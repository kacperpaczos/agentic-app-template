# Raport — Task 3: BL-01 — semantyczny opis aktywnego UI i świeżość kontekstu (L6.15, L6.17)

- Gałąź / worktree: `bl01-bl02/t3-opis-ui` — `/home/paczos/Documents/agentic-app-template-wt/t3-opis-ui` (baza `3097586`)
- Data: 2026-09-17
- Status: **DONE_WITH_CONCERNS** (bramka G10 zielona; obawy w sekcji 10 — najważniejsza: poprawka poza zakresem w `agent/events.ts`)

| SHA | Temat |
|---|---|
| `05cfe10` | Strumien wykonania: zdarzenie wyemitowane w trakcie obslugi poprzedniego nie czeka na kolejne |
| `c8c4a18` | Opis aktywnego UI: wersjonowany snapshot karty, PUT/GET /api/ui/snapshot, ui_state, uiVersion i AppContext.ui |
| `5145ff8` | Lista czasownikow ui_* obejmuje ui_state (tylko odczyt opisu ekranu) |
| `bdc71e8` | Flush opisu ekranu zawsze wysyla biezaca wersje: po restarcie backendu polecenie nie zostaje z no_client |

Rodzaje dowodów: **test kontraktu lub logiki** (Vitest), **symulacja** (skryptowany model na granicy adaptera; w przeglądarce — prawdziwy build, runtime, bramka komend UI i handlery narzędzi), **test GUI bez modelu** (istniejące spece bez agenta). Prawdziwego modelu nie użyto.

---

## 1. Co zrobiono (punkty „Musi”)

### 1.1 Kontrakt (`packages/platform-contracts`)

- **`src/ui-snapshot.ts`** (nowy plik, żeby nie konfliktować z `views.ts` Tasków 2 i 4), eksport z indeksu:
  - `uiSnapshotSchema`: `version` (int ≥ 1, rośnie w obrębie karty), `clientId` (`uiClientIdSchema`: 8–80 znaków `[A-Za-z0-9_-]`), `capturedAt` (ISO), `conversationId|null`, `spaceId|null`, `url` (≤ 2000), `target {id, kind, label}|null` (cel katalogu, którego `to === pathname`), `view {id, title, compositionVersion}|null`, `cards` (≤ 50, `{cardId, title, kind: component|openui, component, specVersion}`) **albo `null`, gdy karta przeglądarki nie wczytała przestrzeni** (nieznane ≠ brak), `cardsOmitted`, `instances: SemanticInstance[]` (≤ 30, walidowane `semanticInstanceSchema` z T1), `instancesOmitted`, `actions` (≤ 20).
  - Stałe: `UI_SNAPSHOT_INSTANCES_LIMIT = 30`, `UI_SNAPSHOT_CARDS_LIMIT = 50`, `UI_SNAPSHOT_MAX_BYTES = 256 000`, `UI_STATE_MAX_WAIT_MS = 5000`, `UI_STATE_DEFAULT_WAIT_MS = 3000`, `UI_STATE_REASONS`.
  - `UiStateResult` = `{ stale, reason?, version, capturedAt, ageMs, snapshot }` (werdykt pierwszy — patrz 2.6).
  - `compositionVersionOf(source)` — FNV-1a 32 po jednostkach UTF-16 z prefiksem długości (`"<len36>-<8 hex>"`); jedna funkcja dla przeglądarki i serwera (G9).
- **`src/agent.ts`**: `appContextSchema.ui = z.object({ version: int ≥ 1, clientId, viewId: string|null, url }).nullable().default(null)`; `EMPTY_APP_CONTEXT.ui = null`. Nic więcej w AppContext.
- **`src/ui.ts`**: `uiCommandResultSchema.uiVersion: z.number().int().min(1).optional()` dopisane na końcu.

### 1.2 Klient (`packages/platform-ui`)

- **`state/uiSnapshot.ts`** (nowy):
  - `buildUiSnapshotContent(input)` — czysta funkcja: wejście to wyłącznie rejestr `uiSemantics` (`listInstances()`), adres, `conversationId`/`spaceId` z powłoki i trzy wpisy cache zapytań (`qk.uiTargets()`, `qk.uiViews()`, `qk.space(spaceId)`). Nic z markupu. *(Stan po Fix round 1: te trzy zapytania obserwuje sam `UiSnapshotPublisher` — `useUiTargets()`, `useViewDefinitions()`, `useCanvasState(spaceId)` — więc są wczytywane na każdym ekranie, także gdy ekran ich nie używa; źródło opisu `createShellSnapshotSource` pamięta też ostatnio widziane dane właściciela. Pierwotne „nic pobierane specjalnie” nie jest już prawdą.)* Cel: wpis katalogu z `to === pathname`, przy kilku — `kind: 'view'`. Widok: definicja o `id` celu, a gdy trasa nie jest ścieżką katalogu (ekran rekordu) — pierwsza definicja wskazana przez `viewId` zamontowanych instancji. Akcje (rozstrzygnięcie koordynatora): `navigate` zawsze, `filter` gdy cel deklaruje `filter`, `sort` gdy widok celu ma `primaryOperation`. Ponad 30 instancji — pominięte i policzone; opis przekraczający limit bajtów traci instancje od końca (policzone w `instancesOmitted`).
  - `sessionIdentityStore()` — `{clientId, version}` w `sessionStorage` (klucz `platform.ui-snapshot.client`), każdy dostęp w `try/catch`; przy niedostępnym magazynie tożsamość żyje w pamięci strony.
  - `UiSnapshotSession`: `capture()` nadaje nową wersję **tylko przy zmianie treści** (klucz = zakres dostępu + JSON treści; ten sam ekran po przelogowaniu to nowa wersja); licznik zapisywany z tożsamością, więc przeładowanie karty go kontynuuje. `changed()` — publikacja z opóźnieniem 250 ms. `flush({settleMs, maxSettleMs, timeoutMs})` — opcjonalnie czeka na ciszę (brak zmian przez `settleMs` i brak instancji `loading`, najwyżej `maxSettleMs`), składa opis i publikuje, zwraca opis przyjęty przez backend albo `null` po `timeoutMs`. *(Nieaktualne od Fix round 1–2: `flush` zwraca `UiPublication` — `published {snapshot}` | `rejected {code}` (tylko odmowa backendu) | `unreachable` | `not_described` | `timeout`; od rundy 3 źródło może też odpowiedzieć „nic do opisania” i wtedy `flush` daje `not_described`.)* Publikacje idą **po kolei** (łańcuch obietnic), więc serwer dostaje wersje karty w kolejności. Odmowa `conflict` (wersja nie nowsza — np. zduplikowana karta skopiowała `sessionStorage`) → nowa tożsamość, ten sam opis jako wersja 1. `contextMarker()` → `{version, clientId, viewId, url}`.
  - Singleton `uiSnapshotSession` wysyła `PUT /api/ui/snapshot` (nowe `apiPut` w `api/client.ts`).
- **`shell/UiSnapshotPublisher.tsx`** (nowy, renderowany w `AppShell` obok `UiCommandRunner`): instaluje źródło opisu i woła `changed()` przy zmianie rejestru `uiSemantics`, `conversationId`/`spaceId` (inne zmiany magazynu — np. strumień tekstu — są pomijane), adresu (`useRouterState(location.href)`) i danych cache `ui-targets`/`ui-views`/`canvas` (tylko zdarzenia `added|updated|removed`).
- **`state/appState.ts`**: `toAppContext().ui = uiSnapshotSession.contextMarker()`.
- **`shell/UiCommandRunner.tsx`**: przed wysłaniem potwierdzenia `flush({settleMs: 150, maxSettleMs: 1500, timeoutMs: 2000})` i `uiVersion` = wersja przyjęta; pominięte dla `inactive_conversation` (nic się nie zmieniło, a ekran dotyczy innej rozmowy).
- **`chat/chatWiring.ts`** (`send`): (1) jeśli `threadId` różni się od `conversationId` w magazynie — zapis `setConversation(threadId)` **przed** publikacją (patrz 2.4 i próba G), (2) `flush({timeoutMs: 1500})`, potem `toAppContext()`.

### 1.3 Serwer (`packages/platform-server`)

- **`services/ui-snapshots.ts`** (nowy) `UiSnapshotStore` w pamięci procesu, w `PlatformServices.uiSnapshots`:
  - klucz: właściciel (z sesji) → `clientId`; najwyżej 20 kart na właściciela (wypada najdawniej publikująca); indeks rozmowa → karta, która najpóźniej opublikowała opis tej rozmowy (przebudowywany przy każdej publikacji, więc karta, która przeszła do innej rozmowy, znika z indeksu starej);
  - `publishRaw(owner, body)` — limit bajtów przed parsowaniem, JSON, schemat; `publish` odrzuca wersję ≤ zapisanej (`conflict`, `details: {reason: 'version_not_newer', current}`), z wyjątkiem ponownego wysłania **tej samej** wersji o tej samej treści (przyjęte bez zmian);
  - `evaluate(owner, conversationId, {minVersion?, context?})` — brak kart właściciela → `no_client`; karta z kontekstu polecenia (`AppContext.ui.clientId`) ma pierwszeństwo, jeśli wciąż pokazuje tę rozmowę, inaczej karta z indeksu; brak → `other_conversation`; wymagana wersja = `max(minVersion, wersja z kontekstu — tylko gdy wybrana karta jest kartą z kontekstu)`; starszy opis → `stale: true, reason: 'older_than_requested'` **ze zwróconym starszym opisem**; `ageMs` liczony od `min(capturedAt, receivedAt)` (zegar karty nie odmładza opisu);
  - `nextPublication(owner, timeoutMs)` i `waitFor(...)` — czekanie na publikację właściciela aż do spełnienia wymogu albo terminu.
- **`http/app.ts`**: `PUT /api/ui/snapshot` (sesja; nagłówek `content-length` i treść sprawdzane z limitem; odpowiedź `{accepted, version, clientId}`), `GET /api/ui/snapshot?conversationId=[&minVersion=]` (ta sama `evaluate` co `ui_state`, bez czekania) albo `?clientId=` (`{snapshot}`); bez parametrów 400. Oba tylko w obrębie właściciela z sesji. CORS: dopisane `PUT`.
- **`agent/tools/ui-state.ts`** (nowy), zarejestrowany w `agent/tools/index.ts` zaraz po `uiTools`: `ui_state`, `effect: 'read'`, `alwaysLoad`, wejście `{minVersion?: int ≥ 1, waitMs?: 0..5000}` (`.optional()`, zgodne z MCP). Oczekiwanie: `waitMs` albo 3000 ms, gdy podano `minVersion`, inaczej 0; najwyżej 5000. Rozmowa = rozmowa wykonania; bez rozmowy `unsupported_operation`.
- **`agent/tools/ui.ts`**: `ui_navigate` i `ui_filter` przekazują `uiVersion` z potwierdzenia (opisy narzędzi bez zmian — mniej konfliktów).
- **`agent/tools/context.ts`**: `get_context` zwraca `ui` (marker z chwili wysłania).
- **`agent/prompt.ts`**: w „Aktualny kontekst aplikacji” linia `- ekran przy wyslaniu polecenia: opis w wersji N (karta X), widok Y, adres Z` albo `(brak opisu)`; w „Sterowanie interfejsem” sekcja „## Stan ekranu”: po `ui_navigate`/`ui_filter`/`ui_sort` wywołaj `ui_state` z `minVersion = uiVersion` przed opisaniem ekranu, nie opisuj ekranu ze `stale=true`, `state=loading` → ponów z `minVersion = version + 1`, porównuj z wersją z kontekstu.
- **`agent/events.ts`** (poza zakresem, commit `05cfe10`): naprawa zgubionego wybudzenia w `RunEventStream.read` — patrz 6.1 i obawa 10.1.

### 1.4 Skryptowany model

- `e2e/support/scripted-agent.ts`: w kroku `call` napis `"$last.<ścieżka>"` w dowolnym miejscu `input` jest zastępowany wartością z wyniku poprzedniego kroku `ui` lub `call` (`LAST_RESULT`, `resolveLastResult`); brak wartości → `null` (walidacja narzędzia odrzuca wywołanie widocznie, zamiast po cichu pominąć pole). Krok `ui` wypisuje dodatkowo `uiVersion=N`.
- `e2e/support/scripted-server.ts`: scenariusze `ui-state-read`, `ui-state-after-filter` (`ui_state` → `call ui_filter` przez prawdziwy handler i bramkę → `ui_state {minVersion: '$last.uiVersion'}` → `get_context`), `ui-state-future-version` (`minVersion: 1_000_000, waitMs: 1500`), `ui-state-late` (8 s pracy, potem `ui_state`).

---

## 2. Decyzje tam, gdzie brief zostawił wybór

