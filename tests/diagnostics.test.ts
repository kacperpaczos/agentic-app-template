import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentRuntime,
  ModelStreamError,
  classifyRunFailure,
  collectToolEntries,
  platformTools,
  subscriptionOnlyEnv,
} from '@platform/server';
import { AppError } from '@platform/contracts';
import { createHarness, login, type Harness } from './helpers.ts';
import { dispatchingAgent, type Plan, type StandInHandle, type Step } from './support/model-standin.ts';
import { EVIDENCE_DIR, codeVersion, writeEvidence } from './support/measurement-evidence.ts';

/**
 * What the diagnostic data has to answer after the fact.
 *
 * Three questions, and none of them is answerable from a log line:
 *
 *  1. **Which conversation, run, tool call, mutation and artifact belong
 *     together?** (L12.1) — followed here end to end, from the stored data
 *     only, in both directions.
 *  2. **What kind of failure was it?** (L12.2) — integration, domain, model and
 *     sandbox have to stay apart in the stored record, because each means a
 *     different next step.
 *  3. **Did a credential leak?** (L12.2) — a real value is placed in the
 *     environment and then looked for in everything this application writes.
 *
 * The model is a stand-in at the adapter boundary (see `support/model-standin.ts`);
 * the runtime, the tools, the services and the database are the real ones.
 */

let h: Harness;
let runtime: AgentRuntime;
let plans: Map<string, Plan>;
const pending: Array<Promise<unknown>> = [];
let promptSeq = 0;

const EMPTY_CONTEXT = {
  conversationId: null as string | null,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
  ui: null,
};

async function runScript(conversationId: string, script: Step[]) {
  promptSeq += 1;
  const prompt = `polecenie diagnostyczne ${promptSeq}`;
  const handle: StandInHandle = { childExitedAt: null, childPid: null, performed: [], dispose: () => {} };
  plans.set(prompt, { script, handle });
  const started = await runtime.start({
    ownerId: h.ownerId,
    conversationId,
    prompt,
    appContext: { ...EMPTY_CONTEXT, conversationId },
  });
  const events: Array<Record<string, any>> = [];
  const reader = (async () => {
    for await (const e of started.stream.read(0)) events.push(e.event as Record<string, any>);
  })();
  pending.push(started.done.catch(() => undefined), reader);
  await started.done.catch(() => undefined);
  await reader;
  return {
    runId: started.runId,
    events,
    performed: handle.performed,
    run: () => h.platform.services.runs.get(started.runId, h.ownerId),
  };
}

const newConversation = (title: string) =>
  h.platform.services.conversations.create({ ownerId: h.ownerId, title }).id;

beforeEach(async () => {
  h = await createHarness();
  plans = new Map();
  runtime = new AgentRuntime(
    h.platform.services,
    dispatchingAgent(plans, () =>
      collectToolEntries({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
      }),
    ),
  );
});
afterEach(async () => {
  h.platform.services.runs.abortAll('koniec_testu');
  await Promise.allSettled(pending.splice(0));
  h.dispose();
});

/* ----------------------- rozmowa → wykonanie → … → artefakt --------------- */

