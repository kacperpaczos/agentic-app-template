import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectToolEntries, platformTools, type AgentRuntime, type AguiEvent } from '@platform/server';
import { AGUI_EVENTS, PLATFORM_CUSTOM_EVENTS, type AppContext } from '@platform/contracts';
import { createHarness, login, type Harness } from './helpers.ts';
import { dispatchingAgent, newStandInHandle, type Plan, type Step } from './support/model-standin.ts';

/**
 * L5.6 / L5.14 — coming back to a run, from the backend's side.
 *
 * The browser half is `e2e/reconnect-live.spec.ts`; what is here is what a
 * browser cannot show:
 *
 *  - **a settled question is settled in the log.** A permission request stays
 *    in `run_events` for ever. Until now nothing followed it, so a client that
 *    replayed the log put an already-answered prompt back on screen — and the
 *    prompt was answerable, while `answerPermission` refused it in silence.
 *    `platform.permission_resolved` is that missing event, and every way out of
 *    the gate emits it: an answer, an expiry, and the refusal a stop issues.
 *  - **a run interrupted by a restart still ends.** `GET /api/runs/:id/stream`
 *    synthesises a terminal event from the stored status when the log has none,
 *    which is the only thing standing between a killed process and a client
 *    that waits for ever. That branch had no test at all.
 *  - **a cursor is a cursor.** Re-attaching from `from=<seq>` delivers what was
 *    missed and nothing that was already had.
 *
 * **Simulation, marked as such**: the model is the stand-in at the adapter
 * boundary; the registry, the event log, the HTTP endpoint and the replay are
 * the application's own.
 */

let h: Harness;
let runtime: AgentRuntime;
let plans: Map<string, Plan>;
let cookie: string;
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

const conversation = (title: string) =>
  h.platform.services.conversations.create({ ownerId: h.ownerId, title }).id;

async function launch(conversationId: string, script: Step[]) {
  promptSeq += 1;
  const prompt = `reconnect ${promptSeq}`;
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
  return {
    runId: started.runId,
    events,
    settle: async () => {
      await done;
      await drained;
    },
  };
}

