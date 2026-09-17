/**
 * Bringing one card of a mounted canvas into view, for whoever needs to point
 * at something inside it.
 *
 * A canvas card is placed on a panned and zoomed surface: scrolling the page
 * does not move it, and scrolling the canvas's own container would fight the
 * canvas library for its position. Each mounted canvas therefore offers a way
 * to centre one of its cards through the library's own viewport, and the
 * command that shows a value in an agent view uses it when the value is not in
 * view (`shell/uiReveal.ts`).
 */

type Focuser = (cardId: string) => boolean;

const focusers = new Set<Focuser>();

/** Offers a canvas's focusing; returns the withdrawal. */
export function registerCanvasFocus(focus: Focuser): () => void {
  focusers.add(focus);
  return () => {
    focusers.delete(focus);
  };
}

/** Centres the card on whichever mounted canvas holds it. False when none does. */
export function focusCanvasCard(cardId: string): boolean {
  for (const focus of focusers) if (focus(cardId)) return true;
  return false;
}