1. **Wersja nadawana przy złożeniu opisu, publikacja przy flush.** Wersja rośnie tylko przy zmianie treści; flush przed komendą i przed poleceniem publikuje bieżącą, więc numer w `uiVersion` i `AppContext.ui.version` jest numerem, który backend już ma (o ile publikacja zdążyła w limicie).
2. **Uspokojenie przed potwierdzeniem komendy** (`settleMs: 150`, najwyżej 1500 ms, także czekanie na wyjście instancji z `loading`). Bez tego po `navigate()` opis mógłby łączyć nowy adres ze starymi instancjami. Koszt: potwierdzenie przychodzi ≥ 150 ms później. Wolny odczyt (> 1,5 s) daje opis z `state: loading` — prompt każe wtedy czytać ponownie z `version + 1`.
3. **Wymagana wersja z kontekstu polecenia** (bez jawnego `minVersion`): opis tej samej karty starszy niż `AppContext.ui.version` jest `stale`/`older_than_requested`. Nie czeka domyślnie (reguła koordynatora: czekanie tylko przy `minVersion`/`waitMs`).
4. **Zapis wątku przed publikacją w `send`.** Biblioteka czatu wywołuje `send(threadId)` dla świeżo utworzonego wątku, zanim `ConversationSync` zapisze go w magazynie; opis z chwili wysłania nie miał rozmowy i pierwsze `ui_state` nowej rozmowy dawało `other_conversation` (potwierdzone próbą G). Ten sam zapis sprawia, że komenda UI z tego wykonania nie jest odrzucana jako `inactive_conversation` w tym oknie.
5. **Karty aktywnej przestrzeni** — *(zmienione w Fix round 1)* powłoka sama obserwuje aktywną przestrzeń, więc `cards` są znane na każdym ekranie (dodatkowy odczyt przestrzeni poza canvasem); `null` tylko przed pierwszym wczytaniem albo przy błędzie odczytu — nieznane nadal nie udaje pustego. Pierwotna wersja (tylko cache, bez pobierania) zależała od przypadkowej zawartości pamięci podręcznej (ustalenie I3 przeglądu).
6. **Kolejność pól wyniku** `{stale, reason, version, capturedAt, ageMs, snapshot}` — werdykt przed dużym opisem, czytelny w skróconym echu czatu i dla modelu.
7. **Wybór karty dla rozmowy**: karta z kontekstu polecenia, jeśli nadal pokazuje rozmowę; inaczej najpóźniej publikująca. `minVersion` stosowany do wybranej karty (wersje są per karta — obawa 10.3).
8. **Konflikt wersji → nowa tożsamość karty** zamiast zgadywania (zduplikowana karta dziedziczy `sessionStorage`).
9. **`flush` zawsze wysyła bieżącą wersję** (commit `bdc71e8`, znalezione w self-review): magazyn jest w pamięci, po restarcie backendu karta bez zmian ekranu nie publikowałaby nic i agent dostawałby `no_client` aż do zmiany ekranu. Publikacja z opóźnieniem nadal pomija niezmieniony opis. Po restarcie `ui_state` zwraca `no_client` do najbliższej publikacji: zmiany ekranu, wysłania polecenia albo potwierdzenia komendy.
10. **Naprawa `RunEventStream.read` zamiast obejścia w teście.** Obejście (krok `ui` zamiast `call ui_filter`) ukryłoby usterkę, na którą trafia ścieżka prawdziwego modelu (zdarzenia `PreToolUse`, a zaraz po nich komenda UI). Zmiana to jedna linia z testem regresji i próbą wykrycia — do decyzji koordynatora (obawa 10.1).

---

## 3. Zmienione pliki (3097586..bdc71e8: 33 pliki, +2278 / −9)

Kontrakty: `packages/platform-contracts/src/{ui-snapshot.ts (nowy), agent.ts, ui.ts, index.ts}`.
Serwer: `packages/platform-server/src/{services/ui-snapshots.ts (nowy), services/index.ts, http/app.ts, agent/tools/ui-state.ts (nowy), agent/tools/index.ts, agent/tools/ui.ts, agent/tools/context.ts, agent/prompt.ts, agent/events.ts}`.
UI: `packages/platform-ui/src/{state/uiSnapshot.ts (nowy), shell/UiSnapshotPublisher.tsx (nowy), shell/AppShell.tsx, shell/UiCommandRunner.tsx, state/appState.ts, chat/chatWiring.ts, api/client.ts, index.ts}`.
Testy: `tests/ui-snapshot.test.ts` (nowy, 26 testów), `e2e/ui-state.spec.ts` (nowy, 4 testy, port 8798, `.e2e-scripted-uistate`), `e2e/support/{scripted-agent.ts, scripted-server.ts}`; w istniejących testach: `ui: null` w literałach `AppContext` (`background-runs`, `contracts`, `platform-boundary`, `run-lifecycle`, `runtime`, `ui-navigation`, `view-filter`, `views-foundation`), `ui_state` na liście narzędzi (`views-foundation`) i liście czasowników `ui_*` (`ui-navigation`).
Nie edytowano: dokumentów koordynatora (G8), zależności (G7), `DataTable.tsx`, `views.ts`, `router.tsx`.

---

## 4. Polecenia, kody wyjścia, liczby testów (stan końcowy `bdc71e8`)

| Polecenie (w worktree) | Wynik |
|---|---|
| `pnpm verify` | **exit 0** — boundaries OK, „spójność: OK”, „Podsumowanie macierzy zgodne z tabelami.”, closure OK, typecheck, build, **Vitest 26 plików / 353 testy** (po T1: 25 / 327) |
| `pnpm exec vitest run tests/ui-snapshot.test.ts` | exit 0, **26/26** |
| `flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/ui-state.spec.ts e2e/view-filter.spec.ts e2e/ui-navigation.spec.ts e2e/scripted-call.spec.ts e2e/composed-views.spec.ts e2e/app.spec.ts e2e/access-context.spec.ts e2e/chat.spec.ts e2e/chat-drawer.spec.ts e2e/chat-layout.spec.ts e2e/session-restore.spec.ts e2e/background-tasks.spec.ts e2e/measurements.spec.ts e2e/streaming.spec.ts e2e/tool-activity.spec.ts` (po `pnpm verify`, czyli na świeżym buildzie `bdc71e8`) | **exit 0, 76 passed (3,7 min)**: ui-state 4, view-filter 7, ui-navigation 5, scripted-call 1, composed-views 4, app 14, access-context 3, chat 7, chat-drawer 6, chat-layout 4, session-restore 6, background-tasks 5, measurements 2, streaming 3, tool-activity 5 |
| ten sam zestaw na `5145ff8` (przed `bdc71e8`) | exit 0, 76 passed (3,9 min) |

Uruchomiłem wszystkie spece bez modelu, bo zmiana dotyka powłoki (publikator na każdym ekranie), wysyłania polecenia i potwierdzania komend UI. **Nie uruchomiono** `e2e/agent-ui.spec.ts` ani `e2e/files-agent.spec.ts` (prawdziwy model — Task 8) ani `pnpm check:module-swap` (kontrakt modułu i warstwa składania bez zmian). Po przebiegach usunięto nieśledzone `docs/evidence/chat-ux-2026-09-16/` i `docs/evidence/closure-2026-09-15/` wygenerowane przez istniejące spece; drzewo czyste.

### 4.1 Co pokrywają testy

`tests/ui-snapshot.test.ts` (test kontraktu lub logiki; jeden test to symulacja):
- **Kontrakt**: wersja ≥ 1 i całkowita, format `clientId`, `capturedAt`, `url` ≤ 2000, 30 instancji tak / 31 nie, 50 kart tak / 51 nie, niespójny opis instancji odrzucony; `compositionVersionOf` stabilne i rozróżniające; `AppContext.ui` domyślnie `null`, wersja 0 odrzucona; `uiVersion` opcjonalne, 0 odrzucone.
- **Budowa opisu** (na prawdziwych celach i widokach modułu z harnessu): cel `procurement.data`, widok z `compositionVersionOf(composition)`, karty `openui` i `component`, akcje `navigate, filter, sort`; `/files` → cel widoku, `view: null`, tylko `navigate`, `cards: null`; karty innej przestrzeni w cache → `null`; ekran bez ścieżki katalogu → widok z `viewId` instancji; 34 instancje → 30 + `instancesOmitted: 4`; opis ponad limit bajtów traci instancje od końca i mieści się w limicie.
- **Sesja karty**: ta sama treść = ta sama wersja, zmiana = +1, przeładowanie kontynuuje licznik tej samej tożsamości; zmiana zalogowanego = nowa wersja; publikacja z opóźnieniem jedna na serię zmian, publikacje po kolei (wersja 2 czeka na 1), flush zwraca przyjętą wersję, `contextMarker`; flush po timeoucie `null`; konflikt → nowa tożsamość, wersja 1; `sessionStorage` rzucający wyjątki → tożsamość w pamięci; **restart backendu (nowy magazyn) → flush publikuje tę samą wersję ponownie**.
- **HTTP**: publikacja i odczyt po rozmowie i po karcie; **drugi właściciel** nie czyta (po rozmowie `no_client`, po karcie `null`), ten sam `clientId` u innego właściciela to inna karta, pierwszy właściciel dalej czyta swoją wersję 3, narzędzie drugiego właściciela nic nie dostaje; 401 bez sesji, 400 `invalid_snapshot` / zły JSON / `too_large`, 409 `version_not_newer` (też ta sama wersja z inną treścią), 200 dla ponowienia tej samej; GET bez parametrów 400.
- **`ui_state`**: `no_client`; `other_conversation` (karta w innej rozmowie, karta z nową niezapisaną rozmową, karta, która odeszła z rozmowy); świeży opis; `minVersion` czeka na publikację (≥ 100 ms, < 2 s) i zwraca nowszą wersję z nowym filtrem; po `waitMs` `stale: true`, `older_than_requested`, starszy opis, niezwiązane publikacje nie kończą czekania; bez `minVersion` odpowiedź natychmiast; pierwszeństwo karty z kontekstu i dolna granica z `AppContext.ui.version`; `effect: read`, `alwaysLoad`, zgodność z MCP, `waitMs` > 5000 odrzucone.
- **`AppContext.ui` w wykonaniu** (symulacja: `AgentRuntime` + `scriptedAgent`, kontekst parsowany jak w `POST /api/agui/run`): `get_context` zwraca marker, `ui_state` ocenia opis wersji 6 jako starszy niż marker 7; prompt zawiera linię ekranu i zasadę odczytu po akcji (i `(brak opisu)` bez markera).
- **`uiVersion` w potwierdzeniu**: `ui_filter` i `ui_navigate` przez prawdziwą bramkę runtime i `POST /api/runs/:id/ui-ack` zwracają `uiVersion` 11 i 12.
- **Strumień wykonania**: czytelnik zajęty poprzednim zdarzeniem dostaje następne bez kolejnej emisji.
- **`$last.`**: podstawienie ścieżki, zagnieżdżenie, brak → `null`.

`e2e/ui-state.spec.ts` (symulacja: GUI + skryptowany model; dane porównywane z `POST /api/read`, wynik agenta z zapisanymi wynikami narzędzi `GET /api/threads/get/:id`):
- **(a)** wejście na link `/data?country=PL` → na ekranie 3 wiersze, identyfikatory = `/api/read` zawężone do PL; opublikowany opis: `target procurement.data`, `view` z tytułem z `GET /api/ui/views` i `compositionVersion` z **niezależnej implementacji FNV w teście**, akcje `navigate, filter, sort`, jedna instancja `DataTable` (`viewId`, `source`, `ready`, `record supplier/id`, `matched 3`, `total 4`), pola w kolejności kompozycji z etykietami deskryptora (literał „Kraj”), predykat `country eq PL`, `visibleRecordIds` = backend, bez fińskiego dostawcy; potem polecenie w GUI → w czacie `[call:ui_state] {"stale":false,"version":`, a zapisany wynik: ta sama karta, rozmowa wykonania, wersja ≥ opublikowanej, ten sam widok, filtr i rekordy.
- **(b)** polecenie w GUI na `/data` → na ekranie 3 wiersze i licznik „3 z 4”; wyniki: `ui_state` przed (bez filtra, 4), `ui_filter` przez prawdziwy handler i bramkę (`executed`, `filtered 3/4`, `uiVersion` > wersji przed), `ui_state {minVersion: uiVersion}` (`stale: false`, wersja ≥ `uiVersion`, adres z `country=PL`, filtr PL, `visibleRecordIds` = backend = wiersze w DOM), `get_context.ui` (ta karta, `procurement.data`, wersja ≤ „przed” i < `uiVersion`); **kolejne polecenie** po ustabilizowaniu opisu → `get_context.ui.version` równe wersji opublikowanej w chwili wysłania (≥ `uiVersion`), adres z `country=PL`.
- **(c1)** `minVersion` wyższe niż jakakolwiek publikacja → w czacie `{"stale":true,"reason":"older_than_requested"`, zwrócony starszy opis tej karty, serwer nie ma takiej wersji, wykonanie trwało ≥ 1500 ms (czekało).
- **(c2)** wykonanie rozmowy A, gdy przeglądarka pokazuje B (utworzoną przez API, otwartą adresem) → wynik `ui_state` dokładnie `{stale: true, reason: 'other_conversation', version: null, capturedAt: null, ageMs: null, snapshot: null}`; po powrocie do A odmowa widoczna w czacie.

---

## 5. Kontrole negatywne i próby zdolności wykrycia

Każda próba: kluczowa linia chwilowo wycofana (bez commitu), test uruchomiony, plik przywrócony `git checkout -- <plik>` (lub kopią), test ponownie zielony; dla prób w przeglądarce — przebudowa przed i po. Po wszystkich próbach `git status` czysty, końcowe przebiegi z sekcji 4 są na przywróconym kodzie.

