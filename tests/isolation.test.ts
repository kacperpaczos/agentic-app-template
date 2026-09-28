import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assertTestInstanceIsIsolated,
  loadConfig,
  TEST_INSTANCE_LABEL as SERVER_LABEL,
  TEST_PORT_RANGE as SERVER_RANGE,
} from '@platform/server';
import {
  assertInstanceIdentity,
  assertIsolatedInstance,
  assertTestBaseUrl,
  assertTestDataDir,
  assertTestPort,
  expectedInstanceDataDir,
  instanceIdentityFile,
  recordInstanceIdentity,
  resolveTestInstance,
  SCENARIO_PORTS,
  scenarioPortOwner,
  TEST_INSTANCE_LABEL,
  TEST_PORT_RANGE,
  TestIsolationError,
} from '../e2e/support/isolation.ts';

/**
 * The isolation guard, tested against the configurations that actually caused
 * harm rather than against invented ones.
 *
 * Two things went wrong during this work, both through configuration and not
 * through a typo:
 *
 *  1. the browser suite ran with `reuseExistingServer` against the default port
 *     and the application's own `data/` directory, so it attached to a running
 *     instance and wrote through it;
 *  2. cleanup matched servers by command line and killed one the tests had not
 *     started.
 *
 * A third arrived when the installation grew to several test instances at once:
 * `APP_E2E_PORT=8794` with `background-tasks.spec` raised the shared instance on
 * a scenario port, and the label check let the two negotiate — the specs ran
 * their scenarios against the shared instance, with the real model. Each case
 * below is one of those, or the environment variable that would recreate it. A
 * guard that only rejects obvious nonsense would have stopped none of them.
 */

const REPO = resolve(import.meta.dirname, '..');

describe('granice konfiguracji testow', () => {
  it('domyslny port aplikacji nie jest portem testowym', () => {
    expect(() => assertTestPort(8791, 'port')).toThrow(TestIsolationError);
    expect(() => assertTestPort(8791, 'port')).toThrow(/domyslny port aplikacji/);
  });

  it('port spoza zarezerwowanego zakresu jest odrzucony', () => {
    expect(() => assertTestPort(3000, 'port')).toThrow(/poza zakresem/);
    expect(() => assertTestPort(Number('nie-port'), 'port')).toThrow(/nie jest numerem portu/);
  });

  it('porty zarezerwowane sa przyjmowane', () => {
    for (const p of [TEST_PORT_RANGE.from, 8797, 8798, TEST_PORT_RANGE.to]) {
      expect(assertTestPort(p, 'port')).toBe(p);
    }
  });

  it('katalog danych aplikacji jest odrzucony', () => {
    expect(() => assertTestDataDir(resolve(REPO, 'data'), REPO, 'katalog')).toThrow(
      TestIsolationError,
    );
  });

  it('katalog poza repozytorium jest odrzucony', () => {
    // The check that matters for `rm -rf`: a relative path resolved from an
    // unexpected working directory is how such a call escapes the repository.
    expect(() => assertTestDataDir('/tmp/.e2e-gdzies-indziej', REPO, 'katalog')).toThrow(
      /poza katalogiem repozytorium/,
    );
    expect(() => assertTestDataDir(REPO, REPO, 'katalog')).toThrow(/katalog glowny/);
  });

  it('katalog bez prefiksu testowego jest odrzucony', () => {
    expect(() => assertTestDataDir(resolve(REPO, 'docs'), REPO, 'katalog')).toThrow(
      /prefiks ".e2e"/,
    );
  });

  it('katalog testowy jest przyjmowany', () => {
    expect(assertTestDataDir(resolve(REPO, '.e2e-data'), REPO, 'katalog')).toBe(
      resolve(REPO, '.e2e-data'),
    );
  });

  it('adres spoza petli zwrotnej jest odrzucony', () => {
    expect(() => assertTestBaseUrl('https://example.com', 8799, 'adres')).toThrow(
      /petli zwrotnej/,
    );
  });

  it('adres wskazujacy inny port niz instancja testowa jest odrzucony', () => {
    // The single environment variable that would send every request to the
    // user's application while every other check still passed.
    expect(() => assertTestBaseUrl('http://127.0.0.1:8791', 8799, 'adres')).toThrow(
      /wskazuje port 8791/,
    );
  });
});

