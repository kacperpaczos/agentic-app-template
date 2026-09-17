import {
  FILE_ANALYSIS,
  viewStateContextSchema,
  type AppContext,
  type ReadOperationSummary,
} from '@platform/contracts';
import type { ComponentCatalog } from '../registry/catalog.ts';
import type { ServerModuleRegistry } from '../registry/modules.ts';
import { describeReadOperations } from '../registry/read-operations.ts';
import { sortableFieldsOfTarget } from '../registry/view-sorting.ts';
import { mcpToolName } from './mcp.ts';
import { agentViewsPromptSection } from './tools/agent-views.ts';

export interface PromptInput {
  registry: ServerModuleRegistry;
  catalog: ComponentCatalog;
  appContext: AppContext;
  resourceSummary: string | null;
  workspaceDir: string | null;
  stagedFiles: Array<{ fileId: string; path: string; filename: string; mediaType: string }>;
  /** Analysis libraries linked into this run's workspace. */
  toolkit: Array<{ name: string; purpose: string }>;
}

/**
 * Assembles the run's system prompt.
 *
 * Deliberately contains *no* business rules. Prices, validation and permissions
 * are enforced by the domain services; the prompt only describes vocabulary,
 * available tools and how to behave with the canvas. A rule that exists only
 * here would be a rule that does not exist.
 */
