# Plan realizacji BL-01 i BL-02

> Dokument roboczy architekta (koordynatora). Data: 2026-09-17. Gałąź integracyjna:
> `bl01-bl02/integracja` (od `main` 7f569c0, kod d142b85).
> **Wiążąca jest specyfikacja `docs/ARCHITECTURE.md`.** Ten plan jest jej argumentem: dzieli pracę,
> ustala kontrakty między zadaniami i wymagane dowody. W sprzeczności rozstrzyga specyfikacja.

## 0. Zakres i stan wyjściowy

| Pakiet | Kryteria | Próba | Stan wyjściowy (docs/ACCEPTANCE.md) |
|---|---|---|---|
| BL-01 | L2.16, L2.17, L6.15, L6.16, L6.17 | T25, T26 | 3 niespełnione, 2 częściowe |
| BL-02 | L3.14, L3.15, L3.16, L3.17, L3.18 | T27 | 2 niespełnione, 2 częściowe, 1 niesprawdzone |

Przebieg bazowy na 7f569c0 (worktree integracyjny, 2026-09-17 15:39): `pnpm verify` exit 0,
Vitest 23 pliki / 278 testów. Przed pracą przeczytaj treść swoich kryteriów w `docs/ARCHITECTURE.md`
(sekcje warstw 2, 3, 6, „Interakcja agenta z aplikacją”, „Semantyczny interfejs i przestrzeń
prezentacyjna agenta”, tabela prób T25–T27, „Jakość testów”) oraz ich wiersze w
`docs/BACKLOG.md` (BL-01, BL-02). `AGENTS.md` obowiązuje w całości.

## 1. Global Constraints (wiążą każde zadanie i każdy review)

**G1. Instancja i dane użytkownika są nietykalne.**
- Na tej maszynie działa instancja użytkownika: port **8791**, kod i dane w
  `/home/paczos/Documents/AgenticApp`. Nie wykonuj tam żadnego polecenia, nie czytaj jej bazy,
  nie wysyłaj żądań na 8791.
- Nie wykonuj poleceń w `/home/paczos/Documents/agentic-app-template` (główny checkout) ani w
  worktree innego zadania. Pracujesz **wyłącznie** w swoim worktree.
- Powłoka narzędzia Bash wraca po każdym wywołaniu do `/home/paczos/Documents/AgenticApp`.
  **Każde** polecenie zaczynaj od `cd <twój worktree> &&` albo używaj ścieżek bezwzględnych.
  `pnpm build` uruchomiony w złym katalogu nadpisałby `dist/`, który serwuje instancja użytkownika.
- Zakazane: `pnpm dev`, `pnpm acceptance`, `scripts/run-agent.mjs`, `pnpm reset`, `pkill`,
  `killall`, `fuser -k`, zabijanie procesów po nazwie, czyszczenie portów, `git push`, operacje na
  gałęziach innych niż własna, `git worktree remove`, zmiany w `~/.claude`.

**G2. Git.** Commituj na swojej gałęzi, małymi commitami z opisem po polsku. Nie przepisuj historii
opublikowanej przez innych, nie scalaj do `main`. Scalanie do gałęzi integracyjnej robi koordynator.

**G3. Granica platforma–domena** (AGENTS.md): `packages/platform-*` bez importów `@module/*` i bez
słownika domeny (`pnpm check:boundaries`). Brak funkcji platformy rozszerza się neutralnie domenowo w
platformie; moduł dostarcza nazwy, pola, operacje i kompozycje. Moduły łączy tylko warstwa składania
(`apps/server/src/compose.ts`, `apps/web/src/compose.tsx`, `apps/web/src/router.tsx`).

**G4. Testy przeglądarkowe.**
- Playwright uruchamiaj **wyłącznie** pod blokadą, wskazując pliki:
  `cd <worktree> && flock -w 5400 /home/paczos/Documents/agentic-app-template-wt/.e2e.lock pnpm exec playwright test <pliki>`.
  Pełnej suity (`pnpm test:e2e` bez plików) nie uruchamiasz — robi to koordynator.
- Suita testuje build produkcyjny: przed e2e wykonaj `pnpm build` w swoim worktree.
- Porty testowe 8792–8799 są przydzielone istniejącym specom. **Każdy nowy spec ze skryptowanym
  modelem używa portu 8798** i własnego katalogu `.e2e-scripted-<nazwa>`, a instancję zatrzymuje w
  `afterEach`/`afterAll`. Blokada gwarantuje, że dwa przebiegi nie działają jednocześnie.
