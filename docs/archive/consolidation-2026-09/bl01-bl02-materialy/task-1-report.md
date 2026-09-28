# Raport — Task 1: Fundament — widoki danych jako kompozycje OpenUI

- Gałąź / worktree: `bl01-bl02/t1-fundament` — `/home/paczos/Documents/agentic-app-template-wt/t1-fundament` (baza `bd615a7`)
- Data: 2026-09-17
- Status: **DONE_WITH_CONCERNS** (bramka G10 zielona; obawy niżej, w sekcji 10)

Commity:

| SHA | Temat |
|---|---|
| `b7cb76e` | Fundament widokow: kontrakty deskryptorow i widokow, wspolny odczyt POST /api/read, podzial narzedzi platformy |
| `de85eb0` | Widoki modulu jako kompozycje OpenUI: DataTable, DataChart, DataSummary, ComposedView i rejestr uiSemantics |
| `f54be9c` | Porzadek pola enum wedlug etykiety widocznej dla uzytkownika |
| `c459ed6` | Test zgodnosci schematow propsow komponentow danych z MCP |

Rodzaje dowodów: **test kontraktu lub logiki** (Vitest), **test GUI bez modelu** (Playwright na instancji wspólnej), **symulacja** (skryptowany model w `scripted-call.spec.ts`, `view-filter.spec.ts`, `ui-navigation.spec.ts`, `session-restore.spec.ts`, `measurements.spec.ts`). Prawdziwego modelu nie użyto.

---

## 1. Co zostało zrobione (punkty „Musi” z briefu)

### 1.1 Kontrakty (`packages/platform-contracts`)

- **`src/views.ts`** (eksport z indeksu): `FIELD_TYPES`, `NUMERIC_FIELD_TYPES`, `recordFieldSchema`, `readResultDescriptorSchema` (z regułami: unikalne pola, `titleField` musi być polem, `values` tylko dla `enum`, `unitField` tylko dla pól liczbowych, opcjonalne `record.route`), `dataSourceSchema` (`input` = `z.looseObject({}).optional()`), `viewDefinitionSchema` (`id`, `title`, `composition`, `params?`, **`primaryOperation?`**), `DATA_COMPONENTS`, `dataSortSchema`, `dataTablePropsSchema` (`source, columns?, title?, pageSize? 1–200, filter?, sort?`), `dataChartPropsSchema` (`source, kind: bar|line|pie, x, series, title?, filter?, sort?`; wykres kołowy = dokładnie jedna seria), `dataSummaryPropsSchema` (`source, fields, title?`), `DATA_COMPONENT_PROPS` (mapa nazwa → schemat, dla walidatora T4), `semanticInstanceSchema` (+ `SEMANTIC_VISIBLE_RECORDS_LIMIT = 50`), typy `ReadResponse`, `ReadOperationSummary`.
- **`src/records.ts`** (nowy, czyste funkcje wspólne dla przeglądarki i serwera): `recordsOf` (rekordy wg deskryptora; brak zadeklarowanej kolekcji = `integration_failed`, nigdy pusta lista), `recordIdOf`, `pickFields` (pole spoza deskryptora odrzucone z nazwą i listą dostępnych), `recordRouteOf`, `fieldUnitOf`, `numericFieldValue`, **`formatFieldValue`** (jedna funkcja formatowania: `money_minor` arytmetyką całkowitą z walutą z `unitField`, `quantity_milli`, `number` z jednostką, `date`, `boolean`, `enum` przez etykiety, puste = „—”), `sortRecords` (liczby liczbowo, daty chronologicznie, tekst `localeCompare('pl')`, enum wg etykiety, puste na końcu, stabilnie).
- **`src/ui.ts`**: `applyViewFilter(rows, {targetId, predicates}) → {kept, outcome}` — wspólna funkcja zawężania (G9), używana przez `useModuleData` i przez `DataTable`.
- **`src/module.ts`**: `ModuleReadOperation.result?: ReadResultDescriptor`, `ServerModule.views?: ViewDefinition[]`.
- **`src/artifacts.ts`**: `liveArtifactSourceSchema = dataSourceSchema` (jeden kontrakt źródła dla artefaktu live i komponentu danych).

### 1.2 Serwer (`packages/platform-server`)

- **Jedna funkcja rozwiązywania odczytu** `registry/read-operations.ts`: `prepareRead` (schemat źródła → rejestr → walidacja wejścia; `AppError('validation_failed')` z `details.reason` = `invalid_source | unknown_operation | invalid_input`, przy nieznanej operacji `details.available`), `runPreparedRead` / `runRead` (uruchomienie z właścicielem z sesji; `forbidden`/`not_found` z serwisu przechodzą bez zmian; wynik sprawdzany z deskryptorem), `readRefusalOf`, `describeReadOperations`.
  - `ArtifactService.assertLiveSourceIsResolvable` = `prepareRead(...).source`; `ArtifactService.resolveLive` używa `prepareRead` + `runPreparedRead` i mapuje `reason` na `unavailable`/`failed` (dotychczasowe komunikaty zachowane).
- **HTTP** (`http/app.ts`): `POST /api/read` → `{ operation, result, descriptor, resolvedAt }`; `GET /api/read/operations` → `{ operations: [{name, description, inputKeys, descriptor}] }`; `GET /api/ui/views` → `{ views }`. Wszystkie za sesją (401 bez niej).
- **Rejestr modułów** (`registry/modules.ts`, `registry/views.ts`): walidacja deskryptorów i definicji widoków schematami przy rejestracji; unikalne `id` widoków w całym rejestrze; **kontrola startowa zgodności `UiTarget.filter` z deskryptorem `primaryOperation` widoku** (patrz 2.1); moduł odrzucony nie zostawia połowicznego stanu (odczyty i widoki zapisywane dopiero po kontroli). Nowe: `registry.views()`, `registry.view(id)`.
- **Szew narzędzi**: `agent/platform-tools.ts` usunięty, zastąpiony `agent/tools/{context,canvas,ui,files,artifacts,index}.ts` (`index.ts` składa `platformTools` w tej samej kolejności; `stageFileIntoWorkspace` i `MEDIA_BY_EXT` w `files.ts`). Dowód braku zmiany zachowania w sekcji 5.3.
- **`agent/mcp.ts`**: wydzielone `collectToolEntries` i **`invokeTool(entry, args, ctx)`** (walidacja wejścia + handler + mapowanie błędu na wynik MCP) — jedyna ścieżka wykonania narzędzia, używana przez serwer MCP i przez krok `call`.
- **Prompt** (`agent/prompt.ts`): sekcja operacji odczytu bierze dane z `describeReadOperations` (jedno miejsce) i pod każdą operacją z deskryptorem wypisuje kolekcję, rodzaj rekordu, `idField` oraz pola `nazwa: etykieta, typ [jednostka]`.

