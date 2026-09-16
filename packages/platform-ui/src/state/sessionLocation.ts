import { useCallback, useMemo } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

/**
 * The part of the session that lives in the address bar.
 *
 * Two identifiers: `c` — the active conversation, `s` — the canvas space on
 * screen. They are in the URL rather than only in the client store because the
 * URL is the one piece of state a reload, Back, Forward and a pasted link all
 * preserve for free. Holding them in memory is exactly why a refresh used to
 * drop the conversation the user was reading.
 *
 * Kept short (`c`, `s`) because these end up in links people paste.
 *
 * `strict: false` reads the search parameters without binding this module to a
 * particular route: the chat and the canvas live in the shell, above the route
 * tree, and must work on every screen. The root route declares the two
 * parameters (`apps/web/src/router.tsx`) so the router preserves them across
 * navigation.
 */
export interface SessionLocation {
  conversationId: string | null;
  spaceId: string | null;
  /**
   * Writes the conversation into the URL.
   *
   * `replace` distinguishes a correction from a navigation: the backend naming a
   * conversation that is already on screen must not add a history entry, while
   * the user moving to another conversation must — otherwise Back does nothing.
   */
  setConversation: (id: string | null, opts?: { replace?: boolean }) => void;
  /**
   * Writes the space into the URL.
   *
   * Always a replacement. The space follows from the screen the user opened or
   * the conversation they picked, both of which have already produced their own
   * history entry; pushing again would mean pressing Back twice to undo one
   * action.
   */
  setSpace: (id: string | null) => void;
}

type SessionSearch = { c?: string; s?: string };

/**
 * Sets or clears one identifier.
 *
 * Clearing is `undefined` and not `delete`, which matters because the root route
 * retains both keys across navigation (`retainSearchParams`). That middleware
 * re-adds a key the caller merely left out — it can only tell a deliberate
 * removal from an omission when the key is present with `undefined`. With
 * `delete`, dismissing the "conversation unavailable" notice put the dead id
 * straight back into the URL. `undefined` values are omitted when the search is
 * stringified, so the address stays clean either way.
 */
const withParam = (prev: SessionSearch, key: 'c' | 's', value: string | null): SessionSearch => ({
  ...prev,
  [key]: value ?? undefined,
});

export function useSessionLocation(): SessionLocation {
  const search = useSearch({ strict: false }) as SessionSearch;
  const navigate = useNavigate();

  const conversationId = typeof search.c === 'string' && search.c ? search.c : null;
  const spaceId = typeof search.s === 'string' && search.s ? search.s : null;

  const setConversation = useCallback(
    (id: string | null, opts?: { replace?: boolean }) => {
      void navigate({
        to: '.',
        search: (prev: SessionSearch) => withParam(prev, 'c', id),
        replace: opts?.replace ?? false,
      } as never);
    },
    [navigate],
  );

  const setSpace = useCallback(
    (id: string | null) => {
      void navigate({
        to: '.',
        search: (prev: SessionSearch) => withParam(prev, 's', id),
        replace: true,
      } as never);
    },
    [navigate],
  );

  return useMemo(
    () => ({ conversationId, spaceId, setConversation, setSpace }),
    [conversationId, spaceId, setConversation, setSpace],
  );
}
