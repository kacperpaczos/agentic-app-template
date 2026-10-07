# ETAP 2 / Subagent B — raport: domknięcie dziur izolacji testów

Data: 2026-09-20. Worktree: `lokalny katalog worktree szablonu/etap2-izolacja`,
gałąź `domkniecie/etap2-izolacja`, baza `bf97be6`, HEAD pakietu `a269d6e`.

## Status: DONE_WITH_CONCERNS

Wszystkie sześć dziur z audytu domknięte, `pnpm verify` = 0 i `pnpm test:e2e` = 0 na kodzie
pakietu. Status DONE_WITH_CONCERNS (a nie DONE) wyłącznie przez świadome, udokumentowane decyzje
projektowe przy dziurach 2/4 i jedno zachowanie sprzed pakietu — szczegóły w „Obawy i decyzje"
na końcu. Zasada nadrzędna zachowana: `packages/platform-server/src/config.ts` i cała warstwa
serwerowa nietknięte (`git diff bf97be6..HEAD --stat` nie zawiera żadnego pliku z `packages/`
ani `apps/`).

## Commity (hash + tytuł)

| Hash | Tytuł |
|---|---|
| `b20844b` | Skrypty startujace serwer: odmowa na katalogu zywych danych (ETAP 2, dziura 1) |
| `0a955a1` | Skrypty startujace serwer: sonda portu przed startem i potwierdzenie wlasnego pid (ETAP 2, dziura 3) |
| `2666025` | Bramka prob odbiorowych: identyfikator przebiegu i testowy katalog danych (ETAP 2, dziura 4) |
| `66143e0` | Proby odbiorowe: odcisk pliku poswiadczen brany przy bramce i sprawdzany na koncu (ETAP 2, dziura 2) |
| `e3df85b` | Porzadki po katalogach .e2e* w teardown e2e; brak odpowiedzi o katalogu to odmowa (ETAP 2, dziury 5-6) |
| `9e345bc` | Dokumentacja: proba odbiorcza z identyfikatorem przebiegu i testowym katalogiem danych |
| `a269d6e` | Dziennik T9: domkniecie dziur izolacji testow (ETAP 2) |

Razem: 7 commitów, 1880 wstawień / 49 usunięć (bez FEEDBACK i README), 2 nowe pliki kodu
(`scripts/lib/server-guard.mjs`, `e2e/global-teardown.ts` — rozbudowany), 3 nowe pliki testowe
(`tests/server-guard.test.ts`, `tests/global-teardown.test.ts`, rozszerzone istniejące).

## Co i dlaczego

### Dziura 1 — żywy katalog danych w skryptach `.sh`

**Powód.** Straż `config.ts` celowo ogranicza tylko instancje z etykietą `agenticapp-test`
(`config.ts:83` wraca natychmiast bez etykiety), więc `dev-server.sh`, `audit-server.sh`,
`closure-server.sh` — startujące bez etykiety — brały `APP_DATA_DIR` na wiarę. Ruling: naprawa na
warstwie skryptowej.

**Zmiana.** Nowy `scripts/lib/server-guard.mjs`, wywoływany w każdym z trzech skryptów PRZED
`setsid` (`|| exit $?`, więc odmowa realnie niczego nie startuje). Reguła `przed`:

- dowiązanie symboliczne → odmowa;
- `session.secret` (istnienie pliku; treść nigdy nie czytana ani drukowana) wykrywany w trzech
  kierunkach jak `state-tools.mjs`: w katalogu, **powyżej** (katalog wewnątrz cudzych danych —
  bez wyjątku nawet dla etykiety testowej, bo harness kasuje swoje katalogi), **poniżej**
  (ta sama granica głębokości co `state-tools`);
- wyjątki od odmowy na własny sekret: (a) etykieta `agenticapp-test` + prefiks `.e2e` — para, którą
  `config.ts` i tak wymusza dla tej etykiety; (b) własny znacznik `.agentic-serwer-guard`
  z wcześniejszego startu, powiązany ścieżką (lekcja `state-tools` o skopiowanym znaczniku) — bez
  niego restart instancji audytowej na jej własnym katalogu byłby „żywymi danymi";