### 1.3 Moduł procurement

- `server/views.ts` (nowy): deskryptory `supplierRecords` (`supplier`, kolekcja `suppliers`), `caseRecords` (`case`, kolekcja `cases`, `route: '/cases/{id}'`, enumy `status` i `priceBasis` z etykietami), `comparisonRecords` (`offer`, kolekcja `rows`, `totalMinor` jako `money_minor` z `unitField: 'currency'`, jednostki `%`, `dni`), `requirementRecords` (`requirement`, kolekcja `requirements` z `case_overview`, `quantityMilli` z `unitField: 'unit'`); widoki `procurement.data` i `procurement.cases` (kompozycje `Stack` + `TextContent` + `DataTable`, `primaryOperation` wskazane).
- `server/index.ts`: nowe odczyty `suppliers` i `cases` (te same wywołania serwisu co trasy `/suppliers` i `/cases`, które zostają), deskryptory dla `comparison` i `case_overview`, `views`.
- **Naprawa wykryta nową kontrolą**: `UiTarget procurement.cases` podpowiadał `status` o wartościach `['collecting','comparing','closed']`, a domena ma `draft|collecting|decided` — dwóch z trzech podpowiedzi żadna sprawa nie może mieć. Zmienione na `['draft','collecting','decided']` (kontrola startowa odrzuca teraz takie niezgodności, test w 5.1).
- `ui/pages.tsx`: `CasesPage` i `DataPage` renderują `ComposedView` (zachowane `data-testid="cases-page"` / `"data-page"` i nagłówki h1). `ui/cards.tsx`: unieważnianie przez `invalidateBusinessData`.

### 1.4 UI platformy (`packages/platform-ui`)

- `views/useReadOperation.ts` — `useReadOperation(source, opts)` przez `POST /api/read`; `qk.read(operation, input)` = `['read', accessScope(), operation, stableJson(input)]` (`stableJson` sortuje klucze). Wstrzymuje zapytanie, gdy wejście zawiera `undefined` (parametr `$x` przed inicjalizacją stanu Renderera).
- `api/queries.ts` — `qk.read`, `qk.uiViews`, `useViewDefinitions`, **`invalidateBusinessData(qc)`** (unieważnia `['module']` i `['read']`), użyte w `chat/runEvents.ts` (RUN_FINISHED/RUN_ERROR i `data_changed`) i w `module-procurement/src/ui/cards.tsx` — wszędzie tam, gdzie wcześniej `['module']`. `useModuleData` używa `applyViewFilter`.
- `views/DataTable.tsx`, `views/DataChart.tsx`, `views/DataSummary.tsx`, wspólne `views/DataFrame.tsx` (korzeń z `data-ui-instance`, `data-component`, `data-operation`, `data-state` = `loading|ready|empty|error|forbidden`), `views/useDataModel.ts` (jedno rozstrzyganie stanu dla trzech komponentów), `views/model.ts` (czyste: `buildDataModel`, `buildChartModel`, `describeDataInstance`), `views/viewContext.ts`, `views/dataComponents.tsx` (`defineComponent` na schematach z kontraktów).
  - Wiersze i komórki: `data-record-kind`, `data-record-id`; komórki i `dd` także `data-field`.
  - Stany rozróżnione słownie: ładowanie, pusty („Brak rekordow.” / „Zaden rekord nie spelnia zawezenia — pokazane 0 z N.”), błąd (`QueryErrorState`, `data-testid="query-error"`), brak dostępu (`access-denied`).
  - `DataChart` rysuje gotowymi `BarChartCondensed` / `LineChartCondensed` / `PieChart` z `@openuidev/react-ui` (te same, które owija `openuiLibrary`), wartości w jednostkach wyświetlania; `figcaption` podaje rodzaj, kategorie, każdą serię z jednostką i zakresem „od … do …” sformatowanym jak komórka tabeli (atrybuty `data-series`, `data-unit`, `data-min`, `data-max`); seria nieliczbowa i seria w mieszanych jednostkach są odrzucane z nazwą.
  - `DataSummary` — pary etykieta–wartość dla każdego rekordu (do 20, reszta policzona), bez liczenia czegokolwiek w przeglądarce.
- `catalog/registry.tsx` — komponenty danych zawsze w katalogu (`platformDataComponents` + moduły), odmowa zdublowanej nazwy komponentu OpenUI; ta sama biblioteka dla widoków, kart `openui` i czatu.
- `state/uiSemantics.ts` — zustand `useUiSemantics`, `registerInstance` (walidacja `semanticInstanceSchema` w runtime; niepoprawny opis odrzucony i zgłoszony w konsoli), `unregisterInstance`, `listInstances`, hook **`useDescribeInstance`** (rejestracja na czas montażu, porównanie po wartości). Brak publikacji do backendu.
- **Zawężenie z adresu**: `DataTable` w `ComposedView`, którego `source.operation === view.primaryOperation`, jest instancją główną — stosuje `useActiveViewFilter()` przez `applyViewFilter` i raportuje `reportFilterOutcome` (ta sama semantyka i ten sam raport co `useModuleData`). Inne instancje stosują tylko `filter` z kompozycji.
- `views/ComposedView.tsx` — `ComposedView { viewId, params? }`, rama `data-testid="composed-view"` + `data-view-id` + `data-state` w każdym stanie (ładowanie, błąd, nieznany widok `composed-view-unknown`, brak wymaganego parametru, gotowe); `params` → `initialState` jako `$nazwa`; `RenderErrorBoundary` (wydzielony z `CardBody`, używany przez karty i widoki).

### 1.5 Szew testów skryptowanych

