# Raport — Task 7: BL-02 — odświeżanie po mutacji i interakcje widoków agenta

- Gałąź / worktree: `bl01-bl02/t7-interakcje` — `/home/paczos/Documents/agentic-app-template-wt/t7-interakcje` (baza `da7b868` = integracja z T1, T5, T2, T4)
- Data: 2026-09-17
- Kryterium: **L3.18**; realizacja **AD-9**
- Status: **DONE_WITH_CONCERNS** (bramka G10 zielona; obawy w sekcji 10)

| SHA | Temat |
|---|---|
| `9c567f4` | Akcje rekordu (AD-9): kontrakt w deskryptorze odczytu, kontrola startowa, `POST /api/actions` przez wykonanie narzędzia wspólne z MCP, przycisk i formularz w `DataTable`, stan odświeżania ramki; akcja zmiany ceny pozycji oferty |
| `9506722` | E2E interakcji widoków agenta (port 8798, `.e2e-scripted-interactions`) |
| `4b7b37f` | Formularz akcji rekordu ułożony pionowo, żeby otwarty nie poszerzał kolumny |
| `531bed0` | Akcja rekordu po zapisie odświeża to samo co `data_changed` narzędzia (wspólna funkcja) |
| `8790414` | Akcja odświeża odczyty i artefakty (bez canvasu, którego odświeżenie zabiera fokus w karcie); e2e: otwarty formularz przeżywa zmianę danych w wykonaniu |
| `5f3be99` | Komentarz o wspólnej ramce znów przy `return` w `DataTable` |

Suma `da7b868..HEAD`: 26 plików, +2145 / −55.

Rodzaje dowodów: **test kontraktu lub logiki** (Vitest: `tests/record-actions.test.ts`, `tests/data-components-describe.test.ts`), **symulacja** (Playwright ze skryptowanym modelem wywołującym prawdziwe handlery: `e2e/interactions.spec.ts`), **test GUI bez modelu** (`e2e/composed-views.spec.ts` — kolumna akcji na ekranie sprawy). Prawdziwego modelu nie użyto (G4/G5).

---

## 1. Co zostało zrobione (punkty „Musi” z briefu)

### 1.1 Kontrakt akcji rekordu (`packages/platform-contracts/src/views.ts`) — punkt 1

Dopisane **na końcu** obiektu deskryptora (zgodnie append-only): `ReadResultDescriptor.actions?: RecordAction[]` (do 10).

```ts
RecordAction = {
  id,                       // ^[a-z][a-z0-9_]*$
  label,                    // napis na przycisku
  tool,                     // NIEkwalifikowana nazwa narzędzia zapisu TEGO modułu
  input: [{ key, from }],   // key = klucz wejścia narzędzia, from = "$record.<pole>" | "$form.<klucz>"
  form?: [{ key, label, type: 'text'|'number'|'money_minor'|'quantity_milli' }],
}
```

- `input` jest **listą par**, nie obiektem — dzięki temu schemat nie potrzebuje `z.record()` i nadaje się do wystawienia modelowi (G9), gdyby kiedyś deskryptor trafił do narzędzia MCP.
- `superRefine` deskryptora (`checkRecordActionShapes`): powtórzony `id` akcji, powtórzony klucz wejścia lub pola formularza, `$record.<pole>` spoza `fields`/`idField`, `$form.<klucz>` spoza `form`, **pole formularza, którego żadne wejście nie używa** (użytkownik wypełniałby pole, które nigdzie nie trafia). Każda odmowa nazywa akcję i element.
- Nowe: `recordActionRequestSchema` (ciało `POST /api/actions`) i `RecordActionResponse`.
- `stableJson` przeniesione z `platform-ui/src/api/queries.ts` do kontraktów (klucz pamięci podręcznej w przeglądarce i porównanie powtórzonego żądania na serwerze to jedna funkcja); `queries.ts` re-eksportuje nazwę bez zmiany API.

### 1.2 Odczyt wartości formularza (`packages/platform-contracts/src/records.ts`)

`parseFieldInput(text, {label, type})` **obok `formatFieldValue`** — odwrotność wypisywania wartości tego samego rodzaju: znak, grupowanie spacjami (także NBSP, bo takie wstawia `toLocaleString('pl-PL')`), przecinek albo kropka dziesiętna. `money_minor` → całkowite grosze, `quantity_milli` → całkowite tysięczne, obie na arytmetyce całkowitej na cyfrach (nie `× 100` na liczbie zmiennoprzecinkowej), z **odmową** przy nadmiarze miejsc po przecinku zamiast cichego zaokrąglenia; `number` → liczba dziesiętna; `text` → tekst przycięty. Każda odmowa to `AppError('validation_failed')` z nazwą pola, którą widzi użytkownik.

### 1.3 Kontrola startowa (`packages/platform-server/src/registry/record-actions.ts`) — punkt 1

`checkRecordActions({moduleId, operation, descriptor, tools})` wołane w `ServerModuleRegistry.register` zaraz po `checkReadDescriptor`, czyli **zanim cokolwiek zostanie zapisane w rejestrze** (moduł odrzucony nie zostawia połowicznego stanu). Odmowy (zwykły `Error` z `Modul <id>, operacja odczytu <op>, akcja <id>: …`):

| Sytuacja | Komunikat |
|---|---|
| narzędzie spoza modułu (także z nazwą kwalifikowaną innego modułu) | `narzedzie X nie jest narzedziem modulu <id>. Akcja rekordu wskazuje narzedzie zapisu tego samego modulu: …` |
| narzędzie odczytu | `narzedzie X jest narzedziem odczytu (effect: read); akcja rekordu musi wskazywac narzedzie zapisu` |
| klucz wejścia spoza schematu narzędzia | `wejscie K nie istnieje w schemacie narzedzia X. Dostepne: …` |
| mapowanie `operationId` | `wejscia operationId nie mapuje sie — platforma przekazuje narzedziu operationId akcji` |
| brak wymaganego wejścia narzędzia | `narzedzie X wymaga wejscia K, ktorego akcja nie podaje` |
| typ pola formularza niezgodny z typem wejścia | `pole formularza F (text) nie pasuje do typu wejscia K narzedzia X (number)` |

Zgodność typów liczona z JSON Schema wejścia (`z.toJSONSchema(..., {io:'input'})`, rozwijane `anyOf/oneOf/allOf`; brak typu = „cokolwiek”): `text` → `string`, `number` → `number` (samo `integer` nie wystarczy, bo formularz dziesiętny nie przejdzie walidacji narzędzia), `money_minor`/`quantity_milli` → `integer` albo `number`.

### 1.4 `POST /api/actions` (`packages/platform-server/src/services/record-actions.ts`) — punkt 2

Ciało: `{ operation, input?, action, recordId, values?, operationId }` (`operationId` **wymagany**). Kolejność i powody:

1. `prepareRead(registry, {operation, input})` — dokładnie to rozwiązanie odczytu co `POST /api/read` (G9), więc nieznana operacja i złe wejście odmawiają tak samo (`unknown_operation`, `invalid_input`).
2. Akcja szukana w **deskryptorze tego odczytu** (`unknown_action` z listą dostępnych) — żądanie nie może zestawić odczytu z cudzą akcją.
3. `parseActionValues` — wartości formularza parsowane po stronie serwera wg zadeklarowanych typów; wartość spoza formularza, pusta i nieczytelna odrzucane z nazwą pola.
4. Pod `operationId` w `services.idempotency.once(operationId, ownerId, 'platform.recordAction', …)`:
   - **ponowny odczyt rekordu** przez ten sam odczyt z właścicielem z sesji (`runPreparedRead`); odmowa modułu (`forbidden`/`not_found`) przechodzi bez zmian, rekordu spoza odczytu nie ma (`not_found`, `reason: record_not_found`) — i nic się nie wykonuje;
   - wejście narzędzia budowane z **odczytanego rekordu** i sparsowanego formularza; gdy schemat narzędzia ma `operationId`, dostaje ten sam identyfikator (czyli własna bramka powtórzeń narzędzia też obejmuje to wywołanie);
   - `executeTool(...)` — funkcja wydzielona z `invokeTool` w `agent/mcp.ts`, czyli **ta sama walidacja i ten sam handler, którym woła model przez MCP**; kontekst: właściciel z sesji, `runId`/`conversationId`/`workspaceDir` = `null`, `emit` zbiera zdarzenia.
5. Odpowiedź `{ operation, action, recordId, result, changed, replayed }`; `changed` to zasoby z `data_changed` zgłoszone przez handler narzędzia (żadnego strumienia nie ma — klient sam unieważnia).
6. Powtórzone `operationId` zwraca pierwszy wynik (`replayed: true`); ten sam `operationId` dla **innego** żądania (inna akcja, rekord, wartości — porównanie po `stableJson`) to `conflict` z `reason: operation_id_reused`, a nie odpowiedź z poprzedniego żądania.

Trasa w `http/app.ts` (7 linii) jest za sesją jak reszta `/api/*` (bez sesji 401).

### 1.5 `DataTable`: przycisk, formularz i uczciwość ekranu (`platform-ui`) — punkt 3

- Nowy plik `views/RecordActions.tsx`: `useRecordActions(source, descriptor)` (stan: otwarta akcja + `operationId` na czas życia formularza, wynik ostatniej akcji, `pending`), `RecordActionsHeader`, `RecordActionCell`, `RecordActionStatus`. Zmiana w `DataTable.tsx` jest lokalna: jeden import, jeden hook, kolumna nagłówka, komórka w `renderRow`, status nad tabelą i w ramce błędu, `colSpan` nagłówka grupy, `action:<id>` w opisie semantycznym.
- Wiersz: przycisk na akcję (`data-record-action="<id>"`, nazwa dostępna `„<etykieta>: <tytuł rekordu>”`), po otwarciu formularz w komórce (`data-testid="record-action-form"`, etykiety `label for`, `inputMode="decimal"` dla pól liczbowych, `Zapisz` / `Anuluj`). Z klawiatury: fokus na przycisku → Enter otwiera formularz z fokusem w pierwszym polu → Enter zapisuje → fokus wraca na przycisk; Escape anuluje. Akcja bez pól formularza renderuje przycisk „Potwierdz: …”.
- Ten sam komponent renderuje ekran modułu, widok agenta i tabelę w czacie — akcje są własnością **odczytu**, nie ekranu.
- **Po zapisie**: `invalidateChangedData` (odczyty modułu, zarejestrowane odczyty, otwarte artefakty — to samo, co odświeża `data_changed` narzędzia, patrz 2.3), status „Zmien cene: zapisano. Dane sa ponownie wczytywane z backendu.”.
- **Po odmowie**: komunikat z kodem błędu w formularzu (`role="alert"`, `data-error-code`), a gdy formularza nie ma już na ekranie (tabela w stanie błędu/braku dostępu) — nad tabelą, żeby odmowa nie zniknęła razem z wierszami. Odmowy, które mogą znaczyć „dane na ekranie nie są już tym, co ma backend” (brak dostępu, brak rekordu, konflikt, awaria) dodatkowo unieważniają odczyty; `validation_failed` i `domain_rule_violated` nie (wtedy wiadomo, że nic się nie zmieniło).
- **Nieaktualne dane nie udają świeżych**: `useDataModel` zwraca `refreshing` (trwa ponowne pobranie już pokazanego wyniku), a `DataFrame` (wspólna dla tabeli, wykresu i podsumowania) ma `data-refreshing="true"`, `aria-busy` i widoczny znacznik „Odswiezanie danych…”; treść jest wtedy przygaszona CSS-em. Nieudane pobranie to (jak dotąd) stan `error`/`forbidden` — stare wartości nie wracają na ekran.

### 1.6 Moduł procurement — punkt 4

`caseOfferItemRecords` (odczyt `procurement.case_offer_items`) dostał `titleField: 'name'` (nazwa rekordu w nazwie dostępnej przycisku) i akcję:

```ts
actions: [{
  id: 'change_unit_price', label: 'Zmien cene', tool: 'update_offer_item',
  input: [{ key: 'itemId', from: '$record.id' }, { key: 'unitPrice', from: '$form.unitPrice' }],
  form: [{ key: 'unitPrice', label: 'Nowa cena jednostkowa', type: 'number' }],
}]
```

Akcja jest na deskryptorze, więc pojawia się i na ekranie sprawy (`procurement.case.detail`), i w **każdym** widoku agenta czytającym tę operację. Narzędzie to istniejące `procurement_update_offer_item` — bez nowego narzędzia, bez kopii serwisu.

### 1.7 Prompt

`describeReadOperationLine` dopisuje przy operacji z akcjami linię `kazda DataTable tej operacji daje uzytkownikowi akcje rekordu: Zmien cene (mcp__app__procurement_update_offer_item)` — model wie, że tabela, którą komponuje, daje użytkownikowi tę samą operację, którą sam wywołuje.

---

## 2. Decyzje tam, gdzie brief/ustalenia zostawiły wybór

### 2.1 Typ pola formularza opisuje **wejście narzędzia**, nie pole rekordu — dlatego cena jest `number`

Ustalenie koordynatora mówi: „Money input in the form is entered in major units and converted with the same rules as display”. Przyjęta semantyka: `money_minor` w formularzu = użytkownik wpisuje kwotę w jednostkach głównych (`1 234,56`), a narzędzie dostaje **całkowite grosze** (123456) — odwrotność wypisywania pola `money_minor`. Tymczasem istniejące narzędzie modułu bierze `unitPrice` w **jednostkach głównych** (`z.number()`, serwis robi `parseAmountToMinor`). Gdyby akcja deklarowała `money_minor`, narzędzie dostałoby 123456 i zapisało 123 456 PLN.

Wybrałem zgodność z kontraktem narzędzia zamiast dopisywania mu drugiego wejścia (`unitPriceMinor`), bo brief mówi „przez **istniejące** narzędzie”, a dodanie wejścia zmieniłoby schemat widziany przez model i dałoby dwa sposoby na jedną wartość. Akcja modułu używa więc `type: 'number'`: użytkownik pisze `9 999,50` (tak jak tabela to wypisuje), narzędzie dostaje `9999.5` — dokładnie to, co przekazałby model. Reguły zaokrąglania pozostają w serwisie, jedne dla obu dróg. `money_minor` i `quantity_milli` są w kontrakcie i mają testy (`parseFieldInput`), dla narzędzi biorących jednostki podrzędne; kontrola startowa pilnuje, żeby typ formularza pasował do typu wejścia. **Do decyzji koordynatora**, gdyby wolał zmianę wejścia narzędzia.

