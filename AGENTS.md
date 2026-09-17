# AGENTS.md — punkt wejścia dla wykonawcy

Ten plik jest dla agenta lub osoby, która dostaje zadanie w tym repozytorium. Nie powtarza
specyfikacji — mówi, gdzie ona jest, co ma pierwszeństwo i jakie są zasady pracy oraz dowodu.

## Cel repozytorium

`agentic-app-template` to szablon lokalnej aplikacji agentowej: **platforma wielokrotnego użytku**
(czat, wykonanie agenta, historia, artefakty, pliki, komunikacja), **wymienialny moduł domenowy**
(przykład: porównywanie ofert) oraz dokumentacja. Kolejny produkt powstaje przez zmianę modułu
domenowego, bez ponownego pisania platformy.

Stan jest **bazową wersją roboczą**: aplikacja działa i ma regresję, ale nie spełnia jeszcze
wszystkich 200 kryteriów specyfikacji. Nie ogłaszaj pełnego odbioru bez macierzy, która go wykazuje.

## Pierwszeństwo źródeł

1. **Polecenie zamawiającego** dla bieżącego zadania — w granicach poniższych zasad.
2. **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — obowiązująca specyfikacja: 12 warstw,
   200 kryteriów Lx.y, 27 prób Txx, zasady jakości testów i raportu. Ustala, co **ma** działać.
3. **Kod i testy** — ustalają, co **faktycznie** działa. Dokument nie jest dowodem działania.
4. **[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)** i **[`docs/BACKLOG.md`](docs/BACKLOG.md)** — ostatnia
   ocena każdego kryterium z dowodem oraz otwarte prace. Generowane; oceny edytuje się w
   `docs/acceptance/assessment.json`, potem `pnpm acceptance:render`.
5. **[`docs/NEW-APPLICATION.md`](docs/NEW-APPLICATION.md)** — kontrakt modułu domenowego.
6. **[`docs/archive/`](docs/archive/)** — historia. Wyniki archiwalne dotyczą innego katalogu i starszej
   wersji wymagań; nie potwierdzają stanu tego repozytorium.

Mapa wszystkich dokumentów: [`docs/DOCUMENTATION-MAP.md`](docs/DOCUMENTATION-MAP.md).

## Granica platforma–domena (nie do negocjacji)

- `packages/platform-*` nie importują i nie deklarują `@module/*` i nie zawierają słownika domeny.
  Sprawdza to `pnpm check:boundaries` (słownik pochodzi z `agenticApp.domainVocabulary` modułów).
- Moduł domenowy dostaje usługi platformy przez fabrykę i kontrakty z `platform-contracts`.
- Moduły łączy wyłącznie warstwa składania: `apps/server/src/compose.ts`, `apps/web/src/compose.tsx`,
  `apps/web/src/router.tsx`.
- Dane biznesowe należą do serwisów backendu. MCP udostępnia operacje, AG-UI przenosi zdarzenia,
  OpenUI opisuje i renderuje kompozycje. Żaden z tych mechanizmów nie jest bazą danych.
- Brak potrzebnej funkcji platformy rozszerza się w platformie w sposób neutralny domenowo, a nie
  obchodzi w module.

## Stos i ograniczenia, których nie zmieniasz bez decyzji zamawiającego

- React + TypeScript + Vite, TanStack Router/Query, React Flow, OpenUI Lang/Renderer i gotowy
  **OpenUI Agent Interface** (rozszerzenia przez publiczne propsy, sloty i wąskie adaptery — nie
  pisze się własnego czatu), Hono, Mastra, Claude Agent SDK, MCP, Zod, SQLite + Drizzle,
  Vitest i Playwright.
- **Claude wyłącznie z subskrypcji użytkownika.** Nie dodawaj klucza API Anthropic, gatewaya ani
  płatnego fallbacku, także „tymczasowo” przy błędzie logowania. Brak dostępu to blokada konkretnej
  próby, nie powód do atrapy.
- Nie ujawniaj sekretów: nie kopiuj tokenów do logów, raportów, dowodów ani commitów.
- Langfuse jest opcjonalny; włączony eksport wymaga dowodu odbioru śladu.

## Zasady pracy

- **Najpierw przeczytaj** odpowiednie kryteria w `docs/ARCHITECTURE.md` i ich wiersze w
  `docs/ACCEPTANCE.md`. Zmiana ma wskazywać kryteria, których dotyczy.
- **Dane użytkownika są nietykalne.** Testy i próby używają własnych katalogów (`.e2e*`,
  katalogi tymczasowe) i własnych procesów. Nie podłączaj się do instancji, której test nie
  uruchomił; nie zabijaj procesów po nazwie; nie czyść portów globalnie. Nie uruchamiaj migracji na
  cudzych danych bez wyraźnej zgody — najpierw kopia i próba (`docs/odzyskiwanie-stanu.md`).
- `pnpm acceptance` i `scripts/run-agent.mjs` zapisują dane w instancji pod `APP_BASE` (domyślnie
  port 8791) i nie sprawdzają etykiety instancji testowej — kieruj je wyłącznie na własną instancję
  z osobnym katalogiem danych. `pnpm dev` ma proxy na stały port 8791.
- Zależności instaluj z lockfile (`pnpm install --frozen-lockfile`). Aktualizacja zależności to
  zmiana wymagająca regresji, nie skutek uboczny.
- Nie wyłączaj kontroli (`check:*`, testów, asercji), żeby przeszedł build. Jeśli kontrola jest
  błędna, popraw ją i wykaż, że nadal potrafi oblać.
