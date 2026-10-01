import { basename, isAbsolute, relative, resolve } from 'node:path';
import { isSymlink, realResolve } from '../../packages/platform-server/src/util/real-path.ts';

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

/**
 * Identifier of *this* run, carried by the servers it starts.
 *
 * The label answers "is this a test instance"; it is the same string for every
 * test instance ever started, so it cannot answer "is this **my** test
 * instance". A scripted server orphaned by an interrupted run answers the
 * health check with the same label as the one this run meant to start, and the
 * identity check accepted it — on a database this run had just deleted.
 *
 * One value per process, generated once and passed to every server this process
 * spawns, so the question has an answer that a survivor of an earlier run
 * cannot give.
 */
export const TEST_RUN_ID = `${process.pid.toString(36)}-${Date.now().toString(36)}`;

/** Ports reserved for automated tests; deliberately above the app default. */
export const TEST_PORT_RANGE = { from: 8792, to: 8799 } as const;

/** Port the application uses when nobody configures one; never a test port. */
export const DEFAULT_APP_PORT = 8791;

/**
 * Rezerwacja portów scenariuszowych: port → katalog danych instancji
 * skryptowanej, która ten port nosi (porty wyprowadzone z `e2e/*.spec.ts`,
 * stan na 2026-09-28). Port 8799 jest jedynym testowym portem poza listą —
 * należy do instancji współdzielonej zestawu (`APP_E2E_PORT`, `.e2e-data`).
 *
 * Rezerwacja istnieje, bo zderzenie tych dwóch światów zdarzyło się po cichu:
 * uruchomienie z `APP_E2E_PORT` pokrywającym port scenariuszowy powołało
 * współdzieloną instancję na porcie scenariuszowym, a kontrola etykiety (i
 * run-id — obie instancje należały do tego samego uruchomienia) przepuściła ją.
 * Zderzenie jest teraz odrzucane przy ładowaniu konfiguracji (nizej).
 */
export const SCENARIO_PORTS = {
  8793: '.e2e-scripted-uinav',
  8794: '.e2e-scripted-tasks',
  8795: '.e2e-scripted-restore / .e2e-scripted-taskcenter / .e2e-real-t15',
  8796: '.e2e-scripted-glm / .e2e-scripted-stream / .e2e-scripted-continuity-limit',
  8797: '.e2e-scripted-l97 / .e2e-scripted-reconnect / .e2e-real-bl03',
  8798: '.e2e-scripted-* (większość speców scenariuszowych)',
} as const;

export const SHARED_DATA_DIR_NAME = '.e2e-data';

/** Fake GLM settings for scripted, model-free browser runs only. */
export const scriptedGlmEnv = (repoRoot: string): Record<string, string> => ({
  APP_MODEL_PROVIDER: 'glm',
  APP_MODEL: 'glm-test-model',
  ANTHROPIC_BASE_URL: 'https://glm.endpoint.invalid',
  ANTHROPIC_AUTH_TOKEN: 'FAKE-GLM-TOKEN-TEST-ONLY',
  CLAUDE_CONFIG_DIR: resolve(repoRoot, '.e2e-glm-config'),
});

export function scenarioPortOwner(port: number): string | null {
  return (SCENARIO_PORTS as Record<number, string>)[port] ?? null;
}

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
 *
 * **Every check is made twice**: once on the path as written and once on where
 * it really points. Until it was, the whole guard was a statement about text —
 * a `.e2e-data` that is a symbolic link to the user's `data/` satisfied all
 * three conditions above (inside the repository, named `.e2e*`, not literally
 * `data`) and the labelled test instance then wrote into the user's database.
 * The link is refused outright as well, because the harness *deletes* this
 * directory and no guard should rest on whether a delete follows a link or
 * removes it.
 */
