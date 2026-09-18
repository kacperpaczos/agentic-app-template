import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_CUSTOM_EVENTS } from '@platform/contracts';
import { collectToolEntries, platformTools } from '@platform/server';
import { createHarness, login, type Harness } from './helpers.ts';
import { dispatchingAgent, newStandInHandle, type Plan, type Step } from './support/model-standin.ts';

/**
 * What a client gets when it comes back and asks a run to replay itself.
 *
 * Re-attachment is the recovery path for everything that takes the stream away
 * — a reload, a closed panel, a lost network — so what the replay contains is a
 * question with consequences. Two answers matter here:
 *
 *  1. everything the client missed, including the terminal event, so it can
 *     stop waiting and re-read the conversation;
 *  2. **not** the interface commands of a run that has already ended. Such a
 *     command is a question the run was waiting on; once the run is over nothing
 *     is waiting, the agent has already been told `no_client`, and performing it
 *     now would move the user's screen to answer nobody.
 *
 * **Simulation, and marked as such**: the model is a stand-in at the adapter
 * boundary. The stream, the event log, the HTTP route and the replay are the
 * application's own.
 */

let h: Harness;
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
  const prompt = `polecenie odtworzenia ${promptSeq}`;
  plans.set(prompt, { script, handle: newStandInHandle() });
  const started = await h.platform.runtime.start({
    ownerId: h.ownerId,
    conversationId,
    prompt,
    appContext: { ...EMPTY_CONTEXT, conversationId },
  });
  const reader = (async () => {
    for await (const _ of started.stream.read(0)) {
      /* drained as a client would */
    }
  })();
  pending.push(started.done.catch(() => undefined), reader);
  return started;
}

/** The events a replay from `from` actually delivers, parsed out of the SSE body. */
async function replay(runId: string, from: number, userId: string) {
  const cookie = await login(h.platform.app, userId);
  const res = await h.platform.app.request(`/api/runs/${runId}/stream?from=${from}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  return (await res.text())
    .split('\n\n')
    .filter((frame) => frame.includes('data:'))
    .map((frame) => JSON.parse(frame.split('data: ')[1]!.split('\n')[0]!) as Record<string, unknown>);
}

beforeEach(async () => {
  plans = new Map();
  h = await createHarness({
    withModule: false,
    modelAgent: dispatchingAgent(plans, () =>
      collectToolEntries({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
      }),
    ),
  });
});
afterEach(async () => {
  h.platform.services.runs.abortAll('koniec_testu');
  await Promise.allSettled(pending.splice(0));
  h.dispose();
});

describe('odtworzenie zakonczonego uruchomienia', () => {
  it('przynosi to, czego klient nie widzial, wraz ze zdarzeniem koncowym', async () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, title: 'Odtworzenie' }).id;
    const started = await startRun(conv, [
      { kind: 'text', text: 'Alfa ' },
      { kind: 'text', text: 'Beta ' },
      { kind: 'text', text: 'ZNACZNIK' },
    ]);
    await started.done;

    const all = h.platform.services.runs.events(started.runId, h.ownerId);
    const cursor = all[2]!.seq;
    const tail = await replay(started.runId, cursor, h.ownerId);

    // Exactly the tail, ending with the event that lets a client stop waiting.
    expect(tail).toHaveLength(all.length - cursor);
    expect(tail.at(-1)!.type).toBe('RUN_FINISHED');
  });

  it('nie niesie polecen sterujacych interfejsem, bo nikt juz na nie nie czeka', async () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, title: 'Sterowanie' }).id;
    /*
     * A real interface command through the real gate: no client answers it, so
     * the runtime times it out and the agent is told `no_client` — which is
     * exactly the state a client returning later would be replaying into. The
     * wait is the acknowledgement budget the tab plans against
     * (`UI_COMMAND_ACK_TIMEOUT_MS`), and it is the point of the test rather than
     * an accident of it: the command really was left unanswered.
     */
    const started = await startRun(conv, [
      { kind: 'call', name: 'ui_navigate', input: { targetId: 'platform.files' } },
      { kind: 'text', text: 'ZNACZNIK' },
    ]);
    await started.done;

    const persisted = h.platform.services.runs.events(started.runId, h.ownerId);
    const commands = persisted.filter(
      (e) => (e.payload as { name?: string } | null)?.name === PLATFORM_CUSTOM_EVENTS.uiCommand,
    );
    expect(commands.length, 'uruchomienie nie wyemitowalo polecenia sterujacego').toBeGreaterThan(0);

    const replayed = await replay(started.runId, 0, h.ownerId);
    expect(
      replayed.filter((e) => e.name === PLATFORM_CUSTOM_EVENTS.uiCommand),
      'odtworzenie zakonczonego uruchomienia niesie polecenie sterujace interfejsem',
    ).toHaveLength(0);
    // Everything else is still there, terminal event included.
    expect(replayed.at(-1)!.type).toMatch(/RUN_FINISHED|RUN_ERROR/);
    expect(replayed.some((e) => e.type === 'TEXT_MESSAGE_CONTENT')).toBe(true);
    expect(replayed.length).toBe(persisted.length - commands.length);
  });
});
