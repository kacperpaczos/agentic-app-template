# Dowody zadania Z4 (pakiet BL-10)

- 01-verify.txt — pelny `pnpm verify` (exit 0, 33 pliki / 546 testow)
- 02-e2e-pelny-przebieg.txt — `pnpm exec playwright test` pod blokada (144 testy, spece modelowe pominiete)
- 03-proby-wykrycia.txt — 14 prob zdolnosci wykrycia wedlug G16 (P1-P12 + poprawione P2b i P9b)
- 04-stan-drzewa.txt — bramka G17/G18: verify = 0 i puste `git status --porcelain` (takze po rundzie 1)
- 05-proby-wykrycia-runda-1.txt — trzy proby dla dodatkow rundy 1 (proxy dev, odtwarzanie szkicu, walidacja propsow karty)
- 06-proby-wykrycia-runda-2.txt — proba dla rozroznienia opisu czesciowego (nazwanie brakujacego odczytu)
- 07-e2e-runda-2.txt — przebieg przegladarkowy rundy 2 (app.spec + bl10-composition, 24 testy)

Odtworzenie: `pnpm verify`, a nastepnie
`flock -w 5400 ../.e2e.lock pnpm exec playwright test` (spece modelowe pozostaja poza przebiegiem).
Zaden test nie zapisuje do tego katalogu — pliki pochodza z recznych przebiegow (G18).
