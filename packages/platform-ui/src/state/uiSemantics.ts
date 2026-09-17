import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { semanticInstanceSchema, type SemanticInstance } from '@platform/contracts';
import { accessEpoch } from '../api/accessContext.ts';

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
  /**
   * Registration order. Kept explicitly rather than trusting object key order,
   * which puts integer-like keys first. Replacing a description keeps its
   * position, so a list read twice in a row lists the same instances in the
   * same order unless one mounted or unmounted.
   */
  order: string[];
  /**
   * The access epoch each description was recorded under.
   *
   * Switching identity empties the query cache but does not re-render what is
   * mounted, so a component can keep describing the previous identity's
   * records for as long as nothing re-renders it. Such a description is kept
   * here (its component still owns the entry) but is not listed: only
   * descriptions recorded under the identity signed in now are.
   */
  epochs: Record<string, number>;
}

export const useUiSemantics = create<UiSemanticsState>(() => ({ instances: {}, order: [], epochs: {} }));

/**
 * Records one instance's description, or replaces it in place.
 *
 * Validated against the contract at runtime: a description that does not fit
 * it is refused, reported to the console with the reason, and not recorded —
 * a malformed entry would otherwise travel on to whatever reads the list.
 * A description equal to the one already recorded changes nothing, so readers
 * that version the list do not see a change that did not happen.
 * Returns whether the description is now recorded.
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
  const id = parsed.data.instanceId;
  const epoch = accessEpoch();
  const state = useUiSemantics.getState();
  const current = state.instances[id];
  if (current && state.epochs[id] === epoch && JSON.stringify(current) === JSON.stringify(parsed.data)) return true;
  useUiSemantics.setState((s) => ({
    instances: { ...s.instances, [id]: parsed.data },
    order: id in s.instances ? s.order : [...s.order, id],
    epochs: { ...s.epochs, [id]: epoch },
  }));
  return true;
}

export function unregisterInstance(instanceId: string): void {
  useUiSemantics.setState((s) => {
    if (!(instanceId in s.instances)) return s;
    const next = { ...s.instances };
    delete next[instanceId];
    const epochs = { ...s.epochs };
    delete epochs[instanceId];
    return { instances: next, order: s.order.filter((id) => id !== instanceId), epochs };
  });
}

/**
 * Every instance mounted right now and described under the identity signed in
 * now, in registration order.
 */
export function listInstances(): SemanticInstance[] {
  const { instances, order, epochs } = useUiSemantics.getState();
  const epoch = accessEpoch();
  return order.filter((id) => epochs[id] === epoch).map((id) => instances[id]!);
}

/**
 * The registration lifecycle of one mounted component, without React.
 *
 * `update` records the latest description in place — an instance never
 * disappears from the list because its content changed, and keeps its
 * position. The entry is removed only by `dispose` (unmount), by `update`
 * with another `instanceId` (the old one goes), by `update(null)`, or when a
 * new description is refused: a stale description would describe a screen
 * that no longer exists.
 */
export interface InstanceDescriber {
  update(description: SemanticInstance | null): void;
  dispose(): void;
}

export function createInstanceDescriber(): InstanceDescriber {
  let registered: string | null = null;
  const drop = () => {
    if (registered) unregisterInstance(registered);
    registered = null;
  };
  return {
    update(description) {
      if (!description) return drop();
      if (registered && registered !== description.instanceId) drop();
      if (registerInstance(description)) {
        registered = description.instanceId;
      } else {
        unregisterInstance(description.instanceId);
        registered = null;
      }
    },
    dispose: drop,
  };
}

/**
 * Keeps one component's description registered for as long as it is mounted.
 *
 * Content changes update the entry in place; only unmounting (or a new
 * `instanceId`) removes it. The description is compared by value, so
 * re-rendering with the same content does not touch the registry.
 */
export function useDescribeInstance(description: SemanticInstance | null): void {
  const [describer] = useState(createInstanceDescriber);
  const key = description ? JSON.stringify(description) : null;
  useEffect(() => {
    describer.update(description);
    // `key` carries the description's content; the object itself is new on every render.
  }, [describer, key]);
  useEffect(() => () => describer.dispose(), [describer]);
}
