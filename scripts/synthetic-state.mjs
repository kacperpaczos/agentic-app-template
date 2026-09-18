#!/usr/bin/env node
/**
 * Builds a **synthetic** application data directory, at a chosen point in the
 * migration history.
 *
 *   node scripts/synthetic-state.mjs --out .e2e-bl07/dane --stage platform-0003-file-versions
 *   node scripts/synthetic-state.mjs --out DIR --stage current   # fully migrated
 *   node scripts/synthetic-state.mjs --out DIR --stage empty     # nothing applied yet
 *   node scripts/synthetic-state.mjs --list                      # the available stages
 *
 * `--stage <id>` means **the state just before that migration ran**: every
 * migration before it is applied and it is not, which is the only shape in
 * which "this migration keeps existing data" can be rehearsed.
 *
 * **Why the template needs this at all.** A backup, a migration rehearsal and a
 * restore can only be *proved* against a database that already holds data. The
 * template ships with none, and the one database that must never be used for a
 * rehearsal is the user's own — so the data has to be made. Everything written
 * here is invented: two people who do not exist, a conversation about nothing,
 * two files of a few dozen bytes.
 *
 * `--stage` also has a second use, in the regression: a copy taken at each
 * stage is what lets every platform migration be rehearsed on data that
 * predates it, instead of only the newest one being covered by accident.
 *
 * The rows deliberately use only the columns that existed at the requested
 * stage — that is what makes the fixture a genuinely old database rather than a
 * current one with a truncated migration log.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Database,
  REPO,
  makeArgs,
  prepareScratchDir,
  refuse,
  runScript,
} from './lib/state-tools.mjs';

const { args, flag, has } = makeArgs(process.argv);

/*
 * Ids and values the platform itself owns. Kept in one place because the
 * fixture has to agree with what boot does: `createPlatform` inserts these two
 * users if they are missing, so a fixture without them would show `users` as an
 * unexpectedly changed table in every rehearsal.
 */
const USERS = [
  ['local-user', 'Uzytkownik lokalny'],
  ['other-user', 'Inny uzytkownik'],
];

/**
 * Every flag of this script that takes a path, and what it does with it.
 *
 * Declared here, next to the code, and checked by `tests/script-path-flags.test.ts`:
 * that test reads the flags this script actually uses out of its source, compares
 * them with this list, and then **runs** the script once per writing flag to see
 * the refusal for itself. A flag added without an entry here fails the test; an
 * entry that claims protection the code does not have fails it too.
 *
 * It exists because this package shipped the same defect twice: a guard that
 * watched the wrong argument. Both times the flag was `--out`, both times the
 * code looked careful, and both times it was someone reading it — not a test —
 * who noticed.
 *
 *   zapis-chroniony  — writes; must refuse a live data directory
 *   odczyt-chroniony — only reads, but still refuses one
 *   zapis-docelowy   — writes *into* a data directory on purpose
 *   odczyt           — only reads; a live data directory is allowed, and `why`
 *                      has to say why that is safe
 *   wartosc          — not a path at all
 */
export const FLAGS = {
  out: {
    kind: 'zapis-chroniony',
    why: 'Katalog jest KASOWANY, a potem wypelniany danymi syntetycznymi.',
  },
  stage: {
    kind: 'wartosc',
    why: 'Nazwa etapu migracji (identyfikator z --list), a nie sciezka — nic nie otwiera i niczego '
      + 'nie zapisuje, wiec nie ma tu czego chronic.',
  },
};

/**
 * The migration lists, read from the composition root.
 *
 * Both halves matter: the platform's own migrations and those of whichever
 * modules are composed in. Read through a child process because they live in
 * TypeScript modules, and read from `composeApp` rather than from a named
 * module so that swapping the business module needs no edit here.
 */
