# Raport — Task 6: BL-01 — wskazanie wartości pola rekordu (L2.16, L6.16; próba T25)

- Gałąź / worktree: `bl01-bl02/t6-wskazanie-wartosci` — `/home/paczos/Documents/agentic-app-template-wt/t6-wskazanie-wartosci` (baza `02a27d3` = integracja fali 1: Task 1, 5, 2, 4, 3)
- Data: 2026-09-17
- Status: **DONE_WITH_CONCERNS** (bramka G10 zielona; najważniejsza obawa: sposób rozróżnienia `forbidden` od `record_not_found` — sekcja 2.1 i 9.1)

| SHA | Temat |
|---|---|
| `3137b5a` | Wskazanie wartosci pola rekordu: narzedzie ui_show_value, mapowanie rekord-pole na cel prezentacyjny, odslanianie rekordu w tabeli |
| `0c571f6` | Testy jednostkowe wskazania wartosci: mapowanie rekord-pole, odmowy narzedzia, plan odslaniania w przegladarce |
| `4e7950c` | E2E wskazania wartosci (port 8798, .e2e-scripted-showvalue): scenariusze skryptowane i detektor proby T25 |
| `1efaa94` | Jedno zrodlo: id ekranu Widokow agenta i odczyt wartosci pola rekordu w kontraktach |

Suma `02a27d3..HEAD`: 26 plików, +3146 / −31.

Rodzaje dowodów: **test kontraktu lub logiki** (Vitest `tests/show-value.test.ts` — narzędzie przez prawdziwą bramkę potwierdzeń runtime, mapowanie na prawdziwym rejestrze modułu, czyste funkcje przeglądarki), **symulacja** (Playwright `e2e/show-value.spec.ts`: skryptowany model, ale prawdziwe handlery `procurement_search`, `ui_show_value`, `agent_view_create`, `agent_views_list`, `ui_state`, prawdziwa bramka, prawdziwy build). Prawdziwego modelu nie użyto (G4/G5).

---

## 1. Co zrobiono (punkty „Musi” z briefu)

### 1.1 Narzędzie `ui_show_value` (punkt 1)

`packages/platform-server/src/agent/tools/ui-show-value.ts` (nowe, dopisane na końcu `platformTools` — kolejność wcześniejszych narzędzi bez zmian). Wejście `{recordKind, recordId, field, targetId?, reason?}`, `effect: 'read'`, `alwaysLoad`, schemat zgodny z MCP (bez `z.record()`, bez `.default()`).

Kandydatów wyznacza `packages/platform-server/src/registry/record-presentation.ts` (`presentationCandidates`), wyłącznie z deklaracji:

- **widoki modułu z własnym ekranem** — widok bez `params`, którego `UiTarget` o tym samym `id` ma trasę `to`;
- **karty „Widoków agenta” rozmowy wykonania** — `CanvasService.findScopedSpace(owner, AGENT_VIEWS_SCOPE_KIND, conversationId)` → `getState().cards`, tylko `kind: 'openui'`;
- **widok z parametrami trasy** (ekran rekordowy) — **tylko** gdy karta przeglądarki związana z wykonaniem właśnie go pokazuje: snapshot z `UiSnapshotStore.evaluate` (karta z potwierdzenia komendy albo z kontekstu polecenia), i tylko gdy opis nie jest `stale`. Parametry (`$caseId`) odczytywane z `source.input` **opisanych instancji**, nigdy zgadywane; brak jednoznacznej wartości → widok nie jest kandydatem.

Instancje w kompozycjach znajduje `findDataInstances` (Task 4) na katalogu `services.catalog.openui`; liczą się tylko `DataTable` (uzasadnienie w komentarzu: tabela rysuje komórkę z `data-record-*` dla każdego rekordu i umie odsłonić dowolny swój rekord zawężeniem i stroną; wykres pokazuje agregaty, a `DataSummary` stałą liczbę rekordów bez stron).

Kolejność odpowiedzi (każda przed czymkolwiek wysłanym do przeglądarki):

| Sytuacja | Wynik |
|---|---|
| żaden deskryptor nie deklaruje rodzaju rekordu | `no_renderer`, `detail: 'kind_not_declared'`, `availableKinds` |
| pole niezadeklarowane dla tego rodzaju | `unknown_field` + `available: [{field,label,type}]` |
| `targetId` spoza celów/widoków/kart rozmowy | `unknown_target` + `candidates` |
| `targetId` istnieje, ale nie pokazuje tego rodzaju | `no_renderer`, `detail: 'target_does_not_render_kind'` |
| rodzaj rekordu nigdzie osiągalnie nierenderowany | `no_renderer`, `detail: 'kind_not_rendered'` |
| pole nierenderowane w żadnym kandydacie | `no_renderer`, `detail: 'field_not_shown'`, `shownIn` (gdzie i z jakimi polami) |
| rekordu nie ma w żadnym odczycie kandydata | `record_not_found` + `checked` (z `excludedBy: 'composition_filter'`, gdy wyklucza go stały filtr kompozycji) |
| odczyt kandydata odmówiony dla tego właściciela | `forbidden` + `refused` |
| rekord w więcej niż jednym kandydacie, bez `targetId` | `ambiguous`, `found: true`, `candidates` |

### 1.2 Wartość backendu przed komendą, `found` ≠ `shown` (punkt 2)

Dla każdego kandydata (odczyty deduplikowane po `operation` + wejściu) serwer wykonuje `prepareRead` + `runPreparedRead` **z właścicielem z sesji**, znajduje rekord po `recordIdOf(...) === recordId` (porównanie napisów) i sprawdza stały filtr kompozycji (`rowMatchesFilter`). Dopiero potem idzie komenda UI.

Wynik rozróżnia:
- `found` — backend ma rekord i wartość: `backend = { rawValue, displayedText }`, gdzie `displayedText = formatFieldValue(rekord, poleDeskryptora)` (kwoty z walutą rekordu, ilości z jednostką, enum przez etykietę);
- `shown` — **klient** potwierdził: `executed && highlighted && revealed` wskazuje **ten** rodzaj, **ten** identyfikator i **to** pole (inaczej `shown: false`, `reason: 'not_confirmed'`);
- `matchesBackend` — `revealed.rawValue === backend.rawValue && revealed.displayedText === backend.displayedText`; `null`, gdy nic nie pokazano.

Wynik niesie też `target` (gdzie), `adjustments`, `highlighted`, `url`, `page` oraz `uiVersion`/`uiClientId`/`uiPublication` z potwierdzenia (jak `ui_navigate`/`ui_filter`/`ui_sort`), więc `ui_state` da się wywołać z `minVersion` i `clientId`.

### 1.3 Klient: odsłonięcie rekordu i wskazanie komórki (punkt 3)

