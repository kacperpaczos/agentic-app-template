import { restStorage, type ChatLLM, type ChatStorage } from '@openuidev/react-headless';
import type { QueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost } from '../api/client.ts';
import { useAppState } from '../state/appState.ts';
import { uiSnapshotSession } from '../state/uiSnapshot.ts';
import { platformAguiAdapter } from './platformAdapter.ts';

/**
 * Cancels one named run in the backend.
 *
 * The only path to cancellation, and deliberately explicit. See the note in
 * `send` for why the stream's abort signal is not allowed to mean this.
 */
export async function stopRun(runId: string): Promise<void> {
  await apiPost(`/api/runs/${runId}/cancel`);
}

/**
 * Conversation storage.
 *
 * `restStorage` is used as-is against `/api/threads`, because the backend was
 * written to its conventions (`/get`, `/create`, `/get/:id`, `/update/:id`,
 * `/delete/:id`). That is configuration, not an adapter.
 *
 * The artifact channel is ours: `restStorage` implements the `thread` channel
 * only, so without this the Artifacts navigation in the ready-made chat would
 * simply not appear.
 */
export function createChatStorage(): ChatStorage {
  const { thread } = restStorage({ baseUrl: '/api/threads' });

  return {
    thread,
    artifact: {
      async list(params) {
        const query = params?.type?.length ? `?type=${params.type.join(',')}` : '';
        const res = await apiGet<{ artifacts: Array<Record<string, unknown>> }>(`/api/artifacts${query}`);
        return {
          artifacts: res.artifacts.map((a) => ({
            id: String(a.id),
            title: String(a.title),
            type: String(a.type),
            threadId: String(a.threadId ?? ''),
            updatedAt: String(a.updatedAt ?? ''),
          })),
        };
      },
      async get(id) {
        const a = await apiGet<Record<string, unknown>>(`/api/artifacts/${id}`);
        return {
          id: String(a.id),
          title: String(a.title),
          type: String(a.type),
          threadId: String(a.threadId ?? ''),
          updatedAt: String(a.updatedAt ?? ''),
          content: a.content,
        };
      },
      async update(patch) {
        const a = await apiPatch<Record<string, unknown>>(`/api/artifacts/${patch.id}`, {
          content: patch.content,
        });
        return {
          id: String(a.id),
          title: String(a.title),
          type: String(a.type),
          threadId: String(a.threadId ?? ''),
          updatedAt: String(a.updatedAt ?? ''),
        };
      },
    },
  };
}

/**
 * The chat's connection to the agent.
 *
 * `send` posts an AG-UI `RunAgentInput` and returns the streaming response. The
 * application context is read from the store *at send time*, so the command the
 * user just typed is evaluated against what they are looking at right now —
 * not against whatever was selected when the chat mounted.
 */
export function createChatLlm(qc: QueryClient): ChatLLM {
  return {
    streamProtocol: platformAguiAdapter(qc),
    async send({ threadId, messages, signal }) {
      /*
       * The thread being sent to is the conversation on screen, even when the
       * chat selected it a moment ago and the shell has not caught up yet (it
       * would on the response). Recorded first, so the screen's description —
       * and a UI command arriving from this run — name the same conversation
       * as the command.
       */
      if (threadId && useAppState.getState().conversationId !== threadId) {
        useAppState.getState().setConversation(threadId);
      }
      /*
       * The command carries the version of the screen it was sent from; publish
       * that version first, so the backend has what the command refers to.
       * Bounded: a slow publication must not hold the command back.
       */
      await uiSnapshotSession.flush({ timeoutMs: 1500 });
      const state = useAppState.getState();
      const appContext = { ...state.toAppContext(), conversationId: threadId || state.conversationId };
      // Accepted but not yet executing. The backend may have to wait for this
      // conversation's previous run, and the user should see that rather than a
      // silent pause. Recorded against the conversation, not globally — a run
      // queued in one conversation must not colour another one's strip.
      if (threadId) {
        state.patchRun(threadId, {
          phase: 'queued',
          runId: null,
          activeTool: null,
          streamingText: '',
          errorCode: null,
          errorMessage: null,
          lastSeq: 0,
          pendingPermission: null,
          unseenResult: false,
        });
      }

      const res = await fetch('/api/agui/run', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          threadId,
          runId: crypto.randomUUID(),
          messages,
          context: appContext,
          forwardedProps: { attachFileIds: state.attachments },
        }),
      });

      /*
       * Attachments belong to the command they were attached to. Clearing them
       * here — after the request carries them, before the next one is typed —
       * is what stops a file silently riding along with every later message.
       */
      if (state.attachments.length > 0) useAppState.getState().setAttachments([]);

      const runId = res.headers.get('X-Run-Id');
      const conversationId = res.headers.get('X-Conversation-Id');
      if (runId) useAppState.getState().setLastRunId(runId);
      if (conversationId) {
        useAppState.getState().setConversation(conversationId);
        if (runId) useAppState.getState().patchRun(conversationId, { runId });
      }

      /*
       * The abort of this fetch is deliberately **not** forwarded to the cancel
       * endpoint.
       *
       * It used to be, on the reasoning that the chat's stop button aborts the
       * fetch and a run must not outlive a stop. But the same `AbortController`
       * is torn down for reasons that are not a stop at all: `selectThread` in
       * the library calls `cancelMessage()` on every conversation switch, and a
       * reload or a closed tab aborts it too. Forwarding it meant that moving to
       * another conversation — or pressing refresh — silently killed work that
       * was supposed to keep running, which is the opposite of what a background
       * task is for. The signal cannot distinguish those cases, so it is not
       * used to decide them.
       *
       * Cancellation is instead an explicit action against a named run
       * (`stopRun`), reachable from the run strip and from the background-task
       * list. Aborting here now means only "stop showing me this stream"; the
       * run continues and can be re-attached to from
       * `GET /api/runs/:id/stream`.
       */
      void signal;

      return res;
    },
  };
}
