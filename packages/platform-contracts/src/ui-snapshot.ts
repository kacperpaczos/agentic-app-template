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
  /** The conversation open in the tab's chat; null for a new, unsaved one. */
  conversationId: z.string().max(128).nullable(),
  /** The canvas space the tab has selected. */
  spaceId: z.string().max(128).nullable(),
  /** Path and query of the screen, as the address bar shows it — cut to the limit. */
  url: z.string().max(UI_URL_MAX_LENGTH),
  /** True when `url` was cut: the address on screen is longer. */
  urlTruncated: z.boolean(),
  /** The catalog target whose route is the screen on display, if one is. */
  target: z
    .object({ id: z.string().max(120), kind: z.enum(UI_TARGET_KINDS), label: z.string().max(120) })
    .nullable(),
  /**
   * The module view composing the screen, if the screen is one. The version
   * names the composition's source (see {@link compositionVersionOf}), so two
   * descriptions of the same view with different versions describe different
   * compositions.
   */
  view: z
    .object({
      id: z.string().max(120),
      title: z.string().max(200),
      compositionVersion: z.string().min(1).max(40),
    })
    .nullable(),
  /**
   * Cards of the active space, whether or not the canvas is the screen on
   * display (`target` says which screen is). Null while this tab has not loaded
   * the space — unknown, which is not the same as none.
   */
  cards: z.array(uiSnapshotCardSchema).max(UI_SNAPSHOT_CARDS_LIMIT).nullable(),
  /** Cards of the space left out of `cards` by its limit. */
  cardsOmitted: z.number().int().nonnegative(),
  /** What each mounted data component says it shows, in mounting order. */
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
 *    shown a sign of life for longer than {@link UI_CLIENT_INACTIVE_AFTER_MS}.
 */
export const UI_STATE_REASONS = [
  'no_client',
  'older_than_requested',
  'other_conversation',
  'client_gone',
  'client_inactive',
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
