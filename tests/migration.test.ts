import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  createPlatform,
  DEFAULT_USER_ID,
  PLATFORM_MIGRATIONS,
  runMigrations,
} from '@platform/server';
import { createProcurementModule } from '@module/procurement/server';

/*
 * `better-sqlite3` belongs to `@platform/server`, not to the repository root, so
 * it is resolved from the package that owns it — and typed structurally here
 * rather than with `typeof import('better-sqlite3')`, which the root tsconfig
 * cannot resolve. Only the handful of members these tests use are declared.
 */
interface SqliteStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
}
interface SqliteDatabase {
  prepare: (sql: string) => SqliteStatement;
  pragma: (source: string, options?: { simple?: boolean }) => unknown;
  close: () => void;
}
type SqliteConstructor = new (file: string, options?: { readonly?: boolean }) => SqliteDatabase;

const Database = createRequire(
  resolve(import.meta.dirname, '../packages/platform-server/package.json'),
)('better-sqlite3') as SqliteConstructor;

/**
 * Starting the new build over an existing database keeps everything in it, and
 * starting it twice keeps it once.
 *
 * `scripts/migration-rehearsal.mjs` establishes this against a copy of the real
 * `data/` directory, which is the evidence that matters for *this* machine. This
 * test establishes the same properties on a database it builds itself, which is
 * the evidence that keeps holding as the code changes: it runs on every
 * `pnpm test`, needs no backup to exist, and fails on a future migration that
 * drops a column or a backfill that stops being idempotent.
 *
 * The fixture is a genuinely *old* database: only the first platform migration
 * applied, and one finished run recorded the way the old code recorded it — a
 * single `am_<runId>` assistant message holding the answer text, with the run's
 * AG-UI events beside it and no tool messages at all. That is the shape the
 * backfill has to rebuild, and the only shape in which it can be proved to.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Row counts plus a content digest per table — shape *and* contents. */
function census(dbFile: string) {
  const db = new Database(dbFile, { readonly: true });
  try {
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    const counts: Record<string, number> = {};
    const digests: Record<string, string> = {};
    for (const t of tables) {
      counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
      const rows = db.prepare(`SELECT * FROM "${t}"`).all() as Array<Record<string, unknown>>;
      digests[t] = createHash('sha256')
        .update(
          rows
            .map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]])))
            .sort()
            .join('\n'),
        )
        .digest('hex');
    }
    return { tables, counts, digests };
  } finally {
    db.close();
  }
}

const query = <T>(dbFile: string, sql: string, ...params: unknown[]): T[] => {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
};

/**
 * A database as the previous build left it.
 *
 * Only `platform-0001-init` is applied — `agent_runs` therefore has no
 * `enqueued_at` — and the finished run holds one assistant message with no tool
 * activity, exactly as the code wrote it before the projection existed.
 */
