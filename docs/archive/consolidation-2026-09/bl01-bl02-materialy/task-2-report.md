# Raport — Task 2: BL-01 — sortowanie, paginacja, kontrolki filtra i stan widoku w kontekście agenta

- Gałąź / worktree: `bl01-bl02/t2-stan-widoku` — `/home/paczos/Documents/agentic-app-template-wt/t2-stan-widoku` (baza `3097586`)
- Kryteria: **L2.17**; wkład do **L6.17** (stan po akcji w kontekście kolejnego polecenia); próba **T26**
- Data: 2026-09-17
- Status: **DONE_WITH_CONCERNS** (bramka G10 zielona; obawy w sekcji 9)

| SHA | Temat |
|---|---|
| `3a3c904` | Stan widoku w adresie: sortowanie, strony i kontrolki DataTable, ui_sort, stan widoku w AppContext.filters |
| `da01b32` | Strumien zdarzen wykonania nie gubi zdarzen wyemitowanych, gdy czytelnik wysyla poprzednie (własna poprawka — wycofana w `d848b44`) |
| `02c8f25` | E2E stanu widoku (port 8798, .e2e-scripted-viewstate) |
| `d848b44` | Wycofanie wlasnej poprawki RunEventStream.read na rzecz 05cfe10 z Task 3 (test regresji zostaje) |
| `95fd5dc` | **cherry-pick `05cfe10` z Task 3** — Strumien wykonania: zdarzenie wyemitowane w trakcie obslugi poprzedniego nie czeka na kolejne |
| `a954e5d` | Test regul zmiany stanu widoku porownuje scisle |
| `bf55ede` | Powtorzone to samo zawezenie lub sortowanie odpowiada stanem na ekranie, nie not_applied (uwaga koordynatora 1) |
| `bae56ba` | Kontrolki zawezenia: znacznik biezacego warunku jako zwykly tekst (bajt NUL) |

Suma `3097586..HEAD`: 33 pliki, +2725 / −183. Stan `events.ts` po `d848b44`+`95fd5dc` jest identyczny z `05cfe10` (scalenie z T3 bez konfliktu treści).

Rodzaje dowodów: **test kontraktu lub logiki** (Vitest), **test GUI bez modelu** (Playwright, bez wysyłania poleceń), **symulacja** (Playwright ze skryptowanym modelem; krok `call` uruchamia prawdziwe handlery `get_context`, `ui_filter`, `ui_sort` przez prawdziwą bramkę potwierdzeń). Prawdziwego modelu nie użyto.

---

## 1. Co zrobiono (punkty „Musi”)

### 1.1 Stan widoku w adresie (AD-6)
- **Kontrakty** (`packages/platform-contracts`):
  - `ui.ts`: `dataSortSchema`/`DataSort` **przeniesione** z `views.ts` (bez zmiany kształtu; `views.ts` importuje), nowe `viewPageSchema`/`ViewPage` (`{index≥1, size≥1, count≥0}`, używane też w `semanticInstanceSchema.page`), `VIEW_SORT_SEARCH_KEY='sort'`, `VIEW_PAGE_SEARCH_KEY='page'`, `RESERVED_SEARCH_KEYS = ['c','s','sort','page']` (odmowa startu dla pola filtra o tej nazwie — istniejąca kontrola w `registry/ui-targets.ts`), `uiCommandSchema.sort: DataSort | null | undefined`, `UI_COMMAND_FAILURES.notSortable = 'not_sortable'`, `uiCommandResultSchema.sorted?: DataSort|null`, `page?: ViewPage`.
  - `view-state.ts` (nowy, czyste funkcje dla przeglądarki i serwera): `parseAddressSearch`/`stringifyAddressSearch` (parametry jako zwykłe napisy), `sortToParam`/`sortFromParam` (`name` / `-name`), `pageToParam`/`pageFromParam` (od 1; strona 1 = brak parametru), `isSortableField`/`sortableFields`/`checkSortField` (`unknown_field` | `not_sortable` + lista dozwolonych), `pageSlice(matched, size, requested)` (liczba stron ≥ 1, przycinanie do ostatniej z `clamped`), `viewStatePatch(filterFields, {predicates?, sort?, page?})` (jedno miejsce reguł: nowe zawężenie zastępuje stare, zmiana zawężenia lub sortowania wraca na stronę 1), `applySearchPatch`, `viewAddressKey` (znormalizowany klucz stanu adresu), `viewStateContextSchema`/`ViewStateContext`.
  - `module.ts`: `ToolCallContext.requestUi` przyjmuje `sort?`; `runtime.ts` przekazuje `sort` do `UiCommand`.
- **Router** (`apps/web/src/router.tsx`): `parseSearch: parseAddressSearch`, `stringifySearch: stringifyAddressSearch`. Bez tego `?page=2` było parsowane jako liczba 2 i **odrzucane** przez walidator sesji (zachowuje tylko napisy), a zapis dawał `page=%222%22` (sonda: `defaultParseSearch('?page=2&taxId=5213456789')` → `{page: 2, taxId: 5213456789}`; `defaultStringifySearch({page:'2'})` → `?page=%222%22`). Poprawia też istniejący ukryty błąd: link z liczbowym zawężeniem (`?taxId=5213456789`) był gubiony. `retainSearchParams(['c','s'])` bez zmian — `sort`/`page` zachowują się jak parametry filtra (należą do widoku, znikają przy wyjściu, wracają z Wstecz).
- **Model** (`platform-ui/src/views/model.ts`): `buildDataModel` przyjmuje `addressSort`, `pageSize`, `page`; zwraca dodatkowo `shown` (rekordy strony), `baseCount`, `sort` (obowiązujący), `sortFromAddress`, `rejectedSort`, `page: PageSlice|null`. Sortowanie z adresu nadpisuje sortowanie kompozycji; sortowanie przez `sortRecords` z T1 (liczby/kwoty liczbowo, daty chronologicznie, tekst `localeCompare('pl')`, puste na końcu). `describeDataInstance` wypełnia `sort` i `page` prawdziwie, `visibleRecordIds` = rekordy narysowanej strony, `matched` = wszystkie po predykatach.
- **DataTable** (`views/DataTable.tsx`): instancja główna (jak w T1) na **własnej trasie celu** dostaje `useViewAddress(viewId)` → zawężenie, `sort`, `page` z adresu; `pageSize` jest stosowany; inne tabele (karty, czat) stronicują w pamięci. Instancja główna zgłasza pełny stan do `useAppState.viewStates[targetId]` (i nadal `reportFilterOutcome`), a przy odmontowaniu go wycofuje. Akcje w opisie: `filter`, `sort`, `page`, `open_record`.

