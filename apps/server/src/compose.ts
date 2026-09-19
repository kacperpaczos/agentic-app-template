import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPlatform,
  type ModelAgentLike,
  type PlatformInstance,
  type SessionProbe,
} from '@platform/server';
import { createProcurementModule } from '@module/procurement/server';

/** Repository-root `data/`, regardless of the working directory a script runs from. */
export const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../data');

/**
 * Application composition root (server half).
 *
 * The only file that knows both the platform and the business module. The
 * module is built from the platform's own services through the factory form of
 * `createPlatform`, which is what allows `@platform/*` to contain no import of
 * `@module/*` at all — verified by `scripts/check-boundaries.mjs`.
 */
export function composeApp(
  options: {
    modules?: 'all' | 'none';
    dataDir?: string;
    /** Test harnesses only; production never sets this. */
    modelAgent?: ModelAgentLike | null;
    /** Test harnesses only; production probes the real SDK session. */
    sessionProbe?: SessionProbe | null;
  } = {},
): PlatformInstance {
  const env = { ...process.env, APP_DATA_DIR: options.dataDir ?? process.env.APP_DATA_DIR ?? dataDir };
  const modelAgent = options.modelAgent ?? null;
  const sessionProbe = options.sessionProbe ?? null;
  if (options.modules === 'none') {
    return createPlatform({ modules: [], env, modelAgent, sessionProbe });
  }
  return createPlatform({
    modules: (services) => [createProcurementModule(services)],
    env,
    modelAgent,
    sessionProbe,
  });
}
