import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  collectToolEntries,
  platformTools,
  type AguiEvent,
} from '@platform/server';
import type { AppContext } from '@platform/contracts';
import { createHarness, login, type Harness } from './helpers.ts';
import { dispatchingAgent, newStandInHandle, type Plan, type Step } from './support/model-standin.ts';

/**
 * Orchestration under collision: L7.4, L7.8, L7.9, L7.10.
 *
 * **Simulation, and marked as such.** The model is replaced at the
 * `ModelAgentLike` boundary by the scripted stand-in
 * (`support/model-standin.ts`), which receives the same `sdkOptions`, the same
 * `AbortSignal` and the same run context the Claude Agent SDK would. Everything
 * the criteria are about is the real thing: **one** `AgentRuntime` and therefore
 * one conversation queue, the real run registry, the real per-run MCP context,
 * the real consent gate, the real event stream, the real database.
 *
 * One `AgentRuntime` is the whole point. The tests these replace used a second
 * runtime per run, which gave every run an empty queue — so they could not have
 * observed a race, an overlap or a queue that failed to release, because none of
 * those can happen between two objects that do not share a queue.
 *
 * Every test here builds the collision rather than describing it: two commands
 * in one conversation without awaiting the first, two conversations in flight at
 * once, a consent answered through the wrong run's address, a stop that lands
 * before the run it names ever reaches the model.
 */

let h: Harness;
let runtime: AgentRuntime;
let plans: Map<string, Plan>;
let promptSeq = 0;
const pending: Array<Promise<unknown>> = [];

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

interface Launched {
  runId: string;
  done: Promise<void>;
  handle: ReturnType<typeof newStandInHandle>;
  events: AguiEvent[];
  drained: Promise<void>;
  run: () => ReturnType<Harness['platform']['services']['runs']['get']>;
}

/**
 * Starts one run and returns without waiting for it.
 *
 * Not awaiting is the mechanism: a test that awaits the first run before
 * sending the second never has two in flight, and every property here is about
 * what happens when it does.
 */
async function launch(
  conversationId: string,
  script: Step[],
  options: { ownerId?: string; context?: Partial<AppContext> } = {},
): Promise<Launched> {
  const ownerId = options.ownerId ?? h.ownerId;
  promptSeq += 1;
  const prompt = `polecenie rownolegle ${promptSeq}`;
  const handle = newStandInHandle();
  plans.set(prompt, { script, handle });

  const started = await runtime.start({
    ownerId,
    conversationId,
    prompt,
    appContext: { ...EMPTY_CONTEXT, ...options.context, conversationId },
  });
  const events: AguiEvent[] = [];
  const drained = (async () => {
    for await (const e of started.stream.read(0)) events.push(e.event);
  })();
  const done = started.done.catch(() => undefined) as Promise<void>;
  pending.push(done, drained);
  return {
    runId: started.runId,
    done,
    handle,
    events,
    drained,
    run: () => h.platform.services.runs.get(started.runId, ownerId),
  };
}

/** Both halves of a launched run: its execution and its event stream. */
const settle = async (...runs: Launched[]) => {
  await Promise.all(runs.map((r) => r.done));
  await Promise.all(runs.map((r) => r.drained));
};

const conversation = (title: string, ownerId = h.ownerId) =>
  h.platform.services.conversations.create({ ownerId, title }).id;

const assistantText = (conversationId: string, ownerId = h.ownerId) =>
  h.platform.services.conversations
    .messages(conversationId, ownerId)
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .join('');

const customEvents = (events: AguiEvent[], name: string) =>
  events.filter((e) => e.type === 'CUSTOM' && e.name === name).map((e) => e.value as Record<string, any>);

const ms = (iso: string | null) => (iso === null ? Number.NaN : Date.parse(iso));

