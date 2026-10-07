import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  AUTO_APPROVED_FILE_TOOLS,
  CONSENT_REQUIRED_TOOLS,
  FORBIDDEN_TOOLS,
  collectToolEntries,
  declaresPathArguments,
  decideTool,
  platformTools,
} from '@platform/server';
import { taskRetryResultSchema, taskViewSchema } from '@platform/contracts';
import { createHarness, login, type Harness } from './helpers.ts';
import {
  dispatchingAgent,
  newStandInHandle,
  type Plan,
  type StandInHandle,
  type Step,
} from './support/model-standin.ts';

/**
 * Trzy tryby zgód (L11.12) i `pendingPermission` w centrum zadań (L11.19).
 *
 * **Symulacja, i tak jest oznaczona.** Model jest zastąpiony na granicy
 * adaptera zastępnikiem z `tests/support/model-standin.ts`, który dostaje
 * prawdziwe `sdkOptions` — łącznie z prawdziwą bramką `canUseTool` — i pyta
 * bramkę dokładnie tam, gdzie pytałoby SDK. Reszta jest prawdziwa: runtime,
 * rejestr uruchomień, strumień zdarzeń, baza (kolumna `consent_mode`), HTTP.
 *
 * Tryb jest własnością **uruchomienia**: zapisywanym raz, przy starcie,
 * odczytywanym z rekordu przy każdej decyzji bramki — nigdy z bieżącego
 * payloadu, więc w trakcie wykonania nie ma drogi eskalacji.
 */

type ConsentMode = 'manual' | 'supervised' | 'auto';
const MODES: readonly ConsentMode[] = ['manual', 'supervised', 'auto'];

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

const conversation = (title = 'Tryby zgod') =>
  h.platform.services.conversations.create({ ownerId: h.ownerId, title }).id;

async function startRun(conversationId: string, script: Step[], consentMode?: ConsentMode) {
  promptSeq += 1;
  const prompt = `polecenie trybow ${promptSeq}`;
  const handle: StandInHandle = newStandInHandle();
  plans.set(prompt, { script, handle });
  const started = await runtime.start({
    ownerId: h.ownerId,
    conversationId,
    prompt,
    appContext: { ...EMPTY_CONTEXT, conversationId },
    ...(consentMode ? { consentMode } : {}),
  });
  const events: Array<Record<string, any>> = [];
  const reader = (async () => {
    for await (const e of started.stream.read(0)) events.push(e.event as Record<string, any>);
  })();
  pending.push(started.done.catch(() => undefined), reader);
  return {
    stand: handle,
    runId: started.runId,
    done: started.done,
    events,
    run: () => h.platform.services.runs.get(started.runId, h.ownerId),
  };
}

const permissionRequestsOf = (events: Array<Record<string, any>>) =>
  events.filter((e) => e.name === 'platform.permission_request').map((e) => e.value as {
    requestId: string;
    toolName: string;
    runId: string;
  });

const textOf = (events: Array<Record<string, any>>) =>
  events
    .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
    .map((e) => e.delta)
    .join('');

const waitUntil = async (predicate: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('warunek nie zaszedl w czasie');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const waitUntilAsync = async (predicate: () => Promise<boolean>, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('warunek nie zaszedl w czasie');
    await new Promise((r) => setTimeout(r, 50));
  }
};

/* --------------------------- HTTP i baza pomocniczo ------------------------ */

