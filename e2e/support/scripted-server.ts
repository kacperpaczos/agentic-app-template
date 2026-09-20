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
import type { SdkSession } from '@platform/contracts';
import { composeApp } from '../../apps/server/src/compose.ts';
import { agentViewsScript } from './agent-views-scenario.ts';
import { compositionScript, messageKindsScript } from './bl10-scenarios.ts';
import { appContextScript } from './app-context-scenario.ts';
import {
  childProcessScript,
  consentScript,
  continuityScript,
  filesScript,
  idempotencyScript,
  neverEndingScript,
} from './bl09-scenarios.ts';
import { chatHistoryScript } from './chat-history-scenario.ts';
import {
  credentialReadScript,
  expiredButWorkingScript,
  limitScript,
  mutationThenLimitScript,
  networkScript,
  refreshRefusedScript,
  revokedScript,
} from './auth-scenarios.ts';
import { consentThenWorkScript, liveReconnectScript } from './bl08b-scenarios.ts';
import {
  bl03CanvasScript,
  bl03ConsentScript,
  bl03IsolationScript,
  bl03LifecycleScript,
  bl03RelationsScript,
  bl03T16Script,
  bl03T17Script,
} from './bl03-scenarios.ts';
import { interactionsScript } from './interactions-scenario.ts';
import { showValueScript } from './show-value-scenario.ts';
import { scriptedAgent, type CallRecord, type Step } from './scripted-agent.ts';

