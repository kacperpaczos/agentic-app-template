/**
 * The scripted conversation behind `e2e/interactions.spec.ts`.
 *
 * `[widok]` creates, with the real `agent_view_create`, one agent view over
 * the case's offer items: a table and a chart of the unit prices of the
 * projectors offered in PLN. `[mcp]` changes one of those prices with the real
 * `procurement_update_offer_item` — the tool the record action in any table
 * runs — and then keeps the run going, so a test can see the change reach the
 * open views while the run is still running (through `data_changed`, not the
 * refresh at its end).
 *
 * Symulacja: the tool calls and their order are chosen here, not by a model.
 */
import type { CallRecord, Step } from './scripted-agent.ts';

export const OFFER_ITEMS = 'procurement.case_offer_items';
export const VIEW_TITLE = 'Ceny projektorow';
/** Columns of the agent view's table. */
export const VIEW_COLUMNS = ['supplierName', 'name', 'unitPriceMinor', 'currency'];
/** What the view shows: projectors priced in PLN (one currency, so the chart has one unit). */
export const PROJECTORS_IN_PLN = (record: Record<string, unknown>) =>
  record.currency === 'PLN' && String(record.name).toLowerCase().includes('projektor');
/** The change the `[mcp]` run makes: this supplier's projector, to this price in PLN. */
export const MCP_SUPPLIER = 'MediaPro';
export const MCP_PRICE = 14250;
/** How long the `[mcp]` run keeps going after the change. */
export const MCP_TAIL_MS = 9000;

const FILTER = '[{field: "currency", op: "eq", value: "PLN"}, {field: "name", op: "contains", value: "Projektor"}]';

const caseIdFrom = (calls: CallRecord[]): string => {
  const listed = calls.find((c) => c.name === 'procurement_list_cases');
  const found = listed?.result?.cases?.find((c: { code: string }) => c.code === 'PC-2026-01');
  if (!found) throw new Error('scenariusz: brak sprawy PC-2026-01 w wyniku procurement_list_cases');
  return found.id as string;
};

export const viewComposition = (caseId: string) => {
  const source = `{operation: "${OFFER_ITEMS}", input: {caseId: "${caseId}"}}`;
  return [
    'root = Stack([opis, tabela, wykres])',
    'opis = TextContent("Ceny jednostkowe projektorow w ofertach w PLN.")',
    `tabela = DataTable(${source}, ${JSON.stringify(VIEW_COLUMNS).replace(/,/g, ', ')}, "Ceny projektorow", null, ${FILTER})`,
    `wykres = DataChart(${source}, "bar", "supplierName", ["unitPriceMinor"], "Cena projektora", ${FILTER})`,
  ].join('\n');
};

const listCases: Step = { kind: 'call', name: 'procurement_list_cases', maxChars: 300 };

export function interactionsScript(prompt: string): Step[] {
  if (prompt.includes('[widok]')) {
    return [
      listCases,
      {
        kind: 'call',
        name: 'agent_view_create',
        input: (calls) => ({ title: VIEW_TITLE, source: viewComposition(caseIdFrom(calls)) }),
      },
      { kind: 'text', text: 'Tabela i wykres cen projektorow sa w Widokach agenta.' },
    ];
  }
  if (prompt.includes('[mcp]')) {
    return [
      listCases,
      {
        kind: 'call',
        name: 'procurement_list_offers',
        input: (calls) => ({ caseId: caseIdFrom(calls) }),
        maxChars: 200,
      },
      {
        kind: 'call',
        name: 'procurement_update_offer_item',
        input: (calls) => {
          const offers = calls.find((c) => c.name === 'procurement_list_offers')?.result?.offers ?? [];
          const offer = offers.find((o: { supplier: string }) => o.supplier.startsWith(MCP_SUPPLIER));
          const item = offer?.items?.find((i: { name: string }) => i.name.includes('Projektor'));
          if (!item) throw new Error(`scenariusz: brak projektora dostawcy ${MCP_SUPPLIER}`);
          return { itemId: item.id, unitPrice: MCP_PRICE, operationId: 'scripted-mcp-projector-price' };
        },
      },
      { kind: 'text', text: 'Zmienilem cene projektora. ', delayMs: 100 },
      { kind: 'wait', delayMs: MCP_TAIL_MS },
      { kind: 'text', text: 'Koniec pracy.' },
    ];
  }
  return [{ kind: 'text', text: 'Nie rozpoznano polecenia testowego.' }];
}