| # | Wycofana linia | Polecenie | Wynik z wycofaniem |
|---|---|---|---|
| A | `ui-snapshots.ts` `evaluate`: opis najnowszej karty właściciela bez względu na rozmowę | `pnpm exec vitest run tests/ui-snapshot.test.ts` | **4 failed / 21 passed**: „drugi wlasciciel nie odczyta…”, „no_client, other_conversation…”, „minVersion po przekroczeniu czasu…”, „karta, z ktorej wyslano polecenie…” |
| B | `ui-snapshots.ts`: `const older = false` (bez porównania z `minVersion` i kontekstem) | jw. | **4 failed / 21 passed**: „minVersion czeka…”, „minVersion po przekroczeniu czasu…”, „karta, z ktorej wyslano…”, „wykonanie dostaje marker ekranu…” |
| C | `ui-snapshots.ts`: wersja nie nowsza przyjmowana (`if (false && …)`) | jw. | **1 failed / 24 passed**: „odmowy: … wersja nie nowsza 409 …” |
| D | `ui-snapshots.ts`: jeden wspólny magazyn dla wszystkich właścicieli | jw. | **1 failed / 24 passed**: „drugi wlasciciel nie odczyta ani nie nadpisze opisu pierwszego” |
| E | `uiSnapshot.ts` `capture`: każde złożenie to nowa wersja | jw. | **2 failed / 23 passed**: „nowa wersja tylko przy istotnej zmianie…”, „publikacja z opoznieniem i flush…” |
| J | `uiSnapshot.ts` `flush` bez ponownego wysłania (`#publishCurrent()`) | jw. | **2 failed / 24 passed**: `expected [ 1, 2 ] to deeply equal [ 1, 2, 2 ]`; restart: `expected { stale: true, … } to match object { stale: false, version: 1 }` |
| S | `events.ts`: bez `if ((this.#buffer.at(-1)?.seq ?? 0) > cursor) continue;` | `pnpm exec vitest run tests/ui-snapshot.test.ts -t "strumien"` | **1 failed**: `expected false to be true` (drugie zdarzenie nie dotarło w 500 ms) |
| F | `UiCommandRunner.tsx`: bez publikacji przed potwierdzeniem (`if (false && …)`) | `pnpm build` + `flock … playwright test e2e/ui-state.spec.ts -g "po ui_filter"` | **1 failed**: linia 219 `expect(filtered.uiVersion).toBeGreaterThan(before.version)` — `Received has value: undefined` |
| H | `appState.ts`: `ui: null` zamiast markera | jw. | **1 failed**: linia 236 `TypeError: Cannot read properties of null (reading 'clientId')` (`get_context.ui` puste) |
| G | `chatWiring.ts`: bez zapisu `threadId` przed publikacją | `pnpm build` + `… -g "zawezony link\|wyzsze niz"` | **1 failed** (test a, 17,9 s): w czacie `[call:ui_state] {"stale":true,"reason":"other_conversation",…}` zamiast `{"stale":false,"version":` — potwierdza wyścig nowego wątku z 2.4 |
| I | jak A, w serwerze scenariuszowym (źródła TS) | `… -g "other_conversation"` | **1 failed**: linia 311 `toEqual` — oczekiwane 6 pól, otrzymany pełny opis ekranu rozmowy B (+82 linie) |

Kontrole negatywne zawarte w samych testach: `no_client`, `other_conversation` (Vitest i GUI), `older_than_requested` po czekaniu (Vitest i GUI), wersja z kontekstu jako dolna granica, drugi właściciel (odczyt i nadpisanie), 401/400/409, limit rozmiaru, limit instancji i kart, `waitMs` > 5000, brak rozmowy wykonania, brak wartości `$last.` → błąd walidacji.

---

## 6. Nieudane przebiegi (poza celowymi próbami z sekcji 5)

1. **`pnpm typecheck`** (pierwszy po zmianie kontraktu): 15 błędów `Property 'ui' is missing` w `appState.ts` i literałach `AppContext` w testach — oczekiwany skutek nowego pola; dodano `ui` w `toAppContext` i `ui: null` w literałach.
2. **`vitest run tests/ui-snapshot.test.ts`** (pierwszy): **1 failed / 23 passed** — test `uiVersion` w potwierdzeniu: drugie potwierdzenie `{accepted: false}` po 2 s. Diagnoza: harness czekał na odpowiedź HTTP wewnątrz pętli `for await (… stream.read())`, a `RunEventStream.read` nie widzi zdarzenia wyemitowanego w tym czasie (zgubione wybudzenie). Najpierw obejście w teście; po potwierdzeniu tej samej usterki w przeglądarce (pkt 4) — naprawa w `events.ts` i przywrócenie czekania w pętli.
3. **`pnpm typecheck`**: `.then` na `Promise<Response> | Response` w teście (błąd kodu testu) — owinięte w `Promise.resolve`; później ten kod usunięty.
4. **`playwright test e2e/ui-state.spec.ts`** (pierwszy): **1 failed / 1 passed / 2 did not run** — test (b): `ui_filter` → `{"executed":false,"reason":"no_client"}` po 8 s, choć przeglądarka zawęziła widok (komenda dotarła dopiero przy zamknięciu strumienia), a `$last.uiVersion` → `null` → `validation_failed` w `ui_state` (odczytane z bazy `.e2e-scripted-uistate/app.db`). **Usterka produkcyjna** w `RunEventStream.read` (commit `05cfe10`).
5. **`playwright test e2e/ui-state.spec.ts`** (drugi): **1 failed / 1 passed / 2 did not run** — test (b) na `toContainText('"uiVersion":2')`: czat zwija wcześniejsze wywołania narzędzi w oś „Behind the scenes” i pokazuje tylko ostatni segment. **Wada testu**; zamieniona na widoczny licznik „3 z 4” i końcowy tekst odpowiedzi. Trzeci przebieg: 4 passed.
6. **`pnpm verify`** (pierwszy): **exit 1**, `tests/ui-navigation.test.ts` „pokazanie ustawienia nie ma zadnej operacji zmiany wartosci” — strażnik dokładnej listy czasowników `ui_*`; dopisany `ui_state` z uzasadnieniem (tylko odczyt), commit `5145ff8`. Kolejny przebieg exit 0.

---

## 7. Kontrakt dla autora modułu

Moduł **nie deklaruje nic nowego**. Opis ekranu powstaje z tego, co już deklaruje, więc warto wiedzieć, co z czego wynika:

- **Cel i widok**: opis ma `target`, gdy ekran jest trasą celu `UiTarget.to` (dokładna ścieżka, bez parametrów). `view` pojawia się, gdy istnieje `ViewDefinition` o `id` celu, albo — na ekranie bez ścieżki katalogu (ekran rekordu `/things/{id}`) — gdy zamontowane komponenty danych mają `viewId` widoku (renderowane przez `ComposedView`). Ekran modułu pisany zwykłym Reactem, bez `ComposedView` i komponentów danych, ma w opisie tylko `target` (jeśli jest) i `url`: `view: null`, `instances: []`.
- **Wersja kompozycji**: `compositionVersionOf(composition)`; każda zmiana źródła kompozycji zmienia `compositionVersion`.
- **Akcje widoku**: `filter` tylko gdy cel deklaruje `filter`; `sort` tylko gdy widok celu ma `primaryOperation`; `navigate` zawsze. Akcje instancji (`filter`, `open_record`) — jak w T1.
- **Instancje**: tylko komponenty rejestrujące opis w `uiSemantics` (`DataTable`, `DataChart`, `DataSummary`, albo własny komponent przez `useDescribeInstance` z opisem zgodnym z `semanticInstanceSchema`). Najwyżej 30 w opisie (reszta w `instancesOmitted`), opis ≤ 256 kB.
- **Karty**: `cards` przestrzeni aktywnej (`kind`, `component` albo `openui`, `specVersion`) — na każdym ekranie, bo powłoka sama obserwuje aktywną przestrzeń (po Fix round 1); `null` tylko przed pierwszym wczytaniem albo przy błędzie odczytu przestrzeni. Cel i widok nie zależą od tego, czy ekran używa komponentów danych: katalog celów i definicje widoków obserwuje powłoka. *(Poprawione w Fix round 1 — wcześniej zapis sugerował, że karty i widok zależą od tego, co akurat jest w pamięci podręcznej.)*
- **Dla konsumentów platformy (narzędzia, testy)**: `ui_state {minVersion?, waitMs? ≤ 5000}` → `{stale, reason?, version, capturedAt, ageMs, snapshot}`; `reason` ∈ `no_client` (brak opisu u właściciela, także po restarcie backendu do najbliższej publikacji), `other_conversation` (żadna karta nie pokazuje rozmowy wykonania — opis innej rozmowy nie jest wydawany), `older_than_requested` (zwrócony starszy opis). `uiVersion` w wyniku `ui_navigate`/`ui_filter` (i nowych komend UI — patrz 10.7). `AppContext.ui = {version, clientId, viewId, url} | null`. `PUT /api/ui/snapshot`: 400 `details.reason` ∈ `too_large | invalid_json | invalid_snapshot`, 409 `version_not_newer` (`details.current`). `GET /api/ui/snapshot?conversationId=[&minVersion=]` albo `?clientId=` — tylko własne karty.

---

## 8. Szwy dla innych zadań

- **Task 2** (`ui_sort`, paginacja): wynik `ui_sort` powinien przekazać `uiVersion: result.uiVersion` jak `ui_navigate`/`ui_filter`; `sort`/`page` instancji trafią do opisu same (rejestr); prompt już wymienia `ui_sort` w zasadzie odczytu `ui_state`.
- **Task 4** (widoki agenta): `compositionVersionOf` do wersji kompozycji; karty `openui` przestrzeni rozmowy trafią do `cards`, gdy powłoka ma tę przestrzeń jako `spaceId` i ją wczytała.
- **Task 6/8**: `ui_state` + `$last.uiVersion` w skryptach; `GET /api/ui/snapshot` do asercji.

---

## 9. Self-review — ustalenia

- Znalezione i poprawione w trakcie: brak ponownej publikacji po restarcie backendu (commit `bdc71e8`, próba J); wyścig nowego wątku w `send` (próba G); zgubione wybudzenie strumienia (próba S); publikacje równoległe mogłyby przyjść w odwrotnej kolejności i wywołać fałszywy konflikt → łańcuch publikacji; po konflikcie nowszy, jeszcze nieopublikowany opis przechodzi na nową tożsamość.
- Filtr zdarzeń publikatora: magazyn powłoki zmienia się przy każdym fragmencie odpowiedzi, a cache przy każdym obserwatorze — publikator reaguje tylko na `conversationId`/`spaceId` i zdarzenia danych `ui-targets|ui-views|canvas`, a i tak nowa wersja powstaje tylko przy zmianie treści.
- Granica platforma–domena: `check:boundaries` OK; w platformie brak słownika domeny (przykłady w testach i specach są poza pakietami platformy).
- G9: `compositionVersionOf` jedna (test e2e używa niezależnej wyroczni celowo); `ui_state` i `GET /api/ui/snapshot` używają tej samej `evaluate`.
- G1/G4: pracowałem wyłącznie w worktree; Playwright tylko pod blokadą ze wskazanymi plikami; baza testowa odczytywana `sqlite3` wyłącznie z `.e2e-scripted-uistate/app.db`.
- Zaobserwowane przy okazji, **nie naprawione** (poza zakresem): ponowne zawężenie identycznym filtrem daje `not_applied` — drugie `ui_filter country=PL` w teście (b) zwróciło `{"executed":false,"reason":"not_applied",…}` (baza testu). `setAgentFilterKey` zeruje `filterOutcome`, a `DataTable` nie raportuje ponownie niezmienionego wyniku. Istniało przed tym zadaniem; obszar Taska 2.

---

## 10. Obawy

1. **Zmiana poza zakresem: `packages/platform-server/src/agent/events.ts`** (`05cfe10`, 1 linia + komentarz). `RunEventStream.read` po obsłużeniu migawki czekał na wybudzenie, choć w buforze leżało zdarzenie wyemitowane podczas obsługi poprzedniego (np. `await sse.writeSSE`). Komenda UI nie ma następcy aż do potwierdzenia, więc może utknąć do timeoutu 8 s (`no_client`), a przeglądarka wykonuje ją dopiero przy zamknięciu strumienia. W przeglądarce wystąpiło deterministycznie dla `ui_filter` wywołanego przez handler zaraz po zdarzeniach `PreToolUse`; w produkcji zależy od czasów MCP (dotychczasowe próby na prawdziwym modelu przechodziły). Proszę o decyzję, czy zostaje w tym zadaniu, czy idzie osobno.
2. **Karta zamknięta i przełączenie tożsamości**: brak sygnału życia karty — ostatni opis zamkniętej karty zostaje (do 20 nowszych kart), `ageMs` rośnie, ale `stale` pozostaje `false`. Po przełączeniu tożsamości w karcie stary właściciel zachowuje jej ostatni opis ze swoją rozmową.
3. **Wiele kart w tej samej rozmowie**: wersje liczą się per karta; `uiVersion` pochodzi od karty, która pierwsza potwierdziła komendę, a `ui_state` wybiera kartę z kontekstu polecenia albo najpóźniej publikującą. Gdy to różne karty, `minVersion` porównuje liczniki różnych kart.
4. **Restart backendu**: `no_client` do najbliższej publikacji (zmiana ekranu, wysłanie polecenia, potwierdzenie komendy).
5. **Opóźnienia**: potwierdzenie komendy UI ≥ 150 ms później (do 1,5 s przy ładowaniu, publikacja do 2 s); wysłanie polecenia czeka na publikację do 1,5 s przy wolnym backendzie.
6. **Opis po powolnym odczycie** może mieć instancję `loading` (limit uspokojenia 1,5 s) — prompt każe czytać ponownie z `version + 1`; nie sprawdzone na prawdziwym modelu.
7. **Scalanie**: konflikty spodziewane w `tests/views-foundation.test.ts` (lista narzędzi) i `tests/ui-navigation.test.ts` (lista `ui_*`) z `ui_sort` Taska 2, w `UiCommandRunner.tsx`, `scripted-agent.ts`/`scripted-server.ts` (nowe scenariusze), w literałach `AppContext` w testach (`ui: null`). Nowe komendy UI Taska 2 muszą przekazać `uiVersion`. Prompt wymienia `ui_sort`, którego w tej gałęzi jeszcze nie ma.
8. **Rodzaj dowodu**: zachowanie agenta potwierdzone symulacją (skryptowany model z prawdziwymi handlerami); to, czy prawdziwy model stosuje zasadę „`ui_state` z `minVersion` przed opisem ekranu”, jest do sprawdzenia w Tasku 8.
9. ~~`cards` tylko z cache~~ — *nieaktualne od Fix round 1*: powłoka wczytuje aktywną przestrzeń na każdym ekranie; `cards: null` tylko przed pierwszym wczytaniem albo przy błędzie odczytu. Kosztem jest dodatkowy odczyt przestrzeni poza canvasem (obawa 4 w Fix round 1).

---

## Fix round 1 (po przeglądzie: „Needs fixes”)

