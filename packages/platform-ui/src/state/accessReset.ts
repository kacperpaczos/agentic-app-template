import { onAccessContextChange } from '../api/accessContext.ts';

/**
 * The part of an identity switch that only the router can do.
 *
 * The client store is cleared by `state/appState.ts`, which subscribes to the
 * same event once for the life of the page — see `clearScopedContext` there for
 * what counts as scoped and why. This file used to clear it too; two
 * implementations of one rule is how one of them stops being applied, so the
 * duplicate is gone and what is left is the thing the store cannot reach.
 *
 * That thing is the address bar. `c` and `s` — the conversation and the
 * workspace — outlive the switch because they live in the URL, not in the
 * store: the chat re-selects the conversation the address names and then
 * reports the previous owner's conversation as unavailable, which is an error
 * message where there is no error, on every switch. They are ids rather than
 * data, so nothing is disclosed; what they produce is a screen that lies about
 * what went wrong.
 *
 * Registered rather than called from `setAccessContext`, because the router is
 * the interface's and the access context is the API layer's; making the lower
 * layer import the higher one would put navigation inside the request path.
 *
 * **Order matters.** The screen-description source (`shell/snapshotSource.ts`)
 * records what it was describing at the moment of the switch. It subscribes
 * when the publisher mounts; this subscribes after it, so the description has
 * already taken what it needs. All listeners run in one synchronous pass, so no
 * intermediate state is observable.
 */
export interface AccessResetDeps {
  /** Subscribes to identity switches; defaults to the application's own. */
  onAccessChange?: (listener: () => void) => () => void;
  /** Drops the session identifiers the address bar carries (`c`, `s`). */
  clearSessionLocation?: () => void;
}

/** Subscribes the address bar to identity switches. Returns the unsubscribe. */
export function registerAccessContextReset(deps: AccessResetDeps = {}): () => void {
  const subscribe = deps.onAccessChange ?? onAccessContextChange;
  return subscribe(() => {
    deps.clearSessionLocation?.();
  });
}
