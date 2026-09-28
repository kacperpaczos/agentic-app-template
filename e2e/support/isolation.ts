import { readFileSync, writeFileSync } from 'node:fs';
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
 * Cztery niezalezne warstwy kontroli, bo kazda lapie to, czego nie lapie
 * zadna inna:
 *
 *  1. **tu, zanim Playwright wstanie** — port, katalog danych i adres bazowy
 *     sa sprawdzane przy ladowaniu konfiguracji, wiec zla konfiguracja daje
 *     czytelny blad i *zadnego* serwera, *zadnego* katalogu i *zadnego*
 *     zadania;
 *  2. **w serwerze** (`assertTestInstanceIsIsolated`) — oznaczony proces odmowi
 *     startu obok prawdziwych danych, nawet kiedy odpala go cos innego niz ten
 *     harness;
 *  3. **w czasie biegu, po etykiecie** (`assertIsolatedInstance`) — zestaw
 *     pyta instancje, ktora faktycznie odpowiedziala, czy jest nasza, zanim
 *     ruszy pierwszy test;
 *  4. **w czasie biegu, po tozsamosci** (`assertInstanceIdentity`) — sama
 *     etykieta przestala wystarczac, kiedy w tym repozytorium zaczelo naraz
 *     dzialac kilka instancji testowych: wszystkie ja nosza. Kazda instancja
 *     zapisuje wiec przy starcie plik tozsamosci (port, katalog danych, pid)
 *     we *wlasnym* katalogu danych, a zestaw porownuje ten plik z tym, o co
 *     prosil. Instancja, ktora odpowie na zarezerwowanym porcie bez pliku z
 *     tego przebiegu — zostalosc po zabitym uruchomieniu, skryptowany serwer
 *     sasiedniego zestawu — zatrzymuje zestaw tutaj, zamiast cicho przejac jego
 *     ruch.
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

/**
 * JEDNA lista rezerwacji portow scenariuszowych: port → katalog danych, ktory
 * instancja scenariuszowa na tym porcie nosi.
 *
 * Skryptowane instancje (`ScriptedInstance` w e2e/support/scripted.ts) startuja
 * na wlasnych portach, obok wspoldzielonej instancji zestawu. Rezerwacja istnieje
 * dlatego, ze zderzenie tych dwoch swiatow zdarzylo sie po cichu: uruchomienie
 * z `APP_E2E_PORT=8794` i background-tasks.spec powolalo wspoldzielona instancje
 * na porcie scenariuszowym, a `verifyIsolatedInstance` przepuscilo ja, bo ta sama
 * etykieta `agenticapp-test` jest i u niej. Testy rozmawialy wtedy ze
 * wspoldzielona instancja — z prawdziwym modelem — mimo scenariusza, ktory ma
 * model zastepowany. Zderzenie jest teraz odrzucane przy ladowaniu konfiguracji,
 * a run-time potwierdza tozsamosc plikiem z tozsamoscia instancji (nizej).
 *
 * Port 8799 jest jedynym portem testowym poza ta lista — nalezy do instancji
 * wspoldzielonej (`.e2e-data`). Nowy zestaw scenariuszowy bierze port stad, a
 * nie wymysla wlasny.
 */
export const SCENARIO_PORTS = {
  8792: '.e2e-scripted-filter', // view-filter.spec.ts
  8793: '.e2e-scripted-uinav', // ui-navigation.spec.ts
  8794: '.e2e-scripted-tasks', // background-tasks.spec.ts
  8795: '.e2e-scripted-restore', // session-restore.spec.ts
  8796: '.e2e-scripted-stream', // streaming.spec.ts
  8797: '.e2e-scripted-slow', // measurements.spec.ts
  8798: '.e2e-scripted', // tool-activity.spec.ts
} as const;

type ScenarioDataDir = (typeof SCENARIO_PORTS)[keyof typeof SCENARIO_PORTS];

/** Katalog danych zarezerwowany dla tego portu scenariuszowego, albo null. */
export function scenarioPortOwner(port: number): ScenarioDataDir | null {
  return (SCENARIO_PORTS as Record<number, ScenarioDataDir>)[port] ?? null;
}

