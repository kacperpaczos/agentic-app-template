import { z } from 'zod';
import { mergeStatements } from '@openuidev/lang-core';
import {
  AGENT_VIEWS_SCOPE_KIND,
  AppError,
  DATA_COMPONENTS,
  type CanvasCard,
  type CanvasSpace,
  type ModuleToolDefinition,
  type ToolCallContext,
} from '@platform/contracts';
import { AGENT_VIEW_LAYOUT_COMPONENTS, type OpenUiServerCatalog } from '../../registry/openui-validation.ts';
import type { PlatformServices } from '../../services/index.ts';
import { mcpToolName } from '../mcp.ts';

const operationId = z.string().min(8).max(200).optional();
const sourceText = z
  .string()
  .min(1)
  .max(200_000)
  .describe('Kompozycja OpenUI Lang: instrukcje nazwa = Komponent(...), w tym root = ...');

/**
 * The agent's own presentation space: one per conversation.
 *
 * **Why the conversation of the run, never the screen.** A run may keep working
 * after the user has moved to another conversation. If these tools followed the
 * active interface, a background task would write its tables into whatever the
 * user happens to be looking at. So every call resolves the space from
 * `ToolCallContext.conversationId` — the conversation the run belongs to — and
 * refuses a card that is not in that space, whoever owns it.
 *
 * Every composition goes through `ComponentCatalog.validate` in `agent-views`
 * mode before it is written: an unknown or disallowed component, an
 * unregistered read, input the read refuses or a field its descriptor does not
 * declare leaves the stored view exactly as it was.
 */
