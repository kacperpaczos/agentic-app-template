import type { CallRecord, Step } from './scripted-agent.ts';

/**
 * The scripted conversation behind `e2e/show-value.spec.ts`.
 *
 * One scenario answering several commands: the user's message carries a marker
 * in brackets and the parameters the test needs the run to use (a supplier's
 * name, a record id), and the steps are chosen from it — so a single server
 * instance can play a whole conversation. Every `call` runs the real tool
 * handler with the run's context, through the runtime's acknowledgement gate,
 * so the browser really performs what the agent asks for.
 *
 * The record is always found first with a module tool and only then shown:
 * `ui_show_value` does not search by name, which is the rule the prompt states.
 *
 * Symulacja: the tool calls and their order are chosen here, not by a model.
 */

const value = (prompt: string, key: string): string => {
  const found = new RegExp(`${key}=([^\\s]+)`).exec(prompt);
  if (!found) throw new Error(`scenariusz show-value: brak ${key}= w poleceniu`);
  return found[1]!;
};

/** The id of the supplier the module's own search returned for the name in the message. */
const supplierFrom = (calls: CallRecord[], name: string): string => {
  const search = [...calls].reverse().find((c) => c.name === 'procurement_search');
  const found = (search?.result?.results ?? []).find(
    (r: { kind: string; label: string }) => r.kind === 'supplier' && r.label === name,
  );
  if (!found) throw new Error(`scenariusz show-value: wyszukiwanie nie zwrocilo dostawcy "${name}"`);
  return found.id as string;
};

const search = (query: string): Step => ({
  kind: 'call',
  name: 'procurement_search',
  input: { query },
  maxChars: 600,
});

/** Reads the screen after the value was shown, with the version and tab of its acknowledgement. */
const readScreen: Step = {
  kind: 'call',
  name: 'ui_state',
  input: { minVersion: '$last.uiVersion', clientId: '$last.uiClientId' },
  maxChars: 200,
};

const suppliersTable = (title: string, pageSize: number | null) =>
  [
    'root = Stack([tabela])',
    `tabela = DataTable({operation: "procurement.suppliers"}, ["name", "taxId", "country"], "${title}", ${pageSize ?? 'null'})`,
  ].join('\n');

export function showValueScript(prompt: string): Step[] {
  /* The value of a supplier's field, in the module's own list view. */
  if (prompt.includes('[pokaz-pole]')) {
    const name = value(prompt, 'nazwa').replace(/_/g, ' ');
    const field = value(prompt, 'pole');
    return [
      search(name),
      {
        kind: 'call',
        name: 'ui_show_value',
        input: (calls) => ({ recordKind: 'supplier', recordId: supplierFrom(calls, name), field }),
        maxChars: 1200,
      },
      readScreen,
      { kind: 'text', text: 'Pokazalem pole na ekranie.' },
    ];
  }

  /*
   * The negative control of the probe: the run finds the value and answers with
   * it in the chat, moving nothing. Everything a text answer can do, and
   * nothing a shown value does.
   */
  if (prompt.includes('[tylko-tekst]')) {
    const name = value(prompt, 'nazwa').replace(/_/g, ' ');
    return [
      search(name),
      { kind: 'text', text: `NIP dostawcy ${name} to ${value(prompt, 'nip')}.` },
    ];
  }

  /* A record shown in two places at once: the list view and an agent view. */
  if (prompt.includes('[niejednoznacznie]')) {
    const name = value(prompt, 'nazwa').replace(/_/g, ' ');
    return [
      {
        kind: 'call',
        name: 'agent_view_create',
        input: { title: 'Dostawcy w rozmowie', source: suppliersTable('Dostawcy w rozmowie', 5) },
        maxChars: 300,
      },
      search(name),
      {
        kind: 'call',
        name: 'ui_show_value',
        input: (calls) => ({ recordKind: 'supplier', recordId: supplierFrom(calls, name), field: 'taxId' }),
        maxChars: 1200,
      },
      { kind: 'text', text: 'Rekord jest w kilku miejscach.' },
    ];
  }

  /* The same value, in the agent view named by the previous answer. */
  if (prompt.includes('[w-widoku-agenta]')) {
    const name = value(prompt, 'nazwa').replace(/_/g, ' ');
    return [
      { kind: 'call', name: 'agent_views_list', maxChars: 300 },
      search(name),
      {
        kind: 'call',
        name: 'ui_show_value',
        input: (calls) => {
          const list = [...calls].reverse().find((c) => c.name === 'agent_views_list');
          const view = (list?.result?.views ?? [])[0];
          if (!view) throw new Error('scenariusz show-value: rozmowa nie ma widoku agenta');
          return { recordKind: 'supplier', recordId: supplierFrom(calls, name), field: 'taxId', targetId: view.cardId };
        },
        maxChars: 1200,
      },
      readScreen,
      { kind: 'text', text: 'Pokazalem pole w widoku agenta.' },
    ];
  }

  /* A record of another owner: the reads behind the only place that shows it are refused. */
  if (prompt.includes('[brak-dostepu]')) {
    const caseId = value(prompt, 'sprawa');
    return [
      {
        kind: 'call',
        name: 'agent_view_create',
        input: {
          title: 'Oferty sprawy',
          source: [
            'root = Stack([tabela])',
            `tabela = DataTable({operation: "procurement.comparison", input: {caseId: "${caseId}"}}, ["supplierName", "totalMinor"], "Oferty")`,
          ].join('\n'),
        },
        maxChars: 300,
      },
      {
        kind: 'call',
        name: 'ui_show_value',
        input: { recordKind: 'offer', recordId: value(prompt, 'oferta'), field: 'totalMinor' },
        maxChars: 1200,
      },
      { kind: 'text', text: 'Zglaszam brak dostepu.' },
    ];
  }

  /* An identifier that is nobody's record. */
  if (prompt.includes('[zly-rekord]')) {
    return [
      {
        kind: 'call',
        name: 'ui_show_value',
        input: { recordKind: 'supplier', recordId: 'pcs_nie_istnieje', field: 'taxId' },
        maxChars: 1200,
      },
      { kind: 'text', text: 'Nie ma takiego rekordu.' },
    ];
  }

  /* A field of a record on the screen of one record — reached without navigating. */
  if (prompt.includes('[pozycja-sprawy]')) {
    return [
      {
        kind: 'call',
        name: 'ui_show_value',
        input: { recordKind: 'offer_item', recordId: value(prompt, 'pozycja'), field: 'unitPriceMinor' },
        maxChars: 1200,
      },
      readScreen,
      { kind: 'text', text: 'Pokazalem cene pozycji.' },
    ];
  }

  return [{ kind: 'text', text: 'Nie wiem, o co chodzi.' }];
}
