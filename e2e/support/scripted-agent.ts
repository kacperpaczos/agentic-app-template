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
   */
  | {
      kind: 'call';
      name: string;
      /**
       * The arguments, or a function of the calls this run has already made —
       * for a call that needs what an earlier one returned (a record id, a card
       * id), the way a model would read it from the previous result.
       */
      input?: unknown | ((earlier: CallRecord[]) => unknown);
      maxChars?: number;
    }
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
      /** Order to apply; `null` restores the view's own order. */
      sort?: { field: string; direction: 'asc' | 'desc' } | null;
    }
  | { kind: 'fail'; message: string };

/** A `call` step already performed in this run: the tool and its parsed answer. */
export interface CallRecord {
  name: string;
  ok: boolean;
  result: any;
}

export interface ScriptedAgentOptions {
  /**
   * The tools a `call` step may run, resolved when the step plays — the
   * platform that owns them usually does not exist yet when the agent is built.
   */
  tools?: () => ToolEntry[];
}

/** Default length of the result echoed into the answer by a `call` step. */
const CALL_ECHO_CHARS = 1200;

const shorten = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** The user's message as the adapter receives it: a string, or `{ message }` when resuming. */
const promptOf = (input: unknown): string =>
  typeof input === 'string'
    ? input
    : typeof (input as { message?: unknown })?.message === 'string'
      ? (input as { message: string }).message
      : '';

/**
 * `script` is a fixed list of steps, or a function choosing them from the
 * user's message — so one scenario can answer several commands of a
 * conversation differently, as a browser test sends them.
 */
export function scriptedAgent(
  script: Step[] | ((prompt: string) => Step[]),
  opts: ScriptedAgentOptions = {},
): ModelAgentLike {
  /*
   * Tool call ids of `call` steps are unique for the life of the agent, as a
   * provider's are. Restarting them in every run made the chat pair a call of
   * an earlier turn with the result of a later one carrying the same id, so a
   * successful call was shown as failed once a later turn's call failed.
   */
  let callSeq = 0;
  const play = async (prompt: string, options: any) => {
    const steps = typeof script === 'function' ? script(prompt) : script;
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

    const calls: CallRecord[] = [];
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
            const input = (typeof step.input === 'function' ? step.input(calls) : step.input) ?? {};
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
            calls.push({
              name: localName,
              ok: !outcome.isError,
              result: (() => {
                try {
                  return JSON.parse(text);
                } catch {
                  return text;
                }
              })(),
            });

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
              sort?: { field: string; direction: 'asc' | 'desc' } | null;
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
                ...(step.sort !== undefined ? { sort: step.sort } : {}),
              })) as Record<string, unknown>;
            }
            const counted = outcome.filtered as { matched: number; total: number } | undefined;
            const sorted = outcome.sorted as { field: string; direction: string } | null | undefined;
            const paged = outcome.page as { index: number; count: number } | undefined;
            yield {
              type: 'text-delta',
              payload: {
                text:
                  `[ui:${step.label ?? step.targetId}] executed=${outcome.executed} ` +
                  `reason=${outcome.reason ?? '-'} ` +
                  (counted ? `pokazane=${counted.matched}/${counted.total} ` : '') +
                  (sorted !== undefined ? `sortowanie=${sorted ? `${sorted.field}:${sorted.direction}` : '-'} ` : '') +
                  (paged ? `strona=${paged.index}/${paged.count} ` : ''),
              },
            };
            continue;
          }
          yield e;
        }
      })(),
    };
  };
  return { stream: (p, o) => play(promptOf(p), o), resumeStream: (i, o) => play(promptOf(i), o) };
}