Commity: `59aa919` — Poprawki po przegladzie T3: dlugi adres, wersja przypisana do karty, zamkniete karty, pamiec podreczna, wspolny budzet potwierdzenia; `666f789` — Test karty potwierdzajacej: zamknieta karta potwierdzajaca nie oddaje wersji karcie o wiekszym liczniku (bdc71e8..666f789: 20 plików, +1200 / −175). Poprawka `events.ts` (`05cfe10`) zostaje w zadaniu zgodnie z decyzją koordynatora.

### Zmiany wg ustaleń

**I1 — adres dłuższy niż 2000 znaków.**
- Kontrakt (`ui-snapshot.ts`): `UI_URL_MAX_LENGTH = 2000`, wspólna `clampUiUrl(url) → {url, urlTruncated}`; snapshot ma wymagane `urlTruncated: boolean`; `AppContext.ui.urlTruncated?: boolean`.
- Klient: `buildUiSnapshotContent` skraca adres i ustawia flagę; `contextMarker()` skraca ponownie (marker nigdy nie unieważnia polecenia) i dopisuje `urlTruncated: true`, gdy adres ucięto.
- Serwer: `parseRunAppContext(raw)` (kontrakty, `agent.ts`) — gdy wszystkie błędy walidacji dotyczą `ui`, kontekst przechodzi z `ui: null`, a powody wracają do wywołującego; każdy inny błąd kontekstu nadal odrzuca. `POST /api/agui/run` używa go, loguje `console.warn('[agui/run] pominiety znacznik ekranu AppContext.ui: …')` i ustawia nagłówek `X-Ui-Context-Rejected: 1`; agent widzi wtedy „(brak opisu)”.
- Odrzucone publikacje nie giną po cichu: `flush()` zwraca `UiPublication` = `published {snapshot}` | `rejected {code}` | `timeout` *(stan z rundy 1; od Fix round 2 także `unreachable` i `not_described`, a `rejected` oznacza wyłącznie odmowę backendu)*; odmowa (inna niż `conflict`, który zmienia tożsamość) jest zgłaszana (`console.error` z wersją, kodem, komunikatem i `details`) i zapamiętana w `session.lastRejection()`; potwierdzenie komendy niesie `uiPublication: 'rejected'`.

**I2 — świeżość związana z konkretną, żywą kartą.**
- Potwierdzenie (`uiCommandResultSchema`) i wyniki `ui_navigate`/`ui_filter` niosą `uiVersion`, **`uiClientId`** i **`uiPublication`** (`published | timeout | rejected | skipped`; *od Fix round 2 także `unreachable | not_described`*). `uiClientIdSchema` przeniesiony do `ui.ts` (bez cyklu importów).
- `ui_state` przyjmuje `clientId?`. Reguła w `UiSnapshotStore.evaluate`: **`minVersion` zawsze liczy się na liczniku jednej karty** — `clientId`, a gdy go nie podano: karty, która potwierdziła ostatnią komendę UI tego wykonania (runtime zapamiętuje `{clientId, version}` z potwierdzenia per `runId`, `recordAcknowledgement`; zapomina po zakończeniu wykonania), a w ostateczności karty z kontekstu polecenia. Ta karta zamknięta/nieznana → `client_gone`; pokazuje inną rozmowę → `other_conversation`; żadna inna karta z większym licznikiem jej nie zastępuje. Bez wymaganej wersji wybór: karta potwierdzająca lub wysyłająca (jeśli pokazuje rozmowę i żyje) → najpóźniej publikująca żywa karta tej rozmowy → najpóźniejsza milcząca (zwrócona z `client_inactive`). Indeks rozmowa → karta zastąpiony przeglądem kart właściciela w kolejności publikacji (≤ 20 kart).
- Zamknięte karty: publikator na `pagehide` woła `session.closing()` → `DELETE /api/ui/snapshot?clientId=&version=` z `keepalive`; serwer wycofuje opis tylko, gdy zapisana wersja ≤ podanej (przeładowana karta mogła już opublikować następną). `pageshow` z bfcache → ponowna publikacja.
- Żywotność: `POST /api/ui/snapshot/alive {clientId, version}` co `UI_CLIENT_HEARTBEAT_MS = 15 s` (i od razu po powrocie karty na wierzch) → `{known}`; `known: false` (restart, wycofanie) → karta publikuje ponownie. Karta bez publikacji ani heartbeatu dłużej niż `UI_CLIENT_INACTIVE_AFTER_MS = 90 s` (np. zamknięta bez `pagehide`, przelogowana na innego właściciela) → `stale: true, reason: 'client_inactive'` z jej opisem. 90 s, bo przeglądarki spowalniają timery kart w tle do ok. 1/min. Heartbeat i ponowienie tej samej wersji budzą oczekujących w `waitFor`.
- `UI_STATE_REASONS` rozszerzone o `client_gone`, `client_inactive`; opis narzędzia i prompt mówią, że wersja bez karty nic nie znaczy i że brak `uiVersion` (`uiPublication ≠ published`) trzeba zgłosić.

**I3 — opis niezależny od przypadkowej zawartości pamięci podręcznej.**
- Korekta przesłanki: katalog celów był obserwowany na każdym ekranie przez `ViewFilterBanner` → `useActiveViewFilter()` → `useUiTargets()` (ekran `/settings` miał więc `target`; potwierdza to próba G-I3b niżej). Przypadkowe zależności to **definicje widoków** (obserwowane tylko przez `ComposedView`) i **karty aktywnej przestrzeni** (tylko przez `CanvasHost`; po opuszczeniu canvasu i `gcTime` zdarzenie `removed` dawało nową wersję z `cards: null`).
- `UiSnapshotPublisher` obserwuje `useUiTargets()`, `useViewDefinitions()` i `useCanvasState(spaceId)` — zapytania powłoki są zawsze wczytane i nie podlegają GC, dopóki powłoka jest zamontowana (dodatkowy odczyt aktywnej przestrzeni na ekranach innych niż canvas).
- Źródło opisu wydzielone do `shell/snapshotSource.ts` (`createShellSnapshotSource`): pamięta ostatnio widziany katalog, widoki i przestrzeń **dla bieżącego właściciela** i używa ich, gdy wpisu chwilowo nie ma w pamięci — wyrzucenie wpisu nie jest zmianą ekranu i nie tworzy wersji; zmiana właściciela porzuca zapamiętane.
- Poprawiono linię w sekcji 7 („Kontrakt dla autora modułu”, punkt „Karty”).

**R1 — wspólny budżet potwierdzenia.**
- Kontrakty (`ui.ts`): `UI_COMMAND_ACK_TIMEOUT_MS = 8000` (domyślny timeout `AgentRuntime.requestUiCommand`) i `UI_COMMAND_ACK_MARGIN_MS = 1000` (dostarczenie komendy i POST potwierdzenia).
- `shell/uiCommandAck.ts` → `performAndAcknowledge(command, {perform, session, post, budgetMs?, marginMs?})`: termin = odbiór + budżet − margines, liczony raz przy odbiorze; `perform` dostaje `{deadline}` (miejsce na oczekiwania Taska 6); uspokojenie ≤ min(1500 ms, połowa pozostałego czasu), publikacja do terminu (`flush({deadlineAt})`); < 100 ms zapasu → bez publikacji. Gdy budżet się kończy, potwierdzenie idzie bez `uiVersion`, jawnie `uiPublication: 'timeout'`. `UiCommandRunner` deleguje do tej funkcji (idempotencja po `commandId` bez zmian).

### Testy

`tests/ui-snapshot.test.ts` 26 → **38** (test kontraktu lub logiki; test karty potwierdzającej to symulacja: `AgentRuntime` + `scriptedAgent` z prawdziwymi handlerami):
- I1: skracanie adresu w opisie i markerze + zgodność ze schematami; `parseRunAppContext` (zły `ui` → `null` z powodem, inne błędy nadal rzucają); **`POST /api/agui/run`** na platformie ze skryptowanym modelem z markerem o adresie ~8000 znaków → 200, `X-Ui-Context-Rejected: 1`, `RUN_FINISHED`, `get_context.ui === null`, ostrzeżenie; odrzucona publikacja → `rejected`, `lastRejection`, zgłoszenie.
- I2: **dwie karty** w jednej rozmowie — X (wysyłająca, licznik 40) i Y (licznik 3); Y potwierdza `ui_filter` wersją 4, zanim ta dotrze do backendu → `ui_state {minVersion: $last.uiVersion}` bez karty: `older_than_requested`, opis Y w wersji 3 (nie X-40 `stale:false`); po publikacji `{minVersion: 4, clientId: Y}` → świeży opis Y; po zamknięciu Y `{minVersion: 4}` → `client_gone` (nie X-40); nieznana karta → `client_gone`; po wykonaniu potwierdzenie zapomniane. DELETE: wersja starsza niż zapisana nie wycofuje, bieżąca wycofuje (`no_client`, `client_gone`), 400 bez wersji, obcy właściciel nie wycofa. Żywotność (zegar `Date` sfałszowany): świeża przed limitem, heartbeat podtrzymuje, heartbeat złej wersji `false`, po limicie `client_inactive` z opisem, żywa karta ma pierwszeństwo przed milczącą nadawcą; `POST …/alive` (`known`, 400). Sesja: heartbeat z `known:false` publikuje ponownie, `closing()` wycofuje bieżącą wersję.
- I3: `createShellSnapshotSource` na prawdziwym `QueryClient` — po `removeQueries` katalogu i widoków ta sama wersja i ten sam cel `platform.settings`; po zmianie właściciela nowa wersja bez celu.
- R1: **prawdziwa bramka runtime** z budżetem 900 ms, `perform` 250 ms, publikacja wisząca → wynik `executed: true`, `uiPublication: 'timeout'`, bez `uiVersion`/`uiClientId`, przed budżetem (nie `no_client`); statusy `published` (z kartą), `rejected`, `skipped` (bez flush); serwer czeka dokładnie `UI_COMMAND_ACK_TIMEOUT_MS` (sztuczne timery).

`e2e/ui-state.spec.ts` 4 → **7** (symulacja):
- (b) rozszerzony: `ui_filter` zwraca `uiClientId` tej karty i `uiPublication: 'published'`; `ui_state` dostaje `clientId: $last.uiClientId`.
- **nowy I1**: link `/data?country=` z 40 wartościami po 200 znaków (adres > 2000), widok `empty`; polecenie z kompozytora przechodzi (`[call:ui_state] {"stale":false,"version":` w czacie); pełny opis z `GET /api/ui/snapshot?conversationId=` — ta karta, `urlTruncated: true`, adres 2000 znaków, instancja `empty`/`matched 0` z pełnym filtrem 40 wartości. (Zapisany wynik narzędzia jest skracany przez runtime do 4000 znaków — z niego tylko werdykt i wersja.)
- **nowy I3**: karta otwarta wprost na `/settings` → opis `target platform.settings`, `view: null`, `instances: []`, `actions: ['navigate']`; `/data?s=<przestrzeń>` bez wizyty na canvasie → `cards` równe `GET /api/canvas/spaces/:id`.
- **nowy I2 (zamknięta karta)**: wykonanie w A; karta wysyłająca przechodzi do nowej rozmowy; druga strona tego samego kontekstu przeglądarki otwiera A, publikuje, zostaje zamknięta (`page.close()`) → `GET ?clientId=` zwraca `null`; `ui_state` wykonania → dokładnie `other_conversation` z pustym opisem.

### Polecenia i wyniki

| Polecenie | Wynik |
|---|---|
| `pnpm exec vitest run tests/ui-snapshot.test.ts` | exit 0, **38/38** |
| `pnpm build` + `flock … playwright test e2e/ui-state.spec.ts` | exit 0, **7 passed** (1,1 min) |
| `pnpm verify` (na `666f789`) | **exit 0** — spójność OK, macierz zgodna, typecheck, build, **Vitest 26 plików / 365 testów** |
| `flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/ui-state.spec.ts e2e/ui-navigation.spec.ts e2e/view-filter.spec.ts e2e/chat.spec.ts e2e/session-restore.spec.ts e2e/background-tasks.spec.ts e2e/scripted-call.spec.ts` (po `pnpm verify`) | **exit 0, 38 passed (3,0 min)**: ui-state 7, ui-navigation 5, view-filter 7, chat 7, session-restore 6, background-tasks 5, scripted-call 1 |

Poza żądanymi dodałem `background-tasks` (przełączanie rozmów i przeładowania przy `pagehide`/heartbeacie) i `scripted-call` (zmiana skryptowanego agenta). Po przebiegach usunięto nieśledzone `docs/evidence/chat-ux-2026-09-16/`; drzewo czyste.

### Próby zdolności wykrycia (wycofanie bez commitu → test → `git checkout -- <plik>` → zielono)

