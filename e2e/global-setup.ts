import { assertIsolatedInstance, resolveTestInstance } from './support/isolation.ts';

/**
 * Last gate before the first test.
 *
 * Preparing the database is *not* done here: Playwright starts `webServer`
 * before this hook, so wiping the data directory at this point would pull the
 * file out from under a server that had already opened it. That work moved to
 * `e2e/support/boot-server.ts`, which runs as the web server command itself.
 *
 * What remains is the check the configuration cannot make: the configuration
 * constrains what this run *asks for*, and this confirms what actually
 * *answered*. If another application held the test port, every test below would
 * write through it — so an unlabelled instance stops the run here, with nothing
 * mutated.
 */
export default async function globalSetup(): Promise<void> {
  const instance = resolveTestInstance({
    repoRoot: import.meta.dirname + '/..',
    dataDirName: '.e2e-data',
    defaultPort: 8799,
  });
  await assertIsolatedInstance(instance.baseUrl);
  console.log(`[e2e] potwierdzono instancje testowa pod ${instance.baseUrl}`);
}