describe('resolveTestInstance', () => {
  it('sklada srodowisko instancji testowej z etykieta', () => {
    const cfg = resolveTestInstance({
      repoRoot: REPO,
      dataDirName: '.e2e-data',
      defaultPort: 8799,
      env: {},
    });
    expect(cfg.port).toBe(8799);
    expect(cfg.dataDir).toBe(resolve(REPO, '.e2e-data'));
    expect(cfg.baseUrl).toBe('http://127.0.0.1:8799');
    expect(cfg.env.APP_INSTANCE_LABEL).toBe(TEST_INSTANCE_LABEL);
    expect(cfg.env.APP_DATA_DIR).toBe(cfg.dataDir);
  });

  it('APP_BASE_URL wskazujacy instancje uzytkownika przerywa konfiguracje', () => {
    expect(() =>
      resolveTestInstance({
        repoRoot: REPO,
        dataDirName: '.e2e-data',
        defaultPort: 8799,
        env: { APP_BASE_URL: 'http://127.0.0.1:8791' },
      }),
    ).toThrow(TestIsolationError);
  });

  it('APP_E2E_PORT rowny portowi aplikacji przerywa konfiguracje', () => {
    expect(() =>
      resolveTestInstance({
        repoRoot: REPO,
        dataDirName: '.e2e-data',
        defaultPort: 8799,
        env: { APP_E2E_PORT: '8791' },
      }),
    ).toThrow(/domyslny port aplikacji/);
  });

  it('APP_E2E_PORT rowny portowi scenariuszowemu przerywa konfiguracje', () => {
    // The audited collision: with APP_E2E_PORT=8794 and background-tasks.spec,
    // the shared instance rose on the scenario port and the label check — the
    // same label on both — let the specs negotiate with it, real model included.
    // The refusal must happen here, at config load, before anything starts.
    expect(() =>
      resolveTestInstance({
        repoRoot: REPO,
        dataDirName: '.e2e-data',
        defaultPort: 8799,
        env: { APP_E2E_PORT: '8794' },
      }),
    ).toThrow(TestIsolationError);
    expect(() =>
      resolveTestInstance({
        repoRoot: REPO,
        dataDirName: '.e2e-data',
        defaultPort: 8799,
        env: { APP_E2E_PORT: '8794' },
      }),
    ).toThrow(/zarezerwowany dla instancji scenariuszowej/);
    expect(() =>
      resolveTestInstance({
        repoRoot: REPO,
        dataDirName: '.e2e-data',
        defaultPort: 8799,
        env: { APP_E2E_PORT: '8794' },
      }),
    ).toThrow(/\.e2e-scripted-tasks/);
  });

  it('kazdy port scenariuszowy jest odrzucony jako APP_E2E_PORT, wskazujac wlasciciela', () => {
    for (const [port, dir] of Object.entries(SCENARIO_PORTS)) {
      expect(() =>
        resolveTestInstance({
          repoRoot: REPO,
          dataDirName: '.e2e-data',
          defaultPort: 8799,
          env: { APP_E2E_PORT: port },
        }),
      ).toThrow(new RegExp(`${dir}`));
    }
  });

  it('APP_E2E_PORT rowny portowi wspoldzielonemu jest przyjety', () => {
    expect(
      resolveTestInstance({
        repoRoot: REPO,
        dataDirName: '.e2e-data',
        defaultPort: 8799,
        env: { APP_E2E_PORT: String(TEST_PORT_RANGE.to) },
      }).port,
    ).toBe(TEST_PORT_RANGE.to);
  });

  it('port scenariuszowy wymaga katalogu danych z rezerwacji', () => {
    // Port and data directory together are the scenario's identity: two suites
    // claiming the same pair in two different ways would be a latent collision.
    expect(() =>
      resolveTestInstance({
        repoRoot: REPO,
        dataDirName: '.e2e-scripted',
        defaultPort: 8794,
        env: {},
      }),
    ).toThrow(/musi pasowac do rezerwacji/);
    const ok = resolveTestInstance({
      repoRoot: REPO,
      dataDirName: '.e2e-scripted-tasks',
      defaultPort: 8794,
      env: {},
    });
    expect(ok.port).toBe(8794);
    expect(ok.dataDir).toBe(resolve(REPO, '.e2e-scripted-tasks'));
  });
});

