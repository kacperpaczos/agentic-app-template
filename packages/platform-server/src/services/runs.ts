import {
  ACTIVE_RUN_STATUSES,
  appContextSchema,
  AppError,
  EMPTY_APP_CONTEXT,
  type AgentRun,
  type AppContext,
  type RunStatus,
  type TerminalRunStatus,
} from '@platform/contracts';
import type { Db } from '../db/client.ts';
import { removeManagedTree } from '../util/managed-fs.ts';
import { newId, nowIso } from '../util/id.ts';

/** `'queued','running','awaiting_consent'` as an SQL list, from the one contract. */
const ACTIVE_SQL_LIST = ACTIVE_RUN_STATUSES.map((s) => `'${s}'`).join(',');

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
  input_file_ids: string | null;
  user_message_id: string | null;
}

/**
 * Wewnętrzny wiersz zadania: to, co centrum zadań (L11.6) potrzebuje z
 * rejestru, włącznie z polami, których publiczny kontrakt `AgentRun` celowo
 * nie niesie (`prompt` jako intencja, lista plików wejściowych).
 */
export interface RunTaskRow extends AgentRun {
  prompt: string;
  inputFileIds: string[];
  /** Kontekst zapisany w chwili startu; pusty wzorzec, gdy zapis jest nieczytelny. */
  appContext: AppContext;
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

  /**
   * `workspacesDir` is not used to *build* any path — the workspace directory of
   * a run is read from its row. It is the root every deletion here is checked
   * against at the moment of the call (`managed-fs.ts`), so a `workspace_dir`
   * that is empty, relative, or written by an older version cannot become an
   * `rm -rf` of something else.
   */
  constructor(
    private readonly db: Db,
    private readonly workspacesDir: string,
  ) {}

