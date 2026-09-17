import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouterState } from '@tanstack/react-router';
import type { CanvasState, UiTarget, ViewDefinition } from '@platform/contracts';
import { qk } from '../api/queries.ts';
import { useAppState } from '../state/appState.ts';
import { listInstances, useUiSemantics } from '../state/uiSemantics.ts';
import { buildUiSnapshotContent, uiSnapshotSession } from '../state/uiSnapshot.ts';

/** Query-cache entries a description is assembled from. */
const DESCRIBED_QUERIES = new Set(['ui-targets', 'ui-views', 'canvas']);

/**
 * Keeps this tab's description of its screen published.
 *
 * Renders nothing. While mounted it tells the session where a description comes
 * from — the registry of mounted data components, the address, the shell's
 * conversation and space, and what the query cache already holds — and marks
 * a change whenever one of those moves, so the session publishes shortly after
 * the screen stops changing. See `state/uiSnapshot.ts`.
 */
export function UiSnapshotPublisher() {
  const qc = useQueryClient();
  const href = useRouterState({ select: (s) => s.location.href });

  useEffect(() => {
    uiSnapshotSession.setSource(() => {
      const state = useAppState.getState();
      return buildUiSnapshotContent({
        url: window.location.pathname + window.location.search,
        pathname: window.location.pathname,
        conversationId: state.conversationId,
        spaceId: state.spaceId,
        instances: listInstances(),
        targets: qc.getQueryData<{ targets: UiTarget[] }>(qk.uiTargets())?.targets,
        views: qc.getQueryData<{ views: ViewDefinition[] }>(qk.uiViews())?.views,
        canvas: state.spaceId ? qc.getQueryData<CanvasState>(qk.space(state.spaceId)) : undefined,
      });
    });

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
    ];
    changed();
    return () => {
      for (const stop of unsubscribe) stop();
      uiSnapshotSession.setSource(null);
    };
  }, [qc]);

  // The address moved: the screen may be another one.
  useEffect(() => {
    uiSnapshotSession.changed();
  }, [href]);

  return null;
}