export function buildSystemPrompt(input: PromptInput): string {
  const ctx = input.appContext;
  const briefings = input.registry.briefings();

  const parts: string[] = [
    `Jestes agentem wbudowanym w lokalna aplikacje webowa. Pracujesz na danych aplikacji wylacznie przez narzedzia MCP z serwera "app".`,
    '',
    '# Zasady',
    '- Nigdy nie zgaduj wartosci biznesowych. Jesli dane sa niekompletne, zwroc je jako brakujace.',
    '- Wszystkie obliczenia kwot wykonuje backend. Nie licz sum w glowie i nie podawaj wyliczen, ktorych nie zwrocilo narzedzie.',
    '- Zapisu danych i zmian interfejsu dokonuj wylacznie narzedziami. Nie edytuj bazy ani plikow aplikacji.',
    '- Nie zmieniaj polozenia istniejacych kart, chyba ze uzytkownik o to prosi. Pozycja karty nalezy do uzytkownika.',
    `- Jesli nie wiesz, na czym pracuje uzytkownik, wywolaj ${mcpToolName('get_context')}.`,
    '- Niezapisane szkice formularzy (unsavedDrafts) to NIE sa dane zapisane. Nie traktuj ich jak faktow.',
    '- Odpowiadaj po polsku, zwiezle.',
    '',
    '# Katalog komponentow canvasu',
    input.catalog.prompt(),
    '',
    '# Aktualny kontekst aplikacji',
    `- rozmowa: ${ctx.conversationId ?? '(brak)'}`,
    `- przestrzen canvas: ${ctx.spaceId ?? '(brak)'}`,
    `- zasob: ${ctx.resource ? `${ctx.resource.kind}:${ctx.resource.id}` : '(brak)'}`,
    input.resourceSummary ? `- opis zasobu: ${input.resourceSummary}` : '',
    `- zaznaczenie: ${ctx.selection.length ? ctx.selection.map((s) => `${s.kind}:${s.id}`).join(', ') : '(brak)'}`,
    ...describeFilters(ctx.filters),
    /*
     * The marker of the screen at send time. The description itself is not in
     * the prompt: by the time the agent acts on it, it may be gone — `ui_state`
     * reads the current one and says whether it is newer than this.
     */
    `- ekran przy wyslaniu polecenia: ${
      ctx.ui
        ? `opis w wersji ${ctx.ui.version} (karta ${ctx.ui.clientId}), widok ${ctx.ui.viewId ?? '(brak)'}, adres ${ctx.ui.url}` +
          // A cut address may end in the middle of a value; say so rather than let it read as the whole.
          (ctx.ui.urlTruncated ? ` [adres skrocony do ${ctx.ui.url.length} znakow — pelny jest dluzszy]` : '')
        : '(brak opisu)'
    }`,
    ctx.drafts.length
      ? `- niezapisane szkice: ${ctx.drafts.map((d) => `${d.entity}/${d.entityId ?? 'nowy'} (${d.dirtyFields.join(',')})`).join('; ')}`
      : '',
  ];

  if (input.workspaceDir) {
    parts.push(
      '',
      '# Workspace i sandbox',
      `Katalog roboczy tego uruchomienia to ${input.workspaceDir}.`,
      '- Pliki wejsciowe znajduja sie w input/, wyniki zapisuj w output/.',
      '- Masz Bash, Read i Write ograniczone do tego katalogu; siec jest odcieta.',
      `- Zeby pobrac plik z aplikacji do workspace, uzyj ${mcpToolName('files_stage')}.`,
      `- Zeby wynik byl trwaly i do pobrania, opublikuj go przez ${mcpToolName('artifact_publish_file')}. Pliki w workspace sa kasowane po uruchomieniu.`,
    );
    if (input.stagedFiles.length) {
      parts.push(
        '- Pliki juz przygotowane w workspace:',
        ...input.stagedFiles.map(
          (f) => `  - ${f.path} (fileId=${f.fileId}, typ=${f.mediaType})`,
        ),
      );
    }

    if (input.toolkit.length) {
      parts.push(
        '',
        '# Biblioteki dostepne w sandboxie',
        'Sa podlinkowane do node_modules workspace. Siec jest odcieta, wiec innych nie zainstalujesz.',
        ...input.toolkit.map((t) => `- ${t.name}: ${t.purpose}`),
      );
    }

    /*
     * The honest scope of file analysis, stated to the model in the same words
     * the interface shows the user.
     *
     * The failure this prevents is specific and silent: reporting a stored
     * formula result as if it had been recalculated. The workbook keeps the
     * value Excel last wrote next to the formula; nothing in the run
     * recalculates it, so presenting it as "the result" would be a fabricated
     * number wearing a spreadsheet's authority.
     */
    parts.push(
      '',
      '# Analiza plikow — co wolno powiedziec',
      '## Obraz (PNG, JPEG)',
      '- Czytaj obraz narzedziem Read; model widzi jego tresc bezposrednio.',
      '- Opisuj to, co widac. Nie zgaduj tekstu, ktorego nie da sie odczytac.',
      '## Skoroszyt (XLSX)',
      ...FILE_ANALYSIS.spreadsheet.reads.map((r) => `- czytane: ${r}`),
      ...FILE_ANALYSIS.spreadsheet.limits.map((l) => `- OGRANICZENIE: ${l}`),
      '- Formule opisuj jako "formula X, ostatnia zapisana wartosc Y". NIGDY nie podawaj',
      '  zapisanej wartosci jako wyniku przeliczenia — plik moze byc nieaktualny.',
      `- Zmodyfikowany plik uzytkownika publikuj przez ${mcpToolName('files_publish_version')},`,
      '  podajac fileId oryginalu. Oryginal zostaje nienaruszony.',
      '- Jesli plik jest uszkodzony albo ma nieobslugiwany format, powiedz to wprost',
      '  i nie zmyslaj zawartosci.',
    );
  }

  /*
   * Live artifacts can only name a query that is registered. Listing them is
   * what makes `mode="live"` usable at all: without it the model would have to
   * guess an operation name, and every guess would be rejected at creation.
   */
  const readOperations = describeReadOperations(input.registry);
  if (readOperations.length) {
    parts.push(
      '',
      '# Operacje odczytu dla artefaktow live',
      `Artefakt utworzony przez ${mcpToolName('artifact_create')} z mode="live" nie przechowuje danych.`,
      'Jako content podaj deskryptor {"operation":"<nazwa>","input":{...}} z ponizszej listy;',
      'przy kazdym otwarciu artefaktu aplikacja uruchomi te operacje ponownie i pokaze aktualny wynik.',
      'Uzywaj mode="live" dla zestawien, ktore maja pozostac aktualne, a mode="snapshot" dla raportu z konkretnej chwili.',
      /*
       * The fields come from the operation's own result descriptor — the list
       * data components are validated against. They describe the records of
       * one collection, not the whole result: a result may carry more (a
       * comparison's criteria, a case's offers), so the rule stated is where
       * these names may be used, not that nothing else exists.
       */
      'Przy operacjach z deskryptorem wyniku podana jest kolekcja rekordow i pola tych rekordow',
      '(nazwa: etykieta, typ). Wynik moze zawierac takze inne dane poza ta kolekcja, ale w komponentach',
      'danych (kolumny, serie, pola, filtr, sortowanie) wskazujesz wylacznie wymienione pola rekordow.',
      ...readOperations.map(describeReadOperationLine),
    );
    parts.push(...agentViewsPromptSection(input.catalog.openui));
  }

  /*
   * Where the interface can be moved to.
   *
   * Listed because the alternative is what actually happened without it: asked
   * to "switch to files", the agent had no navigation tool, called two unrelated
   * read tools, and then told the user they had to create a purchase case first
   * to reach a screen that is in the navigation unconditionally. Describing a
   * route the user must walk is not navigation, and a confident wrong route is
   * worse than saying nothing.
   */
  const uiTargets = input.registry.uiTargets();
  if (uiTargets.length) {
    parts.push(
      '',
      '# Sterowanie interfejsem',
      `Gdy uzytkownik prosi o pokazanie, otwarcie albo przelaczenie czegos w aplikacji, uzyj ${mcpToolName('ui_navigate')}.`,
      'NIE opisuj drogi slowami, jesli cel jest na ponizszej liscie — po prostu go otworz.',
      /*
       * The rule that was missing, and the transcript that shows why.
       *
       * Asked "what is in suppliers?", the agent read the data, retyped it into
       * the conversation and left the user on the screen they were already on.
       * The user then asked "why didn't you take me there?" — and only then did
       * it navigate. The tool was available the whole time; the instruction
       * fired only on an explicit "show me", and a question is not phrased that
       * way. Answering about data and putting that data on screen are the same
       * act here, so the trigger is the subject, not the wording.
       */
      'ODPOWIADANIE O DANYCH TO TEZ POKAZYWANIE. Jesli odpowiadasz na pytanie o dane,',
      'ktore maja swoj widok na ponizszej liscie, otworz ten widok w tej samej turze —',
      'nawet gdy uzytkownik nie uzyl slowa „pokaz". Najpierw przenies, potem opowiedz,',
      'i mow o tym, co uzytkownik ma teraz na ekranie.',
      `Pelna liste wraz z przestrzeniami pracy zwraca ${mcpToolName('ui_catalog')}.`,
      'Wynik ui_navigate zawiera executed=true/false. Jesli false, powiedz uzytkownikowi,',
      'czego nie udalo sie zrobic i dlaczego — nie twierdz, ze cos otworzyles.',
      'Pokazanie ustawienia niczego w nim nie zmienia.',
      /*
       * The list the sentences above call "ponizsza lista" — directly under
       * them, not after the sections on narrowing and ordering, which only
       * refer to the fields each entry names.
       */
      'Cele interfejsu (zawezanie po: pola dla ui_filter; sortowanie po: pola dla ui_sort):',
      ...uiTargets.map((t) => {
        const sortable = sortableFieldsOfTarget(input.registry, t.id);
        return (
          `- ${t.id} [${t.kind}] ${t.label}: ${t.description}` +
          (t.filter ? ` | zawezanie po: ${t.filter.fields.map((f) => f.field).join(', ')}` : '') +
          (sortable?.length ? ` | sortowanie po: ${sortable.map((f) => f.field).join(', ')}` : '')
        );
      }),
      '',
      '## Zawezanie widoku',
      /*
       * The second half of the same transcript: asked to show only Polish
       * suppliers, the agent retyped the matching rows into the chat. The screen
       * still showed all of them, so the user had two versions of the same data,
       * and the one they were told to read was a copy that cannot be sorted,
       * cannot update and is only as right as the retyping.
       */
      `Gdy uzytkownik chce zobaczyc TYLKO czesc danych ("pokaz tylko X", "same Y"), uzyj ${mcpToolName('ui_filter')}.`,
      'To jest domyslny sposob. NIE przepisuj pasujacych wierszy do rozmowy zamiast zawezenia widoku —',
      'uzytkownik zostalby wtedy z pelna lista na ekranie i jej recznie przepisana kopia w czacie.',
      'Mozesz dodatkowo skomentowac wynik w rozmowie, ale widok jest miejscem, gdzie dane sa zawezane.',
      'Pola, po ktorych wolno zawezac, podaje ui_catalog jako filterableFields — pole spoza tej listy',
      'zostanie odrzucone, wiec nie zgaduj nazw. W label napisz krotko po polsku, co zostalo zawezone;',
      'uzytkownik zobaczy to zdanie nad widokiem razem z przyciskiem powrotu do pelnego widoku.',
      'Wynik zawiera filtered.matched i filtered.total — podaj te liczby zamiast liczyc samodzielnie.',
      'Zeby przywrocic pelny widok, wywolaj ui_filter z clear=true.',
      '',
      '## Sortowanie i strony widoku',
      `Gdy uzytkownik chce zobaczyc dane w innej kolejnosci ("posortuj po X", "od najwiekszego"), uzyj ${mcpToolName('ui_sort')}`,
      'z polem i kierunkiem (asc rosnaco, desc malejaco). Nie przepisuj posortowanych wierszy do rozmowy.',
      'Pola, po ktorych wolno sortowac, podaje ui_catalog jako sortableFields; inne pole zostanie odrzucone',
      '(unknown_field albo not_sortable) razem z lista dozwolonych. clear=true przywraca domyslny porzadek.',
      'Wynik zawiera sorted i page (index = numer strony, count = liczba stron) — mow o tym, co potwierdzil klient.',
      'Zmiana zawezenia albo sortowania wraca do pierwszej strony.',
      'ZAWEZENIE I SORTOWANIE ZMIENIAJA TYLKO PREZENTACJE — to, ktore rekordy i w jakiej kolejnosci widac.',
      'Nie zmieniaja danych w bazie: nie mow, ze cos usunales, ukryles na stale albo przestawiles w danych.',
      'Aktualny stan widoku uzytkownika (zawezenie, sortowanie, strona, pokazane X z Y) jest w kontekscie',
      'aplikacji powyzej i w filters zwracanym przez get_context — z chwili wyslania polecenia.',
      '',
      '## Stan ekranu',
      /*
       * The confirmation of a command says the client carried it out, not what
       * the screen shows afterwards — the rows left, whether the table is still
       * loading, which view composition. Describing the screen from what was
       * asked for is exactly the stale answer this section exists to prevent.
       */
      `Co uzytkownik ma teraz na ekranie, odczytujesz przez ${mcpToolName('ui_state')}: widok z wersja kompozycji, karty`,
      '(na Widokach agenta — karty tej rozmowy), komponenty danych (stan, pola z etykietami, filtr, sortowanie, strona,',
      'grupowanie, widoczne rekordy w kolejnosci z ekranu, liczby) i dozwolone akcje.',
      'Po ui_navigate, ui_filter lub ui_sort wywolaj ui_state z minVersion = uiVersion i clientId = uiClientId z ich wyniku,',
      'ZANIM opiszesz ekran. Wersje licza sie osobno dla kazdej karty przegladarki: numer bez karty nic nie znaczy.',
      'Brak uiVersion (uiPublication inne niz published) oznacza, ze ekranu po akcji nie opisano — powiedz to.',
      'Nie opisuj ekranu na podstawie tego, o co prosiles, ani opisu ze stale=true — wtedy powiedz, czego nie wiesz (reason).',
      'Komponent ze state=loading jeszcze nic nie pokazuje: odczytaj ponownie z minVersion = version + 1.',
      'cards: null znaczy „nie wiadomo” (cardsState loading albo error), nie „brak kart” — jesli karty sa wazne,',
      'odczytaj ponownie z minVersion = version + 1; puste cards z cardsState none to brak przestrzeni do pokazania.',
      'Porownuj wersje z „ekran przy wyslaniu polecenia” w kontekscie: nizsza wersja tej samej karty jest starsza niz to,',
      'co uzytkownik widzial, wysylajac polecenie.',
      '',
      '## Pokazanie wartosci pola rekordu',
      /*
       * Finding a value and showing it are different acts. Asked "what is the
       * tax id of X", an answer typed into the chat leaves the user looking at
       * a screen that may not even contain X — filtered out, on another page,
       * in another view. The rule makes the screen the answer, and makes the
       * client's confirmation the only ground for saying it is on screen.
       */
      'Gdy uzytkownik pyta o wartosc pola konkretnego rekordu ("jaki jest NIP dostawcy X", "pokaz cene tej pozycji"):',
      `1. znajdz rekord i jego identyfikator narzedziem modulu (wyszukiwanie, lista) — ${mcpToolName('ui_show_value')} nie szuka po nazwie;`,
      '2. wywolaj ui_show_value z recordKind (rodzaj rekordu z deskryptora operacji odczytu), recordId (wartosc pola id',
      '   jako tekst) i field (pole z deskryptora). Aplikacja sama wybiera widok, w razie potrzeby usuwa zawezenie, ktore',
      '   ukrywa rekord, przechodzi na jego strone i podswietla komorke.',
      'found=true znaczy tylko, ze backend ma rekord (backend.displayedText); shown=true znaczy, ze KLIENT wskazal pole.',
      'Mow, ze pokazales wartosc, TYLKO gdy shown=true, i podaj ja z revealed.displayedText. matchesBackend=false: powiedz,',
      'ze wartosc na ekranie rozni sie od backendu. Wymien adjustments (np. usuniete zawezenie, zmieniona strona) —',
      'to zmiany prezentacji, dane sa bez zmian. Odpowiedz tylko tekstem z wartoscia NIE zastepuje pokazania.',
      'ambiguous: rekord jest w kilku miejscach — wybierz targetId z candidates (albo zapytaj uzytkownika) i wywolaj ponownie.',
      'no_renderer: aplikacja nie ma miejsca, ktore pokazuje takie rekordy lub to pole (detail) — powiedz to wprost;',
      'wartosc mozesz podac slownie tylko z zaznaczeniem, ze jej nie pokazano. unknown_field, record_not_found, forbidden,',
      'not_present, not_visible, inactive_conversation, no_client: powiedz, czego nie udalo sie zrobic i dlaczego.',
      'Po ui_show_value opis ekranu odczytasz przez ui_state z minVersion = uiVersion i clientId = uiClientId.',
    );
  }

  if (briefings) parts.push('', '# Moduly biznesowe', briefings);

  return parts.filter((p) => p !== '').join('\n');
}