### 1.2 Kontrolki użytkownika (`views/DataTableControls.tsx`, `styles.css`)
- Pasek zawężenia (`form role="search"`, `data-testid="view-filter-controls"`): lista wyboru dla pól z `values` (opcja „wszystkie”; warunek niewyrażalny listą, np. `in`, pokazany jako bieżąca opcja z opisem), pole tekstowe `contains` dla pozostałych; „Zastosuj” (też Enter) i „Wyczysc”; etykiety `label for`; wartości zsynchronizowane z adresem (Wstecz, link, agent).
- Nagłówki sortowalnych kolumn to przyciski w `th` z `aria-sort` (`ascending`/`descending`/`none`); strzałka rysowana przez CSS `::after` z pustym tekstem alternatywnym, więc tekst nagłówka zostaje etykietą pola (istniejący test `composed-views` porównuje `thead th` z etykietami). Cykl: rosnąco → malejąco → porządek widoku.
- Paginacja `nav aria-label="Strony tabeli"`: „Poprzednia”, „Strona X z Y” (`aria-live="polite"`), „Nastepna” (napisy bez polskich znaków, jak reszta UI).
- Każda zmiana to nawigacja (`navigate({to:'.'})`) — Wstecz cofa. Fokus widoczny (`:focus-visible` powłoki + reguła dla `.pf-sort`); fokus zostaje na nagłówku po sortowaniu z klawiatury (sprawdzone w e2e).
- Pasek nad widokiem (`ViewFilterBanner.tsx`) opisuje też sortowanie (`view-sort-state`: „Sortowanie: Nazwa, malejaco.”), stronę (`view-page-state`: „Strona 2 z 2.” / „(strony 9 nie ma)”) i pominięte sortowanie z adresu (`view-sort-rejected`); przycisk przywraca cały widok (bez zawężenia, porządek widoku, strona 1). Atrybucja „przez agenta” liczona kluczem zawężenia i sortowania.

### 1.3 Akcje agenta
- `agent/tools/ui-sort.ts` (nowy, zarejestrowany w `tools/index.ts` po `ui_filter`): `ui_sort {targetId, field?, direction?, clear?, reason?}`, `effect: 'read'`, `alwaysLoad`. Odmowy **przed** wysłaniem czegokolwiek do przeglądarki: `unknown_target` (+lista celów), `unknown_field` / `not_sortable` (+`requested`, `available: [{field,label,type}]`), `not_sortable` z `available: []` dla celu bez widoku z rekordami; brak `field` bez `clear` → `validation_failed`. `clear=true` wysyła `sort: null` na dowolny cel. Wynik: `{executed, reason, targetId, label, url, cleared, sorted, page, filtered}` — liczby i porządek z potwierdzenia klienta; `not_applied` przekazywane bez zmian.
- `registry/view-sorting.ts` (nowy): `primaryDescriptorOf`, `sortableFieldsOfTarget` — jedno rozwiązanie cel → widok → `primaryOperation` → deskryptor dla katalogu, narzędzia i promptu.
- `ui_catalog` zwraca `sortableFields` (tylko dla celów z widokiem i deskryptorem); `ui_filter` zwraca `page`.
- **UiCommandRunner**: obsługuje `sort`; buduje adres docelowy przez `viewStatePatch`; na **innym** ekranie zaczyna od czystych parametrów (dawniej rozlewał wszystkie parametry poprzedniego ekranu, co po dodaniu `sort`/`page` przeniosłoby porządek lub stronę na inny widok); czeka (do 80×60 ms) na raport widoku dla **tego samego klucza adresu**, więc stary raport nie może odpowiedzieć na nowe polecenie, a powtórzenie tego samego stanu odpowiada stanem na ekranie (uwaga koordynatora 1); `not_applied`, gdy brak raportu albo porządek w raporcie ≠ żądany; ekran modułu bez raportu (ścieżka `filterOutcome`) działa jak dotąd, a przy niezmienionym adresie zachowuje licznik.
- Skryptowany model: krok `ui` przyjmuje `sort` (przez prawdziwą bramkę) i wypisuje `sortowanie=`/`strona=`; scenariusze `viewstate-filter-sort`, `viewstate-repeat`, `viewstate-sort-refused`, `viewstate-clear`.

### 1.4 Kontekst
- `useAppState.viewStates` (`ViewStateReport`: target, instancja, klucz adresu, predykaty, sortowanie + etykieta + źródło, odrzucone sortowanie, strona, przycięcie, `matched`, `total`), `reportViewState` (bez zmiany stanu przy równej treści), `dropViewState` (tylko własna instancja).
- `toAppContext().filters = { ...s.filters, [targetId]: {predicates, sort, page, matched, total} }` — liczone przy każdym wysłaniu (`chatWiring.send` woła `toAppContext()` w chwili wysłania). `appContextSchema` bez zmian (rekord unknown); brak nowego pola najwyższego poziomu.
- `get_context`: opis mówi, czym jest `filters[<id widoku>]`, wynik ma `filtersNote` („zmienia tylko to, co i w jakiej kolejności widać; dane w bazie są bez zmian”).
- Prompt (`agent/prompt.ts`): w kontekście linia `- stan widoku <id> (tylko prezentacja, dane bez zmian): zawezenie …; sortowanie …; strona X z Y (po N); pokazane M z T` (inne filtry modułu jako JSON); sekcja „## Sortowanie i strony widoku” uczy `ui_sort`, `sortableFields`, odmów i wyniku; zdanie „ZAWEZENIE I SORTOWANIE ZMIENIAJA TYLKO PREZENTACJE … nie zmieniaja danych w bazie”; przy celach `| sortowanie po: …`.

### 1.5 Moduł procurement (`server/views.ts`)
- `DataTable(..., null, 10)` w `procurement.data` i `procurement.cases` (`LIST_PAGE_SIZE = 10`; `null` pomija opcjonalny `title`).
- `contactEmail` (dostawca) i `spec` (pozycja) z `sortable: false`.

### 1.6 Błąd platformy znaleziony przez e2e
`RunEventStream.read` gubił wybudzenie: zdarzenia wyemitowane, gdy czytelnik był zawieszony na `yield` (zapis SSE), czekały na następne emit. Seria `TOOL_CALL_START/ARGS/END` + komenda UI z handlera (`call` → `ui_filter`) docierała do przeglądarki dopiero po 8 s, po `no_client`. Naprawiłem to sam (`da01b32`) i napisałem test regresji; po uwadze koordynatora zastąpiłem swoją poprawkę commitem T3 (`d848b44` + cherry-pick `05cfe10` → `95fd5dc`). Mój test `tests/runtime.test.ts` „czytelnik zajety wysylaniem nie gubi zdarzen…” zostaje i wykrywa brak linii z `05cfe10` (próba T-D(2)).

