import { z } from 'zod';
import { UI_TARGET_KINDS, uiClientIdSchema } from './ui.ts';
import { semanticInstanceSchema } from './views.ts';

/**
 * A versioned description of what one browser tab is showing.
 *
 * **Why a snapshot published by the client.** The agent acts on the interface
 * through commands (`ui_navigate`, `ui_filter`) and is told whether each was
 * performed — but "performed" says nothing about what is on the screen
 * afterwards: which view, which records, under which narrowing and order, and
 * whether the table is still loading. Only the browser knows that, and only
 * while the components are mounted. So each tab assembles this description from
 * what its mounted data components say about themselves (`uiSemantics`) and from
 * the shell's own state, and publishes it to the backend, where the agent reads
 * the latest one for its conversation (`ui_state`).
 *
 * **Why versioned.** A description is only useful if the reader can tell whether
 * it is older than the change it cares about. `version` grows by one each time
 * the description changes in a way that matters, within one tab (`clientId`);
 * the acknowledgement of a UI command carries the version published after the
 * command, and the context of a command carries the version at the moment it was
 * sent. A reader holding either can ask for "this version or newer" and be told
 * plainly when it is not there.
 *
 * Everything here is domain-neutral: views, targets, fields and records are the
 * opaque names the modules declared.
 */

/** Most data component descriptions one snapshot carries; the rest are counted. */
export const UI_SNAPSHOT_INSTANCES_LIMIT = 30;
/** Most cards of the active space one snapshot lists; the rest are counted. */
export const UI_SNAPSHOT_CARDS_LIMIT = 50;
/**
 * Largest serialised snapshot the backend accepts, in bytes. The client drops
 * descriptions from the end (and counts them) rather than publishing more.
 */
export const UI_SNAPSHOT_MAX_BYTES = 256_000;

/**
 * Longest address a description (and `AppContext.ui`) carries. A narrowed view
 * can have a far longer one — eight predicates of forty long values — so the
 * address is shortened to this and says so ({@link clampUiUrl}), rather than
 * making the description, or the command sent from that screen, invalid.
 */
export const UI_URL_MAX_LENGTH = 2000;

/** The address as a description carries it: at most the limit, and whether it was cut. */
export function clampUiUrl(url: string): { url: string; urlTruncated: boolean } {
  return url.length > UI_URL_MAX_LENGTH
    ? { url: url.slice(0, UI_URL_MAX_LENGTH), urlTruncated: true }
    : { url, urlTruncated: false };
}

/**
 * How often an open tab says it is still there, and after how long without a
 * word it is no longer taken for one. Generous on purpose: browsers throttle
 * timers in background tabs to about once a minute.
 */
export const UI_CLIENT_HEARTBEAT_MS = 15_000;
export const UI_CLIENT_INACTIVE_AFTER_MS = 90_000;

/**
 * What is known about the cards a description lists:
 *  - `loaded` — `cards` lists the cards of `cardsSpaceId` (possibly none);
 *  - `loading` — not loaded yet: `cards` is null, i.e. **unknown**, not empty;
 *  - `error` — loading them failed: `cards` is null (unknown);
 *  - `none` — there is no space whose cards the screen could show (no working
 *    space, no conversation on the agent views page, a conversation without
 *    agent views, or a space still held from before an identity switch):
 *    `cards` is empty and `cardsSpaceId` null.
 */
export const UI_CARDS_STATES = ['loaded', 'loading', 'error', 'none'] as const;
export type UiCardsState = (typeof UI_CARDS_STATES)[number];

export const uiSnapshotCardSchema = z.object({
  cardId: z.string().min(1).max(128),
  title: z.string().max(200),
  /** `component` — a catalog component; `openui` — an OpenUI Lang composition. */
  kind: z.enum(['component', 'openui']),
  /** The catalog component id, or `openui` for a composition. */
  component: z.string().min(1).max(120),
  /** The card's content version — the counter a spec edit must name. */
  specVersion: z.number().int().nonnegative(),
});
export type UiSnapshotCard = z.infer<typeof uiSnapshotCardSchema>;

