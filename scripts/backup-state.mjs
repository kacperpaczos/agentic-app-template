#!/usr/bin/env node
/**
 * Verified backup of a local persistent state directory.
 *
 *   node scripts/backup-state.mjs                      # back up ./data
 *   node scripts/backup-state.mjs --data DIR --out DIR
 *   node scripts/backup-state.mjs --verify BACKUP_DIR   # re-check an existing one
 *
 * **Why this is not `cp data/app.db somewhere`.** In WAL mode a committed
 * transaction lives in `app.db-wal` until a checkpoint folds it into the main
 * file. In this repository's own `data/` directory at the time of writing,
 * `app.db` was 397 kB and a day old while `app.db-wal` was 4.1 MB and current:
 * copying the main file alone would have produced a backup missing most of the
 * work, and it would have looked like a complete one. The three files are
 * therefore copied together and the copy is checkpointed into a single
 * self-contained database afterwards.
 *
 * **The source database is never opened.** It is read as bytes and nothing
 * else — no connection, no recovery, no checkpoint, no `-shm` rewrite. Opening
 * a WAL database read-write is itself a write (SQLite recovers the log), and
 * even `readonly: true` is not neutral: it rebuilds `app.db-shm`. That was
 * observed here rather than assumed — a readonly count query against `data/`
 * changed that file's checksum while `app.db` and `app.db-wal` stayed identical.
 * Neither is an acceptable side effect of taking a backup.
 *
 * The consequence is that this refuses to run while a process holds the
 * database: a byte copy of a database being written to can be torn, and the
 * check is what makes the copy trustworthy rather than merely likely.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Database,
  SCRATCH_MARKER,
  assertAwayFromLiveData,
  assertNobodyHoldsIt,
  assertOwnOrEmptyDir,
  census as censusOf,
  isWithin,
  makeArgs,
  realResolve,
  refuse,
  runScript,
  sha256File as sha256,
  tidy,
} from './lib/state-tools.mjs';

export { tidy };

const { flag } = makeArgs(process.argv);

const DB_PARTS = ['app.db', 'app.db-wal', 'app.db-shm'];
const TREES = ['files', 'workspaces'];

function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push({ path: relative(base, full), sha256: sha256(full), bytes: statSync(full).size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The manifest's census, in the manifest's own shape.
 *
 * The computation is shared (`lib/state-tools.mjs`); only the field names are
 * this file's, and they are kept as they were because they are **written into
 * every manifest ever produced**. A backup taken last month is read by
 * `--verify` and by `restore-state.mjs` today, so renaming a key here would
 * quietly declare older copies unverifiable.
 */
export function census(dbFile) {
  const c = censusOf(dbFile);
  return {
    tables: c.tables,
    tableCounts: c.counts,
    tableDigests: c.digests,
    tableColumns: c.columns,
    migrations: c.migrations,
    integrity: c.integrity,
  };
}

/**
 * Where the copy may be written.
 *
 * Three questions, and for a long time this asked only the first two.
 *
 *  1. Is `--out` **inside** `--data`? Then the backup is copied into itself on
 *     the next run, grows without bound, and is deleted by the same
 *     `rm -rf data` the recovery procedure warns about.
 *  2. Does `--out` **contain** `--data`? Then the copy and the original share a
 *     fate, which is the one thing a copy must not do.
 *  3. Is `--out` somebody's **live data directory** — any live data directory,
 *     not just the one being copied?
 *
 * The third was missing, and its absence was the worst defect in this package:
 * `--data <cokolwiek> --out <katalog danych>` overwrote the user's `app.db` and
 * their file tree with another installation's, printed "weryfikacja: kopia
 * odczytana ponownie, sumy i census zgodne" and exited 0. A backup destroying
 * data while reporting success is the exact inverse of what L10.19 requires,
 * and no amount of care about `--data` could have caught it, because the copy
 * *reads* `--data` and *writes* `--out`.
 *
 * `assertAwayFromLiveData` is deliberately applied to `--out` only. Reading a
 * live data directory is this script's whole purpose; writing into one never is.
 */