- **Kontrakt** (`platform-contracts/src/ui.ts`): `uiRevealSchema` (`recordKind`, `recordId`, `field`, `presentation: {kind:'view',viewId} | {kind:'agent_view',cardId}`, `source`) dopisany jako `uiCommandSchema.reveal`; `uiRevealedSchema` (`displayedText`, `rawValue`, `page`, `adjustments`) jako `uiCommandResultSchema.revealed`; `UI_REVEAL_ADJUSTMENT_KINDS = ['filter_cleared','page_changed','card_focused']`; `SHOW_VALUE_REFUSALS`; nowy powód klienta `UI_COMMAND_FAILURES.notVisible`. `dataSourceSchema` **przeniesiony** z `views.ts` do `ui.ts` (bez zmiany kształtu; `views.ts` i `artifacts.ts` importują) — inaczej `uiCommandSchema` nie mogłoby nazwać odczytu instancji bez cyklu importów. `AGENT_VIEWS_TARGET_ID` i `recordValue(record, field)` też w kontraktach (jedno źródło dla obu połówek).
- **`views/revealTarget.ts`** (nowe): czysta `locateRecord(...)` — gdzie jest rekord w tabeli, liczone **tym samym `buildDataModel`**, którym tabela rysuje: `absent`, `field_not_shown`, `excluded_by_composition`, `excluded_by_narrowing` (z listą warunków, których rekord **nie** spełnia, i resztą), `present` (rekord, pole, jego strona, strona pokazana, rozmiar i liczba stron, tytuł rekordu). Rejestr zamontowanych tabel (`useRevealTarget`, filtrowany epoką dostępu jak `uiSemantics`) daje polecenie `locate` i — dla tabeli stronicującej w pamięci — `showPage`.
- **`DataTable.tsx`**: jedno wywołanie `useRevealTarget({...})` (18 linii razem z propsami) — bez zmian w renderowaniu; hook przekazuje bieżącą odpowiedź odczytu, propsy, stan adresu i stronę lokalną.
- **`shell/uiReveal.ts`** (nowe): czysta `planReveal` (co musi się zmienić: zdjęcie **tylko** tych warunków zawężenia, których rekord nie spełnia, i ustawienie jego strony — albo sama strona, w adresie dla instancji głównej i w pamięci dla pozostałych tabel) oraz `performReveal` (nawigacja do celu z czystymi parametrami, oczekiwanie na tabelę i na zastosowany adres przez `pollUntil` z `waitingDeadline`, ponowna lokalizacja, znalezienie komórki `[data-ui-instance] td[data-record-kind][data-record-id][data-field]`, przewinięcie, kontrola widoczności, podświetlenie `data-ui-highlight` na `HIGHLIGHT_MS` = 2600 ms jak dotychczasowe odsłanianie).
- **`UiCommandRunner.tsx`**: trzy linie — polecenie z `reveal` idzie do `performReveal` (przed rozwiązaniem celu w katalogu, bo ekran rekordowy nie ma swojego `UiTarget`); dotychczasowe odsłanianie selektora używa wspólnego `markHighlighted`.
- **Canvas**: `canvas/canvasFocus.ts` + rejestracja w `CanvasInner` — karta w Widokach agenta jest wyśrodkowywana przez viewport React Flow, gdy komórka nie mieści się w widoku (przewijanie strony nie ruszyłoby kanwy); zgłaszane jako `card_focused`.
- **Pasek nad widokiem** (`ViewFilterBanner.tsx`): nowy komunikat `view-reveal-notice` — „Agent wskazal wartosc. Pole „X” rekordu „Y”.” + po jednym `view-reveal-adjustment` na zmianę (`data-kind`) + „Zmiany dotycza tylko tego, co widac — dane sa bez zmian.”. Żyje, dopóki na ekranie jest ten sam adres i stan widoku (`revealAddress`, bez `c`/`s`).
- **Dane biznesowe niezmienione**: klient zmienia wyłącznie adres (zawężenie, strona) albo stan strony tabeli w pamięci; e2e (a) porównuje `POST /api/read` przed i po.

### 1.4 Prompt (punkt 4)

`agent/prompt.ts`, sekcja „## Pokazanie wartosci pola rekordu” w „Sterowanie interfejsem”: najpierw znajdź rekord narzędziem modułu (narzędzie nie szuka po nazwie), potem `ui_show_value`; `found` to nie `shown`; „Mow, ze pokazales wartosc, TYLKO gdy shown=true”; „Odpowiedz tylko tekstem z wartoscia NIE zastepuje pokazania.”; wymień `adjustments` (prezentacja, nie dane); `ambiguous` → wybierz `targetId` z `candidates`; `no_renderer` → ujawnij ograniczenie; pozostałe odmowy → powiedz wprost; po wykonaniu `ui_state` z `minVersion`/`clientId`.

---

## 2. Decyzje tam, gdzie brief zostawił wybór

### 2.1 `forbidden` = odczyt kandydata odmówiony temu właścicielowi (najważniejsza)

Brief żąda rozróżnienia `record_not_found` i `forbidden`, a rozstrzygnięcia koordynatora mówią, że wartość backendu bierze się „z odczytu kandydata (właściciel z sesji)”. Konsekwentnie: **`forbidden` pada wtedy, gdy odczyt stojący za miejscem, w którym rekord mógłby być pokazany, jest dla tego właściciela odmówiony** (`AppError` `forbidden`/`unauthenticated`), a `record_not_found` — gdy odczyty się udały i rekordu w nich nie ma.

Skutek uboczny, który trzeba znać: dla **list zakresowanych właścicielem** (np. `procurement.suppliers`) rekord innego właściciela po prostu nie istnieje w odczycie, więc pytanie o niego daje `record_not_found`, nie `forbidden`. Platforma nie ma dziś kontraktu „podaj mi ten jeden rekord po id”, więc nie może stwierdzić, że rekord istnieje u kogoś innego, nie ujawniając tego istnienia. Rozwiązanie alternatywne (deklaracja modułu: odczyt po identyfikatorze rekordu, który odpowiada `forbidden`/`not_found`) wymagałoby nowego pola kontraktu i nowych odczytów modułu — **nie wprowadzałem go bez decyzji koordynatora** (obawa 9.1). Dowody dla obu ścieżek są w testach: Vitest „odczyt odmowiony dla tego wlasciciela: forbidden, nie record_not_found” i e2e (e) po przełączeniu tożsamości w przeglądarce.

### 2.2 Tylko `DataTable` jest rendererem wartości

Komórki z `data-record-kind`/`data-record-id`/`data-field` rysują `DataTable` i `DataSummary`, ale tylko tabela ma mechanizm odsłonięcia dowolnego swojego rekordu (zawężenie z adresu, strony) — `DataSummary` rysuje pierwsze N rekordów i nie ma stron, a wykres pokazuje agregaty. Rodzaj rekordu widoczny wyłącznie w podsumowaniu albo na wykresie daje więc `no_renderer` (ujawnione ograniczenie), zamiast obietnicy, której klient nie mógłby dotrzymać.

### 2.3 Jedno miejsce = jeden `targetId`, instrukcja rozstrzyga wielokrotność

`targetId` kandydata to `id` widoku albo `id` karty; gdy jedno miejsce ma kilka tabel z tym rodzajem rekordu, dostają sufiks `#<instrukcja kompozycji>`. `targetId` w wejściu narzędzia dopasowuje się do `targetId` kandydata, do `viewId`/`cardId`, a `platform.agentViews` wybiera wszystkie karty rozmowy.

### 2.4 Niejednoznaczność rozstrzygana **po** odczytach

Kandydat, w którym rekordu nie ma (albo wyklucza go stały filtr kompozycji), nie jest alternatywą — `ambiguous` dotyczy tylko miejsc, w których rekord naprawdę jest. Dzięki temu zły identyfikator daje `record_not_found` (a nie `ambiguous`), a wybór jest potrzebny dokładnie wtedy, gdy naprawdę jest z czego wybierać.

### 2.5 Jedna nawigacja na polecenie

Nawigacja na ekran celu (z innego ekranu) startuje z czystymi parametrami widoku (`c`/`s` zachowuje router), a poprawka prezentacji (zdjęcie zawężenia, strona) wykonuje się jako `replace`, gdy polecenie samo tu przyszło — więc Wstecz wraca do ekranu użytkownika, a nie do stanu pośredniego. Gdy użytkownik już był na tym ekranie, poprawka jest zwykłym wpisem historii (Wstecz przywraca jego zawężenie).