---

## 2. Decyzje w miejscach, gdzie brief zostawił wybór

1. **Kod błędu dla celu bez widoku sortowalnego**: `not_sortable` z `available: []` (analogicznie do `not_filterable`); pole zadeklarowane z `sortable:false` → `not_sortable`; pole spoza deskryptora → `unknown_field` (rozstrzygnięcie koordynatora).
2. **Sortowanie kompozycji po polu `sortable:false`** jest odrzucane (`validation_failed` z listą dozwolonych) — ta sama reguła dla kompozycji i dla agenta. Sortowanie z **adresu** po polu niedozwolonym jest pomijane i zgłaszane (`rejectedSort`, pasek), nie zamienia ekranu w błąd — tak jak nieznany parametr filtra.
3. **Strona spoza zakresu**: pokazywana ostatnia, adres **nie** jest przepisywany; pasek podaje „(strony N nie ma)”, raport ma `clampedFrom`. `page.count` = liczba stron, co najmniej 1 („strona 1 z 1” dla pustego wyniku).
4. **`total` w `AppContext.filters`** = rekordy, które widok pokazałby bez zawężenia z adresu (to samo, co „z N” w pasku i `filtered.total`); dla widoków modułu równe liczbie rekordów odczytu.
5. **Kontrolki**: zastosowanie przyciskiem/Enter (nie przy każdym znaku/wyborze — każda zmiana to wpis historii). Przycisk paska przywraca cały widok (zawężenie, porządek, strona), nie tylko zawężenie.
6. **Pasek pokazuje się** przy zawężeniu, sortowaniu z adresu, stronie > 1, przycięciu lub odrzuconym sortowaniu.
7. **Tabele poza instancją główną** z `pageSize` stronicują w pamięci (bez adresu), zamiast ignorować prop (T1 wskazał, że ignorowany prop „kłamie” w widokach agenta).
8. **Kodek parametrów routera** zmieniony na zwykłe napisy (uzasadnienie i sonda w 1.1) — minimalna zmiana w `router.tsx`.
9. **Parametry przy nawigacji agenta na inny ekran** startują czysto (`c`/`s` zachowuje middleware) — inaczej `sort`/`page` jednego widoku trafiałyby na drugi.
10. **Potwierdzenie przez klucz adresu** (`viewAddressKey`) zamiast oczekiwania na „nowy” raport — daje jednocześnie ochronę przed starym raportem i idempotencję.
11. **Dowód (d)**: `GET /api/conversations/:id/runs` nie wystawia `app_context`, więc przechwytuję ciało `POST /api/agui/run` i dodatkowo czytam wynik prawdziwego `get_context` z dziennika zdarzeń wykonania (`GET /api/runs/:id/events`, istniejące API) — to kontekst zapisany dla wykonania po stronie serwera. Brak nowego endpointu.
12. **Wyniki narzędzi w e2e** czytam z `GET /api/runs/:id/events` (TOOL_CALL_RESULT), bo gotowy czat pokazuje tylko tekst po ostatnim wywołaniu narzędzia (wcześniejsze echa kroków `call` są zwinięte w „Behind the scenes”).
13. **Dane testowe (c)**: spec dopisuje 12 dostawców do własnej bazy przed startem (`better-sqlite3` z pakietu serwera; właściciel odczytany z zasiewu): 2 polskich na Ł i Ź (porządek polski ≠ porządek kodów) i 10 niemieckich → 16 rekordów, 2 strony po 10.

---

## 3. Zmienione pliki (`3097586..HEAD`)

Kontrakty: `packages/platform-contracts/src/{ui.ts, views.ts, records.ts, module.ts, index.ts, view-state.ts (nowy)}`.
Serwer: `packages/platform-server/src/{agent/tools/ui-sort.ts (nowy), agent/tools/ui.ts, agent/tools/index.ts, agent/tools/context.ts, agent/prompt.ts, agent/runtime.ts, agent/events.ts (cherry-pick 05cfe10), registry/view-sorting.ts (nowy), index.ts}`.
UI: `packages/platform-ui/src/{views/DataTable.tsx, views/DataTableControls.tsx (nowy), views/model.ts, state/appState.ts, state/viewFilter.ts, shell/UiCommandRunner.tsx, shell/ViewFilterBanner.tsx, styles.css}`.
Składanie: `apps/web/src/router.tsx`. Moduł: `packages/module-procurement/src/server/views.ts`.
Testy: `tests/view-state.test.ts` (nowy), `tests/data-components-describe.test.ts`, `tests/runtime.test.ts`, `tests/ui-navigation.test.ts` i `tests/views-foundation.test.ts` (lista narzędzi +`ui_sort`), `e2e/view-state.spec.ts` (nowy), `e2e/support/scripted-agent.ts`, `e2e/support/scripted-server.ts`.
Nie edytowano dokumentów koordynatora (G8) ani zależności (G7).

---

## 4. Polecenia, kody wyjścia, liczby testów (stan końcowy `bae56ba`)

| Polecenie | Wynik |
|---|---|
| `pnpm verify` | **exit 0** — granica, spójność, macierze, typecheck, build, **Vitest 26 plików / 363 testy** (baza T1: 25 / 327) |
| `pnpm check:module-swap` (na `bf55ede`) | **exit 0** — wszystkie kroki OK (platforma bez zmian w kopii, typecheck/build z modułem kontrolnym, powłoka w przeglądarce) |
| `pnpm build && flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/view-state.spec.ts e2e/view-filter.spec.ts e2e/composed-views.spec.ts e2e/ui-navigation.spec.ts e2e/scripted-call.spec.ts e2e/access-context.spec.ts e2e/session-restore.spec.ts e2e/app.spec.ts e2e/chat.spec.ts e2e/chat-drawer.spec.ts e2e/chat-layout.spec.ts e2e/streaming.spec.ts e2e/tool-activity.spec.ts e2e/background-tasks.spec.ts e2e/measurements.spec.ts` (na `bf55ede`) | **exit 0, 79 passed** (view-state 7, view-filter 7, composed-views 4, ui-navigation 5, scripted-call 1, access-context 3, session-restore 6, app 14, chat 7, chat-drawer 6, chat-layout 4, streaming 3, tool-activity 5, background-tasks 5, measurements 2) |
| po `bae56ba`: `pnpm build && flock … playwright test e2e/view-state.spec.ts e2e/view-filter.spec.ts e2e/composed-views.spec.ts e2e/access-context.spec.ts e2e/ui-navigation.spec.ts` | **exit 0, 26 passed** |

