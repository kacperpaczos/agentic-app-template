import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Every path a state script can be pointed at goes through the shared guard —
 * or says, in the script itself, why it does not.
 *
 * **Why this test exists.** This package shipped the same defect three times:
 * a guard that watched the wrong argument.
 *
 *   1. `--out` in the generator and the rehearsal compared paths for equality,
 *      so `--out <dane>/files` deleted a directory of user files, exit 0;
 *   2. `--out` in `backup-state.mjs` never went through the shared guard at
 *      all — the only check in that file compared it with `--data` — so a
 *      backup *into* a live data directory overwrote the user's database and
 *      reported success;
 *   3. `--json` in the rehearsal overwrote whatever file it named, and nothing
 *      asked where that file was.
 *
 * Each was found by a person reading the code, never by a test, and each time
 * the fix was local. What was missing is the thing this file is: a check that
 * **enumerates** the paths a script accepts, so a new one cannot be added
 * quietly without an answer to "and what protects this?".
 *
 * How it avoids passing vacuously — the failure mode of every "check them all"
 * test:
 *
 *   - the flags are read out of each script's **source**, not typed here, so a
 *     flag added to the code is on the list whether or not anyone remembered;
 *   - a flag with no `FLAGS` entry in its own script fails the test;
 *   - a flag with no invocation recipe *here* fails the test, so adding one
 *     forces a decision about how it is exercised;
 *   - and for every protected flag the script is actually **run**, pointed at a
 *     directory that looks live, and has to refuse — a declaration on its own
 *     proves nothing.
 *
 * The read/write distinction is explicit rather than implied by omission:
 * `--data` in `backup-state.mjs` is *declared* unprotected, with its reason,
 * and this test asserts it really does work against a live directory. Silently
 * leaving it off the list would look identical to the defect above.
 */

const REPO = resolve(import.meta.dirname, '..');
const ROOT = resolve(REPO, '.e2e-bl07');

type Kind = 'zapis-chroniony' | 'odczyt-chroniony' | 'zapis-docelowy' | 'odczyt' | 'wartosc';
interface FlagDecl {
  kind: Kind;
  why: string;
}

const SCRIPTS = [
  'backup-state.mjs',
  'migration-rehearsal.mjs',
  'restore-state.mjs',
  'synthetic-state.mjs',
] as const;
type Script = (typeof SCRIPTS)[number];

/** The refusal that means "this path is, or is inside, application data". */
const ODMOWA_DANYCH = /lezy w katalogu danych aplikacji|zawiera katalog danych aplikacji/;

function run(script: string, args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [resolve(REPO, 'scripts', script), ...args], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** SHA-256 of every file in a tree — used to prove a refusal changed nothing. */
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
  return out;
}

/**
 * The flags a script really uses, read from its source.
 *
 * `flag('x')` is the only way these scripts read a value, so this is the whole
 * set. Boolean switches go through `has()` and never carry a path.
 */
function flagiWKodzie(script: Script): string[] {
  const source = readFileSync(resolve(REPO, 'scripts', script), 'utf8');
  /*
   * Only real call sites: the declaration block below each script's header
   * mentions the same names in prose, and matching those would make the list
   * agree with itself instead of with the code.
   */
  const calls = [...source.matchAll(/(?<![\w.])flag\(\s*'([a-z][a-z-]*)'/g)].map((m) => m[1]!);
  return [...new Set(calls)].sort();
}

let work: string;
let zyweDane: string;
let plikUzytkownika: string;
let kopia: string;
let zrodlo: string;

const swiezy = (name: string) => resolve(work, name);

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  work = mkdtempSync(join(ROOT, 'flagi-'));

  /*
   * A directory that looks exactly like a live installation, built by hand:
   * no marker of ours, a `session.secret`, a database and a file to lose.
   */
  zyweDane = swiezy('zywe-dane');
  mkdirSync(resolve(zyweDane, 'files', 'local-user'), { recursive: true });
  writeFileSync(resolve(zyweDane, 'session.secret'), 'sekret-instalacji\n');
  writeFileSync(resolve(zyweDane, 'app.db'), 'BAZA UZYTKOWNIKA\n');
  plikUzytkownika = resolve(zyweDane, 'files', 'local-user', 'waznyplik.txt');
  writeFileSync(plikUzytkownika, 'tresc uzytkownika\n');

  // A real synthetic directory and a real backup of it, so every script can be
  // invoked with its other arguments valid and actually reach the guard.
  zrodlo = swiezy('zrodlo');
  expect(run('synthetic-state.mjs', ['--out', zrodlo, '--stage', 'current']).status).toBe(0);
  kopia = swiezy('kopia');
  expect(run('backup-state.mjs', ['--data', zrodlo, '--out', kopia]).status).toBe(0);
}, 300_000);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

