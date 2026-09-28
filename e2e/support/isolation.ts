import { basename, isAbsolute, relative, resolve } from 'node:path';

/**
 * Configuration guard for the browser suites.
 *
 * The rule it enforces is narrow and absolute: **a test run may only ever talk
 * to a server the test run itself started, on a reserved port, over a data
 * directory that belongs to the tests.** Nothing about that may be reachable by
 * setting an environment variable.
 *
 * It exists because the opposite happened. The suite was once configured with
 * `reuseExistingServer: true` against the default port and the application's own
 * `data/` directory, so running it attached to whatever instance was already
 * listening and wrote through it — three canvas spaces, an uploaded file and a
 * card move landed in a real database, and nothing in the run said so. The
 * defect was not that the wrong value was typed; it was that no value was ever
 * checked.
 *
 * Three independent checks, because each catches what the others cannot:
 *
 *  1. **here, before Playwright starts** — the port, the data directory and the
 *     base URL are validated at config load, so a bad configuration produces a
 *     readable error and *no* server, *no* directory and *no* request;
 *  2. **in the server** (`assertTestInstanceIsIsolated`) — a labelled process
 *     refuses to boot near real data even when something other than this
 *     harness spawns it;
 *  3. **at run time** (`assertIsolatedInstance`) — the suite asks the instance
 *     that actually answered whether it is one of ours, before the first test.
 */

/*
 * Restated here rather than imported from `@platform/server`, because this
 * module is loaded by `playwright.config.ts` before anything else and must not
 * drag the whole server package (and its native database binding) into config
 * evaluation. `tests/isolation.test.ts` asserts the two definitions are equal,
 * so they cannot drift apart unnoticed.
 */

/** Label every server started by this repository's test suites carries. */
export const TEST_INSTANCE_LABEL = 'agenticapp-test';

/** Ports reserved for automated tests; deliberately above the app default. */
export const TEST_PORT_RANGE = { from: 8792, to: 8799 } as const;

/** Port the application uses when nobody configures one; never a test port. */
export const DEFAULT_APP_PORT = 8791;

export class TestIsolationError extends Error {
  constructor(message: string) {
    super(
      `[izolacja testow] ${message}\n` +
        'Zadna operacja nie zostala wykonana. Testy nie moga uzywac instancji ani danych uzytkownika.',
    );
    this.name = 'TestIsolationError';
  }
}

/** A port the test suites own. The application's default port is excluded. */
export function assertTestPort(port: number, what: string): number {
  if (!Number.isInteger(port)) {
    throw new TestIsolationError(`${what}: "${port}" nie jest numerem portu.`);
  }
  if (port === DEFAULT_APP_PORT) {
    throw new TestIsolationError(
      `${what}: ${port} to domyslny port aplikacji — tam moze dzialac instancja uzytkownika.`,
    );
  }
  if (port < TEST_PORT_RANGE.from || port > TEST_PORT_RANGE.to) {
    throw new TestIsolationError(
      `${what}: ${port} jest poza zakresem zarezerwowanym dla testow ` +
        `(${TEST_PORT_RANGE.from}-${TEST_PORT_RANGE.to}).`,
    );
  }
  return port;
}

/**
 * A directory the test suites own.
 *
 * Must be inside the repository and named `.e2e*`. The containment check is the
 * one that matters for deletion: `globalSetup` removes this directory outright,
 * and a relative path resolved from an unexpected working directory is exactly
 * how such a call reaches somewhere it should not.
 */
export function assertTestDataDir(dir: string, repoRoot: string, what: string): string {
  const abs = resolve(dir);
  if (!isAbsolute(abs)) throw new TestIsolationError(`${what}: "${dir}" nie jest sciezka bezwzgledna.`);

  const rel = relative(resolve(repoRoot), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new TestIsolationError(`${what}: ${abs} lezy poza katalogiem repozytorium (${repoRoot}).`);
  }
  if (rel === '') {
    throw new TestIsolationError(`${what}: ${abs} to katalog glowny repozytorium.`);
  }
  if (!basename(abs).startsWith('.e2e')) {
    throw new TestIsolationError(
      `${what}: ${abs} nie nazywa sie jak katalog testowy (wymagany prefiks ".e2e").`,
    );
  }
  if (abs === resolve(repoRoot, 'data')) {
    throw new TestIsolationError(`${what}: ${abs} to katalog danych aplikacji.`);
  }
  return abs;
}