/** The case the artifact scenarios work on, read from the run's own first call. */
const firstCaseId = (calls: CallRecord[]): string => {
  const listed = calls.find((c) => c.name === 'procurement_list_cases');
  const found = listed?.result?.cases?.find((c: { code: string }) => c.code === 'PC-2026-01');
  if (!found) throw new Error('scenariusz: brak sprawy PC-2026-01');
  return found.id as string;
};

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
  /*
   * Text **before** the tool call, which no scenario could produce until the
   * `inline` announcement existed: the expansion pass fired every tool hook
   * before the stream opened, so "tool, then answer" was the only ordering the
   * browser could ever be shown.
   *
   * The markers are the scenario's own words, not the shell's, so the assertions
   * that read them do not break when a platform label is renamed.
   */
  'text-then-tool': [
    { kind: 'text', text: 'PROZA-PRZED-NARZEDZIEM ', delayMs: 250 },
    { kind: 'wait', delayMs: 400 },
    {
      kind: 'tool',
      inline: true,
      name: 'mcp__app__canvas_list_cards',
      input: { spaceId: 'sp_scripted' },
      result: '{"cards":[],"marker":"WYNIK-NARZEDZIA-A"}',
    },
    { kind: 'wait', delayMs: 900 },
    { kind: 'text', text: 'ODPOWIEDZ-PO-NARZEDZIU', delayMs: 250 },
  ],
  /* Two tools in one turn, with text between them — the other missing ordering. */
  'many-tools': [
    { kind: 'text', text: 'PROZA-PIERWSZA ', delayMs: 250 },
    {
      kind: 'tool',
      inline: true,
      name: 'mcp__app__canvas_list_cards',
      input: { spaceId: 'sp_scripted' },
      result: '{"cards":[],"marker":"WYNIK-NARZEDZIA-A"}',
    },
    { kind: 'text', text: 'PROZA-MIEDZY ', delayMs: 250 },
    {
      kind: 'tool',
      inline: true,
      name: 'mcp__app__ui_catalog',
      input: {},
      result: '{"targets":[],"marker":"WYNIK-NARZEDZIA-B"}',
    },
    { kind: 'wait', delayMs: 900 },
    { kind: 'text', text: 'ODPOWIEDZ-PO-NARZEDZIU', delayMs: 250 },
  ],
  /*
   * One announced tool whose successful answer carries a marker, then a short
   * reply. Separate from `tool-then-text` so that asserting on the *result*
   * cannot accidentally match the card title of somebody else's scenario.
   */
  'tool-result-visible': [
    {
      kind: 'tool',
      name: 'mcp__app__canvas_list_cards',
      input: { spaceId: 'sp_scripted' },
      result: '{"cards":[],"marker":"WYNIK-NARZEDZIA-A"}',
    },
    /*
     * Long enough for a browser test to open the tool's details and read them
     * *while the run is still running* — which is the half of L5.3 that the
     * previous assertions could not distinguish from "shown once it finished".
     */
    { kind: 'wait', delayMs: 4000 },
    { kind: 'text', text: 'Odczytalem karty. ', delayMs: 300 },
    { kind: 'text', text: 'ODPOWIEDZ-PO-NARZEDZIU', delayMs: 300 },
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
  /*
   * A setting inside a section that is closed: the element is in the document
   * and nothing of it is on screen. Showing it has to open the section first
   * and say that it did.
   */
  'ui-open-tools': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'ui', targetId: 'platform.settings.tools', label: 'narzedzia' },
    { kind: 'text', text: 'Pokazalem liste narzedzi.' },
  ],
  /*
   * One command that moves the screen and then reads it: the description the
   * next turn would be given has to describe where the user now is, not where
   * they were when the command started.
   */
  'ui-navigate-then-context': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'ui', targetId: 'platform.files', label: 'pliki' },
    {
      kind: 'call',
      name: 'ui_state',
      input: { minVersion: '$last.uiVersion', clientId: '$last.uiClientId' },
      // Long enough for the description's target to be in the echo the chat shows.
      maxChars: 700,
    },
    { kind: 'text', text: 'Otworzylem pliki i odczytalem ekran.' },
  ],
  /*
   * Navigates early and keeps running, so the run is still open when the tab
   * reloads and the backend replays its events from the start. The replayed
   * navigation must not happen a second time.
   */
  'ui-navigate-then-wait': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'ui', targetId: 'platform.files', label: 'pliki' },
    { kind: 'wait', delayMs: 12_000 },
    { kind: 'text', text: 'Koniec dlugiej pracy.' },
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
   * Reading the screen's description (`ui_state`), as the agent would.
   * The full results are in the conversation's tool messages; the chat shows
   * the start of each so a test can see which call answered what.
   */
  'ui-state-read': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'call', name: 'ui_state', maxChars: 160 },
    { kind: 'text', text: 'Odczytalem opis ekranu.' },
  ],
  /*
   * Narrow through the real `ui_filter` handler and gate, then read the screen
   * asking for at least the version the acknowledgement carried — and then the
   * context the command itself was sent with.
   */
  'ui-state-after-filter': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'call', name: 'ui_state', maxChars: 160 },
    {
      kind: 'call',
      name: 'ui_filter',
      input: {
        targetId: 'procurement.data',
        predicates: [{ field: 'country', op: 'eq', value: 'PL' }],
        label: 'tylko dostawcy z Polski',
      },
      maxChars: 400,
    },
    {
      kind: 'call',
      name: 'ui_state',
      input: { minVersion: '$last.uiVersion', clientId: '$last.uiClientId' },
      maxChars: 160,
    },
    { kind: 'call', name: 'get_context', maxChars: 160 },
    { kind: 'text', text: 'Opisalem ekran po zawezeniu.' },
  ],
  /* A version no tab has published: the answer must be stale, after the wait. */
  'ui-state-future-version': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'call', name: 'ui_state', input: { minVersion: 1_000_000, waitMs: 1500 }, maxChars: 160 },
    { kind: 'text', text: 'Nie mam tak nowego opisu.' },
  ],
  /* Reads the screen late, after the user may have moved to another conversation. */
  'ui-state-late': [
    { kind: 'text', text: 'Zaczynam prace w tle. ', delayMs: 200 },
    { kind: 'wait', delayMs: 10_000 },
    { kind: 'call', name: 'ui_state', maxChars: 160 },
    { kind: 'text', text: 'Koniec pracy w tle.' },
  ],
  /*
   * Order through the real `ui_sort` handler and gate, then read the screen with
   * the version and tab its acknowledgement carried.
   */
  'ui-state-after-sort': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'call', name: 'ui_sort', input: { targetId: 'procurement.data', field: 'name', direction: 'desc' }, maxChars: 400 },
    {
      kind: 'call',
      name: 'ui_state',
      input: { minVersion: '$last.uiVersion', clientId: '$last.uiClientId' },
      maxChars: 160,
    },
    { kind: 'text', text: 'Opisalem ekran po sortowaniu.' },
  ],
  /*
   * An agent view grouped by currency, the agent views screen opened through
   * the real `ui_navigate`, and the screen read with the version and tab of that
   * acknowledgement.
   */
  'ui-state-agent-views': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'call', name: 'procurement_list_cases', maxChars: 200 },
    {
      kind: 'call',
      name: 'agent_view_create',
      input: (calls: CallRecord[]) => {
        const listed = calls.find((c) => c.name === 'procurement_list_cases');
        const found = listed?.result?.cases?.find((c: { code: string }) => c.code === 'PC-2026-01');
        if (!found) throw new Error('scenariusz: brak sprawy PC-2026-01');
        return {
          title: 'Oferty wedlug waluty',
          source: [
            'root = Stack([tabela])',
            // Ordered by delivery time the currencies interleave, so grouping reorders the page on screen.
            `tabela = DataTable({operation: "procurement.comparison", input: {caseId: "${found.id}"}}, ["supplierName", "currency", "totalMinor", "deliveryDays"], "Oferty", null, null, {field: "deliveryDays", direction: "asc"}, "currency")`,
          ].join('\n'),
          operationId: 'e2e-scripted-server-ui-state-agent-views',
        };
      },
      maxChars: 300,
    },
    { kind: 'call', name: 'ui_navigate', input: { targetId: 'platform.agentViews' }, maxChars: 300 },
    {
      kind: 'call',
      name: 'ui_state',
      input: { minVersion: '$last.uiVersion', clientId: '$last.uiClientId' },
      maxChars: 160,
    },
    { kind: 'text', text: 'Opisalem widoki agenta.' },
  ],
  /*
   * An answer that is an OpenUI composition: the chat renders a data component
   * that stays mounted on whatever screen the user moves to — including
   * Settings, where the identity can be switched under it.
   */
  'chat-data-table': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'text', text: 'root = DataTable({operation: "procurement.suppliers"}, ["name", "country"])' },
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
  /*
   * A snapshot and a live artifact of the same comparison, both made by real
   * handlers: `procurement_save_comparison` freezes the numbers, the platform's
   * own `artifact_create` saves the question instead. The second is a *platform*
   * tool, so its answer carries `{ artifactId }` and the ready-made chat shows
   * the artifact under the call — which is the preview the browser test
   * compares against the full view in the artifact browser.
   */
  'artifact-snapshot-and-live': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'call', name: 'procurement_list_cases', maxChars: 200 },
    {
      kind: 'call',
      name: 'procurement_save_comparison',
      /*
       * `operationId` is required of both writes below: a tool that creates a
       * durable record demands a key, so a retry after a reconnect replays
       * instead of making a second artifact (L9.7). A scripted agent names it
       * the way a real one has to — one identifier per intended operation.
       *
       * Minted per invocation, not a fixed literal: this scenario is also
       * driven again after a **restart on the same data directory**, and that
       * second run is a new operation, not a retry of the first. A constant key
       * would either replay the first artifact or, in another conversation,
       * collide with its fingerprint — both of which would be the harness
       * telling a story about idempotency that the test is not about.
       */
      input: (calls: CallRecord[]) => ({
        caseId: firstCaseId(calls),
        title: 'Zestawienie z chwili',
        operationId: `e2e-artefakt-snapshot-${Date.now()}`,
      }),
      maxChars: 200,
    },
    {
      kind: 'call',
      name: 'artifact_create',
      input: (calls: CallRecord[]) => ({
        title: 'Zestawienie na zywo',
        kind: 'table',
        mode: 'live',
        rendererType: 'procurement.comparison',
        content: { operation: 'procurement.comparison', input: { caseId: firstCaseId(calls) } },
        operationId: `e2e-artefakt-live-${Date.now()}`,
      }),
      maxChars: 200,
    },
    { kind: 'text', text: 'Zapisalem zestawienie i wersje na zywo.' },
  ],
  /*
   * Three artifacts of one run, each asking for a *different* renderer, made by
   * the real handlers.
   *
   * The point is the routing, so the three have to be distinguishable on screen
   * by what draws them and by nothing else: a module renderer, the platform's
   * file renderer, and a type nothing registers — which the pane shows as its
   * content, plainly, rather than as an empty box. A preview wired by position,
   * by tool name or by order of creation would draw all three the same way.
   */
  'artifact-renderer-routing': [
    { kind: 'wait', delayMs: 150 },
    { kind: 'call', name: 'procurement_list_cases', maxChars: 200 },
    {
      kind: 'call',
      name: 'artifact_create',
      input: (calls: CallRecord[]) => ({
        title: 'Zestawienie renderowane przez modul',
        kind: 'table',
        mode: 'live',
        rendererType: 'procurement.comparison',
        content: { operation: 'procurement.comparison', input: { caseId: firstCaseId(calls) } },
        operationId: `e2e-renderer-modul-${Date.now()}`,
      }),
      maxChars: 200,
    },
    {
      kind: 'call',
      name: 'artifact_create',
      input: {
        title: 'Artefakt bez zarejestrowanego renderera',
        kind: 'report',
        mode: 'snapshot',
        /* Deliberately not in the catalog; the pane must say so by showing the data. */
        rendererType: 'platform.nie-ma-takiego-renderera',
        content: { text: 'ZNACZNIK-BEZ-RENDERERA' },
        operationId: `e2e-renderer-brak-${Date.now()}`,
      },
      maxChars: 200,
    },
    { kind: 'writeOutput', path: 'wynik-renderera.txt', content: 'ZNACZNIK-PLIKU' },
    {
      kind: 'call',
      name: 'artifact_publish_file',
      input: { path: 'wynik-renderera.txt', title: 'Plik opublikowany z workspace', operationId: `e2e-renderer-plik-${Date.now()}` },
      maxChars: 200,
    },
    { kind: 'text', text: 'Zapisalem trzy artefakty.' },
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
  /* BL-04: controlled authentication and limit failures, simulated at the boundary. */
  'auth-limit': limitScript,
  'auth-revoked': revokedScript,
  'auth-refresh-refused': refreshRefusedScript,
  'auth-network': networkScript,
  'auth-expired-ok': expiredButWorkingScript,
  'auth-credential-read': credentialReadScript(),
};