const postRunHttp = async (body: Record<string, unknown>) => {
  const cookie = await login(h.platform.app, h.ownerId);
  const res = await h.platform.app.request('/api/agui/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return res;
};

/** Startuje run przez prawdziwą ścieżkę HTTP; plan zastępnika kluczowany treścią polecenia. */
async function httpRun(content: string, script: Step[], consentMode?: ConsentMode) {
  const handle: StandInHandle = newStandInHandle();
  plans.set(content, { script, handle });
  const res = await postRunHttp({
    runId: `consent-modes-${promptSeq++}`,
    messages: [{ id: `m-cm-${promptSeq}`, role: 'user', content }],
    ...(consentMode ? { consentMode } : {}),
  });
  expect(res.status).toBe(200);
  const runId = res.headers.get('X-Run-Id')!;
  expect(runId).toBeTruthy();
  /* Strumień nie jest czytany do końca: run jest pracą backendu, nie odpowiedzią HTTP. */
  await res.body?.cancel().catch(() => undefined);
  return { runId };
}

const getTasks = async () => {
  const cookie = await login(h.platform.app, h.ownerId);
  const res = await h.platform.app.request('/api/tasks', { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as { tasks: unknown[] };
};

const taskOf = async (runId: string) => {
  const { tasks } = await getTasks();
  const raw = tasks.find((t) => (t as { run: { id: string } }).run.id === runId);
  expect(raw, 'zadanie ma byc widoczne w centrum').toBeTruthy();
  return taskViewSchema.parse(raw);
};

const countRuns = () =>
  (h.platform.db.$client.prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }).n;

const consentModeInDb = (runId: string): string | undefined =>
  (
    h.platform.db.$client.prepare('SELECT consent_mode FROM agent_runs WHERE id = ?').get(runId) as
      | { consent_mode?: string }
      | undefined
  )?.consent_mode;

beforeEach(async () => {
  plans = new Map();
  /*
   * Zastępnik w runtime **platformy** — trasa HTTP musi decydować o tym samym
   * wykonaniu, o którym pytają testy (jakaś przyczyna, jak w consent.test.ts).
   */
  h = await createHarness({
    withModule: false,
    modelAgent: dispatchingAgent(plans, () =>
      collectToolEntries({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
      }),
    ),
  });
  runtime = h.platform.runtime;
  h.platform.config.consentTimeoutMs = 10_000;
});
afterEach(async () => {
  h.platform.services.runs.abortAll('koniec_testu');
  await Promise.allSettled(pending.splice(0));
  h.dispose();
});

/* ----------------------------- (a) macierz decyzji ------------------------- */

describe('macierz decyzyjna trzech trybow', () => {
  const MCP_NAMES = ['mcp__app__files_list'];

  const CASES: Array<{ what: string; tool: string; expected: Record<ConsentMode, string> }> = [
    {
      what: 'narzedzie MCP aplikacji',
      tool: 'mcp__app__files_list',
      expected: { manual: 'consent', supervised: 'auto', auto: 'auto' },
    },
    {
      what: 'narzedzie plikowe',
      tool: 'Read',
      expected: { manual: 'consent', supervised: 'auto', auto: 'auto' },
    },
    {
      what: 'powloka — kategoria decyzja',
      tool: 'Bash',
      expected: { manual: 'consent', supervised: 'consent', auto: 'auto' },
    },
    {
      what: 'narzedzie nieznane',
      tool: 'NarzedzieZPrzyszlosci',
      expected: { manual: 'consent', supervised: 'consent', auto: 'auto' },
    },
    {
      what: 'narzedzie zabronione',
      tool: 'WebFetch',
      expected: { manual: 'forbidden', supervised: 'forbidden', auto: 'forbidden' },
    },
  ];

  for (const c of CASES) {
    it(`macierz: ${c.what}`, () => {
      for (const mode of MODES) {
        expect(decideTool(c.tool, MCP_NAMES, mode), `${c.tool} w trybie ${mode}`).toBe(
          c.expected[mode],
        );
      }
    });
  }

  it('wywolanie bez trybu pozostaje zachowaniem obecnym (supervised)', () => {
    // Kompatybilność istniejących wywołań: brak trzeciego argumentu znaczy „tak jak dotąd".
    expect(decideTool('Read', MCP_NAMES)).toBe('auto');
    expect(decideTool('Bash', MCP_NAMES)).toBe('consent');
    expect(decideTool('WebFetch', MCP_NAMES)).toBe('forbidden');
  });
});

/* -------------------- (f) niezmienniki sdkOptions w trybach ---------------- */

describe('niezmienniki sdkOptions we wszystkich trybach', () => {
  it('allowedTools bez kategorii decyzja, disallowedTools = zabronione, bramka przekazana', async () => {
    const captured = new Map<string, Record<string, any>>();
    const capturing = new AgentRuntime(h.platform.services, {
      stream: async (p, o: any) => {
        captured.set(String(p), o.sdkOptions as Record<string, any>);
        return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'ok' } }; })() };
      },
      resumeStream: async (i, o: any) => {
        captured.set(
          String((i as { message: string }).message),
          o.sdkOptions as Record<string, any>,
        );
        return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'ok' } }; })() };
      },
    });
    for (const mode of MODES) {
      const started = await capturing.start({
        ownerId: h.ownerId,
        conversationId: conversation(`Reguly ${mode}`),
        prompt: mode,
        appContext: { ...EMPTY_CONTEXT },
        ...(mode !== 'supervised' ? { consentMode: mode } : {}),
      });
      await started.done;
    }

    for (const mode of MODES) {
      const options = captured.get(mode);
      expect(options, `stand-in nie dostal sdkOptions w trybie ${mode}`).toBeTruthy();
      expect(options!.disallowedTools, `tryb ${mode}: deny-rule to kategoria zabroniona`).toEqual([
        ...FORBIDDEN_TOOLS,
      ]);
      for (const tool of CONSENT_REQUIRED_TOOLS) {
        expect(
          options!.allowedTools,
          `tryb ${mode}: ${tool} na allowedTools omija bramke zgody`,
        ).not.toContain(tool);
      }
      for (const tool of FORBIDDEN_TOOLS) {
        expect(options!.allowedTools, `tryb ${mode}: ${tool} w allowedTools`).not.toContain(tool);
      }
      // Bramka canUseTool jest przekazywana w każdym trybie — pozostaje jedynym
      // mechanizmem zgody, także gdy autozatwierdza.
      expect(typeof options!.canUseTool, `tryb ${mode}: brak bramki canUseTool`).toBe('function');
      /*
       * (f')/(f'') — jedyna różnica między trybami na poziomie SDK. Reguła
       * allow cieńuje bramkę `canUseTool` (SDK zatwierdza po stronie listy,
       * zanim bramka cokolwiek zobaczy), więc w trybie `manual` lista dozwolonych
       * musi być PUSTA: każde wywołanie inicjowane przez agenta ma dotrzeć do
       * pytania (D-06: „prosi o zgodę przed każdą akcją"). `supervised` i `auto`
       * dostają listę jak dotychczas — narzędzia aplikacji i narzędzia plikowe,
       * które zadeklarowały, jak podają ścieżkę.
       */
      if (mode === 'manual') {
        expect(options!.allowedTools, `tryb ${mode}: allowedTools ma byc puste`).toEqual([]);
      } else {
        expect(options!.allowedTools, `tryb ${mode}: lista jak dotychczas`).toEqual([
          ...capturing.toolNames,
          ...AUTO_APPROVED_FILE_TOOLS.filter(declaresPathArguments),
        ]);
      }
    }
  });
});