export function agentViewTools(services: PlatformServices): Array<ModuleToolDefinition<any>> {
  const conversationOf = (ctx: ToolCallContext) => {
    if (!ctx.conversationId) {
      throw new AppError(
        'precondition_failed',
        'Widoki agenta naleza do rozmowy, a to wywolanie nie jest czescia zadnej rozmowy.',
      );
    }
    // Ownership: a run acts for its owner, and only on that owner's conversation.
    return services.conversations.get(ctx.conversationId, ctx.ownerId);
  };

  const spaceOf = (ctx: ToolCallContext): CanvasSpace | null =>
    services.canvas.findScopedSpace(ctx.ownerId, AGENT_VIEWS_SCOPE_KIND, conversationOf(ctx).id);

  const ensureSpace = (ctx: ToolCallContext): CanvasSpace => {
    const conversation = conversationOf(ctx);
    return services.canvas.ensureScopedSpace({
      ownerId: ctx.ownerId,
      title: `Widoki agenta: ${conversation.title}`.slice(0, 200),
      scopeKind: AGENT_VIEWS_SCOPE_KIND,
      scopeId: conversation.id,
    }).space;
  };

  /** A card of this run's conversation's agent views, or a refusal. */
  const ownCard = (ctx: ToolCallContext, cardId: string): CanvasCard => {
    // Another owner's card is refused by the service (`forbidden`), a missing one is `not_found`.
    const card = services.canvas.getCard(cardId, ctx.ownerId);
    const space = spaceOf(ctx);
    if (!space || card.spaceId !== space.id) {
      throw new AppError(
        'forbidden',
        `Karta ${cardId} nie jest widokiem agenta tej rozmowy. Zmieniac mozesz tylko widoki zwrocone przez agent_views_list.`,
      );
    }
    return card;
  };

  const validated = (source: string) => {
    const spec = services.catalog.validate({ kind: 'openui', source }, { mode: 'agent-views' });
    return spec as Extract<typeof spec, { kind: 'openui' }>;
  };

  return [
    {
      name: 'agent_views_list',
      description:
        'Zwraca widoki agenta tej rozmowy (przestrzen "Widoki agenta"): cardId, tytul, specVersion i kompozycje ' +
        'OpenUI Lang. Wywolaj przed zmiana lub usunieciem widoku — daje cardId i nazwy instrukcji do patcha.',
      effect: 'read',
      alwaysLoad: true,
      inputSchema: z.object({}),
      handler: async (_input: unknown, ctx: ToolCallContext) => {
        const conversation = conversationOf(ctx);
        const space = spaceOf(ctx);
        const cards = space ? services.canvas.getState(space.id, ctx.ownerId).cards : [];
        return {
          conversationId: conversation.id,
          spaceId: space?.id ?? null,
          views: cards.map((c) => ({
            cardId: c.id,
            title: c.title,
            specVersion: c.specVersion,
            source: c.spec.kind === 'openui' ? c.spec.source : null,
            updatedAt: c.updatedAt,
          })),
        };
      },
    },
    {
      name: 'agent_view_create',
      description:
        'Tworzy nowy widok w przestrzeni "Widoki agenta" tej rozmowy. source to kompozycja OpenUI Lang z komponentow ' +
        'danych DataTable, DataChart, DataSummary (zrodlo: zarejestrowana operacja odczytu i pola jej deskryptora), ' +
        'opcjonalnie ulozonych w Stack, Card, Tabs z tekstem. Nigdy nie wpisuj wartosci biznesowych — komponenty ' +
        'pobieraja je z backendu. Kompozycja jest sprawdzana przed zapisem; odmowa podaje przyczyne.',
      effect: 'write',
      alwaysLoad: true,
      inputSchema: z.object({
        title: z.string().min(1).max(200).describe('Krotki tytul widoku'),
        source: sourceText,
        operationId,
      }),
      handler: async (input: { title: string; source: string; operationId?: string }, ctx: ToolCallContext) => {
        const spec = validated(input.source);
        const space = ensureSpace(ctx);
        const card = await services.canvas.addCard(
          { spaceId: space.id, title: input.title, spec, operationId: input.operationId },
          ctx.ownerId,
        );
        ctx.emit({ type: 'canvas_changed', spaceId: space.id });
        return { cardId: card.id, spaceId: space.id, title: card.title, specVersion: card.specVersion };
      },
    },
    {
      name: 'agent_view_update',
      description:
        'Zmienia istniejacy widok agenta tej rozmowy. patch (zalecany): instrukcje OpenUI Lang, ktore zastepuja ' +
        'instrukcje o tych samych nazwach, np. tabela = DataTable(...); pozostale instrukcje zostaja bez zmian, ' +
        'nazwa = null usuwa instrukcje. source: cala nowa kompozycja. Polozenie karty i inne widoki sie nie zmieniaja. ' +
        'Niepoprawny wynik jest odrzucany, a widok zostaje w poprzedniej wersji.',
      effect: 'write',
      alwaysLoad: true,
      inputSchema: z.object({
        cardId: z.string().max(128),
        patch: z
          .string()
          .min(1)
          .max(200_000)
          .optional()
          .describe('Instrukcje OpenUI Lang scalane z obecna kompozycja po nazwach'),
        source: sourceText.optional(),
        title: z.string().min(1).max(200).optional(),
        expectedSpecVersion: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('specVersion z agent_views_list; nieaktualna wersja konczy sie konfliktem'),
        operationId,
      }),
      handler: async (
        input: {
          cardId: string;
          patch?: string;
          source?: string;
          title?: string;
          expectedSpecVersion?: number;
          operationId?: string;
        },
        ctx: ToolCallContext,
      ) => {
        if (input.patch !== undefined && input.source !== undefined) {
          throw new AppError('validation_failed', 'Podaj patch albo source, nie oba naraz.');
        }
        if (input.patch === undefined && input.source === undefined && input.title === undefined) {
          throw new AppError('validation_failed', 'Nic do zmiany: podaj patch, source albo title.');
        }
        const card = ownCard(ctx, input.cardId);
        const current = card.spec.kind === 'openui' ? card.spec.source : '';
        const next =
          input.source ?? (input.patch !== undefined ? mergeStatements(current, input.patch) : current);
        const spec = validated(next);
        const updated = await services.canvas.updateSpec(
          {
            cardId: card.id,
            title: input.title,
            spec,
            expectedSpecVersion: input.expectedSpecVersion,
            operationId: input.operationId,
          },
          ctx.ownerId,
        );
        ctx.emit({ type: 'canvas_changed', spaceId: updated.spaceId });
        return {
          cardId: updated.id,
          title: updated.title,
          specVersion: updated.specVersion,
          source: spec.source,
        };
      },
    },
    {
      name: 'agent_view_remove',
      description: 'Usuwa widok agenta tej rozmowy. Pozostale widoki zostaja bez zmian.',
      effect: 'write',
      inputSchema: z.object({ cardId: z.string().max(128), operationId }),
      handler: async (input: { cardId: string; operationId?: string }, ctx: ToolCallContext) => {
        const card = ownCard(ctx, input.cardId);
        const removed = await services.canvas.removeCard(
          { cardId: card.id, operationId: input.operationId },
          ctx.ownerId,
        );
        ctx.emit({ type: 'canvas_changed', spaceId: card.spaceId });
        return removed;
      },
    },
  ];
}

/**
 * The agent views part of the system prompt: when to create a view, when to
 * change one, which components exist and what may never go into a composition.
 *
 * Signatures come from the server catalog, i.e. from the same schemas the
 * compositions are validated against, so the prompt cannot describe an
 * argument order the validator would read differently.
 */
