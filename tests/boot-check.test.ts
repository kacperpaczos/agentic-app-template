import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBrowserExecutable,
  assertServerBundle,
  assertWebBundle,
  BootRefusal,
  SERVER_BUNDLE_RELATIVE,
  WEB_BUNDLE_RELATIVE,
} from '../e2e/support/boot-check.ts';

/**
 * Czytelne odmowy przed startem instancji testowej (T01).
 *
 * `pnpm test:e2e` na czystym klonie kończyło się surowym `ERR_MODULE_NOT_FOUND`
 * z wnętrza boot-servera — po przygotowaniu bazy, bez żadnej wskazówki, co
 * naprawić. To samo dotyczyło braku przeglądarek Playwright (odmowa biblioteki
 * dopiero przy pierwszym teście) i braku logowania/poświadczenia modelu
 * (odmowa `loadConfig`, już istniejąca — tu tylko pilnowana, by nie zarosła).
 *
 * Wszystko na katalogach tymczasowych; prawdziwy build ani prawdziwe
 * przeglądarki nie biorą udziału.
 */

const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'boot-check-'));
  mkdirSync(join(root, 'apps', 'server'), { recursive: true });
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  return root;
};

describe('czytelne odmowy przed startem instancji e2e (T01)', () => {
  it('brak bundla serwera daje komunikat z "pnpm build", a nie surowy blad importu', () => {
    const root = freshRoot();
    try {
      expect(() => assertServerBundle(root)).toThrowError(BootRefusal);
      expect(() => assertServerBundle(root)).toThrowError(/pnpm build/);
      // I wskazuje plik, którego brakuje — bez tej wskazówki komunikat jest
      // tylko ładniejszym "coś nie działa".
      expect(() => assertServerBundle(root)).toThrowError(SERVER_BUNDLE_RELATIVE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('brak bundla frontendu daje ten sam rodzaj komunikatu', () => {
    const root = freshRoot();
    try {
      expect(() => assertWebBundle(root)).toThrowError(BootRefusal);
      expect(() => assertWebBundle(root)).toThrowError(/pnpm build/);
      expect(() => assertWebBundle(root)).toThrowError(WEB_BUNDLE_RELATIVE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('obecne bundle przechodza bez odmowy', () => {
    const root = freshRoot();
    try {
      const server = join(root, SERVER_BUNDLE_RELATIVE);
      const web = join(root, WEB_BUNDLE_RELATIVE);
      mkdirSync(resolve(server, '..'), { recursive: true });
      mkdirSync(resolve(web, '..'), { recursive: true });
      writeFileSync(server, 'export {};\n');
      writeFileSync(web, '<html></html>\n');
      expect(() => assertServerBundle(root)).not.toThrow();
      expect(() => assertWebBundle(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('brak przegladarki Playwright daje komunikat z poleceniem instalacji', () => {
    expect(() => assertBrowserExecutable('/nie-ma/takiej/przegladarki', 'chromium')).toThrowError(
      BootRefusal,
    );
    expect(() => assertBrowserExecutable('/nie-ma/takiej/przegladarki', 'chromium')).toThrowError(
      /playwright install/,
    );
    expect(() => assertBrowserExecutable('/nie-ma/takiej/przegladarki', 'chromium')).toThrowError(
      /chromium/,
    );
  });

  it('istniejaca przegladarka przechodzi bez odmowy', () => {
    const root = freshRoot();
    try {
      const fake = join(root, 'chrome');
      writeFileSync(fake, '');
      expect(() => assertBrowserExecutable(fake, 'chromium')).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('boot-server sprawdza dokladnie te pliki, ktore potem importuje', () => {
    /*
     * Równoważność na źródle, jak w tests/isolation.test.ts: boot-server musi
     * odmówić na podstawie TEJ SAMEJ ścieżki, którą zaraz zaimportuje — inaczej
     * kontrola sprawdza jeden plik, a startuje drugi. Wiąże to wspólna stała:
     * import na dole pliku używa `SERVER_BUNDLE_RELATIVE`, nie własnego literału.
     */
    const boot = readFileSync(resolve('e2e/support/boot-server.ts'), 'utf8');
    expect(boot).toContain('assertServerBundle');
    expect(boot).toContain('assertWebBundle');
    expect(boot).toContain(
      `await import(resolve(instance.repoRoot, SERVER_BUNDLE_RELATIVE))`,
    );
    expect(SERVER_BUNDLE_RELATIVE).toBe('apps/server/dist/server.js');
    expect(WEB_BUNDLE_RELATIVE).toBe('apps/web/dist/index.html');
  });

  it('scenariusz produkcyjny ScriptedInstance tez odmawia bez bundla', () => {
    const scripted = readFileSync(resolve('e2e/support/scripted.ts'), 'utf8');
    expect(scripted).toContain('assertServerBundle');
  });

  it('brak logowania modelu: prawdziwy serwer odmawia czytelnie, zanim cokolwiek otworzy', () => {
    /*
     * Próba negatywna na poziomie procesu (T01): start buildu produkcyjnego BEZ
     * poświadczenia endpointu. Odmowa istnieje w `loadConfig`
     * (tests/provider-mode.test.ts pokrywa każdy brak osobno); ta próba dowodzi,
     * że **proces serwera** kończy się tym komunikatem zanim cokolwiek otworzy —
     * nie port, nie bazę — zamiast wstawać i upadać dopiero na pierwszej turze.
     *
     * Wymaga buildu (jak `pnpm test:e2e`); jego brak jest odmową z komunikatem
     * T01, nie cichym pominięciem. Środowisko NIE dziedziczy poświadczenia z
     * powłoki — dziedziczenie właśnie udawało „obecne logowanie".
     */
    const bundle = resolve('apps/server/dist/server.js');
    if (!existsSync(bundle)) {
      throw new Error('[e2e] Brak zbudowanego pakietu serwera. Uruchom "pnpm build" i sprobuj ponownie.');
    }
    const dataDir = join(tmpdir(), `.e2e-brak-logowania-${process.pid}`);
    const out = spawnSync(
      process.execPath,
      [bundle],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          ANTHROPIC_AUTH_TOKEN: undefined as unknown as string,
          APP_MODEL: 'm-atrapa-nie-jest-modelem',
          APP_MODEL_PROVIDER: 'glm',
          ANTHROPIC_BASE_URL: 'https://glm.endpoint.invalid',
          CLAUDE_CONFIG_DIR: join(tmpdir(), `.e2e-brak-logowania-config-${process.pid}`),
          PORT: '8799',
          APP_DATA_DIR: dataDir,
        },
      },
    );
    try {
      expect(out.status, `proces mial odmowic: ${(out.stdout ?? '') + (out.stderr ?? '')}`).not.toBe(0);
      const said = (out.stdout ?? '') + (out.stderr ?? '');
      expect(said, 'odmowa ma nazywac brakujace poswiadczenie').toContain('ANTHROPIC_AUTH_TOKEN');
      expect(said, 'odmowa ma byc startem odmowionym, nie krzykiem o polaczeniu').toContain(
        'Start odmówiony',
      );
      // I niczego po drodze nie zostawił: ani bazy, ani katalogu danych.
      expect(existsSync(dataDir), 'odmowa stowrzyla katalog danych').toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
