import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectToolEntries,
  platformTools,
  type AgentRuntime,
  type AguiEvent,
} from '@platform/server';
import { AGUI_EVENTS, PLATFORM_CUSTOM_EVENTS, type AppContext } from '@platform/contracts';
import { createHarness, type Harness } from './helpers.ts';
import { dispatchingAgent, newStandInHandle, type Plan, type Step } from './support/model-standin.ts';

/**
 * L5.12 — the bridge between text, the SDK's hooks and the domain's events
 * keeps its correlation, and parallel runs share no mutable context.
 *
 * **What was missing, and what was already there.** The parallel-run evidence
 * used to be two `AgentRuntime` objects, which cannot collide: two objects have
 * two queues, two pending-consent maps and two command registries, so a test
 * built on them could not observe a leak between runs even if there were one.
 * `tests/orchestration.test.ts` fixed that for the queue, the tool context and
 * the consent gate, on **one** runtime. What it does not look at is the bridge
 * itself: which *stream* each hook's event lands in, whether a domain event
 * emitted by one run's tool can appear in another's, and whether the one map
 * that is genuinely shared by every run in a process — `#pendingUiCommands` —
 * can answer the wrong run's question.
 *
 * So every test here runs two executions **at once, on one runtime**, and asks
 * only correlation questions: an event that belongs to run A must be in A's
 * stream, carry A's identifiers, and not exist in B's.
 *
 * **Simulation, marked as such.** The model is the scripted stand-in at the
 * `ModelAgentLike` boundary; the hook bridge, the per-run MCP context, the
 * event streams, the consent gate, the interface-command gate and the database
 * are the application's own.
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
  events: AguiEvent[];
  handle: ReturnType<typeof newStandInHandle>;
  done: Promise<unknown>;
  drained: Promise<void>;
}

/** Starts a run and does not wait for it — the only way to have two at once. */
async function launch(conversationId: string, script: Step[]): Promise<Launched> {
  promptSeq += 1;
  const prompt = `korelacja ${promptSeq}`;
  const handle = newStandInHandle();
  plans.set(prompt, { script, handle });
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
  return { runId: started.runId, events, handle, done, drained };
}

const settle = async (...runs: Launched[]) => {
  await Promise.all(runs.map((r) => r.done));
  await Promise.all(runs.map((r) => r.drained));
};

const conversation = (title: string) =>
  h.platform.services.conversations.create({ ownerId: h.ownerId, title }).id;

const customs = (run: Launched, name: string) =>
  run.events
    .filter((e) => e.type === AGUI_EVENTS.CUSTOM && e.name === name)
    .map((e) => e.value as Record<string, unknown>);

const toolNames = (run: Launched) =>
  run.events.filter((e) => e.type === AGUI_EVENTS.TOOL_CALL_START).map((e) => String(e.toolCallName));

const toolCallIds = (run: Launched) =>
  run.events
    .filter((e) => typeof e.toolCallId === 'string')
    .map((e) => String(e.toolCallId));

const textOf = (run: Launched) =>
  run.events
    .filter((e) => e.type === AGUI_EVENTS.TEXT_MESSAGE_CONTENT)
    .map((e) => String(e.delta))
    .join('');

const messageIds = (run: Launched) =>
  run.events.filter((e) => typeof e.messageId === 'string').map((e) => String(e.messageId));

/** Waits for something the runs produce, without a fixed sleep. */
async function eventually(ready: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`nie doczekano: ${what}`);
}

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
});

afterEach(async () => {
  h.platform.services.runs.abortAll('koniec_testu');
  await Promise.allSettled(pending.splice(0));
  h.dispose();
});

/* ========================================================================== */

