import type { ModuleToolDefinition } from '@platform/contracts';
import type { PlatformServices } from '../../services/index.ts';
import { artifactTools } from './artifacts.ts';
import { canvasTools } from './canvas.ts';
import { contextTools } from './context.ts';
import { fileTools } from './files.ts';
import { uiSortTools } from './ui-sort.ts';
import { uiTools } from './ui.ts';

export { stageFileIntoWorkspace } from './files.ts';

/**
 * Domain-agnostic tools every agent run gets: application context, canvas
 * composition, interface control, managed files and artifacts.
 *
 * These are registered under the `app` module id, so they surface as
 * `mcp__app__app_*` / `mcp__app__canvas_*` to Claude. They never touch business
 * tables — business operations come from the installed modules.
 *
 * One file per area, so work on one area does not collide with work on
 * another. The order below is the order the tools are offered in and is kept
 * stable: it is what the model has always seen.
 */
export function platformTools(services: PlatformServices): ModuleToolDefinition<never>[] {
  const defs: Array<ModuleToolDefinition<any>> = [
    ...contextTools(services),
    ...canvasTools(services),
    ...uiTools(services),
    ...uiSortTools(services),
    ...fileTools(services),
    ...artifactTools(services),
  ];
  return defs as ModuleToolDefinition<never>[];
}
