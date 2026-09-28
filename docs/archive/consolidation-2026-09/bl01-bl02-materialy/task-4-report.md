# Raport — Task 4: BL-02 — przestrzeń „Widoki agenta”, walidacja kompozycji i narzędzia

- Gałąź / worktree: `bl01-bl02/t4-widoki-agenta` — `/home/paczos/Documents/agentic-app-template-wt/t4-widoki-agenta` (baza `3097586`)
- Data: 2026-09-17
- Kryteria: **L3.15**, **L3.16**, **L3.17**, część agentowa **L3.14**; wkład do **L3.3**, **L3.12**
- Status: **DONE_WITH_CONCERNS** (bramka G10 zielona; obawy w sekcji 9 — najważniejsza: sposób dołączenia `@openuidev/lang-core` do bundla serwera, sekcja 2.2)

| SHA | Temat |
|---|---|
| `7d6ce0c` | Widoki agenta (serwer): walidator kompozycji OpenUI na lang-core, narzędzia agent_view_*, przestrzeń rozmowy |
| `cdb51a8` | Widoki agenta (UI): strona /agent-views, grupowanie DataTable, bramka odczytu, test e2e skryptowany |
| `5c746a2` | Widoki agenta: asercja niezmienionej instrukcji po patchu, opis grupowania w DataTable |
| `9a741d4` | Test zgodności katalogu: moduł UI importowany dynamicznie, żeby check:module-swap typecheckował kopię bez połówki przeglądarkowej |
| `b9bf798` | Test walidatora: null pomija opcjonalny argument pozycyjny (także w widoku modułu), zły typ i null argumentu wymaganego odrzucone |

Rodzaje dowodów: **test kontraktu lub logiki** (Vitest: `tests/agent-views.test.ts`, `tests/openui-catalog-parity.test.ts`), **symulacja** (Playwright ze skryptowanym modelem wołającym prawdziwe handlery: `e2e/agent-views.spec.ts`), **test GUI bez modelu** (`e2e/composed-views.spec.ts`, `e2e/app.spec.ts`). Prawdziwego modelu nie użyto (G4/G5).

---

## 1. Co zostało zrobione

### 1.1 Walidator kompozycji (`packages/platform-server/src/registry/openui-validation.ts`)