/**
 * A long run that would change domain data *after* the part the user sees.
 *
 * Written for the Stop measurement: cancelling a run that was only going to
 * keep talking proves nothing about "no further mutations after the end". Here
 * the step waiting behind the stream is a real write through the real handler,
 * so the claim can fail.
 *
 * The second command of the conversation ("krotko") gets a short answer, which
 * is how the same instance can show that the queue still works after a Stop
 * without replaying the long script.
 */
const stopMeasurementScript = (prompt: string): Step[] =>
  prompt.includes('krotko')
    ? [
        { kind: 'text', text: 'Krotka odpowiedz ', delayMs: 120 },
        { kind: 'text', text: 'po zatrzymaniu.', delayMs: 120 },
      ]
    : [
        { kind: 'call', name: 'procurement_list_cases', maxChars: 200 },
        { kind: 'text', text: 'Zaczynam dluga odpowiedz. ', delayMs: 150 },
        ...Array.from({ length: 40 }, (_, i) => ({
          kind: 'text' as const,
          text: `fragment ${i + 1} `,
          delayMs: 150,
        })),
        {
          kind: 'call',
          name: 'procurement_set_criteria_weights',
          input: (calls: CallRecord[]) => {
            const listed = calls.find((c) => c.name === 'procurement_list_cases');
            const found = listed?.result?.cases?.[0];
            if (!found) throw new Error('scenariusz: brak sprawy do zmiany wag');
            return { caseId: found.id, weights: [{ key: 'total_cost', weight: 97 }] };
          },
          maxChars: 300,
        },
        { kind: 'text', text: 'Zmienilem wagi kryteriow.' },
      ];

