# Aktualizacja szablonu o poprawki AgenticApp — 2026-09-17

**Zakres:** aktualizacja istniejącego repozytorium (nie ponowna konsolidacja). Przeniesienie
wszystkich poprawek wykonanych w AgenticApp po bazowej wersji szablonu (`v0.1.0-baseline`,
`825c086`), zachowanie celowych zmian szablonu, regresja w czystej kopii, aktualizacja macierzy i
backlogu, publikacja repozytorium jako **publicznego** GitHub template. Bez nowej rozbudowy ze
specyfikacji — nowe braki pozostają w [`BACKLOG.md`](BACKLOG.md). Punkt odniesienia: plan
konsolidacji (części A–E) z nadrzędnym celem aktualizacji; wcześniejszy raport:
[`CONSOLIDATION-REPORT.md`](CONSOLIDATION-REPORT.md).

## 0. Werdykt

- **Przeniesiono wszystkie poprawki kodu z AgenticApp od bazowej wersji** — 25 plików (21 zmienionych,
  4 nowe). Po przeniesieniu kod szablonu jest identyczny z AgenticApp; różni się wyłącznie 12 celowo
  zmienionymi plikami szablonu, których nie nadpisano (§2).
- **Regresja w czystej kopii `d142b85` przeszła:** `pnpm verify` 278/278, `pnpm test:e2e` 72/72 (cztery
  tury na prawdziwym modelu), sonda `ui_filter` na prawdziwym modelu, próba wymiany modułu, start
  produkcyjny (§4). Nieudane uruchomienie sondy (błąd configu próby) jest opisane.
- **Macierz:** 59 potwierdzonych, 118 częściowych, 15 niespełnionych, 8 niesprawdzonych z 200; 0 z 12
  warstw zamkniętych; próby 1 / 22 / 4 / 0. **L2.17 i BL-01 pozostają otwarte** (§5).
- **Publikacja:** §6.

## 1. Stan wejściowy

| Element | Stan |
|---|---|
| Szablon | `main` = `825c086`, tag `v0.1.0-baseline`, repozytorium prywatne, oznaczone jako template |
| AgenticApp | 261 plików w manifeście (bez `node_modules`, `dist`, `data`, `backups`, katalogów testowych), sha256 manifestu `3fbc1ceca5f1c56d1e1e43100b40a3852dc7829a7ba054be1ead357ddaad2e2f`; ostatnia zmiana plików 2026-09-17 10:22; dziennik do wpisu #41, raport do §4e |
| Porównanie | manifest AgenticApp z 2026-09-16 (po części A konsolidacji) → manifest bieżący: +5 plików, 27 zmienionych, 0 usuniętych |
| Przekazanie | `handoff-poprawki-agenticapp-2026-09-17.md` od wykonawcy odczytu, finalne (sha256 `a564efdf…`), zakres liczony wobec `825c086` |

Prace prowadzono na gałęzi lokalnej `update-2026-09-17`, a `main` został przesunięty dopiero po
regresji (fast-forward, bez przepisywania historii).

## 2. Mapa wszystkich różnic i decyzje

Porównanie całych drzew (AgenticApp teraz ↔ szablon po aktualizacji), po wyłączeniu stanu lokalnego i
wyników buildów/testów: **181 plików identycznych**, 12 różnych, 68 tylko w AgenticApp, 41 tylko w
szablonie.

### 2.1 Przeniesione (25) — decyzja: **przenieś**, bez zmian treści

Każdy plik sprawdzony przed skopiowaniem: jego wersja w szablonie była identyczna z commitem importu
`7340863`, więc kopiowanie nie mogło nadpisać poprawki konsolidacji. Po skopiowaniu `cmp` 25/25.