Zmiana kodeka adresu jest globalna, dlatego uruchomiłem wszystkie spece bez prawdziwego modelu; pominięte `e2e/agent-ui.spec.ts` i `e2e/files-agent.spec.ts` (prawdziwy model, G4). Po przebiegach usunięto nieśledzone `docs/evidence/chat-ux-2026-09-16/` i `docs/evidence/closure-2026-09-15/` (generowane przez istniejące spece); drzewo czyste.

### 4.1 Co pokrywają nowe testy
**`tests/view-state.test.ts` (33, test kontraktu lub logiki)**: kodowanie/dekodowanie `sort` i `page` (w tym śmieci), zwykłe napisy w adresie (`page=2`, NIP), klucze zarezerwowane `c/s/sort/page` zatrzymują start, reguły `viewStatePatch` (ścisłe porównanie), normalizacja klucza adresu, matematyka stron i przycinanie, porządek wg typów (9<10, kwoty, daty, `Ł` między L i M, puste na końcu w obu kierunkach), adres nadpisuje kompozycję, odrzucone sortowanie z adresu, odmowa sortowania kompozycji po polu niesortowalnym, `checkSortField`, cykl nagłówka, druga strona po zawężeniu i sortowaniu + opis instancji (`sort`, `page`, `visibleRecordIds`, `matched`/`total`), mapowanie do `AppContext.filters` (kształt, `appContextSchema.parse`, liczenie przy wysłaniu, zdjęcie widoku, `setFilter` obok), `ui_sort` przez prawdziwą bramkę runtime (porządek i strona z potwierdzenia, domyślnie `asc`, `unknown_field`/`not_sortable` bez komendy, cel bez widoku, nieznany cel, brak pola, `clear` → `sort: null`, `not_applied`), `ui_filter` niesie `page`, `ui_catalog.sortableFields`, `get_context` + `filtersNote`, prompt (ui_sort, „TYLKO PREZENTACJE”, linia stanu widoku, `sortowanie po:` bez `contactEmail`), kontrakt `uiCommand.sort` i wyniku.
**`tests/data-components-describe.test.ts` (+2, render komponentu bez DOM)**: tabela poza widokiem z `pageSize` (strona 1 z 3, 10 wierszy, opis); instancja główna z adresem: `aria-sort="descending"`/`"none"`, wybrana opcja `PLN`, wartość pola tekstowego, „Strona 2 z 3”, opis `sort`/`page`/rekordy strony.
**`tests/runtime.test.ts` (+1)**: czytelnik zajęty wysyłką nie gubi zdarzeń.
**`e2e/view-state.spec.ts` (7; symulacja + test GUI bez modelu)**:
- **(a)+(d)** agent (`get_context` → `ui_filter country=PL` → `ui_sort name desc`): kolejność `data-record-id` = rekordy z `/api/read` przefiltrowane i posortowane **komparatorem testu** (`localeCompare('pl')`) + literały fixture (`Źródło Dźwięku`, `MediaPro Systemy`, `Łódzka Technika Sceniczna`, `Konferencje24`, `AV Technika Sp. z o.o.`); adres `country=PL&sort=-name`, brak `page`; `aria-sort` descending/none/brak na `contactEmail`; lista `PL`; pasek „Widok zawezony przez agenta.”, „pokazane 5 z 16”, „Sortowanie: Nazwa, malejaco.”; wyniki handlerów (`filtered`, `sorted`, `page`); **dane backendu identyczne przed i po** (`/api/read` i `/api/m/procurement/suppliers`); pierwsze polecenie niosło stan sprzed akcji (bez zawężenia, 2 strony, 16 z 16); **kolejne polecenie z GUI niesie `{predicates:[country eq PL], sort:{name,desc}, page:{1,10,1}, matched:5, total:16}`** w ciele żądania i w wyniku `get_context` wykonania.
- **(a) powtórzenie** tego samego zawężenia i sortowania: 4 wyniki `executed:true` z liczbami i stroną, żaden `not_applied`.
- **(b)** użytkownik: lista Kraj=FI → wiersze = rekordy FI z backendu, adres, pasek bez „przez agenta”; pole Nazwa „techn” (Enter) → 2 rekordy, `name=~techn`, `country` usunięty; Wstecz → FI i kontrolki pokazują FI; kolejne polecenie niesie zawężenie ustawione kontrolką.
- **(c)** strony: 10 wierszy = backend[0..10], „Nastepna” → `page=2`, 6 wierszy = backend[10..], pasek „Strona 2 z 2.”; Wstecz/Dalej; klawiatura (Enter na nagłówku „Nazwa”) → `sort=name`, strona 1, kolejność z komparatora testu, fokus zostaje; drugi Enter → malejąco; `/data?page=9` → „Strona 2 z 2 (strony 9 nie ma).”.
- **(e)** odmowy: `ui_sort wojewodztwo` → `unknown_field` z listą, `ui_sort contactEmail` → `not_sortable` z listą; wiersze, parametry widoku i `aria-sort` bez zmian.
- **(e)** zawężenie do zera: `data-state="empty"`, „Zaden rekord nie spelnia zawezenia — pokazane 0 z 16.”, brak `query-error`, kontrolki zostają, strona wraca do 1; „Wyczysc” → 10 wierszy, „Strona 1 z 2”, brak parametrów i paska.
- **(e)** agent czyści (`ui_sort clear`, `ui_filter clear`) z `/data?country=DE&sort=-name&page=2` (przycięte „Strona 1 z 1 (strony 2 nie ma).”) → wiersze backendu, strona 1 z 2, `aria-sort="none"`, brak parametrów i paska; Wstecz cofa ostatnią zmianę agenta (`country=DE`, porządek widoku).

---

## 5. Kontrole negatywne i próby zdolności wykrycia

Kontrole negatywne z treści kryterium: niezadeklarowane i niesortowalne pole (odmowa po nazwie, widok nietknięty), dane backendu niezmienione (porównanie przed/po), pusty zbiór jako stan „0 z N”, nie błąd, wyczyszczenie przywraca pełny zakres i stronę 1, stary raport nie odpowiada na nowe polecenie (klucz adresu).

Próby: wycofanie kluczowej linii bez commitu → test → `git checkout -- <plik>` (dla UI z `pnpm build` przed e2e) → zielono.

