import { useNavigate } from '@tanstack/react-router';
import { describePredicate } from '@platform/contracts';
import { useAppState } from '../state/appState.ts';
import { useActiveViewFilter } from '../state/viewFilter.ts';

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
 */
export function ViewFilterBanner() {
  const filter = useActiveViewFilter();
  const outcome = useAppState((s) => s.filterOutcome);
  const agentApplied = useAppState((s) => s.agentFilterKey);
  const navigate = useNavigate();

  if (!filter) return null;

  const counted = outcome && outcome.targetId === filter.targetId ? outcome : null;
  const labelFor = (field: string) =>
    filter.fields.find((f) => f.field === field)?.label ?? field;
  const described = filter.predicates
    .map((p) => describePredicate(p, labelFor(p.field)))
    .join(', ');

  const key = `${filter.targetId}|${filter.predicates.map((p) => `${p.field}=${p.value}`).join('&')}`;
  const byAgent = agentApplied === key;

  /* Clearing is a navigation: Back returns to the narrowed view, as it should. */
  const clear = () =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next = { ...prev };
        // `undefined`, not `delete` — the router's retain middleware re-adds a
        // key that is merely absent (see `sessionLocation.ts`).
        for (const p of filter.predicates) next[p.field] = undefined;
        return next;
      },
    } as never);

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
        <strong>{byAgent ? 'Widok zawezony przez agenta.' : 'Widok zawezony.'}</strong> {described}
        {counted && (
          <span className="pf-viewfilter__count" data-testid="view-filter-count">
            {' '}
            — pokazane {counted.matched} z {counted.total}
          </span>
        )}
      </span>
      <button
        type="button"
        className="pf-btn pf-btn--tiny"
        data-testid="view-filter-clear"
        onClick={clear}
      >
        Pokaz pelny widok
      </button>
    </div>
  );
}