describe('L5.12 — most tekst / hooki / zdarzenia domeny przy dwoch przebiegach naraz', () => {
  it('hooki narzedzi i zdarzenia domeny trafiaja do strumienia swojego uruchomienia', async () => {
    const a = conversation('Korelacja A');
    const b = conversation('Korelacja B');
    const caseId = h.service.listCases(h.ownerId)[0]!.id;

    const runA = await launch(a, [
      // Long enough that B runs entirely inside A's execution window.
      { kind: 'text', text: 'A-TEKST ' },
      { kind: 'wait', ms: 300 },
      {
        kind: 'call',
        name: 'artifact_create',
        input: {
          title: 'Artefakt-A',
          kind: 'report',
          rendererType: 'platform.markdown',
          content: { text: 'A' },
          operationId: 'korelacja-a-1',
        },
      },
      { kind: 'text', text: 'A-KONIEC' },
    ]);
    const runB = await launch(b, [
      {
        kind: 'call',
        name: 'procurement_save_comparison',
        input: { caseId, title: 'Zestawienie-B', operationId: 'korelacja-b-1' },
      },
      { kind: 'text', text: 'B-KONIEC' },
    ]);

    // Really parallel: B finishes while A is still working.
    await runB.done;
    expect(['queued', 'running']).toContain(h.platform.services.runs.get(runA.runId, h.ownerId).status);
    await settle(runA, runB);

    /* --------------------------- the tool hooks --------------------------- */

    expect(toolNames(runA)).toEqual(['mcp__app__artifact_create']);
    expect(toolNames(runB)).toEqual(['mcp__app__procurement_save_comparison']);

    /*
     * The identifiers, which is where a shared `tool_use_id` would show. The
     * stand-in numbers its calls from 1 per run, exactly as a provider restarts
     * them per session, so both runs produce `tu_1` — and the namespace the
     * bridge adds is the only thing keeping them apart.
     */
    expect(toolCallIds(runA).every((id) => id.startsWith(`${runA.runId}~`))).toBe(true);
    expect(toolCallIds(runB).every((id) => id.startsWith(`${runB.runId}~`))).toBe(true);
    expect(toolCallIds(runA).some((id) => toolCallIds(runB).includes(id))).toBe(false);
    // And the unscoped id really was shared — otherwise the line above is true
    // for a reason that has nothing to do with the namespace.
    const bare = (ids: string[]) => new Set(ids.map((id) => id.split('~')[1]));
    expect([...bare(toolCallIds(runA))]).toEqual([...bare(toolCallIds(runB))]);

    /* ------------------------- the domain's events ------------------------ */

    const artifactsA = customs(runA, PLATFORM_CUSTOM_EVENTS.artifactCreated);
    const artifactsB = customs(runB, PLATFORM_CUSTOM_EVENTS.artifactCreated);
    expect(artifactsA).toHaveLength(1);
    expect(artifactsB).toHaveLength(1);
    expect(artifactsA[0]!.artifactId).not.toBe(artifactsB[0]!.artifactId);

    const stored = h.platform.services.artifacts.list(h.ownerId);
    const byId = (id: unknown) => stored.find((x) => x.id === id)!;
    expect(byId(artifactsA[0]!.artifactId).runId).toBe(runA.runId);
    expect(byId(artifactsA[0]!.artifactId).conversationId).toBe(a);
    expect(byId(artifactsB[0]!.artifactId).runId).toBe(runB.runId);
    expect(byId(artifactsB[0]!.artifactId).conversationId).toBe(b);

    /* ------------------------------- the text ----------------------------- */

    expect(textOf(runA)).toContain('A-KONIEC');
    expect(textOf(runA)).not.toContain('B-KONIEC');
    expect(textOf(runB)).toContain('B-KONIEC');
    expect(textOf(runB)).not.toContain('A-TEKST');

    // The assistant segment is named after the run, so two open turns cannot be
    // reduced into one message.
    expect(messageIds(runA).every((id) => id.includes(runA.runId))).toBe(true);
    expect(messageIds(runB).every((id) => id.includes(runB.runId))).toBe(true);
  });

  it('polecenie interfejsu jednego uruchomienia rozstrzyga sie potwierdzeniem tego uruchomienia', async () => {
    const a = conversation('Polecenie A');
    const b = conversation('Polecenie B');

    /*
     * Both runs ask the browser to move the interface, at the same time. The map
     * of outstanding commands (`#pendingUiCommands`) is one per runtime — that
     * is the shared mutable state this test is about — and the acknowledgements
     * arrive in the *opposite* order to the requests, so "the last one wins"
     * would be visible as a swapped answer rather than hidden by luck.
     */
    const uiStep = (targetId: string): Step[] => [
      { kind: 'text', text: 'Otwieram. ' },
      { kind: 'call', name: 'ui_navigate', input: { targetId } },
      { kind: 'text', text: 'Gotowe.' },
    ];
    const runA = await launch(a, uiStep('platform.files'));
    const runB = await launch(b, uiStep('platform.settings'));

    const commandOf = (run: Launched) =>
      customs(run, PLATFORM_CUSTOM_EVENTS.uiCommand)[0] as
        | { commandId: string; runId: string; conversationId: string; targetId: string }
        | undefined;

    await eventually(() => !!commandOf(runA) && !!commandOf(runB), 'oba polecenia interfejsu');
    const commandA = commandOf(runA)!;
    const commandB = commandOf(runB)!;

    // Each command names its own run and its own conversation — that is what the
    // client refuses a foreign command by.
    expect(commandA.runId).toBe(runA.runId);
    expect(commandA.conversationId).toBe(a);
    expect(commandA.targetId).toBe('platform.files');
    expect(commandB.runId).toBe(runB.runId);
    expect(commandB.conversationId).toBe(b);
    expect(commandB.targetId).toBe('platform.settings');
    expect(commandA.commandId).not.toBe(commandB.commandId);

    // The browser answers B first, and says something only B could have said.
    expect(
      runtime.acknowledgeUiCommand({
        commandId: commandB.commandId,
        executed: true,
        targetId: 'platform.settings',
        url: '/settings',
      }),
    ).toBe(true);
    expect(
      runtime.acknowledgeUiCommand({
        commandId: commandA.commandId,
        executed: true,
        targetId: 'platform.files',
        url: '/files',
      }),
    ).toBe(true);
    // An acknowledgement for a command nobody is waiting for decides nothing.
    expect(runtime.acknowledgeUiCommand({ commandId: commandA.commandId, executed: true })).toBe(false);

    await settle(runA, runB);

    /*
     * The answer each run was given. It comes back through the tool's own
     * result, so this is the model's view of what happened — the place where a
     * swap would actually mislead somebody.
     */
    const answer = (run: Launched) =>
      JSON.parse(run.handle.results.find((r) => r.name === 'ui_navigate')!.text) as Record<string, unknown>;
    expect(answer(runA).url).toBe('/files');
    expect(answer(runB).url).toBe('/settings');
    expect(answer(runA).executed).toBe(true);
    expect(answer(runB).executed).toBe(true);
  });

  it('zgoda jednego uruchomienia nie zwalnia bramki drugiego', async () => {
    const a = conversation('Zgoda A');
    const b = conversation('Zgoda B');

    const ask = (marker: string): Step[] => [
      { kind: 'ask', toolName: 'Bash', input: { command: `node ${marker}.mjs` }, then: [{ kind: 'text', text: `WYKONANE-${marker}` }] },
      { kind: 'text', text: `KONIEC-${marker}` },
    ];
    const runA = await launch(a, ask('A'));
    const runB = await launch(b, ask('B'));

    const requestOf = (run: Launched) =>
      customs(run, PLATFORM_CUSTOM_EVENTS.permissionRequest)[0] as
        | { requestId: string; runId: string }
        | undefined;

    await eventually(() => !!requestOf(runA) && !!requestOf(runB), 'obie prosby o zgode');
    const requestA = requestOf(runA)!;
    const requestB = requestOf(runB)!;
    expect(requestA.requestId).not.toBe(requestB.requestId);
    expect(requestA.runId).toBe(runA.runId);
    expect(requestB.runId).toBe(runB.runId);

    /*
     * B's address with A's question decides nothing — and this line is here
     * because a detection trial said so. Removing the run binding from
     * `answerPermission` left this test green: with two distinct request ids and
     * each answered under its own run, the binding is never exercised, so the
     * test was about the gate resolving once and not about *whose* question it
     * resolved. The crossed answer is the case that can only pass with the
     * binding in place.
     */
    expect(
      runtime.answerPermission({
        runId: runB.runId,
        ownerId: h.ownerId,
        requestId: requestA.requestId,
        allow: true,
      }),
      'zgoda pod cudzym adresem rozstrzygnela prosbe',
    ).toBe(false);
    expect(runtime.pendingPermissionIds()).toEqual(
      expect.arrayContaining([requestA.requestId, requestB.requestId]),
    );

    // A's answer, posted under A's run: decides A and only A.
    expect(
      runtime.answerPermission({ runId: runA.runId, ownerId: h.ownerId, requestId: requestA.requestId, allow: true }),
    ).toBe(true);
    await runA.done;
    // B is still waiting — its gate was not released by somebody else's answer.
    expect(runtime.pendingPermissionIds()).toContain(requestB.requestId);
    expect(h.platform.services.runs.get(runB.runId, h.ownerId).status).toBe('awaiting_consent');

    expect(
      runtime.answerPermission({ runId: runB.runId, ownerId: h.ownerId, requestId: requestB.requestId, allow: false }),
    ).toBe(true);
    await settle(runA, runB);

    // Each run did what its own decision said, and nothing of the other's.
    expect(textOf(runA)).toContain('WYKONANE-A');
    expect(textOf(runA)).not.toContain('WYKONANE-B');
    expect(textOf(runB)).not.toContain('WYKONANE-B');
    expect(textOf(runB)).toContain('KONIEC-B');
    expect(runA.handle.gate).toEqual([{ toolName: 'Bash', allowed: true, message: undefined }]);
    expect(runB.handle.gate.map((g) => g.allowed)).toEqual([false]);
  });
});
