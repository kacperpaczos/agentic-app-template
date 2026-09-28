## Task 1: Fundament — widoki danych jako kompozycje OpenUI

**Gałąź/worktree:** `t1-fundament`. **Kryteria:** fundament pod L3.14, L3.18, L2.17, L6.15 (samo w
sobie nie zamyka żadnego). **Zależy od:** nic.

**Cel.** Wprowadzić wspólne kontrakty i runtime AD-2…AD-5, przepiąć ekrany `/data` i `/cases` na
kompozycje oraz przygotować szwy, na których zadania fali 1 pracują bez kolizji.

**Musi:**
1. **Kontrakty** — nowy plik `packages/platform-contracts/src/views.ts` (eksport z indeksu):
   `FIELD_TYPES`, `recordFieldSchema`, `readResultDescriptorSchema`, `dataSourceSchema`
   (`input` jako `z.looseObject({}).optional()`), `viewDefinitionSchema`, schematy propsów
   `dataTablePropsSchema` (`source`, `columns?: string[]`, `title?`, `pageSize?` 1–200,
   `filter?: ViewFilterPredicate[]`, `sort?: {field, direction: 'asc'|'desc'}`),
   `dataChartPropsSchema` (`source`, `kind: 'bar'|'line'|'pie'`, `x`, `series: string[]`, `title?`,
   `filter?`, `sort?`), `dataSummaryPropsSchema` (`source`, `fields: string[]`, `title?`),
   `semanticInstanceSchema` (`instanceId`, `component`, `viewId|null`, `source`,
   `record {kind, idField}`, `fields [{field,label,type,unit?}]`, `filter`, `sort|null`,
   `page {index,size,count}|null`, `visibleRecordIds` ≤ 50, `matched`, `total`, `actions: string[]`).
   W `module.ts`: `ModuleReadOperation.result?`, `ServerModule.views?`.
2. **Serwer:**
   - jedna funkcja rozwiązująca operację odczytu (nazwa → rejestr → walidacja wejścia → uruchomienie z
     właścicielem), używana przez `ArtifactService.resolveLive`/`assertLiveSourceIsResolvable` i przez
     nowe `POST /api/read` → `{ operation, result, descriptor, resolvedAt }`; błędy przez `AppError`
     (nieznana operacja z listą dostępnych, `validation_failed`, `forbidden`/`not_found` z serwisu);
   - `GET /api/read/operations` (nazwa kwalifikowana, opis, klucze wejścia, deskryptor) i
     `GET /api/ui/views`;
   - rejestr modułów: unikalne `id` widoków; przy starcie odmowa, gdy `UiTarget.filter.fields` celu
     mającego widok nie należą do deskryptora odczytu tego widoku (moduł wskazuje go w definicji
     widoku albo test jednostkowy wykazuje zgodność — wybierz jedno i uzasadnij);
   - **szew narzędzi:** podziel `agent/platform-tools.ts` na katalog `agent/tools/` (`context.ts`,
     `canvas.ts`, `ui.ts`, `files.ts`, `artifacts.ts`, `index.ts` składający `platformTools`) bez
     zmiany zachowania, nazw ani kolejności narzędzi;
   - prompt: sekcja operacji odczytu wypisuje także pola deskryptora (jedno miejsce).
3. **Moduł procurement:** operacje odczytu `suppliers` i `cases` z deskryptorami (`supplier`/`case`),
   deskryptory dla istniejących `comparison` i `case_overview` tam, gdzie wynik ma kolekcję rekordów;
   `views` dla `procurement.data` i `procurement.cases` (kompozycje z `DataTable`). Trasy HTTP modułu
   zostają.
4. **UI platformy** (`packages/platform-ui/src/views/`):
   - `useReadOperation(source, opts)` + `qk.read`; `['read']` unieważniane wszędzie tam, gdzie
     `['module']` (m.in. `chat/runEvents.ts`);
   - `DataTable`, `DataChart`, `DataSummary` zarejestrowane w katalogu OpenUI (wspólna biblioteka
     dla widoków, kart `openui` i czatu); formatowanie wg typu pola (kwoty w groszach z walutą z
     `unitField`, ilości w tysięcznych, daty) jako jedna funkcja; rozróżnione stany ładowania,
     pusty, błąd, brak dostępu; atrybuty AD-5;
   - `DataChart` na gotowych wykresach `@openuidev/react-ui`; dostępny podpis (`figcaption` lub
     równoważny) z nazwami serii, jednostką i zakresem min–max wartości;
   - rejestr `state/uiSemantics.ts` (rejestracja/wyrejestrowanie opisu instancji, odczyt listy) i
     hook `useDescribeInstance` wołany przez komponenty danych — bez publikowania do backendu;
   - zawężenie z adresu w `DataTable` będącym instancją główną widoku z `UiTarget.filter`: ta sama
     semantyka i ten sam raport `reportFilterOutcome` co dziś w `useModuleData` — logika zawężania
     wydzielona do wspólnej funkcji (G9);
   - `ComposedView { viewId, params? }` z `data-testid="composed-view"` i `data-view-id`, ze stanami
     ładowania, błędu i nieznanego widoku; ekrany `CasesPage` i `DataPage` renderują go, zachowując
     `data-testid="cases-page"`/`"data-page"`.
5. **Szew testów skryptowanych** w `e2e/support/scripted-server.ts`: krok `call` `{ name, input }`
   wywołujący **prawdziwy** handler narzędzia platformy lub modułu z kontekstem wykonania, odpalający
   hooki Pre/PostToolUse z rzeczywistym wynikiem i emitujący `[call:<nazwa>] <wynik JSON, skrócony>`.

**Poza zakresem:** sortowanie, paginacja, kontrolki filtra (Task 2); publikacja snapshotu (Task 3);
walidacja OpenUI (Task 4); ekrany szczegółów (Task 5).

**Testy i dowody (minimum):**
- Vitest `tests/views-foundation.test.ts`: `/api/read` — sukces z deskryptorem, nieznana operacja,
  złe wejście, zasób innego właściciela; `/api/ui/views`; zgodność pól `UiTarget.filter` z deskryptorem
  (z próbą negatywną: pole spoza deskryptora odrzucone przy starcie); formatowanie typów pól;
  artefakty live nadal działają przez wspólną funkcję (istniejące testy zielone);
  `tests/mcp-schema.test.ts` i testy narzędzi zielone po podziale.
- E2E (bez modelu, instancja wspólna): nowy `e2e/composed-views.spec.ts` — `/data` i `/cases`
  renderowane przez `composed-view`, wartości komórek równe `POST /api/read`, atrybuty rekord–pole
  obecne; karta `openui` z nieistniejącą operacją pokazuje stan błędu, nie puste pole.
- Istniejące `e2e/view-filter.spec.ts`, `e2e/app.spec.ts`, `e2e/ui-navigation.spec.ts` zielone.
  Wolno zmienić wyłącznie selektory, nie asercje.

---

