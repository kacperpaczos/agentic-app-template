import { mkdtempSync, rmSync } from 'node:fs';
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
  assertTestBaseUrl,
  assertTestDataDir,
  assertTestPort,
  resolveTestInstance,
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
 * Each case below is one of those, or the environment variable that would
 * recreate it. A guard that only rejects obvious nonsense would have stopped
 * neither.
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
