import {
  AGUI_EVENTS,
  PLATFORM_CUSTOM_EVENTS,
  PLATFORM_CUSTOM_PAYLOAD_VERSION,
} from '@platform/contracts';
import type { RunRegistry } from '../services/runs.ts';

export interface AguiEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Ordered, sequence-numbered AG-UI event stream for one agent run.
 *
 * Events arrive from two independent producers — the Mastra text stream and the
 * Claude SDK hook callbacks — so they are funnelled through this single queue.
 * Every event is persisted to `run_events` before it is pushed, which is what
 * lets a reconnecting client replay from a sequence number instead of re-running
 * the model.
 */
export class RunEventStream {
  #seq = 0;
  #closed = false;
  readonly #buffer: Array<{ seq: number; event: AguiEvent }> = [];
  readonly #waiters: Array<() => void> = [];

  /**
   * @param observe Called with every event, in order, before it reaches any
   *   reader. The run projection subscribes here so the persisted conversation
   *   is reduced from exactly the sequence the browser receives — one source of
   *   truth, two reductions, no drift between history and the live view.
   */
  constructor(
    readonly runId: string,
    private readonly runs: RunRegistry,
    private readonly observe: (event: AguiEvent) => void = () => {},
  ) {}

  get seq(): number {
    return this.#seq;
  }

  get closed(): boolean {
    return this.#closed;
  }

