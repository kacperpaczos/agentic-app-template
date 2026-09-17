# Próby odbiorowe T25, T26, T27 — rzeczywisty model (2026-09-17)

Dowody z `e2e/bl01-bl02-model.spec.ts`. Każde polecenie zostało wpisane w kompozytorze czatu produkcyjnego
builda na instancji testowej suity przeglądarkowej i obsłużone przez model z subskrypcji przez runtime
aplikacji. Asercje dotyczą DOM, adresu, potwierdzeń komend UI, opisów ekranu (`ui_state`), dziennika
wykonania (`GET /api/runs/:id/events`) i backendu (`POST /api/read`) — nigdy brzmienia odpowiedzi.

| Plik | Co zawiera |
|---|---|
| `tury-modelu.json` | rejestr **wszystkich** tur subskrypcji wydanych przez to zadanie (budżet 12): numer, czas, próba, polecenie, identyfikator wykonania |
| `t25-wskazanie-wartosci.json` | T25 — zaliczona; warunek wstępny, werdykt detektora, wynik `ui_show_value`, opis ekranu po, dane backendu przed i po |
| `t26-zawezenie-rozmowa.json` | T26 — zaliczona; trzy wykonania, wszystkie próby zawężenia modelu, kontekst drugiego polecenia, przywrócony pełny zakres |
| `t27-proba-a-kod-sprawy-jako-id.json` | T27 wariant A — **niezaliczona** dwukrotnie: model użył kodu sprawy jako jej identyfikatora |
| `t27-widoki-agenta.json` | T27 wariant B — krok 1 potwierdzony, krok 2 to ustalenie o produkcie, kroki 3–5 niesprawdzone (budżet) |
| `t25-*.png`, `t26-*.png`, `t27-*.png` | zrzuty ekranu stanu po wykonaniu |

Pliki nie zawierają sekretów, identyfikatorów sesji Claude ani ścieżek spoza repozytorium.
Identyfikatory rozmów, wykonań i kart pochodzą z bazy instancji testowej, która jest odtwarzana
przed każdym przebiegiem (`e2e/support/boot-server.ts`).

Kontrole deterministyczne tych samych kryteriów — bez modelu — są w `e2e/show-value.spec.ts`,
`e2e/view-state.spec.ts`, `e2e/view-filter.spec.ts`, `e2e/ui-state.spec.ts`, `e2e/agent-views.spec.ts`
i `e2e/interactions.spec.ts`. Pełne omówienie: `task-8-report.md` w katalogu planu.
