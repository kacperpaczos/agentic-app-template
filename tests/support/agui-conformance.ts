import { createRequire } from 'node:module';
import {
  AGUI_EVENTS,
  isPlatformCustomEvent,
  platformAguiEventSchemas,
  platformCustomPayloadSchemas,
  PLATFORM_EMITTED_EVENTS,
  type PlatformEmittedEventName,
} from '@platform/contracts';

/**
 * AG-UI conformance, checked against the protocol and against behaviour.
 *
 * Two things were missing before this existed, and they are different things:
 *
 *  - **schemas.** Conformance was measured by feeding the platform's bytes to
 *    `processStreamedMessage` and comparing the result with the backend's own
 *    projection. That is a good check of the events the parser handles, and it
 *    is blind to the rest: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` and every
 *    `CUSTOM` are dropped by the parser, so a malformed one of those produced
 *    exactly the same (passing) comparison as a correct one.
 *  - **behaviour.** A stream can be a sequence of individually valid events and
 *    still be nonsense: two terminal events, a tool result for a call that never
 *    started, text after the run ended. None of that is a schema question.
 *
 * The protocol reference is `@ag-ui/core` — **the copy the chat library itself
 * depends on**, resolved through it rather than declared again here. That is
 * deliberate: the question "do we speak AG-UI" is only meaningful about the
 * version the consumer parses with, and a separate dependency entry could drift
 * from it without anything failing.
 */

/** `@ag-ui/core` as the installed chat library resolves it, with its version. */
export function aguiCore(): { version: string; schemas: Record<string, { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }> } {
  const here = createRequire(import.meta.url);
  const headless = here.resolve('@openuidev/react-headless');
  const fromHeadless = createRequire(headless);
  return {
    version: (fromHeadless('@ag-ui/core/package.json') as { version: string }).version,
    schemas: fromHeadless('@ag-ui/core') as never,
  };
}

/** Which `@ag-ui/core` schema describes each event this platform emits. */
const AGUI_SCHEMA_NAME: Record<PlatformEmittedEventName, string> = {
  [AGUI_EVENTS.RUN_STARTED]: 'RunStartedEventSchema',
  [AGUI_EVENTS.RUN_FINISHED]: 'RunFinishedEventSchema',
  [AGUI_EVENTS.RUN_ERROR]: 'RunErrorEventSchema',
  [AGUI_EVENTS.TEXT_MESSAGE_START]: 'TextMessageStartEventSchema',
  [AGUI_EVENTS.TEXT_MESSAGE_CONTENT]: 'TextMessageContentEventSchema',
  [AGUI_EVENTS.TEXT_MESSAGE_END]: 'TextMessageEndEventSchema',
  [AGUI_EVENTS.TOOL_CALL_START]: 'ToolCallStartEventSchema',
  [AGUI_EVENTS.TOOL_CALL_ARGS]: 'ToolCallArgsEventSchema',
  [AGUI_EVENTS.TOOL_CALL_END]: 'ToolCallEndEventSchema',
  [AGUI_EVENTS.TOOL_CALL_RESULT]: 'ToolCallResultEventSchema',
  [AGUI_EVENTS.CUSTOM]: 'CustomEventSchema',
};

export interface Violation {
  /** Position in the stream, so a failure names the event and not the run. */
  at: number;
  /** Short identifier of the rule, asserted on instead of the message text. */
  rule:
    | 'unknown_event'
    | 'agui_schema'
    | 'platform_schema'
    | 'unknown_custom'
    | 'custom_payload'
    | 'run_started_missing'
    | 'run_started_repeated'
    | 'terminal_missing'
    | 'terminal_repeated'
    | 'after_terminal'
    | 'text_not_open'
    | 'text_after_end'
    | 'tool_not_started'
    | 'tool_result_shares_message_id';
  detail: string;
}

export interface ConformanceInput {
  type?: string;
  [key: string]: unknown;
}

/**
 * Every way in which this sequence is not a conforming AG-UI run.
 *
 * Returns the whole list rather than throwing on the first, so a failing test
 * says what is wrong with the stream instead of what is wrong with its first
 * event.
 */
