import type { QueryClient } from '@tanstack/react-query';
import type { CanvasState, SemanticInstance, UiTarget, ViewDefinition } from '@platform/contracts';
import { accessScope, onAccessContextChange } from '../api/accessContext.ts';
import { qk } from '../api/queries.ts';
import { buildUiSnapshotContent, type UiSnapshotContent } from '../state/uiSnapshot.ts';

export interface ShellSnapshotDeps {
  qc: QueryClient;
  /** The address as the browser shows it. */
  location: () => { pathname: string; search: string };
  shell: () => { conversationId: string | null; spaceId: string | null };
  /** Descriptions recorded under the identity signed in now (`listInstances`). */
  instances: () => SemanticInstance[];
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
  const stop = (deps.onAccessChange ?? onAccessContextChange)(() => {
    const held = deps.shell();
    heldAtSwitch.conversationId = held.conversationId;
    heldAtSwitch.spaceId = held.spaceId;
  });

  const unlessHeld = (key: 'conversationId' | 'spaceId', value: string | null): string | null => {
    if (heldAtSwitch[key] === undefined) return value;
    if (value === heldAtSwitch[key]) return null;
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
    const conversationId = unlessHeld('conversationId', shell.conversationId);
    const spaceId = unlessHeld('spaceId', shell.spaceId);
    const canvas = spaceId ? deps.qc.getQueryData<CanvasState>(qk.space(spaceId)) : undefined;
    if (canvas) known.canvas = canvas;

    const { pathname, search } = deps.location();
    return buildUiSnapshotContent({
      url: pathname + withoutHeldSessionParams(search),
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
  return Object.assign(source, { dispose: stop });
}