- Rozszerzenia gotowych bibliotek: przez publiczne API. Ingerencja w cudzy markup lub klasy CSS
  jest ostatecznością, opisaną i chronioną testem przynależności.

## Wymagane dowody

Rodzaj dowodu nie jest statusem. W raporcie i w `assessment.json` rozróżniaj: **rzeczywisty model**,
**test GUI bez modelu**, **test kontraktu lub logiki**, **symulacja**, **analiza kodu**.

- Kryterium jest **potwierdzone** tylko dowodem uzyskanym na kodzie tego repozytorium. Wynik
  historyczny nie zalicza zmienionej integracji.
- Test GUI zaczyna się interakcją w GUI i kończy widocznym wynikiem. API może przygotować dane i
  dodatkowo sprawdzić rezultat, ale nie zastępuje funkcji, której dotyczy test.
- Streaming: co najmniej dwa różne stany odpowiedzi przed końcem wykonania; odpowiedź tylko na końcu
  musi oblać. Nowy artefakt lub karta: nowy identyfikator powiązany z badanym wykonaniem. Odtworzenie
  po przeładowaniu: bez ręcznego otwierania rozmowy.
- Każda krytyczna naprawa ma **kontrolę negatywną** — dowód, że test oblewa bez poprawki.
- Kluczowe przepływy potwierdza przebieg z prawdziwym modelem; symulacje oznacz jako symulacje.
- Nieudany przebieg na tym samym kodzie zostaje w raporcie razem z wyjaśnieniem.
- Niespełnione wymaganie nie staje się spełnione przez przeniesienie go do „ograniczeń biblioteki”.

## Bramki przed oddaniem

```bash
pnpm install --frozen-lockfile
pnpm verify          # granica, macierz 200, macierze historyczne, typy (pakiety + e2e), build, testy
pnpm test:e2e        # przeglądarka na istniejącym buildzie produkcyjnym (po verify/build — inaczej testuje stary bundle);
                     # BEZ testów z prawdziwym modelem — nie zużywa ani jednej tury subskrypcji
pnpm test:e2e:model  # tylko testy z prawdziwym modelem; koszt: 11 tur subskrypcji na przebieg
pnpm check:module-swap   # przy zmianach kontraktu modułu lub warstwy składania
```

`pnpm typecheck` sprawdza dwie konfiguracje: `tsconfig.json` (pakiety, aplikacje, `tests/`, `scripts/`)
i `tsconfig.e2e.json` (`e2e/` i `playwright.config.ts`). Playwright uruchamia TypeScript bez sprawdzania
typów, więc bez tej drugiej bramki błąd typu w specu wychodzi dopiero w trakcie przebiegu — przy testach
modelowych kosztuje turę.

**Testy z prawdziwym modelem są świadomym wyborem, nie domyślnym.** `e2e/bl01-bl02-model.spec.ts`
(7 tur), `e2e/agent-ui.spec.ts` (2) i `e2e/files-agent.spec.ts` (2) nie należą do żadnego projektu
domyślnego przebiegu — żaden argument ani filtr do nich nie sięgnie. Uruchamia je wyłącznie
`pnpm test:e2e:model` (czyli `APP_E2E_MODEL=1`). Domyślny przebieg wypisuje, co pominął i ile by to
kosztowało. Licznik wydanych tur trzymany jest w kopii roboczej (`.e2e-model-turns/`, ignorowanej przez
git), zasiewany raz z zamkniętego rejestru `docs/evidence/bl01-bl02-2026-09-17/tury-modelu.json`, którego
spec **tylko czyta**; dowody przebiegu lądują pod stemplem przebiegu w `docs/evidence/<zadanie>/runs/`,
więc zapisany werdykt próby odbiorowej nie jest do nadpisania przez późniejszy przebieg.

Przed pierwszym poleceniem spec odbiorowy sprawdza, czy reszta budżetu pokrywa **cały** jego koszt
(deklarowany per próba). Jeśli nie — pomija próby z komunikatem podającym rejestr, sufit, brak i to, że
podniesienie sufitu wymaga grantu koordynatora. Nic nie idzie wtedy do modelu i żaden zapisany dowód nie
jest ruszany: pominięcie jest uczciwą odpowiedzią na brak budżetu, w przeciwieństwie do przebiegu, który
wydaje turę i pada na następnej.

Bramka i licznik obejmują **wyłącznie** spec odbiorowy. `e2e/agent-ui.spec.ts` i `e2e/files-agent.spec.ts`
wydają swoje 4 tury bez liczenia i bez sprawdzenia budżetu, więc `pnpm test:e2e:model` kosztuje 11 tur
także wtedy, gdy spec odbiorowy sam się pominie. Zanim uruchomisz przebieg modelowy, policz to sam.

Podaj faktyczne polecenia, kody wyjścia i liczby testów. Dowody zapisuj w `docs/evidence/<zadanie>/`
bez sekretów i danych prywatnych.

## Raportowanie

- `FEEDBACK.md` — dziennik: co zmieniono, dlaczego, jakie problemy znaleziono (także własne
  pomyłki), co zostało otwarte.
- `docs/acceptance/assessment.json` → `pnpm acceptance:render` — aktualizacja ocen kryteriów i
  backlogu; `pnpm check:acceptance` pilnuje, żeby sumy i pliki nie rozjechały się z ocenami.
- Raport końcowy oddziela: ukończenie implementacji, odbiór w izolacji i ewentualne uruchomienie z
  migracją na danych użytkownika (L12.17).
