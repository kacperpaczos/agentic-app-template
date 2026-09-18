import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Backup, migration rehearsal and restore — exercised, not described.
 *
 * Everything here runs the **real scripts** as a user would run them
 * (`scripts/backup-state.mjs`, `scripts/migration-rehearsal.mjs`,
 * `scripts/restore-state.mjs`), against **synthetic** databases this file
 * generates. That combination is the point:
 *
 *  - the scripts were previously covered only by reading them, so nothing
 *    noticed that the rehearsal reported a false failure on any copy that
 *    actually contained files;
 *  - the template ships with no `data/`, and the one database that must never
 *    take part in a rehearsal is the user's own, so the data is invented.
 *
 * Every directory used lives under `.e2e-bl07/` **inside the repository**, which
 * is ignored by git. Nothing in this file can name `data/`, `APP_DATA_DIR` or
 * anything outside that root — and three of the tests below check that the
 * scripts refuse when someone else does.
 */

const REPO = resolve(import.meta.dirname, '..');
const ROOT = resolve(REPO, '.e2e-bl07');

const Database = createRequire(resolve(REPO, 'packages/platform-server/package.json'))(
  'better-sqlite3',
) as new (file: string, options?: { readonly?: boolean }) => {
  prepare: (sql: string) => { get: (...p: unknown[]) => any; all: (...p: unknown[]) => any[]; run: (...p: unknown[]) => unknown };
  pragma: (s: string, o?: { simple?: boolean }) => unknown;
  close: () => void;
};

interface Ran {
  status: number;
  out: string;
}

