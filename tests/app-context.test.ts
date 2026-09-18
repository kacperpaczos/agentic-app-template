import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppError,
  EMPTY_UI_SNAPSHOT_CONTEXT,
  READ_WINDOW_DEFAULT_LIMIT,
  appContextSchema,
  type AppContext,
  type ToolCallContext,
  type UiSnapshot,
} from '@platform/contracts';
import {
  AgentRuntime,
  buildSystemPrompt,
  collectToolEntries,
  executeTool,
  platformTools,
  TOOL_RESULT_STORED_CHARS,
} from '@platform/server';
import { setAccessContext, resetAccessContext } from '../packages/platform-ui/src/api/accessContext.ts';
import { useAppState } from '../packages/platform-ui/src/state/appState.ts';
import {
  decideRestore,
  leavesAnotherConversation,
} from '../packages/platform-ui/src/chat/sessionRestore.ts';
import { createHarness, login, type Harness } from './helpers.ts';
import { dispatchingAgent, type Plan, type StandInHandle } from './support/model-standin.ts';
import { codeVersion, evidenceWritingRequested, writeEvidence } from './support/measurement-evidence.ts';

/**
 * The context the agent works from: true when it is used, scoped to whoever is
 * asking, and not carried across a boundary.
 *
 * Criteria L6.3, L6.4, L6.7, L6.9, L6.10, L6.11, L6.12, L6.14. Contract and
 * logic only — no browser, no model; the stand-in sits at the adapter boundary
 * (`support/model-standin.ts`) and everything around it is the real runtime,
 * the real MCP handlers, the real services and a real database. The user-flow
 * half (a person switching conversation, selecting rows, navigating mid-task)
 * is `e2e/app-context.spec.ts`.
 *
 * Most of what is asserted here is a **negative** property: that a run does
 * *not* see another conversation's selection, that a stale write does *not*
 * land, that a switch does *not* leave the previous owner's ids behind. Each of
 * those is set up so the bad outcome is the one that would happen without the
 * mechanism under test.
 */

let h: Harness;
let cookie: string;
let runtime: AgentRuntime;
let plans: Map<string, Plan>;
const pending: Array<Promise<unknown>> = [];
let promptSeq = 0;

const EMPTY_CONTEXT: AppContext = {
  conversationId: null,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
  ui: null,
};

const tools = () =>
  collectToolEntries({ registry: h.platform.registry, platformTools: platformTools(h.platform.services) });

/** Runs one tool the way the MCP server does: its own validation, then its handler. */
async function callTool(name: string, input: unknown, ctx: Partial<ToolCallContext> = {}) {
  const entry = tools().find((t) => t.localName === name);
  if (!entry) throw new Error(`nieznane narzedzie ${name}`);
  return executeTool({ localName: name, def: entry.def as never }, input, {
    ownerId: h.ownerId,
    appContext: EMPTY_CONTEXT,
    conversationId: null,
    runId: null,
    workspaceDir: null,
    emit: () => {},
    ...ctx,
  } as ToolCallContext);
}

/** A tab's description of its screen, with the live command context in it. */
function snapshotOf(over: Partial<UiSnapshot> & { clientId: string; version: number }): UiSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    conversationId: null,
    spaceId: null,
    url: '/data',
    urlTruncated: false,
    target: null,
    view: null,
    cards: null,
    cardsSpaceId: null,
    cardsState: 'loading',
    cardsOmitted: 0,
    instances: [],
    instancesOmitted: 0,
    actions: ['navigate'],
    context: EMPTY_UI_SNAPSHOT_CONTEXT,
    ...over,
  };
}

const newConversation = (title = 'Kontekst') =>
  h.platform.services.conversations.create({ ownerId: h.ownerId, title }).id;

beforeEach(async () => {
  h = await createHarness();
  cookie = await login(h.platform.app, h.ownerId);
  plans = new Map();
  runtime = new AgentRuntime(h.platform.services, dispatchingAgent(plans, tools));
});
afterEach(async () => {
  h.platform.services.runs.abortAll('koniec_testu');
  await Promise.allSettled(pending.splice(0));
  h.dispose();
  resetAccessContext();
});