- znacznik **nie** działa dla domyślnego katalogu `data/` repozytorium (tam żyją prawdziwe dane);
- `dev-server.sh` czyta `DEV_DATA`/`DEV_PORT` (domyślnie bez zmian), żeby komunikat odmowy miał
  konkretną drogę wyjścia („dla własnej aplikacji `pnpm start`, dla tego skryptu `DEV_DATA=…`").

### Dziura 3 — fałszywe „started" w `dev-server.sh`

**Powód.** Skrypt pollował `/api/health` pod stałym `http://127.0.0.1:8791` i zgłaszał sukces na
pierwszą odpowiedź — przy zajętych 8791 odpowiadała cudza instancja, a pidfile opisywał martwy
proces.

**Zmiana.** (1) Sonda TCP **przed** startem (wzorzec `port-probe.ts:44-58`; TCP, nie HTTP —
półstartowany serwer też trzyma port) → odmowa z pidem właściciela czytanym z `/proc/net/tcp{,6}`
i `/proc/*/fd`. (2) Po pierwszej odpowiedzi zdrowia podpolecenie `po` potwierdza w `/proc`, że
port trzyma właśnie proces z pidfile: żywy, z `apps/server/dist/server.js` w cmdline, właściciel
gniazda LISTEN. Brak potwierdzenia = odmowa („potwierdzenie własne musi być czytelne, nie
domniemane"). `po` dostały też `audit-server.sh` i `closure-server.sh`.

### Dziura 4 — RUN_ID + testowy katalog danych w próbach odbiorczych

**Powód.** Etykieta jest wspólna dla wszystkich instancji testowych, więc osierocona instancja z
przerwanego startu przechodziła całą bramkę (audyt, punkt 9). e2e ma na to `APP_INSTANCE_RUN_ID`
(`isolation.ts:305-313`); próby odbiorcze nie miały nic.

**Zmiana** (`scripts/lib/acceptance-target.mjs`): `requireAcceptanceInstance` wymaga w
środowisku próby `APP_INSTANCE_RUN_ID` i `APP_DATA_DIR` (te same wartości, z jakimi startowała
instancja), porównuje identyfikator z `instanceRunId` z `/api/health` (instancja z innego
przebiegu **i** instancja odpowiadająca `null` są odmawiane), oraz wymaga katalogu testowego:
prefiks `.e2e` albo katalog w systemowym tmp (rozpoznawane po rzeczywistej ścieżce). Odmowa przed
pierwszym żądaniem zapisującym; `seen` pozostaje `['GET /api/health']`, zero POST. Komunikat
podaje gotowe polecenia startu zgodnej instancji. `diag-frontend.mjs` i `probe-chat-composer.mjs`
(przechodzące przez tę samą bramkę) dostają przekazanie pełnego środowiska.

### Dziura 2 — odcisk poświadczeń w próbach odbiorczych

**Powód.** Próba uruchamia prawdziwego agenta i nic nie dowodziło, że nie naruszyła logowania
użytkownika (G21).

**Zmiana.** Bramka przy przepuszczeniu zapisuje odcisk `.credentials.json` — rozmiar:czas
modyfikacji, **wyłącznie `statSync`** (wzorzec `e2e/credential-guard.ts`; treść pliku nigdy nie
jest czytana nawet do hashu). `run-agent.mjs` porównuje odcisk przy **każdym** kończeniu, także
błędnym; `acceptance-agent.mjs` przy końcu nadrzędnym (każdy potomek `run-agent` sprawdza swój
odcisk osobno, więc ścieżki ryzyka — rzeczywiste uruchomienia agenta — są pokryte niezależnie).
Zmiana = kod wyjścia 5 z nazwaniem przebiegu sprawcy. Brak pliku w środowisku CI-like jest jawny
(odcisk „brak" + komunikat; pilnowane jest wtedy pojawienie się pliku), a brak zapisanego odcisku
przy końcu to również błąd, nie ciche przejście.

### Dziura 5 — porządki w `global-teardown`

**Powód.** ~30 katalogów `.e2e*` kumulowało się w repo; warunek odbioru wymaga „repozytorium bez
śmieci".

**Zmiana.** `globalTeardown` PO pomyślnym `checkCredentialFingerprint` usuwa katalogi `.e2e*` w
korzeniu repozytorium, których nie trzyma żaden żywy proces (`directoryInUse === false`); przy
niezgodności odcisku porządki **nie idą** — katalogi zostają jako dowód naruszenia. Pliki i
dowiązania poza zakresem; katalog otwarty przez proces albo pytanie niemożliwe (brak `/proc`)
zostaje z powodem wypisanym na wyjście.

### Dziura 6 — `assertDirectoryFree` fail-closed

`null` z `directoryInUse` (brak `/proc`, nic nieczytelne) dawniej przechodził po cichu. Nowa
eksportowana funkcja `directoryFreeProblem(answer, dir)` zamienia wszystkie trzy odpowiedzi na
decyzje: `true` i `null` → komunikat odmowy, `false` → `null` (zgoda). `assertDirectoryFree`
rzuca na obie odmowy.

### Dokumentacja

README dokumentował start instancji odbiorczej (`.acceptance-data`, bez identyfikatora), który
nowa bramka odrzuciłaby — zamieniony na pełny, działający przebieg w jednej powłoce z opisem
porównania identyfikatora i odcisku. `pnpm start`, `pnpm dev`, `pnpm acceptance` (samo polecenie)
bez zmian.

## Testy (pozytywna + negatywna na każdą naprawę)

Nowe/rozszerzone pliki: `tests/server-guard.test.ts` (34 testy), `tests/global-teardown.test.ts`
(5), `tests/acceptance-target.test.ts` (24, było 15), `tests/isolation-orphan.test.ts`
(+2). Kluczowe przypadki:

- **żywy katalog**: fixture w tmp z FAŁSZYWYM sekretem → odmowa (kod 2), komunikat nazywa katalog,
  nie zawiera treści pliku; katalog z sekretem niżej; katalog wewnątrz żywych danych odrzucony
  nawet z etykietą testową; `.e2e` bez etykiety i etykieta bez `.e2e` — odmowa; skopiowany
  znacznik — odmowa; własny znacznik w `<atrapa-repo>/data` — odmowa (z „pnpm start" w
  komunikacie); przepusty: katalog nieistniejący (dostaje znacznik), katalog bez strażnej
  zawartości (kontrola przeciwna), etykieta testowa + `.e2e`, ponowny start na własnym katalogu;
  jednostkowo `sekretPowyzej`/`sekretWKataloguLubPonizej` (własne katalogi pomijane, granica
  głębokości); **spinka**: każdy `.sh` wywołuje straż przed `setsid`, a `po` przed „started"
  + próba zdolności wykrycia na atrapie skryptu bez spinki.
- **port/pid**: zajęty port → odmowa z `pid <właściciel>` (właścicielem jest proces testowy);
  wolny → przepust; `--port zero` → odmowa; kontrola bez `--port` (przepust — nie „odmawiaj
  zawsze"); `po`: własny proces przechodzi; port trzyma ktoś inny → odmowa „cudza instancja";
  martwy pid; właściwy pid z innym programem; brak właściciela w `/proc` → odmowa.
- **RUN_ID/katalog**: brak `APP_INSTANCE_RUN_ID` → odmowa (kod 3), `seen === ['GET /api/health']`,
  zero POST, komunikat z gotowymi poleceniami; instancja z innego przebiegu → „Z INNEGO
  PRZEBIEGU"; instancja bez pola (`null`) → odmowa; dobry przebieg + katalog poza testowymi →
  odmowa przed zapisem; kontrola przeciwna: dobre środowisko + dobra etykieta → POST-y dochodzą;
  jednostkowo wszystkie warianty `problemSrodowiskaOdbiorczego`.
- **odcisk**: honorowanie `CLAUDE_CONFIG_DIR`; zmiana samego mtime przy identycznej treści →
  wykryta (G21 bez wyjątku); „brak" jawny, pojawienie się pliku wykryte; brak zapisanego odcisku
  → błąd; bramka zwraca odcisk; **na prawdziwym skrypcie**: dotknięcie pliku po linii
  `# instancja:` → `run-agent` kończy kodem 5 z „ZMIENIL SIE"; kontrola przeciwna — bez zmiany
  kończy kodem 1 jak dotychczas.
- **porządki**: usuwa `.e2e*` (z zawartością też), zostawia katalog bez prefiksu, PLIK `.e2e.lock`
  i dowiązanie `.e2e*`; katalog otwarty deskryptorem zostaje z powodem, po zamknięciu odchodzi
  (kontrola przeciwna); próba zdolności wykrycia (reguła „kasuj wszystko" by tu nie przeszła
  niewidocznie — asercje „co NIE odchodzi" są osobne); zgodny odcisk → porządki idą; niezgodny →
  błąd i katalog-dowód zostaje.
- **dziura 6**: `directoryFreeProblem`: `null`/`true` → komunikaty, `false` → `null`.

### Wyjścia z przebiegów

```
baseline:  pnpm install --frozen-lockfile && pnpm verify
           → Test Files 69 passed (69), Tests 1067 passed (1067), exit 0

po pakiecie: pnpm verify
           → Test Files 71 passed (71), Tests 1125 passed (1125), exit 0
             (check:boundaries, check:acceptance, check:matrix, check:closure,
              typecheck ×3, build, test)

pnpm test:e2e   → 224 passed (16.5m), exit 0  (bez testów modelowych — zero tur)
```

### Próby dymne na prawdziwym skrypcie (własne procesy, tmp, porty 18791-18795)

```
DEV_DATA=<tmp z FAŁSZYWYM session.secret> DEV_PORT=18791 scripts/dev-server.sh
  → [server-guard] ODMAWIAM: katalog danych … zawiera dane istniejacej instancji …
    exit 2; brak /tmp/agentic-server.pid; nic nie wystartowało
DEV_DATA=<świeży tmp> DEV_PORT=18791 (port zajęty przez własnego okupanta testu)
  → [server-guard] ODMAWIAM: port 18791 jest juz zajety (pid 3673966) … exit 2
DEV_DATA=<świeży tmp> DEV_PORT=18791 scripts/dev-server.sh
  → ok (katalog) / ok (port trzyma wlasny proces 3674208) / started pid=3674208 port=18791
    /api/health → {"ok":true,"instanceLabel":null,"instanceRunId":null}
    stop → stopped pid=3674208; katalog zawierał tylko artefakty bootu tmp; SMOKE-OK
restart na tym samym katalogu (po stopie, sekret instancji w środku) → started, exit 0
AUDIT_DATA=<tmp> AUDIT_PORT=18795 scripts/audit-server.sh start|stop → started/stopped
kontrola po wszystkim: brak procesów `dist/server.js`, brak nasłuchów 8792-8799/1879x,
brak plików pid — czysto.
```

W realnym przebiegu `pnpm test:e2e` porządki z dziury 5 usunęły 22 katalogi `.e2e-scripted-*`
i zostawiły `.e2e-data` z jawnym powodem („katalog jest otwarty przez dzialajacy proces") —
Playwright zabija webServer **po** `globalTeardown`; katalog i tak jest wymazywany przy każdym
boocie (`boot-server.ts`).

## Obawy i decyzje warte recenzji

1. **Dziura 4 jest wymogiem deklaracji + weryfikacji odpowiedzi, nie podpisem kryptograficznym.**
   Operator świadomie kłamiący w `APP_INSTANCE_RUN_ID`/`APP_DATA_DIR` może obie wartości
   „dopasować". Domknięta jest klasa z audytu (osierocona/przypadkowa instancja) i uczciwe użycie
   jest jedno-`export`owe; mocniejsza tożsamość wymagałaby zmiany serwera (poza rulingiem).
2. **Zasadniczo zawężone zachowanie prób odbiorczych**: każde `pnpm acceptance` /
   `run-agent.mjs` / `diag-frontend.mjs` / `probe-chat-composer.mjs` wymaga teraz eksportu
   `APP_INSTANCE_RUN_ID` i testowego `APP_DATA_DIR`. Celowe (tak brzmiał audyt), ale to zmiana
   wygody; README zaktualizowane, `docs/ACCEPTANCE.md` L1.8 pozostaje prawdziwe (nie twierdzi, że
   każda oznaczona instancja jest przyjmowana).
3. **Wyjątkiem od odmowy na własny sekret jest tylko para `agenticapp-test`+`.e2e`** — instancje
   `agenticapp-dev`/`agenticapp-acceptance` nie są zwalniane, bo `config.ts` ich faktycznie nie
   wiąże z prefiksem (zwolnienie byłoby obietnicą bez egzekucji).
4. **Odcisk w `acceptance-agent.mjs` przy normalnym końcu** — nagły crash nadrzędnego omija
   porównanie; dzieci `run-agent` sprawdzają swoje osobno, więc realne uruchomienia agenta są
   pokryte.
5. **Porządki a kolejność Playwright**: `.e2e-data` pozostaje po przebiegu (webServer żyje do
   zabicia po `globalTeardown`) — świadome: nigdy nie kasujemy spod żywego procesu; katalog jest
   wymazywany przy każdym starcie i nie jest śmieciem rosnącym.
6. **Poza zakresem, odnotowane**: `audit-server.sh stop` wypisuje błąd `cat /tmp/audit_data_dir`
   (zachowanie sprzed pakietu); `dev-server.sh` bez etykiety nadal wystartuje na świeżym
   katalogu bez sekretu — zgodnie z rulingiem (etykieta wymagałaby katalogu `.e2e` w repo).
7. Kontrola przeciwna w `tests/acceptance-target.test.ts` dostała nowe zmienne środowiskowe
   (bramka ich wymaga); asercje celu testu nie zostały osłabione — POST-y nadal muszą dotrzeć.

## Regresja istniejących strażników

Wszystkie istniejące kontrole przechodzą bez osłabienia (verify = 0). Jedyna modyfikacja
istniejącej asercji: „kontrola przeciwna" w `tests/acceptance-target.test.ts` (szczegóły wyżej).
`tests/isolation-orphan.test.ts` rozszerzony o dziurę 6, żadna asercja nie usunięta.

## Fix round 1 — FINDING I-1 (crash-path omijał porównanie odcisku)

**Finding (recenzent, verbatim):** „crash-path w `acceptance-agent.mjs:81` i `run-agent.mjs`
(nieprzechwycony wyjątek, np. `JSON.parse` wadliwej linii SSE) omija porównanie odcisku, a odcisk
żyje tylko w pamięci (brak pliku-przenośnika jak w e2e) — a porównanie w procesie nadrzędnym to
jedyna detekcja ścieżki serwerowego SDK. Tania poprawka: exit-hook / zapis odcisku do
`test-results/`."

**Co zmienione.**

1. **Gwarancja porównania (wzorzec: try/catch/finally).** W `scripts/run-agent.mjs` i
   `scripts/acceptance-agent.mjs` cały bieg po bramce stoi w `try/catch/finally`:
   - `catch` drukuje stos wyjątku na stderr i zapamiętuje kod 1 — krach **pozostaje krachem**,
     nie jest maskowany przez porównanie;
   - `finally` porównuje odcisk **zawsze** — przy niezgodności drukuje powód („ZMIENIL SIE") i
     kończy kodem 5, niezależnie od wyniku scenariuszy i od tego, czy bieg się wywalił;
   - końcowe `process.exit(kod)` następuje po `finally`.
   Wybrany wzorzec zamiast `process.on('exit')` celowo: w handlerze `'exit'` nie da się zmienić
   kodu wyjścia ani rzucić głośnego błędu, a `try/finally` daje obie rzeczy i jest czytelne w
   przeglądzie. Nadpisywanie `APP_INSTANCE_LABEL`-owych ścieżek wcześniejszych (użycie bez
   argumentów → kod 2, odmowa bramki → kod 3) zostaje poza wrapperem — przed zapisaniem odcisku
   nie ma czego porównywać.
2. **Plik-przenośnik (decyzja jaka w `e2e/credential-guard.ts`: plikiem, nie środowiskiem).**
   Bramka (`requireAcceptanceInstance`) zapisuje odcisk do
   `test-results/acceptance-credential-fingerprint.json` (`{plik, odcisk}` — wyłącznie size:mtime
   poświadczeń, nigdy treść); katalog nadpisywalny zmienną `APP_PRZENOSNIK_ODCISKU`
   (testy kierują go na tmp). Nowy eksport `odciskZPrzenosnika()` czyta wartość z powrotem, a
   `finally` używa jej awaryjnie, gdy zmienna pamięciowa jest niedostępna — odcisk przeżywa
   proces. Plik ląduje wyłącznie w gitignorowanym `test-results/`, nigdy w `docs/evidence/`.
   Charakter read-only wobec poświadczeń bez zmian: jedyny kontakt to `statSync` (size:mtime).

**Nowe testy** (`tests/acceptance-target.test.ts`, 4 przypadki + 1 jednostkowy na przenośnik):

- `run-agent`: stand-in serwuje 200 + `text/event-stream` z linią `data: {zepsute-json` →
  `JSON.parse` rzuca w połowie biegu; atrapa poświadczeń dotknięta po przejściu bramki →
  **kod 5**, stderr zawiera „ZMIENIL SIE … poswiadczen" (powód) **i** `SyntaxError` (krach
  widoczny, nie zamaskowany); stdout potwierdza, że bramka przeszła.
- kontrola przeciwna: ten sam krach bez dotknięcia pliku → **kod 1**, `SyntaxError` obecne,
  „ZMIENIL SIE" nieobecne.
- `acceptance-agent`: bramka przechodzi, pierwszy krok setupu (`GET /api/m/procurement/cases`)
  odpowiada 500 → `call()` rzuca przed jakimkolwiek scenariuszem; dotknięta atrapa → **kod 5** z
  powodem; kontrola przeciwna → kod 1 z „procurement/cases -> 500".
- jednostkowo: round-trip pliku-przenośnika (zapis → odczyt → porównanie z wartością z pliku
  przechodzi; brak pliku → `undefined`).

**Komenda i wyjście.**

```
pnpm typecheck                                    → 0 błędów
npx vitest run tests/acceptance-target.test.ts
  tests/e2e-credential-guard.test.ts
  tests/credential-guard.test.ts
  tests/isolation-orphan.test.ts
  tests/server-guard.test.ts
  tests/global-teardown.test.ts                   → Tests 128 passed (128)
pnpm verify                                       → Test Files 71 passed (71),
                                                    Tests 1130 passed (1130), exit 0
```

(pełne `test:e2e` zgodnie z poleceniem nie było uruchamiane w tej rundzie; poprzedni pełny
przebieg = 224 passed, kod nie dotyka warstwy, którą by obciążał inaczej niż verify.)

**Commit:** `8c04b0d` — „Proby odbiorowe: porownanie odcisku takze przy nieprzechwyconym
wyjatku; plik-przenosnik (fix I-1)". Nic niewypchnięte.

**Obawy po rundzie.** (a) `kill -9` procesu próby nadal omija wszystko — fizycznie nie do
zamknięcia po stronie procesu; plik-przenośnik pozostawia po tym ślad wartości, z którą próba
wystartowała. (b) Wielokrotne uruchomienia prób współdzielą domyślny plik-przenośnik
(`test-results/`), każdy zapis nadpisuje wartość ze swoim czasem bramki — porównanie jest zawsze
„od swojej bramki", plik służy inspekcji i awaryjnemu odczytowi; równoległe próby tego samego
użytkownika pozostają poza założeniami (jak cały harness).

## Fix round 2 (final review I-1) — porządki kasowały `.e2e-model-turns/`

**Finding (final reviewer, verbatim):** „`usunKatalogiInstancjiTestowych`
(`e2e/global-teardown.ts:39-69`, reguła prefiksowa `:53`) kasuje z korzenia repo każdy katalog
`.e2e*` bez listy wykluczeń — w tym `.e2e-model-turns/`, dokumentowany jako jedyny rejestr budżetu
tur (AGENTS.md:140,150; README.md:315; 21/25, sufit 25). Po scaleniu pierwszy `pnpm test:e2e` w
kopii z rejestrem go trwale usuwa, a `readZ11Ledger` startuje wtedy od zera — ciche obejście
sufitu subskrypcji."

**Co zmienione.**

1. **Warunek KSZTAŁTU zamiast listy wyjątków** (zgodnie z preferencją recenzenta). Nowy eksport
   `nosiCechyDanychInstancji(katalog)` w `e2e/global-teardown.ts`: katalog jest danymi instancji
   wtedy, gdy ma bezpośrednio w sobie `app.db` **albo** `session.secret` — obie rzeczy zawsze
   zostawia po sobie boot instancji (`loadConfig` tworzy strukturę, `auth/session.ts:28` pisze
   sekret). `usunKatalogiInstancjiTestowych` kasuje wyłącznie katalogi `.e2e*`, które ten warunek
   przechodzą i których nie trzyma żywy proces; katalog bez cech zostaje z powodem
   „katalog nie nosi cech danych instancji (brak app.db i session.secret) — porzadki kasuja tylko
   dane instancji testowych, nigdy danych nieinstancyjnych". **Lista wykluczeń nie została
   dodana** — uzasadnienie: wyjątek chroniłby tylko nazwane przypadki i starzał się razem z
   dokumentacją; kształt danych instancji jest właściwością tego, co porządki są w stanie
   bezpiecznie skasować, więc każdy przyszły nieinstancyjny katalog (rejestr, notatki, cokolwiek)
   jest z natury poza zasięgiem. Kolejność sprawdzeń: kształt (tanie `existsSync`) przed
   `directoryInUse` (skan `/proc`).
2. **Testy** (`tests/global-teardown.test.ts`, przebudowany blok „co odchodzi" + nowy blok
   „prefiks to za mało"): (a) `.e2e-model-turns` z atrapą rejestru (`bl01-bl02.json`,
   `z11-bl03.json`) **przeżywa** porządki, a test asertuje POWÓD („nie nosi cech danych
   instancji") i nietkniętą treść rejestru; (b) regresja: katalog instancji z `app.db` odchodzi
   (dodatkowo przypadek tylko z `session.secret`); (c) katalog `.e2e-*` wyłącznie z JSON-em nie
   jest kasowany; kontrola przeciwna warunku kształtu (te same dane JSON + `app.db` odchodzą);
   próba zdolności wykrycia rekonstruuje regułę prefiksową i pokazuje, że warunek kształtu MUSI
   się od niej różnić właśnie na `.e2e-model-turns`. Istniejące przypadki dostosowane: pusty
   katalog `.e2e-*` nie jest już kasowany (brak cech — zostaje z powodem), katalog „w użyciu"
   dostaje `app.db`, by przechodził warunek kształtu, a w teście kolejności (odcisk niezgodny →
   porządki nie idą) katalog-dowód też ma `app.db`.
3. **Adnotacje (ten sam commit, wg rulingu koordynatora):** (a) komentarz
   `scripts/lib/server-guard.mjs` przy `ETYKIETY_TESTOWE` mówił, że `config.ts` ogranicza
   instancję testową do katalogu `.e2e` „inside the repository" — poprawiony na zgodny z faktem:
   `config.ts` sprawdza wyłącznie basename, zawieranie w repo dokłada dopiero harness
   (`isolation.ts`); (b) README przy opisie `pnpm test:e2e`: jedno zdanie, że po przebiegu
   `globalTeardown` usuwa z korzenia repo katalogi instancji `.e2e-*` rozpoznawane po `app.db`
   lub `session.secret`, a dane nieinstancyjne pod tym prefiksem (jak `.e2e-model-turns/`)
   zostają.

**Komenda i wyjście.**

```
npx vitest run tests/global-teardown.test.ts tests/acceptance-target.test.ts
                                                  → Test Files 2 passed (2), Tests 45 passed (45)
pnpm verify                                       → Test Files 71 passed (71),
                                                    Tests 1134 passed (1134), exit 0
```

**Commit:** `6bdb42f` — „Porzadki e2e: warunek ksztaltu danych instancji zamiast samego prefiksu
(ETAP 2, fix final review I-1)". Nic niewypchnięte.

**Obawy po rundzie.** (a) Katalog instancji przerwany w pierwszej sekundzie bootu (między
utworzeniem katalogu a zapisem `app.db`) nie zostałby skasowany — zostaje z powodem i jest to
strona bezpieczna: porządki wolą zostawić sztukę niż skasować dane, które instancją nie są.
(b) Katalog instancji, w którym ktoś ręcznie usunął `app.db` i `session.secret`, przestaje być
rozpoznawalny — ale wtedy przestaje też być danymi instancji w każdym sensownym sensie.
(c) `.e2e-model-turns/` jest chroniony kształtem, nie nazwą — jeśli kiedyś zacząłby trzymać
`app.db` (nie ma powodu), regułę trzeba by ponownie przejrzeć; test `PROBA ZDOLNOSCI WYKRYCIA`
dokumentuje, na czym pole działanie.