### 2.2 `values` to napisy, parsowane na serwerze

Przeglądarka wysyła to, co użytkownik napisał; serwer parsuje wg zadeklarowanego typu i on decyduje. Klient robi ten sam parse przed wysłaniem tylko po to, żeby nie wysyłać żądania, które i tak zostanie odrzucone tym samym komunikatem (jedna funkcja `parseFieldInput`, nie dwie reguły). `values` jako `z.record(string, string)` jest tylko w schemacie HTTP — modelowi nic z tego nie jest wystawiane (G9).

### 2.3 Akcja odświeża to samo co `data_changed`, **minus** `['canvas']`

Wspólna funkcja `invalidateChangedData(qc)` = `['module'] + ['read'] + ['artifact']`; obsługa `data_changed` wywołuje ją i dodatkowo unieważnia `['canvas']` (zachowane zachowanie z testem `agui-stream`: narzędzie zmieniające dane mogło zmienić też karty). Po akcji użytkownika `['canvas']` **nie** jest unieważniany: zmiana danych biznesowych nie zmienia żadnej karty, a odświeżenie canvasu przerysowuje kartę, w której użytkownik właśnie działa — co w pierwszym przebiegu zabrało fokus wracający na przycisk (sekcja 6, przebieg 2). Sondy pokazały, że karta **nie** jest przemontowywana (otwarty formularz i wpisana wartość przeżywają odświeżenie w trakcie wykonania — to jest teraz asercją w e2e (b)), więc chodzi o sam fokus.

### 2.4 Pozostałe

- **Idempotencja dwupoziomowa**: klucz akcji w zakresie `platform.recordAction` (platforma) i ten sam `operationId` przekazany narzędziu, jeśli deklaruje to wejście (moduł). Dzięki temu przerwanie między wykonaniem narzędzia a zapisem wyniku platformy nie powiela zmiany.
- `operationId` powstaje przy otwarciu formularza i żyje do jego zamknięcia: ponowne „Zapisz” po zerwanej odpowiedzi odtwarza pierwszy wynik, a nie zmienia danych drugi raz. Nowy formularz = nowy identyfikator.
- **Odcisk żądania** (`stableJson` z operacji, wejścia, akcji, rekordu i wartości) chroni przed cichym zwróceniem cudzego wyniku pod tym samym `operationId` (`conflict`).
- Każde pole formularza jest wymagane (pusta wartość to odmowa z nazwą pola); akcja bez `form` to potwierdzenie.
- Komórka akcji nie ma `data-field` ani `data-record-*` — selektory „komórka wartości” (`td[data-record-id][data-field]`, także w Task 6) nadal wskazują wyłącznie wartości.
- Nagłówek „Akcje” jest zwykłym `th scope="col"`; test ekranu sprawy w `composed-views.spec.ts` sprawdza go jawnie (nie pomija), patrz 3.
- Status „zapisano” zostaje do następnej akcji; anulowanie formularza czyści też komunikat odmowy.

---

## 3. Zmienione pliki

- **Kontrakty**: `platform-contracts/src/views.ts` (akcje rekordu, schemat żądania i odpowiedzi, `stableJson`), `src/records.ts` (`parseFieldInput`).
- **Serwer**: `registry/record-actions.ts` (nowy), `services/record-actions.ts` (nowy), `registry/modules.ts` (1 wywołanie kontroli), `agent/mcp.ts` (wydzielone `executeTool`), `http/app.ts` (`POST /api/actions`), `agent/prompt.ts` (linia akcji), `index.ts` (eksporty).
- **UI**: `views/RecordActions.tsx` (nowy), `views/DataTable.tsx`, `views/DataFrame.tsx`, `views/useDataModel.ts`, `views/DataChart.tsx`, `views/DataSummary.tsx` (przekazanie `refreshing`), `api/queries.ts` (`invalidateChangedData`, re-eksport `stableJson`), `chat/runEvents.ts` (użycie wspólnej funkcji), `styles.css`.
- **Moduł**: `module-procurement/src/server/views.ts` (deskryptor `caseOfferItemRecords`).
- **Testy**: `tests/record-actions.test.ts` (nowy, 13), `tests/data-components-describe.test.ts` (11 → 13), `tests/views-foundation.test.ts` (1 asercja: `record` deskryptora ma teraz `titleField`), `e2e/interactions.spec.ts` (nowy, 5), `e2e/support/interactions-scenario.ts` (nowy), `e2e/support/scripted-server.ts` (2 linie), `e2e/composed-views.spec.ts` (kolumna „Akcje” w teście ekranu sprawy — parametr `extraHeaders`).
- Nie edytowano dokumentów koordynatora (G8) ani zależności (G7 — bez zmian w `package.json`/lockfile).

---

## 4. Polecenia, kody wyjścia, liczby testów

| Polecenie (w worktree) | Wynik |
|---|---|
| `pnpm exec vitest run tests/record-actions.test.ts` | exit 0, **13/13** |
| `pnpm exec vitest run tests/data-components-describe.test.ts` | exit 0, 13/13 (było 11) |
| `pnpm typecheck` | exit 0 |
| `pnpm verify` (na `5f3be99`, stan końcowy) | **exit 0** — boundaries OK, acceptance/matrix/closure OK, typecheck, build, **Vitest 29 plików / 431 testów** (baza `da7b868`: 28 / 416 wg raportu T4 — +1 plik, +15 testów) |
| `pnpm build` + `flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/interactions.spec.ts` | **exit 0, 5 passed** |
| `flock … pnpm exec playwright test` 17 speców bez modelu (`interactions, composed-views, agent-views, app, view-state, view-filter, access-context, session-restore, ui-navigation, scripted-call, measurements, chat, tool-activity, background-tasks, streaming, chat-drawer, chat-layout`) | **exit 0, 95 passed** (interactions 5, composed-views 7, agent-views 7, app 14, view-state 8, view-filter 7, access-context 3, session-restore 6, ui-navigation 5, scripted-call 1, measurements 2, chat 7, tool-activity 5, background-tasks 5, streaming 3, chat-drawer 6, chat-layout 4) |
| `flock … pnpm exec playwright test` (po `5f3be99`: interactions, composed-views, agent-views, view-state, app) | **exit 0, 41 passed** |
| `flock … pnpm check:module-swap` | **exit 0** (kopia z modułem kontrolnym: build, start, rejestr, trasy, przeglądarka) |

Nie uruchamiano `agent-ui.spec.ts` ani `files-agent.spec.ts` (prawdziwy model — Task 8). Po przebiegach usunięto nieśledzone `docs/evidence/chat-ux-2026-09-16/`, `docs/evidence/closure-2026-09-15/` i `test-results/`; drzewo czyste.

### 4.1 Co pokrywają nowe testy

**`tests/record-actions.test.ts`** (test kontraktu lub logiki; prawdziwa platforma i moduł na bazie tymczasowej, żądania przez `app.request`):

