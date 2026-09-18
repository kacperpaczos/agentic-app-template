import { agUIAdapter, type StreamProtocolAdapter } from '@openuidev/react-headless';
import type { QueryClient } from '@tanstack/react-query';
import { accessEpoch } from '../api/accessContext.ts';
import { useAppState } from '../state/appState.ts';
import { applyRunEvent } from './runEvents.ts';
import { attachToRun, claimRunStream, releaseRunStream } from './runStreams.ts';

/**
 * Stream adapter for the chat.
 *
 * Why this wrapper exists: `processStreamedMessage` in `@openuidev/react-headless`
 * handles TEXT_MESSAGE_*, TOOL_CALL_* and RUN_ERROR, and silently drops every
 * other AG-UI event — including `CUSTOM`, which is how this platform reports a
 * canvas edit, a new artifact, a data mutation, a bound Claude session and a
 * permission request. Verified by reading the library's own switch statement.
 *
 * So we keep the ready-made parser for everything it does handle and tap the
 * same event sequence on the way past for the rest. No parsing is reimplemented.
 *
 * The conversation id is read from the response headers rather than from the
 * store. The backend names the conversation in `X-Conversation-Id` — including
 * the case where it has just created one — and that is the conversation this
 * run belongs to, whatever the user navigates to while it runs.
 */
export function platformAguiAdapter(qc: QueryClient): StreamProtocolAdapter {
  const inner = agUIAdapter();
  return {
    async *parse(response: Response) {
      const conversationId =
        response.headers.get('X-Conversation-Id') ?? useAppState.getState().conversationId;
      const runId = response.headers.get('X-Run-Id');
      /*
       * The identity this stream belongs to.
       *
       * The request is already aborted on a switch (`accessFetch` in
       * `chatWiring.ts`), but an abort is a race with whatever the browser has
       * already buffered: a frame decoded before the abort took effect is still
       * delivered to this loop. It is the previous owner's, and every event
       * here has a side effect — it writes a run record, appends answer text
       * and invalidates caches the new owner is about to read. So the epoch is
       * checked per event and the stream is abandoned on the first one that
       * does not belong here.
       */
      const issuedAt = accessEpoch();

      /*
       * Claim the run for this stream.
       *
       * A run must have exactly one consumer feeding the reducer: the
       * background-task sync also re-attaches to whatever is in flight, and two
       * consumers applying the same text deltas append them twice. Released
       * when this stream ends, which is the moment re-attachment becomes the
       * right way to keep watching. See `runStreams.ts`.
       */
      if (runId) claimRunStream(runId);
      /*
       * How far this client has got, so a re-attachment asks for what it
       * **missed** rather than for everything from the start.
       *
       * The backend numbers a run's events from 1 and increments by one, and
       * this response carries them in that order from the beginning — so the
       * count of events applied here *is* the sequence number of the last one.
       * The number cannot be read off the wire instead: the ready-made parser
       * yields parsed events and does not expose the SSE `id:` line, and
       * re-implementing its parsing to see one line would be replacing the
       * chat, which this application does not do.
       *
       * Counting only what is actually applied keeps the cursor honest in the
       * one case where the two differ — an identity switch abandons the stream,
       * and the run record it belonged to is cleared with it.
       *
       * Left at zero this was harmless but wasteful: a re-attachment replayed
       * the whole run, including the interface commands the user had already
       * seen performed (those are refused a second time by `commandId` in
       * `UiCommandRunner`, which is why it was harmless).
       */
      let applied = 0;
      /**
       * Whether this stream carried the run to its end.
       *
       * The difference between "the run finished" and "this connection ended"
       * is the whole of the block below: only the first of them means there is
       * nothing left to watch.
       */
      let resolved = false;
      try {
        for await (const event of inner.parse(response)) {
          // Nothing of the previous identity's is applied, and nothing of it is
          // handed on to the chat to render.
          if (accessEpoch() !== issuedAt) return;
          if (conversationId) {
            applyRunEvent(conversationId, event as Record<string, unknown>, {
              qc,
              isActive: () => useAppState.getState().conversationId === conversationId,
            });
            applied += 1;
            useAppState.getState().patchRun(conversationId, { lastSeq: applied });
          }
          const type = (event as { type?: unknown }).type;
          if (type === 'RUN_FINISHED' || type === 'RUN_ERROR') resolved = true;
          yield event;
        }
      } finally {
        if (runId) releaseRunStream(runId);
        /*
         * The send path's stream ended before the run did: pick the run back up
         * from the cursor, exactly as a reload would.
         *
         * **The defect this closes.** The ready-made composer's submit control
         * becomes a stop button while a turn is open, and pressing it makes the
         * library abort *this* fetch (`cancelMessage`). `useComposerStop` adds
         * the other half — the backend is told to cancel — but the events that
         * say so (`platform.run_cancelled`, then `RUN_ERROR`) are written to a
         * stream nobody is reading any more. The run really was cancelled; the
         * tab went on showing `running` until something else happened to
         * re-sync (a conversation switch, a reload, an `online` event), which
         * on an idle tab is never. Measured at roughly thirty seconds, and in
         * principle unbounded.
         *
         * Deliberately **not** patching the phase from the cancel response:
         * that response is sent the moment the abort is signalled, before the
         * run has settled, so it would be this client deciding how the run
         * ended rather than being told. The terminal event is the backend's
         * statement, and re-attaching is how it arrives.
         *
         * General on purpose, not special-cased to the stop button. Every other
         * way this stream can end early — a conversation switch, a dropped
         * socket, a closed laptop — leaves the same hole, and each of them is
         * equally well served by resuming from the cursor. Exactly one consumer
         * still: the claim above is released first, and `attachToRun` ignores a
         * run it is already following.
         *
         * Not after an identity switch: that run belongs to the previous owner
         * and nothing of it may be applied here.
         */
        if (runId && conversationId && !resolved && accessEpoch() === issuedAt) {
          attachToRun(qc, { runId, conversationId });
        }
      }
    },
  };
}