function migrationLists() {
  const probe = mkdtempSync(resolve(tmpdir(), 'agentic-lista-migracji-'));
  const script = `
    import { rmSync } from 'node:fs';
    import { composeApp } from ${JSON.stringify(resolve(REPO, 'apps/server/src/compose.ts'))};
    import { PLATFORM_MIGRATIONS } from ${JSON.stringify(resolve(REPO, 'packages/platform-server/src/db/migrations.ts'))};
    const p = composeApp({ dataDir: ${JSON.stringify(probe)} });
    const moduleIds = p.registry.migrations().map((m) => m.id);
    p.close();
    rmSync(${JSON.stringify(probe)}, { recursive: true, force: true });
    console.log('LISTS ' + JSON.stringify({ platform: PLATFORM_MIGRATIONS.map((m) => m.id), module: moduleIds }));
  `;
  try {
    const out = execFileSync(
      process.execPath,
      ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--input-type=module', '-e', script],
      { cwd: REPO, env: { ...process.env, APP_DATA_DIR: probe }, stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const line = out.split('\n').find((l) => l.startsWith('LISTS '));
    if (!line) throw new Error(`nie udalo sie odczytac listy migracji:\n${out}`);
    return JSON.parse(line.slice('LISTS '.length));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

/**
 * Applies a prefix of the migration history to a fresh database.
 *
 * Uses the application's own `runMigrations` with the application's own
 * migration objects — not a copy of the SQL — so a fixture "before
 * platform-0003" is the schema that migration will actually meet.
 */
function applyUpTo(dbFile, stage, lists) {
  const cut = stage === 'current' ? lists.platform.length : lists.platform.indexOf(stage);
  if (stage !== 'current' && stage !== 'empty' && cut < 0) {
    throw new Error(
      `nieznany etap: ${stage}. Dostepne: empty, ${lists.platform.join(', ')}, current`,
    );
  }
  if (stage === 'empty') {
    // An empty file in WAL mode: a database that exists and knows nothing.
    const db = new Database(dbFile);
    db.pragma('journal_mode = WAL');
    db.close();
    return [];
  }
  const platformPrefix = lists.platform.slice(0, cut);
  // Unique per call: a fixed path meant two concurrent runs (the regression
  // runs several) shared one directory and raced on deleting it.
  const modulesProbe = mkdtempSync(resolve(tmpdir(), 'agentic-sonda-modulow-'));
  const script = `
    import { createRequire } from 'node:module';
    import { PLATFORM_MIGRATIONS, runMigrations } from ${JSON.stringify(resolve(REPO, 'packages/platform-server/src/db/migrations.ts'))};
    import { composeApp } from ${JSON.stringify(resolve(REPO, 'apps/server/src/compose.ts'))};
    const Database = createRequire(${JSON.stringify(resolve(REPO, 'packages/platform-server/package.json'))})('better-sqlite3');
    const wanted = new Set(${JSON.stringify(platformPrefix)});
    const db = new Database(${JSON.stringify(dbFile)});
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    /*
     * The module's migrations are applied in full alongside the platform prefix:
     * a database from the era of an older platform migration still carried the
     * module schema of its day, and a fixture without it would not be an old
     * database but an impossible one.
     */
    const probeDir = ${JSON.stringify(modulesProbe)};
    const probe = composeApp({ dataDir: probeDir });
    const moduleMigrations = probe.registry.migrations();
    probe.close();
    /*
     * Module migrations only once the platform has been initialised: boot runs
     * them after the platform's own, so a database holding a module's tables
     * but not schema_migrations is a state that never existed. The stage
     * before the very first platform migration is simply an empty database.
     */
    const platform = PLATFORM_MIGRATIONS.filter((m) => wanted.has(m.id));
    const applied = runMigrations({ $client: db }, [
      ...platform,
      ...(platform.length > 0 ? moduleMigrations : []),
    ]);
    db.close();
    console.log('APPLIED ' + JSON.stringify(applied));
  `;
  let out;
  try {
    out = execFileSync(
      process.execPath,
      ['--experimental-transform-types', '--no-warnings=ExperimentalWarning', '--input-type=module', '-e', script],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
  } finally {
    rmSync(modulesProbe, { recursive: true, force: true });
  }
  const line = out.split('\n').find((l) => l.startsWith('APPLIED '));
  if (!line) throw new Error(`nie udalo sie zastosowac migracji:\n${out}`);
  return JSON.parse(line.slice('APPLIED '.length));
}

/** Synthetic rows, written with the columns that exist at this stage. */
function populate(dataDir, applied) {
  const db = new Database(resolve(dataDir, 'app.db'));
  db.pragma('foreign_keys = ON');
  const has = (table, column) =>
    db.prepare(`PRAGMA table_info("${table}")`).all().some((c) => c.name === column);
  const tables = new Set(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r) => r.name),
  );
  if (!tables.has('conversations')) {
    db.close();
    return { note: 'schemat platformy jeszcze nie istnieje — katalog zawiera pusta baze' };
  }

  const ts = '2026-09-01T10:00:00.000Z';
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  for (const [id, name] of USERS) {
    run('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)', id, name, ts);
  }

  run(
    `INSERT INTO canvas_spaces (id, owner_id, title, scope_kind, scope_id, viewport, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    'sp_syn_1', 'local-user', 'Przestrzen testowa', 'sprawa', 'sprawa_1',
    '{"x":0,"y":0,"zoom":1}', ts, ts,
  );
  run(
    `INSERT INTO canvas_cards (id, space_id, title, spec, geometry, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'card_syn_1', 'sp_syn_1', 'Karta testowa',
    JSON.stringify({ kind: 'component', component: 'platform.markdown', props: { text: 'tresc syntetyczna' } }),
    JSON.stringify({ x: 10, y: 20, width: 400, height: 300 }), ts, ts,
  );

  const convId = 'cnv_syn_1';
  const runId = 'run_syn_1';
  run(
    `INSERT INTO conversations (id, owner_id, title, space_id, claude_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    convId, 'local-user', 'Rozmowa syntetyczna', 'sp_syn_1', 'sess_syntetyczna', ts, ts,
  );

  const msg = (id, role, content, meta, seq) =>
    run(
      `INSERT INTO messages (id, conversation_id, role, content, meta, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, convId, role, content, meta, seq, ts,
    );
  msg('msg_syn_user_1', 'user', 'Policz to, o co prosilem.', null, 1);
  /*
   * The pre-projection shape: one assistant message holding the answer and no
   * trace of the tool that produced it. This is what the boot-time backfill has
   * to rebuild from `run_events`, and the reason `messages` is a table the
   * rehearsal expects to change.
   */
  msg(`am_${runId}`, 'assistant', 'Policzone: 1234 PLN.', JSON.stringify({ runId }), 2);
  msg('msg_syn_user_2', 'user', 'Dziekuje.', null, 3);

  const runColumns = ['id', 'conversation_id', 'owner_id', 'status', 'claude_session_id', 'prompt',
    'app_context', 'started_at', 'finished_at', 'first_token_ms', 'duration_ms'];
  const runValues = [runId, convId, 'local-user', 'succeeded', 'sess_syntetyczna',
    'Policz to, o co prosilem.', '{}', ts, ts, 120, 3400];
  // Only if this stage already has the column: writing it earlier would make the
  // fixture newer than the stage it claims to be.
  if (has('agent_runs', 'enqueued_at')) {
    runColumns.push('enqueued_at');
    runValues.push(ts);
  }
  run(
    `INSERT INTO agent_runs (${runColumns.join(', ')}) VALUES (${runColumns.map(() => '?').join(', ')})`,
    ...runValues,
  );

  const events = [
    ['RUN_STARTED', { type: 'RUN_STARTED', runId }],
    ['TOOL_CALL_START', { type: 'TOOL_CALL_START', toolCallId: 'tu_1', toolCallName: 'mcp__app__platform_canvas_add_card' }],
    ['TOOL_CALL_ARGS', { type: 'TOOL_CALL_ARGS', toolCallId: 'tu_1', delta: '{"title":"Karta testowa"}' }],
    ['TOOL_CALL_END', { type: 'TOOL_CALL_END', toolCallId: 'tu_1' }],
    ['TOOL_CALL_RESULT', { type: 'TOOL_CALL_RESULT', toolCallId: 'tu_1', messageId: 'tm_1', content: '{"total":1234}' }],
    ['TEXT_MESSAGE_START', { type: 'TEXT_MESSAGE_START', messageId: 'am_1' }],
    ['TEXT_MESSAGE_CONTENT', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'am_1', delta: 'Policzone: ' }],
    ['TEXT_MESSAGE_CONTENT', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'am_1', delta: '1234 PLN.' }],
    ['TEXT_MESSAGE_END', { type: 'TEXT_MESSAGE_END', messageId: 'am_1' }],
    ['RUN_FINISHED', { type: 'RUN_FINISHED', runId }],
  ];
  events.forEach(([name, payload], i) =>
    run('INSERT INTO run_events (run_id, seq, name, payload, at) VALUES (?, ?, ?, ?, ?)',
      runId, i + 1, name, JSON.stringify(payload), ts),
  );

  /*
   * Files, with their bytes on disk. Non-empty on purpose: `files` is the table
   * `platform-0003-file-versions` widens, and a fixture with an empty one would
   * let that migration be "rehearsed" without the rehearsal ever meeting the
   * case it changes.
   */
  mkdirSync(resolve(dataDir, 'files', 'local-user'), { recursive: true });
  const fileRows = [
    ['file_syn_1', 'oferta.csv', 'text/csv', 'dostawca;cena\nAlfa;1234\n'],
    ['file_syn_2', 'notatka.txt', 'text/plain', 'notatka syntetyczna\n'],
  ];
  for (const [id, filename, mediaType, content] of fileRows) {
    const rel = `local-user/${id}-${filename}`;
    writeFileSync(resolve(dataDir, 'files', rel), content);
    run(
      `INSERT INTO files (id, owner_id, filename, media_type, byte_size, sha256, rel_path, scope_kind, scope_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, 'local-user', filename, mediaType, Buffer.byteLength(content),
      createHash('sha256').update(content).digest('hex'), rel, 'sprawa', 'sprawa_1', ts,
    );
  }

  run(
    `INSERT INTO artifacts (id, owner_id, conversation_id, kind, mode, title, renderer_type, current_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'art_syn_1', 'local-user', convId, 'document', 'snapshot', 'Zestawienie', 'markdown', 1, ts, ts,
  );
  run(
    `INSERT INTO artifact_versions (artifact_id, version, content, file_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    'art_syn_1', 1, '# Zestawienie\n\nAlfa: 1234 PLN\n', 'file_syn_1', ts,
  );

  const counts = {};
  for (const t of ['users', 'conversations', 'messages', 'agent_runs', 'run_events', 'canvas_cards', 'files', 'artifacts']) {
    counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
  }
  db.close();
  return { counts, migrations: applied };
}

/**
 * Leaves a committed write in the write-ahead log and nowhere else.
 *
 * This reproduces the state that makes a naive `cp data/app.db` a data-losing
 * backup: the transaction is committed and durable, but it lives in
 * `app.db-wal` until a checkpoint folds it in — and a clean `close()` performs
 * that checkpoint, which is why the row is written by a child process that is
 * then killed outright. An unclean stop is not an exotic case; it is what
 * happens every time the machine or the process dies, and it is the exact
 * situation `docs/odzyskiwanie-stanu.md` records from a real directory.
 *
 * Returns the id written, so a test can ask the backup for it by name.
 */
function leaveRowInWal(dataDir) {
  const dbFile = resolve(dataDir, 'app.db');
  const id = 'cnv_syn_tylko_w_wal';
  const script = `
    const { createRequire } = require('node:module');
    const Database = createRequire(${JSON.stringify(resolve(REPO, 'packages/platform-server/package.json'))})('better-sqlite3');
    const db = new Database(${JSON.stringify(dbFile)});
    db.pragma('journal_mode = WAL');
    const ts = new Date().toISOString();
    db.prepare('INSERT INTO conversations (id, owner_id, title, space_id, claude_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(${JSON.stringify(id)}, 'local-user', 'Rozmowa zapisana tuz przed awaria', null, null, ts, ts);
    db.prepare('INSERT INTO messages (id, conversation_id, role, content, meta, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('msg_syn_wal', ${JSON.stringify(id)}, 'user', 'Ta wiadomosc istnieje wylacznie w WAL.', null, 1, ts);
    // No close(): a clean close would checkpoint the log into app.db and the
    // whole point of the fixture would disappear.
    process.kill(process.pid, 'SIGKILL');
  `;
  try {
    execFileSync(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // Killed by signal, as intended. Anything else is a real failure.
    if (e.signal !== 'SIGKILL') throw e;
  }
  if (!existsSync(`${dbFile}-wal`)) {
    throw new Error('nie udalo sie zostawic zapisu w WAL — fikstura nie pokazalaby roznicy');
  }
  return id;
}

/* --------------------------------- main ---------------------------------- */

function main() {
  const lists = migrationLists();
  if (has('list')) {
    console.log(`[syntetyk] etapy: empty, ${lists.platform.join(', ')}, current`);
    console.log(`[syntetyk] migracje modulow: ${lists.module.join(', ') || '(brak)'}`);
    return;
  }

  const stage = flag('stage', 'current');
  if (!flag('out')) refuse('podaj --out <katalog>');

  /*
   * The generator *deletes* what it is pointed at. A fixture builder that can
   * wipe the user's state is not a safety feature with a bug in it; it is the
   * accident — so the target goes through the shared guard, which refuses a
   * path at, inside, above or symlinked to a data directory, and refuses to
   * delete any non-empty directory these scripts did not create.
   *
   * The checks this replaced compared the path for equality with two known
   * directories and looked for `session.secret` only at the top level:
   * `--out <dane>/files` passed both and deleted the user's files.
   */
  const outDir = prepareScratchDir(flag('out'), { what: 'Katalog danych syntetycznych' });
  mkdirSync(resolve(outDir, 'workspaces'), { recursive: true });
  const applied = applyUpTo(resolve(outDir, 'app.db'), stage, lists);
  const result = populate(outDir, applied);

  let walRow = null;
  if (has('leave-wal') && result.counts) {
    walRow = leaveRowInWal(outDir);
  }

  console.log(`[syntetyk] katalog: ${outDir}`);
  console.log(`[syntetyk] etap:    ${stage} (zastosowane: ${applied.join(', ') || '(zadne)'})`);
  if (walRow) {
    console.log(
      `[syntetyk] WAL:      zatwierdzona rozmowa ${walRow} lezy wylacznie w app.db-wal ` +
        '(proces zabity bez punktu kontrolnego)',
    );
  }
  if (result.counts) {
    console.log(
      `[syntetyk] wiersze:  ${Object.entries(result.counts).map(([t, n]) => `${t}=${n}`).join(' ')}`,
    );
  } else {
    console.log(`[syntetyk] ${result.note}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runScript('syntetyk', main);
}
