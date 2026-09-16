import { rmSync } from 'node:fs';
import { AppError, type AgentRun, type AppContext, type RunStatus } from '@platform/contracts';
import type { Db } from '../db/client.ts';
import { newId, nowIso } from '../util/id.ts';

interface RunRow {
  id: string;
  conversation_id: string;
  owner_id: string;
  status: string;
  claude_session_id: string | null;
  prompt: string;
  app_context: string;
  enqueued_at: string | null;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  first_token_ms: number | null;
  duration_ms: number | null;
  workspace_dir: string | null;
}

const toRun = (r: RunRow): AgentRun => ({
  id: r.id,
  conversationId: r.conversation_id,
  ownerId: r.owner_id,
  status: r.status as RunStatus,
  claudeSessionId: r.claude_session_id,
  // Rows written before the split carry no `enqueued_at`; for those the two
  // instants were the same value, so reporting it twice is accurate, not a guess.
  enqueuedAt: r.enqueued_at ?? r.started_at,
  startedAt: r.started_at,
  queuedMs: r.enqueued_at
    ? Math.max(0, Date.parse(r.started_at) - Date.parse(r.enqueued_at))
    : null,
  finishedAt: r.finished_at,
  errorCode: r.error_code,
  errorMessage: r.error_message,
  firstTokenMs: r.first_token_ms,
  durationMs: r.duration_ms,
});

/**
 * Durable task registry for agent runs.
 *
 * The record outlives the HTTP connection: closing the chat panel, or losing the
 * socket, does not lose the fact that work happened. On boot, `reconcileOnBoot`
 * marks anything still `running` as `failed` with an explicit reason, so a
 * restart can tell a finished run from an interrupted one instead of pretending
 * to resume a process that no longer exists.
 */
export class RunRegistry {
  /** In-process cancel handles. Intentionally not persisted: a killed process cannot be cancelled. */
  readonly #aborts = new Map<string, AbortController>();

  constructor(private readonly db: Db) {}

