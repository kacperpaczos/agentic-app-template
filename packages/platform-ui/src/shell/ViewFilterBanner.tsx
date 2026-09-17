import { useNavigate, useRouterState } from '@tanstack/react-router';
import { describePredicate, viewAddressKey, viewStatePatch } from '@platform/contracts';
import { useUiTargets } from '../api/queries.ts';
import { useAppState } from '../state/appState.ts';
import { useActiveViewFilter, useActiveViewReport } from '../state/viewFilter.ts';

/**
 * Says that this view is narrowed, by what, and gives the way back.
 *
 * **Why it is here and not in the views.** The requirement is that this appears
 * in *every* view. Rendered once above the work surface it is true of every
 * screen, including the ones written after this — a per-screen banner would be
 * a promise each new screen has to keep, and the first one that forgot would
 * hide rows with nothing saying so.
 *
 * **Why the text is generated and not quoted.** The sentence comes from the
 * predicates actually in the address bar, rendered through the view's own field
 * labels. An earlier version printed the sentence the agent supplied, which
 * could describe something other than what was applied — and which a shared
 * link would not carry at all. Generated, the banner cannot be wrong about what
 * is on screen.
 *
 * **Who did it is a separate question from what is applied.** The narrowing is
 * in the URL, so it may equally have arrived in a pasted link or with Back;
 * only a narrowing this session's agent performed is attributed to the agent.
 * That flag is transient interface state and stays in memory, where it belongs.
 *
 * **Order and page are described too.** A view sorted by something other than
 * its own order, or showing a later page or a page it had to clamp, is also
 * "not what it would show on its own" — so the same banner says so, from what
 * the view reports having applied (`viewStates`), and the same button puts the
 * whole view back: no narrowing, its own order, the first page.
 */
export function ViewFilterBanner() {
  const filter = useActiveViewFilter();
  const report = useActiveViewReport();
  const outcome = useAppState((s) => s.filterOutcome);
  const agentApplied = useAppState((s) => s.agentFilterKey);
  const targets = useUiTargets();
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const navigate = useNavigate();

  const sorted = report?.sortFromAddress ? report : null;
  const paged = report?.page && (report.page.index > 1 || report.clampedFrom !== null) ? report : null;
  const rejected = report?.rejectedSort ?? null;
  if (!filter && !sorted && !paged && !rejected) return null;

  const targetId = filter?.targetId ?? report!.targetId;
  const fields = targets.data?.find((t) => t.id === targetId)?.filter?.fields ?? [];
  const counted =
    report && report.predicates.length > 0
      ? report
      : outcome && outcome.targetId === targetId
        ? outcome
        : null;
  const labelFor = (field: string) => fields.find((f) => f.field === field)?.label ?? field;
  const described = (filter?.predicates ?? [])
    .map((p) => describePredicate(p, labelFor(p.field)))
    .join(', ');

  const names = fields.map((f) => f.field);
  const key = `${targetId}|${viewAddressKey(search, names, { page: false })}`;
  const byAgent = agentApplied === key;

  /* Resetting is a navigation: Back returns to the changed view, as it should. */
  const clear = () => {
    const patch = viewStatePatch(names, { predicates: null, sort: null, page: null });
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
    } as never);
  };

  return (
    <div className="pf-viewfilter" role="status" data-testid="view-filter-banner">
      <span className="pf-viewfilter__mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" focusable="false">
          {byAgent ? (
            /* Robot: this view is not showing what it would show on its own. */
            <path
              d="M12 3v3m-5 0h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm2 5v2m6-2v2m-6 5h6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : (
            /* Funnel: narrowed, but not by anything that happened here. */
            <path
              d="M4 5h16l-6 7v6l-4 2v-8L4 5Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </span>
      <span className="pf-viewfilter__text">
        <strong>
          {filter ? 'Widok zawezony' : 'Widok zmieniony'}
          {byAgent ? ' przez agenta.' : '.'}
        </strong>{' '}
        {described}
        {filter && counted && (
          <span className="pf-viewfilter__count" data-testid="view-filter-count">
            {' '}
            — pokazane {counted.matched} z {counted.total}
          </span>
        )}
        {sorted?.sort && (
          <span className="pf-viewfilter__part" data-testid="view-sort-state">
            {' '}
            Sortowanie: {sorted.sortLabel ?? sorted.sort.field},{' '}
            {sorted.sort.direction === 'desc' ? 'malejaco' : 'rosnaco'}.
          </span>
        )}
        {rejected && (
          <span className="pf-viewfilter__part" data-testid="view-sort-rejected">
            {' '}
            Sortowanie po „{rejected.field}” pominiete — {rejected.reason === 'not_sortable' ? 'pole nie jest sortowalne' : 'nie ma takiego pola'}.
          </span>
        )}
        {paged?.page && (
          <span className="pf-viewfilter__part" data-testid="view-page-state">
            {' '}
            Strona {paged.page.index} z {paged.page.count}
            {paged.clampedFrom !== null ? ` (strony ${paged.clampedFrom} nie ma)` : ''}.
          </span>
        )}
      </span>
      <button
        type="button"
        className="pf-btn pf-btn--tiny"
        data-testid="view-filter-clear"
        onClick={clear}
      >
        {filter ? 'Pokaz pelny widok' : 'Przywroc domyslny widok'}
      </button>
    </div>
  );
}
