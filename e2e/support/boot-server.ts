import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTestInstance } from './isolation.ts';

/**
 * Prepares the browser suite's database and then starts the production server
 * on it — in that order, in one process.
 *
 * The order is the point. Playwright starts `webServer` as a plugin task, which
 * runs *before* `globalSetup`; preparing the data directory in `globalSetup`
 * therefore deleted and recreated the database file underneath a server that
 * had already opened it, leaving the process holding an unlinked inode while
 * the tests read a different file at the same path. Doing both here removes the
 * race rather than papering over it: nothing is running when the directory is
 * wiped, and the server opens the database only once it has been migrated and
 * seeded.
 *
 * Everything this touches comes back from `resolveTestInstance`, which refuses
 * any port, directory or base URL that is not demonstrably the tests' own. The
 * server that then boots is the real production bundle — only its environment
 * is ours.
 */
const instance = resolveTestInstance({
  repoRoot: resolve(import.meta.dirname, '../..'),
  dataDirName: process.env.APP_E2E_DATA_DIR_NAME ?? '.e2e-data',
  defaultPort: 8799,
});

if (existsSync(instance.dataDir)) rmSync(instance.dataDir, { recursive: true, force: true });

for (const script of ['migrate', 'seed']) {
  execFileSync('pnpm', [script], {
    cwd: instance.repoRoot,
    stdio: 'inherit',
    // An explicit environment, not the inherited one: an `APP_DATA_DIR` left in
    // the shell must not be able to redirect the migration.
    env: { ...process.env, ...instance.env },
  });
}

for (const [key, value] of Object.entries(instance.env)) process.env[key] = value;

console.log(
  `[e2e] instancja testowa: port=${instance.port} data=${instance.dataDir} etykieta=${instance.env.APP_INSTANCE_LABEL}`,
);

await import(resolve(instance.repoRoot, 'apps/server/dist/server.js'));
