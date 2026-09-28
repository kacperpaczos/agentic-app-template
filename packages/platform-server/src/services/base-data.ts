import type { PlatformInstance } from '../index.ts';

/**
 * Fills a fresh installation with base data, once.
 *
 * **Why this is part of starting the application.** An empty application is not
 * a neutral starting point — it is a dead end. With no records at all the canvas
 * has nothing to show, the business screens are empty lists, and the agent,
 * asked to do anything, can only report that there is nothing to do. That is
 * what a first run looked like, and it made the product read as broken rather
 * than as new.
 *
 * **Once, not every boot.** Each module's contribution is recorded in
 * `app_settings` under `base-data.<moduleId>`. If the user deletes the demo
 * case, it stays deleted — restarting must not resurrect data somebody chose to
 * remove. That is also why this never touches existing rows: it adds, or it does
 * nothing.
 *
 * **Where it lives.** The platform offers it; the composition root calls it
 * (`apps/server/src/main.ts`). It is deliberately not inside `createPlatform`,
 * because a test harness that builds a platform wants the database it asked
 * for — empty — and having the constructor quietly populate it would make every
 * count assertion depend on a module's demo fixture.
 */
export interface BaseDataResult {
  /** Modules whose base data was created by this call. */
  seeded: string[];
  /** Modules already recorded as seeded, left alone. */
  skipped: string[];
  /** Workspaces materialised so the canvas is not empty on first open. */
  workspaces: number;
}

const MARKER = (moduleId: string) => `base-data.${moduleId}`;

function alreadySeeded(platform: PlatformInstance, moduleId: string): boolean {
  const row = platform.db.$client
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(MARKER(moduleId)) as { value: string } | undefined;
  return row !== undefined;
}

function recordSeeded(platform: PlatformInstance, moduleId: string): void {
  platform.db.$client
    .prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
    .run(MARKER(moduleId), new Date().toISOString());
}

export async function ensureBaseData(
  platform: PlatformInstance,
  options: { ownerId: string; force?: boolean } = { ownerId: 'local-user' },
): Promise<BaseDataResult> {
  const { ownerId, force = false } = options;
  const result: BaseDataResult = { seeded: [], skipped: [], workspaces: 0 };

  for (const mod of platform.registry.modules) {
    if (!mod.seed) continue;
    if (!force && alreadySeeded(platform, mod.meta.id)) {
      result.skipped.push(mod.meta.id);
      continue;
    }
    await mod.seed({
      ownerId,
      storeFile: async (input) => ({
        id: platform.services.files.store({ ownerId, ...input }).id,
      }),
    });
    recordSeeded(platform, mod.meta.id);
    result.seeded.push(mod.meta.id);
  }

  /*
   * A workspace for every seeded record, so the canvas has something on it.
   *
   * Without this the application still opens on "Brak przestrzeni pracy" and the
   * user has to find a record and open it before anything is visible — which is
   * most of the emptiness the base data was meant to remove. The composition
   * comes from the module's own `defaultComposition`, through the same catalog
   * validation the HTTP path uses, so nothing here knows what a card contains.
   */
  if (result.seeded.length > 0) {
    for (const mod of platform.registry.modules) {
      for (const record of mod.baseDataScopes?.(ownerId) ?? []) {
        const { space, created } = platform.services.canvas.ensureScopedSpace({
          ownerId,
          title: record.title,
          scopeKind: record.kind,
          scopeId: record.id,
        });
        if (!created) continue;
        result.workspaces += 1;
        for (const card of platform.services.modules.defaultComposition({
          kind: record.kind,
          id: record.id,
        })) {
          await platform.services.canvas.addCard(
            {
              spaceId: space.id,
              title: card.title,
              spec: platform.services.catalog.validate(card.spec),
              geometry: card.geometry,
            },
            ownerId,
          );
        }
      }
    }
  }

  return result;
}