### 2.6 `not_visible` jako osobna odmowa klienta

Komórka istniejąca, ale niedająca się pokazać (kanwa poza kadrem, kontener przycięty) to nie to samo co `not_present`. Klient sprawdza, czy środek komórki jest w oknie i nieprzycięty przez żadnego przodka; dla karty na kanwie najpierw przewija jej treść, potem prosi kanwę o wyśrodkowanie karty (`card_focused`).

### 2.7 Komunikat o wskazaniu w pasku widoku

Zdjęcie zawężenia jest niewidoczne (widok bez zawężenia wygląda jak widok, którego nikt nie zawężał), więc pasek nad widokiem mówi, co i przez kogo się zmieniło — tymi samymi słowami co zawężenie (`describePredicate`) i tylko dopóki ten stan jest na ekranie.

### 2.8 Wynik `ambiguous` nie podaje wartości

`found: true` mówi, że backend ją ma, ale sama wartość jest w wyniku dopiero, gdy jest jedno miejsce i coś naprawdę pokazano — żeby wynik nie zachęcał do odpowiedzi tekstem zamiast pokazania (L6.16).

---

## 3. Zmienione pliki (`02a27d3..HEAD`)

Kontrakty: `platform-contracts/src/{ui.ts (reveal, dataSourceSchema, AGENT_VIEWS_TARGET_ID, not_visible), records.ts (recordValue), views.ts (import zamiast definicji dataSourceSchema), artifacts.ts (import), module.ts (requestUi.reveal)}`.
Serwer: `platform-server/src/{agent/tools/ui-show-value.ts (nowy), agent/tools/index.ts, agent/prompt.ts, agent/runtime.ts (przekazanie reveal), registry/record-presentation.ts (nowy), registry/ui-targets.ts, index.ts}`.
UI: `platform-ui/src/{views/revealTarget.ts (nowy), views/DataTable.tsx, shell/uiReveal.ts (nowy), shell/UiCommandRunner.tsx, shell/ViewFilterBanner.tsx, state/appState.ts, canvas/canvasFocus.ts (nowy), canvas/CanvasHost.tsx}`.
Testy: `tests/show-value.test.ts` (nowy, 30), `tests/{ui-navigation.test.ts, views-foundation.test.ts}` (listy narzędzi), `e2e/show-value.spec.ts` (nowy, 6), `e2e/support/show-value-scenario.ts` (nowy), `e2e/support/scripted-server.ts` (jeden wpis scenariusza).
Nie edytowano dokumentów koordynatora (G8) ani zależności (G7).

---

## 4. Polecenia, kody wyjścia, liczby testów (stan `1efaa94`)

| Polecenie (w worktree) | Wynik |
|---|---|
| `pnpm exec vitest run tests/show-value.test.ts` | exit 0, **30 passed** |
| `node scripts/check-boundaries.mjs` | exit 0 — brak importów `@module/*`, brak słownika domeny w platformie |
| `pnpm verify` (granica, spójność, macierze, typecheck, build, testy) | **exit 0** — Vitest **30 plików / 502 testy** (baza `02a27d3`: 29 / 472) |
| `pnpm build` + `flock -w 2400 …/.e2e.lock pnpm exec playwright test e2e/show-value.spec.ts` | **exit 0, 6 passed (24,6 s)** |
| `flock … pnpm exec playwright test` na 18 specach bez modelu (patrz 4.2) | **exit 0, 106 passed (5,9 min)** |

Nie uruchamiano `e2e/agent-ui.spec.ts` ani `e2e/files-agent.spec.ts` (prawdziwy model — Task 8) ani `pnpm check:module-swap` (kontrakt modułu bez zmian łamiących zgodność; nowe pola kontraktu są opcjonalne i nie wymagają niczego od modułu — patrz sekcja 7).

### 4.1 Co pokrywają nowe testy

**`tests/show-value.test.ts` (30; test kontraktu lub logiki)**

*Mapowanie rekord–pole na cel prezentacyjny* (na prawdziwym rejestrze modułu i prawdziwym katalogu OpenUI): widok modułu z własnym ekranem jako kandydat z instrukcją kompozycji i kolumnami; rodzaj rekordu widoczny tylko na ekranie rekordowym bez kandydata; karty Widoków agenta rozmowy jako kandydaci, dwie tabele w jednej karcie rozróżnione sufiksem `#instrukcja`; widok z parametrami trasy kandydatem **tylko** z opisu ekranu i z parametrami z tego opisu (bez parametru w opisie — brak kandydata); pola rodzaju rekordu zbierane ze wszystkich deskryptorów.

*Narzędzie przez prawdziwą bramkę runtime* (`AgentRuntime.requestUiCommand` + `RunEventStream`, klient grany przez `acknowledgeUiCommand`): polecenie niesie rekord, pole, prezentację i odczyt instancji; wynik podaje wartość backendu i potwierdzenie klienta (`shown`, `matchesBackend`, `revealed.page`, `adjustments`); różna wartość na ekranie → `shown: true`, `matchesBackend: false`; potwierdzenie o innym rekordzie albo bez podświetlenia → `shown: false` (`not_confirmed` / `not_visible`); brak klienta → `found: true`, `shown: false`, `no_client`; `unknown_field` z listą pól i **zero** komend; `no_renderer` w trzech odmianach (`kind_not_declared`, `kind_not_rendered`, `field_not_shown` z `shownIn`); `record_not_found` z listą sprawdzonych miejsc; rekord odrzucony stałym filtrem kompozycji (`excludedBy: 'composition_filter'`); `forbidden` dla odczytu odmówionego temu właścicielowi (druga tożsamość); `ambiguous` z listą i wykonanie po wskazaniu `targetId` karty; `unknown_target` vs `target_does_not_render_kind`; ekran rekordowy z opisu karty (polecenie bez nawigacji, `input` z parametrem, wartość formatowana walutą rekordu); kontrakt narzędzia (`effect: read`, `alwaysLoad`, zgodność z MCP); prompt (reguły „znajdź, potem pokaż”, „shown=true”, „odpowiedź tekstem nie zastępuje pokazania”).

*Przeglądarka jako czyste funkcje*: `locateRecord` — rekord na dalszej stronie (strona, rekord z modelu, tytuł), kolejność z adresu zmienia stronę rekordu, zawężenie ukrywające rekord wskazuje **tylko** warunki, których nie spełnia, stały filtr kompozycji / brak pola / brak rekordu / brak odpowiedzi jako cztery różne odpowiedzi; `planReveal` — nic do zmiany, zmiana strony w adresie, zmiana strony w pamięci, zdjęcie tylko wykluczającego zawężenia z ustawieniem strony i dwoma zgłoszonymi zmianami, `not_present` dla tego, czego prezentacją zmienić się nie da; `revealAddress` (stan widoku tak, parametry sesji nie); kontrakt polecenia i potwierdzenia (odrzucenie nieznanego rodzaju prezentacji i nieznanej zmiany prezentacji).

**`e2e/show-value.spec.ts` (6; symulacja)** — port 8798, katalog `.e2e-scripted-showvalue`, 12 dodatkowych dostawców dopisanych do bazy tej instancji przed startem (2 strony po 10). Wszystkie oczekiwania liczone z `POST /api/read`:

- **(a) próba T25**: użytkownik sam zawęża widok kontrolką (`Kraj = PL`), rekord („Dostawca DE 10”) jest przez to ukryty i na drugiej stronie (asercje warunków wstępnych); polecenie z kompozytora → adres `?page=2` bez `country`, komórka `td[data-record-kind=supplier][data-record-id=…][data-field=taxId]` z NIP-em backendu, widoczna w oknie; pasek: „Agent wskazal wartosc.”, pole „NIP”, nazwa rekordu, dwie zmiany (`filter_cleared` z „Kraj (kod ISO): PL”, `page_changed`), „dane sa bez zmian”; wynik narzędzia (`found`, `shown`, `matchesBackend`, `target`, `backend`, `revealed.page`, `adjustments[0].predicates`, `url`); `ui_state` z `minVersion`/`clientId` z potwierdzenia: `stale: false`, instancja z pustym filtrem, strona 2 z 2, `visibleRecordIds` = rekordy backendu z drugiej strony; `POST /api/read` przed i po **identyczne**.
- **(b) kontrola detektora T25**: wykonanie, które tylko odpowiada tekstem z **poprawną** wartością — detektor zwraca problemy („wykonanie nie wywolalo ui_show_value”, „zadna komorka … nie zostala podswietlona”), ekran zostaje zawężony przez użytkownika, brak podświetleń i komunikatu.
- **(c)** błędny identyfikator → `record_not_found` z listą sprawdzonych miejsc, adres, wiersze, brak komunikatu i podświetleń bez zmian.
- **(d)** rekord w dwóch miejscach → `ambiguous` z dwoma kandydatami i **bez ruchu ekranu**; drugie polecenie ze wskazanym `targetId` karty → `/agent-views`, podświetlona komórka wewnątrz tej karty, `revealed.page.size = 5` i zgłoszona zmiana strony (tabela stronicuje w pamięci), `ui_state` wymienia tę kartę.
- **(e)** po przełączeniu tożsamości w aplikacji: rekord pierwszego właściciela → `forbidden` (odczyt karty odmówiony), ekran bez zmian, żadnego wiersza ani komórki tego rekordu, brak podświetleń.
- **(f)** ekran jednego rekordu (`/cases/{id}`, widok z parametrami): wskazanie pola pozycji oferty **bez nawigacji i bez zmian prezentacji** (`adjustments: []`, ta sama ścieżka i te same parametry widoku), komórka z wartością backendu, widoczna.

Detektor próby (`notShown`) jest funkcją zwracającą listę braków, nie zestawem asercji — dzięki temu ten sam detektor służy w (a) jako warunek zaliczenia i w (b) jako dowód, że wykonanie „tylko tekstem” próby nie zalicza. Podświetlenie jest **obserwowane** `MutationObserver`-em założonym przed poleceniem (znika po 2,6 s), razem z widocznością komórki w chwili podświetlenia.

### 4.2 Pełny przebieg e2e

Po `pnpm verify` (czyli na świeżym buildzie `1efaa94`), pod blokadą, jednym poleceniem:

`e2e/{show-value, view-state, view-filter, ui-state, agent-views, composed-views, ui-navigation, access-context, app, chat, session-restore, background-tasks, scripted-call, tool-activity, streaming, measurements, chat-drawer, chat-layout}.spec.ts` → **exit 0, 106 passed (5,9 min)**.

Uruchomiłem cały zestaw bez modelu, bo zmiana dotyka kontraktu polecenia UI, `DataTable`, paska nad widokiem, powłoki i kanwy. Po przebiegach usunięto nieśledzone `docs/evidence/chat-ux-2026-09-16/`, `docs/evidence/closure-2026-09-15/` i `test-results/` (generowane przez istniejące spece); `git status --short` puste.

---

## 5. Kontrole negatywne i próby zdolności wykrycia

Kontrole negatywne wynikające z treści kryteriów są w samych testach: `unknown_field`, `no_renderer` (trzy odmiany), `record_not_found`, `forbidden`, `ambiguous`, potwierdzenie o innym rekordzie, potwierdzenie bez podświetlenia, brak klienta, wartość na ekranie różna od backendu, rekord wykluczony stałym filtrem kompozycji, dane backendu niezmienione, ekran nietknięty po każdej odmowie oraz **kontrola detektora T25** (wykonanie odpowiadające tylko tekstem).

Procedura prób (dispatch-common): najpierw commit, czyste drzewo, wycofanie jednej linii, test, `git checkout -- <plik>`, ponowne `git status --short` puste; dla prób GUI dodatkowo `pnpm build` przed i po.

| Próba | Wycofanie | Test | Wynik z wycofaniem |
|---|---|---|---|
| S1 | `ui-show-value.ts`: brak filtrowania kandydatów po polu (`showing = pool`) | Vitest `-t "nigdzie nierenderowany"` | **1 failed / 29 skipped** — `expected { executed: false, …(16) } to match object { reason: 'no_renderer', …(2) }` (pole nierenderowane przestało być odmową) |
| S2 | `ui-show-value.ts`: `shown = result.executed` (bez `highlighted` i bez zgodności rekordu i pola) | Vitest `-t "potwierdzenie o innym rekordzie"` | **1 failed** — `expected { executed: true, found: true, …(15) } to match object { found: true, shown: false, …(2) }` |
| S3 | `ui-show-value.ts`: odmowa odczytu traktowana jak brak rekordu | Vitest `-t "forbidden"` | **1 failed** — `expected { executed: false, found: false, …(8) } to match object { reason: 'forbidden', …(2) }` |
| S4 | `ui-show-value.ts`: `matchesBackend` zawsze `true` (bez porównania z backendem) | Vitest `-t "matchesBackend"` | **1 failed** — `expected { executed: true, found: true, …(15) } to match object { found: true, shown: true, …(1) }` |
| C1 | `uiReveal.ts`: zdejmowane **całe** zawężenie zamiast wykluczających warunków | Vitest `-t "zawezenie ukrywajace rekord"` | **1 failed** — `expected { group: undefined, …(2) } to deeply equal { group: undefined, …(2) }` (zniknął warunek `name`, który rekord spełnia) |
| C2 | `revealTarget.ts`: strona rekordu brana z pokazanej strony zamiast z jego pozycji | Vitest `-t "rekord na dalszej stronie"` | **1 failed** — `expected { status: 'present', …(7) } to match object { status: 'present', page: 2, …(4) }` |
| G1 | jak C2, w przeglądarce (`pnpm build`) | `playwright … -g "rekord ukryty zawezeniem"` | **1 failed** (22,6 s) — `viewParams` linia 271: oczekiwane `[['page','2']]`, otrzymane bez strony |
| G2 | `uiReveal.ts`: pominięta zmiana adresu z planu (`if (false && plan.kind === 'address' …)`) | jw. | **1 failed** (22,7 s) — `viewParams` linia 271: zawężenie `country=PL` zostaje, strony nie ma |

Po każdej próbie drzewo czyste; po próbach GUI kod przywrócony i przebudowany, a pełne przebiegi z sekcji 4 wykonane na przywróconym kodzie.

---

## 6. Nieudane przebiegi (poza celowymi próbami)

1. **`pnpm exec vitest run tests/show-value.test.ts` (pierwszy przebieg): 3 failed / 27 passed.** Moje dane testowe: rekord `t7` należał do grupy, którą zawężenie **przepuszcza**, więc testy „wykluczenia” nic nie wykluczały. **Wada testu** (nie kodu); zmieniona wartość w trzech miejscach, kolejny przebieg 30/30.
2. **`node scripts/check-boundaries.mjs`: 1 naruszenie.** W nowej sekcji promptu użyłem przykładu ze słowem z domeny modułu („dostawcy”). **Mój błąd**; przykład przepisany na neutralny („jaki numer ma X”), kontrola zielona.
3. **`playwright test e2e/show-value.spec.ts` (pierwszy przebieg): 1 failed / 5 passed.** Test (f) porównywał **cały** adres przed i po poleceniu, a wysłanie polecenia dopisuje do adresu sesyjne `c=cnv_…`. **Wada testu**; porównywana jest ścieżka i parametry widoku (bez `c`/`s`), kolejny przebieg 6/6.

