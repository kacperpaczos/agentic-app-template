import type { AguiEvent } from '../agent/events.ts';
import { projectEvents } from '../agent/projection.ts';
import type { Db } from './client.ts';

/**
 * Reconstructs tool activity for conversations recorded before it was persisted.
 *
 * Until the run projection existed, a finished run stored one assistant message
 * holding the answer text and nothing else, so reopening an old conversation
 * showed the conclusion with no trace of the steps that produced it. The AG-UI
 * events of those runs were persisted all along, and they are a complete record
 * — so the history can be rebuilt rather than declared lost.
 *
 * What it does per legacy run:
 *  - projects the stored events into the same messages a live run would write;
 *  - replaces the single old `am_<runId>` row **in place**, renumbering the rows
 *    after it, so the rebuilt turn keeps its position between the user messages
 *    around it;
 *  - leaves everything else untouched.
 *
 * What it deliberately does not do: invent activity it cannot evidence. A run
 * whose events were pruned keeps exactly the message it already had.
 *
 * Idempotent: a run whose projection is already present is skipped, so this can
 * run on every boot.
 */
export function backfillToolActivity(db: Db): {
  runsExamined: number;
  runsRebuilt: number;
  messagesWritten: number;
} {
  const sqlite = db.$client;

  const runs = sqlite
    .prepare(
      `SELECT r.id AS run_id, r.conversation_id
         FROM agent_runs r
        WHERE EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = r.id)
        ORDER BY r.enqueued_at, r.started_at`,
    )
    .all() as Array<{ run_id: string; conversation_id: string }>;

  let runsRebuilt = 0;
  let messagesWritten = 0;

  for (const run of runs) {
    // Already projected (live path or an earlier backfill) — nothing to do.
    // GLOB, not LIKE: `_` is a single-character wildcard in LIKE, and every id
    // here contains underscores.
    const projected = sqlite
      .prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND id GLOB ? LIMIT 1')
      .get(run.conversation_id, `am_${run.run_id}_*`) as unknown;
    if (projected) continue;

    const events = (
      sqlite
        .prepare('SELECT payload FROM run_events WHERE run_id = ? ORDER BY seq')
        .all(run.run_id) as Array<{ payload: string }>
    ).map((r) => JSON.parse(r.payload) as AguiEvent);
    if (events.length === 0) continue;

    const messages = projectEvents(run.run_id, events);
    if (messages.length === 0) continue;

    const legacy = sqlite
      .prepare('SELECT seq FROM messages WHERE conversation_id = ? AND id = ?')
      .get(run.conversation_id, `am_${run.run_id}`) as { seq: number } | undefined;

    const maxSeq = (
      sqlite
        .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE conversation_id = ?')
        .get(run.conversation_id) as { s: number }
    ).s;

    // Insert where the old row stood, or after everything if the run never
    // managed to write one (a failure before any text).
    const anchor = legacy ? legacy.seq : maxSeq + 1;
    const ts = new Date().toISOString();

    const tx = sqlite.transaction(() => {
      if (legacy) {
        sqlite
          .prepare('DELETE FROM messages WHERE conversation_id = ? AND id = ?')
          .run(run.conversation_id, `am_${run.run_id}`);
        // Make room: the rebuilt turn may be several rows where one stood.
        // Shift downwards from the far end so the unique (conversation, seq)
        // ordering never collides mid-update.
        const shift = messages.length - 1;
        if (shift > 0) {
          sqlite
            .prepare(
              'UPDATE messages SET seq = seq + ? WHERE conversation_id = ? AND seq > ?',
            )
            .run(shift, run.conversation_id, anchor);
        }
      }

      messages.forEach((m, i) => {
        const meta =
          m.role === 'assistant'
            ? { runId: run.run_id, toolCalls: m.toolCalls, rebuiltFromEvents: true }
            : {
                runId: run.run_id,
                toolCallId: m.toolCallId,
                isError: m.isError,
                ...(m.error ? { error: m.error } : {}),
                rebuiltFromEvents: true,
              };
        sqlite
          .prepare(
            `INSERT INTO messages (id, conversation_id, role, content, meta, seq, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            m.id,
            run.conversation_id,
            m.role,
            m.content,
            JSON.stringify(meta),
            anchor + i,
            ts,
          );
        messagesWritten += 1;
      });
    });

    tx();
    runsRebuilt += 1;
  }

  return { runsExamined: runs.length, runsRebuilt, messagesWritten };
}
