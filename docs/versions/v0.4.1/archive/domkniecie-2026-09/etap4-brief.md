# Brief: ETAP 4 — reuse istniejących dowodów modelowych (READ-ONLY)

Repo: `worktree integracja` (HEAD: `763dd31`).
Cel: zapobiec powtarzaniu prób modelowych, których dowód jest aktualny, kompletny i przypięty
do bieżącego kodu. Wynik posłuży do `docs/evidence/REUSE-MATRIX.md`.

## Źródła (odczyt, zero zmian, zero uruchamiania)

- `docs/evidence/POCHODZENIE.json` — koperta pochodzenia dowodów (commit, wytwórca, rodzaj wykonania).
- `docs/evidence/z11-bl03/` (w tym `runs/` i `diagnoza-blokady-org.md`), `docs/evidence/z10-bl09/`,
  `docs/evidence/z12-bl04/` — przebiegi i rejestry prób modelowych.
- `docs/evidence/HIGIENA-REDAKCJA.md` — rejestr redakcji (czy redakcja złamała hash?).
- `docs/acceptance/wersje-rejestr.json` — wersje środowiska.
- git: dla każdego commitu dowodu sprawdź `git merge-base --is-ancestor` względem HEAD oraz
  `git diff --stat <commit-dowodu>..HEAD -- <pliki dotknięte dowodem>` (czy kod, o który dowód
  opiera się, zmienił się od zapisu).

## Zadanie

Dla KAŻDEGO dowodu przebiegu modelowego (tura/attempt) z wymienionych katalogów ustal:
1. Jaki kryterium/próba (Lx.y / Txx) — z nazw plików i zawartości.
2. Commit, na którym powstał (z POCHODZENIE.json albo treści), czy jest przodkiem HEAD.
3. Czy od tego commitu zmieniły się pliki istotne dla twierdzenia dowodu (nazwij które).
4. Czy dowód pochodzi z PRAWDZIWEGO modelu (flaga/rejestr), czy stand-inu/symulacji.
5. Czy dowód jest kompletny wg standardu (commit, wersje, model, tryb, port, katalog danych,
   wynik, koszt tur) — czego brakuje.
6. Werdykt: REUSE (aktualny, nie powtarzać) / DELTA (aktualny częściowo — czego) / REPEAT
   (nieaktualny, wymaga powtórzenia) — i ile tur modelu oszczędza REUSE.

## Wynik

Zapisz tabelę do `docs/versions/v0.4/archive/domkniecie-2026-09/etap4-reuse-tabela.md`
(markdown, kolumny: dowód | kryteria/próba | commit | przodek HEAD? | zmienione pliki | prawdziwy
model? | kompletność | werdykt | oszczędne tury). Podsumowanie: ile dowodów REUSE/DELTA/REPEAT,
ile tur oszczędza reuse łącznie. W odpowiedzi zwrotnej TYLKO: status, ścieżka, podsumowanie liczbowe,
3 najciekawsze wnioski.

## Zakazy

Nie kopiuj treści tokenów/sekretów do raportu — pliki są już zredagowane, ale nie przepisuj
wrażliwych fragmentów. Nie modyfikuj plików dowodowych.
