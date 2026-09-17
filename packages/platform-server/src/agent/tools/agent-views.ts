import { z } from 'zod';
import {
  AGENT_VIEWS_SCOPE_KIND,
  AppError,
  DATA_COMPONENTS,
  type CanvasCard,
  type CanvasSpace,
  type ModuleToolDefinition,
  type ToolCallContext,
} from '@platform/contracts';
import {
  AGENT_VIEW_LAYOUT_COMPONENTS,
  applyCompositionPatch,
  compositionRefusal,
  findDataInstances,
  normalizeCompositionSource,
  sameComposition,
  statementsOf,
  type OpenUiServerCatalog,
} from '../../registry/openui-validation.ts';
import type { PlatformServices } from '../../services/index.ts';
import { mcpToolName } from '../mcp.ts';

/**
 * What every answer of `agent_view_create` / `agent_view_update` says about
 * itself.
 *
 * Storing a composition and drawing it are two different events, and only the
 * first one happened here. A real turn made the difference visible: the agent
 * added a money series to a view, the tool answered success, the component
 * refused on screen ("laczy rozne jednostki (PLN, EUR)") — and the user was
 * told "Dodano wykres slupkowy cen jednostkowych do widoku." Nothing in the
 * answer could have told the model otherwise, so the answer says it itself.
 */
const NOT_RENDERED_NOTE =
  'Kompozycja zostala ZAPISANA, ale nie narysowana: ten wynik nie mowi nic o tym, co karta pokazuje. ' +
  `Zanim powiesz uzytkownikowi, co widok przedstawia, odczytaj ekran przez ${mcpToolName('ui_state')} ` +
  '(stan instancji, liczba rekordow, ewentualna odmowa komponentu). Jesli opis ekranu nie wymienia tej karty ' +
  '(uzytkownik patrzy gdzie indziej), powiedz tylko, ze widok powstal — nie opisuj, co przedstawia.';

/** A warning about a stored composition: never a refusal, and never about the data. */
export interface CompositionWarning {
  code: 'unit_from_record';
  statementId?: string;
  message: string;
}

/**
 * Warnings a composition earns from its descriptors alone.
 *
 * **Why a warning and not a check.** The one failure a real turn produced was a
 * chart series in PLN and EUR at once, which `buildChartModel` refuses to draw
 * rather than state a comparison the data does not support. Whether a series
 * mixes units is a fact about the rows *at the moment of drawing*, so running
 * the read here would prove nothing durable: the composition would be accepted
 * today and still fail tomorrow, or refused today for rows that are fine an
 * hour later. What *is* knowable without data is weaker and stable — a field
 * that carries its unit in another property of the record (`unitField`) can
 * never be shown to be uniform ahead of time. That is what is said, once, as a
 * warning next to the note that the view was not rendered.
 */
