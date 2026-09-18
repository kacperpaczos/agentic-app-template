import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatform,
  DEFAULT_USER_ID,
  SECOND_USER_ID,
  type ModelAgentLike,
  type PlatformInstance,
} from '@platform/server';
import { createProcurementModule, type ProcurementService } from '@module/procurement/server';
import { ProcurementService as Service } from '@module/procurement/server';

export interface Harness {
  platform: PlatformInstance;
  service: ProcurementService;
  ownerId: string;
  otherOwnerId: string;
  dataDir: string;
  dispose: () => void;
}

/** Fresh platform + module on a throw-away database. No network, no model. */
export async function createHarness(
  options: {
    withModule?: boolean;
    seed?: boolean;
    /**
     * Replaces the model at the adapter boundary **for the platform's own
     * runtime** — the one `platform.app` routes to.
     *
     * A test that drives the HTTP API through a run needs this: building a
     * second `AgentRuntime` beside the platform gives the stand-in a runtime the
     * routes know nothing about, so a request answered over HTTP (a permission
     * decision, a cancellation) reaches the wrong object and quietly does
     * nothing.
     */
    modelAgent?: ModelAgentLike | null;
  } = {},
): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentic-test-'));
  const env = { ...process.env, APP_DATA_DIR: dataDir };
  const withModule = options.withModule !== false;

  const platform = createPlatform({
    modules: withModule ? (services) => [createProcurementModule(services)] : [],
    env,
    modelAgent: options.modelAgent ?? null,
  });

  const service = new Service(platform.services);

  // Seeded by default so existing tests keep the fixture they were written
  // against; `seed: false` is for tests that need to observe an empty database
  // becoming non-empty.
  if (withModule && options.seed !== false) {
    for (const mod of platform.registry.modules) {
      await mod.seed?.({
        ownerId: DEFAULT_USER_ID,
        storeFile: async (input) => ({
          id: platform.services.files.store({ ownerId: DEFAULT_USER_ID, ...input }).id,
        }),
      });
    }
  }

  return {
    platform,
    service,
    ownerId: DEFAULT_USER_ID,
    otherOwnerId: SECOND_USER_ID,
    dataDir,
    dispose: () => {
      platform.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Signs in over HTTP and returns the cookie header for subsequent calls. */
export async function login(app: PlatformInstance['app'], userId: string): Promise<string> {
  const res = await app.request('/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}

export const caseCode = 'PC-2026-01';
