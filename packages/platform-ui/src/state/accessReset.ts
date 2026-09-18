import { onAccessContextChange } from '../api/accessContext.ts';
import { useAppState } from './appState.ts';

/**
 * What an identity switch has to throw away *outside* the query cache.
 *
 * `setAccessContext` aborts the previous identity's requests and empties the
 * cache, and for a while that was taken to be the whole job. It is not: the
 * client keeps state of its own that describes the same person's work — which
 * conversation is open, which run is being followed, which files are attached
 * to the next command, which form is half filled in — and every one of those is
 * read again when the next command is composed. Left behind, they are sent to
 * the backend as the *new* identity's context. The backend refuses to act on
 * them (ownership is the session's), so this is not a way in; it is a way for
 * one owner's conversation id, resource and drafts to be carried into another
 * owner's prompt, and for the address bar to keep pointing at a conversation
 * that is no longer readable.
 *
 * Registered rather than called from `setAccessContext` on purpose. The store
 * belongs to the interface and the access context to the API layer; making the
 * lower layer import the higher one would put the shell's state model inside
 * the request path. A listener keeps the dependency pointing the right way and
 * keeps this testable without a browser.
 *
 * **Order matters, and it is the reason this is not first in the list.** The
 * screen-description source (`shell/snapshotSource.ts`) reads the shell's
 * conversation and space *at the moment of the switch*, to stop describing
 * them. It subscribes when the publisher mounts; this subscribes after, so by
 * the time the reset runs the description has already recorded what it needed.
 * Both listeners run in the same synchronous pass, so nothing can observe the
 * intermediate state.
 */
export interface AccessResetDeps {
  /** Subscribes to identity switches; defaults to the application's own. */
  onAccessChange?: (listener: () => void) => () => void;
  /**
   * Drops the session identifiers the address bar carries (`c`, `s`).
   *
   * They are ids, not data, but they outlive the switch: a conversation id left
   * in the URL is immediately re-selected by the chat, which then reports the
   * previous owner's conversation as unavailable — an error where there is no
   * error, on every switch.
   */
  clearSessionLocation?: () => void;
}

/** Subscribes the client store to identity switches. Returns the unsubscribe. */
export function registerAccessContextReset(deps: AccessResetDeps = {}): () => void {
  const subscribe = deps.onAccessChange ?? onAccessContextChange;
  return subscribe(() => {
    useAppState.getState().resetForAccessChange();
    deps.clearSessionLocation?.();
  });
}