/** Runs one of the repository's scripts exactly as the documentation says to. */
function run(script: string, args: string[], env: Record<string, string> = {}): Ran {
  const r = spawnSync(process.execPath, [resolve(REPO, 'scripts', script), ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Boots the application against a directory, the way `pnpm start` does. */
function boot(dataDir: string): Ran {
  const script = `
    import { composeApp } from ${JSON.stringify(resolve(REPO, 'apps/server/src/compose.ts'))};
    const p = composeApp({ dataDir: ${JSON.stringify(dataDir)} });
    console.log('ROZMOWY ' + p.db.$client.prepare('SELECT COUNT(*) AS n FROM conversations').get().n);
    p.close();
  `;
  const r = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--input-type=module', '-e', script],
    { cwd: REPO, env: { ...process.env, APP_DATA_DIR: dataDir }, encoding: 'utf8' },
  );
  return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

const count = (dbFile: string, sql: string): number => {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare(sql).get().n as number;
  } finally {
    db.close();
  }
};

/** Row counts and a content digest per table, taken by the test itself. */
function census(dbFile: string): Record<string, string> {
  const db = new Database(dbFile, { readonly: true });
  try {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((r: { name: string }) => r.name);
    const out: Record<string, string> = {};
    for (const t of tables) {
      const rows = db.prepare(`SELECT * FROM "${t}"`).all() as Array<Record<string, unknown>>;
      out[t] = createHash('sha256')
        .update(rows.map((r) => JSON.stringify(Object.entries(r).sort())).sort().join('\n'))
        .digest('hex');
    }
    return out;
  } finally {
    db.close();
  }
}

let work: string;
beforeAll(() => {
  mkdirSync(ROOT, { recursive: true });
  work = mkdtempSync(join(ROOT, 'regresja-'));
});
afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

const dir = (name: string) => resolve(work, name);

/* ========================================================================== */
/* L10.16 — the copy holds the committed state, WAL included                  */
/* ========================================================================== */

describe('kopia zachowuje zatwierdzony stan SQLite wraz z WAL', () => {
  let dane: string;
  let kopia: string;
  let przed: Record<string, string>;

  beforeAll(() => {
    dane = dir('wal-dane');
    kopia = dir('wal-kopia');
    const gen = run('synthetic-state.mjs', ['--out', dane, '--stage', 'current', '--leave-wal']);
    expect(gen.status, gen.out).toBe(0);
    przed = Object.fromEntries(
      ['app.db', 'app.db-wal', 'app.db-shm']
        .filter((f) => existsSync(resolve(dane, f)))
        .map((f) => [f, sha256(resolve(dane, f))]),
    );
  }, 120_000);

  it('fikstura jest tym przypadkiem, o ktory chodzi: zapis istnieje tylko w WAL', () => {
    /*
     * The control without which every other assertion in this block would pass
     * for the wrong reason. `app.db` on its own — which is what a careless
     * `cp data/app.db` would take — does not contain the last committed
     * conversation; it is in `app.db-wal` and nowhere else.
     */
    expect(existsSync(resolve(dane, 'app.db-wal'))).toBe(true);
    const onlyMain = resolve(work, 'tylko-glowny.db');
    cpSync(resolve(dane, 'app.db'), onlyMain);
    expect(count(onlyMain, `SELECT COUNT(*) AS n FROM conversations WHERE id='cnv_syn_tylko_w_wal'`)).toBe(0);
    expect(count(resolve(dane, 'app.db'), `SELECT COUNT(*) AS n FROM conversations`)).toBe(2);
  });

  it('kopia zawiera zapis lezacy w WAL i jest jednym samowystarczalnym plikiem', () => {
    const r = run('backup-state.mjs', ['--data', dane, '--out', kopia]);
    expect(r.status, r.out).toBe(0);

    /*
     * Checked *before* anything in this test opens the copy: any connection,
     * including a read-only one, recreates `-wal` and `-shm`, so asking later
     * would only measure this test's own side effects.
     */
    expect(existsSync(resolve(kopia, 'app.db-wal'))).toBe(false);
    expect(existsSync(resolve(kopia, 'app.db-shm'))).toBe(false);

    expect(
      count(resolve(kopia, 'app.db'), `SELECT COUNT(*) AS n FROM conversations WHERE id='cnv_syn_tylko_w_wal'`),
      'kopia zgubila zapis, ktory lezal w WAL',
    ).toBe(1);
    expect(
      count(resolve(kopia, 'app.db'), `SELECT COUNT(*) AS n FROM messages WHERE id='msg_syn_wal'`),
    ).toBe(1);
  }, 120_000);

  it('kopia niesie pliki uzytkownika i manifest z odciskami tabel', () => {
    const manifest = JSON.parse(readFileSync(resolve(kopia, 'manifest.json'), 'utf8'));
    expect(manifest.census.integrity).toBe('ok');
    expect(manifest.census.migrations).toContain('platform-0003-file-versions');
    expect(manifest.trees.files).toHaveLength(2);
    for (const f of manifest.trees.files) {
      expect(sha256(resolve(kopia, 'files', f.path))).toBe(f.sha256);
    }
    // The installation secret is data about this machine, not application data.
    expect(existsSync(resolve(kopia, 'session.secret'))).toBe(false);
  });

  it('kopia jest odczytana ponownie i sprawdzona (--verify)', () => {
    const r = run('backup-state.mjs', ['--verify', kopia]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/sprawdzona: bez zastrzezen/);
  }, 60_000);

  it('wykonanie kopii nie zmienia zrodla', () => {
    /*
     * L10.19, measured rather than argued: the committed state — `app.db` and
     * `app.db-wal` — is byte-identical before and after. `app.db-shm` is left
     * out on purpose: SQLite rebuilds that index even on a read-only
     * connection, it holds no data, and pretending otherwise would be the kind
     * of assertion that has to be weakened later.
     *
     * The backup is taken *here*, into its own directory, rather than leaning on
     * the one another test made. A detection trial showed why: run on its own,
     * a version of this test that only compared `przed` with the current files
     * passed while the source was being checkpointed, because no backup had run
     * in that process at all.
     */
    const kontrolna = dir('wal-kopia-kontrolna');
    const before = Object.fromEntries(
      ['app.db', 'app.db-wal']
        .filter((f) => existsSync(resolve(dane, f)))
        .map((f) => [f, sha256(resolve(dane, f))]),
    );
    expect(Object.keys(before)).toEqual(['app.db', 'app.db-wal']);

    const r = run('backup-state.mjs', ['--data', dane, '--out', kontrolna]);
    expect(r.status, r.out).toBe(0);

    for (const file of ['app.db', 'app.db-wal']) {
      expect(sha256(resolve(dane, file)), `${file} zmieniony przez wykonanie kopii`).toBe(before[file]);
      // ...and unchanged since the fixture was built, i.e. by any earlier test.
      expect(sha256(resolve(dane, file))).toBe(przed[file]);
    }
  }, 120_000);
});

/* ========================================================================== */
/* Negative controls: a copy that is not a copy                                */
/* ========================================================================== */

describe('uszkodzona kopia i niespojny manifest sa wykrywane', () => {
  let zrodlo: string;
  beforeAll(() => {
    zrodlo = dir('kontrola-dane');
    const gen = run('synthetic-state.mjs', ['--out', zrodlo, '--stage', 'current']);
    expect(gen.status, gen.out).toBe(0);
  }, 120_000);

  const freshCopy = (name: string): string => {
    const out = dir(name);
    const r = run('backup-state.mjs', ['--data', zrodlo, '--out', out]);
    expect(r.status, r.out).toBe(0);
    return out;
  };

  it('zmieniony plik uzytkownika w kopii', () => {
    const kopia = freshCopy('kopia-plik');
    const [first] = readdirSync(resolve(kopia, 'files', 'local-user'));
    appendFileSync(resolve(kopia, 'files', 'local-user', first!), 'dopisane\n');

    const r = run('backup-state.mjs', ['--verify', kopia]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/inna suma kontrolna/);
  }, 120_000);

  it('zmieniona baza w kopii', () => {
    const kopia = freshCopy('kopia-baza');
    const db = new Database(resolve(kopia, 'app.db'));
    db.prepare('DELETE FROM messages WHERE id = ?').run('msg_syn_user_2');
    db.close();

    const r = run('backup-state.mjs', ['--verify', kopia]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/suma kontrolna app\.db nie zgadza sie z manifestem/);
    expect(r.out).toMatch(/tabela messages/);
  }, 120_000);

  it('manifest niezgodny z kopia', () => {
    const kopia = freshCopy('kopia-manifest');
    const manifestPath = resolve(kopia, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // The copy is intact; the manifest now claims something else about it.
    manifest.census.tableCounts.conversations += 7;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const r = run('backup-state.mjs', ['--verify', kopia]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/tabela conversations: 1 wierszy, w manifescie 8/);
  }, 120_000);

  it('brak pliku wymienionego w manifescie', () => {
    const kopia = freshCopy('kopia-brak');
    const [first] = readdirSync(resolve(kopia, 'files', 'local-user'));
    rmSync(resolve(kopia, 'files', 'local-user', first!));

    const r = run('backup-state.mjs', ['--verify', kopia]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/brak pliku files\//);
  }, 120_000);
});

/* ========================================================================== */
/* L10.19 — nothing here may touch a live database                            */
/* ========================================================================== */

describe('kopie i proby odmawiaja pracy na katalogu danych aplikacji', () => {
  let udawaneDane: string;
  beforeAll(() => {
    // A directory that looks exactly like a live one: a database, files, and
    // the session secret that only a live directory has.
    udawaneDane = dir('udawane-dane');
    const gen = run('synthetic-state.mjs', ['--out', udawaneDane, '--stage', 'current']);
    expect(gen.status, gen.out).toBe(0);
    writeFileSync(resolve(udawaneDane, 'session.secret'), 'sekret-udawany\n');
    /*
     * ...and the marker goes, because this fixture stands in for **somebody
     * else's** data directory. A real one was never created by these scripts
     * and carries no marker of theirs, and leaving one here would hand the
     * fixture the ownership exemption that exists for scratch directories —
     * making these refusals pass for the wrong reason, or not at all.
     *
     * (A marker only counts for the path written inside it, so copying a
     * generated directory no longer carries the claim with it. Removing it here
     * as well keeps the fixture honest rather than relying on that.)
     */
    rmSync(resolve(udawaneDane, '.katalog-roboczy-agentic'));
  }, 120_000);

  it('kopia do wnetrza katalogu danych jest odrzucona', () => {
    const r = run('backup-state.mjs', ['--data', udawaneDane, '--out', resolve(udawaneDane, 'backups/x')]);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/lezy wewnatrz katalogu danych/);
    expect(existsSync(resolve(udawaneDane, 'backups'))).toBe(false);
  }, 60_000);

  it('kopia bazy trzymanej przez proces jest odrzucona', () => {
    // This test process holds the database open for the duration of the call,
    // which is exactly the situation the check exists for.
    const held = new Database(resolve(udawaneDane, 'app.db'));
    try {
      held.prepare('SELECT COUNT(*) AS n FROM conversations').get();
      const r = run('backup-state.mjs', ['--data', udawaneDane, '--out', dir('kopia-trzymana')]);
      expect(r.status).toBe(2);
      expect(r.out).toMatch(/jest otwarty przez proces/);
    } finally {
      held.close();
    }
  }, 60_000);

  it('proba migracji na katalogu wskazanym przez APP_DATA_DIR jest odrzucona', () => {
    /*
     * The gap this closes: the refusal used to compare only against the
     * repository's own `data/`, so an installation configured to keep its state
     * anywhere else — which is supported — was unprotected.
     *
     * This directory deliberately has **no** `session.secret`, so the only rule
     * that can catch it is the one reading `APP_DATA_DIR`. Reusing the
     * directory that has one would let this test pass with that rule deleted.
     */
    const bezSekretu = dir('udawane-bez-sekretu');
    cpSync(udawaneDane, bezSekretu, { recursive: true });
    rmSync(resolve(bezSekretu, 'session.secret'));
    const przed = census(resolve(bezSekretu, 'app.db'));

    const r = run('migration-rehearsal.mjs', ['--backup', bezSekretu], { APP_DATA_DIR: bezSekretu });
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/lezy w katalogu danych aplikacji/);
    expect(census(resolve(bezSekretu, 'app.db')), 'proba dotknela bazy').toEqual(przed);
  }, 60_000);

  it('proba migracji na katalogu z session.secret jest odrzucona, nawet bez APP_DATA_DIR', () => {
    // No path comparison could catch this one: the directory is not named
    // anywhere. The tell is the secret, which a backup never contains.
    const przed = census(resolve(udawaneDane, 'app.db'));
    const r = run('migration-rehearsal.mjs', ['--backup', udawaneDane]);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/session\.secret/);
    expect(census(resolve(udawaneDane, 'app.db'))).toEqual(przed);
  }, 60_000);

  it('generator danych syntetycznych odmawia nadpisania katalogu danych', () => {
    // It deletes what it is pointed at, so it gets the same refusal.
    const r = run('synthetic-state.mjs', ['--out', udawaneDane, '--stage', 'current']);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/session\.secret/);
    expect(existsSync(resolve(udawaneDane, 'app.db'))).toBe(true);
  }, 60_000);
});

