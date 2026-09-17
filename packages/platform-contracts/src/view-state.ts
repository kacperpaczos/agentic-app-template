import { z } from 'zod';
import {
  VIEW_PAGE_SEARCH_KEY,
  VIEW_SORT_SEARCH_KEY,
  dataSortSchema,
  filterFromSearch,
  filterToSearch,
  viewFilterPredicateSchema,
  viewPageSchema,
  type DataSort,
  type ViewFilterPredicate,
} from './ui.ts';
import type { ReadResultDescriptor, RecordField } from './views.ts';

/**
 * The state of a view that lives in the address bar: narrowing, order, page.
 *
 * **Why all three are in the address.** Each decides *which records the user is
 * looking at* — which ones, in which order, which slice of them — and that is
 * exactly what a link, a reload, Back and a bookmark have to preserve. A page
 * number kept in memory would reset on reload and could not be undone with
 * Back, and an order kept in memory would make a pasted link show a different
 * screen than the one its author saw.
 *
 * The encoding is the readable one the narrowing already used, extended by two
 * keys the session reserves (`RESERVED_SEARCH_KEYS`):
 *
 *   `?country=PL`   narrowing (see `predicateToParam`)
 *   `?sort=name`    ascending by `name`; `?sort=-name` descending
 *   `?page=2`       second page, counted from 1; absent means the first
 *
 * Pure functions, shared by the browser (controls, the agent's commands, the
 * banner) and the server (the agent's tools), so a URL means one thing.
 */

/* -------------------------------------------------------------------------- */
/*  Address encoding                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Search parameters as plain strings, the way they appear in the address.
 *
 * The router's default parser reads every value as JSON, so `?page=2` became
 * the number 2 and `?taxId=5213456789` a number too — and the session's search
 * validator, which keeps strings, silently dropped both. Its default serializer
 * in turn wrote a string that looks like JSON in quotes (`page=%222%22`). Every
 * parameter here is a string a person can read and paste, so it is parsed and
 * written as one. The first value of a repeated key wins.
 */
export function parseAddressSearch(searchStr: string): Record<string, string> {
  const params = new URLSearchParams(searchStr.startsWith('?') ? searchStr.slice(1) : searchStr);
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/** Inverse of {@link parseAddressSearch}. `undefined` and `null` are omitted. */
export function stringifyAddressSearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** `name` ascending, `-name` descending. */
export function sortToParam(sort: DataSort): string {
  return sort.direction === 'desc' ? `-${sort.field}` : sort.field;
}

/**
 * The order an address parameter spells, or null when it spells none.
 *
 * Only the syntax is read here. Whether the view can be ordered by the field is
 * the descriptor's answer ({@link checkSortField}), given where the records are.
 */
export function sortFromParam(raw: unknown): DataSort | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const desc = text.startsWith('-');
  const field = desc ? text.slice(1) : text;
  const parsed = dataSortSchema.safeParse({ field, direction: desc ? 'desc' : 'asc' });
  return parsed.success ? parsed.data : null;
}

/** The first page is the absence of the parameter, so a link to it stays clean. */
export function pageToParam(index: number | null | undefined): string | undefined {
  return index && Number.isInteger(index) && index > 1 ? String(index) : undefined;
}

/** A page number from the address: a whole number from 1, or null. */
export function pageFromParam(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,9}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 ? n : null;
}

/* -------------------------------------------------------------------------- */
/*  Order                                                                     */
/* -------------------------------------------------------------------------- */

/** A declared field is sortable unless its descriptor says `sortable: false`. */
export const isSortableField = (field: RecordField): boolean => field.sortable !== false;

/** The fields a view over this read may be ordered by, in declaration order. */
export function sortableFields(descriptor: ReadResultDescriptor): RecordField[] {
  return descriptor.fields.filter(isSortableField);
}

export type SortFieldCheck =
  | { ok: true; field: RecordField }
  | { ok: false; reason: 'unknown_field' | 'not_sortable'; available: RecordField[] };

/**
 * Whether records of this read may be ordered by the named field — and, when
 * not, why, with the fields that may be used instead.
 *
 * Two different answers, because they are two different mistakes: a field the
 * read does not have is a guess (`unknown_field`); a field it has but declares
 * unsortable is a request the module has ruled out (`not_sortable`).
 */
export function checkSortField(descriptor: ReadResultDescriptor, fieldName: string): SortFieldCheck {
  const field = descriptor.fields.find((f) => f.field === fieldName);
  const available = sortableFields(descriptor);
  if (!field) return { ok: false, reason: 'unknown_field', available };
  if (!isSortableField(field)) return { ok: false, reason: 'not_sortable', available };
  return { ok: true, field };
}

/* -------------------------------------------------------------------------- */
/*  Pages                                                                     */
/* -------------------------------------------------------------------------- */

