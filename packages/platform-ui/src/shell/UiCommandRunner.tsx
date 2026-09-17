import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  UI_COMMAND_FAILURES,
  viewAddressKey,
  type UiCommand,
  type UiCommandResult,
  type UiTarget,
  type ViewDefinition,
} from '@platform/contracts';
import { apiGet, apiPost } from '../api/client.ts';
import { useAppState, type ViewStateReport } from '../state/appState.ts';
import { setUiCommandHandler } from '../chat/runEvents.ts';
import { cachedLoader, planViewCommand } from './uiCommandPlan.ts';

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
 *  - `no_client` — added by the server when nothing answered at all;
 *  - `not_filterable` / `unknown_field` — the view declares no narrowing, or the
 *    agent named a property it does not declare;
 *  - `not_sortable` — an order (or clearing one) for a target with no view that
 *    can be ordered;
 *  - `views_unavailable` — the view definitions could not be loaded, so a
 *    change of a view's state could not be judged; nothing was done;
 *  - `not_applied` — the narrowing or order was accepted but no view reported
 *    applying it. Distinct from narrowing to nothing: "your screen now shows
 *    none of the rows" is an answer, "your screen is unchanged" is a defect,
 *    and the agent must not report the second as the first.
 *
 * Idempotent by `commandId`: a re-attached run replays its events from a
 * sequence number, and a navigation that happened once must not happen again
 * because the user reloaded.
 */

/** How long the highlight stays on screen. */
const HIGHLIGHT_MS = 2600;

/**
 * How long to wait for a view to report the state it was asked for. Long
 * enough for a screen that still has to fetch its composition and its read.
 */
const VIEW_REPORT_ATTEMPTS = 80;
const VIEW_REPORT_INTERVAL_MS = 60;

export function UiCommandRunner() {
  const navigate = useNavigate();
  const setSpace = useAppState((s) => s.setSpace);
  const setAgentFilterKey = useAppState((s) => s.setAgentFilterKey);
  const reportFilterOutcome = useAppState((s) => s.reportFilterOutcome);
  const handled = useRef(new Set<string>());
  const catalog = useRef<UiTarget[] | null>(null);
  // View definitions, loaded on the first command that needs them; a failed load is retried.
  const loadViews = useMemo(
    () => cachedLoader(async () => (await apiGet<{ views: ViewDefinition[] }>('/api/ui/views')).views),
    [],
  );

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

      /*
       * A narrowing and an order are changes of address, not of client state.
       *
       * They become search parameters (`?country=PL&sort=-name`), so the view
       * can be linked, reloaded and undone with Back — see `state/viewFilter.ts`.
       * For each, `undefined` leaves the address alone, `null` clears it, and a
       * value sets it. Which commands are refused, where a command leads and
       * whether a view must confirm it is decided in `planViewCommand`.
       */
      const narrowing = command.filter;
      const ordering = command.sort;
      const changesView = narrowing !== undefined || ordering !== undefined;
      const plan = planViewCommand({
        command,
        target,
        // Only a change of a view's state needs the view definitions.
        views: changesView ? await loadViews() : [],
        location: { pathname: window.location.pathname, search: window.location.search },
      });
      if (plan.kind === 'refuse') return { ...base, executed: false, reason: plan.reason };
      const { filterFields, reportingView, samePath, patch, expected, expectedKey, unchanged, awaitsView } = plan;

      /*
       * The same state asked for again changes nothing in the address, so no
       * view reports anything new. That is still an applied command: the answer
       * is the state already on screen. A composed view's standing report
       * matches the address and answers it; a module screen's narrowing count
       * is kept rather than reset, since it describes this very address.
       */
      const standingOutcome = useAppState.getState().filterOutcome;

      if (changesView) {
        /*
         * Remembered as a key of the resulting narrowing and order, so the
         * banner credits the agent exactly while the screen still shows what
         * the agent set — a later change by the user, a reload or Back is not
         * the agent's doing. Set before navigating: it also resets the
         * narrowing's count, so a count from before cannot answer this command.
         */
        const agentKey = viewAddressKey(expected, filterFields, { page: false });
        const empty = viewAddressKey({}, filterFields, { page: false });
        setAgentFilterKey(agentKey === empty ? null : `${target.id}|${agentKey}`);
        if (unchanged && standingOutcome?.targetId === target.id) reportFilterOutcome(standingOutcome);
      }

      if (target.to) {
        await navigate({
          to: target.to,
          search: (prev: Record<string, unknown>) => (samePath ? { ...prev, ...patch } : { ...patch }),
        } as never);
      }

      /*
       * Wait for the view to report what it did, the same way the highlight
       * waits for its element. Without this the answer would be "we set some
       * state", and the difference that matters — narrowed to nothing versus
       * nothing applied it — would be unanswerable. `not_applied` is what the
       * user's screen looking untouched actually is.
       *
       * A composed view reports its whole state for the address it applied, so
       * only a report for *this* address counts. A module screen without one
       * reports only a narrowing's count (`filterOutcome`).
       */
      let filtered: { matched: number; total: number } | undefined;
      let viewReport: ViewStateReport | null = null;
      if (awaitsView) {
        for (let attempt = 0; attempt < VIEW_REPORT_ATTEMPTS; attempt += 1) {
          const state = useAppState.getState();
          const report = state.viewStates[command.targetId];
          if (report && report.address === expectedKey) {
            viewReport = report;
            break;
          }
          if (!reportingView && narrowing && state.filterOutcome?.targetId === command.targetId) {
            filtered = { matched: state.filterOutcome.matched, total: state.filterOutcome.total };
            break;
          }
          await new Promise((r) => window.setTimeout(r, VIEW_REPORT_INTERVAL_MS));
        }
        const orderApplied =
          !ordering ||
          (viewReport?.sort?.field === ordering.field && viewReport.sort.direction === ordering.direction);
        if ((!viewReport && !filtered) || !orderApplied) {
          setAgentFilterKey(null);
          return {
            ...base,
            executed: false,
            reason: UI_COMMAND_FAILURES.notApplied,
            url: window.location.pathname + window.location.search,
          };
        }
        if (viewReport && narrowing) filtered = { matched: viewReport.matched, total: viewReport.total };
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
        ...(filtered ? { filtered } : {}),
        ...(viewReport && ordering !== undefined ? { sorted: viewReport.sort } : {}),
        ...(viewReport?.page ? { page: viewReport.page } : {}),
        url: window.location.pathname + window.location.search,
      };
    },
    [navigate, reveal, setSpace, setAgentFilterKey, reportFilterOutcome, loadViews],
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
