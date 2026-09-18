import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  TOOL_PERMISSION_MATRIX,
  collectToolEntries,
  decideTool,
  platformTools,
} from '@platform/server';
import { createHarness, login, type Harness } from './helpers.ts';
import {
  dispatchingAgent,
  newStandInHandle,
  type Plan,
  type StandInHandle,
  type Step,
} from './support/model-standin.ts';

/**
 * The consent gate: which tools reach it, which never do, and what an answer
 * is allowed to decide.
 *
 * **Simulation, and marked as such.** The model is replaced at the adapter
 * boundary by a stand-in that receives the real `sdkOptions` — including the
 * real `canUseTool` — and calls the gate exactly where the SDK would. Everything
 * else is the application: the runtime, the event stream, the run registry, the
 * HTTP route that answers a question. What a stand-in cannot show is the SDK's
 * own *ordering* of its three permission mechanisms, and nothing here claims to:
 * see the file header of `agent/permissions.ts` and docs/ACCEPTANCE.md, L11.12.
 *
 * The properties under test are the ones a happy-path run never exercises: a
 * refusal, a repeat, an answer sent to the wrong run, and an answer nobody ever
 * gives.
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

async function startRun(conversationId: string, script: Step[]) {
  promptSeq += 1;
  const prompt = `polecenie zgody ${promptSeq}`;
  const handle: StandInHandle = newStandInHandle();
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
  return {
    stand: handle,
    runId: started.runId,
    done: started.done,
    events,
    run: () => h.platform.services.runs.get(started.runId, h.ownerId),
  };
}

const conversation = (title = 'Zgody') =>
  h.platform.services.conversations.create({ ownerId: h.ownerId, title }).id;

/** The permission request this run emitted, once it has emitted one. */
const permissionOf = (events: Array<Record<string, any>>) =>
  events.find((e) => e.name === 'platform.permission_request')?.value as
    | { requestId: string; toolName: string; runId: string }
    | undefined;

const waitUntil = async (predicate: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('warunek nie zaszedl w czasie');
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(async () => {
  plans = new Map();
  /*
   * The stand-in is installed in the **platform's own** runtime, not in a second
   * one beside it, because the HTTP routes answer through `platform.runtime`. A
   * runtime the routes do not know about would take every decision sent over
   * HTTP and silently drop it — which looks exactly like the defect these tests
   * are about.
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
  /*
   * Long enough that a question stays open while a test drives the answer, and
   * short enough that a forgotten one cannot hold the suite. The expiry branch
   * sets its own, much shorter value — the default is two minutes and is the
   * very same code path.
   */
  h.platform.config.consentTimeoutMs = 10_000;
});
afterEach(async () => {
  h.platform.services.runs.abortAll('koniec_testu');
  await Promise.allSettled(pending.splice(0));
  h.dispose();
});

/* ------------------------------- the matrix ------------------------------- */

describe('macierz uprawnien narzedzi', () => {
  it('trzy kategorie sa rozlaczne i kazda ma tresc', () => {
    const { auto, consent, forbidden } = TOOL_PERMISSION_MATRIX;
    expect(auto.length).toBeGreaterThan(0);
    expect(consent.length).toBeGreaterThan(0);
    // The category the matrix used to lack entirely.
    expect(forbidden.length).toBeGreaterThan(0);
    const all = [...auto, ...consent, ...forbidden];
    expect(new Set(all).size, 'narzedzie w dwoch kategoriach naraz').toBe(all.length);
  });

  it('decyduje o narzedziu po nazwie, a nieznane trafia do pytania', () => {
    const mcp = ['mcp__app__files_list'];
    expect(decideTool('Read', mcp)).toBe('auto');
    expect(decideTool('mcp__app__files_list', mcp)).toBe('auto');
    expect(decideTool('Bash', mcp)).toBe('consent');
    expect(decideTool('WebFetch', mcp)).toBe('forbidden');
    expect(decideTool('WebSearch', mcp)).toBe('forbidden');
    // The default is the cautious one: a tool a future SDK adds asks.
    expect(decideTool('NarzedzieZPrzyszlosci', mcp)).toBe('consent');
  });

  it('uruchomienie przekazuje SDK reguly zgodne z macierza', async () => {
    let captured: Record<string, any> | null = null;
    const capturing = new AgentRuntime(h.platform.services, {
      stream: async (_p, o: any) => {
        captured = o.sdkOptions as Record<string, any>;
        return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'ok' } }; })() };
      },
      resumeStream: async (_i, o: any) => {
        captured = o.sdkOptions as Record<string, any>;
        return { fullStream: (async function* () { yield { type: 'text-delta', payload: { text: 'ok' } }; })() };
      },
    });
    const started = await capturing.start({
      ownerId: h.ownerId,
      conversationId: conversation('Reguly'),
      prompt: 'sprawdz reguly',
      appContext: { ...EMPTY_CONTEXT },
    });
    await started.done;

    const options = captured as unknown as { allowedTools: string[]; disallowedTools: string[] };
    expect(options, 'stand-in nie dostal sdkOptions').toBeTruthy();
    // The deny rule is passed, so a forbidden tool is not even in the model's
    // context — the gate below is the second line, not the only one.
    expect(options.disallowedTools).toEqual([...TOOL_PERMISSION_MATRIX.forbidden]);
    for (const tool of TOOL_PERMISSION_MATRIX.auto) {
      expect(options.allowedTools, `${tool} nie jest wstepnie zatwierdzone`).toContain(tool);
    }
    for (const tool of TOOL_PERMISSION_MATRIX.consent) {
      /*
       * The mechanism that makes the gate reachable at all: an allow rule here
       * would auto-approve the call before `canUseTool` ran, and the consent
       * prompt would be dead code while looking perfectly alive.
       */
      expect(options.allowedTools, `${tool} na liscie allowedTools omija bramke zgody`).not.toContain(tool);
    }
    for (const tool of TOOL_PERMISSION_MATRIX.forbidden) {
      expect(options.allowedTools).not.toContain(tool);
    }
  });
});