/**
 * How to invoke each flag so that the guard under test is the one that answers.
 *
 * Hand-written — but *required*: a declared flag with no recipe fails the test
 * below, so a new path argument cannot be added without someone deciding how it
 * gets exercised. `cel` is the directory that looks live.
 */
const PRZEPISY: Record<string, (cel: string) => string[]> = {
  'backup-state.mjs:data': (cel) => ['--data', cel, '--out', swiezy(`out-${Math.random().toString(36).slice(2, 8)}`)],
  'backup-state.mjs:out': (cel) => ['--data', zrodlo, '--out', cel],
  'backup-state.mjs:verify': (cel) => ['--verify', cel],
  'migration-rehearsal.mjs:backup': (cel) => ['--backup', cel, '--out', swiezy(`proba-${Math.random().toString(36).slice(2, 8)}`)],
  'migration-rehearsal.mjs:out': (cel) => ['--backup', kopia, '--out', cel],
  'migration-rehearsal.mjs:json': (cel) => [
    '--backup', kopia,
    '--out', swiezy(`proba-json-${Math.random().toString(36).slice(2, 8)}`),
    '--json', join(cel, 'raport.json'),
  ],
  'restore-state.mjs:backup': (cel) => ['--backup', cel, '--data', swiezy(`cel-${Math.random().toString(36).slice(2, 8)}`), '--check'],
  'restore-state.mjs:data': (cel) => ['--backup', kopia, '--data', cel],
  'synthetic-state.mjs:out': (cel) => ['--out', cel, '--stage', 'empty'],
  'synthetic-state.mjs:stage': () => ['--stage', 'empty', '--out', swiezy('nieuzywany')],
};