1. *zmienia cenę przez handler narzędzia MCP modułu* — `9 999,50` → `unitPriceMinor` 999950 w `POST /api/read`, `version` pozycji +1; handler wywołany **raz**, z wejściem `{itemId (z ponownie odczytanego rekordu), unitPrice: 9999.5, operationId}` i kontekstem `ownerId` z sesji, `runId`/`conversationId` = `null`; `def` i `handler` są **tym samym obiektem**, który `collectToolEntries` wystawia pod `procurement_update_offer_item` (czyli MCP); `changed` = `['case:<id>','offer:<id>']` — zasoby zgłasza wyłącznie handler narzędzia (trasa `PATCH /items/:id` ich nie emituje); wpisy idempotencji w obu zakresach.
2. *powtórzony `operationId`* — drugie żądanie (klucze w innej kolejności) `replayed: true`, ten sam wynik i `changed`, handler nadal raz, wersja +1 raz; ten sam `operationId` z inną wartością → **409** `operation_id_reused`, dane bez zmian.
3. *walidacja* — 10 przypadków (brak `operationId`, nieznana akcja, odczyt bez akcji, nieznana operacja, złe wejście odczytu, wartość nie‑liczba, pusta, brakująca, pole spoza formularza, rekord spoza odczytu = 404 `record_not_found`), odmowa nazywa pole (`Nowa cena jednostkowa`) i podaje `available`; ujemna cena → **422 `domain_rule_violated`** (reguła serwisu, ta sama co przez MCP); bez sesji 401; migawka odczytu przed i po jest identyczna.
4. *rekord innego właściciela* — druga tożsamość na sprawę i pozycję pierwszej: **403 `forbidden`** z modułu przy ponownym odczycie, **handler nie został wywołany**, odpowiedź nie zawiera nazwy pozycji, dane bez zmian; `operationId` odrzuconego żądania nie blokuje właściciela (jego żądanie z tym samym identyfikatorem wykonuje się normalnie).
5. *kontrola startowa* — moduł przykładowy i poprawna akcja przechodzą; odrzucone: narzędzie odczytu, narzędzie innego modułu (także z prefiksem), klucz spoza schematu, brak wymaganego wejścia, mapowany `operationId`, niezgodny typ pola formularza (`text`→`number`, `number`→`integer`), a po stronie deskryptora `$record.<nieznane>`, `$form.<nieznane>`, nieużywane pole formularza, powtórzony `id`, powtórzone wejście, zły format `from`; po każdej odmowie rejestr nie ma operacji modułu.
6. *prompt* — dokładna linia z akcją i nazwą narzędzia MCP.
7. *wartości formularza* — round‑trip `formatFieldValue` → `parseFieldInput` dla kwot (0, 29 gr, 1999, 999950, ujemne, 1234567890), ilości i liczb; kropka, spacje, NBSP; odmowa przy 3 miejscach po przecinku w kwocie i 4 w ilości (zamiast zaokrąglenia), przy tekście, podwójnym przecinku, `1 23`, `12.`, pustej wartości.

**`tests/data-components-describe.test.ts`** (+2): tabela nad odczytem z akcjami rysuje kolumnę „Akcje” i przycisk w każdym wierszu z nazwą dostępną `„Zmien sume: n0”`, opis semantyczny zawiera `action:set_total`, komórki wartości mają dalej `data-field` (a komórka akcji nie), nagłówek grupy obejmuje kolumnę akcji (`colSpan=3`), nic nie twierdzi, że dane są odświeżane; tabela nad odczytem bez akcji nie ma ani kolumny, ani `action:*`.

**`e2e/interactions.spec.ts`** (symulacja; port 8798, `.e2e-scripted-interactions`, instancja zatrzymywana w `afterAll`; scenariusz `interactions` woła prawdziwe `agent_view_create` i `procurement_update_offer_item`; wartości porównywane z `POST /api/read` przez `page.request`, nigdy z tekstem scenariusza; w żadnym teście nie ma przeładowania — znacznik `window.__sameDocument` sprawdzany na końcu):

1. **(a)** Polecenie `[widok]` z kompozytora → `agent_view_create` tej tury → strona „Widoki agenta” otwarta linkiem w nawigacji: karta z **tabelą i wykresem** nad `procurement.case_offer_items` (3 projektory w PLN) — wiersze, kolejność, każda komórka i podpis wykresu (`data-unit=PLN`, `data-min/max`, „od … do …”, liczba kategorii) = backend; każdy wiersz ma przycisk akcji. Potem, **z klawiatury**, zmiana ceny na ekranie sprawy (nawigacja → lista spraw → sprawa): nazwa dostępna przycisku, fokus w polu, Enter zapisuje, status „zapisano”, fokus wraca na przycisk. Żądanie `POST /api/actions` niesie tę samą operację, wejście i akcję co deskryptor; backend 999950 i `version` +1; komórka na ekranie sprawy zmienia się **w miejscu**, liczba wierszy bez zmian. Powrót linkiem do widoków agenta: tabela i wykres pokazują nową wartość, a obserwator DOM (założony przed powrotem) potwierdza, że stara wartość **nigdy** się w nich nie pojawiła.
2. **(b)** Na otwartej stronie widoków agenta użytkownik ma otwarty formularz z wpisaną wartością; polecenie `[mcp]` → `procurement_update_offer_item` w wykonaniu → nowa cena jest w tabeli i w podpisie wykresu **gdy pasek wykonania nadal pokazuje `running`** (scenariusz trzyma wykonanie 9 s po zmianie, więc to nie jest odświeżenie po `RUN_FINISHED`); otwarty formularz i wpisana wartość przeżywają odświeżenie; wynik narzędzia w historii tury = 1425000 i `version` +1; po zakończeniu ekran sprawy (otwarty z nawigacji) pokazuje tę samą wartość.
3. **(c)** Akcja **w widoku agenta**, z klawiatury: to samo żądanie (`operation`, `input`, `action`), `changed` z `case:<id>`, backend 875025 i `version` +1, tabela i podpis wykresu **tej samej karty** odświeżone w miejscu, ekran sprawy pokazuje nową wartość.
4. **Kontrola negatywna — cudza sesja**: formularz otwarty w karcie, w drugiej karcie przeglądarki użytkownik przełącza tożsamość (`/settings`), po czym pierwsza karta wysyła formularz → **403**, komunikat odmowy z `data-error-code="forbidden"` widoczny, tabela i wykres przechodzą w stan `forbidden` (żadnej komórki z wpisaną wartością), a po powrocie do pierwszej tożsamości backend ma cenę i wersję sprzed próby, i widok znów je pokazuje.
5. **Kontrola negatywna — nieudane odświeżenie**: `page.route` zatrzymuje i zwraca 500 na każdy `POST /api/read`; akcja zapisuje się (`zapisano`), tabela i wykres najpierw mówią `data-refreshing="true"` i „Odswiezanie danych…”, a po nieudanych próbach pokazują **błąd** (`data-state="error"`, treść „Awaria odczytu (test)”), bez ani jednej komórki i bez podpisu wykresu, i nie zawierają wartości sprzed zmiany; zmiana w backendzie jest zapisana (700000); po przywróceniu odczytów widok pokazuje wartość z backendu.

---

## 5. Kontrole negatywne i próby zdolności wykrycia

Procedura z `dispatch-common.md`: **najpierw commit**, potem próba na czystym drzewie (skrypt przerywa, jeśli `git status --short` nie jest pusty), wycofanie linii, test, `git checkout -- <plik>`, ponowne sprawdzenie, że drzewo jest czyste (skrypt wypisuje wynik). Próby e2e po `pnpm --filter @app/web build`; po serii przebudowano całość (`pnpm verify`) i przebiegi z sekcji 4 są na tym buildzie.

