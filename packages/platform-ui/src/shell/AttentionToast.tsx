import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useActiveRuns } from '../api/queries.ts';
import { useSessionLocation } from '../state/sessionLocation.ts';

/**
 * A one-shot notice that a background task is waiting for a decision (L11.19).
 *
 * A run parked at the consent gate is already durable — the task center shows
 * the question, the status bar counts the work — but both of those are places a
 * user has to look at. This is the one push the platform makes in the other
 * direction, and it is deliberately narrow, because every broader version has a
 * failure mode:
 *
 *  - **Only on an observed transition.** The toast fires when a poll saw the
 *    run in a different status before and in `awaiting_consent` now. A page
 *    that loads into an already-waiting run — a reload, a colleague's screen —
 *    never saw the transition and stays quiet; the badge is the durable signal
 *    precisely so this one does not have to be.
 *  - **Never for the active conversation's run.** There the question has its
 *    own place, the `PermissionPrompt` in the chat. A transition observed while
 *    the run *was* the active conversation's stays eligible but unsurfaced, and
 *    fires only if the user moves away while the question still stands — so
 *    leaving the conversation is what turns the question into a notification,
 *    and answering it (anywhere) takes the eligibility away.
 *  - **Once per run, in this page's life.** The announced set lives in memory,
 *    deliberately not in `localStorage`: one decision, one notice, and a reload
 *    starts a fresh life in which the badge carries the durable fact.
 *
 * Driven by the same `/api/runs/active` poll as the badge — one query, shared
 * through the query key, so the two can never disagree about what is waiting.
 * The action moves to the task center and nothing else: the active conversation
 * stays in the address (`c`), which the router retains across navigation.
 */

/** Runs this page has already announced. Cleared by nothing but a reload. */
const notified = new Set<string>();

/** Long enough to be read, short enough to be ignorable. */
const AUTO_HIDE_MS = 8000;

interface Attention {
  runId: string;
  intent: string;
}

export function AttentionToast() {
  const runs = useActiveRuns();
  const { conversationId } = useSessionLocation();
  const navigate = useNavigate();
  const [shown, setShown] = useState<Attention | null>(null);
  /*
   * The mirror of `shown` for the polling effect, which would otherwise have to
   * depend on it and re-run on every show — re-entering the eligibility scan it
   * has just finished.
   */
  const shownRef = useRef<Attention | null>(null);
  /** Previous status of every run this page has seen; the baseline of "observed". */
  const known = useRef(new Map<string, string>());
  /*
   * Runs whose step into `awaiting_consent` this page observed and has not
   * announced yet. Latched at the observation rather than re-derived later,
   * because the transition happens exactly once: a poll that sees the run
   * waiting while its conversation is the active one cannot surface it there —
   * and by the time the user moves away, the previous-status map already says
   * `awaiting_consent`. What was observed stays eligible until the question is
   * gone; what was never observed (a page that loaded into the waiting state)
   * never enters this set at all.
   */
  const pendingAttention = useRef(new Set<string>());

  const dismiss = () => {
    shownRef.current = null;
    setShown(null);
  };

  useEffect(() => {
    const list = runs.data?.runs ?? [];

    /* Latch the observed transitions — once, at the poll that saw them. */
    for (const r of list) {
      const before = known.current.get(r.id);
      if (
        r.status === 'awaiting_consent' &&
        before !== undefined &&
        before !== 'awaiting_consent' &&
        !notified.has(r.id)
      ) {
        pendingAttention.current.add(r.id);
      }
    }

    /* A decision made in the center or in the source conversation ends the
       notice; a toast about a question that no longer stands is noise. */
    const current = shownRef.current;
    if (current) {
      if (!list.some((r) => r.id === current.runId && r.status === 'awaiting_consent')) {
        dismiss();
      }
    } else {
      for (const r of list) {
        if (r.status !== 'awaiting_consent') continue;
        if (!pendingAttention.current.has(r.id)) continue;
        /* The active conversation's run has its prompt on screen; announcing it
           here would be the same fact twice, one of them in the way. Staying
           eligible, it surfaces the moment the user moves away — if the
           question still stands then, which the set membership is. */
        if (r.conversationId === conversationId) continue;
        notified.add(r.id);
        pendingAttention.current.delete(r.id);
        const next = { runId: r.id, intent: r.intent ?? r.conversationTitle };
        shownRef.current = next;
        setShown(next);
        break;
      }
    }

    /* Refresh the baseline, then drop eligibility for questions that ended
       unannounced — the moment for a toast about them has passed. */
    const next = new Map(known.current);
    for (const r of list) next.set(r.id, r.status);
    known.current = next;
    const stillWaiting = new Set(list.filter((r) => r.status === 'awaiting_consent').map((r) => r.id));
    for (const id of [...pendingAttention.current]) {
      if (!stillWaiting.has(id)) pendingAttention.current.delete(id);
    }
    /* `runs.data` is a new object on every poll; the scan is cheap and the
       transitions it looks for happen exactly between two polls. */
  }, [runs.data, conversationId]);

  /* Auto-hide: the badge keeps the count, so hiding loses no information. */
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(dismiss, AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  if (!shown) return null;

  return (
    <div className="pf-attention" role="status" data-testid="attention-toast">
      <span className="pf-dot pf-dot--busy" aria-hidden="true" />
      <p className="pf-attention__text">Zadanie „{shown.intent}” czeka na decyzję</p>
      <div className="pf-attention__actions">
        <button
          type="button"
          className="pf-btn pf-btn--tiny pf-btn--primary"
          data-testid="attention-toast-open"
          onClick={() => {
            dismiss();
            // To the center only. The active conversation stays in the address
            // bar — the router retains `c` — so this is a change of what is
            // being read, not of what is being talked about.
            void navigate({ to: '/tasks' });
          }}
        >
          Otwórz centrum zadań
        </button>
        <button
          type="button"
          className="pf-btn pf-btn--tiny"
          data-testid="attention-toast-close"
          aria-label="Zamknij powiadomienie"
          onClick={dismiss}
        >
          Zamknij
        </button>
      </div>
    </div>
  );
}
