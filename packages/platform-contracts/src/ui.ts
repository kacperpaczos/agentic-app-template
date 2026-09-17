import { z } from 'zod';

/**
 * Semantic targets the agent may move the interface to.
 *
 * **Why a catalog and not free-form navigation.** Without one, an agent asked
 * to "switch to files" has nothing to act on, so it does the only thing it
 * can — describe a route in prose, and guess. Observed exactly that: asked for
 * the files screen, the agent called two unrelated read tools and then told the
 * user they had to create a purchase case first to see a tab that is in the
 * navigation unconditionally. A stated route the user must follow by hand is
 * not navigation, and a confident wrong answer is worse than a refusal.
 *
 * So targets are declared, named and enumerable. The agent asks what exists,
 * names one, and the client either performs it or reports why it could not.
 * A target that is not in the catalog cannot be navigated to, which is what
 * makes "no such target" a real answer instead of an improvised one.
 */

export const UI_TARGET_KINDS = ['view', 'section', 'setting', 'element'] as const;
export type UiTargetKind = (typeof UI_TARGET_KINDS)[number];

export const uiTargetSchema = z.object({
  /** Stable identifier, e.g. `platform.files`. Namespaced by its contributor. */
  id: z.string().min(3).max(120),
  kind: z.enum(UI_TARGET_KINDS),
  /** What a user would call it. */
  label: z.string().max(120),
  /** What the user sees when it opens — for the agent to pick correctly. */
  description: z.string().max(300),
  /** Route to open, for a target that lives on its own screen. */
  to: z.string().max(200).optional(),
  /**
   * Element to scroll to and highlight once the screen is open.
   *
   * A CSS selector chosen by the contributor, because only the contributor
   * knows its own markup. Resolved in the browser, and its absence is reported
   * as a failure rather than assumed.
   */
  selector: z.string().max(300).optional(),
  /**
   * What the agent may narrow in this view, declared by whoever owns it.
   *
   * Only a contributor knows which of its records are on screen and which of
   * their properties mean anything, so the platform holds this list without
   * reading it: `collection` is the key of an array in the view's own response,
   * and each entry of `fields` is a property name on its rows. Both travel as
   * opaque strings.
   *
   * A view without this cannot be narrowed at all, and a property that is not
   * listed is refused by name. That is deliberate: an agent that could filter
   * by an invented property would quietly show an empty screen and call it an
   * answer.
   */
  filter: z
    .object({
      collection: z.string().max(80),
      fields: z
        .array(
          z.object({
            field: z.string().max(80),
            label: z.string().max(120),
            /** Values worth suggesting, when the set is small and known. */
            values: z.array(z.string().max(120)).max(40).optional(),
          }),
        )
        .min(1)
        .max(20),
    })
    .optional(),
});
export type UiTarget = z.infer<typeof uiTargetSchema>;

/**
 * Narrowing a view: which rows stay on screen.
 *
 * **Why this is a view state and not an answer in the chat.** Asked to show
 * only part of a list, the agent used to retype the matching rows into the
 * conversation. The screen still showed everything, the user had two versions
 * of the same data in front of them, and the one in the chat was a copy that
 * would not update, could not be sorted and was as correct as the retyping.
 * Narrowing belongs to the thing being narrowed.
 *
 * The operators are few on purpose. Each one has an obvious meaning to somebody
 * reading the sentence in the banner, and none of them can express something
 * the user cannot undo with one button.
 */
export const VIEW_FILTER_OPS = ['eq', 'neq', 'contains', 'in'] as const;
export type ViewFilterOp = (typeof VIEW_FILTER_OPS)[number];

export const viewFilterPredicateSchema = z.object({
  field: z.string().min(1).max(80),
  op: z.enum(VIEW_FILTER_OPS),
  value: z.union([
    z.string().max(200),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string().max(200), z.number()])).max(40),
  ]),
});
export type ViewFilterPredicate = z.infer<typeof viewFilterPredicateSchema>;

export const viewFilterSchema = z.object({
  /** The view being narrowed. Its `filter` declaration is the authority. */
  targetId: z.string().min(3).max(120),
  predicates: z.array(viewFilterPredicateSchema).min(1).max(8),
  /**
   * The narrowing in the agent's own words — "tylko z Polski".
   *
   * Required, because an agent that narrows a screen has to be able to say what
   * it did. It is *not* what the banner prints: that sentence is generated from
   * the predicates actually in the address bar, so the screen cannot be
   * described by a sentence that does not match it — and so a narrowed link
   * still explains itself to somebody who never saw the conversation.
   */
  label: z.string().min(1).max(140),
});
export type ViewFilter = z.infer<typeof viewFilterSchema>;