/* ========================================================================== */
/* L10.19 — the three protections around a destructive path                   */
/* ========================================================================== */

/**
 * Not "does it refuse the exact path of the data directory" — that was already
 * true, and it was not enough.
 *
 * A review reproduced the real failure: `--out <dane>/files` is not *equal* to
 * the data directory and has no `session.secret` of its own, so both scripts
 * accepted it, deleted a directory of the user's files and exited 0. The parent
 * directory was equally unprotected, and a symlink walked around any comparison
 * of literal paths.
 *
 * Every case below therefore checks two things: the refusal, and that the
 * user's file is still there afterwards. The second is the one that matters.
 */
describe('sciezki wokol katalogu danych — trzy ochrony przed skasowaniem', () => {
  let dane: string;
  let plikUzytkownika: string;
  let kopia: string;

  beforeAll(() => {
    /*
     * A real backup, so the rehearsal gets past its `--backup` checks and the
     * refusal under test is genuinely the one about `--out`.
     */
    const zrodlo = dir('ofiara-zrodlo');
    kopia = dir('ofiara-kopia');
    expect(run('synthetic-state.mjs', ['--out', zrodlo, '--stage', 'current']).status).toBe(0);
    expect(run('backup-state.mjs', ['--data', zrodlo, '--out', kopia]).status).toBe(0);

    // A directory indistinguishable from a live one, with something to lose.
    // Built by hand, not by the generator: a victim directory must look like a
    // stranger's, marker included — that is, without one.
    dane = dir('ofiara-dane');
    mkdirSync(resolve(dane, 'files', 'local-user'), { recursive: true });
    writeFileSync(resolve(dane, 'session.secret'), 'sekret-instalacji\n');
    writeFileSync(resolve(dane, 'app.db'), 'nie-jest-prawdziwa-baza\n');
    plikUzytkownika = resolve(dane, 'files', 'local-user', 'waznyplik.txt');
    writeFileSync(plikUzytkownika, 'tresc uzytkownika\n');
  });

  const nienaruszony = () =>
    expect(
      existsSync(plikUzytkownika) && readFileSync(plikUzytkownika, 'utf8'),
      'plik uzytkownika zostal skasowany',
    ).toBe('tresc uzytkownika\n');

  /* --- ochrona 1: zawieranie w obie strony, nie rownosc --- */

  it.each([
    ['synthetic-state.mjs', (p: string) => ['--out', p, '--stage', 'empty']],
    ['migration-rehearsal.mjs', (p: string) => ['--backup', kopia, '--out', p]],
  ])('%s odmawia katalogu WEWNATRZ katalogu danych', (script, argv) => {
    const r = run(script, argv(resolve(dane, 'files')));
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/lezy w katalogu danych aplikacji/);
    nienaruszony();
  }, 60_000);

  it.each([
    ['synthetic-state.mjs', (p: string) => ['--out', p, '--stage', 'empty']],
    ['migration-rehearsal.mjs', (p: string) => ['--backup', kopia, '--out', p]],
  ])('%s odmawia katalogu NADRZEDNEGO wobec katalogu danych', (script, argv) => {
    const r = run(script, argv(dir('ofiara-dane/..')));
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/zawiera katalog danych aplikacji|nie zostal utworzony przez te skrypty/);
    nienaruszony();
  }, 60_000);

  /* --- ochrona 2: rozwiazywanie dowiazan --- */

  it('dowiazanie symboliczne nie obchodzi kontroli', () => {
    /*
     * Isolated on purpose, so that it is this protection being tested and not
     * one of the others standing in for it.
     *
     * The configured data directory carries **no** `session.secret` (so the
     * marker-file rule and the secret rule cannot fire) and the target does not
     * exist yet (so the "we did not create it" rule cannot fire either). The
     * only thing that can refuse this is resolving `<link>/nowy` and the
     * configured path to the same real directory — which is exactly what a
     * comparison of literal paths fails to do.
     */
    const prawdziwe = dir('link-cel-dane');
    mkdirSync(resolve(prawdziwe, 'files'), { recursive: true });
    writeFileSync(resolve(prawdziwe, 'app.db'), 'baza\n');
    const link = dir('dowiazanie-do-danych');
    symlinkSync(prawdziwe, link, 'dir');

    const r = run(
      'synthetic-state.mjs',
      ['--out', join(link, 'nowy'), '--stage', 'empty'],
      { APP_DATA_DIR: prawdziwe },
    );
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/lezy w katalogu danych aplikacji/);
    expect(existsSync(resolve(prawdziwe, 'nowy')), 'skrypt wszedl do katalogu danych').toBe(false);
  }, 60_000);

  /* --- ochrona 3: nie kasuj katalogu, ktorego te skrypty nie zrobily --- */

  it('odmawia skasowania cudzego niepustego katalogu bez znacznika', () => {
    /*
     * The backstop. Even where nothing marks the directory as application data
     * — no `session.secret`, no configured path — a non-empty directory these
     * scripts did not create is not theirs to delete.
     */
    const cudzy = dir('cudze-zdjecia');
    mkdirSync(cudzy, { recursive: true });
    writeFileSync(resolve(cudzy, 'zdjecie.jpg'), 'bajty\n');

    const r = run('synthetic-state.mjs', ['--out', cudzy, '--stage', 'empty']);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/nie zostal utworzony przez te skrypty/);
    expect(readFileSync(resolve(cudzy, 'zdjecie.jpg'), 'utf8')).toBe('bajty\n');
  }, 60_000);

  it('katalog pusty albo wlasny jest uzywany normalnie', () => {
    // The control: the protection must not make the scripts unusable. An empty
    // directory is filled, and the directory they made is reused on a re-run.
    const wlasny = dir('wlasny-katalog');
    mkdirSync(wlasny, { recursive: true });
    expect(run('synthetic-state.mjs', ['--out', wlasny, '--stage', 'empty']).status).toBe(0);
    expect(existsSync(resolve(wlasny, '.katalog-roboczy-agentic'))).toBe(true);
    expect(run('synthetic-state.mjs', ['--out', wlasny, '--stage', 'current']).status).toBe(0);
  }, 120_000);

  it('odtworzenie odmawia katalogu --data, ktory nie wyglada na katalog danych', () => {
    // `restore-state.mjs` renames what it is given. Nothing is deleted, but a
    // typo must not move somebody's directory aside.
    const cudzy = dir('cudzy-cel');
    mkdirSync(cudzy, { recursive: true });
    writeFileSync(resolve(cudzy, 'notatki.md'), 'tresc\n');

    const r = run('restore-state.mjs', ['--backup', kopia, '--data', cudzy]);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/nie wyglada na katalog danych aplikacji/);
    expect(readFileSync(resolve(cudzy, 'notatki.md'), 'utf8')).toBe('tresc\n');
  }, 60_000);

  it('kopia NIE MOZE byc zapisana do zywego katalogu danych', () => {
    /*
     * The defect this exists for, and the worst one in the package: the guard
     * on `--out` only ever compared it with `--data`. Nothing asked whether the
     * destination was *itself* somebody's data directory, so
     * `--data <cokolwiek> --out <katalog danych>` overwrote the user's `app.db`
     * and file tree with another installation's and exited 0, printing that the
     * copy had been read back and verified. Reading a live directory is this
     * script's purpose; writing into one never is.
     */
    const zrodlo = dir('kopia-do-zywych-zrodlo');
    expect(run('synthetic-state.mjs', ['--out', zrodlo, '--stage', 'current']).status).toBe(0);
    const przed = sha256(resolve(dane, 'app.db'));

    const r = run('backup-state.mjs', ['--data', zrodlo, '--out', dane]);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/Katalog kopii .* lezy w katalogu danych aplikacji/);
    // The two things that were lost when this passed.
    expect(sha256(resolve(dane, 'app.db')), 'baza uzytkownika nadpisana kopia').toBe(przed);
    nienaruszony();
  }, 120_000);

  it('kopia NIE MOZE nadpisac cudzego niepustego katalogu', () => {
    // Even where nothing marks the destination as application data: a backup
    // writes `app.db` and the trees into it, so it may not land on somebody's
    // files.
    const zrodlo = dir('kopia-do-cudzego-zrodlo');
    expect(run('synthetic-state.mjs', ['--out', zrodlo, '--stage', 'current']).status).toBe(0);
    const cudzy = dir('cudzy-cel-kopii');
    mkdirSync(cudzy, { recursive: true });
    writeFileSync(resolve(cudzy, 'foto.jpg'), 'bajty\n');

    const r = run('backup-state.mjs', ['--data', zrodlo, '--out', cudzy]);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/nie zostal utworzony przez te skrypty/);
    expect(readFileSync(resolve(cudzy, 'foto.jpg'), 'utf8')).toBe('bajty\n');
  }, 120_000);

  it('kopia do katalogu wskazanego przez APP_DATA_DIR jest odrzucona', () => {
    // No `session.secret` here, so only the configured-path rule can catch it.
    const zrodlo = dir('kopia-env-zrodlo');
    expect(run('synthetic-state.mjs', ['--out', zrodlo, '--stage', 'current']).status).toBe(0);
    const cel = dir('kopia-env-cel');
    mkdirSync(cel, { recursive: true });
    writeFileSync(resolve(cel, 'app.db'), 'baza uzytkownika\n');

    const r = run('backup-state.mjs', ['--data', zrodlo, '--out', cel], { APP_DATA_DIR: cel });
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/lezy w katalogu danych aplikacji/);
    expect(readFileSync(resolve(cel, 'app.db'), 'utf8')).toBe('baza uzytkownika\n');
  }, 120_000);

  it('kopia do katalogu pustego i do wlasnej wczesniejszej kopii dziala', () => {
    /*
     * The control. Refusing everything would satisfy the tests above and make
     * the script useless; re-running a backup over the previous one is the
     * normal way people use it, and the backup's own `manifest.json` is what
     * makes that destination recognisably its own.
     */
    const zrodlo = dir('kopia-kontrola-zrodlo');
    expect(run('synthetic-state.mjs', ['--out', zrodlo, '--stage', 'current']).status).toBe(0);
    const cel = dir('kopia-kontrola-cel');

    expect(run('backup-state.mjs', ['--data', zrodlo, '--out', cel]).status).toBe(0);
    const powtorka = run('backup-state.mjs', ['--data', zrodlo, '--out', cel]);
    expect(powtorka.status, powtorka.out).toBe(0);
  }, 180_000);

  it('katalog danych ukryty POD celem jest wykryty osobna regula', () => {
    /*
     * Isolates `dataDirBelow`, which the "parent directory" case above does not:
     * there, the marker rule refuses first and either message satisfies the
     * assertion.
     *
     * Here the target carries our own marker — so the marker rule says "ours"
     * and steps aside — and neither the target nor any ancestor holds a
     * `session.secret`. The only rule left that can refuse is the one looking
     * *below* the target, which is the point: pointing a script at the parent of
     * a data directory deletes the data with it, and no comparison against the
     * data directory's own path would notice.
     */
    const nadrzedny = dir('nad-danymi');
    mkdirSync(resolve(nadrzedny, 'cudze-dane'), { recursive: true });
    // A valid marker: it names the directory it sits in, which is what makes it
    // count (a marker carried elsewhere by a copy does not).
    writeFileSync(
      resolve(nadrzedny, '.katalog-roboczy-agentic'),
      `sciezka: ${realpathSync(nadrzedny)}\n`,
    );
    writeFileSync(resolve(nadrzedny, 'cudze-dane', 'session.secret'), 'sekret\n');
    writeFileSync(resolve(nadrzedny, 'cudze-dane', 'app.db'), 'baza\n');

    const r = run('synthetic-state.mjs', ['--out', nadrzedny, '--stage', 'empty']);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/zawiera katalog danych aplikacji/);
    expect(readFileSync(resolve(nadrzedny, 'cudze-dane', 'app.db'), 'utf8')).toBe('baza\n');
  }, 60_000);

  it('znacznik skopiowany do innego katalogu nic nie znaczy', () => {
    /*
     * Found while re-recording the evidence, not by a test: `cp -r` of a
     * generated directory carried the marker into the copy, so a copy that had
     * since become somebody's data directory still counted as ours — and a
     * backup wrote straight into it. The marker now names the directory it was
     * written for and is worthless anywhere else.
     */
    const oryginal = dir('znacznik-oryginal');
    expect(run('synthetic-state.mjs', ['--out', oryginal, '--stage', 'current']).status).toBe(0);
    const kopiaKatalogu = dir('znacznik-kopia');
    cpSync(oryginal, kopiaKatalogu, { recursive: true });
    expect(existsSync(resolve(kopiaKatalogu, '.katalog-roboczy-agentic'))).toBe(true);
    writeFileSync(resolve(kopiaKatalogu, 'session.secret'), 'sekret\n');

    const r = run('backup-state.mjs', ['--data', oryginal, '--out', kopiaKatalogu]);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/lezy w katalogu danych aplikacji/);
  }, 120_000);

  it('skopiowany znacznik nie autoryzuje SKASOWANIA katalogu', () => {
    /*
     * The reviewer's third escape, and the one that still destroyed data after
     * the copied-marker fix: that fix landed in `isOurs`, but the two places
     * where a marker *authorises a deletion* still asked only whether the file
     * was present. So `cp -r` of a generated directory, a user's file added to
     * the copy, no `session.secret` anywhere — and `synthetic-state --out`
     * deleted it, exit 0.
     *
     * Deliberately separate from the test above: that one covers
     * `backup-state --out`, which *overwrites* through `assertOwnOrEmptyDir`.
     * This one covers `synthetic-state --out`, which *deletes* through
     * `prepareScratchDir`. Both gates read the marker, and only one of them had
     * a test — which is exactly how the escape survived.
     */
    const wygenerowany = dir('kasowanie-oryginal');
    expect(run('synthetic-state.mjs', ['--out', wygenerowany, '--stage', 'current']).status).toBe(0);

    const mojeDane = dir('kasowanie-kopia');
    cpSync(wygenerowany, mojeDane, { recursive: true });
    expect(existsSync(resolve(mojeDane, '.katalog-roboczy-agentic'))).toBe(true);
    writeFileSync(resolve(mojeDane, 'waznyplik.txt'), 'tresc uzytkownika\n');

    const r = run('synthetic-state.mjs', ['--out', mojeDane, '--stage', 'empty']);
    expect(r.status, r.out).toBe(2);
    expect(r.out).toMatch(/nie zostal utworzony przez te skrypty/);
    expect(readFileSync(resolve(mojeDane, 'waznyplik.txt'), 'utf8')).toBe('tresc uzytkownika\n');

    // ...and the directory the generator really made is still reusable.
    expect(run('synthetic-state.mjs', ['--out', wygenerowany, '--stage', 'empty']).status).toBe(0);
  }, 240_000);

  it('awaria skryptu ma inny kod wyjscia niz werdykt proby', () => {
    /*
     * A caller has to tell "the rehearsal found problems" (1) from "the
     * rehearsal fell over" (4). They used to be the same number, which makes
     * the one verdict nobody may misread indistinguishable from a bug.
     */
    const kopia = dir('kopia-do-awarii');
    mkdirSync(kopia, { recursive: true });
    // A manifest makes it past the refusals; there is no database behind it,
    // so the rehearsal crashes rather than reaching a verdict.
    writeFileSync(resolve(kopia, 'manifest.json'), '{"census":{"migrations":[]}}');
    const r = run('migration-rehearsal.mjs', ['--backup', kopia, '--out', dir('proba-awaria')]);
    expect(r.status, r.out).toBe(4);
    expect(r.out).toMatch(/AWARIA/);
  }, 60_000);
});

