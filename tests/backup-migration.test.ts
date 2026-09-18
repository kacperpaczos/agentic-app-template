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
  rmSync,
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
     */
    for (const file of ['app.db', 'app.db-wal']) {
      expect(sha256(resolve(dane, file)), `${file} zmieniony przez wykonanie kopii`).toBe(przed[file]);
    }
  });
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
     */
    const przed = census(resolve(udawaneDane, 'app.db'));
    const r = run('migration-rehearsal.mjs', ['--backup', udawaneDane], { APP_DATA_DIR: udawaneDane });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/odmawiam proby na katalogu danych aplikacji/);
    expect(census(resolve(udawaneDane, 'app.db')), 'proba dotknela bazy').toEqual(przed);
  }, 60_000);

  it('proba migracji na katalogu z session.secret jest odrzucona, nawet bez APP_DATA_DIR', () => {
    // No path comparison could catch this one: the directory is not named
    // anywhere. The tell is the secret, which a backup never contains.
    const przed = census(resolve(udawaneDane, 'app.db'));
    const r = run('migration-rehearsal.mjs', ['--backup', udawaneDane]);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/zawiera session\.secret/);
    expect(census(resolve(udawaneDane, 'app.db'))).toEqual(przed);
  }, 60_000);

  it('generator danych syntetycznych odmawia nadpisania katalogu danych', () => {
    // It deletes what it is pointed at, so it gets the same refusal.
    const r = run('synthetic-state.mjs', ['--out', udawaneDane, '--stage', 'current']);
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/zawiera session\.secret/);
    expect(existsSync(resolve(udawaneDane, 'app.db'))).toBe(true);
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
