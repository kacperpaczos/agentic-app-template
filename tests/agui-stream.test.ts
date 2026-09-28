import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyRunEvent,
  attachToRun,
  attachedRunIds,
  claimedRunIds,
  platformAguiAdapter,
  resetAccessContext,
  resetRunStreams,
  setAccessContext,
  useAppState,
} from '@platform/ui';
import { AGUI_EVENTS, PLATFORM_CUSTOM_EVENTS } from '@platform/contracts';

/**
 * The AG-UI stream, end to end through the browser adapter.
 *
 * Deterministic on purpose: no model, no network. What is exercised is the part
 * that has to be right regardless of what the model says — which lifecycle state
 * the UI lands in, which caches are invalidated, and what happens when the same
 * stream is replayed after a reconnect.
 */

type Ev = Record<string, unknown>;

/**
 * Builds an SSE response, optionally splitting events across network chunks.
 *
 * The `X-Conversation-Id` header is part of the contract, not decoration: the
 * adapter reads it to decide **which conversation** the run it is parsing
 * belongs to, so that a run started in one conversation cannot write its state
 * into whichever one the user happens to be looking at.
 */
function sse(events: Ev[], { fragment = false, conversationId = CONV } = {}): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!fragment) {
        controller.enqueue(bytes);
      } else {
        // 7 bytes at a time: every event is split, most across several chunks.
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'X-Conversation-Id': conversationId } });
}

async function drain(
  events: Ev[],
  qc: QueryClient,
  opts: { fragment?: boolean; conversationId?: string } = {},
): Promise<Ev[]> {
  const adapter = platformAguiAdapter(qc);
  const seen: Ev[] = [];
  for await (const e of adapter.parse(sse(events, opts))) seen.push(e as Ev);
  return seen;
}

const RUN = 'run_1';
const CONV = 'cnv_1';

const runStarted: Ev = { type: AGUI_EVENTS.RUN_STARTED, threadId: CONV, runId: RUN };
const toolStart: Ev = {
  type: AGUI_EVENTS.TOOL_CALL_START, toolCallId: 't1',
  toolCallName: 'mcp__app__canvas_add_card', parentMessageId: 'am_run_1',
};
const toolResult: Ev = {
  type: AGUI_EVENTS.TOOL_CALL_RESULT, messageId: 'tr_t1', toolCallId: 't1',
  content: '{"cardId":"c1"}', role: 'tool',
};
const canvasChanged: Ev = {
  type: AGUI_EVENTS.CUSTOM, name: PLATFORM_CUSTOM_EVENTS.canvasChanged, value: { spaceId: 'sp_1' },
};
const runFinished: Ev = { type: AGUI_EVENTS.RUN_FINISHED, threadId: CONV, runId: RUN, durationMs: 10 };
const runError = (code: string, message: string): Ev => ({ type: AGUI_EVENTS.RUN_ERROR, code, message });

let qc: QueryClient;

beforeEach(() => {
  qc = new QueryClient();
  resetAccessContext();
  setAccessContext(qc, 'local-user');
  useAppState.setState({ runs: {}, lastRunId: null, conversationId: CONV });
});
afterEach(() => resetAccessContext());

/** The run record of the conversation under test. */
const phase = (conversationId = CONV) => useAppState.getState().runFor(conversationId);