- Pliki specyfikacji z prawdziwym modelem (zużywają tury subskrypcji) pisze i uruchamia tylko
  Zadanie 8. Pozostałe zadania nie uruchamiają `e2e/agent-ui.spec.ts` ani innych testów modelowych.

**G5. Model.** Tylko subskrypcja Claude przez istniejący runtime. Zakaz klucza API, gatewaya, fallbacku.
W zadaniach 1–7 zachowanie agenta dowodzi się skryptowanym modelem (`e2e/support/scripted-server.ts`)
wywołującym **prawdziwe** handlery narzędzi — oznaczone w raporcie jako „test GUI bez modelu”
albo „symulacja”, nigdy jako „rzeczywisty model”.

**G6. Dowody** (AGENTS.md „Wymagane dowody”, ARCHITECTURE.md „Jakość testów”):
- test GUI zaczyna się interakcją w GUI i kończy widocznym wynikiem; API może przygotować dane i
  dodatkowo sprawdzić rezultat, ale nie zastępuje funkcji;
- nowy obiekt (karta, widok) ma nowy identyfikator powiązany z badanym wykonaniem — zastany nie zalicza;
- każda nowa funkcja krytyczna ma **kontrolę negatywną** z treści kryterium; dodatkowo w raporcie
  opisz próbę zdolności wykrycia: na chwilę wycofaj kluczową linię poprawki (bez commitu), pokaż, że
  test oblewa, przywróć — z poleceniem i wynikiem;
- wartości na ekranie porównuje się z backendem (`/api/read`, trasy modułu), nigdy z tekstem modelu;
- nieudane przebiegi zostają w raporcie z wyjaśnieniem.

**G7. Zależności.** `pnpm install --frozen-lockfile`. Jedyna dopuszczona zmiana zależności:
`@openuidev/lang-core@0.2.18` jako bezpośrednia zależność pakietu, który go importuje (wersja już
jest w lockfile jako tranzytywna). Każda inna zmiana wymaga zgody koordynatora.

**G8. Dokumenty prowadzi koordynator.** Nie edytuj `docs/ACCEPTANCE.md`, `docs/BACKLOG.md`,
`docs/acceptance/assessment.json`, `FEEDBACK.md`, `README.md`, `docs/ARCHITECTURE.md`,
`docs/NEW-APPLICATION.md`. Zamiast tego w raporcie zadania dodaj sekcję **„Kontrakt dla autora
modułu”** (co moduł deklaruje, jakie są reguły i błędy). Komentarze w kodzie w dotychczasowym stylu
repozytorium (angielskie, tłumaczące *dlaczego*), napisy UI po polsku jak w istniejącym kodzie.

**G9. Kontrakty są jedne.** Typ TypeScript nie zastępuje walidacji w runtime. Schematy wystawiane
modelowi: bez `z.record()`, `.optional()` zamiast `.default()` (strażnik `assertMcpCompatibleShape`).
Nie duplikuj logiki (np. zawężania, formatowania, rozwiązywania operacji odczytu) — wydziel wspólną
funkcję i użyj jej w obu miejscach.

**G10. Bramka przed raportem DONE.** W swoim worktree: `pnpm verify` exit 0 oraz e2e plików
dotkniętych zmianą i nowych (pod blokadą, po `pnpm build`). W raporcie: polecenia, kody wyjścia,
liczby testów, lista uruchomionych speców, opis prób negatywnych.

## 2. Decyzje architektoniczne

**AD-1. Jeden runtime widoków dla widoków domyślnych i widoków agenta.** Robocze ekrany modułu są
kompozycjami OpenUI Lang renderowanymi przez `Renderer` z `@openuidev/react-lang` na wspólnym
katalogu (`registry.library`). Implementacja komponentów pozostaje w React. Powłoka, router i
gotowy czat pozostają deterministycznym React (ARCHITECTURE.md, „Semantyczny interfejs…”).

**AD-2. Dane wyłącznie przez deskryptor zarejestrowanego odczytu.** Komponenty danych dostają
`source: { operation: "<modul>.<operacja>", input?: {...} }` — nazwę operacji z istniejącego
rejestru `ModuleReadOperation` — nigdy wartości. Przeglądarka pobiera przez `POST /api/read`
(właściciel z sesji, walidacja wejścia schematem operacji). Rozwiązywanie operacji jest jedną
funkcją współdzieloną z artefaktami live. Cache TanStack Query: `['read', accessScope(), operation,
stabilnyJSON(input)]`, unieważniany tam, gdzie dziś `['module']`.