| Próba | Wycofanie | Test | Wynik z wycofaniem |
|---|---|---|---|
| T1a (I1) | `clampUiUrl` bez skracania | Vitest `tests/ui-snapshot.test.ts` | **1 failed / 37**: „opis i marker polecenia skracaja adres…” |
| T1b (I1) | `parseRunAppContext` bez tolerancji `ui` | jw. | **2 failed / 36**: „zly znacznik ekranu nie odrzuca polecenia…”, „POST /api/agui/run ze zlym znacznikiem…” |
| T1c (I1) | odrzucenie bez zapamiętania i zgłoszenia | jw. | **1 failed / 37**: „odrzucona publikacja nie ginie po cichu…” |
| T2a (I2) | `minVersion` wiązany tylko z jawnym `clientId` | jw. (po rozszerzeniu testu, patrz „Nieudane”) | **1 failed / 37**: „wersja z potwierdzenia jest liczona na karcie, ktora potwierdzila…” — `expected { stale: false, version: 40, … } to match object { stale: true, … }` |
| T2b (I2) | `retire` nie usuwa opisu | jw. | **1 failed / 37**: „karta zamykana wycofuje opis (DELETE)…” |
| T2c (I2) | brak reguły bezczynności | jw. | **1 failed / 37**: „karta milczaca dluzej niz limit jest client_inactive…” |
| T3a (I3) | źródło bez pamięci ostatnio widzianych danych | jw. | **1 failed / 37**: „wyrzucenie katalogu i widokow z pamieci nie zmienia opisu ani wersji…” |
| R1 | `performAndAcknowledge` z dawnymi limitami (1500 ms / 2000 ms, bez terminu) | jw. | **1 failed / 37**: „wolna publikacja nie zamienia wykonanej komendy w no_client…” (916 ms) |
| G-I1 | `clampUiUrl` bez skracania | `pnpm build` + `flock … playwright test e2e/ui-state.spec.ts -g "bardzo dlugi"` | **1 failed**: w czacie `[call:ui_state] {"stale":true,"reason":"no_client",…}` (publikacja odrzucona 400; polecenie przeszło dzięki tolerancji serwera) |
| G-I2 | publikator bez `closing()` na `pagehide` | `… -g "zamknieta karta"` | **1 failed**: linia 375 `toBeNull()` — `GET ?clientId=` zamkniętej karty nadal zwraca jej opis rozmowy A |
| G-I3a | publikator bez `useCanvasState(spaceId)` | `… -g "wprost na ekranie"` | **1 failed**: linia 343 `cards` — oczekiwane 3 karty przestrzeni, otrzymane `null` |
| G-I3b | publikator bez `useUiTargets()` | jw. | **passed** — kontrola: katalog obserwuje też `ViewFilterBanner`, więc `/settings` ma cel i bez tej linii (potwierdza korektę przesłanki I3) |

Po próbach `git status` czysty, `pnpm build` na przywróconym kodzie; bramka i spece z tabeli wyżej uruchomione po próbach.

### Nieudane przebiegi w tej rundzie

1. `vitest run tests/ui-snapshot.test.ts` (po zmianie typu wyniku `flush`): skrypt adaptujący testy przerwał się na własnym błędnym wpisie (pusta para zamian), zanim zapisał plik — **13 failed / 13 passed** na niezaadaptowanych testach. Błąd narzędzia; po ponownym uruchomieniu bez tej pary 26/26.
2. `vitest` (nowe testy): **1 failed / 37** — test żywotności: dotknąłem milczącej karty tuż przed asercją i czas wypadł dokładnie na granicy limitu. **Wada testu**; usunięte zbędne `touch`. Kolejny przebieg 38/38.
3. Próba T2a (pierwsze podejście): **38 passed** z wycofaną linią — test dwóch kart nie obejmował przypadku, w którym wiązanie ma znaczenie (karta potwierdzająca nadal żyła i była wybierana także bez wiązania). **Luka testu**; dodano krok z zamkniętą kartą potwierdzającą (commit `666f789`); ponowna próba oblewa (tabela).
4. `playwright test e2e/ui-state.spec.ts` (pierwszy z nowymi testami): **1 failed / 3 passed / 3 did not run** — test długiego adresu: `SyntaxError: Unterminated string in JSON at position 4003`. Polecenie przeszło (wykonanie zakończone), ale runtime zapisuje wynik narzędzia skrócony do 4000 znaków. **Wada testu**; werdykt i wersja czytane z początku zapisanego wyniku, pełny opis z `GET /api/ui/snapshot`. Kolejny przebieg 7/7.

### Kontrakt dla autora modułu — uzupełnienie

- Moduł nadal nic nie deklaruje. Adres dłuższy niż 2000 znaków trafia do opisu i `AppContext.ui` skrócony z `urlTruncated: true`; filtr instancji nie jest skracany (limity `semanticInstanceSchema`).
- Konsumenci: wynik komendy UI to `{…, uiVersion?, uiClientId?, uiPublication?}`; `ui_state {clientId?, minVersion?, waitMs?}`; `reason` ∈ `no_client | other_conversation | older_than_requested | client_gone | client_inactive` (*od Fix round 2 także `superseded`*); `uiPublication` ∈ `published | timeout | rejected | skipped` (*od Fix round 2 także `unreachable | not_described`*). Nowe komendy UI (Task 2 `ui_sort`, Task 6) przekazują `uiVersion`, `uiClientId`, `uiPublication` i planują swoje oczekiwania w `deadline` z `performAndAcknowledge`.
- HTTP: `DELETE /api/ui/snapshot?clientId=&version=` → `{retired}`; `POST /api/ui/snapshot/alive {clientId, version}` → `{known}`; `POST /api/agui/run` z nieprawidłowym `context.ui` → wykonanie bez markera, nagłówek `X-Ui-Context-Rejected: 1`.

### Obawy po rundzie

1. Obawy 10.2 i 10.3 z raportu głównego są rozwiązane (karty zamknięte i milczące; wersja wiązana z kartą). Zostaje: karta, która wysłała polecenie i potwierdziła komendę, a potem przelogowała się na innego właściciela, jest dla poprzedniego `client_inactive` dopiero po 90 s (heartbeat idzie już do nowego właściciela).
2. Zamknięcie karty bez `pagehide` (awaria przeglądarki) — opis jest zwracany ze `stale:false` do 90 s, potem `client_inactive`.
3. Budżet po stronie karty liczony od odbioru komendy; czas dostarczenia przez SSE pokrywa margines 1000 ms — przy dłuższym opóźnieniu strumienia serwer może nadal zgłosić `no_client`.
4. Powłoka pobiera aktywną przestrzeń także poza canvasem (dodatkowy `GET /api/canvas/spaces/:id` przy zmianie przestrzeni) i wysyła heartbeat co 15 s na kartę.
5. Wyniki narzędzi zapisywane w rozmowie są skracane przez runtime do 4000 znaków (istniejące `summariseToolResponse`); model dostaje pełny wynik, historia rozmowy — nie. Poza zakresem.
6. Konflikty przy scalaniu jak w 10.7 raportu głównego, dodatkowo `UiCommandRunner.tsx` (logika potwierdzenia przeniesiona do `uiCommandAck.ts`) i `runtime.ts` (zapamiętywanie potwierdzenia, stała budżetu).

---

## Fix round 2 (po ponownym przeglądzie rundy 1)

Commit: `4a26129` — Poprawki T3 runda 2: izolacja tozsamosci opisu, uczciwy heartbeat, flaga skrocenia adresu w prompcie, rozdzielone statusy publikacji (666f789..4a26129: 7 plików, +294 / −46).

### Zmiany wg ustaleń

**N1 — izolacja tożsamości (L6.4, L10.11).** `UiSnapshotSession` przechowuje każdy opis z zakresem dostępu, pod którym go złożono (`#currentScope`, `#publishedScope`). Jeden strażnik `#currentInScope()` — opis tylko wtedy, gdy zakres złożenia jest zakresem zalogowanego teraz — obsługuje każdą ścieżkę:
- kolejka publikacji (`#publishCurrent`, używana przez debounce, `flush` i heartbeat): zakres sprawdzany **w chwili wysyłki**, nie przy kolejkowaniu — opis złożony jako poprzedni właściciel i czekający za publikacją w toku nie wychodzi po przełączeniu (`not_described`); publikacja już w drodze w chwili przełączenia jest przerywana przez `api()` (epoka dostępu) i kończy się `unreachable`;
- heartbeat: tylko opis z bieżącego zakresu; przy `known: false` najpierw **ponowne złożenie** (`capture()`), potem publikacja (dalej ze strażnikiem); zmiana zakresu w trakcie odpowiedzi → nic;
- `closing()` (wycofanie przy `pagehide`): tylko wersja z bieżącego zakresu, inaczej nic (poprzedni właściciel dostaje `client_inactive` po 90 s);
- `contextMarker()` (`AppContext.ui`): `null`, dopóki nie złożono opisu jako nowy właściciel.

**N2 — uczciwa świeżość (L6.17).** Heartbeat potwierdza wyłącznie **bieżący** opis (`#current`), nigdy starszy opublikowany. Odmowa backendu (`#failed`) od razu wysyła `alive` z odrzuconą, nowszą wersją. Backend (`UiSnapshotStore.touch`): wersja nowsza niż przechowywana → karta żywa, przechowywany opis oznaczony `supersededBy`, odpowiedź `known: false`; wiadomość o przechowywanej wersji po takim oznaczeniu jest traktowana jako spóźniona (wersje karty tylko rosną) i **nie zdejmuje oznaczenia**; zdejmuje je dopiero przyjęcie nowszego opisu. `evaluate` zwraca taki opis ze `stale: true, reason: 'superseded'` i przy wyborze karty woli żywą, nieoznaczoną kartę tej rozmowy. Heartbeat nie wysyła ponownie wersji, którą backend już odrzucił (bez zalewu zgłoszeń co 15 s). Nowy powód `superseded` w `UI_STATE_REASONS`, opisie `ui_state` i kontrakcie.

**N3.** Prompt: `adres … [adres skrocony do 2000 znakow — pelny jest dluzszy]`, gdy `AppContext.ui.urlTruncated`.

**N5.** `UiPublication` i `UI_PUBLICATION_STATUSES`: `rejected` wyłącznie dla odmowy backendu (`AppError` z odpowiedzi); nowe `unreachable` (brak odpowiedzi backendu: sieć, zmiana tożsamości w drodze — bez zgłoszenia i bez `lastRejection`, próbowane ponownie) i `not_described` (nic do wysłania: brak opisu złożonego pod bieżącą tożsamością). `lastRejection` niesie też `clientId`.

**Raport.** Poprawione sekcje 1.2 („nic pobierane specjalnie”), 2.5 (tylko cache) i obawa 10.9 (`cards: null` poza canvasem) — opisują teraz zachowanie po Fix round 1.

### Testy (`tests/ui-snapshot.test.ts` 38 → 42; test kontraktu lub logiki)

- **N1**: dwa magazyny (po jednym na właściciela), wysyłka i heartbeat trafiają do magazynu właściciela zalogowanego w chwili żądania (jak ciasteczko). v1 opublikowane jako `local-user`; v2 w drodze; v3 złożone jako `local-user` czeka w kolejce; przełączenie na `other-user`; v2 kończy się (wyszło wcześniej), v3 → `not_described`; heartbeat, `closing()` i `contextMarker()` po przełączeniu nic nie wysyłają (`null`); magazyn `other-user` nie zna karty. Po złożeniu jako `other-user` — dokładnie jedna publikacja do nowego właściciela, z jego rozmową.
- **N2**: sesja na prawdziwym `UiSnapshotStore`: v1 przyjęte (`stale: false`), v2 odrzucone → od razu `superseded` z opisem v1; dwa heartbeaty potwierdzają wersje `[2, 2]` (nie 1) i nie wysyłają ponownie v2 (jedno zgłoszenie); spóźnione `touch(1)` → `false`, oznaczenie zostaje; żywa, nieoznaczona karta tej rozmowy wygrywa; przyjęte v3 → karta znów świeża.
- **N3**: linia promptu z flagą skrócenia; bez flagi brak dopisku.
- **N5**: `flush` bez opisu → `not_described`; błąd sieci → `unreachable` bez zgłoszenia i `lastRejection`; `performAndAcknowledge` przenosi `not_described` do `uiPublication`; kontrakt przyjmuje oba nowe statusy.

### Polecenia i wyniki (stan `4a26129`)

| Polecenie | Wynik |
|---|---|
| `pnpm exec vitest run tests/ui-snapshot.test.ts` | exit 0, **42/42** |
| `pnpm verify` | **exit 0** — spójność OK, macierz zgodna, typecheck, build, **Vitest 26 plików / 369 testów** |
| `flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/ui-state.spec.ts e2e/access-context.spec.ts` (po `pnpm verify`) | **exit 0, 10 passed** (ui-state 7, access-context 3) |
| `flock … playwright test e2e/ui-navigation.spec.ts e2e/view-filter.spec.ts e2e/chat.spec.ts e2e/session-restore.spec.ts` (dodatkowo: zmienione ścieżki wysyłki i potwierdzenia) | **exit 0, 25 passed** (5, 7, 7, 6) |

Po przebiegach usunięto nieśledzony `docs/evidence/chat-ux-2026-09-16/`; drzewo czyste.

### Próby zdolności wykrycia (na zatwierdzonym `4a26129`: wycofanie → `vitest run tests/ui-snapshot.test.ts` → `git checkout -- <plik>` → 42/42)

| Próba | Wycofanie | Wynik z wycofaniem |
|---|---|---|
| N1a | `#currentInScope()` zwraca opis bez względu na zakres | **1 failed / 41**: „N1: …” — `expected { status: 'published', … } to deeply equal { status: 'not_described' }` (v3 wysłane do nowego właściciela) |
| N1b | tylko kolejka publikacji bez sprawdzenia zakresu w chwili wysyłki | **1 failed / 41**: „N1: …” — to samo |
| N1c | heartbeat jak przed poprawką (`#published ?? #current`, bez zakresu, bez ponownego złożenia, wysyła opis przy `known: false`) | **2 failed / 40**: „N1: …” — `expected [ { owner: 'other-user', … } ] to deeply equal []`; „N2: …” — `expected [ 1, 1 ] to deeply equal [ 2, 2 ]` |
| N2a | odmowa bez natychmiastowego `alive` z nowszą wersją | **1 failed / 41**: „N2: …” — `expected { stale: false, version: 1, … } to match object { stale: true, … }` |
| N2b | heartbeat potwierdza opublikowany (starszy) opis | **1 failed / 41**: „N2: …” — `expected [ 1, 1, 2 ] to deeply equal [ 2, 2 ]` |
| N2c | backend zdejmuje oznaczenie przy wiadomości o przechowywanej wersji | **1 failed / 41**: „N2: …” — `expected true to be false` (spóźnione `touch(1)`) |
| N3 | prompt bez dopisku o skróceniu | **1 failed / 41**: „N3: prompt mowi, ze adres ekranu zostal skrocony” |
| N5a | brak opisu jako `rejected` / `nothing_described` | **2 failed / 40**: „N1: …” i „N5: …” — `expected { status: 'rejected', … } to deeply equal { status: 'not_described' }` |
| N5b | błąd sieci jako `rejected` | **1 failed / 41**: „N5: …” — `expected { status: 'rejected', … } to deeply equal { status: 'unreachable' }` |