  emit(event: AguiEvent): number {
    if (this.#closed) return this.#seq;
    this.#seq += 1;
    const seq = this.#seq;
    try {
      this.runs.appendEvent(this.runId, seq, event.type, event);
    } catch (err) {
      /*
       * One expected failure, and everything else stays loud.
       *
       * The expected one: the run's row can disappear underneath it. Deleting a
       * conversation cascades to `agent_runs`, and with `foreign_keys = ON` the
       * next `run_events` insert is refused with a foreign-key violation. That
       * is a legitimate end for a run nobody can look at any more, and it must
       * not become an exception thrown out of an event emit — which took the
       * run down mid-stream and left the failure looking like a model error.
       * The cancellation issued by the delete is the orderly path
       * (`ConversationService.delete`); this is the guard for the one or two
       * events already in flight when it landed.
       *
       * Everything else — a full disk, a locked or read-only database, a
       * corrupted file — is a write failure in the **single source of truth**
       * for this run. The stream carries on, because killing a run the user is
       * watching over a logging failure helps nobody, but the log this leaves
       * behind is now shorter than what was delivered, and that is exactly what
       * a reload and a restart will replay. So it is reported the way the
       * projection below reports its own genuine failures: an error, with the
       * cause, saying plainly what is now incomplete. Swallowing this as a
       * warning is how a truncated history would look like a rendering problem.
       */
      const sqlite = (err as { code?: unknown } | null)?.code;
      if (sqlite === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        console.warn(
          `[run ${this.runId}] zdarzenia ${event.type} nie ma juz gdzie zapisac: uruchomienie zniknelo razem z rozmowa`,
        );
      } else {
        console.error(
          `[run ${this.runId}] BLAD ZAPISU DZIENNIKA zdarzenia ${event.type}: dziennik tego uruchomienia jest od tego miejsca niepelny i taki zostanie odtworzony po przeladowaniu i restarcie`,
          err,
        );
      }
    }
    // Persist the projection before the event is readable: a client that
    // reconnects and refetches the thread must never see a message the stream
    // has already delivered but the database does not know about yet.
    try {
      this.observe(event);
    } catch (err) {
      /*
       * A projection failure must not take down the run the user is watching —
       * but it must be loud. Swallowing it silently is how a missing tool
       * message looked like a rendering problem for an afternoon.
       *
       * With one exception, and it is a real one rather than a convenience: a
       * conversation that has been deleted answers `not_found` (or `forbidden`
       * once its owner is gone) to every write, and there is nothing incomplete
       * about a history nobody kept. Printing a stack for the outcome the user
       * asked for teaches the reader to ignore this line, which is how the
       * genuine failure above stops being noticed.
       */
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'not_found' || code === 'forbidden') {
        console.warn(
          `[run ${this.runId}] zdarzenie ${event.type} nie ma juz gdzie trafic: rozmowa zostala usunieta`,
        );
      } else {
        console.error(
          `[run ${this.runId}] BLAD PROJEKCJI zdarzenia ${event.type}: historia tego uruchomienia bedzie niekompletna`,
          err,
        );
      }
    }
    this.#buffer.push({ seq, event });
    for (const w of this.#waiters.splice(0)) w();
    return seq;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w();
  }

  /** Async iterator over events, starting after `fromSeq`. */
  async *read(fromSeq = 0): AsyncGenerator<{ seq: number; event: AguiEvent }> {
    let cursor = fromSeq;
    for (;;) {
      const pending = this.#buffer.filter((e) => e.seq > cursor);
      for (const item of pending) {
        cursor = item.seq;
        yield item;
      }
      /*
       * Once the stream is closed there will be no further wake-up, so a reader
       * must drain what is left instead of waiting for one.
       *
       * The previous form awaited a waiter whenever anything was still
       * unconsumed — including after close — and a reader that attached late, or
       * fell behind a burst, then hung for ever. A reconnecting client replaying
       * from a sequence number is exactly that reader.
       */
      if (this.#closed) {
        if (this.#buffer.every((e) => e.seq <= cursor)) return;
        continue;
      }
      /*
       * An event emitted while the consumer was still busy with the previous one
       * (writing it to a socket, say) found no waiter to wake. Waiting now would
       * hold it back until some later event — and a UI command is followed by no
       * event at all until the browser acknowledges it, which it cannot do
       * before receiving it: the run timed out as `no_client` while the command
       * sat in the buffer.
       */
      if ((this.#buffer.at(-1)?.seq ?? 0) > cursor) continue;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  /* ------------------------- typed emit helpers ------------------------- */

  runStarted(threadId: string, runId: string): void {
    this.emit({ type: AGUI_EVENTS.RUN_STARTED, threadId, runId });
  }

  textStart(messageId: string): void {
    this.emit({ type: AGUI_EVENTS.TEXT_MESSAGE_START, messageId, role: 'assistant' });
  }

  textDelta(messageId: string, delta: string): void {
    this.emit({ type: AGUI_EVENTS.TEXT_MESSAGE_CONTENT, messageId, delta });
  }

  textEnd(messageId: string): void {
    this.emit({ type: AGUI_EVENTS.TEXT_MESSAGE_END, messageId });
  }

  toolStart(toolCallId: string, toolCallName: string, parentMessageId: string): void {
    this.emit({ type: AGUI_EVENTS.TOOL_CALL_START, toolCallId, toolCallName, parentMessageId });
  }

  toolArgs(toolCallId: string, argsJson: string): void {
    this.emit({ type: AGUI_EVENTS.TOOL_CALL_ARGS, toolCallId, delta: argsJson });
  }

  toolEnd(toolCallId: string): void {
    this.emit({ type: AGUI_EVENTS.TOOL_CALL_END, toolCallId });
  }

  toolResult(toolCallId: string, content: string, isError = false): void {
    this.emit({
      type: AGUI_EVENTS.TOOL_CALL_RESULT,
      messageId: `tr_${toolCallId}`,
      toolCallId,
      content,
      role: 'tool',
      ...(isError ? { isError: true, error: content } : {}),
    });
  }

  /**
   * A platform concern the protocol does not model.
   *
   * The shape version is stamped here and nowhere else. `CUSTOM` is AG-UI's
   * escape hatch — the protocol says nothing about what is inside one — so a
   * consumer that is not this build's own client (an older tab, an event log
   * replayed long afterwards) has no way to tell a payload it understands from
   * one it does not. One producer means the number cannot drift between two
   * emit sites, and `platformCustomPayloadSchemas` says what each name carries.
   *
   * An object payload only: every platform custom event is one, and stamping a
   * version onto a string or an array would change its type rather than extend
   * it. A non-object is passed through untouched and fails the conformance
   * check, which is the honest outcome — it is not a payload this platform
   * describes.
   */
  custom(name: string, value: unknown): void {
    const stamped =
      value && typeof value === 'object' && !Array.isArray(value)
        ? { version: PLATFORM_CUSTOM_PAYLOAD_VERSION, ...(value as Record<string, unknown>) }
        : value;
    this.emit({ type: AGUI_EVENTS.CUSTOM, name, value: stamped });
  }

  canvasChanged(spaceId: string): void {
    this.custom(PLATFORM_CUSTOM_EVENTS.canvasChanged, { spaceId });
  }

  dataChanged(resources: string[]): void {
    this.custom(PLATFORM_CUSTOM_EVENTS.dataChanged, { resources });
  }

  artifactCreated(artifactId: string): void {
    this.custom(PLATFORM_CUSTOM_EVENTS.artifactCreated, { artifactId });
  }

  sessionBound(sessionId: string, conversationId: string): void {
    this.custom(PLATFORM_CUSTOM_EVENTS.sessionBound, { sessionId, conversationId });
  }

  runFinished(threadId: string, runId: string, extra: Record<string, unknown> = {}): void {
    this.emit({ type: AGUI_EVENTS.RUN_FINISHED, threadId, runId, ...extra });
  }

  runError(message: string, code: string): void {
    this.emit({ type: AGUI_EVENTS.RUN_ERROR, message, code });
  }
}

/** Encodes an AG-UI event the way `agUIAdapter()` expects: `data: <json>`. */
export const encodeSse = (event: AguiEvent): string => `data: ${JSON.stringify(event)}\n\n`;
