import { AGENT_VIEWS_SCOPE_KIND, AppError, type Conversation, type StoredMessage } from '@platform/contracts';
import type { Db } from '../db/client.ts';
import { newId, nowIso } from '../util/id.ts';

interface ConvRow {
  id: string;
  owner_id: string;
  title: string;
  space_id: string | null;
  claude_session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MsgRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  meta: string | null;
  seq: number;
  created_at: string;
}

const toConv = (r: ConvRow): Conversation => ({
  id: r.id,
  ownerId: r.owner_id,
  title: r.title,
  spaceId: r.space_id,
  claudeSessionId: r.claude_session_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMsg = (r: MsgRow): StoredMessage => ({
  id: r.id,
  role: r.role as StoredMessage['role'],
  content: r.content,
  meta: r.meta ? JSON.parse(r.meta) : null,
  createdAt: r.created_at,
});

/**
 * Derives a readable title from the first user message. Deliberately local:
 * the acceptance criteria forbid calling the Anthropic API for titling, and a
 * subscription run costs a turn, so titles are produced by plain string work.
 */
export function deriveTitle(text: string): string {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/^["'`\s]+/, '')
    .trim();
  if (!cleaned) return 'Nowa rozmowa';
  const stop = cleaned.search(/[.?!;\n]/);
  const base = stop > 12 ? cleaned.slice(0, stop) : cleaned;
  const words = base.split(' ').slice(0, 9).join(' ');
  const title = words.length > 64 ? `${words.slice(0, 61)}…` : words;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export class ConversationService {
  constructor(private readonly db: Db) {}

  #row(id: string, ownerId: string): ConvRow {
    const row = this.db.$client
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(id) as ConvRow | undefined;
    if (!row) throw new AppError('not_found', `Conversation ${id} not found.`);
    if (row.owner_id !== ownerId) {
      throw new AppError('forbidden', 'Conversation belongs to another owner.');
    }
    return row;
  }

  list(ownerId: string, limit = 100): Conversation[] {
    return (
      this.db.$client
        .prepare('SELECT * FROM conversations WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?')
        .all(ownerId, limit) as ConvRow[]
    ).map(toConv);
  }

  get(id: string, ownerId: string): Conversation {
    return toConv(this.#row(id, ownerId));
  }

  create(input: {
    ownerId: string;
    title?: string;
    spaceId?: string | null;
    firstMessage?: { id?: string; content: string };
  }): Conversation {
    const id = newId('cnv');
    const ts = nowIso();
    const title =
      input.title ?? (input.firstMessage ? deriveTitle(input.firstMessage.content) : 'Nowa rozmowa');
    this.db.$client
      .prepare(
        `INSERT INTO conversations (id, owner_id, title, space_id, claude_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, input.ownerId, title, input.spaceId ?? null, ts, ts);
    if (input.firstMessage) {
      this.appendMessage(id, input.ownerId, {
        id: input.firstMessage.id,
        role: 'user',
        content: input.firstMessage.content,
      });
    }
    return toConv(this.#row(id, input.ownerId));
  }

  rename(id: string, ownerId: string, title: string): Conversation {
    this.#row(id, ownerId);
    this.db.$client
      .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, nowIso(), id);
    return toConv(this.#row(id, ownerId));
  }

  bindSpace(id: string, ownerId: string, spaceId: string | null): Conversation {
    this.#row(id, ownerId);
    this.db.$client
      .prepare('UPDATE conversations SET space_id = ?, updated_at = ? WHERE id = ?')
      .run(spaceId, nowIso(), id);
    return toConv(this.#row(id, ownerId));
  }

  /**
   * Binds the conversation to the Claude SDK session that answered it. Set once
   * per conversation: later runs resume that same session id, which is what
   * keeps the model's memory and the application history from drifting apart.
   */
  bindClaudeSession(id: string, sessionId: string): void {
    this.db.$client
      .prepare(
        `UPDATE conversations SET claude_session_id = ?, updated_at = ?
         WHERE id = ? AND (claude_session_id IS NULL OR claude_session_id <> ?)`,
      )
      .run(sessionId, nowIso(), id, sessionId);
  }

  /**
   * Deleting a conversation cascades to its messages and runs (FK ON DELETE
   * CASCADE) and detaches its artifacts (ON DELETE SET NULL) so published work
   * survives. The Claude session id is dropped with the row; the SDK's own
   * transcript is left alone because it is not ours to delete.
   *
   * The conversation's agent views space goes with it, cards included (they
   * cascade from the space). It is bound to the conversation by scope rather
   * than by a foreign key — spaces are scoped by opaque strings — so it is
   * deleted here, in the same transaction, instead of being left orphaned.
   */
  delete(
    id: string,
    ownerId: string,
  ): { deleted: string; detachedArtifacts: number; removedViewSpaces: number } {
    this.#row(id, ownerId);
    const artifacts = this.db.$client
      .prepare('SELECT COUNT(*) AS n FROM artifacts WHERE conversation_id = ?')
      .get(id) as { n: number };
    const removedViewSpaces = this.db.$client.transaction(() => {
      const spaces = this.db.$client
        .prepare('DELETE FROM canvas_spaces WHERE owner_id = ? AND scope_kind = ? AND scope_id = ?')
        .run(ownerId, AGENT_VIEWS_SCOPE_KIND, id);
      this.db.$client.prepare('DELETE FROM conversations WHERE id = ?').run(id);
      return spaces.changes;
    })();
    return { deleted: id, detachedArtifacts: artifacts.n, removedViewSpaces };
  }

  messages(id: string, ownerId: string): StoredMessage[] {
    this.#row(id, ownerId);
    return (
      this.db.$client
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq')
        .all(id) as MsgRow[]
    ).map(toMsg);
  }

  /**
   * Inserts a message, or updates it in place when its id is already present.
   *
   * The run projection calls this repeatedly for the same derived id as an
   * assistant segment grows and as a tool result lands, so the row must be able
   * to change after it is first written. `appendMessage` deliberately cannot do
   * that: a client-supplied id repeating there means a retry, not a revision.
   *
   * Position is assigned once, on first insert, so a later update never
   * reorders a turn — the tool timeline keeps the order the user watched.
   */
  upsertMessage(
    conversationId: string,
    ownerId: string,
    msg: { id: string; role: StoredMessage['role']; content: string; meta?: unknown },
  ): StoredMessage {
    this.#row(conversationId, ownerId);
    const ts = nowIso();
    const metaJson = msg.meta ? JSON.stringify(msg.meta) : null;
    const existing = this.db.$client
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?')
      .get(conversationId, msg.id) as MsgRow | undefined;

    if (existing) {
      this.db.$client
        .prepare('UPDATE messages SET content = ?, meta = ? WHERE conversation_id = ? AND id = ?')
        .run(msg.content, metaJson, conversationId, msg.id);
    } else {
      const seqRow = this.db.$client
        .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE conversation_id = ?')
        .get(conversationId) as { s: number };
      this.db.$client
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, content, meta, seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(msg.id, conversationId, msg.role, msg.content, metaJson, seqRow.s + 1, ts);
    }
    this.db.$client
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(ts, conversationId);
    return toMsg(
      this.db.$client
        .prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?')
        .get(conversationId, msg.id) as MsgRow,
    );
  }

  /**
   * Appends a message. When the caller supplies an id (the chat client does),
   * a repeat of the same id is a no-op — a reconnect or a retried POST cannot
   * duplicate a turn.
   */
  appendMessage(
    conversationId: string,
    ownerId: string,
    msg: { id?: string; role: StoredMessage['role']; content: string; meta?: unknown },
  ): StoredMessage {
    this.#row(conversationId, ownerId);
    const id = msg.id ?? newId('msg');
    const existing = this.db.$client
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?')
      .get(conversationId, id) as MsgRow | undefined;
    if (existing) return toMsg(existing);

    const seqRow = this.db.$client
      .prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { s: number };
    const ts = nowIso();
    this.db.$client
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, meta, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        conversationId,
        msg.role,
        msg.content,
        msg.meta ? JSON.stringify(msg.meta) : null,
        seqRow.s + 1,
        ts,
      );
    this.db.$client
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(ts, conversationId);
    return toMsg(
      this.db.$client
        .prepare('SELECT * FROM messages WHERE conversation_id = ? AND id = ?')
        .get(conversationId, id) as MsgRow,
    );
  }
}