- `e2e/support/scripted-agent.ts` (nowy): `Step` i `scriptedAgent(steps, { tools })` przeniesione z `scripted-server.ts` bez zmian zachowania (diff: wyłącznie dodatki) + **krok `call` `{ name, input?, maxChars? }`**: w kolejności strumienia odpala `PreToolUse` (nazwa `mcp__app__<local>`), wykonuje **prawdziwy handler** przez `invokeTool` z `options.toolContext` wykonania, odpala `PostToolUse` z rzeczywistym wynikiem albo `PostToolUseFailure`, emituje tekst `[call:<nazwa>] <wynik JSON, skrócony do 1200 znaków lub maxChars>`. Nazwa lokalna lub `mcp__app__…`; nieznane narzędzie / brak kontekstu = błąd narzędzia.
- `e2e/support/scripted-server.ts`: import agenta, leniwe `tools: () => collectToolEntries({registry, platformTools})`, scenariusz `call-ui-catalog`.

---

## 2. Decyzje projektowe tam, gdzie brief zostawił wybór

### 2.1 Zgodność `UiTarget.filter` z deskryptorem: **kontrola startowa** (nie test jednostkowy)

`ViewDefinition.primaryOperation?: string` — moduł wskazuje odczyt instancji głównej. Przy rejestracji (`checkViewAgainstTarget`): jeśli cel o `id` widoku ma `filter`, to `primaryOperation` jest wymagane, musi być zarejestrowane i mieć `result`; `filter.collection` musi równać się `descriptor.collection`; każde `filter.fields[].field` musi być polem deskryptora; podpowiadane `values` pola typu `enum` muszą być kodami deskryptora. Uzasadnienie: test jednostkowy chroniłby tylko moduł przykładowy, a kolejny moduł nie dostałby takiego testu; kontrola startowa nie wymaga parsera OpenUI (Task 4), bo odczyt jest zadeklarowany obok kompozycji. To samo pole służy przeglądarce do rozpoznania instancji głównej.

### 2.2 Link rekordu i zachowanie `data-testid="case-tile-<id>"`

Lista spraw przestała być kafelkami, a 6 speców (`app`, `chat`, `access-context`, `session-restore`, `measurements`, `agent-ui`) otwiera sprawę przez `[data-testid^="case-tile-"]` z `href`. Zamiast zmieniać selektory (w tym w `agent-ui.spec.ts`, którego nie wolno mi uruchomić), deskryptor dostał opcjonalne `record.route` (`'/cases/{id}'`), a `DataTable` renderuje pole `titleField` (lub pierwszą kolumnę) jako `Link` z `data-record-link` oraz `data-testid="<kind>-tile-<id>"` wyprowadzonym z nieprzezroczystego `kind` (komentarz w kodzie: nazwa zachowana dla istniejących testów; nowy kod ma używać `data-record-link` + `data-record-kind`/`data-record-id`). Żaden istniejący spec nie został zmieniony.

### 2.3 Pozostałe

- **`sort` w propsach jest stosowany** (statyczny porządek kompozycji przez `sortRecords`), bo zadeklarowany a ignorowany prop kłamałby w widokach agenta (T4). Porządek w adresie, kontrolki i paginacja pozostają dla Task 2 — mogą użyć `sortRecords`.
- **`pageSize` przyjmowany, ale jeszcze niestosowany** (wszystkie pasujące wiersze są pokazywane, `page: null` w opisie) — paginacja ma żyć w adresie (AD-6, Task 2); stan w pamięci byłby do wyrzucenia.
- `total` w opisie semantycznym = rekordy zwrócone przez odczyt; `outcome.total` dla banera = rekordy przed zawężeniem z adresu (po stałym `filter` kompozycji). Dla widoków modułu (bez stałego filtra) to ta sama liczba.
- `semanticInstanceSchema.filter` do 28 predykatów (8 z kompozycji + do 20 pól celu); `component` jako napis (moduł może kiedyś opisywać własne komponenty); `actions`: `filter` (instancja główna celu z `filter`), `open_record` (deskryptor z `route`).
- `recordsOf` bez `collection`: tablica wyniku albo pojedynczy rekord (dla `DataSummary` na wyniku jednego rekordu).
- Nieznana operacja w `POST /api/read` to `validation_failed` (400) z `reason`, spójnie z dotychczasową odmową artefaktu live; `not_found` zostaje zarezerwowane dla braku rekordu, żeby przeglądarka nie pokazywała „brak dostępu” przy błędnej kompozycji.
- Biblioteka OpenUI jest teraz zawsze tworzona przez `createLibrary` z `root: openuiLibrary.root` (`Stack`); instrukcja `root = …` i tak ma pierwszeństwo przy parsowaniu.
- Nagłówek h1 strony zostaje w deterministycznym opakowaniu trasy; `ViewDefinition.title` służy opisowi (T3) i komunikatom błędów.

---

## 3. Zmienione pliki (bd615a7..c459ed6: 49 plików, +4448 / −1010)

Kontrakty: `packages/platform-contracts/src/{views.ts (nowy), records.ts (nowy), ui.ts, module.ts, artifacts.ts, index.ts}`.
Serwer: `packages/platform-server/src/{registry/read-operations.ts (nowy), registry/views.ts (nowy), registry/modules.ts, services/artifacts.ts, http/app.ts, agent/mcp.ts, agent/prompt.ts, agent/runtime.ts, agent/tools/{context,canvas,ui,files,artifacts,index}.ts (nowe), agent/platform-tools.ts (usunięty), index.ts}`.
UI: `packages/platform-ui/src/{views/{ComposedView,DataTable,DataChart,DataSummary,DataFrame,dataComponents}.tsx, views/{model,useDataModel,useReadOperation,viewContext}.ts (nowe), state/uiSemantics.ts (nowy), components/RenderErrorBoundary.tsx (nowy), api/queries.ts, canvas/CardBody.tsx, catalog/registry.tsx, chat/runEvents.ts, index.ts, styles.css}`.
Moduł: `packages/module-procurement/src/{server/views.ts (nowy), server/index.ts, ui/pages.tsx, ui/cards.tsx}`.
Testy: `tests/views-foundation.test.ts` (nowy), `e2e/composed-views.spec.ts` (nowy), `e2e/scripted-call.spec.ts` (nowy, port 8798, `.e2e-scripted-call`), `e2e/support/scripted-agent.ts` (nowy), `e2e/support/scripted-server.ts`.
Nie edytowano: dokumentów koordynatora (G8), zależności (G7 — `@openuidev/lang-core` nie jest importowany w T1), `apps/*`.