| Próba | Wycofanie | Wynik |
|---|---|---|
| T-A | `viewStatePatch`: usunięty reset strony przy zmianie zawężenia/sortowania | **33/33 passed — test NIE wykrył** (`toEqual` ignoruje klucz o wartości `undefined`). Poprawiony test (`toStrictEqual`, `a954e5d`). |
| T-A(2) | j.w., po poprawie testu | **1 failed / 32** — `expected { country: 'PL', name: undefined } to strictly equal { … page … }`. Po przywróceniu 33/33. |
| T-B | `toAppContext`: bez stanu widoków | **4 failed / 29** (testy mapowania do `AppContext.filters`). Po przywróceniu 33/33. |
| T-C | `ui_sort`: pominięte `checkSortField` | **2 failed / 31** (`unknown_field`, `not_sortable` — komenda trafiała do przeglądarki). Po przywróceniu 33/33. |
| T-D | `events.ts`: wycofana moja linia | **1 failed / 24** (`['TOOL_CALL_START']` zamiast 4 zdarzeń). Po przywróceniu 25/25. |
| T-D(2) | `events.ts`: usunięta linia z `05cfe10` | **1 failed / 24**. Po przywróceniu 25/25. |
| T-H | `sortRecords`: porównanie kodów zamiast `localeCompare('pl')` | **1 failed / 32** („…tekst po polsku…”). Po przywróceniu 33/33. |
| T-E | router: domyślny kodek JSON (build) | e2e (c) **failed**: `Expected "2"`, `Received "\"2\""`. |
| T-F | `DataTable`: `addressSort: null` (build) | e2e (a)+(d) **failed**: kolejność wierszy (`- Expected 3 / + Received 3`). |
| T-G | `toAppContext` bez stanu widoków (build) | e2e (a)+(d) **failed**: `context.filters` pierwszego polecenia (`- Expected 13 / + Received 1`). |
| T-I | runner usuwa stojący raport przed nawigacją (wymusza „nowy” raport) (build) | e2e „to samo zawezenie i sortowanie drugi raz” **failed**: `executed: false` zamiast `true` z liczbami. |

Po próbach: build na przywróconym kodzie, pełna bramka z sekcji 4.

---

## 6. Nieudane przebiegi (poza próbami z sekcji 5)

1. `tests/data-components-describe.test.ts`, pierwszy przebieg nowego testu instancji głównej: **1 failed / 10** — `expected ['t14'…'t10'] to deeply equal ['t13'…'t1']`. **Błąd w oczekiwaniu testu** (źle policzona druga strona `n19…n10, n1`); poprawione oczekiwanie, kod bez zmian.
2. `e2e/view-state.spec.ts`, pierwszy przebieg: **1 failed, 5 did not run** — `ui_sort` zwrócił `no_client`, choć ekran był już zawężony i posortowany. Ślad Playwright: każde `POST /ui-ack` przychodziło ~8 s po starcie polecenia. **Błąd platformy** (`RunEventStream.read`, sekcja 1.6), plus **wada testu**: czat pokazuje tylko tekst po ostatnim narzędziu, więc echo `[call:ui_filter]` nie było widoczne — asercje przeniesione na `GET /api/runs/:id/events`.
3. Drugi przebieg: **3 passed, 1 failed** — test (e) porównywał cały URL, a pierwsze polecenie dopisało sesyjne `c=cnv_…`. **Wada testu**; porównywane są parametry widoku bez `c`/`s`.
4. Wcześniej (przed pierwszym uruchomieniem) poprawiłem w teście dwa własne błędy oczekiwań: pasek pokazuje przyciętą stronę, a `url` w potwierdzeniu zawiera `c`.
5. Podczas przywracania po próbie T-I `git checkout -- UiCommandRunner.tsx` usunął też **niezacommitowaną** zmianę idempotencji ścieżki `filterOutcome`. Zmiana nałożona ponownie (identycznie) i zacommitowana (`bf55ede`); próba T-I była wykonana na kodzie z tą zmianą. Pełna bramka po tym.

---

## 7. Kontrakt dla autora modułu

- **Pola sortowalne**: każde pole deskryptora wyniku (`ModuleReadOperation.result.fields`) jest sortowalne, chyba że ma `sortable: false`. Porządek wg typu: `number`/`money_minor`/`quantity_milli` liczbowo, `date` chronologicznie, `enum` po etykiecie, `text` `localeCompare('pl')`, puste na końcu w obu kierunkach. Oznacz `sortable: false` pola, po których sortowanie nie ma sensu (e-mail, długi opis).
- **Stronicowanie**: `DataTable(source, columns, title, pageSize)` — `pageSize` 1–200. Pomijany argument pozycyjny zapisuje się jako `null` (np. `DataTable({operation: "m.op"}, ["a","b"], null, 10)`).
- **Stan w adresie** dotyczy instancji głównej widoku (`ViewDefinition.primaryOperation`) na trasie celu `UiTarget.to` o `id` równym `id` widoku: zawężenie `?pole=wartość` (pola z `UiTarget.filter`), `?sort=pole` / `?sort=-pole`, `?page=N` (od 1). Inne tabele tego widoku i tabele w kartach nie czytają adresu.
- **Zarezerwowane klucze**: pole zawężenia (`UiTarget.filter.fields[].field`) nie może nazywać się `c`, `s`, `sort`, `page` — start aplikacji zostaje przerwany z nazwą celu i pola.
- **Sortowanie w kompozycji** (`sort`) po polu niezadeklarowanym lub `sortable:false` → komponent w stanie błędu z nazwą pola i listą dozwolonych. Sortowanie z adresu po takim polu → pominięte i opisane w pasku.
- **Agent**: `ui_catalog` pokazuje `sortableFields` celu z widokiem; `ui_sort` odmawia `unknown_field` (pole spoza deskryptora), `not_sortable` (pole `sortable:false` albo cel bez widoku z rekordami) z listą dozwolonych, zanim cokolwiek trafi do przeglądarki; `not_applied`, gdy widok nie zgłosił zastosowania.
- **Kontekst**: widok na ekranie trafia do `AppContext.filters[<id celu>] = {predicates, sort, page, matched, total}` przy każdym wysłaniu polecenia; moduł nie musi nic robić. Własne klucze modułu w `filters` (przez `setFilter`) zostają obok.
- Ekran modułu **bez** kompozycji (`useModuleData`) nadal dostaje zawężenie z adresu, ale nie sortowanie ani strony.

---

## 8. Self-review — ustalenia

