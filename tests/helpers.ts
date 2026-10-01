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

/** Fake provider configuration for tests that never call a real model. */
export const testGlmEnv = (dataDir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  APP_DATA_DIR: dataDir,
  APP_MODEL_PROVIDER: 'glm',
  APP_MODEL: 'glm-test-model',
  ANTHROPIC_BASE_URL: 'https://glm.endpoint.invalid',
  ANTHROPIC_AUTH_TOKEN: 'FAKE-GLM-TOKEN-TEST-ONLY',
  CLAUDE_CONFIG_DIR: dataDir,
});

/** Fresh platform + module on a throw-away database. No network, no model. */
export async function createHarness(
  options: {
    withModule?: boolean;
    seed?: boolean;
    /**
     * Installs a stand-in model in the platform's **own** runtime — the one
     * `platform.app` is wired to.
     *
     * Necessary whenever a test drives runs *and* calls the HTTP API about
     * them: a runtime built beside the platform has different pending consents,
     * different live streams and a different conversation queue, so an endpoint
     * asked about a run of that other runtime answers about nothing — quietly,
     * which is the worst way to be wrong.
     *
     * Results obtained this way are simulations and are reported as such.
     */
    modelAgent?: ModelAgentLike | null;
  } = {},
): Promise<Harness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentic-test-'));
  const env = testGlmEnv(dataDir);
  const withModule = options.withModule !== false;

  const platform = createPlatform({
    modules: withModule ? (services) => [createProcurementModule(services)] : [],
    env,
    ...(options.modelAgent !== undefined ? { modelAgent: options.modelAgent } : {}),
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
