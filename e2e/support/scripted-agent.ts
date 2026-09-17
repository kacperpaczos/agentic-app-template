/**
 * The scripted stand-in for the model, separate from the server that hosts it.
 *
 * Installed at the adapter boundary (`ModelAgentLike`), it receives the very
 * `sdkOptions` the Claude Agent SDK would — hooks included — and the run's
 * `toolContext`, and plays a list of steps. Everything around it is the real
 * runtime. Kept in its own module so that a unit test can drive a run with it
 * without starting a server; `scripted-server.ts` hosts the named scenarios.
 *
 * Results obtained with it are simulations and are reported as such.
 */
import {
  invokeTool,
  mcpToolName,
  type ModelAgentLike,
  type ToolEntry,
  type ToolInvocationResult,
} from '@platform/server';

export type Step =
  | { kind: 'text'; text: string; delayMs?: number }
  /**
   * A tool call that is *announced only*: hooks fire with the given result, and
   * no handler runs. For exercising how the interface shows tool activity.
   */
  | { kind: 'tool'; name: string; input: unknown; result?: string; error?: string }
  /**
   * A tool call that is *performed*: the real handler of a platform or module
   * tool runs with the run's context, through the same validation and error
   * mapping as the MCP server (`invokeTool`). PreToolUse / PostToolUse (or
   * PostToolUseFailure) fire with the actual outcome, and the answer receives
   * `[call:<name>] <result JSON, shortened>` so a browser test can read it.
   *
   * `name` is the tool's local name (`ui_catalog`, `procurement_list_cases`) or
   * its exposed one (`mcp__app__ui_catalog`).
   *
   * A string `"$last.<path>"` anywhere in `input` is replaced by that value of
   * the previous `ui` or `call` step's result (see {@link LAST_RESULT}) — how a
   * scenario hands a version from one step's answer to the next call, as a
   * model would. A path the previous result does not have becomes `null`, so
   * the tool's own validation refuses the call visibly instead of the property
   * silently disappearing.
   */
  | { kind: 'call'; name: string; input?: unknown; maxChars?: number }
  /** Time passing with nothing emitted — lets the browser settle and repaint. */
  | { kind: 'wait'; delayMs: number }
  /**
   * Asks the browser to move the interface, through the real runtime gate, and
   * records what the client reported back.
   */
  | {
      kind: 'ui';
      targetId: string;
      spaceId?: string;
      label?: string;
      /** Narrowing to apply; `null` restores the full view. */
      filter?: { predicates: Array<{ field: string; op: string; value: unknown }>; label: string } | null;
    }
  | { kind: 'fail'; message: string };

export interface ScriptedAgentOptions {
  /**
   * The tools a `call` step may run, resolved when the step plays — the
   * platform that owns them usually does not exist yet when the agent is built.
   */
  tools?: () => ToolEntry[];
}

/**
 * Prefix of a placeholder resolved from the previous `ui` or `call` result,
 * e.g. `{ minVersion: '$last.uiVersion' }`.
 */
export const LAST_RESULT = '$last.';

/** Replaces `"$last.<path>"` strings in a call's input with values from the previous result. */
export function resolveLastResult(input: unknown, last: unknown): unknown {
  if (typeof input === 'string' && input.startsWith(LAST_RESULT)) {
    let value: unknown = last;
    for (const key of input.slice(LAST_RESULT.length).split('.')) {
      value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
    }
    return value === undefined ? null : value;
  }
  if (Array.isArray(input)) return input.map((v) => resolveLastResult(v, last));
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, resolveLastResult(v, last)]));
  }
  return input;
}

