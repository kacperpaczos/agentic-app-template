import type { PlatformConfig } from '../config.ts';
import type { Db } from '../db/client.ts';
import type { ComponentCatalog } from '../registry/catalog.ts';
import type { ServerModuleRegistry } from '../registry/modules.ts';
import { ArtifactService } from './artifacts.ts';
import { CanvasService } from './canvas.ts';
import { ConversationService } from './conversations.ts';
import { FileService } from './files.ts';
import { IdempotencyStore } from './idempotency.ts';
import { RunRegistry } from './runs.ts';

export { ArtifactService } from './artifacts.ts';
export { CanvasService } from './canvas.ts';
export { ConversationService, deriveTitle } from './conversations.ts';
export { FileService, sanitizeFilename } from './files.ts';
export { IdempotencyStore } from './idempotency.ts';
export { RunRegistry } from './runs.ts';

/**
 * Every platform capability in one place. Modules receive this through their
 * own factory, so a module never reaches into the database directly and the
 * platform never needs to know what a module stores.
 */
export interface PlatformServices {
  config: PlatformConfig;
  db: Db;
  modules: ServerModuleRegistry;
  /** Rebuilt by `createPlatform` once modules have registered. */
  catalog: ComponentCatalog;
  idempotency: IdempotencyStore;
  canvas: CanvasService;
  conversations: ConversationService;
  artifacts: ArtifactService;
  files: FileService;
  runs: RunRegistry;
}

export function createPlatformServices(input: {
  config: PlatformConfig;
  db: Db;
  modules: ServerModuleRegistry;
  catalog: ComponentCatalog;
}): PlatformServices {
  const idempotency = new IdempotencyStore(input.db);
  return {
    config: input.config,
    db: input.db,
    modules: input.modules,
    catalog: input.catalog,
    idempotency,
    canvas: new CanvasService(input.db, idempotency),
    conversations: new ConversationService(input.db),
    artifacts: new ArtifactService(input.db),
    files: new FileService(input.db, input.config.filesDir, input.config.maxUploadBytes),
    runs: new RunRegistry(input.db),
  };
}