/**
 * Does one row survive the narrowing?
 *
 * Lives in the contract because the contract names the operators, so it also
 * owes an answer to what they mean. Comparison is by string except for `in`,
 * which is membership: it is the only way a number in the data and a number in
 * the agent's argument compare equal without the platform guessing types.
 */
export function rowMatchesPredicate(row: unknown, predicate: ViewFilterPredicate): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const actual = (row as Record<string, unknown>)[predicate.field];
  if (actual === undefined || actual === null) return false;
  const text = String(actual).toLowerCase();

  switch (predicate.op) {
    case 'eq':
      return text === String(predicate.value).toLowerCase();
    case 'neq':
      return text !== String(predicate.value).toLowerCase();
    case 'contains':
      return text.includes(String(predicate.value).toLowerCase());
    case 'in':
      return (Array.isArray(predicate.value) ? predicate.value : [predicate.value]).some(
        (v) => String(v).toLowerCase() === text,
      );
  }
}

/** Every predicate must hold — narrowing is conjunctive, as a user expects. */
export function rowMatchesFilter(row: unknown, predicates: ViewFilterPredicate[]): boolean {
  return predicates.every((p) => rowMatchesPredicate(row, p));
}

/** What a narrowing did to one view, as the view counted it. */
export interface ViewFilterOutcome {
  targetId: string;
  matched: number;
  total: number;
}

/**
 * Narrows a view's rows and counts the result.
 *
 * The one implementation behind every narrowed screen — a module screen
 * reading its own route and a composed view's primary table alike — so "3 of
 * 4" means the same thing whichever of them the user is looking at.
 */
export function applyViewFilter<T>(
  rows: readonly T[],
  filter: { targetId: string; predicates: ViewFilterPredicate[] },
): { kept: T[]; outcome: ViewFilterOutcome } {
  const kept = rows.filter((row) => rowMatchesFilter(row, filter.predicates));
  return { kept, outcome: { targetId: filter.targetId, matched: kept.length, total: rows.length } };
}

/* -------------------------------------------------------------------------- */
/*  Narrowing in the address bar                                              */
/* -------------------------------------------------------------------------- */

/**
 * Search-parameter keys the session owns; a filterable field may not use them.
 *
 * `c` is the conversation and `s` the workspace. They are retained across every
 * navigation, so a field of the same name would be carried onto screens it means
 * nothing on — and would fight the session for the same key.
 */
export const RESERVED_SEARCH_KEYS = ['c', 's'] as const;

/**
 * A narrowing lives in the URL, one parameter per field: `?country=PL&name=~av`.
 *
 * **Why the URL and not client state.** A filter decides *which set of records
 * the user is looking at*, and that is the thing a link, a reload, Back and a
 * bookmark all have to preserve. The first version of this feature kept it in
 * memory, with the reasoning that a narrowing is something done *to* the screen
 * rather than a place navigated to — which confused the provenance of the change
 * with the nature of the state. Transient interface state (an open menu, a
 * hovered row) belongs in memory; durable preferences ("always show 50")
 * belong to the account; *which data is on screen* belongs in the address.
 *
 * The encoding stays readable, because these end up in links people paste:
 *
 *   `country=PL`      equals
 *   `country=!FI`     does not equal
 *   `name=~av`        contains
 *   `country=PL,CZ`   any of
 *
 * **A link cannot widen access.** These parameters only ever *remove* rows from
 * a response the server already scoped to its owner. Nothing here reaches the
 * database, so a narrowed link handed to somebody else shows them their own
 * data narrowed the same way — never a row they could not otherwise see.
 */
export function predicateToParam(predicate: ViewFilterPredicate): string {
  const { op, value } = predicate;
  if (op === 'in') {
    return (Array.isArray(value) ? value : [value]).map(String).join(',');
  }
  if (op === 'neq') return `!${String(value)}`;
  if (op === 'contains') return `~${String(value)}`;
  return String(value);
}

/** Inverse of {@link predicateToParam}. An empty parameter is not a filter. */
export function paramToPredicate(field: string, raw: string): ViewFilterPredicate | null {
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('!')) {
    return text.length > 1 ? { field, op: 'neq', value: text.slice(1) } : null;
  }
  if (text.startsWith('~')) {
    return text.length > 1 ? { field, op: 'contains', value: text.slice(1) } : null;
  }
  if (text.includes(',')) {
    const values = text.split(',').map((v) => v.trim()).filter(Boolean);
    return values.length ? { field, op: 'in', value: values } : null;
  }
  return { field, op: 'eq', value: text };
}

/** The search parameters a narrowing becomes. */
export function filterToSearch(predicates: ViewFilterPredicate[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of predicates) out[p.field] = predicateToParam(p);
  return out;
}