/**
 * Scenarios whose steps depend on the user's message — a whole conversation
 * played by one server instance.
 */
/**
 * L11.6 — centrum zadań. Wybierany treścią polecenia, bo jedna instancja
 * testowa gra jeden scenariusz:
 *
 *  - polecenie ze słowem „AWARIA" kończy się jawnym błędem — to daje zadanie
 *    zakończone niepowodzeniem, którego błąd i ponowienie pokazuje centrum;
 *  - pozostałe polecenia grają długą pracę: narzędzie, opublikowany artefakt
 *    (na tyle wcześnie, żeby zdążył przed anulowaniem z centrum), potem jeszcze
 *    chwilę pracy — wystarczająco długo, by wyjść z rozmowy źródłowej, otworzyć
 *    centrum i obsłużyć zadanie (podgląd, wynik, anulowanie, ponowienie).
 */
const taskCenterScript = (prompt: string): Step[] => {
  if (prompt.includes('AWARIA')) {
    return [{ kind: 'fail', message: 'Symulowana awaria narzedzia centrum zadan.' }];
  }
  const operationId = `tc-${prompt.replace(/[^a-zA-Z0-9]/g, '').slice(-24) || 'domyslna'}`;
  return [
    { kind: 'text', text: 'Zaczynam dlugie zadanie centrum. ', delayMs: 150 },
    {
      kind: 'tool',
      name: 'mcp__app__canvas_list_cards',
      input: { spaceId: 'sp_scripted' },
      result: '{"cards":[],"marker":"CENTRUM-ZADAN-NARZEDZIE"}',
    },
    {
      kind: 'call',
      name: 'artifact_create',
      input: {
        title: 'Raport centrum zadan',
        kind: 'report',
        rendererType: 'platform.markdown',
        content: { text: 'Wynik dlugiego zadania centrum.' },
        operationId,
      },
      maxChars: 200,
    },
    { kind: 'wait', delayMs: 2500 },
    { kind: 'text', text: 'Dzialam nadal. ', delayMs: 150 },
    { kind: 'wait', delayMs: 2500 },
    { kind: 'text', text: 'Koncze zadanie centrum.', delayMs: 150 },
  ];
};