- Znalezione i poprawione: słaby test reguł łatki (T-A); bajt NUL w stałej `CURRENT` robił z `DataTableControls.tsx` plik binarny dla gita (`bae56ba`); przenoszenie parametrów poprzedniego ekranu przez runner (dotąd nieszkodliwe dla filtrów, szkodliwe dla `sort`/`page`); powtórzone polecenie — obsłużone kluczem adresu (+ ścieżka `filterOutcome`).
- Granica platforma–domena: `pnpm check:boundaries` OK (w `verify`); platforma zna tylko nieprzezroczyste nazwy pól i celów.
- G9: schemat sortowania jeden (`dataSortSchema` przeniesiony, nie skopiowany), strona jedna (`viewPageSchema`), reguły zmiany stanu w jednej funkcji (`viewStatePatch`) używanej przez kontrolki, pasek i runner; sortowanie tylko przez `sortRecords`; formatowanie bez zmian. Schemat wejścia `ui_sort` bez `z.record()` i `.default()` (test `mcp-schema` w `verify`).
- Zmiany we wspólnych plikach lokalne: `prompt.ts` (linie kontekstu + nowa sekcja), `UiCommandRunner.tsx` (blok filtra przepisany na wspólny blok filtra/sortowania — tu możliwy konflikt z T3/T6), `appState.ts` (nowe pola i jedna linia `filters`), `scripted-server.ts` (nowe scenariusze na końcu), `router.tsx` (dwie opcje), `DataTable.tsx` (większa zmiana — możliwy konflikt z T4 `groupBy`).
- Instancja użytkownika (8791), główny checkout i inne worktree nietknięte; e2e wyłącznie pod blokadą; `check:module-swap` na kopii w `/tmp` z wolnym portem.

---

## 9. Obawy

1. **`null` dla pominiętego `title`** w kompozycjach modułu: Renderer OpenUI to akceptuje (materializacja pomija walidację `null`), ale walidator kompozycji z T4 musi traktować `null` pozycyjnego argumentu opcjonalnego jak brak (Zod `.optional()` sam nie przyjmie `null`). Do sprawdzenia przy scalaniu T4.
2. **Zmiana kodeka parametrów routera** jest globalna: stare linki z parametrami w cudzysłowach JSON (`%22…%22`) nie zadziałają jako filtry. Pełna suita bez modelu zielona; `agent-ui.spec.ts` nieuruchomiony (G4).
3. **Wcześniejsze wyniki narzędzi nie są widoczne w czacie** (gotowy czat pokazuje tekst po ostatnim narzędziu); e2e czyta je z dziennika zdarzeń. Dotyczy wszystkich scenariuszy z kilkoma krokami `call` (T3/T6/T7).
4. **Ścieżka `filterOutcome` bez kompozycji** (idempotencja zawężenia ekranu modułu) nie ma testu przeglądarkowego — żaden ekran modułu nie używa już `useModuleData` z celem deklarującym `filter`.
5. **`RunEventStream`**: mój commit `da01b32` i jego wycofanie `d848b44` zostają w historii gałęzi (bez przepisywania historii); wynik końcowy = `05cfe10`.
6. **Konflikty tekstowe przy scalaniu** prawdopodobne w `UiCommandRunner.tsx` (T3: `uiVersion`, T6: odsłanianie), `ui.ts` (`uiCommandResultSchema`), `DataTable.tsx` (T4), `prompt.ts` i `appState.ts` (T3: `AppContext.ui`).
7. Fokus po kliknięciu „Nastepna” na przedostatniej stronie: przycisk staje się nieaktywny i fokus wraca do dokumentu (typowe zachowanie; nie przenoszę go ręcznie).
8. Pasek pokazuje „przez agenta” według klucza zawężenia i sortowania; jeśli agent zawęzi, a użytkownik posortuje, atrybucja znika (świadomie — stan nie jest już wyłącznie dziełem agenta).

---

## 10. Uwagi koordynatora (wiadomość w trakcie pracy)

1. **Powtórzenie tego samego zawężenia/sortowania → `not_applied`**: na tej gałęzi runner porównuje klucz adresu z raportem widoku, więc powtórzenie dostaje `executed: true` z liczbami i stroną; dodatkowo ścieżka `filterOutcome` zachowuje licznik przy niezmienionym adresie (`bf55ede`). Test: e2e „(a) to samo zawezenie i sortowanie drugi raz” (ui_filter ×2, ui_sort ×2), próba T-I.
2. **`05cfe10`**: wykryłem ten sam błąd niezależnie (sekcja 1.6); moja poprawka zastąpiona cherry-pickiem `05cfe10` (`95fd5dc`); mój test regresji zostaje i wykrywa brak ich linii.

---

## Fix round 1 (po przeglądzie: „Needs fixes”)

Commit: `3993c4f` — Poprawki po przegladzie T2 (runda 1): widoki bez zapamietanej porazki, ui_sort clear bez widoku, operator zawezenia zachowany, lista celow w promptcie, asercja drugiego polecenia (10 plików).

### Zmiany wg ustaleń

**I1 — zapamiętana porażka `/api/ui/views`.** Decyzje runnera sprzed dotknięcia ekranu wydzielone do czystego modułu `packages/platform-ui/src/shell/uiCommandPlan.ts`:
- `cachedLoader(load)` — zapamiętuje tylko udane wczytanie; porażka zwraca `null` i następne polecenie pyta ponownie (runner: `useMemo(() => cachedLoader(...))`, definicje pobierane tylko dla polecenia zmieniającego stan widoku);
- `planViewCommand({command, target, views, location})` → `refuse(reason)` albo `apply({patch, expected, expectedKey, samePath, unchanged, reportingView, awaitsView, …})`. Gdy `views === null`, a polecenie zmienia stan widoku (ustawienie/czyszczenie zawężenia albo porządku): **`views_unavailable`** — nowy kod `UI_COMMAND_FAILURES.viewsUnavailable` w `ui.ts` („nic nie zrobiono, ponowienie może się udać”). Nigdy fałszywe `not_sortable` ani sukces bez sprawdzenia ekranu. Odmowy niezależne od widoków (`not_filterable`, `unknown_field`) zachowują swój powód; zwykła nawigacja nie potrzebuje definicji. `UiCommandRunner.tsx` używa planu zamiast bloku inline (zachowanie poza I1/R1 bez zmian — potwierdzają e2e).

**R1 — `ui_sort clear=true` na celu bez widoku sortowalnego.** Serwer (`ui-sort.ts`): sprawdzenie `primaryDescriptorOf` przed rozgałęzieniem na ustawianie/czyszczenie → `{executed:false, reason:'not_sortable', targetId, label, available: []}` bez `requestUi` (brak komendy, brak nawigacji). Klient (`planViewCommand`): `ordering !== undefined` (także `null`) na celu bez instancji głównej → `not_sortable` przed nawigacją. Opis narzędzia uzupełniony. Test `tests/view-state.test.ts` zmieniony: czyszczenie na `procurement.data` wysyła `sort: null`; na `platform.settings` — `not_sortable`, 0 komend.

**R2 — „Zastosuj” zamieniało `eq` agenta w `contains`.** `DataTableControls.tsx`: pasek pamięta pola edytowane przez użytkownika (`edited`, zerowane przy zmianie adresu); przy zastosowaniu **pola nieedytowane zachowują swój predykat bez zmian** (każdy operator), przebudowywane są tylko edytowane (lista → `eq`, tekst → `contains`). Pole tekstowe z zastosowanym warunkiem pokazuje operator obok (`data-filter-op-for`, `aria-describedby`): „rowna sie” / „zawiera” (po edycji — „zawiera”, bo tak zostanie zastosowane).

