import type { ModuleMigration } from '@platform/contracts';
import type { Db } from './client.ts';

/**
 * Platform-owned schema. Module tables live in the same physical database but
 * are created from the module's own migration list and are never referenced by
 * platform code — the only coupling is the opaque `scope_kind` / `scope_id`
 * pair, which the platform stores and compares but never interprets.
 */
export const PLATFORM_MIGRATIONS: ModuleMigration[] = [
  {
    id: 'platform-0001-init',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS canvas_spaces (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        scope_kind  TEXT,
        scope_id    TEXT,
        viewport    TEXT NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spaces_owner ON canvas_spaces(owner_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_spaces_scope
        ON canvas_spaces(owner_id, scope_kind, scope_id)
        WHERE scope_kind IS NOT NULL;

      CREATE TABLE IF NOT EXISTS canvas_cards (
        id               TEXT PRIMARY KEY,
        space_id         TEXT NOT NULL REFERENCES canvas_spaces(id) ON DELETE CASCADE,
        title            TEXT NOT NULL,
        spec             TEXT NOT NULL,
        geometry         TEXT NOT NULL,
        spec_version     INTEGER NOT NULL DEFAULT 1,
        geometry_version INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cards_space ON canvas_cards(space_id);

      CREATE TABLE IF NOT EXISTS conversations (
        id                TEXT PRIMARY KEY,
        owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title             TEXT NOT NULL,
        space_id          TEXT REFERENCES canvas_spaces(id) ON DELETE SET NULL,
        claude_session_id TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        meta            TEXT,
        seq             INTEGER NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);
      -- Guards against a reconnect replaying the same message into the thread.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id ON messages(conversation_id, id);

      CREATE TABLE IF NOT EXISTS agent_runs (
        id                TEXT PRIMARY KEY,
        conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        owner_id          TEXT NOT NULL,
        status            TEXT NOT NULL,
        claude_session_id TEXT,
        prompt            TEXT NOT NULL,
        app_context       TEXT NOT NULL,
        started_at        TEXT NOT NULL,
        finished_at       TEXT,
        error_code        TEXT,
        error_message     TEXT,
        first_token_ms    INTEGER,
        duration_ms       INTEGER,
        workspace_dir     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_conv ON agent_runs(conversation_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS run_events (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id    TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        seq       INTEGER NOT NULL,
        name      TEXT NOT NULL,
        payload   TEXT NOT NULL,
        at        TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_seq ON run_events(run_id, seq);

      CREATE TABLE IF NOT EXISTS files (
        id         TEXT PRIMARY KEY,
        owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        filename   TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_size  INTEGER NOT NULL,
        sha256     TEXT NOT NULL,
        rel_path   TEXT NOT NULL,
        scope_kind TEXT,
        scope_id   TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_files_scope ON files(scope_kind, scope_id);

      CREATE TABLE IF NOT EXISTS artifacts (
        id              TEXT PRIMARY KEY,
        owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        kind            TEXT NOT NULL,
        mode            TEXT NOT NULL,
        title           TEXT NOT NULL,
        renderer_type   TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts(owner_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS artifact_versions (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        version     INTEGER NOT NULL,
        content     TEXT NOT NULL,
        file_id     TEXT REFERENCES files(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (artifact_id, version)
      );

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        operation_id TEXT NOT NULL,
        owner_id     TEXT NOT NULL,
        scope        TEXT NOT NULL,
        result       TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (operation_id, owner_id, scope)
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    /*
     * Splits "the run was accepted" from "the run started executing".
     *
     * `started_at` used to be written when the row was created, which is when
     * the request was *queued*. Any run that waited behind another therefore
     * reported a duration that included the wait, and the queueing behaviour
     * could only be inferred by reconstructing windows backwards from the
     * finish time. `enqueued_at` now carries the old meaning and `started_at`
     * carries the new one.
     *
     * Existing rows are backfilled so that `enqueued_at = started_at`: for rows
     * written under the old code that value genuinely was the enqueue time. The
     * execution start of those historical runs is not recoverable and is left
     * equal to it, which is exact for every run that never waited.
     */
    id: 'platform-0002-run-measurement-points',
    sql: /* sql */ `
      ALTER TABLE agent_runs ADD COLUMN enqueued_at TEXT;
      UPDATE agent_runs SET enqueued_at = started_at WHERE enqueued_at IS NULL;
    `,
  },
  {
    /**
     * File lineage.
     *
     * A run that edits an attached spreadsheet must not overwrite it: the
     * original is the user's, and "the agent changed my file" has to remain
     * inspectable and reversible. A modified file is therefore a *new* row that
     * points at the one it came from, so both exist and the chain is readable.
     *
     * Existing rows are version 1 with no parent, which is exactly what they
     * are — nothing is guessed.
     */
    id: 'platform-0003-file-versions',
    sql: /* sql */ `
      ALTER TABLE files ADD COLUMN derived_from_file_id TEXT;
      ALTER TABLE files ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS idx_files_derived ON files(derived_from_file_id);
    `,
  },
  {
    /**
     * Closes the diagnostic chain in both directions.
     *
     * Conversation → run → tool call → mutation → artifact was walkable forwards
     * only: `run_events` carries a `platform.artifact_created` event, so the
     * answer to "what did this run produce" needed a scan of every run's event
     * log, and the answer to "which run produced this artifact" was not stored
     * at all — `conversation_id` names a conversation that may hold dozens of
     * runs.
     *
     * Existing rows keep `NULL`, which is exact: for an artifact written before
     * this column existed the producing run is not recoverable, and guessing the
     * conversation's latest run would invent a link.
     */
    id: 'platform-0004-artifact-run-link',
    sql: /* sql */ `
      ALTER TABLE artifacts ADD COLUMN run_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
    `,
  },
  {
    /**
     * The idempotency key becomes a reservation, not a receipt.
     *
     * The row used to be written *after* the operation, and carried nothing but
     * its result. Two things were therefore impossible to state: that an
     * operation is running right now (so a concurrent retry has something to
     * join instead of a second execution), and that the key was used for a
     * different request (so a reuse is a conflict rather than someone else's
     * answer). `status` and `fingerprint` say both.
     *
     * Existing rows are `done` with no fingerprint, which is exactly what they
     * are: completed operations whose request body was never recorded. They
     * keep replaying as before, and nothing about them is guessed.
     */
    id: 'platform-0005-idempotency-reservation',
    sql: /* sql */ `
      ALTER TABLE idempotency_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
      ALTER TABLE idempotency_keys ADD COLUMN fingerprint TEXT;
    `,
  },
  {
    /**
     * Which command a file was attached to.
     *
     * The link existed only for the duration of the run: `attachFileIds` arrived
     * with the request, the files were copied into the workspace, and nothing
     * was written down. Afterwards — a reload later, or in the files screen —
     * there was no way to say which message a file had been sent with, which is
     * half of "an attachment is tied to the answer".
     *
     * A table rather than a field in `messages.meta`, because the question is
     * asked from both ends: the conversation wants its message's attachments and
     * the files screen wants a file's commands. The run is recorded too, so the
     * chain conversation → message → file → run stays walkable.
     *
     * Rows are written when the file is actually staged into the workspace, so
     * the record describes what the run received, not what the request asked
     * for. Deleting a conversation or a file takes its links with it.
     */
    id: 'platform-0006-message-attachments',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS message_attachments (
        message_id      TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        file_id         TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        run_id          TEXT,
        owner_id        TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (message_id, file_id)
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_file ON message_attachments(file_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_conv ON message_attachments(conversation_id);
    `,
  },
  {
    /**
     * Task input (L11.6): what a run received to start with.
     *
     * `attachFileIds` and `userMessageId` already reached the runtime — but
     * only as workspace staging and an attachment link. The run row itself did
     * not remember its input list, so the task center could not show a
     * command's files without reconstructing them from circumstances. The
     * columns are nullable: rows from before this migration have nothing to
     * put in them, and the center shows "no files" for those, not an invented
     * list.
     *
     * `user_message_id` completes the task-to-conversation link (the event in
     * the source thread); L11.19 is its main consumer.
     */
    id: 'platform-0007-run-task-inputs',
    sql: /* sql */ `
      ALTER TABLE agent_runs ADD COLUMN input_file_ids TEXT;
      ALTER TABLE agent_runs ADD COLUMN user_message_id TEXT;
    `,
  },
];

/** Applies every not-yet-applied migration inside one transaction each. */
export function runMigrations(db: Db, migrations: ModuleMigration[]): string[] {
  const sqlite = db.$client;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    sqlite
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((r) => (r as { id: string }).id),
  );
  const done: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    const tx = sqlite.transaction(() => {
      sqlite.exec(m.sql);
      sqlite
        .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
        .run(m.id, new Date().toISOString());
    });
    tx();
    done.push(m.id);
  }
  return done;
}