export interface PageSlice {
  /** Page shown, from 1. */
  index: number;
  size: number;
  /** Number of pages; at least 1, so an empty result is "page 1 of 1". */
  count: number;
  /** Half-open range of the records on this page. */
  start: number;
  end: number;
  /** Page the address asked for, when there was one. */
  requested: number | null;
  /** True when the requested page did not exist and the nearest one is shown. */
  clamped: boolean;
}

/**
 * Which records one page holds.
 *
 * A page past the end — a link kept while records were removed, a hand-edited
 * address — is not an empty screen: the last page is shown and the slice says
 * it was clamped, so the view can say so rather than pretend.
 */
export function pageSlice(matched: number, size: number, requested: number | null): PageSlice {
  const count = Math.max(1, Math.ceil(matched / size));
  const wanted = requested ?? 1;
  const index = Math.min(Math.max(wanted, 1), count);
  const start = (index - 1) * size;
  return {
    index,
    size,
    count,
    start,
    end: Math.min(start + size, matched),
    requested,
    clamped: requested !== null && requested !== index,
  };
}

/* -------------------------------------------------------------------------- */
/*  Changing the state                                                        */
/* -------------------------------------------------------------------------- */

export interface ViewStateChange {
  /** `undefined` leaves the narrowing; `null` or `[]` removes it; predicates replace it. */
  predicates?: ViewFilterPredicate[] | null;
  /** `undefined` leaves the order; `null` returns the view to its own order. */
  sort?: DataSort | null;
  /**
   * `undefined` keeps the page — unless the narrowing or the order changes,
   * which returns to the first page; a number sets it; `null` is the first.
   */
  page?: number | null;
}

/**
 * The search parameters that put a view into a new state; `undefined` removes one.
 *
 * The one place the rules of a change live, so the user's controls, the
 * banner's reset and the agent's commands cannot drift apart:
 *
 *  - a new narrowing replaces the old one — declared fields it does not name
 *    are removed, rather than stacking silently on top of it;
 *  - changing the narrowing or the order returns to the first page, because
 *    "page 3" of a different set of records is a page nobody asked for.
 *
 * `undefined`, not a missing key, is how a parameter is removed: the router's
 * retain middleware re-adds a key that is merely absent.
 */
export function viewStatePatch(
  filterFields: readonly string[],
  change: ViewStateChange,
): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = {};
  if (change.predicates !== undefined) {
    for (const field of filterFields) patch[field] = undefined;
    Object.assign(patch, filterToSearch(change.predicates ?? []));
  }
  if (change.sort !== undefined) {
    patch[VIEW_SORT_SEARCH_KEY] = change.sort ? sortToParam(change.sort) : undefined;
  }
  if (change.page !== undefined) {
    patch[VIEW_PAGE_SEARCH_KEY] = pageToParam(change.page);
  } else if (change.predicates !== undefined || change.sort !== undefined) {
    patch[VIEW_PAGE_SEARCH_KEY] = undefined;
  }
  return patch;
}

/** A search object with a patch applied; removed keys are gone, not `undefined`. */
export function applySearchPatch(
  search: Record<string, unknown>,
  patch: Record<string, string | undefined>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...search, ...patch };
  for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
  return next;
}

/**
 * A comparison key for the view state an address carries.
 *
 * Normalised through the same readers the view uses, so two addresses that put
 * the view in the same state have the same key (`page=1` and no page, `PL ` and
 * `PL`). The acknowledgement of an agent's command compares the key of the
 * address it navigated to with the key the view reports having applied — a
 * report of some *earlier* state cannot be mistaken for the new one.
 */
export function viewAddressKey(
  search: Record<string, unknown>,
  filterFields: readonly string[],
  opts: { page?: boolean } = {},
): string {
  const predicates = filterToSearch(filterFromSearch(search, filterFields));
  const sort = sortFromParam(search[VIEW_SORT_SEARCH_KEY]);
  const page = opts.page === false ? null : pageToParam(pageFromParam(search[VIEW_PAGE_SEARCH_KEY])) ?? null;
  return JSON.stringify([Object.entries(predicates), sort ? sortToParam(sort) : null, page]);
}

/* -------------------------------------------------------------------------- */
/*  In the agent's context                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What one view is showing, as `AppContext.filters[targetId]` carries it.
 *
 * Taken from the view that applied it when the command is sent, so the next
 * turn starts from what the user is actually looking at: the narrowing in
 * force, the order, the page, and how many records that leaves of how many.
 */
export const viewStateContextSchema = z.object({
  /** The address bar's narrowing in force. */
  predicates: z.array(viewFilterPredicateSchema).max(20),
  /** The order in force — the address bar's, else the composition's; null for the read's own. */
  sort: dataSortSchema.nullable(),
  /** Null when the view does not page its records. */
  page: viewPageSchema.nullable(),
  /** Records left after the narrowing. */
  matched: z.number().int().nonnegative(),
  /** Records the view would show without the narrowing. */
  total: z.number().int().nonnegative(),
});
export type ViewStateContext = z.infer<typeof viewStateContextSchema>;