beforeEach(async () => {
  plans = new Map();
  /*
   * The stand-in goes into the platform's own runtime, not into one built
   * beside it. Two runtimes over one database look like one application and are
   * not: they have separate queues, separate live streams and separate pending
   * consents, so `POST /api/runs/:id/permission` would be answering about runs
   * it has never heard of. That mistake passed a first draft of the consent
   * test here — the endpoint returned "not answered" for the crossed request
   * for the wrong reason, and would have gone on doing so with the binding
   * removed.
   */
  h = await createHarness({
    modelAgent: dispatchingAgent(plans, () =>
      collectToolEntries({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
      }),
    ),
  });
  runtime = h.platform.runtime;
});

afterEach(async () => {
  h.platform.services.runs.abortAll('koniec_testu');
  await Promise.allSettled(pending.splice(0));
  h.dispose();
});

/* ========================================================================== */
/*  L7.4 / L7.8 — two commands, one conversation                              */
/* ========================================================================== */

describe('L7.4, L7.8 — dwa polecenia w jednej rozmowie', () => {
  it('okna wykonania sa rozlaczne, a czekanie w kolejce nie jest liczone jako praca', async () => {
    const conv = conversation('Jedna rozmowa, dwa polecenia');

    // A is still inside its wait when B is accepted: B is therefore queued, not
    // parallel, which is the situation both criteria are about.
    const a = await launch(conv, [{ kind: 'wait', ms: 220 }, { kind: 'text', text: 'ODPOWIEDZ-A' }]);
    const b = await launch(conv, [{ kind: 'text', text: 'ODPOWIEDZ-B' }]);

    // Before anything finishes: exactly one is executing and the other waits.
    expect(b.run().status, 'drugie polecenie ruszylo, zanim pierwsze skonczylo').toBe('queued');

    await settle(a, b);

    const runA = a.run();
    const runB = b.run();
    expect([runA.status, runB.status]).toEqual(['succeeded', 'succeeded']);

    /* --- L7.8: the windows do not overlap, and the wait is not the work --- */
    expect(runA.finishedAt).not.toBeNull();
    expect(
      ms(runB.startedAt) >= ms(runA.finishedAt),
      `B ruszylo o ${runB.startedAt}, gdy A konczylo o ${runA.finishedAt}`,
    ).toBe(true);
    // The first run waited for nobody; the second waited for the first.
    expect(runA.queuedMs!).toBeLessThan(50);
    expect(runB.queuedMs!).toBeGreaterThan(runA.queuedMs!);
    expect(runB.queuedMs!).toBeGreaterThan(100);
    /*
     * The measurement point, stated as a comparison rather than as a number:
     * B's reported duration is time spent *executing*, so it has to be shorter
     * than the wall clock since B was accepted — which includes the queue. If
     * the start were taken at enqueue time the two would be equal.
     */
    const sinceEnqueued = ms(runB.finishedAt) - ms(runB.enqueuedAt);
    expect(runB.durationMs!).toBeLessThan(sinceEnqueued);
    expect(runB.durationMs!).toBeLessThan(runB.queuedMs!);

    /* --- L7.4: the second run resumes the session the first one bound ---- */
    expect(a.handle.resumedFrom, 'pierwsze polecenie nie mialo czego wznawiac').toBeNull();
    const bound = h.platform.services.conversations.get(conv, h.ownerId).claudeSessionId;
    expect(bound).toBeTruthy();
    expect(
      b.handle.resumedFrom,
      'drugie polecenie nie wznowilo sesji zwiazanej przez pierwsze',
    ).toBe(bound);
    expect(runB.claudeSessionId).toBe(bound);

    // Both answers are in the conversation, in the order they were executed.
    const text = assistantText(conv);
    expect(text.indexOf('ODPOWIEDZ-A')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('ODPOWIEDZ-B')).toBeGreaterThan(text.indexOf('ODPOWIEDZ-A'));
  });

  it('kontekst narzedzi nie przecieka miedzy uruchomieniami tej samej rozmowy', async () => {
    const conv = conversation('Kontekst per uruchomienie');
    const caseId = h.service.listCases(h.ownerId)[0]!.id;

    /*
     * Two runs of one conversation, each with a *different* command context and
     * each creating an artifact. The MCP server is built per run and the tool
     * handler closes over that run's context, so a leak shows up twice over: as
     * an artifact attributed to the wrong run, and as `get_context` reporting
     * the other run's selection.
     */
    const a = await launch(
      conv,
      [
        { kind: 'wait', ms: 200 },
        { kind: 'call', name: 'get_context', input: { waitMs: 0 } },
        {
          kind: 'call',
          name: 'artifact_create',
          input: {
            title: 'Z-uruchomienia-A',
            kind: 'report',
            rendererType: 'platform.markdown',
            content: { text: 'A' },
            operationId: 'op-kontekst-a-1',
          },
        },
        { kind: 'text', text: 'A gotowe' },
      ],
      { context: { selection: [{ kind: 'case', id: caseId }] } },
    );
    const b = await launch(
      conv,
      [
        { kind: 'call', name: 'get_context', input: { waitMs: 0 } },
        {
          kind: 'call',
          name: 'artifact_create',
          input: {
            title: 'Z-uruchomienia-B',
            kind: 'report',
            rendererType: 'platform.markdown',
            content: { text: 'B' },
            operationId: 'op-kontekst-b-1',
          },
        },
        { kind: 'text', text: 'B gotowe' },
      ],
      { context: { selection: [] } },
    );

    await settle(a, b);

    const artifacts = h.platform.services.artifacts.list(h.ownerId);
    const byTitle = (title: string) => artifacts.find((x) => x.title === title)!;
    expect(byTitle('Z-uruchomienia-A').runId).toBe(a.runId);
    expect(byTitle('Z-uruchomienia-B').runId).toBe(b.runId);
    expect(byTitle('Z-uruchomienia-A').runId).not.toBe(b.runId);

    // `get_context` answered each run with its own command context.
    const contextOf = (r: Launched) => r.handle.results.find((x) => x.name === 'get_context')!.text;
    expect(contextOf(a)).toContain(caseId);
    expect(contextOf(b), 'drugie uruchomienie zobaczylo zaznaczenie pierwszego').not.toContain(caseId);
  });
});

