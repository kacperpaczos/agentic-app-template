import {
  UI_COMMAND_FAILURES,
  applySearchPatch,
  parseAddressSearch,
  viewAddressKey,
  viewStatePatch,
  type UiCommand,
  type UiCommandFailure,
  type UiTarget,
  type ViewDefinition,
} from '@platform/contracts';

/**
 * What `UiCommandRunner` decides before it touches the screen.
 *
 * Pure — no React, no router, no fetching — so the rules that make an answer
 * honest can be tested on their own: which commands are refused and why, where
 * a command leads, and whether its result must be confirmed by a view.
 */

/**
 * A list loaded on first use and kept — but only once it has loaded.
 *
 * A failed request is not remembered. Remembering it as an empty list made one
 * network blip permanent for the page: every order was then refused as
 * `not_sortable` and every clearing reported success without looking at the
 * screen. Returns null when the load failed, so the caller can say so.
 */
export function cachedLoader<T>(load: () => Promise<T>): () => Promise<T | null> {
  let loaded: { value: T } | null = null;
  return async () => {
    if (loaded) return loaded.value;
    try {
      loaded = { value: await load() };
      return loaded.value;
    } catch {
      return null;
    }
  };
}

export type ViewCommandPlan =
  | { kind: 'refuse'; reason: UiCommandFailure }
  | {
      kind: 'apply';
      /** The command sets or clears a narrowing or an order. */
      changesView: boolean;
      filterFields: string[];
      /** The target's view has a primary instance that reports its state. */
      reportingView: boolean;
      /** The command's target is the screen already open. */
      samePath: boolean;
      /** Search parameters to apply; `undefined` removes one. */
      patch: Record<string, string | undefined>;
      /** The address the command leads to, and its view-state key. */
      expected: Record<string, unknown>;
      expectedKey: string;
      /** The address already carries this state: nothing on screen will change. */
      unchanged: boolean;
      /** The outcome must be confirmed by a view before answering. */
      awaitsView: boolean;
    };

/**
 * Checks a command against the target and the views, and works out where it
 * leads.
 *
 * `views` is null when the view definitions could not be loaded. A command
 * that changes a view's state then cannot be judged — whether the view can be
 * ordered, whether a report is to be waited for — so it is refused as
 * `views_unavailable` rather than guessed either way. A plain navigation does
 * not need them.
 */
export function planViewCommand(input: {
  command: Pick<UiCommand, 'filter' | 'sort'>;
  target: UiTarget;
  views: ViewDefinition[] | null;
  location: { pathname: string; search: string };
}): ViewCommandPlan {
  const { target, location } = input;
  const narrowing = input.command.filter;
  const ordering = input.command.sort;
  const changesView = narrowing !== undefined || ordering !== undefined;
  const filterFields = (target.filter?.fields ?? []).map((f) => f.field);

  if (narrowing) {
    if (!target.filter || !target.to) {
      // A narrowing belongs to a screen, and this target declares none — or
      // has no screen of its own to narrow.
      return { kind: 'refuse', reason: UI_COMMAND_FAILURES.notFilterable };
    }
    const declared = new Set(filterFields);
    if (narrowing.predicates.some((p) => !declared.has(p.field))) {
      return { kind: 'refuse', reason: UI_COMMAND_FAILURES.unknownField };
    }
  }

  if (changesView && input.views === null) {
    return { kind: 'refuse', reason: UI_COMMAND_FAILURES.viewsUnavailable };
  }
  const reportingView = Boolean(input.views?.find((v) => v.id === target.id)?.primaryOperation);

  /*
   * Only a view with a primary instance knows the fields it can be ordered by
   * — and only such a view has an order to clear. Clearing "the order" of a
   * target that has none is not a success: answering it would also move the
   * user to that target's screen for nothing.
   */
  if (ordering !== undefined && (!target.to || !reportingView)) {
    return { kind: 'refuse', reason: UI_COMMAND_FAILURES.notSortable };
  }

  /*
   * Parameters belong to the screen they were set on: staying on it keeps
   * them, arriving from another screen starts clean (the session's `c` and `s`
   * are retained by the router), so one view's order or page is never carried
   * onto another.
   */
  const samePath = target.to !== undefined && location.pathname === target.to;
  const current = parseAddressSearch(location.search);
  const patch = changesView
    ? viewStatePatch(filterFields, {
        ...(narrowing !== undefined ? { predicates: narrowing?.predicates ?? null } : {}),
        ...(ordering !== undefined ? { sort: ordering } : {}),
      })
    : {};
  const expected = applySearchPatch(samePath ? current : {}, patch);
  const expectedKey = viewAddressKey(expected, filterFields);

  return {
    kind: 'apply',
    changesView,
    filterFields,
    reportingView,
    samePath,
    patch,
    expected,
    expectedKey,
    unchanged: samePath && viewAddressKey(current, filterFields) === expectedKey,
    // Setting a narrowing always expects a view to apply it; clearing, or any
    // order, is only observable on a view that reports its state.
    awaitsView: Boolean(
      target.to && (narrowing || (reportingView && (narrowing === null || ordering !== undefined))),
    ),
  };
}