| # | Wycofana linia / zmiana | Polecenie | Wynik z wycofaniem |
|---|---|---|---|
| V1 | `services/record-actions.ts`: bez ponownego odczytu rekordu (rekord = `{id}` z żądania) | `vitest run tests/record-actions.test.ts` | **2 failed / 11**: „rekord spoza odczytu” (`expected undefined to be 'record_not_found'`), „rekord innego wlasciciela” (`expected […] to have a length of +0 but got 1` — handler wywołany) |
| V2 | bez `idempotency.once` (funkcja wykonywana zawsze) | j.w. | **2 failed / 11**: brak wpisu idempotencji (`expected undefined to be truthy`), `replayed` (`expected false to be true`) |
| V3 | `registry/record-actions.ts`: kontrola `effect !== 'write'` wyłączona | j.w. | **1 failed / 12**: „akcja wskazujaca narzedzie odczytu…” (`modul powinien zostac odrzucony`) |
| V4 | `operationId` nieprzekazywany narzędziu | j.w. | **1 failed / 12**: wejście handlera `expected { …(2) } to deeply equal { …(3) }` |
| V5 | bez porównania odcisku żądania przy powtórce | j.w. | **1 failed / 12**: `expected 200 to be 409` (cudze żądanie dostało pierwszy wynik) |
| V6 | `records.ts`: brak odmowy przy nadmiarze miejsc po przecinku | j.w. | **1 failed / 12**: `money_minor "12,345": expected [Function] to throw an error` |
| V7 | `views.ts`: kontrola `$record.<pole>` wyłączona | j.w. | **1 failed / 12**: deskryptor z `$record.cena` przyjęty (`expected true to be false`) |
| V8 | `registry/record-actions.ts`: nieznane narzędzie zastąpione atrapą (symulacja „obce narzędzie przyjęte”) | j.w. | **1 failed / 12**: „akcja wskazujaca narzedzie innego modulu…” |
| V9 | `DataTable.tsx`: bez `action:<id>` w opisie semantycznym | `vitest run tests/data-components-describe.test.ts` | **1 failed / 12**: `expected [] to include 'action:set_total'` |
| E1 | `RecordActions.tsx`: po zapisie bez `invalidateChangedData` | build + `playwright test e2e/interactions.spec.ts` | **1 failed / 4 did not run**: (a) ekran sprawy pokazuje `12 400,00 PLN` zamiast `9999,50 PLN` |
| E1b | jak E1 **plus** usunięta asercja „w miejscu” w teście — czy sama część o widoku agenta wykrywa? | j.w. | **1 failed / 4 did not run**: komórka w widoku agenta `Expected "9999,50 PLN", Received "12 400,00 PLN"` (linia 309) |
| E2 | `runEvents.ts`: `data_changed` bez `invalidateChangedData` | j.w. | **1 failed / 1 passed / 3 did not run**: (b) `Expected "14 250,00 PLN", Received "13 100,00 PLN"` w trakcie wykonania |
| E3 | `useDataModel.ts`: `if (read.error && !read.data)` (stare dane zamiast błędu) | j.w. | **1 failed / 3 passed**: kontrola cudzej sesji — tabela zostaje `ready` zamiast `forbidden` |
| E3b | jak E3, ale tylko dla błędów niedostępowych | j.w. | **1 failed / 4 passed**: kontrola nieudanego odświeżenia — `Expected "error", Received "ready"` |
| E4 | `useDataModel.ts`: `refreshing: false` zawsze | j.w. | **1 failed / 4 passed**: `data-refreshing` `Expected "true", Received ""` |
| E5 | `RecordActions.tsx`: po odmowie bez ponownego odczytu | j.w. | **1 failed / 1 did not run / 3 passed**: tabela zostaje `ready` z cudzymi wierszami zamiast `forbidden` |

Kontrole negatywne wewnątrz testów: sekcja 4.1 (10 wariantów odmowy `POST /api/actions`, cudza tożsamość, odmowy startowe, nieudane odświeżenie, brak sesji, ujemna cena jako reguła serwisu).

---

## 6. Nieudane przebiegi (poza celowymi próbami)

1. **Pierwszy przebieg `e2e/interactions.spec.ts`**: 1 failed — `Expected: "9 999,50 PLN", Received: "9999,50 PLN"`. **Wada testu**: polskie grupowanie zaczyna się od pięciu cyfr (`minimumGroupingDigits`), więc literał w teście był zły, a nie formatowanie. Literał poprawiony (zostaje w teście, żeby formatter nie zgadzał się tylko sam ze sobą); dalsze przebiegi 5/5.
2. **Po scaleniu unieważniania z `data_changed`** (commit `531bed0`, wersja odświeżająca też `['canvas']`): 1 failed — test (c), `toBeFocused` na przycisku po zapisie (`inactive` przez 15 s). Sondy (obie na pełnym specu, potem wycofane): identyfikator instancji tabeli po `data_changed` bez zmian, a otwarty formularz i wpisana wartość przeżywają odświeżenie canvasu — czyli karta **nie** jest przemontowywana, ale przerysowanie węzła React Flow zabiera fokus. **Błąd mojej implementacji** (niepotrzebne unieważnianie): po akcji `['canvas']` nie jest już unieważniany (2.3), a przeżycie formularza w trakcie wykonania jest teraz asercją w (b). Commit `531bed0` został poprawiony przez `8790414`, więc jego opis („wspólna funkcja invalidateAfterDataChange”) opisuje stan przejściowy — w HEAD funkcja nazywa się `invalidateChangedData`.
3. **Moja pomyłka proceduralna**: próbę sondy uruchomiłem raz z `-g "(b)"` — testy są seryjne i dzielą identyfikatory z testu (a), więc pojedynczy test oblał z powodu pustego `conversationId`, a nie badanej zmiany. Przebieg powtórzony na pełnym specu. Przy tej okazji `git checkout -- e2e/interactions.spec.ts` (przywracanie po sondzie) skasował niezacommitowaną asercję w specu — dlatego opis commita `531bed0` wspomina o asercji, której w nim nie ma; asercja została odtworzona w innej, mocniejszej formie w `8790414`.

Innych nieudanych przebiegów na tym kodzie nie było.

---

## 7. Kontrakt dla autora modułu

**Akcja rekordu** (`ModuleReadOperation.result.actions[]`, do 10 na odczyt):