### Nieudane przebiegi w tej rundzie

1. `vitest run tests/ui-snapshot.test.ts` (pierwszy z nowymi testami): **1 failed / 41** — „N2”: `store.touch(owner, clientId, 1)` zwróciło `true` i zdjęło oznaczenie `superseded`. **Błąd implementacji** (spóźniona wiadomość o starszej wersji przywracała świeżość); `touch` nie zdejmuje już oznaczenia. Kolejny przebieg 42/42.
2. **Błąd procedury prób**: pierwsze uruchomienie skryptu prób odbyło się przed commitem; `git checkout -- packages/platform-ui/src/state/uiSnapshot.ts` po próbie N1a przywróciło wersję z `666f789` i usunęło niezatwierdzone zmiany rundy 2 w tym jednym pliku (skrypt przerwał się na następnej próbie, bo wzorzec już nie istniał). Pozostałe pliki rundy 2 były nietknięte (`git status`). Zmiany w `uiSnapshot.ts` odtworzono tą samą, zapisaną w sesji zamianą sekcji, typecheck OK, **42/42**, commit `4a26129` — i dopiero na nim wszystkie próby z tabeli (N1a powtórzona).

### Obawy po rundzie

1. Po przełączeniu tożsamości karta nie ma opisu (`contextMarker` `null`, publikacje `not_described`), dopóki nie złoży go jako nowy właściciel — zwykle po ~250 ms (debounce po czyszczeniu pamięci podręcznej). Opis złożony tuż po przełączeniu może zawierać instancje wyrenderowane z danych poprzedniego właściciela, jeśli komponenty nie zdążyły się przerysować. *(Korekta w Fix round 3: to nie była „chwila”. `QueryCache.clear()` niszczy zapytania bez powiadamiania obserwatorów, więc zamontowany komponent danych — np. tabela w odpowiedzi czatu na Ustawieniach — w ogóle się nie przerysowuje; jego opis, a także rozmowa i przestrzeń trzymane przez powłokę, trafiały do magazynu nowego właściciela bez ograniczenia czasu. Naprawione w Fix round 3.)* *(Stan po rundzie 2, skorygowany w rundzie 3: wymóg rundy 2 — nic złożonego pod starym zakresem nie wychodzi — był spełniony, ale nie wystarczał, bo opis złożony już pod nowym zakresem mógł nieść dane poprzedniego właściciela bez ograniczenia czasu; zdanie o „chwili”, której „nie da się wykluczyć”, było błędne. Runda 3 wyklucza to epoką dostępu w rejestrze i identyfikatorami trzymanymi w chwili przełączenia.)*
2. `superseded` zależy od tego, czy backend dostanie od karty wersję nowszą niż przechowywana: od razu po odmowie, najpóźniej z heartbeatem. Gdy obie wiadomości przepadną, zostaje reguła bezczynności (`client_inactive` po 90 s).
3. Poprzednie obawy z rund 0–1 bez zmian.

---

## Fix round 3 (po ponownym przeglądzie rundy 2)

Commity: `5be019c` — Poprawki T3 runda 3: nic sprzed przelaczenia tozsamosci w opisie ekranu; `96a2fad` — Opis po przelaczeniu tozsamosci nie niesie rozmowy ani przestrzeni poprzedniego wlasciciela takze w adresie (parametry c i s) (4a26129..96a2fad: 9 plików, +377 / −49).

### Zmiany wg ustaleń

**A1 — nic sprzed przełączenia tożsamości (L10.11).** Potwierdzam diagnozę przeglądu i jej skalę: próba G-A1a (niżej) pokazała w przeglądarce opis nowego właściciela z tabelą z czatu poprzedniego (`state: ready`, 4 identyfikatory rekordów poprzedniego właściciela) — komponent nie przerysował się po `QueryCache.clear()` i nic tego nie ograniczało w czasie.
- `state/uiSemantics.ts`: każdy wpis rejestru ma epokę dostępu z chwili zapisu (`epochs`); `listInstances()` wymienia **tylko wpisy z bieżącej epoki**. Wpis sprzed przełączenia zostaje (należy do zamontowanego komponentu, który go usunie przy odmontowaniu), ale nie jest opisem ekranu nowego właściciela; ponowny opis — nawet o tej samej treści — zapisuje się w nowej epoce. Wybrane zamiast czyszczenia rejestru, bo nie wymaga zależności `api/accessContext` od stanu UI i obejmuje każdego konsumenta rejestru.
- `shell/snapshotSource.ts`: rozmowa i przestrzeń trzymane przez powłokę **w chwili przełączenia** (zapamiętane przez nowe `onAccessContextChange`) są zgłaszane jako `null`, dopóki powłoka nie przejdzie do innych; te same identyfikatory są usuwane z adresu (parametry `c`, `s`). Adres był dodatkowym kanałem wycieku znalezionym w wyniku próby G-A1a (`"url":"/settings?c=cnv_…"`) — naprawione w `96a2fad`.
- Przegląd zakładał, że dane mogą przejść przez `GET ?clientId=` i przez `ui_state`, gdy rozmowa się zgadza; obie drogi zamknięte, bo magazyn nowego właściciela nie dostaje już ani instancji, ani identyfikatorów, ani adresu sprzed przełączenia.

**M1.**
- `api/client.ts`: epoka sprawdzana także **po** odczycie treści błędu (`parseError` to kolejne `await`) — odmowa zaadresowana do poprzedniego kontekstu kończy się `AccessContextChanged`, nie `AppError`.
- `UiSnapshotSession`: ścieżka odnowienia tożsamości karty po `conflict` sprawdza zakres przed drugą wysyłką (`unreachable`); `#failed` sprawdza zakres przed zapamiętaniem odmowy, zgłoszeniem i `alive` (`unreachable`, bez `lastRejection`).

**P1.**
- `api/accessContext.ts`: `onAccessContextChange(listener)` — wywoływane po każdym przełączeniu (po przerwaniu żądań i wyczyszczeniu pamięci).
- `UiSnapshotPublisher` przerysowuje się na przełączenie, więc `useUiTargets`/`useViewDefinitions`/`useCanvasState` obserwują i pobierają klucze nowego właściciela.
- `createShellSnapshotSource` zwraca `null` („nic do opisania”), dopóki katalog celów dla bieżącego właściciela się nie wczyta (albo jego odczyt się nie powiedzie); `UiSnapshotSession.capture()` nie tworzy wtedy wersji, a `flush` daje `not_described`. **Pierwszy opis po przełączeniu nazywa więc cel** (to samo dotyczy startu aplikacji). Źródło ma `dispose()` (publikator woła przy odmontowaniu).

**Raport i komentarz w kodzie.** Nagłówek `state/uiSnapshot.ts` mówi teraz, że trzy zapytania są wczytywane przez publikator dla opisu. W raporcie poprawiono: sekcję 1.2 (`flush` zwraca `UiPublication`, nie „opis albo null”), listy powodów i statusów w uzupełnieniach kontraktu (Fix round 1 — linie o `uiPublication` i `reason`) oraz obawę 1 rundy 2 (to nie była „chwila ~250 ms”, tylko czas nieograniczony).

### Testy

`tests/ui-snapshot.test.ts` 42 → **46** (test kontraktu lub logiki):
- zmieniony test źródła (I3/P1): bez wczytanego katalogu `capture()` → `null`; po wyrzuceniu wpisów z pamięci ta sama wersja; po przełączeniu właściciela `capture()` → `null` i `contextMarker()` → `null`, po wczytaniu katalogu nowego właściciela **pierwszy** opis ma cel `platform.settings` i `conversationId: null`;
- **A1 rejestr**: wpis sprzed przełączenia nie jest wymieniany, choć nadal jest w stanie; ponowny opis tą samą treścią jest wymieniany; `unregisterInstance` usuwa epokę;
- **A1 całość**: prawdziwy `setAccessContext`, rejestr, źródło, sesja i dwa magazyny (żądanie trafia do magazynu właściciela z `accessScope()` w chwili żądania). Jako `local-user`: tabela z czatu, rozmowa, przestrzeń, adres `?c=…&s=…&tab=auth` opublikowane. Po przełączeniu: `flush` → `not_described` (brak katalogu nowego właściciela), heartbeat nic; po wczytaniu katalogu: opis nowego właściciela bez instancji, z `conversationId`/`spaceId` `null`, adresem `/settings?tab=auth`, bez żadnego `rec_local_` ani `_of_local_user`, z celem; po przejściu powłoki do rozmowy nowego właściciela — zgłaszana wraz z adresem;
- **M1**: konflikt przeczytany po przełączeniu → `unreachable`, jedna wysyłka (jako poprzedni właściciel), bez `alive` i zgłoszenia; zwykła odmowa przeczytana po przełączeniu → `unreachable`, bez `alive` i `lastRejection`; `api()` z odpowiedzią 409, której treść przychodzi po przełączeniu → `AccessContextChanged`.

`e2e/ui-state.spec.ts` 7 → **8** (symulacja): skryptowana odpowiedź `root = DataTable({operation: "procurement.suppliers"}, …)` renderuje tabelę **w czacie na `/settings`** (4 wiersze pierwszego właściciela, opis z identyfikatorami równymi `POST /api/read`); kliknięcie `switch-access-context`; tabela nadal `ready` (nieprzerysowana — warunek scenariusza przeglądu); opis w magazynie nowego właściciela (`GET ?clientId=` z sesją nowego właściciela): ta sama karta, cel `platform.settings`, `conversationId: null`, **żaden** identyfikator rekordu poprzedniego właściciela ani identyfikator jego rozmowy (także w adresie), brak instancji `ready` z 4 rekordami.

### Polecenia i wyniki (stan `96a2fad`)

| Polecenie | Wynik |
|---|---|
| `pnpm exec vitest run tests/ui-snapshot.test.ts` | exit 0, **46/46** |
| `pnpm verify` | **exit 0** — spójność OK, macierz zgodna, typecheck, build, **Vitest 26 plików / 373 testy** |
| `flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/ui-state.spec.ts e2e/access-context.spec.ts e2e/chat.spec.ts e2e/view-filter.spec.ts e2e/session-restore.spec.ts` (po `pnpm verify`) | **exit 0, 31 passed** (ui-state 8, access-context 3, chat 7, view-filter 7, session-restore 6) |

`view-filter` i `session-restore` dodane do wymaganych, bo zmieniły się rejestr `uiSemantics` i publikator. Po przebiegach usunięto nieśledzony `docs/evidence/chat-ux-2026-09-16/`; drzewo czyste.

### Próby zdolności wykrycia (procedura z `dispatch-common.md`: commit → czyste drzewo → wycofanie → test → `git checkout -- <plik>` → `git status --short` puste; skrypt przerywa przy nieczystym drzewie)

Próby A1a–M1c i G-* na `5be019c`, A1c na `96a2fad`; po każdej drzewo czyste, po próbach GUI `pnpm build` na przywróconym kodzie.

| Próba | Wycofanie | Test | Wynik z wycofaniem |
|---|---|---|---|
| A1a | `listInstances()` bez filtra epoki | Vitest | **2 failed / 44**: rejestr — `expected [ 'DataTable-przed' ] to not include 'DataTable-przed'`; całość — `expected [ { …(15) } ] to deeply equal []` |
| A1b | źródło zgłasza rozmowę i przestrzeń sprzed przełączenia | Vitest | **2 failed / 44**: `expected 'cnv_a' to be null`, `expected 'cnv_of_local_user' to be null` |
| A1c | adres z parametrami `c`/`s` sprzed przełączenia | Vitest + `pnpm build` + GUI | Vitest **1 failed / 45**: `… not to contain '_of_local_user'`; GUI **1 failed**: linia 419 `not.toContain("cnv_…")` |
| P1 (Vitest) | opis składany bez wczytanego katalogu | Vitest | **2 failed / 44**: `expected { version: 1, … } to be null`; `expected 'published' to be 'not_described'` |
| M1a | odnowienie po konflikcie bez sprawdzenia zakresu | Vitest | **1 failed / 45**: dwie wysyłki zamiast jednej (druga jako nowy właściciel) |
| M1b | `#failed` bez sprawdzenia zakresu | Vitest | **1 failed / 45**: `expected { status: 'rejected', … } to deeply equal { status: 'unreachable' }` |
| M1c | `api()` bez sprawdzenia epoki po treści błędu | Vitest | **1 failed / 45**: `expected AppError: wersja nie nowsza … to be an instance of AccessContextChanged` |
| G-A1a | `listInstances()` bez filtra epoki | `pnpm build` + `flock … playwright test e2e/ui-state.spec.ts -g "przelaczenie tozsamosci na Ustawieniach"` | **1 failed**: linia 417 — opis nowego właściciela zawiera `pcs_…` (pełna instancja `DataTable` z czatu, `ready`, 4 identyfikatory poprzedniego właściciela) |
| G-A1b | źródło zgłasza rozmowę sprzed przełączenia | jw. | **1 failed**: linia 414 `not.toBe("cnv_…")` |
| G-P1 | publikator nie przerysowuje się po przełączeniu | jw. | **1 failed** (27,5 s): opis nowego właściciela z celem nigdy nie powstał (`published` → `expected true, received false`) |

### Nieudane przebiegi w tej rundzie

