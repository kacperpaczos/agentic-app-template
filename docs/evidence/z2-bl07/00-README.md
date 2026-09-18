# Dowody — zadanie Z2, pakiet BL-07 (trwałość, kopia i migracje)

Kryteria: **L7.13, L10.2, L10.16, L10.17, L10.18, L10.19**. Próba **T18**.

Wszystko poniżej wykonano na **danych syntetycznych** wytworzonych przez
`scripts/synthetic-state.mjs` w katalogu `.e2e-bl07/` wewnątrz worktree (ignorowany przez git).
Żadne polecenie nie dotknęło `data/`, `APP_DATA_DIR` ani żadnego katalogu poza `.e2e-bl07/` —
a trzy kontrole negatywne pokazują, co się dzieje, gdy ktoś spróbuje.

| plik | co zawiera |
|---|---|
| `01-przebieg.txt` | Nagrany przebieg odbiorowy: 20 kroków z poleceniami, kodami wyjścia i sumami SHA-256. Kopia z zapisem leżącym wyłącznie w WAL → weryfikacja → próba migracji na kopii → trzecie uruchomienie bez skutku → kontrole negatywne → odmowy → odtworzenie → start aplikacji na odtworzonym stanie → odmowa kopii nowszej niż build. |
| `02-testy.txt` | Regresja: `tests/backup-migration.test.ts` (24) i `tests/session-transcript.test.ts` (18), kod wyjścia 0. |
| `03-proby-wykrycia.txt` | Siedem prób zdolności wykrycia (G16): wycofana linia → test oblewa → przywrócenie → drzewo czyste. Próba 7 przy pierwszym podejściu ujawniła wadę testu, nie kodu; test poprawiono i próbę powtórzono. |
| `04-raport-proby.json` | Raport `migration-rehearsal --json` z przebiegu z `01-przebieg.txt`. |

## Co rozstrzyga który krok

- **L10.16** — kroki 1–8 `01-przebieg.txt`. Krok 3 jest kontrolą: sam `app.db`
  (to, co skopiowałoby `cp data/app.db`) ma 1 rozmowę, `app.db` razem z `app.db-wal` ma 2.
  Kopia ma 2 i jest jednym plikiem. Kroki 12–14: uszkodzony plik, niespójny manifest i zmieniona
  baza w kopii dają kod wyjścia 1 z nazwanym powodem.
- **L10.17** — kroki 9–11. Zmiany dopuszczone są nazwane, w tym `files: dodane kolumny … dane bez
  zmian` (to jest przypadek, który wcześniej dawał fałszywy błąd). Trzecie uruchomienie porównane
  odciskiem 21 tabel liczonym poza skryptem: 0 różnic.
- **L10.2** — kroki 9–11 plus regresja: próba na kopii sprzed **każdej** migracji platformy.
- **L10.18** — kroki 16–20: `--check`, odtworzenie z odłożeniem stanu sprzed próby, przeniesiony
  `session.secret`, start aplikacji, odmowa kopii nowszej niż build (kod 3) i kopii, która się nie
  weryfikuje (kod 1).
- **L10.19** — kroki 2 i 8 (suma `app.db` i `app.db-wal` identyczna przed i po; zmienia się tylko
  `app.db-shm`, odtwarzalny indeks bez danych) oraz krok 15: cztery odmowy, po których odcisk bazy
  jest bajt w bajt ten sam.
- **L7.13** — `02-testy.txt`, `tests/session-transcript.test.ts`. To **symulacja** na granicy
  adaptera modelu; kryterium pozostaje otwarte, bo nie sprawdzono, którą z dwóch reakcji daje
  prawdziwy SDK. Szczegóły w `docs/ACCEPTANCE.md` i w raporcie zadania.