const CONVERSATION_SCENARIOS: Record<string, (prompt: string) => Step[]> = {
  'agent-views': agentViewsScript,
  'bl10-messages': messageKindsScript,
  'bl10-composition': compositionScript,
  'app-context': appContextScript,
  'chat-history': chatHistoryScript,
  interactions: interactionsScript,
  'show-value': showValueScript,
  'stop-measurement': stopMeasurementScript,
  /* BL-09: consent, background continuity, files and Stop reaching processes. */
  'bl09-consent': consentScript,
  'bl09-continuity': continuityScript,
  'bl09-timeout': neverEndingScript,
  'bl09-child': childProcessScript,
  'bl09-files': filesScript,
  /* BL-09, L9.7: repeats of the creating write tools produce one effect. */
  'bl09-l97': idempotencyScript,
  /* BL-04: a mutation, then the limit, then a retry the user asks for. */
  'auth-mutation-then-limit': mutationThenLimitScript,
  /* BL-08b: coming back to a run that is still going. */
  'bl08b-live-reconnect': liveReconnectScript,
  'bl08b-consent-then-work': consentThenWorkScript,
  /* L11.6: obsługa pracy w tle z globalnego centrum zadań. */
  'task-center': taskCenterScript,
  /*
   * BL-03: rehearsals of the paid runs. Simulations, and never evidence for a
   * criterion of that package — see the header of `bl03-scenarios.ts`.
   */
  'bl03-canvas': bl03CanvasScript,
  'bl03-relations': bl03RelationsScript,
  'bl03-consent': bl03ConsentScript,
  'bl03-isolation': bl03IsolationScript,
  'bl03-lifecycle': bl03LifecycleScript,
  'bl03-t16': bl03T16Script,
  'bl03-t17': bl03T17Script,
};

