import { useEffect, useId } from 'react';
import { create } from 'zustand';
import type { CanvasCard, UiCardsState } from '@platform/contracts';
import { accessEpoch } from '../api/accessContext.ts';

/**
 * Which canvas space is on screen, and which cards it shows.
 *
 * The shell's selected working space (`AppState.spaceId`) is not always the
 * space on screen: the agent views page shows the conversation's own space and
 * deliberately leaves the working space alone. So whatever renders a space —
 * the canvas surface, or the agent views page while it has no canvas to show —
 * says so here while it is mounted, and the screen's description takes its
 * cards from what is actually displayed.
 *
 * Stamped with the access epoch of the render that produced it, like component
 * descriptions (`uiSemantics`): an entry from before an identity switch is not
 * listed.
 */
export interface DisplayedCanvas {
  /** The space on screen; null for a page that belongs to a space not created yet. */
  spaceId: string | null;
  /** The space's scope kind (e.g. a conversation's agent views), when known. */
  scopeKind: string | null;
  /** The cards on screen; null while they are loading or failed to load. */
  cards: CanvasCard[] | null;
  /** What the screen shows of them (`UiCardsState`). */
  state: UiCardsState;
}

interface Entry extends DisplayedCanvas {
  epoch: number;
}

interface DisplayedCanvasState {
  /** By mount key, in mounting order. */
  entries: Array<[string, Entry]>;
}

export const useDisplayedCanvases = create<DisplayedCanvasState>(() => ({ entries: [] }));

const sameEntry = (a: Entry, b: Entry) =>
  a.epoch === b.epoch &&
  a.spaceId === b.spaceId &&
  a.scopeKind === b.scopeKind &&
  a.state === b.state &&
  JSON.stringify(a.cards) === JSON.stringify(b.cards);

export function setDisplayedCanvas(key: string, displayed: DisplayedCanvas | null, epoch = accessEpoch()): void {
  useDisplayedCanvases.setState((s) => {
    const index = s.entries.findIndex(([k]) => k === key);
    if (!displayed) return index < 0 ? s : { entries: s.entries.filter(([k]) => k !== key) };
    const entry: Entry = { ...displayed, epoch };
    if (index >= 0 && sameEntry(s.entries[index]![1], entry)) return s;
    const entries = [...s.entries];
    if (index >= 0) entries[index] = [key, entry];
    else entries.push([key, entry]);
    return { entries };
  });
}

/**
 * What a screen showing a space's cards reports about them, from its query.
 *
 * The order of the three answers is the rule, and it is one rule for every such
 * screen: a failed load is what the user is looking at **even when older cards
 * are still cached**, so the error comes before the data. Asked the other way
 * round (`data ? 'loaded' : error ? 'error' : 'loading'`), a refetch that fails
 * over a filled cache describes cards nobody is looking at — and the agent then
 * talks about them.
 */
export function cardsOnScreen(input: {
  spaceId: string | null;
  scopeKind: string | null;
  data: { cards: CanvasCard[] } | null | undefined;
  /** The query's failure, in whatever form the screen has it. */
  error: unknown;
}): DisplayedCanvas {
  const { spaceId, scopeKind } = input;
  if (input.error) return { spaceId, scopeKind, cards: null, state: 'error' };
  if (!input.data) return { spaceId, scopeKind, cards: null, state: 'loading' };
  return { spaceId, scopeKind, cards: input.data.cards, state: 'loaded' };
}

/** The most recently mounted display of a space, under the identity signed in now. */
export function displayedCanvas(): DisplayedCanvas | null {
  const epoch = accessEpoch();
  const current = useDisplayedCanvases.getState().entries.filter(([, e]) => e.epoch === epoch);
  const last = current.at(-1)?.[1];
  return last ? { spaceId: last.spaceId, scopeKind: last.scopeKind, cards: last.cards, state: last.state } : null;
}

/** Declares, while mounted, the space this component shows. `null` declares nothing. */
export function useDisplayCanvas(displayed: DisplayedCanvas | null): void {
  const key = useId();
  // The identity the displayed cards were rendered under, taken now, not when the effect runs.
  const epoch = accessEpoch();
  const value = displayed ? JSON.stringify(displayed) : null;
  useEffect(() => {
    setDisplayedCanvas(key, displayed, epoch);
    // `value` carries the content; `displayed` is a new object on every render.
  }, [key, value, epoch]);
  useEffect(() => () => setDisplayedCanvas(key, null), [key]);
}
