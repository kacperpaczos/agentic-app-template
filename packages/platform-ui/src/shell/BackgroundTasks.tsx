import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { stopRun } from '../chat/chatWiring.ts';
import { syncActiveRuns, type ActiveRun } from '../chat/runStreams.ts';
import { useSessionLocation } from '../state/sessionLocation.ts';
import { useAppState } from '../state/appState.ts';

/**
 * What the backend is working on, across every conversation.
 *
 * Exists because a run is not the panel that started it. Once work survives a
 * conversation switch and a reload, "is anything still running?" stops being
 * answerable from the current view — and a task that finishes while the user is
 * somewhere else has no way to say so.
 *
 * Two deliberate restrictions:
 *
 *  - **It never takes over the view.** A finished or consent-waiting task is
 *    announced here; moving to it is a click the user makes. A background task
 *    that yanked the screen away mid-sentence would be worse than silence.
 *  - **Stop targets one named run.** The composer's abort cannot mean "cancel",
 *    because the library fires it on every conversation switch (see
 *    `chatWiring.ts`); this is the control that actually ends a task.
 */
export function BackgroundTasks() {
  const qc = useQueryClient();
  const runs = useAppState((s) => s.runs);
  const activeConversation = useAppState((s) => s.conversationId);
  const acknowledgeRun = useAppState((s) => s.acknowledgeRun);
  const { setConversation } = useSessionLocation();
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);

  /*
   * Ask the backend what is in flight, and attach to all of it.
   *
   * On mount — which is also every reload — and whenever the active
   * conversation changes, because those are the moments this client's picture
   * can be stale. The list is the backend's answer, never inferred from what
   * this tab remembers.
   */
  const sync = useCallback(async () => {
    try {
      const active = await syncActiveRuns(qc);
      setTitles((prev) => {
        const next = { ...prev };
        for (const r of active) next[r.conversationId] = r.conversationTitle;
        return next;
      });
    } catch {
      // Not being able to ask does not mean nothing is running; the next sync
      // asks again, and the records already held are left alone.
    }
  }, [qc]);

  useEffect(() => {
    void sync();
  }, [sync, activeConversation]);

  /* Opening a conversation is what marks its result as seen. */
  useEffect(() => {
    if (activeConversation && runs[activeConversation]?.unseenResult) {
      acknowledgeRun(activeConversation);
    }
  }, [activeConversation, runs, acknowledgeRun]);

  const entries = Object.entries(runs)
    .map(([conversationId, run]) => ({ conversationId, run }))
    .filter(
      ({ conversationId, run }) =>
        run.phase === 'queued' ||
        run.phase === 'running' ||
        run.phase === 'awaiting_consent' ||
        (run.unseenResult && conversationId !== activeConversation),
    );

  if (entries.length === 0) return null;

  const busy = entries.filter((e) => e.run.phase !== 'succeeded' && e.run.phase !== 'failed').length;
  const done = entries.length - busy;

  const label =
    busy > 0
      ? `${busy} ${busy === 1 ? 'zadanie' : 'zadania'} w toku`
      : `${done} ${done === 1 ? 'zadanie zakonczone' : 'zadania zakonczone'}`;

  return (
    <div className="pf-tasks" data-testid="background-tasks" data-count={entries.length}>
      <button
        type="button"
        className="pf-tasks__toggle"
        aria-expanded={open}
        data-testid="background-tasks-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`pf-dot ${busy > 0 ? 'pf-dot--busy' : 'pf-dot--ok'}`} aria-hidden="true" />
        {label}
      </button>

      {open && (
        <ul className="pf-tasks__list" data-testid="background-tasks-list">
          {entries.map(({ conversationId, run }) => (
            <li key={conversationId} className="pf-tasks__item" data-conversation={conversationId}>
              <button
                type="button"
                className="pf-tasks__open"
                data-testid={`background-task-open-${conversationId}`}
                onClick={() => {
                  // A click, never an automatic jump.
                  setConversation(conversationId);
                  setOpen(false);
                }}
              >
                {titles[conversationId] ?? `rozmowa ${conversationId.slice(-8)}`}
              </button>
              <span className="pf-tasks__phase" data-phase={run.phase}>
                {run.phase === 'awaiting_consent' ? 'czeka na zgode' : run.phase}
              </span>
              {run.runId && (run.phase === 'queued' || run.phase === 'running' || run.phase === 'awaiting_consent') && (
                <button
                  type="button"
                  className="pf-btn pf-btn--tiny"
                  data-testid={`background-task-stop-${conversationId}`}
                  onClick={() => void stopRun(run.runId!)}
                >
                  Zatrzymaj
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
