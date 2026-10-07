# Brief: ETAP 1 / Subagent A — mapa zależności bramek macierzy (READ-ONLY)

Repo: `worktree integracja` (gałąź `domkniecie/integracja`).
Kontekst: `pnpm verify` składa trzy bramki macierzowe. `check:acceptance` = macierz bieżąca 200
kryteriów (źródła: `docs/ARCHITECTURE.md` + `docs/acceptance/assessment.json`, generuje
`docs/ACCEPTANCE.md` i `docs/BACKLOG.md`). `check:matrix` = kontrola wewnętrznej spójności
HISTORYCZNEGO archiwum 95 kryteriów (`docs/archive/agenticapp-2026-09/FEEDBACK.md`).
`check:closure` = render drugiej wariacji macierzy 95; oceny wpisane RĘCZNIE w kod
`scripts/closure-matrix.mjs` (obiekt `A`). Właściciel chce: jedna kanoniczna macierz, oba
`check:*` czytają to samo źródło, rozjazd liczby kryteriów kończy się błędem, zero ręcznych liczb.

## Zadanie

Znajdź i spisz (nie zmieniaj NICZEGO):

1. Wszystkie źródła macierzy: pliki specyfikacji wymagań i pliki ocen (które pliki są wejściem,
   które generowane — wskaż generatory).
2. Wszystkie skrypty generujące podsumowania/raporty z macierzy (`scripts/*.mjs` i inne) — dla
   każdego: co czyta, co pisze/wypisuje, jaki kod wyjścia przy rozjeździe.
3. Wszystkie pliki (poza `node_modules/`, `.git/`) zawierające liczbę **95** w kontekście kryteriów —
   osobno: pliki ARCHIWUM historycznego, osobno: inne.
4. Wszystkie pliki zawierające liczbę **200** w kontekście kryteriów (uwaga na fałszywe trafienia:
   inne „200” — rozmiary, limity HTTP — odfiltruj i napisz, że odfiltrowałeś).
5. Wszystkie miejsca, w które STATUS oceny jest wpisywany ręcznie: `assessment.json` (słuszne
   źródło ocen) vs oceny zaszyte w kodzie skryptów (np. `closure-matrix.mjs` obiekt `A`), vs
   tabele w markdownach archiwum.
6. Wszystkie raporty/dokumenty zależne od starej macierzy 95 (które by zmiały znaczenie, gdyby
   archiwum się zmieniło) i zależne od macierzy 200.
7. Kto wywołuje `check:acceptance` / `check:matrix` / `check:closure` / `acceptance:render`:
   `package.json` (`verify`!), dokumenty (`AGENTS.md`), skrypty, ewentualne hooki/CI.
8. Czy skrypty macierzowe mają jakieś testy jednostkowe/regresyjne (szukaj w `tests/`, `e2e/`).
9. Jak `check:matrix` wykrywa „rozjazd”: obecny mechanizm (regexy na FEEDBACK.md archiwum) —
   opisz precyzyjnie, co jest sprawdzane, a czego NIE (np. czy cokolwiek porównuje 95 z 200).

## Wynik

Zapisz mapę do: `docs/versions/v0.4/archive/domkniecie-2026-09/etap1-a-mapa.md`
(sekcje 1–9, każde twierdzenie ze ścieżką pliku i numerem linii). W odpowiedzi zwrotnej podaj
TYLKO: status, ścieżkę mapy, 5-zdaniowe podsumowanie najważniejszych odkryć, listę plików, które
Twoim zdaniem musi dotknąć patch B.

## Zakazy

- Zero zapisów poza plikiem mapy. Zero `git` zapisów. Zero instalacji.
