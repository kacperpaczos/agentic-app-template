import { z } from 'zod';
import { AGUI_EVENTS, PLATFORM_CUSTOM_EVENTS, type AguiEventName } from './agui.ts';
import { uiCommandSchema } from './ui.ts';

/**
 * Shapes of the events this platform puts on the wire — the half of AG-UI
 * conformance that a package name and a switch statement cannot answer.
 *
 * **Why this file exists.** Conformance used to be checked against the OpenUI
 * parser: whatever `processStreamedMessage` consumed was, by definition, what
 * the platform emitted. That check cannot see the events the parser ignores,
 * and those are precisely the ones the application depends on — `RUN_STARTED`,
 * `RUN_FINISHED`, `RUN_ERROR` and every `CUSTOM`. A field dropped from a
 * `CUSTOM` payload would have passed it silently.
 *
 * Two references, and they answer different questions:
 *
 *  - `@ag-ui/core` (the very copy `@openuidev/react-headless` depends on) says
 *    whether an event is a valid AG-UI event at all. Checked in
 *    `tests/agui-conformance.test.ts`, against a real run's real bytes.
 *  - the schemas below say whether it is the event *this platform promises*:
 *    AG-UI's own schemas are deliberately permissive about `CUSTOM` (`name` and
 *    an arbitrary `value`), so they cannot tell `{ spaceId }` from `{}`.
 *
 * **The version field.** Every `CUSTOM` payload carries
 * `version: PLATFORM_CUSTOM_PAYLOAD_VERSION`. `CUSTOM` is the escape hatch of
 * the protocol: nothing in AG-UI describes what is inside one, so a consumer
 * that is not this repository's own client — another tab of an older build, a
 * replayed event log written months ago, a second application on the same
 * stream — has no way to tell a payload it understands from one it does not.
 * The number is stamped in one place (`RunEventStream.custom`), so it cannot
 * drift between producers.
 */

/** Current shape version of every platform `CUSTOM` payload. */
export const PLATFORM_CUSTOM_PAYLOAD_VERSION = 1;

/**
 * A payload of exactly these fields, and no others.
 *
 * `z.strictObject`, not `z.object`: a plain object schema **strips** unknown
 * keys, so it answers "are the fields I expect present and well typed" and says
 * nothing about a field somebody added by accident — which is half of what this
 * file claims to be for. Strict makes the second half true as well: a payload
 * that grew a key nobody wrote down fails the conformance check instead of
 * passing it quietly.
 */
const versioned = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject({ version: z.literal(PLATFORM_CUSTOM_PAYLOAD_VERSION), ...shape });

/**
 * One schema per `CUSTOM` name this platform emits.
 *
 * Typed as a total map over `PLATFORM_CUSTOM_EVENTS`, so a new custom event
 * without a payload schema is a compile error rather than an unvalidated
 * payload nobody notices. That is the guard the previous state lacked: the
 * names were enumerated, the payloads were not described anywhere.
 */
export const platformCustomPayloadSchemas = {
  [PLATFORM_CUSTOM_EVENTS.canvasChanged]: versioned({ spaceId: z.string().min(1) }),
  [PLATFORM_CUSTOM_EVENTS.dataChanged]: versioned({ resources: z.array(z.string().min(1)) }),
  [PLATFORM_CUSTOM_EVENTS.artifactCreated]: versioned({ artifactId: z.string().min(1) }),
  [PLATFORM_CUSTOM_EVENTS.runCancelled]: versioned({ runId: z.string().min(1) }),
  [PLATFORM_CUSTOM_EVENTS.permissionRequest]: versioned({
    requestId: z.string().min(1),
    runId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.string(),
  }),
  [PLATFORM_CUSTOM_EVENTS.permissionResolved]: versioned({
    requestId: z.string().min(1),
    runId: z.string().min(1),
    allowed: z.boolean(),
  }),
  [PLATFORM_CUSTOM_EVENTS.sessionBound]: versioned({
    sessionId: z.string().min(1),
    conversationId: z.string().min(1),
  }),
  [PLATFORM_CUSTOM_EVENTS.sessionTranscriptLost]: versioned({
    conversationId: z.string().min(1),
    lostSessionId: z.string().min(1),
    newSessionId: z.string().min(1),
    memoryRestored: z.literal(false),
    bindingCleared: z.boolean(),
    detectedBy: z.string().min(1),
  }),
  /*
   * The interface command already had a schema — it is the one payload a client
   * validates before acting on it — so this reuses it rather than restating it.
   * A second description of one shape is a second thing to forget to update.
   */
  [PLATFORM_CUSTOM_EVENTS.uiCommand]: uiCommandSchema
    .extend({ version: z.literal(PLATFORM_CUSTOM_PAYLOAD_VERSION) })
    .strict(),
} satisfies Record<(typeof PLATFORM_CUSTOM_EVENTS)[keyof typeof PLATFORM_CUSTOM_EVENTS], z.ZodType>;