describe('rezerwacja portow scenariuszowych', () => {
  it('pokrywa caly zakres testowy poza portem wspoldzielonym', () => {
    // Every reserved test port is either a scenario port or the shared one —
    // nothing in between, so a suite inventing its own port is impossible.
    const reserved = new Set(Object.keys(SCENARIO_PORTS).map(Number));
    for (let p: number = TEST_PORT_RANGE.from; p <= TEST_PORT_RANGE.to; p += 1) {
      if (p === TEST_PORT_RANGE.to) {
        expect(reserved.has(p), `port wspoldzielony ${p} nie moze byc scenariuszowy`).toBe(false);
      } else {
        expect(reserved.has(p), `port ${p} musi miec rezerwacje scenariuszowa`).toBe(true);
      }
    }
    // ...and the reservation registers nothing outside the range.
    for (const port of reserved) {
      expect(port).toBeGreaterThanOrEqual(TEST_PORT_RANGE.from);
      expect(port).toBeLessThan(TEST_PORT_RANGE.to);
    }
  });

  it('zadna rezerwacja nie dotyka portu aplikacji ani nie powtarza katalogu', () => {
    const dirs = Object.values(SCENARIO_PORTS);
    for (const port of Object.keys(SCENARIO_PORTS).map(Number)) {
      expect(port, 'port aplikacji nie jest portem testowym').not.toBe(8791);
      expect(scenarioPortOwner(port)).toMatch(/^\.e2e/);
    }
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('scenarioPortOwner zwraca wlasciciela albo null', () => {
    expect(scenarioPortOwner(8792)).toBe('.e2e-scripted-filter');
    expect(scenarioPortOwner(8799)).toBeNull();
    expect(scenarioPortOwner(8791)).toBeNull();
  });
});

describe('tozsamosc instancji testowej', () => {
  const made: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(resolve(tmpdir(), 'agentic-identity-'));
    made.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  it('instancja zapisuje tozsamosc, a kontrola ja potwierdza', () => {
    const dir = tmp();
    const marker = recordInstanceIdentity({
      port: 8794,
      dataDir: dir,
      instanceLabel: TEST_INSTANCE_LABEL,
    });
    expect(marker.port).toBe(8794);
    expect(marker.pid).toBe(process.pid);
    // The file lives in the instance's own data directory, named by its port —
    // exactly what the run-time check will look for.
    expect(instanceIdentityFile(dir, 8794)).toBe(resolve(dir, 'instance-8794.json'));
    expect(
      assertInstanceIdentity({ port: 8794, expectedDataDir: dir }).startedAt,
    ).toBeTruthy();
  });

  it('instancja bez etykiety testowej nie zapisuje tozsamosci', () => {
    const dir = tmp();
    expect(() =>
      recordInstanceIdentity({ port: 8794, dataDir: dir, instanceLabel: null }),
    ).toThrow(TestIsolationError);
  });

  it('instancja bez pliku tozsamosci jest odrzucona', () => {
    const dir = tmp();
    expect(() => assertInstanceIdentity({ port: 8794, expectedDataDir: dir })).toThrow(
      /nie zapisala swojej tozsamosci/,
    );
  });

  it('niezgodny katalog danych w pliku odrzuca instancje', () => {
    // The audited failure, at run time: an instance answering on a port while
    // carrying another run's (or suite's) data directory. The label alone would
    // pass — both instances are labelled.
    const mine = tmp();
    const theirs = tmp();
    writeFileSync(
      instanceIdentityFile(mine, 8794),
      JSON.stringify({
        port: 8794,
        dataDir: theirs,
        instanceLabel: TEST_INSTANCE_LABEL,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
    );
    expect(() => assertInstanceIdentity({ port: 8794, expectedDataDir: mine })).toThrow(
      /instancja innego przebiegu|instancja z katalogiem danych/,
    );
  });

  it('niezgodny port w pliku odrzuca instancje', () => {
    // The file's name names the port it claims; the contents must agree with it.
    const dir = tmp();
    writeFileSync(
      instanceIdentityFile(dir, 8795),
      JSON.stringify({
        port: 8794,
        dataDir: dir,
        instanceLabel: TEST_INSTANCE_LABEL,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
    );
    expect(() => assertInstanceIdentity({ port: 8795, expectedDataDir: dir })).toThrow(
      /mowi o porcie 8794/,
    );
  });

  it('tozsamosc po martwym procesie jest odrzucona', () => {
    const dir = tmp();
    // A pid that is certainly gone: a child that has already been waited for.
    const dead = spawnSync(process.execPath, ['-e', '']);
    expect(dead.status).toBe(0);
    writeFileSync(
      instanceIdentityFile(dir, 8794),
      JSON.stringify({
        port: 8794,
        dataDir: dir,
        instanceLabel: TEST_INSTANCE_LABEL,
        pid: dead.pid,
        startedAt: new Date().toISOString(),
      }),
    );
    expect(() => assertInstanceIdentity({ port: 8794, expectedDataDir: dir })).toThrow(
      /juz nie zyje/,
    );
  });

  it('plik tozsamosci, ktory nie jest JSON-em, jest odrzucony', () => {
    const dir = tmp();
    writeFileSync(instanceIdentityFile(dir, 8794), 'to nie jest json');
    expect(() => assertInstanceIdentity({ port: 8794, expectedDataDir: dir })).toThrow(
      /nie jest poprawnym JSON-em/,
    );
  });

  it('katalog oczekiwany po porcie: z rezerwacji dla scenariuszy, wspoldzielony dla 8799', () => {
    expect(expectedInstanceDataDir(8794, REPO)).toBe(resolve(REPO, '.e2e-scripted-tasks'));
    expect(expectedInstanceDataDir(8792, REPO)).toBe(resolve(REPO, '.e2e-scripted-filter'));
    expect(expectedInstanceDataDir(TEST_PORT_RANGE.to, REPO)).toBe(resolve(REPO, '.e2e-data'));
  });

  it('assertIsolatedInstance przepuszcza instancje z tozsamoscia i etykieta, a odrzuca bez pliku', async () => {
    const dir = tmp();
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, instanceLabel: TEST_INSTANCE_LABEL }));
    });
    const port = await new Promise<number>((done) => {
      server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port));
    });
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await expect(assertIsolatedInstance(baseUrl, { expectedDataDir: dir })).rejects.toThrow(
        /nie zapisala swojej tozsamosci/,
      );
      // The marker is written by hand here: `recordInstanceIdentity` accepts
      // only reserved test ports, and this fake instance listens on an
      // ephemeral one. The file's shape is what the check reads.
      writeFileSync(
        instanceIdentityFile(dir, port),
        JSON.stringify({
          port,
          dataDir: dir,
          instanceLabel: TEST_INSTANCE_LABEL,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      );
      await expect(
        assertIsolatedInstance(baseUrl, { expectedDataDir: dir }),
      ).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('serwer odmawia startu przy niezgodnej konfiguracji', () => {
  const made: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(resolve(tmpdir(), 'agentic-iso-'));
    made.push(d);
    return d;
  };
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });

  /* The two definitions are restated in `e2e/support/isolation.ts` so that
     Playwright's config need not import the server package. They must agree. */
  it('stale sa wspolne dla harnessu i serwera', () => {
    expect(SERVER_LABEL).toBe(TEST_INSTANCE_LABEL);
    expect(SERVER_RANGE).toEqual(TEST_PORT_RANGE);
  });

  const cfg = (over: Record<string, unknown>) =>
    ({
      dataDir: resolve(REPO, '.e2e-data'),
      dbFile: '',
      filesDir: '',
      workspacesDir: '',
      port: 8799,
      allowedOrigins: [],
      webDistDir: null,
      model: 'm',
      provider: null,
      runTimeoutMs: 1,
      maxUploadBytes: 1,
      instanceLabel: TEST_INSTANCE_LABEL,
      ...over,
    }) as Parameters<typeof assertTestInstanceIsIsolated>[0];

  it('oznaczona instancja nie wstanie na domyslnym porcie', () => {
    expect(() => assertTestInstanceIsIsolated(cfg({ port: 8791 }), resolve(REPO, 'data'))).toThrow(
      /poza zakresem zarezerwowanym/,
    );
  });

  it('oznaczona instancja nie wstanie na katalogu danych aplikacji', () => {
    expect(() =>
      assertTestInstanceIsIsolated(cfg({ dataDir: resolve(REPO, 'data') }), resolve(REPO, 'data')),
    ).toThrow(/domyslny katalog aplikacji/);
  });

  it('nieoznaczona instancja nie jest ograniczana', () => {
    // Production must be unaffected: the guard only constrains labelled runs.
    expect(() =>
      assertTestInstanceIsIsolated(
        cfg({ instanceLabel: null, port: 8791, dataDir: resolve(REPO, 'data') }),
        resolve(REPO, 'data'),
      ),
    ).not.toThrow();
  });

  it('loadConfig odrzuca oznaczona instancje przed utworzeniem katalogu', () => {
    const dir = resolve(tmp(), 'dane-produkcyjne');
    expect(() =>
      loadConfig({
        APP_INSTANCE_LABEL: TEST_INSTANCE_LABEL,
        APP_DATA_DIR: dir,
        PORT: '8799',
      } as NodeJS.ProcessEnv),
    ).toThrow(/izolacja testow/);
    // The refusal happens before `mkdirSync`, so nothing was created next to it.
    expect(() => rmSync(dir, { recursive: true })).toThrow();
  });

  it('loadConfig przyjmuje poprawna instancje testowa', () => {
    const dir = resolve(tmp(), '.e2e-ok');
    const config = loadConfig({
      APP_INSTANCE_LABEL: TEST_INSTANCE_LABEL,
      APP_DATA_DIR: dir,
      PORT: '8799',
    } as NodeJS.ProcessEnv);
    expect(config.instanceLabel).toBe(TEST_INSTANCE_LABEL);
    expect(config.dataDir).toBe(dir);
  });
});