/* ========================================================================== */
/* L10.2 / L10.17 — a rehearsal for every platform migration                  */
/* ========================================================================== */

/**
 * One case per platform migration, named by the migration it precedes.
 *
 * Read from the code, not typed out: `--list` asks the composition root which
 * migrations exist, so a migration added later is rehearsed here without anyone
 * remembering to add it — and a migration whose rehearsal fails cannot be
 * shipped by forgetting to write a case for it.
 */
function platformStages(): string[] {
  const r = run('synthetic-state.mjs', ['--list']);
  if (r.status !== 0) throw new Error(`nie udalo sie odczytac etapow:\n${r.out}`);
  const line = r.out.split('\n').find((l) => l.includes('[syntetyk] etapy:'))!;
  return line
    .slice(line.indexOf(':') + 1)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('platform-'));
}

const stages = platformStages();

describe('proba migracji na syntetycznej kopii sprzed kazdej migracji platformy', () => {
  it('zna wszystkie migracje platformy', () => {
    // Guards the loop below against silently becoming empty.
    expect(stages.length).toBeGreaterThanOrEqual(3);
    expect(stages).toContain('platform-0003-file-versions');
  });

  it.each(stages)('kopia sprzed %s: migracja zachowuje dane i nie dubluje ich', (stage) => {
    const dane = dir(`etap-${stage}`);
    const kopia = dir(`etap-${stage}-kopia`);
    const proba = dir(`etap-${stage}-proba`);
    const raport = resolve(work, `etap-${stage}.json`);

    expect(run('synthetic-state.mjs', ['--out', dane, '--stage', stage]).status).toBe(0);
    const kopiaRun = run('backup-state.mjs', ['--data', dane, '--out', kopia]);
    expect(kopiaRun.status, kopiaRun.out).toBe(0);

    const r = run('migration-rehearsal.mjs', [
      '--backup', kopia, '--out', proba, '--json', raport,
    ]);
    expect(r.status, r.out).toBe(0);

    const report = JSON.parse(readFileSync(raport, 'utf8'));
    expect(report.problems).toEqual([]);
    // The migration this stage precedes is one the rehearsal actually applied —
    // otherwise the case would be passing without exercising anything.
    expect(report.migrationsApplied, `etap ${stage} nie zastosowal swojej migracji`).toContain(stage);
    expect(report.migrationsBefore).not.toContain(stage);
    expect(report.secondBootChangedNothing).toBe(true);
    expect(report.sourceUntouched).toBe(true);

    /* --- identity and content, not totals --- */
    if (report.countsBefore.conversations) {
      expect(report.preserved.rozmowy).toBe(report.countsBefore.conversations);
      expect(report.countsAfter.conversations).toBe(report.countsBefore.conversations);
      expect(report.countsAfter.files).toBe(report.countsBefore.files);
      expect(report.countsAfter.canvas_cards).toBe(report.countsBefore.canvas_cards);
      expect(report.countsAfter.run_events).toBe(report.countsBefore.run_events);
    }
  }, 300_000);

  it('kopia sprzed platform-0003 z niepustymi plikami: zmiana jest nazwana, dane nietkniete', () => {
    /*
     * The case the rehearsal used to get wrong, and the reason this file exists.
     *
     * `platform-0003-file-versions` adds two columns to `files`. The comparison
     * reads whole rows, so on any copy with files in it the table came out
     * different and was reported as an unexplained change — a false failure
     * that made the rehearsal unusable on exactly the data it was meant to
     * protect. It is now an *explained* change with a stronger check behind it:
     * the columns that existed before must still hold the same values.
     */
    const stage = 'platform-0003-file-versions';
    const raport = resolve(work, `etap-${stage}.json`);
    const report = JSON.parse(readFileSync(raport, 'utf8'));

    expect(report.countsBefore.files).toBeGreaterThan(0);
    expect(report.expectedChanges.join('\n')).toMatch(
      /files: dodane kolumny derived_from_file_id, version/,
    );
    expect(report.expectedChanges.join('\n')).toMatch(/dane bez zmian/);
    expect(report.preserved.pliki).toBe(report.countsBefore.files);
    expect(report.problems).toEqual([]);
  });

  it('proba jest powtarzalna do tego samego --out, mimo ze boot zapisuje tam session.secret', () => {
    /*
     * A regression introduced by the very guard that fixed the deletion defect,
     * and not caught by the positive control next to it — that one repeats
     * `synthetic-state`, which never boots the platform.
     *
     * The rehearsal does boot it, against its own working copy, and booting
     * writes a `session.secret` there. The second run into the same `--out` was
     * then refused as "a data directory": the documented command worked once
     * and afterwards told the user that the scratch directory this script had
     * just created was theirs to protect, leaving a manual `rm -rf` as the way
     * out — the exact move this package exists to make unnecessary.
     *
     * The marker now outranks the `session.secret` heuristic for a directory
     * these scripts created, and only for that directory.
     */
    const zrodlo = dir('powtorka-zrodlo');
    const kopiaP = dir('powtorka-kopia');
    const proba = dir('powtorka-proba');
    expect(run('synthetic-state.mjs', ['--out', zrodlo, '--stage', 'platform-0003-file-versions']).status).toBe(0);
    expect(run('backup-state.mjs', ['--data', zrodlo, '--out', kopiaP]).status).toBe(0);

    const pierwszy = run('migration-rehearsal.mjs', ['--backup', kopiaP, '--out', proba]);
    expect(pierwszy.status, pierwszy.out).toBe(0);
    expect(existsSync(resolve(proba, '.katalog-roboczy-agentic'))).toBe(true);
    // Two mechanisms keep this working, and both are checked. The first: the
    // rehearsal drops the throw-away secret its own boot wrote.
    expect(existsSync(resolve(proba, 'session.secret')), 'proba zostawila sekret po sobie').toBe(false);

    const drugi = run('migration-rehearsal.mjs', ['--backup', kopiaP, '--out', proba]);
    expect(drugi.status, drugi.out).toBe(0);

    /*
     * The second mechanism, which is what saves a run that was interrupted
     * before it could tidy up: a secret left in a directory these scripts
     * created does not turn it into somebody's data directory.
     */
    writeFileSync(resolve(proba, 'session.secret'), 'po-przerwanym-przebiegu\n');
    const trzeci = run('migration-rehearsal.mjs', ['--backup', kopiaP, '--out', proba]);
    expect(trzeci.status, trzeci.out).toBe(0);

    // ...and a foreign directory with a secret is still refused, so the rule
    // was relaxed for our own directories and nothing else.
    const obcy = dir('powtorka-obcy');
    mkdirSync(obcy, { recursive: true });
    writeFileSync(resolve(obcy, 'session.secret'), 'cudzy\n');
    const odmowa = run('migration-rehearsal.mjs', ['--backup', kopiaP, '--out', obcy]);
    expect(odmowa.status, odmowa.out).toBe(2);
  }, 300_000);

  it('trzecie uruchomienie takze nic nie zmienia — sprawdzone przez test, nie przez skrypt', () => {
    /*
     * Independent of the script's own idempotency verdict: the census here is
     * taken by the test, over every table, around a boot the test performs
     * itself. If the rehearsal's own comparison were broken, this would still
     * fail.
     */
    const proba = dir('etap-platform-0003-file-versions-proba');
    const dbFile = resolve(proba, 'app.db');
    const przed = census(dbFile);
    const b = boot(proba);
    expect(b.status, b.out).toBe(0);
    expect(census(dbFile)).toEqual(przed);
  }, 120_000);
});

