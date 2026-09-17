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

/**
 * The platform's own screen showing a conversation's agent views.
 *
 * Named in the contract because both halves need it without knowing each
 * other: the server declares the target and points a command at it, the
 * browser resolves it to a route when it has to open it.
 */
export const AGENT_VIEWS_TARGET_ID = 'platform.agentViews';

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

/**
 * Ordering a view: one declared field, one direction.
 *
 * Beside the narrowing because it is the same kind of thing — a state of the
 * presentation, never of the data — and because a composition's own order
 * (`DataTable(..., sort)`), the address bar and the agent's `ui_sort` all speak
 * this one contract.
 */
export const dataSortSchema = z.object({
  field: z
    .string()
    .min(1)
    .max(80)
    .describe('Nazwa pola rekordu zadeklarowanego w deskryptorze operacji odczytu'),
  direction: z.enum(['asc', 'desc']).describe('asc rosnaco, desc malejaco'),
});
export type DataSort = z.infer<typeof dataSortSchema>;

/**
 * Which registered read a data component (or a live artifact) re-runs.
 *
 * Never code, never SQL, never values: a qualified operation name and the input
 * the operation's own schema validates. `input` is a loose object rather than
 * `z.record()` so that the schema can be offered to the model over MCP.
 *
 * Here rather than in `views.ts` so that an interface command can name the read
 * of the instance it points at (`uiRevealSchema`) without an import cycle.
 */
export const dataSourceSchema = z.object({
  /** Qualified operation name, `<moduleId>.<operation>`. */
  operation: z
    .string()
    .min(1)
    .max(200)
    .describe('Kwalifikowana nazwa zarejestrowanej operacji odczytu, np. "modul.operacja"'),
  /** Input for the operation; validated against the operation's own schema. */
  input: z.looseObject({}).optional().describe('Wejscie operacji zgodne z jej schematem'),
});
export type DataSource = z.infer<typeof dataSourceSchema>;

/** Which page of a view is on screen. `index` counts from 1; `count` is the number of pages. */
export const viewPageSchema = z.object({
  index: z.number().int().min(1),
  size: z.number().int().min(1),
  count: z.number().int().min(0),
});
export type ViewPage = z.infer<typeof viewPageSchema>;

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

/** Address-bar key of a view's order: `sort=name` ascending, `sort=-name` descending. */
export const VIEW_SORT_SEARCH_KEY = 'sort';
/** Address-bar key of a view's page, counted from 1: `page=2`. */
export const VIEW_PAGE_SEARCH_KEY = 'page';

/**
 * Search-parameter keys a filterable field may not use.
 *
 * `c` is the conversation and `s` the workspace. They are retained across every
 * navigation, so a field of the same name would be carried onto screens it means
 * nothing on — and would fight the session for the same key. `sort` and `page`
 * are the view's own order and page: a field of that name would be read as both
 * a narrowing and an order, and neither reading would be right.
 */
export const RESERVED_SEARCH_KEYS = ['c', 's', VIEW_SORT_SEARCH_KEY, VIEW_PAGE_SEARCH_KEY] as const;

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

/* -------------------------------------------------------------------------- */
/*  Showing one value: a field of a record                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where the value of a record's field is to be shown.
 *
 * **Why the server names the place and the instance.** "Show me this value"
 * has a right answer only if the application can say where that record and
 * field are drawn. The server works that out from what is declared — module
 * views and the conversation's agent views, their compositions, the reads'
 * descriptors (`ui_show_value`) — and tells the client exactly which data
 * component to reveal it in, by its view (or agent view card) and its read.
 * The client then only has to find that instance, never guess one.
 *
 *  - `view` — a module view: its own screen (`UiTarget.to`, navigated to), or a
 *    record screen with route parameters that the tab is showing right now
 *    (not navigated to: its parameters are not the server's to guess);
 *  - `agent_view` — a card of the run's conversation's agent views
 *    (`platform.agentViews`).
 */
export const uiRevealPresentationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('view'), viewId: z.string().min(3).max(120) }),
  z.object({ kind: z.literal('agent_view'), cardId: z.string().min(1).max(128) }),
]);
export type UiRevealPresentation = z.infer<typeof uiRevealPresentationSchema>;