/* ------------------------- (b) zabronione w każdym trybie ------------------ */

describe('narzedzie zabronione we wszystkich trybach', () => {
  it('zero permissionRequest i zero skutku, niezaleznie od trybu', async () => {
    for (const mode of MODES) {
      const started = await startRun(
        conversation(`Zabronione ${mode}`),
        [
          { kind: 'ask', toolName: 'WebFetch', input: { url: 'https://example.invalid' }, then: [{ kind: 'text', text: 'POBRANO' }] },
          { kind: 'text', text: 'koniec' },
        ],
        mode,
      );
      await started.done;

      expect(started.stand.gate, `tryb ${mode}`).toEqual([
        expect.objectContaining({ toolName: 'WebFetch', allowed: false }),
      ]);
      expect(permissionRequestsOf(started.events), `tryb ${mode}: pytanie o narzedzie zabronione`).toEqual([]);
      expect(textOf(started.events), `tryb ${mode}: skutek po odmowie`).not.toContain('POBRANO');
      expect(started.run().status).toBe('succeeded');
    }
  });
});

/* ------------------------------ (g) tryb auto ------------------------------ */

describe('tryb auto', () => {
  it('Bash wykonuje sie bez permissionRequest i bez fazy oczekiwania na zgode', async () => {
    const started = await startRun(
      conversation(),
      [
        {
          kind: 'ask',
          toolName: 'Bash',
          input: { command: 'node przetworz.mjs' },
          then: [{ kind: 'call', name: 'artifact_create', input: { title: 'Wynik auto', kind: 'report', rendererType: 'platform.markdown', content: { text: 'ok' }, operationId: 'tryb-auto-1' } }],
        },
        { kind: 'text', text: 'koniec' },
      ],
      'auto',
    );
    await started.done;

    // Bramka odpowiedziała zgodą, ale cała ścieżka pytania zamilkła: ani
    // `permission_request`, ani `permission_resolved` (a `markAwaitingConsent`
    // stoi w tej samej gałęzi, tuż przed zdarzeniem — brak obu zdarzeń jest
    // zewnętrznym dowodem, że faza `awaiting_consent` nie nastąpiła).
    expect(started.stand.gate).toEqual([expect.objectContaining({ toolName: 'Bash', allowed: true })]);
    expect(permissionRequestsOf(started.events)).toEqual([]);
    expect(
      started.events.filter((e) => e.name === 'platform.permission_resolved'),
      'auto: rozwiazanie zgody nie powinno istniec',
    ).toEqual([]);
    expect(started.stand.performed).toEqual(['artifact_create']);
    expect(h.platform.services.artifacts.list(h.ownerId)).toHaveLength(1);
    expect(started.run().status).toBe('succeeded');
  });
});