---

## 7. Kontrakt dla autora modułu

Moduł **nie deklaruje nic nowego** — wskazanie wartości korzysta z tego, co już deklaruje. Co z czego wynika:

- **Gdzie wartość da się pokazać.** Miejscem prezentacji jest instancja `DataTable` w (a) widoku modułu, który ma `UiTarget` o tym samym `id` z trasą `to` i **nie** ma `params`; (b) karcie „Widoków agenta” rozmowy; (c) widoku z `params` — tylko gdy karta przeglądarki właśnie go pokazuje. Rekord rodzaju, którego nie renderuje żadna taka tabela, daje `no_renderer` — z rozróżnieniem „nigdzie takich rekordów” i „to pole nie jest pokazywane” (`detail`).
- **`DataChart` i `DataSummary` nie są rendererami wartości** (brak sposobu odsłonięcia dowolnego rekordu). Jeśli rodzaj rekordu ma być wskazywalny, musi go pokazywać jakaś tabela.
- **Kolumny tabeli decydują o polach.** `DataTable(source, columns, …)` bez `columns` pokazuje wszystkie pola deskryptora; pole poza `columns` jest `no_renderer` z listą pól, które ta tabela pokazuje.
- **Stały filtr kompozycji** (`DataTable(..., filter)`) wyklucza rekord z tego miejsca: nie jest tam pokazywany i nie da się tego zmienić prezentacją (`record_not_found` z `excludedBy: 'composition_filter'`).
- **Identyfikator rekordu** porównywany jest jako **tekst** z `recordIdOf` (pole `record.idField` deskryptora). Rodzaj rekordu to `record.kind`.
- **Wartość porównywalna z backendem**: `backend.displayedText` liczy `formatFieldValue` na rekordzie z odczytu, więc kwota niesie walutę rekordu, a ilość jednostkę; klient porównywany jest z tym samym tekstem.
- **Zmiany prezentacji, które robi klient**: `filter_cleared` (tylko warunki zawężenia z adresu, których rekord nie spełnia), `page_changed` (strona — w adresie dla instancji głównej widoku, w pamięci dla pozostałych tabel), `card_focused` (przesunięcie kanwy do karty). Nic poza tym; dane biznesowe są nietknięte, a pasek nad widokiem mówi użytkownikowi, co się zmieniło.
- **Odmowa `forbidden`** pochodzi z odczytów stojących za kandydatami: odczyt odmówiony temu właścicielowi → `forbidden`; odczyty udane bez rekordu → `record_not_found` (odczyt zakresowany właścicielem nie ujawnia cudzych rekordów — patrz 2.1).
- **Dla konsumentów platformy**: `ui_show_value {recordKind, recordId, field, targetId?, reason?}` → `{executed, reason?, found, shown, matchesBackend, recordKind, recordId, field, fieldLabel?, target?, backend?, revealed?, adjustments, highlighted, url?, uiVersion?, uiClientId?, uiPublication?}`; odmowy serwera `SHOW_VALUE_REFUSALS` (`unknown_field | no_renderer | ambiguous | record_not_found | forbidden`) plus `unknown_target`; odmowy klienta z `UI_COMMAND_FAILURES` (`inactive_conversation | not_present | not_visible | no_client`). `UiCommand.reveal` i `UiCommandResult.revealed` są opcjonalne (starsze polecenia i potwierdzenia bez zmian). `dataSourceSchema` eksportowany teraz z `ui.ts` (ten sam obiekt, `@platform/contracts` bez zmian dla importujących z indeksu).

---

## 8. Self-review — ustalenia

- **G9 (kontrakty i logika bez duplikatów)**: `dataSourceSchema` przeniesiony, nie skopiowany; `recordValue` i `AGENT_VIEWS_TARGET_ID` wydzielone do kontraktów po tym, jak zauważyłem po dwie kopie (commit `1efaa94`); pozycja rekordu i strona liczone przez `buildDataModel` (ten sam model, którym tabela rysuje), zawężenie przez `rowMatchesPredicate`/`rowMatchesFilter`, łatka adresu przez `viewStatePatch`, opis warunku przez `describePredicate`, formatowanie przez `formatFieldValue`, oczekiwania w budżecie potwierdzenia przez `pollUntil` + `waitingDeadline` (kontrakt z Task 3), odczyty przez `prepareRead`/`runPreparedRead`, instancje kompozycji przez `findDataInstances` (Task 4).
- **Granica platforma–domena**: `check:boundaries` zielony (naruszenie znalezione i usunięte — sekcja 6.2); platforma zna wyłącznie nieprzezroczyste nazwy rodzajów rekordów, pól, widoków i kart.
- **Minimalne zmiany we wspólnych plikach** (scalanie): `DataTable.tsx` — jedno wywołanie hooka (Task 7 dokłada kolumnę akcji w innym miejscu pliku); `UiCommandRunner.tsx` — import, jeden blok `if (command.reveal)`, wspólne `markHighlighted`; `ViewFilterBanner.tsx` — komunikat jako osobny komponent i jeden warunek; `scripted-server.ts` — jeden wpis scenariusza; `appState.ts` — jedno pole i jeden setter; `prompt.ts` — jedna sekcja na końcu bloku sterowania interfejsem.
- **Instancja użytkownika (8791), główny checkout i inne worktree nietknięte**; Playwright wyłącznie pod blokadą ze wskazanymi plikami; baza testowa tylko w `.e2e-scripted-showvalue`.
- Po przebiegach usunięto nieśledzone dowody generowane przez istniejące spece (`docs/evidence/…`) i `test-results/`; drzewo czyste.

---

## 9. Obawy

1. **`forbidden` tylko z odmowy odczytu kandydata** (sekcja 2.1). Pytanie o rekord innego właściciela, którego jedynym miejscem prezentacji jest lista zakresowana właścicielem, daje `record_not_found`. Jeśli koordynator chce, żeby w takim przypadku padało `forbidden`, potrzebna jest deklaracja modułu w rodzaju „odczyt R z wejściem `{k: id}` odpowiada za dostęp do rekordu rodzaju K” (nowe, opcjonalne pole kontraktu + odczyty w module) — zaprojektowane, nieujęte w tej gałęzi bez decyzji.
2. **Renderer to tylko `DataTable`** (2.2). Rodzaj rekordu pokazywany wyłącznie przez `DataSummary` byłby dziś `no_renderer`, choć jego komórki mają komplet atrybutów. Rozszerzenie wymaga mechanizmu odsłonięcia rekordu spoza rysowanego zakresu.
3. **Ekran rekordowy jako kandydat zależy od świeżości opisu ekranu.** Gdy karta przeglądarki nie zdążyła opublikować opisu (albo jest `stale`), widok z parametrami nie jest kandydatem i odpowiedź brzmi `no_renderer`/`record_not_found` — mimo że użytkownik patrzy na ten rekord. To świadome (parametrów nie wolno zgadywać), ale przy wolnym ekranie może zaskoczyć.
4. **Podświetlenie trwa 2,6 s i nie jest odnawiane.** Dwa wskazania tej samej komórki w odstępie krótszym niż 2,6 s kończą się wcześniejszym zdjęciem podświetlenia (timer pierwszego).
5. **`card_focused` przesuwa viewport kanwy** — React Flow zgłasza `onMoveEnd`, więc przesunięcie zapisuje się jako viewport przestrzeni Widoków agenta. Nie zmienia pozycji kart ani danych; na Widokach agenta viewport i tak nie jest kontekstem roboczym użytkownika.
6. **Zgodność `input` instancji z `source` z polecenia** jest porównywana po `JSON.stringify` — instancja o tym samym wejściu zapisanym w innej kolejności kluczy nie zostałaby dopasowana. Dziś wejście pochodzi z tej samej kompozycji, więc kolejność jest ta sama.
7. **Konflikty przy scalaniu**: `DataTable.tsx` (Task 7 — kolumna akcji), `ui.ts` (dopisane schematy na końcu), `UiCommandRunner.tsx`, `ViewFilterBanner.tsx`, `scripted-server.ts`, listy narzędzi w `tests/views-foundation.test.ts` i `tests/ui-navigation.test.ts`.
8. **Zachowanie prawdziwego modelu** (czy stosuje „najpierw znajdź, potem pokaż” i czy nie raportuje `found` jako `shown`) potwierdza dopiero Task 8; tutaj jest symulacja ze skryptowanym modelem i prawdziwymi handlerami.

