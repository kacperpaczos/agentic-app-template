import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { Hono } from 'hono';
import type { ServerModule } from '@platform/contracts';
import { loadConfig, type PlatformConfig } from './config.ts';
import { openDatabase, type Db } from './db/client.ts';
import { backfillToolActivity } from './db/backfill.ts';
import { PLATFORM_MIGRATIONS, runMigrations } from './db/migrations.ts';
import { SessionAuth, ensureUser } from './auth/session.ts';
import { ServerModuleRegistry } from './registry/modules.ts';
import { ComponentCatalog } from './registry/catalog.ts';
import { createPlatformServices, type PlatformServices } from './services/index.ts';
import { AgentRuntime, type ModelAgentLike } from './agent/runtime.ts';
import { createPlatformApp, DEFAULT_USER_ID, SECOND_USER_ID } from './http/app.ts';
import { platformCardComponents } from './registry/platform-components.ts';

export * from './config.ts';
export * from './db/client.ts';
export * from './db/migrations.ts';
export * from './db/backfill.ts';
export * from './registry/modules.ts';
export * from './registry/catalog.ts';
export * from './registry/ui-targets.ts';
export * from './registry/read-operations.ts';
export * from './registry/openui-validation.ts';
export * from './registry/views.ts';
export * from './registry/view-sorting.ts';
export * from './registry/record-presentation.ts';
export * from './services/index.ts';
export * from './services/base-data.ts';
export * from './agent/runtime.ts';
export * from './agent/auth.ts';
export * from './agent/events.ts';
export * from './agent/sandbox.ts';
export * from './agent/toolkit.ts';
export * from './agent/tools/index.ts';
export * from './agent/projection.ts';
export * from './agent/sandbox.ts';
export * from './agent/mcp.ts';
export * from './agent/prompt.ts';
export * from './auth/session.ts';
export * from './http/app.ts';
export * from './registry/platform-components.ts';
export * from './util/id.ts';

export interface PlatformInstance {
  config: PlatformConfig;
  db: Db;
  services: PlatformServices;
  registry: ServerModuleRegistry;
  runtime: AgentRuntime;
  app: Hono<{ Variables: { ownerId: string } }>;
  versions: Record<string, string>;
  close: () => void;
}

function readVersions(): Record<string, string> {
  const require = createRequire(import.meta.url);
  /**
   * Reads a dependency's real installed version. `require.resolve('<pkg>/package.json')`
   * fails for packages whose `exports` map does not list `./package.json`, so we
   * resolve the entry point and walk up to the owning manifest instead.
   */
  const pick = (name: string): string => {
    try {
      let dir = dirname(require.resolve(name));
      for (let i = 0; i < 8; i += 1) {
        const manifest = resolve(dir, 'package.json');
        if (existsSync(manifest)) {
          const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
          if (json.name === name && json.version) return json.version;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  };
  return {
    node: process.versions.node,
    hono: pick('hono'),
    drizzle: pick('drizzle-orm'),
    mastraCore: pick('@mastra/core'),
    mastraClaude: pick('@mastra/claude'),
    claudeAgentSdk: pick('@anthropic-ai/claude-agent-sdk'),
    zod: pick('zod'),
  };
}

/**
 * Boots the platform with a chosen set of business modules.
 *
 * `modules: []` is a supported configuration: the platform serves an empty
 * workspace, an empty data section and an agent whose only tools are the
 * domain-agnostic ones. That path is exercised by the boundary test suite.
 */
export function createPlatform(input: {
  /**
   * Either ready modules, or a factory that receives the platform services a
   * module needs to be constructed. The factory form exists so a module can be
   * built against a live platform without booting the platform twice.
   */
  modules: ServerModule[] | ((services: PlatformServices) => ServerModule[]);
  config?: Partial<PlatformConfig>;
  env?: NodeJS.ProcessEnv;
  /**
   * Replaces the model at the adapter boundary. Tests and diagnostic harnesses
   * only — production leaves this unset and goes through Mastra. See
   * {@link ModelAgentLike}.
   */
  modelAgent?: ModelAgentLike | null;
}): PlatformInstance {
  const config = { ...loadConfig(input.env), ...input.config };
  const db = openDatabase(config.dbFile);

  const registry = new ServerModuleRegistry();
  const services = createPlatformServices({
    config,
    db,
    modules: registry,
    catalog: new ComponentCatalog(registry, platformCardComponents()),
  });

  const mods = typeof input.modules === 'function' ? input.modules(services) : input.modules;
  for (const mod of mods) registry.register(mod);

  // The catalog is rebuilt once the registry is populated: it must see the
  // modules' card components before anything validates a composition.
  services.catalog = new ComponentCatalog(registry, platformCardComponents());
  // Live artifacts resolve through the module registry; it only exists once the
  // modules above are installed.
  services.artifacts.modules = registry;

  runMigrations(db, [...PLATFORM_MIGRATIONS, ...registry.migrations()]);
  ensureUser(db, DEFAULT_USER_ID, 'Uzytkownik lokalny');
  ensureUser(db, SECOND_USER_ID, 'Inny uzytkownik');
  services.runs.reconcileOnBoot();
  // Rebuilds tool activity for conversations recorded before it was persisted,
  // and repairs any run whose process died mid-stream. Idempotent, so it is
  // safe on every boot; silent when there is nothing to rebuild.
  const rebuilt = backfillToolActivity(db);
  if (rebuilt.runsRebuilt > 0) {
    console.log(
      `[platform] odtworzono aktywnosc narzedzi: ${rebuilt.runsRebuilt} uruchomien, ${rebuilt.messagesWritten} wiadomosci`,
    );
  }

  const runtime = new AgentRuntime(services, input.modelAgent ?? null);
  const versions = readVersions();
  const auth = SessionAuth.load(config.dataDir);
  const app = createPlatformApp({ services, runtime, auth, versions });

  return {
    config,
    db,
    services,
    registry,
    runtime,
    app,
    versions,
    close: () => {
      services.runs.abortAll('server_shutdown');
      db.$client.close();
    },
  };
}

export { DEFAULT_USER_ID, SECOND_USER_ID };
