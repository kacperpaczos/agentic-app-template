import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Readable refusals for everything a browser run needs *before* it starts.
 *
 * Each of these used to fail somewhere deep in the run, in a voice that said
 * nothing: a missing production bundle surfaced as a raw `ERR_MODULE_NOT_FOUND`
 * from `boot-server` — *after* the test database had been wiped and reseeded;
 * a missing Playwright browser surfaced as the launcher's complaint inside the
 * first test that asked for a page. Both are configuration problems a person
 * can fix in one command, and both deserve that command in the message.
 *
 * So the checks live here, at the door: same message family, one command each,
 * and unit-tested (`tests/boot-check.test.ts`) — including the equivalence that
 * the callers refuse on exactly the paths they then use.
 *
 * `pnpm build` at the root builds the web bundle **and then** the server one,
 * so one command in the message is the honest instruction for both.
 */

export const SERVER_BUNDLE_RELATIVE = 'apps/server/dist/server.js';
export const WEB_BUNDLE_RELATIVE = 'apps/web/dist/index.html';

/** A refusal that names the fix, not just the fact. */
export class BootRefusal extends Error {
  constructor(message: string) {
    super(`[e2e] ${message}`);
    this.name = 'BootRefusal';
  }
}

export const serverBundlePath = (repoRoot: string): string => resolve(repoRoot, SERVER_BUNDLE_RELATIVE);
export const webBundlePath = (repoRoot: string): string => resolve(repoRoot, WEB_BUNDLE_RELATIVE);

/**
 * Refuses to boot the production server without its bundle.
 *
 * The point of doing this *before* anything else: `boot-server` wipes and
 * reseeds the test database before the import that would fail. A raw
 * `ERR_MODULE_NOT_FOUND` at that point has already destroyed whatever state a
 * human was looking at, and says nothing about `pnpm build`.
 */
export function assertServerBundle(repoRoot: string): string {
  const bundle = serverBundlePath(repoRoot);
  if (!existsSync(bundle)) {
    throw new BootRefusal(
      `Brak zbudowanego pakietu serwera: nie ma pliku ${bundle}. ` +
        'Uruchom "pnpm build" i sprobuj ponownie. ' +
        '(Bez tej kontroli przebieg skasowalby baze testowa, a dopiero potem ' +
        'padl na surowym ERR_MODULE_NOT_FOUND.)',
    );
  }
  return bundle;
}

/**
 * Refuses to serve tests from a build without a frontend.
 *
 * The server tolerates a missing web bundle and boots anyway — every test then
 * fails on the first selector, minutes into the run, with nothing pointing at
 * the cause. The frontend is checked with the same one command.
 */
export function assertWebBundle(repoRoot: string): string {
  const bundle = webBundlePath(repoRoot);
  if (!existsSync(bundle)) {
    throw new BootRefusal(
      `Brak zbudowanego frontendu: nie ma pliku ${bundle}. ` +
        'Uruchom "pnpm build" i sprobuj ponownie — testy przegladarkowe mialyby ' +
        'czym mowic do serwera, ale nie czym sie pokazywac.',
    );
  }
  return bundle;
}

/**
 * Refuses to start a browser run without the browser.
 *
 * `executablePath()` from `@playwright/test` names the file the launcher will
 * demand; its absence is checked here so the run stops in `globalSetup` with
 * the install command, instead of inside the first test with the library's own
 * complaint.
 */
export function assertBrowserExecutable(executablePath: string, what: string): string {
  if (!existsSync(executablePath)) {
    throw new BootRefusal(
      `Brak przegladarki ${what}: nie ma pliku ${executablePath}. ` +
        `Uruchom "pnpm exec playwright install ${what}" i sprobuj ponownie.`,
    );
  }
  return executablePath;
}
