import { restStorage, type ChatLLM, type ChatStorage } from '@openuidev/react-headless';
import type { QueryClient } from '@tanstack/react-query';
import { accessFetch, apiGet, apiPatch, apiPost } from '../api/client.ts';
import { qk } from '../api/queries.ts';
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
 * The artifact reference a renderer is handed, in both paths the ready-made
 * chat has.
 *
 * The library runs one `parser` for a tool call (`response` = what the tool
 * returned) and for a stored artifact (`response` = the artifact's `content`),
 * and its contract says the two must have the same shape. The platform's own
 * artifact tools answer `{ artifactId }`, so the storage channel below reports
 * `{ artifactId }` as well — and neither path hands a renderer any *data*.
 *
 * That is the point, not a shortcut. Data handed over here would be whatever
 * the chat happened to be holding: the tool's result from when the run
 * finished, or a list entry from when the browser last loaded. The renderer
 * re-reads the artifact instead (`ArtifactContent` → `qk.artifact`), which for
 * a live artifact re-runs its query server-side — so a preview in a message and
 * the full view in the artifact browser read one cache entry and cannot show
 * two different answers.
 */
export interface ArtifactReference {
  artifactId: string;
}

/** The `{ artifactId }` in a tool result or a stored artifact's content, if there is one. */
export function artifactReferenceOf(raw: unknown): ArtifactReference | null {
  let value = raw;
  // Tool results reach the chat as text: the SDK does not pre-parse them.
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const id = (value as { artifactId?: unknown } | null)?.artifactId;
  return typeof id === 'string' && id ? { artifactId: id } : null;
}

/** Cache key for the artifact list under one type filter. */
const artifactListKey = (types?: readonly string[]) =>
  qk.artifacts(types?.length ? `type:${[...types].sort().join(',')}` : undefined);

/**
 * Conversation storage.
 *
 * `restStorage` is used as-is against `/api/threads`, because the backend was
 * written to its conventions (`/get`, `/create`, `/get/:id`, `/update/:id`,
 * `/delete/:id`). That is configuration, not an adapter — except for the one
 * thing it cannot know: which identity the request belongs to. Its own `fetch`
 * option takes {@link accessFetch}, so a thread list or a message load issued
 * as one owner is aborted, and its late answer refused, the moment the
 * application acts as another. Without it the chat kept the previous owner's
 * conversations on screen in the same tab.
 *
 * The artifact channel is ours: `restStorage` implements the `thread` channel
 * only, so without this the Artifacts navigation in the ready-made chat would
 * simply not appear. It reads **through the query cache**, not past it. The
 * library's artifact browser used to call the API directly, so the browser's
 * list, the full view it opens and a preview in a message were three
 * independent fetches of the same artifact and could disagree — which is
 * exactly what a reader cannot check. One key, one fetch, one answer.
 */
export function createChatStorage(qc: QueryClient): ChatStorage {
  const { thread } = restStorage({ baseUrl: '/api/threads', fetch: accessFetch });

  const summarise = (a: Record<string, unknown>) => ({
    id: String(a.id),
    title: String(a.title),
    type: String(a.type),
    threadId: String(a.threadId ?? ''),
    updatedAt: String(a.updatedAt ?? ''),
  });

  return {
    thread,
    artifact: {
      async list(params) {
        const types = params?.type?.length ? params.type : undefined;
        const query = types ? `?type=${types.join(',')}` : '';
        const res = await qc.fetchQuery({
          queryKey: artifactListKey(types),
          queryFn: () =>
            apiGet<{ artifacts: Array<Record<string, unknown>> }>(`/api/artifacts${query}`),
        });
        return { artifacts: res.artifacts.map(summarise) };
      },
      async get(id) {
        const a = await qc.fetchQuery({
          queryKey: qk.artifact(id),
          queryFn: () => apiGet<Record<string, unknown>>(`/api/artifacts/${id}`),
        });
        // A reference, not data — see `ArtifactReference`.
        return { ...summarise(a), content: { artifactId: String(a.id) } satisfies ArtifactReference };
      },
      async update(patch) {
        const a = await apiPatch<Record<string, unknown>>(`/api/artifacts/${patch.id}`, {
          content: patch.content,
        });
        // A new version: whatever is showing this artifact must re-read it.
        void qc.invalidateQueries({ queryKey: qk.artifact(patch.id) });
        void qc.invalidateQueries({ queryKey: ['artifacts'] });
        return summarise(a);
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

      /*
       * Through `accessFetch`, not a bare `fetch`.
       *
       * This is the one request whose body outlives it by minutes: the answer
       * arrives as a stream that keeps feeding the reducer and invalidating
       * caches long after the response resolved. Bound only to the library's
       * own signal it survived an identity switch — the previous owner's tool
       * results, canvas invalidations and answer text went on landing in a tab
       * that was now acting as somebody else. The shared access signal aborts
       * the body as well as the request; the epoch check in the adapter
       * (`platformAdapter.ts`) is the second defence for an event that gets
       * past the abort.
       */
      const res = await accessFetch('/api/agui/run', {
        method: 'POST',
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