/* ========================================================================== */
/*  L7.9 — different conversations, and different owners, at the same time    */
/* ========================================================================== */

describe('L7.9 — rownolegle rozmowy nie mieszaja sie', () => {
  it('dwie rozmowy jednoczesnie: narzedzia, odpowiedzi i artefakty zostaja u siebie', async () => {
    const a = conversation('Rozmowa A');
    const b = conversation('Rozmowa B');

    const runA = await launch(a, [
      { kind: 'wait', ms: 120 },
      {
        kind: 'call',
        name: 'artifact_create',
        input: {
          title: 'Artefakt-A',
          kind: 'report',
          rendererType: 'platform.markdown',
          content: { text: 'A' },
          operationId: 'op-rozmowa-a-1',
        },
      },
      { kind: 'text', text: 'WYNIK-A' },
    ]);
    const runB = await launch(b, [
      {
        kind: 'call',
        name: 'artifact_create',
        input: {
          title: 'Artefakt-B',
          kind: 'report',
          rendererType: 'platform.markdown',
          content: { text: 'B' },
          operationId: 'op-rozmowa-b-1',
        },
      },
      { kind: 'text', text: 'WYNIK-B' },
    ]);

    // Different conversations are not serialised: B runs while A is waiting.
    await runB.done;
    expect(['queued', 'running']).toContain(runA.run().status);

    await settle(runA, runB);

    expect(assistantText(a)).toContain('WYNIK-A');
    expect(assistantText(a)).not.toContain('WYNIK-B');
    expect(assistantText(b)).toContain('WYNIK-B');
    expect(assistantText(b)).not.toContain('WYNIK-A');

    const artifacts = h.platform.services.artifacts.list(h.ownerId);
    expect(artifacts.find((x) => x.title === 'Artefakt-A')!.conversationId).toBe(a);
    expect(artifacts.find((x) => x.title === 'Artefakt-B')!.conversationId).toBe(b);
  });

  it('dwoch wlascicieli naraz: kazde narzedzie widzi dane swojego wlasciciela', async () => {
    const mine = conversation('Moja rozmowa');
    const theirs = conversation('Cudza rozmowa', h.otherOwnerId);

    const a = await launch(mine, [
      { kind: 'wait', ms: 120 },
      { kind: 'call', name: 'procurement_list_cases', input: {} },
      { kind: 'text', text: 'moje' },
    ]);
    const b = await launch(
      theirs,
      [
        { kind: 'call', name: 'procurement_list_cases', input: {} },
        { kind: 'text', text: 'cudze' },
      ],
      { ownerId: h.otherOwnerId },
    );

    await settle(a, b);

    const casesOf = (r: Launched) =>
      JSON.parse(r.handle.results.find((x) => x.name === 'procurement_list_cases')!.text) as {
        cases: unknown[];
        window: { total: number };
      };

    // The seed belongs to the first owner only, so the second owner's run must
    // come back empty — from a tool call made while the first one was in flight.
    expect(casesOf(a).cases.length).toBeGreaterThan(0);
    expect(casesOf(b).cases, 'uruchomienie drugiego wlasciciela zobaczylo cudze sprawy').toHaveLength(0);
    expect(casesOf(b).window.total).toBe(0);
  });

  it('zgoda udzielona pod adresem jednego uruchomienia nie rozstrzyga prosby drugiego', async () => {
    const a = conversation('Zgoda A');
    const b = conversation('Zgoda B');
    const cookie = await login(h.platform.app, h.ownerId);

    const runA = await launch(a, [
      { kind: 'permission', toolName: 'Bash', input: { command: 'ls' } },
      { kind: 'text', text: 'A po zgodzie' },
    ]);
    const runB = await launch(b, [
      { kind: 'permission', toolName: 'Bash', input: { command: 'ls' } },
      { kind: 'text', text: 'B po zgodzie' },
    ]);

    /** The consent request each run put on its own stream. */
    const awaitRequest = async (r: Launched): Promise<string> => {
      for (let i = 0; i < 200; i += 1) {
        const [request] = customEvents(r.events, 'platform.permission_request');
        if (request) return request.requestId as string;
        await new Promise((done) => setTimeout(done, 5));
      }
      throw new Error('nie doczekano prosby o zgode');
    };

    const requestA = await awaitRequest(runA);
    const requestB = await awaitRequest(runB);
    expect(requestA).not.toBe(requestB);
    // Each request names the run that asked, so a client can answer the right one.
    expect(customEvents(runA.events, 'platform.permission_request')[0]!.runId).toBe(runA.runId);

    /*
     * The collision: A's request id posted to B's address. The owner is the
     * same person and the address passes the ownership check, so the only thing
     * that can refuse this is the binding between the request and its run.
     */
    const crossed = await h.platform.app.request(`/api/runs/${runB.runId}/permission`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: requestA, allow: true }),
    });
    expect(crossed.status).toBe(200);
    expect((await crossed.json()).answered, 'zgoda cudzego uruchomienia zostala rozstrzygnieta').toBe(
      false,
    );
    // A is still waiting: nothing was decided for it.
    expect(runA.run().status).toBe('running');
    expect(runA.handle.consents).toHaveLength(0);

    // Answered at its own address, it resolves — and only it.
    const own = await h.platform.app.request(`/api/runs/${runA.runId}/permission`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: requestA, allow: true }),
    });
    expect((await own.json()).answered).toBe(true);

    const refusedB = await h.platform.app.request(`/api/runs/${runB.runId}/permission`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: requestB, allow: false }),
    });
    expect((await refusedB.json()).answered).toBe(true);

    await settle(runA, runB);
    expect(runA.handle.consents).toEqual([{ toolName: 'Bash', allowed: true }]);
    expect(runB.handle.consents).toEqual([{ toolName: 'Bash', allowed: false }]);
  });
});