/** Default length of the result echoed into the answer by a `call` step. */
const CALL_ECHO_CHARS = 1200;

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function scriptedAgent(steps: Step[], opts: ScriptedAgentOptions = {}): ModelAgentLike {
  const play = async (options: any) => {
    const hooks = options?.sdkOptions?.hooks ?? {};
    const fire = async (event: string, payload: Record<string, unknown>) => {
      for (const group of hooks[event] ?? []) {
        for (const hook of group.hooks ?? []) await hook({ hook_event_name: event, ...payload });
      }
    };
    await fire('SessionStart', { session_id: 'sess_scripted' });

    let seq = 0;
    const emissions: Array<Record<string, unknown>> = [];
    for (const step of steps) {
      if (step.kind === 'tool') {
        seq += 1;
        const id = `tu_${seq}`;
        await fire('PreToolUse', { tool_use_id: id, tool_name: step.name, tool_input: step.input });
        if (step.error !== undefined) {
          await fire('PostToolUseFailure', { tool_use_id: id, error: step.error });
        } else {
          await fire('PostToolUse', { tool_use_id: id, tool_response: step.result ?? 'ok' });
        }
      } else if (step.kind === 'text') {
        emissions.push({ type: 'text-delta', payload: { text: step.text }, delayMs: step.delayMs ?? 0 });
      } else if (step.kind === 'wait') {
        emissions.push({ type: 'wait', delayMs: step.delayMs });
      } else if (step.kind === 'ui') {
        emissions.push({ type: 'ui', step });
      } else if (step.kind === 'call') {
        // Performed in order while the answer streams, not up front: a call may
        // depend on what an earlier step did to the interface or the data.
        emissions.push({ type: 'call', step });
      } else {
        emissions.push({ type: 'error', payload: { error: new Error(step.message) } });
      }
    }
    await fire('Stop', { session_id: 'sess_scripted' });

    let callSeq = 0;
    /** What the previous `ui` or `call` step answered, for `$last.` placeholders. */
    let lastResult: unknown = null;
    /*
     * Honours the abort signal, as the real SDK does. Without this a scripted
     * run would ignore a cancellation and finish anyway — which would make a
     * cancellation test measure nothing.
     */
    const signal: AbortSignal | undefined = options?.signal;
    return {
      fullStream: (async function* () {
        for (const e of emissions) {
          // Deltas are spaced out so the browser can observe growth, which is
          // what a streaming assertion has to see.
          if (e.delayMs) await new Promise((r) => setTimeout(r, e.delayMs as number));
          if (signal?.aborted) throw signal.reason ?? new Error('run cancelled');
          // A `wait` is elapsed time and nothing else — never an event.
          if (e.type === 'wait') continue;
          if (e.type === 'call') {
            const step = e.step as Extract<Step, { kind: 'call' }>;
            const localName = step.name.replace(/^mcp__app__/, '');
            const input = resolveLastResult(step.input ?? {}, lastResult);
            callSeq += 1;
            const id = `tu_call_${callSeq}`;
            await fire('PreToolUse', { tool_use_id: id, tool_name: mcpToolName(localName), tool_input: input });

            const entry = opts.tools?.().find((t) => t.localName === localName);
            const ctx = options?.toolContext;
            const refusal = (error: string, message: string): ToolInvocationResult => ({
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ error, message, details: null }) }],
            });
            const outcome = !entry
              ? refusal('not_found', `Nieznane narzedzie ${localName}.`)
              : !ctx
                ? refusal('unsupported_operation', 'Brak kontekstu wykonania dla wywolania narzedzia.')
                : await invokeTool(entry, input, ctx);
            const text = outcome.content.map((c) => c.text).join('');
            try {
              lastResult = JSON.parse(text);
            } catch {
              lastResult = null;
            }

            if (outcome.isError) await fire('PostToolUseFailure', { tool_use_id: id, error: text });
            else await fire('PostToolUse', { tool_use_id: id, tool_response: text });

            yield {
              type: 'text-delta',
              payload: { text: `[call:${localName}] ${shorten(text, step.maxChars ?? CALL_ECHO_CHARS)} ` },
            };
            continue;
          }
          if (e.type === 'ui') {
            /*
             * The real gate: this resolves only when the browser acknowledges,
             * or when the runtime times the command out. Whatever comes back is
             * reported verbatim, so a scenario cannot claim a navigation the
             * client did not perform.
             */
            const step = e.step as {
              targetId: string;
              spaceId?: string;
              label?: string;
              filter?: { predicates: unknown[]; label: string } | null;
            };
            const ctx = options?.toolContext;
            let outcome: Record<string, unknown> = { executed: false, reason: 'no_tool_context' };
            if (ctx?.requestUi) {
              outcome = (await ctx.requestUi({
                targetId: step.targetId,
                spaceId: step.spaceId ?? null,
                // `undefined` leaves any narrowing alone; `null` clears it.
                ...(step.filter !== undefined
                  ? {
                      filter:
                        step.filter === null
                          ? null
                          : { targetId: step.targetId, ...step.filter },
                    }
                  : {}),
              })) as Record<string, unknown>;
            }
            const counted = outcome.filtered as { matched: number; total: number } | undefined;
            lastResult = outcome;
            yield {
              type: 'text-delta',
              payload: {
                text:
                  `[ui:${step.label ?? step.targetId}] executed=${outcome.executed} ` +
                  `reason=${outcome.reason ?? '-'} ` +
                  (counted ? `pokazane=${counted.matched}/${counted.total} ` : '') +
                  (outcome.uiVersion !== undefined ? `uiVersion=${outcome.uiVersion} ` : ''),
              },
            };
            continue;
          }
          yield e;
        }
      })(),
    };
  };
  return { stream: (_p, o) => play(o), resumeStream: (_i, o) => play(o) };
}