- `{ id, label, tool, input, form? }`: `id` małymi literami (`^[a-z][a-z0-9_]*$`), `label` to napis na przycisku, `tool` to **nieskwalifikowana** nazwa narzędzia **tego samego modułu** o `effect: 'write'`.
- `input: [{ key, from }]` — `key` jest kluczem wejścia narzędzia, `from` to `"$record.<pole>"` (pole deskryptora albo `idField`, wartość z **ponownego odczytu na serwerze**, nie z przeglądarki) albo `"$form.<klucz>"`.
- `form?: [{ key, label, type }]`, `type` ∈ `text | number | money_minor | quantity_milli`. **Typ opisuje wejście narzędzia**: `money_minor` i `quantity_milli` oddają liczby całkowite (grosze, tysięczne) z wartości wpisanej w jednostkach głównych, `number` — liczbę dziesiętną, `text` — tekst. Każde pole jest wymagane; akcja bez `form` to samo potwierdzenie.
- `operationId` narzędzia jest podawany przez platformę — nie mapuj go.
- **Odmowy przy starcie** (moduł się nie rejestruje, komunikat nazywa moduł, odczyt, akcję i element): narzędzie spoza modułu albo odczytu; klucz wejścia spoza schematu narzędzia; niepodane wejście wymagane przez narzędzie; typ pola formularza niezgodny z typem wejścia; `$record.<pole>` spoza deskryptora; `$form.<klucz>` spoza formularza; pole formularza, którego żadne wejście nie używa; powtórzony `id`, klucz wejścia albo pole formularza.
- **Odmowy w działaniu** (`POST /api/actions`): `validation_failed` (`invalid_request`, `unknown_operation`, `invalid_input`, `unknown_action`, `invalid_value` — z nazwą pola), `not_found` (`record_not_found`), `forbidden`/`not_found` z serwisu modułu przy ponownym odczycie, `conflict` (`operation_id_reused`), oraz wszystko, co zgłosi narzędzie (np. `domain_rule_violated`, `conflict` wersji) — z tym samym kodem i komunikatem co przez MCP.
- **Efekt uboczny**: akcja pojawia się **w każdej** tabeli nad tym odczytem — ekran modułu, widok agenta, tabela w czacie. Nie deklaruj akcji na odczycie, którego nie chcesz mieć interaktywnego wszędzie.
- **Zgłaszanie zmian**: to, co handler narzędzia wyemituje jako `data_changed`, wraca w odpowiedzi jako `changed` i jest jedynym sposobem, w jaki klient dowiaduje się, co się zmieniło (żadnego strumienia tu nie ma).
- Tytuł rekordu (`record.titleField`) trafia do nazwy dostępnej przycisku („Zmien cene: Projektor 4K K24-LX”) — warto go zadeklarować dla odczytu z akcjami.

**Dla autora komponentu danych platformy**: `DataFrame` przyjmuje `refreshing` — komponent, który pokazuje wynik i jednocześnie pobiera go ponownie, ma to zgłaszać (`data-refreshing`, `aria-busy`, widoczny znacznik), a nieudane pobranie zostaje stanem błędu, nie powrotem do poprzednich wartości.

---

## 8. Self-review — ustalenia

- Znalezione i poprawione w trakcie: unieważnianie `['canvas']` po akcji zabierało fokus w karcie (sekcja 6.2); pierwsza wersja `RecordActionCell` przywracała fokus także wtedy, gdy formularz otwarto w **innym** wierszu (efekt sprawdza teraz, że żaden formularz nie jest otwarty); formularz w komórce był początkowo poziomy i poszerzał kolumnę (commit `4b7b37f`).
- G9: jedno rozwiązywanie odczytu (`prepareRead`), jedno wykonanie narzędzia (`executeTool` używane przez MCP, krok `call` i akcję), jedno formatowanie i **jeden** parser obok niego (`formatFieldValue` / `parseFieldInput`, ten sam w przeglądarce i na serwerze), jedno `stableJson`, jedno unieważnianie po zmianie danych (`invalidateChangedData`).
- Granica platforma–domena: `pnpm check:boundaries` OK; platforma nie wie, co to cena — akcja, jej etykieta, narzędzie i typ pola pochodzą z modułu.
- Minimalne zmiany we wspólnych plikach: `DataTable.tsx` 6 wstawek, `runEvents.ts` 4 linie, `http/app.ts` 1 trasa, `prompt.ts` 1 linia w istniejącej funkcji, `scripted-server.ts` 2 linie (T3 dopisuje tam swoje).
- Instancja użytkownika (8791), główny checkout i worktree innych zadań nietknięte; wszystkie przebiegi przeglądarkowe pod blokadą, scenariuszowa instancja na porcie 8798 z własnym katalogiem `.e2e-scripted-interactions`, zatrzymywana w `afterAll`.

---

## 9. Spełnienie briefu

| Wymaganie briefu | Gdzie |
|---|---|
| 1. Kontrakt akcji w deskryptorze, narzędzie zapisu tego modułu sprawdzane przy starcie | 1.1, 1.3; V3, V8 |
| 2. `POST /api/actions`: właściciel z sesji, ponowny odczyt, budowa wejścia, handler przez rejestr (ten sam co MCP), idempotencja, zmienione zasoby; klient unieważnia `['read']`/`['module']` | 1.4, 1.5; V1, V2, V4, E1 |
| 3. `DataTable` renderuje akcje tak samo w widoku domyślnym i agenta, z klawiatury; błąd pokazany, nieaktualne dane nie udają świeżych | 1.5; e2e (a)/(c), kontrole negatywne 4 i 5; E3, E3b, E4, E5 |
| 4. Procurement: zmiana ceny jednostkowej na `case_offer_items` istniejącym narzędziem | 1.6; e2e (a)/(c) |
| Vitest: sukces, idempotencja, walidacja, cudzy rekord, odmowy startowe | 4.1 (1–5) |
| E2E (a), (b), (c) + negatywne | 4.1 e2e 1–5 |
| Ustalenie: zapis przez MCP odświeża otwarte widoki agenta bez przeładowania | e2e (b) — działało bez poprawki; próba E2 pokazuje, że test to wykrywa |
| Ustalenie: `action:<id>` w opisie semantycznym | 1.5; V9 |

---

## 10. Obawy (concerns)

1. **Cena w formularzu jest `number`, nie `money_minor`** (2.1) — bo istniejące narzędzie modułu bierze jednostki główne. Skutek: użytkownik może wpisać `12,345`, a serwis zaokrągli tak samo jak przy wywołaniu przez model. Gdyby koordynator wolał ścisłe dwa miejsca, trzeba dopisać narzędziu wejście w groszach i zmienić typ pola na `money_minor` (parser i kontrola startowa są gotowe).
2. **`data_changed` w trakcie wykonania nadal unieważnia `['canvas']`** (zachowanie sprzed mojej zmiany, chronione testem `agui-stream`). Przerysowanie karty nie gubi otwartego formularza (asercja w e2e (b)), ale zabiera fokus — użytkownik piszący w formularzu w widoku agenta w chwili, gdy agent zmienia dane, straci fokus (nie treść). Usunięcie `['canvas']` z tej ścieżki wymagałoby zmiany cudzego testu — do decyzji koordynatora.
3. **Znacznik „Odswiezanie danych…”** pojawia się przy każdym ponownym pobraniu, więc też po każdym zakończeniu wykonania (`RUN_FINISHED` unieważnia wszystko). To uczciwe, ale widoczne; jeśli okaże się zbyt nerwowe, można je opóźnić o ~300 ms.
4. **Odmowa `forbidden` po zmianie tożsamości w innej karcie**: tabela przechodzi w stan braku dostępu, a komunikat akcji zostaje nad nią — ale ekran szczegółów sprawy (Task 5 robi własny odczyt-bramkę) zniknie w całości razem z komunikatem. W e2e kontrolę negatywną prowadzę dlatego w widoku agenta, gdzie komunikat jest trwale widoczny.
5. **`z.toJSONSchema` w kontroli typów** (1.3) opiera się na tym, jak zod 4 opisuje wejście; egzotyczny schemat (transformacje, `z.custom`) da „cokolwiek” i kontrola przepuści niezgodność, którą wychwyci dopiero walidacja narzędzia w runtime (odmowa z komunikatem, bez zmiany danych).
6. **Akcja jest widoczna wszędzie, gdzie tabela czyta ten odczyt** — łącznie z tabelą wyrenderowaną w odpowiedzi czatu. To wynika z decyzji, że akcje należą do odczytu (AD-9), ale warto o tym pamiętać przy deklarowaniu akcji dla odczytu używanego w wielu miejscach.
7. **Idempotencja `IdempotencyStore.once` nie jest atomowa** (istniejące zachowanie): dwa równoległe żądania z tym samym `operationId` mogą oba wejść w wykonanie. Dla akcji z GUI (przycisk blokowany na czas zapisu) to teoria, ale ta sama luka dotyczy narzędzi MCP.
8. **Task 3 nie jest scalony** — przy scaleniu spodziewane konflikty w `chat/runEvents.ts` (jedna linia), `api/queries.ts`, `DataTable.tsx` (opis instancji — T3 czyta `actions`), `e2e/support/scripted-server.ts` i liście narzędzi/promptu. Nowe `action:<id>` w `SemanticInstance.actions` trafi do snapshotu T3 bez zmian w schemacie (limit 20 pozycji ×80 znaków wystarcza).