/* ========================================================================== */
/*  L7.10 — a failure and a stop release the queue                            */
/* ========================================================================== */

describe('L7.10 — blad i anulowanie zwalniaja kolejke', () => {
  it('po bledzie pierwszego polecenia drugie w tej samej rozmowie konczy sie sukcesem', async () => {
    const conv = conversation('Blad, potem praca');

    const failing = await launch(conv, [
      { kind: 'wait', ms: 120 },
      { kind: 'streamError', message: 'model przerwal odpowiedz' },
    ]);
    const next = await launch(conv, [{ kind: 'text', text: 'PO-BLEDZIE' }]);
    expect(next.run().status).toBe('queued');

    await settle(failing, next);

    expect(failing.run().status).toBe('failed');
    expect(next.run().status, 'kolejka nie zostala zwolniona po bledzie').toBe('succeeded');
    // And it ran *after* the failure, not beside it.
    expect(ms(next.run().startedAt) >= ms(failing.run().finishedAt)).toBe(true);
    expect(assistantText(conv)).toContain('PO-BLEDZIE');
    // The session bound by the failed run is the one the next run continued.
    const bound = h.platform.services.conversations.get(conv, h.ownerId).claudeSessionId;
    expect(next.handle.resumedFrom).toBe(bound);
  });

  it('po anulowaniu trwajacego polecenia nastepne w tej samej rozmowie konczy sie sukcesem', async () => {
    const conv = conversation('Stop, potem praca');

    const stopped = await launch(conv, [
      { kind: 'wait', ms: 5_000 },
      { kind: 'text', text: 'NIE-POWINNO-DOJSC' },
    ]);
    const next = await launch(conv, [{ kind: 'text', text: 'PO-STOPIE' }]);

    // Stop while it is executing, with the next command already waiting behind it.
    expect(h.platform.services.runs.cancel(stopped.runId, h.ownerId).cancelled).toBe(true);

    await settle(stopped, next);

    expect(stopped.run().status).toBe('cancelled');
    expect(next.run().status, 'kolejka nie zostala zwolniona po anulowaniu').toBe('succeeded');
    expect(assistantText(conv)).toContain('PO-STOPIE');
    expect(assistantText(conv)).not.toContain('NIE-POWINNO-DOJSC');
  });

  it('polecenie zatrzymane w kolejce nie rusza wcale, a kolejne dostaje swoj wynik', async () => {
    const conv = conversation('Stop przed startem');

    const head = await launch(conv, [{ kind: 'wait', ms: 200 }, { kind: 'text', text: 'PIERWSZE' }]);
    const stoppedWhileQueued = await launch(conv, [
      {
        kind: 'call',
        name: 'artifact_create',
        input: {
          title: 'Nie-powinien-powstac',
          kind: 'report',
          rendererType: 'platform.markdown',
          content: { text: 'x' },
          operationId: 'op-anulowane-w-kolejce',
        },
      },
      { kind: 'text', text: 'NIE-POWINNO-DOJSC' },
    ]);
    const last = await launch(conv, [{ kind: 'text', text: 'TRZECIE' }]);

    expect(stoppedWhileQueued.run().status).toBe('queued');
    expect(h.platform.services.runs.cancel(stoppedWhileQueued.runId, h.ownerId).cancelled).toBe(true);

    await settle(head, stoppedWhileQueued, last);

    const cancelled = stoppedWhileQueued.run();
    expect(cancelled.status).toBe('cancelled');
    /*
     * Never started, not merely stopped early: no execution start was recorded,
     * no RUN_STARTED reached the stream, and the tool its script would have
     * called did not run.
     */
    expect(cancelled.startedAt, 'anulowane w kolejce mimo to oznaczylo start wykonania').toBe(
      cancelled.enqueuedAt,
    );
    expect(stoppedWhileQueued.events.map((e) => e.type)).not.toContain('RUN_STARTED');
    expect(stoppedWhileQueued.handle.performed).toEqual([]);
    expect(h.platform.services.artifacts.list(h.ownerId).map((x) => x.title)).not.toContain(
      'Nie-powinien-powstac',
    );
    // Exactly one resolving terminal event, as on every other path.
    expect(stoppedWhileQueued.events.filter((e) => e.type === 'RUN_ERROR' || e.type === 'RUN_FINISHED'))
      .toHaveLength(1);

    // The queue moved on: the command behind the cancelled one got its answer.
    expect(last.run().status).toBe('succeeded');
    expect(assistantText(conv)).toContain('TRZECIE');
    expect(assistantText(conv)).not.toContain('NIE-POWINNO-DOJSC');
  });
});
