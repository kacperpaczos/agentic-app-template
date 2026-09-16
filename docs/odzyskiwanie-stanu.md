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

> **Znane ograniczenie (2026-09-16, analiza kodu, bez próby):** lista tabel, które migracja *może*
> zmienić (`EXPECTED_TO_CHANGE` w skrypcie), obejmuje zmiany `platform-0002`, ale nie
> `platform-0003-file-versions`. Ta migracja dodaje kolumny `derived_from_file_id` i `version` do
> tabeli `files`, a skrypt porównuje odcisk wszystkich kolumn (`SELECT *`). Dla kopii sprzed 0003
> z niepustą tabelą `files` próba zgłosi więc „tabela files zmieniona nieoczekiwanie”, mimo że dane
> są zachowane. Uzupełnienie listy wraz z testem jest w `docs/BACKLOG.md`.

Skrypt kopiuje kopię do katalogu tymczasowego (sama kopia pozostaje nietknięta),
robi spis treści, uruchamia **prawdziwy** `composeApp` — tę samą ścieżkę co
`pnpm start` — i porównuje stan. Następnie uruchamia go **po raz drugi** i
wymaga, aby spis był identyczny; to jedyne miejsce, w którym ujawniłoby się
dublowanie danych przez odtwarzanie aktywności.

Tabele, które **mają** się zmienić, są wymienione w skrypcie z podaniem powodu
(`schema_migrations`, `agent_runs`, `messages`). Każda inna zmiana to błąd.
Wiersze widoczne dla użytkownika sprawdzane są **po tożsamości**, nie po liczbie:
identyfikatory rozmów, treść i przypisanie wiadomości użytkownika, kompozycje
kart, identyfikatory plików i artefaktów.

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
# 1. odłóż obecny stan na bok — nigdy nie nadpisuj go bez tego
mv data data.przed-odtworzeniem-$(date +%Y%m%d-%H%M%S)

# 2. odtwórz z kopii
mkdir -p data
cp backups/data-RRRR-MM-DD/app.db data/app.db
cp -r backups/data-RRRR-MM-DD/files data/files
[ -d backups/data-RRRR-MM-DD/workspaces ] && cp -r backups/data-RRRR-MM-DD/workspaces data/workspaces

# 3. sekret sesji nie jest w kopii — przenieś stary albo pozwol go wygenerowac
cp data.przed-odtworzeniem-*/session.secret data/session.secret 2>/dev/null || true

# 4. sprawdź, co odtworzono, zanim wstanie aplikacja
node -e "
const {createRequire}=require('node:module');
const {resolve}=require('node:path');
const D=createRequire(resolve('packages/platform-server/package.json'))('better-sqlite3');
const db=new D('data/app.db',{readonly:true});
for (const t of ['conversations','messages','canvas_cards','files'])
  console.log(t, db.prepare('SELECT COUNT(*) n FROM '+t).get().n);
console.log('integrity', db.pragma('integrity_check',{simple:true}));
"

# 5. uruchom
pnpm build && pnpm start
```

W kopii nie ma `app.db-wal` ani `app.db-shm` — WAL został zwinięty do pliku
głównego, więc odtworzenie to jeden plik. Gdyby ktoś odtwarzał z surowego
`cp data/*` (nie z tej kopii), musi przenieść **wszystkie trzy** pliki albo
żadnego; sam `app.db` to cofnięcie się do ostatniego punktu kontrolnego.

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
