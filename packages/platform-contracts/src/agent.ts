import { z } from 'zod';
import { canvasViewportSchema } from './canvas.ts';

/**
 * Application context the frontend attaches to every run.
 *
 * Validated server-side. It selects *what the user is looking at*; it never
 * grants access. Ownership is always taken from the authenticated session, so a
 * forged `ownerId` here is meaningless (there is deliberately no such field).
 */
export const appContextSchema = z.object({
  conversationId: z.string().nullable(),
  spaceId: z.string().nullable(),
  /** Module-defined resource the user is on, e.g. { kind: 'case', id: '...' }. */
  resource: z
    .object({ kind: z.string().max(80), id: z.string().max(128) })
    .nullable()
    .default(null),
  /** Cards / rows the user selected. */
  selection: z
    .array(z.object({ kind: z.string().max(80), id: z.string().max(128) }))
    .max(50)
    .default([]),
  /** Active UI filters, module-defined. */
  filters: z.record(z.string(), z.unknown()).default({}),
  viewport: canvasViewportSchema.nullable().default(null),
  /**
   * Unsaved form state, explicitly labelled as a draft. The agent is instructed
   * that drafts are NOT stored data and must not be treated as facts.
   */
  drafts: z
    .array(
      z.object({
        formId: z.string().max(120),
        entity: z.string().max(80),
        entityId: z.string().max(128).nullable(),
        dirtyFields: z.array(z.string().max(80)).max(60),
      }),
    )
    .max(20)
    .default([]),
});
export type AppContext = z.infer<typeof appContextSchema>;

export const EMPTY_APP_CONTEXT: AppContext = {
  conversationId: null,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
};

export const runStatusSchema = z.enum([
  /** Accepted, waiting for the conversation's previous run to finish. */
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const agentRunSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  ownerId: z.string(),
  status: runStatusSchema,
  claudeSessionId: z.string().nullable(),
  /*
   * Three distinct instants, because collapsing them hides exactly the things
   * worth measuring:
   *   enqueuedAt — the request was accepted and the run row created;
   *   startedAt  — the run reached the head of its conversation queue and began
   *                executing (equal to `enqueuedAt` when nothing was ahead of it);
   *   finishedAt — a terminal status was recorded.
   */
  enqueuedAt: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** Milliseconds spent waiting in the conversation queue before execution. */
  queuedMs: z.number().int().nullable(),
  /** Milliseconds from *execution start* to the first streamed text token. */
  firstTokenMs: z.number().int().nullable(),
  /** Milliseconds from execution start to the terminal status. */
  durationMs: z.number().int().nullable(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

/**
 * Authentication status, surfaced to Settings.
 *
 * Three questions that used to be collapsed into one, and must not be:
 *
 *  1. **How is this installation configured to sign in?** (`method`) — the
 *     policy, not the outcome. It is `subscription`, always; there is no API-key
 *     path to fall back to.
 *  2. **What do the local credential metadata say?** (`credential`) — whether a
 *     credential file is readable and whether its recorded expiry is in the
 *     past. A past expiry is *not* a verdict: the runtime may refresh the token.
 *  3. **What happened the last time access was actually exercised?** (`access`)
 *     — the only dimension that can say the login works, because the only proof
 *     that it works is a call that succeeded.
 *
 * Reporting a present file as a working subscription — which this contract used
 * to do — makes an expired login indistinguishable from a healthy one.
 *
 * None of these fields ever carries a token value.
 */
export const authMethodSchema = z.enum(['subscription', 'none']);
export type AuthMethod = z.infer<typeof authMethodSchema>;

export const credentialStateSchema = z.enum([
  /** No credential file, or no subscription block inside it. */
  'absent',
  /** Present and its recorded expiry is in the future. */
  'valid',
  /** Present but the recorded expiry has passed; refresh may still succeed. */
  'stale',
  /** Present but unparseable. */
  'unreadable',
]);
export type CredentialState = z.infer<typeof credentialStateSchema>;

export const accessStateSchema = z.enum([
  /** Not exercised since this process started. Says nothing either way. */
  'unverified',
  /** A real subscription call succeeded. */
  'verified',
  /** The subscription's usage limit was reached. The login itself is fine. */
  'rate_limited',
  /** The credential was expired and the runtime could not renew it. */
  'refresh_refused',
  /** The login was revoked or rejected; signing in again is required. */
  'revoked',
  /** Reached the model and failed for some other reason. */
  'failed',
]);
export type AccessState = z.infer<typeof accessStateSchema>;

export const authStatusSchema = z.object({
  method: authMethodSchema,
  credential: z.object({
    present: z.boolean(),
    /** e.g. "max", "pro" — reported by the local credential store. */
    subscriptionType: z.string().nullable(),
    expiresAt: z.string().nullable(),
    state: credentialStateSchema,
  }),
  access: z.object({
    state: accessStateSchema,
    lastVerifiedAt: z.string().nullable(),
    lastError: z.string().nullable(),
    lastErrorAt: z.string().nullable(),
  }),
  /** True when an ANTHROPIC_API_KEY is visible; the app refuses to use it. */
  apiKeyDetected: z.boolean(),
  apiKeyPolicy: z.literal('refused'),
  cliVersion: z.string().nullable(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

/**
 * Whether the application should present itself as ready to run the agent.
 *
 * Deliberately permissive about a stale credential and deliberately strict
 * about a revoked one: the first may refresh on the next call, the second
 * cannot.
 */
export function authIsUsable(status: AuthStatus): boolean {
  if (status.method !== 'subscription') return false;
  if (!status.credential.present) return false;
  return status.access.state !== 'revoked' && status.access.state !== 'refresh_refused';
}
