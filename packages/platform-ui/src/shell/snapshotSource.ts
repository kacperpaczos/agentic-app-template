import type { QueryClient } from '@tanstack/react-query';
import {
  EMPTY_UI_SNAPSHOT_CONTEXT,
  type CanvasState,
  type SemanticInstance,
  type UiSnapshotContext,
  type UiTarget,
  type ViewDefinition,
} from '@platform/contracts';
import { accessScope, onAccessContextChange } from '../api/accessContext.ts';
import { qk } from '../api/queries.ts';
import type { DisplayedCanvas } from '../state/displayedCanvas.ts';
import { buildUiSnapshotContent, type UiSnapshotContent } from '../state/uiSnapshot.ts';

export interface ShellSnapshotDeps {
  qc: QueryClient;
  /** The address as the browser shows it. */
  location: () => { pathname: string; search: string };
  shell: () => {
    conversationId: string | null;
    spaceId: string | null;
    /** The live command context of this tab (`UiSnapshotContext`); absent means empty. */
    context?: UiSnapshotContext;
  };
  /** Descriptions recorded under the identity signed in now (`listInstances`). */
  instances: () => SemanticInstance[];
  /** The space on screen, under the identity signed in now (`displayedCanvas`). */
  displayed?: () => DisplayedCanvas | null;
  scope?: () => string;
  /** Subscribes to identity switches; defaults to the application's own. */
  onAccessChange?: (listener: () => void) => () => void;
}

/** A description source that also stops listening when disposed. */
export type ShellSnapshotSource = (() => UiSnapshotContent | null) & { dispose(): void };

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
 *
 * **Nothing from before an identity switch.** The shell's conversation and
 * space are not reset by a switch, so the ids held at that moment are not
 * reported (as `null`) until the shell moves to another one — neither as ids
 * nor in the address, whose session parameters (`c`, `s`) carry the same ids;
 * component descriptions from before the switch are filtered out by the
 * registry itself.
 *
 * **No description without the catalog.** While the catalog is still loading
 * for the signed-in owner — right after a switch, or at startup — the screen
 * cannot be named, and a description that says "no target" would be a wrong
 * one: the source answers `null` (nothing to describe yet) until it arrives,
 * or until loading it has failed.
 */
export function createShellSnapshotSource(deps: ShellSnapshotDeps): ShellSnapshotSource {
  const scope = deps.scope ?? accessScope;
  let known: {
    scope: string;
    targets?: UiTarget[];
    views?: ViewDefinition[];
    canvas?: CanvasState;
  } = { scope: scope() };
  /* Shell ids held when the identity last changed; `undefined` — no longer filtered. */
  const heldAtSwitch: { conversationId?: string | null; spaceId?: string | null } = {};
  /*
   * The ids this source last described, which is what the previous identity had.
   *
   * Deliberately not `deps.shell()` read inside the listener: the shell store
   * also clears itself on a switch (L6.12) and, being a module-level subscriber,
   * it may well run first — in which case reading the store here would answer
   * `null` and nothing would be filtered, letting the previous identity's
   * conversation id go out in the address of the next description. What this
   * source last *reported* cannot be changed by another listener's timing.
   */
  let lastSeen: { conversationId: string | null; spaceId: string | null } | null = null;
  const stop = (deps.onAccessChange ?? onAccessContextChange)(() => {
    const held = lastSeen ?? deps.shell();
    heldAtSwitch.conversationId = held.conversationId;
    heldAtSwitch.spaceId = held.spaceId;
  });

  const unlessHeld = (key: 'conversationId' | 'spaceId', value: string | null): string | null => {
    if (heldAtSwitch[key] === undefined) return value;
    /*
     * `null` is not "moved on": the shell clears these ids on a switch (L6.12),
     * and the address bar catches up a render later. Dropping the filter on the
     * first `null` let that render's description go out with the previous
     * identity's conversation still in its `url`. The filter is released only
     * when the shell names something — which can only be the new identity's.
     */
    if (value === heldAtSwitch[key] || value === null) return null;
    heldAtSwitch[key] = undefined; // the shell has moved on: its ids are the new identity's
    return value;
  };

  /* The address as shown, minus a session parameter still naming an id held at the switch. */
  const withoutHeldSessionParams = (search: string): string => {
    if (heldAtSwitch.conversationId === undefined && heldAtSwitch.spaceId === undefined) return search;
    const params = new URLSearchParams(search);
    let dropped = false;
    for (const [param, key] of [['c', 'conversationId'], ['s', 'spaceId']] as const) {
      const held = heldAtSwitch[key];
      if (held && params.get(param) === held) {
        params.delete(param);
        dropped = true;
      }
    }
    if (!dropped) return search;
    const rest = params.toString();
    return rest ? `?${rest}` : '';
  };

  const source = () => {
    const owner = scope();
    if (known.scope !== owner) known = { scope: owner };

    const targets = deps.qc.getQueryData<{ targets: UiTarget[] }>(qk.uiTargets())?.targets;
    if (targets) known.targets = targets;
    if (!known.targets && deps.qc.getQueryState(qk.uiTargets())?.status !== 'error') return null;
    const views = deps.qc.getQueryData<{ views: ViewDefinition[] }>(qk.uiViews())?.views;
    if (views) known.views = views;

    const shell = deps.shell();
    lastSeen = { conversationId: shell.conversationId, spaceId: shell.spaceId };
    const heldSpace = heldAtSwitch.spaceId;
    const conversationId = unlessHeld('conversationId', shell.conversationId);
    const spaceId = unlessHeld('spaceId', shell.spaceId);
    const canvas = spaceId ? deps.qc.getQueryData<CanvasState>(qk.space(spaceId)) : undefined;
    if (canvas) known.canvas = canvas;
    const canvasFailed = spaceId ? deps.qc.getQueryState(qk.space(spaceId))?.status === 'error' : false;
    /*
     * The canvas on screen may still be showing the space the shell held at the
     * switch (the working canvas renders the shell's space): not reported —
     * neither its id nor its cards — until the shell moves to another space.
     */
    let displayed = deps.displayed?.() ?? null;
    if (displayed && displayed.spaceId !== null && heldSpace !== undefined && displayed.spaceId === heldSpace) {
      displayed = { spaceId: null, scopeKind: null, cards: [], state: 'none' };
    }

    const { pathname, search } = deps.location();
    return buildUiSnapshotContent({
      url: pathname + withoutHeldSessionParams(search),
      pathname,
      conversationId,
      spaceId,
      /*
       * Nothing from before an identity switch, as above: while the shell still
       * holds the previous identity's space, what was selected in it is that
       * identity's too and is not published under the new one.
       */
      context: heldSpace !== undefined && spaceId === null ? EMPTY_UI_SNAPSHOT_CONTEXT : shell.context,
      instances: deps.instances(),
      targets: known.targets,
      views: known.views,
      // Only the active space's: the builder ignores a remembered other space.
      canvas: known.canvas,
      canvasFailed,
      displayed,
    });
  };
  return Object.assign(source, { dispose: stop });
}