---

## 4. Polecenia, kody wyjścia, liczby testów (końcowy stan `c459ed6`)

| Polecenie (w worktree) | Wynik |
|---|---|
| `pnpm verify` | **exit 0** — boundaries OK, acceptance „spójność: OK”, matrix zgodna, closure OK, typecheck OK, build OK, **Vitest 24 pliki / 314 testów** (baza 23 / 278; +1 plik, +36 testów) |
| `pnpm exec vitest run tests/views-foundation.test.ts` | exit 0, 36/36 |
| `flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/composed-views.spec.ts e2e/scripted-call.spec.ts e2e/view-filter.spec.ts e2e/app.spec.ts e2e/ui-navigation.spec.ts e2e/access-context.spec.ts e2e/chat.spec.ts e2e/session-restore.spec.ts e2e/measurements.spec.ts` (po `pnpm verify`, czyli na świeżym buildzie) | **exit 0, 49 passed** (composed-views 4, scripted-call 1, view-filter 7, app 14, ui-navigation 5, access-context 3, chat 7, session-restore 6, measurements 2) |
| `flock … pnpm check:module-swap` | exit 0 — pakiety platformy bez zmian w kopii, typecheck/build/serwer/przeglądarka z modułem kontrolnym OK |

Spece wymagane briefem: `composed-views` (nowy), `view-filter`, `app`, `ui-navigation` — zielone **bez zmian selektorów**. Dodatkowo uruchomione, bo dotyka ich zmiana ekranów `/cases` i `/data`: `access-context`, `chat`, `session-restore`, `measurements`. **Nie uruchomiono** `agent-ui.spec.ts` ani `files-agent.spec.ts` (prawdziwy model — Task 8); zachowane testid (`case-tile-*`, `data-page`) wskazują, że selektory `agent-ui.spec.ts` nadal pasują, ale to analiza kodu, nie przebieg.

Po przebiegach e2e usunięto nieśledzone pliki wygenerowane przez istniejące spece (`docs/evidence/chat-ux-2026-09-16/`, `docs/evidence/closure-2026-09-15/`); drzewo robocze czyste.

### 4.1 Co pokrywają nowe testy

`tests/views-foundation.test.ts` (test kontraktu lub logiki):
- `POST /api/read`: sukces z deskryptorem (wiersze = serwis dla właściciela sesji), odczyt z wejściem (`comparison`), nieznana operacja (400, `unknown_operation`, lista dostępnych, brak `result`), złe wejście (`invalid_input` ze ścieżką pola, brak wymaganego pola, nie-deskryptor `invalid_source`), zasób innego właściciela (403 `forbidden`, bez treści; lista innego właściciela pusta), brak sesji (401), `GET /api/read/operations`.
- `GET /api/ui/views`: dwa widoki, `primaryOperation`, kompozycja z `DataTable`, każdy `id` jest celem UI; 401 bez sesji.
- Kontrola startowa: moduł przykładowy przechodzi; **pole spoza deskryptora zatrzymuje start z nazwą pola** (rejestr pozostaje pusty) — także przez `createPlatform`; brak `primaryOperation`; niezgodna kolekcja; zabłąkane wartości enum (dawne `comparing, closed`); niezarejestrowana `primaryOperation`; odczyt bez deskryptora; niepoprawny deskryptor (`titleField`); powtórzony `id` widoku.
- Formatowanie typów pól (kwoty z separatorem ` `, 29 gr, wartości ujemne, ilości, jednostki, daty, bool, enum, puste), `numericFieldValue` (brak ≠ 0), `sortRecords` (liczby, polska kolacja z „Ł”, daty, puste na końcu, enum wg etykiety, pole spoza deskryptora), `recordsOf` (brak kolekcji = błąd), `recordRouteOf`.
- Model: kolumna/filtr spoza deskryptora odrzucone z nazwą; wynik zawężenia `buildDataModel` = `applyViewFilter` (3 z 4); opis instancji spełnia schemat, limit 50 identyfikatorów przy 120 rekordach; rejestr `uiSemantics` przyjmuje poprawny i odrzuca niepoprawny opis; wykres — zakres min/max i tekst zakresu = `formatFieldValue`, odmowa mieszanych jednostek (PLN+EUR w fixture) i serii nieliczbowej, `pie` z dwiema seriami odrzucony.
- Artefakty live przez wspólną funkcję: identyczna odmowa w `assertLiveSourceIsResolvable` i `POST /api/read`; `resolveLive` → `unavailable` / `failed`. Istniejące `tests/live-artifacts.test.ts` zielone.
- Szew narzędzi: dokładna lista i kolejność 17 narzędzi platformy; schematy `DATA_COMPONENT_PROPS` przechodzą `assertMcpCompatibleShape`; `tests/mcp-schema.test.ts` zielone.
- Prompt: linia `procurement.suppliers` z polami (`country: Kraj, text`), `totalMinor: Suma, money_minor`.
- Pamięć podręczna: `qk.read` z tożsamością i wejściem niezależnym od kolejności kluczy; `data_changed` i `RUN_FINISHED` unieważniają `['read']`.
- Krok `call` (symulacja, prawdziwy `AgentRuntime` + skryptowany agent): `canvas_add_card` naprawdę tworzy kartę w przestrzeni wykonania (id z wyniku jest w bazie), `TOOL_CALL_START/RESULT` z rzeczywistą treścią, `canvas_changed` na strumieniu; `procurement_list_cases` zwraca dane z bazy (`PC-2026-01`); błędne wejście → `validation_failed` jako błąd narzędzia; nieznane narzędzie → `not_found`.

