import { z } from 'zod';
import { canvasViewportSchema } from './canvas.ts';
import { UI_URL_MAX_LENGTH } from './ui-snapshot.ts';

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
  /**
   * The tab's interface description at the moment the command was sent: its
   * version, which tab, which view and address. Only the marker travels here —
   * the description itself is read with `ui_state`, which can then say whether
   * what it found is older or newer than what the user was looking at when
   * they asked. Null when the tab had not described its screen yet.
   */
  ui: z
    .object({
      version: z.number().int().min(1),
      clientId: z.string().max(80),
      viewId: z.string().max(120).nullable(),
      url: z.string().max(UI_URL_MAX_LENGTH),
      /** The address on screen is longer than `url`. */
      urlTruncated: z.boolean().optional(),
    })
    .nullable()
    .default(null),
});
export type AppContext = z.infer<typeof appContextSchema>;

/**
 * Parses the context of a command, tolerating a malformed screen marker.
 *
 * The marker (`ui`) only says which description of the screen the command was
 * sent from. A tab that got it wrong must not stop the user from sending
 * anything at all from that screen: the marker is dropped (`ui: null`) and the
 * reasons are returned for the caller to report. Anything else that fails
 * still fails.
 */
export function parseRunAppContext(raw: unknown): { context: AppContext; uiRejected: string[] | null } {
  const parsed = appContextSchema.safeParse(raw);
  if (parsed.success) return { context: parsed.data, uiRejected: null };
  const issues = parsed.error.issues;
  if (raw && typeof raw === 'object' && issues.every((i) => i.path[0] === 'ui')) {
    return {
      context: appContextSchema.parse({ ...(raw as Record<string, unknown>), ui: null }),
      uiRejected: issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }
  throw parsed.error;
}

export const EMPTY_APP_CONTEXT: AppContext = {
  conversationId: null,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
  ui: null,
};

export const runStatusSchema = z.enum([
  /** Accepted, waiting for the conversation's previous run to finish. */
  'queued',
  'running',
  /**
   * Executing, but stopped at the consent gate: a tool call is waiting for the
   * user's decision.
   *
   * A stored status rather than a screen state, because the whole point of the
   * criterion behind it (L11.19) is the case where nobody is looking: a client
   * that reloads, opens another conversation or comes back later asks
   * `GET /api/runs/active`, and a run parked on a question has to be in that
   * answer. It is *active* — cancellable, still holding its workspace — so it
   * is not a terminal status.
   */
  'awaiting_consent',
  'succeeded',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Statuses that mean the run is still the backend's work. */
export const ACTIVE_RUN_STATUSES = ['queued', 'running', 'awaiting_consent'] as const;

/** The resolving statuses; exactly one of them is ever recorded per run. */
export type TerminalRunStatus = Exclude<RunStatus, (typeof ACTIVE_RUN_STATUSES)[number]>;

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
 *     policy, not the outcome. `subscription` (default) means the local OAuth
 *     login; `glm` means the explicit GLM/Z.AI mode (decyzja właściciela
 *     2026-09-20): the harness is still the Claude Agent SDK, the model calls
 *     go to an Anthropic-compatible GLM endpoint, and the OAuth credential is
 *     neither used nor read. There is no silent API-key path in either mode.
 *  2. **What do the local credential metadata say?** (`credential`) — whether a
 *     credential file is readable and whether its recorded expiry is in the
 *     past. A past expiry is *not* a verdict: the runtime may refresh the
 *     token. In `glm` mode this dimension is irrelevant and is reported as
 *     absent without the file being opened at all.
 *  3. **What happened the last time access was actually exercised?** (`access`)
 *     — the only dimension that can say the login works, because the only proof
 *     that it works is a call that succeeded.
 *
 * Reporting a present file as a working subscription — which this contract used
 * to do — makes an expired login indistinguishable from a healthy one.
 *
 * None of these fields ever carries a token value.
 */
export const authMethodSchema = z.enum(['subscription', 'glm', 'none']);
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

/**
 * What the **SDK session itself** says about how it authenticates.
 *
 * A fourth dimension, and the only one that is not this application's own
 * opinion: `method` above is the configured policy, `credential` is a file on
 * disk and `access` is the outcome of a run. None of the three can answer "did
 * the Claude Agent SDK use the subscription OAuth login, or an API key?" — the
 * SDK is the only party that knows, and it answers through a control request
 * (`accountInfo`) that costs no model turn.
 *
 * `unknown` is the honest default: the probe is explicit, not automatic, so a
 * status that was never probed says so rather than claiming a subscription.
 */
export const sdkSessionStateSchema = z.enum([
  /** No probe has been run in this process. */
  'unknown',
  /** OAuth subscription login: no API key source, first-party provider, a plan. */
  'subscription',
  /** An API key is the session's credential — outside this application's policy. */
  'api_key',
  /** The session authenticates in a way that is neither of the two above. */
  'other',
  /** The probe could not be performed (no CLI, no login, timeout). */
  'unavailable',
]);
export type SdkSessionState = z.infer<typeof sdkSessionStateSchema>;

/**
 * The redacted result of the session probe.
 *
 * Deliberately narrow. The SDK's `accountInfo()` also returns the account's
 * e-mail address and organisation name; neither is needed to answer "is this a
 * subscription session", both are personal data, and this application does not
 * carry personal data it has no use for. The probe copies the four fields
 * below and discards the rest — the same rule the credential reader follows.
 */
export const sdkSessionSchema = z.object({
  state: sdkSessionStateSchema,
  /**
   * Where the SDK's credential came from, verbatim: `ANTHROPIC_API_KEY`,
   * `apiKeyHelper`, `/login managed key`, `none`, or absent when no API key is
   * in use at all.
   */
  apiKeySource: z.string().nullable(),
  /** `firstParty` is Anthropic's own backend; anything else is a gateway or a cloud. */
  apiProvider: z.string().nullable(),
  /** The plan the *session* reports, which an API-key session does not have. */
  subscriptionType: z.string().nullable(),
  /**
   * Plan limit utilisation the session reports, in percent.
   *
   * `available: false` is itself a signal: plan limits do not exist for an API
   * key, Bedrock or Vertex session. These are readings of the real limit, never
   * a simulation of one, and a reading is not an exhaustion.
   */
  planLimits: z
    .object({
      available: z.boolean(),
      fiveHourPercent: z.number().nullable(),
      sevenDayPercent: z.number().nullable(),
    })
    .nullable(),
  checkedAt: z.string().nullable(),
  /** Why the probe could not answer. Never carries a token value. */
  error: z.string().nullable(),
});
export type SdkSession = z.infer<typeof sdkSessionSchema>;

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
  /** True when an Anthropic credential variable is visible in the environment. */
  apiKeyDetected: z.boolean(),
  /**
   * What the configuration does with what it detected: `refused` scrubs every
   * provider variable (the default subscription mode); `glm_explicit` passes
   * only the two GLM endpoint variables (`ANTHROPIC_BASE_URL`,
   * `ANTHROPIC_AUTH_TOKEN`) to the agent process and still scrubs
   * `ANTHROPIC_API_KEY`, Bedrock and Vertex. The field is a policy name —
   * never a credential value.
   */
  apiKeyPolicy: z.enum(['refused', 'glm_explicit']),
  cliVersion: z.string().nullable(),
  /** What the SDK session reports about itself; `unknown` until probed. */
  sdkSession: sdkSessionSchema,
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

/**
 * Whether the application should present itself as ready to run the agent.
 *
 * Deliberately permissive about a stale credential and deliberately strict
 * about a revoked one: the first may refresh on the next call, the second
 * cannot. The two configured methods differ in what counts as *their*
 * credential: the subscription requires the local OAuth file and treats an
 * API-key session as a policy violation, while the explicit GLM mode runs on
 * the endpoint token — an `api_key` session report is the **expected** answer
 * there, and the (unread, irrelevant) local file disqualifies nothing.
 * A revoked or refresh-refused access fails both: whatever provides the
 * credential, the last call said it was refused.
 */
export function authIsUsable(status: AuthStatus): boolean {
  if (status.method === 'glm') {
    return status.access.state !== 'revoked' && status.access.state !== 'refresh_refused';
  }
  if (status.method !== 'subscription') return false;
  if (!status.credential.present) return false;
  // A session the SDK itself says is running on an API key is outside the
  // policy this build states, whatever the local credential file looks like.
  if (status.sdkSession.state === 'api_key') return false;
  return status.access.state !== 'revoked' && status.access.state !== 'refresh_refused';
}

/**
 * Whether the interface may present the connection as **healthy**.
 *
 * Narrower than {@link authIsUsable} on purpose, and the difference is the
 * point of L8.9: a credential file that exists makes the application *usable*
 * (it is worth trying a run), but only a call that succeeded makes the
 * connection *confirmed*. The status bar used to show one green dot for both,
 * so "the file is there" and "the model answered" looked identical — including
 * after a failed run.
 */
export function authIsConfirmed(status: AuthStatus): boolean {
  return authIsUsable(status) && status.access.state === 'verified';
}

/** The empty session report: nothing has been probed yet. */
export const UNPROBED_SDK_SESSION: SdkSession = {
  state: 'unknown',
  apiKeySource: null,
  apiProvider: null,
  subscriptionType: null,
  planLimits: null,
  checkedAt: null,
  error: null,
};

/**
 * Name of the MCP server the platform exposes its tools through.
 *
 * Shared because the exposed name (`mcp__app__<tool>`) is what the model sees,
 * what the run stream reports as `toolCallName`, and what the browser matches a
 * renderer against — three places that must agree, in three packages.
 */
export const MCP_SERVER_NAME = 'app';

/** A tool's local name as the agent and the interface see it. */
export const mcpToolName = (localName: string): string => `mcp__${MCP_SERVER_NAME}__${localName}`;
