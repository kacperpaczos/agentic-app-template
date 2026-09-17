/**
 * The scripted conversation behind `e2e/agent-views.spec.ts`.
 *
 * One scenario answering several commands: the user's message carries a marker
 * in brackets and the steps are chosen from it, so a single server instance can
 * play a whole conversation — create, change, refuse, work in the background —
 * the way the browser test sends it. Every `call` runs the real tool handler
 * with the run's context; ids (the case, the card) are read from earlier
 * results of the same run, as a model would read them.
 *
 * Symulacja: the tool calls and their order are chosen here, not by a model.
 */
import type { CallRecord, Step } from './scripted-agent.ts';

const COMPARISON = 'procurement.comparison';
export const TABLE_TITLE = 'Zestawienie ofert';
export const CHART_TITLE = 'Suma ofert';
export const BACKGROUND_TITLE = 'Widok z tla';
const COLUMNS = '["supplierName", "currency", "priceBasis", "totalMinor", "deliveryDays"]';

/** The example case with offers in more than one currency. */
const caseIdFrom = (calls: CallRecord[]): string => {
  const listed = calls.find((c) => c.name === 'procurement_list_cases');
  const found = listed?.result?.cases?.find((c: { code: string }) => c.code === 'PC-2026-01');
  if (!found) throw new Error('scenariusz: brak sprawy PC-2026-01 w wyniku procurement_list_cases');
  return found.id as string;
};

const source = (caseId: string) => `{operation: "${COMPARISON}", input: {caseId: "${caseId}"}}`;

/** The view titled so in this conversation, from `agent_views_list` of this run. */
const viewFrom = (calls: CallRecord[], title: string): { cardId: string; source: string } => {
  const list = [...calls].reverse().find((c) => c.name === 'agent_views_list');
  const view = list?.result?.views?.find((v: { title: string }) => v.title === title);
  if (!view) throw new Error(`scenariusz: brak widoku "${title}" w wyniku agent_views_list`);
  return view;
};

const caseIdOfView = (view: { source: string }): string => /caseId: "([^"]+)"/.exec(view.source)![1]!;

export const tableComposition = (caseId: string) =>
  [
    'root = Stack([opis, tabela])',
    'opis = TextContent("Zestawienie ofert w sprawie: dostawca, waluta, podstawa cen, suma i termin dostawy.")',
    `tabela = DataTable(${source(caseId)}, ${COLUMNS}, "Oferty")`,
  ].join('\n');

export const chartComposition = (caseId: string) =>
  [
    'root = Stack([wykres])',
    `wykres = DataChart(${source(caseId)}, "bar", "supplierName", ["totalMinor"], "Suma ofert w PLN", [{field: "currency", op: "eq", value: "PLN"}])`,
  ].join('\n');

const listCases: Step = { kind: 'call', name: 'procurement_list_cases', maxChars: 300 };
const listViews: Step = { kind: 'call', name: 'agent_views_list', maxChars: 300 };

