import type { QueryClient } from '@tanstack/react-query';
import type { CanvasState, SemanticInstance, UiTarget, ViewDefinition } from '@platform/contracts';
import { accessScope } from '../api/accessContext.ts';
import { qk } from '../api/queries.ts';
import { buildUiSnapshotContent, type UiSnapshotContent } from '../state/uiSnapshot.ts';

export interface ShellSnapshotDeps {
  qc: QueryClient;
  /** The address as the browser shows it. */
  location: () => { pathname: string; search: string };
  shell: () => { conversationId: string | null; spaceId: string | null };
  instances: () => SemanticInstance[];
  scope?: () => string;
}

/**
 * Where the shell's description of the screen comes from.
 *
 * The catalog, the module views and the active space's cards are read from the
 * query cache, which the publisher keeps observed. What was last seen is also
 * remembered, for the signed-in owner: a cache entry evicted and not yet
 * loaded again is not a change of the screen, and must not publish a new
 * version that has lost the screen's target, view or cards. Remembered values
 * are dropped when the owner changes — another owner's catalog or cards are
 * never described.
 */
export function createShellSnapshotSource(deps: ShellSnapshotDeps): () => UiSnapshotContent {
  const scope = deps.scope ?? accessScope;
  let known: {
    scope: string;
    targets?: UiTarget[];
    views?: ViewDefinition[];
    canvas?: CanvasState;
  } = { scope: scope() };

  return () => {
    const owner = scope();
    if (known.scope !== owner) known = { scope: owner };
    const { conversationId, spaceId } = deps.shell();

    const targets = deps.qc.getQueryData<{ targets: UiTarget[] }>(qk.uiTargets())?.targets;
    if (targets) known.targets = targets;
    const views = deps.qc.getQueryData<{ views: ViewDefinition[] }>(qk.uiViews())?.views;
    if (views) known.views = views;
    const canvas = spaceId ? deps.qc.getQueryData<CanvasState>(qk.space(spaceId)) : undefined;
    if (canvas) known.canvas = canvas;

    const { pathname, search } = deps.location();
    return buildUiSnapshotContent({
      url: pathname + search,
      pathname,
      conversationId,
      spaceId,
      instances: deps.instances(),
      targets: known.targets,
      views: known.views,
      // Only the active space's: the builder ignores a remembered other space.
      canvas: known.canvas,
    });
  };
}