`e2e/composed-views.spec.ts` (test GUI bez modelu, instancja wspólna, start od kliknięcia w nawigacji / listy przestrzeni):
1. „Dostawcy”: `composed-view[data-view-id=procurement.data]`, `DataTable` `ready`, każdy wiersz (kolejność id) i każda komórka (po `data-record-kind/id/field`) = `POST /api/read` przez `formatFieldValue`, nagłówki = etykiety deskryptora, literał `NordAV OY` → `FI`, 4 wiersze.
2. „Wszystkie sprawy”: to samo + literały etykiet (`zbieranie ofert`, `netto`), link rekordu (ścieżka `/cases/<id>`, testid `case-tile-<id>`), kliknięcie otwiera `case-detail-page`.
3. Karta `openui` z `DataTable({operation: "nie.istnieje"})`: `data-state="error"`, alert „Nieznana operacja odczytu "nie.istnieje"”, brak tabeli i stanu `empty`; w tej samej przestrzeni karta z zarejestrowaną operacją pokazuje tabelę zgodną z backendem (kontrola pozytywna).
4. Karty `openui` z `DataChart` (bar, `comparison` zawężone do PLN) — `svg` wykresu, podpis serii z `data-unit=PLN`, `data-min/max` i tekst „od … do …” = backend; `DataSummary` (`case_overview`) — wartości ilości = backend, literał „2 szt”.

`e2e/scripted-call.spec.ts` (symulacja, port 8798): polecenie z kompozytora → wykonanie `call-ui-catalog` → w czacie `[call:ui_catalog] {"targets":[` z identyfikatorami celów równymi `GET /api/ui/targets` i `filterableFields` (tylko prawdziwy handler je zwraca).

---

## 5. Kontrole negatywne i próby zdolności wykrycia

Każda próba: kluczowa linia chwilowo wycofana bez commitu, test uruchomiony, plik przywrócony `git checkout -- <plik>`, test ponownie zielony (dla e2e po ponownym buildzie; końcowy build pochodzi z `pnpm verify`).

| # | Wycofana linia | Polecenie | Wynik z wycofaniem |
|---|---|---|---|
| A | `registry/views.ts`: lista pól niezadeklarowanych zawsze pusta | `pnpm exec vitest run tests/views-foundation.test.ts` | **2 failed / 33 passed**: „pole zawezania spoza deskryptora zatrzymuje start z nazwa pola”, „ta sama odmowa zatrzymuje createPlatform” (oczekiwana nazwana odmowa, otrzymany `TypeError` z pętli wartości enum). Po przywróceniu 35/35. |
| B | `DataTable.tsx`: błąd odczytu renderowany jako stan `empty` | `pnpm build` + `flock … playwright test e2e/composed-views.spec.ts -g "niezarejestrowana operacja"` | **1 failed**: `Expected: "error"`, `Received: "empty"`. |
| C | `DataTable.tsx`: `narrowing = null` (zawężenie z adresu niestosowane w instancji głównej) | `pnpm build` + `flock … playwright test e2e/view-filter.spec.ts -g "zawezenie widac w widoku"` | **1 failed**: `[data-testid="data-page"] tbody tr` — `Expected: 3`, `Received: 4`. |
| D | `records.ts`: `enum` formatowany jako surowy kod | `pnpm build` + `flock … playwright test e2e/composed-views.spec.ts -g "Wszystkie sprawy"` | **1 failed** na literale linia 126: `Expected: "zbieranie ofert"`, `Received: "collecting"`. Porównanie z backendem przez wspólny formatter (linia 121) przeszło — dowód, że literały z fixture są potrzebne, bo sam formatter zgadza się sam ze sobą. |
| E | `scripted-agent.ts`: zamiast `invokeTool` udawany sukces | `pnpm exec vitest run tests/views-foundation.test.ts` | **2 failed** (oba testy `call`): `expected [] to include 'crd_udawany'` — karty nie ma w bazie. |
| F | `queries.ts`: `invalidateBusinessData` bez `['read']` | ten sam przebieg co E | **1 failed**: „zmiana danych i koniec wykonania uniewazniaja odczyty komponentow danych” — `expected [] to include 'read'`. (E+F razem: 3 failed / 32 passed.) |

Kontrole negatywne zawarte w samych testach: odmowy odczytu (nieznana operacja, złe wejście, obcy właściciel, brak sesji), odmowy startowe (6 wariantów), karta z nieistniejącą operacją ≠ pusta karta, mieszane jednostki wykresu, niepoprawny opis semantyczny, nieznane narzędzie i złe wejście kroku `call`.

### 5.3 Podział narzędzi bez zmiany zachowania

Przed i po podziale wygenerowano migawkę: dla każdego z 17 narzędzi platformy `name`, `description`, `effect`, `alwaysLoad`, **tekst źródłowy handlera** i `z.toJSONSchema(inputSchema)` oraz listę 26 narzędzi serwera MCP (`buildMcpServer().tools`). Pliki identyczne: `cmp` → IDENTICAL, sha256 obu `2cbf502fdc55b4a2087a96268e4fe8bedcf60aa59c2246effb8a5987340c72a7`. Dodatkowo test kolejności nazw w Vitest i zielone `tests/mcp-schema.test.ts`, `tests/view-filter.test.ts`, `tests/ui-navigation.test.ts`.

---

## 6. Nieudane przebiegi (poza celowymi próbami z sekcji 5)

1. `pnpm typecheck` (pierwszy) — `mcp.ts`: `interface ToolInvocationResult` nie spełniał typu wyniku SDK z sygnaturą indeksu. Błąd implementacji; zmieniono na alias typu. Kolejny przebieg exit 0.
2. `e2e/composed-views.spec.ts` (pierwszy przebieg): **1 failed / 3 passed** — asercja `href === /cases/<id>`, a otrzymano `/cases/<id>?s=spc_…`. **Wada testu**: router celowo przenosi parametry sesji `c`/`s` na każdym linku (`retainSearchParams`). Test porównuje teraz ścieżkę; kolejne przebiegi 4/4.

Brak innych nieudanych przebiegów na tym kodzie.

---

## 7. Kontrakt dla autora modułu

**Operacja odczytu z deskryptorem** (`ServerModule.readOperations[]`):
- `name` (kwalifikowana jako `<moduleId>.<name>`), `description`, `inputSchema: z.object({...})`, `run(input, { ownerId })` — tylko odczyt, właściciel wyłącznie z kontekstu; brak dostępu zgłaszaj `AppError('forbidden' | 'not_found')`.
- `result?: ReadResultDescriptor` — wymagany, jeśli odczyt mają pokazywać `DataTable` / `DataChart` / `DataSummary` albo zasilać widok:
  - `collection?` — klucz tablicy rekordów w wyniku; bez niego wynik jest tablicą albo pojedynczym rekordem;
  - `record: { kind, idField, titleField?, route? }` — `kind` nieprzezroczysty (ten sam słownik co `AppContext.resource.kind`), `idField` nie musi być wyświetlanym polem, `titleField` musi być polem z `fields`, `route` to ścieżka z `{pole}` (np. `/things/{id}`) — wtedy pole tytułu jest linkiem rekordu;
  - `fields: [{ field, label, type, unit?, unitField?, values?, sortable? }]`, `type` ∈ `text | number | money_minor (grosze) | quantity_milli (tysięczne) | date (ISO) | boolean | enum`; `unitField` tylko dla typów liczbowych (np. waluta z pola rekordu), `values: [{value, label}]` tylko dla `enum`; nazwy pól unikalne.
