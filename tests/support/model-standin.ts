import { spawn } from 'node:child_process';
import { invokeTool, type ModelAgentLike, type ToolEntry } from '@platform/server';
import type { ToolCallContext } from '@platform/contracts';

/**
 * The scripted stand-in the measurement and diagnostics regressions drive the
 * runtime with.
 *
 * It is installed where the model is — at the `ModelAgentLike` boundary — and
 * receives the very `sdkOptions` (hooks included), `AbortSignal` and run
 * `toolContext` the Claude Agent SDK would. Everything around it is the real
 * application: the conversation queue, the run registry, the event stream, the
 * projection, the workspace, the MCP tool handlers.
 *
 * **Results obtained with it are simulations and are reported as such.** It
 * exists because the orderings these criteria are about — an answer with no
 * text at all, a stop landing mid-stream, a failure the model's stream reports
 * as opposed to one that stops the call from happening — are chosen by the
 * model and cannot be requested from it.
 */

export type Step =
  | { kind: 'text'; text: string; delayMs?: number }
  /** Time passing with nothing emitted. Interruptible, as a real await is. */
  | { kind: 'wait'; ms: number }
  /** A real tool call: the handler runs with the run's context, through `invokeTool`. */
  | { kind: 'call'; name: string; input?: unknown }
  /**
   * A tool the run is not allowed to use unattended, asked for the way the SDK
   * asks: through the `canUseTool` callback in `sdkOptions`.
   *
   * It is the only way a test can reach the consent gate without a model. The
   * gate lives in the runtime, is handed to the SDK, and is what turns a
   * request into a chat event and waits for the user's answer — so a scenario
   * that wants to observe consent has to come through the same door.
   */
  | { kind: 'permission'; toolName: string; input?: Record<string, unknown> }
  /** Starts a real OS child process bound to this run's abort signal. */
  | { kind: 'spawnChild' }
  /** The model's stream reports a failure — a stream existed and then failed. */
  | { kind: 'streamError'; message: string }
  /**
   * The call to the adapter never produces a stream at all. A different class
   * of failure from `streamError`, and the message alone cannot tell them apart.
   */
  | { kind: 'startFailure'; message: string };

export interface StandInHandle {
  /** Wall-clock instant the spawned child process exited, if one was spawned. */
  childExitedAt: number | null;
  childPid: number | null;
  /** Names of `call` steps that actually reached a tool handler. */
  performed: string[];
  /**
   * What each `call` step got back, in order.
   *
   * Recorded because "the tool ran" and "the tool ran with *this* run's
   * context" are different statements, and only the answer can tell them
   * apart: a leak between two parallel runs shows up as one run's tool
   * reporting the other's conversation, owner or data.
   */
  results: Array<{ name: string; text: string; isError: boolean }>;
  /** Outcome of each `permission` step: whether the gate allowed the tool. */
  consents: Array<{ toolName: string; allowed: boolean }>;
  /**
   * The Claude session this run asked the adapter to continue, or null for a
   * fresh one.
   *
   * It is what the runtime *asked for*, recorded where the SDK would receive
   * it. A second run on the same conversation must resume the session the first
   * one bound — and it can only do that if it re-reads the conversation when it
   * reaches the head of the queue, rather than when it was accepted.
   */
  resumedFrom: string | null;
  dispose: () => void;
}

/** A handle with every field at its empty value; scenarios fill it as they run. */
export const newStandInHandle = (): StandInHandle => ({
  childExitedAt: null,
  childPid: null,
  performed: [],
  results: [],
  consents: [],
  resumedFrom: null,
  dispose: () => {},
});

/** Sleeps, but wakes immediately on abort — the shape of every real await. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal?.aborted) return done();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      done();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      done();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export interface Plan {
  script: Step[];
  handle: StandInHandle;
}

/**
 * One stand-in for the whole harness, choosing its script from the user's
 * message.
 *
 * Deliberately not one stand-in per run: the conversation queue lives in the
 * `AgentRuntime`, so two runtimes would give every run an empty queue and the
 * queueing measurements would be measuring nothing. A provider answers many
 * conversations from one connection, and so does this.
 */