function assertSafeOutDir(dataDir, outDir) {
  const data = realResolve(dataDir);
  const out = realResolve(outDir);
  if (isWithin(out, data)) {
    refuse(
      `Katalog kopii ${out} lezy wewnatrz katalogu danych ${data}.\n` +
        'Wskaz katalog poza katalogiem danych (--out), inaczej kopia jest czescia tego, co kopiuje.',
    );
  }
  if (isWithin(data, out)) {
    refuse(
      `Katalog kopii ${out} zawiera katalog danych ${data}.\n` +
        'Kopia i oryginal dzielilyby los; wskaz katalog obok (--out).',
    );
  }
  assertAwayFromLiveData(out, { what: 'Katalog kopii' });
  /*
   * And, even where nothing marks the destination as application data: a backup
   * overwrites `app.db` and the file trees, so it may only land somewhere empty,
   * new, or recognisably a previous backup of its own (`manifest.json`).
   */
  assertOwnOrEmptyDir(out, {
    what: 'Katalog kopii',
    ownMarkers: ['manifest.json', SCRATCH_MARKER],
  });
}

export function backup({ dataDir, outDir }) {
  const dbFile = resolve(dataDir, 'app.db');
  if (!existsSync(dbFile)) refuse(`Nie znaleziono bazy: ${dbFile}`);
  assertSafeOutDir(dataDir, outDir);
  assertNobodyHoldsIt(dataDir, { label: 'backup' });

  mkdirSync(outDir, { recursive: true });

  /* ---- 1. the database, as bytes, all parts together ---- */
  const parts = [];
  for (const part of DB_PARTS) {
    const src = resolve(dataDir, part);
    if (!existsSync(src)) continue;
    const dst = resolve(outDir, part);
    copyFileSync(src, dst);
    parts.push({ part, bytes: statSync(src).size, sha256: sha256(src) });
  }
  if (!parts.some((p) => p.part === 'app.db-wal')) {
    console.log('[backup] brak app.db-wal — baza byla zamknieta czysto');
  }

  /*
   * 2. Fold the log into the copy.
   *
   * Done on the copy, never on the source. Afterwards `app.db` in the backup is
   * one self-contained file, which is what makes restoring it a single `cp` and
   * removes the chance of someone restoring the main file without its log.
   */
  const copyDb = new Database(resolve(outDir, 'app.db'));
  try {
    copyDb.pragma('journal_mode = WAL');
    copyDb.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    copyDb.close();
  }

  /* ---- 3. file trees ---- */
  const trees = {};
  for (const tree of TREES) {
    const src = resolve(dataDir, tree);
    const files = walk(src);
    trees[tree] = files;
    for (const f of files) {
      const dst = resolve(outDir, tree, f.path);
      mkdirSync(resolve(dst, '..'), { recursive: true });
      copyFileSync(resolve(src, f.path), dst);
    }
  }

  /*
   * `session.secret` is deliberately not copied. It signs this installation's
   * own login cookies and is not application data; a backup that carries it
   * turns a copy of the state into a copy of the credentials.
   */

  const manifest = {
    createdAt: new Date().toISOString(),
    source: dataDir,
    note:
      'Kopia obejmuje app.db (po zwiniecia WAL), pliki i przestrzenie robocze. ' +
      'session.secret nie jest kopiowany celowo — to sekret instalacji, nie dane.',
    databaseParts: parts,
    databaseAfterCheckpoint: {
      bytes: statSync(resolve(outDir, 'app.db')).size,
      sha256: sha256(resolve(outDir, 'app.db')),
    },
    census: census(resolve(outDir, 'app.db')),
    trees,
  };
  writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Re-checks an existing backup against its own manifest.
 *
 * A backup nobody has read back is a hope, not a copy. This is the step that
 * turns one into the other, and it is run immediately after writing so the
 * result is reported at the moment of creation rather than discovered later.
 */
export function verify(outDir) {
  const manifestPath = resolve(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) refuse(`Brak manifestu: ${manifestPath} — to nie wyglada na kopie.`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const problems = [];

  const dbCopy = resolve(outDir, 'app.db');
  if (!existsSync(dbCopy)) problems.push('brak app.db w kopii');
  else {
    if (sha256(dbCopy) !== manifest.databaseAfterCheckpoint.sha256) {
      problems.push('suma kontrolna app.db nie zgadza sie z manifestem');
    }
    const now = census(dbCopy);
    if (now.integrity !== 'ok') problems.push(`integrity_check: ${now.integrity}`);
    for (const [table, n] of Object.entries(manifest.census.tableCounts)) {
      if (now.tableCounts[table] !== n) {
        problems.push(`tabela ${table}: ${now.tableCounts[table]} wierszy, w manifescie ${n}`);
      }
    }
    for (const [table, digest] of Object.entries(manifest.census.tableDigests)) {
      if (now.tableDigests[table] !== digest) problems.push(`tabela ${table}: inna tresc wierszy`);
    }
  }

  for (const [tree, files] of Object.entries(manifest.trees)) {
    for (const f of files) {
      const p = resolve(outDir, tree, f.path);
      if (!existsSync(p)) problems.push(`brak pliku ${tree}/${f.path}`);
      else if (sha256(p) !== f.sha256) problems.push(`inna suma kontrolna ${tree}/${f.path}`);
    }
  }
  return problems;
}

/* --------------------------------- main ---------------------------------- */

/**
 * Guarded so the functions above can be imported — by `restore-state.mjs`,
 * which must verify a backup before it touches anything, and by the regression
 * tests. Without the guard, importing this file would run a backup.
 *
 * `tidy` (dropping the now-empty log after the last read) is shared, and
 * re-exported at the top of this file so callers still find it here.
 */
function main() {
  const verifyOnly = flag('verify');
  if (verifyOnly) {
    const problems = verify(resolve(verifyOnly));
    if (problems.length) {
      console.error(`[backup] KOPIA NIEPOPRAWNA (${problems.length}):`);
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`[backup] kopia ${resolve(verifyOnly)} sprawdzona: bez zastrzezen`);
    process.exit(0);
  }

  const dataDir = resolve(flag('data', resolve(process.cwd(), 'data')));
  const outDir = resolve(
    flag('out', resolve(process.cwd(), 'backups', `${basename(dataDir)}-${new Date().toISOString().replace(/[:.]/g, '-')}`)),
  );

  const manifest = backup({ dataDir, outDir });
  const problems = verify(outDir);

  console.log(`[backup] zrodlo:   ${dataDir}`);
  console.log(`[backup] kopia:    ${outDir}`);
  console.log(
    `[backup] baza:     ${manifest.databaseParts.map((p) => `${p.part} ${(p.bytes / 1024).toFixed(0)} kB`).join(', ')}` +
      ` → app.db ${(manifest.databaseAfterCheckpoint.bytes / 1024).toFixed(0)} kB po zwinieciu WAL`,
  );
  console.log(`[backup] migracje: ${manifest.census.migrations.join(', ') || '(brak)'}`);
  const interesting = ['conversations', 'messages', 'agent_runs', 'run_events', 'canvas_spaces', 'canvas_cards', 'artifacts', 'files'];
  console.log(
    `[backup] wiersze:  ${interesting
      .filter((t) => t in manifest.census.tableCounts)
      .map((t) => `${t}=${manifest.census.tableCounts[t]}`)
      .join(' ')}`,
  );
  for (const [tree, files] of Object.entries(manifest.trees)) {
    console.log(`[backup] ${tree}: ${files.length} plikow`);
  }

  if (problems.length) {
    console.error(`[backup] WERYFIKACJA NIEUDANA (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  tidy(outDir);

  console.log('[backup] weryfikacja: kopia odczytana ponownie, sumy i census zgodne, integrity_check ok');
  console.log(`[backup] kopia to jeden plik app.db — odtworzenie: patrz docs/odzyskiwanie-stanu.md`);
}

if (process.argv[1] && realResolve(process.argv[1]) === realResolve(fileURLToPath(import.meta.url))) {
  runScript('backup', main);
}