export function aguiViolations(events: ConformanceInput[]): Violation[] {
  const { schemas } = aguiCore();
  const out: Violation[] = [];
  const add = (at: number, rule: Violation['rule'], detail: string) => out.push({ at, rule, detail });

  let started = false;
  let terminal = -1;
  const openText = new Set<string>();
  const endedText = new Set<string>();
  const startedTools = new Map<string, string>();

  events.forEach((event, at) => {
    const type = event.type;

    if (typeof type !== 'string' || !(PLATFORM_EMITTED_EVENTS as string[]).includes(type)) {
      add(at, 'unknown_event', `typ "${String(type)}" nie jest zdarzeniem emitowanym przez platforme`);
      return;
    }
    const name = type as PlatformEmittedEventName;

    if (terminal >= 0) {
      add(at, 'after_terminal', `${type} po zdarzeniu koncowym na pozycji ${terminal}`);
    }

    /* ---- the protocol's own schema, from the library's own @ag-ui/core ---- */
    const aguiSchema = schemas[AGUI_SCHEMA_NAME[name]];
    const aguiResult = aguiSchema?.safeParse(event);
    if (!aguiResult?.success) {
      add(
        at,
        'agui_schema',
        `${type}: ${(aguiResult?.error?.issues ?? []).map((i) => `${i.path.join('.')} ${i.message}`).join('; ') || 'brak schematu AG-UI'}`,
      );
    }

    /* ------------- and what this platform promises on top of it ------------ */
    const platformResult = platformAguiEventSchemas[name].safeParse(event);
    if (!platformResult.success) {
      add(
        at,
        'platform_schema',
        `${type}: ${platformResult.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }

    switch (name) {
      case AGUI_EVENTS.RUN_STARTED:
        if (started) add(at, 'run_started_repeated', 'drugie RUN_STARTED w jednym uruchomieniu');
        if (at !== 0) add(at, 'run_started_missing', `RUN_STARTED na pozycji ${at}, nie pierwszej`);
        started = true;
        break;

      case AGUI_EVENTS.RUN_FINISHED:
      case AGUI_EVENTS.RUN_ERROR:
        if (terminal >= 0) add(at, 'terminal_repeated', `drugi status koncowy (${type})`);
        terminal = at;
        break;

      case AGUI_EVENTS.TEXT_MESSAGE_START:
        openText.add(String(event.messageId));
        break;

      case AGUI_EVENTS.TEXT_MESSAGE_CONTENT: {
        const id = String(event.messageId);
        if (endedText.has(id)) add(at, 'text_after_end', `tekst po TEXT_MESSAGE_END dla ${id}`);
        else if (!openText.has(id)) add(at, 'text_not_open', `tekst bez TEXT_MESSAGE_START dla ${id}`);
        break;
      }

      case AGUI_EVENTS.TEXT_MESSAGE_END: {
        const id = String(event.messageId);
        if (!openText.has(id)) add(at, 'text_not_open', `TEXT_MESSAGE_END bez START dla ${id}`);
        openText.delete(id);
        endedText.add(id);
        break;
      }

      case AGUI_EVENTS.TOOL_CALL_START:
        startedTools.set(String(event.toolCallId), String(event.parentMessageId));
        break;

      case AGUI_EVENTS.TOOL_CALL_ARGS:
      case AGUI_EVENTS.TOOL_CALL_END:
        if (!startedTools.has(String(event.toolCallId))) {
          add(at, 'tool_not_started', `${type} dla wywolania bez TOOL_CALL_START: ${String(event.toolCallId)}`);
        }
        break;

      case AGUI_EVENTS.TOOL_CALL_RESULT: {
        const callId = String(event.toolCallId);
        const parent = startedTools.get(callId);
        if (parent === undefined) {
          add(at, 'tool_not_started', `wynik narzedzia bez TOOL_CALL_START: ${callId}`);
          break;
        }
        /*
         * The result is a message of its own, and must not borrow the assistant
         * segment's id: the ready-made chat pairs `toolCalls[]` of an assistant
         * message with `role: "tool"` messages by id, and one id used for both
         * makes the turn unreadable — the exact failure `scopeToolId` exists for
         * one level up.
         */
        if (String(event.messageId) === parent) {
          add(at, 'tool_result_shares_message_id', `wynik ${callId} uzywa messageId segmentu asystenta`);
        }
        break;
      }

      case AGUI_EVENTS.CUSTOM: {
        const customName = event.name;
        if (!isPlatformCustomEvent(customName)) {
          add(at, 'unknown_custom', `CUSTOM "${String(customName)}" nie ma schematu w platform-contracts`);
          break;
        }
        const payload = platformCustomPayloadSchemas[customName].safeParse(event.value);
        if (!payload.success) {
          add(
            at,
            'custom_payload',
            `${customName}: ${payload.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
          );
        }
        break;
      }
    }
  });

  if (!started) add(0, 'run_started_missing', 'strumien nie zaczyna sie od RUN_STARTED');
  if (terminal < 0) add(events.length, 'terminal_missing', 'strumien nie ma statusu koncowego');
  else if (terminal !== events.length - 1) {
    add(terminal, 'after_terminal', `status koncowy na pozycji ${terminal} z ${events.length - 1}`);
  }

  return out;
}

/** Readable summary for an assertion message. */
export const describeViolations = (v: Violation[]): string =>
  v.length === 0 ? 'brak naruszen' : v.map((x) => `#${x.at} ${x.rule}: ${x.detail}`).join('\n');
