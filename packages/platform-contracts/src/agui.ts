import { z } from 'zod';

/**
 * AG-UI wire contract.
 *
 * The event names follow the AG-UI protocol so the ready-made OpenUI
 * `agUIAdapter()` consumes the stream without a translation layer. Two CUSTOM
 * events carry platform concerns the protocol does not model (canvas edits and
 * artifact publication).
 */
export const AGUI_EVENTS = {
  RUN_STARTED: 'RUN_STARTED',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
  TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
  TOOL_CALL_END: 'TOOL_CALL_END',
  TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
  STATE_SNAPSHOT: 'STATE_SNAPSHOT',
  CUSTOM: 'CUSTOM',
} as const;

export type AguiEventName = (typeof AGUI_EVENTS)[keyof typeof AGUI_EVENTS];

/** `CUSTOM` payload names used by this platform. */
export const PLATFORM_CUSTOM_EVENTS = {
  canvasChanged: 'platform.canvas_changed',
  dataChanged: 'platform.data_changed',
  artifactCreated: 'platform.artifact_created',
  runCancelled: 'platform.run_cancelled',
  permissionRequest: 'platform.permission_request',
  /**
   * The decision on a permission request, whichever way it went — allowed,
   * refused, expired, or released because the run was stopped.
   *
   * **Why a question needs an answer event.** The request is in the run's
   * event log for ever, and a client that re-attaches replays the log: a reload
   * during a run whose question had already been answered showed the question
   * again, with nothing in the stream to say it was settled. The stale prompt
   * was answerable, and answering it did nothing at all — the gate resolves
   * once — so the interface asked for a decision it could not use. This event
   * is what a replay needs to arrive at the state the run is actually in.
   */
  permissionResolved: 'platform.permission_resolved',
  sessionBound: 'platform.session_bound',
  /**
   * The stored Claude session could not be resumed because its transcript is
   * gone. Carries what was lost and what was done about it, so the client can
   * say "the earlier context was not restored" instead of implying it was.
   */
  sessionTranscriptLost: 'platform.session_transcript_lost',
  /**
   * The agent asking the client to move the interface.
   *
   * A request, not a result: the client decides whether it can be performed and
   * acknowledges what actually happened. See `ui.ts`.
   */
  uiCommand: 'platform.ui_command',
} as const;

export const runAgentInputSchema = z.object({
  // Nullish, not just optional: a client starting a new conversation sends an
  // explicit `null`, which `.optional()` alone would reject.
  threadId: z.string().nullish(),
  runId: z.string().nullish(),
  messages: z.array(z.record(z.string(), z.unknown())).default([]),
  /** Frontend-supplied application context; validated separately. */
  context: z.unknown().optional(),
  forwardedProps: z.record(z.string(), z.unknown()).optional(),
  state: z.unknown().optional(),
  tools: z.array(z.unknown()).optional(),
});
export type RunAgentInput = z.infer<typeof runAgentInputSchema>;