/** Reads one SSE body to the end, returning `{ seq, event }` in order. */
async function replay(runId: string, from: number): Promise<Array<{ seq: number | null; event: any }>> {
  const res = await h.platform.app.request(`/api/runs/${runId}/stream?from=${from}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const body = await res.text();
  return body
    .split('\n\n')
    .filter((frame) => frame.includes('data:'))
    .map((frame) => {
      let seq: number | null = null;
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        else if (line.startsWith('id:')) seq = Number(line.slice(3).trim());
      }
      return { seq, event: JSON.parse(data.join('\n')) };
    });
}

async function eventually(ready: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ready()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`nie doczekano: ${what}`);
}

const customsIn = (events: any[], name: string) =>
  events.filter((e) => e.type === AGUI_EVENTS.CUSTOM && e.name === name).map((e) => e.value);

/* ========================================================================== */

describe('L5.6 / L5.14 — ponowne podlaczenie do uruchomienia', () => {
  it('rozstrzygniecie prosby o zgode jest w dzienniku, wiec odtworzenie nie pokazuje jej ponownie jako otwartej', async () => {
    const conv = conversation('Zgoda i odtworzenie');
    const run = await launch(conv, [
      { kind: 'ask', toolName: 'Bash', input: { command: 'node x.mjs' }, then: [{ kind: 'text', text: 'WYKONANE' }] },
      { kind: 'text', text: 'KONIEC' },
    ]);
    await eventually(() => runtime.pendingPermissionIds().length > 0, 'prosba o zgode');
    const requestId = runtime.pendingPermissionIds()[0]!;
    expect(runtime.answerPermission({ runId: run.runId, ownerId: h.ownerId, requestId, allow: true })).toBe(true);
    await run.settle();

    // The whole log, as a client re-attaching from scratch receives it.
    const events = (await replay(run.runId, 0)).map((e) => e.event);
    const asked = customsIn(events, PLATFORM_CUSTOM_EVENTS.permissionRequest);
    const settled = customsIn(events, PLATFORM_CUSTOM_EVENTS.permissionResolved);
    expect(asked).toHaveLength(1);
    expect(settled).toHaveLength(1);
    expect(settled[0].requestId).toBe(requestId);
    expect(settled[0].runId).toBe(run.runId);
    expect(settled[0].allowed).toBe(true);
    // And the answer comes after the question, which is the only order in which
    // replaying them leaves the prompt closed.
    const at = (name: string) =>
      events.findIndex((e) => e.type === AGUI_EVENTS.CUSTOM && e.name === name);
    expect(at(PLATFORM_CUSTOM_EVENTS.permissionResolved)).toBeGreaterThan(
      at(PLATFORM_CUSTOM_EVENTS.permissionRequest),
    );
  });

  it('odmowa i wygasniecie tez zostawiaja rozstrzygniecie w dzienniku', async () => {
    h.platform.config.consentTimeoutMs = 400;
    const conv = conversation('Wygasniecie');
    const run = await launch(conv, [
      { kind: 'ask', toolName: 'Bash', input: { command: 'node x.mjs' }, then: [{ kind: 'text', text: 'WYKONANE' }] },
      { kind: 'text', text: 'KONIEC' },
    ]);
    // Nobody answers; time passes and the request expires as a refusal.
    await run.settle();

    const events = (await replay(run.runId, 0)).map((e) => e.event);
    const settled = customsIn(events, PLATFORM_CUSTOM_EVENTS.permissionResolved);
    expect(settled).toHaveLength(1);
    expect(settled[0].allowed).toBe(false);
    // The operation the approval would have unlocked did not run.
    expect(
      events
        .filter((e) => e.type === AGUI_EVENTS.TEXT_MESSAGE_CONTENT)
        .map((e) => e.delta)
        .join(''),
    ).not.toContain('WYKONANE');
  });

  it('zatrzymanie w trakcie oczekiwania na zgode tez zapisuje rozstrzygniecie', async () => {
    const conv = conversation('Stop przy zgodzie');
    const run = await launch(conv, [
      { kind: 'ask', toolName: 'Bash', input: { command: 'sleep 60' }, then: [{ kind: 'text', text: 'WYKONANE' }] },
      { kind: 'text', text: 'KONIEC' },
    ]);
    await eventually(
      () => h.platform.services.runs.get(run.runId, h.ownerId).status === 'awaiting_consent',
      'status awaiting_consent',
    );
    expect(h.platform.services.runs.cancel(run.runId, h.ownerId).cancelled).toBe(true);
    await run.settle();

    const events = (await replay(run.runId, 0)).map((e) => e.event);
    const settled = customsIn(events, PLATFORM_CUSTOM_EVENTS.permissionResolved);
    expect(settled).toHaveLength(1);
    expect(settled[0].allowed).toBe(false);
    expect(h.platform.services.runs.get(run.runId, h.ownerId).status).toBe('cancelled');
  });

  it('kursor oddaje to, czego klient nie ma, i nic ponad to', async () => {
    const conv = conversation('Kursor');
    const run = await launch(conv, [
      { kind: 'text', text: 'A' },
      { kind: 'text', text: 'B' },
      { kind: 'text', text: 'C' },
    ]);
    await run.settle();

    const all = await replay(run.runId, 0);
    expect(all.length).toBeGreaterThan(3);
    const cut = 3;
    const rest = await replay(run.runId, cut);
    expect(rest.map((e) => e.seq)).toEqual(all.slice(cut).map((e) => e.seq));
    expect(rest.every((e) => (e.seq ?? 0) > cut)).toBe(true);
    // Sequence numbers are dense and increasing: a replay cannot silently skip.
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
  });

  it('uruchomienie przerwane restartem konczy sie dla klienta, mimo ze dziennik nie ma zdarzenia koncowego', async () => {
    /*
     * The shape of a run the process no longer owns: a row that `reconcileOnBoot`
     * has marked as failed, and a log that stops mid-sentence because nothing
     * was there to write the end. Built directly rather than by restarting the
     * process, because what is under test is the replay branch, not the boot.
     */
    const conv = conversation('Po restarcie');
    const run = h.platform.services.runs.start({
      conversationId: conv,
      ownerId: h.ownerId,
      prompt: 'Przerwane restartem.',
      appContext: { ...EMPTY_CONTEXT, conversationId: conv },
      workspaceDir: null,
      abort: new AbortController(),
    });
    h.platform.services.runs.appendEvent(run.id, 1, AGUI_EVENTS.RUN_STARTED, {
      type: AGUI_EVENTS.RUN_STARTED,
      threadId: conv,
      runId: run.id,
    });
    h.platform.services.runs.appendEvent(run.id, 2, AGUI_EVENTS.TEXT_MESSAGE_CONTENT, {
      type: AGUI_EVENTS.TEXT_MESSAGE_CONTENT,
      messageId: `am_${run.id}`,
      delta: 'Zaczynam',
    });
    expect(h.platform.services.runs.reconcileOnBoot()).toBeGreaterThan(0);
    expect(h.platform.services.runs.get(run.id, h.ownerId).status).toBe('failed');

    const events = (await replay(run.id, 0)).map((e) => e.event);
    // Nothing invented about what happened, and one statement that it is over.
    expect(events.map((e) => e.type)).toEqual([
      AGUI_EVENTS.RUN_STARTED,
      AGUI_EVENTS.TEXT_MESSAGE_CONTENT,
      AGUI_EVENTS.RUN_ERROR,
    ]);
    const terminal = events.at(-1)!;
    expect(terminal.code).toBe('integration_failed');
    expect(String(terminal.message)).toContain('restart');

    // A log that *does* end properly is not given a second ending.
    const proper = await launch(conversation('Zwykle'), [{ kind: 'text', text: 'ok' }]);
    await proper.settle();
    const properEvents = (await replay(proper.runId, 0)).map((e) => e.event);
    expect(
      properEvents.filter((e) => e.type === AGUI_EVENTS.RUN_FINISHED || e.type === AGUI_EVENTS.RUN_ERROR),
    ).toHaveLength(1);
  });
});