export const uiRevealSchema = z.object({
  /** The record, as its read's descriptor names it (`record.kind`, the `idField` value as a string). */
  recordKind: z.string().min(1).max(80),
  recordId: z.string().min(1).max(128),
  /** A declared field of the record, rendered by the instance. */
  field: z.string().min(1).max(80),
  presentation: uiRevealPresentationSchema,
  /** The read of the data component that renders it, input resolved. */
  source: dataSourceSchema,
});
export type UiReveal = z.infer<typeof uiRevealSchema>;

/**
 * A change of presentation made to bring the value on screen. Never a change of
 * data: which records are shown and where, reported so the user and the agent
 * can see what moved.
 *
 *  - `filter_cleared` — the address bar's narrowing hid the record; the
 *    predicates on the fields that excluded it were removed (others stay);
 *  - `page_changed` — the record was on another page;
 *  - `card_focused` — the canvas was moved to bring the agent view card in view.
 */
export const UI_REVEAL_ADJUSTMENT_KINDS = ['filter_cleared', 'page_changed', 'card_focused'] as const;
export type UiRevealAdjustmentKind = (typeof UI_REVEAL_ADJUSTMENT_KINDS)[number];

export const uiRevealAdjustmentSchema = z.object({
  kind: z.enum(UI_REVEAL_ADJUSTMENT_KINDS),
  /** What changed, in words shown to the user (e.g. „Kraj: PL”, „strona 1 → 2”). */
  detail: z.string().max(300),
  /** `filter_cleared`: the predicates removed. */
  predicates: z.array(viewFilterPredicateSchema).max(8).optional(),
  /** `page_changed`: the page before and after. */
  from: z.number().int().min(1).optional(),
  to: z.number().int().min(1).optional(),
});
export type UiRevealAdjustment = z.infer<typeof uiRevealAdjustmentSchema>;

/** A stored field value as it travels: records hold primitives. */
export const recordValueSchema = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);

/**
 * What the client revealed, as it found it on screen — the client's own
 * statement, compared with the backend by the server, never taken on trust.
 *
 * The changes of presentation it made are **not** here: they are on the result
 * itself (`uiCommandResultSchema.adjustments`), because a change can outlive a
 * refusal — the narrowing is already gone when the cell turns out not to be
 * there — and a change nobody reports is a change the user cannot undo.
 */
export const uiRevealedSchema = z.object({
  recordKind: z.string().max(80),
  recordId: z.string().max(128),
  field: z.string().max(80),
  /** The text of the highlighted cell. */
  displayedText: z.string().max(2000),
  /** The field's value on the row the cell was drawn from; null when the record has none. */
  rawValue: recordValueSchema,
  /** The page the record is on after the reveal; null when the table does not page. */
  page: viewPageSchema.nullable(),
});
export type UiRevealed = z.infer<typeof uiRevealedSchema>;

/**
 * Why `ui_show_value` did not show a value, decided on the server before
 * anything is asked of the browser. Each is a different answer:
 *
 *  - `unknown_field` — no read declares this field for records of this kind;
 *  - `no_renderer` — nothing the user can be taken to renders records of this
 *    kind, or none of those places shows this field (`detail` says which);
 *  - `ambiguous` — the record is shown in more than one place; the candidates
 *    are listed and one must be named (`targetId`);
 *  - `record_not_found` — none of the places that render the kind has this
 *    record, as read for the signed-in owner;
 *  - `forbidden` — the reads behind those places are refused for this owner;
 *  - `unreadable` — those reads failed for another reason, so nothing is known
 *    about the record. Distinct from `record_not_found` on purpose: "it is not
 *    there" and "I could not look" are different claims, and only the first one
 *    may be repeated to the user as a fact;
 *  - `unknown_target` — the `targetId` given names no view, card or catalog
 *    target this run could use.
 *
 * The client adds its own (`UI_COMMAND_FAILURES`): `inactive_conversation`,
 * `not_present`, `not_visible`, `no_client`.
 */
export const SHOW_VALUE_REFUSALS = {
  unknownField: 'unknown_field',
  noRenderer: 'no_renderer',
  ambiguous: 'ambiguous',
  recordNotFound: 'record_not_found',
  forbidden: 'forbidden',
  unreadable: 'unreadable',
  unknownTarget: 'unknown_target',
} as const;
export type ShowValueRefusal = (typeof SHOW_VALUE_REFUSALS)[keyof typeof SHOW_VALUE_REFUSALS];

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
  /**
   * Order to put the target view in. As with `filter`, `null` means *put the
   * view back in its own order* and leaving it out changes nothing.
   */
  sort: dataSortSchema.nullable().optional(),
  /** Why the agent is doing it, shown to the user. */
  reason: z.string().max(200).optional(),
  /**
   * A field of a record to bring on screen and point at, in the data component
   * the server chose (`ui_show_value`). The client may change the presentation
   * to get there — clear the narrowing that hides the record, turn the page —
   * and reports each change; it never changes data.
   */
  reveal: uiRevealSchema.optional(),
});
export type UiCommand = z.infer<typeof uiCommandSchema>;

