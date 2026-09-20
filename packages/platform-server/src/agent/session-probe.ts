import { query } from '@anthropic-ai/claude-agent-sdk';
import { UNPROBED_SDK_SESSION, type SdkSession } from '@platform/contracts';
import type { ModelProvider } from '../config.ts';
import { subscriptionOnlyEnv } from './auth.ts';

/**
 * Asks the Claude Agent SDK how **it** is authenticated.
 *
 * ## Why this exists
 *
 * Everything else this application can say about authentication is its own
 * opinion. `method: 'subscription'` is a constant in the source. The credential
 * file is a file. `access` records whether a run worked, which an API-key
 * session would also make work. None of them answers the question L8.2 and L8.3
 * actually ask — *did the SDK use the subscription OAuth login, or a paid API
 * key?* — and the only party that knows is the SDK.
 *
 * ## How it asks, and why it costs nothing
 *
 * The SDK's `Query` object exposes **control requests**: messages to the CLI
 * that are answered by the CLI itself and never reach a model. `accountInfo()`
 * is one of them. So this probe opens a session whose input is a stream that
 * never yields a message, asks its two questions, and closes it. No prompt is
 * sent, no turn is spent, and the subscription is not charged.
 *
 * Observed on `@anthropic-ai/claude-agent-sdk` 0.3.270 with a Claude Max login:
 *
 * ```
 * accountInfo() → { email, organization, subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
 * ```
 *
 * and, with `ANTHROPIC_API_KEY` present in the child environment:
 *
 * ```
 * accountInfo() → { tokenSource: 'claude.ai', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }
 * ```
 *
 * — no `subscriptionType`, and the plan limits report `rate_limits_available:
 * false`. The two are therefore distinguishable from the outside, which is what
 * makes "the API key is not the active path" a checkable statement rather than
 * a claim about environment hygiene.
 *
 * ## What it refuses to carry
 *
 * `accountInfo()` also returns the account's e-mail address and organisation
 * name. Neither is copied. The same rule as the credential reader: parse what
 * has to be parsed, keep the few fields the interface states, discard the rest
 * on return. Nothing here ever reaches a token value at all — the SDK does not
 * offer one through this interface.
 */

/** Shape of the SDK's answer this module reads. Structural, so a test can build one. */
export interface AccountInfoLike {
  subscriptionType?: string | null;
  tokenSource?: string | null;
  apiKeySource?: string | null;
  apiProvider?: string | null;
  /* `email` and `organization` exist on the SDK's type and are deliberately absent here. */
}

/** Shape of the plan-limit answer this module reads. */
export interface UsageInfoLike {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: { utilization?: number | null } | null;
    seven_day?: { utilization?: number | null } | null;
  } | null;
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const asNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Turns the SDK's two answers into the reported state.
 *
 * Pure, and exported, because the classification is the part worth asserting:
 * the probe itself is a process spawn, but "an `ANTHROPIC_API_KEY` source means
 * `api_key`, whatever else the answer says" is a rule.
 *
 * `'none'` is the SDK's way of saying *no API key is in use* — claude.ai OAuth,
 * a bearer token or a third-party provider — so it is not an API-key session.
 * Anything else non-empty is.
 */
export function classifySdkSession(
  account: AccountInfoLike | null | undefined,
  usage: UsageInfoLike | null | undefined,
  now: () => string = () => new Date().toISOString(),
): SdkSession {
  if (!account) {
    return { ...UNPROBED_SDK_SESSION, state: 'unavailable', checkedAt: now(), error: 'brak odpowiedzi sesji SDK' };
  }
  const apiKeySource = asString(account.apiKeySource);
  const apiProvider = asString(account.apiProvider);
  const subscriptionType = asString(account.subscriptionType) ?? asString(usage?.subscription_type);

  const limits = usage
    ? {
        available: usage.rate_limits_available === true,
        fiveHourPercent: asNumber(usage.rate_limits?.five_hour?.utilization),
        sevenDayPercent: asNumber(usage.rate_limits?.seven_day?.utilization),
      }
    : null;

  const state: SdkSession['state'] =
    apiKeySource !== null && apiKeySource !== 'none'
      ? 'api_key'
      : apiProvider === 'firstParty' && subscriptionType !== null
        ? 'subscription'
        : 'other';

  return {
    state,
    apiKeySource,
    apiProvider,
    subscriptionType,
    planLimits: limits,
    checkedAt: now(),
    error: null,
  };
}

