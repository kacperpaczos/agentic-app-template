import { useEffect } from 'react';
import { create } from 'zustand';
import { semanticInstanceSchema, type SemanticInstance } from '@platform/contracts';

/**
 * What the mounted data components say they are showing.
 *
 * **Why a registry and not the DOM.** Rendering a composition puts records on
 * screen, but nothing in the markup says which read they came from, which field
 * a cell is, what narrowing produced the rows or how many were left out. Each
 * data component therefore describes itself here while it is mounted, in the
 * vocabulary of the read's descriptor, and removes the description when it
 * unmounts. Whoever needs to know what the interface shows — a description of
 * the active screen for the agent, a test — reads the list instead of scraping
 * markup, and reads only what is mounted right now.
 *
 * Nothing here talks to the backend. Publishing a snapshot is a separate
 * concern built on top of this list.
 */

interface UiSemanticsState {
  /** Mounted instances by `instanceId`. */
  instances: Record<string, SemanticInstance>;
}

export const useUiSemantics = create<UiSemanticsState>(() => ({ instances: {} }));

/**
 * Records, or replaces, one instance's description.
 *
 * Validated against the contract at runtime: a description that does not fit
 * it is refused, reported to the console with the reason, and not recorded —
 * a malformed entry would otherwise travel on to whatever reads the list.
 * Returns whether it was recorded.
 */
export function registerInstance(description: SemanticInstance): boolean {
  const parsed = semanticInstanceSchema.safeParse(description);
  if (!parsed.success) {
    console.error(
      '[uiSemantics] opis instancji odrzucony',
      description?.instanceId,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
    return false;
  }
  useUiSemantics.setState((s) => ({
    instances: { ...s.instances, [parsed.data.instanceId]: parsed.data },
  }));
  return true;
}

export function unregisterInstance(instanceId: string): void {
  useUiSemantics.setState((s) => {
    if (!(instanceId in s.instances)) return s;
    const next = { ...s.instances };
    delete next[instanceId];
    return { instances: next };
  });
}

/** Every instance mounted right now, in mount order. */
export function listInstances(): SemanticInstance[] {
  return Object.values(useUiSemantics.getState().instances);
}

/**
 * Keeps one component's description registered for as long as it is mounted.
 *
 * Pass `null` while there is nothing truthful to say (loading, failed): an
 * instance that has not shown records does not claim any. The description is
 * compared by value, so re-rendering with the same content does not churn the
 * registry.
 */
export function useDescribeInstance(description: SemanticInstance | null): void {
  const key = description ? JSON.stringify(description) : null;
  useEffect(() => {
    if (!description) return;
    registerInstance(description);
    return () => unregisterInstance(description.instanceId);
    // `key` carries the description's content; the object itself is new on every render.
  }, [key]);
}
