# Kopia i odzyskiwanie stanu lokalnego

Dotyczy katalogu danych aplikacji (domyślnie `data/`): bazy SQLite, plików
źródłowych i przestrzeni roboczych. Procedura jest wymagana przez kryterium
**L10.2** i jest warunkiem bezpiecznego uruchomienia nowego builda na istniejącej
bazie.

---

## 1. Dlaczego nie `cp data/app.db`

Baza pracuje w trybie WAL. Zatwierdzona transakcja trafia najpierw do
`app.db-wal` i dopiero punkt kontrolny przenosi ją do pliku głównego. Stan
zaobserwowany w aplikacji źródłowej AgenticApp 2026-09-15 (przykład historyczny,
nie stan tego repozytorium, które nie zawiera `data/`):

```
data/app.db       397 kB   (14 września)
data/app.db-wal   4.1 MB   (15 września)
data/app.db-shm    33 kB
```

Skopiowanie samego `app.db` dałoby kopię ze stanem z 14 września — bez dnia
pracy — i **wyglądałoby na kopię kompletną**. To nie jest teoretyczne
zastrzeżenie: taki był rzeczywisty stan katalogu po nieczystym zatrzymaniu
procesu.

Dlatego kopię wykonuje skrypt, a nie ręczne `cp`.

## 2. Wykonanie kopii

```bash
node scripts/backup-state.mjs --data data --out backups/data-RRRR-MM-DD
```

Co robi:

1. **odmawia**, jeśli jakiś proces trzyma pliki bazy (`fuser`) — kopia bazy
   zapisywanej w tle może być niespójna;
2. kopiuje `app.db`, `app.db-wal` i `app.db-shm` **razem, jako bajty**;
3. zwija WAL **w kopii** (`wal_checkpoint(TRUNCATE)`), więc wynikiem jest jeden
   samowystarczalny plik `app.db`;
4. kopiuje `files/` i `workspaces/` z sumami SHA-256 każdego pliku;
5. zapisuje `manifest.json`: sumy kontrolne, liczby wierszy i odcisk treści
   każdej tabeli, lista zastosowanych migracji;
6. **odczytuje kopię ponownie** i porównuje z manifestem, plus
   `PRAGMA integrity_check`. Niezgodność = kod wyjścia 1.

**Pliku źródłowego skrypt nigdy nie otwiera jako bazy** — czyta bajty i nic
więcej. Otwarcie bazy WAL do zapisu jest samo w sobie zapisem (SQLite odtwarza
log), a to nie jest dopuszczalny efekt uboczny wykonywania kopii.

Co więcej, **nie wystarczy otwierać „tylko do odczytu”**: SQLite przebudowuje
`app.db-shm` także przy połączeniu readonly. Zostało to zaobserwowane wprost —
po wykonaniu kopii wszystkie trzy sumy SHA-256 w `data/` były identyczne ze
stanem wejściowym, a `app.db-shm` zmienił się dopiero cztery minuty później, gdy
uruchomiono polecenie weryfikujące z sekcji 4 (readonly). `app.db` i
`app.db-wal` — czyli cały stan zatwierdzony — pozostały identyczne bajt w bajt;
`-shm` to indeks pamięci współdzielonej, odtwarzalny z `-wal` i niezawierający
danych. Szczegóły i sumy były zapisane w dowodach AgenticApp
(`docs/evidence/closure-2026-09-15/24-kopia.txt`), które nie są publikowane w tym repozytorium.

`session.secret` **nie jest kopiowany celowo.** Podpisuje ciasteczka logowania
tej instalacji; kopia stanu nie ma być kopią sekretów. Po odtworzeniu na nowej
maszynie sesje przeglądarki wygasną — trzeba się zalogować ponownie, dane
pozostają.

Skrypt **odmawia** (kod wyjścia 2) zapisania kopii do wnętrza kopiowanego katalogu: taka kopia jest
częścią tego, co kopiuje, i znika razem z nim. Jeśli w systemie nie ma `fuser`, sprawdzenie z punktu 1
nie może się odbyć — skrypt wypisuje wtedy ostrzeżenie zamiast milcząco udawać, że sprawdził.

### Ponowne sprawdzenie istniejącej kopii

```bash
node scripts/backup-state.mjs --verify backups/data-RRRR-MM-DD
```

## 3. Próba migracji przed uruchomieniem

Build stosuje przy starcie zaległe migracje — obecnie `platform-0002-run-measurement-points`
i `platform-0003-file-versions` — i odtwarza aktywność narzędzi w starych rozmowach.
Zanim to nastąpi na rzeczywistych danych, próbę wykonuje się **na kopii**:

```bash
node scripts/migration-rehearsal.mjs --backup backups/data-RRRR-MM-DD \
  --json backups/proba-migracji-RRRR-MM-DD.json
```

Lista tabel, które migracja *może* zmienić (`EXPECTED_TO_CHANGE` w skrypcie), rozróżnia dwa rodzaje
zmiany, i to rozróżnienie jest istotne:

- **dodane kolumny** (`platform-0002` → `agent_runs.enqueued_at`, `platform-0003-file-versions` →
  `files.derived_from_file_id` i `files.version`) — skrypt wymaga, żeby kolumny sprzed migracji
  trzymały **dokładnie te same wartości**, liczba wierszy się nie zmieniła, a nowe kolumny były
  wyłącznie tymi wymienionymi. To mocniejsze sprawdzenie niż porównanie całych wierszy, a nie
  słabsze: samo `SELECT *` nie odróżnia dopisanej kolumny od przepisanego wiersza;
- **przepisane wiersze** (`schema_migrations`, `messages`) — tu odcisk nic nie powie, więc gwarancję
  daje sprawdzenie po tożsamości: każda rozmowa, wiadomość użytkownika, karta, plik i artefakt.

Do 2026-09-18 tabeli `files` w tej liście nie było, a próba na kopii z niepustą tabelą `files`
kończyła się fałszywym „tabela files zmieniona nieoczekiwanie” — czyli dokładnie na danych, które
miała chronić. Regresja `tests/backup-migration.test.ts` trzyma dziś ten przypadek.

Skrypt kopiuje kopię do katalogu tymczasowego (sama kopia pozostaje nietknięta),
robi spis treści, uruchamia **prawdziwy** `composeApp` — tę samą ścieżkę co
`pnpm start` — i porównuje stan. Następnie uruchamia go **po raz drugi** i
wymaga, aby spis był identyczny; to jedyne miejsce, w którym ujawniłoby się
dublowanie danych przez odtwarzanie aktywności.

Każda zmiana spoza listy powyżej to błąd. Wiersze widoczne dla użytkownika sprawdzane są **po
tożsamości**, nie po liczbie: identyfikatory rozmów, treść i przypisanie wiadomości użytkownika,
kompozycje kart, identyfikatory plików i artefaktów. Na koniec skrypt porównuje sumy SHA-256
wszystkich plików kopii źródłowej sprzed i po próbie — „próba pracuje na kopii” jest w ten sposób
zmierzone, a nie tylko wynikające z konstrukcji.

Próba odmawia pracy (kod wyjścia 2), gdy `--backup` albo `--out` wskazuje katalog `data` repozytorium,
katalog z `APP_DATA_DIR`, albo dowolny katalog zawierający `session.secret` — kopia nigdy go nie
zawiera, więc jego obecność oznacza katalog danych aplikacji, nawet jeśli nikt go nie nazwał.

### Próba bez danych użytkownika — na danych syntetycznych

Szablon nie zawiera `data/`, a jedyna baza, której do próby użyć nie wolno, to baza użytkownika.
Dlatego dane do próby się **wytwarza**:

```bash
node scripts/synthetic-state.mjs --list                   # etapy = migracje platformy
node scripts/synthetic-state.mjs --out .e2e-bl07/dane --stage platform-0003-file-versions
node scripts/backup-state.mjs      --data .e2e-bl07/dane --out .e2e-bl07/kopia
node scripts/migration-rehearsal.mjs --backup .e2e-bl07/kopia --out .e2e-bl07/proba
```

`--stage <id>` oznacza **stan tuż przed tą migracją**: wszystkie wcześniejsze zastosowane, ta jeszcze
nie. To jedyny kształt, w którym da się przećwiczyć „ta migracja zachowuje istniejące dane”, i to
właśnie robi regresja szablonu — po jednym przebiegu na kopii sprzed każdej migracji platformy
(`tests/backup-migration.test.ts`). Katalog `.e2e-bl07/` jest ignorowany przez git.

Przebieg zapisany w `docs/evidence/z2-bl07/` obejmuje: kopię z zapisem leżącym wyłącznie w WAL,
weryfikację, próbę migracji na kopii, drugie i trzecie uruchomienie bez skutku oraz odtworzenie.

Wynik historyczny na kopii danych AgenticApp z 2026-09-15 (przed migracją `platform-0003`;
dowód pozostał lokalnie w AgenticApp):

| | przed | po |
|---|---|---|
| migracje | `platform-0001-init`, `procurement-0001-init` | + `platform-0002-run-measurement-points` |
| rozmowy | 31 | 31 |
| wiadomości | 42 | 76 |
| uruchomienia | 11 | 11 |
| zdarzenia uruchomień | 432 | 432 |
| karty canvasu | 18 | 18 |
| pliki | 9 | 9 |

Wzrost liczby wiadomości to odtworzenie aktywności narzędzi: 11 uruchomień,
45 nowych wiadomości, w miejsce 11 starych pojedynczych wiadomości asystenta
(42 + 45 − 11 = 76). Zdarzenia uruchomień są źródłem odtworzenia i pozostają
nietknięte. Drugie uruchomienie nie zmieniło niczego.

## 4. Odtworzenie stanu

Aplikacja musi być zatrzymana.

```bash
# najpierw na sucho: nic nie jest dotykane, a wypisane zostaje wszystko,
# co decyduje o tym, czy odtworzenie jest bezpieczne
node scripts/restore-state.mjs --backup backups/data-RRRR-MM-DD --data data --check

# odtworzenie
node scripts/restore-state.mjs --backup backups/data-RRRR-MM-DD --data data

pnpm build && pnpm start
```