describe('powiazanie rozmowy z wykonaniem, narzedziem, mutacja i artefaktem', () => {
  it('lancuch da sie przejsc w danych diagnostycznych w obie strony', async () => {
    const { services } = h.platform;
    const caseId = h.service.listCases(h.ownerId)[0]!.id;
    const detail = h.service.getCaseDetail(caseId, h.ownerId);
    const offer = detail.offers.find((o) => o.items.length > 0)!;
    const item = offer.items[0]!;
    const versionBefore = item.version;

    const conversationId = newConversation('Lancuch diagnostyczny');
    const r = await runScript(conversationId, [
      {
        kind: 'call',
        name: 'procurement_update_offer_item',
        input: { itemId: item.id, quantity: 11 },
      },
      { kind: 'call', name: 'procurement_save_comparison', input: { caseId } },
      { kind: 'text', text: 'Zmienilem pozycje i zapisalem zestawienie.' },
    ]);
    expect(r.run().status).toBe('succeeded');

    /* ----- 1. conversation → run, read back from the registry ------------- */
    const runs = services.runs.listForConversation(conversationId, h.ownerId);
    expect(runs.map((x) => x.id)).toContain(r.runId);
    const run = runs.find((x) => x.id === r.runId)!;
    expect(run.conversationId).toBe(conversationId);

    /* ----- 2. run → tool calls, read back from the persisted event log ---- */
    const events = services.runs.events(r.runId, h.ownerId);
    const starts = events.filter((e) => e.name === 'TOOL_CALL_START');
    const names = starts.map((e) => (e.payload as any).toolCallName);
    expect(names).toContain('mcp__app__procurement_update_offer_item');
    expect(names).toContain('mcp__app__procurement_save_comparison');
    const writeCallId = (starts.find(
      (e) => (e.payload as any).toolCallName === 'mcp__app__procurement_update_offer_item',
    )!.payload as any).toolCallId as string;

    /* ----- 3. tool call → its arguments and its result -------------------- */
    const args = JSON.parse(
      (events.find((e) => e.name === 'TOOL_CALL_ARGS' && (e.payload as any).toolCallId === writeCallId)!
        .payload as any).delta as string,
    );
    expect(args.itemId).toBe(item.id);
    const resultEvent = events.find(
      (e) => e.name === 'TOOL_CALL_RESULT' && (e.payload as any).toolCallId === writeCallId,
    )!;
    const result = JSON.parse((resultEvent.payload as any).content as string);

    /* ----- 4. tool call → mutation: which record, at which version -------- */
    // The identity and the version come out of the stored tool result, so the
    // mutation is identifiable from diagnostics and not only from the database.
    expect(result.item.id).toBe(item.id);
    expect(result.item.version).toBeGreaterThan(versionBefore);
    expect(h.service.getCaseDetail(caseId, h.ownerId).offers
      .flatMap((o) => o.items)
      .find((i) => i.id === item.id)!.version).toBe(result.item.version);
    const dataChanged = events.find(
      (e) => e.name === 'CUSTOM' && (e.payload as any).name === 'platform.data_changed',
    )!;
    expect((dataChanged.payload as any).value.resources).toContain(`offer:${offer.offer.id}`);

    /* ----- 5. run → artifact, and the artifact back to the run ------------ */
    const created = events.find(
      (e) => e.name === 'CUSTOM' && (e.payload as any).name === 'platform.artifact_created',
    )!;
    const artifactId = (created.payload as any).value.artifactId as string;
    const artifact = services.artifacts.meta(artifactId, h.ownerId);
    expect(artifact.conversationId).toBe(conversationId);
    // Backwards: the artifact row alone names the run that produced it, so the
    // chain does not have to be reconstructed by scanning every run's log.
    expect(artifact.runId).toBe(r.runId);
    expect(services.runs.get(artifact.runId!, h.ownerId).conversationId).toBe(conversationId);

    /* ----- 6. tool call → conversation history ---------------------------- */
    const messages = services.conversations.messages(conversationId, h.ownerId);
    const assistant = messages.find(
      (m) => m.role === 'assistant' && (m.meta as any)?.toolCalls?.some((c: any) => c.id === writeCallId),
    );
    expect(assistant, 'brak wiadomosci asystenta z tym wywolaniem').toBeTruthy();
    expect((assistant!.meta as any).runId).toBe(r.runId);
    const toolMessage = messages.find((m) => m.role === 'tool' && (m.meta as any)?.toolCallId === writeCallId);
    expect(toolMessage, 'brak wiadomosci narzedzia dla tego wywolania').toBeTruthy();
    expect((toolMessage!.meta as any).runId).toBe(r.runId);

    /* ----- negative control: an artifact nobody's run produced ------------- */
    const byHand = services.artifacts.create({
      ownerId: h.ownerId,
      conversationId,
      kind: 'report',
      mode: 'snapshot',
      title: 'Zapisane recznie',
      rendererType: 'platform.file',
      content: { x: 1 },
    });
    // The link is recorded, never inferred: without a run there is no run id,
    // and the conversation's latest run is not silently substituted for one.
    expect(byHand.meta.runId).toBeNull();
    expect(byHand.meta.conversationId).toBe(conversationId);

    writeEvidence('powiazanie-diagnostyczne.json', {
      opis:
        'Lancuch rozmowa → wykonanie → narzedzie → mutacja → artefakt, przejsty wylacznie po ' +
        'danych diagnostycznych (agent_runs, run_events, messages, artifacts), w obie strony.',
      zrodlo: 'pnpm test → tests/diagnostics.test.ts (regresja szablonu)',
      warunki:
        'stand-in modelu na granicy adaptera; prawdziwe handlery narzedzi MCP, prawdziwe serwisy ' +
        'domenowe i baza; jedno uruchomienie z zapisem domenowym i zapisem artefaktu',
      wersjaKodu: codeVersion(h.platform.versions),
      lancuch: {
        rozmowa: conversationId,
        wykonanie: r.runId,
        narzedzie: {
          nazwa: 'mcp__app__procurement_update_offer_item',
          toolCallId: writeCallId,
          zrodloArgumentow: 'run_events TOOL_CALL_ARGS',
          zrodloWyniku: 'run_events TOOL_CALL_RESULT oraz messages(role=tool)',
        },
        mutacja: {
          rekord: result.item.id,
          wersjaPrzed: versionBefore,
          wersjaPo: result.item.version,
          zasobyZdarzenia: (dataChanged.payload as any).value.resources,
        },
        artefakt: { id: artifactId, runId: artifact.runId, conversationId: artifact.conversationId },
      },
      kontrolaNegatywna: {
        opis: 'artefakt utworzony poza uruchomieniem',
        artefakt: byHand.meta.id,
        runId: byHand.meta.runId,
      },
    });
  });
});