describe('kazda flaga sciezkowa skryptow stanu ma rozstrzygniecie', () => {
  const deklaracje = new Map<Script, Record<string, FlagDecl>>();

  beforeAll(async () => {
    for (const script of SCRIPTS) {
      const mod = (await import(resolve(REPO, 'scripts', script))) as { FLAGS?: Record<string, FlagDecl> };
      expect(mod.FLAGS, `${script} nie deklaruje FLAGS`).toBeDefined();
      deklaracje.set(script, mod.FLAGS!);
    }
  });

  it.each(SCRIPTS)('%s: kod i deklaracja wymieniaja te same flagi', (script) => {
    /*
     * The half that cannot be forgotten. The left side is read from the source,
     * so a flag added to the code lands here by itself; the right side is the
     * script's own declaration. A new flag fails this until somebody writes
     * down what protects it.
     */
    expect(flagiWKodzie(script)).toEqual(Object.keys(deklaracje.get(script)!).sort());
  });

  it.each(SCRIPTS)('%s: kazda flaga ma znany rodzaj, uzasadnienie i przepis na wywolanie', (script) => {
    for (const [flag, decl] of Object.entries(deklaracje.get(script)!)) {
      expect(
        ['zapis-chroniony', 'odczyt-chroniony', 'zapis-docelowy', 'odczyt', 'wartosc'],
        `${script} --${flag}: nieznany rodzaj ${decl.kind}`,
      ).toContain(decl.kind);
      // A reason nobody wrote is a reason nobody thought about.
      expect(decl.why.length, `${script} --${flag}: brak uzasadnienia`).toBeGreaterThan(40);
      expect(
        PRZEPISY[`${script}:${flag}`],
        `${script} --${flag}: brak przepisu na wywolanie w tescie — dopisz go i rozstrzygnij, ` +
          'czy ta flaga potrzebuje ochrony',
      ).toBeDefined();
    }
  });

  /* ---------------------------------------------------------------------- */

  it.each(SCRIPTS)('%s: flagi zapisujace odmawiaja zywego katalogu danych', (script) => {
    const flagi = Object.entries(deklaracje.get(script)!).filter(
      ([, d]) => d.kind === 'zapis-chroniony' || d.kind === 'odczyt-chroniony',
    );
    for (const [flag] of flagi) {
      const przed = odcisk(zyweDane);
      const r = run(script, PRZEPISY[`${script}:${flag}`]!(zyweDane));

      expect(r.status, `${script} --${flag} nie odmowilo: ${r.out}`).toBe(2);
      expect(r.out, `${script} --${flag}: odmowa z innego powodu niz katalog danych`).toMatch(
        ODMOWA_DANYCH,
      );
      // The assertion that actually matters.
      expect(odcisk(zyweDane), `${script} --${flag} zmienilo katalog danych`).toEqual(przed);
      expect(readFileSync(plikUzytkownika, 'utf8')).toBe('tresc uzytkownika\n');
    }
  }, 300_000);

  it.each(SCRIPTS)('%s: flagi czytajace dzialaja na zywym katalogu, i tak ma byc', (script) => {
    /*
     * The explicit other half. `--data` in `backup-state.mjs` is the one flag
     * in these scripts that may be pointed at a live data directory — copying
     * one is the entire purpose — and this says so in a test instead of leaving
     * it off a list, where it would be indistinguishable from the omission that
     * caused defect 2.
     */
    const flagi = Object.entries(deklaracje.get(script)!).filter(([, d]) => d.kind === 'odczyt');
    for (const [flag] of flagi) {
      const przed = odcisk(zyweDane);
      const r = run(script, PRZEPISY[`${script}:${flag}`]!(zyweDane));

      expect(r.out, `${script} --${flag} zostalo odrzucone jako katalog danych, a jest czytajace`)
        .not.toMatch(ODMOWA_DANYCH);
      // Reading changes nothing either — `app.db-shm` aside, which SQLite
      // rebuilds even for a read-only connection and which holds no data.
      const po = odcisk(zyweDane);
      delete przed['app.db-shm'];
      delete po['app.db-shm'];
      expect(po, `${script} --${flag} zmienilo katalog danych`).toEqual(przed);
    }
  }, 300_000);

  it('backup-state --data faktycznie kopiuje zywy katalog danych', () => {
    // Not just "is not refused": it works, end to end, on a directory carrying a
    // `session.secret`. That is the behaviour the exception exists for.
    const zywaBaza = swiezy('zywa-z-baza');
    expect(run('synthetic-state.mjs', ['--out', zywaBaza, '--stage', 'current']).status).toBe(0);
    writeFileSync(resolve(zywaBaza, 'session.secret'), 'sekret\n');

    const cel = swiezy('kopia-zywego');
    const r = run('backup-state.mjs', ['--data', zywaBaza, '--out', cel]);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(resolve(cel, 'manifest.json'))).toBe(true);
    // ...and the secret is still not copied.
    expect(existsSync(resolve(cel, 'session.secret'))).toBe(false);
  }, 180_000);

  it('restore-state --data celuje w katalog danych, ale odmawia katalogu, ktory nim nie jest', () => {
    /*
     * The fourth kind. Restoring *into* the data directory is the point, so the
     * usual guard would be backwards; the check that replaces it runs in the
     * other direction, and is asserted here so the exception is behavioural
     * rather than a gap in the list.
     */
    const obcy = swiezy('obcy-cel');
    mkdirSync(obcy, { recursive: true });
    writeFileSync(resolve(obcy, 'notatki.md'), 'tresc\n');

    const r = run('restore-state.mjs', PRZEPISY['restore-state.mjs:data']!(obcy));
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/nie wyglada na katalog danych aplikacji/);
    expect(readFileSync(resolve(obcy, 'notatki.md'), 'utf8')).toBe('tresc\n');
  }, 120_000);
});