/* ------------------------------- the gate --------------------------------- */

describe('bramka zgody', () => {
  it('narzedzie zabronione jest odrzucone bez pytania uzytkownika', async () => {
    const started = await startRun(conversation(), [
      { kind: 'ask', toolName: 'WebFetch', input: { url: 'https://example.invalid' }, then: [{ kind: 'text', text: 'POBRANO' }] },
      { kind: 'text', text: 'koniec' },
    ]);
    await started.done;

    expect(started.stand.gate).toEqual([
      expect.objectContaining({ toolName: 'WebFetch', allowed: false }),
    ]);
    // Nobody was asked: no request reached the conversation at all.
    expect(permissionOf(started.events)).toBeUndefined();
    // And the work behind the refusal did not happen.
    const text = started.events
      .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
      .map((e) => e.delta)
      .join('');
    expect(text).not.toContain('POBRANO');
    expect(started.run().status).toBe('succeeded');
  });

  it('narzedzie wymagajace zgody pyta i czeka; odmowa nie wykonuje operacji', async () => {
    const started = await startRun(conversation(), [
      {
        kind: 'ask',
        toolName: 'Bash',
        input: { command: 'node przetworz.mjs' },
        then: [{ kind: 'call', name: 'artifact_create', input: { title: 'Nie powinno powstac', kind: 'report', rendererType: 'platform.markdown', content: { text: 'x' }, operationId: 'zgoda-odmowa-1' } }],
      },
      { kind: 'text', text: 'koniec' },
    ]);

    await waitUntil(() => permissionOf(started.events) !== undefined);
    const request = permissionOf(started.events)!;
    expect(request.toolName).toBe('Bash');
    expect(request.runId).toBe(started.runId);
    // Waiting is a stored status, not only a screen state.
    expect(started.run().status).toBe('awaiting_consent');
    expect(h.platform.services.runs.listActive(h.ownerId).map((r) => r.id)).toContain(started.runId);

    expect(
      runtime.answerPermission({
        runId: started.runId,
        ownerId: h.ownerId,
        requestId: request.requestId,
        allow: false,
      }),
    ).toBe(true);
    await started.done;

    // The refusal branch: the tool never ran, so there is no artifact.
    expect(started.stand.gate).toEqual([expect.objectContaining({ toolName: 'Bash', allowed: false })]);
    expect(started.stand.performed).toEqual([]);
    expect(h.platform.services.artifacts.list(h.ownerId)).toHaveLength(0);
    expect(started.run().status).toBe('succeeded');
  });

  it('zgoda wykonuje operacje dokladnie raz, a powtorzona odpowiedz nie wykonuje jej drugi raz', async () => {
    const started = await startRun(conversation(), [
      {
        kind: 'ask',
        toolName: 'Bash',
        input: { command: 'node przetworz.mjs' },
        then: [{ kind: 'call', name: 'artifact_create', input: { title: 'Wynik', kind: 'report', rendererType: 'platform.markdown', content: { text: 'ok' }, operationId: 'zgoda-raz-1' } }],
      },
      { kind: 'text', text: 'koniec' },
    ]);
    await waitUntil(() => permissionOf(started.events) !== undefined);
    const request = permissionOf(started.events)!;
    const answer = (allow: boolean) =>
      runtime.answerPermission({ runId: started.runId, ownerId: h.ownerId, requestId: request.requestId, allow });

    expect(answer(true)).toBe(true);
    // The same answer again — a double click, a retried POST, a reconnecting
    // client. It decides nothing, because the question is no longer open.
    expect(answer(true)).toBe(false);
    expect(answer(false)).toBe(false);
    await started.done;

    expect(started.stand.gate).toHaveLength(1);
    expect(started.stand.performed).toEqual(['artifact_create']);
    expect(h.platform.services.artifacts.list(h.ownerId)).toHaveLength(1);
  });

  it('odpowiedz z requestId innego uruchomienia nie rozstrzyga niczego', async () => {
    const script: Step[] = [
      { kind: 'ask', toolName: 'Bash', input: { command: 'echo a' }, then: [{ kind: 'text', text: 'WYKONANO' }] },
      { kind: 'text', text: 'koniec' },
    ];
    const a = await startRun(conversation('A'), script);
    const b = await startRun(conversation('B'), script);
    await waitUntil(() => permissionOf(a.events) !== undefined && permissionOf(b.events) !== undefined);
    const requestA = permissionOf(a.events)!;
    const requestB = permissionOf(b.events)!;
    expect(requestA.requestId).not.toBe(requestB.requestId);

    /*
     * The defect this replaces: the runtime resolved by request id alone, so an
     * answer posted to A's address carrying B's request id decided B — and the
     * ownership check on A's address said nothing about B.
     */
    expect(
      runtime.answerPermission({ runId: a.runId, ownerId: h.ownerId, requestId: requestB.requestId, allow: true }),
    ).toBe(false);
    // B is still waiting, so nothing was decided in its name.
    expect(runtime.pendingPermissionIds()).toContain(requestB.requestId);
    expect(b.run().status).toBe('awaiting_consent');

    // Another owner cannot decide either, even with the right request id.
    expect(
      runtime.answerPermission({ runId: a.runId, ownerId: h.otherOwnerId, requestId: requestA.requestId, allow: true }),
    ).toBe(false);
    expect(runtime.pendingPermissionIds()).toContain(requestA.requestId);

    for (const started of [a, b]) {
      runtime.answerPermission({
        runId: started.runId,
        ownerId: h.ownerId,
        requestId: permissionOf(started.events)!.requestId,
        allow: false,
      });
    }
    await Promise.all([a.done, b.done]);
  });

  it('brak odpowiedzi konczy sie odmowa, nie zgoda', async () => {
    h.platform.config.consentTimeoutMs = 400;
    const started = await startRun(conversation(), [
      {
        kind: 'ask',
        toolName: 'Bash',
        input: { command: 'node przetworz.mjs' },
        then: [{ kind: 'call', name: 'artifact_create', input: { title: 'Nie powinno powstac', kind: 'report', rendererType: 'platform.markdown', content: { text: 'x' }, operationId: 'zgoda-odmowa-1' } }],
      },
      { kind: 'text', text: 'koniec' },
    ]);
    await waitUntil(() => permissionOf(started.events) !== undefined);
    const request = permissionOf(started.events)!;

    // Nobody answers. The only thing that happens is time passing.
    await started.done;

    expect(started.stand.gate).toEqual([expect.objectContaining({ toolName: 'Bash', allowed: false })]);
    expect(started.stand.performed).toEqual([]);
    expect(h.platform.services.artifacts.list(h.ownerId)).toHaveLength(0);
    // A late answer to an expired question decides nothing either.
    expect(
      runtime.answerPermission({ runId: started.runId, ownerId: h.ownerId, requestId: request.requestId, allow: true }),
    ).toBe(false);
    // And the run is no longer parked on the question.
    expect(started.run().status).toBe('succeeded');
  });

  it('oczekiwanie na zgode mozna zatrzymac, a uruchomienie konczy sie jako anulowane', async () => {
    const started = await startRun(conversation(), [
      { kind: 'ask', toolName: 'Bash', input: { command: 'sleep 60' }, then: [{ kind: 'text', text: 'WYKONANO' }] },
      { kind: 'text', text: 'koniec' },
    ]);
    await waitUntil(() => started.run().status === 'awaiting_consent');

    const result = h.platform.services.runs.cancel(started.runId, h.ownerId);
    expect(result.cancelled, 'Stop odmowil zatrzymania zadania czekajacego na zgode').toBe(true);
    await started.done;
    expect(started.run().status).toBe('cancelled');
  });
});

