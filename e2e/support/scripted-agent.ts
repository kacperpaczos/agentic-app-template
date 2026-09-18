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
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
   *
   * `inline` decides **when** the hooks fire, and it is the difference between
   * two orderings the acceptance criteria name separately:
   *
   *  - omitted (the long-standing behaviour): they fire while the script is
   *    being expanded, before the stream opens. Every tool call of the run
   *    therefore reaches the runtime *before* its first word, which is the
   *    common "tool, then answer" case the existing scenarios were written
   *    against — and the reason none of them could reproduce the other one.
   *  - `true`: they fire at this step's position in the stream, so text emitted
   *    before it really does arrive first. That is what makes "text, then tool"
   *    and "several tools, with text between them" scenarios possible at all.
   *
   * Left as a flag rather than changed outright: the announced-before-the-stream
   * behaviour is what the existing measurements were taken against, and
   * silently moving it would alter other packages' green tests.
   */
  | { kind: 'tool'; name: string; input: unknown; result?: string; error?: string; inline?: boolean }
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
  | {
      kind: 'call';
      name: string;
      input?: CallInput;
      maxChars?: number;
    }
  /** Time passing with nothing emitted — lets the browser settle and repaint. */
  | { kind: 'wait'; delayMs: number }
  /**
   * Time passing that a cancellation **interrupts**, as a real await would.
   *
   * Separate from `wait` on purpose. `wait` finishes its delay before the abort
   * signal is looked at, which is what the existing cancellation measurements
   * were taken against: they assert that the run's workspace still exists at the
   * moment the Stop request is acknowledged, and an instantly-waking wait would
   * narrow that window to nothing and make somebody else's green test flaky.
   * Scenarios that have to sit idle for minutes — a run waiting to be stopped or
   * to hit its ceiling — use this one.
   */
  | { kind: 'idle'; delayMs: number }
  /**
   * Asks the runtime's permission gate, exactly where the SDK asks it.
   *
   * The stand-in calls `sdkOptions.canUseTool(toolName, input)` — the real gate,
   * which emits the real request into the real stream and waits for the real
   * HTTP answer — and plays `then` **only if it was allowed**. Without this the
   * consent path could not be driven from a browser test at all: a scripted run
   * that never called the gate made "Odmowa leaves the operation undone"
   * untestable without spending a model turn.
   *
   * The answer is echoed into the conversation as `[zgoda:<tool>] allowed=…`, so
   * the decision is visible to the test as well as its effect.
   */
  | { kind: 'ask'; toolName: string; input?: Record<string, unknown>; then?: Step[] }
  /** Writes a file into `output/` of the run workspace, as sandboxed code would. */
  | { kind: 'writeOutput'; path: string; content: string }
  /**
   * Runs a real Node script inside the run workspace — what `Bash` would do.
   *
   * The script is written into the workspace and executed with the workspace as
   * its working directory, so it resolves the analysis libraries exactly as
   * model-authored code does. Its standard output is echoed into the answer, so
   * a browser test reads facts the script derived from the actual file bytes.
   */
  | { kind: 'workspaceScript'; script: string; maxChars?: number }
  /**
   * Starts a real OS child process bound to the run's abort signal.
   *
   * Stands in for a shell command the run left behind: it exists so a Stop
   * measurement can count the server's descendant processes before, during and
   * after, instead of stopping at a status in the database.
   */
  | { kind: 'spawnChild' }
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

/**
 * The arguments of a `call` step: an object, or a function of the calls this
 * run has already made — for a call that needs what an earlier one returned (a
 * record id, a card id), the way a model would read it from the previous
 * result.
 *
 * Deliberately *not* `unknown | ((earlier: CallRecord[]) => unknown)`:
 * `unknown` absorbs every other member of a union, so the whole type collapsed
 * to `unknown`, the callback form lost its contextual type, and every
 * `input: (calls) => …` in the scenarios was written with an implicitly `any`
 * parameter — fourteen errors the shared typecheck could not see because it did
 * not cover `e2e/` at all.
 */
