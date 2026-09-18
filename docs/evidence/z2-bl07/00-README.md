# Dowody — zadanie Z2, pakiet BL-07 (trwałość, kopia i migracje)

Kryteria: **L7.13, L10.2, L10.16, L10.17, L10.18, L10.19**. Próba **T18**.

Wszystko poniżej wykonano na **danych syntetycznych** wytworzonych przez
`scripts/synthetic-state.mjs` w katalogu `.e2e-bl07/` wewnątrz worktree (ignorowany przez git).
Żadne polecenie nie dotknęło `data/`, `APP_DATA_DIR` ani żadnego katalogu poza `.e2e-bl07/` —
a trzy kontrole negatywne pokazują, co się dzieje, gdy ktoś spróbuje.

| plik | co zawiera |
|---|---|
| `01-przebieg.txt` | Nagrany przebieg odbiorowy: 24 kroki z poleceniami, kodami wyjścia i sumami SHA-256. Kopia z zapisem leżącym wyłącznie w WAL → weryfikacja → próba migracji na kopii → trzecie uruchomienie bez skutku → kontrole negatywne → **osiem odmów** (w tym ścieżka wewnątrz i nad katalogiem danych) → odtworzenie → start aplikacji na odtworzonym stanie → odmowa kopii nowszej niż build → odmowa cudzego `--data` → osobny kod wyjścia awarii. |
| `02-testy-runda{0..7}.txt` | Wynik regresji po każdej rundzie, **osobny plik na rundę**. W rundach 3 i 4 nadpisywałem jeden plik i wyniki poprzednich rund przepadały z drzewa roboczego; wszystkie siedem odzyskane z historii gita (`git log --follow` po tym pliku, potem `git show <commit>:<plik>`) i od tej pory dopisywane obok. Przy pierwszym odzyskiwaniu wybierałem commity na oko i zgubiłem rundę 1 — jest w komplecie od rundy 6. |
| `03-proby-wykrycia.txt` | Siedem prób zdolności wykrycia (G16) z pierwszego przebiegu zadania. Próba 7 przy pierwszym podejściu ujawniła wadę testu, nie kodu; test poprawiono i próbę powtórzono. |
| `04-raport-proby.json` | Raport `migration-rehearsal --json` z przebiegu z `01-przebieg.txt`. |
| `05-proby-wykrycia-runda1.txt` | Pięć prób zdolności wykrycia dla poprawek z rundy 1 (trzy ochrony ścieżek, odmowa cudzego `--data`, osobny kod awarii). |
| `11-proby-wykrycia-runda7.txt` | Próba dla ścieżki **nieudanej** weryfikacji: bez przeniesienia sprzątania przed werdykt uszkodzona kopia zostaje ze śladem po odczycie. |
| `10-proby-wykrycia-runda6.txt` | Dwie próby: ślad zostawiony w cudzej kopii przez `--verify`/`--check` (regresja rundy 5) i `approveOwnTemp` zatwierdzające cokolwiek. |
| `09-proby-wykrycia-runda5.txt` | Cztery próby: trzy powtórzenia ucieczek recenzenta (argument pozycyjny; nowy skrypt importujący bibliotekę podwójnym cudzysłowem; flaga kasująca zadeklarowana jako przełącznik z przepisem, który jej nie podaje) i próba dla samego zwężenia gardła. |
| `08-proby-wykrycia-runda4.txt` | Powtórzenie dwóch ucieczek recenzenta (flaga w podwójnych cudzysłowach; flaga zadeklarowana jako rodzaj wyjęty spod kontroli) oraz próba dla znacznika autoryzującego kasowanie. Trzecia próba ujawniła brak testu na ścieżce kasującej — test dopisany, próba powtórzona. |
| `07-proby-wykrycia-runda3.txt` | Dwuetapowa próba dla testu wyliczającego flagi ścieżkowe: flaga dodana bez deklaracji oblewa, a flaga zadeklarowana jako chroniona, lecz bez ochrony w kodzie — oblewa na uruchomieniu skryptu. |
| `06-proby-wykrycia-runda2.txt` | Odtworzenie defektu A (kopia nadpisująca żywy katalog danych z kodem 0) i pięć prób zdolności wykrycia dla rundy 2. |

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
  `app.db-shm`, odtwarzalny indeks bez danych) oraz kroki 15, 21 i 22: osiem odmów, po których
  odcisk bazy jest bajt w bajt ten sam, a plik użytkownika i cudzy katalog są na miejscu. Wśród nich
  przypadek zgłoszony w przeglądzie: `--out <katalog-danych>/files` dla generatora i dla próby
  migracji, katalog nadrzędny wobec katalogu danych oraz cudzy niepusty katalog bez znacznika.
  Krok 22 to osobny defekt z rerecenzji: **kopia zapisywana do** żywego katalogu danych
  (`--data <cokolwiek> --out <katalog danych>`) nadpisywała bazę użytkownika i kończyła się kodem 0;
  dziś odmowa, suma `app.db` identyczna przed i po, a kontrola odwrotna pokazuje, że kopia do
  katalogu pustego i jej powtórzenie do tego samego katalogu nadal działają. Krok 23: próba
  migracji powtórzona trzykrotnie do tego samego `--out`, w tym po symulowanym przerwanym
  przebiegu.
- **L7.13** — `02-testy.txt`, `tests/session-transcript.test.ts`. To **symulacja** na granicy
  adaptera modelu; kryterium pozostaje otwarte, bo nie sprawdzono, którą z dwóch reakcji daje
  prawdziwy SDK. Szczegóły w `docs/ACCEPTANCE.md` i w raporcie zadania.