| Plik | Zmiana w AgenticApp (FEEDBACK #40–#41, RAPORT §4e) |
|---|---|
| `packages/platform-contracts/src/module.ts` | `ModuleToolDefinition.alwaysLoad`; `requestUi` z opcjonalnym `filter` |
| `packages/platform-contracts/src/ui.ts` | `UiTarget.filter`, operatory `eq/neq/contains/in`, schematy zawężenia, kodek adresu, `RESERVED_SEARCH_KEYS`, odmowy `not_filterable`/`unknown_field`/`not_applied`, `filtered` w wyniku |
| `packages/platform-server/src/agent/mcp.ts` | przekazanie `alwaysLoad` do `tool()` SDK |
| `packages/platform-server/src/agent/platform-tools.ts` | narzędzie `ui_filter`; `alwaysLoad` na `get_context`, `ui_catalog`, `ui_navigate`, `ui_filter`; `filterableFields` w katalogu |
| `packages/platform-server/src/agent/prompt.ts` | reguła „odpowiadanie o danych to też pokazywanie”, sekcja „Zawężanie widoku” |
| `packages/platform-server/src/agent/runtime.ts` | przekazanie `filter` do polecenia UI (`undefined` ≠ `null`) |
| `packages/platform-server/src/registry/ui-targets.ts` | odrzucenie pola filtra `c`/`s` przy budowie katalogu |
| `packages/platform-ui/src/api/queries.ts` | `useUiTargets`; zawężanie w `useModuleData` |
| `packages/platform-ui/src/shell/AppShell.tsx` | pasek zawężenia nad powierzchnią roboczą |
| `packages/platform-ui/src/shell/UiCommandRunner.tsx` | nawigacja z parametrami filtra, oczekiwanie na zgłoszenie widoku, `not_applied` |
| `packages/platform-ui/src/state/appState.ts` | `agentFilterKey`, `filterOutcome` |
| `packages/platform-ui/src/styles.css` | `.pf-viewfilter*` |
| `packages/platform-ui/src/shell/ViewFilterBanner.tsx` (nowy) | pasek z generowanym opisem, liczbami i przywróceniem |
| `packages/platform-ui/src/state/viewFilter.ts` (nowy) | `useActiveViewFilter` — filtr z adresu względem deklaracji widoku |
| `apps/web/src/router.tsx` | walidator adresu przepuszcza wszystkie parametry tekstowe; `retainSearchParams` bez zmian (`c`, `s`) |
| `packages/module-procurement/src/server/index.ts` | `filter` na celach `procurement.cases` i `procurement.data` |
| `packages/module-procurement/src/server/repository.ts` | `*`/`%` = wszystko (z limitem); `counts()` |
| `packages/module-procurement/src/server/services.ts` | `search` zwraca `results, matched, query, totals` |
| `packages/module-procurement/src/server/tools.ts` | opis narzędzia wyszukiwania (`totals`, zakaz wniosku „aplikacja jest pusta”) |
| `tests/view-filter.test.ts` (nowy) | 21 testów kontraktu zawężania i wyszukiwania |
| `tests/ui-navigation.test.ts` | lista narzędzi `ui_*` z `ui_filter` |
| `e2e/view-filter.spec.ts` (nowy) | 7 testów GUI na serwerze skryptowanym, port 8792 |
| `e2e/support/scripted-server.ts` | scenariusze `ui-filter-*` |
| `e2e/access-context.spec.ts` | link z filtrem po zmianie tożsamości nie pokazuje cudzych wierszy |
| `e2e/agent-ui.spec.ts` | test na prawdziwym modelu: pytanie o dane przenosi na ich widok |

Zależności (`package.json` pakietów, `pnpm-lock.yaml`) — **bez zmian**; `pnpm install --frozen-lockfile`
przechodzi. Kontrola granicy szablonu (słownik z manifestów modułów) na przeniesionym kodzie: 0 naruszeń.

### 2.2 Różne w obu drzewach (12) — decyzja: **zachowaj wersję szablonu**

| Plik | Dlaczego zostaje wersja szablonu |
|---|---|
| `package.json` | nazwa, `check:acceptance`, `acceptance:render`, `check:module-swap`; **`verify` buduje przed testami** (w AgenticApp odwrotnie — wada ujawniona czystą kopią 2026-09-16) |
| `packages/module-procurement/package.json` | `agenticApp.domainVocabulary` dla uogólnionej kontroli granicy |
| `scripts/check-boundaries.mjs` | wykrywanie pakietów i słownika bez nazwy modułu przykładowego |
| `scripts/matrix-summary.mjs`, `closure-matrix.mjs`, `audit-matrix.mjs` | czytają dokumenty z `docs/archive/` |
| `.gitignore` | lokalne ustawienia narzędzi, logi, katalog próby wymiany |
| `README.md`, `FEEDBACK.md` | dokumenty szablonu (treść AgenticApp scalona lub zarchiwizowana — §2.4) |
| `docs/ARCHITECTURE.md`, `docs/DOCUMENTATION-MAP.md` | ta sama treść, inny nagłówek i ścieżki właściwe dla repozytorium |
| `docs/odzyskiwanie-stanu.md` | wersja szablonu z liczbami oznaczonymi jako historyczne i opisem braku `platform-0003` w próbie migracji |

### 2.3 Tylko w AgenticApp (68) — decyzja: **pomiń w kodzie; dokumenty zarchiwizowane lub lokalne**

| Pliki | Decyzja | Uzasadnienie |
|---|---|---|
| `docs/evidence/**` (64, w tym nowy `chat-ux-2026-09-16/05-zawezony-widok.png` i zmienione pomiary `closure-2026-09-15/2*.json`) | pomiń, zostają lokalnie | dowody konkretnego wdrożenia, z lokalnymi ścieżkami i śladami sesji; szablon ma własne dowody |
| `RAPORT-DOMKNIECIA-PLATFORMY.md`, `RAPORT-STANU-PLATFORMY.md` | archiwum w `docs/archive/agenticapp-2026-09/` (raport domknięcia zaktualizowany do stanu z §4e) | historia wdrożenia; wyniki nie potwierdzają szablonu |
| `stack-agentowy-ustalenia-i-materialy.md`, `docs/archive/stack-agentowy-…-95-kryteriow.md` | pomiń odsyłacz; wersja 95 jest w `docs/archive/agenticapp-2026-09/` | szablon ma `docs/ARCHITECTURE.md` |
| pusty katalog `packages/platform-server/src/http/routes/` | pomiń | bez plików i importów (ustalenie przekazania, potwierdzone) |

### 2.4 Tylko w szablonie (41) — decyzja: **zachowaj**

`AGENTS.md`, `CLAUDE.md`, `docs/NEW-APPLICATION.md`, `docs/ACCEPTANCE.md`, `docs/BACKLOG.md`,
`docs/acceptance/assessment.json`, `docs/CONSOLIDATION-REPORT.md`, ten raport, `docs/archive/**`,
`docs/evidence/template-consolidation/**`, `docs/evidence/template-update-2026-09-17/**`,
`scripts/acceptance-matrix.mjs`, `scripts/check-module-swap.mjs` — aparat odbioru i dokumentacja szablonu.

### 2.5 Dokumentacja zaktualizowana w tej aktualizacji

| Plik | Zmiana |
|---|---|
| `README.md` | zawężanie widoku (adres, pasek, uprawnienia, brak przenoszenia między ekranami), nawigacja po pytaniu o dane, ograniczenia (brak sortowania, filtr poza kontekstem), porty e2e 8792–8799, cztery tury modelu |
| `AGENTS.md` | cztery testy zużywające tury |
| `docs/NEW-APPLICATION.md` | `alwaysLoad`, `UiTarget.filter`, `useModuleData` jako miejsce zawężania, klucze `c`/`s`, nowe pułapki (odraczanie narzędzi przez SDK, wyszukiwanie `*` i `totals`) |
| `docs/archive/agenticapp-2026-09/FEEDBACK.md`, `RAPORT-DOMKNIECIA-PLATFORMY.md`, `docs/archive/README.md` | kopie historyczne zaktualizowane do stanu z 2026-09-17 |
| `docs/DOCUMENTATION-MAP.md` | §5 — rozliczenie dokumentów aktualizacji |
| `docs/acceptance/assessment.json` → `ACCEPTANCE.md`, `BACKLOG.md` | oceny §5 |
| `FEEDBACK.md` | wpis T2 |

## 3. Rozliczenie przekazania (handoff)

| Punkt | Rozliczenie |
|---|---|
| §0 zakres 25 plików wobec `825c086` | zgodny z własną mapą (§2.1); przeniesione w `d142b85` przez tego wykonawcę (przekazanie obserwowało ten commit w trakcie powstawania); `cmp` 25/25 |
| §1 runda A (panel rozmowy) w bazie | potwierdzone: pliki czatu identyczne, pochodzą z importu `7340863` |
| §2–§4 poprawki B1–B3 | przeniesione; B1 i B3 opisane w `NEW-APPLICATION.md`, B2 w README i `NEW-APPLICATION.md` |
| §3 cztery decyzje do zachowania, brak przenoszenia filtrów między ekranami | zachowane w kodzie (bez zmian treści) i opisane w dokumentacji; `retainSearchParams(['c','s'])` bez zmian |
| §5 celowe różnice szablonu — nie nadpisywać | zachowane (§2.2); `check:boundaries`, `check:module-swap`, kolejność build→test i macierz działają w regresji |
| §6 zależności bez zmian, port 8792 wolny | potwierdzone: install z lockfile, suita 72/72 bez kolizji portów |
| §7b liczby z AgenticApp (278, 72/72, 22,8 s) | **nie przyjęte jako dowód szablonu**; własna regresja potwierdziła 278 i 72/72; czas testu nawigacji w szablonie 25,6 s |
| §7c „nie wiem, czy `verify` przechodzi po `d142b85`” | przechodzi — `check:acceptance` nie wykrywał dryfu, bo `ARCHITECTURE.md` i oceny się nie zmieniły; po aktualizacji ocen pliki przerenderowane |
| **R1** macierz nieaktualna | zaktualizowana po obejrzeniu dowodów (§5) |
| **R2** filtry nie docierają do kontekstu agenta | potwierdzone (`setFilter` bez wywołań); **niezmienione** (bez rozbudowy) — wpisane do BL-01, uzasadnia status częściowy L2.17, L6.1, L6.17 |
| **R3** brak sortowania i paginacji | potwierdzone; w BL-01; L2.17 nie może być potwierdzone |
| **R4** brak trwałych preferencji na koncie | w BL-01 |
| **R5** ruchomy stan szablonu | stan wyjaśniony: równoległa zmiana dokumentacji w migawce przekazania to prace tego wykonawcy |
| **R6** angielskie napisy przeglądarki artefaktów | znane ograniczenie w archiwalnym raporcie §7; bez zmian |
| **R7** kontrolki kompozytora zależne od klas CSS | chronione przez `e2e/chat-layout.spec.ts` (4/4 w regresji); bez zmian |
| **R8** deklaracja ≠ dowód | stosowane: oceny oparte wyłącznie na regresji szablonu i sondzie |
| §10 lista kontrolna 1–8 | wykonana w całości |

## 4. Regresja

Dowody: [`evidence/template-update-2026-09-17/`](evidence/template-update-2026-09-17/).

| Próba | Stan kodu | Wynik |
|---|---|---|
| `pnpm verify` (gałąź robocza, przed commitem) | drzewo robocze | 0; 23 pliki / 278 testów |
| `pnpm check:module-swap` (drzewo robocze) | drzewo robocze | 0 |
| czysta kopia: `pnpm install --frozen-lockfile` | `d142b85` | 0 |
| czysta kopia: `pnpm verify` | `d142b85` | 0; 278/278; macierz spójna |
| czysta kopia: `pnpm test:e2e` | `d142b85` | **72/72**, 7,0 min, bez ponowień (`retries: 0`); cztery tury na prawdziwym modelu |
| czysta kopia: sonda `ui_filter` na prawdziwym modelu, uruchomienie 1 | `d142b85` | **nie wystartowała** — config sondy wczytany jako CJS (błąd narzędzia próby) |
| czysta kopia: sonda, uruchomienie 2 | `d142b85` | 1/1, 56,2 s: zawężenie do PL (3 z 4) i przywrócenie (4) |
| czysta kopia: start produkcyjny | `d142b85` | health, dane startowe, restart bez ponownego zasiewania, `seed`, `seed --force`, `APP_SKIP_BASE_DATA` — OK |
| czysta kopia: `pnpm check:module-swap` | `d142b85` | 0 |
| kopia z GitHuba po publikacji | commit końcowy | §6 |

**Rzeczywisty agent dla zmienionych przepływów:** nawigacja po pytaniu o dane — test regresji
(`agent-ui.spec.ts`); zawężanie widoku — sonda jednorazowa (`09-sonda-ui-filter-model.json`).
Obserwacja z sondy: model użył kolejno `country=Polska`, `country=Poland` (po 0 z 4) i dopiero `PL`,
mimo zadeklarowanych wartości. Potwierdzenie z liczbami pozwoliło mu się poprawić; kosztem były dwa
chwilowe puste widoki. Zapisane w BL-01.

**Izolacja:** wszystkie przebiegi w czystych kopiach poza repozytoriami, na portach 8792–8799 lub
efemerycznych. AgenticApp: manifest na końcu identyczny z początkowym; instancja użytkownika na 8791
(pid 1819385, start 10:22:58) nieprzerwana; pliki bazy bez zmian od 10:23 (przed rozpoczęciem prac);
nie zabijano żadnych procesów.

## 5. Macierz i backlog

| Kryterium / próba | Było | Jest | Podstawa |
|---|---|---|---|
| L2.13 | częściowe (bez modelu) | częściowe, **dowód: prawdziwy model** | test „pytanie o dane przenosi na ich widok”; brak próby podświetlenia ustawienia i przełączenia przestrzeni przez model |
| L2.15 | częściowe | częściowe | dopisane: zawężenie z Wstecz i odświeżeniem; kontekst po nawigacji nadal nieaktualizowany |
| **L2.17** | niespełnione | **częściowe** | `ui_filter` ustawia i czyści zawężenie, wynik widoczny, dane nietknięte (e2e + sonda); **brak sortowania, filtr poza kontekstem agenta** |
| L6.1 | częściowe | częściowe | brak opisu zaktualizowany: zawężenie w adresie, `filters` w kontekście puste |
| L6.11 | częściowe | częściowe | dopisane `totals` w wyszukiwaniu |
| **L6.13** | częściowe | **potwierdzone** | handler `ui_catalog` w teście; nawigacja i zawężanie przez typowany kontrakt wywołane przez prawdziwy model; zastrzeżenia w macierzy |
| L6.15 | niespełnione | niespełnione | katalog podaje deklarowane pola, nie aktualny stan ekranu |
| **L6.17** | niespełnione | **częściowe** | potwierdzony stan po akcji w wyniku narzędzia, użyty przez model do korekty; brak wersji kontekstu i stanu w kolejnej turze |
| L1.12, L1.13, L12.14 | — | bez zmiany statusu | dowody zaktualizowane o przebieg `d142b85` |
| T23 | częściowe | częściowe | dopisany przebieg z prawdziwym modelem |
| **T26** | niespełnione | **częściowe** | zawężanie przez rozmowę działa; brak sortowania i uwzględnienia filtra w kolejnym pytaniu |

Sumy (wyliczone): **59 potwierdzonych, 118 częściowych, 15 niespełnionych, 8 niesprawdzonych**
(było 58 / 117 / 17 / 8); próby 1 / 22 / 4 / 0; 0 z 12 warstw zamkniętych; 141 otwartych kryteriów w
12 pakietach. Pozostałe oceny z 2026-09-16 nie zmieniły się — żaden test, na którym się opierały, nie
oblał.

**BL-01 pozostaje otwarty** z opisem stanu: zaimplementowane zawężanie filtrem dla widoków
deklarujących pola; do zrobienia — zawężenie w kontekście agenta (R2), sortowanie i paginacja w adresie
(R3), trwałe preferencje (R4), wersjonowany opis aktywnej kompozycji, wskazanie wartości pola,
zawężanie po stronie serwera dla dużych zbiorów, trafianie w zadeklarowane wartości.

## 6. Publikacja

_Sekcja uzupełniana po wypchnięciu i zmianie widoczności — patrz kolejny commit z tym plikiem._

## 7. Ograniczenia i próby niewykonane

| Rodzaj | Co |
|---|---|
| niewykonane w tej aktualizacji | `docker build --no-cache` (Dockerfile i zależności bez zmian — dowód z 2026-09-16); kontrole negatywne `check:boundaries` i `check:acceptance` (skrypty bez zmian — dowód z 2026-09-16) |
| niewykonane, środowisko | `pnpm dev` (proxy na 8791, zajęty przez instancję użytkownika); mapowanie portu kontenera z hosta (rootless Docker na tej maszynie); przeglądarki Playwright na nowej maszynie |
| niewykonane, brak próby | podświetlenie ustawienia i przełączenie przestrzeni przez prawdziwy model; zachowanie „aplikacja jest pusta” po poprawce `totals` na prawdziwym modelu (poprawka kontraktu sprawdzona testem, nie turą modelu); sonda `ui_filter` nie jest częścią regresji |
| implementacja (bez zmian w tej fazie) | zawężenie poza kontekstem agenta; brak sortowania i paginacji; zawężanie tylko na danych już pobranych; wady z raportu z 2026-09-16 (§6.1) — w tym kontekst ze startu wykonania, idempotencja bez odcisku treści, zgoda bez powiązania z wykonaniem, sandbox bez `denyRead` dla katalogu konfiguracji Claude |
| decyzja użytkownika | licencja — repozytorium nadal bez pliku licencji; nie wybrano jej |

Pełna lista otwartych prac: [`BACKLOG.md`](BACKLOG.md).