/** Katalog danych instancji wspoldzielonej — tej, o ktora pyta `baseURL` zestawu. */
export const SHARED_DATA_DIR_NAME = '.e2e-data';

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
 * Sklada i sprawdza konfiguracje jednej izolowanej instancji testowej.
 *
 * `APP_BASE_URL` jest honorowany, ale nieufny: moze wylacznie nazywac instancje,
 * ktora to wlasnie wywolanie opisuje. Skierowanie zestawu na cudze zrodlo to
 * jedna zmienna srodowiskowa, ktora po cichu wyslalaby kazde zadanie do aplikacji
 * uzytkownika — jest sprawdzana, a nie wykonywana.
 *
 * Porty scenariuszowe sa chronione dwojako, bo zderzenie zdarzylo sie po cichu
 * (`APP_E2E_PORT=8794` + background-tasks: wspoldzielona instancja na porcie
 * scenariuszowym, przepuszczona przez kontrole etykiety, z prawdziwym modelem):
 *
 *  - `APP_E2E_PORT` nie moze nazywac portu z `SCENARIO_PORTS` — nadpisanie jest
 *    wlasciwoscia instancji wspoldzielonej, a scenariuszowe i tak go ignoruja
 *    (przekazuja wlasne `env`), wiec taka wartosc mialaby tylko jeden skutek:
 *    cicha kolizja;
 *  - instancja na porcie scenariuszowym musi nosic katalog danych z rezerwacji —
 *    port i katalog to razem tozsamosc scenariusza, a rozjazd miedzy nimi znaczy,
 *    ze dwa zestawy dealokowaly te sama pare na dwa sposoby.
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
  const override = env.APP_E2E_PORT;
  const port = assertTestPort(
    Number(override ?? input.defaultPort),
    'port instancji testowej (APP_E2E_PORT)',
  );
  const scenarioOwner = scenarioPortOwner(port);
  if (override !== undefined && scenarioOwner !== null) {
    throw new TestIsolationError(
      `port instancji testowej (APP_E2E_PORT): ${port} jest zarezerwowany dla instancji ` +
        `scenariuszowej z katalogiem danych "${scenarioOwner}". Wspoldzielona instancja testow ` +
        'na tym porcie zderzylaby sie z instancja scenariusza, a kontrola etykiety przepuscilaby ' +
        'je obie — etykieta jest wspolna. ' +
        `Usun APP_E2E_PORT albo ustaw ${TEST_PORT_RANGE.to} — jedyny port poza rezerwacja scenariuszowa.`,
    );
  }
  if (scenarioOwner !== null && input.dataDirName !== scenarioOwner) {
    throw new TestIsolationError(
      `port ${port} jest zarezerwowany dla instancji scenariuszowej z katalogiem danych ` +
        `"${scenarioOwner}", a ta konfiguracja deklaruje katalog "${input.dataDirName}". ` +
        'Para port + katalog danych instancji scenariuszowej musi pasowac do rezerwacji w SCENARIO_PORTS.',
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
      APP_WEB_DIST: input.webDist ?? resolve(repoRoot, 'apps/web/dist'),
      APP_ALLOWED_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
    },
  };
}

/* --------------------- tozsamosc instancji (plik) ------------------------- */

/**
 * To, co `/api/health` celowo nie mowi: gdzie ta instancja trzyma dane.
 *
 * Produkt w /api/health raportuje wylacznie etykiete i swiadomie nie zdradza
 * katalogu danych (endpoint jest nieuwierzytelniony). To wystarczylo, dopoki
 * instancja testowa byla jedna; przy kilku naraz etykieta przestala rozdziac
 * instancje — wszystkie ja nosza, co pokazalo zderzenie APP_E2E_PORT=8794 z
 * background-tasks. Zamiast zmieniac API produktu, kazda instancja testowa
 * zapisuje przy starcie plik `instance-<port>.json` we WLASNYM katalogu danych:
 * port, katalog, pid. Plik jest dowodem, ze ten proces wystartowal nad tymi
 * danymi — i ze zrobil to ten przebieg testow, bo kazdy przebieg najpierw kasuje
 * katalog, w ktorym plik lezy.
 */
export interface InstanceIdentity {
  port: number;
  dataDir: string;
  instanceLabel: string | null;
  pid: number;
  startedAt: string;
}

/** Plik tozsamosci instancji na tym porcie, w jej wlasnym katalogu danych. */
export function instanceIdentityFile(dataDir: string, port: number): string {
  return resolve(dataDir, `instance-${port}.json`);
}

/**
 * Zapisuje tozsamosc instancji przy starcie. Robia to dwa miejsca, oba w
 * momencie, w ktorym instancja zaczyna wladac portem: boot-server (instancja
 * wspoldzielona) i scripted-server (instancje scenariuszowe, po udanym bindowaniu).
 */