/** Runs the probe, or reports why it could not. Never throws. */
export type SessionProbe = () => Promise<SdkSession>;

export interface ProbeOptions {
  env?: NodeJS.ProcessEnv;
  /** How long the control requests may take before the probe gives up. */
  timeoutMs?: number;
  /**
   * Whether to apply the subscription-only policy to the environment.
   *
   * On by default, because the probe exists to describe the path a **run**
   * would take, and a run's environment always goes through
   * `subscriptionOnlyEnv`. Turning it off has exactly one use, and it is a
   * diagnostic one: showing that the probe can *see* an API key when there is
   * one on the path. Without that control, "the application's environment
   * reports a subscription" could equally mean the probe is blind — and a
   * check that cannot fail is not a check.
   */
  applyPolicy?: boolean;
  /**
   * Which provider policy to apply when `applyPolicy` is on.
   *
   * The default `subscription` scrubs every provider variable; `glm` passes
   * the two GLM endpoint variables through, exactly as a run in that mode
   * would — the probe must describe the same environment the agent gets.
   */
  provider?: ModelProvider;
}

export async function probeSdkSession(opts: ProbeOptions = {}): Promise<SdkSession> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const checkedAt = () => new Date().toISOString();

  /*
   * An input stream that never yields. The session initialises, answers control
   * requests and waits — which is precisely the state in which no turn is spent.
   */
  let release = (): void => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  async function* neverAsks(): AsyncGenerator<never, void> {
    await gate;
  }

  let session: ReturnType<typeof query> | null = null;
  try {
    session = query({
      prompt: neverAsks() as never,
      options: {
        // The same isolation the runtime uses: the developer's own settings,
        // MCP servers and CLAUDE.md files must not take part in a diagnostic
        // either, and the paid-API variables are removed exactly as they are
        // for a run — which is what makes this probe an answer about the path
        // a real run would take.
        settingSources: [],
        env:
          opts.applyPolicy === false
            ? (Object.fromEntries(
                Object.entries(opts.env ?? process.env).filter(([, v]) => v !== undefined),
              ) as Record<string, string>)
            : subscriptionOnlyEnv(opts.env ?? process.env, opts.provider ?? 'subscription'),
        // A probe does nothing. Listing no allowed tool and forbidding the ones
        // that could act keeps that true even if a future SDK decided to start
        // a turn on its own.
        allowedTools: [],
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch'],
        maxTurns: 1,
      } as never,
    });

    const withTimeout = <T,>(p: Promise<T>): Promise<T | null> =>
      Promise.race([
        p.catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
      ]);

    const account = (await withTimeout(session.accountInfo())) as AccountInfoLike | null;
    /*
     * Experimental in the SDK and treated as such: its absence degrades the
     * report to "no plan limits", never to a failure. The name carries the
     * warning, and so does this comment — if 0.3.270's spelling disappears, the
     * probe still answers the question it exists for.
     */
    const usageFn = (
      session as unknown as {
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: {
          skipBehaviors?: boolean;
        }) => Promise<UsageInfoLike>;
      }
    ).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    const usage = usageFn
      ? ((await withTimeout(usageFn.call(session, { skipBehaviors: true }))) as UsageInfoLike | null)
      : null;

    if (!account) {
      return {
        ...UNPROBED_SDK_SESSION,
        state: 'unavailable',
        checkedAt: checkedAt(),
        error: 'sesja SDK nie odpowiedziala na zadanie sterujace w wyznaczonym czasie',
      };
    }
    return classifySdkSession(account, usage, checkedAt);
  } catch (err) {
    return {
      ...UNPROBED_SDK_SESSION,
      state: 'unavailable',
      checkedAt: checkedAt(),
      // Message only, and short: a probe failure is diagnostics, not a place to
      // paste whatever the CLI wrote to its error stream.
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    };
  } finally {
    release();
    try {
      await (session as unknown as { return?: (v?: unknown) => Promise<unknown> })?.return?.(undefined);
    } catch {
      /* the session is being discarded; how it ends does not change the answer */
    }
  }
}
