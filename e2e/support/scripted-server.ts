/**
 * Test-only server: the application, with a scripted stand-in where the model
 * would be.
 *
 * Everything else is the real thing — the same composition root, the same HTTP
 * app, the same built frontend, the same database. Only the model is replaced,
 * at the adapter boundary, so the browser can be driven through a run whose tool
 * calls, timings and failures are chosen by the test rather than by a model.
 *
 * Usage: node --experimental-transform-types e2e/support/scripted-server.ts
 * Env: PORT, APP_DATA_DIR, APP_WEB_DIST, SCRIPT (a scenario name below).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ModelAgentLike } from '@platform/server';
import { composeApp } from '../../apps/server/src/compose.ts';

type Step =
  | { kind: 'text'; text: string; delayMs?: number }
  | { kind: 'tool'; name: string; input: unknown; result?: string; error?: string }
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

/**
 * Scenarios the browser tests drive. Named so a spec reads as an intention
 * ("a run that calls a tool and then answers") rather than as a data structure.
 */
const SCENARIOS: Record<string, Step[]> = {
  'tool-then-text': [
    {
      kind: 'tool',
      name: 'mcp__app__canvas_add_card',
      input: { title: 'Podsumowanie', component: 'platform.markdown' },
      result: '{"cardId":"card_scripted"}',
    },
    /*
     * Several deltas, deliberately spaced: a streaming assertion has to watch
     * the answer *grow*, and it can only do that if there is time between the
     * pieces. Two deltas 60 ms apart were indistinguishable from one repaint.
     */
    { kind: 'text', text: 'Dodalem karte. ', delayMs: 300 },
    { kind: 'text', text: 'Widac na niej ', delayMs: 300 },
    { kind: 'text', text: 'podsumowanie ', delayMs: 300 },
    { kind: 'text', text: 'sprawy.', delayMs: 300 },
  ],
  'text-only': [
    { kind: 'text', text: 'Pierwsze zdanie odpowiedzi. ', delayMs: 300 },
    { kind: 'text', text: 'Drugie zdanie odpowiedzi. ', delayMs: 300 },
    { kind: 'text', text: 'Trzecie zdanie odpowiedzi. ', delayMs: 300 },
    { kind: 'text', text: 'Czwarte zdanie odpowiedzi.', delayMs: 300 },
  ],
  /** Long enough to be cancelled from the interface while it is still running. */
  'slow': [
    { kind: 'text', text: 'Zaczynam dluga odpowiedz. ', delayMs: 200 },
    ...Array.from({ length: 40 }, (_, i) => ({
      kind: 'text' as const,
      text: `fragment ${i + 1} `,
      delayMs: 500,
    })),
  ],
  /*
   * Negative control for the streaming check: the whole answer in a single
   * delta, immediately before the run ends.
   *
   * A test that claims to prove streaming has to fail here. If it passes, it was
   * only ever proving that an answer arrived — which the previous assertion in
   * `agent-ui.spec.ts` came close to doing, and which is the exact failure the
   * acceptance criteria name. The trailing `wait` keeps the run open long enough
   * for the browser to paint the burst, so the detector sees the honest worst
   * case (one full-length sample while running) rather than an accident of
   * batching.
   */
  'burst-at-end': [
    { kind: 'wait', delayMs: 900 },
    {
      kind: 'text',
      text:
        'Pierwsze zdanie odpowiedzi. Drugie zdanie odpowiedzi. ' +
        'Trzecie zdanie odpowiedzi. Czwarte zdanie odpowiedzi.',
    },
    { kind: 'wait', delayMs: 900 },
  ],
  /*
   * Second negative control: a run that does real work and says nothing.
   *
   * The conversation starters, the composer and the user's own message are on
   * screen for its whole duration, so a probe that counted any of them would
   * report growth here. It must report no answer at all.
   */
  'tool-only-silent': [
    { kind: 'wait', delayMs: 300 },
    {
      kind: 'tool',
      name: 'mcp__app__canvas_list_cards',
      input: { spaceId: 'sp_scripted' },
      result: '{"cards":[]}',
    },
    { kind: 'wait', delayMs: 900 },
  ],
  /* One navigation, to a platform screen that always exists. */
  'ui-open-files': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'ui', targetId: 'platform.files', label: 'pliki' },
    { kind: 'text', text: 'Otworzylem ekran plikow.' },
  ],
  /* A setting: shown and highlighted, never changed. */
  'ui-open-setting': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'ui', targetId: 'platform.settings.auth', label: 'ustawienie' },
    { kind: 'text', text: 'Pokazalem sekcje logowania.' },
  ],
  /* A target that is not in the catalog: the answer must be a refusal. */
  'ui-unknown': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'ui', targetId: 'platform.nie-ma-takiego', label: 'nieistniejacy' },
    { kind: 'text', text: 'Zglaszam brak celu.' },
  ],
  /*
   * A long run that navigates near its end. Used to prove that a command from a
   * conversation the user has left does not drag their screen back.
   */
  'ui-late-navigate': [
    { kind: 'text', text: 'Zaczynam prace w tle. ', delayMs: 200 },
    { kind: 'wait', delayMs: 2500 },
    { kind: 'ui', targetId: 'platform.settings', label: 'ustawienia' },
    { kind: 'text', text: 'Koniec pracy w tle.' },
  ],
  /*
   * Narrowing a view instead of retyping its rows into the conversation.
   *
   * The fixture has four suppliers, three of them Polish, so "3 of 4" is a
   * number the screen must actually produce — not one the scenario asserts.
   */
  'ui-filter-suppliers': [
    { kind: 'wait', delayMs: 150 },
    {
      kind: 'ui',
      targetId: 'procurement.data',
      label: 'zawezenie',
      filter: {
        predicates: [{ field: 'country', op: 'eq', value: 'PL' }],
        label: 'tylko dostawcy z Polski',
      },
    },
    { kind: 'text', text: 'Zawezilem widok.' },
  ],
  /* A property the view does not declare: the answer must be a refusal. */
  'ui-filter-unknown-field': [
    { kind: 'wait', delayMs: 150 },
    {
      kind: 'ui',
      targetId: 'procurement.data',
      label: 'zawezenie',
      filter: {
        predicates: [{ field: 'wojewodztwo', op: 'eq', value: 'mazowieckie' }],
        label: 'tylko mazowieckie',
      },
    },
    { kind: 'text', text: 'Zglaszam odmowe.' },
  ],
  /* Narrow, then put it back — the agent's own way out, beside the button. */
  'ui-filter-then-clear': [
    { kind: 'wait', delayMs: 150 },
    {
      kind: 'ui',
      targetId: 'procurement.data',
      label: 'zawezenie',
      filter: {
        predicates: [{ field: 'country', op: 'eq', value: 'FI' }],
        label: 'tylko dostawcy zagraniczni',
      },
    },
    { kind: 'wait', delayMs: 1200 },
    { kind: 'ui', targetId: 'procurement.data', label: 'pelny widok', filter: null },
    { kind: 'text', text: 'Przywrocilem pelny widok.' },
  ],
  'tool-error': [
    {
      kind: 'tool',
      name: 'mcp__app__canvas_add_card',
      input: { component: 'nie.istnieje' },
      error: 'Nieznany komponent "nie.istnieje".',
    },
    { kind: 'text', text: 'Nie udalo sie dodac karty.' },
  ],
  'run-failure': [
    { kind: 'text', text: 'Zaczynam...' },
    { kind: 'fail', message: 'Claude usage limit reached' },
  ],
};

