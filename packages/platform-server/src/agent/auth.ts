import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AccessState, AuthStatus, CredentialState } from '@platform/contracts';

/**
 * Reports how the Claude runtime is authenticated.
 *
 * Read the contract note on `authStatusSchema` first: this module answers three
 * separate questions (configured method, local credential metadata, last
 * verified access) and never collapses them, because a credential file that
 * exists is not evidence that signing in works.
 *
 * **On reading the credential file.** This module does parse
 * `~/.claude/.credentials.json`, in full — there is no way to report the plan
 * and the expiry without parsing the object that contains them. What it
 * guarantees is narrower and checkable:
 *
 *  - only `subscriptionType` and `expiresAt` are copied out of the parsed value;
 *  - `accessToken` and `refreshToken` are never referenced, returned, stored,
 *    logged or transmitted, and the parsed object is discarded on return;
 *  - the file is only ever *read*. Renewal belongs to the Claude Agent SDK,
 *    which reads and rewrites the same file on its own; this application is
 *    never on that path and must never implement a token flow of its own.
 *  - `tests/runtime.test.ts` takes the real token value from disk and asserts it
 *    appears in no output this application produces.
 */

/* --------------------------- last verified access -------------------------- */

interface AccessRecord {
  state: AccessState;
  lastVerifiedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

let access: AccessRecord = {
  state: 'unverified',
  lastVerifiedAt: null,
  lastError: null,
  lastErrorAt: null,
};

/**
 * Classifies why a run could not reach the model.
 *
 * The distinctions matter operationally: a usage limit means wait, a refused
 * refresh or a revoked login means sign in again, and everything else means
 * something broke. Collapsing them — as a single `unauthenticated` code did —
 * tells the user to re-login when their subscription has simply run out for the
 * window.
 */
export function classifyAccessFailure(message: string): AccessState {
  const m = message.toLowerCase();
  if (
    m.includes('usage limit') ||
    m.includes('rate limit') ||
    m.includes('rate_limit') ||
    m.includes('quota') ||
    m.includes('429') ||
    m.includes('too many requests')
  ) {
    return 'rate_limited';
  }
  if (
    m.includes('refresh') &&
    (m.includes('fail') || m.includes('refus') || m.includes('invalid') || m.includes('expired'))
  ) {
    return 'refresh_refused';
  }
  if (
    m.includes('revoked') ||
    m.includes('logged out') ||
    m.includes('please run /login') ||
    m.includes('/login') ||
    m.includes('unauthorized') ||
    m.includes('401') ||
    m.includes('invalid_grant') ||
    m.includes('invalid api key') ||
    m.includes('authentication_error')
  ) {
    return 'revoked';
  }
  if (m.includes('oauth') || m.includes('authenticat') || m.includes('credential')) {
    return 'revoked';
  }
  return 'failed';
}

/** Records the outcome of a real attempt to reach the model. */
export function recordVerification(ok: boolean, error?: string): void {
  const at = new Date().toISOString();
  if (ok) {
    access = { state: 'verified', lastVerifiedAt: at, lastError: null, lastErrorAt: null };
    return;
  }
  const message = error ?? 'nieznany blad';
  access = {
    state: classifyAccessFailure(message),
    // A failure does not erase the fact that access worked earlier; the two are
    // different facts and the UI shows both.
    lastVerifiedAt: access.lastVerifiedAt,
    lastError: message,
    lastErrorAt: at,
  };
}

/** Test seam: resets the process-local access record. */
export function resetVerification(): void {
  access = { state: 'unverified', lastVerifiedAt: null, lastError: null, lastErrorAt: null };
}

/* ------------------------------ local metadata ----------------------------- */

function cliVersion(): string | null {
  try {
    return (
      execFileSync('claude', ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .split('\n')[0] ?? null
    );
  } catch {
    return null;
  }
}

export interface CredentialMetadata {
  present: boolean;
  subscriptionType: string | null;
  expiresAt: string | null;
  state: CredentialState;
}

export function readCredentialMetadata(
  credFile: string,
  now: number = Date.now(),
): CredentialMetadata {
  const absent: CredentialMetadata = {
    present: false,
    subscriptionType: null,
    expiresAt: null,
    state: 'absent',
  };
  if (!existsSync(credFile)) return absent;

  let oauth: { subscriptionType?: unknown; expiresAt?: unknown } | undefined;
  try {
    const parsed = JSON.parse(readFileSync(credFile, 'utf8')) as {
      claudeAiOauth?: { subscriptionType?: unknown; expiresAt?: unknown };
    };
    oauth = parsed.claudeAiOauth;
  } catch {
    return { present: false, subscriptionType: null, expiresAt: null, state: 'unreadable' };
  }
  if (!oauth) return absent;

  const expiresAtMs = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null;

  return {
    present: true,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
    expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
    /*
     * `stale` is a statement about the recorded expiry, not a verdict on access.
     * The SDK holds a refresh token and renews on its own, so a past expiry
     * routinely still works — which is why nothing in this application refuses
     * to start a run on the strength of this field.
     */
    state: expiresAtMs !== null && expiresAtMs <= now ? 'stale' : 'valid',
  };
}

export function credentialFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'), '.credentials.json');
}

export function probeAuth(env: NodeJS.ProcessEnv = process.env, now = Date.now()): AuthStatus {
  const credential = readCredentialMetadata(credentialFilePath(env), now);

  return {
    // The configured method, not the outcome: this build has no API-key path.
    method: 'subscription',
    credential,
    access: { ...access },
    apiKeyDetected: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    apiKeyPolicy: 'refused',
    cliVersion: cliVersion(),
  };
}

/**
 * Environment handed to the Claude Agent SDK child process.
 *
 * Two separate jobs:
 *
 * 1. **Subscription only.** Every variable that could route the run through a
 *    paid API, a gateway, Bedrock or Vertex is removed, so the policy is
 *    enforced rather than assumed.
 *
 * 2. **Harness isolation.** If this backend is itself started from inside a
 *    Claude Code session, the child inherits that session's bridge variables
 *    (`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_SESSION_ID`, ...) and attaches
 *    to the *enclosing* agent instead of running standalone. The observable
 *    symptom is that the application's own MCP server is missing while the
 *    outer harness's tools appear in its place. Everything matching
 *    `CLAUDE_CODE_*` is therefore dropped, except `CLAUDE_CONFIG_DIR`, which is
 *    how the SDK finds the subscription credential.
 */
const PROVIDER_OVERRIDES = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_MODEL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
]);

const HARNESS_KEEP = new Set(['CLAUDE_CONFIG_DIR']);

const HARNESS_EXTRA = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'AI_AGENT']);

export function subscriptionOnlyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (PROVIDER_OVERRIDES.has(k)) continue;
    if (HARNESS_EXTRA.has(k)) continue;
    if (k.startsWith('CLAUDE_CODE_') && !HARNESS_KEEP.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Names removed from the child environment; surfaced in diagnostics. */
export function scrubbedEnvKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter(
    (k) =>
      PROVIDER_OVERRIDES.has(k) ||
      HARNESS_EXTRA.has(k) ||
      (k.startsWith('CLAUDE_CODE_') && !HARNESS_KEEP.has(k)),
  );
}
