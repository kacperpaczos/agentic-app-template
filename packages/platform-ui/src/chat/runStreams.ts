import type { QueryClient } from '@tanstack/react-query';
import { apiGet } from '../api/client.ts';
import { accessSignal } from '../api/accessContext.ts';
import { useAppState } from '../state/appState.ts';
import { applyRunEvent } from './runEvents.ts';

/**
 * Keeps the interface attached to work the backend is doing, whether or not the
 * request that started it is still open.
 *
 * A run is owned by the backend, not by the socket that began it. Reloading,
 * switching conversation, closing the panel or losing the network ends the
 * response to `POST /api/agui/run` — and used to end the *display* of a run that
 * was still going, with no way back to it short of re-asking. Worse, the chat's
 * abort was forwarded straight to the cancel endpoint, so switching conversation
 * genuinely killed the task.
 *
 * What this does instead: ask the backend what is still running, and re-attach
 * to each one from the sequence number already applied. Replay is exact because
 * every event is persisted before it becomes readable, so nothing is shown
 * twice and nothing is invented.
 *
 * Attachment is per run and idempotent: `attach` on a run already being followed
 * returns immediately, so repeated syncs (a reload, a conversation switch, a
 * poll) cannot double-apply an event stream.
 */

interface Attachment {
  runId: string;
  conversationId: string;
  abort: AbortController;
}

const attached = new Map<string, Attachment>();

/**
 * Runs already being consumed by the response to `POST /api/agui/run`.
 *
 * A run must have exactly one consumer feeding the reducer. Without this, a run
 * started in this tab had two: the POST response the ready-made chat is
 * parsing, and a re-attachment opened by the background-task sync the moment the
 * conversation id appeared. Both applied the same `TEXT_MESSAGE_CONTENT`
 * events, and since the reducer appends deltas, **the answer text doubled** —
 * 107 characters of answer measured as 214. It also made a reply delivered in
 * one burst look as though it had grown.
 *
 * So the send path claims its run, and re-attachment skips anything claimed.
 * A reload drops the claim with the page, which is exactly when re-attachment
 * becomes the right consumer.
 */
const claimed = new Set<string>();

/** Marks a run as consumed by the send path. */
export const claimRunStream = (runId: string): void => {
  claimed.add(runId);
};

/** Releases a claim when the send path's stream ends. */
export const releaseRunStream = (runId: string): void => {
  claimed.delete(runId);
};

/** Runs currently being followed. Exposed for assertions and diagnostics. */
export const attachedRunIds = (): string[] => [...attached.keys()];

/** Runs claimed by the send path. Exposed for assertions. */
export const claimedRunIds = (): string[] => [...claimed];

/**
 * Reads an SSE body and hands each `data:` payload to the reducer.
 *
 * Written against the response body rather than `EventSource` for two reasons:
 * `EventSource` cannot send credentials on a cross-port dev origin, and it has
 * no way to stop retrying — a finished run would be reconnected to for ever.
 */
async function pump(
  response: Response,
  conversationId: string,
  ctx: { qc: QueryClient },
  onSeq: (seq: number) => void,
): Promise<void> {
  const body = response.body;
  if (!body) return;
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    // SSE frames are separated by a blank line; anything after the last one is
    // an incomplete frame and stays in the buffer.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      let seq: number | null = null;
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        else if (line.startsWith('id:')) seq = Number(line.slice(3).trim()) || null;
      }
      if (dataLines.length === 0) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
      } catch {
        continue;
      }
      applyRunEvent(conversationId, event, {
        qc: ctx.qc,
        isActive: () => useAppState.getState().conversationId === conversationId,
      });
      if (seq !== null) onSeq(seq);
    }
  }
}

/**
 * Follows one run from where this client left off.
 *
 * Safe to call repeatedly: a run already attached is left alone.
 */
export function attachToRun(
  qc: QueryClient,
  input: { runId: string; conversationId: string },
): void {
  // Already following it, or the send path is — one consumer per run.
  if (attached.has(input.runId) || claimed.has(input.runId)) return;

  const store = useAppState.getState();
  const from = store.runFor(input.conversationId).lastSeq;
  const abort = new AbortController();
  attached.set(input.runId, { ...input, abort });

  void (async () => {
    try {
      const res = await fetch(`/api/runs/${input.runId}/stream?from=${from}`, {
        credentials: 'include',
        // Bound to the access context as well as to this attachment: switching
        // identity must not leave a stream of the previous one running.
        signal: AbortSignal.any([abort.signal, accessSignal()]),
      });
      if (!res.ok) return;
      await pump(res, input.conversationId, { qc }, (seq) =>
        useAppState.getState().patchRun(input.conversationId, { lastSeq: seq }),
      );
    } catch {
      /*
       * A dropped attachment is not a failed run. The record in the backend is
       * unaffected; the next sync re-attaches from the last applied sequence.
       */
    } finally {
      attached.delete(input.runId);
    }
  })();
}

/** Stops following a run without touching it in the backend. */
export function detachFromRun(runId: string): void {
  const entry = attached.get(runId);
  if (!entry) return;
  attached.delete(runId);
  entry.abort.abort();
}

export interface ActiveRun {
  id: string;
  conversationId: string;
  conversationTitle: string;
  status: string;
  enqueuedAt: string;
  startedAt: string;
}

/**
 * Asks the backend what is still in flight and attaches to all of it.
 *
 * Called on load and whenever the active conversation changes, because those
 * are the moments a client's picture of "what is running" can be stale. The
 * answer is the backend's, never inferred from what this tab happens to
 * remember.
 */
export async function syncActiveRuns(qc: QueryClient): Promise<ActiveRun[]> {
  const { runs } = await apiGet<{ runs: ActiveRun[] }>('/api/runs/active');
  const store = useAppState.getState();
  for (const run of runs) {
    // Seed the record so the strip shows something before the first event of
    // the replay lands — a task that is queued has produced no events at all.
    const known = store.runFor(run.conversationId);
    if (known.runId !== run.id || known.phase === 'idle') {
      store.patchRun(run.conversationId, {
        runId: run.id,
        phase: run.status === 'queued' ? 'queued' : run.status === 'awaiting_consent' ? 'awaiting_consent' : 'running',
        // A different run than the one we were following means the record we
        // hold describes something else; its cursor must not be reused.
        ...(known.runId !== run.id ? { lastSeq: 0, streamingText: '' } : {}),
      });
    }
    attachToRun(qc, { runId: run.id, conversationId: run.conversationId });
  }
  return runs;
}

/** Test seam: drops every attachment without touching the backend. */
export function resetRunStreams(): void {
  for (const id of [...attached.keys()]) detachFromRun(id);
  claimed.clear();
}
