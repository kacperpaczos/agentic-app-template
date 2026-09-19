import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

/**
 * L1.8 — a probe run from a shell may not write through the user's instance.
 *
 * Test kontraktu lub logiki, plus an end-to-end check of the script itself.
 *
 * The defect was real and documented in the README: `pnpm acceptance` and
 * `scripts/run-agent.mjs` defaulted to `http://127.0.0.1:8791`, the port an
 * installed instance listens on, and asked nobody who answered there. Their
 * scenarios change the quantity of an offer item and add canvas cards, so a
 * real-model probe started outside the browser harness wrote through whatever
 * was listening.
 *
 * Two things are checked, and the second is the one that matters: not only that
 * the guard function returns a refusal, but that **the script sends nothing**.
 * A guard that refuses while the request is already in flight refuses nothing.
 *
 * The counter-case is what makes that assertion mean something. "No POST
 * arrived" is also true of a script that failed to start, so the same stand-in
 * answers with an allowed label in the last test and the POST has to arrive.
 */

const REPO = resolve(import.meta.dirname, '..');

const katalogi: string[] = [];
/** Kontrolowane drzewo skryptów dla prób reguły. */
const tmpKatalog = (): string => {
  const d = mkdtempSync(resolve(tmpdir(), 'agentic-skrypty-'));
  katalogi.push(d);
  return d;
};
const RUN_AGENT = resolve(REPO, 'scripts/run-agent.mjs');
const MODULE = resolve(REPO, 'scripts/lib/acceptance-target.mjs');

interface AcceptanceTargetModule {
  DEFAULT_ACCEPTANCE_BASE: string;
  TEST_PORT_RANGE: { from: number; to: number };
  DEFAULT_ACCEPTANCE_PORT: number;
  USER_APP_PORT: number;
  ACCEPTANCE_LABELS: string[];
  AcceptanceTargetError: new (m: string) => Error;
  resolveAcceptanceTarget: (env?: Record<string, string | undefined>) => {
    base: string;
    port: number;
    allowedLabels: string[];
  };
  checkAcceptanceInstance: (
    target: { base: string; allowedLabels: string[] },
    fetchImpl?: typeof fetch,
    timeoutMs?: number,
  ) => Promise<string | null>;
  requireAcceptanceInstance: (env?: Record<string, string | undefined>) => Promise<{ base: string }>;
}

const mod = (await import(MODULE)) as AcceptanceTargetModule;

let running: Server | null = null;

/** Every request the stand-in received, in order: `POST /api/agui/run`. */
let seen: string[] = [];

/**
 * A stand-in instance answering `/api/health` with the given label.
 *
 * `null` is the interesting one: that is exactly what an installed instance
 * answers, because `APP_INSTANCE_LABEL` is set only by this repository's own
 * commands.
 */
async function instanceAnswering(label: string | null): Promise<string> {
  seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/api/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, instanceLabel: label }));
      return;
    }
    if (req.url === '/api/auth/session') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'sid=test; Path=/');
      res.end('{}');
      return;
    }
    // Anything else: refuse, so the script stops without a stream to read.
    res.statusCode = 503;
    res.end('stand-in');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  running = server;
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('brak portu');
  return `http://127.0.0.1:${address.port}`;
}

/** Second stand-in, for the cases that need two servers or none answering. */
let second: Server | null = null;

/** Answers `/api/health` with a redirect to `to` — and nothing else. */
async function instanceRedirectingTo(to: string): Promise<string> {
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.statusCode = 302;
    res.setHeader('location', `${to}/api/health`);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  second = server;
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('brak portu');
  return `http://127.0.0.1:${address.port}`;
}