function makeLegacyDatabase(): { dataDir: string; dbFile: string; runId: string; convId: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'agentic-legacy-'));
  dirs.push(dataDir);
  const dbFile = join(dataDir, 'app.db');

  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const first = PLATFORM_MIGRATIONS.find((m) => m.id === 'platform-0001-init')!;
  runMigrations({ $client: db } as never, [first]);

  const ts = '2026-09-01T10:00:00.000Z';
  const convId = 'cnv_legacy_1';
  const runId = 'run_legacy_1';

  db.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run(
    DEFAULT_USER_ID,
    'Uzytkownik lokalny',
    ts,
  );
  db.prepare(
    `INSERT INTO canvas_spaces (id, owner_id, title, scope_kind, scope_id, viewport, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('sp_legacy', DEFAULT_USER_ID, 'Stara przestrzen', 'case', 'case_1', '{"x":0,"y":0,"zoom":1}', ts, ts);
  db.prepare(
    `INSERT INTO canvas_cards (id, space_id, title, spec, geometry, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'card_legacy',
    'sp_legacy',
    'Stara karta',
    JSON.stringify({ kind: 'component', component: 'platform.markdown', props: { text: 'stare' } }),
    JSON.stringify({ x: 10, y: 20, width: 400, height: 300 }),
    ts,
    ts,
  );
  db.prepare(
    `INSERT INTO conversations (id, owner_id, title, space_id, claude_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(convId, DEFAULT_USER_ID, 'Stara rozmowa', 'sp_legacy', 'sess_legacy', ts, ts);

  const msg = db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, meta, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  msg.run('msg_user_1', convId, 'user', 'Policz koszty tej sprawy.', null, 1, ts);
  // The legacy shape: the answer, and no trace of how it was produced.
  msg.run(`am_${runId}`, convId, 'assistant', 'Policzone: 1234 PLN.', JSON.stringify({ runId }), 2, ts);
  // A later user message, so the rebuilt turn has to keep its position between
  // the two rather than being appended at the end.
  msg.run('msg_user_2', convId, 'user', 'Dziekuje.', null, 3, ts);

  db.prepare(
    `INSERT INTO agent_runs (id, conversation_id, owner_id, status, claude_session_id, prompt,
        app_context, started_at, finished_at, first_token_ms, duration_ms)
     VALUES (?, ?, ?, 'succeeded', ?, ?, '{}', ?, ?, 120, 3400)`,
  ).run(runId, convId, DEFAULT_USER_ID, 'sess_legacy', 'Policz koszty tej sprawy.', ts, ts);

  const ev = db.prepare(
    'INSERT INTO run_events (run_id, seq, name, payload, at) VALUES (?, ?, ?, ?, ?)',
  );
  const events: Array<[string, unknown]> = [
    ['RUN_STARTED', { type: 'RUN_STARTED', runId }],
    ['TOOL_CALL_START', { type: 'TOOL_CALL_START', toolCallId: 'tu_1', toolCallName: 'mcp__app__procurement_compare_offers' }],
    ['TOOL_CALL_ARGS', { type: 'TOOL_CALL_ARGS', toolCallId: 'tu_1', delta: '{"caseId":"case_1"}' }],
    ['TOOL_CALL_END', { type: 'TOOL_CALL_END', toolCallId: 'tu_1' }],
    ['TOOL_CALL_RESULT', { type: 'TOOL_CALL_RESULT', toolCallId: 'tu_1', messageId: 'tm_1', content: '{"total":1234}' }],
    ['TEXT_MESSAGE_START', { type: 'TEXT_MESSAGE_START', messageId: 'am_1' }],
    ['TEXT_MESSAGE_CONTENT', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'am_1', delta: 'Policzone: ' }],
    ['TEXT_MESSAGE_CONTENT', { type: 'TEXT_MESSAGE_CONTENT', messageId: 'am_1', delta: '1234 PLN.' }],
    ['TEXT_MESSAGE_END', { type: 'TEXT_MESSAGE_END', messageId: 'am_1' }],
    ['RUN_FINISHED', { type: 'RUN_FINISHED', runId }],
  ];
  events.forEach(([name, payload], i) => ev.run(runId, i + 1, name, JSON.stringify(payload), ts));

  db.close();
  return { dataDir, dbFile, runId, convId };
}

/** Boots the platform once, as `pnpm start` does, then closes it. */
function boot(dataDir: string): void {
  const platform = createPlatform({
    modules: (services) => [createProcurementModule(services)],
    env: { ...process.env, APP_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
  });
  platform.close();
}

describe('migracja istniejacej bazy', () => {
  it('zachowuje rozmowy, wiadomosci uzytkownika, kompozycje i dane domenowe', () => {
    const { dataDir, dbFile, convId } = makeLegacyDatabase();
    const before = census(dbFile);
    expect(before.counts.agent_runs).toBe(1);

    boot(dataDir);
    const after = census(dbFile);

    // The new migration is recorded, and applied: the column exists and is
    // filled rather than left null.
    const migrations = query<{ id: string }>(dbFile, 'SELECT id FROM schema_migrations ORDER BY id');
    expect(migrations.map((m) => m.id)).toContain('platform-0002-run-measurement-points');
    const runs = query<{ id: string; enqueued_at: string | null; started_at: string }>(
      dbFile,
      'SELECT id, enqueued_at, started_at FROM agent_runs',
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.enqueued_at).toBe(runs[0]!.started_at);

    /* --- nothing a user would notice is gone --- */

    const conv = query<Record<string, unknown>>(dbFile, 'SELECT * FROM conversations');
    expect(conv).toHaveLength(1);
    expect(conv[0]!.id).toBe(convId);
    expect(conv[0]!.title).toBe('Stara rozmowa');
    // The binding to the Claude session survives, so a follow-up still resumes it.
    expect(conv[0]!.claude_session_id).toBe('sess_legacy');

    const userMessages = query<{ id: string; content: string; seq: number }>(
      dbFile,
      `SELECT id, content, seq FROM messages WHERE role='user' ORDER BY seq`,
    );
    expect(userMessages.map((m) => m.id)).toEqual(['msg_user_1', 'msg_user_2']);
    expect(userMessages[0]!.content).toBe('Policz koszty tej sprawy.');
    expect(userMessages[1]!.content).toBe('Dziekuje.');

    const cards = query<{ id: string; spec: string }>(dbFile, 'SELECT id, spec FROM canvas_cards');
    expect(cards).toHaveLength(1);
    expect(before.digests.canvas_cards).toBe(after.digests.canvas_cards);
    expect(before.digests.canvas_spaces).toBe(after.digests.canvas_spaces);
    // The stored events are the source the rebuild reads; it must not consume
    // them.
    expect(before.digests.run_events).toBe(after.digests.run_events);

    /* --- and the turn is rebuilt, in place --- */

    const rebuilt = query<{ id: string; role: string; seq: number; content: string }>(
      dbFile,
      'SELECT id, role, seq, content FROM messages WHERE conversation_id = ? ORDER BY seq',
      convId,
    );
    expect(rebuilt[0]!.id).toBe('msg_user_1');
    // Between the two user messages, not appended after them.
    expect(rebuilt[rebuilt.length - 1]!.id).toBe('msg_user_2');
    expect(rebuilt.some((m) => m.role === 'tool')).toBe(true);
    expect(rebuilt.some((m) => m.role === 'assistant' && m.content.includes('1234 PLN'))).toBe(true);
    // The old placeholder row is gone, replaced rather than duplicated.
    expect(rebuilt.some((m) => m.id === 'am_run_legacy_1')).toBe(false);
  });

  it('powtorne uruchomienie nie dubluje danych', () => {
    const { dataDir, dbFile } = makeLegacyDatabase();
    boot(dataDir);
    const first = census(dbFile);

    boot(dataDir);
    boot(dataDir);
    const third = census(dbFile);

    // Every table, by count and by content. A backfill that re-ran its work
    // would show up here as extra `messages` rows and nowhere else.
    expect(third.counts).toEqual(first.counts);
    for (const t of first.tables) {
      expect(third.digests[t], `tabela ${t} zmieniona przy powtornym uruchomieniu`).toBe(
        first.digests[t],
      );
    }
  });

  it('uruchomienie bez zachowanych zdarzen zostawia stara wiadomosc nietknieta', () => {
    // The backfill must not invent activity it cannot evidence: a run whose
    // events were pruned keeps exactly the message it already had.
    const { dataDir, dbFile, runId, convId } = makeLegacyDatabase();
    const db = new Database(dbFile);
    db.prepare('DELETE FROM run_events WHERE run_id = ?').run(runId);
    db.close();

    boot(dataDir);

    const messages = query<{ id: string; role: string; content: string }>(
      dbFile,
      'SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY seq',
      convId,
    );
    expect(messages.map((m) => m.id)).toEqual(['msg_user_1', `am_${runId}`, 'msg_user_2']);
    expect(messages[1]!.content).toBe('Policzone: 1234 PLN.');
  });

  it('migracja na pustym katalogu tworzy kompletny schemat', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentic-fresh-'));
    dirs.push(dataDir);
    boot(dataDir);

    const tables = census(join(dataDir, 'app.db')).tables;
    for (const t of [
      'schema_migrations',
      'users',
      'canvas_spaces',
      'canvas_cards',
      'conversations',
      'messages',
      'agent_runs',
      'run_events',
      'artifacts',
      'files',
    ]) {
      expect(tables, `brak tabeli ${t}`).toContain(t);
    }
    const migrations = query<{ id: string }>(
      join(dataDir, 'app.db'),
      'SELECT id FROM schema_migrations ORDER BY id',
    ).map((m) => m.id);
    /*
     * Exhaustive on purpose: a new migration has to be added here deliberately,
     * which is what makes this test notice one that was added by accident.
     */
    expect(migrations).toEqual([
      'platform-0001-init',
      'platform-0002-run-measurement-points',
      'platform-0003-file-versions',
      'procurement-0001-init',
    ]);
  });
});
