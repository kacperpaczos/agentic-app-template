import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Every path a state script can be pointed at is accounted for — and what this
 * test does **not** promise is written down here, because a previous version of
 * it promised more than it delivered.
 *
 * **What the scripts guarantee.** A state script reads its command line through
 * `makeArgs(process.argv, FLAGS)`, which refuses any `--flag` that is not in
 * that script's own declaration. A flag therefore cannot be *used* without
 * being declared, whatever the code that would read it looks like: a
 * double-quoted literal, a computed name, a hand-rolled `args.indexOf('--x')`
 * — none of them help, because the refusal happens before the script runs. The
 * previous version of this test scanned the source for `flag('...')` instead,
 * and a reviewer walked past it with `flag("raport")` — a double-quoted string
 * — destroying a database while the test stayed green.
 *
 * **What this test then checks.** For every script in `scripts/` that uses the
 * shared state library, and for every flag it declares: that the declaration is
 * complete, and that the **behaviour matches the kind claimed**, by running the
 * script against a directory that looks like a live installation.
 *
 * **What neither covers, stated plainly:**
 *   - a path that reaches a script other than through a command-line flag — an
 *     environment variable, a config file, a constant. Nothing here sees those;
 *   - a script that does not use `lib/state-tools.mjs` at all. It would have
 *     none of these protections and is outside this file's claim — the test
 *     lists which scripts it covers so that gap is visible rather than implied;
 *   - a flag deliberately mis-declared (a writing flag called `wartosc`). The
 *     kind is then a lie in the file, not an omission — but every kind now has
 *     a behavioural consequence, so the lie has to survive an actual run: the
 *     universal invariant below applies whatever the kind says.
 *
 * **The universal invariant**, which is what makes the kinds more than labels:
 * *no flag may modify the directory it is pointed at*, except the one kind
 * whose entire purpose is to write there (`zapis-docelowy`). That is checked by
 * fingerprinting the whole directory around every single run.
 */

const REPO = resolve(import.meta.dirname, '..');
const ROOT = resolve(REPO, '.e2e-bl07');
const SCRIPTS_DIR = resolve(REPO, 'scripts');

type Kind = 'zapis-chroniony' | 'odczyt-chroniony' | 'zapis-docelowy' | 'odczyt' | 'wartosc' | 'przelacznik';
interface FlagDecl {
  kind: Kind;
  why: string;
}

/**
 * The scripts under this test's claim: everything in `scripts/` that imports
 * the shared state library.
 *
 * Read from the directory rather than typed out — a hand-written list is how a
 * new script quietly ends up uncovered, which is the same failure this whole
 * file exists to prevent.
 */
function stateScripts(): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.mjs'))
    /*
     * Any mention of the module, not one spelling of one import statement. The
     * first version matched `from './lib/state-tools.mjs'` with single quotes,
     * and a reviewer added a script importing it with double quotes: invisible
     * to the test, and therefore outside every check in this file. Matching the
     * module name covers single quotes, double quotes, backticks and a dynamic
     * import with a literal path. A module path assembled at runtime would
     * still escape — see the scope note at the top.
     */
    .filter((f) => /state-tools/.test(readFileSync(resolve(SCRIPTS_DIR, f), 'utf8')))
    .sort();
}

const SCRIPTS = stateScripts();

const ODMOWA_DANYCH = /lezy w katalogu danych aplikacji|zawiera katalog danych aplikacji/;

function run(script: string, args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [resolve(SCRIPTS_DIR, script), ...args], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** SHA-256 of every file in a tree — used to prove a run changed nothing. */
function odcisk(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        out[full.slice(dir.length + 1)] = createHash('sha256').update(readFileSync(full)).digest('hex');
      }
    }
  };
  walk(dir);
  /*
   * SQLite's side files are left out, and it is worth being exact about what
   * that costs. Any connection — read-only included — can create `app.db-shm`
   * and an empty `app.db-wal`, so a script that merely *reads* a database makes
   * them appear; comparing them would flag reading as a modification.
   *
   * What the comparison still covers: every other file, including `app.db`
   * itself, and the *disappearance* of a log. `delete` removes the key whether
   * or not it was there, so a `-wal` that existed before and is gone afterwards
   * does not show up here — that case is covered instead by `tidy` refusing to
   * remove a log outside a directory this run approved, and by the backup tests
   * that read the WAL-only row back.
   */
  delete out['app.db-shm'];
  delete out['app.db-wal'];
  return out;
}

