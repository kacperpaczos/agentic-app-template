import { AGUI_EVENTS } from '@platform/contracts';
import type { AguiEvent } from './events.ts';

/**
 * Projects an AG-UI event sequence into the conversation messages that must
 * survive a reload, a conversation switch and a backend restart.
 *
 * **Why this exists.** The chat renders tool activity from the message list
 * itself: `@openuidev/react-ui` pairs an assistant message's `toolCalls[]` with
 * the `role: "tool"` messages that carry the results (`pairToolActivity`), and
 * `InterleavedTurn` draws the `ToolCallTimeline` from that pairing. A backend
 * that stores only assistant prose therefore produces a thread that shows the
 * answer and silently drops every step that produced it — which is exactly what
 * this platform did before.
 *
 * **Why a projector and not a second writer.** The live stream is already
 * reduced by `processStreamedMessage` in the browser. If persistence reduced the
 * same events differently, history and live view would drift. This class is a
 * deliberate mirror of that reducer's state machine — same segmentation rules,
 * same tool-call assembly — so the thread a user reloads is the thread they
 * watched. The event sequence is the single source of truth; both reductions are
 * derived from it, and `tests/projection.test.ts` pins them to each other.
 *
 * Ids are derived, never random, so applying the same event twice (a reconnect,
 * a crash-recovery backfill) updates the same row instead of duplicating a turn.
 */

export interface ProjectedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ProjectedMessage =
  | {
      id: string;
      role: 'assistant';
      content: string;
      toolCalls: ProjectedToolCall[];
    }
  | {
      id: string;
      role: 'tool';
      toolCallId: string;
      content: string;
      isError: boolean;
      error?: string;
    };

/** A message is only worth storing once it carries text or a tool call. */
const hasBody = (m: { content: string; toolCalls: ProjectedToolCall[] }): boolean =>
  m.content.length > 0 || m.toolCalls.length > 0;

export class ConversationProjection {
  #segment = 0;
  #current: { id: string; content: string; toolCalls: ProjectedToolCall[] };
  #textItemId: string | null = null;
  /** Tool results already written, so a repeated RESULT updates instead of appending. */
  readonly #toolMessages = new Map<string, ProjectedMessage>();

  constructor(
    private readonly runId: string,
    private readonly write: (message: ProjectedMessage) => void,
  ) {
    this.#current = this.#freshSegment();
  }

  #freshSegment(): { id: string; content: string; toolCalls: ProjectedToolCall[] } {
    this.#segment += 1;
    return { id: `am_${this.runId}_${this.#segment}`, content: '', toolCalls: [] };
  }

  /**
   * Closes the open segment and starts a new one. Mirrors the library's
   * `startNewAssistantSegment`: text that follows a tool call belongs to a new
   * assistant message, which is what lets the timeline and the final answer sit
   * in the right order inside one turn.
   */
  #startNewSegment(): void {
    if (hasBody(this.#current)) this.#flush();
    this.#current = this.#freshSegment();
    this.#textItemId = null;
  }

  #flush(): void {
    if (!hasBody(this.#current)) return;
    this.write({
      id: this.#current.id,
      role: 'assistant',
      content: this.#current.content,
      toolCalls: this.#current.toolCalls,
    });
  }

  apply(event: AguiEvent): void {
    switch (event.type) {
      case AGUI_EVENTS.TEXT_MESSAGE_START: {
        const startId = typeof event.messageId === 'string' ? event.messageId : null;
        if (hasBody(this.#current) && startId !== this.#textItemId) this.#startNewSegment();
        this.#textItemId = startId;
        break;
      }

      case AGUI_EVENTS.TEXT_MESSAGE_CONTENT: {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (!delta) return;
        // Text after a tool call opens a new assistant segment.
        if (this.#current.toolCalls.length > 0) this.#startNewSegment();
        this.#current.content += delta;
        break;
      }

      case AGUI_EVENTS.TOOL_CALL_START: {
        const id = String(event.toolCallId ?? '');
        if (!id) return;
        this.#current.toolCalls.push({
          id,
          type: 'function',
          function: { name: String(event.toolCallName ?? 'tool'), arguments: '' },
        });
        break;
      }

      case AGUI_EVENTS.TOOL_CALL_ARGS: {
        const id = String(event.toolCallId ?? '');
        const call = this.#current.toolCalls.find((c) => c.id === id);
        if (!call) return;
        call.function.arguments += typeof event.delta === 'string' ? event.delta : '';
        break;
      }

      case AGUI_EVENTS.TOOL_CALL_RESULT: {
        const id = String(event.toolCallId ?? '');
        if (!id) return;
        const isError = event.isError === true;
        const message: ProjectedMessage = {
          /*
           * Scoped to the run, not just to the tool call.
           *
           * `messages.id` is a primary key across the whole table, and a tool
           * call id is only unique within the provider's own session — so two
           * runs that happen to reuse one would collide and the second run's
           * result would be dropped. Deriving from the run id removes that
           * dependency on someone else's uniqueness guarantee.
           */
          id: `tm_${this.runId}_${id}`,
          role: 'tool',
          toolCallId: id,
          content: typeof event.content === 'string' ? event.content : '',
          isError,
          ...(isError && typeof event.error === 'string' ? { error: event.error } : {}),
        };
        this.#toolMessages.set(id, message);
        this.write(message);
        // A tool result does not close the assistant segment: the model may call
        // another tool in the same segment before it says anything.
        return;
      }

      default:
        return;
    }

    this.#flush();
  }

  /** Writes whatever is still open. Safe to call more than once. */
  finish(): void {
    this.#flush();
  }
}

/**
 * Reduces a stored event sequence into messages. Used to reconstruct tool
 * activity for conversations recorded before tool activity was persisted, and
 * to repair a run whose process died before it could finish writing.
 */
export function projectEvents(runId: string, events: AguiEvent[]): ProjectedMessage[] {
  const out: ProjectedMessage[] = [];
  const byId = new Map<string, number>();
  const projection = new ConversationProjection(runId, (message) => {
    const at = byId.get(message.id);
    if (at === undefined) {
      byId.set(message.id, out.length);
      out.push(message);
    } else {
      out[at] = message;
    }
  });
  for (const event of events) projection.apply(event);
  projection.finish();
  return out;
}