const api = async (path: string, init: RequestInit = {}) => {
  const res = await h.platform.app.request(path, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const runInput = (over: Record<string, unknown>) => ({
  method: 'POST',
  body: JSON.stringify({
    threadId: null,
    runId: 'run_test',
    messages: [{ id: 'm1', role: 'user', content: 'zrob cos' }],
    ...over,
  }),
});

/* ========================================================================== */
/*  L6.4 — a context that is validated and grants nothing                     */
/* ========================================================================== */

describe('L6.4 — kontekst z frontendu jest walidowany i nie nadaje uprawnien', () => {
  it('kontekst niezgodny z kontraktem to validation_failed z polami, nie internal 500', async () => {
    /*
     * The failure this replaces: the schema threw a bare ZodError, which the
     * error shaper could only call `internal` — a 500 blaming the server for a
     * request that was simply malformed, and saying nothing about which field.
     */
    const res = await api(
      '/api/agui/run',
      runInput({ context: { conversationId: null, spaceId: null, resource: 'sprawa-numer-1' } }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.reason).toBe('invalid_app_context');
    expect(res.body.error.details.issues.map((i: { path: string }) => i.path)).toContain('resource');
  });

  it('cudza przestrzen z kontekstu nie zostaje zapisana w rozmowie: forbidden, wiazanie nietkniete', async () => {
    const foreign = h.platform.services.canvas.createSpace({
      ownerId: h.otherOwnerId,
      title: 'Cudza przestrzen',
      scopeKind: 'workspace',
      scopeId: 'x',
    });
    const own = h.platform.services.canvas.createSpace({
      ownerId: h.ownerId,
      title: 'Moja przestrzen',
      scopeKind: 'workspace',
      scopeId: 'y',
    });
    const conversation = h.platform.services.conversations.create({
      ownerId: h.ownerId,
      title: 'Rozmowa',
      spaceId: own.id,
    });

    const res = await api(
      '/api/agui/run',
      runInput({ threadId: conversation.id, context: { ...EMPTY_CONTEXT, spaceId: foreign.id } }),
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    // The point of the check: the conversation is not left pointing at a space
    // its owner cannot open.
    expect(h.platform.services.conversations.get(conversation.id, h.ownerId).spaceId).toBe(own.id);
    // And no run was started for it.
    expect(h.platform.services.runs.listActive(h.ownerId)).toHaveLength(0);
  });

  it('cudzy zasob w kontekscie nie daje odczytu: opis mowi forbidden, a nie tresc rekordu', async () => {
    const foreignCase = h.service.listCases(h.ownerId)[0]!;
    // The same record id, asked about as the *other* owner: the context names it,
    // the session decides whether it may be read.
    const described = await h.platform.registry.describeResource(
      { kind: 'case', id: foreignCase.id },
      h.otherOwnerId,
    );
    expect(described).toMatchObject({ state: 'forbidden', summary: null, errorCode: 'forbidden' });
    expect(JSON.stringify(described)).not.toContain(foreignCase.title);
  });

  it('kontekst nie ma pola wlasciciela, a podstawiony ownerId nie zmienia wlasciciela wykonania', async () => {
    expect(Object.keys(appContextSchema.shape)).not.toContain('ownerId');
    const conversation = newConversation();
    const prompt = 'polecenie z podstawionym wlascicielem';
    plans.set(prompt, {
      script: [{ kind: 'call', name: 'get_context' }],
      handle: emptyHandle(),
    });
    const parsed = appContextSchema.parse({
      ...EMPTY_CONTEXT,
      conversationId: conversation,
      ownerId: h.otherOwnerId,
    } as Record<string, unknown>);
    expect(parsed).not.toHaveProperty('ownerId');
    const started = await runtime.start({
      ownerId: h.ownerId,
      conversationId: conversation,
      prompt,
      appContext: parsed,
    });
    pending.push(started.done.catch(() => undefined));
    await started.done;
    expect(h.platform.services.runs.get(started.runId, h.ownerId).ownerId).toBe(h.ownerId);
  });
});

/* ========================================================================== */
/*  L6.7 — reads take a window                                                */
/* ========================================================================== */

describe('L6.7 — wiekszy zbior jest pobierany oknem, nie w calosci', () => {
  it('bez limitu odczyt zwraca domyslne okno i mowi, ze to nie caly zbior', async () => {
    const space = h.platform.services.canvas.createSpace({
      ownerId: h.ownerId,
      title: 'Duza przestrzen',
      scopeKind: 'workspace',
      scopeId: 'big',
    });
    const cardCount = READ_WINDOW_DEFAULT_LIMIT + 5;
    for (let i = 0; i < cardCount; i += 1) {
      await h.platform.services.canvas.addCard(
        { spaceId: space.id, title: `Karta ${i}`, spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'x' } } },
        h.ownerId,
      );
    }

    const out: any = await callTool('canvas_list_cards', { spaceId: space.id });
    expect(out.cards).toHaveLength(READ_WINDOW_DEFAULT_LIMIT);
    expect(out.window).toMatchObject({
      total: cardCount,
      returned: READ_WINDOW_DEFAULT_LIMIT,
      offset: 0,
      truncated: true,
      nextOffset: READ_WINDOW_DEFAULT_LIMIT,
    });
    expect(out.windowNote).toContain('NIE jest caly zbior');

    // The rest is reachable, and the two pages together are the whole set.
    const rest: any = await callTool('canvas_list_cards', { spaceId: space.id, offset: out.window.nextOffset });
    expect(rest.cards).toHaveLength(5);
    expect(rest.window).toMatchObject({ truncated: true, nextOffset: null });
    expect(new Set([...out.cards, ...rest.cards].map((c: any) => c.id)).size).toBe(cardCount);
  });

  it('kazde narzedzie odczytu albo bierze okno, albo jest tu wymienione z powodem', () => {
    /*
     * Enumerated from the registry, not written out by hand.
     *
     * A hand-written list of the tools that *were* fixed proves only that they
     * were fixed; it says nothing about the next read tool somebody adds, and it
     * quietly went on passing while three unwindowed listings sat next to it.
     * So the rule is stated the other way round: **every** tool with
     * `effect: 'read'` declares `limit` and `offset`, unless it is named below
     * with the reason why a window would make it worse. A new read tool fails
     * this test until somebody decides which of the two it is.
     */
    const withoutWindow: Record<string, string> = {
      // Not listings: one command each, answering with what the browser did.
      ui_navigate: 'komenda interfejsu, odpowiedz to wynik jednej nawigacji',
      ui_filter: 'komenda interfejsu, odpowiedz to wynik jednego zawezenia',
      ui_sort: 'komenda interfejsu, odpowiedz to wynik jednego sortowania',
      ui_show_value: 'komenda interfejsu, odpowiedz dotyczy jednej wartosci',
      files_stage: 'dotyczy jednego pliku',
      procurement_find_price_provenance: 'przejscie po relacjach jednej pozycji',
      // Bounded by the contract, not by how much the user has.
      get_context: 'kontekst polecenia ma limity w appContextSchema (zaznaczenie 50, szkice 20)',
      ui_state: 'jeden opis ekranu, z wlasnymi limitami UI_SNAPSHOT_* i rozmiarem w bajtach',
      canvas_catalog: 'katalog komponentow deklarowany przez aplikacje, nie przez uzytkownika',
      // Windowing would change the meaning of the answer, not just its size.
      procurement_compare_offers:
        'ranking dotyczy calego zbioru ofert sprawy; ranking strony bylby mylacy, a nie krotszy',
      procurement_search: 'ma wlasny limit (domyslnie 20, maks. 50) i totals mowiace o calosci',
    };

    const reads = tools().filter((t) => t.def.effect === 'read');
    expect(reads.length).toBeGreaterThan(10);
    const missing: string[] = [];
    for (const entry of reads) {
      const keys = Object.keys((entry.def.inputSchema as any).shape);
      const windowed = keys.includes('limit') && keys.includes('offset');
      if (windowed) {
        expect(withoutWindow[entry.localName], `${entry.localName} ma okno i wyjatek naraz`).toBeUndefined();
        continue;
      }
      if (!withoutWindow[entry.localName]) missing.push(entry.localName);
    }
    expect(missing, 'narzedzia odczytu bez okna i bez uzasadnienia').toEqual([]);

    // The exception list describes tools that exist; a stale entry is a lie too.
    const names = new Set(reads.map((t) => t.localName));
    expect(Object.keys(withoutWindow).filter((n) => !names.has(n))).toEqual([]);
  });

  it('limit i offset przechodza przez narzedzie modulu, a totals nie klamia', async () => {
    const all = h.service.listCases(h.ownerId);
    expect(all.length).toBeGreaterThan(0);
    const first: any = await callTool('procurement_list_cases', { limit: 1 });
    expect(first.cases).toHaveLength(1);
    expect(first.window.total).toBe(all.length);
    expect(first.window.truncated).toBe(all.length > 1);

    // An offset past the end is an empty page of a non-empty set — never "no cases".
    const past: any = await callTool('procurement_list_cases', { offset: all.length });
    expect(past.cases).toHaveLength(0);
    expect(past.window.total).toBe(all.length);
  });

  it('kazdy windowany odczyt miesci sie w tym, co rozmowa przechowuje', async () => {
    /*
     * Enumerated from the registry, for the same reason as the window rule
     * above: a hand-written list of six proved six things and quietly said
     * nothing about the three unwindowed listings sitting next to it.
     *
     * The coupling: a tool answer longer than `TOOL_RESULT_STORED_CHARS` is
     * stored cut in the middle of a value, so whatever reads the conversation
     * back gets text that no longer parses. A window is the remedy — and only
     * while the default window actually fits.
     */
    const caseId = h.service.listCases(h.ownerId)[0]!.id;
    const spaceId = await spaceWithCards();
    const fileId = h.platform.services.files.store({
      ownerId: h.ownerId,
      filename: 'wejscie.csv',
      mediaType: 'text/csv',
      bytes: Buffer.from('a,b\n1,2\n'),
    }).id;

    /** Arguments a tool needs before it can answer at all. */
    const argsFor: Record<string, Record<string, unknown>> = {
      procurement_get_case: { caseId },
      procurement_list_offers: { caseId },
      canvas_list_cards: { spaceId },
      files_versions: { fileId },
    };
    /**
     * Windowed reads whose size does not come from the user's data, with the
     * reason. `ui_catalog` is built from what the application declares about
     * itself: no window shrinks it and no user can enlarge it. Its answer is
     * over the limit today, which is a defect of the stored projection rather
     * than of the window, and is reported as one.
     */
    const oversizeAllowed: Record<string, string> = {
      ui_catalog: 'rozmiar pochodzi z deklaracji aplikacji, nie z danych uzytkownika',
    };

    // A conversation, because a read scoped to one (agent views) refuses without it.
    const conversationId = newConversation('Rozmowa pomiarowa');
    const ctx = {
      appContext: { ...EMPTY_CONTEXT, spaceId, conversationId },
      conversationId,
    };
    const windowed = tools().filter((t) => {
      const keys = Object.keys((t.def.inputSchema as any).shape);
      return t.def.effect === 'read' && keys.includes('limit') && keys.includes('offset');
    });
    expect(windowed.length).toBeGreaterThanOrEqual(9);

    const tooBig: string[] = [];
    for (const entry of windowed) {
      const answer = await callTool(entry.localName, argsFor[entry.localName] ?? {}, ctx);
      const size = JSON.stringify(answer).length;
      if (size < TOOL_RESULT_STORED_CHARS) {
        expect(oversizeAllowed[entry.localName], `${entry.localName} miesci sie i ma wyjatek`).toBeUndefined();
        continue;
      }
      if (!oversizeAllowed[entry.localName]) tooBig.push(`${entry.localName} (${size})`);
    }
    expect(tooBig, 'windowane odczyty przekraczajace zapis wyniku narzedzia').toEqual([]);

    // A stale exception is a lie too.
    const names = new Set(windowed.map((t) => t.localName));
    expect(Object.keys(oversizeAllowed).filter((n) => !names.has(n))).toEqual([]);
  });

  it('odpowiedz get_context miesci sie w tym, co rozmowa przechowuje', async () => {
    /*
     * `get_context` takes no window — nothing about it is a page of a larger
     * set — so the enumeration above skips it, and yet it is the answer that
     * grows with everything the user has picked and typed. It is also the
     * answer that already forced a change once: naming the command context
     * twice (flat and in a block of its own) pushed a heavy context past the
     * limit, and the duplicate was dropped rather than the fields.
     *
     * The context below is a heavy one a person can really produce: a dozen
     * rows selected, a narrowed and ordered view, five dirty forms. It is not
     * the schema's ceiling — fifty selected rows with ids of the maximum length
     * and twenty forms of sixty dirty fields do not fit, and no tool answer of
     * that size would; that is the stored projection's limit, recorded as an
     * observation rather than silently assumed away here.
     */
    const caseId = h.service.listCases(h.ownerId)[0]!.id;
    const answer = await callTool(
      'get_context',
      {},
      {
        appContext: {
          ...EMPTY_CONTEXT,
          spaceId: 'spc_pomiarowa',
          resource: { kind: 'case', id: caseId },
          selection: Array.from({ length: 12 }, (_, i) => ({
            kind: 'offer_item',
            id: `pci_${i}${'a'.repeat(16)}`,
          })),
          filters: {
            'procurement.data': {
              predicates: [{ field: 'country', op: 'eq', value: 'PL' }],
              sort: { field: 'name', direction: 'desc' },
              page: { index: 1, size: 10, count: 1 },
              matched: 5,
              total: 7,
            },
          },
          viewport: { x: 12, y: 34, zoom: 1 },
          drafts: Array.from({ length: 5 }, (_, i) => ({
            formId: `form_${i}`,
            entity: 'offer_item',
            entityId: `pci_${i}`,
            dirtyFields: ['unitPrice', 'quantity'],
          })),
          ui: { version: 12, clientId: 'ui_tab_kontekst', viewId: 'procurement.data', url: '/data?country=PL' },
        },
      },
    );
    expect(
      JSON.stringify(answer).length,
      'get_context nie miesci sie w zapisie wyniku narzedzia',
    ).toBeLessThan(TOOL_RESULT_STORED_CHARS);
  });

  it('limit poza zakresem schematu jest odrzucany, a nie znosi ograniczenia odczytu', async () => {
    for (const limit of [0, -1, 5000]) {
      await expect(callTool('procurement_list_cases', { limit }), String(limit)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    }
  });
});

/* ========================================================================== */
/*  L6.11 — missing, stale and forbidden are not an empty result              */
/* ========================================================================== */

describe('L6.11 — brak zasobu, cudzy zasob i pusty wynik to trzy rozne odpowiedzi', () => {
  it('opis zasobu rozroznia brak kontekstu, opisany rekord, usuniety, cudzy i nieopisany rodzaj', async () => {
    const own = h.service.listCases(h.ownerId)[0]!;

    expect(await h.platform.registry.describeResource(null, h.ownerId)).toMatchObject({ state: 'none' });
    expect(await h.platform.registry.describeResource({ kind: 'case', id: own.id }, h.ownerId)).toMatchObject({
      state: 'described',
    });
    expect(
      await h.platform.registry.describeResource({ kind: 'case', id: 'pc_nie_ma_takiej' }, h.ownerId),
    ).toMatchObject({ state: 'not_found', errorCode: 'not_found', summary: null });
    expect(await h.platform.registry.describeResource({ kind: 'case', id: own.id }, h.otherOwnerId)).toMatchObject({
      state: 'forbidden',
      errorCode: 'forbidden',
    });
    expect(await h.platform.registry.describeResource({ kind: 'zabawka', id: 'z1' }, h.ownerId)).toMatchObject({
      state: 'not_described',
      summary: null,
    });

    // Each state says, in words, that nothing may be invented in its place.
    for (const resource of [
      { kind: 'case', id: 'pc_nie_ma_takiej' },
      { kind: 'zabawka', id: 'z1' },
    ]) {
      const d = await h.platform.registry.describeResource(resource, h.ownerId);
      expect(d.note.toLowerCase()).toMatch(/nie zmyslaj|nie opisuj|nie znasz/);
    }
  });

  it('get_context i prompt mowia wprost, ze rekordu nie ma — zamiast milczec po identyfikatorze', async () => {
    const appContext: AppContext = { ...EMPTY_CONTEXT, resource: { kind: 'case', id: 'pc_nie_ma_takiej' } };
    const out: any = await callTool('get_context', {}, { appContext, conversationId: null });
    expect(out.resourceState).toBe('not_found');
    expect(out.resourceSummary).toBeNull();
    expect(out.resourceState).toBe('not_found');

    const prompt = buildSystemPrompt({
      registry: h.platform.registry,
      catalog: h.platform.services.catalog,
      appContext,
      resourceSummary: null,
      resourceDescription: await h.platform.registry.describeResource(appContext.resource, h.ownerId),
      workspaceDir: null,
      stagedFiles: [],
      toolkit: [],
    });
    expect(prompt).toContain('BRAK (not_found)');
    expect(prompt).toContain('pc_nie_ma_takiej');
  });

  it('pusty wynik odczytu to zero rekordow z totals, a brak rekordu to blad — nie to samo', async () => {
    const own = h.service.listCases(h.ownerId)[0]!;
    // Empty page of an existing case: a list, a total, no error.
    const empty: any = await callTool('procurement_list_offers', { caseId: own.id, offset: 1000 });
    expect(empty.offers).toEqual([]);
    expect(empty.window.total).toBeGreaterThan(0);
    // A case that is not there: an error with a code, not an empty list.
    await expect(callTool('procurement_list_offers', { caseId: 'pc_nie_ma_takiej' })).rejects.toMatchObject({
      code: 'not_found',
    });
    // Somebody else's case: a different code again.
    await expect(
      callTool('procurement_list_offers', { caseId: own.id }, { ownerId: h.otherOwnerId }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

/* ========================================================================== */
/*  L6.3 / L6.9 — the current context during a long task                      */
/* ========================================================================== */

describe('L6.3 i L6.9 — agent czyta kontekst nowszy niz startowy i odroznia go od niego', () => {
  it('bez opisu karty biezacy kontekst jest NIEZNANY, a nie rowny startowemu', async () => {
    const conversation = newConversation();
    const appContext: AppContext = {
      ...EMPTY_CONTEXT,
      conversationId: conversation,
      selection: [{ kind: 'offer', id: 'of_1' }],
    };
    const out: any = await callTool('get_context', {}, { appContext, conversationId: conversation });
    expect(out.currentContext.known).toBe(false);
    expect(out.currentContext.reason).toBe('no_client');
    /*
     * The assertion that matters: not an empty selection, which would read as
     * "the user has deselected everything". Nothing is known.
     */
    expect(out.currentContext.selection).toBeNull();
    expect(out.currentContext.changedSinceCommand).toBeNull();
    expect(out.selection).toEqual([{ kind: 'offer', id: 'of_1' }]);
  });

  it('zmiana zaznaczenia i szkicu W TRAKCIE wykonania jest widoczna i nazwana', async () => {
    const conversation = newConversation();
    const startSelection = [{ kind: 'offer_item', id: 'it_start' }];
    h.platform.services.uiSnapshots.publish(
      h.ownerId,
      snapshotOf({
        clientId: 'ui_tab_kontekst',
        version: 1,
        conversationId: conversation,
        context: { resource: { kind: 'case', id: 'pc_a' }, selection: startSelection, drafts: [] },
      }),
    );
    const appContext: AppContext = {
      ...EMPTY_CONTEXT,
      conversationId: conversation,
      resource: { kind: 'case', id: 'pc_a' },
      selection: startSelection,
      ui: { version: 1, clientId: 'ui_tab_kontekst', viewId: null, url: '/data' },
    };

    const prompt = 'dlugie zadanie z kontekstem';
    plans.set(prompt, {
      script: [
        { kind: 'call', name: 'get_context', input: { minVersion: 1, clientId: 'ui_tab_kontekst', waitMs: 2000 } },
        // Blocks until the tab publishes version 2 — no sleep, no race.
        { kind: 'call', name: 'get_context', input: { minVersion: 2, clientId: 'ui_tab_kontekst', waitMs: 5000 } },
      ],
      handle: emptyHandle(),
    });

    const started = await runtime.start({ ownerId: h.ownerId, conversationId: conversation, prompt, appContext });
    /*
     * The user changes the selection and starts typing a form *while the run is
     * between its two reads*: the publication is made the moment the first read
     * has answered, which the run's own event stream reports.
     */
    let published = false;
    const reader = (async () => {
      for await (const { event } of started.stream.read(0)) {
        if ((event as { type?: string }).type === 'TOOL_CALL_RESULT' && !published) {
          published = true;
          h.platform.services.uiSnapshots.publish(
            h.ownerId,
            snapshotOf({
              clientId: 'ui_tab_kontekst',
              version: 2,
              conversationId: conversation,
              context: {
                resource: { kind: 'case', id: 'pc_a' },
                selection: [{ kind: 'offer_item', id: 'it_nowy' }],
                drafts: [{ formId: 'f1', entity: 'offer_item', entityId: 'it_nowy', dirtyFields: ['unitPrice'] }],
              },
            }),
          );
        }
      }
    })();
    pending.push(started.done.catch(() => undefined), reader);
    await started.done;
    await reader;

    const toolMessages = h.platform.services.conversations
      .messages(conversation, h.ownerId)
      .filter((m) => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(2);
    const last = JSON.parse(toolMessages.at(-1)!.content);

    // The newer context reached the agent …
    expect(last.currentContext.known).toBe(true);
    expect(last.currentContext.stale).toBe(false);
    expect(last.currentContext.version).toBe(2);
    expect(last.currentContext.selection).toEqual([{ kind: 'offer_item', id: 'it_nowy' }]);
    expect(last.currentContext.unsavedDrafts[0]).toMatchObject({ formId: 'f1', dirtyFields: ['unitPrice'] });
    // … and is distinguishable from the context the command started with.
    expect(last.selection).toEqual(startSelection);
    expect(last.currentContext.changedSinceCommand).toEqual(expect.arrayContaining(['selection', 'drafts']));
    expect(last.currentContext.note).toContain('kontekst polecenia');
  });
});

/* ========================================================================== */
/*  L6.14 / L6.12 — nothing crosses a conversation or an owner                */
/* ========================================================================== */

describe('L6.14 — zadanie nie przejmuje zaznaczenia ani przestrzeni z innej rozmowy', () => {
  it('opis karty pokazujacej INNA rozmowe nie jest podany jako biezacy kontekst', async () => {
    const mine = newConversation('Moja');
    const other = newConversation('Inna');
    // The user has moved on: the only tab open is showing the other conversation.
    h.platform.services.uiSnapshots.publish(
      h.ownerId,
      snapshotOf({
        clientId: 'ui_tab_kontekst',
        version: 1,
        conversationId: other,
        spaceId: 'sp_innej_rozmowy',
        context: { resource: { kind: 'case', id: 'pc_inne' }, selection: [{ kind: 'offer', id: 'of_inne' }], drafts: [] },
      }),
    );

    const appContext: AppContext = {
      ...EMPTY_CONTEXT,
      conversationId: mine,
      spaceId: 'sp_mojej_rozmowy',
      selection: [{ kind: 'offer', id: 'of_moje' }],
    };
    const out: any = await callTool('get_context', {}, { appContext, conversationId: mine });

    expect(out.currentContext.known).toBe(false);
    expect(out.currentContext.reason).toBe('other_conversation');
    // Nothing of the other conversation is anywhere in the answer.
    const text = JSON.stringify(out);
    expect(text).not.toContain('of_inne');
    expect(text).not.toContain('pc_inne');
    expect(text).not.toContain('sp_innej_rozmowy');
    // The task keeps the space and the selection it was started with.
    expect(out.spaceId).toBe('sp_mojej_rozmowy');
    expect(out.selection).toEqual([{ kind: 'offer', id: 'of_moje' }]);
  });
});

/* ========================================================================== */
/*  L6.10 — the target of a started operation, and the version at write       */
/* ========================================================================== */

describe('L6.10 — cel operacji i aktualnosc wersji przy zapisie', () => {
  it('nawigacja w trakcie wykonania nie przenosi mutacji na inny rekord', async () => {
    const cases = h.service.listCases(h.ownerId);
    const target = cases[0]!;
    const item = h.service.getCaseDetail(target.id, h.ownerId).offers.flatMap((o) => o.items)[0]!;
    const conversation = newConversation('Zapis w tle');

    const appContext: AppContext = {
      ...EMPTY_CONTEXT,
      conversationId: conversation,
      resource: { kind: 'case', id: target.id },
      selection: [{ kind: 'offer_item', id: item.id }],
      ui: { version: 1, clientId: 'ui_tab_kontekst', viewId: null, url: `/cases/${target.id}` },
    };
    h.platform.services.uiSnapshots.publish(
      h.ownerId,
      snapshotOf({
        clientId: 'ui_tab_kontekst',
        version: 1,
        conversationId: conversation,
        context: { resource: { kind: 'case', id: target.id }, selection: appContext.selection, drafts: [] },
      }),
    );

    const prompt = 'zmien cene wskazanej pozycji';
    plans.set(prompt, {
      script: [
        // The write is derived from the *command* context, read after the user moved.
        { kind: 'call', name: 'get_context', input: { minVersion: 2, clientId: 'ui_tab_kontekst', waitMs: 5000 } },
        {
          kind: 'call',
          name: 'procurement_update_offer_item',
          input: { itemId: item.id, unitPrice: 11.5, expectedVersion: item.version },
        },
      ],
      handle: emptyHandle(),
    });

    const started = await runtime.start({ ownerId: h.ownerId, conversationId: conversation, prompt, appContext });
    // The user navigates away to another record while the task runs.
    h.platform.services.uiSnapshots.publish(
      h.ownerId,
      snapshotOf({
        clientId: 'ui_tab_kontekst',
        version: 2,
        conversationId: conversation,
        url: '/data',
        context: { resource: { kind: 'case', id: 'pc_gdzie_indziej' }, selection: [], drafts: [] },
      }),
    );
    pending.push(started.done.catch(() => undefined));
    await started.done;

    const messages = h.platform.services.conversations
      .messages(conversation, h.ownerId)
      .filter((m) => m.role === 'tool');
    const context = JSON.parse(messages[0]!.content);
    // The agent saw the navigation …
    expect(context.currentContext.resource).toEqual({ kind: 'case', id: 'pc_gdzie_indziej' });
    expect(context.currentContext.changedSinceCommand).toContain('resource');
    // … and the operation's target did not move with it.
    expect(context.resource).toEqual({ kind: 'case', id: target.id });
    const after = h.service.getCaseDetail(target.id, h.ownerId).offers.flatMap((o) => o.items).find((i) => i.id === item.id)!;
    expect(after.unitPriceMinor).toBe(1150);
    expect(after.version).toBe(item.version + 1);
  });

  it('zapis narzedziem bez wersji jest odrzucony, a z nieaktualna wersja daje conflict bez nadpisania', async () => {
    const target = h.service.listCases(h.ownerId)[0]!;
    const item = h.service.getCaseDetail(target.id, h.ownerId).offers.flatMap((o) => o.items)[0]!;
    const before = item.unitPriceMinor;

    // No version at all: refused by the tool's own schema, nothing written.
    await expect(callTool('procurement_update_offer_item', { itemId: item.id, unitPrice: 1 })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(currentPrice(item.id)).toBe(before);

    // Somebody else changed the row in the meantime.
    await h.service.updateOfferItem({ itemId: item.id, unitPrice: 77, expectedVersion: item.version }, h.ownerId);
    await expect(
      callTool('procurement_update_offer_item', { itemId: item.id, unitPrice: 1, expectedVersion: item.version }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(currentPrice(item.id)).toBe(7700);
  });

  it('kompozycja karty: zapis bez wersji odrzucony, z nieaktualna wersja conflict', async () => {
    const space = h.platform.services.canvas.createSpace({
      ownerId: h.ownerId,
      title: 'Przestrzen',
      scopeKind: 'workspace',
      scopeId: 'w1',
    });
    const spec = { kind: 'component', component: 'platform.markdown', props: { markdown: 'a' } } as const;
    const card = await h.platform.services.canvas.addCard({ spaceId: space.id, title: 'K', spec }, h.ownerId);

    await expect(callTool('canvas_update_card', { cardId: card.id, spec })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await h.platform.services.canvas.updateSpec(
      { cardId: card.id, spec: { ...spec, props: { markdown: 'b' } }, expectedSpecVersion: card.specVersion },
      h.ownerId,
    );
    await expect(
      callTool('canvas_update_card', {
        cardId: card.id,
        spec: { ...spec, props: { markdown: 'c' } },
        expectedSpecVersion: card.specVersion,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((h.platform.services.canvas.getCard(card.id, h.ownerId).spec as any).props.markdown).toBe('b');
  });
});

/* ========================================================================== */
/*  L6.12 — a switch leaves nothing behind (store level)                      */
/* ========================================================================== */

describe('L6.12 — przelaczenie zakresu nie zostawia kontekstu poprzedniego', () => {
  it('zmiana przestrzeni czysci zaznaczenie i viewport poprzedniej przestrzeni', () => {
    const state = useAppState.getState();
    state.clearScopedContext();
    state.setSpace('sp_a');
    state.toggleSelection({ kind: 'card', id: 'card_z_a' });
    state.setViewport({ x: 10, y: 20, zoom: 2 });
    expect(useAppState.getState().toAppContext().selection).toHaveLength(1);

    useAppState.getState().setSpace('sp_b');
    const context = useAppState.getState().toAppContext();
    expect(context.spaceId).toBe('sp_b');
    expect(context.selection).toEqual([]);
    expect(context.viewport).toBeNull();
    // The same space again is not a move and must not clear anything.
    useAppState.getState().toggleSelection({ kind: 'card', id: 'card_z_b' });
    useAppState.getState().setSpace('sp_b');
    expect(useAppState.getState().toAppContext().selection).toHaveLength(1);
  });

  it('przestrzen rozmowy zastepuje biezaca tylko wtedy, gdy czat OPUSZCZA inna rozmowe', () => {
    /*
     * The rule `ConversationSync` applies when a conversation without a
     * workspace is opened. Pinned here because both cases below reach the same
     * `publish` decision, and treating them alike breaks one of them:
     *  - leaving A for B: B's scope wins, `null` included — otherwise A's
     *    workspace and the cards selected in it travel into B's first command;
     *  - coming from no conversation: nothing is being left, and the space on
     *    screen is the user's own. Clearing it there wiped the workspace
     *    somebody was looking at while they typed (caught by e2e in round 1).
     */
    expect(leavesAnotherConversation('cnv_a', 'cnv_b')).toBe(true);
    // A thread the chat has just created for the command being sent.
    expect(leavesAnotherConversation(null, 'cnv_nowa')).toBe(false);
    // First synchronisation after the page loaded, including a pick from the drawer.
    expect(leavesAnotherConversation(null, null)).toBe(false);
    // The backend naming the conversation already on screen is not a move either.
    expect(leavesAnotherConversation('cnv_a', 'cnv_a')).toBe(false);
    /*
     * Deliberately not `!decision.replace`, which answers a different question
     * and only happens to agree for A → B.
     */
    expect(decideRestore({ urlThreadId: null, selectedThreadId: 'cnv_1', lastSynced: null })).toEqual({
      action: 'publish',
      threadId: 'cnv_1',
      replace: true,
    });
    expect(leavesAnotherConversation(null, 'cnv_1')).toBe(false);
  });

  it('zmiana wlasciciela czysci caly zakres: rozmowa, przestrzen, zasob, zaznaczenie, szkice, zalaczniki', () => {
    resetAccessContext();
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');

    const state = useAppState.getState();
    state.setSpace('sp_poprzedni');
    state.setConversation('cnv_poprzednia');
    state.setResource({ kind: 'case', id: 'pc_poprzedni' });
    state.toggleSelection({ kind: 'offer', id: 'of_poprzednia' });
    state.setDraft({ formId: 'f', entity: 'offer', entityId: 'of_poprzednia', dirtyFields: ['x'], values: {} });
    state.setAttachments(['file_poprzedni']);
    state.setFilter('country', 'PL');
    state.patchRun('cnv_poprzednia', { phase: 'succeeded', runId: 'run_poprzedni' });
    const before = JSON.stringify(useAppState.getState().toAppContext());
    expect(before).toContain('pc_poprzedni');

    setAccessContext(qc, 'other-user');

    const after = useAppState.getState().toAppContext();
    const text = JSON.stringify(after);
    for (const leaked of ['sp_poprzedni', 'cnv_poprzednia', 'pc_poprzedni', 'of_poprzednia', 'PL']) {
      expect(text, leaked).not.toContain(leaked);
    }
    expect(after).toMatchObject({ conversationId: null, spaceId: null, resource: null, selection: [], drafts: [] });
    expect(useAppState.getState().attachments).toEqual([]);
    expect(useAppState.getState().runs).toEqual({});
    // The live context published with the screen is emptied too.
    expect(useAppState.getState().toLiveContext()).toEqual(EMPTY_UI_SNAPSHOT_CONTEXT);
    qc.clear();
  });
});

/* ========================================================================== */

describe('dowod pakietu', () => {
  it('zapisuje dowod tylko na zadanie, a asercje wykonuje zawsze', async () => {
    const own = h.service.listCases(h.ownerId)[0]!;
    const states = {
      brakZasobu: (await h.platform.registry.describeResource(null, h.ownerId)).state,
      opisany: (await h.platform.registry.describeResource({ kind: 'case', id: own.id }, h.ownerId)).state,
      usuniety: (await h.platform.registry.describeResource({ kind: 'case', id: 'pc_nie_ma' }, h.ownerId)).state,
      cudzy: (await h.platform.registry.describeResource({ kind: 'case', id: own.id }, h.otherOwnerId)).state,
      nieopisanyRodzaj: (await h.platform.registry.describeResource({ kind: 'zabawka', id: 'z' }, h.ownerId)).state,
    };
    expect(Object.values(states)).toEqual(['none', 'described', 'not_found', 'forbidden', 'not_described']);

    const result = writeEvidence(
      'kontekst-aplikacji.json',
      {
        opis:
          'Stany opisu zasobu i okno odczytu narzedzi agenta, z regresji tests/app-context.test.ts. ' +
          'Bez modelu i bez przegladarki: prawdziwe serwisy, prawdziwe handlery MCP.',
        zrodlo: 'pnpm evidence:z5 (APP_WRITE_EVIDENCE=1 vitest run tests/app-context.test.ts)',
        wersjaKodu: codeVersion(h.platform.versions, ['docs/evidence/z5-bl11a']),
        stanyOpisuZasobu: states,
        oknoOdczytu: {
          domyslnyLimit: READ_WINDOW_DEFAULT_LIMIT,
          /*
           * Read off the registry, not typed out here. A hand-written list was
           * six names long and stayed six names long after three more tools
           * took a window — the evidence file then described a state of the
           * code that had not been true for two commits.
           */
          narzedzia: windowedReadNames(),
        },
      },
      'docs/evidence/z5-bl11a',
    );
    expect(result.written).toBe(evidenceWritingRequested());
    expect(result.path).toContain('docs/evidence/z5-bl11a');
    const body = JSON.parse(result.body);
    expect(body.stanyOpisuZasobu.cudzy).toBe('forbidden');
    // An empty or shrunken list would be evidence of nothing, quietly.
    expect(body.oknoOdczytu.narzedzia, 'dowod wymienia windowane odczyty').toEqual(windowedReadNames());
    expect(body.oknoOdczytu.narzedzia.length).toBeGreaterThanOrEqual(9);
  });
});

/** Names of the agent's read tools that take a window, straight from the registry. */
function windowedReadNames(): string[] {
  return tools()
    .filter((t) => {
      const keys = Object.keys((t.def.inputSchema as any).shape);
      return t.def.effect === 'read' && keys.includes('limit') && keys.includes('offset');
    })
    .map((t) => t.localName)
    .sort();
}

/** A space of the signed-in owner, with a few cards in it. */
async function spaceWithCards(cards = 3): Promise<string> {
  const space = h.platform.services.canvas.createSpace({
    ownerId: h.ownerId,
    title: 'Przestrzen pomiarowa',
    scopeKind: 'workspace',
    scopeId: `w_${Math.random().toString(36).slice(2, 8)}`,
  });
  for (let i = 0; i < cards; i += 1) {
    await h.platform.services.canvas.addCard(
      {
        spaceId: space.id,
        title: `Karta ${i}`,
        spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'x'.repeat(40) } },
      },
      h.ownerId,
    );
  }
  return space.id;
}

const emptyHandle = (): StandInHandle => ({
  childExitedAt: null,
  childPid: null,
  performed: [],
  dispose: () => {},
});

function currentPrice(itemId: string): number | null {
  const cases = h.service.listCases(h.ownerId);
  for (const c of cases) {
    const found = h.service
      .getCaseDetail(c.id, h.ownerId)
      .offers.flatMap((o) => o.items)
      .find((i) => i.id === itemId);
    if (found) return found.unitPriceMinor;
  }
  throw new AppError('not_found', `pozycja ${itemId}`);
}