/**
 * The narrowing a URL carries, for one view.
 *
 * Only fields the view declares are read. Anything else in the address is
 * somebody else's parameter — or a typo — and is left alone rather than turned
 * into a filter on a property that does not exist.
 */
export function filterFromSearch(
  search: Record<string, unknown>,
  declaredFields: readonly string[],
): ViewFilterPredicate[] {
  const out: ViewFilterPredicate[] = [];
  for (const field of declaredFields) {
    const raw = search[field];
    if (typeof raw !== 'string') continue;
    const predicate = paramToPredicate(field, raw);
    if (predicate) out.push(predicate);
  }
  return out;
}

/** How a narrowing reads to a user, built from what is actually applied. */
export function describePredicate(
  predicate: ViewFilterPredicate,
  fieldLabel: string,
): string {
  const { op, value } = predicate;
  const shown = Array.isArray(value) ? value.join(' albo ') : String(value);
  if (op === 'neq') return `${fieldLabel} inne niz ${shown}`;
  if (op === 'contains') return `${fieldLabel} zawiera „${shown}”`;
  return `${fieldLabel}: ${shown}`;
}

/**
 * What the client is asked to do.
 *
 * `reveal` is deliberately the only verb for a setting. Showing a control and
 * changing it are different acts with different consequences, and an agent that
 * can do the first must not be able to do the second by accident — so there is
 * no "set" here at all.
 */
export const uiCommandSchema = z.object({
  /** Idempotency key. A replayed event with a seen id must not act twice. */
  commandId: z.string().min(8).max(80),
  runId: z.string(),
  conversationId: z.string(),
  targetId: z.string(),
  /** Canvas space to switch to, when the target is a workspace. */
  spaceId: z.string().nullable().optional(),
  /**
   * Narrowing to apply to the target view.
   *
   * `null` is not "absent": it means *clear the narrowing*, which is how the
   * agent puts a view back the way it found it. Leaving it out changes nothing.
   */
  filter: viewFilterSchema.nullable().optional(),
  /** Why the agent is doing it, shown to the user. */
  reason: z.string().max(200).optional(),
});
export type UiCommand = z.infer<typeof uiCommandSchema>;

/** Why a UI command did not happen. Each one is a distinct, honest answer. */
export const UI_COMMAND_FAILURES = {
  /** No such target in the catalog reachable by this client. */
  unknownTarget: 'unknown_target',
  /** The target exists but its element is not in the document. */
  notPresent: 'not_present',
  /** The owner may not see it. */
  forbidden: 'forbidden',
  /**
   * The command came from a conversation the user is not looking at.
   *
   * Reported rather than performed: a task running in the background must not
   * yank the screen away from whatever its owner is doing now.
   */
  inactiveConversation: 'inactive_conversation',
  /** No client acknowledged in time — nothing is known to have happened. */
  noClient: 'no_client',
  /** The view exists but declares nothing that may be narrowed. */
  notFilterable: 'not_filterable',
  /** A property the view does not declare. Refused by name, never guessed. */
  unknownField: 'unknown_field',
  /**
   * The narrowing was accepted but no view reported applying it.
   *
   * Distinct from a successful narrowing that matched nothing: "the screen now
   * shows none of the rows" is an answer, "nothing on screen used the
   * narrowing" is a defect, and telling them apart is the point.
   */
  notApplied: 'not_applied',
} as const;
export type UiCommandFailure = (typeof UI_COMMAND_FAILURES)[keyof typeof UI_COMMAND_FAILURES];

export const uiCommandResultSchema = z.object({
  commandId: z.string(),
  /** True only when the client actually moved. Never inferred from sending. */
  executed: z.boolean(),
  reason: z.string().optional(),
  /** Where the client ended up, as the client saw it. */
  url: z.string().optional(),
  targetId: z.string().optional(),
  /** True when the element was found, scrolled to and highlighted. */
  highlighted: z.boolean().optional(),
  /**
   * What the narrowing did, as counted by the view that applied it.
   *
   * Reported rather than predicted. The server could compute the same numbers,
   * but then "executed" would mean "we think so" — and the whole point of the
   * acknowledgement is that it means "the user is looking at it".
   */
  filtered: z.object({ matched: z.number(), total: z.number() }).optional(),
  /**
   * Version of the tab's interface description published after the command
   * was carried out (see `uiSnapshotSchema`). The tab publishes before it
   * acknowledges, so a reader asking for this version or newer is not asking
   * for something still on its way. Absent when nothing could be published.
   */
  uiVersion: z.number().int().min(1).optional(),
});
export type UiCommandResult = z.infer<typeof uiCommandResultSchema>;
