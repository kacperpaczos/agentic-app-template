import { useMemo } from 'react';
import { useRouterState } from '@tanstack/react-router';
import {
  filterFromSearch,
  type UiTarget,
  type ViewFilterPredicate,
} from '@platform/contracts';
import { useUiTargets } from '../api/queries.ts';

/**
 * The narrowing the address bar is carrying, for the screen on screen.
 *
 * **Why this is derived and not stored.** A filter decides which set of records
 * the user is looking at, so it is the URL's job: a link carries it, a reload
 * keeps it, Back undoes it and a bookmark remembers it. Keeping it in the client
 * store — as the first version of this feature did — meant a narrowed view could
 * not be shared, did not survive a refresh, and was invisible to Back.
 *
 * What is *not* here, on purpose: transient interface state (an open menu, a
 * hovered row) stays in memory, and durable preferences ("always show 50 rows")
 * would belong to the account. This is only "which data is on screen".
 *
 * **A link cannot widen access.** Nothing in here reaches the server. The
 * predicates remove rows from a response the backend already scoped to its
 * owner, so a narrowed link opened by somebody else narrows *their* data the
 * same way and can never reveal a row they could not otherwise see.
 */
export interface ActiveViewFilter {
  targetId: string;
  /** Key of the array in the view's response the predicates run against. */
  collection: string;
  predicates: ViewFilterPredicate[];
  /** The view's own field declarations, for rendering what is applied. */
  fields: NonNullable<UiTarget['filter']>['fields'];
}

/** The target whose screen is currently open, if it declares a narrowing. */
function targetForRoute(targets: UiTarget[] | undefined, pathname: string): UiTarget | null {
  return targets?.find((t) => t.to === pathname && t.filter) ?? null;
}

export function useActiveViewFilter(): ActiveViewFilter | null {
  const targets = useUiTargets();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });

  return useMemo(() => {
    const target = targetForRoute(targets.data, pathname);
    if (!target?.filter) return null;
    const predicates = filterFromSearch(search, target.filter.fields.map((f) => f.field));
    if (predicates.length === 0) return null;
    return {
      targetId: target.id,
      collection: target.filter.collection,
      predicates,
      fields: target.filter.fields,
    };
  }, [targets.data, pathname, search]);
}