/* ----------------------------- klasy bledow ------------------------------- */

describe('klasy bledow sa rozroznialne w zapisanym uruchomieniu', () => {
  it('taksonomia rozdziela integracje, model, sandbox i dostep', () => {
    // A table of failures as they actually read, mapped to the class the run
    // record must store. `classifyRunFailure` is the one place that decides.
    const stream = (message: string) => new ModelStreamError(new Error(message));
    expect(classifyRunFailure(stream('Model returned an invalid response'))).toBe('model_failed');
    expect(classifyRunFailure(stream('overloaded_error: please retry'))).toBe('model_failed');
    // The same wording, but nothing ever produced a stream: an integration fault.
    expect(classifyRunFailure(new Error('Model returned an invalid response'))).toBe(
      'integration_failed',
    );
    expect(classifyRunFailure(new Error('spawn claude ENOENT'))).toBe('integration_failed');
    expect(classifyRunFailure(new Error('run_timeout'))).toBe('integration_failed');
    expect(classifyRunFailure(stream('Sandbox unavailable: sandbox-exec not found'))).toBe(
      'sandbox_denied',
    );
    expect(classifyRunFailure(new AppError('sandbox_denied', 'Sciezka wychodzi poza workspace.'))).toBe(
      'sandbox_denied',
    );
    expect(classifyRunFailure(stream('Claude usage limit reached'))).toBe('rate_limited');
    expect(classifyRunFailure(stream('OAuth token revoked, please run /login'))).toBe(
      'unauthenticated',
    );
    // A domain rejection is not a run failure and must not be dressed as one.
    expect(classifyRunFailure(new AppError('domain_rule_violated', 'Cena nie moze byc ujemna.'))).toBe(
      'domain_rule_violated',
    );
  });

  it('zapisane uruchomienia niosa rozne kody dla modelu, integracji i sandboxu', async () => {
    const zapisane: Record<string, unknown> = {};

    const cases: Array<{ klasa: string; script: Step[]; oczekiwanyKod: string }> = [
      {
        klasa: 'model',
        script: [
          { kind: 'text', text: 'Zaczynam. ' },
          { kind: 'streamError', message: 'overloaded_error: model is overloaded' },
        ],
        oczekiwanyKod: 'model_failed',
      },
      {
        klasa: 'integracja',
        script: [{ kind: 'startFailure', message: 'spawn claude ENOENT' }],
        oczekiwanyKod: 'integration_failed',
      },
      {
        klasa: 'sandbox',
        script: [{ kind: 'streamError', message: 'Sandbox unavailable: sandbox-exec not found' }],
        oczekiwanyKod: 'sandbox_denied',
      },
      {
        klasa: 'dostep',
        script: [{ kind: 'streamError', message: 'Claude usage limit reached' }],
        oczekiwanyKod: 'rate_limited',
      },
    ];

    for (const c of cases) {
      const r = await runScript(newConversation(`Blad ${c.klasa}`), c.script);
      const run = r.run();
      expect(run.status, c.klasa).toBe('failed');
      expect(run.errorCode, c.klasa).toBe(c.oczekiwanyKod);
      // The same class reaches the client, so the chat and the record agree.
      const runError = r.events.find((e) => e.type === 'RUN_ERROR');
      expect(runError?.code, c.klasa).toBe(c.oczekiwanyKod);
      zapisane[c.klasa] = {
        kodWRekordzie: run.errorCode,
        kodWZdarzeniuRUN_ERROR: runError?.code,
        komunikat: run.errorMessage,
        gdzieZapisane: 'agent_runs.error_code + run_events RUN_ERROR',
      };
    }

    /* --- domain: a refusal by the rules, which is not a failed run --------- */
    const caseId = h.service.listCases(h.ownerId)[0]!.id;
    const item = h.service
      .getCaseDetail(caseId, h.ownerId)
      .offers.flatMap((o) => o.items)[0]!;
    const conversationId = newConversation('Blad domeny');
    const domain = await runScript(conversationId, [
      {
        kind: 'call',
        name: 'procurement_update_offer_item',
        input: { itemId: item.id, unitPrice: -5 },
      },
      { kind: 'text', text: 'Regula domeny odmowila.' },
    ]);
    // The model was told, the user's turn survived, and the run is not failed:
    // a domain rule is an answer, not an outage.
    expect(domain.run().status).toBe('succeeded');
    expect(domain.run().errorCode).toBeNull();
    const toolMessage = h.platform.services.conversations
      .messages(conversationId, h.ownerId)
      .find((m) => m.role === 'tool');
    expect((toolMessage!.meta as any).isError).toBe(true);
    expect(JSON.parse(toolMessage!.content).error).toBe('domain_rule_violated');
    // The record kept the version it had: a refused write changes nothing.
    expect(
      h.service.getCaseDetail(caseId, h.ownerId).offers.flatMap((o) => o.items)
        .find((i) => i.id === item.id)!.version,
    ).toBe(item.version);
    zapisane.domena = {
      statusUruchomienia: domain.run().status,
      kodWWiadomosciNarzedzia: 'domain_rule_violated',
      gdzieZapisane: 'messages(role=tool).content + meta.isError',
    };

    writeEvidence('klasy-bledow.json', {
      opis:
        'Rozroznialnosc klas bledow w zapisanych danych: blad modelu, blad integracji, odmowa ' +
        'sandboxa, limit dostepu i odmowa reguly domenowej. Kazdy ma inny kod i inne miejsce zapisu.',
      zrodlo: 'pnpm test → tests/diagnostics.test.ts (regresja szablonu)',
      warunki:
        'stand-in modelu na granicy adaptera; komunikaty bledow w brzmieniu, jakie produkuje SDK; ' +
        'blad integracji to odrzucone wywolanie adaptera, blad modelu to strumien, ktory zglosil awarie',
      wersjaKodu: codeVersion(h.platform.versions),
      klasy: zapisane,
    });
  });
});