function compositionWarnings(source: string, services: PlatformServices): CompositionWarning[] {
  const warnings: CompositionWarning[] = [];
  let instances;
  try {
    instances = findDataInstances(source, services.catalog.openui);
  } catch {
    // A warning must never be the reason a stored composition is reported as failed.
    return warnings;
  }
  for (const instance of instances) {
    if (instance.component !== 'DataChart') continue;
    const descriptor = services.modules.readOperation(instance.props.source.operation)?.definition.result;
    if (!descriptor) continue;
    const carried = instance.props.series
      .map((name) => descriptor.fields.find((f) => f.field === name))
      .filter((f) => f?.unitField);
    if (carried.length === 0) continue;
    warnings.push({
      code: 'unit_from_record',
      ...(instance.statementId ? { statementId: instance.statementId } : {}),
      message:
        `Instrukcja ${instance.statementId ?? '(wewnetrzna)'} (DataChart): ` +
        `serie ${carried.map((f) => `${f!.label} (jednostka z pola ${f!.unitField})`).join(', ')} ` +
        'niosa jednostke z rekordu, wiec dopiero dane pokaza, czy jest jednolita. Jesli nie jest ' +
        '(np. PLN i EUR naraz), wykres odmowi narysowania. Nie obiecuj tego wykresu uzytkownikowi, ' +
        `zanim nie odczytasz ekranu przez ${mcpToolName('ui_state')}.`,
    });
  }
  return warnings;
}

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
        'pobieraja je z backendu. Identyfikatory w source.input biora sie z odczytu narzedziem modulu albo z ' +
        'biezacego kontekstu — nigdy z kodu biznesowego, ktory uzytkownik wpisal w rozmowie. Kompozycja jest ' +
        'sprawdzana przed zapisem (schemat, nie istnienie rekordu); odmowa podaje przyczyne. Wynik mowi tylko, ' +
        'ze kompozycja zostala ZAPISANA, nie ze karta ja narysowala — co widac na ekranie odczytaj przez ui_state.',
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
        return {
          cardId: card.id,
          spaceId: space.id,
          title: card.title,
          specVersion: card.specVersion,
          rendered: false,
          readBack: NOT_RENDERED_NOTE,
          warnings: compositionWarnings(spec.source, services),
        };
      },
    },
    {
      name: 'agent_view_update',
      description:
        'Zmienia istniejacy widok agenta tej rozmowy. patch (zalecany): instrukcje OpenUI Lang, ktore zastepuja ' +
        'instrukcje o tych samych nazwach, np. tabela = DataTable(...); pozostale instrukcje zostaja bez zmian, ' +
        'nazwa = null usuwa instrukcje. Nowa instrukcja musi byc osiagalna z root (zmien tez root), a istniejaca ' +
        'nie moze zniknac bez jawnego nazwa = null. source: cala nowa kompozycja. Polozenie karty i inne widoki sie ' +
        'nie zmieniaja. Niepoprawny wynik jest odrzucany, a widok zostaje w poprzedniej wersji; brak zmiany zwraca ' +
        'unchanged=true. Wynik mowi tylko, ze kompozycja zostala ZAPISANA, nie ze karta ja narysowala — co widac ' +
        'na ekranie (i czy komponent nie odmowil rysowania) odczytaj przez ui_state.',
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
        let next = current;
        if (input.patch !== undefined) {
          // A patch that would lose a statement, or cannot be read as written, is refused before merging.
          const patched = applyCompositionPatch(current, input.patch);
          if (patched.problems.length > 0) throw compositionRefusal(patched.problems);
          next = patched.unchanged ? current : patched.source;
        } else if (input.source !== undefined) {
          const source = normalizeCompositionSource(input.source);
          /*
           * The list of statements is checked as written before it is compared:
           * the comparison reads statements only, so a garbled line or a name
           * given twice would otherwise make a bad source look unchanged.
           */
          const written = statementsOf(source);
          if (written.problems.length > 0) throw compositionRefusal(written.problems);
          next = sameComposition(source, current) ? current : source;
        }
        // A stale version is a conflict whether or not anything would change.
        if (input.expectedSpecVersion !== undefined && input.expectedSpecVersion !== card.specVersion) {
          throw new AppError('conflict', 'Card content changed since it was read.', {
            currentSpecVersion: card.specVersion,
          });
        }
        /*
         * Nothing would change: no write, no new version, no event — and the
         * answer says so, instead of reporting an edit that did not happen.
         */
        if (next === current && (input.title === undefined || input.title === card.title)) {
          return {
            cardId: card.id,
            title: card.title,
            specVersion: card.specVersion,
            source: current,
            unchanged: true,
            rendered: false,
            readBack: NOT_RENDERED_NOTE,
            warnings: compositionWarnings(current, services),
          };
        }
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
          unchanged: false,
          rendered: false,
          readBack: NOT_RENDERED_NOTE,
          warnings: compositionWarnings(spec.source, services),
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
    /*
     * From two real turns in a row (`run_39bc79cc133d4bce8fcc`,
     * `run_24132e16b1cf49a9a624`): asked for the offer items "of case
     * PC-2026-01", the agent went straight to `agent_view_create` with
     * `input: {caseId: "PC-2026-01"}` — the code the user had typed put where
     * the record's id belongs — without a single read first. The platform held:
     * the read was refused and the card showed the refusal instead of invented
     * rows. What was missing was this paragraph. The neighbouring rule for
     * `ui_show_value` has said "find the record and its id with a module tool"
     * from the start, and that path never produced the same mistake.
     */
    '- Identyfikatory w source.input musza pochodzic z ODCZYTU: z wyniku narzedzia modulu (wyszukiwanie, lista,',
    '  operacja odczytu) albo z biezacego kontekstu (zasob, zaznaczenie, opis ekranu z ui_state). NIGDY nie wstawiaj',
    '  kodu biznesowego, ktory uzytkownik wpisal w rozmowie (np. "PC-2026-01"), jako identyfikatora rekordu —',
    '  kod i identyfikator to rozne rzeczy. Gdy uzytkownik nazywa rekord slowem albo kodem, najpierw go znajdz',
    '  narzedziem modulu i wez identyfikator z wyniku.',
    '- Walidator sprawdza schemat kompozycji, a NIE istnienie rekordu: zmyslony identyfikator przechodzi walidacje,',
    '  a odmowa przychodzi dopiero przy odczycie. Tak wyglada odmowa w opisie ekranu: instancja ma state = forbidden',
    '  (albo error), error.code not_found lub forbidden, error.message podaje powod, zero rekordow, a karta pokazuje',
    '  komunikat o odmowie zamiast danych. Wtedy widok NIE pokazuje danych — powiedz to uzytkownikowi i popraw',
    '  identyfikator; nie wymyslaj wartosci.',
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
    '  Zmiana grupowania tej tabeli — patch powtarza wszystkie dotychczasowe argumenty i dopisuje tylko nowy:',
    '           tabela = DataTable({operation: "modul.operacja", input: {}}, ["poleA", "poleB"], "Tytul", null, null, {field: "poleB", direction: "desc"}, "poleA")',
    '  Nowa instrukcja w patchu musi byc dodana tez do root (np. root = Stack([opis, tabela, wykres])); instrukcja usuwana: nazwa = null.',
    '- Odmowa narzedzia podaje przyczyne (nieznany komponent, operacja, wejscie, pole). Popraw kompozycje; poprzednia wersja widoku zostaje.',
    '- Jesli katalog nie pozwala pokazac tego, o co prosi uzytkownik (brak operacji albo pola), powiedz to wprost.',
    '  Nie obchodz ograniczenia wpisujac liczby do tekstu.',
    /*
     * From `run_96c52b19607e4a21a589`: the agent added a chart of unit prices,
     * the tool answered success, `DataChart` refused to draw a series in PLN
     * and EUR at once — and the user was told "Dodano wykres slupkowy cen
     * jednostkowych do widoku." The composition was stored; the picture was
     * never there. Storing and drawing are separate events, so what may be said
     * about the second one has to be read back from the screen.
     */
    '## Po utworzeniu albo zmianie widoku',
    '- Wynik agent_view_create / agent_view_update mowi tylko, ze kompozycja zostala ZAPISANA. Nie mowi, ze karta',
    '  ja narysowala: komponent moze odmowic rysowania (np. seria pieniezna laczaca PLN i EUR), a odczyt moze',
    '  zostac odrzucony.',
    `- Zanim powiesz uzytkownikowi, co widok pokazuje, odczytaj ekran przez ${mcpToolName('ui_state')} — patrz "## Stan ekranu".`,
    '- NIGDY nie twierdz, ze wykres, tabela albo podsumowanie cos pokazuje, jesli tego nie odczytales. Instancja ze',
    '  state = error albo forbidden niczego nie narysowala: powiedz, czego nie widac i dlaczego (error.message).',
    '- Gdy opis ekranu nie wymienia tej karty ani jej instancji (uzytkownik patrzy na inny ekran), powiedz tylko,',
    '  ze widok powstal albo sie zmienil, i NIE opisuj, co przedstawia.',
    '- warnings w wyniku to ostrzezenia, nie odmowa — mowia, czego nie dalo sie sprawdzic przed narysowaniem.',
    '## Nawigacja',
    '- Nie przelaczaj ekranu uzytkownika do Widokow agenta z wlasnej inicjatywy. Napisz, ze widok jest w "Widoki agenta";',
    `  ${mcpToolName('ui_navigate')} do platform.agentViews tylko na wyrazna prosbe uzytkownika.`,
  ];
}
