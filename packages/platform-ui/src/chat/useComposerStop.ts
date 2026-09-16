import { useEffect } from 'react';
import { stopRun } from './chatWiring.ts';
import { useAppState } from '../state/appState.ts';

/**
 * Makes the ready-made composer's stop button actually cancel the run.
 *
 * **Why not the abort signal.** The obvious wiring — forward the chat's
 * `AbortSignal` to the cancel endpoint — is what used to kill background tasks:
 * the library fires that same signal from `selectThread` on every conversation
 * switch, and the browser fires it on reload. The signal cannot tell a stop from
 * a navigation, so it must not decide a cancellation.
 *
 * **What this does instead.** It watches for the one thing that *is*
 * unambiguous: a click on the composer's submit control while this
 * conversation's run is in flight. In that state the control is the stop button
 * — the library swaps its role — so the click is a stop and nothing else.
 *
 * Listening in the capture phase and on the panel, rather than replacing the
 * button: the composer stays the ready-made component, keeps its own behaviour
 * (ending the stream locally), and gains the one effect it cannot have on its
 * own — ending the work in the backend.
 *
 * This is additive. The explicit Stop in the run strip and in the background
 * task list remains the way to cancel a run from *another* conversation, which
 * the composer cannot express at all.
 */
const ACTIVE = new Set(['queued', 'running', 'awaiting_consent']);

export function useComposerStop(panel: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = panel.current;
    if (!node) return;

    const onClick = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest?.('.openui-agent-thread-composer__submit-button')) return;

      const state = useAppState.getState();
      const run = state.runFor(state.conversationId);
      // Only when this conversation has work in flight; otherwise the same
      // control means "send", and cancelling would be nonsense.
      if (!run.runId || !ACTIVE.has(run.phase)) return;
      void stopRun(run.runId);
    };

    node.addEventListener('click', onClick, { capture: true });
    return () => node.removeEventListener('click', onClick, { capture: true });
  }, [panel]);
}
