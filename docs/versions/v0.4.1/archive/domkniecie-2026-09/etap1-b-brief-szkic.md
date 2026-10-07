# Brief: ETAP 1 / Subagent B — patch bramki macierzy (SZKIC — doprecyzowany po mapie A)

Cel (właściciel): jedna kanoniczna macierz; `check:acceptance` i `check:matrix` czytają to samo
źródło; rozjazd liczby kryteriów kończy się błędem; liczby nie wpisane ręcznie; raporty generowane.

Kierunek rozwiązania (ruling orkiestratora #2, do zatwierdzenia po mapie A):
- KANONEM bieżącego stanu pozostaje para `docs/ARCHITECTURE.md` + `docs/acceptance/assessment.json`
  (już dziś wyliczana, zero ręcznych sum w tabelach wyjściowych).
- `check:matrix` zostaje przepięty z archiwum FEEDBACK.md na kanon: jego zadaniem staje się
  wypisanie/weryfikacja PODSUMOWANIA macierzy bieżącej (liczby per status, warstwy zamknięte,
  pakiety backlogu) wyliczonego z tego samego źródła co `check:acceptance` — i oblewanie, gdy
  cokolwiek się rozjeżdża (np. `docs/ACCEPTANCE.md` przestarzały, ocena bez kryterium, duplikat).
- Kontrola wewnętrznej spójności archiwum 95 zostaje, ale jako JAWNA kontrola archiwum
  (nowa nazwa/polecenie, np. `check:matrix-archive`), opisana jako historia, nie bieżąca macierz;
  `check:closure` — analogicznie, z deklaracją w nagłówku, że oceny w nim to wariacja archiwalna;
  docelowo oceny `closure-matrix.mjs` przepięte na plik danych zamiast obiektu w kodzie (jeśli
  mapa A potwierdzi wykonalność bez tworzenia trzeciego źródła prawdy — nie duplication).
- `pnpm verify` składa: check:acceptance + check:matrix (kanon) + check:closure (archiwum) —
  wszystkie trzy muszą przechodzić; rozjazd niemożliwy do przemilczenia.

## Testy negatywne (obowiązkowe, od Subagenta C)

1. Usunięcie jednego kryterium z specyfikacji → check oblewa.
2. Zmiana statusu jednego kryterium w ocenach → check oblewa (dryf wygenerowanych dokumentów).
3. Duplikat ID → oblewa.
4. Sztuczny rozjazd 95/200 (usunięcie kryterium z kanonu) → NIE może przejść cicho; check:matrix
   (kanon) musi zgłosić niespójność zamiast sukcesu.
5. Podręczny raport pochodny (ręcznie przepisane „187/11/2”) nie może udawać aktualnego —
   bramka czyta źródło, nie raport.

## Kryteria akceptacji

- `pnpm check:acceptance` = 0, `pnpm check:matrix` = 0, `pnpm check:closure` = 0 na scalonym
  drzewie; podsumowania pokazują tę samą liczbę kryteriów (200) i te same stany.
- Każdy test negatywny z pkt. „Testy negatywne” demonstracyjnie oblewa (przed poprawą stanu).
- Zero ręcznych liczb sum w nowych ścieżkach kodu.
- `pnpm verify` = 0 po scaleniu.
