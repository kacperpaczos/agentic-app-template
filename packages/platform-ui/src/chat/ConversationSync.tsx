import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useThread, useThreadList } from '@openuidev/react-headless';
import { apiGet } from '../api/client.ts';
import { useChatSlots } from './chatSlots.ts';
import { useSessionLocation } from '../state/sessionLocation.ts';
import { useAppState } from '../state/appState.ts';
import { classifyThreadFailure, decideRestore, type ThreadFailure } from './sessionRestore.ts';

/**
 * Keeps the address bar and the ready-made chat's thread selection in step.
 *
 * **Why an adapter and not a rewrite.** `AgentInterface` owns thread selection;
 * it exposes that state and the actions to change it through its own public
 * hooks (`useThreadList` → `selectedThreadId`, `selectThread`,
 * `switchToNewThread`; `useThread` → `threadError`), but it has no prop for an
 * initial conversation. So this component reads and drives the library's own
 * state and renders nothing but a fallback notice. The thread list, the message
 * loading, the composer and the history engine are all untouched — what is
 * added is the one fact the library cannot know: which conversation *this
 * application's* URL is pointing at.
 *
 * **What it fixes.** A reload used to land on a brand-new, empty conversation.
 * The history was intact on the server and reachable from the drawer, but the
 * conversation the user had been reading a second earlier was not restored, and
 * the next command started a different Claude session. Two browser tests had
 * been written to *work around* that — reopening the conversation from the
 * drawer after every reload — which is how a missing feature came to look like
 * expected behaviour.
 *
 * The rule for which side moved lives in `sessionRestore.ts` and is unit tested
 * there; this component applies it and owns the failure state.
 */
export function ConversationSync() {
  /*
   * The notice goes above the library's container, not into it.
   *
   * Rendered here it would be `slots.rest` — a panel beside the thread, taking
   * a share of the panel's width. That is the same defect the attachment strip
   * had, and it was latent here: it only showed when a conversation failed to
   * load, which is exactly when the thread can least afford to be squeezed.
   */
  const { notice: noticeHost } = useChatSlots();
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const selectThread = useThreadList((s) => s.selectThread);
  const switchToNewThread = useThreadList((s) => s.switchToNewThread);
  /*
   * The library's own load error for the selected thread. Using it rather than
   * "is it in the thread list" is what makes this correct for a conversation
   * beyond the first page of the list, and immediately after a reload when the
   * list has not arrived yet.
   */
  const threadError = useThread((s) => s.threadError);

  const { conversationId: urlThreadId, setConversation } = useSessionLocation();
  const setConversationState = useAppState((s) => s.setConversation);
  const setSpace = useAppState((s) => s.setSpace);

  const lastSynced = useRef<string | null>(null);
  const [problem, setProblem] = useState<{ threadId: string; kind: ThreadFailure } | null>(null);

  /**
   * Moves the workspace to the one this conversation belongs to.
   *
   * Only when the chat moved — picking a conversation should bring its canvas
   * space with it. When the *URL* moved it already carries the space, and
   * overriding it here would undo a restored or shared address.
   */
  const followConversationSpace = useCallback(
    async (threadId: string) => {
      try {
        const conv = await apiGet<{ spaceId: string | null }>(`/api/conversations/${threadId}`);
        if (conv.spaceId) setSpace(conv.spaceId);
      } catch {
        // Whether the conversation is reachable at all is decided below, from
        // the chat's own load error; a space lookup is not the place to report.
      }
    },
    [setSpace],
  );

  useEffect(() => {
    const decision = decideRestore({
      urlThreadId,
      selectedThreadId,
      lastSynced: lastSynced.current,
    });

    switch (decision.action) {
      case 'select':
        lastSynced.current = decision.threadId;
        setProblem(null);
        selectThread(decision.threadId);
        setConversationState(decision.threadId);
        return;
      case 'new':
        lastSynced.current = null;
        setProblem(null);
        switchToNewThread();
        setConversationState(null);
        return;
      case 'publish':
        lastSynced.current = decision.threadId;
        setProblem(null);
        setConversation(decision.threadId, { replace: decision.replace });
        setConversationState(decision.threadId);
        if (decision.threadId) void followConversationSpace(decision.threadId);
        return;
      case 'idle':
        return;
    }
  }, [
    urlThreadId,
    selectedThreadId,
    selectThread,
    switchToNewThread,
    setConversation,
    setConversationState,
    followConversationSpace,
  ]);

  /*
   * Classify a failed load by asking the API directly.
   *
   * The chat's error object comes from its own storage adapter and does not
   * carry a code we can rely on, and the difference matters: a deleted
   * conversation will never load and the user should start a new one, while a
   * failed request should be retried. One extra request, only on the error path.
   */
  useEffect(() => {
    if (!threadError || !selectedThreadId || selectedThreadId !== urlThreadId) return;
    let cancelled = false;
    void (async () => {
      let kind: ThreadFailure = 'failed';
      try {
        await apiGet(`/api/conversations/${selectedThreadId}`);
      } catch (e) {
        kind = classifyThreadFailure(e);
      }
      if (!cancelled) setProblem({ threadId: selectedThreadId, kind });
    })();
    return () => {
      cancelled = true;
    };
  }, [threadError, selectedThreadId, urlThreadId]);

  if (!problem) return null;

  const gone = problem.kind === 'gone';
  const notice = (
    <div
      className="pf-conv-missing"
      role="status"
      data-testid="conversation-missing"
      data-kind={problem.kind}
    >
      <strong>{gone ? 'Ta rozmowa jest niedostepna.' : 'Nie udalo sie wczytac rozmowy.'}</strong>
      <span>
        Rozmowa <code>{problem.threadId.slice(-8)}</code>{' '}
        {gone
          ? 'zostala usunieta albo nalezy do innego wlasciciela. Pozostale rozmowy sa na liscie w szufladzie.'
          : 'istnieje, ale jej historia sie nie wczytala. Nic nie zostalo utracone — mozna sprobowac ponownie.'}
      </span>
      <div className="pf-conv-missing__actions">
        {gone ? (
          <button
            type="button"
            className="pf-btn pf-btn--tiny"
            onClick={() => {
              setProblem(null);
              setConversation(null, { replace: true });
            }}
          >
            Zacznij nowa rozmowe
          </button>
        ) : (
          <button
            type="button"
            className="pf-btn pf-btn--tiny"
            onClick={() => {
              setProblem(null);
              // Force a fresh load: the library returns early when the id is
              // already selected, so it has to be left and re-entered.
              switchToNewThread();
              selectThread(problem.threadId);
            }}
          >
            Sprobuj ponownie
          </button>
        )}
      </div>
    </div>
  );

  /*
   * Without a host — the panel not yet measured, or this component used outside
   * `ChatPanel` — nothing is rendered rather than something rendered in the
   * wrong place. The state itself survives; the notice appears when the host does.
   */
  return noticeHost ? createPortal(notice, noticeHost) : null;
}
