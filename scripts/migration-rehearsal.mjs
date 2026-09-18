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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  REPO,
  assertAwayFromLiveData,
  census,
  fingerprint,
  makeArgs,
  prepareScratchDir,
  realResolve,
  refuse,
  runScript,
} from './lib/state-tools.mjs';


/* ------------------------------- the census ------------------------------- */

/**
 * Every flag of this script that takes a path, and what it does with it.
 *
 * This is not documentation of the flags — it is where they come from.
 * `makeArgs(process.argv, FLAGS)` refuses any flag that is not in this list, so
 * an undeclared flag cannot be passed at all, whatever the code that would read
 * it looks like. `tests/script-path-flags.test.ts` then runs this script once
 * per declared flag and requires the behaviour its kind claims, plus one rule
 * that holds whatever the kind says: the directory a flag is pointed at must
 * come out byte-for-byte unchanged, unless the flag is `zapis-docelowy`.
 *
 * It exists because this package shipped the same defect three times: a guard
 * that watched the wrong argument. Every time the code looked careful, and every
 * time it was a person or a recorded run — never a test — that noticed.
 *
 *   zapis-chroniony  — writes; must refuse a live data directory
 *   odczyt-chroniony — only reads, but still refuses one (here: because the
 *                      rehearsal would boot the application against it)
 *   zapis-docelowy   — writes *into* a data directory on purpose
 *   odczyt           — only reads; a live data directory is allowed, and `why`
 *                      has to say why that is safe
 *   wartosc          — not a path at all
 */
export const FLAGS = {
  backup: {
    kind: 'odczyt-chroniony',
    why: 'Kopia, z ktorej bierze sie proba: czytana i kopiowana gdzie indziej, a na koniec skrypt '
      + 'sprawdza sumy SHA-256 wszystkich jej plikow, zeby pokazac, ze jej nie tknal. Mimo to '
      + 'przechodzi przez ochrone — proba na zywym katalogu nie bylaby proba, tylko migracja '
      + 'wykonana na danych uzytkownika pod nazwa, ktora mowi co innego.',
  },
  out: {
    kind: 'zapis-chroniony',
    why: 'Katalog roboczy jest KASOWANY przed wypelnieniem, a potem startuje na nim aplikacja.',
  },
  json: {
    kind: 'zapis-chroniony',
    why: 'Raport nadpisuje wskazany plik i tworzy katalogi po drodze. Do 2026-09-18 nic nie pytalo, '
      + 'gdzie ten plik laduje — --json <katalog danych>/app.db niszczylo baze.',
  },
};


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

function main() {
  /*
   * Inside `main`, so that a refusal over an unknown flag is reported the way
   * every other refusal is (exit 2) instead of escaping module evaluation as an
   * uncaught error.
   */
  const { flag } = makeArgs(process.argv, FLAGS);

  const backupDir = realResolve(flag('backup', resolve(REPO, 'backups/data-2026-09-15')));

  /*
   * The refusals, before anything is read — because this script *boots the
   * application* against what it is given: migrations are applied, a session
   * secret is written, the backfill runs, and the working directory is deleted
   * first. Pointed at a live directory it would not be a rehearsal at all; it
   * would be the migration, performed on the user's data, under a name that says
   * otherwise.
   *
   * `assertAwayFromLiveData` is shared with the other state scripts and compares
   * by containment in both directions, through symlinks, plus `session.secret`
   * anywhere at or above the path. The comparison here used to be equality
   * against two known paths, which meant `--backup <dane>/files` and
   * `--out <dane>/files` both passed — the second one deleting the directory
   * before any refusal could fire.
   */
  assertAwayFromLiveData(backupDir, { what: 'Kopia zrodlowa' });

  if (!existsSync(resolve(backupDir, 'manifest.json'))) {
    refuse(
      `${backupDir} nie wyglada na kopie (brak manifest.json).\n` +
        'Wykonaj najpierw: node scripts/backup-state.mjs --data <dane> --out backups/<nazwa>',
    );
  }

  /*
   * The report file is a *write*, and until this check nothing asked where it
   * would land. It creates directories and overwrites whatever file it names,
   * so `--json <katalog danych>/app.db` would have destroyed a database from a
   * flag nobody thinks of as dangerous. Checked here, with the other arguments,
   * rather than at the moment of writing: an argument that will be refused
   * should be refused before the work starts, not after.
   */
  if (flag('json')) assertAwayFromLiveData(resolve(flag('json')), { what: 'Plik raportu' });

  const backupBefore = fingerprint(backupDir);

  /*
   * The working directory is emptied before it is filled, so it goes through the
   * guard that refuses to delete a directory these scripts did not create.
   */
  const work = prepareScratchDir(
    flag('out') ? flag('out') : mkdtempSync(resolve(tmpdir(), 'agentic-rehearsal-')),
    { what: 'Katalog proby' },
  );
  cpSync(backupDir, work, { recursive: true });
  rmSync(resolve(work, 'manifest.json'), { force: true });

  const dbFile = resolve(work, 'app.db');
  const before = census(dbFile, { identity: true });

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
  const after = census(dbFile, { restrict: before.columns, identity: true });
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
  const again = census(dbFile, { identity: true });
  const idempotency = compareIdempotent(after, again);

  /*
   * The throw-away installation secret that booting wrote into the working
   * copy. It is meaningless here — it signs cookies for an installation that
   * exists for a few seconds — and leaving it behind makes a scratch directory
   * look like a data directory to the very guards that protect data
   * directories. Removed as soon as the last boot is done.
   */
  rmSync(resolve(work, 'session.secret'), { force: true });

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
}

/*
 * Exit codes are a contract here, because this script is called from tests and
 * from other scripts: 0 nothing to report, 1 the rehearsal found problems,
 * 2 refused, 4 crashed. Before this wrapper, a crash also exited 1 and was
 * indistinguishable from "the migration would lose data" — the one verdict
 * nobody may misread.
 */
if (process.argv[1] && realResolve(process.argv[1]) === realResolve(fileURLToPath(import.meta.url))) {
  runScript('proba', main);
}
