#!/usr/bin/env node
/**
 * Rehearses a migration on a copy, and proves what it did and did not change.
 *
 *   node scripts/migration-rehearsal.mjs --backup backups/data-2026-09-15
 *   node scripts/migration-rehearsal.mjs --backup DIR --out DIR --json FILE
 *
 * The question this answers is not "do the migrations run" — that is visible
 * from any boot. It is the one that has to be settled *before* touching real
 * data: **does starting the new build over an existing database keep every
 * conversation, message, canvas card, artifact, file and domain row, and does
 * it stay that way if it happens again?**
 *
 * How it establishes that:
 *
 *  1. copies the backup to a scratch directory — the backup itself is never
 *     opened for writing, so it remains a restorable copy throughout;
 *  2. takes a full census (row counts *and* a content digest per table);
 *  3. boots the real platform against the copy, which is exactly what
 *     `pnpm start` does: it applies the pending migrations and runs the
 *     tool-activity backfill;
 *  4. compares the census, table by table, and reports every difference with
 *     the reason it is expected — or fails;
 *  5. **boots a second time** and requires the census to be byte-identical to
 *     the first result. That is the check for duplication: a backfill that
 *     re-ran its work would show up here as extra message rows, and nowhere
 *     else.
 *
 * It never runs against `data/`. The `--backup` argument must name a directory
 * holding a backup manifest, and the rehearsal works on a copy of that.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require_ = createRequire(
  resolve(import.meta.dirname, '../packages/platform-server/package.json'),
);
const Database = require_('better-sqlite3');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const REPO = resolve(import.meta.dirname, '..');

/* ------------------------------- the census ------------------------------- */

/**
 * @param dbFile   database to inspect
 * @param restrict optional `{ table: [column, ...] }`. Where given, a second
 *   digest is computed over **only those columns**. That is what lets the
 *   comparison below distinguish "the migration added a column" from "the
 *   migration changed the data": the columns that existed before the migration
 *   must still hold exactly the same values, while the new ones are allowed to
 *   appear. Comparing `SELECT *` alone cannot tell the two apart, and treating
 *   the whole table as "expected to change" would hide a rewritten row.
 */
function census(dbFile, restrict = {}) {
  const db = new Database(dbFile, { readonly: true });
  try {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
    const counts = {};
    const digests = {};
    const columns = {};
    const restrictedDigests = {};
    const digestOf = (rows, keep) =>
      createHash('sha256')
        .update(
          rows
            .map((r) =>
              JSON.stringify(
                Object.keys(r)
                  .filter((k) => !keep || keep.includes(k))
                  .sort()
                  .map((k) => [k, r[k]]),
              ),
            )
            .sort()
            .join('\n'),
        )
        .digest('hex');
    for (const t of tables) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      // From the schema, not from the rows: an empty table still has columns.
      columns[t] = db
        .prepare(`PRAGMA table_info("${t}")`)
        .all()
        .map((c) => c.name)
        .sort();
      const rows = db.prepare(`SELECT * FROM "${t}"`).all();
      digests[t] = digestOf(rows, null);
      if (restrict[t]) restrictedDigests[t] = digestOf(rows, restrict[t]);
    }
    return {
      tables,
      counts,
      digests,
      columns,
      restrictedDigests,
      migrations: tables.includes('schema_migrations')
        ? db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id)
        : [],
      integrity: db.pragma('integrity_check', { simple: true }),
      /* The rows a user would notice missing, identified rather than counted. */
      conversationIds: tables.includes('conversations')
        ? db.prepare('SELECT id FROM conversations ORDER BY id').all().map((r) => r.id)
        : [],
      userMessages: tables.includes('messages')
        ? db
            .prepare(`SELECT id, conversation_id, content, seq FROM messages WHERE role='user' ORDER BY id`)
            .all()
        : [],
      cardIds: tables.includes('canvas_cards')
        ? db.prepare('SELECT id, space_id, spec FROM canvas_cards ORDER BY id').all()
        : [],
      fileIds: tables.includes('files') ? db.prepare('SELECT id FROM files ORDER BY id').all().map((r) => r.id) : [],
      artifactIds: tables.includes('artifacts')
        ? db.prepare('SELECT id FROM artifacts ORDER BY id').all().map((r) => r.id)
        : [],
    };
  } finally {
    db.close();
  }
}