**R3 — struktura promptu.** Lista celów (`- <id> [kind] …| zawezanie po … | sortowanie po …`) stoi teraz bezpośrednio pod „# Sterowanie interfejsem” (po zdaniach, które mówią „ponizsza lista”), z wierszem wprowadzającym; „## Zawezanie widoku” i „## Sortowanie i strony widoku” są samodzielne i nie zawierają listy. Test sprawdza kolejność sekcji i brak wierszy celów w sekcji sortowania.

**R4 — pusta asercja w (d).** Usunięte `toContainText('Zawezilem i posortowalem widok.')` (tekst był już na ekranie z pierwszego wykonania). Teraz: pasek stanu wskazuje drugie wykonanie (`last-run` = `run <ostatnie 8 znaków second.runId>`), odpowiedź pojawia się drugi raz (`getByText(...)` → 2 elementy), `get_context` drugiego wykonania zwraca przeniesiony stan (poll bez zmian), a wyniki jego własnych narzędzi (dziennik zdarzeń `second.runId`) to `ui_filter` `executed:true, filtered 5 z 17` i `ui_sort` `executed:true, sorted name desc`.

### Testy pokrywające

- `tests/view-state.test.ts` (33 → **38**): „nieudane wczytanie widokow nie jest zapamietywane…” (I1, loader), „bez definicji widokow zmiana stanu widoku to views_unavailable…” (I1, plan: sort, sort null, filter null, filter; `unknown_field` bez zmian; nawigacja bez widoków), „z definicjami widokow: sortowanie i czyszczenie na widoku czekaja na raport…” (plan: `awaitsView`, łatka, adres docelowy, `unchanged`, czysty start z innego ekranu), „czyszczenie porzadku celu bez widoku z rekordami: not_sortable, bez nawigacji” (R1 klient), „clear=true na celu bez widoku z rekordami: not_sortable, bez komendy…” (R1 serwer), rozdzielony test czyszczenia na `procurement.data`, kolejność sekcji promptu (R3), kod `views_unavailable` w kontrakcie.
- `e2e/view-state.spec.ts` (7 → **8**; symulacja): nowy „(b) zawezenie agenta "rowna sie" na polu tekstowym zostaje takie, gdy uzytkownik zmienia inne pole” — scenariusz `viewstate-exact-name` (`ui_filter name eq NordAV` przez prawdziwy handler); dane testu mają dodatkowego dostawcę „NordAV” (CZ), więc `eq` daje 1 wiersz, a `contains` 2; po wpisaniu przez użytkownika „12345678” w NIP i „Zastosuj”: adres `name=NordAV` (nie `~NordAV`), `taxId=~12345678`, wiersze = rekordy backendu z `name === 'NordAV'` i NIP zawierającym `12345678`, pasek „Nazwa dostawcy: NordAV” i „NIP zawiera „12345678””, podpowiedź „rowna sie” przy polu. Test (a)+(d) z asercją R4. `TOTAL` = 17 (wszystkie oczekiwania liczone z backendu).

### Polecenia i wyniki (stan `3993c4f`)

| Polecenie | Wynik |
|---|---|
| `pnpm exec vitest run tests/view-state.test.ts` | exit 0, **38 passed** |
| `pnpm build && flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/view-state.spec.ts e2e/view-filter.spec.ts` (przed commitem, ten sam kod) | exit 0, **15 passed** (view-state 8, view-filter 7) |
| `pnpm verify` | **exit 0** — spójność OK, typecheck, build, **Vitest 26 plików / 368 testów** |
| `flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/view-state.spec.ts e2e/view-filter.spec.ts e2e/ui-navigation.spec.ts e2e/access-context.spec.ts e2e/composed-views.spec.ts` (po `verify`, build z `verify`) | **exit 0, 27 passed** (view-state 8, view-filter 7, ui-navigation 5, access-context 3, composed-views 4) |

`ui-navigation` dołączony, bo refaktor runnera dotyka zwykłej nawigacji. Po przebiegach usunięto nieśledzone `docs/evidence/chat-ux-2026-09-16/` i `docs/evidence/closure-2026-09-15/`; drzewo czyste.

### Próby zdolności wykrycia (zmiany po commicie → test → `git checkout -- packages` → zielono)

| Próba | Wycofanie | Wynik |
|---|---|---|
| I1a | `cachedLoader`: porażka zapamiętana jako pusta lista (dawne zachowanie) | **1 failed / 37** — „nieudane wczytanie widokow nie jest zapamietywane…”: `expected [] to be null`. Po przywróceniu 38/38. |
| I1b | `planViewCommand`: brak widoków traktowany jak brak widoku (`if (false)` zamiast `views === null`) | **1 failed / 37** — „bez definicji widokow… views_unavailable…”: `{ kind: 'refuse', … }` z innym powodem (`not_sortable`). Po przywróceniu 38/38. |
| R1a | `ui-sort.ts`: czyszczenie pomija sprawdzenie widoku (`!primary && !clearing`) | **1 failed / 37** — „clear=true na celu bez widoku z rekordami…”: `expected { executed: true, …(8) } to deeply equal { executed: false, …(4) }`. Po przywróceniu 38/38. |
| R1b | `planViewCommand`: sprawdzane tylko ustawienie porządku (`if (ordering && …)`) | **1 failed / 37** — „czyszczenie porzadku celu bez widoku…”: `expected { kind: 'apply', … } to deeply equal { kind: 'refuse', … }`. Po przywróceniu 38/38. |
| R2 | `FilterBar`: każde pole przebudowywane z tekstu (`if (false)` zamiast `!edited.has`), `pnpm build` | e2e „(b) zawezenie agenta "rowna sie"…” **failed**: `Expected: "NordAV"`, `Received: "~NordAV"`. Po przywróceniu `pnpm build` i pełny przebieg z tabeli wyżej. |

### Nieudane przebiegi w tej rundzie

Brak poza celowymi próbami z tabeli.

### Kontrakt dla autora modułu — uzupełnienie

- Potwierdzenie polecenia UI może mieć powód `views_unavailable`: klient nie wczytał definicji widoków, nic nie zrobił; ponowienie może się udać.
- `ui_sort clear=true` działa tylko na celu, którego widok ma rekordy do porządkowania (instancja główna z deskryptorem); na innym celu odpowiada `not_sortable` i nie zmienia ekranu.
- Pasek zawężenia widoku: pole, którego użytkownik nie edytował, zachowuje warunek ustawiony przez agenta lub link (także `eq`, `neq`, `in`); edytowane pole tekstowe zawęża przez „zawiera”, lista — przez „równa się”.