- Błędy przy starcie (odmowa uruchomienia): niepoprawny deskryptor (z opisem ścieżki), powtórzona nazwa operacji.
- Błędy w działaniu: wynik bez zadeklarowanej kolekcji → `integration_failed` (ekran pokazuje błąd, nie pustą listę).

**Widok modułu** (`ServerModule.views[]`, `ViewDefinition`):
- `id` = `id` celu `UiTarget` ekranu; `title`; `composition` — OpenUI Lang na wspólnym katalogu; `params?` — parametry trasy dostępne w kompozycji jako `$nazwa`; `primaryOperation?` — odczyt instancji głównej.
- Komponenty danych, argumenty pozycyjne w kolejności kluczy schematu: `DataTable(source, columns?, title?, pageSize?, filter?, sort?)`, `DataChart(source, kind, x, series, title?, filter?, sort?)`, `DataSummary(source, fields, title?)`; `source = {operation: "<modul>.<op>", input: {...}}`; wszystkie nazwy pól muszą być w deskryptorze. Nigdy nie wpisuj wartości biznesowych w kompozycję.
- Jeśli cel widoku deklaruje `filter`: `primaryOperation` wymagane i zarejestrowane z `result`; `filter.collection` = `result.collection`; każde `filter.fields[].field` jest polem deskryptora; `filter.fields[].values` pola `enum` ⊆ kodów z `values` deskryptora. Każde naruszenie zatrzymuje start z komunikatem wskazującym moduł, widok i pole.
- Instancja główna (`DataTable` z `source.operation === primaryOperation` w `ComposedView`) stosuje zawężenie z adresu i raportuje „N z M”; powinna być jedna na widok.
- Powtórzony `id` widoku (także między modułami) → `conflict` przy starcie.
- Ekran w warstwie przeglądarki: `<ComposedView viewId="…" params={{…}} />` wewnątrz własnej ramy strony (testid strony zostaje w module); brak wymaganego parametru i nieznany widok są stanami na ekranie.
- Unieważnianie po mutacji z UI modułu: `invalidateBusinessData(qc)` (odświeża trasy modułu i wszystkie komponenty danych).

---

## 8. Szwy dla fali 1 (co jest gotowe do użycia)

- Task 2: `sortRecords` (reguły typów), `buildDataModel({ sort, narrowing })`, `DataTable` z kontekstem widoku i `reportFilterOutcome`; `pageSize` przyjmowany, niestosowany; opis semantyczny ma `sort` i `page: null` do uzupełnienia.
- Task 3: `useUiSemantics` / `listInstances()` / `registerInstance` (walidowane), `semanticInstanceSchema`, `describeDataInstance`; `ViewDefinition.title` i `composition` z `GET /api/ui/views` (hash wersji do policzenia po stronie klienta).
- Task 4: `DATA_COMPONENT_PROPS`, `readResultDescriptorSchema`, `pickFields` (odmowa pola z nazwą), `prepareRead` (odmowa operacji/wejścia z `reason`), `registry.views()` do walidacji przy starcie; `@openuidev/lang-core` nie jest jeszcze bezpośrednią zależnością.
- Task 5: `ViewDefinition.params` → `$nazwa`, `record.route`, `recordRouteOf`.
- Task 6: atrybuty `data-record-kind/id/field` na komórkach i `dd`, `formatFieldValue` dla `displayedText`.
- Task 7: `invokeTool` + `collectToolEntries` (ta sama ścieżka co MCP), `invalidateBusinessData`.
- Wszystkie zadania: krok `call` w `e2e/support/scripted-agent.ts`; scenariusze dalej w `SCENARIOS` w `scripted-server.ts`.

---

## 9. Self-review — ustalenia

- Znalezione i poprawione w trakcie: `unitAcross` zwracał stałą jednostkę dla kolumny o mieszanych jednostkach (teraz brak jednostki); zakres wykresu liczony w `forEach` psuł zawężanie typów (przepisane na pętlę); enum sortowany po kodzie zamiast po etykiecie (commit `f54be9c`); `DataTable` przeliczał model przy każdym renderze przez nowe tablice propsów z Renderera (zależności porównywane po wartości).
- Próba A ujawniła, że bez kontroli pól pętla wartości enum rzuciłaby `TypeError` — kontrola pól stoi przed pętlą, więc w kodzie produkcyjnym nie występuje; test wymaga nazwanej odmowy, więc wychwyciłby regres.
- Granica platforma–domena: `pnpm check:boundaries` OK; testid `<kind>-tile-<id>` jest wyprowadzony z nieprzezroczystego `kind`, bez słownika domeny.
- Brak zmian w zależnościach; `pnpm install` nieuruchamiany; instancja użytkownika (8791) i katalogi innych worktree nietknięte. Ręczny, izolowany serwer do jednej sondy przeglądarkowej działał na porcie 18731 z katalogiem `.e2e-scripted-manual-t1` (usunięty), zatrzymany przez zatrzymanie własnego zadania; sonda Playwright uruchomiona pod blokadą.

---

## 10. Obawy (concerns)