/**
 * Starts the platform once against `dataDir`, then shuts it down.
 *
 * Deliberately the real thing — `apps/server/src/compose.ts` through
 * `createPlatform`, the same path `pnpm start` takes — so the rehearsal covers
 * whatever boot actually does, including any step added later, rather than a
 * re-implementation of it that could drift.
 */
function bootOnce(dataDir) {
  const script = `
    import { composeApp } from ${JSON.stringify(resolve(REPO, 'apps/server/src/compose.ts'))};
    const p = composeApp({ dataDir: ${JSON.stringify(dataDir)} });
    p.close();
  `;
  return execFileSync(
    process.execPath,
    ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--input-type=module', '-e', script],
    { cwd: REPO, env: { ...process.env, APP_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
    .toString()
    .trim();
}

/* ------------------------------ the comparison ---------------------------- */

/**
 * Tables the migration is *expected* to change, and in what way.
 *
 * Anything not listed here must come out byte-identical. Naming the exceptions
 * explicitly is what stops "the totals still add up" from passing for
 * "nothing was lost": a rebuilt assistant turn genuinely changes the `messages`
 * digest, and a check that tolerated any change to any table would also
 * tolerate a dropped conversation.
 *
 * The two kinds of exception are deliberately different in strength:
 *
 *  - `addedColumns` — the migration widens the table and nothing else. The
 *    columns that existed before must still hold exactly the same values, the
 *    row count must be unchanged, and the only new columns allowed are the ones
 *    named here. This is a *stronger* check than an untouched digest would be
 *    on a table that cannot change at all, and it is why `files` can be listed
 *    without weakening anything: `platform-0003-file-versions` adds two columns
 *    to it, which used to be reported as an unexplained change and made the
 *    rehearsal unusable on any copy that actually contained files.
 *  - `rowsMayChange` — the migration or the boot rewrites rows (the migration
 *    log grows, a turn is rebuilt from its events). Here the digest cannot say
 *    anything, so the guarantee comes from the identity checks below: every
 *    conversation, user message, card, file and artifact is followed by id.
 */
const EXPECTED_TO_CHANGE = {
  schema_migrations: { reason: 'migracja dopisuje swoj wpis', rowsMayChange: true },
  agent_runs: {
    reason: 'platform-0002 dodaje kolumne enqueued_at i wypelnia ja z started_at',
    addedColumns: ['enqueued_at'],
  },
  messages: {
    reason: 'odtworzenie aktywnosci narzedzi zastepuje pojedyncza wiadomosc asystenta pelna tura',
    rowsMayChange: true,
  },
  files: {
    reason:
      'platform-0003-file-versions dodaje kolumny derived_from_file_id i version; ' +
      'istniejace wiersze zachowuja wszystkie dotychczasowe wartosci',
    addedColumns: ['derived_from_file_id', 'version'],
  },
};

function compare(before, after) {
  const problems = [];
  const notes = [];

  if (after.integrity !== 'ok') problems.push(`integrity_check po migracji: ${after.integrity}`);

  for (const t of before.tables) {
    if (!after.tables.includes(t)) problems.push(`tabela ${t} zniknela`);
  }

  for (const t of before.tables.filter((t) => after.tables.includes(t))) {
    const expected = EXPECTED_TO_CHANGE[t];

    /* --- a table that was only widened is checked column by column --- */
    if (expected?.addedColumns) {
      const lost = before.columns[t].filter((c) => !after.columns[t].includes(c));
      const added = after.columns[t].filter((c) => !before.columns[t].includes(c));
      const unannounced = added.filter((c) => !expected.addedColumns.includes(c));
      if (lost.length) problems.push(`tabela ${t}: zniknely kolumny ${lost.join(', ')}`);
      if (unannounced.length) {
        problems.push(
          `tabela ${t}: nieopisane nowe kolumny ${unannounced.join(', ')} ` +
            '(uzupelnij EXPECTED_TO_CHANGE razem z testem)',
        );
      }
      if (before.counts[t] !== after.counts[t]) {
        problems.push(
          `tabela ${t}: zmieniona liczba wierszy (${before.counts[t]} → ${after.counts[t]}), ` +
            'a migracja mialas tylko dodac kolumny',
        );
      }
      // The values that were there before, compared over exactly those columns.
      if (after.restrictedDigests[t] !== before.digests[t]) {
        problems.push(`tabela ${t}: zmieniona tresc w kolumnach sprzed migracji`);
      } else if (added.length) {
        notes.push(`${t}: dodane kolumny ${added.join(', ')} (${expected.reason}); dane bez zmian`);
      }
      continue;
    }

    const changed = before.digests[t] !== after.digests[t];
    if (!changed) continue;
    if (expected) {
      notes.push(`${t}: ${before.counts[t]} → ${after.counts[t]} wierszy (${expected.reason})`);
    } else {
      problems.push(
        `tabela ${t} zmieniona nieoczekiwanie (${before.counts[t]} → ${after.counts[t]} wierszy)`,
      );
    }
  }

  /* --- the rows a user would notice missing, checked by identity --- */

  const missingConv = before.conversationIds.filter((id) => !after.conversationIds.includes(id));
  if (missingConv.length) problems.push(`utracone rozmowy: ${missingConv.join(', ')}`);

  const afterUser = new Map(after.userMessages.map((m) => [m.id, m]));
  for (const m of before.userMessages) {
    const now = afterUser.get(m.id);
    if (!now) problems.push(`utracona wiadomosc uzytkownika ${m.id}`);
    else if (now.content !== m.content) problems.push(`zmieniona tresc wiadomosci ${m.id}`);
    else if (now.conversation_id !== m.conversation_id) {
      problems.push(`wiadomosc ${m.id} przeniesiona do innej rozmowy`);
    }
  }

  const afterCards = new Map(after.cardIds.map((c) => [c.id, c]));
  for (const c of before.cardIds) {
    const now = afterCards.get(c.id);
    if (!now) problems.push(`utracona karta canvasu ${c.id}`);
    else if (now.spec !== c.spec) problems.push(`zmieniona kompozycja karty ${c.id}`);
  }

  for (const id of before.fileIds) {
    if (!after.fileIds.includes(id)) problems.push(`utracony plik ${id}`);
  }
  for (const id of before.artifactIds) {
    if (!after.artifactIds.includes(id)) problems.push(`utracony artefakt ${id}`);
  }

  return { problems, notes };
}

/** Second boot must change nothing at all. */
function compareIdempotent(first, second) {
  const problems = [];
  for (const t of first.tables) {
    if (first.counts[t] !== second.counts[t]) {
      problems.push(
        `powtorna migracja zmienila liczbe wierszy w ${t}: ${first.counts[t]} → ${second.counts[t]}`,
      );
    } else if (first.digests[t] !== second.digests[t]) {
      problems.push(`powtorna migracja zmienila tresc tabeli ${t}`);
    }
  }
  return problems;
}

/* --------------------------------- main ---------------------------------- */

const backupDir = resolve(flag('backup', resolve(REPO, 'backups/data-2026-09-15')));

/*
 * Three refusals, because the rehearsal *boots the application* against what it
 * is given: migrations are applied, a session secret is written, the backfill
 * runs. Pointed at a live directory it would not be a rehearsal at all — it
 * would be the migration, performed on the user's data, under a name that says
 * otherwise. The whole value of this script is the separation between "ready to
 * migrate" and "migrated", so the checks come before anything is read.
 *
 * `APP_DATA_DIR` is checked by name, not only the repository's own `data/`: an
 * installation that keeps its state elsewhere — which the configuration
 * explicitly allows — was previously unprotected.
 */
const liveDirs = [resolve(REPO, 'data'), process.env.APP_DATA_DIR ? resolve(process.env.APP_DATA_DIR) : null]
  .filter(Boolean);
if (liveDirs.includes(resolve(backupDir))) {
  console.error(
    `[proba] odmawiam proby na katalogu danych aplikacji (${resolve(backupDir)}). Uzyj kopii:\n` +
      '        node scripts/backup-state.mjs --data <dane> --out backups/<nazwa>',
  );
  process.exit(2);
}
if (existsSync(resolve(backupDir, 'session.secret'))) {
  /*
   * A backup never contains `session.secret` — `backup-state.mjs` leaves it out
   * on purpose. Finding one means this is a live data directory wearing a
   * backup's name, and no path comparison would have caught it.
   */
  console.error(
    `[proba] ${backupDir} zawiera session.secret, wiec jest katalogiem danych aplikacji, nie kopia. Odmawiam.`,
  );
  process.exit(2);
}
if (!existsSync(resolve(backupDir, 'manifest.json'))) {
  console.error(
    `[proba] ${backupDir} nie wyglada na kopie (brak manifest.json).\n` +
      'Wykonaj najpierw: node scripts/backup-state.mjs --data data --out backups/<nazwa>',
  );
  process.exit(2);
}

/**
 * Fingerprint of every file in a directory tree.
 *
 * Taken of the backup before the rehearsal and again after it. The rehearsal
 * works on a copy *by construction*, but "by construction" is an argument, and
 * the point of this script is to replace arguments with measurements — so the
 * claim "the source was not touched" is one of the things it measures.
 */
function fingerprint(dir) {
  const out = {};
  const walk = (d, base) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = resolve(d, entry.name);
      if (entry.isDirectory()) walk(full, base);
      else if (entry.isFile()) {
        out[full.slice(base.length + 1)] = createHash('sha256')
          .update(readFileSync(full))
          .digest('hex');
      }
    }
  };
  walk(dir, dir);
  return out;
}

const backupBefore = fingerprint(backupDir);

const work = flag('out') ? resolve(flag('out')) : mkdtempSync(resolve(tmpdir(), 'agentic-rehearsal-'));
/*
 * The working directory is *deleted* before it is filled, so it gets the same
 * refusals as the source — an `--out` pointing at a data directory would not
 * rehearse anything, it would destroy it.
 */
if (liveDirs.includes(work) || existsSync(resolve(work, 'session.secret'))) {
  console.error(`[proba] odmawiam uzycia ${work} jako katalogu proby: to katalog danych aplikacji.`);
  process.exit(2);
}
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
cpSync(backupDir, work, { recursive: true });
rmSync(resolve(work, 'manifest.json'), { force: true });

const dbFile = resolve(work, 'app.db');
const before = census(dbFile);

console.log(`[proba] kopia zrodlowa: ${backupDir}`);
console.log(`[proba] katalog proby:  ${work}`);
console.log(`[proba] przed:  migracje=[${before.migrations.join(', ')}]`);
console.log(
  `[proba]         rozmowy=${before.counts.conversations ?? 0} wiadomosci=${before.counts.messages ?? 0} ` +
    `uruchomienia=${before.counts.agent_runs ?? 0} zdarzenia=${before.counts.run_events ?? 0} ` +
    `karty=${before.counts.canvas_cards ?? 0} pliki=${before.counts.files ?? 0}`,
);

const bootLog1 = bootOnce(work);
// Restricted to the columns that existed before, so a widened table can be
// judged on its old values instead of being written off as "changed".
const after = census(dbFile, before.columns);
console.log(`[proba] po:     migracje=[${after.migrations.join(', ')}]`);
console.log(
  `[proba]         rozmowy=${after.counts.conversations ?? 0} wiadomosci=${after.counts.messages ?? 0} ` +
    `uruchomienia=${after.counts.agent_runs ?? 0} zdarzenia=${after.counts.run_events ?? 0} ` +
    `karty=${after.counts.canvas_cards ?? 0} pliki=${after.counts.files ?? 0}`,
);
for (const line of bootLog1.split('\n').filter((l) => l.includes('[platform]'))) {
  console.log(`[proba] boot:   ${line.trim()}`);
}

const { problems, notes } = compare(before, after);
for (const n of notes) console.log(`[proba] zmiana oczekiwana — ${n}`);

const bootLog2 = bootOnce(work);
const again = census(dbFile);
const idempotency = compareIdempotent(after, again);

/* --- and the copy this was rehearsed from is still exactly a copy --- */
const backupAfter = fingerprint(backupDir);
const touched = [
  ...Object.keys(backupAfter).filter((f) => backupBefore[f] !== backupAfter[f]),
  ...Object.keys(backupBefore).filter((f) => !(f in backupAfter)),
];
const sourceProblems = touched.map((f) => `proba zmienila plik w kopii zrodlowej: ${f}`);

const report = {
  at: new Date().toISOString(),
  backup: backupDir,
  workdir: work,
  migrationsBefore: before.migrations,
  migrationsAfter: after.migrations,
  migrationsApplied: after.migrations.filter((m) => !before.migrations.includes(m)),
  sourceUntouched: sourceProblems.length === 0,
  countsBefore: before.counts,
  countsAfter: after.counts,
  expectedChanges: notes,
  preserved: {
    rozmowy: before.conversationIds.length,
    wiadomosciUzytkownika: before.userMessages.length,
    kartyCanvasu: before.cardIds.length,
    pliki: before.fileIds.length,
    artefakty: before.artifactIds.length,
  },
  secondBootChangedNothing: idempotency.length === 0,
  problems: [...problems, ...idempotency, ...sourceProblems],
  bootOutput: [bootLog1, bootLog2].map((l) =>
    l.split('\n').filter((x) => x.includes('[platform]')).join(' | '),
  ),
};

const jsonOut = flag('json');
if (jsonOut) {
  mkdirSync(resolve(jsonOut, '..'), { recursive: true });
  writeFileSync(resolve(jsonOut), JSON.stringify(report, null, 2));
  console.log(`[proba] raport: ${resolve(jsonOut)}`);
}

console.log(
  `[proba] zachowane: ${report.preserved.rozmowy} rozmow, ` +
    `${report.preserved.wiadomosciUzytkownika} wiadomosci uzytkownika (tresc i przypisanie), ` +
    `${report.preserved.kartyCanvasu} kart canvasu (kompozycje bez zmian), ` +
    `${report.preserved.pliki} plikow, ${report.preserved.artefakty} artefaktow`,
);
console.log(
  `[proba] powtorne uruchomienie: ${idempotency.length === 0 ? 'nic nie zmienilo (brak dublowania)' : 'ZMIENILO STAN'}`,
);
console.log(
  `[proba] kopia zrodlowa: ${sourceProblems.length === 0 ? `${Object.keys(backupBefore).length} plikow bez zmian (sumy SHA-256)` : 'ZMIENIONA'}`,
);
console.log(
  `[proba] zastosowane migracje: ${report.migrationsApplied.join(', ') || '(zadnych — kopia byla juz aktualna)'}`,
);

if (report.problems.length) {
  console.error(`[proba] PROBA NIEUDANA (${report.problems.length}):`);
  for (const p of report.problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('[proba] wynik: migracja i odtworzenie aktywnosci narzedzi zachowaly caly stan');