1. `vitest run tests/ui-snapshot.test.ts` (po `5be019c`, pierwszy): **1 failed / 45** — test źródła z rundy 1 oczekiwał po przełączeniu nowej wersji z `target: null`, czyli dokładnie zachowania, które P1 usuwa. **Test opisywał starą regułę**; przepisany na nową (brak opisu do wczytania katalogu, potem pierwszy opis z celem). Kolejny przebieg 46/46.
2. `vitest` (po dopisaniu kontroli adresu): **1 failed / 45** — „N1” z rundy 2: moja zamiana w pliku testu (Python `str.replace`) zmieniła tę samą linię asercji w dwóch testach (N1 i A1). **Błąd edycji testu**; przywrócona linia N1. Kolejny przebieg 46/46. (Zmiana była przed commitem `96a2fad`; żadna próba nie była wtedy wykonywana.)

### Kontrakt dla autora modułu — uzupełnienie

- Komponent opisujący się przez `useDescribeInstance`/`registerInstance` jest wymieniany w opisie ekranu tylko wtedy, gdy jego opis zapisano pod bieżącą tożsamością; po przełączeniu musi opisać się ponownie (dzieje się to samo przy przerysowaniu z nowymi danymi).
- Kod platformy, który trzyma stan zależny od tożsamości poza pamięcią zapytań albo czyta pamięć tylko przy przerysowaniu, może użyć `onAccessContextChange` (`@platform/ui`).

### Obawy po rundzie

1. Tabela w czacie nadal **pokazuje** wiersze poprzedniego właściciela po przełączeniu (nie przerysowuje się) — opis ekranu już ich nie podaje, ale sam ekran tak. To zachowanie `setAccessContext`/`QueryCache.clear()` sprzed tego zadania (widoczne w teście GUI jako warunek scenariusza); poza zakresem T3, do decyzji koordynatora.
2. Komponent po przełączeniu znika z opisu, dopóki nie opisze się ponownie; jeśli nic go nie przerysuje, opis nie wymieni go wcale (przemilczenie zamiast wycieku).
3. Do czasu wczytania katalogu nowego właściciela (i przy starcie) karta nie ma opisu: `ui_state` → `no_client` lub `client_gone`, `AppContext.ui` → `null`.
4. Pozostałe obawy z rund 0–2 bez zmian.

---

## Merge round (scalenie `bl01-bl02/integracja` da7b868 = Task 1 + 5 + 2 + 4)

Commity:

| SHA | Temat |
|---|---|
| `e58796b` | Scalenie bl01-bl02/integracja (Task 1, 5, 2, 4) do Task 3 — commit scalający (rodzice `96a2fad`, `da7b868`), tylko rozwiązania konfliktów i to, czego wymagała kompilacja |
| `09ba0ed` | Integracja T3 z Task 2 i Task 4: budzet potwierdzenia, ui_sort, opis Widokow agenta, grupowanie |
| `5e94c3c` | Test Widokow agenta: grupowanie zmienia kolejnosc strony (sortowanie po terminie dostawy przeplata waluty) |

`git merge` bez rebase i bez przepisywania commitów. Poprawka `RunEventStream.read` (95fd5dc w integracji, `05cfe10` u mnie) scaliła się bez konfliktu.

### Konflikty i rozwiązania (10 plików)

| Plik | Konflikt | Rozwiązanie |
|---|---|---|
| `platform-contracts/src/ui.ts` | `uiCommandResultSchema`: `sorted`/`page` (T2) vs `uiVersion`/`uiClientId`/`uiPublication` (T3) | oba; pola T2, potem T3 (schemat nie jest pozycyjny) |
| `platform-server/src/agent/tools/index.ts` | `uiSortTools` vs `uiStateTools` | kolejność `ui_catalog, ui_navigate, ui_filter, ui_sort, ui_state` |
| `platform-server/src/agent/tools/ui.ts` | wynik `ui_filter`: `page` (T2) vs pola wersji opisu (T3) | oba |
| `platform-server/src/agent/prompt.ts` | (1) linia filtrów: `describeFilters` (T2) vs linia „ekran przy wyslaniu polecenia” (T3); (2) koniec „Sterowanie interfejsem”: „## Sortowanie i strony widoku” (T2) vs „## Stan ekranu” + dawna lista celów (T3) | (1) `describeFilters` T2, potem linia ekranu T3; (2) kolejność T2 (lista celów wyżej, zawężanie, sortowanie), potem „## Stan ekranu” **bez** drugiej listy celów (T2 przeniósł ją wyżej) |
| `platform-ui/src/shell/UiCommandRunner.tsx` | tylko importy (ciało scaliło się automatycznie: plan T2 wewnątrz `performAndAcknowledge`) | importy obu stron |
| `platform-ui/src/state/appState.ts` | importy typów T2 vs import `uiSnapshotSession` | oba |
| `e2e/support/scripted-agent.ts` | 5 miejsc: `input` jako funkcja wcześniejszych wywołań i `CallRecord` (T2/T4) vs placeholder `$last.<ścieżka>` (T3); licznik wywołań przeniesiony przez T2 na poziom agenta; opis kroku `ui` (sortowanie, strona vs wersja opisu) | oba mechanizmy: najpierw funkcja, potem `resolveLastResult`; `calls` i `lastResult` aktualizowane z tego samego sparsowanego wyniku; licznik z T2; krok `ui` wypisuje sortowanie, stronę, `uiVersion`, `uiClientId` |
| `e2e/support/scripted-server.ts` | nowe scenariusze w tym samym miejscu (`ui-state-*`, `chat-data-table` vs `viewstate-*`) — hunki przeplecione | obie grupy w całości (odtworzone z obu wersji) |
| `tests/ui-navigation.test.ts` | lista czasowników `ui_*` | `ui_catalog, ui_filter, ui_navigate, ui_sort, ui_state` |
| `tests/views-foundation.test.ts` | lista narzędzi platformy | `…ui_filter, ui_sort, ui_state, files_list…` |

Poza konfliktami (w commicie scalającym, bo bez tego nie kompilowało się): `ui: null` w literałach `AppContext` nowych testów `tests/agent-views.test.ts` (2) i `tests/view-state.test.ts` (1). Po scaleniu: `pnpm install --frozen-lockfile` bez zmian, typecheck 0 błędów, Vitest 29 plików / 462 testy — przed jakąkolwiek zmianą integracyjną.

### Wymagania integracji (commit `09ba0ed`, test `5e94c3c`)

**1. Budżet potwierdzenia wokół planu T2.** `performAndAcknowledge` owija cały `perform` T2, więc każde potwierdzenie — także odmowy planu (`views_unavailable`, `not_sortable`, `not_filterable`, `unknown_field`) i wyniki `ui_sort` — przechodzi przez tę samą publikację i niesie `uiVersion`/`uiClientId`/`uiPublication` (`skipped` tylko dla `inactive_conversation`). Czekanie T2 na raport widoku (do 80 × 60 ms = 4,8 s) i na element (12 × 60 ms) liczone jest teraz od wspólnego terminu: nowe `pollUntil(probe, {attempts, intervalMs, until})` z **wymaganym** `until` (usunięcie terminu z wywołania to błąd typu) i `waitingDeadline(deadline) = deadline − UI_ACK_PUBLICATION_RESERVE_MS (800 ms)`. Najgorszy przypadek: perform kończy czekanie najpóźniej 800 ms przed terminem (budżet 8000 − margines 1000), publikacja dostaje resztę, potwierdzenie przed 7 s. Widok, który nie zgłosił stanu w tym czasie, jest `not_applied` (z opisem ekranu), a nie `no_client`.

**2. `ui_sort`** zwraca `uiVersion`, `uiClientId`, `uiPublication` tak jak `ui_navigate`/`ui_filter`. Prompt „## Stan ekranu” obejmował już `ui_sort`; dopisano stronę, grupowanie, kolejność z ekranu i karty Widoków agenta.

**3. Opis na `/agent-views`.** Strona Widoków agenta nie ustawia `AppState.spaceId`, więc opis brał karty przestrzeni roboczej. Nowy rejestr **przestrzeni na ekranie** `state/displayedCanvas.ts` (`useDisplayCanvas`, `displayedCanvas()`, epoka dostępu z renderu jak `uiSemantics`): zgłasza ją `CanvasInner` (canvas roboczy i powierzchnia Widoków agenta — karty, które faktycznie rysuje) oraz `AgentViewsPage`, dopóki nie ma własnego canvasu (brak widoków → pusty zbiór kart, ładowanie → nieznane). Kontrakt: `cards` opisują przestrzeń na ekranie (inaczej roboczą), nowe `cardsSpaceId`. Dla przestrzeni rozmowy (`AGENT_VIEWS_SCOPE_KIND`) `view = {id: cel ekranu (platform.agentViews), title, compositionVersion}`, gdzie wersja = `compositionVersionOf("<spaceId>|<cardId>@<specVersion>,…")` — dodanie, usunięcie lub edycja widoku agenta daje nową wersję kompozycji. `target` to `platform.agentViews` z katalogu (trasa `/agent-views`). Instancje w kartach — z `uiSemantics` jak dotąd.

**4. Grupowanie.** `semanticInstanceSchema.groupBy: string | null` — dopisane na końcu, opcjonalne (starsze opisy bez pola nadal przechodzą). `describeDataInstance` bierze model z `withGrouping` (T4): `groupBy` = pole grupowania, a `visibleRecordIds` **w kolejności z ekranu** (grupa po grupie, w grupie kolejność strony); tak też opisano pole w kontrakcie.

**5. `total` (rozstrzygnięcie koordynatora, bez zmiany zachowania).** `SemanticInstance.total` (views.ts) = rekordy zwrócone przez odczyt przed **jakimkolwiek** predykatem; `ViewStateContext.total` (view-state.ts, `AppContext.filters[target]`) = rekordy po własnym `filter` kompozycji, przed zawężeniem z adresu. Oba komentarze odsyłają do siebie i mówią, dlaczego są równe dla instancji głównej (bez filtra kompozycji), jedynej zasilającej `AppContext.filters`.

**Drobne z przeglądu.** (B1) epoka dostępu opisu instancji i przestrzeni na ekranie odczytywana **przy renderze** i przekazywana do `update`/`registerInstance(description, epoch)`, nie w efekcie. (B2) `ui-snapshot.ts`: `conversationId`/`spaceId` `null`, dopóki powłoka trzyma identyfikatory sprzed przełączenia; `url` bez takich `c`/`s`; `instances` — tylko komponenty opisane pod bieżącą tożsamością, zamontowany a nieopisany komponent może brakować. (B3) w raporcie poprawiono listę statusów przy I1 rundy 1 i sprzeczne ostatnie zdanie obawy 1 rundy 2.

### Testy

`tests/ui-snapshot.test.ts` 46 → **52** (test kontraktu lub logiki):
- **R1** prawdziwa bramka runtime, budżet 2000 ms: perform czeka jak T2 (80 × 60 ms) na raport, który nie przychodzi, przez `pollUntil` z `waitingDeadline` → potwierdzenie przed budżetem: `executed: false`, `not_applied`, `uiPublication: 'published'`, `uiVersion` i `uiClientId` sesji; `pollUntil` nie czeka po `until`.
- **R2** `ui_sort` przez bramkę i `POST /ui-ack` zwraca `sorted`, `uiVersion`, `uiClientId`, `uiPublication`.
- **R3** builder: na `/agent-views` karty i `cardsSpaceId` przestrzeni rozmowy (nie roboczej, która zostaje w `spaceId`), `view` z celem i wersją kompozycji, nowa wersja po zmianie `specVersion`; brak widoków → `cards: []`, `cardsSpaceId: null`; ładowanie → `cards: null`, `view: null`; canvas roboczy → jego karty, `view: null`; ekran danych → przestrzeń robocza. Rejestr przestrzeni: ostatnio zamontowana, po przełączeniu tożsamości nic, zgłoszenie z epoką renderu sprzed przełączenia nie jest wymieniane.
- **R4** trzy rekordy PLN/EUR/PLN: bez grupowania `groupBy: null`, kolejność strony; grupowane po walucie `groupBy: 'currency'`, `visibleRecordIds` `[a, c, b]`; schemat przyjmuje oba i opis bez pola.
- **B1** opis wyrenderowany przed przełączeniem, zapisany po nim — niewymieniany; z bieżącą epoką — wymieniany.

`e2e/ui-state.spec.ts` 8 → **10** (symulacja):
- **`ui_sort` → `ui_state`**: polecenie z kompozytora na `/data`; adres `sort=-name`; wynik `ui_sort` ma `sorted`, `uiClientId` tej karty, `uiPublication: 'published'`; `ui_state {minVersion: $last.uiVersion, clientId: $last.uiClientId}` → `stale: false`, wersja ≥ `uiVersion`, instancja `sort: name desc`, `groupBy: null`, `visibleRecordIds` = kolejność wierszy w DOM = rekordy `POST /api/read` posortowane malejąco po nazwie (kolacja `pl`).
- **Widoki agenta**: `procurement_list_cases` → `agent_view_create` (tabela porównania ofert, `sort` po terminie dostawy, `groupBy: "currency"`) → `ui_navigate platform.agentViews` → `ui_state` z `$last`. Na ekranie `/agent-views` z tabelą `ready`; wynik `ui_state`: cel `platform.agentViews`, `cardsSpaceId` = przestrzeń z `GET /api/conversations/:id/agent-views` (≠ `spaceId`), `cards` = karty z tego API (id, tytuł, rodzaj, `specVersion`), `view` z wersją kompozycji liczoną **niezależną** implementacją FNV w teście; opublikowany opis tabeli: `groupBy: 'currency'`, `visibleRecordIds` = kolejność wierszy w DOM; każda waluta w jednym ciągłym bloku; warunek wstępny: kolejność strony (wg terminu dostawy z `POST /api/read`) jest **inna** niż kolejność na ekranie (PLN, EUR, PLN, PLN → PLN×3, EUR).

### Polecenia i wyniki (stan `5e94c3c`)