export function dispatchingAgent(plans: Map<string, Plan>, tools: () => ToolEntry[]): ModelAgentLike {
  const play = async (prompt: string, options: any) => {
    const plan = plans.get(prompt);
    if (!plan) throw new Error(`stand-in: brak scenariusza dla polecenia "${prompt}"`);
    const { script, handle } = plan;
    const hooks = options?.sdkOptions?.hooks ?? {};
    const signal: AbortSignal | undefined = options?.signal;
    const ctx: ToolCallContext | undefined = options?.toolContext;
    const fire = async (event: string, payload: Record<string, unknown>) => {
      for (const group of hooks[event] ?? []) {
        for (const hook of group.hooks ?? []) await hook({ hook_event_name: event, ...payload });
      }
    };
    const failFast = script.find((s): s is Extract<Step, { kind: 'startFailure' }> => s.kind === 'startFailure');
    if (failFast) throw new Error(failFast.message);
    await fire('SessionStart', { session_id: 'sess_pomiar' });

    let callSeq = 0;
    return {
      fullStream: (async function* () {
        for (const step of script) {
          if (signal?.aborted) throw signal.reason ?? new Error('cancelled_by_user');

          if (step.kind === 'wait') {
            await sleep(step.ms, signal);
            continue;
          }
          if (step.kind === 'spawnChild') {
            /*
             * A real process, bound to the run's abort signal the way the SDK
             * binds its own. It exists so "the run's processes ended" is an
             * instant observable from outside this process (a pid that exits)
             * rather than a bookkeeping flag — see the file header for what it
             * does and does not stand in for.
             */
            const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
              stdio: 'ignore',
            });
            handle.childPid = child.pid ?? null;
            child.once('exit', () => {
              handle.childExitedAt = Date.now();
            });
            const kill = () => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            };
            handle.dispose = kill;
            if (signal?.aborted) kill();
            else signal?.addEventListener('abort', kill, { once: true });
            continue;
          }
          if (step.kind === 'streamError') {
            yield { type: 'error', payload: { error: new Error(step.message) } };
            continue;
          }
          // Handled before the stream opened; unreachable here.
          if (step.kind === 'startFailure') continue;
          if (step.kind === 'permission') {
            const gate = options?.sdkOptions?.canUseTool as
              | ((name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>)
              | undefined;
            if (!gate) throw new Error('stand-in: brak bramki zgody w sdkOptions');
            const decision = await gate(step.toolName, step.input ?? {});
            handle.consents.push({ toolName: step.toolName, allowed: decision.behavior === 'allow' });
            continue;
          }
          if (step.kind === 'call') {
            callSeq += 1;
            const id = `tu_${callSeq}`;
            const entry = tools().find((t) => t.localName === step.name);
            if (!entry) throw new Error(`stand-in: nieznane narzedzie ${step.name}`);
            if (!ctx) throw new Error('stand-in: brak kontekstu wykonania');
            await fire('PreToolUse', {
              tool_use_id: id,
              tool_name: `mcp__app__${step.name}`,
              tool_input: step.input ?? {},
            });
            const outcome = await invokeTool(entry, step.input ?? {}, ctx);
            handle.performed.push(step.name);
            const text = outcome.content.map((c) => c.text).join('');
            handle.results.push({ name: step.name, text, isError: outcome.isError === true });
            if (outcome.isError) await fire('PostToolUseFailure', { tool_use_id: id, error: text });
            else await fire('PostToolUse', { tool_use_id: id, tool_response: text });
            continue;
          }

          if (step.delayMs) await sleep(step.delayMs, signal);
          if (signal?.aborted) throw signal.reason ?? new Error('cancelled_by_user');
          yield { type: 'text-delta', payload: { text: step.text } };
        }
      })(),
    };
  };

  /** The user's message as the adapter receives it: a string, or `{ message }`. */
  const promptOf = (input: unknown): string =>
    typeof input === 'string' ? input : String((input as { message?: unknown })?.message ?? '');

  return {
    stream: (p, o) => play(promptOf(p), o),
    resumeStream: (i, o) => {
      // Recorded before anything is played: what this run asked to continue is
      // a property of the call, not of what the script then does.
      const plan = plans.get(promptOf(i));
      if (plan) plan.handle.resumedFrom = i.sessionId;
      return play(promptOf(i), o);
    },
  };
}

