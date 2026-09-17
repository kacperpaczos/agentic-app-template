import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import { useCanvasState, useUiTargets, useViewDefinitions } from '../api/queries.ts';
import { useAppState } from '../state/appState.ts';
import { listInstances, useUiSemantics } from '../state/uiSemantics.ts';
import { uiSnapshotSession } from '../state/uiSnapshot.ts';
import { createShellSnapshotSource } from './snapshotSource.ts';

/** Query-cache entries a description is assembled from. */
const DESCRIBED_QUERIES = new Set(['ui-targets', 'ui-views', 'canvas']);

/**
 * Keeps this tab's description of its screen published.
 *
 * Renders nothing. While mounted it tells the session where a description comes
 * from (`createShellSnapshotSource`) and marks a change whenever one of its
 * inputs moves, so the session publishes shortly after the screen stops
 * changing. See `state/uiSnapshot.ts`.
 *
 * It also keeps the inputs loaded: the catalog, the module views and the active
 * space are observed here, because the screens that happen to use them
 * (a data table, a composed view, the canvas) are not on every screen — and a
 * tab opened straight on Settings must still say it shows Settings.
 *
 * And it says whether the tab is still there: a heartbeat while open, a
 * retirement when the page goes away, a fresh publication when it comes back.
 */
export function UiSnapshotPublisher() {
  const qc = useQueryClient();
  const href = useRouterState({ select: (s) => s.location.href });
  const spaceId = useAppState((s) => s.spaceId);
  useUiTargets();
  useViewDefinitions();
  useCanvasState(spaceId);

  useEffect(() => {
    uiSnapshotSession.setSource(
      createShellSnapshotSource({
        qc,
        location: () => ({ pathname: window.location.pathname, search: window.location.search }),
        shell: () => {
          const s = useAppState.getState();
          return { conversationId: s.conversationId, spaceId: s.spaceId };
        },
        instances: listInstances,
      }),
    );

    const changed = () => uiSnapshotSession.changed();
    const unsubscribe = [
      useUiSemantics.subscribe(changed),
      // The store also carries streamed text; only these two describe the screen.
      useAppState.subscribe((s, prev) => {
        if (s.conversationId !== prev.conversationId || s.spaceId !== prev.spaceId) changed();
      }),
      qc.getQueryCache().subscribe((event) => {
        const head = event.query.queryKey[0];
        // Data arriving or leaving; observer bookkeeping changes nothing described.
        const moved = event.type === 'updated' || event.type === 'added' || event.type === 'removed';
        if (moved && typeof head === 'string' && DESCRIBED_QUERIES.has(head)) {
          changed();
        }
      }),
      uiSnapshotSession.startHeartbeat(),
    ];

    /*
     * A closing (or reloading) page retires its description; one restored from
     * the back-forward cache publishes again; one brought back to the front
     * says at once that it is there — background timers may have been slowed.
     */
    const onPageHide = () => uiSnapshotSession.closing();
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void uiSnapshotSession.flush();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void uiSnapshotSession.heartbeat();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisible);

    changed();
    return () => {
      for (const stop of unsubscribe) stop();
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisible);
      uiSnapshotSession.setSource(null);
    };
  }, [qc]);

  // The address moved: the screen may be another one.
  useEffect(() => {
    uiSnapshotSession.changed();
  }, [href]);

  return null;
}
