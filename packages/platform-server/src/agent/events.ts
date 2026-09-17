import { AGUI_EVENTS, PLATFORM_CUSTOM_EVENTS } from '@platform/contracts';
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
    this.runs.appendEvent(this.runId, seq, event.type, event);
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
       */
      console.error(
        `[run ${this.runId}] BLAD PROJEKCJI zdarzenia ${event.type}: historia tego uruchomienia bedzie niekompletna`,
        err,
      );
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
       * Events emitted while this reader was suspended at `yield` (its
       * consumer still writing to the socket) found no waiter to wake. They are
       * in the buffer already, so they are read now — waiting here would hold
       * them back until some later, unrelated emit. A tool that asks the
       * browser for something emits its call and the command in one burst, and
       * the command then reached the browser only once it had timed out.
       */
      if (this.#buffer.some((e) => e.seq > cursor)) continue;
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

  custom(name: string, value: unknown): void {
    this.emit({ type: AGUI_EVENTS.CUSTOM, name, value });
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