export function recordInstanceIdentity(identity: {
  port: number;
  dataDir: string;
  instanceLabel: string | null;
  pid?: number;
}): InstanceIdentity {
  if (identity.instanceLabel !== TEST_INSTANCE_LABEL) {
    throw new TestIsolationError(
      `instancja na porcie ${identity.port} nie nosi etykiety testowej ` +
        `(instanceLabel=${JSON.stringify(identity.instanceLabel)}) — to nie jest instancja, ` +
        'ktora testy moga odpalic ani potwierdzic.',
    );
  }
  assertTestPort(identity.port, 'port instancji testowej');
  const full: InstanceIdentity = {
    port: identity.port,
    dataDir: resolve(identity.dataDir),
    instanceLabel: identity.instanceLabel,
    pid: identity.pid ?? process.pid,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(instanceIdentityFile(full.dataDir, full.port), JSON.stringify(full, null, 2));
  return full;
}

/**
 * Dowod tozsamosci: port, o ktory prosza testy, zostal zajety w TYM przebiegu
 * przez instancje nad TYM katalogiem danych.
 *
 * Sprawdzenie jest instancjoswoiste i dlatego lapie to, czego nie lapie etykieta:
 * instancja bez pliku (ktoś cudzy na zarezerwowanym porcie), z niezgodnym
 * katalogiem (wspoldzielona instancja na porcie scenariuszowym — zderzenie z
 * P1-A), z plikiem po martwym procesie (zostalosc, ktora przejela port po
 * zabitym uruchomieniu).
 */
export function assertInstanceIdentity(input: {
  port: number;
  expectedDataDir: string;
}): InstanceIdentity {
  const expectedDataDir = resolve(input.expectedDataDir);
  const file = instanceIdentityFile(expectedDataDir, input.port);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new TestIsolationError(
      `Na porcie ${input.port} odpowiada instancja, ktora nie zapisala swojej tozsamosci w ` +
        `${file}. Ten plik powstaje wlasnie przy starcie instancji testowej i kasowany razem ` +
        'z katalogiem danych przed kazdym uruchomieniem, wiec jego brak znaczy, ze odpowiada ' +
        'proces z innego (np. niezakonczonego) uruchomienia testow albo serwer, ktorego ten ' +
        'harness nie odpalil.',
    );
  }
  let marker: InstanceIdentity;
  try {
    marker = JSON.parse(raw) as InstanceIdentity;
  } catch {
    throw new TestIsolationError(`Plik tozsamosci instancji ${file} nie jest poprawnym JSON-em.`);
  }
  if (marker.port !== input.port) {
    throw new TestIsolationError(
      `Plik tozsamosci ${file} mowi o porcie ${marker.port}, a pytasz o porcie ${input.port}.`,
    );
  }
  if (marker.instanceLabel !== TEST_INSTANCE_LABEL) {
    throw new TestIsolationError(
      `Plik tozsamosci ${file} nazywa instancje bez etykiety testowej ` +
        `(instanceLabel=${JSON.stringify(marker.instanceLabel)}).`,
    );
  }
  if (resolve(marker.dataDir) !== expectedDataDir) {
    throw new TestIsolationError(
      `Na porcie ${input.port} odpowiada instancja z katalogiem danych ${marker.dataDir}, ` +
        `a ten zestaw oczekuje instancji nad ${expectedDataDir}. To instancja innego przebiegu ` +
        'lub innego zestawu — pisalaby do cudzej bazy.',
    );
  }
  try {
    process.kill(marker.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
      throw new TestIsolationError(
        `Proces (pid=${marker.pid}), ktory zapisal tozsamosc instancji na porcie ${input.port}, ` +
          'juz nie zyje — odpowiada cos, czego nikt w tym przebiegu nie potwierdzil.',
      );
    }
    /* Brak uprawnien do sygnalu znaczy: proces zyje (i nalezy do innego uzytkownika). */
  }
  return marker;
}

/**
 * Katalog danych, jakiego ten zestaw oczekuje po instancji na tym porcie: dla
 * portu scenariuszowego — z rezerwacji, dla wspoldzielonego — katalog wspoldzielony.
 */
export function expectedInstanceDataDir(port: number, repoRoot: string): string {
  const owner = scenarioPortOwner(port);
  return resolve(repoRoot, owner ?? SHARED_DATA_DIR_NAME);
}

/** Katalog glowny repozytorium, wzgledem ktorego ten modul rozumie swoje sciezki. */
const REPO_ROOT = resolve(import.meta.dirname, '../..');

/**
 * Potwierdza, ze instancja, ktora faktycznie odpowiedziala, jest nasza.
 *
 * Kontrole konfiguracji powyzej ograniczaja to, o co ten proces prosi; ta
 * sprawdza, co odpowiedzialo. Odpowiedz bez etykiety testowej znaczy, ze na
 * porcie testowym slucha cos innego — zestaw sie zatrzymuje, zamiast przez nie
 * pisac.
 *
 * Etykieta to dzis za malo: kazda instancja testowa w tym repozytorium ja nosi,
 * wiec dodatkowo sprawdza plik tozsamosci (`assertInstanceIdentity`) — ze na tym
 * porcie odpowiada instancja z TEGO przebiegu, nad oczekiwanym katalogiem danych.
 */
export async function assertIsolatedInstance(
  baseUrl: string,
  opts: { expectedDataDir?: string } = {},
): Promise<void> {
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
  const port = Number(new URL(baseUrl).port);
  assertInstanceIdentity({
    port,
    expectedDataDir: opts.expectedDataDir ?? expectedInstanceDataDir(port, REPO_ROOT),
  });
}