/* ----------------------------- (h) tryb manual ----------------------------- */

describe('tryb manual', () => {
  const SCRIPT: Step[] = [
    {
      kind: 'ask',
      toolName: 'mcp__app__files_list',
      input: {},
      then: [{ kind: 'call', name: 'files_list', input: {} }],
    },
    { kind: 'text', text: 'koniec' },
  ];

  it('odczyt MCP aplikacji pyta; odmowa zostawia zero skutku', async () => {
    const started = await startRun(conversation('Manual odmowa'), SCRIPT, 'manual');
    await waitUntil(() => permissionRequestsOf(started.events).length > 0);
    const request = permissionRequestsOf(started.events)[0]!;
    expect(request.toolName).toBe('mcp__app__files_list');
    expect(started.run().status).toBe('awaiting_consent');

    expect(
      runtime.answerPermission({
        runId: started.runId,
        ownerId: h.ownerId,
        requestId: request.requestId,
        allow: false,
      }),
    ).toBe(true);
    await started.done;

    expect(started.stand.gate).toEqual([
      expect.objectContaining({ toolName: 'mcp__app__files_list', allowed: false }),
    ]);
    expect(started.stand.performed, 'odmowa: zero skutku').toEqual([]);
  });

  it('zgoda wykonuje odczyt dokladnie raz', async () => {
    const started = await startRun(conversation('Manual zgoda'), SCRIPT, 'manual');
    await waitUntil(() => permissionRequestsOf(started.events).length > 0);
    const request = permissionRequestsOf(started.events)[0]!;
    runtime.answerPermission({
      runId: started.runId,
      ownerId: h.ownerId,
      requestId: request.requestId,
      allow: true,
    });
    await started.done;

    expect(permissionRequestsOf(started.events)).toHaveLength(1);
    expect(started.events.filter((e) => e.name === 'platform.permission_resolved')).toHaveLength(1);
    expect(started.stand.gate).toEqual([
      expect.objectContaining({ toolName: 'mcp__app__files_list', allowed: true }),
    ]);
    expect(started.stand.performed, 'dokladnie jedno wykonanie').toEqual(['files_list']);
  });
});

/* --------------------- (c)(d)(e) start runu i walidacja -------------------- */