/**
 * The context's filters, one line per view.
 *
 * A view's state (`AppContext.filters[targetId]`, sent by the client from the
 * view that applied it) is written out in words, so the model reads "narrowed
 * to country PL, sorted by name descending, page 1 of 2, 3 of 4 shown" instead
 * of parsing JSON. Anything else a module put there is passed on as it is.
 */
function describeFilters(filters: AppContext['filters']): string[] {
  const entries = Object.entries(filters);
  if (entries.length === 0) return ['- filtry: (brak)'];
  return entries.map(([key, value]) => {
    const view = viewStateContextSchema.safeParse(value);
    if (!view.success) return `- filtr ${key}: ${JSON.stringify(value)}`;
    const { predicates, sort, page, matched, total } = view.data;
    const narrowing = predicates.length
      ? predicates.map((p) => `${p.field} ${p.op} ${Array.isArray(p.value) ? p.value.join('|') : String(p.value)}`).join(', ')
      : 'brak';
    const order = sort ? `${sort.field} ${sort.direction === 'desc' ? 'malejaco' : 'rosnaco'}` : 'domyslne';
    const paging = page ? `strona ${page.index} z ${page.count} (po ${page.size})` : 'bez stron';
    return (
      `- stan widoku ${key} (tylko prezentacja, dane bez zmian): zawezenie ${narrowing}; ` +
      `sortowanie ${order}; ${paging}; pokazane ${matched} z ${total}`
    );
  });
}

/** One read operation, with its record and fields when it declares them. */
function describeReadOperationLine(op: ReadOperationSummary): string {
  const input = op.inputKeys.length ? op.inputKeys.join(', ') : 'brak';
  const line = `- ${op.name}: ${op.description} (input: ${input})`;
  const d = op.descriptor;
  if (!d) return line;
  const fields = d.fields
    .map((f) => `${f.field}: ${f.label}, ${f.type}${f.unit ? ` [${f.unit}]` : ''}`)
    .join('; ');
  const where = d.collection ? `rekordy kolekcji ${d.collection}` : 'rekordy wyniku';
  return (
    `${line}\n  ${where} (rodzaj ${d.record.kind}, id: ${d.record.idField}) maja pola: ${fields}` +
    '; tylko te pola wskazujesz w komponentach danych'
  );
}
