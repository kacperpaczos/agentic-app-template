import { z } from 'zod';

/**
 * The window a tool's read returns, and how it says what it left out.
 *
 * **Why every list tool needs one.** A tool answer becomes part of the model's
 * context. A read that returns "all of them" grows with the user's data, so it
 * works on a demonstration database and silently stops working on a real one —
 * and worse, it does so by filling the window with rows nobody asked for. The
 * remedy is not a cap hidden inside the handler: a caller has to be able to
 * *ask* for a window and to *know* that it got one.
 *
 * So every listing takes `limit` and `offset`, defaults to
 * {@link READ_WINDOW_DEFAULT_LIMIT}, never exceeds {@link READ_WINDOW_MAX_LIMIT},
 * and answers with {@link ReadWindow}: how many records exist in total, which
 * slice this is, and whether more follow. `truncated: true` with `total` is the
 * difference between "these are all of them" and "these are the first twenty" —
 * the same distinction that keeps an empty result from being read as an empty
 * application.
 *
 * Deliberately domain-neutral and deliberately shared: a module's list tools use
 * exactly the same window as the platform's, so an agent learns the shape once.
 */

/** Records a listing returns when the caller does not ask for a number. */
export const READ_WINDOW_DEFAULT_LIMIT = 25;

/** The most any listing will return in one call, whatever the caller asks for. */
export const READ_WINDOW_MAX_LIMIT = 100;

/**
 * `limit` / `offset` as a tool declares them.
 *
 * `.optional()` rather than `.default()`: a defaulted field is published in the
 * MCP schema as one the caller must provide, which is the opposite of what a
 * default is for (the same reasoning as `searchInput` in the example module).
 */
export const readWindowInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(READ_WINDOW_MAX_LIMIT)
    .optional()
    .describe(`Ile rekordow zwrocic (domyslnie ${READ_WINDOW_DEFAULT_LIMIT}, najwyzej ${READ_WINDOW_MAX_LIMIT})`),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Od ktorego rekordu zaczac (do przejscia po kolejnych stronach)'),
};

export const readWindowInputSchema = z.object(readWindowInput);
export type ReadWindowInput = z.infer<typeof readWindowInputSchema>;

/** What a windowed listing says about the set it was taken from. */
export interface ReadWindow {
  /** Records that exist, independently of this window. */
  total: number;
  /** Records in this answer. */
  returned: number;
  offset: number;
  limit: number;
  /**
   * True when the window does not cover the whole set. Says plainly that the
   * answer is a page — never to be read as "that is everything there is".
   */
  truncated: boolean;
  /** `offset` of the next page, or null when this one ends the set. */
  nextOffset: number | null;
}

/** One sentence the tool puts next to a window, so the answer explains itself. */
export function readWindowNote(window: ReadWindow, what = 'rekordow'): string {
  return window.truncated
    ? `Zwrocono ${window.returned} z ${window.total} ${what} (offset ${window.offset}). ` +
        `To NIE jest caly zbior — po kolejne wywolaj ponownie z offset=${window.nextOffset}.`
    : `Zwrocono ${window.returned} z ${window.total} ${what} — to caly zbior od offset ${window.offset}.`;
}

/**
 * Takes the asked-for window out of a set, and describes it.
 *
 * The limit is clamped rather than refused: a caller asking for more than the
 * ceiling gets the ceiling and is told so by `truncated`, which is more useful
 * than an error that leaves it with nothing. A `limit` outside the schema's
 * range never reaches here from a tool — the schema refuses it first.
 */
export function applyReadWindow<T>(
  items: readonly T[],
  input: ReadWindowInput = {},
): { items: T[]; window: ReadWindow } {
  const limit = Math.min(Math.max(1, input.limit ?? READ_WINDOW_DEFAULT_LIMIT), READ_WINDOW_MAX_LIMIT);
  const offset = Math.max(0, input.offset ?? 0);
  const slice = items.slice(offset, offset + limit);
  const end = offset + slice.length;
  return {
    items: slice,
    window: {
      total: items.length,
      returned: slice.length,
      offset,
      limit,
      truncated: end < items.length || offset > 0,
      nextOffset: end < items.length ? end : null,
    },
  };
}
