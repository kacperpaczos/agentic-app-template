# Próby odbiorowe T25, T26, T27 — rzeczywisty model (2026-09-17)

Dowody z `e2e/bl01-bl02-model.spec.ts`. Każde polecenie zostało wpisane w kompozytorze czatu produkcyjnego
builda na instancji testowej suity przeglądarkowej i obsłużone przez model z subskrypcji przez runtime
aplikacji. Asercje dotyczą DOM, adresu, potwierdzeń komend UI, opisów ekranu (`ui_state`), dziennika
wykonania (`GET /api/runs/:id/events`) i backendu (`POST /api/read`) — nigdy brzmienia odpowiedzi.

| Plik | Co zawiera |
|---|---|
| `tury-modelu.json` | rejestr **wszystkich** tur subskrypcji wydanych przez to zadanie (sufit 22 = 12 na Task 8 + 6 na dokończenie po Task 9 + 4 na domknięcie kroków 2 i 6; **wydane 21**): numer, czas, etap, próba, polecenie, identyfikator wykonania |
| `t25-wskazanie-wartosci.json` | T25 — zaliczona; warunek wstępny, werdykt detektora, wynik `ui_show_value`, opis ekranu po, dane backendu przed i po |
| `t26-zawezenie-rozmowa.json` | T26 — zaliczona; trzy wykonania, wszystkie próby zawężenia modelu, kontekst drugiego polecenia, przywrócony pełny zakres |
| `t27-proba-a-kod-sprawy-jako-id.json` | T27 wariant A — **niezaliczona** dwukrotnie: model użył kodu sprawy jako jej identyfikatora |
| `t27-przed-task-9-wykres-nienarysowany.json` | T27 **przed** Task 9 — przebieg, na którym powstało ustalenie F2 (wykres zapisany, nienarysowany, model oznajmił sukces) |
| `t27-widoki-agenta.json` | T27 **po** Task 9 — **wszystkie sześć kroków zaliczone** w jednej rozmowie (tury 19–21) |
| `t27-kroki-5-6.json` | **archiwalny** — tura 17, pomocniczy test kroków 5–6 (przeładowanie potwierdzone); test usunięty ze speca, gdy główna próba objęła te kroki sama |
| `t25-*.png`, `t26-*.png`, `t27-*.png` | zrzuty ekranu stanu po wykonaniu |

Pliki nie zawierają sekretów, identyfikatorów sesji Claude ani ścieżek spoza repozytorium.
Identyfikatory rozmów, wykonań i kart pochodzą z bazy instancji testowej, która jest odtwarzana
przed każdym przebiegiem (`e2e/support/boot-server.ts`).

Kontrole deterministyczne tych samych kryteriów — bez modelu — są w `e2e/show-value.spec.ts`,
`e2e/view-state.spec.ts`, `e2e/view-filter.spec.ts`, `e2e/ui-state.spec.ts`, `e2e/agent-views.spec.ts`
i `e2e/interactions.spec.ts`. Pełne omówienie: `task-8-report.md` w katalogu planu.

## Który commit zapisuje który dowód

Każdy plik JSON niesie pole `kodCommit` — stan kodu, na którym przebiegł zapisany w nim przebieg. Spec
zmieniał się między przebiegami, więc te numery **nie są** jednym commitem:

| Plik | `kodCommit` | Co wtedy działało |
|---|---|---|
| `t25-wskazanie-wartosci.json` | `492bfbc` | detektor T25 po dodaniu rozpakowania bloków treści MCP |
| `t26-zawezenie-rozmowa.json` | `962e24a` | po przejściu na `lastResultOf` |
| `t27-proba-a-kod-sprawy-jako-id.json` | `7132b95` | przed Task 9 — dwa razy kod sprawy jako identyfikator |
| `t27-przed-task-9-wykres-nienarysowany.json` | `118c871` | przed Task 9 — wykres zapisany, nienarysowany, model oznajmił sukces |
| `t27-kroki-5-6.json` (archiwalny) | `d986b89` | pomocniczy test kroków 5–6, tura 17 |
| `t27-widoki-agenta.json` | `3c5a74e` | **próba T27 zaliczona w całości**, tury 19–21 |

## Dlaczego późniejsze zmiany speca nie unieważniają zapisanych przebiegów

Cztery zmiany weszły po części przebiegów. Żadna nie dotyka tego, co zapisane przebiegi zmierzyły — wszystkie
albo czytają dziennik wykonania inaczej, albo **zaostrzają** warunek, który zapisany przebieg i tak spełnił:

- **`resultOf` → `lastResultOf`** (`962e24a`) — zmienia tylko to, **które** wywołanie narzędzia w wykonaniu
  ocenia detektor: ostatnie zamiast pierwszego. Przebiegi zapisane wcześniej (`t25-…`, tura 2) miały po
  jednym wywołaniu `ui_show_value`, więc pierwsze i ostatnie to to samo wywołanie.
- **`expect(snapshot).toBeTruthy()` w próbie T25** (`d986b89`) — dopisana asercja na wartość, którą zapisany
  przebieg już podał: `opisEkranuPo.wersja = 3`. Warunek ostrzejszy, wynik ten sam.
- **Asercja świadka braku przeładowania w kroku 6** (przegląd, I1) — dopisana na wartość, którą zapisany
  przebieg podał: `poPowrocieDoRozmowy.bezPrzeladowaniaOdOstatniego = true`.
- **Wymóg przycisku akcji w karcie widoku agenta** (przegląd, I2) — zamiast rozgałęzienia. Zapisany przebieg
  podał `mutacja.gdzie = "akcja rekordu w widoku agenta"`, czyli szedł gałęzią, która teraz jest jedyna
  dopuszczalna dla karty nad tym odczytem.

Dwie ostatnie **nie były wykonane w przebiegu z modelem** — grant tur jest zamknięty. Zapisane dowody
pokazują wartości, których teraz wymagają; wykona je najbliższy pełny przebieg suity.