1. **`pageSize` nie jest jeszcze stosowany** — kompozycja deklarująca `pageSize` pokazuje wszystkie wiersze do czasu Task 2 (udokumentowane w kodzie).
2. **Nazwa `data-testid="<kind>-tile-<id>"` na linku w tabeli** jest pozostałością po kafelkach, utrzymaną, by nie zmieniać 6 speców (w tym niewykonywalnego dla mnie `agent-ui.spec.ts`). Koordynator może zdecydować o migracji selektorów na `[data-record-link][data-record-kind][data-record-id]`.
3. **Widoczna zmiana UX**: lista spraw jest tabelą zamiast kafelków; tekst wprowadzający renderuje `TextContent` z domyślną typografią OpenUI (większy niż dawny `pf-page__lead`).
4. **Nieaktualne odwołania w dokumentach koordynatora** do `packages/platform-server/src/agent/platform-tools.ts` (`docs/ACCEPTANCE.md` L3.1/L3.2/L3.4 oraz historyczne macierze w `scripts/audit-matrix.mjs`, `scripts/closure-matrix.mjs`) — plik jest teraz katalogiem `agent/tools/`. Nie edytowałem (G8); kontrole macierzy nie sprawdzają istnienia ścieżek.
5. Komunikat odmowy przy `artifact_create` z niepoprawną treścią live brzmi teraz „Zrodlo danych wymaga deskryptora { operation, input }…” (wspólny z `POST /api/read`) zamiast „Artefakt live wymaga…”; test regex `wymaga deskryptora` zielony.
6. Krok `call` przekazuje do `PostToolUse` tekst wyniku; kształt `tool_response` dla narzędzi MCP w prawdziwym SDK może być tablicą bloków — runtime serializuje oba przypadki, ale to symulacja, nie odwzorowanie bajt w bajt.
7. Klient nie waliduje w runtime odpowiedzi `POST /api/read` (deskryptor jest walidowany na serwerze przy starcie); świadome zaufanie do własnego backendu.

---

## Fix round 1 (po przeglądzie: „Needs fixes”)

Commit: `d268ab3` — Poprawki po przegladzie T1: prawdziwe liczby opisu podsumowania, kontrola unitField i trasy rekordu, stabilny rejestr uiSemantics, opis w kazdym stanie, prawdziwy prompt (11 plików, +752 / −129).

### Zmiany wg ustaleń

**I1 — fałszywe `matched` w `DataSummary`.** `DataSummary.tsx` przekazuje do `describeDataInstance` **cały model** i `visibleLimit: 20`. `describeDataInstance` (`views/model.ts`) rozróżnia teraz rekordy narysowane (`visibleLimit`, brak = wszystkie) od listy identyfikatorów (narysowane, obcięte do 50): `matched` = wszystkie rekordy po predykatach, `total` = rekordy odczytu, `visibleRecordIds` = tylko narysowane. Podsumowanie 30 rekordów bez filtra opisuje się jako `matched 30, total 30, filter [], visibleRecordIds: 20`.

**I2 — `unitField` i trasa rekordu bez kontroli.** `readResultDescriptorSchema.superRefine` (`platform-contracts/src/views.ts`): `unitField` musi być zadeklarowanym polem — odmowa `Pole total: unitField currencyy nie jest zadeklarowanym polem.` ze ścieżką `fields.<i>.unitField`; każdy `{placeholder}` w `record.route` musi być zadeklarowanym polem albo `idField` — odmowa `record.route: {slug} nie jest zadeklarowanym polem ani idField.`. Ta sama odmowa zatrzymuje rejestrację modułu (`checkReadDescriptor`), np. `Operacja odczytu procurement.comparison: niepoprawny deskryptor wyniku — fields.4.unitField: Pole totalMinor: unitField currencyy …`. Deskryptory modułu przykładowego przechodzą bez zmian.

**R1 — rejestracja w miejscu.** `state/uiSemantics.ts`:
- magazyn ma jawną kolejność `order: string[]` (nie polega na kolejności kluczy obiektu); podmiana opisu zachowuje pozycję; `listInstances()` w kolejności rejestracji;
- `registerInstance` z opisem równym zapisanemu nie zmienia stanu (brak powiadomienia subskrybentów);
- nowe `createInstanceDescriber()` (`update` / `dispose`) — cykl życia bez Reacta: `update` podmienia wpis w miejscu, usuwa stary tylko przy zmianie `instanceId` albo `update(null)`, a przy odrzuconym opisie usuwa wpis (nieaktualny opis nie zostaje); `dispose` usuwa przy odmontowaniu;
- `useDescribeInstance` = `useState(createInstanceDescriber)` + efekt `update` zależny od treści + efekt `dispose` tylko przy odmontowaniu. Instancja nie znika już przy zmianie treści.

**R2 — opis w każdym stanie.** `semanticInstanceSchema`: nowe `state: 'loading'|'ready'|'empty'|'error'|'forbidden'` (`DATA_INSTANCE_STATES`, typ `DataInstanceState`), `error: { code: AppErrorCode, message ≤ 300 } | null`, `record` nullable, `matched`/`total` nullable; reguły spójności w schemacie: `ready`/`empty` ⇒ oba liczniki liczbami, pozostałe stany ⇒ oba `null`; `error`/`forbidden` ⇔ `error ≠ null`; rekordy wymienione tylko w `ready`; `empty` ⇒ `matched = 0`. `describeDataInstance` przyjmuje `state`, opcjonalnie `model`, `descriptor` (znany z odpowiedzi, np. gdy kompozycję odrzucono po odczycie), `fieldNames`, `filter`, `error`, `visibleLimit`. Bez modelu: `record` i zamówione pola zadeklarowane w deskryptorze (ze stałą jednostką) gdy deskryptor znany, inaczej `null`/`[]`; `matched`/`total` = `null`; `visibleRecordIds` = `[]`; `actions` = `[]`; komunikat błędu z `AppError`, skrócony. `useDataModel` zwraca też `response`. `DataTable`, `DataChart`, `DataSummary` zgłaszają opis w każdym stanie (także `empty`), a stan opisu jest tym samym stanem co `data-state` ramy (sprawdzane w teście).

**R3 — prompt.** `agent/prompt.ts`: nagłówek mówi, że podana jest kolekcja rekordów i pola tych rekordów, że wynik może zawierać także inne dane poza kolekcją, a w komponentach danych (kolumny, serie, pola, filtr, sortowanie) wskazuje się wyłącznie wymienione pola; linia operacji: `rekordy kolekcji <X> (rodzaj <kind>, id: <idField>) maja pola: …; tylko te pola wskazujesz w komponentach danych`. Zdanie „innych pol wynik nie ma” usunięte.

### Testy pokrywające

