# Zmiany v0.4 względem v0.3

Ten changelog rejestruje zatwierdzone zmiany względem nieedytowanej historii
v0.3. Nie jest drugą specyfikacją ani raportem stanu. Definicja systemu i pełne
brzmienie wymagań są wyłącznie w [ARCHITECTURE.md](ARCHITECTURE.md).

| Zmiana | Dotknięte miejsca | Powód |
|---|---|---|
| GLM/Z.AI jako provider, Claude Code / Claude Agent SDK jako harness | `ARCHITECTURE.md`: cel, diagram, dobór technologii, warstwa 8, ryzyka i źródła; `ACCEPTED-DECISIONS.md` D-01; L8 | Aktualna ścieżka wykonania nie używa OAuth ani subskrypcji Anthropic użytkownika. |
| Trzy klasy wymagań | ARCHITECTURE: warunki odbioru i macierz; assessment.json; ACCEPTANCE.md; BACKLOG.md | Oddzielenie funkcji produktu i jakości od ograniczeń proceduralnych, których nie można bezpiecznie wymusić na żądanie. |
| Semantyczny kontekst i nawigacja UI | ARCHITECTURE: interakcja agenta z aplikacją, L2/L6 i T25–T26 | Agent ma doprowadzić do widocznego wyniku, nie tylko opisać znalezione dane. |
| Obowiązkowe Widoki agenta oraz lista dozwolonych osadzeń | ARCHITECTURE: semantyczny UI i przestrzeń prezentacyjna agenta, L3 i T27 | Dynamiczny UI jest kontrolowaną kompozycją OpenUI, a nie dowolnym kodem. |
| Globalne centrum zadań | ARCHITECTURE: praca w tle, L11.6 i L11.19 | Długie zadanie nie należy do aktualnie otwartej rozmowy ani panelu. |
| Tryby zgód | ARCHITECTURE: sandbox i uprawnienia, L11.12 | Użytkownik wybiera stopień automatyzacji; model nie może go eskalować. |
| Kanon v0.4 i projekcje techniczne | `README.md`, `docs/CURRENT.md`, `docs/README.md`; projekcje `docs/*.md` | v0.4 jest jedyną aktywną książką; v0.3 i raporty pozostają historią, a wymagane przez skrypty kopie nie tworzą konkurencyjnej dokumentacji. |

| Korekta kwalifikacji L5.8 oraz L8.10–L8.11 | `ACCEPTANCE.md`, `BACKLOG.md`; L5.8, L8.10, L8.11 | Symulacja nie zastępuje realnego dowodu awarii adaptera ani limitu GLM; niewywoływalne scenariusze wymagają jawnego ograniczenia. |

Stan bieżących kryteriów i pakietów jest w [ACCEPTANCE.md](ACCEPTANCE.md) oraz
[BACKLOG.md](BACKLOG.md); historyczny stan v0.3 nie jest do niego przenoszony
automatycznie.