---

## Fix round 1 (po przeglądzie: „Approved”, ustalenia I1–I2, R1–R4)

Commit: `1d041e5` — Fix round 1: zmiana prezentacji zgloszona takze przy odmowie, unreadable odrozniony od braku rekordu, czekanie na klatke w budzecie (10 plików).

### Zmiany wg ustaleń

**I1 — zmiana prezentacji nie przeżywa już odmowy w milczeniu.**
- **Kontrakt**: `adjustments` przeniesione z `uiCommandResultSchema.revealed` na **wynik** (`uiCommandResultSchema.adjustments`), bo zmiana może przeżyć odmowę, a wtedy nie ma żadnego `revealed`, w którym mogłaby jechać. `uiRevealedSchema` opisuje odtąd tylko to, co wskazano (rekord, pole, tekst, wartość, strona).
- **Klient** (`uiReveal.ts`): `adjustments` są listą polecenia od początku; nowe `announce(shown, found?)` ustawia komunikat paska **w chwili zastosowania zmiany adresu albo strony** (`shown: false`), a nie dopiero po sukcesie; każda odmowa po tym momencie (`refuse`) niesie `adjustments`. Ścieżka `not_visible` zgłasza dodatkowo `revealed` (komórka istnieje) i też ustawia pasek.
- **Decyzja o nieprzywracaniu adresu**: zmiana **zostaje**. To jest stan, w którym rekord jest osiągalny; cofnięcie schowałoby go z powrotem, dołożyło drugi wpis historii i twierdziło, że nic się nie stało — a użytkownik i tak zobaczył zmianę. Zamiast tego każda odmowa mówi, co zostało zmienione (wynik + pasek). Uzasadnienie w komentarzu przy `announce`.
- **Pasek** (`ViewFilterBanner.tsx`): `data-shown="true|false"`, a teksty pochodzą z jednej funkcji `revealNoticeText(notice)` (jedno źródło dla ekranu i testów): przy niepowodzeniu „Agent zmienil widok, szukajac wartosci.” + „Pole „X” rekordu „Y” nie zostalo wskazane.” + lista zmian + „Zmiany dotycza tylko tego, co widac — dane sa bez zmian.”. `RevealNotice` ma `shown` i dopuszcza nieznaną etykietę pola i tytuł rekordu (odmowa może nastąpić, zanim rekord zostanie zlokalizowany).
- **Narzędzie**: `adjustments: result.adjustments ?? []` (zamiast z `revealed`), więc odmowa klienta też je przekazuje; opis narzędzia mówi, że niepuste `adjustments` przy odmowie znaczą „ekran już zmieniony”.

**I2 — `unreadable` ≠ `record_not_found`.** Nowa odmowa `SHOW_VALUE_REFUSALS.unreadable`: gdy **żaden** odczyt kandydata się nie powiódł z powodu innego niż dostęp, wynik to `{reason: 'unreadable', unreadable: [{…, code, message}]}` bez `checked` — „nie ma takiego rekordu” to twierdzenie o danych, a „nie dało się sprawdzić” o tym wykonaniu. Gdy część odczytów się udała, odpowiedź jest jak dotąd (`record_not_found` z `unreadable` obok). Udokumentowane w `SHOW_VALUE_REFUSALS`, opisie narzędzia i prompcie („NIE mow, ze rekordu nie ma”).

**R1 — czekanie na klatkę w budżecie.** `nextFrame(until)` zwraca `boolean` i rozstrzyga się na `requestAnimationFrame` **albo** po `min(120 ms, until − teraz)`; `bringIntoView` dostaje termin polecenia i zwraca `framed && inView(cell)`. Karta, która nie rysuje klatek (w tle), kończy więc poleceniem `not_visible` w budżecie, zamiast wisieć do `no_client` po zmianie ekranu.

**R2 — tylko rozmowa wykonania.** `displayedView` nie schodzi już do `ctx.appContext.conversationId`; bez rozmowy wykonania nie ma kandydata z ekranu rekordowego (tak jak `agentViewCards` już odmawiał).

**R3 — `unknown_target` jest odmową udokumentowaną**: w `SHOW_VALUE_REFUSALS`, w opisie narzędzia i w prompcie.

**R4 — `fieldLabel` w każdej odpowiedzi po rozpoznaniu pola** (wspólne `asked`): `ambiguous`, `record_not_found`, `forbidden`, `unreadable`, `no_renderer`, `unknown_target`.

Dodatkowo: `registerRevealTarget` wyeksportowany z `views/revealTarget.ts` (używa go hook), żeby ścieżkę odsłaniania dało się wykonać bez montowania komponentu.

### Testy (`tests/show-value.test.ts` 30 → **37**)

- **I1 (klient, ekran zastępczy)**: „komorki nie ma: not_present, ale zdjete zawezenie jest zgloszone i widoczne w pasku” — wynik z `adjustments` (`filter_cleared` + `page_changed`), adres faktycznie `?page=2`, komunikat `shown: false` i jego teksty; „komorka poza widocznym obszarem: not_visible z wartoscia, zmianami i paskiem”; „komorka w widoku: wskazana, podswietlona, a zmiany sa w wyniku i w pasku” (podświetlenie ustawione dokładnie raz).
- **R1**: „karta, ktora nie rysuje klatek: odpowiedz w budzecie, bez udawania, ze cos widac” — `requestAnimationFrame`, który nigdy nie oddaje sterowania; wynik `not_visible` przed terminem, bez podświetlenia.
- **I2**: „odczytu nie dalo sie wykonac: unreadable, nie record_not_found” — odczyt modułu zastąpiony w teście błędem `integration_failed`; wynik `unreadable` z kodem błędu, bez `checked`, zero komend.
- **R2**: „wykonanie bez rozmowy nie bierze ekranu z opisu innej rozmowy” — ten sam opis ekranu daje kandydata dla wykonania w rozmowie i **nie daje** go dla wykonania bez rozmowy.
- **I1 (serwer)**: „zmiana prezentacji z odmowy klienta trafia do wyniku narzedzia”.
- **R3/R4**: `unknown_target` z `SHOW_VALUE_REFUSALS` i `fieldLabel`; `ambiguous` z `fieldLabel`; prompt zawiera `unknown_target`, zdanie o `unreadable` i o „ekran ZOSTAL juz zmieniony”.
- Kontrakt: potwierdzenie z samą zmianą prezentacji i bez `revealed` przechodzi walidację; nieznany rodzaj zmiany jest odrzucany.

### Polecenia i wyniki (stan `1d041e5`)

