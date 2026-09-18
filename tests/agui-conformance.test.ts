import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectToolEntries,
  encodeSse,
  platformTools,
  type AguiEvent,
  type AgentRuntime,
} from '@platform/server';
import {
  AGUI_EVENTS,
  PLATFORM_CUSTOM_EVENTS,
  PLATFORM_CUSTOM_PAYLOAD_VERSION,
  platformCustomPayloadSchemas,
  type AppContext,
} from '@platform/contracts';
import { createHarness, login, type Harness } from './helpers.ts';
import { dispatchingAgent, newStandInHandle, type Plan, type Step } from './support/model-standin.ts';
import {
  aguiCore,
  aguiViolations,
  describeViolations,
  type ConformanceInput,
} from './support/agui-conformance.ts';

/**
 * L5.11 — AG-UI conformance for the schemas **and** the behaviour of the events
 * this platform needs, not for their names or for the presence of a package.
 *
 * What was here before: `tests/projection.test.ts` runs the library's own
 * reducer over the platform's bytes and compares it with the backend's
 * projection. That is a real check and it stays — but it can only see the
 * events the reducer handles. `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` and
 * every `CUSTOM` are dropped by `processStreamedMessage` (pinned in
 * `tests/library-limits.test.ts`), so nothing was checking the shape of the
 * four kinds of event the application depends on most.
 *
 * What this adds, in the order the criterion names it:
 *
 *  1. **schemas** — every event of a real run is parsed by `@ag-ui/core`'s own
 *     schema for its type. The copy used is the one `@openuidev/react-headless`
 *     depends on, resolved through it, because the only version worth
 *     conforming to is the one the consumer parses with.
 *  2. **platform shapes** — AG-UI is deliberately silent about what is inside a
 *     `CUSTOM`, so the payloads have schemas of their own
 *     (`platform-contracts/src/agui-payloads.ts`) and a version, and both are
 *     checked against the bytes of a real run.
 *  3. **behaviour** — one `RUN_STARTED` first, exactly one terminal event last,
 *     no text outside an open message, no tool result for a call that never
 *     started, no result borrowing the assistant segment's message id.
 *
 * **Simulation, marked as such.** The model is the scripted stand-in at the
 * `ModelAgentLike` boundary; the runtime, the hook bridge, the MCP tools, the
 * event stream, the HTTP app and the SSE encoding are the application's own.
 */

let h: Harness;
let runtime: AgentRuntime;
let plans: Map<string, Plan>;
let cookie: string;
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

beforeEach(async () => {
  plans = new Map();
  h = await createHarness({
    modelAgent: dispatchingAgent(plans, () =>
      collectToolEntries({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
      }),
    ),
  });
  runtime = h.platform.runtime;
  cookie = await login(h.platform.app, h.ownerId);
});

afterEach(async () => {
  h.platform.services.runs.abortAll('koniec_testu');
  await Promise.allSettled(pending.splice(0));
  h.dispose();
});

/**
 * Sends one command over HTTP and returns the events **as they left the wire**.
 *
 * Deliberately not the in-memory objects: a conformance claim is about what a
 * consumer receives, and the difference between the two is a `JSON.stringify`
 * that could drop an undefined field without anything noticing.
 */
async function commandOverHttp(prompt: string, script: Step[]): Promise<ConformanceInput[]> {
  plans.set(prompt, { script, handle: newStandInHandle() });
  const res = await h.platform.app.request('/api/agui/run', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ threadId: null, messages: [{ role: 'user', content: prompt }], context: EMPTY_CONTEXT }),
  });
  expect(res.status).toBe(200);
  const body = await res.text();
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as ConformanceInput);
}

/**
 * Same trip through the encoder, for the runs that cannot be driven through one
 * HTTP request (a cancellation, a question answered from outside).
 *
 * `encodeSse` is the function the HTTP layer uses, so this is the same bytes by
 * construction rather than by resemblance.
 */
const overTheWire = (events: AguiEvent[]): ConformanceInput[] =>
  events.map((e) => JSON.parse(encodeSse(e).slice('data: '.length)) as ConformanceInput);

/** Starts a run without waiting for it, collecting its stream. */
async function launch(conversationId: string, prompt: string, script: Step[]) {
  plans.set(prompt, { script, handle: newStandInHandle() });
  const started = await runtime.start({
    ownerId: h.ownerId,
    conversationId,
    prompt,
    appContext: { ...EMPTY_CONTEXT, conversationId },
  });
  const events: AguiEvent[] = [];
  const drained = (async () => {
    for await (const e of started.stream.read(0)) events.push(e.event);
  })();
  const done = started.done.catch(() => undefined);
  pending.push(done, drained);
  return { runId: started.runId, events, settle: async () => {
    await done;
    await drained;
  } };
}

const typesOf = (events: ConformanceInput[]) => events.map((e) => String(e.type));
const customs = (events: ConformanceInput[], name: string) =>
  events.filter((e) => e.type === AGUI_EVENTS.CUSTOM && e.name === name).map((e) => e.value as Record<string, unknown>);

