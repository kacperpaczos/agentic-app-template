# Wspólne zasady dla implementatorów (fala 1 i kolejne)

Repozytorium: `agentic-app-template` — szablon lokalnej aplikacji agentowej (React/Vite/TanStack/OpenUI
frontend, Hono/Mastra/Claude Agent SDK backend, SQLite). Realizujemy pakiety BL-01 i BL-02 według planu,
w kilku zadaniach równoległych w osobnych worktree. Koordynator scala gałęzie i rozwiązuje konflikty.

## Bezpieczeństwo (bezwzględne)
- Pracujesz WYŁĄCZNIE w swoim worktree (ścieżka w poleceniu). Nie wykonujesz poleceń ani nie edytujesz
  plików w `/home/paczos/Documents/AgenticApp` (działająca aplikacja użytkownika, port 8791),
  `/home/paczos/Documents/agentic-app-template` (główny checkout) ani w worktree innych zadań.
- Narzędzie Bash po każdym wywołaniu wraca do `/home/paczos/Documents/AgenticApp`. KAŻDE polecenie zaczynaj
  od `cd <twój worktree> && ...`; narzędzia plików — tylko ścieżki bezwzględne w twoim worktree.
- Pełna lista zakazów i reguł: G1–G10 w `globals.md` (ten sam katalog). Są wiążące.

## Co przeczytać najpierw
1. `globals.md` — ograniczenia G1–G10 i decyzje architektoniczne AD-1…AD-9 (wiążące).
2. Swój brief `task-N-brief.md` — wymagania i minimalne testy/dowody.
3. Stan po zadaniu 1 (fundament, już w twojej gałęzi): raport
   `task-1-report.md`, sekcje **1** (co powstało), **2** (decyzje), **7** (kontrakt dla autora modułu),
   **8** (szwy dla fali 1) oraz sekcja **„Fix round 1”** na końcu (stan opisu instancji `state`,
   stabilny rejestr `uiSemantics`, kontrole deskryptora).
4. W worktree: `AGENTS.md`, właściwe kryteria w `docs/ARCHITECTURE.md` i wiersze w `docs/BACKLOG.md`.

## Równoległość
Równolegle pracują inne zadania fali 1 na tej samej bazie (3097586):
- Task 2 — sortowanie, paginacja, kontrolki filtra, stan widoku w `AppContext.filters` (`DataTable`, adres,
  `UiCommandRunner`, `ui_sort`);
- Task 3 — snapshot semantyczny UI, `PUT /api/ui/snapshot`, `ui_state`, `uiVersion`, `AppContext.ui`;
- Task 4 — „Widoki agenta”, walidator OpenUI na `@openuidev/lang-core`, `agent_view_*`, `groupBy`;
- Task 5 — ekrany szczegółów modułu (`/cases/$caseId`, `/items/$itemId`) jako kompozycje.
Trzymaj się swojego zakresu. Nowe narzędzia w osobnych plikach `agent/tools/<nazwa>.ts`; zmiany we
wspólnych plikach (`prompt.ts`, `UiCommandRunner.tsx`, `appState.ts`, `scripted-server.ts`, `router.tsx`,
`DataTable.tsx`) minimalne i lokalne, żeby scalanie było proste. Nie zmieniaj istniejących kontraktów
z `views.ts` w sposób łamiący zgodność; nowe pola tylko dopisuj (propsy komponentów danych na KOŃCU
schematu — argumenty OpenUI Lang są pozycyjne w kolejności kluczy schematu). Jeśli musisz zmienić
kontrakt inaczej — NEEDS_CONTEXT.

## Stan gałęzi integracyjnej (aktualizacja przed falą 2)
Scalone i przejrzane: Task 1 (fundament), Task 5 (ekrany szczegółów), Task 2 (stan widoku: sort/strona/filtr w
adresie, `DataTableControls`, `ui_sort`, `uiCommandPlan.ts`), Task 4 („Widoki agenta”, walidator OpenUI na
lang-core, `agent_view_*`, `groupBy`, deklaracje komponentów modułu w `shared/openui-components.ts`).
Task 3 (snapshot UI, `ui_state`, `uiVersion`/`uiClientId`/`uiPublication`, `uiCommandAck.ts`, epoka dostępu)
jest w ostatniej rundzie i zostanie scalony wkrótce. Raporty: `task-2-report.md`, `task-3-report.md`,
`task-4-report.md`, `task-5-report.md` (sekcje „Kontrakt dla autora modułu” i rundy poprawek/scalania).

## Testy przeglądarkowe
`cd <worktree> && pnpm build && flock -w 5400 /home/paczos/Documents/agentic-app-template-wt/.e2e.lock pnpm exec playwright test <pliki>`
Blokada może czekać na inne zadania — to normalne. Nowe spece ze skryptowanym modelem: port 8798, katalog
`.e2e-scripted-<nazwa>` (nazwa z briefu), zatrzymanie instancji w `afterEach`/`afterAll`. Krok `call`
skryptowanego agenta (`e2e/support/scripted-agent.ts`) wywołuje prawdziwe handlery narzędzi. Po przebiegach
usuń nieśledzone pliki dowodów wygenerowane przez istniejące spece (np. `docs/evidence/chat-ux-2026-09-16/`),
chyba że są twoimi dowodami.

## Próby zdolności wykrycia — procedura (obowiązkowa)
Dwukrotnie w fali 1 próba wykrycia skasowała niezacommitowaną pracę (`git checkout -- <plik>` po
wycofaniu linii). Dlatego: **najpierw commit** poprawki i testu, potem próba na czystym drzewie
(`git status --short` puste), wycofanie linii, test, przywrócenie przez `git checkout -- <plik>`,
sprawdzenie `git status --short` = puste. Nigdy nie wykonuj prób na drzewie z niezacommitowanymi zmianami.

## Zasady pracy
- Nie uruchamiasz subagentów (żadnych pomocników ani recenzentów). Przegląd zleca koordynator.
- Niejasność, sprzeczność briefu, rozwidlenie architektoniczne spoza decyzji → zatrzymaj się i zgłoś
  NEEDS_CONTEXT lub BLOCKED z konkretami. Nie zgaduj.
- Iteracyjnie testy celowane; przed raportem bramka G10: `pnpm verify` exit 0 + e2e z briefu i dotkniętych
  speców (pod blokadą, po buildzie).
- Commity na swojej gałęzi, opisy po polsku.

## Raport
Pełny raport w pliku `task-N-report.md` (ten sam katalog): co zrobiono, decyzje w miejscach, gdzie brief
zostawił wybór (i dlaczego), zmienione pliki, dokładne polecenia z kodami wyjścia i liczbami testów,
kontrole negatywne i próby zdolności wykrycia (wycofanie → oblanie → przywrócenie), nieudane przebiegi z
wyjaśnieniem, sekcja „Kontrakt dla autora modułu”, ustalenia self-review, obawy. Rodzaj dowodu przy
każdym teście: test kontraktu lub logiki / test GUI bez modelu / symulacja.

Odpowiedź końcowa TYLKO (do 15 linii): Status (DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT),
commity (SHA + temat), jednolinijkowe podsumowanie testów, obawy, ścieżka raportu.
