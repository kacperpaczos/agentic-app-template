import type { CallRecord, Step } from './scripted-agent.ts';

/**
 * Scenarios for the BL-10 package: what an answer is made of, and what a
 * composition change does to work in progress.
 *
 * Each one is chosen by the user's message, so a single server instance plays a
 * whole conversation — the browser test sends the commands in order and asserts
 * on what is on screen after each.
 */

/**
 * Answers of the four kinds the interface has to tell apart.
 *
 * Prose, a valid composition, a composition that is only half written and one
 * that names a component nobody has. All four arrive the same way — as the
 * text of one assistant message — so distinguishing them is the renderer's job,
 * and getting it wrong is silent: the failure this covers is an explanation
 * that disappears because a table was underneath it.
 */
export function messageKindsScript(prompt: string): Step[] {
  const ask = prompt.toLowerCase();

  if (ask.includes('tabele i wyjasnienie')) {
    return [
      { kind: 'wait', delayMs: 100 },
      // A real tool answer, in the same turn, so the three kinds are side by side.
      { kind: 'call', name: 'procurement_list_cases', maxChars: 200 },
      { kind: 'text', text: 'Ponizej dostawcy z backendu. ', delayMs: 120 },
      {
        kind: 'text',
        text:
          '```openui-lang\n' +
          'root = DataTable({operation: "procurement.suppliers"}, ["name", "country"], "Dostawcy")\n' +
          '```\n',
        delayMs: 120,
      },
      { kind: 'text', text: 'Tabela pobiera dane sama; nie przepisuje ich do odpowiedzi.' },
    ];
  }

  if (ask.includes('sama proza')) {
    return [
      { kind: 'wait', delayMs: 100 },
      { kind: 'text', text: 'Bez zadnego opisu interfejsu: to jest zwykla odpowiedz tekstowa.' },
    ];
  }

  if (ask.includes('bledny opis')) {
    return [
      { kind: 'wait', delayMs: 100 },
      { kind: 'text', text: 'Sprobuje pokazac to komponentem. ', delayMs: 120 },
      {
        kind: 'text',
        // A component no catalog has: the answer must say so, and keep the prose.
        text: '```openui-lang\nroot = NieMaTakiegoKomponentu({co: "cokolwiek"})\n```\n',
        delayMs: 120,
      },
      { kind: 'text', text: 'Jesli sie nie wyrenderowal, powinno to byc widac.' },
    ];
  }

  if (ask.includes('czesciowy opis')) {
    return [
      { kind: 'wait', delayMs: 100 },
      { kind: 'text', text: 'Zaczynam opis interfejsu. ', delayMs: 120 },
      // A fence that is never closed: the half-written case.
      { kind: 'text', text: '```openui-lang\nroot = DataTable({operation: "procurement.suppl', delayMs: 120 },
    ];
  }

  return [{ kind: 'text', text: 'Nie znam tego polecenia w tym scenariuszu.' }];
}

/** The card a composition-change scenario acts on, by its component id. */
const cardWithComponent = (calls: CallRecord[], component: string): string => {
  const listed = calls.find((c) => c.name === 'canvas_list_cards');
  const cards = (listed?.result?.cards ?? []) as Array<{ id: string; spec: { component?: string } }>;
  const found = cards.find((c) => c.spec?.component === component);
  if (!found) throw new Error(`scenariusz: brak karty ${component} w przestrzeni`);
  return found.id;
};

/**
 * The agent changing the composition under the user's hands.
 *
 * Adding a card, and removing the one that holds a half-filled form. Both go
 * through the real handlers with the run's own context, so what the browser
 * sees afterwards is what a composition change actually does — including to a
 * selection, a card's view state and an unsaved draft.
 */
export function compositionScript(prompt: string): Step[] {
  const ask = prompt.toLowerCase();

  if (ask.includes('dodaj notatke')) {
    return [
      { kind: 'wait', delayMs: 100 },
      {
        kind: 'call',
        name: 'canvas_add_card',
        input: {
          title: 'Notatka agenta',
          spec: {
            kind: 'component',
            component: 'platform.markdown',
            /*
             * A number the model made up. It must stay what it is — words in a
             * note — and must not become, or overwrite, a stored value
             * anywhere.
             */
            props: { markdown: 'Moim zdaniem suma najtanszej oferty to **999 999,99 PLN**.' },
          },
          geometry: { x: 1160, y: 0, width: 360, height: 200 },
        },
        maxChars: 200,
      },
      { kind: 'text', text: 'Dodalem notatke.' },
    ];
  }

  if (ask.includes('usun formularz')) {
    return [
      { kind: 'wait', delayMs: 100 },
      { kind: 'call', name: 'canvas_list_cards', maxChars: 1200 },
      {
        kind: 'call',
        name: 'canvas_remove_card',
        input: (calls: CallRecord[]) => ({ cardId: cardWithComponent(calls, 'procurement.offerItemForm') }),
        maxChars: 200,
      },
      { kind: 'text', text: 'Usunalem karte formularza.' },
    ];
  }

  if (ask.includes('podmien podsumowanie')) {
    return [
      { kind: 'wait', delayMs: 100 },
      { kind: 'call', name: 'canvas_list_cards', maxChars: 1200 },
      {
        kind: 'call',
        name: 'canvas_update_card',
        input: (calls: CallRecord[]) => {
          const listed = calls.find((c) => c.name === 'canvas_list_cards');
          const cards = (listed?.result?.cards ?? []) as Array<{
            id: string;
            spec: { component?: string; props?: { caseId?: string } };
          }>;
          const summary = cards.find((c) => c.spec?.component === 'procurement.caseSummary');
          if (!summary) throw new Error('scenariusz: brak karty podsumowania');
          return {
            cardId: summary.id,
            title: 'Warunki dostawy',
            spec: {
              kind: 'component',
              component: 'procurement.deliveryTerms',
              props: { caseId: summary.spec.props?.caseId },
            },
          };
        },
        maxChars: 300,
      },
      { kind: 'text', text: 'Podmienilem karte podsumowania.' },
    ];
  }

  /*
   * A composition that writes business values into the answer instead of
   * reading them. The agent views space takes only components that fetch their
   * own data, so this must be refused by name and nothing must be stored.
   */
  if (ask.includes('wpisz liczby')) {
    return [
      { kind: 'wait', delayMs: 100 },
      {
        kind: 'call',
        name: 'agent_view_create',
        input: {
          title: 'Zestawienie wpisane recznie',
          source: [
            'root = Stack([naglowek, tabela])',
            'naglowek = TextContent("Oferty")',
            'tabela = Table([["Dostawca", "Suma"], ["NordAV", "999 999,99 PLN"]])',
          ].join('\n'),
        },
        maxChars: 600,
      },
      { kind: 'text', text: 'Sprobowalem wpisac liczby do widoku.' },
    ];
  }

  return [{ kind: 'text', text: 'Nie znam tego polecenia w tym scenariuszu.' }];
}