let work: string;
let zyweDane: string;
let plikUzytkownika: string;
let kopia: string;
let kopiaZSekretem: string;
let zrodlo: string;

const swiezy = (name: string) => resolve(work, `${name}-${Math.random().toString(36).slice(2, 8)}`);

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  work = mkdtempSync(join(ROOT, 'flagi-'));

  // A directory indistinguishable from a live installation, built by hand: no
  // marker of ours, a session secret, a database and a file to lose.
  zyweDane = resolve(work, 'zywe-dane');
  mkdirSync(resolve(zyweDane, 'files', 'local-user'), { recursive: true });
  writeFileSync(resolve(zyweDane, 'session.secret'), 'sekret-instalacji\n');
  writeFileSync(resolve(zyweDane, 'app.db'), 'BAZA UZYTKOWNIKA\n');
  plikUzytkownika = resolve(zyweDane, 'files', 'local-user', 'waznyplik.txt');
  writeFileSync(plikUzytkownika, 'tresc uzytkownika\n');

  zrodlo = resolve(work, 'zrodlo');
  expect(run('synthetic-state.mjs', ['--out', zrodlo, '--stage', 'current']).status).toBe(0);
  kopia = resolve(work, 'kopia');
  expect(run('backup-state.mjs', ['--data', zrodlo, '--out', kopia]).status).toBe(0);

  /*
   * A backup that *also* looks live. Needed by the reading flags: pointed at a
   * bare data directory they bail out on the missing manifest before touching
   * anything, so the run would prove nothing about whether reading live data is
   * allowed. This one they can actually process.
   */
  kopiaZSekretem = resolve(work, 'kopia-z-sekretem');
  expect(run('backup-state.mjs', ['--data', zrodlo, '--out', kopiaZSekretem]).status).toBe(0);
  writeFileSync(resolve(kopiaZSekretem, 'session.secret'), 'sekret-instalacji\n');
}, 300_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/**
 * How to invoke each flag so the guard under test is the one that answers.
 *
 * Hand-written, and *required*: a declared flag with no recipe fails the test,
 * so a new path argument cannot be added without someone deciding how it is
 * exercised. `cel` is the directory that is supposed to survive.
 */
const PRZEPISY: Record<string, (cel: string) => string[]> = {
  'backup-state.mjs:data': (cel) => ['--data', cel, '--out', swiezy('out')],
  'backup-state.mjs:out': (cel) => ['--data', zrodlo, '--out', cel],
  'backup-state.mjs:verify': (cel) => ['--verify', cel],
  'migration-rehearsal.mjs:backup': (cel) => ['--backup', cel, '--out', swiezy('proba')],
  'migration-rehearsal.mjs:out': (cel) => ['--backup', kopia, '--out', cel],
  'migration-rehearsal.mjs:json': (cel) => ['--backup', kopia, '--out', swiezy('proba'), '--json', join(cel, 'raport.json')],
  'restore-state.mjs:backup': (cel) => ['--backup', cel, '--data', swiezy('cel'), '--check'],
  'restore-state.mjs:data': (cel) => ['--backup', kopia, '--data', cel],
  'synthetic-state.mjs:out': (cel) => ['--out', cel, '--stage', 'empty'],
  'synthetic-state.mjs:stage': (cel) => ['--stage', cel, '--out', swiezy('sy')],
  /*
   * Switches get the target handed to them too, deliberately. A flag that takes
   * no value must *ignore* what follows it; one that secretly treats it as a
   * path is precisely the escape this rule closes, and the invariant below then
   * catches it.
   */
  'restore-state.mjs:check': (cel) => ['--check', cel, '--backup', kopia, '--data', swiezy('cel')],
  'synthetic-state.mjs:list': (cel) => ['--list', cel],
  'synthetic-state.mjs:leave-wal': (cel) => [
    '--leave-wal', cel, '--out', swiezy('sy-wal'), '--stage', 'current',
  ],
};

/** Reading flags need a target they can actually process (see `kopiaZSekretem`). */
const CEL_DLA_ODCZYTU: Record<string, () => string> = {
  'backup-state.mjs:verify': () => kopiaZSekretem,
  'restore-state.mjs:backup': () => kopiaZSekretem,
};