  start(input: {
    conversationId: string;
    ownerId: string;
    prompt: string;
    appContext: AppContext;
    workspaceDir: string | null;
    abort: AbortController;
  }): AgentRun {
    const id = newId('run');
    const ts = nowIso();
    this.db.$client
      .prepare(
        `INSERT INTO agent_runs (id, conversation_id, owner_id, status, claude_session_id, prompt, app_context, enqueued_at, started_at, workspace_dir)
         VALUES (?, ?, ?, 'queued', NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.ownerId,
        input.prompt,
        JSON.stringify(input.appContext),
        ts,
        // Provisional: overwritten by `markExecutionStart` the moment this run
        // reaches the head of its conversation queue. Seeding it with the
        // enqueue time keeps the column non-null and keeps list ordering stable.
        ts,
        input.workspaceDir,
      );
    this.#aborts.set(id, input.abort);
    return toRun(this.#row(id));
  }

  #row(id: string): RunRow {
    const row = this.db.$client.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as
      | RunRow
      | undefined;
    if (!row) throw new AppError('not_found', `Uruchomienie ${id} nie istnieje.`);
    return row;
  }

  get(id: string, ownerId: string): AgentRun {
    const row = this.#row(id);
    if (row.owner_id !== ownerId) throw new AppError('forbidden', 'Cudze uruchomienie.');
    return toRun(row);
  }

  /**
   * Runs the owner still has in flight, across every conversation.
   *
   * This is what lets the browser re-attach after a reload: the work is the
   * backend's, not the socket's, so a client that comes back asks what is still
   * running rather than assuming anything it cannot see has stopped.
   */
  listActive(ownerId: string): AgentRun[] {
    return (
      this.db.$client
        .prepare(
          `SELECT * FROM agent_runs
            WHERE owner_id = ? AND status IN ('queued','running','awaiting_consent')
            ORDER BY enqueued_at, started_at`,
        )
        .all(ownerId) as RunRow[]
    ).map(toRun);
  }

  listForConversation(conversationId: string, ownerId: string): AgentRun[] {
    return (
      this.db.$client
        .prepare(
          'SELECT * FROM agent_runs WHERE conversation_id = ? AND owner_id = ? ORDER BY started_at DESC LIMIT 50',
        )
        .all(conversationId, ownerId) as RunRow[]
    ).map(toRun);
  }

  bindSession(id: string, sessionId: string): void {
    this.db.$client
      .prepare('UPDATE agent_runs SET claude_session_id = ? WHERE id = ?')
      .run(sessionId, id);
  }

  /**
   * Marks the transition from `queued` to `running`. Called once, when the run
   * actually starts executing — which is not when it was accepted if another
   * run for the same conversation was still in progress.
   */
  markExecutionStart(id: string): void {
    this.db.$client
      .prepare("UPDATE agent_runs SET started_at = ?, status = 'running' WHERE id = ? AND status = 'queued'")
      .run(nowIso(), id);
  }

  markFirstToken(id: string, ms: number): void {
    this.db.$client
      .prepare('UPDATE agent_runs SET first_token_ms = COALESCE(first_token_ms, ?) WHERE id = ?')
      .run(ms, id);
  }

  /** Exactly one resolving terminal status per run; later calls are ignored. */
  finish(
    id: string,
    status: Exclude<RunStatus, 'queued' | 'running'>,
    opts: { errorCode?: string; errorMessage?: string; durationMs?: number } = {},
  ): AgentRun {
    this.db.$client
      .prepare(
        `UPDATE agent_runs
            SET status = ?, finished_at = ?, error_code = ?, error_message = ?, duration_ms = ?
          WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(
        status,
        nowIso(),
        opts.errorCode ?? null,
        opts.errorMessage ?? null,
        opts.durationMs ?? null,
        id,
      );
    this.#aborts.delete(id);
    return toRun(this.#row(id));
  }

  cancel(id: string, ownerId: string): { cancelled: boolean; run: AgentRun } {
    const row = this.#row(id);
    if (row.owner_id !== ownerId) throw new AppError('forbidden', 'Cudze uruchomienie.');
    const ac = this.#aborts.get(id);
    // A run still waiting in the queue is cancellable too: the user pressed
    // stop before it ever reached the model, and it must not run afterwards.
    if (!ac || (row.status !== 'running' && row.status !== 'queued')) {
      return { cancelled: false, run: toRun(row) };
    }
    ac.abort(new Error('cancelled_by_user'));
    return { cancelled: true, run: toRun(row) };
  }

  activeCount(): number {
    return this.#aborts.size;
  }

  /** Aborts everything in flight; used by the graceful-shutdown path. */
  abortAll(reason = 'server_shutdown'): number {
    const n = this.#aborts.size;
    for (const [id, ac] of this.#aborts) {
      ac.abort(new Error(reason));
      this.finish(id, 'failed', { errorCode: 'cancelled', errorMessage: reason });
    }
    this.#aborts.clear();
    return n;
  }

  /**
   * Called once at startup. Any run still marked `running` belongs to a process
   * that no longer exists, so it is closed as interrupted rather than resumed.
   */
  reconcileOnBoot(): number {
    const stale = this.db.$client
      .prepare("SELECT id, workspace_dir FROM agent_runs WHERE status IN ('queued', 'running')")
      .all() as Array<{ id: string; workspace_dir: string | null }>;
    for (const r of stale) {
      this.db.$client
        .prepare(
          `UPDATE agent_runs
              SET status = 'failed', finished_at = ?, error_code = 'integration_failed',
                  error_message = 'Przerwane restartem serwera; proces wykonania nie istnieje.'
            WHERE id = ?`,
        )
        .run(nowIso(), r.id);
      if (r.workspace_dir) rmSync(r.workspace_dir, { recursive: true, force: true });
    }
    return stale.length;
  }

  appendEvent(runId: string, seq: number, name: string, payload: unknown): void {
    this.db.$client
      .prepare(
        `INSERT INTO run_events (run_id, seq, name, payload, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, seq) DO NOTHING`,
      )
      .run(runId, seq, name, JSON.stringify(payload ?? null), nowIso());
  }

  events(runId: string, ownerId: string): Array<{ seq: number; name: string; payload: unknown; at: string }> {
    const row = this.#row(runId);
    if (row.owner_id !== ownerId) throw new AppError('forbidden', 'Cudze uruchomienie.');
    return (
      this.db.$client
        .prepare('SELECT seq, name, payload, at FROM run_events WHERE run_id = ? ORDER BY seq')
        .all(runId) as Array<{ seq: number; name: string; payload: string; at: string }>
    ).map((r) => ({ seq: r.seq, name: r.name, payload: JSON.parse(r.payload), at: r.at }));
  }

  /**
   * Persisted events after `fromSeq`, for a client re-attaching to a run whose
   * live stream this process no longer holds — a finished run, or one from
   * before a restart. Ownership is checked here because this is a read path a
   * browser reaches directly.
   */
  eventsAfter(
    runId: string,
    ownerId: string,
    fromSeq: number,
  ): Array<{ seq: number; payload: unknown }> {
    const row = this.#row(runId);
    if (row.owner_id !== ownerId) throw new AppError('forbidden', 'Cudze uruchomienie.');
    return (
      this.db.$client
        .prepare('SELECT seq, payload FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq')
        .all(runId, fromSeq) as Array<{ seq: number; payload: string }>
    ).map((r) => ({ seq: r.seq, payload: JSON.parse(r.payload) }));
  }
}