/** Why a UI command did not happen. Each one is a distinct, honest answer. */
export const UI_COMMAND_FAILURES = {
  /** No such target in the catalog reachable by this client. */
  unknownTarget: 'unknown_target',
  /** The target exists but its element is not in the document. */
  notPresent: 'not_present',
  /**
   * The element is in the document but could not be brought into view, so
   * nothing was pointed at that the user can see.
   */
  notVisible: 'not_visible',
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
   * The view cannot be ordered by this: the field is declared but marked
   * `sortable: false`, or the target has no view whose records could be ordered.
   */
  notSortable: 'not_sortable',
  /**
   * The client could not load the view definitions it needs to tell whether
   * the target's view can apply the change and report it. Nothing was done;
   * asking again may succeed. Never reported as a refusal of the field or as a
   * success nobody checked.
   */
  viewsUnavailable: 'views_unavailable',
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

/** A browser tab's identity (see `uiSnapshotSchema`): random, URL-safe, kept for the life of the tab. */
export const uiClientIdSchema = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * The one time budget of a UI command, shared by both ends.
 *
 * The server stops waiting for the acknowledgement after
 * `UI_COMMAND_ACK_TIMEOUT_MS` and reports `no_client`. Everything the tab does
 * before acknowledging — performing the command, waiting for the view to
 * settle, publishing its description — has to fit in that budget minus
 * `UI_COMMAND_ACK_MARGIN_MS`, left for delivering the command and posting the
 * acknowledgement. A command the tab performed must never be reported as one
 * nobody answered because the tab spent the budget describing it.
 */
export const UI_COMMAND_ACK_TIMEOUT_MS = 8000;
export const UI_COMMAND_ACK_MARGIN_MS = 1000;

/**
 * Whether the acknowledgement names the screen's description version:
 * `published` — yes (`uiVersion`, `uiClientId`); `timeout` — the budget ran out
 * first; `rejected` — the backend refused the description (a backend answer,
 * and only that); `unreachable` — the description did not get an answer from
 * the backend; `not_described` — the tab had no description to send (none
 * captured under the identity signed in now); `skipped` — not described on
 * purpose (the command came from a conversation the tab is not showing).
 */
export const UI_PUBLICATION_STATUSES = [
  'published',
  'timeout',
  'rejected',
  'unreachable',
  'not_described',
  'skipped',
] as const;
export type UiPublicationStatus = (typeof UI_PUBLICATION_STATUSES)[number];

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
   * The order the view reports being in after the command — `null` for the
   * read's own order. Reported by the view, for the same reason as `filtered`.
   */
  sorted: dataSortSchema.nullable().optional(),
  /** The page on screen after the command, when the view pages its records. */
  page: viewPageSchema.optional(),
  /**
   * Version of the tab's interface description published after the command
   * was carried out (see `uiSnapshotSchema`). The tab publishes before it
   * acknowledges, so a reader asking for this version or newer is not asking
   * for something still on its way. Absent when nothing could be published.
   */
  uiVersion: z.number().int().min(1).optional(),
  /**
   * The tab that published `uiVersion`. Versions count per tab, so a version
   * means something only together with the tab it belongs to.
   */
  uiClientId: uiClientIdSchema.optional(),
  /** Why `uiVersion` is absent, or that it is present. */
  uiPublication: z.enum(UI_PUBLICATION_STATUSES).optional(),
  /**
   * For a `reveal`: the record and field the client pointed at, with the text
   * and the value on screen. Present only when a cell was found; `highlighted`
   * says whether it was brought into view.
   */
  revealed: uiRevealedSchema.optional(),
  /**
   * Changes of presentation the client made carrying the command out —
   * reported **whatever the outcome**. A cleared narrowing or a turned page
   * outlives a refusal: the user is looking at it, so the agent is told about
   * it even when nothing was pointed at.
   */
  adjustments: z.array(uiRevealAdjustmentSchema).max(8).optional(),
});
export type UiCommandResult = z.infer<typeof uiCommandResultSchema>;