**AD-3. Deskryptor wyniku odczytu deklaruje moduł.** `ModuleReadOperation.result?:
ReadResultDescriptor` = `{ collection?: string; record: { kind; idField; titleField? }; fields:
RecordField[] }`, gdzie `RecordField = { field; label; type: 'text'|'number'|'money_minor'|
'quantity_milli'|'date'|'boolean'|'enum'; unit?; unitField?; values?; sortable? }`. Deskryptor
jest źródłem etykiet, formatowania, jednostek wykresu, dozwolonych pól sortowania, mapowania
rekord–pole i walidacji kompozycji. Pole spoza deskryptora jest odrzucane z nazwą, nigdy zgadywane.
Pola zawężania pozostają zadeklarowane w `UiTarget.filter` (istniejący kontrakt) i muszą należeć do
deskryptora odczytu, z którego korzysta widok.

**AD-4. Widoki modułu.** `ServerModule.views?: ViewDefinition[]`, `ViewDefinition = { id; title;
composition: string /* OpenUI Lang */; params?: string[] }`. `id` widoku z własnym ekranem jest
równy `id` jego `UiTarget`. Parametry trasy trafiają do kompozycji jako stan `$nazwa` (`initialState`
Renderera). Serwer udostępnia `GET /api/ui/views`; przeglądarka renderuje `ComposedView`.

**AD-5. Komponenty danych platformy** (neutralne domenowo, w katalogu OpenUI): `DataTable`,
`DataChart`, `DataSummary`. Schematy propsów są w `@platform/contracts` (bez Reacta), żeby serwer
mógł walidować kompozycje. Każdy wiersz/komórka niesie `data-record-kind`, `data-record-id`,
`data-field`; korzeń instancji `data-ui-instance` i `data-component`. Każda zamontowana instancja
zgłasza opis semantyczny do klienckiego rejestru `uiSemantics` (AD-7).

**AD-6. Stan widoku w adresie.** Zawężenie (istniejące kodowanie `?pole=wartość`), sortowanie
(`sort=pole` rosnąco, `sort=-pole` malejąco) i strona (`page=N`, od 1) dotyczą instancji głównej
widoku z `UiTarget` i żyją w adresie. `sort` i `page` dołączają do kluczy zarezerwowanych.
Kontrolki użytkownika i akcje agenta zmieniają ten sam adres; Wstecz cofa zmianę.
`AppContext.filters` jest wypełniany z tego stanu w chwili wysłania polecenia.

**AD-7. Semantyczny opis aktywnego UI.** Klient składa z rejestru `uiSemantics` wersjonowany
snapshot (widok, wersja kompozycji, instancje, rekord–pole, filtry, sortowanie, strona, widoczne
rekordy, dozwolone akcje), publikuje go do backendu (`PUT /api/ui/snapshot`), a narzędzie `ui_state`
zwraca najnowszy snapshot klienta oglądającego rozmowę wykonania, z wersją i oceną świeżości.
Potwierdzenie komendy UI niesie `uiVersion` snapshotu po jej wykonaniu. `AppContext.ui` niesie
wersję z chwili wysłania polecenia.

**AD-8. „Widoki agenta”.** Platformowa trasa `/agent-views`, pozycja nawigacji „Widoki agenta”, cel
`platform.agentViews`. Każda rozmowa ma własną przestrzeń canvas o zakresie `conversation:<id>`;
karty są kompozycjami `kind: 'openui'`. Narzędzia `agent_view_*` działają zawsze na przestrzeni
rozmowy **wykonania** (nie aktywnego UI), więc zadanie w tle nie zmienia widoku innej rozmowy.
Każda kompozycja OpenUI jest walidowana po stronie serwera parserem `@openuidev/lang-core`:
nieznany komponent, niezarejestrowana operacja, niezgodne wejście i niezadeklarowane pole są
odrzucane, a ostatnia poprawna wersja zostaje. W przestrzeni widoków agenta dozwolone są tylko
komponenty danych, komponenty modułów i jawna lista komponentów układu/tekstu — komponenty
przyjmujące wpisane przez model liczby (np. `Table`, `BarChart` z danymi literalnymi) są odrzucane.

**AD-9. Interakcje przez te same operacje domenowe.** Deskryptor odczytu może zadeklarować akcje
rekordu wskazujące narzędzie zapisu modułu. Platforma wykonuje je przez `POST /api/actions`
(właściciel z sesji, ponowny odczyt rekordu, idempotencja, ten sam handler co MCP). Ten sam
`DataTable` w widoku domyślnym i w widoku agenta wywołuje więc tę samą operację.