export function assertTestDataDir(dir: string, repoRoot: string, what: string): string {
  const abs = resolve(dir);
  if (!isAbsolute(abs)) throw new TestIsolationError(`${what}: "${dir}" nie jest sciezka bezwzgledna.`);

  if (isSymlink(abs)) {
    throw new TestIsolationError(
      `${what}: ${abs} jest dowiazaniem symbolicznym (wskazuje ${realResolve(abs)}). ` +
        'Katalog testowy musi byc prawdziwym katalogiem — testy go kasuja.',
    );
  }

  const realRepo = realResolve(repoRoot);
  const real = realResolve(abs);
  /*
   * Both spellings are checked against both roots: the written path against the
   * written root, and the real path against the real root. Checking only one
   * pair leaves the other as the way through.
   */
  for (const [candidate, root] of [
    [abs, resolve(repoRoot)],
    [real, realRepo],
  ] as const) {
    const rel = relative(root, candidate);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new TestIsolationError(
        `${what}: ${candidate} lezy poza katalogiem repozytorium (${root}).` +
          (candidate === real && real !== abs ? ` Sciezka ${abs} wskazuje tam przez dowiazanie.` : ''),
      );
    }
    if (rel === '') {
      throw new TestIsolationError(`${what}: ${candidate} to katalog glowny repozytorium.`);
    }
    if (!basename(candidate).startsWith('.e2e')) {
      throw new TestIsolationError(
        `${what}: ${candidate} nie nazywa sie jak katalog testowy (wymagany prefiks ".e2e").` +
          (candidate === real && real !== abs ? ` To rzeczywisty cel ${abs}.` : ''),
      );
    }
  }
  if (abs === resolve(repoRoot, 'data') || real === resolve(realRepo, 'data')) {
    throw new TestIsolationError(`${what}: ${abs} to katalog danych aplikacji (${real}).`);
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
  // Kolizja portów scenariuszowych: instancja współdzielona nie może wstać na
  // porcie, który należy do instancji skryptowanej innego specu — kontrola
  // etykiety (i run-id, bo obie instancje pochodzą z tego samego uruchomienia)
  // nie odróżnia ich; dane scenariusza byłyby wtedy czytane/pisane przez zły
  // zestaw (port z audytu 2026-09-28).
  const owner = scenarioPortOwner(port);
  if (env.APP_E2E_PORT !== undefined && owner) {
    throw new TestIsolationError(
      `APP_E2E_PORT=${port} jest zarezerwowany dla instancji scenariuszowej ` +
        `(${owner}). Instancja współdzielona działa na porcie 8799 ` +
        `(${SHARED_DATA_DIR_NAME}). Zadna operacja nie zostala wykonana.`,
    );
  }
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
      // Identifies this run, so a server left over from an earlier one cannot
      // pass for the server this run just started. See TEST_RUN_ID.
      APP_INSTANCE_RUN_ID: TEST_RUN_ID,
      APP_WEB_DIST: input.webDist ?? resolve(repoRoot, 'apps/web/dist'),
      APP_ALLOWED_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
    },
  };
}

/**
 * The label an instance gives for itself, or a description of why it could not
 * be asked.
 *
 * Separated from the assertion below because the same question — *who is
 * actually listening there?* — is asked by two callers with different powers to
 * act on the answer: a test suite, which must stop, and the development proxy
 * (`apps/web/src/dev-proxy.ts`), which must refuse to forward a request and say
 * so in the response. One reading of `/api/health`, two policies.
 */
export async function readInstanceLabel(
  baseUrl: string,
): Promise<{ label: string | null; runId: string | null } | { unreachable: string }> {
  try {
    /*
     * `redirect: 'error'` and a deadline, for the same two reasons as in
     * `scripts/lib/acceptance-target.mjs`: an answer that came from a redirect
     * describes a different server than the one the caller is about to use, and
     * a target that accepts the connection and never replies would hang the
     * run instead of being refused.
     */
    const res = await fetch(`${baseUrl}/api/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      ok?: boolean;
      instanceLabel?: string | null;
      instanceRunId?: string | null;
    };
    return { label: body.instanceLabel ?? null, runId: body.instanceRunId ?? null };
  } catch (e) {
    return { unreachable: (e as Error).message };
  }
}

/**
 * Confirms that the instance which actually answered carries the expected
 * label.
 *
 * The configuration checks above constrain what this process asks for; this one
 * checks what replied. An unlabelled answer means something else is listening on
 * that port — the caller stops rather than write through it.
 */
export async function assertInstanceLabel(
  baseUrl: string,
  expected: string,
  what: string,
  /**
   * Identifier this run's own servers carry. Passed by a caller that started
   * the server itself; omitted where the instance may legitimately come from
   * elsewhere (a `webServer` Playwright started in another process).
   */
  expectedRunId?: string,
): Promise<void> {
  const answer = await readInstanceLabel(baseUrl);
  if ('unreachable' in answer) {
    throw new TestIsolationError(`${what} pod ${baseUrl} nie odpowiada na /api/health (${answer.unreachable}).`);
  }
  if (answer.label !== expected) {
    throw new TestIsolationError(
      `Pod ${baseUrl} odpowiada instancja z inna etykieta ` +
        `(instanceLabel=${JSON.stringify(answer.label)}, oczekiwano ${JSON.stringify(expected)}). ` +
        'To moze byc instancja uzytkownika — nie bedziemy przez nia pisac.',
    );
  }
  if (expectedRunId !== undefined && answer.runId !== expectedRunId) {
    throw new TestIsolationError(
      `Pod ${baseUrl} odpowiada instancja testowa Z INNEGO PRZEBIEGU ` +
        `(instanceRunId=${JSON.stringify(answer.runId)}, oczekiwano ${JSON.stringify(expectedRunId)}). ` +
        'Etykieta jest wspolna dla wszystkich instancji testowych, wiec sama nie odroznia serwera ' +
        'osieroconego po przerwanym przebiegu od tego, ktory ten przebieg wlasnie uruchomil. ' +
        'Zatrzymaj tamten proces po jego pid i uruchom przebieg ponownie.',
    );
  }
}

/**
 * The test suites' own policy: only an instance this repository's tests started.
 *
 * `runId` is checked when the caller started the server itself and can
 * therefore say which run it belongs to.
 */
export async function assertIsolatedInstance(baseUrl: string, expectedRunId?: string): Promise<void> {
  await assertInstanceLabel(baseUrl, TEST_INSTANCE_LABEL, 'Instancja testowa', expectedRunId);
}
