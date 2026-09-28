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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function census(dbFile) {
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
    for (const t of tables) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      const rows = db.prepare(`SELECT * FROM "${t}"`).all();
      const canonical = rows
        .map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]])))
        .sort();
      digests[t] = createHash('sha256').update(canonical.join('\n')).digest('hex');
    }
    return {
      tables,
      counts,
      digests,
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
 * Tables the migration is *expected* to change, and why.
 *
 * Anything not listed here must come out byte-identical. Naming the exceptions
 * explicitly is what stops "the totals still add up" from passing for
 * "nothing was lost": a rebuilt assistant turn genuinely changes the `messages`
 * digest, and a check that tolerated any change to any table would also
 * tolerate a dropped conversation.
 */
const EXPECTED_TO_CHANGE = {
  schema_migrations: 'migracja dopisuje swoj wpis',
  agent_runs: 'platform-0002 dodaje kolumne enqueued_at i wypelnia ja z started_at',
  messages: 'odtworzenie aktywnosci narzedzi zastepuje pojedyncza wiadomosc asystenta pelna tura',
};

function compare(before, after) {
  const problems = [];
  const notes = [];

  if (after.integrity !== 'ok') problems.push(`integrity_check po migracji: ${after.integrity}`);

  for (const t of before.tables) {
    if (!after.tables.includes(t)) problems.push(`tabela ${t} zniknela`);
  }

  for (const t of before.tables.filter((t) => after.tables.includes(t))) {
    const changed = before.digests[t] !== after.digests[t];
    if (!changed) continue;
    if (t in EXPECTED_TO_CHANGE) {
      notes.push(
        `${t}: ${before.counts[t]} → ${after.counts[t]} wierszy (${EXPECTED_TO_CHANGE[t]})`,
      );
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
if (!existsSync(resolve(backupDir, 'manifest.json'))) {
  console.error(
    `[proba] ${backupDir} nie wyglada na kopie (brak manifest.json).\n` +
      'Wykonaj najpierw: node scripts/backup-state.mjs --data data --out backups/<nazwa>',
  );
  process.exit(2);
}
if (resolve(backupDir) === resolve(REPO, 'data')) {
  console.error('[proba] odmawiam proby na katalogu danych aplikacji. Uzyj kopii.');
  process.exit(2);
}

const work = flag('out') ? resolve(flag('out')) : mkdtempSync(resolve(tmpdir(), 'agentic-rehearsal-'));
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
const after = census(dbFile);
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

const report = {
  at: new Date().toISOString(),
  backup: backupDir,
  workdir: work,
  migrationsBefore: before.migrations,
  migrationsAfter: after.migrations,
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
  problems: [...problems, ...idempotency],
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

if (report.problems.length) {
  console.error(`[proba] PROBA NIEUDANA (${report.problems.length}):`);
  for (const p of report.problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('[proba] wynik: migracja i odtworzenie aktywnosci narzedzi zachowaly caly stan');