/** The suite addresses its own loopback instance and nothing else. */
export function assertTestBaseUrl(raw: string, expectedPort: number, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TestIsolationError(`${what}: "${raw}" nie jest poprawnym adresem URL.`);
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new TestIsolationError(
      `${what}: ${url.origin} nie jest adresem petli zwrotnej — testy nie wychodza poza localhost.`,
    );
  }
  const port = Number(url.port);
  if (port !== expectedPort) {
    throw new TestIsolationError(
      `${what}: ${url.origin} wskazuje port ${url.port || '(domyslny)'}, ` +
        `a instancja testowa dziala na ${expectedPort}. ` +
        'Testy musialyby wyslac zadania do cudzej instancji.',
    );
  }
  return url.origin;
}

export interface TestInstanceConfig {
  port: number;
  dataDir: string;
  baseUrl: string;
  repoRoot: string;
  /** Environment for a server process the suite starts itself. */
  env: Record<string, string>;
}

/**
 * Resolves and validates the configuration of one isolated test instance.
 *
 * `APP_BASE_URL` is honoured but not trusted: it may only ever name the instance
 * this same call is describing. Pointing the suite at a different origin is the
 * single environment variable that would silently send every request to the
 * user's application, so it is checked rather than obeyed.
 */
export function resolveTestInstance(input: {
  repoRoot: string;
  dataDirName: string;
  defaultPort: number;
  env?: NodeJS.ProcessEnv;
  webDist?: string;
}): TestInstanceConfig {
  const env = input.env ?? process.env;
  const repoRoot = resolve(input.repoRoot);
  const port = assertTestPort(
    Number(env.APP_E2E_PORT ?? input.defaultPort),
    'port instancji testowej (APP_E2E_PORT)',
  );
  const dataDir = assertTestDataDir(
    resolve(repoRoot, input.dataDirName),
    repoRoot,
    'katalog danych testow',
  );
  const baseUrl = assertTestBaseUrl(
    env.APP_BASE_URL ?? `http://127.0.0.1:${port}`,
    port,
    'adres bazowy testow (APP_BASE_URL)',
  );

  return {
    port,
    dataDir,
    baseUrl,
    repoRoot,
    env: {
      PORT: String(port),
      APP_DATA_DIR: dataDir,
      APP_INSTANCE_LABEL: TEST_INSTANCE_LABEL,
      APP_WEB_DIST: input.webDist ?? resolve(repoRoot, 'apps/web/dist'),
      APP_ALLOWED_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
    },
  };
}

/**
 * Confirms that the instance which actually answered is one of ours.
 *
 * The configuration checks above constrain what this process asks for; this one
 * checks what replied. An unlabelled answer means something else is listening on
 * the test port — the suite stops rather than write through it.
 */
export async function assertIsolatedInstance(baseUrl: string): Promise<void> {
  let body: { ok?: boolean; instanceLabel?: string | null };
  try {
    const res = await fetch(`${baseUrl}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (e) {
    throw new TestIsolationError(
      `Instancja testowa pod ${baseUrl} nie odpowiada na /api/health (${(e as Error).message}).`,
    );
  }
  if (body.instanceLabel !== TEST_INSTANCE_LABEL) {
    throw new TestIsolationError(
      `Pod ${baseUrl} odpowiada instancja bez etykiety testowej ` +
        `(instanceLabel=${JSON.stringify(body.instanceLabel)}, oczekiwano ${JSON.stringify(TEST_INSTANCE_LABEL)}). ` +
        'To moze byc instancja uzytkownika — testy nie beda przez nia pisac.',
    );
  }
}