| Polecenie | Wynik |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 („Already up to date”) |
| `pnpm verify` | **exit 0** — spójność OK, macierz zgodna, typecheck, build, **Vitest 29 plików / 468 testów** |
| `flock -w 5400 …/.e2e.lock pnpm check:module-swap` | **exit 0** — „OK … próba zakończona — 9 s” (moduł kontrolny, powłoka bez ekranów przykładu, `/files` i `/settings` bez błędów) |
| `pnpm build` + `flock -w 5400 …/.e2e.lock pnpm exec playwright test` na 17 specach bez modelu (`ui-state, view-state, view-filter, agent-views, composed-views, ui-navigation, access-context, chat, session-restore, background-tasks, scripted-call, app, tool-activity, streaming, measurements, chat-drawer, chat-layout`) | **exit 0, 100 passed (5,5 min)**: ui-state 10, view-state 8, view-filter 7, agent-views 7, composed-views 7, ui-navigation 5, access-context 3, chat 7, session-restore 6, background-tasks 5, scripted-call 1, app 14, tool-activity 5, streaming 3, measurements 2, chat-drawer 6, chat-layout 4 |

Nie uruchomiono `e2e/agent-ui.spec.ts` ani `e2e/files-agent.spec.ts` (prawdziwy model — Task 8). Po przebiegach usunięto nieśledzone `docs/evidence/chat-ux-2026-09-16/` i `docs/evidence/closure-2026-09-15/`; drzewo czyste.

### Próby zdolności wykrycia (commit → czyste drzewo → wycofanie → test → `git checkout -- <plik>` → `git status --short` puste; skrypt przerywa przy nieczystym drzewie)

Vitest i G-R2/G-R3 na `09ba0ed`, G-R4 (ponownie) na `5e94c3c`; po próbach GUI `pnpm build` na przywróconym kodzie.

| Próba | Wycofanie | Test | Wynik z wycofaniem |
|---|---|---|---|
| R1 | `pollUntil` bez sprawdzenia `until` | Vitest | **1 failed / 51**: potwierdzenie nie `not_applied` — serwer rozstrzygnął `no_client` (2020 ms) |
| R2 | `ui_sort` bez `uiVersion`/`uiClientId`/`uiPublication` | Vitest | **1 failed / 51** |
| R3a | builder ignoruje przestrzeń na ekranie | Vitest | **1 failed / 51**: `expected 'spc_working' to be 'spc_conv_a'` |
| R3b | rejestr przestrzeni bez filtra epoki | Vitest | **1 failed / 51**: `expected { spaceId: 'spc_1', … } to be null` |
| R4a | `visibleRecordIds` w kolejności strony | Vitest | **1 failed / 51** |
| R4b | opis bez `groupBy` | Vitest | **1 failed / 51** |
| B1 | `registerInstance` bierze epokę z chwili zapisu | Vitest | **1 failed / 51**: `expected [ 'DataTable-render' ] to not include 'DataTable-render'` |
| G-R2 | `ui_sort` bez pól wersji opisu | `pnpm build` + `flock … playwright test e2e/ui-state.spec.ts -g "ui_sort, a potem"` | **1 failed**: linia 435 — wynik `ui_sort` bez `uiClientId`/`uiPublication` |
| G-R3 | `CanvasInner` nie zgłasza przestrzeni na ekranie | `… -g "Widoki agenta: opis"` | **1 failed**: linia 476 `cardsSpaceId` — oczekiwane `spc_…`, otrzymane `null` |
| G-R4 | `visibleRecordIds` w kolejności strony (po `5e94c3c`) | jw. | **1 failed**: linia 501 `visibleRecordIds` ≠ kolejność w DOM |

### Nieudane przebiegi w tej rundzie

1. `tsc` po rozwiązaniu konfliktów: 3 błędy `Property 'ui' is missing` w nowych testach T2/T4 — oczekiwane (nowe literały `AppContext`), dopisano `ui: null`.
2. `vitest run tests/ui-snapshot.test.ts` (nowe testy): `ReferenceError: semanticInstanceSchema is not defined` — brakujący import w teście; kolejny przebieg 52/52.
3. **Próba G-R4 (pierwsze podejście): 1 passed z wycofaną linią.** W przykładowej sprawie oferty w kolejności odczytu mają waluty już zgrupowane (PLN, PLN, PLN, EUR), więc test GUI nie odróżniał kolejności strony od kolejności grup. **Luka testu**; kompozycja scenariusza sortuje po terminie dostawy (PLN, EUR, PLN, PLN), test sprawdza ten warunek wstępny (commit `5e94c3c`), ponowna próba oblewa (tabela).

### Kontrakt dla autora modułu — uzupełnienie

- Nic nowego do deklarowania. Tabela z `groupBy` jest opisana z polem grupowania, a jej widoczne rekordy — w kolejności z ekranu.
- Ekran pokazujący przestrzeń canvasu inną niż robocza (jak Widoki agenta) powinien renderować ją przez `CanvasSurface`/`CanvasInner` albo zgłosić `useDisplayCanvas({spaceId, scopeKind, cards})` — wtedy opis ekranu podaje jej karty.
- Nowe komendy UI (Task 6) wykonują swoje oczekiwania przez `pollUntil` z `until: waitingDeadline(deadline)` i zwracają pola wersji opisu jak `ui_sort`.

### Obawy po rundzie

1. `UI_ACK_PUBLICATION_RESERVE_MS = 800` ogranicza czekanie T2 na raport widoku do ok. 6,2 s od odebrania komendy (zamiast stałych 4,8 s plus reszta): przy bardzo wolnym ekranie komenda prędzej będzie `not_applied` niż `no_client` — to zamierzone, ale zmienia czas, po którym T2 uznaje niepowodzenie.
2. Wersja kompozycji Widoków agenta zależy od kolejności kart w odpowiedzi canvasu (kolejność ze stanu przestrzeni); zmiana samej kolejności kart przez serwer dałaby nową wersję.
3. Na `/agent-views` karty pochodzą z tego, co rysuje `CanvasInner` (zapytanie przestrzeni), a przed pojawieniem się canvasu — z odpowiedzi `agent-views` strony; przez chwilę po utworzeniu pierwszego widoku mogą to być dwa źródła o różnej świeżości (oba unieważniane tym samym zdarzeniem `canvas_changed`).
4. Konflikty scalania z Taskiem 6 prawdopodobne w `UiCommandRunner.tsx` (reveal przez `pollUntil`), `uiCommandAck.ts`, `scripted-server.ts`.

---

## Merge round — fix L1

Commit: `7bb8a8e` — Merge round L1: przestrzen sprzed przelaczenia tozsamosci nie wraca przez cardsSpaceId; Widoki agenta bez kart przestrzeni roboczej (na `5e94c3c`).

### Zmiany

**L1 (identity isolation).** `createShellSnapshotSource` odczytuje przestrzeń trzymaną przy przełączeniu (`heldAtSwitch.spaceId`) i, jeśli przestrzeń zgłoszona jako wyświetlana (`displayedCanvas`) jest tą samą przestrzenią, podaje ją jak brak przestrzeni: `cardsSpaceId: null`, `cards: []`, `cardsState: 'none'` — do czasu przejścia powłoki do innej przestrzeni (ta sama reguła co dla `spaceId`, `conversationId` i parametrów `c`/`s` adresu). Kontrakt `cardsSpaceId` opisuje ten wyjątek.

**Strona Widoków agenta nie zapada się do przestrzeni roboczej.** Decyzja strony, co zgłosić, wydzielona do czystej funkcji `agentViewsDisplay({conversationId, data, failed})` (eksport z `AgentViewsPage.tsx`), zgodnej z tym, co strona rysuje: bez `c` → `none` (`[]`); błąd — także z danymi w pamięci podręcznej — → `error` (`cards: null`, bez przestrzeni); ładowanie → `loading`; brak przestrzeni → `none`; przestrzeń bez kart → `loaded`, `[]`; z kartami → `null` (canvas zgłasza się sam). Strona zgłasza zawsze, więc opis `/agent-views` nigdy nie bierze kart przestrzeni roboczej.

**`cardsState`** (nowe pole kontraktu, `UI_CARDS_STATES`): `loaded | loading | error | none`. `cards: null` znaczy „nie wiadomo” (`loading`/`error`), `[]` przy `none` — brak przestrzeni do pokazania. Kontrakt mówi, że publikacja po uspokojeniu nie czeka na karty; prompt „## Stan ekranu”: „cards: null znaczy „nie wiadomo” … odczytaj ponownie z minVersion = version + 1”. `CanvasInner` zgłasza `loaded`/`error`/`loading` ze swojego zapytania; ścieżka przestrzeni roboczej (bez wyświetlanej) — `none` bez przestrzeni, `error` przy nieudanym odczycie, inaczej `loading`/`loaded`.

**Porządek kart.** `CanvasService.getState`: `ORDER BY created_at, id` — karty z tej samej milisekundy mają stały porządek, więc wersja kompozycji Widoków agenta nie zależy od kolejności zapisu (obawa 2 rundy scalania rozwiązana).

### Testy

`tests/ui-snapshot.test.ts` 52 → **56** (test kontraktu lub logiki); zaktualizowane literały Merge round o `state`/`cardsState`:
- **L1**: prawdziwy `setAccessContext`, źródło i sesja. Jako `local-user` canvas pokazuje `spc_of_local_user` (`cardsSpaceId` = ta przestrzeń). Po przełączeniu canvas nadal pokazuje tę przestrzeń (odczyt nieudany): opis `spaceId: null`, `cardsSpaceId: null`, `cards: []`, `cardsState: none`, `url: '/'`, **żadne wystąpienie** `spc_of_local_user`. Po przejściu powłoki do `spc_of_other_user` — podawana.
- **Widoki agenta**: sześć stanów `agentViewsDisplay` (w tym błąd z danymi w pamięci → `error` bez przestrzeni) i opis `/agent-views` z przestrzenią roboczą w pamięci: bez rozmowy `cards: []`/`none`, z błędem `cards: null`/`error` — w obu bez kart i id przestrzeni roboczej.
- **Porządek kart**: dwie karty wstawione SQL w tej samej milisekundzie w kolejności `crd_zzz_b`, `crd_aaa_a` → `getState` zwraca `crd_aaa_a`, `crd_zzz_b`.
- **Prompt**: zasada `cards: null`.

`e2e/ui-state.spec.ts` (symulacja), rozszerzony test przełączenia: najpierw `/` (powłoka trzyma przestrzeń roboczą pierwszego właściciela, `s` w adresie), przejście na Ustawienia **w aplikacji** (link nawigacji), tabela w czacie, przełączenie; opis na Ustawieniach bez id przestrzeni; potem link **Canvas** w aplikacji (warunek wstępny: `s` w adresie nadal = przestrzeń sprzed przełączenia): opis nowego właściciela z celem `platform.canvas` ma `spaceId: null`, `cardsSpaceId: null`, `cardsState: none`, `cards: []` i nigdzie nie zawiera id tej przestrzeni.

### Polecenia i wyniki (stan `7bb8a8e`)

| Polecenie | Wynik |
|---|---|
| `pnpm exec vitest run tests/ui-snapshot.test.ts tests/agent-views.test.ts` | exit 0, **87 passed** (56 + 31) |
| `pnpm verify` | **exit 0** — spójność OK, macierz zgodna, typecheck, build, **Vitest 29 plików / 472 testy** |
| `flock -w 5400 …/.e2e.lock pnpm exec playwright test e2e/ui-state.spec.ts e2e/agent-views.spec.ts e2e/access-context.spec.ts` (po `pnpm verify`) | **exit 0, 20 passed** (ui-state 10, agent-views 7, access-context 3) |

Drzewo czyste po przebiegach (te spece nie wygenerowały nieśledzonych dowodów).

### Próby zdolności wykrycia (na `7bb8a8e`, czyste drzewo → wycofanie → test → `git checkout -- <plik>` → czyste)

| Próba | Wycofanie | Test | Wynik z wycofaniem |
|---|---|---|---|
| L1 | filtr przestrzeni trzymanej przy przełączeniu wyłączony | Vitest | **1 failed / 55**: `expected { version: 2, … } to match object { spaceId: null, … }` |
| G-L1 | jw. | `pnpm build` + `flock … playwright test e2e/ui-state.spec.ts -g "przelaczenie tozsamosci na Ustawieniach"` | **1 failed**: linia 433 — opis na canvasie po przełączeniu ma `cardsSpaceId`/`cardsState` przestrzeni sprzed przełączenia |
| M1 | `agentViewsDisplay` bez gałęzi błędu (błąd z danymi w pamięci traktowany jak dane) | Vitest | **1 failed / 55**: `expected null to match object { spaceId: null, cards: null, … }` |
| M2 | `ORDER BY created_at` bez `id` | Vitest | **1 failed / 55**: `expected [ 'crd_zzz_b', 'crd_aaa_a' ] to deeply equal [ 'crd_aaa_a', 'crd_zzz_b' ]` |
| M3 | prompt bez zasady `cards: null` | Vitest | **1 failed / 55** |

Po próbach `pnpm build` na przywróconym kodzie; bramka z tabeli wyżej uruchomiona po próbach.

### Nieudane przebiegi w tej rundzie

1. `tsc` po zmianie kontraktu: literały testów rundy scalania bez `state` i fixture bez `cardsState` — oczekiwane; uzupełnione. Innych nieudanych przebiegów nie było.

### Kontrakt dla autora modułu — uzupełnienie

- Ekran pokazujący przestrzeń canvasu inną niż robocza zgłasza `useDisplayCanvas({spaceId, scopeKind, cards, state})` z `state` ∈ `loaded | loading | error | none` — także gdy nic nie pokazuje (wtedy opis nie wróci do przestrzeni roboczej).

### Obawy po rundzie

1. Po przełączeniu tożsamości canvas nadal próbuje wczytać przestrzeń poprzedniego właściciela (odmowa) i pokazuje błąd, dopóki powłoka nie zmieni przestrzeni — opis tego nie podaje, ale sam ekran tak (zachowanie powłoki sprzed T3, jak tabela w czacie z rundy 3).
2. Obawy 1, 3 i 4 rundy scalania bez zmian; obawa 2 (kolejność kart) rozwiązana.