/* ------------------------------- sekrety ---------------------------------- */

describe('sekret ze srodowiska nie trafia do diagnostyki', () => {
  const CANARY = 'sk-ant-kanarek-z3bl05-0123456789abcdef';
  const CANARY_GENERIC = 'kanarek-ogolny-z3bl05-fedcba9876543210';
  let restore: Array<[string, string | undefined]> = [];

  beforeEach(() => {
    restore = [
      ['ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY],
      ['ANTHROPIC_AUTH_TOKEN', process.env.ANTHROPIC_AUTH_TOKEN],
      ['APP_TAJNY_KANAREK', process.env.APP_TAJNY_KANAREK],
    ];
    process.env.ANTHROPIC_API_KEY = CANARY;
    process.env.ANTHROPIC_AUTH_TOKEN = CANARY;
    process.env.APP_TAJNY_KANAREK = CANARY_GENERIC;
  });
  afterEach(() => {
    for (const [k, v] of restore) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('nie wystepuje w logach, bledach, zapisanych uruchomieniach ani w dowodach', async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? '')).join(' '));
    };
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );

    let scanned: Record<string, number>;
    try {
      // The value is in the environment of the very process running the agent,
      // which is the situation the criterion is about.
      const conversationId = newConversation('Przebieg z sekretem w srodowisku');
      const ok = await runScript(conversationId, [
        { kind: 'call', name: 'get_context' },
        { kind: 'text', text: 'Gotowe.' },
      ]);
      expect(ok.run().status).toBe('succeeded');
      // A failing run too: an error message is the surface a leak reaches first.
      const bad = await runScript(newConversation('Przebieg zakonczony bledem'), [
        { kind: 'streamError', message: 'overloaded_error: model is overloaded' },
      ]);
      expect(bad.run().status).toBe('failed');

      const cookie = await login(h.platform.app, h.ownerId);
      const status = await (
        await h.platform.app.request('/api/status', { headers: { cookie } })
      ).text();

      const db = h.platform.db.$client;
      const surfaces: Record<string, string> = {
        'logi serwera (console.*)': logged.join('\n'),
        'agent_runs': JSON.stringify(db.prepare('SELECT * FROM agent_runs').all()),
        'run_events': JSON.stringify(db.prepare('SELECT * FROM run_events').all()),
        messages: JSON.stringify(db.prepare('SELECT * FROM messages').all()),
        'odpowiedz /api/status': status,
        'plik bazy danych': readFileSync(h.platform.config.dbFile).toString('latin1'),
      };
      const evidenceDir = resolve(process.cwd(), EVIDENCE_DIR);
      for (const name of readdirSync(evidenceDir)) {
        surfaces[`dowod ${name}`] = readFileSync(resolve(evidenceDir, name), 'utf8');
      }

      scanned = Object.fromEntries(Object.entries(surfaces).map(([k, v]) => [k, v.length]));
      for (const [where, text] of Object.entries(surfaces)) {
        expect(text, `sekret w: ${where}`).not.toContain(CANARY);
        expect(text, `sekret w: ${where}`).not.toContain(CANARY_GENERIC);
        // A leading fragment would be enough to identify the credential.
        expect(text, `fragment sekretu w: ${where}`).not.toContain(CANARY.slice(0, 20));
      }

      /* ------------------------- negative control ------------------------- */
      // The scan has to be able to fail: the same check over a surface that does
      // contain the value must find it.
      const fabricated = `ANTHROPIC_API_KEY=${CANARY}`;
      expect(fabricated).toContain(CANARY);
      expect(() => expect(fabricated).not.toContain(CANARY)).toThrow();

      /*
       * The environment handed to the agent's child is a different question
       * from the diagnostic surfaces above, and is asserted separately: the
       * provider overrides are stripped, while an unrelated variable is passed
       * through — so their absence is a decision, not an empty environment.
       */
      expect(process.env.ANTHROPIC_API_KEY).toBe(CANARY);
      expect(subscriptionOnlyEnv().ANTHROPIC_API_KEY).toBeUndefined();
      expect(subscriptionOnlyEnv().ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(JSON.stringify(subscriptionOnlyEnv())).not.toContain(CANARY);
      expect(subscriptionOnlyEnv().APP_TAJNY_KANAREK).toBe(CANARY_GENERIC);
    } finally {
      for (const s of spies) s.mockRestore();
    }

    writeEvidence('sekrety-w-diagnostyce.json', {
      opis:
        'Wartosc poswiadczenia umieszczona w srodowisku procesu serwera nie wystepuje w zadnej ' +
        'powierzchni diagnostycznej aplikacji ani w plikach dowodow tego zadania.',
      zrodlo: 'pnpm test → tests/diagnostics.test.ts (regresja szablonu)',
      warunki:
        'kanarki ustawione w ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN i APP_TAJNY_KANAREK przed ' +
        'utworzeniem instancji; przebieg udany i przebieg zakonczony bledem; console.* przechwycone ' +
        'na czas przebiegu; skan po tresci, nie po nazwie zmiennej',
      wersjaKodu: codeVersion(h.platform.versions),
      przeskanowanePowierzchnieZnakow: scanned,
      kontrolaNegatywna:
        'ten sam skan nad spreparowanym tekstem zawierajacym kanarka znajduje go — asercja potrafi oblac',
      uwaga:
        'APP_TAJNY_KANAREK jest przekazywany do srodowiska procesu agenta, bo nie jest przelacznikiem ' +
        'dostawcy; dowodem jest brak jego wartosci w logach i w zapisanych danych, nie brak zmiennej.',
    });
  });
});