export function agentViewsPromptSection(catalog: OpenUiServerCatalog): string[] {
  const data = DATA_COMPONENTS.map((name) => `- ${catalog.signature(name)}`);
  const modules = [...catalog.moduleComponents].map((name) => `- ${catalog.signature(name)}`);
  const layout = Object.entries(AGENT_VIEW_LAYOUT_COMPONENTS).map(
    ([name, why]) => `- ${catalog.signature(name)} — ${why}`,
  );
  return [
    '',
    '# Widoki agenta',
    'Kazda rozmowa ma wlasna przestrzen "Widoki agenta" (pozycja menu Widoki agenta, cel platform.agentViews).',
    'To tam pokazujesz dane jako tabele, wykresy i podsumowania: widok jest trwaly, czyta dane z backendu',
    'i odswieza sie po ich zmianie. Widoki dotycza zawsze rozmowy, w ktorej pracujesz — takze gdy uzytkownik',
    'patrzy teraz na inna rozmowe.',
    '## Kiedy tworzyc widok',
    `- Gdy uzytkownik prosi o zestawienie, porownanie, ranking, wykres albo podsumowanie danych — utworz widok przez ${mcpToolName('agent_view_create')}.`,
    '- Uzytkownik nie musi nazywac komponentu. Dobierz forme do intencji: lista lub porownanie rekordow -> DataTable;',
    '  porownanie wartosci liczbowych miedzy kategoriami -> DataChart "bar", przebieg -> "line", udzial jednej serii -> "pie";',
    '  kilka pol wskazanych rekordow -> DataSummary; kilka naraz -> Stack([...]) z krotkim TextContent.',
    '## Kiedy zmieniac widok',
    `- Gdy kolejne polecenie dotyczy istniejacego widoku (filtr, grupowanie, sortowanie, kolumny, rodzaj wykresu), wywolaj ${mcpToolName('agent_views_list')},`,
    `  a potem ${mcpToolName('agent_view_update')} z patch zawierajacym TYLKO zmieniane instrukcje (te same nazwy).`,
    '  Nie tworz nowego widoku zamiast zmiany i nie przepisuj calej kompozycji — reszta widoku i uklad uzytkownika maja zostac.',
    '## Co wolno wpisac do kompozycji',
    '- Dane pokazuja wylacznie komponenty danych. source = {operation: "<operacja z listy operacji odczytu>", input: {...}}.',
    '- Kolumny, x, series, fields, filter[].field, sort.field i groupBy to wylacznie pola rekordow tej operacji z listy operacji odczytu.',
    '- NIGDY nie wpisuj do kompozycji liczb, kwot, dat ani wierszy danych. Tekst sluzy tylko tytulom i objasnieniom.',
    '- Argumenty sa pozycyjne, w podanej kolejnosci; pominiety argument przed kolejnym zapisz jako null.',
    '- Komponenty danych:',
    ...data,
    ...(modules.length ? ['- Komponenty modulow (dane pobieraja same):', ...modules] : []),
    '- Uklad i tekst:',
    ...layout,
    '- Kazdy inny komponent (np. Table, BarChart z wpisanymi liczbami), wyrazenia i $zmienne sa odrzucane.',
    '- Kazda linia to instrukcja nazwa = Komponent(...); kompozycja zaczyna sie od root = ...',
    '  Przyklad: root = Stack([opis, tabela])',
    '           opis = TextContent("Krotkie objasnienie")',
    '           tabela = DataTable({operation: "modul.operacja", input: {}}, ["poleA", "poleB"], "Tytul", null, null, {field: "poleB", direction: "desc"})',
    '  Zmiana grupowania tej tabeli: patch "tabela = DataTable({operation: \\"modul.operacja\\", input: {}}, [\\"poleA\\", \\"poleB\\"], \\"Tytul\\", null, null, null, \\"poleA\\")".',
    '- Odmowa narzedzia podaje przyczyne (nieznany komponent, operacja, wejscie, pole). Popraw kompozycje; poprzednia wersja widoku zostaje.',
    '- Jesli katalog nie pozwala pokazac tego, o co prosi uzytkownik (brak operacji albo pola), powiedz to wprost.',
    '  Nie obchodz ograniczenia wpisujac liczby do tekstu.',
    '## Nawigacja',
    '- Nie przelaczaj ekranu uzytkownika do Widokow agenta z wlasnej inicjatywy. Napisz, ze widok jest w "Widoki agenta";',
    `  ${mcpToolName('ui_navigate')} do platform.agentViews tylko na wyrazna prosbe uzytkownika.`,
  ];
}
