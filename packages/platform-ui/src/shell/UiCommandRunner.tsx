import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  REJECTED_SORT_FAILURES,
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
import { uiSnapshotSession } from '../state/uiSnapshot.ts';
import { performAndAcknowledge, pollUntil, waitingDeadline } from './uiCommandAck.ts';
import { cachedLoader, planViewCommand } from './uiCommandPlan.ts';
import { markHighlighted, performReveal } from './uiReveal.ts';

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
 *  - `mixed_units` — the view can be ordered by the field, but the records on
 *    screen hold it in several units, so no order over them is a ranking; the
 *    units are reported with it (`rejectedSort`);
 *  - `views_unavailable` — the view definitions could not be loaded, so a
 *    change of a view's state could not be judged; nothing was done;
 *  - `not_applied` — the narrowing or order was accepted but no view reported
 *    applying it. Distinct from narrowing to nothing: "your screen now shows
 *    none of the rows" is an answer, "your screen is unchanged" is a defect,
 *    and the agent must not report the second as the first. It is a defect
 *    signal only: a view that was merely still being read answers `refreshing`
 *    (`uiReveal.ts`), which is worth asking again.
 *
 * Idempotent by `commandId`: a re-attached run replays its events from a
 * sequence number, and a navigation that happened once must not happen again
 * because the user reloaded.
 */

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
  const reveal = useCallback(async (selector: string | undefined, waitUntil: number): Promise<boolean> => {
    if (!selector) return false;
    // One frame for the route change to paint before looking for the element.
    const el = await pollUntil(() => document.querySelector<HTMLElement>(selector), {
      attempts: 12,
      intervalMs: 60,
      until: waitUntil,
    });
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    markHighlighted(el);
    return true;
  }, []);

  const perform = useCallback(
    async (command: UiCommand, budget: { deadline: number }): Promise<UiCommandResult> => {
      const base = { commandId: command.commandId, targetId: command.targetId };
      /*
       * Waiting for the view and for the element ends in time to describe the
       * result and acknowledge it within the budget the server waits — see
       * `performAndAcknowledge`. A view that has not reported by then is
       * reported as not applied rather than letting the server call it `no_client`.
       */
      const waitUntil = waitingDeadline(budget.deadline);

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
      /*
       * Showing one record's field is its own kind of command: the server has
       * already chosen the data component that renders it, and the client's
       * work is to reach that instance, make the record visible and point at
       * the cell — see `uiReveal.ts`. It is answered before the catalog target
       * is resolved, because a record screen with route parameters has no
       * catalog target of its own.
       */
      if (command.reveal) {
        return performReveal({ ...command, reveal: command.reveal }, {
          catalog: catalog.current,
          navigate: (options) => navigate(options as never) as Promise<unknown>,
          until: waitUntil,
        });
      }

      const target = catalog.current.find((t) => t.id === command.targetId);
      if (!target) {
        return { ...base, executed: false, reason: UI_COMMAND_FAILURES.unknownTarget };
      }

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

      // Switching workspace is a state change, and the URL follows it through
      // `SpaceSync`, so Back returns to the previous one. Only after every
      // refusal above: a command that is not performed changes nothing.
      if (plan.switchSpace) setSpace(plan.switchSpace);

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
        const answer = await pollUntil<{ report: ViewStateReport } | { counted: { matched: number; total: number } }>(
          () => {
            const state = useAppState.getState();
            const report = state.viewStates[command.targetId];
            if (report && report.address === expectedKey) return { report };
            if (!reportingView && narrowing && state.filterOutcome?.targetId === command.targetId) {
              return { counted: { matched: state.filterOutcome.matched, total: state.filterOutcome.total } };
            }
            return null;
          },
          { attempts: VIEW_REPORT_ATTEMPTS, intervalMs: VIEW_REPORT_INTERVAL_MS, until: waitUntil },
        );
        if (answer && 'report' in answer) viewReport = answer.report;
        if (answer && 'counted' in answer) filtered = answer.counted;
        const orderApplied =
          !ordering ||
          (viewReport?.sort?.field === ordering.field && viewReport.sort.direction === ordering.direction);
        if ((!viewReport && !filtered) || !orderApplied) {
          setAgentFilterKey(null);
          /*
           * An order the view *judged* and set aside is a different answer from
           * one nothing applied: the view says which field and why, so that is
           * passed on by name — with the units, when the records turned out to
           * be in several of them — instead of the blanket `not_applied`.
           */
          const setAside =
            ordering && viewReport?.rejectedSort?.field === ordering.field ? viewReport.rejectedSort : null;
          return {
            ...base,
            executed: false,
            reason: setAside ? REJECTED_SORT_FAILURES[setAside.reason] : UI_COMMAND_FAILURES.notApplied,
            ...(setAside ? { rejectedSort: setAside, sorted: viewReport?.sort ?? null } : {}),
            url: window.location.pathname + window.location.search,
          };
        }
        if (viewReport && narrowing) filtered = { matched: viewReport.matched, total: viewReport.total };
      }

      const highlighted = target.selector ? await reveal(target.selector, waitUntil) : false;
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

      await performAndAcknowledge(command, {
        perform,
        session: uiSnapshotSession,
        post: (runId, result) => apiPost(`/api/runs/${runId}/ui-ack`, result),
      });
    });
    return () => setUiCommandHandler(null);
  }, [perform]);

  return null;
}