/* ========================================================================== */
/* L10.18 — the restore procedure, performed                                  */
/* ========================================================================== */

describe('procedura odtworzenia stanu', () => {
  let kopia: string;
  beforeAll(() => {
    const dane = dir('odtw-zrodlo');
    kopia = dir('odtw-kopia');
    expect(run('synthetic-state.mjs', ['--out', dane, '--stage', 'current', '--leave-wal']).status).toBe(0);
    expect(run('backup-state.mjs', ['--data', dane, '--out', kopia]).status).toBe(0);
  }, 180_000);

  it('--check niczego nie zmienia i odpowiada na trzy pytania procedury', () => {
    const cel = dir('odtw-cel-check');
    mkdirSync(cel, { recursive: true });
    writeFileSync(resolve(cel, 'znacznik'), 'nietkniety');

    const r = run('restore-state.mjs', ['--backup', kopia, '--data', cel, '--check']);
    expect(r.status, r.out).toBe(0);
    // 1. code-version compatibility, 2. browser sessions, 3. SDK transcripts.
    expect(r.out).toMatch(/migracje w kopii/);
    expect(r.out).toMatch(/migracje w kodzie/);
    expect(r.out).toMatch(/session\.secret` nie jest w kopii/);
    expect(r.out).toMatch(/transkrypty Claude Agent SDK/);
    expect(r.out).toMatch(/session_transcript_lost/);
    // Nothing moved, nothing was set aside.
    expect(readFileSync(resolve(cel, 'znacznik'), 'utf8')).toBe('nietkniety');
    expect(readdirSync(work).filter((d) => d.startsWith('odtw-cel-check.'))).toEqual([]);
  }, 120_000);

  it('odmawia kopii nowszej niz kod, bo migracji nie da sie cofnac', () => {
    const nowsze = dir('odtw-nowsze');
    cpSync(kopia, nowsze, { recursive: true });
    // A copy written by a build that had one migration more than this one.
    const db = new Database(resolve(nowsze, 'app.db'));
    db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
      'platform-0004-z-przyszlosci',
      '2027-01-01T00:00:00.000Z',
    );
    db.close();
    // The manifest is regenerated so the refusal is about the code version and
    // not merely about a checksum that no longer matches.
    const przebudowa = run('backup-state.mjs', ['--data', nowsze, '--out', dir('odtw-nowsze-kopia')]);
    expect(przebudowa.status, przebudowa.out).toBe(0);

    const cel = dir('odtw-cel-nowsze');
    mkdirSync(cel, { recursive: true });
    const r = run('restore-state.mjs', ['--backup', dir('odtw-nowsze-kopia'), '--data', cel, '--check']);
    expect(r.status).toBe(3);
    expect(r.out).toMatch(/kopia zawiera migracje nieznane temu buildowi: platform-0004-z-przyszlosci/);
  }, 180_000);

  it('odmawia odtworzenia z kopii, ktora sie nie weryfikuje', () => {
    const zepsuta = dir('odtw-zepsuta');
    cpSync(kopia, zepsuta, { recursive: true });
    appendFileSync(resolve(zepsuta, 'files', 'local-user', readdirSync(resolve(zepsuta, 'files', 'local-user'))[0]!), 'x');

    const cel = dir('odtw-cel-zepsuta');
    mkdirSync(cel, { recursive: true });
    writeFileSync(resolve(cel, 'znacznik'), 'nietkniety');
    const r = run('restore-state.mjs', ['--backup', zepsuta, '--data', cel]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/KOPIA NIEPOPRAWNA/);
    // Refused before anything was moved: the state from before the attempt is
    // still exactly where it was.
    expect(readFileSync(resolve(cel, 'znacznik'), 'utf8')).toBe('nietkniety');
  }, 120_000);

  it('odklada stan sprzed proby, odtwarza kopie i aplikacja wstaje na odtworzonym stanie', () => {
    const cel = dir('odtw-cel');
    // The directory being replaced holds a different database *and* this
    // installation's session secret.
    expect(run('synthetic-state.mjs', ['--out', cel, '--stage', 'platform-0003-file-versions']).status).toBe(0);
    writeFileSync(resolve(cel, 'session.secret'), 'sekret-instalacji\n');
    const przedOdtworzeniem = census(resolve(cel, 'app.db'));

    const r = run('restore-state.mjs', ['--backup', kopia, '--data', cel]);
    expect(r.status, r.out).toBe(0);

    /* 1. the state from before the attempt: moved aside, complete, untouched */
    const odlozone = readdirSync(work).filter((d) => d.startsWith('odtw-cel.przed-odtworzeniem-'));
    expect(odlozone, 'poprzedni stan nie zostal odlozony').toHaveLength(1);
    expect(census(resolve(work, odlozone[0]!, 'app.db'))).toEqual(przedOdtworzeniem);

    /* 2. what was restored, including the write that lived only in the WAL */
    expect(
      count(resolve(cel, 'app.db'), `SELECT COUNT(*) AS n FROM conversations WHERE id='cnv_syn_tylko_w_wal'`),
    ).toBe(1);
    expect(readdirSync(resolve(cel, 'files', 'local-user'))).toHaveLength(2);

    /* 3. application sessions: the secret is carried over, so logins survive */
    expect(readFileSync(resolve(cel, 'session.secret'), 'utf8')).toBe('sekret-instalacji\n');
    // ...and it is not the backup that provided it — the backup has none.
    expect(existsSync(resolve(kopia, 'session.secret'))).toBe(false);

    /* 4. the restored state is one the application can actually start on */
    const b = boot(cel);
    expect(b.status, b.out).toBe(0);
    expect(b.out).toMatch(/ROZMOWY 2/);
  }, 300_000);
});