describe('kazda flaga skryptow stanu ma rozstrzygniecie sprawdzone zachowaniem', () => {
  const deklaracje = new Map<string, Record<string, FlagDecl>>();

  beforeAll(async () => {
    for (const script of SCRIPTS) {
      const mod = (await import(resolve(SCRIPTS_DIR, script))) as { FLAGS?: Record<string, FlagDecl> };
      expect(mod.FLAGS, `${script} uzywa lib/state-tools.mjs, ale nie deklaruje FLAGS`).toBeDefined();
      deklaracje.set(script, mod.FLAGS!);
    }
  });

  it('obejmuje wszystkie skrypty stanu, wyliczone z katalogu', () => {
    // Guards the whole file against becoming empty, and names its own scope.
    expect(SCRIPTS).toEqual([
      'backup-state.mjs',
      'migration-rehearsal.mjs',
      'restore-state.mjs',
      'synthetic-state.mjs',
    ]);
  });

  it.each(SCRIPTS)('%s: odmawia flagi, ktorej nie zadeklarowano', (script) => {
    /*
     * The mechanism everything else rests on. A flag that is not declared
     * cannot be passed, so it cannot reach any code — which is what makes
     * "every flag is accounted for" true without anyone scanning for flags.
     */
    const przed = odcisk(zyweDane);
    const r = run(script, ['--flaga-ktorej-nie-ma', zyweDane]);
    expect(r.status, `${script} przyjelo nieznana flage: ${r.out}`).toBe(2);
    expect(r.out).toMatch(/nieznana flaga --flaga-ktorej-nie-ma/);
    expect(odcisk(zyweDane)).toEqual(przed);
  }, 120_000);

  it.each(SCRIPTS)('%s: kazda flaga ma znany rodzaj, uzasadnienie i przepis', (script) => {
    for (const [flag, decl] of Object.entries(deklaracje.get(script)!)) {
      expect(
        ['zapis-chroniony', 'odczyt-chroniony', 'zapis-docelowy', 'odczyt', 'wartosc', 'przelacznik'],
        `${script} --${flag}: nieznany rodzaj ${decl.kind}`,
      ).toContain(decl.kind);
      expect(decl.why.length, `${script} --${flag}: brak uzasadnienia`).toBeGreaterThan(40);
      const przepis = PRZEPISY[`${script}:${flag}`];
      expect(
        przepis,
        `${script} --${flag}: brak przepisu na wywolanie — dopisz go i rozstrzygnij, ` +
          'jak ta flaga ma sie zachowac wobec katalogu danych',
      ).toBeDefined();

      /*
       * The recipe has to actually exercise the flag, with the target right
       * behind it. Without this the whole file could be satisfied by a recipe
       * that omits the flag under test: a reviewer declared a deleting flag as
       * `przelacznik`, wrote a recipe that never passed it, and everything
       * stayed green while `--raport <ofiara>` destroyed a directory.
       */
      const argv = przepis!('/CEL');
      const i = argv.indexOf(`--${flag}`);
      expect(i, `${script} --${flag}: przepis nie podaje tej flagi`).toBeGreaterThanOrEqual(0);
      expect(
        argv[i + 1],
        `${script} --${flag}: po fladze musi stac katalog-cel, zeby bylo co sprawdzac`,
      ).toContain('/CEL');
    }
  });

  /* ------------------------------------------------------------------ */
  /* One behavioural check per kind. No kind is exempt.                  */
  /* ------------------------------------------------------------------ */

  it.each(SCRIPTS)('%s: zachowanie kazdej flagi zgadza sie z jej rodzajem', (script) => {
    for (const [flag, decl] of Object.entries(deklaracje.get(script)!)) {
      const przepis = PRZEPISY[`${script}:${flag}`]!;
      const opis = `${script} --${flag} (${decl.kind})`;

      if (decl.kind === 'zapis-docelowy') {
        /*
         * Never run against the live directory: writing into one is this kind's
         * purpose, and the run would do exactly that. (It did, the first time
         * this loop was written — the restore moved the victim directory aside
         * and replaced it, and the invariant below is what noticed.)
         *
         * The protection this kind has instead — a non-empty target must look
         * like a data directory — is checked here rather than assumed, which is
         * what stops the kind from being a way out.
         */
        const obcy = swiezy('obcy-cel');
        mkdirSync(obcy, { recursive: true });
        writeFileSync(resolve(obcy, 'notatki.md'), 'tresc\n');
        const przedObcym = odcisk(obcy);
        const odmowa = run(script, przepis(obcy));
        expect(odmowa.status, `${opis} przyjelo katalog, ktory nie jest katalogiem danych: ${odmowa.out}`).toBe(2);
        expect(odmowa.out).toMatch(/nie wyglada na katalog danych aplikacji/);
        // Fingerprinted like every other branch — the claim that every run is
        // measured has to be true of this one too.
        expect(odcisk(obcy), `${opis} zmienilo katalog, ktory odrzucilo`).toEqual(przedObcym);
        expect(readFileSync(resolve(obcy, 'notatki.md'), 'utf8')).toBe('tresc\n');
        continue;
      }

      const cel = CEL_DLA_ODCZYTU[`${script}:${flag}`]?.() ?? zyweDane;
      const przed = odcisk(cel);
      const r = run(script, przepis(cel));

      if (decl.kind === 'zapis-chroniony' || decl.kind === 'odczyt-chroniony') {
        expect(r.status, `${opis} nie odmowilo: ${r.out}`).toBe(2);
        expect(r.out, `${opis}: odmowa z innego powodu niz katalog danych`).toMatch(ODMOWA_DANYCH);
      } else {
        // odczyt / wartosc / przelacznik: allowed to run, never to write.
        expect(r.out, `${opis} zostalo odrzucone jako katalog danych, a nie jest chronione`)
          .not.toMatch(ODMOWA_DANYCH);
      }

      /*
       * The invariant that holds whatever the declaration claims: the directory
       * the flag was pointed at is byte-for-byte what it was. A writing flag
       * mis-declared as `wartosc` fails here even though its kind exempts it
       * from everything above.
       */
      expect(odcisk(cel), `${opis} ZMIENILO katalog, na ktory je wskazano`).toEqual(przed);
      expect(readFileSync(plikUzytkownika, 'utf8')).toBe('tresc uzytkownika\n');
    }
  }, 600_000);

  it('flagi czytajace naprawde przetwarzaja wskazany katalog, a nie odpadaja wczesniej', () => {
    /*
     * Without this the reading cases would pass vacuously: pointed at a bare
     * data directory, `--verify` and `restore --backup` stop at the missing
     * manifest before they read anything, and "was not refused as a data
     * directory" would be true of a script that did nothing at all.
     *
     * Here they are given a real backup that also carries a `session.secret`,
     * so they get all the way through — which is the behaviour the `odczyt`
     * kind actually claims.
     */
    const weryfikacja = run('backup-state.mjs', ['--verify', kopiaZSekretem]);
    expect(weryfikacja.status, weryfikacja.out).toBe(0);
    expect(weryfikacja.out).toMatch(/sprawdzona: bez zastrzezen/);

    const odtworzenie = run('restore-state.mjs', ['--backup', kopiaZSekretem, '--data', swiezy('cel'), '--check']);
    expect(odtworzenie.status, odtworzenie.out).toBe(0);
    expect(odtworzenie.out).toMatch(/migracje w kopii/);
  }, 180_000);

  /* ------------------------------------------------------------------ */
  /* The chokepoint: the check sits at the operation, not at the argument */
  /* ------------------------------------------------------------------ */

  it.each(SCRIPTS)('%s: nie wola sam operacji kasujacych, przenoszacych i nadpisujacych', (script) => {
    /*
     * Five rounds of guarding the *argument* were walked around five times: by
     * a double-quoted literal, by a kind exempt from the checks, by a
     * positional argument the parser skipped. The shapes an argument can take
     * are unbounded.
     *
     * So the check moved to the operation. `rmSync`, `renameSync`,
     * `writeFileSync`, `copyFileSync`, `cpSync` and `mkdirSync` are called in
     * exactly one module — `lib/state-tools.mjs` — where each one verifies, at
     * the moment of the call, that the path lies inside a directory this run
     * approved. How the path arrived stops mattering: flag, positional,
     * environment variable, configuration file, constant.
     *
     * This test keeps it that way. It is a source check, and therefore about
     * omission rather than adversaries: `await import('node:fs')` inside a
     * function would slip past it. It is here because the next person adding a
     * script will reach for `rmSync` out of habit, not to defeat anything.
     */
    const zakazane = ['rmSync', 'renameSync', 'writeFileSync', 'copyFileSync', 'cpSync', 'mkdirSync'];
    const zrodlo = readFileSync(resolve(SCRIPTS_DIR, script), 'utf8');
    const linie = zrodlo.split('\n');

    for (const fn of zakazane) {
      const trafienia = linie
        .map((line, i) => ({ line, nr: i + 1 }))
        .filter(({ line }) => new RegExp(`(^|[^.\\w])${fn}\\s*\\(`).test(line))
        .filter(({ line }) => !/^\s*\*/.test(line) && !/^\s*\/\//.test(line));

      expect(
        trafienia.map((t) => `${script}:${t.nr}`),
        `${script} wola ${fn} bezposrednio — ma przejsc przez guarded operacje z lib/state-tools.mjs ` +
          `(usun, przenies, zapisz, kopiujPlik, kopiujDrzewo, utworzKatalog)`,
      ).toEqual([]);
    }
  });

  it('operacja kasujaca poza zatwierdzonym katalogiem jest odrzucana w chwili wykonania', async () => {
    /*
     * The chokepoint itself, exercised directly rather than through a script:
     * a path that no step approved is refused **at the call**, which is what
     * makes the route it arrived by irrelevant.
     */
    const lib = await import(resolve(SCRIPTS_DIR, 'lib/state-tools.mjs'));
    const ofiara = swiezy('ofiara-bez-zatwierdzenia');
    mkdirSync(ofiara, { recursive: true });
    writeFileSync(resolve(ofiara, 'plik.txt'), 'tresc\n');

    expect(() => lib.usun(ofiara, { recursive: true, force: true })).toThrow(/poza katalogami zatwierdzonymi/);
    expect(() => lib.zapisz(resolve(ofiara, 'plik.txt'), 'nadpisane')).toThrow(/poza katalogami zatwierdzonymi/);
    expect(() => lib.przenies(ofiara, `${ofiara}-gdzie-indziej`)).toThrow(/poza katalogami zatwierdzonymi/);
    expect(readFileSync(resolve(ofiara, 'plik.txt'), 'utf8')).toBe('tresc\n');

    // ...and the same call works once the directory has been approved.
    lib.approveTarget(ofiara, { what: 'Katalog testowy' });
    expect(() => lib.zapisz(resolve(ofiara, 'plik.txt'), 'nadpisane')).not.toThrow();
    expect(readFileSync(resolve(ofiara, 'plik.txt'), 'utf8')).toBe('nadpisane');
  }, 60_000);

  it('argument pozycyjny jest odrzucany, a nie ignorowany', () => {
    /*
     * The third escape: `backup-state.mjs <ofiara> --data X --out Y` used to
     * sail past a parser that inspected only `--tokens`. These scripts take no
     * positional arguments, so one on the command line is a mistake — and the
     * one thing never to do with an unexpected path is to ignore it.
     */
    for (const script of SCRIPTS) {
      const przed = odcisk(zyweDane);
      const r = run(script, [zyweDane, '--out', swiezy('poz'), '--stage', 'empty']);
      expect(r.status, `${script} przyjelo argument pozycyjny: ${r.out}`).toBe(2);
      expect(r.out).toMatch(/argument pozycyjny/);
      expect(odcisk(zyweDane), `${script} zmienilo katalog podany pozycyjnie`).toEqual(przed);
    }
  }, 120_000);

  it('backup-state --data faktycznie kopiuje zywy katalog danych', () => {
    /*
     * The one flag allowed to point at live data, asserted positively. Saying
     * only "it is not refused" would be satisfied by a script that failed for
     * some other reason — and leaving it off the list entirely would look
     * exactly like the omission that let a backup overwrite a user's database.
     */
    const zywaBaza = swiezy('zywa-z-baza');
    expect(run('synthetic-state.mjs', ['--out', zywaBaza, '--stage', 'current']).status).toBe(0);
    writeFileSync(resolve(zywaBaza, 'session.secret'), 'sekret\n');

    const cel = swiezy('kopia-zywego');
    const r = run('backup-state.mjs', ['--data', zywaBaza, '--out', cel]);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(resolve(cel, 'manifest.json'))).toBe(true);
    expect(existsSync(resolve(cel, 'session.secret'))).toBe(false);
  }, 180_000);
});
