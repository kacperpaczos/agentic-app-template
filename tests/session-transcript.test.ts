import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, isMissingSessionTranscript, type ModelAgentLike } from '@platform/server';
import { PLATFORM_CUSTOM_EVENTS } from '@platform/contracts';
import { createHarness, type Harness } from './helpers.ts';

/**
 * A conversation the application kept, whose SDK transcript is gone (L7.13).
 *
 * **These are simulations**, and marked as such: the failure is produced at the
 * adapter boundary by a stand-in that rejects `resumeStream` the way the Claude
 * Agent SDK rejects a resume it cannot satisfy. Everything else — the run
 * record, the queue, the event stream, the projection, the conversation service
 * — is the real thing.
 *
 * Why simulated rather than prompted: the case cannot be produced on demand
 * with a real model. It happens when the SDK's own transcript files are pruned,
 * the machine changes, or a backup is restored (the copy carries this
 * application's database and never the SDK's files). The behaviour under test
 * is entirely on this side of the boundary: what the application does with a
 * resume that failed.
 *
 * The defect being guarded against is not the failure itself but a *quiet*
 * recovery — starting a fresh session while the chat still shows the whole
 * earlier thread, so the interface implies a memory the model does not have.
 */

/** The stand-in: `resumeStream` rejects, `stream` would happily answer. */
function agentThatCannotResume(rejection: string): ModelAgentLike & { freshStarts: number } {
  const state = {
    freshStarts: 0,
    async stream() {
      state.freshStarts += 1;
      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', payload: { text: 'Odpowiedz z nowej sesji.' } };
        })(),
      };
    },
    async resumeStream() {
      throw new Error(rejection);
    },
  };
  return state as unknown as ModelAgentLike & { freshStarts: number };
}

let h: Harness;
beforeEach(async () => {
  h = await createHarness({ withModule: false });
});
afterEach(() => h.dispose());

async function runResuming(agent: ModelAgentLike, sessionId: string) {
  const runtime = new AgentRuntime(h.platform.services, agent);
  const conv = h.platform.services.conversations.create({
    ownerId: h.ownerId,
    firstMessage: { content: 'wczorajsze pytanie' },
  });
  // The conversation is bound exactly as a previous run would have bound it.
  h.platform.services.conversations.bindClaudeSession(conv.id, sessionId);

  const started = await runtime.start({
    ownerId: h.ownerId,
    conversationId: conv.id,
    prompt: 'kontynuuj to, o czym mowilismy',
    appContext: {
      conversationId: conv.id, spaceId: null, resource: null,
      selection: [], filters: {}, viewport: null, drafts: [], ui: null,
    },
  });
  const events: Array<Record<string, any>> = [];
  const reader = (async () => {
    for await (const e of started.stream.read(0)) events.push(e.event as Record<string, any>);
  })();
  await started.done;
  await reader;

  return {
    conv: () => h.platform.services.conversations.get(conv.id, h.ownerId),
    run: () => h.platform.services.runs.get(started.runId, h.ownerId),
    messages: () => h.platform.services.conversations.messages(conv.id, h.ownerId),
    events,
  };
}

const SDK_REJECTION = 'No conversation found with session ID: sess_zgubiona';

describe('utracony transkrypt SDK daje jawny wynik (symulacja)', () => {
  it('rozmowa bez transkryptu konczy sie wlasnym kodem bledu, nie ogolnym', async () => {
    const agent = agentThatCannotResume(SDK_REJECTION);
    const r = await runResuming(agent, 'sess_zgubiona');

    const run = r.run();
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('session_transcript_lost');
    // The message has to say what did *not* happen, in as many words.
    expect(run.errorMessage).toMatch(/NIE zostala odtworzona/);
    expect(run.errorMessage).toContain('sess_zgubiona');
  });

  it('aplikacja nie podstawia po cichu nowej sesji z odpowiedzia', async () => {
    const agent = agentThatCannotResume(SDK_REJECTION);
    const r = await runResuming(agent, 'sess_zgubiona');

    /*
     * The stand-in's `stream` would have produced a perfectly good answer. The
     * point of the test is that it is never called: an answer produced without
     * the conversation's history, presented under that history, is the false
     * claim of restored memory the criterion forbids.
     */
    expect(agent.freshStarts).toBe(0);
    const contents = r.messages().map((m) => m.content);
    expect(contents.some((c) => c.includes('Odpowiedz z nowej sesji'))).toBe(false);
    // The user's own messages are untouched — nothing is lost on this side.
    expect(contents).toContain('wczorajsze pytanie');
  });

  it('jawne zdarzenie nazywa utracona sesje i stwierdza brak pamieci', async () => {
    const r = await runResuming(agentThatCannotResume(SDK_REJECTION), 'sess_zgubiona');

    const custom = r.events.find(
      (e) => e.type === 'CUSTOM' && e.name === PLATFORM_CUSTOM_EVENTS.sessionTranscriptLost,
    );
    expect(custom, 'brak jawnego zdarzenia o utracie transkryptu').toBeDefined();
    expect(custom!.value.lostSessionId).toBe('sess_zgubiona');
    expect(custom!.value.memoryRestored).toBe(false);
    expect(custom!.value.bindingCleared).toBe(true);

    // And exactly one terminal event, carrying the same code.
    const errors = r.events.filter((e) => e.type === 'RUN_ERROR');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('session_transcript_lost');
  });

  it('martwe powiazanie z sesja zostaje usuniete, wiec kolejna proba startuje czysto', async () => {
    const r = await runResuming(agentThatCannotResume(SDK_REJECTION), 'sess_zgubiona');
    expect(r.conv().claudeSessionId).toBeNull();
  });

  it('inny blad wznowienia nie kasuje powiazania i zostaje bledem integracji', async () => {
    /*
     * The control that keeps the recogniser honest. A transient failure must not
     * be read as a lost transcript: dropping the binding on a timeout would
     * silently discard a session that was perfectly fine, which is the same
     * class of damage in the other direction.
     */
    const r = await runResuming(agentThatCannotResume('Connection reset by peer'), 'sess_zywa');
    const run = r.run();
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('integration_failed');
    expect(r.conv().claudeSessionId).toBe('sess_zywa');
  });
});

