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

Skrypt **odmawia** (kod wyjścia 2) zapisania kopii do wnętrza kopiowanego katalogu ani w katalogu,
który ten katalog zawiera: w pierwszym przypadku kopia jest częścią tego, co kopiuje, w drugim kopia
i oryginał dzielą los. Jeśli w systemie nie ma `fuser`, sprawdzenie z punktu 1 nie może się odbyć —
skrypt wypisuje wtedy ostrzeżenie zamiast milcząco udawać, że sprawdził.

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

- **dodane kolumny** — lista pochodzi z **SQL samych migracji**: kolumna może się pojawić dlatego,
  że któraś migracja mówi `ALTER TABLE … ADD COLUMN`, i z żadnego innego powodu. Skrypt wymaga przy
  tym, żeby kolumny sprzed migracji trzymały **dokładnie te same wartości**, liczba wierszy się nie
  zmieniła, a nowe kolumny były wyłącznie tymi z DDL. To mocniejsze sprawdzenie niż porównanie
  całych wierszy, a nie słabsze: samo `SELECT *` nie odróżnia dopisanej kolumny od przepisanego
  wiersza. Nowa migracja poszerzająca tabelę nie wymaga żadnej edycji skryptu;
- **przepisane wiersze** (`schema_migrations`, `messages`) — tu odcisk nic nie powie, więc gwarancję
  daje sprawdzenie po tożsamości: każda rozmowa, wiadomość użytkownika, karta, plik i artefakt. Ta
  lista jest i zostaje **ręczna**: nic w schemacie nie mówi, że start aplikacji przepisuje turę z
  zapisanych zdarzeń. To zdanie o zachowaniu i musi je napisać człowiek.

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

### Czego te skrypty nie tkną

Próba migracji i generator danych syntetycznych **kasują** katalog, na który je wskażesz, zanim go
wypełnią. Dlatego odmawiają pracy (kod wyjścia 2) w każdym z tych przypadków:

- ścieżka **jest** katalogiem danych, **leży w nim** albo **go zawiera** — porównanie po zawieraniu,
  w obie strony, a nie po równości. `--out data/files` i `--out <katalog nad data>` są odrzucane tak
  samo jak `--out data`;
- ścieżka prowadzi tam **przez dowiązanie symboliczne** — porównywane są ścieżki rozwiązane
  (`realpath`), więc dowiązanie nie jest obejściem;
- gdziekolwiek **nad** ścieżką (na dowolnym poziomie) albo tuż **pod** nią leży `session.secret` —
  kopia nigdy go nie zawiera, więc jego obecność oznacza katalog danych aplikacji, nawet jeśli nikt
  go nie nazwał w konfiguracji;
- katalog **istnieje, nie jest pusty i nie został utworzony przez te skrypty** — rozpoznają własne
  po pliku `.katalog-roboczy-agentic`. Nie ma znacznika, nie ma kasowania; wskaż katalog pusty albo
  nieistniejący. Odwrotnie: znacznik ma pierwszeństwo przed regułą `session.secret` **dla tego
  jednego katalogu**, więc próbę wolno powtórzyć do tego samego `--out` mimo sekretu, który zapisał
  tam start aplikacji.

To samo dotyczy `backup-state.mjs` i jego `--out`: kopia **nadpisuje** `app.db` i drzewa plików, więc
wolno ją zapisać tylko do katalogu nieistniejącego, pustego albo do własnej wcześniejszej kopii
(rozpoznawanej po `manifest.json`). Kopia **do** cudzego katalogu danych nadpisywała bazę użytkownika
i kończyła się kodem 0 — do 2026-09-18, kiedy `--out` dostał tę samą ochronę co pozostałe skrypty.

Katalogiem danych jest przy tym `data/` w repozytorium **i** katalog z `APP_DATA_DIR`, bo instalacja
może trzymać stan gdzie indziej.

> Do 2026-09-18 te kontrole porównywały ścieżkę na równość i szukały `session.secret` tylko na
> najwyższym poziomie. `--out <katalog-danych>/files` przechodziło i kasowało pliki użytkownika z
> kodem wyjścia 0. Każdy z czterech przypadków wyżej ma dziś test w regresji.

`restore-state.mjs` niczego nie kasuje, ale **przenosi** katalog wskazany przez `--data`, więc
odmawia, gdy ten katalog istnieje, nie jest pusty i nie wygląda na katalog danych aplikacji (nie ma
`app.db`, `session.secret`, `files`, `workspaces` ani znacznika).

### Która flaga jest chroniona, a która nie

Każdy z czterech skryptów deklaruje przy sobie (`export const FLAGS`) wszystkie swoje flagi
przyjmujące ścieżkę i to, co z nimi robi: `zapis-chroniony` (odmawia katalogu danych),
`odczyt-chroniony` (tylko czyta, ale i tak odmawia — bo próba migracji uruchomiłaby na tym katalogu
aplikację), `zapis-docelowy` (pisze do katalogu danych celowo — `--data` w odtworzeniu) i `odczyt`
(wolno wskazać katalog danych; `--data` w `backup-state.mjs` to jedyny taki przypadek, bo
kopiowanie żywego katalogu jest sensem tego skryptu).