/* ========================================================================== */

describe('L5.11 — zgodnosc AG-UI: schematy i zachowanie', () => {
  it('uruchomienie z narzedziem i zdarzeniem domeny jest zgodne ze schematami AG-UI i platformy', async () => {
    const caseId = h.service.listCases(h.ownerId)[0]!.id;
    const events = await commandOverHttp('Zapisz zestawienie i powiedz co zrobiles.', [
      { kind: 'text', text: 'Zaczynam. ' },
      {
        kind: 'call',
        name: 'procurement_save_comparison',
        input: { caseId, title: 'Zgodnosc AG-UI', operationId: 'agui-zgodnosc-1' },
      },
      { kind: 'text', text: 'Zapisalem zestawienie.' },
    ]);

    /*
     * The check is only worth something over a stream that actually has the
     * events it is about. Without these four lines "no violations" would also
     * be true of an empty list, which is the classic way this kind of test
     * passes while proving nothing.
     */
    const types = typesOf(events);
    expect(types[0]).toBe(AGUI_EVENTS.RUN_STARTED);
    expect(types).toContain(AGUI_EVENTS.TOOL_CALL_START);
    expect(types).toContain(AGUI_EVENTS.TOOL_CALL_RESULT);
    expect(types).toContain(AGUI_EVENTS.CUSTOM);
    expect(types.at(-1)).toBe(AGUI_EVENTS.RUN_FINISHED);

    const violations = aguiViolations(events);
    expect(describeViolations(violations)).toBe('brak naruszen');

    // The platform's own addition to RUN_FINISHED, written down as an addition.
    const finished = events.at(-1)!;
    expect(typeof finished.durationMs).toBe('number');

    // And a CUSTOM payload that carries its version, not only its name.
    const created = customs(events, PLATFORM_CUSTOM_EVENTS.artifactCreated);
    expect(created.length).toBeGreaterThan(0);
    expect(created[0]!.version).toBe(PLATFORM_CUSTOM_PAYLOAD_VERSION);
    expect(String(created[0]!.artifactId)).toMatch(/^art_/);
  });

  it('anulowanie: run_cancelled i dokladnie jeden status koncowy, oba zgodne', async () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, title: 'Anulowanie' }).id;
    const run = await launch(conv, 'Pracuj dlugo.', [
      { kind: 'text', text: 'Zaczynam. ' },
      { kind: 'wait', ms: 60_000 },
      { kind: 'text', text: 'NIE-POWINNO-DOJSC' },
    ]);
    // Wait until the run is really executing, then stop it by name.
    await expectEventually(() => run.events.some((e) => e.type === AGUI_EVENTS.TEXT_MESSAGE_CONTENT));
    h.platform.services.runs.cancel(run.runId, h.ownerId);
    await run.settle();

    const events = overTheWire(run.events);
    expect(describeViolations(aguiViolations(events))).toBe('brak naruszen');

    const cancelled = customs(events, PLATFORM_CUSTOM_EVENTS.runCancelled);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.version).toBe(PLATFORM_CUSTOM_PAYLOAD_VERSION);
    expect(cancelled[0]!.runId).toBe(run.runId);
    // Cancellation is announced first and resolved once — the two events are a
    // pair, and neither replaces the other.
    const types = typesOf(events);
    expect(types.filter((t) => t === AGUI_EVENTS.RUN_FINISHED || t === AGUI_EVENTS.RUN_ERROR)).toEqual([
      AGUI_EVENTS.RUN_ERROR,
    ]);
  });

  it('prosba o zgode: ladunek ma schemat, wersje i wlasne uruchomienie', async () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, title: 'Zgoda' }).id;
    const run = await launch(conv, 'Zapytaj o zgode.', [
      { kind: 'text', text: 'Pytam. ' },
      { kind: 'ask', toolName: 'Bash', input: { command: 'node przetworz.mjs' } },
      { kind: 'text', text: 'Koniec.' },
    ]);
    await expectEventually(() => runtime.pendingPermissionIds().length > 0);
    const requestId = runtime.pendingPermissionIds()[0]!;
    expect(runtime.answerPermission({ runId: run.runId, ownerId: h.ownerId, requestId, allow: false })).toBe(true);
    await run.settle();

    const events = overTheWire(run.events);
    expect(describeViolations(aguiViolations(events))).toBe('brak naruszen');

    const asked = customs(events, PLATFORM_CUSTOM_EVENTS.permissionRequest);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.version).toBe(PLATFORM_CUSTOM_PAYLOAD_VERSION);
    expect(asked[0]!.runId).toBe(run.runId);
    expect(asked[0]!.requestId).toBe(requestId);
    expect(asked[0]!.toolName).toBe('Bash');
  });

  /* ---------------------------- negative controls ------------------------- */

  it('kontrola negatywna: kazde naruszenie jest zglaszane na swoim zdarzeniu', async () => {
    const started = { type: AGUI_EVENTS.RUN_STARTED, threadId: 'conv_1', runId: 'run_1' };
    const finished = { type: AGUI_EVENTS.RUN_FINISHED, threadId: 'conv_1', runId: 'run_1', durationMs: 5 };
    const textStart = { type: AGUI_EVENTS.TEXT_MESSAGE_START, messageId: 'am_run_1', role: 'assistant' };
    const textEnd = { type: AGUI_EVENTS.TEXT_MESSAGE_END, messageId: 'am_run_1' };
    const delta = { type: AGUI_EVENTS.TEXT_MESSAGE_CONTENT, messageId: 'am_run_1', delta: 'x' };
    const toolStart = {
      type: AGUI_EVENTS.TOOL_CALL_START,
      toolCallId: 'run_1~t1',
      toolCallName: 'mcp__app__x',
      parentMessageId: 'am_run_1',
    };

    // The honest stream first: whatever else this test says, it must agree that
    // a correct sequence is correct.
    expect(aguiViolations([started, textStart, delta, textEnd, finished])).toEqual([]);

    const rulesOf = (events: ConformanceInput[]) => aguiViolations(events).map((v) => `${v.at}:${v.rule}`);

    // A field the protocol requires, removed.
    expect(rulesOf([started, { ...toolStart, toolCallId: undefined }, finished])).toContain('1:agui_schema');
    // A CUSTOM payload missing its version — the shape promise, not the protocol's.
    expect(
      rulesOf([
        started,
        { type: AGUI_EVENTS.CUSTOM, name: PLATFORM_CUSTOM_EVENTS.canvasChanged, value: { spaceId: 'sp_1' } },
        finished,
      ]),
    ).toContain('1:custom_payload');
    // A CUSTOM name nothing describes.
    expect(
      rulesOf([started, { type: AGUI_EVENTS.CUSTOM, name: 'platform.wymyslone', value: {} }, finished]),
    ).toContain('1:unknown_custom');
    /*
     * A field nobody wrote down — the half of the promise a non-strict schema
     * cannot keep. `z.object` strips an unknown key and reports success, so
     * without `z.strictObject` this file would detect a *missing* field and be
     * blind to an *added* one, which is how a payload quietly grows a second,
     * undocumented meaning.
     */
    expect(
      rulesOf([
        started,
        {
          type: AGUI_EVENTS.CUSTOM,
          name: PLATFORM_CUSTOM_EVENTS.canvasChanged,
          value: { version: PLATFORM_CUSTOM_PAYLOAD_VERSION, spaceId: 'sp_1', dopisanePrzezPomylke: 1 },
        },
        finished,
      ]),
    ).toContain('1:custom_payload');
    // The same for an event of the protocol, not only for a CUSTOM payload.
    expect(rulesOf([started, { ...finished, dopisanePrzezPomylke: 1 }])).toContain('1:platform_schema');
    // Two terminal events, and work after the end.
    expect(rulesOf([started, finished, delta, finished])).toEqual(
      expect.arrayContaining(['2:after_terminal', '3:terminal_repeated']),
    );
    // Text with no open message, and a tool result for a call that never started.
    expect(rulesOf([started, delta, finished])).toContain('1:text_not_open');
    expect(
      rulesOf([
        started,
        { type: AGUI_EVENTS.TOOL_CALL_RESULT, messageId: 'tr_x', toolCallId: 'x', content: 'ok', role: 'tool' },
        finished,
      ]),
    ).toContain('1:tool_not_started');
    // A result that borrows the assistant segment's id: the pairing the chat
    // performs would attach it to the wrong message.
    expect(
      rulesOf([
        started,
        toolStart,
        { type: AGUI_EVENTS.TOOL_CALL_RESULT, messageId: 'am_run_1', toolCallId: 'run_1~t1', content: 'ok', role: 'tool' },
        finished,
      ]),
    ).toContain('2:tool_result_shares_message_id');
    // No terminal event at all.
    expect(rulesOf([started, delta])).toContain('2:terminal_missing');
  });

  it('kazde zdarzenie CUSTOM platformy ma schemat, a odniesieniem jest @ag-ui/core biblioteki', () => {
    // Totality: a new custom event without a payload schema is a compile error
    // (the map is typed over `PLATFORM_CUSTOM_EVENTS`); this is the same claim
    // at run time, so a cast could not smuggle one past.
    expect(Object.keys(platformCustomPayloadSchemas).sort()).toEqual(
      Object.values(PLATFORM_CUSTOM_EVENTS).sort(),
    );

    /*
     * The version of the protocol package is pinned here on purpose. The
     * criterion is about conformance "for the version in use": an upgrade that
     * changes an event's shape has to be looked at, and a test that silently
     * follows whatever is installed would never say so.
     */
    expect(
      aguiCore().version,
      'wersja @ag-ui/core sie zmienila: zgodnosc byla mierzona wobec 0.0.53, wiec ksztalty zdarzen ' +
        'trzeba zmierzyc ponownie, a nie podbic ten literal',
    ).toBe('0.0.53');
  });
});

/** Waits for a condition the run produces, without a fixed sleep. */
async function expectEventually(ready: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('warunek nie zostal spelniony w czasie');
}
