import { z } from 'zod';
import { agentRunSchema, consentModeSchema } from './agent.ts';

/**
 * The task view behind the global task center (L11.6).
 *
 * This is a **projection**, not a second owner of state: the truth about a task
 * stays in the run registry (`agent_runs`, `run_events`) and the file and
 * artifact services. The center assembles those records into one operational
 * description — intent, status, progress, tools, input files, artifacts and
 * error — because the user is owed a single place to handle background work,
 * independent of which conversation happens to be open.
 *
 * Progress fields are counters, not a percentage: an agent run does not know
 * its step count in advance, so any percent would be invented. Freshness is
 * readable from `progress.lastEventAt` and from watching the numbers move.
 */

export const taskProgressSchema = z.object({
  /** Tool calls started (`TOOL_CALL_START`); includes calls a gate refused. */
  toolCallsStarted: z.number().int().nonnegative(),
  /** Tool calls finished (`TOOL_CALL_END`). */
  toolCallsFinished: z.number().int().nonnegative(),
  /** Text fragments received (`TEXT_MESSAGE_CONTENT`). */
  textParts: z.number().int().nonnegative(),
  /** Artifacts published by this run, per the artifact registry. */
  artifactsPublished: z.number().int().nonnegative(),
  /** Time of the run's last event; null before the first one arrives. */
  lastEventAt: z.string().nullable(),
});
export type TaskProgress = z.infer<typeof taskProgressSchema>;

export const taskToolUseSchema = z.object({
  name: z.string(),
  calls: z.number().int().positive(),
});
export type TaskToolUse = z.infer<typeof taskToolUseSchema>;

export const taskFileRefSchema = z.object({
  id: z.string(),
  filename: z.string(),
});
export type TaskFileRef = z.infer<typeof taskFileRefSchema>;

export const taskArtifactRefSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  mode: z.string(),
});
export type TaskArtifactRef = z.infer<typeof taskArtifactRefSchema>;

/**
 * The question a run is parked on, surfaced through the task center (L11.19).
 *
 * Strict so a field added here has to be a field the interface was meant to
 * read: the answer endpoint takes only `requestId` and `allow`, and a stray
 * key in this object would otherwise travel to the browser unnoticed.
 * `input` is the raw JSON value the agent passed to the tool — shown, never
 * re-executed; answering goes through `POST /api/runs/:id/permission` and is
 * bound to the run and its owner there.
 */
export const pendingPermissionSchema = z.strictObject({
  requestId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
});
export type PendingPermission = z.infer<typeof pendingPermissionSchema>;

export const taskViewSchema = z.object({
  /** The truth about status, instants and error — fields passed through, not copied. */
  run: agentRunSchema,
  conversationId: z.string(),
  conversationTitle: z.string(),
  /** The command the task started from. Never rewritten after the fact. */
  intent: z.string(),
  /**
   * The consent mode the run was started with, stated at the top level so the
   * center can badge a task without reaching into `run` — and so the mode a
   * background task runs under is visible exactly where the task is handled.
   */
  consentMode: consentModeSchema,
  progress: taskProgressSchema,
  /** Tools used by this run, with call counts. */
  tools: z.array(taskToolUseSchema),
  /** Files attached to the command; empty for rows recorded before this contract. */
  inputFiles: z.array(taskFileRefSchema),
  /** Output artifacts linked to this run. */
  artifacts: z.array(taskArtifactRefSchema),
  /**
   * Present only while the run is parked at the consent gate; absent — the
   * key itself, not `null` — the moment the question is answered, expired or
   * released. The center renders it as "czeka na zgode" and offers the two
   * answers.
   */
  pendingPermission: pendingPermissionSchema.optional(),
});
export type TaskView = z.infer<typeof taskViewSchema>;

/**
 * The center's response body: active tasks first (oldest first), then finished
 * ones (newest first). The limit bounds both parts together.
 */
export const taskListSchema = z.object({
  tasks: z.array(taskViewSchema),
});
export type TaskList = z.infer<typeof taskListSchema>;

/** A retry's result: a new run, in the same conversation. */
export const taskRetryResultSchema = z.object({
  run: agentRunSchema,
  conversationId: z.string(),
});
export type TaskRetryResult = z.infer<typeof taskRetryResultSchema>;
