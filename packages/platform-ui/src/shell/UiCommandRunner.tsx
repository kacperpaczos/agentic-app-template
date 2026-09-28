import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  UI_COMMAND_FAILURES,
  type UiCommand,
  type UiCommandResult,
  type UiTarget,
} from '@platform/contracts';
import { apiGet, apiPost } from '../api/client.ts';
import { useAppState } from '../state/appState.ts';
import { setUiCommandHandler } from '../chat/runEvents.ts';

/**
 * Performs the agent's interface commands — and reports back what really
 * happened.
 *
 * The acknowledgement is the whole point. `ui_navigate` on the server does not
 * resolve until this posts a result, so the model is told the observed outcome
 * rather than the fact that a request was sent. Every refusal below is a
 * distinct, truthful answer:
 *
 *  - `unknown_target` — the id is not in the catalog;
 *  - `not_present` — the target's element is not in the document, so there was
 *    nothing to scroll to;
 *  - `inactive_conversation` — the command came from a conversation the user is
 *    not looking at. A task running in the background must not pull the screen
 *    away from what its owner is doing now, so this is reported, not performed;
 *  - `no_client` — added by the server when nothing answered at all.
 *
 * Idempotent by `commandId`: a re-attached run replays its events from a
 * sequence number, and a navigation that happened once must not happen again
 * because the user reloaded.
 */

/** How long the highlight stays on screen. */
const HIGHLIGHT_MS = 2600;

export function UiCommandRunner() {
  const navigate = useNavigate();
  const setSpace = useAppState((s) => s.setSpace);
  const handled = useRef(new Set<string>());
  const catalog = useRef<UiTarget[] | null>(null);

  /** Scrolls to the element and marks it, returning whether it was found. */
  const reveal = useCallback(async (selector: string | undefined): Promise<boolean> => {
    if (!selector) return false;
    // One frame for the route change to paint before looking for the element.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.setAttribute('data-ui-highlight', 'true');
        window.setTimeout(() => el.removeAttribute('data-ui-highlight'), HIGHLIGHT_MS);
        return true;
      }
      await new Promise((r) => window.setTimeout(r, 60));
    }
    return false;
  }, []);

  const perform = useCallback(
    async (command: UiCommand): Promise<UiCommandResult> => {
      const base = { commandId: command.commandId, targetId: command.targetId };

      /*
       * A command from a conversation the user is not watching is refused, not
       * performed. Answered honestly so the agent can say "I did not move your
       * screen because you are elsewhere" instead of claiming a navigation.
       */
      if (useAppState.getState().conversationId !== command.conversationId) {
        return { ...base, executed: false, reason: UI_COMMAND_FAILURES.inactiveConversation };
      }

      if (!catalog.current) {
        try {
          catalog.current = (await apiGet<{ targets: UiTarget[] }>('/api/ui/targets')).targets;
        } catch {
          return { ...base, executed: false, reason: UI_COMMAND_FAILURES.unknownTarget };
        }
      }
      const target = catalog.current.find((t) => t.id === command.targetId);
      if (!target) {
        return { ...base, executed: false, reason: UI_COMMAND_FAILURES.unknownTarget };
      }

      // Switching workspace is a state change, and the URL follows it through
      // `SpaceSync`, so Back returns to the previous one.
      if (command.spaceId) setSpace(command.spaceId);

      if (target.to) {
        await navigate({ to: target.to, search: (prev: Record<string, unknown>) => prev } as never);
      }

      const highlighted = target.selector ? await reveal(target.selector) : false;
      if (target.selector && !highlighted) {
        /*
         * The screen may well have changed, but the element the agent was asked
         * to point at is not there. Reporting success would tell the user to
         * look at something that is not on their screen.
         */
        return {
          ...base,
          executed: false,
          reason: UI_COMMAND_FAILURES.notPresent,
          url: window.location.pathname + window.location.search,
        };
      }

      return {
        ...base,
        executed: true,
        highlighted,
        url: window.location.pathname + window.location.search,
      };
    },
    [navigate, reveal, setSpace],
  );

  useEffect(() => {
    setUiCommandHandler(async (command) => {
      // Replayed events must not re-navigate: a reload re-reads the run's
      // stream from a cursor, and a jump that already happened is done.
      if (handled.current.has(command.commandId)) return;
      handled.current.add(command.commandId);

      let result: UiCommandResult;
      try {
        result = await perform(command);
      } catch (e) {
        result = {
          commandId: command.commandId,
          targetId: command.targetId,
          executed: false,
          reason: e instanceof Error ? e.message.slice(0, 120) : 'error',
        };
      }
      try {
        await apiPost(`/api/runs/${command.runId}/ui-ack`, result);
      } catch {
        // The server times the command out on its own; a failed acknowledgement
        // becomes `no_client`, which is the truthful outcome.
      }
    });
    return () => setUiCommandHandler(null);
  }, [perform]);

  return null;
}