  start(input: {
    conversationId: string;
    ownerId: string;
    prompt: string;
    appContext: AppContext;
    workspaceDir: string | null;
    abort: AbortController;
    /** Files attached to the command; empty when it carried none. */
    inputFileIds?: string[];
    userMessageId?: string | null;
  }): AgentRun {
    const id = newId('run');
    const ts = nowIso();
    this.db.$client
      .prepare(
        `INSERT INTO agent_runs (id, conversation_id, owner_id, status, claude_session_id, prompt, app_context, enqueued_at, started_at, workspace_dir, input_file_ids, user_message_id)
         VALUES (?, ?, ?, 'queued', NULL, ?, ?, ?, ?, ?, ?, ?)`,
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
        // Persisted at start: the task center shows what the run *received*,
        // not what a request promised and the message later lost.
        JSON.stringify(input.inputFileIds ?? []),
        input.userMessageId ?? null,
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
            WHERE owner_id = ? AND status IN (${ACTIVE_SQL_LIST})
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

  #taskRow(row: RunRow): RunTaskRow {
    let ids: string[] = [];
    if (row.input_file_ids) {
      try {
        const parsed: unknown = JSON.parse(row.input_file_ids);
        if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string');
      } catch {
        // A corrupted record is an absent list, not an exception for the center.
      }
    }
    let appContext: AppContext = EMPTY_APP_CONTEXT;
    try {
      const parsed: unknown = JSON.parse(row.app_context);
      const check = appContextSchema.safeParse(parsed);
      if (check.success) appContext = check.data;
    } catch {
      // A record from before the schema changed: the start context is unknown,
      // not invented.
    }
    return { ...toRun(row), prompt: row.prompt, inputFileIds: ids, appContext };
  }

  /** One task row, with the ownership check a browser-reachable read owes. */
  task(id: string, ownerId: string): RunTaskRow {
    const row = this.#row(id);
    if (row.owner_id !== ownerId) throw new AppError('forbidden', 'Cudze uruchomienie.');
    return this.#taskRow(row);
  }

  /**
   * The owner's tasks for the center: active ones oldest first, then finished
   * ones newest first, bounded together by the limit.
   */
  listTasks(ownerId: string, limit: number): RunTaskRow[] {
    const active = (
      this.db.$client
        .prepare(
          `SELECT * FROM agent_runs
            WHERE owner_id = ? AND status IN (${ACTIVE_SQL_LIST})
            ORDER BY enqueued_at, started_at`,
        )
        .all(ownerId) as RunRow[]
    ).map((r) => this.#taskRow(r));
    const remaining = Math.max(0, limit - active.length);
    const finished =
      remaining === 0
        ? []
        : (
            this.db.$client
              .prepare(
                `SELECT * FROM agent_runs
                  WHERE owner_id = ? AND status NOT IN (${ACTIVE_SQL_LIST})
                  ORDER BY COALESCE(finished_at, started_at) DESC LIMIT ?`,
              )
              .all(ownerId, remaining) as RunRow[]
          ).map((r) => this.#taskRow(r));
    return [...active, ...finished];
  }

  /**
   * Progress counters straight from the durable event log.
   *
   * One query per batch of runs: the center refreshes on a schedule, so the
   * cost has to grow with the number of visible tasks, not with the events in
   * each of them. Artifacts are *not* counted here — their truth is the
   * artifact registry, not an event in the stream (the event dates a moment of
   * publication; the registry says what exists).
   */
  eventStats(runIds: string[]): Map<
    string,
    { toolCallsStarted: number; toolCallsFinished: number; textParts: number; lastEventAt: string | null }
  > {
    const out = new Map<
      string,
      { toolCallsStarted: number; toolCallsFinished: number; textParts: number; lastEventAt: string | null }
    >();
    for (const id of runIds)
      out.set(id, { toolCallsStarted: 0, toolCallsFinished: 0, textParts: 0, lastEventAt: null });
    if (runIds.length === 0) return out;
    const placeholders = runIds.map(() => '?').join(',');
    const rows = this.db.$client
      .prepare(
        `SELECT run_id, name, MAX(at) AS last_at, COUNT(*) AS n
           FROM run_events WHERE run_id IN (${placeholders})
          GROUP BY run_id, name`,
      )
      .all(...runIds) as Array<{ run_id: string; name: string; last_at: string; n: number }>;
    for (const r of rows) {
      const acc = out.get(r.run_id);
      if (!acc) continue;
      acc.lastEventAt = acc.lastEventAt && acc.lastEventAt > r.last_at ? acc.lastEventAt : r.last_at;
      if (r.name === 'TOOL_CALL_START') acc.toolCallsStarted += r.n;
      else if (r.name === 'TOOL_CALL_END') acc.toolCallsFinished += r.n;
      else if (r.name === 'TEXT_MESSAGE_CONTENT') acc.textParts += r.n;
    }
    return out;
  }

  /** Tools used by one run, with call counts, most-called first. */
  toolSummary(runId: string): Array<{ name: string; calls: number }> {
    const rows = this.db.$client
      .prepare(
        `SELECT json_extract(payload, '$.toolCallName') AS name, COUNT(*) AS n
           FROM run_events
          WHERE run_id = ? AND name = 'TOOL_CALL_START' AND json_extract(payload, '$.toolCallName') IS NOT NULL
          GROUP BY name ORDER BY n DESC`,
      )
      .all(runId) as Array<{ name: string; n: number }>;
    return rows.map((r) => ({ name: r.name, calls: r.n }));
  }

  /**
   * The same summary for a batch of runs, in one query — the center renders
   * every row it returns, so per-row queries would multiply the load by the
   * number of visible tasks on every refresh tick.
   */
  toolSummaryFor(runIds: string[]): Map<string, Array<{ name: string; calls: number }>> {
    const out = new Map<string, Array<{ name: string; calls: number }>>();
    for (const id of runIds) out.set(id, []);
    if (runIds.length === 0) return out;
    const placeholders = runIds.map(() => '?').join(',');
    const rows = this.db.$client
      .prepare(
        `SELECT run_id, json_extract(payload, '$.toolCallName') AS name, COUNT(*) AS n
           FROM run_events
          WHERE run_id IN (${placeholders}) AND name = 'TOOL_CALL_START' AND json_extract(payload, '$.toolCallName') IS NOT NULL
          GROUP BY run_id, name ORDER BY n DESC`,
      )
      .all(...runIds) as Array<{ run_id: string; name: string; n: number }>;
    for (const r of rows) {
      const acc = out.get(r.run_id);
      if (acc) acc.push({ name: r.name, calls: r.n });
    }
    return out;
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

  /**
   * The run stopped at the consent gate and is waiting for a person.
   *
   * Written to the row, not only emitted, because the client that needs to know
   * is the one that is *not* watching this conversation. `running` is the only
   * status it may replace: a run cancelled or timed out while the question was
   * open has already resolved, and must not be dragged back into an active
   * status by an answer arriving afterwards.
   */
  markAwaitingConsent(id: string): void {
    this.db.$client
      .prepare("UPDATE agent_runs SET status = 'awaiting_consent' WHERE id = ? AND status = 'running'")
      .run(id);
  }

  /** The question was answered (or expired): back to ordinary execution. */
  markConsentAnswered(id: string): void {
    this.db.$client
      .prepare("UPDATE agent_runs SET status = 'running' WHERE id = ? AND status = 'awaiting_consent'")
      .run(id);
  }

  markFirstToken(id: string, ms: number): void {
    this.db.$client
      .prepare('UPDATE agent_runs SET first_token_ms = COALESCE(first_token_ms, ?) WHERE id = ?')
      .run(ms, id);
  }

  /** Exactly one resolving terminal status per run; later calls are ignored. */
  finish(
    id: string,
    status: TerminalRunStatus,
    opts: { errorCode?: string; errorMessage?: string; durationMs?: number } = {},
  ): AgentRun {
    this.db.$client
      .prepare(
        `UPDATE agent_runs
            SET status = ?, finished_at = ?, error_code = ?, error_message = ?, duration_ms = ?
          WHERE id = ? AND status IN (${ACTIVE_SQL_LIST})`,
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
    /*
     * Every active status is cancellable, and that includes `awaiting_consent`.
     * A run still in the queue never reached the model and must not run
     * afterwards; a run parked on a question is the case the user is most
     * likely to want to end — Stop has to be an answer to "something is waiting
     * for me and I do not want it to happen", not only to "this is taking long".
     */
    if (!ac || !(ACTIVE_RUN_STATUSES as readonly string[]).includes(row.status)) {
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
      .prepare(`SELECT id, workspace_dir FROM agent_runs WHERE status IN (${ACTIVE_SQL_LIST})`)
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
      /*
       * The path comes out of the database, so it is checked at the call rather
       * than trusted for having been stored. A boot must not be able to delete
       * anything outside the workspaces directory, whatever a row happens to
       * contain — and a row that fails the check leaves its directory alone
       * instead of taking the boot down with it.
       */
      if (r.workspace_dir) {
        try {
          removeManagedTree(r.workspace_dir, {
            root: this.workspacesDir,
            what: 'workspace uruchomien',
          });
        } catch (err) {
          console.warn(
            `[runs] nie usunieto workspace uruchomienia ${r.id}: ${(err as Error).message}`,
          );
        }
      }
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