describe('jeden przebieg ma dokladnie jednego konsumenta', () => {
  it('strumien z wyslania zajmuje przebieg, wiec podlaczenie w tle go pomija', async () => {
    resetRunStreams();
    const qc2 = new QueryClient();

    // The header names the run; parsing the stream claims it for this consumer.
    const response = sse([runStarted, { type: AGUI_EVENTS.TEXT_MESSAGE_CONTENT, messageId: 'am', delta: 'abc' }]);
    const withRun = new Response(response.body, {
      headers: { 'X-Conversation-Id': CONV, 'X-Run-Id': RUN },
    });

    const adapter = platformAguiAdapter(qc2);
    const seen: Ev[] = [];
    for await (const e of adapter.parse(withRun)) {
      seen.push(e as Ev);
      // While the stream is open the run is claimed, so a background sync that
      // tried to follow it would be a no-op.
      expect(claimedRunIds()).toContain(RUN);
      attachToRun(qc2, { runId: RUN, conversationId: CONV });
      expect(attachedRunIds(), 'podlaczono sie do przebiegu, ktory ma juz konsumenta').not.toContain(RUN);
    }

    expect(seen.length).toBeGreaterThan(0);
    // Applied once, not twice: this is the property whose absence doubled the
    // answer text (107 characters measured as 214).
    expect(phase(CONV).streamingText).toBe('abc');
    // Released when the stream ends — that is when re-attachment is correct.
    expect(claimedRunIds()).not.toContain(RUN);
  });

  it('dwukrotne zastosowanie tego samego zdarzenia podwaja tekst — dlatego jeden konsument', () => {
    // States the failure mode plainly, so the guard above has a reason on record.
    const event = { type: AGUI_EVENTS.TEXT_MESSAGE_CONTENT, messageId: 'am', delta: 'abc' };
    const ctx = { qc, isActive: () => true };
    applyRunEvent(CONV, { type: AGUI_EVENTS.RUN_STARTED, threadId: CONV, runId: RUN }, ctx);
    applyRunEvent(CONV, event, ctx);
    expect(phase(CONV).streamingText).toBe('abc');
    applyRunEvent(CONV, event, ctx);
    expect(phase(CONV).streamingText).toBe('abcabc');
  });
});

describe('zadania w tle nie mieszaja sie ze soba', () => {
  const OTHER = 'cnv_2';
  const otherStarted: Ev = { type: AGUI_EVENTS.RUN_STARTED, threadId: OTHER, runId: 'run_2' };

  it('strumien rozmowy B nie dotyka stanu rozmowy A', async () => {
    // A is running and has produced text; the user is looking at A.
    await drain(
      [
        runStarted,
        { type: AGUI_EVENTS.TEXT_MESSAGE_START, messageId: 'am_a', role: 'assistant' },
        { type: AGUI_EVENTS.TEXT_MESSAGE_CONTENT, messageId: 'am_a', delta: 'Praca w A. ' },
      ],
      qc,
    );
    expect(phase(CONV).phase).toBe('running');
    expect(phase(CONV).streamingText).toBe('Praca w A. ');

    // B runs and finishes, while the record of A must be untouched.
    await drain([otherStarted, { type: AGUI_EVENTS.RUN_FINISHED, threadId: OTHER, runId: 'run_2' }], qc, {
      conversationId: OTHER,
    });

    expect(phase(OTHER).phase).toBe('succeeded');
    expect(phase(OTHER).runId).toBe('run_2');
    // The decisive assertion: A kept its own phase, its own run and its own text.
    expect(phase(CONV).phase).toBe('running');
    expect(phase(CONV).runId).toBe(RUN);
    expect(phase(CONV).streamingText).toBe('Praca w A. ');
  });

  it('zakonczenie poza ogladana rozmowa jest oznaczone jako niezobaczone', async () => {
    useAppState.setState({ conversationId: CONV });
    await drain([otherStarted, { type: AGUI_EVENTS.RUN_FINISHED, threadId: OTHER, runId: 'run_2' }], qc, {
      conversationId: OTHER,
    });
    // Signalled at the right conversation, without taking over the current view.
    expect(phase(OTHER).unseenResult).toBe(true);
    expect(useAppState.getState().conversationId).toBe(CONV);
  });

  it('zakonczenie w ogladanej rozmowie nie jest oznaczane jako niezobaczone', async () => {
    useAppState.setState({ conversationId: CONV });
    await drain([runStarted, runFinished], qc);
    expect(phase(CONV).phase).toBe('succeeded');
    expect(phase(CONV).unseenResult).toBe(false);
  });

  it('prosba o zgode trafia do rozmowy zadania, nie do ogladanej', async () => {
    useAppState.setState({ conversationId: CONV });
    await drain(
      [
        otherStarted,
        {
          type: AGUI_EVENTS.CUSTOM,
          name: PLATFORM_CUSTOM_EVENTS.permissionRequest,
          value: { requestId: 'p9', toolName: 'Bash', input: 'ls', runId: 'run_2' },
        },
      ],
      qc,
      { conversationId: OTHER },
    );
    expect(phase(OTHER).pendingPermission).toMatchObject({ requestId: 'p9' });
    expect(phase(CONV).pendingPermission).toBeNull();
  });
});