### Gdzie stoi sprawdzenie

Nie przy argumencie, tylko **przy operacji**. `rmSync`, `renameSync`, `writeFileSync`,
`copyFileSync`, `cpSync` i `mkdirSync` są w tych czterech skryptach wywoływane wyłącznie przez
`scripts/lib/state-tools.mjs` (`usun`, `przenies`, `zapisz`, `kopiujPlik`, `kopiujDrzewo`,
`utworzKatalog`), a każda z nich sprawdza **w chwili wykonania**, czy ścieżka leży w katalogu
zatwierdzonym wcześniej w tym przebiegu. Dzięki temu przestaje mieć znaczenie, **skąd** ścieżka się
wzięła: z flagi, z argumentu pozycyjnego, ze zmiennej środowiskowej czy ze stałej.

Pięć rund próbowało inaczej — strażnik stał przy argumencie i za każdym razem dało się do operacji
dojść bokiem: literałem w podwójnych cudzysłowach, flagą zadeklarowaną pod rodzajem zwolnionym z
kontroli, argumentem pozycyjnym, który parser pomijał. Kształty argumentu są nieograniczone,
operacja nie jest.

Argumenty pozycyjne są dziś odrzucane (te skrypty ich nie przyjmują), a `makeArgs(process.argv,
FLAGS)` odrzuca flagę spoza deklaracji skryptu.

**Co jest sprawdzane w regresji** (`tests/script-path-flags.test.ts`): że żaden z tych czterech
skryptów nie woła tych funkcji samodzielnie; że samo zwężenie gardła odrzuca operację poza
zatwierdzonym katalogiem; że każdy skrypt odrzuca nieznaną flagę i argument pozycyjny; oraz że
zachowanie każdej zadeklarowanej flagi zgadza się z jej rodzajem, przy czym po każdym przebiegu
porównywany jest odcisk SHA-256 katalogu, na który flagę wskazano (poza `app.db-wal` i `app.db-shm`,
które SQLite odtwarza przy samym czytaniu).

**Czego to nie obejmuje**, wprost — pełna lista:

1. **Skryptu, który nie korzysta z `scripts/lib/state-tools.mjs`.** Taki nie ma żadnej z tych ochron;
   test wypisuje listę objętych, żeby luka była widoczna, a nie domniemana.
2. **Sięgnięcia po `node:fs` w formie, której kontrola źródła nie zobaczy** (np.
   `(await import('node:fs')).rm`). Ta kontrola jest o przeoczeniu, nie o przeciwniku.
3. **Podmiany katalogu między zatwierdzeniem a operacją** (TOCTOU). Zatwierdzenie i zapis są w jednym
   procesie i w krótkim odstępie, ale nie są atomowe.
4. **Ścieżek wewnątrz zatwierdzonego katalogu.** Po zatwierdzeniu `--out` skrypt robi w nim, co chce —
   tym właśnie jest katalog roboczy. `approveTarget` odpowiada wyłącznie na pytanie „czy to nie są
   dane aplikacji”; na pytanie „czy wolno skasować to, co tam leży” odpowiada osobno `prepareScratchDir`
   albo `assertOwnOrEmptyDir`.
5. **Zapisów wykonywanych przez zależności, nie przez te skrypty.** `new Database(...)` tworzy
   `app.db-wal` i `app.db-shm` obok czytanej bazy, a procesy potomne uruchamiane przez `execFileSync`
   piszą w katalogach, które dostaną. Te zapisy **nie przechodzą** przez bramkę. Tam, gdzie chodzi o
   cudzy katalog — `--verify` i `restore --check` — skrypt zapamiętuje, które pliki pomocnicze
   zastał, i po odczycie usuwa dokładnie te, które sam utworzył.
6. **Treści pliku pomocniczego, który już tam był.** Ochrona z punktu 5 dotyczy **usunięcia**, nie
   zawartości: plik `app.db-wal` albo `app.db-shm` zastany w cudzym katalogu zostaje na miejscu, ale
   SQLite może po cichu nadpisać jego bajty przy odczycie bazy. Zdanie „plik, który tam był, zostaje
   nietknięty” jest więc prawdziwe o istnieniu pliku i **nieprawdziwe o jego treści**.

Kody wyjścia wszystkich czterech skryptów: **0** zrobione, **1** werdykt negatywny (kopia się nie
weryfikuje, próba znalazła problemy, odtworzony stan nie zgadza się z manifestem), **2** odmowa,
**3** kopia nowsza niż build (tylko odtworzenie), **4** awaria skryptu.

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

Generator kasuje katalog, który dostanie, a próba migracji kasuje swój katalog roboczy — obowiązują
je odmowy opisane wyżej, w „Czego te skrypty nie tkną”. Oba wolno uruchomić ponownie z tym samym
`--out`: katalog, który same utworzyły, rozpoznają po znaczniku `.katalog-roboczy-agentic`, także
wtedy, gdy start aplikacji zdążył zapisać w nim `session.secret`.

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