describe('tryb zgody przy starcie runu', () => {
  it('(c) brak pola consentMode w payloadzie: run jest supervised', async () => {
    const { runId } = await httpRun('polecenie bez trybu', [
      { kind: 'text', text: 'ok' },
    ]);
    const task = await taskOf(runId);
    expect(task.consentMode).toBe('supervised');
    expect(task.run.consentMode).toBe('supervised');
    expect(consentModeInDb(runId)).toBe('supervised');
  });

  it('(d) niepoprawne consentMode: 400 i zaden run nie powstaje', async () => {
    const runsBefore = countRuns();
    const res = await postRunHttp({
      runId: 'consent-modes-bad',
      messages: [{ id: 'm-cm-bad', role: 'user', content: 'polecenie zlym trybie' }],
      consentMode: 'autopilot',
    });
    expect(res.status).toBe(400);
    await res.body?.cancel().catch(() => undefined);
    expect(countRuns(), 'zadne uruchomienie nie powstalo').toBe(runsBefore);
  });

  it('(e) tryb z payloadu trafia do agent_runs.consent_mode i do GET /api/tasks', async () => {
    const { runId } = await httpRun('polecenie w trybie auto', [{ kind: 'text', text: 'ok' }], 'auto');
    const task = await taskOf(runId);
    expect(task.consentMode).toBe('auto');
    expect(task.run.consentMode).toBe('auto');
    expect(consentModeInDb(runId)).toBe('auto');
  });
});

/* --------------- (i) pendingPermission w centrum zadan (L11.19) ------------ */

describe('pendingPermission w centrum zadan', () => {
  it('pojawia sie w fazie oczekiwania i znika po odpowiedzi', async () => {
    const { runId } = await httpRun('polecenie czekajace na zgode', [
      {
        kind: 'ask',
        toolName: 'Bash',
        input: { command: 'echo czekam' },
        then: [{ kind: 'text', text: 'po zgodzie' }],
      },
      { kind: 'text', text: 'koniec' },
    ]);

    await waitUntilAsync(async () => (await taskOf(runId)).pendingPermission !== undefined);
    const waiting = await taskOf(runId);
    expect(waiting.run.status).toBe('awaiting_consent');
    expect(waiting.pendingPermission!.toolName).toBe('Bash');
    expect(waiting.pendingPermission!.input).toEqual({ command: 'echo czekam' });
    expect(waiting.pendingPermission!.requestId).toBeTruthy();
    // Widok centrum i mapa bramki mówią o tym samym pytaniu.
    expect(runtime.pendingPermissionIds()).toContain(waiting.pendingPermission!.requestId);

    const cookie = await login(h.platform.app, h.ownerId);
    const res = await h.platform.app.request(`/api/runs/${runId}/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ requestId: waiting.pendingPermission!.requestId, allow: false }),
    });
    expect(res.status).toBe(200);

    await waitUntilAsync(async () => (await taskOf(runId)).run.status === 'succeeded');
    const after = await taskOf(runId);
    expect(after.pendingPermission, 'po odpowiedzi pytanie znika z centrum').toBeUndefined();
    expect(after.run.consentMode).toBe('supervised');
  });
});

/* -------------- (j) katalog narzedzi bez zmieniacza trybu zgody ------------ */

describe('katalog narzedzi MCP', () => {
  it('nie zawiera narzedzia zmieniajacego tryb zgody', async () => {
    const hj = await createHarness({ withModule: true });
    try {
      const entries = collectToolEntries({
        registry: hj.platform.registry,
        platformTools: platformTools(hj.platform.services),
      });
      const names = entries.map((e) => `mcp__app__${e.localName}`);
      expect(names.length).toBeGreaterThan(0);
      const modeChangers = names.filter((n) => /consent|zgoda|mode/i.test(n));
      expect(modeChangers, 'narzedzie zmieniajace tryb zgody w katalogu MCP').toEqual([]);
    } finally {
      hj.dispose();
    }
  });
});

/* ------------------------- (k) brak eskalacji w trakcie -------------------- */

describe('brak eskalacji trybu w trakcie wykonania', () => {
  it('consentMode w zadaniu zgody nie zmienia decyzji kolejnej bramki tego runu', async () => {
    const started = await startRun(conversation(), [
      { kind: 'ask', toolName: 'Bash', input: { command: 'echo raz' }, then: [{ kind: 'text', text: 'RAZ' }] },
      { kind: 'ask', toolName: 'Bash', input: { command: 'echo dwa' }, then: [{ kind: 'text', text: 'DWA' }] },
      { kind: 'text', text: 'koniec' },
    ]);
    await waitUntil(() => permissionRequestsOf(started.events).length >= 1);
    const first = permissionRequestsOf(started.events)[0]!;

    const cookie = await login(h.platform.app, h.ownerId);
    const res = await h.platform.app.request(`/api/runs/${started.runId}/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ requestId: first.requestId, allow: true, consentMode: 'auto' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answered: boolean }).answered).toBe(true);

    // Kolejna bramka TEGO SAMEGO runu wciąż pyta: tryb jest w rekordzie, nie w payloadzie.
    await waitUntil(() => permissionRequestsOf(started.events).length >= 2);
    expect(started.run().consentMode).toBe('supervised');
    expect(started.run().status).toBe('awaiting_consent');

    const second = permissionRequestsOf(started.events)[1]!;
    runtime.answerPermission({
      runId: started.runId,
      ownerId: h.ownerId,
      requestId: second.requestId,
      allow: true,
    });
    await started.done;

    expect(permissionRequestsOf(started.events)).toHaveLength(2);
    expect(started.stand.gate).toHaveLength(2);
    expect(started.stand.gate.every((g) => g.allowed)).toBe(true);
    expect(started.run().consentMode).toBe('supervised');
  });
});

