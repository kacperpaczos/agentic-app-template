import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { testGlmEnv } from './helpers.ts';
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
  SCENARIO_PORTS,
  scenarioPortOwner,
  SHARED_DATA_DIR_NAME,
} from '../e2e/support/isolation.ts';
import {
  ACCEPTANCE_TEST_TURNS,
  ACCEPTANCE_TURNS_NEEDED,
  EVIDENCE_ROOT,
  MODEL_OPT_IN_ENV,
  MODEL_SPEC_FILES,
  MODEL_SPEC_PATTERNS,
  MODEL_SPEC_TURNS,
  MODEL_TURNS_PER_RUN,
  RECORDED_LEDGER,
  RUN_STAMP,
  Z11_MODEL_SPEC_FILES,
  Z11_MODEL_SPEC_PATTERNS,
  Z11_OPT_IN_ENV,
  Z11_SPEC_TURNS,
  Z11_TURNS_PLANNED,
  Z11_TURN_BUDGET,
  Z11_WORKING_LEDGER,
  readZ11Ledger,
  z11SpecsRequested,
  WORKING_LEDGER,
  acceptancePreflight,
  budgetPreflight,
  evidencePath,
  modelSpecsNotice,
  modelSpecsRequested,
  readLedger,
  runEvidenceDir,
} from '../e2e/support/model-turns.ts';

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

/** Historical subscription ledger checks; the running application remains GLM-only. */
const withArchivedSubscription = <T>(fn: () => T): T => {
  const original = process.env.APP_MODEL_PROVIDER;
  process.env.APP_MODEL_PROVIDER = 'subscription';
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.APP_MODEL_PROVIDER;
    else process.env.APP_MODEL_PROVIDER = original;
  }
};

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
      modelProvider: 'subscription',
      modelEndpointOrigin: null,
      runTimeoutMs: 1,
      consentTimeoutMs: 1,
      maxUploadBytes: 1,
      instanceLabel: TEST_INSTANCE_LABEL,
      instanceRunId: null,
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
        ...testGlmEnv(dir),
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
      ...testGlmEnv(dir),
      APP_INSTANCE_LABEL: TEST_INSTANCE_LABEL,
      APP_DATA_DIR: dir,
      PORT: '8799',
    } as NodeJS.ProcessEnv);
    expect(config.instanceLabel).toBe(TEST_INSTANCE_LABEL);
    expect(config.dataDir).toBe(dir);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The other thing a browser run must not destroy: the record of what the
 * subscription already paid for.
 *
 * `pnpm test:e2e` used to run the three model specs with everything else. On the
 * committed state that meant spending turn 22 of a 22-turn budget in T25, then
 * failing the guard in T26 and T27 — whose `finally` blocks write the proba's
 * verdict — so a routine full run turned three recorded "zaliczona" into
 * "niezaliczona" and rewrote the ledger of a closed grant. Every assertion here
 * is one half of that: not reachable by default, not counted in the evidence,
 * not written over the evidence.
 */
