import { defineConfig, devices } from '@playwright/test';
import { resolveTestInstance } from './e2e/support/isolation.ts';

/**
 * Browser acceptance.
 *
 * Runs against the *production* build served by the backend, not the Vite dev
 * server, so what the tests exercise is what a user would run.
 *
 * Isolated by construction, and the construction is checked rather than
 * assumed: `resolveTestInstance` validates the port, the data directory and the
 * base URL *here*, while the config is being evaluated. A configuration that
 * could reach the user's instance fails at this line — before a server starts,
 * before a directory is created, before a single request goes out. See
 * `e2e/support/isolation.ts` for the three layers and why one is not enough.
 */
const instance = resolveTestInstance({
  repoRoot: import.meta.dirname,
  dataDirName: '.e2e-data',
  defaultPort: 8799,
});

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'docs/evidence/playwright-report' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: instance.baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Prepares the test database and then starts the production bundle on it,
    // in one process. Playwright runs `webServer` before `globalSetup`, so
    // preparing the directory there would delete the database under a server
    // that had already opened it — see `e2e/support/boot-server.ts`.
    command:
      'node --experimental-transform-types --no-warnings=ExperimentalWarning e2e/support/boot-server.ts',
    url: `${instance.baseUrl}/api/health`,
    // Never attach to a server this run did not start. The suite used to reuse
    // one, which is how it ended up writing through the user's instance.
    reuseExistingServer: false,
    timeout: 60_000,
    env: instance.env,
  },
});