export const uiSnapshotSchema = z.object({
  /** Grows by one per significant change, within one `clientId`. Starts at 1. */
  version: z.number().int().min(1),
  clientId: uiClientIdSchema,
  /** When the tab assembled this description (the tab's clock). */
  capturedAt: z.iso.datetime(),
  /**
   * The conversation open in the tab's chat; null for a new, unsaved one.
   * Also null right after an identity switch while the chat still holds the
   * previous identity's conversation — it is not reported until the chat moves.
   */
  conversationId: z.string().max(128).nullable(),
  /**
   * The working canvas space the tab has selected. Null after an identity
   * switch while it is still the previous identity's, as `conversationId`.
   */
  spaceId: z.string().max(128).nullable(),
  /**
   * Path and query of the screen, as the address bar shows it — cut to the
   * limit, and without the session parameters (`c`, `s`) that still name the
   * previous identity's conversation or space after a switch.
   */
  url: z.string().max(UI_URL_MAX_LENGTH),
  /** True when `url` was cut: the address on screen is longer. */
  urlTruncated: z.boolean(),
  /** The catalog target whose route is the screen on display, if one is. */
  target: z
    .object({ id: z.string().max(120), kind: z.enum(UI_TARGET_KINDS), label: z.string().max(120) })
    .nullable(),
  /**
   * The composition on screen, if there is one, with a version that changes
   * whenever it does (see {@link compositionVersionOf}):
   *  - a module view — `id` is the view's, the version names its source;
   *  - a conversation's agent views (a canvas of a conversation-scoped space) —
   *    `id` is the screen's target (or `space:<id>`), the version names the
   *    space and every card in it with its `specVersion`, so adding, removing
   *    or editing an agent view gives a new version.
   */
  view: z
    .object({
      id: z.string().max(120),
      title: z.string().max(200),
      compositionVersion: z.string().min(1).max(40),
    })
    .nullable(),
  /**
   * Cards of the space in `cardsSpaceId`: the canvas space actually on screen
   * (the working canvas, or a conversation's agent views — on that page never
   * the working space's), otherwise the working space selected in the shell
   * (`target` says which screen is shown). **Null means unknown** — not loaded
   * yet, or loading failed (`cardsState` says which) — and is not the same as
   * none. A description is published once the view settles, but settling does
   * not wait for cards: a reader for whom they matter reads again with
   * `minVersion` = `version` + 1.
   */
  cards: z.array(uiSnapshotCardSchema).max(UI_SNAPSHOT_CARDS_LIMIT).nullable(),
  /**
   * Which space `cards` belong to; null when there is none (`cardsState: none`).
   * Also null right after an identity switch while the space on screen is still
   * the one the shell held before it — as `spaceId`; neither its id nor its
   * cards are reported until the shell moves to another space.
   */
  cardsSpaceId: z.string().max(128).nullable(),
  cardsState: z.enum(UI_CARDS_STATES),
  /** Cards of the space left out of `cards` by its limit. */
  cardsOmitted: z.number().int().nonnegative(),
  /**
   * What mounted data components say they show, in mounting order — only those
   * that described themselves under the identity signed in now. After an
   * identity switch a component that has not described itself again (it was
   * not re-rendered) is left out: a mounted component may be missing here, but
   * nothing described under the previous identity is listed.
   */
  instances: z.array(semanticInstanceSchema).max(UI_SNAPSHOT_INSTANCES_LIMIT),
  /** Mounted descriptions left out by the count or size limit. */
  instancesOmitted: z.number().int().nonnegative(),
  /**
   * What may be done to this screen through the interface commands:
   * `navigate` always; `filter` when the screen's target declares narrowing;
   * `sort` when its view names the read of its primary instance.
   */
  actions: z.array(z.string().max(80)).max(20),
});
export type UiSnapshot = z.infer<typeof uiSnapshotSchema>;

/**
 * Why the agent did not get a current description of its conversation's screen.
 *
 *  - `no_client` — no tab of this owner has published anything (none open, or
 *    the backend restarted since — snapshots live in memory);
 *  - `other_conversation` — no tab (or not the tab asked about) shows the run's
 *    conversation. What they show belongs to another conversation and is not
 *    handed over;
 *  - `older_than_requested` — the tab has not yet published the version asked
 *    for; the newest one it has is returned, marked stale;
 *  - `client_gone` — the tab asked about (or the one a version belongs to) was
 *    closed, or the backend does not know it;
 *  - `client_inactive` — the tab's description is returned, but the tab has not
 *    shown a sign of life for longer than {@link UI_CLIENT_INACTIVE_AFTER_MS};
 *  - `superseded` — the tab is open but says its screen has moved on to a
 *    version the backend does not have (the tab's newer description was
 *    refused); the older description is returned, and is not the screen.
 */
export const UI_STATE_REASONS = [
  'no_client',
  'older_than_requested',
  'other_conversation',
  'client_gone',
  'client_inactive',
  'superseded',
] as const;
export type UiStateReason = (typeof UI_STATE_REASONS)[number];

/** What `ui_state` and `GET /api/ui/snapshot` answer. */
export interface UiStateResult {
  /** True whenever the answer is not a description at least as new as required. */
  stale: boolean;
  reason?: UiStateReason;
  version: number | null;
  capturedAt: string | null;
  /** Milliseconds since the description was captured (never before it reached the server). */
  ageMs: number | null;
  snapshot: UiSnapshot | null;
}

/** Longest wait `ui_state` accepts for a newer publication. */
export const UI_STATE_MAX_WAIT_MS = 5000;
/** Wait applied when a minimum version is asked for without a wait. */
export const UI_STATE_DEFAULT_WAIT_MS = 3000;

/**
 * A short, stable name for a composition's source text.
 *
 * FNV-1a over the UTF-16 code units, 32 bits, as eight hex digits, prefixed with
 * the source length — the same text always gives the same name in the browser
 * and on the server, and an edit that happens to collide in 32 bits would also
 * have to keep the length. It names a version; it is not a security measure.
 */
export function compositionVersionOf(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${source.length.toString(36)}-${hash.toString(16).padStart(8, '0')}`;
}