describe('cykl zycia wykonania wynika ze zdarzen', () => {
  it('sukces: kolejka → wykonywanie → zakonczone', async () => {
    useAppState.getState().patchRun(CONV, { phase: 'queued' });
    expect(phase().phase).toBe('queued');

    await drain([runStarted, toolStart, toolResult, canvasChanged, runFinished], qc);
    expect(phase().phase).toBe('succeeded');
    expect(phase().runId).toBe(RUN);
    expect(phase().activeTool).toBeNull();
  });

  it('w trakcie wywolania narzedzia widac, ktore narzedzie dziala', async () => {
    const adapter = platformAguiAdapter(qc);
    const seen: string[] = [];
    for await (const e of adapter.parse(sse([runStarted, toolStart, toolResult, runFinished]))) {
      seen.push((e as Ev).type as string);
      if ((e as Ev).type === AGUI_EVENTS.TOOL_CALL_START) {
        expect(phase().activeTool).toBe('mcp__app__canvas_add_card');
      }
    }
    expect(seen).toContain(AGUI_EVENTS.TOOL_CALL_RESULT);
    expect(phase().activeTool).toBeNull();
  });

  it('blad niesie kod i komunikat, nie tylko fakt porazki', async () => {
    await drain([runStarted, runError('rate_limited', 'Claude usage limit reached')], qc);
    expect(phase()).toMatchObject({
      phase: 'failed',
      errorCode: 'rate_limited',
      errorMessage: 'Claude usage limit reached',
    });
  });

  it('anulowanie nie zostaje nadpisane przez blad, ktory po nim nastepuje', async () => {
    await drain(
      [
        runStarted,
        { type: AGUI_EVENTS.CUSTOM, name: PLATFORM_CUSTOM_EVENTS.runCancelled, value: { runId: RUN } },
        runError('cancelled', 'Przerwano.'),
      ],
      qc,
    );
    // The runtime emits both; the user asked to stop, so that is the outcome.
    expect(phase().phase).toBe('cancelled');
  });

  it('prosba o zgode wstrzymuje wykonanie w odroznialnym stanie', async () => {
    await drain(
      [
        runStarted,
        {
          type: AGUI_EVENTS.CUSTOM,
          name: PLATFORM_CUSTOM_EVENTS.permissionRequest,
          value: { requestId: 'p1', toolName: 'Bash', input: 'rm -rf /', runId: RUN },
        },
      ],
      qc,
    );
    expect(phase().phase).toBe('awaiting_consent');
    expect(phase().pendingPermission).toMatchObject({ requestId: 'p1', toolName: 'Bash' });
  });

  it('tekst odpowiedzi jest gromadzony w trakcie tury i zwalniany po jej zamknieciu', async () => {
    const adapter = platformAguiAdapter(qc);
    const seen: number[] = [];
    const events: Ev[] = [
      runStarted,
      { type: AGUI_EVENTS.TEXT_MESSAGE_START, messageId: 'am_run_1', role: 'assistant' },
      { type: AGUI_EVENTS.TEXT_MESSAGE_CONTENT, messageId: 'am_run_1', delta: 'Pierwsze. ' },
      { type: AGUI_EVENTS.TEXT_MESSAGE_CONTENT, messageId: 'am_run_1', delta: 'Drugie. ' },
      { type: AGUI_EVENTS.TEXT_MESSAGE_END, messageId: 'am_run_1' },
      runFinished,
    ];
    for await (const e of adapter.parse(sse(events))) {
      if ((e as Ev).type === AGUI_EVENTS.TEXT_MESSAGE_CONTENT) {
        seen.push(phase().streamingText.length);
      }
    }
    // Grew while the turn was open...
    expect(seen).toHaveLength(2);
    expect(seen[1]!).toBeGreaterThan(seen[0]!);
    // ...and was released once the thread took ownership of the answer.
    expect(phase().streamingText).toBe('');
  });

  it('stan konczy sie na zdarzeniu koncowym, nie na pojawieniu sie tekstu', async () => {
    await drain(
      [
        runStarted,
        { type: AGUI_EVENTS.TEXT_MESSAGE_START, messageId: 'am_run_1', role: 'assistant' },
        { type: AGUI_EVENTS.TEXT_MESSAGE_CONTENT, messageId: 'am_run_1', delta: 'Gotowe.' },
        { type: AGUI_EVENTS.TEXT_MESSAGE_END, messageId: 'am_run_1' },
      ],
      qc,
    );
    // Text arrived and ended, but no terminal event did: the run is not finished.
    expect(phase().phase).toBe('running');
  });
});

