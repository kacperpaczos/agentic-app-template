import type { QueryClient } from '@tanstack/react-query';

/**
 * Who the application is currently acting as, and everything that has to be
 * abandoned when that changes.
 *
 * Clearing the cache is not enough on its own. A request issued for the previous
 * access context can still be in flight when the switch happens; when it lands
 * it writes the previous context's rows back into a cache that has just been
 * emptied, and the new context silently reads someone else's data. Two things
 * therefore happen together here:
 *
 *  - every in-flight request is **aborted**, through a shared `AbortSignal` that
 *    is replaced on each switch;
 *  - every response is checked against the **epoch** it was issued under, so a
 *    response that somehow completes anyway is discarded instead of stored.
 *
 * Testable without a user-management system: switching between the two local
 * identities the backend recognises exercises exactly this path, in one browser
 * and one cache.
 */

let currentOwner: string | null = null;
let epoch = 0;
let controller = new AbortController();
const switchListeners = new Set<() => void>();

/**
 * Called right after every switch, once the previous context's requests are
 * aborted and its cache is gone.
 *
 * Needed because emptying the cache does not re-render what is mounted:
 * TanStack's `QueryCache.clear()` destroys queries without telling their
 * observers. Whatever keeps state about the previous identity outside the
 * cache — or reads the cache only when it re-renders — has to be told.
 */
export function onAccessContextChange(listener: () => void): () => void {
  switchListeners.add(listener);
  return () => switchListeners.delete(listener);
}

/** Monotonic counter; changes on every access-context switch. */
export const accessEpoch = (): number => epoch;

/** The identity the application is currently acting as. */
export const accessOwner = (): string | null => currentOwner;

/** Aborted as soon as the access context changes. */
export const accessSignal = (): AbortSignal => controller.signal;

/** Cache-key segment, so no key can be shared between two identities. */
export const accessScope = (): string => currentOwner ?? 'anon';

export class AccessContextChanged extends Error {
  constructor() {
    super('Kontekst dostepu zmienil sie w trakcie zadania.');
    this.name = 'AccessContextChanged';
  }
}

/**
 * Records the identity the application is acting as, and discards everything
 * belonging to the previous one.
 *
 * Safe to call with the same owner (the boot path does): that is not a switch
 * and must not tear down requests that are legitimately running.
 */
export function setAccessContext(qc: QueryClient, ownerId: string): boolean {
  if (currentOwner === ownerId) return false;

  const switching = currentOwner !== null;
  currentOwner = ownerId;
  epoch += 1;

  if (switching) {
    // Order matters: abort first so nothing can resolve into the cache between
    // the clear and the new context's first read.
    controller.abort(new AccessContextChanged());
    controller = new AbortController();
    void qc.cancelQueries();
    qc.clear();
    for (const listener of [...switchListeners]) listener();
  }
  return switching;
}

/** Test seam: returns the module to its initial state. */
export function resetAccessContext(): void {
  currentOwner = null;
  epoch = 0;
  controller = new AbortController();
}