function scriptedAgent(steps: Step[]): ModelAgentLike {
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
      } else {
        emissions.push({ type: 'error', payload: { error: new Error(step.message) } });
      }
    }
    await fire('Stop', { session_id: 'sess_scripted' });

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
            yield {
              type: 'text-delta',
              payload: {
                text:
                  `[ui:${step.label ?? step.targetId}] executed=${outcome.executed} ` +
                  `reason=${outcome.reason ?? '-'} ` +
                  (counted ? `pokazane=${counted.matched}/${counted.total} ` : ''),
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

const scenario = process.env.SCRIPT ?? 'tool-then-text';
const steps = SCENARIOS[scenario];
if (!steps) {
  console.error(`[scripted] nieznany scenariusz "${scenario}". Dostepne: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

const platform = composeApp({ modelAgent: scriptedAgent(steps) });
const { app, config } = platform;

const distDir = config.webDistDir ?? resolve(process.cwd(), 'apps/web/dist');
if (existsSync(distDir)) {
  app.use('/assets/*', serveStatic({ root: distDir, rewriteRequestPath: (p) => p }));
  app.get('*', serveStatic({ path: 'index.html', root: distDir }));
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[scripted] scenariusz=${scenario} port=${info.port} data=${config.dataDir}`);
});

const shutdown = () => {
  platform.services.runs.abortAll('scripted_shutdown');
  server.close(() => {
    platform.close();
    process.exit(0);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
