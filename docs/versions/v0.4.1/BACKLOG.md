# Backlog rozwoju szablonu

> Plik generowany przez `node scripts/acceptance-matrix.mjs` z `docs/acceptance/assessment.json`.
> Każde otwarte kryterium macierzy (`docs/ACCEPTANCE.md`) należy do dokładnie jednego pakietu.

Otwartych kryteriów: **1** z 200, w 1 pakietach. Kolejność pakietów jest propozycją, nie harmonogramem. Kryteria „informacyjne / poza bramką odbioru” nie są w tej liczbie — nie blokują zamknięcia warstwy ani nie należą do backlogu.

| Pakiet | Tytuł | Kryteria | Liczba |
|---|---|---|---|
| BL-07 | Trwałość, kopia i migracje | L7.13 | 1 |

## BL-07 — Trwałość, kopia i migracje

Pytanie L7.13 ma pierwszą turę modelową (2026-10-08): SDK wznowił ten sam identyfikator sesji bez zdarzenia utraty — nierozstrzygnięte, czy chirurgia trafiła w żywy transkrypt CLI 2.1.270. Pozostałe kryteria trwałości (kopia z WAL, migracje, odtworzenie) są potwierdzone regresją.

**Warunek zamknięcia:** Jedna tura modelowa z chirurgią transkryptu potwierdzoną (plik istniał przed i nie istnieje po, w katalogu faktycznie czytanym przez CLI przy wznowieniu); zapisany komunikat SDK rozstrzyga, która ścieżka zachodzi, i potwierdza albo uzupełnia wzorce rozpoznawania w isMissingSessionTranscript.

| ID | Wymaganie | Stan | Brak |
|---|---|---|---|
| L7.13 | Brak transkryptu SDK dla zachowanej rozmowy daje jawny wynik odzyskiwania lub błąd; aplikacja nie deklaruje zachowania pamięci, której nie odtworzyła. | częściowe | Niewykonywalne na CLI 2.1.270 dokumentowanym układem transkryptów (zob. proof — próba 14-40-39-051Z: pliku nie było; wznowienie ciche). Do decyzji właściciela: przeklasyfikowanie na informacyjne (granica zewnętrznego SDK, D-02) albo research faktycznego store CLI 2.1.270 i ponowna próba. |