| Polecenie | Wynik |
|---|---|
| `pnpm exec vitest run tests/show-value.test.ts` | exit 0, **37 passed** |
| `pnpm build` + `flock -w 2400 …/.e2e.lock pnpm exec playwright test e2e/show-value.spec.ts e2e/view-state.spec.ts e2e/ui-state.spec.ts` | **exit 0, 24 passed (1,8 min)** (show-value 6, view-state 8, ui-state 10) |
| `pnpm verify` | **exit 0** — spójność OK, macierze, typecheck, build, **Vitest 30 plików / 509 testów** (przed rundą: 30 / 502) |

E2E `show-value` uzupełnione o `data-shown="true"` na pasku przy udanym wskazaniu.

### Próby zdolności wykrycia (commit → czyste drzewo → wycofanie → test → `git checkout` → czyste)

| Próba | Wycofanie | Wynik z wycofaniem |
|---|---|---|
| I1a | `announce(false)` po zastosowaniu zmiany adresu | **1 failed / 36 skipped** — `expected null to match object { shown: false, …(2) }` (pasek milczy o zdjętym zawężeniu) |
| I1b | `refuse` bez `adjustments` | **1 failed** — `expected undefined to deeply equal [ …(2) ]` (agent nie dowiaduje się o zmianie ekranu) |
| I2 | gałąź `unreadable` wyłączona | **1 failed** — `expected { executed: false, found: false, …(9) } to match object { reason: 'unreadable', …(3) }` (nieudany odczyt raportowany jako brak rekordu) |
| R1 | `nextFrame` znów nieograniczony (bez terminu) | **1 failed** — `Error: Test timed out in 30000ms.` — dokładnie zawieszenie, które kończyłoby się `no_client` po zmianie ekranu |

Po każdej próbie drzewo czyste; pełne przebiegi z tabeli wyżej wykonane na przywróconym kodzie.

### Nieudane przebiegi w tej rundzie

Brak poza celowymi próbami. (Typecheck po zmianie kontraktu wskazał — zgodnie z oczekiwaniem — pięć miejsc w teście i jedno w kliencie, gdzie `adjustments` były jeszcze w `revealed`; poprawione przed uruchomieniem testów.)

### Kontrakt dla autora modułu — uzupełnienie

- Potwierdzenie polecenia UI może nieść `adjustments` **bez** `revealed`: klient zmienił prezentację (np. zdjął zawężenie użytkownika), a mimo to nie wskazał wartości. Zmiana **nie jest cofana** — jest zgłaszana w wyniku narzędzia i opisana w pasku nad widokiem (`data-testid="view-reveal-notice"`, `data-shown="false"`).
- `ui_show_value` odmawia też `unreadable` (odczytów stojących za miejscami prezentacji nie dało się wykonać — nie wolno z tego wnioskować, że rekordu nie ma) i `unknown_target` (podany `targetId` nie jest żadnym widokiem, kartą ani celem katalogu). Każda odmowa po rozpoznaniu pola podaje `fieldLabel`.
- Ekran rekordowy (widok z `params`) jest kandydatem tylko dla wykonania **mającego swoją rozmowę**; wykonanie bez rozmowy nie czyta opisu ekranu.

### Obawy po rundzie

1. Obawa 1 z sekcji 9 (rozróżnienie `forbidden` / `record_not_found`) — zaakceptowana przez koordynatora jako spełniająca L6.16; zostaje jako opisane ograniczenie.
2. Nowe: przy odmowie po zmianie prezentacji użytkownik zostaje ze zmienionym widokiem (świadoma decyzja, opisana wyżej) — przywrócenie poprzedniego adresu byłoby drugą zmianą i też wymagałoby zgłoszenia; jeśli koordynator woli przywracanie, jest to zmiana lokalna w `performReveal`.
3. `FRAME_WAIT_MS = 120` jest limitem na jedno oczekiwanie na klatkę; przy bardzo obciążonej karcie (klatka rzadsza niż 120 ms) wskazanie może zostać zgłoszone jako `not_visible`, mimo że komórka jest na ekranie — wybrane świadomie: fałszywe „pokazałem” jest gorsze niż ostrożna odmowa.
4. Pozostałe obawy z sekcji 9 bez zmian (renderer tylko `DataTable`, świeżość opisu ekranu, konflikty scalania — teraz także `ui.ts` z `adjustments` na wyniku).

---

## Merge round (scalenie `bl01-bl02/integracja` 1be9998 = fala 1 + Task 7)

Commity:

| SHA | Temat |
|---|---|
| `cd1e8c3` | Scalenie `bl01-bl02/integracja` (Task 7) do gałęzi Task 6 — commit scalający (rodzice `1d041e5`, `1be9998`), bez rebase |
| `134e0dd` | Merge round: wskazanie wartosci w tabeli z akcjami rekordu, odczyt po odswiezeniu, testy integracji |
| `a348d2a` | Merge round: komunikat o zmianie strony po polsku, testy kolumny akcji i odczytu po akcji |

### Konflikty i rozwiązania (3 pliki; oczekiwane pięć innych scaliło się samo)

| Plik | Konflikt | Rozwiązanie |
|---|---|---|
| `platform-contracts/src/records.ts` | obie strony dopisały funkcję w tym samym miejscu: moje `recordValue` vs `TYPED_DECIMAL` + `parseFieldInput` (T7) | obie, w kolejności zapisu; nic nie usunięte |
| `platform-server/src/index.ts` | `export * from './registry/record-presentation.ts'` vs trzy eksporty T7 (`record-actions`, `tool-execution`, `services/record-actions`) | wszystkie cztery |
| `e2e/support/scripted-server.ts` | import i wpis scenariusza: `show-value` vs `interactions` | oba (import T7 pierwszy, scenariusze `interactions`, potem `show-value`) |

Scaliły się automatycznie i zostały sprawdzone: `DataTable.tsx` (kolumna akcji T7 + mój `useRevealTarget` — oba obecne, wiersz nadal rysowany jedną `renderRow`), `ui.ts` (`adjustments` na wyniku + kontrakty T7), `UiCommandRunner.tsx`, `ViewFilterBanner.tsx`, `prompt.ts`, `views.ts` (`actions` w deskryptorze), `views-foundation.test.ts`.

### Wymagania integracji

**1. Wskazanie w tabeli z kolumną akcji.** Komórka akcji (`td.pf-table__actions`) nie ma `data-record-kind`, `data-record-id` ani `data-field`, a moje wyszukanie komórki wymaga wszystkich trzech — więc kolumna akcji nie może zostać wzięta za komórkę wartości, a otwarty formularz innego wiersza niczego nie przesuwa (formularz żyje w komórce akcji swojego wiersza). Dowód: e2e **(g)** — w karcie Widoków agenta nad `procurement.case_offer_items` (2 wiersze na stronę) użytkownik otwiera formularz ceny w wierszu z pierwszej strony i **wpisuje** do niego wartość, a polecenie wskazuje cenę rekordu z drugiej strony: podświetlona jest dokładnie jedna komórka (`[data-record-id=…][data-field="unitPriceMinor"]`), jej tekst to `backend.displayedText`, `adjustments` zawiera `page_changed`.
- **Otwarty formularz a zmiana strony — znalezisko zgłaszane jawnie.** Zmiana strony odmontowuje wiersz, więc formularz znika z ekranu; stan „która akcja jest otwarta” przeżywa (po powrocie na stronę formularz jest znowu otwarty), ale **wpisany tekst przepada** — pole wraca puste. Test (g) przypina dokładnie to zachowanie (`toHaveValue('')`). Jest to zachowanie tabeli T7 przy każdej zmianie strony (także ręcznej przez użytkownika), nie coś, co dokłada wskazanie wartości; nowe jest tylko to, że teraz stronę może zmienić agent. Zmiana **nie jest cicha**: pasek mówi „Agent wskazal wartosc … Zmieniono strone: 1 → 2.”. Czy formularz ma przeżywać zmianę strony z wpisanym tekstem — do decyzji właściciela Taska 7 (obawa 3 poniżej).