`tests/views-foundation.test.ts` (36 → 40):
- nowy „podsumowanie rysujace czesc rekordow podaje wszystkie dopasowane, a wymienia tylko narysowane” (I1, poziom buildera);
- nowy „unitField i pola trasy rekordu musza byc zadeklarowane — odmowa z nazwa pola” (I2: schemat, ścieżka błędu, `idField` w trasie dozwolony, odmowa przy rejestracji modułu);
- nowy „zmiana opisu aktualizuje wpis w miejscu: bez znikania, z ta sama kolejnoscia” (R1: każdy stan magazynu w trakcie zmian — instancja nigdy nieobecna, kolejność stała, brak powiadomienia przy tej samej treści; nowa tożsamość; `dispose`; odrzucony opis nie zostawia starego);
- nowy „opis w kazdym stanie: ladowanie, pusty, blad, brak dostepu” (R2: builder, skracanie komunikatu, reguły spójności schematu);
- zaktualizowane: opisy z `state: 'ready'`; prompt — nowe brzmienie i brak „innych pol wynik nie ma” (R3).

`tests/data-components-describe.test.ts` (nowy, 9 testów) — **komponenty** renderowane `react-dom/server` z przygotowaną pamięcią podręczną zapytań; `useDescribeInstance` zastąpiony rejestratorem, `useActiveViewFilter` zwraca `null` (brak routera). Każdy przypadek sprawdza, że opis spełnia schemat i że `description.state` = `data-state` ramy:
- DataSummary: 30 rekordów → `matched 30, total 30, filter []`, 20 identyfikatorów, 20 bloków `<dl>` (I1 na poziomie wywołania komponentu); błąd odczytu → `error` z kodem, liczniki `null`;
- DataTable: `loading`; `ready` (liczniki, identyfikatory, jednostka PLN); `empty` po filtrze kompozycji (`0 z 3`); `forbidden` z kodem; kompozycja odrzucona po odpowiedzi (rekord i znane pola z deskryptora);
- DataChart: seria nieliczbowa → `error`; `loading`.
- Uwaga techniczna: klient testowy ma `retryOnMount: false`, bo bez efektów obserwator TanStack Query raportuje nieudane zapytanie jako oczekujące na ponowienie.

### Polecenia i wyniki

| Polecenie | Wynik |
|---|---|
| `pnpm exec vitest run tests/views-foundation.test.ts tests/data-components-describe.test.ts` | exit 0, **49 passed** (40 + 9) |
| `pnpm typecheck` | exit 0 |
| `pnpm verify` | **exit 0** — spójność OK, macierz zgodna, typecheck, build, **Vitest 25 plików / 327 testów** (było 24 / 314) |
| `pnpm build` | exit 0 |
| `flock -w 5400 /home/paczos/Documents/agentic-app-template-wt/.e2e.lock pnpm exec playwright test e2e/composed-views.spec.ts e2e/view-filter.spec.ts` | **exit 0, 11 passed** (composed-views 4, view-filter 7) |

Po e2e usunięto nieśledzony `docs/evidence/chat-ux-2026-09-16/` wygenerowany przez `view-filter.spec.ts`; drzewo czyste.

### Próby zdolności wykrycia (wycofanie bez commitu → test → `git checkout -- <plik>` → zielono)

| Próba | Wycofanie | Wynik |
|---|---|---|
| I1 | `DataSummary.tsx`: przywrócone wywołanie sprzed poprawki `model: { ...model, records: model.records.slice(0, 20) }` | `tests/data-components-describe.test.ts`: **1 failed / 8 passed** — „rysuje 20 z 30 rekordow…”: `expected 20 to be 30`. Po przywróceniu 9/9. |
| I2 | `views.ts`: warunki kontroli `unitField` i trasy wyłączone (`&& false`) | `tests/views-foundation.test.ts`: **1 failed / 39 passed** — „unitField i pola trasy rekordu…”: `expected true to be false` (literówka `currencyy` przyjęta). |
| I2b | `views.ts`: wyłączona tylko kontrola trasy | **1 failed / 39 passed** — ten sam test, asercja trasy (linia 311): `expected true to be false` dla `/things/{slug}`. Po przywróceniu 40/40. |
| R1 | `uiSemantics.ts`: `update` zawsze najpierw usuwa wpis (zachowanie sprzed poprawki) | **1 failed / 39 passed** — „zmiana opisu aktualizuje wpis w miejscu…”: `expected [ [ 'DataTable-B' ], …(5) ] to deeply equal [ …(2) ]` (instancja A znikała i zmieniała pozycję). Po przywróceniu 40/40. |

### Nieudane przebiegi w tej rundzie

1. `tests/views-foundation.test.ts` (pierwszy przebieg po zmianach): **1 failed / 39 passed** — test R1 wykazał, że reguła spójności schematu odrzucała liczniki tylko wtedy, gdy *oba* były liczbami, więc opis `loading` z `matched: 5, total: null` przechodził. **Błąd implementacji**; reguła wymaga teraz obu liczników poza `ready`/`empty` = `null`. Kolejny przebieg 40/40.
2. `tests/data-components-describe.test.ts` (pierwszy przebieg): **2 failed / 7 passed** — przypadki błędu i braku dostępu dawały `loading`. **Wada harnessu testu**: przy renderze bez efektów obserwator TanStack Query optymistycznie raportuje ponowne pobranie nieudanego zapytania (`status: pending`). Dodano `retryOnMount: false` w kliencie testowym; kolejny przebieg 9/9. W przeglądarce stan błędu jest raportowany po nieudanym pobraniu — potwierdza to `e2e/composed-views.spec.ts` („karta openui z niezarejestrowana operacja…”, `data-state="error"`).

### Kontrakt dla autora modułu — uzupełnienie

- W deskryptorze `unitField` wskazuje zadeklarowane pole tego samego rekordu; `record.route` może używać tylko `{idField}` i zadeklarowanych pól. Naruszenie zatrzymuje start z nazwą pola.
- Opis semantyczny komponentu danych (dla konsumentów rejestru `uiSemantics`) zawsze ma `state`; liczby i identyfikatory rekordów są obecne tylko w `ready`/`empty`, przyczyna tylko w `error`/`forbidden`.

### Obawy po rundzie

Bez zmian względem sekcji 10 (pkt 1–7). Dodatkowo: rejestr `uiSemantics` nie jest obserwowany w e2e (brak publikacji — Task 3); przewodzenie opisów przez komponenty sprawdzają testy renderu serwerowego, a zgodność stanów w przeglądarce — atrybuty `data-state` w `composed-views.spec.ts`.
