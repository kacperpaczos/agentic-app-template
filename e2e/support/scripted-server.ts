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
import { collectToolEntries, platformTools, type PlatformInstance } from '@platform/server';
import { composeApp } from '../../apps/server/src/compose.ts';
import { scriptedAgent, type Step } from './scripted-agent.ts';

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
  /*
   * A real tool call from the run: the handler of `ui_catalog` runs with the
   * run's context and its actual answer reaches the chat, tool activity and
   * text alike. Exercises the `call` step that later scenarios build on.
   */
  'call-ui-catalog': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'call', name: 'ui_catalog', maxChars: 4000 },
    { kind: 'text', text: 'Odczytalem katalog.' },
  ],
  /*
   * The view's state through the agent's real tools: the run first reads its
   * own context (what the client sent with the command), then narrows and
   * orders the suppliers through the actual `ui_filter` and `ui_sort` handlers
   * and the runtime's acknowledgement gate. Played again as a second command,
   * its `get_context` shows the state the first one left on screen.
   */
  'viewstate-filter-sort': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'call', name: 'get_context', maxChars: 3000 },
    {
      kind: 'call',
      name: 'ui_filter',
      input: {
        targetId: 'procurement.data',
        predicates: [{ field: 'country', op: 'eq', value: 'PL' }],
        label: 'tylko dostawcy z Polski',
      },
    },
    { kind: 'call', name: 'ui_sort', input: { targetId: 'procurement.data', field: 'name', direction: 'desc' } },
    { kind: 'text', text: 'Zawezilem i posortowalem widok.' },
  ],
  /*
   * The same narrowing and the same order asked for twice. The second time
   * nothing in the address changes, and the answer must still be the state on
   * screen — executed, with its counts — not `not_applied`.
   */
  'viewstate-repeat': [
    { kind: 'wait', delayMs: 150 },
    {
      kind: 'call',
      name: 'ui_filter',
      input: { targetId: 'procurement.data', predicates: [{ field: 'country', op: 'eq', value: 'PL' }], label: 'z Polski' },
    },
    { kind: 'call', name: 'ui_sort', input: { targetId: 'procurement.data', field: 'name', direction: 'desc' } },
    {
      kind: 'call',
      name: 'ui_filter',
      input: { targetId: 'procurement.data', predicates: [{ field: 'country', op: 'eq', value: 'PL' }], label: 'z Polski' },
    },
    { kind: 'call', name: 'ui_sort', input: { targetId: 'procurement.data', field: 'name', direction: 'desc' } },
    { kind: 'text', text: 'Powtorzylem zawezenie i sortowanie.' },
  ],
  /*
   * An exact narrowing on a text field (`eq`), which the user's controls, where
   * a text field means "contains", must not widen when a different field is
   * changed.
   */
  'viewstate-exact-name': [
    { kind: 'wait', delayMs: 150 },
    {
      kind: 'call',
      name: 'ui_filter',
      input: { targetId: 'procurement.data', predicates: [{ field: 'name', op: 'eq', value: 'NordAV' }], label: 'dokladnie NordAV' },
    },
    { kind: 'text', text: 'Zawezilem do nazwy NordAV.' },
  ],
  /*
   * Orders the view cannot take: a field the read does not have and one it
   * declares unsortable. Both must be refused by name, before the browser is
   * asked for anything, and the screen must stay as it was.
   */
  'viewstate-sort-refused': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'call', name: 'ui_sort', input: { targetId: 'procurement.data', field: 'wojewodztwo', direction: 'asc' } },
    { kind: 'call', name: 'ui_sort', input: { targetId: 'procurement.data', field: 'contactEmail', direction: 'asc' } },
    { kind: 'text', text: 'Zglaszam odmowy sortowania.' },
  ],
  /* The agent puts the view back: its own order, no narrowing, the first page. */
  'viewstate-clear': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'call', name: 'ui_sort', input: { targetId: 'procurement.data', clear: true } },
    { kind: 'call', name: 'ui_filter', input: { targetId: 'procurement.data', clear: true } },
    { kind: 'text', text: 'Przywrocilem domyslny widok.' },
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

const scenario = process.env.SCRIPT ?? 'tool-then-text';
const steps = SCENARIOS[scenario];
if (!steps) {
  console.error(`[scripted] nieznany scenariusz "${scenario}". Dostepne: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

/*
 * `call` steps run real tool handlers, so the agent needs the platform's tool
 * list — which exists only once the platform does. Resolved lazily, when a step
 * plays.
 */
let platform: PlatformInstance;
platform = composeApp({
  modelAgent: scriptedAgent(steps, {
    tools: () =>
      collectToolEntries({ registry: platform.registry, platformTools: platformTools(platform.services) }),
  }),
});
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
