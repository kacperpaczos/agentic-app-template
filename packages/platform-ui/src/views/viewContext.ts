import { createContext, useContext, useId } from 'react';

/**
 * The module view a data component is rendered in, if any.
 *
 * Provided by `ComposedView`. A table in a canvas card or a chat message has no
 * view, so it never picks up a narrowing from the address bar: that narrowing
 * belongs to the view's primary instance — the one reading the view's declared
 * `primaryOperation` — and nothing else on screen.
 */
export interface ComposedViewContextValue {
  viewId: string;
  primaryOperation: string | null;
}

export const ComposedViewContext = createContext<ComposedViewContextValue | null>(null);

export const useComposedView = (): ComposedViewContextValue | null => useContext(ComposedViewContext);

/** A stable, attribute-safe identifier for one mounted component. */
export function useInstanceId(component: string): string {
  const raw = useId();
  return `${component}-${raw.replace(/[^A-Za-z0-9_-]/g, '')}`;
}