export function agentViewsScript(prompt: string): Step[] {
  if (prompt.includes('[zestawienie]')) {
    return [
      listCases,
      {
        kind: 'call',
        name: 'agent_view_create',
        input: (calls) => ({ title: TABLE_TITLE, source: tableComposition(caseIdFrom(calls)) }),
      },
      { kind: 'text', text: 'Zestawienie jest w Widokach agenta.' },
    ];
  }
  if (prompt.includes('[pierwszy]')) {
    /*
     * The first view of a conversation, created after a pause (so the page has
     * already read "no views yet" for the new conversation) and followed by a
     * long one before the run ends: the view must reach the screen while the
     * run is still going, i.e. through the event, not the end of the run.
     */
    return [
      { kind: 'text', text: 'Przygotowuje pierwszy widok. ', delayMs: 100 },
      { kind: 'wait', delayMs: 3000 },
      listCases,
      {
        kind: 'call',
        name: 'agent_view_create',
        input: (calls) => ({ title: TABLE_TITLE, source: tableComposition(caseIdFrom(calls)) }),
      },
      { kind: 'text', text: 'Widok jest juz w Widokach agenta. ', delayMs: 100 },
      { kind: 'wait', delayMs: 8000 },
      { kind: 'text', text: 'Koniec pracy.' },
    ];
  }
  if (prompt.includes('[wykres]')) {
    return [
      listCases,
      {
        kind: 'call',
        name: 'agent_view_create',
        input: (calls) => ({ title: CHART_TITLE, source: chartComposition(caseIdFrom(calls)) }),
      },
      { kind: 'text', text: 'Wykres jest w Widokach agenta.' },
    ];
  }
  if (prompt.includes('[grupowanie]')) {
    return [
      listViews,
      {
        kind: 'call',
        name: 'agent_view_update',
        input: (calls) => {
          const view = viewFrom(calls, TABLE_TITLE);
          return {
            cardId: view.cardId,
            patch: `tabela = DataTable(${source(caseIdOfView(view))}, ${COLUMNS}, "Oferty", null, null, null, "currency")`,
          };
        },
      },
      { kind: 'text', text: 'Pogrupowalem zestawienie.' },
    ];
  }
  if (prompt.includes('[typ]')) {
    return [
      listViews,
      {
        kind: 'call',
        name: 'agent_view_update',
        input: (calls) => {
          const view = viewFrom(calls, CHART_TITLE);
          return {
            cardId: view.cardId,
            patch: `wykres = DataChart(${source(caseIdOfView(view))}, "line", "supplierName", ["totalMinor"], "Suma ofert w PLN", [{field: "currency", op: "eq", value: "PLN"}])`,
          };
        },
      },
      { kind: 'text', text: 'Zmienilem wykres na liniowy.' },
    ];
  }
  if (prompt.includes('[odmowy]')) {
    return [
      listViews,
      // An unknown component in a patch of an existing view.
      {
        kind: 'call',
        name: 'agent_view_update',
        input: (calls) => ({ cardId: viewFrom(calls, TABLE_TITLE).cardId, patch: 'tabela = Wykresik("oferty")' }),
      },
      // A chart drawing numbers written into the composition.
      {
        kind: 'call',
        name: 'agent_view_create',
        input: { title: 'Liczby wpisane', source: 'root = BarChart(["A", "B"], [Series("Suma", [100, 200])])' },
      },
      // A read nobody registered.
      {
        kind: 'call',
        name: 'agent_view_create',
        input: { title: 'Zla operacja', source: 'root = DataTable({operation: "procurement.nie_ma"})' },
      },
      { kind: 'text', text: 'Zglaszam odmowy.' },
    ];
  }
  if (prompt.includes('[w tle]')) {
    return [
      { kind: 'text', text: 'Przygotowuje widok w tle. ', delayMs: 100 },
      { kind: 'wait', delayMs: 6000 },
      listCases,
      {
        kind: 'call',
        name: 'agent_view_create',
        input: (calls) => ({ title: BACKGROUND_TITLE, source: tableComposition(caseIdFrom(calls)) }),
      },
      { kind: 'text', text: 'Widok z tla gotowy.' },
    ];
  }
  if (prompt.includes('[czat-nieznana]')) {
    return [{ kind: 'text', text: 'root = DataTable({operation: "nie.istnieje"}, ["name"], "Nieznana")' }];
  }
  if (prompt.includes('[czat]')) {
    /*
     * A composition in a chat answer, arriving in pieces that cut the operation
     * name in half. The chat renders an OpenUI answer while it streams, so each
     * piece reaches the data component as a source with a partial name.
     */
    return [
      { kind: 'text', text: 'root = DataTable({operation: "procurement.' },
      { kind: 'text', text: 'supp', delayMs: 700 },
      { kind: 'text', text: 'liers"}, ["name", ', delayMs: 700 },
      { kind: 'text', text: '"country"], "Dostawcy z czatu")', delayMs: 700 },
      { kind: 'wait', delayMs: 700 },
    ];
  }
  return [{ kind: 'text', text: 'Nie rozpoznano polecenia testowego.' }];
}