/* ------------------------------ the HTTP route ---------------------------- */

describe('punkt HTTP odpowiedzi na zgode', () => {
  it('odpowiedz na wlasciwym adresie rozstrzyga, a na cudzym uruchomieniu nie', async () => {
    const started = await startRun(conversation(), [
      { kind: 'ask', toolName: 'Bash', input: { command: 'echo a' }, then: [{ kind: 'text', text: 'WYKONANO' }] },
      { kind: 'text', text: 'koniec' },
    ]);
    await waitUntil(() => permissionOf(started.events) !== undefined);
    const request = permissionOf(started.events)!;

    const post = async (runId: string, userId: string, body: unknown) => {
      const cookie = await login(h.platform.app, userId);
      const res = await h.platform.app.request(`/api/runs/${runId}/permission`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as { answered?: boolean } };
    };

    // Somebody else's run: refused before any decision is even considered.
    const foreign = await post(started.runId, h.otherOwnerId, { requestId: request.requestId, allow: true });
    expect(foreign.status).toBe(403);
    expect(runtime.pendingPermissionIds()).toContain(request.requestId);

    const ok = await post(started.runId, h.ownerId, { requestId: request.requestId, allow: true });
    expect(ok.status).toBe(200);
    expect(ok.body.answered).toBe(true);

    // The retry the client may send on a flaky connection.
    const again = await post(started.runId, h.ownerId, { requestId: request.requestId, allow: true });
    expect(again.body.answered).toBe(false);

    await started.done;
    expect(started.stand.gate).toEqual([expect.objectContaining({ allowed: true })]);
  });
});
