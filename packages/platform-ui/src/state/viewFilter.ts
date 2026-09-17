import { useCallback, useMemo } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import {
  VIEW_PAGE_SEARCH_KEY,
  VIEW_SORT_SEARCH_KEY,
  filterFromSearch,
  pageFromParam,
  sortFromParam,
  viewAddressKey,
  viewStatePatch,
  type DataSort,
  type UiTarget,
  type ViewFilterPredicate,
  type ViewStateChange,
} from '@platform/contracts';
import { useUiTargets } from '../api/queries.ts';
import { useAppState, type ViewStateReport } from './appState.ts';

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

/**
 * The address bar's state of one view — narrowing, order, page — and the way
 * to change it.
 *
 * Present only for the view whose screen is open: the target named by
 * `viewId` must be the one whose route is the current path. A composed view
 * rendered anywhere else (a card, a chat message) has no address of its own
 * and must not pick up another screen's parameters.
 *
 * `sort` and `page` are read as written; whether the view can honour them is
 * decided by the view against its read's descriptor. Every `change` is a
 * navigation — one history entry, undone with Back — built by
 * `viewStatePatch`, which is where "a new narrowing returns to page 1" lives.
 */
export interface ViewAddress {
  targetId: string;
  /** The target's declared narrowing fields; empty when it declares none. */
  filterFields: NonNullable<UiTarget['filter']>['fields'];
  predicates: ViewFilterPredicate[];
  sort: DataSort | null;
  page: number | null;
  /** `viewAddressKey` of this state. */
  key: string;
  change: (change: ViewStateChange) => void;
}

export function useViewAddress(viewId: string | null): ViewAddress | null {
  const targets = useUiTargets();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search as Record<string, unknown> });
  const navigate = useNavigate();

  const target = viewId ? (targets.data?.find((t) => t.id === viewId && t.to === pathname) ?? null) : null;
  const fields = target?.filter?.fields;

  const change = useCallback(
    (next: ViewStateChange) => {
      const patch = viewStatePatch((fields ?? []).map((f) => f.field), next);
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }),
      } as never);
    },
    [fields, navigate],
  );

  return useMemo(() => {
    if (!target) return null;
    const names = (fields ?? []).map((f) => f.field);
    return {
      targetId: target.id,
      filterFields: fields ?? [],
      predicates: filterFromSearch(search, names),
      sort: sortFromParam(search[VIEW_SORT_SEARCH_KEY]),
      page: pageFromParam(search[VIEW_PAGE_SEARCH_KEY]),
      key: viewAddressKey(search, names),
      change,
    };
  }, [target, fields, search, change]);
}

/** The reported state of the view whose screen is open, if one reported. */
export function useActiveViewReport(): ViewStateReport | null {
  const targets = useUiTargets();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const reports = useAppState((s) => s.viewStates);
  return useMemo(
    () =>
      Object.values(reports).find(
        (r) => targets.data?.find((t) => t.id === r.targetId)?.to === pathname,
      ) ?? null,
    [reports, targets.data, pathname],
  );
}