Procedura jest skryptem, a nie listą poleceń do przepisania, bo tylko skrypt daje się wykonać w
regresji — i bo trzy pytania, które rozstrzygają o bezpieczeństwie odtworzenia, muszą mieć odpowiedź
**przed** przeniesieniem pierwszego bajtu.

**1. Co dzieje się ze stanem sprzed próby.** Obecny katalog danych jest *przenoszony* do
`data.przed-odtworzeniem-<znacznik czasu>` — nigdy nadpisywany i nigdy usuwany. Nieudane odtworzenie
cofa się przez przeniesienie tego katalogu z powrotem. Kopia jest wcześniej sprawdzona (`--verify`);
kopia, która się nie weryfikuje, jest odrzucana, zanim cokolwiek zostanie przesunięte.

**2. Zgodność wersji kodu.** Skrypt porównuje migracje zapisane w kopii z migracjami, które zna ten
checkout (czyta je, uruchamiając kompozycję aplikacji na pustym katalogu — więc obejmuje też migracje
modułu):

- kopia zawiera migrację nieznaną temu buildowi → **odmowa** (kod wyjścia 3). Kopia pochodzi z
  nowszej wersji kodu, a migracji nie da się cofnąć; trzeba odtworzyć ją na wersji co najmniej tak
  nowej jak kopia;
- kopia jest starsza niż kod → skrypt wypisuje, które migracje zastosuje pierwszy start, i odsyła do
  próby z sekcji 3. Odtworzenie jest dozwolone, ale „gotowość do migracji” to nie to samo co jej
  wykonanie — próba jest osobnym krokiem i to ona odpowiada, czy dane przeżyją;
- zestawy są równe → start nie zmieni schematu.

**3. Los sesji aplikacji i transkryptów SDK.**

- *Sesje przeglądarki.* `session.secret` nie jest w kopii (patrz sekcja 2). Skrypt przenosi go z
  katalogu odłożonego na bok, więc odtworzenie na tej samej maszynie nie wylogowuje nikogo. Przy
  odtworzeniu na nowej maszynie sekretu nie ma skąd wziąć: zostanie wygenerowany, a wszyscy muszą
  zalogować się ponownie. Dane pozostają.
- *Transkrypty Claude Agent SDK.* Leżą poza katalogiem danych aplikacji, nie są kopiowane ani
  usuwane — nie są nasze. Po odtworzeniu (zwłaszcza na innej maszynie) rozmowa z zapisanym
  `claude_session_id` może więc nie mieć transkryptu. Aplikacja **nie udaje wtedy, że pamięć
  wróciła**: pierwsze polecenie w takiej rozmowie kończy się jawnym błędem
  `session_transcript_lost`, powiązanie z martwą sesją zostaje usunięte, a kolejne polecenie
  startuje w nowej sesji — świadomie, bez wcześniejszego kontekstu modelu. Historia rozmowy w
  aplikacji pozostaje nietknięta (kryterium L7.13).

Po skopiowaniu skrypt odczytuje odtworzoną bazę: liczby wierszy porównane z manifestem i
`PRAGMA integrity_check`. Niezgodność = kod wyjścia 1, jeszcze zanim aplikacja wstanie.

W kopii nie ma `app.db-wal` ani `app.db-shm` — WAL został zwinięty do pliku głównego, więc
odtworzenie to jeden plik. Gdyby ktoś odtwarzał z surowego `cp data/*` (nie z tej kopii), musi
przenieść **wszystkie trzy** pliki albo żadnego; sam `app.db` to cofnięcie się do ostatniego punktu
kontrolnego.

## 5. Czego ta procedura nie obejmuje

- **Zdalnego przechowywania kopii.** Kopia leży w `backups/` na tej samej
  maszynie i na tym samym dysku co dane. Zabezpiecza przed nieudaną migracją i
  błędem w aplikacji, nie przed awarią dysku.
- **Kopii gorącej.** Skrypt odmawia działania przy uruchomionej aplikacji.
  Nie ma tu kopii bez przestoju; przy jednej lokalnej instancji to jest
  właściwy kompromis, ale trzeba o nim wiedzieć.
- **Transkryptów SDK.** Sesje Claude Agent SDK leżą poza katalogiem danych
  aplikacji i nie są ani kopiowane, ani usuwane — nie są nasze.
- **Automatycznego harmonogramu.** Kopia jest wykonywana ręcznie, przed
  migracją. Nic nie robi jej cyklicznie.
- **Cofania migracji.** Migracje idą tylko w jedną stronę. Dlatego kopia
  nowsza niż kod jest odrzucana, a nie „naprawiana”.
- **Wymuszenia próby przed startem.** `pnpm start` stosuje zaległe migracje
  sam. Rozdział „gotowość” od „wykonania” trzyma się na tym, że próba i
  odtworzenie są osobnymi poleceniami, które nigdy nie dotykają katalogu
  danych — nie na blokadzie w starcie aplikacji.