---

## Runda scalenia (z `bl01-bl02/integracja` = `02a27d3`: Task 3)

Commity: `5e55b10` — `Merge branch 'bl01-bl02/integracja' into bl01-bl02/t7-interakcje` (rodzice `5f3be99` + `02a27d3`; bez rebase i przepisywania historii); `42ae3da` — poprawki rundy (M1, M3, M4 + dowody snapshotu).

### Konflikty i rozstrzygnięcia

| Plik | Konflikt | Rozstrzygnięcie |
|---|---|---|
| `e2e/support/scripted-server.ts` | mój import scenariusza `interactions` vs import `type CallRecord` z T3 | obie linie; `CONVERSATION_SCENARIOS` ma `agent-views` (T4) i `interactions` (T7) |

Automatycznie scalone i **sprawdzone ręcznie**:

- `packages/platform-contracts/src/views.ts` — moje `actions` w deskryptorze i `RecordAction*` obok dopisanego przez T3 `groupBy` w `semanticInstanceSchema`; oba w jednym schemacie, `readResultDescriptorSchema` bez zmian po stronie T3.
- `packages/platform-ui/src/views/model.ts` — T3 opisuje rekordy w kolejności ekranu (grupowanie); mój `action:<id>` wchodzi do `actions` opisu bez kolizji.
- `packages/platform-ui/src/views/DataTable.tsx`, `chat/runEvents.ts`, `api/queries.ts` — **T3 ich nie zmieniał** (`git diff da7b868..02a27d3` na tych plikach jest pusty), więc nie było czego uzgadniać; sprawdziłem, że po scaleniu `useDescribeInstance` ma tę samą sygnaturę (T3 czyta epokę dostępu wewnątrz hooka), więc moje wywołanie w `DataTable` jest poprawne.
- `packages/platform-server/src/http/app.ts`, `agent/prompt.ts`, `tests/views-foundation.test.ts` — dopisy T3 (trasy snapshotu, sekcja „Stan ekranu”) obok moich (trasa `/api/actions`, linia akcji przy operacji odczytu).

**Niepowodzenie po scaleniu (poza próbami):** `pnpm typecheck` — `tests/record-actions.test.ts` budował `AppContext` literałem, a T3 dodał do niego wymagane pole `ui`. **Wada mojego testu**; zastąpione `EMPTY_APP_CONTEXT` z kontraktów (w commicie scalenia). Vitest przechodził wcześniej, bo testy nie są typecheckowane w przebiegu.

### Uzgodnienie unieważniania (jeden zestaw reguł)

T3 nie dotykał ścieżki unieważniania, więc obowiązuje wyłącznie mój podział z rundy podstawowej i jest jedyną definicją:

- `invalidateBusinessData(qc)` = `['module']` + `['read']` — wszystko, co czyta dane biznesowe;
- `invalidateChangedData(qc)` = `invalidateBusinessData` + `['artifact']` — „dane się zmieniły” (artefakt live liczy się na nowo przy pokazaniu);
- `data_changed` z wykonania = `invalidateChangedData` + `['canvas']` (narzędzie mogło zmienić karty, nie mówiąc o tym — zachowane zachowanie chronione testem `agui-stream`);
- akcja rekordu po zapisie = `invalidateChangedData` (bez `['canvas']`, bo żadna karta się nie zmieniła, a przerysowanie karty zabiera użytkownikowi fokus — uzasadnienie w 2.3);
- akcja rekordu po odmowie, która może znaczyć „ekran już nie jest tym, co ma backend” = `invalidateBusinessData`.

Nowej logiki unieważniania w tej rundzie nie przybyło; `RUN_FINISHED` zostaje siatką bezpieczeństwa jak dotąd.

### Opis semantyczny i snapshot po akcji (ustalenie koordynatora)

`SemanticInstance` z założenia **nie niesie wartości biznesowych** (agent czyta je przez `POST /api/read`), więc sama zmiana ceny nie zmienia opisu i nie daje nowej wersji snapshotu — to poprawne, ale nie do udowodnienia „na wartościach”. Żeby zmiana po akcji była widoczna w tym, co opisuje snapshot, tabela widoku agenta w scenariuszu jest teraz **porządkowana ceną malejąco** (`DataTable(..., filter, {field: "unitPriceMinor", direction: "desc"})`). Dzięki temu:

- e2e (c): przed akcją zapisuję opublikowany snapshot tej karty; po akcji `visibleRecordIds` instancji tabeli = nowa kolejność rekordów z backendu, `version` snapshotu **większa** niż przed akcją, `state: 'ready'`, `matched` = 3, `actions` zawiera `action:change_unit_price`, a kolejność wierszy na ekranie jest ta sama co w opisie. Czyli `ui_state` nie poda ekranu sprzed akcji jako bieżącego.
- e2e (b): z **otwartym formularzem** i wpisaną wartością opis instancji jest bajt w bajt taki sam jak przed otwarciem (stan, strona, rekordy, akcje) — formularz nie jest częścią opisu i niczego w nim nie psuje.
- Kolejność w `expectViewMatchesBackend` liczona jest teraz z backendu tym samym porządkiem (`byPriceDesc`), więc każdy wiersz, komórka i podpis wykresu dalej porównują się z `POST /api/read`.

### Poprawki M1, M3, M4

**M1 — jedno wykonanie narzędzia.** `executeTool` przeniesione z `agent/mcp.ts` do nowego `registry/tool-execution.ts` (rejestr nie musi zależeć od połówki agentowej). `invokeTool` tylko opakowuje jego wynik w rezultat MCP, `ServerModuleRegistry.callTool` deleguje do niego (własna kopia walidacji usunięta), `services/record-actions.ts` i krok `call` skryptowanego agenta idą tą samą drogą. Komentarze testów poprawione tak, żeby były prawdziwe: `tests/contracts.test.ts` ma nad sekcją „same rules through HTTP and through MCP” zdanie, czym jest `callTool` (to samo wykonanie co MCP, MCP dokłada tylko zamianę błędu na wynik narzędzia), a pomocnik `callTool` w `tests/view-state.test.ts` **nie woła już `tool.handler` wprost** — woła `executeTool`, czyli naprawdę to, co robi wykonanie.