/**
 * The SDK session report the scripted instance answers with.
 *
 * The real probe starts the Claude CLI: useful once, in a recorded run
 * (`scripts/probe-sdk-session.ts`), and wrong inside a browser suite, which
 * would then be testing whether the machine is logged in rather than what the
 * interface does with each answer. `SDK_SESSION` chooses the answer; unset
 * leaves the real probe in place.
 */
const SDK_SESSION_ANSWERS: Record<string, SdkSession> = {
  subscription: {
    state: 'subscription',
    apiKeySource: null,
    apiProvider: 'firstParty',
    subscriptionType: 'Claude Max',
    planLimits: { available: true, fiveHourPercent: 2, sevenDayPercent: 64 },
    checkedAt: new Date().toISOString(),
    error: null,
  },
  'api-key': {
    state: 'api_key',
    apiKeySource: 'ANTHROPIC_API_KEY',
    apiProvider: 'firstParty',
    subscriptionType: null,
    planLimits: { available: false, fiveHourPercent: null, sevenDayPercent: null },
    checkedAt: new Date().toISOString(),
    error: null,
  },
  unavailable: {
    state: 'unavailable',
    apiKeySource: null,
    apiProvider: null,
    subscriptionType: null,
    planLimits: null,
    checkedAt: new Date().toISOString(),
    error: 'sesja SDK nie odpowiedziala na zadanie sterujace w wyznaczonym czasie',
  },
  /*
   * The answer a session reports in the explicit GLM mode: the endpoint token
   * is the credential, so `api_key` with an `ANTHROPIC_AUTH_TOKEN` source is
   * the **expected** result there — not the policy violation it is under the
   * subscription-only policy. A stand-in, like the other answers here: the
   * real accountInfo() answer in this mode is a recorded-run question, not a
   * browser-suite one.
   */
  glm: {
    state: 'api_key',
    apiKeySource: 'ANTHROPIC_AUTH_TOKEN',
    apiProvider: 'GLM/Z.AI (kompatybilny endpoint Anthropic)',
    subscriptionType: null,
    planLimits: { available: false, fiveHourPercent: null, sevenDayPercent: null },
    checkedAt: new Date().toISOString(),
    error: null,
  },
};

const scenario = process.env.SCRIPT ?? 'tool-then-text';
const steps = SCENARIOS[scenario] ?? CONVERSATION_SCENARIOS[scenario];
if (!steps) {
  console.error(
    `[scripted] nieznany scenariusz "${scenario}". Dostepne: ${[...Object.keys(SCENARIOS), ...Object.keys(CONVERSATION_SCENARIOS)].join(', ')}`,
  );
  process.exit(2);
}

/*
 * `call` steps run real tool handlers, so the agent needs the platform's tool
 * list — which exists only once the platform does. Resolved lazily, when a step
 * plays.
 */
let platform: PlatformInstance;
const sessionAnswer = process.env.SDK_SESSION ? SDK_SESSION_ANSWERS[process.env.SDK_SESSION] : undefined;
if (process.env.SDK_SESSION && !sessionAnswer) {
  console.error(
    `[scripted] nieznana odpowiedz sesji SDK "${process.env.SDK_SESSION}". Dostepne: ${Object.keys(SDK_SESSION_ANSWERS).join(', ')}`,
  );
  process.exit(2);
}
platform = composeApp({
  modelAgent: scriptedAgent(steps, {
    tools: () =>
      collectToolEntries({ registry: platform.registry, platformTools: platformTools(platform.services) }),
  }),
  sessionProbe: sessionAnswer ? async () => sessionAnswer : null,
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
