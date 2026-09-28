import { agUIAdapter, type StreamProtocolAdapter } from '@openuidev/react-headless';
import type { QueryClient } from '@tanstack/react-query';
import { useAppState } from '../state/appState.ts';
import { applyRunEvent } from './runEvents.ts';
import { claimRunStream, releaseRunStream } from './runStreams.ts';

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
       * Claim the run for this stream.
       *
       * A run must have exactly one consumer feeding the reducer: the
       * background-task sync also re-attaches to whatever is in flight, and two
       * consumers applying the same text deltas append them twice. Released
       * when this stream ends, which is the moment re-attachment becomes the
       * right way to keep watching. See `runStreams.ts`.
       */
      if (runId) claimRunStream(runId);
      try {
        for await (const event of inner.parse(response)) {
          if (conversationId) {
            applyRunEvent(conversationId, event as Record<string, unknown>, {
              qc,
              isActive: () => useAppState.getState().conversationId === conversationId,
            });
          }
          yield event;
        }
      } finally {
        if (runId) releaseRunStream(runId);
      }
    },
  };
}