- **Katalog serwera `OpenUiServerCatalog`**: `$defs` = wygenerowana kopia schematu gotowej biblioteki `openuiLibrary` (`registry/openui-library.schema.json`, 54 komponenty, generator `scripts/openui-library-schema.mjs`) + komponenty danych i zadeklarowane komponenty modułów przepuszczone przez `createLibrary`/`defineComponent` z `@openuidev/lang-core` (to samo, co robi przeglądarka), parser `createParser(schema, 'Stack')`. Konflikt nazw (z gotową biblioteką, komponentami danych, innym modułem) → `conflict` przy starcie, jak w `buildRegistry` przeglądarki. `signature(name)` wyprowadza sygnaturę pozycyjną ze schematu (używane w prompcie).
- **`checkComposition` / `validateComposition`** zbierają wszystkie problemy i rzucają `AppError('validation_failed', …, { reason, problems[] })`. Rodzaje odmowy (`COMPOSITION_REFUSALS`): `empty`, `syntax` (linia, która nie jest `nazwa = wyrażenie` — parser takie linie po cichu pomija), `partial` (`meta.incomplete`), `missing_root`, `duplicate_statement`, `unknown_component`, `invalid_props` (błędy walidacji parsera i schematu Zod), `unresolved_reference`, `orphaned_statement` (instrukcja nieosiągalna z root nie byłaby ani pokazana, ani sprawdzona — parser nie zgłasza w niej nawet nieznanego komponentu), `forbidden_reference` (Query/Mutation — aplikacja nie ma `toolProvider`), `component_not_allowed`, `dynamic_expression`, `invalid_source`, `unknown_operation`, `invalid_input` (przez wspólne `prepareRead`, G9), `no_descriptor`, `undeclared_field` (columns, x, series, fields, filter[].field, sort.field, groupBy — przez wspólne `pickFields`), `non_numeric_series`, `primary_operation_missing`.
- **Tryb `agent-views`**: tylko komponenty danych, zadeklarowane komponenty modułów i jawna lista `AGENT_VIEW_LAYOUT_COMPONENTS` (`Stack, Card, CardHeader, Tabs, TabItem, Accordion, AccordionItem, Separator, TextContent, TextCallout, MarkDownRenderer`) z uzasadnieniem w kodzie (nic, co przyjmuje liczby/serie/wiersze; poza listą m.in. `Table/Col`, wszystkie wykresy z `Series/Slice/Point`, `Tag*`, formularze i przyciski, `Image*`, `Modal/Callout`); bez wyrażeń, stanu `$x`, builtinów.
- **Tryb `catalog`** (karty `openui` poza widokami agenta, widoki modułów): każdy komponent znany przeglądarce; komponent danych musi mieć stałe propsy — jedyny wyjątek to parametr widoku `$param` jako wartość `source.input` (dla zadeklarowanego `params`); komponent danych wewnątrz wyrażenia jest odrzucany.
- `null` w argumencie pozycyjnym = „nie podano”, tak jak czyta to Renderer: parser `lang-core` nie sprawdza typu wartości `null`, a przed walidacją Zod (`.optional()` odrzuca `null`) propsy o wartości `null` są usuwane. Zły typ na tej samej pozycji i `null` dla argumentu wymaganego (`source`, `kind`) są nadal odrzucane (uwaga koordynatora o kompozycjach Task 2 — sekcja 9 pkt 10).
- **`findDataInstances(source, catalog?)`** — instancje komponentów danych z przefiltrowanymi przez schemat propsami i `statementId` (dla Task 6).
- `normalizeCompositionSource` zdejmuje zewnętrzny blok ``` (Renderer też to robi); zapisywana jest znormalizowana treść.

### 1.2 Użycie walidatora

- `ComponentCatalog.validate(spec, { mode })` dla każdej karty `openui`; karta `kind: 'component'` w trybie `agent-views` odrzucona. Tryb wynika z przestrzeni: `CanvasService.compositionModeOfSpace/compositionModeOfCard` (`scopeKind === AGENT_VIEWS_SCOPE_KIND` → `agent-views`) — stosowane w `POST /api/canvas/cards`, `PATCH /api/canvas/cards/:id/spec`, `canvas_add_card`, `canvas_update_card`, więc reguły widoków agenta nie da się obejść ogólnym narzędziem ani API.
- **Start**: `ServerModuleRegistry.register` waliduje kompozycję każdego widoku modułu (tryb `catalog`, `params`, `primaryOperation` → wymagany `DataTable` na tej operacji — handoff z przeglądu T1) na katalogu z komponentami modułów już zarejestrowanych i bieżącego; błąd: `Modul <id>, widok <id>: Kompozycja OpenUI odrzucona: …`, moduł nie zostaje połowicznie zarejestrowany.
- `prepareRead(registry, raw, { unresolvedInputKeys })` — rozszerzenie wstecznie zgodne: klucze wejścia znane dopiero przy renderze (`$param`) muszą być kluczami schematu wejścia operacji, reszta wejścia walidowana jak przy odczycie; typ rejestru zawężony do `ReadOperationLookup` (`readOperation`, `readOperations`), żeby działał w trakcie rejestracji.

### 1.3 Przestrzeń rozmowy

- `AGENT_VIEWS_SCOPE_KIND = 'conversation'` (`platform-contracts/src/canvas.ts`); przestrzeń `ensureScopedSpace({ scopeKind: 'conversation', scopeId: <conversationId> })` tworzona przy pierwszym widoku; `CanvasService.findScopedSpace` (bez tworzenia), `getCard`.
- `ConversationService.delete` usuwa w tej samej transakcji przestrzeń widoków rozmowy (karty kaskadowo); odpowiedź dostała `removedViewSpaces`.
- `GET /api/conversations/:id/agent-views` → `{ conversationId, space | null, cards }` (kontrola właściciela przez rozmowę; odczyt niczego nie tworzy).
- Cel `platform.agentViews` (`/agent-views`) w `PLATFORM_UI_TARGETS`.

### 1.4 Narzędzia (`packages/platform-server/src/agent/tools/agent-views.ts`, dopisane na końcu `platformTools`)

- `agent_views_list` → `{ conversationId, spaceId, views: [{ cardId, title, specVersion, source, updatedAt }] }`.
- `agent_view_create { title, source, operationId? }` → walidacja `agent-views` → przestrzeń rozmowy → `addCard` → `canvas_changed` → `{ cardId, spaceId, title, specVersion }`.
- `agent_view_update { cardId, patch? | source?, title?, expectedSpecVersion?, operationId? }` — `patch` scalany `mergeStatements(obecna, patch)`, wynik walidowany, `updateSpec` (konflikt wersji → `conflict`); oba naraz lub nic do zmiany → `validation_failed`.
- `agent_view_remove { cardId, operationId? }`.
- Zawsze `ToolCallContext.conversationId` (rozmowa wykonania), nigdy `appContext`: brak rozmowy → `precondition_failed`; obca rozmowa tego samego właściciela → `forbidden` („nie jest widokiem agenta tej rozmowy”); obcy właściciel → `forbidden` z serwisu. `alwaysLoad` dla list/create/update (model musi wiedzieć, że istnieją — powód opisany w `ModuleToolDefinition.alwaysLoad`).
- Schematy wejścia: bez `z.record`, `.optional()` (test `assertMcpCompatibleShape` i `mcp-schema.test.ts` zielone).

### 1.5 Komponenty

- `dataTablePropsSchema.groupBy?` dopisane **na końcu** (`DataTable(source, columns?, title?, pageSize?, filter?, sort?, groupBy?)`).
- `platform-ui/src/views/grouping.ts` (czyste): `groupRecords(records, field)` — grupa = wartość + jednostka (100 PLN i 100 EUR to dwie grupy), etykieta jak komórka (`formatFieldValue`), kolejność pierwszego wystąpienia (porządek tabeli), puste w osobnej grupie; `withGrouping(model, groupBy)` odrzuca pole spoza deskryptora z nazwą.
- `DataTable.tsx`: hook-in — `withGrouping(buildDataModel(...), props.groupBy)`; przy grupowaniu jeden `<tbody data-group-field data-group-key>` na grupę z wierszem nagłówka `th[scope=rowgroup]` („Waluta: PLN (3)”, `data-group-count`), wiersze renderowane tą samą funkcją `renderRow` co bez grupowania.
- `DataChart.kind` — zmiana przez patch kompozycji (bez zmian w komponencie).
- `DATA_COMPONENT_DESCRIPTIONS` przeniesione do kontraktów (jeden tekst dla `defineComponent` i katalogu serwera — test zgodności wykrył różnicę).

### 1.6 UI

- `AgentViewsPage` (`platform-ui/src/shell/AgentViewsPage.tsx`): rozmowa z adresu (`c`), `data-testid="agent-views-page"`, `data-state` = `no-conversation | loading | error | empty | ready`, `data-conversation-id`, `data-space-id`. Canvas przez nowe `CanvasSurface({ spaceId, publishViewport: false })` — nie czyta i nie zmienia `s`/`AppState.spaceId`, nie zapisuje viewportu do `AppContext` (viewport zapisuje się tylko przy własnej przestrzeni).
- Trasa `/agent-views` (`apps/web/src/router.tsx`), pozycja menu „Widoki agenta” (`platform.agentViews`, sekcja workspace, `apps/web/src/compose.tsx`).
- `qk.agentViews` pod prefiksem `['canvas', …]` — odświeżane na końcu wykonania. **Sprostowanie (Fix round 1, I3):** pierwotne twierdzenie, że każdy `canvas_changed` odświeża stronę, było fałszywe; poprawione w rundzie 1.
- Przestrzenie `conversation` ukryte na liście „Zapisane kompozycje” i pomijane w fallbacku `CanvasHost` (inaczej ostatnio zmieniona przestrzeń widoków agenta stawała się roboczym canvasem).

### 1.7 Prompt

`agentViewsPromptSection(catalog.openui)` (w `tools/agent-views.ts`, wołane w `prompt.ts` jedną linią, gdy są operacje odczytu): kiedy tworzyć, dobór formy do intencji bez nazwy komponentu, zmiana przez `agent_views_list` + `agent_view_update` z `patch` tylko zmienianych instrukcji, wyłącznie komponenty danych z operacjami i polami z listy, zakaz wpisywania liczb/kwot/dat/wierszy, sygnatury z katalogu (`DataTable(source, columns?, …, groupBy?)`, komponenty modułu, lista układu), `null` dla pominiętych argumentów, przykład kompozycji i patcha, jawne ujawnienie ograniczenia katalogu, zakaz samowolnego przełączania do Widoków agenta.

### 1.8 Moduł procurement

`src/shared/openui.ts` (bez Reacta): `PROCUREMENT_OPENUI_COMPONENTS` (nazwa, opis, schemat propsów `OfferComparison`, `OfferCostChart`); przeglądarka (`ui/index.tsx`) i serwer (`openuiComponents`) biorą je stąd. Nowe pole kontraktu: `ServerModule.openuiComponents?: OpenUiComponentDeclaration[]`.

### 1.9 Ustalenia koordynatora — realizacja

| Ustalenie | Realizacja |
|---|---|
| Kontrola `primaryOperation` w kompozycji | `primary_operation_missing` przy starcie; test „widok modułu musi zawierać DataTable na swojej primaryOperation…” |
| Eksport narzędzia instancji danych | `findDataInstances(source, catalog?)` + typ `DataInstance` |
| Lista dozwolona w widokach agenta, deklaracje serwerowe komponentów modułu, test zgodności | 1.1, 1.8; `tests/openui-catalog-parity.test.ts` porównuje nazwy **i** kolejność parametrów oraz pełne `$defs` biblioteki przeglądarki (`buildRegistry` z modułem procurement) z katalogiem serwera |
| Ryzyko strumieniowania w czacie | **Potwierdzone** (sekcja 2.6): bramka w `useReadOperation` + test logiki + e2e z próbą wykrycia |
| Strona nie zmienia `s` ani viewportu kontekstu | 1.6; e2e sprawdza `s` przed i po |
| Zakres `conversation:<id>` | 1.3 |

---

## 2. Decyzje tam, gdzie brief zostawił wybór

### 2.1 Gotowa biblioteka po stronie serwera: wygenerowana kopia schematu
Serwer nie może importować `@openuidev/react-ui` (React), a parser potrzebuje listy parametrów każdego komponentu. Wybrana kopia `openuiLibrary.toJSONSchema()` (`$defs`, `root`) w JSON + generator + test, który porównuje ją z biblioteką przy każdym `pnpm test`. Alternatywa „tylko nazwy” nie pozwoliłaby walidować propsów ani mapować argumentów pozycyjnych. Po aktualizacji `@openuidev/react-ui`: `node scripts/openui-library-schema.mjs`.

### 2.2 `@openuidev/lang-core` w bundlu serwera (ZASTĄPIONE w Fix round 1, R1: deklaracja w `@app/server`)
Zależność dodana do `@platform/server` zgodnie z G7 (`pnpm --filter @platform/server add @openuidev/lang-core@0.2.18`; lockfile: +3 linie w `importers`, wersja już była). Bundel `apps/server/dist/server.js` oznacza wszystkie pakiety z `node_modules` jako zewnętrzne i rozwiązuje je z `apps/server/dist` — tam (i w obrazie po `pnpm deploy`) `lang-core` nie istnieje. Zamiast drugiej deklaracji zależności w `@app/server` (wymagałaby zgody) dodałem w `apps/server/build.mjs` listę `BUNDLED = ['@openuidev/lang-core']` — pakiet jest wkompilowany, jego importy `zod/*` pozostają zewnętrzne. Sprawdzone: smoke uruchomionego `dist/server.js` (izolowany port 18745, katalog w scratchpadzie, zatrzymany po PID) odrzucił kartę z nieznanym komponentem; wspólna instancja e2e (`boot-server.ts` importuje `dist/server.js`) i `check:module-swap` zielone. Alternatywa: `@openuidev/lang-core` w `apps/server/package.json`.

### 2.3 Telemetria `lang-core`
Przeczytany kod: `createParser().parse` ma próbkowaną telemetrię PostHog (z odczytem `git remote`), ale jest **opt-in** (`OPENUI_RUNTIME_TELEMETRY_ENABLED` musi być prawdą), więc domyślnie nic nie wysyła. `mergeStatements` nie ma telemetrii. Nie zmieniałem konfiguracji.

### 2.4 Reguły kompozycji ostrzejsze niż parser
Wymagane `root = …`; instrukcje osierocone, zdublowane i nierozpoznane linie odrzucane (parser je pomija lub nadpisuje po cichu — L3.3/L3.4). Query/Mutation odrzucane w obu trybach (brak `toolProvider` → błąd w runtime). Tryb widoku zależny od przestrzeni, nie od narzędzia (1.2).

### 2.5 `composed-views.spec.ts` test 3 przerobiony
Po walidacji serwerowej karty `DataTable({operation: "nie.istnieje"})` nie da się już zapisać, więc test T1 „karta openui z niezarejestrowaną operacją pokazuje błąd” musiał się zmienić: teraz sprawdza odmowę zapisu (400, `unknown_operation`) i że odczyt, który zawodzi w runtime (zarejestrowana operacja, nieistniejąca sprawa), daje `data-state="forbidden"` z komunikatem, bez tabeli i bez stanu `empty`. Błąd nieznanej operacji w przeglądarce (kompozycja w czacie) sprawdza teraz `e2e/agent-views.spec.ts`.

### 2.6 Ryzyko strumieniowania w czacie — potwierdzone
Analiza kodu: `InterleavedTurn` renderuje odpowiedź w trakcie tury, gdy ma składnię OpenUI (`hasLangSyntax`), a `RenderNode` renderuje elementy częściowe. Przebieg: bez bramki przeglądarka wysłała `POST /api/read` dla `"procurement."` i `"procurement.supp"` (próba E1, sekcja 5). Rozwiązanie: `readGate(source, operations, listFailed)` — `wait` (brak nazwy, nierozstrzygnięty `$param`, lista operacji jeszcze się wczytuje), `fetch` (nazwa z `GET /api/read/operations`), `refuse` (nazwy nie ma na wczytanej liście → błąd z brzmieniem backendu, bez żądania; nie wieczne ładowanie). Gdy listy nie da się pobrać — decyduje backend.

### 2.7 Pomiar karty resetował pozycję (błąd istniejący, znaleziony testem)
`CanvasInner.onNodesChange` przy zmianie `dimensions` zapisywał geometrię z `x/y` z lokalnego stanu przeciągania albo **0,0**. React Flow mierzy karty przy montażu i po każdym ponownym odczycie kart (np. po `canvas_changed`), więc każda karta nieprzesunięta w tej sesji lądowała na (0,0) na pierwszej karcie, a `geometryVersion` rósł bez działania użytkownika. Poprawka: pomiar równy zapisanemu rozmiarowi nic nie zapisuje; przy rzeczywistej zmianie rozmiaru pozycja brana z zapisanej geometrii. Zabezpieczone asercją e2e (próba E2).

### 2.8 Pozostałe
- Pierwszy widok tworzy przestrzeń; strona/`GET` jej nie tworzą.
- Grupowanie: grupy wg wartości zapisanej i jednostki, kolejność tabeli (sort w kompozycji porządkuje też grupy).
- `e2e/support/scripted-agent.ts` (dopiski): skrypt może być funkcją polecenia użytkownika (`(prompt) => Step[]`), wejście kroku `call` może być funkcją wcześniejszych wyników (`CallRecord[]`), identyfikatory wywołań `call` unikalne w obrębie agenta. Ostatnie naprawia artefakt symulacji: `tu_call_N` powtarzane w każdej turze powodowały, że czat parował wywołanie wcześniejszej tury z nieudanym wynikiem późniejszej i pokazywał udane wywołanie jako „failed”.
- `e2e/support/scripted-server.ts`: `CONVERSATION_SCENARIOS` (`agent-views`), scenariusz w osobnym pliku `e2e/support/agent-views-scenario.ts`.
- Test zgodności importuje `@module/procurement/ui` dynamicznie (nazwa w zmiennej), bo `check:module-swap` typecheckuje kopię bez połówki UI modułu (pierwszy przebieg swap oblał na tym teście — sekcja 6).

---

## 3. Zmienione pliki (3097586..9a741d4: 44 pliki, +5114 / −116; z tego 2015 linii to wygenerowany JSON)

- Kontrakty: `platform-contracts/src/{views.ts (groupBy, DATA_COMPONENT_DESCRIPTIONS), module.ts (OpenUiComponentDeclaration, openuiComponents), canvas.ts (AGENT_VIEWS_SCOPE_KIND)}`.
- Serwer: `registry/{openui-validation.ts (nowy), openui-library.schema.json (nowy, generowany), catalog.ts, modules.ts, read-operations.ts, ui-targets.ts}`, `services/{canvas.ts, conversations.ts}`, `agent/tools/{agent-views.ts (nowy), canvas.ts, index.ts}`, `agent/prompt.ts` (2 linie), `http/app.ts`, `index.ts`, `package.json`.
- UI: `views/{grouping.ts (nowy), DataTable.tsx, dataComponents.tsx, useReadOperation.ts}`, `shell/{AgentViewsPage.tsx (nowy), WorkspacePage.tsx}`, `canvas/CanvasHost.tsx`, `api/queries.ts`, `index.ts`, `styles.css`.
- Moduł: `module-procurement/src/{shared/openui.ts (nowy), server/index.ts, ui/index.tsx}`.
- Warstwa składania: `apps/web/src/{router.tsx, compose.tsx}`, `apps/server/build.mjs`.
- Testy: `tests/{agent-views.test.ts (nowy), openui-catalog-parity.test.ts (nowy), views-foundation.test.ts (lista narzędzi)}`, `e2e/{agent-views.spec.ts (nowy), composed-views.spec.ts, support/agent-views-scenario.ts (nowy), support/scripted-agent.ts, support/scripted-server.ts}`.
- Skrypt: `scripts/openui-library-schema.mjs` (nowy).
- Nie edytowano dokumentów koordynatora (G8). Jedyna zmiana zależności: `@openuidev/lang-core@0.2.18` w `@platform/server` (G7).

---

## 4. Polecenia, kody wyjścia, liczby testów

| Polecenie (w worktree) | Wynik |
|---|---|
| `pnpm exec vitest run tests/agent-views.test.ts` | exit 0, 22/22 (23/23 po `b9bf798`) |
| `pnpm exec vitest run tests/openui-catalog-parity.test.ts` | exit 0, 8/8 |
| `pnpm verify` (na `5c746a2`) | **exit 0** — Vitest 27 plików / 357 testów |
| `pnpm verify` (na `9a741d4`) | exit 0 — Vitest 27 / 357 |
| `pnpm exec vitest run tests/agent-views.test.ts` (po dodaniu testu `null`) | exit 0, 23/23 |
| `pnpm verify` (**końcowy, na `b9bf798`**) | **exit 0** — boundaries OK, acceptance/matrix/closure OK, typecheck, build, **Vitest 27 plików / 358 testów** (po scaleniu T1: 25 / 327; +2 pliki, +31 testów) |
| `flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/agent-views.spec.ts e2e/composed-views.spec.ts e2e/app.spec.ts e2e/view-filter.spec.ts e2e/scripted-call.spec.ts e2e/background-tasks.spec.ts e2e/session-restore.spec.ts e2e/ui-navigation.spec.ts e2e/chat.spec.ts e2e/tool-activity.spec.ts e2e/streaming.spec.ts e2e/measurements.spec.ts e2e/access-context.spec.ts` (po `pnpm verify`) | **exit 0, 68 passed** (agent-views 6, composed-views 4, app 14, view-filter 7, scripted-call 1, background-tasks 5, session-restore 6, ui-navigation 5, chat 7, tool-activity 5, streaming 3, measurements 2, access-context 3) |
| `flock … pnpm exec playwright test e2e/agent-views.spec.ts e2e/composed-views.spec.ts e2e/app.spec.ts` (po próbach, na świeżym buildzie z `pnpm verify`) | **exit 0, 24 passed** |
| `flock … pnpm check:module-swap` (na `9a741d4`) | **exit 0** (pierwszy przebieg na `5c746a2`: exit 1 — sekcja 6) |

Po każdym przebiegu e2e usunięte nieśledzone `docs/evidence/chat-ux-2026-09-16/`, `docs/evidence/closure-2026-09-15/` i `test-results/`; drzewo czyste. Nie uruchomiono `agent-ui.spec.ts`, `files-agent.spec.ts` (prawdziwy model), `chat-drawer`, `chat-layout` (niedotknięte).

### 4.1 Co pokrywają testy

`tests/agent-views.test.ts` (test kontraktu lub logiki; prawdziwy parser, prawdziwy rejestr, narzędzia przez `invokeTool`):
- walidator: przyjęta tabela+wykres w `Stack` z `null`-ami i `groupBy`; `null` przed obecnym argumentem (`DataTable(src, cols, null, 10)`, `…, null, null, null, null, sort, "country"`) przyjęty w obu trybach i w widoku modułu przy rejestracji, a zły typ (`"dziesiec"`, `0`, `title = 5`) i `null` dla `source`/`kind` odrzucone; nieznany komponent w obu trybach; składnia, źródło częściowe, brak root, duplikat, odwołanie bez definicji, instrukcja osierocona, pusta; złe propsy (typ, `pie` z dwiema seriami); niezarejestrowana operacja, złe i brakujące wejście; **każde** pole spoza deskryptora (columns, filter, sort, groupBy, x, series, fields) z nazwą; seria nieliczbowa; tryb agent-views (BarChart/Table z liczbami przyjęte w `catalog`, odrzucone w `agent-views`; komponent modułu i układ przyjęte; wyrażenie, stan, Query odrzucone); `$param` tylko w widoku, który go deklaruje, i tylko jako klucz wejścia operacji; `findDataInstances` w `Tabs`;
- zapis i start: karta `openui` z nieznanym komponentem nie nadpisuje poprzedniej treści (`specVersion` 1), z nieznaną operacją — 400; widok modułu z nieznanym komponentem zatrzymuje `createPlatform` z nazwą modułu, widoku, instrukcji i komponentu; brak `DataTable` na `primaryOperation` i pole spoza deskryptora zatrzymują rejestrację; komponent modułu o nazwie `DataTable` → konflikt;
- narzędzia: tworzenie w przestrzeni rozmowy wykonania (nie w roboczej przestrzeni z `appContext`), `canvas_changed`, lista; patch zmienia tylko instrukcję `tabela`, `root` i `opis` bajt w bajt, geometria przesunięta przez użytkownika i druga karta bez zmian, zmiana rodzaju wykresu patchem `root`, nieaktualne `expectedSpecVersion` → `conflict`; 5 niepoprawnych zmian (nieznany komponent, BarChart, nieznana operacja, patch częściowy, `Table`) i tworzenie z liczbami odrzucone z właściwym `reason`, widok w poprzedniej wersji; karta innej rozmowy (update/remove) i innego właściciela → `forbidden`, obca rozmowa → `forbidden`, bez rozmowy → `precondition_failed`; `canvas_update_card`, `canvas_add_card` i `PATCH /spec` na przestrzeni widoków agenta → `component_not_allowed`; usunięcie rozmowy przez `DELETE /api/threads/delete/:id` usuwa przestrzeń i karty, zero przestrzeni `conversation` bez rozmowy; `GET …/agent-views` (brak przestrzeni bez tworzenia, karty po utworzeniu, 403 dla obcego bez treści); prompt (sekcja, sygnatury z katalogu, zakazy).

`tests/openui-catalog-parity.test.ts` (test kontraktu lub logiki): nazwy, kolejność parametrów i pełne `$defs` przeglądarki (`buildRegistry` z `procurementUiModule`) = katalog serwera z deklaracjami modułu = `services.catalog.openui` platformy; kopia JSON = `openuiLibrary.toJSONSchema()`; `groupRecords` (kolejność, etykiety enum, puste, waluty), `withGrouping` (odmowa pola); `readGate` (niepełne nazwy → brak `fetch`, oczekiwanie przed listą i przy `undefined`, awaria listy → backend, nieznana operacja → błąd z `reason`).

`e2e/agent-views.spec.ts` (symulacja; port 8798, `.e2e-scripted-agentviews`, instancja zatrzymywana w `afterAll`; każde polecenie wysyłane z kompozytora, strona otwierana linkiem „Widoki agenta”):
1. Bez rozmowy: stan `no-conversation`. `[zestawienie]` → id karty z wyniku `agent_view_create` **tej tury** (historia rozmowy) = karta na stronie = jedyna karta przestrzeni rozmowy; każda komórka = `POST /api/read` (`procurement.comparison`). `[wykres]` → nowa karta; podpis: `data-unit=PLN`, `data-min/max`, tekst „od … do …” = backend, liczba kategorii; obie karty; wykres umieszczony pod tabelą i `geometryVersion` [1,1] po wyrenderowaniu; ścieżka i `s` bez zmian.
2. Użytkownik przeciąga tabelę (PATCH geometrii). `[grupowanie]` → `tbody[data-group-field=currency]` = liczba walut w backendzie, nagłówek i `data-group-count` per waluta, id wierszy w grupie = backend, wszystkie komórki = backend; tekst niezmienionej instrukcji `opis` widoczny; ta sama karta, `specVersion +1`, geometria = przeciągnięta, `boundingBox` bez zmian, karta wykresu identyczna. `[typ]` → „Wykres liniowy”, tabela identyczna, grupy dalej widoczne.
3. `[odmowy]`: na ekranie „Behind the scenes · 3 failed” i treść odmowy; w wynikach tury: `unknown_component` (patch z `Wykresik`), `component_not_allowed` (BarChart z liczbami), `unknown_operation`; stan przestrzeni identyczny, na ekranie 2 karty, tabela nadal pogrupowana, brak „Liczby wpisane”.
4. Przeładowanie odtwarza widoki A; „New chat” → `no-conversation`; rozmowa B dostaje własną kartę, na ekranie tylko ona; przełączenie z listy rozmów do A → karty A, bez karty B; przeładowanie → A.
5. W A `[w tle]` (6 s oczekiwania, potem `agent_view_create`), użytkownik przełącza się do B; po zakończeniu wykonania A: adres identyczny z adresem w B, strona B z 1 kartą, bez „Widok z tla”, karty B identyczne; widok trafił do A i jest widoczny po powrocie do A (3 karty).
6. `[czat]` strumieniuje `DataTable` z nazwą operacji przeciętą w połowie: obserwator DOM widział w czacie komponent z niepełną nazwą, ale żadne `POST /api/read` nie dotyczyło niezarejestrowanej nazwy; tabela w odpowiedzi = backend. `[czat-nieznana]` → `data-state=error`, „Nieznana operacja odczytu "nie.istnieje"”, bez żądania.

---

## 5. Kontrole negatywne i próby zdolności wykrycia

Każda próba: zmiana bez commitu → test → `git checkout -- <plik>` → drzewo czyste (`git status` pusty). Próby UI z przebudową `pnpm --filter @app/web build`; na koniec `pnpm verify` (pełny build) i ponowny zielony przebieg e2e (sekcja 4).

| # | Wycofanie | Polecenie | Wynik z wycofaniem |
|---|---|---|---|
| A | `openui-validation.ts`: warunek listy dozwolonej `&& false` | `vitest run tests/agent-views.test.ts` | **3 failed / 19**: tryb widoków agenta (`expected [] to include 'component_not_allowed'`), niepoprawny patch (`component_not_allowed: expected true to be false`), ogólne narzędzia/API |
| B | `pickFields(descriptor, names)` → `pickFields(descriptor, [])` | j.w. | **3 failed / 19**: pola spoza deskryptora, seria nieliczbowa, start widoku z polem `miasto` (`expected [Function] to throw`) |
| C | `agent-views.ts`: kontrola przestrzeni karty `if (false)` | j.w. | **1 failed / 21**: „widok innej rozmowy…” — `expected undefined to be 'forbidden'` |
| D | `conversations.ts`: DELETE przestrzeni dla innego `scope_id` | j.w. | **1 failed / 21**: `removedViewSpaces` `expected +0 to be 1` |
| E | `mergeStatements(current, input.patch)` → `input.patch` | j.w. | **2 failed / 20**: patch (`missing_root`), niepoprawny patch (`expected 'missing_root' to be 'unknown_component'`) |
| F | `modules.ts`: `if (false) validateComposition(...)` | j.w. | **2 failed / 20**: oba testy startu (`expected [Function] to throw an error`) |
| G | `readGate`: zawsze `fetch` dla znanej listy | `vitest run tests/openui-catalog-parity.test.ts` | **2 failed / 6**: `[ 'fetch','fetch','fetch' ]` zamiast `refuse`, nieznana operacja `fetch` |
| H | `agent_view_create` pisze do `ctx.appContext.spaceId` (robocza przestrzeń) | `vitest run tests/agent-views.test.ts` | **7 failed / 15** (m.in. przestrzeń rozmowy `null`, cudza karta `forbidden`) |
| I | kopia JSON: `"TextContent"` → `"TextKontent"` | `vitest run tests/openui-catalog-parity.test.ts` | **2 failed / 6**: katalog odmawia startu widoku modułu (`nieznany komponent TextContent`), kopia ≠ biblioteka |
| J | `openui-validation.ts`: bez usuwania `null` przed Zod (`safeParse(el.props)`) | `vitest run tests/agent-views.test.ts` | **4 failed / 19** (na 23): m.in. test `null` (`catalog: expected [ { reason: 'invalid_props' … } ] to deeply equal []`), patch z `null`-ami (`title: expected string, received null`) |
| I2 | serwer deklaruje tylko `OfferComparison` (`.slice(0, 1)`) | j.w. (po zmianie na import dynamiczny) | **1 failed / 7**: nazwy 57 ≠ 58 |
| E3 | jak A, e2e (serwer skryptowany ze źródeł) | `flock … playwright test e2e/agent-views.spec.ts` | **1 failed / 2 passed / 3 nie uruchomione**: test 3 — brak „Behind the scenes · 3 failed” (BarChart zapisany) |
| E1 | jak G, w buildzie przeglądarki | `pnpm --filter @app/web build` + `flock … playwright test e2e/agent-views.spec.ts` | **1 failed / 5 passed**: test 6 — wysłane odczyty `["procurement.", "procurement.supp"]` |
| E2 | `CanvasHost.tsx`: przywrócony zapis pomiaru z (0,0) | j.w. | **1 failed / 5 nie uruchomione**: test 1 — `Expected: >= 360, Received: 0` (wykres przeniesiony na tabelę) |

Kontrole negatywne zawarte w samych testach: sekcja 4.1 (odmowy walidatora każdego rodzaju, zakres rozmowy i właściciela, obejście przez ogólne narzędzia i API, usunięcie rozmowy, strony bez rozmowy, zadanie w tle, strumień czatu, nieznana operacja w czacie).

---

## 6. Nieudane przebiegi (poza celowymi próbami)

1. `tests/openui-catalog-parity.test.ts` (pierwszy): 1 failed — opis `DataTable` na serwerze różnił się od opisu w `defineComponent`. **Błąd implementacji** (zduplikowany tekst); opisy przeniesione do kontraktów. Kolejny: 8/8.
2. `pnpm test` (pełny, przed commitem): 1 failed — `views-foundation` „podział narzędzi platformy zachowuje nazwy i kolejność” (17 → 21 narzędzi). **Oczekiwana zmiana kontraktu**; lista uzupełniona o 4 narzędzia na końcu (kolejność wcześniejszych bez zmian).
3. `e2e/agent-views.spec.ts` przebieg 1: 1 failed (test 2) — karta wykresu miała `geometryVersion` 3 zamiast 2 i pozycję (0,0). **Istniejący błąd aplikacji** (sekcja 2.7), naprawiony; test wzmocniony.
4. Przebieg 2: 1 failed (test 3) — `toContainText('[call:agent_view_update] …')`: czat pokazuje tylko ostatni segment tekstu tury, wcześniejsze są zwinięte w „Behind the scenes”. **Wada testu**; wyniki narzędzi czytane z historii rozmowy, na ekranie etykieta „3 failed” i ostatnia odmowa. Przy okazji wykryty artefakt symulacji „failed” przy udanych wywołaniach (sekcja 2.8), naprawiony w `scripted-agent.ts`.
5. Przebieg 3: 1 failed (test 4) — przełączenie rozmowy nie nastąpiło: szuflada zamknięta jest poza ekranem, ale `isVisible()` zwraca prawdę, więc nie otwierano jej, a kliknięcie `force` trafiało w pustkę. **Wada testu**; helper otwiera szufladę wg `data-sidebar-visual-state`.
6. Przebieg 4: 1 failed (test 5) — `updatedAt` przestrzeni B zmienione. Przyczyna: sama strona B zapisuje viewport własnej przestrzeni po zamontowaniu, nie wykonanie A. **Wada testu**; porównywane karty i id przestrzeni.
7. `pnpm check:module-swap` (na `5c746a2`): exit 1 — typecheck kopii bez `packages/module-procurement/src/ui`: `tests/openui-catalog-parity.test.ts: Cannot find module '@module/procurement/ui'`. **Wada testu** (statyczny import połówki UI modułu); import dynamiczny, zdolność wykrycia potwierdzona (I2), swap exit 0.

Brak innych nieudanych przebiegów na tym kodzie.

---

## 7. Kontrakt dla autora modułu

**Komponenty OpenUI modułu** (`ServerModule.openuiComponents`, `UiModule.openuiComponents`):
- Deklaruj `{ name, description, propsSchema: z.object({...}) }` w pliku modułu **bez Reacta** (wzór: `module-procurement/src/shared/openui.ts`); przeglądarka robi `defineComponent({ name, description, props: propsSchema, component })`, serwer podaje te same obiekty w `openuiComponents`. Kolejność kluczy schematu = kolejność argumentów pozycyjnych.
- Komponent bez deklaracji serwerowej jest odrzucany jako nieznany we wszystkich kartach i widokach. Nazwa zajęta (gotowa biblioteka, `DataTable/DataChart/DataSummary`, inny moduł) → `conflict` przy starcie.
- Propsy niosą referencje (np. `caseId`), nie wartości; walidacja sprawdza schemat, nie własność rekordu — odmowa dostępu przychodzi przy odczycie.
- Komponenty modułu są dozwolone w widokach agenta.

**Widoki modułu** (`ServerModule.views`) — sprawdzane przy starcie (tryb `catalog`):
- musi być `root = …`; każda linia to `nazwa = wyrażenie`; brak instrukcji zdublowanych, osieroconych i odwołań bez definicji; brak `Query`/`Mutation`;
- komponenty danych: propsy stałe; jedyny wyjątek — `$param` z `params` widoku jako **wartość** w `source.input` (np. `{caseId: $caseId}`), klucz musi być kluczem wejścia operacji; komponent danych nie może być wynikiem wyrażenia;
- `source.operation` zarejestrowana i z `result`; wejście zgodne ze schematem; `columns`, `filter[].field`, `sort.field`, `groupBy`, `x`, `series`, `fields` — tylko pola deskryptora; `series` tylko pola liczbowe;
- gdy widok ma `primaryOperation`, kompozycja musi zawierać `DataTable` czytający tę operację;
- błąd: `Modul <id>, widok <id>: Kompozycja OpenUI odrzucona: <problemy>` — start przerwany, moduł niezarejestrowany.

**Sygnatury komponentów danych**: `DataTable(source, columns?, title?, pageSize?, filter?, sort?, groupBy?)`, `DataChart(source, kind, x, series, title?, filter?, sort?)`, `DataSummary(source, fields, title?)`; `null` pomija argument pozycyjny. `groupBy`: dowolne zadeklarowane pole; grupy wg wartości i jednostki.

**Karty `openui` i widoki agenta** (zapis przez API i narzędzia):
- odmowa `validation_failed`, `details.reason` = pierwszy z `COMPOSITION_REFUSALS`, `details.problems[] = { reason, message, statementId?, component? }`; poprzednia treść karty zostaje;
- w przestrzeni rozmowy (`scopeKind: 'conversation'`) obowiązuje tryb `agent-views`: komponenty danych, komponenty modułów, `AGENT_VIEW_LAYOUT_COMPONENTS`; bez wyrażeń i stanu; karta `kind: 'component'` odrzucona.

**Po aktualizacji `@openuidev/react-ui`**: `node scripts/openui-library-schema.mjs`, przejrzyj różnicę, `pnpm test` (test zgodności).

---

## 8. Self-review — ustalenia

- Znalezione i poprawione w trakcie: zduplikowane opisy komponentów danych (test zgodności); reset pozycji kart przy pomiarze (istniejący); artefakt „failed” w symulacji; statyczny import UI modułu w teście (swap).
- Granica platforma–domena: `pnpm check:boundaries` OK; platforma zna tylko nieprzezroczysty zakres `conversation` (platformowy), słownik domeny tylko w module.
- G9: operacje przez `prepareRead` (rozszerzone, nie skopiowane), pola przez `pickFields`, formatowanie grup przez `formatFieldValue`, opisy komponentów z kontraktów, sygnatury promptu ze schematu walidatora.
- Minimalne zmiany we wspólnych plikach: `prompt.ts` 2 linie, `tools/index.ts` 1 wpis na końcu, `router.tsx`/`compose.tsx` po jednym wpisie, `DataTable.tsx` — grupowanie jako hook-in + wydzielenie `renderRow` (ten sam markup), `groupBy` na końcu schematu.
- Instancja użytkownika (8791), główny checkout i inne worktree nietknięte. Ręczny smoke `dist/server.js` na porcie 18745 z katalogiem w scratchpadzie, zatrzymany `kill <PID>` własnego procesu, katalog usunięty.

---

## 9. Obawy

1. **Dołączenie `lang-core` do bundla** (`apps/server/build.mjs`, sekcja 2.2) zamiast deklaracji w `@app/server` — do potwierdzenia przez koordynatora; bez jednej z tych zmian zbudowany serwer nie startuje.
2. **Konflikty przy scalaniu** spodziewane w: `agent/tools/index.ts` i liście w `views-foundation.test.ts` (T2 `ui_sort`, T3 `ui_state`), `views.ts` (T2 może dopisywać propsy — `groupBy` jest teraz ostatni), `DataTable.tsx` (T2 sort/paginacja), `CanvasHost.tsx`, `queries.ts`, `router.tsx`, `compose.tsx`, `ui-targets.ts`, `http/app.ts`, `prompt.ts`, `scripted-agent.ts`/`scripted-server.ts`. **Task 5**: nowe komponenty OpenUI modułu muszą trafić do `shared/openui.ts` i `openuiComponents`, a nowe widoki przejdą walidację startową (np. `$caseId` tylko jako wartość `source.input` przy `params: ['caseId']`).
3. **Stan użytkownika w karcie poza geometrią** (np. rozwinięta sekcja `Accordion`, wybrana zakładka `Tabs`) nie ma testu przeżycia zmiany treści; e2e dowodzi przeżycia pozycji karty i drugiej karty.
4. Przestrzenie widoków agenta nadal zwraca `GET /api/canvas/spaces` i `ui_catalog` (ukryte tylko na liście „Zapisane kompozycje” i w fallbacku canvasu); `ui_navigate` ze `spaceId` takiej przestrzeni otworzy ją na roboczym canvasie (reguła `agent-views` nadal obowiązuje przy zapisie).
5. Karty `openui` zapisane przed tą zmianą nie są migrowane ani sprawdzane — działają do pierwszej aktualizacji, która musi przejść walidację.
6. L3.3 częściowo: referencja do cudzego rekordu w propsach (`caseId`) nadal przyjmowana przy zapisie, odmowa przy odczycie.
7. W czacie, w trakcie strumienia, komponent z niepełną nazwą operacji chwilowo pokazuje błąd „Nieznana operacja” (bez żądań) — kosmetyczne; nie rozróżniam strumienia, bo `useIsStreaming` wymaga kontekstu Renderera.
8. L3.16 (dobór formy bez nazwy komponentu) ma tylko prompt i symulację — potwierdzenie prawdziwym modelem to Task 8; lista `alwaysLoad` wydłużona o 3 narzędzia (każde jest w każdym promptcie).
9. Wygenerowany `openui-library.schema.json` (45 KB) w repozytorium — pilnowany testem, ale wymaga regeneracji przy aktualizacji biblioteki.
10. **Kompozycje Task 2 z `null`**: walidator przyjmuje `null` jako pominięty argument opcjonalny (test i próba J). Przykład z notatki koordynatora `DataTable(source, columns, title, null, 10)` w kolejności kontraktu z tej gałęzi (`source, columns, title, pageSize, filter, sort, groupBy`) oznacza `pageSize = null`, `filter = 10` — i zostałby odrzucony (`field "/filter" expects array but got number`), tak samo jak Renderer odrzuca go w przeglądarce. Jeśli Task 2 nie zmienił kolejności kluczy, właściwa forma to `DataTable(source, columns, null, 10)` (pominięty `title`); przy scalaniu warto uruchomić start z widokami Task 2 — błędna pozycja zatrzyma start z nazwą instrukcji.


---

## Fix round 1 (po przeglądzie: „Needs fixes”)

Commity: `5361778` — Poprawki po przeglądzie T4 (runda 1): patch nie gubi instrukcji, widoki innej rozmowy niedostępne dla ogólnych narzędzi, odświeżanie strony w trakcie wykonania; `7970288` — E2E pierwszego widoku: widok tworzony po odczycie pustego stanu strony, żeby test wykrywał brak unieważnienia.

### Zmiany wg ustaleń

**I1 — patch gubił instrukcje po cichu.** `openui-validation.ts`: nowe `statementsOf(source)` (nazwy w kolejności, usunięcia `x = null`, problemy listy: `syntax`, `duplicate_statement`, `partial` przez `autoClose`) — używane też przez `checkComposition`; nowe `applyCompositionPatch(current, patch)`: patch sprawdzany tak, jak został napisany, **przed** scaleniem; po `mergeStatements` odmowa `orphaned_statement`, gdy instrukcji z patcha (poza `x = null`) nie ma w wyniku („nie jest osiągalna z root”), oraz gdy znika instrukcja obecnej kompozycji niewskazana jako `x = null` („zniknęłaby z widoku … usuń ją jawnie: opis = null”); usunięcie nieistniejącej instrukcji → `unresolved_reference`; `unchanged`, gdy wynik jest bajtowo identyczny. `compositionRefusal(problems)` wydzielone (jedna postać odmowy). `agent_view_update`: odmowa przed zapisem; gdy treść (i tytuł) się nie zmienia — brak zapisu, brak nowej wersji, brak zdarzenia, odpowiedź `unchanged: true`; opis narzędzia mówi o obu regułach.

**I2 — reguła jednej rozmowy do obejścia.** `services/canvas.ts`: `assertOwnConversationViews(space, runConversationId)` (`forbidden`, `details.reason = 'other_conversation_views'`, wskazuje `agent_view_*`; `undefined` = wywołanie spoza wykonania, np. HTTP), `getSpace`, `spaceOfCard`. Stosowane w `canvas_list_cards`, `canvas_add_card`, `canvas_update_card`, `canvas_move_card`, `canvas_remove_card` (emisja `canvas_changed` teraz z przestrzeni karty, nie z kontekstu) oraz w `ui_navigate` ze `spaceId`. `ui_catalog` pomija przestrzenie `conversation` innych rozmów (własna zostaje).

**I3 — strona nie odświeżała się w trakcie wykonania.** `runEvents.ts`: `canvas_changed` unieważnia dodatkowo `qk.agentViewsAll()` = `['canvas', scope, 'agent-views']` (widoki są czytane po rozmowie, zdarzenie zna tylko przestrzeń — przy pierwszym widoku strona jej jeszcze nie zna). Komentarz `qk.agentViews` poprawiony; sprostowanie w §1.6.

**I4 — `MarkDownRenderer` na liście dozwolonej.** Usunięty z `AGENT_VIEW_LAYOUT_COMPONENTS`, uzasadnienie w komentarzu (obrazy i linki pod dowolny adres, listy wpisanych wartości). Prompt bierze listę z tej stałej.

**R1** — `@openuidev/lang-core@0.2.18` w `apps/server/package.json` (lockfile: +3 linie w `importers` `apps/server`), `apps/server/build.mjs` przywrócony bajt w bajt do bazy `3097586` (bez `BUNDLED`). Smoke: `PORT=18746 APP_DATA_DIR=<scratchpad>/smoke2 node apps/server/dist/server.js` → `/api/health` 200, `POST /api/canvas/cards` z `root = Nieznany(1)` → 400 `unknown_component`; proces zatrzymany `kill <PID>`, katalog usunięty. `check:module-swap` exit 0 (kopia robi `pnpm install --frozen-lockfile` i build).
**R2** — przykład grupowania w prompcie powtarza `{field: "poleB", direction: "desc"}` i dopisuje tylko `"poleA"`; dodane zdanie, że nowa instrukcja musi trafić do root, a usuwana to `nazwa = null`. Inne przykłady sprawdzone (przykład kompozycji bez zmian).
**R3** — test przemianowany na „schematy wejścia narzędzi agent_view_* przechodzą kontrolę MCP i tak są wystawiane modelowi”: `assertMcpCompatibleShape` dla każdego, `z.toJSONSchema(inputSchema).required` = dokładnie pola wymagane (`title, source` / `cardId` / brak), `buildMcpServer` wystawia `mcp__app__agent_view*`; asercje-wypełniacze usunięte; prompt w osobnym teście (także brak `MarkDownRenderer` i przykład z zachowanym `sort`).
**R4** — `http/app.ts`: `refuseReservedScope` w `POST /api/canvas/spaces` **i** `POST /api/canvas/spaces/for-scope` (ta druga trasa pozwalała na to samo przez `kind`) → 400 `reserved_scope`.

### Testy (nowe/zmienione w `tests/agent-views.test.ts`, 23 → 28)

- „patch nie gubi niczego po cichu…” — (a) `wykres2 = DataChart(...)` bez zmiany root → `orphaned_statement`; (b) `root = Stack([tabela])` → `orphaned_statement` z nazwą `opis`; (c) patch z linią `to nie jest instrukcja` → `syntax`; (d) `opis` dwa razy → `duplicate_statement`; `duch = null` → `unresolved_reference`; po każdej odmowie treść i `specVersion` 1 bez zmian; patch identyczny → `unchanged: true`, `specVersion` 1 w bazie; te same zamiary zapisane poprawnie (`root` z `wykres2`, `opis = null`) → `specVersion` 2 i dokładna treść.
- „ogólne narzędzia canvasu i interfejsu nie sięgają do widoków agenta innej rozmowy” — z rozmowy A: `canvas_list_cards`, `canvas_add_card`, `canvas_update_card`, `canvas_move_card`, `canvas_remove_card`, `ui_navigate` na przestrzeń/kartę B → `forbidden`/`other_conversation_views`; także gdy kontekst A wskazuje przestrzeń B; stan B identyczny; `ui_catalog` A bez przestrzeni B, z własną; własne widoki dostępne przez `canvas_list_cards`.
- „wykonanie w tle w rozmowie A nie zmieni widoków rozmowy B ogólnym narzędziem” — prawdziwy `AgentRuntime` + skryptowany agent w A (kontekst: rozmowa i przestrzeń B) woła `canvas_remove_card` i `canvas_move_card` na karcie B → oba `TOOL_CALL_RESULT` błędne z `other_conversation_views`, stan B identyczny.
- „zakres rozmowy jest zarezerwowany…” — `POST /api/canvas/spaces` (istniejąca i nieistniejąca rozmowa) i `/for-scope` → 400 `reserved_scope`, żadna przestrzeń nie powstała; inny zakres → 201.
- tryb widoków agenta: `MarkDownRenderer("- Dostawca A: 12 345,00 PLN…![x](https://example.com/p.png)")` → `component_not_allowed`; lista dozwolona porównana dokładnie.
- R3 i prompt jak wyżej.

`e2e/agent-views.spec.ts` (6 → 7): „pierwszy widok rozmowy pojawia się na stronie w trakcie wykonania, nie dopiero po nim” — nowa rozmowa na stronie Widoków agenta, scenariusz `[pierwszy]` (3 s → `agent_view_create` → 8 s), strona najpierw `empty` dla tej rozmowy, potem `ready` z kartą z backendu, a pasek wykonania nadal `running`; po zakończeniu id karty = wynik `agent_view_create` tury.

### Polecenia i wyniki

| Polecenie | Wynik |
|---|---|
| `pnpm exec vitest run tests/agent-views.test.ts` | exit 0, **28/28** |
| `pnpm exec vitest run tests/openui-catalog-parity.test.ts tests/views-foundation.test.ts tests/mcp-schema.test.ts tests/ui-navigation.test.ts` | exit 0, 72/72 |
| `pnpm build` + `flock … playwright test e2e/agent-views.spec.ts` (na `5361778`) | exit 0, 7 passed |
| `pnpm build` + `flock … playwright test e2e/agent-views.spec.ts e2e/composed-views.spec.ts e2e/app.spec.ts` (na `7970288`) | **exit 0, 25 passed** (7 + 4 + 14) |
| `flock … playwright test e2e/ui-navigation.spec.ts e2e/scripted-call.spec.ts` (dotknięte przez `ui_catalog`/`ui_navigate`) | exit 0, 6 passed |
| `pnpm verify` (na `7970288`) | **exit 0** — Vitest **27 plików / 363 testy** |
| `flock … pnpm check:module-swap` (na `7970288`) | **exit 0** |

Po przebiegach usunięte `docs/evidence/chat-ux-2026-09-16/`, `docs/evidence/closure-2026-09-15/`, `test-results/`; drzewo czyste.

### Próby zdolności wykrycia (na zacommitowanym kodzie; wycofanie → test → `git checkout -- <plik>`)

| Próba | Wycofanie | Wynik |
|---|---|---|
| I1a | `agent-views.ts`: bez `throw compositionRefusal(patched.problems)` | `tests/agent-views.test.ts` **2 failed / 26**: patch `partial` przyjęty (`expected true to be false`), przypadek (a) `wykres2` przyjęty |
| I1b | `agent-views.ts`: bez skrótu `unchanged` (`if (false)`) | **1 failed / 27**: `expected { …(5) } to match object { unchanged: true, specVersion: 1 }` |
| I2 | `canvas.ts`: `assertOwnConversationViews` zawsze przepuszcza | **2 failed / 26**: `canvas_list_cards: expected undefined to be 'forbidden'`; wykonanie w tle `[ [ undefined, undefined ], … ]` (karta B usunięta) |
| I2b | `ui.ts`: bez filtra przestrzeni w `ui_catalog` | **1 failed / 27**: lista zawiera przestrzeń B |
| I3 | `runEvents.ts`: bez `invalidateQueries(qk.agentViewsAll())`, `pnpm --filter @app/web build` | pierwsza wersja testu: **1 passed** — test nie wykrywał (strona czytała widoki rozmowy dopiero po utworzeniu karty, wyścig); poprawiony scenariusz (3 s przed utworzeniem, asercja stanu `empty`) → **1 failed**: `Expected: "ready"`, `Received: "empty"` (linia 475). Potem przywrócone i przebudowane (`pnpm build`), 25 passed |
| I4 | `MarkDownRenderer` z powrotem na liście | **2 failed / 26**: `expected [] to include 'component_not_allowed'`; prompt zawiera `MarkDownRenderer` |
| R4 | `refuseReservedScope` zawsze przepuszcza | **1 failed / 27**: `/api/canvas/spaces: expected 201 to be 400` |

### Nieudane przebiegi i pomyłki w tej rundzie

1. **Moja pomyłka proceduralna:** pierwsza seria prób (I1a…R4) została uruchomiona **przed** commitem poprawek; pomocnik próby przywracał plik `git checkout -- <plik>`, co cofnęło niezacommitowane poprawki w `agent-views.ts`, `services/canvas.ts`, `tools/ui.ts`, `openui-validation.ts`, `http/app.ts` (kolejne próby w tej serii oblewały kaskadowo i nie są dowodem). Poprawki odtworzone tymi samymi skryptami edycji, `tests/agent-views.test.ts` 28/28, commit `5361778`, dopiero potem powtórzona seria prób (tabela wyżej) — pomocnik sprawdza teraz czyste drzewo przed każdą próbą.
2. Próba I3 w pierwszej postaci nie oblała (wada testu — opisane w tabeli); test wzmocniony w `7970288`.
3. Poza tym żadnych nieudanych przebiegów w tej rundzie.

### Kontrakt dla autora modułu — uzupełnienie

- Zmiana widoku agenta patchem: każda instrukcja patcha musi być osiągalna z `root` (dodaj ją do `root` w tym samym patchu), instrukcję usuwa się jawnie `nazwa = null`, żadna istniejąca instrukcja nie może zniknąć niejawnie; linie patcha podlegają tym samym regułom składni i unikalności co pełna kompozycja; brak zmiany → `unchanged: true` bez nowej wersji.
- Zakres `conversation` jest zarezerwowany dla platformy: nie twórz przestrzeni z tym zakresem przez `POST /api/canvas/spaces` ani `/for-scope` (400 `reserved_scope`).
- W widokach agenta nie ma `MarkDownRenderer` — tekst przez `TextContent`, `TextCallout`, `CardHeader`.

### Obawy po rundzie

- Obawa 1 z §9 (bundel) rozwiązana decyzją R1. Pozostałe z §9 bez zmian.
- Deklaracje komponentów Task 5 (`shared/openui-components.ts`: `CaseHeader`, `CaseOfferSources`, `ItemProvenance`, `SectionHeading`) nie są w tej gałęzi; przy scalaniu muszą trafić do `openuiComponents` (inaczej widoki szczegółów Task 5 nie przejdą walidacji startowej jako nieznane komponenty) — test zgodności katalogu to wykaże.
- `canvas_changed` unieważnia widoki agenta wszystkich rozmów (ponownie czytana jest tylko rozmowa na ekranie) — świadomie prosto, zdarzenie nie niesie rozmowy.

---

## Merge round (runda scalenia z `bl01-bl02/integracja` = eb6985e: Task 1 + Task 5 + Task 2)

Commity: `dabc157` — Scalenie bl01-bl02/integracja (Task 1 + Task 5 + Task 2) do gałęzi Task 4 (rodzice `7970288`, `eb6985e`; bez rebase i przepisywania historii); `9aec7be` — Po scaleniu: patch z nieczytelną linią odrzucony, brak zmian porównywany po instrukcjach, nieaktualna wersja to konflikt; sortowanie kompozycji tylko po polu sortowalnym; grupowanie strony.

### Konflikty i rozstrzygnięcia

| Plik | Konflikt | Rozstrzygnięcie |
|---|---|---|
| `platform-server/src/agent/tools/ui.ts` | importy: `sortableFieldsOfTarget` (T2) vs `assertOwnConversationViews` (T4) | oba importy; `ui_catalog` ma `sortableFields` (T2) i filtr przestrzeni innych rozmów (T4), `ui_navigate` — kontrola przestrzeni T4 |
| `platform-ui/src/views/DataTable.tsx` | cały komponent: stan widoku w adresie, `HeaderCell`/`FilterBar`/`Pager`, `model.shown` (T2) vs grupowanie + `renderRow` (T4) | baza = wersja T2 bez zmian zachowania; grupowanie dołożone jako hook-in: `withGrouping(buildDataModel(...), props.groupBy)`, `groupBy` w zależnościach modelu, `renderRow` wydzielony (ten sam markup wiersza co T2), przy grupowaniu jeden `<tbody>` na grupę **wierszy strony** |
| automatycznie scalone, sprawdzone | `views.ts` (`dataSortSchema` przeniesione przez T2 do `ui.ts`; `groupBy` nadal ostatni w `dataTablePropsSchema` — sprawdzone), `module.ts`, `tools/index.ts` (`ui_sort` przed narzędziami widoków agenta; test kolejności narzędzi zgodny), `prompt.ts` (sekcja widoków agenta nadal po operacjach odczytu), `scripted-agent.ts`/`scripted-server.ts`, `router.tsx`, `styles.css`, `module-procurement/src/{server/index.ts, ui/index.tsx}` | bez zmian ręcznych poza uzgodnieniem komponentów niżej |

### Uzgodnienie deklaracji komponentów OpenUI modułu

Jedno miejsce bez Reacta: `module-procurement/src/shared/openui-components.ts` (plik Task 5) — schematy propsów Task 5 zostają eksportowane, dopisane `offerComparisonPropsSchema`, `offerCostChartPropsSchema` i `PROCUREMENT_OPENUI_COMPONENTS` z nazwą, opisem i schematem dla **6** komponentów (`SectionHeading`, `CaseHeader`, `CaseOfferSources`, `ItemProvenance`, `OfferComparison`, `OfferCostChart`). Mój `shared/openui.ts` usunięty. Przeglądarka: `ui/detailComponents.tsx` i `ui/index.tsx` biorą nazwę/opis/schemat z tej stałej (opisy Task 5 przeniesione dosłownie); serwer: `openuiComponents: Object.values(PROCUREMENT_OPENUI_COMPONENTS)`. Komentarz nagłówkowy pliku Task 5 („wired up alongside the startup validator”) zastąpiony opisem stanu faktycznego (walidacja widoków modułu przy starcie, kart i widoków agenta przy zapisie, test zgodności).

Widoki szczegółów Task 5 przechodzą walidację startową (tryb `catalog`): `DataTable({... input: {caseId: $caseId}})` przez `params: ['caseId']`, `CaseHeader($caseId)`/`CaseOfferSources($caseId)`/`ItemProvenance($itemId)` jako komponenty modułu z parametrem w propsie (wyrażenie `$param` w propsach komponentu niebędącego komponentem danych jest dozwolone w trybie `catalog`; niezadeklarowany `$x` w propsach komponentu modułu nie jest sprawdzany — jak dotąd, patrz obawy).

### Grupowanie × stronicowanie i sortowanie z adresu — decyzja

**Grupy tworzone z wierszy bieżącej strony (`model.shown`), po porządku i podziale na strony.** Uzasadnienie: tabela pokazuje stronę, pager i opis semantyczny (`describeDataInstance` wymienia `shown`) opisują te same rekordy; grupowanie nie może zmienić, które rekordy są na stronie ani liczby stron. Nagłówek grupy: `Pole: wartość (n)` gdzie `n` = wiersze grupy na stronie; gdy grupa ma więcej rekordów w całym dopasowanym zbiorze — `(n z N)`; atrybuty `data-group-count` (strona) i `data-group-total` (cały zbiór po zawężeniach). Sortowanie z adresu (T2) działa bez zmian — kolejność grup = kolejność pierwszego wystąpienia na stronie. `groupRecords(records, field, all?)` dostało opcjonalny zbiór do liczenia `total`.

### Poprawki po re-review (M1, M2, M4) i wynik scalenia

- **M1** — `applyCompositionPatch`: dla każdej instrukcji patcha (poza `x = null`) tekst w wyniku scalenia musi być tekstem patcha (porównanie tokenów `lang-core` `tokenize`, bez białych znaków); inaczej `syntax`: „Instrukcji tabela z patcha nie da się odczytać, więc nie zostałaby zastosowana”. Przypadki z przeglądu: `opis = TextContent("Nowy")\ntabela == DataTable(...)` i `tabela = @@@ ###` — odrzucone, treść i `specVersion` 1 bez zmian.
- **M2** — `unchanged` = te same instrukcje, w tej samej kolejności, o tych samych tokenach (`sameComposition`), niezależnie od pustych linii, odstępów i komentarzy; dotyczy patcha i pełnego `source`; zmiana wewnątrz napisu (`"Oferty  w sprawie"`) nadal jest zmianą.
- **M4** — `expectedSpecVersion` sprawdzane przed skrótem `unchanged`: nieaktualna wersja → `conflict` z `currentSpecVersion`, także gdy nic by się nie zmieniło.
- **Zgodność z T2 (znalezione przy scaleniu)** — `DataTable`/`DataChart` T2 odrzucają porządek kompozycji po polu `sortable: false` (`checkSortField`); walidator serwera przyjmował go (sprawdzał tylko deklarację). Teraz ta sama funkcja `checkSortField` → nowy powód `unsortable_field` (np. `sort` po `contactEmail`).

### Testy (nowe/zmienione)

`tests/agent-views.test.ts` (28 → 30): „patch: linia, której nie da się odczytać, zmiana tylko układu i nieaktualna wersja przy braku zmian” (M1 dwa warianty, M2 patch i pełne źródło z inną składnią, zmiana w napisie = wersja 2, M4 konflikt przy braku zmian i brak konfliktu dla aktualnej wersji); „porządek kompozycji tylko po polu sortowalnym”.
`tests/openui-catalog-parity.test.ts` (8 → 10): zgodność katalogu obejmuje 6 komponentów modułu (dokładna lista `moduleComponents` serwera i obecność w bibliotece przeglądarki, pełne `$defs` równe); „widoki szczegółów modułu przechodzą walidację startową tylko z deklaracjami swoich komponentów” (moduł rejestruje się; bez deklaracji `CaseHeader` → start odrzucony z nazwą widoku `procurement.case.detail`, bez `ItemProvenance` → `procurement.item.provenance`; bez `params` → `$caseId` w wejściu odrzucony); „grupy tworzy strona pokazana, a liczy cały dopasowany zbiór” (7 rekordów, `pageSize` 3, strona 2, sort malejąco: strona `4,3,2` identyczna z niegrupowaną, grupy `brutto [4,2] total 3`, `netto [3] total 4`, `page` bez zmian).

### Próby zdolności wykrycia (na zacommitowanym `9aec7be`, strażnik czystego drzewa przed każdą próbą)

| Próba | Wycofanie | Wynik |
|---|---|---|
| M1 | porównanie tekstu instrukcji patcha `if (false)` | `tests/agent-views.test.ts` **1 failed / 29**: przypadek `opis = TextContent("Nowy")\ntabela == DataTable(...)` przyjęty |
| M2 | `unchanged` = `merged === current` | **1 failed / 29**: `expected { …(5) } to match object { unchanged: true, specVersion: 1 }` |
| M4 | bez sprawdzenia `expectedSpecVersion` przed skrótem | **1 failed / 29**: `expected undefined to be 'conflict'` |
| sortowalność | bez `checkSortField` w walidatorze | **1 failed / 29**: `expected [] to include 'unsortable_field'` |
| grupowanie×strona | grupy z `model.records` zamiast `model.shown` | `tests/openui-catalog-parity.test.ts` **1 failed / 9**: grupy `[['netto', …], …]` zamiast `[['brutto', ['4','2'], 3], …]` |
| deklaracje modułu | (w samym teście) usunięcie `CaseHeader`/`ItemProvenance` z `openuiComponents` | start odrzucony z nazwą widoku i komponentu |

### Bramka G10 na scalonej gałęzi

| Polecenie | Wynik |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm exec vitest run tests/agent-views.test.ts tests/openui-catalog-parity.test.ts` | exit 0, 40/40 |
| `pnpm test` (po rozwiązaniu konfliktów, przed poprawkami) | exit 0, 28 plików / 411 testów |
| `pnpm verify` (na `9aec7be`) | **exit 0** — Vitest **28 plików / 415 testów** |
| `pnpm build` + `flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/agent-views.spec.ts e2e/composed-views.spec.ts e2e/view-state.spec.ts e2e/view-filter.spec.ts e2e/app.spec.ts e2e/ui-navigation.spec.ts e2e/scripted-call.spec.ts e2e/access-context.spec.ts e2e/session-restore.spec.ts e2e/tool-activity.spec.ts` | **exit 0, 63 passed** (agent-views 7, composed-views 7, view-state 8, view-filter 7, app 14, ui-navigation 5, scripted-call 1, access-context 3, session-restore 6, tool-activity 5) |
| `flock … pnpm check:module-swap` | **exit 0** |

Po przebiegach usunięte nieśledzone `docs/evidence/chat-ux-2026-09-16/` (wygenerowany `05-zawezony-widok.png`), `docs/evidence/closure-2026-09-15/`, `test-results/`; drzewo czyste.

### Nieudane przebiegi w tej rundzie

Brak. (Wszystkie przebiegi zielone za pierwszym razem; oblania tylko w celowych próbach z tabeli.)

### Kontrakt dla autora modułu — uzupełnienie

- Wszystkie komponenty OpenUI modułu deklaruj w jednym pliku bez Reacta (`{ name, description, propsSchema }`), z którego biorą je `defineComponent` w przeglądarce i `openuiComponents` serwera; brak deklaracji serwerowej zatrzymuje start każdego widoku, który komponentu używa.
- Porządek w kompozycji (`sort`) tylko po polu sortowalnym (`sortable !== false`) — odmowa `unsortable_field`.
- `groupBy` grupuje wiersze strony; z `pageSize` grupa może być rozdzielona między strony (nagłówek pokazuje `n z N`).
- Patch widoku agenta: każda linia patcha musi dać się odczytać i trafić do wyniku; ponowne wysłanie tych samych instrukcji w innym układzie to `unchanged`; `expectedSpecVersion` jest sprawdzane zawsze.

### Obawy po rundzie

1. `$x` w propsach komponentu modułu (nie komponentu danych) nie jest sprawdzany względem `params` widoku — widok z literówką `CaseHeader($caseID)` przejdzie start i pokaże błąd dopiero w przeglądarce. Nie zmieniałem w tej rundzie (poza zakresem ustaleń); prosta reguła do dodania, jeśli koordynator zechce.
2. Komentarz w `module-procurement/src/server/views.ts` wymienia sygnaturę `DataTable(source, columns, title, pageSize, filter, sort)` bez `groupBy` (tekst Task 1/5) — nie zmieniany, żeby nie przebudowywać po bramce.
3. Grupowanie przy `pageSize` może rozdzielić grupę między strony — świadoma konsekwencja decyzji „grupy ze strony”; nagłówek to ujawnia.

---

## Merge round — fix N1

Commit: `8701b29` — Pełne źródło w agent_view_update sprawdzane jak napisane przed porównaniem z obecną kompozycją (N1); sygnatura DataTable z groupBy w komentarzu widoków modułu.

**N1 (wprowadzone przez poprawkę M2).** `sameComposition` czyta tylko instrukcje, więc pełne `source` = obecna kompozycja + nierozpoznana linia (`@@@ smieci`) albo + powtórzona nazwa (`opis = …`) dawało `unchanged: true`, a z `title` — udaną zmianę tytułu z po cichu pominiętą złą linią. Poprawka (`agent/tools/agent-views.ts`, ścieżka pełnego `source`): najpierw `statementsOf(source).problems` (te same kontrole co dla patcha: `syntax`, `duplicate_statement`, `partial`) → `compositionRefusal`, dopiero potem skrót `sameComposition`.

**Komentarz** `module-procurement/src/server/views.ts`: sygnatura `DataTable(source, columns, title, pageSize, filter, sort, groupBy)` (obawa 2 z rundy scalenia zamknięta).

**Test** (`tests/agent-views.test.ts`, 30 → 31): „pełne źródło z nierozpoznaną linią lub powtórzoną nazwą jest odrzucane, nie uznane za brak zmian — z tytułem i bez” — 2 przypadki × (bez `title`, z `title`): `syntax` / `duplicate_statement` z komunikatem; karta po wszystkich próbach: tytuł `Przed`, `specVersion` 1, treść bez zmian.

**Próba zdolności wykrycia** (po commicie, na czystym drzewie): usunięta linia `if (written.problems.length > 0) throw compositionRefusal(written.problems);` → `pnpm exec vitest run tests/agent-views.test.ts` **1 failed / 30** (`syntax title=undefined: expected true to be false`); `git checkout -- packages/platform-server/src/agent/tools/agent-views.ts`, drzewo czyste.

| Polecenie | Wynik |
|---|---|
| `pnpm exec vitest run tests/agent-views.test.ts` | exit 0, **31/31** |
| `pnpm verify` (na `8701b29`) | **exit 0** — Vitest **28 plików / 416 testów** |

E2E nie uruchamiane (zgodnie z poleceniem; zmiana wyłącznie w ścieżce narzędzia i komentarzu). Nieudanych przebiegów poza celową próbą brak. Obawa 1 z rundy scalenia (`$x` w propsach komponentu modułu niesprawdzany względem `params`) bez zmian.