### Obawy po rundzie

Sekcja 9 bez zmian, z uwagami:
1. `ui_filter clear=true` na celu bez zawężenia (np. `platform.settings`) nadal przenosi na jego ekran i odpowiada `cleared: true` — ta sama klasa co R1, ale istniejący kontrakt z T1 i test `tests/view-filter.test.ts` „clear=true przywraca pelny widok i dziala na kazdym celu”; rozstrzygnięcie R1 dotyczyło `ui_sort`, więc nie zmieniałem. Do decyzji koordynatora.
2. `setSpace(command.spaceId)` w runnerze wykonuje się przed planem (jak przed zmianą), więc odmowa zmiany stanu widoku w poleceniu, które przełącza też przestrzeń, przełączy przestrzeń. Narzędzia `ui_filter`/`ui_sort` wysyłają `spaceId: null`, więc nie dotyczy ich w praktyce.

---

## Fix round 2 (rozstrzygnięcie koordynatora R5 + przestrzeń pracy)

Commit: `de247be` — Poprawki po przegladzie T2 (runda 2): ui_filter clear na celu bez zawezenia odmawia not_filterable, przestrzen przelaczana dopiero po odmowach (5 plików). Commity `bae56ba..3993c4f` bez zmian.

### Zmiany

**R5 — `ui_filter clear=true` na celu bez `filter`.**
- Serwer (`agent/tools/ui.ts`): sprawdzenie `known.filter` przed rozgałęzieniem na ustawianie/czyszczenie → `{executed: false, reason: 'not_filterable', targetId, label}` bez `requestUi` (brak komendy, brak nawigacji). Na celu, który deklaruje zawężenie, czyszczenie działa jak dotąd — zawsze wysyła `filter: null`, niezależnie od parametrów w adresie. Komentarz opisuje obie połowy (dawne „Clearing is allowed on any view…” usunięte, bo przestało być prawdą). Opis narzędzia: „clear=true … (tylko widok z filterableFields; inny cel odpowiada not_filterable i nic nie zmienia)”. Prompt nie obiecywał „każdego celu” — bez zmian.
- Klient (`shell/uiCommandPlan.ts`): `filter !== undefined` (także `null`) na celu bez `filter` lub bez `to` → `refuse not_filterable` przed jakąkolwiek nawigacją, niezależnie od dostępności definicji widoków.

**Przestrzeń pracy po odmowach.** `planViewCommand` przyjmuje `spaceId` i zwraca `switchSpace` wyłącznie w wyniku `apply`; `UiCommandRunner` wywołuje `setSpace(plan.switchSpace)` dopiero po obsłużeniu `refuse` (wcześniej `setSpace` stało przed wszystkimi kontrolami). Odrzucone polecenie nie zmienia przestrzeni.

### Testy

- `tests/view-filter.test.ts`: test przemianowany na „clear=true przywraca pelny widok celu z zawezeniem, a cel bez zawezenia odmawia bez komendy” — `procurement.data`: 1 komenda z `filter: null`, `executed`, `cleared`; `platform.settings`: wynik `{executed:false, reason:'not_filterable', targetId:'platform.settings', label:'Ustawienia'}`, 0 komend.
- `tests/view-state.test.ts` (38 → **40**): „czyszczenie zawezenia celu bez zawezenia: not_filterable, bez nawigacji, niezaleznie od widokow i adresu” (plan z widokami i bez; cel z zawężeniem czyszczony przy pustym adresie — łatka czyści wszystkie zadeklarowane pola i stronę); „przestrzen pracy przelacza tylko polecenie wykonywane, nigdy odrzucone” (odmowy `not_sortable` i `views_unavailable` bez `switchSpace`; wykonywana nawigacja z `switchSpace: 'sp_inna'` / `null`).
- E2E bez zmian w spece; istniejące przypadki czyszczenia dotyczą `procurement.data` (cel z zawężeniem).

### Polecenia i wyniki (stan `de247be`)

| Polecenie | Wynik |
|---|---|
| `pnpm exec vitest run tests/view-filter.test.ts tests/view-state.test.ts tests/ui-navigation.test.ts` | exit 0, **75 passed** (21 + 40 + 14) |
| `pnpm build && flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/view-filter.spec.ts e2e/view-state.spec.ts` (kod identyczny z `de247be`, uruchomione tuż przed commitem) | **exit 0, 15 passed** (view-filter 7, view-state 8) |
| `pnpm verify` | **exit 0** — spójność OK, typecheck, build, **Vitest 26 plików / 370 testów** |

Po e2e usunięto nieśledzone `docs/evidence/chat-ux-2026-09-16/` i `docs/evidence/closure-2026-09-15/`; drzewo czyste.

### Próby zdolności wykrycia (po commicie: zmiana → test → `git checkout -- packages` → zielono)

| Próba | Wycofanie | Wynik |
|---|---|---|
| R5a | `ui.ts`: sprawdzenie `filter` tylko przy ustawianiu (`!known.filter && !clearing`) | `tests/view-filter.test.ts` **1 failed / 20** — `expected { executed: true, …(7) } to deeply equal { executed: false, …(3) }`. Po przywróceniu 21/21. |
| R5b | `planViewCommand`: odmowa tylko dla ustawianego zawężenia (`if (narrowing && …)`) | `tests/view-state.test.ts` **1 failed / 39** — „czyszczenie zawezenia celu bez zawezenia…”: `expected { kind: 'apply', … } to deeply equal { kind: 'refuse', … }`. Po przywróceniu 40/40. |
| S | odmowa `not_sortable` niesie `switchSpace` | **2 failed / 38** — „przestrzen pracy przelacza tylko polecenie wykonywane…” i „czyszczenie porzadku celu bez widoku…”: `{ kind: 'refuse', …(2) }` zamiast `…(1)`. Po przywróceniu 40/40. |

Uwaga do próby S: sprawdza kontrakt planu (odmowa bez `switchSpace`); kolejność w komponencie (`setSpace` po `return` odmowy) jest widoczna w kodzie runnera i nie ma testu przeglądarkowego.

### Nieudane przebiegi w tej rundzie

Brak poza celowymi próbami.

### Kontrakt dla autora modułu — uzupełnienie

- `ui_filter clear=true` działa tylko na celu deklarującym `UiTarget.filter` (zawsze, niezależnie od adresu); na innym celu odpowiada `not_filterable` i nie zmienia ekranu — tak samo jak `ui_sort clear=true` (`not_sortable`).
- Polecenie UI odrzucone przez klienta nie przełącza przestrzeni pracy.

### Obawy po rundzie

Obawa 1 z „Fix round 1” rozstrzygnięta (R5); obawa 2 usunięta. Pozostałe z sekcji 9 bez zmian.