/** A stand-in that accepts the resume but answers from a different session. */
function agentAnsweringFromAnotherSession(reportedSessionId: string): ModelAgentLike {
  const play = async (options: any) => {
    const hooks = options?.sdkOptions?.hooks ?? {};
    for (const group of hooks.SessionStart ?? []) {
      for (const hook of group.hooks ?? []) {
        await hook({ hook_event_name: 'SessionStart', session_id: reportedSessionId });
      }
    }
    return {
      fullStream: (async function* () {
        yield { type: 'text-delta', payload: { text: 'Odpowiedz bez wczesniejszego kontekstu.' } };
      })(),
    };
  };
  return { stream: (_p, o) => play(o), resumeStream: (_i, o) => play(o) };
}

describe('wznowienie, ktore po cichu daje inna sesje (symulacja)', () => {
  it('jest wykryte i opisane jako brak odtworzonej pamieci', async () => {
    /*
     * The quiet variant, and the one the gap description called out: the SDK
     * does not fail, it simply answers from a session that is not the one we
     * asked it to continue. Nothing about the run looks wrong — which is
     * exactly why it has to be reported.
     */
    const r = await runResuming(agentAnsweringFromAnotherSession('sess_zupelnie_inna'), 'sess_stara');

    const custom = r.events.find(
      (e) => e.type === 'CUSTOM' && e.name === PLATFORM_CUSTOM_EVENTS.sessionTranscriptLost,
    );
    expect(custom, 'zmiana sesji przy wznowieniu przeszla bez slowa').toBeDefined();
    expect(custom!.value.lostSessionId).toBe('sess_stara');
    expect(custom!.value.newSessionId).toBe('sess_zupelnie_inna');
    expect(custom!.value.memoryRestored).toBe(false);
    expect(custom!.value.detectedBy).toBe('session_id_mismatch');

    // The conversation now points at the session that really exists, so the
    // next message continues *that* one instead of chasing a dead id.
    expect(r.conv().claudeSessionId).toBe('sess_zupelnie_inna');
  });

  it('wznowienie tej samej sesji nie zglasza niczego', async () => {
    // The control that keeps the check from crying wolf on every follow-up.
    const r = await runResuming(agentAnsweringFromAnotherSession('sess_ta_sama'), 'sess_ta_sama');
    expect(
      r.events.some(
        (e) => e.type === 'CUSTOM' && e.name === PLATFORM_CUSTOM_EVENTS.sessionTranscriptLost,
      ),
    ).toBe(false);
    expect(r.conv().claudeSessionId).toBe('sess_ta_sama');
    expect(r.run().status).toBe('succeeded');
  });
});

describe('rozpoznanie komunikatu o braku transkryptu', () => {
  it.each([
    'No conversation found with session ID: 0c0b1f2e-1111-2222-3333-444455556666',
    'Error: session 0c0b1f2e not found',
    'Transcript for this conversation no longer exists',
    'No such session: abc',
    "ENOENT: no such file or directory, open '/home/u/.claude/projects/x/abc.jsonl'",
  ])('rozpoznaje: %s', (message) => {
    expect(isMissingSessionTranscript(message)).toBe(true);
  });

  it.each([
    'Connection reset by peer',
    'Claude AI usage limit reached|1758200000',
    'Rekord nie zostal znaleziony',
    'Tool result not found for tool_use_id tu_1',
    // A failure *during* a session, not a missing one. Matched before the
    // pattern required the two halves to be adjacent.
    'unknown error while starting session',
    'run_timeout',
  ])('nie rozpoznaje: %s', (message) => {
    expect(isMissingSessionTranscript(message)).toBe(false);
  });
});

describe('forgetClaudeSession', () => {
  it('nie kasuje nowszego powiazania zalozonego w miedzyczasie', () => {
    const conv = h.platform.services.conversations.create({
      ownerId: h.ownerId,
      firstMessage: { content: 'x' },
    });
    h.platform.services.conversations.bindClaudeSession(conv.id, 'sess_nowa');

    // A queued run that failed on the *old* session must not erase the binding
    // a newer run has already established.
    expect(h.platform.services.conversations.forgetClaudeSession(conv.id, 'sess_stara')).toBe(false);
    expect(h.platform.services.conversations.get(conv.id, h.ownerId).claudeSessionId).toBe(
      'sess_nowa',
    );
  });
});
