import { useEffect, useRef } from 'react';
import { useSessionLocation } from '../state/sessionLocation.ts';
import { useAppState } from '../state/appState.ts';

/**
 * Keeps the canvas space in the address bar in step with the one on screen.
 *
 * Deliberately here and not inside the canvas. `setSpace` in the client store is
 * already the single funnel every space change goes through — opening a case,
 * choosing a saved composition, the canvas falling back to the most recent
 * space, a conversation bringing its own workspace — so synchronising the store
 * covers all of them without any of those callers, including the business
 * module's screens, having to know that a URL exists.
 *
 * Same which-side-moved problem as the conversation, and the same solution: the
 * value both sides last agreed on decides who is following whom. The URL wins
 * on a reload or Back/Forward; the store wins when the user opens something.
 */
export function SpaceSync() {
  const { spaceId: urlSpaceId, setSpace: setUrlSpace } = useSessionLocation();
  const spaceId = useAppState((s) => s.spaceId);
  const setSpace = useAppState((s) => s.setSpace);
  const lastSynced = useRef<string | null>(null);

  useEffect(() => {
    if (urlSpaceId !== lastSynced.current) {
      // The URL moved: a reload, Back/Forward, or a shared link.
      lastSynced.current = urlSpaceId;
      if (urlSpaceId !== null && urlSpaceId !== spaceId) setSpace(urlSpaceId);
      return;
    }
    if (spaceId !== lastSynced.current) {
      // The application moved: record it so a reload comes back here.
      lastSynced.current = spaceId;
      setUrlSpace(spaceId);
    }
  }, [urlSpaceId, spaceId, setSpace, setUrlSpace]);

  return null;
}
