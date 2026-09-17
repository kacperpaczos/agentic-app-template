import { test as base, expect } from '@playwright/test';
import { assertIsolatedInstance, assertTestBaseUrl, TestIsolationError } from './isolation.ts';

/**
 * The `test` every browser spec uses instead of `@playwright/test`'s.
 *
 * It adds one worker-scoped, automatic fixture: before the worker's first test
 * sends anything, the instance that answers `baseURL` must identify itself as
 * one the test suite started. The check is cheap, it runs once per worker, and
 * it closes the last gap the configuration guards cannot — they constrain what
 * this process asks for, not who is listening.
 *
 * Specs that run their own server on another port (the scripted-model suites)
 * call `verifyIsolatedInstance` for their own base URL; the fixture covers the
 * shared instance.
 */
/*
 * `object` and not `Record<string, never>` for the test-scoped fixtures: the
 * latter puts an index signature of `never` on the fixture table, so every
 * entry — including the worker fixture below — is checked against
 * `TestFixture<never, …>` and its `use(): void` no longer fits. The suite adds
 * no test-scoped fixtures, which is what `object` says.
 */
export const test = base.extend<object, { isolatedInstance: void }>({
  isolatedInstance: [
    async ({}, use, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL;
      if (!baseURL) {
        throw new TestIsolationError(
          'Testy nie maja ustawionego baseURL — nie da sie potwierdzic, do ktorej instancji mowia.',
        );
      }
      await assertIsolatedInstance(baseURL);
      await use();
    },
    { scope: 'worker', auto: true },
  ],
});

/**
 * Same check for a suite that starts its own server on its own port.
 *
 * Validates the address first — a spec must not be able to point itself
 * somewhere else — and then that the instance there is labelled as ours.
 */
export async function verifyIsolatedInstance(baseUrl: string, expectedPort: number): Promise<void> {
  assertTestBaseUrl(baseUrl, expectedPort, 'adres instancji scenariuszowej');
  await assertIsolatedInstance(baseUrl);
}

export { expect };
