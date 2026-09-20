# Zmiany v0.4 względem v0.3

v0.4 jest pełną kopią v0.3 z poniższymi, zatwierdzonymi zmianami. Identyfikatory
Lx.y oraz pozostałe wymagania zostały zachowane.

| Zmiana | Dotknięte miejsca | Powód |
|---|---|---|
| GLM/Z.AI jako provider, Claude Code / Claude Agent SDK jako harness | ARCHITECTURE: cel, diagram, dobór technologii, warstwa 8, ryzyka i źródła | Aktualna ścieżka wykonania nie używa OAuth ani subskrypcji Anthropic użytkownika. |
| Trzy klasy wymagań | ARCHITECTURE: warunki odbioru i macierz; assessment.json; ACCEPTANCE.md; BACKLOG.md | Oddzielenie funkcji produktu i jakości od ograniczeń proceduralnych, których nie można bezpiecznie wymusić na żądanie. |
| Semantyczny kontekst i nawigacja UI | ARCHITECTURE: interakcja agenta z aplikacją, L2/L6 i T25–T26 | Agent ma doprowadzić do widocznego wyniku, nie tylko opisać znalezione dane. |
| Obowiązkowe Widoki agenta oraz lista dozwolonych osadzeń | ARCHITECTURE: semantyczny UI i przestrzeń prezentacyjna agenta, L3 i T27 | Dynamiczny UI jest kontrolowaną kompozycją OpenUI, a nie dowolnym kodem. |
| Globalne centrum zadań | ARCHITECTURE: praca w tle, L11.6 i L11.19 | Długie zadanie nie należy do aktualnie otwartej rozmowy ani panelu. |
| Tryby zgód | ARCHITECTURE: sandbox i uprawnienia, L11.12 | Użytkownik wybiera stopień automatyzacji; model nie może go eskalować. |
| Wersjonowanie dokumentacji | `docs/versions/`, `docs/CURRENT.md`, `docs/README.md` | v0.3 pozostaje punktem odniesienia, a v0.4 jest reviewowalnym snapshotem. |

## Korekta po niezależnym odbiorze

- **L5.8** pozostaje kryterium jakościowym i częściowym w pakiecie BL-03. Symulacja `RUN_ERROR` chroni regresję, ale brak rzeczywistego dowodu awarii strumienia aktualnego adaptera nie jest procedurą informacyjną.
- **L8.10–L8.11** opisują wyłącznie tryb GLM: kontrolowane błędy i limit są testowane przez konfigurację oraz symulację, a realne unieważnienie klucza lub wyczerpanie limitu wymaga osobnego konta testowego i pozostaje informacyjne.
- **v0.3** zawiera wyłącznie pliki występujące w deklarowanym stanie źródłowym; opis wersji jest w `docs/versions/README.md`, poza zamrożonym snapshotem.

## Wpływ na stan odbioru

Zmiana providera i doprecyzowanie centrum zadań oraz trybów zgód wzmacniają istniejące kryteria, więc v0.4 nie przenosi automatycznie dawnych dowodów jako pełnego potwierdzenia. `L11.6`, `L11.12`, `L11.19` i `L12.6` są oznaczone jako częściowe i należą do `BL-13`. Jest to jawny brak implementacji lub aktualnego dowodu, a nie regresja ukryta pod dokumentacją.

## Świadomie bez zmian

Nie zmieniono funkcji produktu, kodu aplikacji, worktree review, gałęzi, testów
modelowych ani historii Git. Dokumenty takie jak `ADAPTERY.md`,
`NEW-APPLICATION.md`, `observability.md` i rozbudowana mapa konsolidacji pozostają
kopią v0.3; ich redakcja i uproszczenie są osobnym zadaniem, nie skutkiem tej
wersji.
