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
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

/*
 * `better-sqlite3` is a dependency of `@platform/server`, not of the repository
 * root, and it stays that way: adding it to the root manifest so a script can
 * `import` it would declare a dependency the application does not have. This
 * resolves it from the package that legitimately owns it.
 */
const Database = createRequire(resolve(import.meta.dirname, '../packages/platform-server/package.json'))(
  'better-sqlite3',
);

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DB_PARTS = ['app.db', 'app.db-wal', 'app.db-shm'];
const TREES = ['files', 'workspaces'];

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

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
 * Row census of every table, plus the applied migrations.
 *
 * Counts alone would miss content that changed without changing shape, so each
 * table also gets a digest over its rows in primary-key order. That is what
 * lets the migration rehearsal say "these conversations are the same
 * conversations" rather than "there are still eleven of them".
 */
export function census(dbFile) {
  const db = new Database(dbFile, { readonly: true });
  try {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((r) => r.name);
    const tableCounts = {};
    const tableDigests = {};
    for (const t of tables) {
      tableCounts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      const rows = db.prepare(`SELECT * FROM "${t}"`).all();
      const canonical = rows
        .map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]])))
        .sort();
      tableDigests[t] = createHash('sha256').update(canonical.join('\n')).digest('hex');
    }
    const migrations = tables.includes('schema_migrations')
      ? db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id)
      : [];
    const integrity = db.pragma('integrity_check', { simple: true });
    return { tables, tableCounts, tableDigests, migrations, integrity };
  } finally {
    db.close();
  }
}

/** Refuses to copy a database some process may be writing to. */
function assertNobodyHoldsIt(dbFile) {
  for (const part of DB_PARTS) {
    const p = resolve(dbFile, '..', part);
    if (!existsSync(p)) continue;
    try {
      const holders = execFileSync('fuser', [p], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      if (holders) {
        throw new Error(
          `Plik ${p} jest otwarty przez proces(y): ${holders}.\n` +
            'Zatrzymaj aplikacje przed wykonaniem kopii — kopia bazy zapisywanej w tle moze byc niespojna.',
        );
      }
    } catch (e) {
      // `fuser` exits non-zero when nothing holds the file: that is the good case.
      if (e instanceof Error && /jest otwarty przez proces/.test(e.message)) throw e;
    }
  }
}

function backup({ dataDir, outDir }) {
  const dbFile = resolve(dataDir, 'app.db');
  if (!existsSync(dbFile)) throw new Error(`Nie znaleziono bazy: ${dbFile}`);
  assertNobodyHoldsIt(dbFile);

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
function verify(outDir) {
  const manifestPath = resolve(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`Brak manifestu: ${manifestPath}`);
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
/*
 * Last, after every read: drop the empty log and the shared-memory index.
 *
 * They are recreated by each `census`/`verify` connection, so clearing them
 * earlier achieves nothing. Removing them here leaves the backup as a single
 * `app.db`, which is what makes a restore one copy instead of three — and
 * removes the chance of someone restoring the main file without its log, the
 * exact mistake this script exists to prevent.
 */
export function tidy(dir) {
  for (const stray of ['app.db-wal', 'app.db-shm']) {
    const p = resolve(dir, stray);
    if (existsSync(p)) rmSync(p);
  }
}
tidy(outDir);

console.log('[backup] weryfikacja: kopia odczytana ponownie, sumy i census zgodne, integrity_check ok');
console.log(`[backup] kopia to jeden plik app.db — odtworzenie: patrz docs/odzyskiwanie-stanu.md`);