/** Accepts the connection and never replies. */
async function instanceThatNeverAnswers(): Promise<string> {
  const server = createServer(() => {
    /* deliberately no response */
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  second = server;
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('brak portu');
  return `http://127.0.0.1:${address.port}`;
}

afterAll(() => {
  for (const d of katalogi.splice(0)) rmSync(d, { recursive: true, force: true });
});

afterEach(async () => {
  for (const ref of ['running', 'second'] as const) {
    const server = ref === 'running' ? running : second;
    if (ref === 'running') running = null;
    else second = null;
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }
});

/**
 * Runs the script and collects what it printed.
 *
 * Asynchronous on purpose. `spawnSync` blocks this process's event loop, and
 * the stand-in instance lives *in* this process — the child's `/api/health`
 * would then never be answered and every run would look like "the instance did
 * not reply", which is the wrong refusal for the right reason. That mistake
 * made the first version of this file pass its main assertion by accident.
 */
async function runScript(base: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [RUN_AGENT, 'cokolwiek', '--space', 's1'], {
    env: { ...process.env, APP_BASE: base },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
  child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
  const status = await new Promise<number | null>((done) => child.on('close', done));
  return { status, stdout, stderr };
}

describe('cel proby odbiorowej', () => {
  it('domyslny cel nie jest portem zainstalowanej aplikacji', () => {
    const target = mod.resolveAcceptanceTarget({});
    expect(target.port).toBe(mod.DEFAULT_ACCEPTANCE_PORT);
    // The whole point: reaching the user's instance must take a deliberate act.
    expect(target.port).not.toBe(mod.USER_APP_PORT);
    expect(target.base).toBe(mod.DEFAULT_ACCEPTANCE_BASE);
  });

  it('APP_BASE wskazujacy port zainstalowanej aplikacji jest odrzucony z powodem', () => {
    expect(() => mod.resolveAcceptanceTarget({ APP_BASE: 'http://127.0.0.1:8791' })).toThrowError(
      /domyslny port zainstalowanej aplikacji/,
    );
    expect(() => mod.resolveAcceptanceTarget({ APP_BASE: 'http://localhost:8791/' })).toThrowError(
      /domyslny port zainstalowanej aplikacji/,
    );
  });

  it('adres spoza petli zwrotnej i adres niepoprawny sa odrzucone', () => {
    expect(() => mod.resolveAcceptanceTarget({ APP_BASE: 'http://example.com:8790' })).toThrowError(
      /petli zwrotnej/,
    );
    expect(() => mod.resolveAcceptanceTarget({ APP_BASE: 'nie-adres' })).toThrowError(/poprawnym adresem/);
    // A different loopback port is fine — the rule is specific, not blanket.
    expect(mod.resolveAcceptanceTarget({ APP_BASE: 'http://127.0.0.1:8765' }).port).toBe(8765);
  });

  it('instancja bez etykiety — czyli instancja uzytkownika — jest odrzucona', async () => {
    const base = await instanceAnswering(null);
    const problem = await mod.checkAcceptanceInstance({ base, allowedLabels: mod.ACCEPTANCE_LABELS });
    expect(problem, 'instancja bez etykiety zostala przyjeta').not.toBeNull();
    expect(problem).toContain('null');
    expect(problem).toContain('nic nie zostalo zapisane');
  });

  it('instancja z cudza etykieta jest odrzucona, z wlasciwa — przyjeta', async () => {
    const foreign = await instanceAnswering('cudza-aplikacja');
    expect(await mod.checkAcceptanceInstance({ base: foreign, allowedLabels: mod.ACCEPTANCE_LABELS }))
      .toContain('cudza-aplikacja');

    await new Promise<void>((done) => running!.close(() => done()));
    running = null;

    const ours = await instanceAnswering('agenticapp-dev');
    expect(await mod.checkAcceptanceInstance({ base: ours, allowedLabels: mod.ACCEPTANCE_LABELS })).toBeNull();
  });

  it('instancja, ktora nie odpowiada, jest odmowa — nie milczaca zgoda', async () => {
    const problem = await mod.checkAcceptanceInstance({
      // Nothing listens here.
      base: 'http://127.0.0.1:1',
      allowedLabels: mod.ACCEPTANCE_LABELS,
    });
    expect(problem).toContain('nie odpowiada na /api/health');
  });
});

describe('sprawdzenie etykiety nie daje sie obejsc', () => {
  it('przekierowanie na inna instancje jest odmowa, a nie zgoda', async () => {
    /*
     * Pokazane przez recenzenta, nie wymyslone: `/api/health` odpowiada 302 na
     * drugi, poprawnie oznaczony serwer, sprawdzenie przechodzi — a kazdy zapis
     * idzie do pierwszego. Etykiete trzeba przeczytac z tej samej instancji,
     * ktora przyjmie zapisy.
     */
    const labelled = await instanceAnswering('agenticapp-dev');
    const redirector = await instanceRedirectingTo(labelled);
    const problem = await mod.checkAcceptanceInstance({
      base: redirector,
      allowedLabels: mod.ACCEPTANCE_LABELS,
    });
    expect(problem, 'przekierowanie zostalo przyjete').not.toBeNull();
    expect(problem).toContain('Przekierowanie i brak odpowiedzi');
  });

  it('cel, ktory przyjmuje polaczenie i nie odpowiada, jest odrzucony w terminie', async () => {
    // Bez terminu ten przypadek wiesza przebieg — ani odmowa, ani zgoda.
    const silent = await instanceThatNeverAnswers();
    const started = Date.now();
    const problem = await mod.checkAcceptanceInstance(
      { base: silent, allowedLabels: mod.ACCEPTANCE_LABELS },
      fetch,
      400,
    );
    expect(problem).toContain('nie odpowiada na /api/health');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

/* ------------------- klasa: skrypty a bramka instancji -------------------- */

/** Rozszerzenia, ktore ktos uruchamia. `.sh` tez potrafi wywolac curl. */
const WYKONYWALNE = /\.(mjs|cjs|js|ts|mts|cts|sh)$/;

/**
 * Prawdziwy import bramki — instrukcja, nie wzmianka.
 *
 * Poprzednia wersja zwalniala plik, w ktorym gdziekolwiek wystepowal napis
 * `lib/acceptance-target.mjs`, wiec **komentarz zwalnial plik, ktory bramki
 * nigdy nie importowal**. Komentarze sa tu najpierw usuwane, a potem szukana
 * jest instrukcja importu.
 */
const IMPORT_BRAMKI =
  /(?:^|\n)\s*(?:import[^;\n]*from\s*|await\s+import\s*\(\s*)['"][^'"]*lib\/acceptance-target\.mjs['"]/;

/** Ślady wykonania żądania HTTP albo otwarcia przeglądarki. */
const ROBI_SIEC =
  /\bfetch\s*\(|\bchromium\b|\bfirefox\b|\bwebkit\b|page\.goto\s*\(|https?\.request\s*\(|\bcurl\b|\bwget\b/;

const bezKomentarzy = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').replace(/^\s*#[^\n]*/gm, ' ');

/** Rekurencyjnie: podkatalog to nie jest miejsce poza zasięgiem reguły. */
function skryptyPod(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...skryptyPod(resolve(dir, entry.name), rel));
    else if (WYKONYWALNE.test(entry.name)) out.push(rel);
  }
  return out;
}

interface Wpis {
  /** Czy plik wykonuje żądania HTTP albo otwiera przeglądarkę. */
  siec: boolean;
  /** Dlaczego wolno mu to robić bez bramki. Wymagane, gdy `siec`. */
  powod: string;
}

/**
 * Reguła, licząc od operacji, nie od adresu.
 *
 * Każdy plik wykonywalny w `scripts/` musi być **sklasyfikowany**: albo
 * importuje bramkę, albo ma wpis mówiący, czy w ogóle rusza sieć i dlaczego
 * wolno mu bez niej. Deklaracja „nie rusza sieci” jest sprawdzana krzyżowo —
 * plik, który ją składa, a zawiera `fetch(`, oblewa.
 */
export function problemyKlasyfikacji(root: string, klasyfikacja: Record<string, Wpis>): string[] {
  const problemy: string[] = [];
  const pliki = skryptyPod(root);
  for (const plik of pliki) {
    const tekst = readFileSync(resolve(root, plik), 'utf8');
    const kod = bezKomentarzy(tekst);
    if (IMPORT_BRAMKI.test(kod)) continue;
    const wpis = klasyfikacja[plik];
    if (!wpis) {
      problemy.push(
        `${plik}: nie importuje bramki i nie ma wpisu w klasyfikacji — ` +
          'dopisz go albo przepuść przez requireAcceptanceInstance',
      );
      continue;
    }
    if (!wpis.siec && ROBI_SIEC.test(kod)) {
      problemy.push(`${plik}: zadeklarowany jako bez sieci, a wykonuje żądanie albo otwiera przeglądarkę`);
    }
    if (wpis.siec && wpis.powod.trim().length < 20) {
      problemy.push(`${plik}: zwolniony z bramki bez powodu`);
    }
  }
  for (const plik of Object.keys(klasyfikacja)) {
    if (!pliki.includes(plik)) problemy.push(`${plik}: wpis w klasyfikacji wskazuje nieistniejący plik`);
  }
  return problemy;
}

const SONDA_W_ZAKRESIE_TESTOWYM =
  'historyczna sonda odbiorowa: cel domyślnie w zakresie 8792-8799, uruchamiana ręcznie przy audycie, ' +
  'nie jest częścią żadnego udokumentowanego polecenia';

/** Każdy plik wykonywalny w `scripts/`, który nie importuje bramki. */
const KLASYFIKACJA: Record<string, Wpis> = {
  'acceptance-matrix.mjs': { siec: false, powod: '' },
  'audit-matrix.mjs': { siec: false, powod: '' },
  'audit-probe-chat-layout.mjs': { siec: true, powod: SONDA_W_ZAKRESIE_TESTOWYM },
  'audit-probe-chat-tools.mjs': { siec: true, powod: SONDA_W_ZAKRESIE_TESTOWYM },
  'audit-probe-remount.mjs': { siec: true, powod: SONDA_W_ZAKRESIE_TESTOWYM },
  'audit-probes-api.mjs': { siec: true, powod: SONDA_W_ZAKRESIE_TESTOWYM },
  'audit-probes-browser.mjs': { siec: true, powod: SONDA_W_ZAKRESIE_TESTOWYM },
  'audit-probes-model.mjs': { siec: true, powod: SONDA_W_ZAKRESIE_TESTOWYM },
  'audit-probes.ts': { siec: false, powod: '' },
  'audit-server.sh': {
    siec: true,
    powod:
      'startuje WLASNY serwer (domyslnie 8795, wlasny katalog danych) i czeka na jego GET /api/health; ' +
      'jedyne zadanie idzie do procesu, ktorego sam jest rodzicem — znalezione przez kontrole krzyzowa ' +
      'tej reguly, bo pierwsza klasyfikacja mowila blednie "bez sieci"',
  },
  'audit-versions.mjs': { siec: false, powod: '' },
  'backup-state.mjs': { siec: false, powod: '' },
  'check-boundaries.mjs': { siec: false, powod: '' },
  'check-module-swap.mjs': {
    siec: true,
    powod:
      'odpytuje wyłącznie serwer, którego sam jest rodzicem: port wybiera z wolnych (freePort), ' +
      'katalog danych ma w katalogu tymczasowym kopii, a proces zatrzymuje w finally',
  },
  'check-versions.mjs': {
    siec: true,
    powod: 'jedyny cel to registry.npmjs.org — nie instancja aplikacji; żadnego zapisu, tylko odczyt wersji',
  },
  'closure-evidence.sh': { siec: false, powod: '' },
  'closure-matrix.mjs': { siec: false, powod: '' },
  'closure-probe-cancel.mjs': { siec: true, powod: SONDA_W_ZAKRESIE_TESTOWYM },
  'closure-probe-chat-layout.mjs': { siec: true, powod: SONDA_W_ZAKRESIE_TESTOWYM },
  'closure-probe-restore.mjs': { siec: true, powod: SONDA_W_ZAKRESIE_TESTOWYM },
  'closure-probe-select.mjs': { siec: true, powod: SONDA_W_ZAKRESIE_TESTOWYM },
  'closure-probe-tool-dom.mjs': { siec: true, powod: SONDA_W_ZAKRESIE_TESTOWYM },
  'closure-server.sh': {
    siec: true,
    powod:
      'to samo co audit-server.sh, port domyslnie 8796: startuje wlasny serwer i czeka na jego ' +
      'GET /api/health; zadne zadanie nie idzie do cudzej instancji',
  },
  'detection-trials.mjs': { siec: false, powod: '' },
  'dev-server.sh': {
    siec: true,
    powod:
      'jedyne żądanie to GET /api/health na 8791 — sprawdza, czy port zajmuje instancja użytkownika, ' +
      'żeby tryb deweloperski jej nie wyparł; odczyt, nigdy zapis',
  },
  'lib/acceptance-target.mjs': {
    siec: true,
    powod: 'to JEST bramka: jej jedyne żądanie to odczyt etykiety z /api/health, od którego zależy reszta',
  },
  'lib/state-tools.mjs': { siec: false, powod: '' },
  'matrix-summary.mjs': { siec: false, powod: '' },
  'migration-rehearsal.mjs': { siec: false, powod: '' },
  'openui-library-schema.mjs': { siec: false, powod: '' },
  'probe-refresh-refused.ts': {
    siec: false,
    powod: '',
  },
  'probe-sdk-session.ts': { siec: false, powod: '' },
  'probe-which-cli.mjs': { siec: false, powod: '' },
  'restore-state.mjs': { siec: false, powod: '' },
  'synthetic-state.mjs': { siec: false, powod: '' },
  'typecheck-modules.mjs': { siec: false, powod: '' },
};

describe('klasa: skrypty a bramka instancji', () => {
  /*
   * Reguła liczona od OPERACJI, nie od adresu — i to jest cała poprawka.
   *
   * Poprzednia wersja szukała w tekście adresu pętli zwrotnej z literalnym
   * portem i zwalniała plik, w którym gdziekolwiek padł napis z nazwą bramki.
   * Recenzent obszedł ją sześć razy na sześć prób: skan nierekurencyjny,
   * rozszerzenie `.cjs`, port w interpolacji, adres ze sklejenia, port z
   * `process.env`, zapis `http://[::1]:8791` — a każde obejście POST-owało na
   * 8791. Kształtów zapisu adresu jest nieskończenie wiele; operacji jest
   * kilka, a gardło już istnieje.
   *
   * Dlatego: każdy plik wykonywalny musi być sklasyfikowany, zwolnienie wynika
   * z **importu**, a deklaracja „bez sieci” jest sprawdzana krzyżowo.
   */
  it('kazdy skrypt jest sklasyfikowany, a deklaracja "bez sieci" sie zgadza', () => {
    const problemy = problemyKlasyfikacji(resolve(REPO, 'scripts'), KLASYFIKACJA);
    expect(problemy, problemy.join('\n')).toEqual([]);
    // Skan, który niczego nie obejrzał, też zwróciłby pustą listę.
    expect(skryptyPod(resolve(REPO, 'scripts')).length).toBeGreaterThan(30);
    expect(skryptyPod(resolve(REPO, 'scripts'))).toContain('lib/acceptance-target.mjs');
  });

  it('PROBA ZDOLNOSCI WYKRYCIA: szesc obejsc recenzenta oblewa regule', () => {
    /*
     * Każde z sześciu obejść, na kontrolowanym drzewie, plus siódmy przypadek:
     * plik, który deklaruje „bez sieci” i kłamie. Adres nie ma tu żadnego
     * znaczenia — reguła patrzy na `fetch(`.
     */
    const root = tmpKatalog();
    mkdirSync(resolve(root, 'zzevade'), { recursive: true });
    const zapisz = (rel: string, tresc: string) => writeFileSync(resolve(root, rel), tresc);

    zapisz('zzevade/probe.mjs', "await fetch('http://127.0.0.1:8791/api/auth/session', { method: 'POST' });\n");
    zapisz('obejscie.cjs', "fetch('http://127.0.0.1:8791/api/auth/session', { method: 'POST' });\n");
    zapisz('interpolacja.mjs', 'const p = 8791;\nawait fetch(`http://127.0.0.1:${p}/api/x`);\n');
    zapisz('sklejenie.mjs', "await fetch('http://127.0.0.1:' + 8791 + '/api/x');\n");
    zapisz('ze-srodowiska.mjs', "await fetch(`http://127.0.0.1:${process.env.X ?? 8791}/api/x`);\n");
    zapisz('ipv6.mjs', "await fetch('http://[::1]:8791/api/x');\n");
    zapisz(
      'klamie.mjs',
      "/* import { requireAcceptanceInstance } from './lib/acceptance-target.mjs'; */\n" +
        "await fetch('http://127.0.0.1:8791/api/x');\n",
    );

    const problemy = problemyKlasyfikacji(root, { 'klamie.mjs': { siec: false, powod: '' } });
    const zgloszone = problemy.join('\n');
    for (const plik of [
      'zzevade/probe.mjs',
      'obejscie.cjs',
      'interpolacja.mjs',
      'sklejenie.mjs',
      'ze-srodowiska.mjs',
      'ipv6.mjs',
    ]) {
      expect(zgloszone, `${plik} przeszedl regule`).toContain(plik);
    }
    // Komentarz z nazwą bramki nie zwalnia: plik deklaruje „bez sieci” i kłamie.
    expect(zgloszone).toContain('klamie.mjs: zadeklarowany jako bez sieci');
    expect(problemy.length).toBe(7);
  });

  it('kontrola przeciwna: plik z prawdziwym importem bramki przechodzi', () => {
    // Bez tego poprzedni test przeszedłby też na regule odrzucającej wszystko.
    const root = tmpKatalog();
    writeFileSync(
      resolve(root, 'uczciwy.mjs'),
      "import { requireAcceptanceInstance } from './lib/acceptance-target.mjs';\n" +
        'await requireAcceptanceInstance(process.env);\n' +
        "await fetch('http://127.0.0.1:8791/api/x');\n",
    );
    expect(problemyKlasyfikacji(root, {})).toEqual([]);
  });

  it('wpis wskazujacy nieistniejacy plik jest bledem', () => {
    const root = tmpKatalog();
    writeFileSync(resolve(root, 'jest.mjs'), 'console.log(1);\n');
    expect(problemyKlasyfikacji(root, { 'jest.mjs': { siec: false, powod: '' }, 'nie-ma.mjs': { siec: false, powod: '' } })).toEqual(
      ['nie-ma.mjs: wpis w klasyfikacji wskazuje nieistniejący plik'],
    );
  });
});

describe('run-agent.mjs wobec instancji uzytkownika', () => {
  it('nie wysyla ZADNEGO zapisu do instancji bez etykiety i konczy sie bledem', async () => {
    const base = await instanceAnswering(null);
    const out = await runScript(base);

    expect(out.status, `stderr: ${out.stderr}`).toBe(3);
    expect(out.stderr).toContain('proba odbiorowa');
    expect(out.stderr).toContain('Zadne zadanie nie zostalo wyslane');

    /*
     * The assertion the criterion is about: the refusal happened *before* the
     * write, not next to it. `/api/auth/session` is already a POST, so the list
     * has to contain the health probe and nothing else.
     */
    expect(seen).toEqual(['GET /api/health']);
    expect(seen.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('kontrola przeciwna: przy dozwolonej etykiecie skrypt naprawde pisze', async () => {
    /*
     * Without this, the test above could pass for the wrong reason — a script
     * that crashes on startup also sends no POST. Here the same stand-in says
     * `agenticapp-dev`, and the POST has to arrive.
     */
    const base = await instanceAnswering('agenticapp-dev');
    const out = await runScript(base);

    expect(out.stdout).toContain(`# instancja: ${base}`);
    expect(seen).toContain('GET /api/health');
    expect(seen).toContain('POST /api/auth/session');
    expect(seen).toContain('POST /api/agui/run');
    // The stand-in refuses the run itself, so the script reports the HTTP error.
    expect(out.status).toBe(1);
  });
});
