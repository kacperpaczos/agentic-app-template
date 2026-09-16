import { z } from 'zod';

/**
 * Semantic targets the agent may move the interface to.
 *
 * **Why a catalog and not free-form navigation.** Without one, an agent asked
 * to "switch to files" has nothing to act on, so it does the only thing it
 * can — describe a route in prose, and guess. Observed exactly that: asked for
 * the files screen, the agent called two unrelated read tools and then told the
 * user they had to create a purchase case first to see a tab that is in the
 * navigation unconditionally. A stated route the user must follow by hand is
 * not navigation, and a confident wrong answer is worse than a refusal.
 *
 * So targets are declared, named and enumerable. The agent asks what exists,
 * names one, and the client either performs it or reports why it could not.
 * A target that is not in the catalog cannot be navigated to, which is what
 * makes "no such target" a real answer instead of an improvised one.
 */

export const UI_TARGET_KINDS = ['view', 'section', 'setting', 'element'] as const;
export type UiTargetKind = (typeof UI_TARGET_KINDS)[number];

export const uiTargetSchema = z.object({
  /** Stable identifier, e.g. `platform.files`. Namespaced by its contributor. */
  id: z.string().min(3).max(120),
  kind: z.enum(UI_TARGET_KINDS),
  /** What a user would call it. */
  label: z.string().max(120),
  /** What the user sees when it opens — for the agent to pick correctly. */
  description: z.string().max(300),
  /** Route to open, for a target that lives on its own screen. */
  to: z.string().max(200).optional(),
  /**
   * Element to scroll to and highlight once the screen is open.
   *
   * A CSS selector chosen by the contributor, because only the contributor
   * knows its own markup. Resolved in the browser, and its absence is reported
   * as a failure rather than assumed.
   */
  selector: z.string().max(300).optional(),
});
export type UiTarget = z.infer<typeof uiTargetSchema>;

/**
 * What the client is asked to do.
 *
 * `reveal` is deliberately the only verb for a setting. Showing a control and
 * changing it are different acts with different consequences, and an agent that
 * can do the first must not be able to do the second by accident — so there is
 * no "set" here at all.
 */
export const uiCommandSchema = z.object({
  /** Idempotency key. A replayed event with a seen id must not act twice. */
  commandId: z.string().min(8).max(80),
  runId: z.string(),
  conversationId: z.string(),
  targetId: z.string(),
  /** Canvas space to switch to, when the target is a workspace. */
  spaceId: z.string().nullable().optional(),
  /** Why the agent is doing it, shown to the user. */
  reason: z.string().max(200).optional(),
});
export type UiCommand = z.infer<typeof uiCommandSchema>;

/** Why a UI command did not happen. Each one is a distinct, honest answer. */
export const UI_COMMAND_FAILURES = {
  /** No such target in the catalog reachable by this client. */
  unknownTarget: 'unknown_target',
  /** The target exists but its element is not in the document. */
  notPresent: 'not_present',
  /** The owner may not see it. */
  forbidden: 'forbidden',
  /**
   * The command came from a conversation the user is not looking at.
   *
   * Reported rather than performed: a task running in the background must not
   * yank the screen away from whatever its owner is doing now.
   */
  inactiveConversation: 'inactive_conversation',
  /** No client acknowledged in time — nothing is known to have happened. */
  noClient: 'no_client',
} as const;
export type UiCommandFailure = (typeof UI_COMMAND_FAILURES)[keyof typeof UI_COMMAND_FAILURES];

export const uiCommandResultSchema = z.object({
  commandId: z.string(),
  /** True only when the client actually moved. Never inferred from sending. */
  executed: z.boolean(),
  reason: z.string().optional(),
  /** Where the client ended up, as the client saw it. */
  url: z.string().optional(),
  targetId: z.string().optional(),
  /** True when the element was found, scrolled to and highlighted. */
  highlighted: z.boolean().optional(),
});
export type UiCommandResult = z.infer<typeof uiCommandResultSchema>;