describe('spece z prawdziwym modelem: opt-in i nienaruszalnosc dowodow', () => {
  it('domyslny przebieg nie ma projektu, ktory obejmuje spece modelowe; opt-in ma tylko je', async () => {
    const { default: config } = await import('../playwright.config.ts');
    const projects = config.projects!;
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe('chromium');
    /*
     * Excluded by the project's own file set: no argument or grep can reach
     * them — and that has to hold for **both** grants. A second package adding
     * paid specs is exactly the moment this list silently stops covering
     * everything that spends a turn.
     */
    expect(projects[0]!.testIgnore).toEqual([...MODEL_SPEC_PATTERNS, ...Z11_MODEL_SPEC_PATTERNS]);
    expect(projects[0]!.testMatch).toBeUndefined();
    expect(MODEL_SPEC_PATTERNS).toEqual([
      '**/bl01-bl02-model.spec.ts',
      '**/agent-ui.spec.ts',
      '**/files-agent.spec.ts',
      '**/model-artifacts.spec.ts',
    ]);
    expect(Z11_MODEL_SPEC_PATTERNS).toEqual([
      '**/bl03-model-canvas.spec.ts',
      '**/bl03-model-isolation.spec.ts',
      '**/bl03-model-lifecycle.spec.ts',
      '**/bl03-model-relations.spec.ts',
      '**/bl03-model-t14.spec.ts',
      '**/bl03-model-t15.spec.ts',
      '**/bl03-model-t16.spec.ts',
      '**/bl03-model-t17.spec.ts',
    ]);
    expect(modelSpecsRequested({} as NodeJS.ProcessEnv)).toBe(false);
    expect(modelSpecsRequested({ [MODEL_OPT_IN_ENV]: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  /**
   * The second grant, and why it needs a second switch.
   *
   * `pnpm test:e2e:model` is documented as costing up to 12 turns. Putting BL-03's
   * four specs into the same project would change that number for everyone who
   * runs it, without anybody choosing it — the same class of surprise as the
   * default run spending turns. So `APP_E2E_MODEL_Z11` has to be set **as well**,
   * and the two projects are mutually exclusive: one invocation can never spend
   * from both grants.
   */
  it('spece BL-03 wymagaja drugiej zgody i wydaja z wlasnego grantu', () => {
    const env = (extra: Record<string, string>) => extra as NodeJS.ProcessEnv;
    expect(z11SpecsRequested(env({}))).toBe(false);
    // The second switch alone is not enough: the first one is the opt-in to
    // spending anything at all.
    expect(z11SpecsRequested(env({ [Z11_OPT_IN_ENV]: '1' }))).toBe(false);
    expect(z11SpecsRequested(env({ [MODEL_OPT_IN_ENV]: '1' }))).toBe(false);
    expect(z11SpecsRequested(env({ [MODEL_OPT_IN_ENV]: '1', [Z11_OPT_IN_ENV]: '1' }))).toBe(true);

    // Two ledgers: this grant's counter is not the closed grant's file.
    expect(Z11_WORKING_LEDGER.startsWith(resolve(REPO, '.e2e-model-turns'))).toBe(true);
    expect(Z11_WORKING_LEDGER).not.toBe(WORKING_LEDGER);
    expect(Z11_WORKING_LEDGER.startsWith(EVIDENCE_ROOT)).toBe(false);
    // A fresh checkout starts this grant at zero, not at the other one's count.
    if (!existsSync(Z11_WORKING_LEDGER)) expect(readZ11Ledger().wydane).toBe(0);
    expect(readZ11Ledger().budzet).toBe(Z11_TURN_BUDGET);

    /*
     * The plan fits inside the grant, with room for retries.
     *
     * The first version of this compared `Z11_TURNS_PLANNED` with the sum it is
     * *defined as* — a tautology that could not fail. What can actually drift is
     * the declaration against the specs: each paid file must be named in the
     * cost table, and the total must be the number the documentation quotes.
     */
    expect(Object.keys(Z11_SPEC_TURNS).sort()).toEqual([...Z11_MODEL_SPEC_FILES].sort());
    for (const file of Z11_MODEL_SPEC_FILES) {
      expect(Z11_SPEC_TURNS[file], `${file}: koszt musi byc dodatni`).toBeGreaterThan(0);
    }
    /*
     * 22: plan tury T14 dolozyl `bl03-model-t14.spec.ts` (1 tura — jedna
     * rozmowa, cztery proby izolacji) do planu czterech specek (15), a grupy
     * D+E, F2 i G2 (rewizja 2) dolozily T15 (4), T16 (1) i T17 (1).
     */
    expect(Z11_TURNS_PLANNED, 'suma kosztow specek rozjechala sie z dokumentacja').toBe(22);
    expect(Z11_TURNS_PLANNED).toBeLessThan(Z11_TURN_BUDGET);

    /*
     * Every paid spec refuses **before the first command** when the grant is
     * short — checked as an ordering, not as a spelling.
     *
     * The earlier version looked for the literal `paidSpecPreflight(FILE)` and
     * `test.skip(!preflight.ok`. It caught a real change (the pre-flight moved
     * from the file to the individual test, so a one-turn test would stop being
     * refused for a seven-turn file it does not belong to) — but it caught it by
     * matching text, which would equally have failed on a rename. What has to
     * hold is that the refusal exists and comes first; that is what is asserted
     * now, and it survives either spelling.
     */
    for (const file of Z11_MODEL_SPEC_FILES) {
      const source = readFileSync(resolve(REPO, 'e2e', file), 'utf8');
      expect(source, `${file}: brak sprawdzenia wstepnego`).toContain('paidSpecPreflight(');
      const skip = source.indexOf('test.skip(!');
      expect(skip, `${file}: brak pominiecia przy braku budzetu`).toBeGreaterThan(-1);
      const firstCommand = source.indexOf('run.command(');
      expect(firstCommand, `${file}: spec nie wysyla zadnego polecenia?`).toBeGreaterThan(-1);
      expect(
        skip,
        `${file}: pominiecie przy braku budzetu jest PO pierwszym poleceniu — tura poszlaby mimo pustego grantu`,
      ).toBeLessThan(firstCommand);
      // Evidence lands under the run stamp, written from a `finally`.
      expect(source, `${file}: dowod nie jest zapisywany bezwarunkowo`).toContain('} finally {');
    }
    const shortfall = budgetPreflight({ budget: Z11_TURN_BUDGET, spent: 25, needed: 4 });
    expect(shortfall).toMatchObject({ ok: false, left: 0, shortfall: 4 });
    expect((shortfall as { message: string }).message).toContain('NIC nie zostalo wyslane do modelu');
  });

  it('pominiecie BL-03 jest powiedziane razem z kosztem i druga zgoda', () => {
    const skipped = modelSpecsNotice({} as NodeJS.ProcessEnv);
    for (const file of Z11_MODEL_SPEC_FILES) expect(skipped).toContain(file);
    expect(skipped).toContain(Z11_OPT_IN_ENV);
    expect(skipped).toContain('pnpm test:e2e:z11');
    // With only the first switch, the BL-03 specs are named as still skipped.
    const first = modelSpecsNotice({ [MODEL_OPT_IN_ENV]: '1' } as NodeJS.ProcessEnv);
    expect(first).toContain(Z11_OPT_IN_ENV);
    expect(first).toContain(String(MODEL_TURNS_PER_RUN));
    // With both, the notice names this grant's ceiling instead.
    const both = modelSpecsNotice({
      [MODEL_OPT_IN_ENV]: '1',
      [Z11_OPT_IN_ENV]: '1',
    } as NodeJS.ProcessEnv);
    expect(both).toContain('model-z11');
    expect(both).toContain(String(Z11_TURNS_PLANNED));
    expect(both).toContain(String(Z11_TURN_BUDGET));
  });

  it('pominiecie jest powiedziane, z kosztem w turach', () => {
    const skipped = modelSpecsNotice({} as NodeJS.ProcessEnv);
    for (const file of MODEL_SPEC_FILES) expect(skipped).toContain(file);
    expect(skipped).toContain(String(MODEL_TURNS_PER_RUN));
    expect(skipped).toContain('pnpm test:e2e:model');
    expect(modelSpecsNotice({ [MODEL_OPT_IN_ENV]: '1' } as NodeJS.ProcessEnv)).toContain('wyda do');
  });

  it('licznik tur jest w kopii roboczej (ignorowanej przez git), a nie w dowodach', () => {
    expect(WORKING_LEDGER.startsWith(resolve(REPO, '.e2e-model-turns'))).toBe(true);
    expect(WORKING_LEDGER.startsWith(EVIDENCE_ROOT)).toBe(false);
    expect(readFileSync(resolve(REPO, '.gitignore'), 'utf8')).toContain('.e2e-model-turns/');
    // The closed grant is the starting count, never a file this suite writes.
    expect(RECORDED_LEDGER).toBe(resolve(EVIDENCE_ROOT, 'tury-modelu.json'));
    const seeded = withArchivedSubscription(() => readLedger(22));
    const recorded = JSON.parse(readFileSync(RECORDED_LEDGER, 'utf8')) as { wydane: number };
    expect(seeded.wydane).toBe(recorded.wydane);
  });

  it('budzet niepokrywajacy calego speca: decyzja o pominieciu, z rejestrem, sufitem i brakiem', () => {
    /*
     * The straznik per polecenie nie wystarcza sam: przy 21 z 22 tur przepuscil
     * T25 (jedna tura naprawde wyslana) i dopiero T26 odmowil. Sprawdzenie
     * wstepne pyta o caly spec, zanim cokolwiek pojdzie do modelu.
     */
    const short = withArchivedSubscription(() =>
      budgetPreflight({ budget: 22, spent: 21, needed: ACCEPTANCE_TURNS_NEEDED }),
    );
    expect(short.ok).toBe(false);
    expect(short).toMatchObject({ budget: 22, spent: 21, left: 1, needed: 7, shortfall: 6 });
    const message = (short as { message: string }).message;
    expect(message).toContain('21 z 22');
    expect(message).toContain('zostaje 1');
    expect(message).toContain('potrzebuje 7');
    expect(message).toContain('brakuje 6');
    expect(message).toContain('NIC nie zostalo wyslane do modelu');
    expect(message).toContain('grantu koordynatora');
    expect(message).toContain(WORKING_LEDGER);

    // Dokladnie tyle, ile spec potrzebuje, wystarcza; o jedna mniej — nie.
    expect(budgetPreflight({ budget: 28, spent: 21, needed: ACCEPTANCE_TURNS_NEEDED }).ok).toBe(true);
    expect(budgetPreflight({ budget: 27, spent: 21, needed: ACCEPTANCE_TURNS_NEEDED }).ok).toBe(false);
    // Wyczerpany i przekroczony rejestr tez jest pominieciem, nie przebiegiem.
    expect(budgetPreflight({ budget: 22, spent: 22, needed: ACCEPTANCE_TURNS_NEEDED })).toMatchObject({ ok: false, shortfall: 7 });
    expect(budgetPreflight({ budget: 22, spent: 30, needed: ACCEPTANCE_TURNS_NEEDED })).toMatchObject({ ok: false, left: -8 });
    // Swiezy grant z zapasem: przebieg.
    expect(budgetPreflight({ budget: 40, spent: 21, needed: ACCEPTANCE_TURNS_NEEDED })).toMatchObject({ ok: true, left: 19 });

    // Koszt zadeklarowany per proba i koszt speca nie moga sie rozjechac.
    expect(Object.values(ACCEPTANCE_TEST_TURNS).reduce((a, b) => a + b, 0)).toBe(ACCEPTANCE_TURNS_NEEDED);
    expect(MODEL_SPEC_TURNS['bl01-bl02-model.spec.ts']).toBe(ACCEPTANCE_TURNS_NEEDED);

    // Na stanie galezi (zamkniety grant) spec jest pomijany, a nie uruchamiany.
    expect(withArchivedSubscription(() => acceptancePreflight(22).ok)).toBe(false);
  });

  it('spec odbiorowy pomija proby na podstawie sprawdzenia wstepnego, zanim cokolwiek wysle', () => {
    // Statyczna kontrola polaczenia: samo wykonanie hooka wymagaloby uruchomienia
    // speca modelowego, czego to zadanie nie robi (grant zamkniety).
    const source = readFileSync(resolve(REPO, 'e2e/bl01-bl02-model.spec.ts'), 'utf8');
    // Preflight jest podpiety pod sufit AKTYWNEGO rejestru (ACTIVE_BUDGET:
    // subskrypcja, albo rejestr GLM w trybie glm) — nie pod sztywna stala.
    expect(source).toContain('const preflight = acceptancePreflight(ACTIVE_BUDGET);');
    expect(source).toContain('test.skip(!preflight.ok, preflight.ok ? \'\' : preflight.message);');
    // Skip w beforeEach, czyli przed cialem testu — a wiec przed sendForRun.
    const hook = source.indexOf('test.beforeEach(');
    expect(hook).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(source.indexOf('await sendForRun('));
  });

  it('dowody przebiegu ida pod stempel przebiegu — zapisane werdykty sa nie do nadpisania', () => {
    for (const name of ['t25-wskazanie-wartosci.json', 't26-zawezenie-rozmowa.json', 't27-widoki-agenta.json', 'tury-modelu.json']) {
      const recorded = resolve(EVIDENCE_ROOT, name);
      expect(evidencePath(name)).not.toBe(recorded);
      expect(evidencePath(name).startsWith(resolve(EVIDENCE_ROOT, 'runs'))).toBe(true);
    }
    expect(runEvidenceDir()).toBe(resolve(EVIDENCE_ROOT, 'runs', RUN_STAMP));
    // A name that could climb out of the run's directory is not a file name.
    expect(() => evidencePath('../t25-wskazanie-wartosci.json')).toThrow(/zwykla nazwa pliku/);
    expect(() => evidencePath('runs/../t25.json')).toThrow(/zwykla nazwa pliku/);
  });
});

describe('rezerwacja portow scenariuszowych (port z audytu 2026-09-28)', () => {
  const PORTS = [8793, 8794, 8795, 8796, 8797, 8798];
  for (const p of PORTS) {
    it(`APP_E2E_PORT=${p} jest odrzucany — port scenariuszowy (${p})`, () => {
      const dir = resolve(REPO, `.e2e-data`);
      expect(() =>
        resolveTestInstance({
          repoRoot: REPO,
          dataDirName: SHARED_DATA_DIR_NAME,
          defaultPort: 8799,
          env: { APP_E2E_PORT: String(p) },
        }),
      ).toThrow(/zarezerwowany dla instancji scenariuszowej/);
      expect(scenarioPortOwner(p)).toBeTruthy();
    });
  }

  it('port wspoldzielony 8799 pozostaje przyjmowany', () => {
    const cfg = resolveTestInstance({
      repoRoot: REPO,
      dataDirName: SHARED_DATA_DIR_NAME,
      defaultPort: 8799,
    });
    expect(cfg.port).toBe(8799);
  });

  it('porty 8792 i 8799 sa jedynymi niescenariuszowymi w zakresie testowym', () => {
    for (let p = 8792; p <= 8799; p++) {
      const owner = scenarioPortOwner(p);
      if (p === 8792 || p === 8799) expect(owner, `port ${p} ma byc wolny`).toBeNull();
      else expect(owner, `port ${p} ma byc zarezerwowany`).toBeTruthy();
    }
  });
});
