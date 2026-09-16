import { mkdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const int = (v: string | undefined, d: number) => {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : d;
};

export interface PlatformConfig {
  dataDir: string;
  dbFile: string;
  filesDir: string;
  workspacesDir: string;
  port: number;
  /** Origins allowed to call the API with credentials. */
  allowedOrigins: string[];
  /** Static bundle served in production; absent in dev. */
  webDistDir: string | null;
  model: string;
  /** Hard ceiling for a single agent run. */
  runTimeoutMs: number;
  maxUploadBytes: number;
  /**
   * Set by automated tests (`APP_INSTANCE_LABEL`), never in production.
   *
   * Two things depend on it. `/api/health` echoes it, so a test can prove it is
   * talking to an instance the test suite started rather than to one the user
   * has open; and `assertTestInstanceIsIsolated` below refuses to start a
   * labelled process anywhere near real data.
   */
  instanceLabel: string | null;
}

/** Label every server started by this repository's test suites carries. */
export const TEST_INSTANCE_LABEL = 'agenticapp-test';

/**
 * Ports reserved for automated tests.
 *
 * Starts above the application's default port (8791) so that a labelled test
 * instance cannot bind the port a user's instance listens on — the range is the
 * check, rather than a special case somewhere that could be forgotten.
 */
export const TEST_PORT_RANGE = { from: 8792, to: 8799 } as const;

/**
 * Refuses to run a test-labelled instance against anything that could be real.
 *
 * The guard lives here — in the product, at the point where the data directory
 * and the port are decided — and not only in the test harness, because the
 * failure it prevents is a *configuration* failure: an `APP_DATA_DIR` inherited
 * from the shell, a stale `PORT`, a config that resolved its relative path from
 * the wrong working directory. A harness that guards its own inputs still
 * misses every one of those the moment something else spawns the server.
 *
 * Deliberately fatal rather than corrective: silently redirecting a misconfigured
 * test to a safe directory would hide the misconfiguration and let the next
 * caller inherit it.
 */
export function assertTestInstanceIsIsolated(cfg: PlatformConfig, defaultDataDir: string): void {
  if (cfg.instanceLabel !== TEST_INSTANCE_LABEL) return;
  const problems: string[] = [];

  if (cfg.port < TEST_PORT_RANGE.from || cfg.port > TEST_PORT_RANGE.to) {
    problems.push(
      `port ${cfg.port} jest poza zakresem zarezerwowanym dla testow ` +
        `(${TEST_PORT_RANGE.from}-${TEST_PORT_RANGE.to})`,
    );
  }
  if (cfg.dataDir === defaultDataDir) {
    problems.push(`katalog danych ${cfg.dataDir} to domyslny katalog aplikacji`);
  }
  if (!basename(cfg.dataDir).startsWith('.e2e')) {
    problems.push(
      `katalog danych ${cfg.dataDir} nie nazywa sie jak katalog testowy ` +
        '(wymagany prefiks ".e2e" w nazwie katalogu)',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `[izolacja testow] Instancja oznaczona jako testowa (APP_INSTANCE_LABEL=${TEST_INSTANCE_LABEL}) ` +
        `nie moze wystartowac z ta konfiguracja:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\nUstaw PORT w zakresie ${TEST_PORT_RANGE.from}-${TEST_PORT_RANGE.to} oraz APP_DATA_DIR na katalog ` +
        'o nazwie zaczynajacej sie od ".e2e". Zadna operacja nie zostala wykonana.',
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const defaultDataDir = resolve(process.cwd(), 'data');
  const dataDir = resolve(env.APP_DATA_DIR ?? defaultDataDir);
  const cfg: PlatformConfig = {
    dataDir,
    dbFile: resolve(dataDir, 'app.db'),
    filesDir: resolve(dataDir, 'files'),
    workspacesDir: resolve(dataDir, 'workspaces'),
    port: int(env.PORT, 8791),
    allowedOrigins: (env.APP_ALLOWED_ORIGINS ??
      'http://localhost:5173,http://127.0.0.1:5173,http://localhost:8791,http://127.0.0.1:8791')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    webDistDir: env.APP_WEB_DIST ? resolve(env.APP_WEB_DIST) : null,
    model: env.APP_MODEL ?? 'claude-sonnet-4-5',
    runTimeoutMs: int(env.APP_RUN_TIMEOUT_MS, 300_000),
    maxUploadBytes: int(env.APP_MAX_UPLOAD_BYTES, 8 * 1024 * 1024),
    instanceLabel: env.APP_INSTANCE_LABEL ?? null,
  };
  // Before `mkdirSync`: a misconfigured test instance must not even create a
  // directory next to real data, let alone open the database there.
  assertTestInstanceIsIsolated(cfg, defaultDataDir);
  for (const d of [cfg.dataDir, cfg.filesDir, cfg.workspacesDir]) {
    mkdirSync(d, { recursive: true });
  }
  return cfg;
}