**2. Opis semantyczny niesie oba wkłady.** `describeDataInstance` dostaje `actions` złożone z tokenów `filter`/`sort`/`page`/`open_record` i `action:<id>` (T7); mój przepływ nic tam nie dokłada ani nie odejmuje, a po wskazaniu, które zmieniło stronę, `page` i `visibleRecordIds` opisują stronę pokazaną. Dowód: e2e **(h)** — po wskazaniu `ui_state` zwraca instancję `procurement.case_offer_items` z `action:change_unit_price` **i** z rekordem w `visibleRecordIds`; e2e **(a)** (bez akcji w tym odczycie) sprawdza `page: {index: 2 …}` i `visibleRecordIds` = rekordy drugiej strony z backendu.

**3. Wskazanie po akcji pokazuje NOWĄ wartość; kolejność bez wyścigu.** Kolejność jest taka: akcja kończy się i unieważnia `['read']` → dopiero potem wykonanie woła `ui_show_value` → serwer czyta backend **w tej chwili** (świeżo) → komenda idzie do przeglądarki. Fałszywe „zgadza się” wymagałoby, żeby **serwer** miał starą wartość, a on czyta po akcji; stara wartość po stronie klienta może dać najwyżej `matchesBackend: false`, czyli prawdę o tym, co widać.
- Dodatkowo zamknięta została luka odwrotna: tabela T7 zgłasza `refreshing`, gdy jej odczyt leci ponownie (wiersze na ekranie są tymi, które zaraz znikną). `RevealTarget` niesie teraz `refreshing`, a `performReveal` **czeka** z odczytem wartości, aż tabela przestanie się odświeżać (w budżecie polecenia); jeśli nie przestanie — `not_applied` („widok wlasnie odswieza dane”, dopisane do opisu narzędzia), zamiast porównania wartości, która już jest nieaktualna. Dowody: Vitest „tabela w trakcie ponownego odczytu…” i „tabela, ktora nie przestaje sie odswiezac…”, e2e **(h)** (użytkownik zmienia cenę formularzem, potem polecenie: `backend.rawValue` i `revealed.rawValue` = 999950, `matchesBackend: true`, `backend.displayedText` równy `formatFieldValue` **nowego** rekordu i różny od tekstu sprzed zmiany).

**4. Brak dryfu schematów.** `uiCommandResultSchema.adjustments` i kontrakty T7 (`ReadResultDescriptor.actions`, `recordActionSchema`) obowiązują obok siebie — test kontraktu parsuje deskryptor z akcjami i potwierdzenie ze zmianami prezentacji w jednym miejscu.

### Testy (`tests/show-value.test.ts` 37 → **39**, `e2e/show-value.spec.ts` 6 → **8**)

- Vitest: „tabela w trakcie ponownego odczytu: wskazana jest wartosc po odswiezeniu, nie ta sprzed akcji”; „tabela, ktora nie przestaje sie odswiezac: not_applied, nie falszywe wskazanie”; kontrakt — deskryptor z `actions` T7 obok potwierdzenia ze zmianami prezentacji.
- E2E: **(g)** kolumna akcji, otwarty formularz i zmiana strony; **(h)** akcja rekordu → wskazanie nowej wartości → `ui_state` z `action:<id>` i widocznym rekordem.

### Polecenia i wyniki (stan `a348d2a`)

| Polecenie | Wynik |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 („Already up to date”) |
| `pnpm verify` | **exit 0** — spójność OK, macierze, typecheck, build, **Vitest 31 plików / 526 testów** |
| `flock … pnpm check:module-swap` | **exit 0** — „próba zakończona — 8 s” (moduł kontrolny, powłoka bez ekranów przykładu) |
| `pnpm build` + `flock … pnpm exec playwright test e2e/show-value.spec.ts` | **exit 0, 8 passed (31,7 s)** |
| `pnpm build` + `flock … pnpm exec playwright test` na **19** specach bez modelu (`ls e2e/*.spec.ts` bez `agent-ui` i `files-agent`) | **exit 0, 114 passed (6,3 min)** |

### Próby zdolności wykrycia (commit → czyste drzewo → wycofanie → test → `git checkout` → czyste)

| Próba | Wycofanie | Test | Wynik z wycofaniem |
|---|---|---|---|
| M1 | `performReveal` bez czekania na koniec odświeżania tabeli | Vitest `-t "w trakcie ponownego odczytu"` | **1 failed / 38 skipped** — `expected { recordKind: 'supplier', …(5) } to match object { displayedText: 'nowa', …(1) }` (wskazana wartość sprzed akcji) |
| M2 | wyszukanie komórki bez `[data-field]` (dowolna komórka wiersza) | `pnpm build` + `playwright … -g "kolumna akcji"` | **1 failed** — podświetlona komórka innego pola tego samego wiersza |

### Nieudane przebiegi w tej rundzie

1. `playwright e2e/show-value.spec.ts` (pierwszy po scaleniu): **1 failed / 6 passed** — (g) asercja tekstu paska „Zmieniono strone”, a pasek pisał „Zmieniono strona 1 → 2”. **Błąd tekstu UI** (odmiana), nie testu: zdanie o stronie budowane jest teraz z `from`/`to` („Zmieniono strone: 1 → 2.”).
2. Drugi przebieg: **1 failed / 6 passed** — (g) oczekiwał, że po powrocie na pierwszą stronę formularz **nie** jest otwarty; w rzeczywistości otwarty stan akcji przeżywa zmianę strony, a traci tylko wpisany tekst. **Wada oczekiwania**; test przypina zachowanie faktyczne (i jest podstawą znaleziska w wymaganiu 1).
3. Trzeci przebieg: **1 failed / 7 passed** — (h) porównywał tekst z literałem „9 999,50”, a deskryptor formatuje `999950` jako „9999,50 PLN”. **Wada testu**; oczekiwanie liczone `formatFieldValue` na deskryptorze z backendu. Czwarty przebieg 8/8.

### Kontrakt dla autora modułu — uzupełnienie

- Tabela z akcjami rekordu (`ReadResultDescriptor.actions`) jest normalnym miejscem wskazywania wartości: kolumna akcji nie niesie `data-record-id`/`data-field`, więc nie bierze udziału w wyszukaniu komórki.
- Wskazanie wartości **czeka**, aż tabela skończy ponowny odczyt (po akcji rekordu, po zakończeniu wykonania), i dopiero wtedy porównuje wartość z backendem; tabela, która nie przestaje się odświeżać w budżecie polecenia, kończy się `not_applied`.
- Zmiana strony przez wskazanie zabiera z ekranu wiersz z otwartym formularzem akcji: sam wybór akcji przeżywa (po powrocie formularz jest znów otwarty), wpisany tekst nie.

### Obawy po rundzie

1. Obawy z sekcji 9 i z „Fix round 1” bez zmian.
2. **Wpisany tekst w otwartym formularzu akcji ginie przy zmianie strony** (także ręcznej) — opisane wyżej; jeśli ma przeżywać, to zmiana w `RecordActions` (Task 7), nie tutaj.
3. `not_applied` jest teraz również odpowiedzią „widok się odświeża” — dla agenta znaczy „spróbuj ponownie”; opis narzędzia to mówi, ale kod jest wspólny z odmową „widok nie zgłosił zastosowania” z Taska 2.