**M3 — komunikat nie obiecuje trwającego odczytu.** Status akcji to teraz `„Zmien cene: zapisano.”`, a zdanie „Dane sa ponownie wczytywane z backendu.” dokłada `RecordActionStatus` **tylko gdy ramka faktycznie odświeża** (`refreshing` z `useDataModel`, ten sam, który ustawia `data-refreshing`). Sprawdzane w e2e w obu ścieżkach: po udanym odświeżeniu tekst jest dokładnie `Zmien cene: zapisano.` (i ramka nie ma `data-refreshing`), a w teście nieudanego odświeżenia zdanie jest widoczne w trakcie ponownego odczytu i znika, gdy odczyt się kończy (błędem).

**M4 — poprawiona wartość dostaje własny `operationId`.** `useRecordActions` pamięta, jakie wartości wysłano pod bieżącym identyfikatorem (`stableJson`); powtórzenie **tych samych** wartości leci pod tym samym identyfikatorem (bramka powtórzeń działa po zgubionej odpowiedzi), a wysłanie **innych** wartości to inna zmiana i dostaje nowy identyfikator. Dzięki temu użytkownik nie dostaje konfliktu z własną wcześniejszą próbą. Odmowa serwera na faktycznie ponownie użyty identyfikator jest przeformułowana: `…zostal juz uzyty dla innej akcji lub innych wartosci — tamta zmiana zostala wykonana. Tym zadaniem nie zmieniono nic; odczytaj rekord ponownie i powtorz zmiane z nowym operationId.`

### Testy dopisane w tej rundzie

- `tests/record-actions.test.ts` (13, bez zmiany liczby): odmowa przy ponownie użytym `operationId` musi mówić, że tamta zmiana **została wykonana** i że trzeba użyć nowego identyfikatora.
- `e2e/interactions.spec.ts` (5 → **6**): nowy test „zgubiona odpowiedz, a potem poprawiona wartosc” — `page.route` wykonuje żądanie na serwerze i **gubi odpowiedź** (`route.fetch()` + `route.abort()`); przeglądarka pokazuje błąd w formularzu, po ponownym odczycie tabela pokazuje wartość, która mimo wszystko weszła (500000), użytkownik poprawia wartość i zapisuje — drugie żądanie ma **inny** `operationId`, kończy się `200`, backend ma 510000, a widok (tabela i wykres) zgadza się z backendem. Do tego asercje snapshotu w (c) i niezmienionego opisu przy otwartym formularzu w (b), oraz asercje M3 w (a) i w teście nieudanego odświeżenia.

### Próby zdolności wykrycia (na zacommitowanym `42ae3da`, czyste drzewo przed każdą, `git checkout` po)

| # | Wycofanie | Polecenie | Wynik |
|---|---|---|---|
| M1 | `registry/tool-execution.ts`: walidacja wejścia pominięta | `vitest run tests/contracts.test.ts tests/record-actions.test.ts tests/view-state.test.ts` | **1 failed / 73**: „odrzuca wejscie narzedzia niezgodne ze schematem” — `expected AppError: Sprawa 123 nie istnieje. to match object { code: 'validation_failed' }` (czyli te testy naprawdę idą przez wspólne wykonanie) |
| M3 | zdanie o ponownym wczytywaniu pokazywane zawsze | build + `playwright test e2e/interactions.spec.ts` | **1 failed / 5 did not run**: `Expected "Zmien cene: zapisano.", Received "Zmien cene: zapisano. Dane sa ponownie wczytywane z backendu."` |
| M4 | bez nowego `operationId` przy zmienionej wartości | j.w. | **1 failed / 5 passed**: test zgubionej odpowiedzi — brak „Zmien cene: zapisano.” (druga próba odrzucona jako powtórzenie) |
| S1 | `UiSnapshotPublisher`: brak subskrypcji `useUiSemantics` | j.w. | **1 failed / 2 passed / 3 did not run**: (c) `visibleRecordIds` w snapshocie w kolejności sprzed akcji |

### Bramka G10 na scalonej gałęzi (`42ae3da`)

| Polecenie | Wynik |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm verify` | **exit 0** — boundaries, acceptance/matrix/closure, typecheck, build, **Vitest 30 plików / 487 testów** |
| `pnpm build` + `flock … pnpm exec playwright test` — **wszystkie 18 speców bez modelu** (`ls e2e/*.spec.ts` bez `agent-ui`, `files-agent`) | **exit 0, 106 passed** (access-context 3, agent-views 7, app 14, background-tasks 5, chat 7, chat-drawer 6, chat-layout 4, composed-views 7, **interactions 6**, measurements 2, scripted-call 1, session-restore 6, streaming 3, tool-activity 5, ui-navigation 5, **ui-state 10**, view-filter 7, view-state 8) |
| `flock … pnpm check:module-swap` | **exit 0** |

Po przebiegach usunięte nieśledzone `docs/evidence/chat-ux-2026-09-16/`, `docs/evidence/closure-2026-09-15/`, `test-results/`; drzewo czyste.

### Uwaga o Task 6

W tej rundzie nie ruszałem `shell/UiCommandRunner.tsx`, `shell/ViewFilterBanner.tsx` ani `packages/platform-contracts/src/ui.ts`; w `DataTable.tsx` zmiany zostały punktowe (import, hook, nagłówek, komórka w `renderRow`, status w dwóch ramkach, `colSpan`, `action:<id>` w opisie), a w `e2e/support/scripted-server.ts` to dwie linie — scalenie Task 6 po mnie powinno zostać małe.

### Kontrakt dla autora modułu — uzupełnienie

- Powtórzenie akcji z **tymi samymi** wartościami jest powtórzeniem (bramka `operationId`); zmiana wartości w tym samym formularzu to **inna** zmiana i dostaje nowy `operationId`. Serwer odmawia ponownego użycia identyfikatora dla innego żądania i mówi wprost, że tamta zmiana została wykonana.
- Opis semantyczny tabeli nie zawiera wartości biznesowych. Jeśli chcesz, żeby zmiana danych była widoczna w `ui_state`, niech wpływa na to, co opisuje ekran (kolejność, zawężenie, liczbę rekordów) — inaczej agent musi po prostu przeczytać dane ponownie (`POST /api/read`).

### Obawy po rundzie

- Obawy 1–8 z sekcji 10 bez zmian, z tym że obawa 2 (`['canvas']` przy `data_changed`) ma teraz dowód wprost: otwarty formularz i wpisana wartość przeżywają odświeżenie w trakcie wykonania (asercja w e2e (b)); ginie tylko fokus.
- Nowa, drobna: e2e „zgubionej odpowiedzi” opiera się na `route.fetch()` + `route.abort()`; gdyby Playwright zmienił semantykę (np. nie wysyłał żądania przed abortem), test zacząłby sprawdzać coś innego — asercja `sent[0].values` i wartość 500000 w backendzie wyłapują taką zmianę jako oblanie, nie jako ciche przejście.