describe('transport', () => {
  it('zdarzenie rozbite miedzy pakiety sieciowe jest skladane w calosc', async () => {
    const events = [runStarted, toolStart, toolResult, canvasChanged, runFinished];
    const whole = await drain(events, qc, { fragment: false });
    const split = await drain(events, new QueryClient(), { fragment: true });
    expect(split).toEqual(whole);
    expect(split).toHaveLength(events.length);
  });

  it('kolejnosc zdarzen jest zachowana', async () => {
    const events = [runStarted, toolStart, toolResult, canvasChanged, runFinished];
    const seen = await drain(events, qc);
    expect(seen.map((e) => e.type)).toEqual(events.map((e) => e.type));
  });

  it('ponowne odtworzenie tego samego strumienia nie zmienia stanu koncowego', async () => {
    const events = [runStarted, toolStart, toolResult, canvasChanged, runFinished];
    await drain(events, qc);
    const first = { ...phase() };
    // A reconnect replays from the persisted event log; applying it twice must
    // land in exactly the same place, not in a doubled or reopened state.
    await drain(events, qc);
    expect(phase()).toEqual(first);
  });
});

describe('zdarzenia platformy trafiaja do wlasciwych odbiorcow', () => {
  const invalidated = (client: QueryClient) =>
    client
      .getQueryCache()
      .getAll()
      .filter((q) => q.state.isInvalidated)
      .map((q) => q.queryKey);

  it('zmiana kompozycji uniewaznia przestrzen, ktorej dotyczy', async () => {
    const key = ['canvas', 'local-user', 'space', 'sp_1'];
    qc.setQueryData(key, { cards: [] });
    qc.setQueryData(['canvas', 'local-user', 'space', 'sp_inna'], { cards: [] });
    await drain([runStarted, canvasChanged], qc);
    expect(invalidated(qc)).toContainEqual(key);
  });

  it('zmiana danych uniewaznia odczyty modulu, canvas i otwarte artefakty', async () => {
    qc.setQueryData(['module', 'local-user', '/cases'], {});
    qc.setQueryData(['canvas', 'local-user', 'spaces'], {});
    qc.setQueryData(['artifact', 'local-user', 'art_1'], {});
    await drain(
      [
        runStarted,
        { type: AGUI_EVENTS.CUSTOM, name: PLATFORM_CUSTOM_EVENTS.dataChanged, value: { resources: ['offer'] } },
      ],
      qc,
    );
    const keys = invalidated(qc).map((k) => (k as string[])[0]);
    expect(keys).toContain('module');
    expect(keys).toContain('canvas');
    expect(keys).toContain('artifact');
  });

  it('nowy artefakt uniewaznia liste i otwarty podglad', async () => {
    qc.setQueryData(['artifacts', 'local-user', 'all'], { artifacts: [] });
    qc.setQueryData(['artifact', 'local-user', 'art_1'], {});
    await drain(
      [
        runStarted,
        { type: AGUI_EVENTS.CUSTOM, name: PLATFORM_CUSTOM_EVENTS.artifactCreated, value: { artifactId: 'art_2' } },
      ],
      qc,
    );
    const keys = invalidated(qc).map((k) => (k as string[])[0]);
    expect(keys).toContain('artifacts');
    expect(keys).toContain('artifact');
  });

  it('powiazanie sesji Claude uniewaznia wlasnie te rozmowe', async () => {
    qc.setQueryData(['conversation', 'local-user', CONV], {});
    await drain(
      [
        runStarted,
        {
          type: AGUI_EVENTS.CUSTOM,
          name: PLATFORM_CUSTOM_EVENTS.sessionBound,
          value: { sessionId: 'sess_1', conversationId: CONV },
        },
      ],
      qc,
    );
    expect(invalidated(qc)).toContainEqual(['conversation', 'local-user', CONV]);
  });

  it('nieznane zdarzenie CUSTOM jest przepuszczane bez skutkow ubocznych', async () => {
    qc.setQueryData(['module', 'local-user', '/cases'], {});
    const seen = await drain(
      [runStarted, { type: AGUI_EVENTS.CUSTOM, name: 'cos.nieznanego', value: {} }],
      qc,
    );
    expect(seen).toHaveLength(2);
    expect(invalidated(qc)).toHaveLength(0);
  });
});