/* ----------------- ponowienie dziedziczy tryb zgody źródła ----------------- */

describe('ponowienie (retry) dziedziczy tryb zgody', () => {
  const MCP_ASK_SCRIPT: Step[] = [
    {
      kind: 'ask',
      toolName: 'mcp__app__files_list',
      input: {},
      then: [{ kind: 'call', name: 'files_list', input: {} }],
    },
    { kind: 'text', text: 'koniec' },
  ];

  const retryOf = async (runId: string) => {
    const cookie = await login(h.platform.app, h.ownerId);
    const res = await h.platform.app.request(`/api/runs/${runId}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
    });
    expect(res.status).toBe(200);
    return taskRetryResultSchema.parse(await res.json());
  };

  it('retry runu manual tworzy run manual', async () => {
    const conv = conversation('Retry manual');
    const first = await startRun(conv, MCP_ASK_SCRIPT, 'manual');
    await waitUntil(() => permissionRequestsOf(first.events).length > 0);
    const request = permissionRequestsOf(first.events)[0]!;
    runtime.answerPermission({
      runId: first.runId,
      ownerId: h.ownerId,
      requestId: request.requestId,
      allow: false,
    });
    await first.done;
    expect(first.run().consentMode).toBe('manual');

    // To ta sama intencja użytkownika: ponowienie nie może po cichu obniżyć
    // rygoru do supervised — ani go podnieść.
    const retried = await retryOf(first.runId);
    expect(retried.run.id).not.toBe(first.runId);
    expect(retried.run.consentMode, 'ponowienie dziedziczy tryb manual').toBe('manual');
    expect(consentModeInDb(retried.run.id)).toBe('manual');

    // Odziedziczony tryb działa: ponowione wykonanie także pyta.
    await waitUntil(() => runtime.pendingPermissionFor(retried.run.id) !== undefined);
    const pending = runtime.pendingPermissionFor(retried.run.id)!;
    expect(pending.toolName).toBe('mcp__app__files_list');
    runtime.answerPermission({
      runId: retried.run.id,
      ownerId: h.ownerId,
      requestId: pending.requestId,
      allow: false,
    });
  });

  it('retry runu bez zapisanego trybu (stary wiersz po migracji = supervised) tworzy supervised', async () => {
    // Wiersz utworzony bez pola w payloadzie niesie z migracji dokładnie to,
    // co stary wiersz po platform-0008: 'supervised'. Dziedziczenie musi więc
    // dać supervised, nie wartość „clever".
    const conv = conversation('Retry supervised');
    const first = await startRun(conv, [{ kind: 'text', text: 'ok' }]);
    await first.done;
    expect(consentModeInDb(first.runId)).toBe('supervised');

    const retried = await retryOf(first.runId);
    expect(retried.run.id).not.toBe(first.runId);
    expect(retried.run.consentMode).toBe('supervised');
  });
});