export type PlatformCustomEventName = keyof typeof platformCustomPayloadSchemas;

/** True when this is a `CUSTOM` name the platform describes. */
export const isPlatformCustomEvent = (name: unknown): name is PlatformCustomEventName =>
  typeof name === 'string' && name in platformCustomPayloadSchemas;

/**
 * Shapes of the non-`CUSTOM` events, including the platform's own additions.
 *
 * `RUN_FINISHED.durationMs` is the addition, and it is written down here
 * because AG-UI does not model it: without a line saying so, an extension is
 * indistinguishable from a field somebody added by accident, and the protocol's
 * own schema — which strips unknown keys — will never object to either. Strict
 * here for the same reason as the payloads above: an extension nobody declared
 * has to fail the check rather than be quietly dropped.
 */
export const platformAguiEventSchemas = {
  [AGUI_EVENTS.RUN_STARTED]: z.strictObject({
    type: z.literal(AGUI_EVENTS.RUN_STARTED),
    threadId: z.string().min(1),
    runId: z.string().min(1),
  }),
  [AGUI_EVENTS.RUN_FINISHED]: z.strictObject({
    type: z.literal(AGUI_EVENTS.RUN_FINISHED),
    threadId: z.string().min(1),
    runId: z.string().min(1),
    /** Platform extension: execution time, excluding the wait in the queue. */
    durationMs: z.number().int().nonnegative().optional(),
  }),
  [AGUI_EVENTS.RUN_ERROR]: z.strictObject({
    type: z.literal(AGUI_EVENTS.RUN_ERROR),
    message: z.string(),
    /** Platform extension: the failure taxonomy the interface shows. */
    code: z.string().min(1),
  }),
  [AGUI_EVENTS.TEXT_MESSAGE_START]: z.strictObject({
    type: z.literal(AGUI_EVENTS.TEXT_MESSAGE_START),
    messageId: z.string().min(1),
    role: z.literal('assistant'),
  }),
  [AGUI_EVENTS.TEXT_MESSAGE_CONTENT]: z.strictObject({
    type: z.literal(AGUI_EVENTS.TEXT_MESSAGE_CONTENT),
    messageId: z.string().min(1),
    delta: z.string().min(1),
  }),
  [AGUI_EVENTS.TEXT_MESSAGE_END]: z.strictObject({
    type: z.literal(AGUI_EVENTS.TEXT_MESSAGE_END),
    messageId: z.string().min(1),
  }),
  [AGUI_EVENTS.TOOL_CALL_START]: z.strictObject({
    type: z.literal(AGUI_EVENTS.TOOL_CALL_START),
    toolCallId: z.string().min(1),
    toolCallName: z.string().min(1),
    parentMessageId: z.string().min(1),
  }),
  [AGUI_EVENTS.TOOL_CALL_ARGS]: z.strictObject({
    type: z.literal(AGUI_EVENTS.TOOL_CALL_ARGS),
    toolCallId: z.string().min(1),
    delta: z.string(),
  }),
  [AGUI_EVENTS.TOOL_CALL_END]: z.strictObject({
    type: z.literal(AGUI_EVENTS.TOOL_CALL_END),
    toolCallId: z.string().min(1),
  }),
  [AGUI_EVENTS.TOOL_CALL_RESULT]: z.strictObject({
    type: z.literal(AGUI_EVENTS.TOOL_CALL_RESULT),
    messageId: z.string().min(1),
    toolCallId: z.string().min(1),
    content: z.string(),
    role: z.literal('tool'),
    /** Platform extension: a tool that failed, told apart from one that did not. */
    isError: z.literal(true).optional(),
    error: z.string().optional(),
  }),
  [AGUI_EVENTS.CUSTOM]: z.strictObject({
    type: z.literal(AGUI_EVENTS.CUSTOM),
    name: z.string().min(1),
    value: z.unknown(),
  }),
} satisfies Partial<Record<AguiEventName, z.ZodType>>;

export type PlatformEmittedEventName = keyof typeof platformAguiEventSchemas;

/**
 * Event names this platform emits.
 *
 * Not every name in `AGUI_EVENTS`: `STATE_SNAPSHOT` is declared by the protocol
 * and never produced here, and saying so is the point — a conformance check
 * that accepted anything in the enum would pass a stream of events nothing in
 * this application knows how to make.
 */
export const PLATFORM_EMITTED_EVENTS = Object.keys(
  platformAguiEventSchemas,
) as PlatformEmittedEventName[];