export type CallInput = Record<string, unknown> | ((earlier: CallRecord[]) => Record<string, unknown>);

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
  /** The same guarantee for `inline` tool announcements, in their own space. */
  let inlineSeq = 0;
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
    /**
     * Turns steps into the emission list the generator below plays.
     *
     * `tool` steps are the exception and are fired here, before the stream
     * opens, which is how they have always behaved — the announced-only tool
     * activity of the existing scenarios depends on it. Everything else is
     * performed in order *while* the answer streams, because a call may depend
     * on what an earlier step did to the interface, the data or the workspace.
     */
    const expand = async (list: Step[]): Promise<Array<Record<string, unknown>>> => {
      const out: Array<Record<string, unknown>> = [];
      for (const step of list) {
        if (step.kind === 'tool' && step.inline) {
          // Fired where it stands, inside the stream — see the `inline` note on
          // the step type.
          out.push({ type: 'tool', step });
        } else if (step.kind === 'tool') {
          seq += 1;
          const id = `tu_${seq}`;
          await fire('PreToolUse', { tool_use_id: id, tool_name: step.name, tool_input: step.input });
          if (step.error !== undefined) {
            await fire('PostToolUseFailure', { tool_use_id: id, error: step.error });
          } else {
            await fire('PostToolUse', { tool_use_id: id, tool_response: step.result ?? 'ok' });
          }
        } else if (step.kind === 'text') {
          out.push({ type: 'text-delta', payload: { text: step.text }, delayMs: step.delayMs ?? 0 });
        } else if (step.kind === 'wait') {
          out.push({ type: 'wait', delayMs: step.delayMs });
        } else if (step.kind === 'ui') {
          out.push({ type: 'ui', step });
        } else if (step.kind === 'fail') {
          out.push({ type: 'error', payload: { error: new Error(step.message) } });
        } else {
          // `call`, `ask`, `writeOutput`, `workspaceScript`, `spawnChild`.
          out.push({ type: step.kind, step });
        }
      }
      return out;
    };
    const emissions = await expand(steps);
    await fire('Stop', { session_id: 'sess_scripted' });

    /** What the previous `ui` or `call` step answered, for `$last.` placeholders. */
    let lastResult: unknown = null;
    const calls: CallRecord[] = [];
    /*
     * Honours the abort signal, as the real SDK does. Without this a scripted
     * run would ignore a cancellation and finish anyway — which would make a
     * cancellation test measure nothing.
     */
    const signal: AbortSignal | undefined = options?.signal;
    const canUseTool = options?.sdkOptions?.canUseTool as
      | ((name: string, input: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>)
      | undefined;
    /* Recursive, so an `ask` can carry the steps its approval unlocks. */
    const perform = async function* (
      list: Array<Record<string, unknown>>,
    ): AsyncGenerator<Record<string, unknown>> {
        for (const e of list) {
          // Deltas are spaced out so the browser can observe growth, which is
          // what a streaming assertion has to see.
          if (e.delayMs) await new Promise((r) => setTimeout(r, e.delayMs as number));
          if (signal?.aborted) throw signal.reason ?? new Error('run cancelled');
          // A `wait` is elapsed time and nothing else — never an event.
          if (e.type === 'wait') continue;
          if (e.type === 'tool') {
            const step = e.step as Extract<Step, { kind: 'tool' }>;
            inlineSeq += 1;
            const id = `tu_inline_${inlineSeq}`;
            await fire('PreToolUse', { tool_use_id: id, tool_name: step.name, tool_input: step.input });
            if (step.error !== undefined) {
              await fire('PostToolUseFailure', { tool_use_id: id, error: step.error });
            } else {
              await fire('PostToolUse', { tool_use_id: id, tool_response: step.result ?? 'ok' });
            }
            continue;
          }
          if (e.type === 'call') {
            const step = e.step as Extract<Step, { kind: 'call' }>;
            const localName = step.name.replace(/^mcp__app__/, '');
            const input = resolveLastResult(
              (typeof step.input === 'function' ? step.input(calls) : step.input) ?? {},
              lastResult,
            );
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
            let parsed: unknown = text;
            let isJson = false;
            try {
              parsed = JSON.parse(text);
              isJson = true;
            } catch {
              /* kept as text */
            }
            calls.push({ name: localName, ok: !outcome.isError, result: parsed });
            lastResult = isJson ? parsed : null;

            if (outcome.isError) await fire('PostToolUseFailure', { tool_use_id: id, error: text });
            else await fire('PostToolUse', { tool_use_id: id, tool_response: text });

            yield {
              type: 'text-delta',
              payload: { text: `[call:${localName}] ${shorten(text, step.maxChars ?? CALL_ECHO_CHARS)} ` },
            };
            continue;
          }
          if (e.type === 'idle') {
            const step = e.step as Extract<Step, { kind: 'idle' }>;
            await new Promise<void>((done) => {
              if (signal?.aborted) return done();
              const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                done();
              }, step.delayMs);
              const onAbort = () => {
                clearTimeout(timer);
                done();
              };
              signal?.addEventListener('abort', onAbort, { once: true });
            });
            if (signal?.aborted) throw signal.reason ?? new Error('run cancelled');
            continue;
          }
          if (e.type === 'writeOutput') {
            const step = e.step as Extract<Step, { kind: 'writeOutput' }>;
            const dir = options?.toolContext?.workspaceDir;
            if (!dir) throw new Error('scenariusz: brak workspace uruchomienia');
            writeFileSync(resolve(dir, 'output', step.path), step.content, 'utf8');
            continue;
          }
          if (e.type === 'workspaceScript') {
            const step = e.step as Extract<Step, { kind: 'workspaceScript' }>;
            const dir = options?.toolContext?.workspaceDir;
            if (!dir) throw new Error('scenariusz: brak workspace uruchomienia');
            const file = resolve(dir, 'przetworz.mjs');
            writeFileSync(file, step.script, 'utf8');
            let out: string;
            try {
              out = execFileSync(process.execPath, [file], {
                cwd: dir,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
              }).trim();
            } catch (err) {
              // A script that fails is reported as a failure, not as a result:
              // the corrupt-file case has to be distinguishable from success.
              const reason = (err as { stderr?: Buffer | string }).stderr?.toString() ?? String(err);
              yield {
                type: 'text-delta',
                payload: { text: `[skrypt] blad=${shorten(reason.replace(/\s+/g, ' '), 300)} ` },
              };
              continue;
            }
            yield {
              type: 'text-delta',
              payload: { text: `[skrypt] ${shorten(out, step.maxChars ?? CALL_ECHO_CHARS)} ` },
            };
            continue;
          }
          if (e.type === 'spawnChild') {
            /*
             * A real process of the server, bound to the run's abort signal the
             * way the SDK binds its own — so "the run's processes ended" is
             * something an outside observer can count, not a flag.
             */
            /*
             * Long-lived, but not immortal: it exits by itself after five
             * minutes. A run's child is supposed to die with the run, and it
             * does — but a *broken* version of that binding (which is exactly
             * what a detection trial installs) would otherwise leave a process
             * spinning on the machine for ever once the test server is gone.
             * Five minutes is far longer than any assertion here waits, so it
             * weakens nothing and bounds the damage of a failing trial.
             */
            const child = spawn(
              process.execPath,
              ['-e', 'setTimeout(() => process.exit(0), 300000)'],
              { stdio: 'ignore' },
            );
            const kill = () => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            };
            if (signal?.aborted) kill();
            else signal?.addEventListener('abort', kill, { once: true });
            yield { type: 'text-delta', payload: { text: `[proces] pid=${child.pid} ` } };
            continue;
          }
          if (e.type === 'ask') {
            const step = e.step as Extract<Step, { kind: 'ask' }>;
            if (!canUseTool) throw new Error('scenariusz: runtime nie przekazal bramki canUseTool');
            const outcome = await canUseTool(step.toolName, step.input ?? {});
            const allowed = outcome.behavior === 'allow';
            yield {
              type: 'text-delta',
              payload: { text: `[zgoda:${step.toolName}] allowed=${allowed} ` },
            };
            // The work happens only on an allow — that is the whole property.
            if (allowed && step.then) yield* perform(await expand(step.then));
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
            lastResult = outcome;
            const sorted = outcome.sorted as { field: string; direction: string } | null | undefined;
            const paged = outcome.page as { index: number; count: number } | undefined;
            /*
             * Changes of presentation the client made to show the target — a
             * narrowing cleared, a page turned, a collapsed section opened.
             * Echoed by kind because the acknowledgement carries them and the
             * user is told about them: a test that only sees `executed=true`
             * cannot tell "it was already on screen" from "we opened something
             * to get to it".
             */
            const adjusted = (outcome.adjustments as Array<{ kind: string }> | undefined)
              ?.map((a) => a.kind)
              .join(',');
            yield {
              type: 'text-delta',
              payload: {
                text:
                  `[ui:${step.label ?? step.targetId}] executed=${outcome.executed} ` +
                  `reason=${outcome.reason ?? '-'} ` +
                  (counted ? `pokazane=${counted.matched}/${counted.total} ` : '') +
                  (sorted !== undefined ? `sortowanie=${sorted ? `${sorted.field}:${sorted.direction}` : '-'} ` : '') +
                  (paged ? `strona=${paged.index}/${paged.count} ` : '') +
                  (adjusted ? `zmiany=${adjusted} ` : '') +
                  (outcome.uiVersion !== undefined ? `uiVersion=${outcome.uiVersion} ` : '') +
                  (outcome.uiClientId !== undefined ? `uiClientId=${outcome.uiClientId} ` : ''),
              },
            };
            continue;
          }
          yield e;
        }
    };
    return { fullStream: perform(emissions) };
  };
  return { stream: (p, o) => play(promptOf(p), o), resumeStream: (i, o) => play(promptOf(i), o) };
}
