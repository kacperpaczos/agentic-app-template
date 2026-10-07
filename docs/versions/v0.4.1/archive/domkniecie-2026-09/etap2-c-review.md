# ETAP 2 / Subagent C — recenzja pakietu izolacji (jakość + bezpieczeństwo)

Data: 2026-09-20. Recenzent: niezależny (nie autor). Pakiet: `bf97be6..a269d6e`, gałąź
`domkniecie/etap2-izolacja` w `lokalny katalog worktree szablonu/etap2-izolacja`,
7 commitów, 17 plików, +1980/−49. Recenzja read-only wobec repo; wszystkie próby na kopiach w `/tmp`
z FAŁSZYMYM sekretem albo w harnessie testowym. HEAD zweryfikowany: `a269d6e1013…`, drzewo czyste.

## Werdykt 1 — zgodność ze specem: ✅

Wszystkie sześć dziur z audytu (`etap2-a-audyt.md`) domknięte na warstwie dozwolonej rulingiem,
każda z parą test pozytywny + negatywny, asercje asertują POWÓD odmowy, nie tylko kod wyjścia:

| Dziura | Naprawa | Dowód (plik:linia) | Testy |
|---|---|---|---|
| 1 — żywy katalog w skryptach | `server-guard.mjs przed` odmowa po `session.secret` w 3 kierunkach; spięte w 3 skryptach PRZED `setsid` | `scripts/lib/server-guard.mjs:203-267` (`problemKatalogu`), `scripts/dev-server.sh` / `audit-server.sh` / `closure-server.sh` (`node … przed --katalog "$DATA" … \|\| exit $?` przed `setsid`) | `tests/server-guard.test.ts` — 34 testy; spinka skryptowa asertowana indeksami (`straż < setsid`), z próbą zdolności wykrycia na atrapie bez spinki |
| 2 — odcisk poświadczeń w acceptance | stat-only odcisk (rozmiar:mtime) przy bramce, porównanie na końcu, kod 5 | `scripts/lib/acceptance-target.mjs:265-313`, `scripts/run-agent.mjs:54-62,110,172`, `scripts/acceptance-agent.mjs:236-241` | `tests/acceptance-target.test.ts` — mtime-only zmiana wykryta, „brak" jawny, pojawienie się pliku wykryte, próba na PRAWDZIWYM skrypcie: exit 5 „ZMIENIL SIE", kontrola przeciwna exit 1 |
| 3 — fałszywe „started" | sonda TCP przed startem; „started" dopiero po potwierdzeniu w /proc, że port trzyma pid z pidfile | `scripts/lib/server-guard.mjs:281-301` (`portZajety`), `:304-345` (`pidNasluchujacyNaPorcie`), `:380-403` (`problemWlasnegoProcesu`); `dev-server.sh` (curl po `$PORT`, `po --pid` przed `echo "started"`) | `tests/server-guard.test.ts` — zajęty port → odmowa z pid właściciela; cudzy właściciel portu → „cudza instancja"; martwy pid; właściwy pid inny program; brak właściciela w /proc → odmowa |
| 4 — RUN_ID + katalog testowy | `APP_INSTANCE_RUN_ID` porównywany z `/api/health`, `APP_DATA_DIR` wymagany i testowy; odmowa przed pierwszym zapisem | `scripts/lib/acceptance-target.mjs:140-146` (expectedRunId), `:207-213` (porównanie), `:218-262` (`problemSrodowiskaOdbiorczego`), `:331-336` (kolejność w bramce) | `tests/acceptance-target.test.ts:552-641` — brak RUN_ID → exit 3, `seen === ['GET /api/health']`, zero POST; inny przebieg → „Z INNEGO PRZEBIEGU"; instancja bez pola → odmowa; dobry przebieg + zły katalog → odmowa przed zapisem; kontrola przeciwna: POST-y dochodzą |
| 5 — porządki `.e2e*` | usuwanie PO pomyślnym `checkCredentialFingerprint`; niezgodny odcisk → katalogi zostają jako dowód; nigdy spod żywego procesu | `e2e/global-teardown.ts:39-66` (`usunKatalogiInstancjiTestowych`), `:73-77` (kolejność) | `tests/global-teardown.test.ts` — usuwa `.e2e*` katalogi (nie pliki/dowiązania), zostawia bez prefiksu; otwarty przez proces → zostaje z powodem, po zamknięciu odchodzi; niezgodny odcisk → błąd i katalog-dowód zostaje |
| 6 — `assertDirectoryFree` fail-closed | `directoryFreeProblem`: `null` i `true` → komunikat odmowy, `false` → zgoda | `e2e/support/port-probe.ts` (`directoryFreeProblem`, `assertDirectoryFree`) | `tests/isolation-orphan.test.ts` — `null`/`true` → komunikaty, `false` → `null`; komunikat nazywa katalog i brak /proc |

**Zakaz globalny zachowany** (sprawdzone w git, nie w deklaracji):
`git diff bf97be6..a269d6e -- packages/ apps/ package.json pnpm-lock.yaml` → **pusty**;
`docs/evidence/**` nietknięte; zero nowych zależności (straż używa `node:fs`/`node:net`/`node:path`).
Kotwica rulingu `tests/isolation.test.ts:215-223` („nieoznaczona instancja nie jest ograniczana")
nietknięta i przechodzi.

**Twierdzenia zweryfikowane:** `pnpm verify` w worktree → **Test Files 71 (71), Tests 1125 (1125),
exit 0** (baselineraportowany 69/1067 → przyrost +2 pliki/+58 testów, spójny z raportem).
`pnpm test:e2e` 224/224 — **nie ponawiane** (zakaz z briefu, 16 min); spójne z raportem i FEEDBACK T9,
ale to jedyne twierdzenie przyjęte bez własnego powtórzenia.

## Werdykt 2 — jakość: **zatwierdzony**

Kod czytelny, decyzje udokumentowane w miejscu użycia, komunikaty odmowy prowadzą do działającej
komendy (nie tylko blokują), testy mają próby zdolności wykrycia („reguła kasująca wszystko by tu
nie przeszła") i kontrole przeciwne. Jedna uwaga jakościowa: powtarzalny wzorzec
`try { CLAUDE_CONFIG_DIR=atrapa } finally { restore }` w dwóch plikach testowych mógłby być helperem
(kosmetyka). Nie blokują niczego poniższe findings — Important-1 prosi o tanią poprawkę, reszta to
notki resztkowe.

## Findings

### Critical: 0

Nie znalazłem drogi, którą test/próba dotknęłaby dane użytkownika albo poświadczenie mimo strażników.
Próby adwersarskie (wszystkie na fałszywych sekretach w /tmp):
- `session.secret` jako **dowiązanie symboliczne** do obcego pliku → odmowa (`existsSync` podąża za
  dowiązaniem; fail-closed), exit 2.
- **Skopiowany znacznik** `.agentic-serwer-guard` → bezużyteczny (porównanie ścieżki w treści,
  `server-guard.mjs:172-186`) — dodatkowo zamrożone testem.
- **Ścieżka przez dowiązany przodek** — detekcja po `realpathSync` (`realnaSciezka`), domyślny katalog
  porównywany po realnej ścieżce (`server-guard.mjs:250`).
- **TOCTOU sonda portu → `setsid`**: okno istnieje, ale `po` po starcie weryfikuje właściciela LISTEN
  z /proc przeciw pidfile (`server-guard.mjs:380-403`), więc wyścig kończy się odmową albo
  nieudanym startem — nigdy fałszywym „started" i cudzym pidfile. `null` od pytania o właściciela to
  odmowa, nie zgoda (fail-closed).
- **Znacznik w prawdziwych danych**: żeby znacznik wylądował w katalogu, `przed` musi najpierw
  przepuścić — a katalog z `session.secret` jest odmawiany przed zapisem znacznika; jedyna droga to
  katalog świeży w chwili startu, który później stał się danymi (tekst znacznika wprost każe go wtedy
  usunąć). Wyjątek `data/` repo nie może wrócić przez znacznik (`server-guard.mjs:250-251`).
- **Komunikaty**: żadna odmowa nie drukuje treści plików (test asertuje `not.toContain(FAKE_SECRET)`);
  odcisk w komunikacie to rozmiar:mtime — nie sekret; treść `.credentials.json` nigdy nie czytana
  (`statSync` wyłącznie, `acceptance-target.mjs:270-278`).

### Important: 1

**I-1. Ścieżka crash w próbach odbiorczych omija porównanie odcisku — a to jest jedyna detekcja
najryzykowniejszej ścieżki.** `scripts/acceptance-agent.mjs:81` (`call()` rzuca przy `!res.ok` —
nieprzechwycony throw w setupie kończy proces bez `sprawdzOdciskPoswiadczen` z :236-241); analogicznie
`scripts/run-agent.mjs:119-127` (wyjątek w pętli strumienia SSE, np. `JSON.parse` wadliwej linii,
omija `zakoncz`). Dodatkowo odcisk żyje wyłącznie w pamięci procesu (acceptance **nie** zapisuje
pliku-przenośnika tak jak e2e, `e2e/credential-guard.ts:54-59`), więc po crashu nie ma nic, czym dało
by się dowiedzieć „przed" po fakcie. Waga wynika z tego, że prawdziwego agenta sprowadza **serwer**
(SDK działa po stronie instancji), więc porównanie w procesie nadrzędnym jest jedynym detektorem
dla tej ścieżki — `run-agent`/`acceptance-agent` mówią do serwera tylko HTTP. Implementator to
ujawnił (obawa 4) i częściowe pokrycie przez dzieci łagodzi, ale dzieci detekują tylko własne końce.
Rekomendacja (tania): `process.on('exit')`/try-finally wokół korpusu obu skryptów albo zapis odcisku
do `test-results/` jak w e2e. Nie blokuje zatwierdzenia (kontrola detekcyjna, nic w repo nie zapisuje
tego pliku z zamysłem), ale powinno być domknięte w kolejnym pakiecie.

### Minor: 5

- **M-1.** `tests/acceptance-target.test.ts:181` (`runScript` nie ustawia `CLAUDE_CONFIG_DIR`),
  użycia :543 i :679 — testy przepuszczające bramkę statują **prawdziwy** plik poświadczeń
  (read-only, zgodnie z kontraktem produkcyjnym tych samych skryptów; treść nieczytana). Skutek
  uboczny: jeśli mtime prawdziwego pliku zmieni się w trakcie testu (odświeżenie tokenów na żywej
  maszynie), „kontrola przeciwna" dostanie exit 5 zamiast oczekiwanego 1 → flak. Rekomendacja:
  domyślnie kierować `runScript` na atrapę `CLAUDE_CONFIG_DIR`.
- **M-2.** `acceptance-target.mjs:244` — prefiks `.e2e` akceptowany **w dowolnym miejscu fs**:
  potwierdzone próbą, `$HOME/.e2e-cokolwiek` przechodzi `problemSrodowiskaOdbiorczego` (tmp i
  `$HOME/Documents` poprawnie odmawiane). Warstwa deklaracji jest więc słabsza niż sugeruje nazwa
  „katalog testowy"; realny cel zapisu i tak musi być instancją z etykietą i zgodnym RUN_ID, więc to
  klasa świadomego kłamstwa operatora (ujawniona jako obawa 1). Można zaostrzyć: tmp ∪ prefiks
  wewnątrz repo (jak wymaga `config.ts` dla `agenticapp-test`).
- **M-3.** `scripts/diag-frontend.mjs` i `scripts/probe-chat-composer.mjs` pobierają odcisk przez
  bramkę (`requireAcceptanceInstance`) i nigdy go nie porównują — pobieranie bez porównania to martwy
  kod, a sondy nie mają końcowej kontroli. (Nie uruchamiają agenta, ryzyko niższe niż run-agent;
  brief dziury 2 wymagał porównania tylko od `acceptance-agent.mjs` i `run-agent.mjs`.)
- **M-4.** `server-guard.mjs:100` — granica głębokości 3 poziomy: sekret trzy poziomy niżej
  przepuszczony (potwierdzone próbą). Spójne ze `state-tools.mjs` (równoważność kopii świadomie
  utrzymana — implementator poprawił oczekiwanie testu, nie kod), a start w odróżnieniu od kasowania
  nie dotyka zagnieżdżonych katalogów. Odnotowane, akceptowalne.
- **M-5.** `e2e/global-teardown.ts:39-66` — katalog użytkownika ręcznie nazwany `.e2e-*` w korzeniu
  repo zostałby usunięty przy zgodnym odcisku i braku otwartych deskryptorów. Konwencja repo
  (`.e2e*` = instancje testowe, wymuszana przez `config.ts`) czyni to mało prawdopodobnym; pliki,
  dowiązania i cokolwiek poza korzeniem repo próba obejmuje — nie rusza.

Notki (bez statusu): pidfile w świat zapisywalnym `/tmp` to wzorzec sprzed pakietu — `po` przy
podmienionym pidfile fail-closed (odmowa), więc nie tworzy nowego ryzyka; `przed` zapisuje znacznik
i tworzy katalog nawet gdy późniejszy start padnie (kosmetyka); `audit-server.sh stop` nadal wypisuje
błąd `cat /tmp/audit_data_dir` — sprzed pakietu, ujawnione (obawa 6c).

## Próby (komendy + wyniki)

```
cd lokalny katalog worktree szablonu/etap2-izolacja
pnpm verify                                   → 71 files / 1125 tests / exit 0   (potwierdzone)
pnpm vitest run tests/server-guard.test.ts    → 34/34, exit 0
pnpm vitest run tests/acceptance-target.test.ts → 31/31, exit 0
pnpm vitest run tests/global-teardown.test.ts tests/isolation-orphan.test.ts → 22/22, exit 0
```

Testy negatywne wybrane z briefu — oblewają właściwy przypadek i asertują POWÓD odmowy:
1. **Żywy katalog → odmowa**: `tests/server-guard.test.ts > żywy katalog z fałszywym session.secret…`
   — exit 2, „ODMAWIAM", komunikat nazywa katalog, `not.toContain(FAKE_SECRET)`.
2. **Zajęty port → odmowa z pidem**: `> zajęty port jest odmową z pid właściciela…` — exit 2,
   `pid ${process.pid}` (właścicielem jest proces testowy); plus `> port trzyma ktoś inny niż pid z
   pidfile` — „cudza instancja".
3. **Brak RUN_ID → odmowa przed zapisem**: `tests/acceptance-target.test.ts > brak identyfikatora
   przebiegu: odmowa PRZED pierwszym zapisem` — exit 3, „brak APP_INSTANCE_RUN_ID",
   `seen === ['GET /api/health']`, zero POST.

Próby adwersarskie recenzenta (CLI na fałszywych sekretach w /tmp):
```
ln -s obcy-plik.txt dirA/session.secret; server-guard przed --katalog dirA
  → ODMAWIAM, exit 2  (dowiązaniowy sekret fail-closed)
problemSrodowiskaOdbiorczego: $HOME/.e2e-pod-szhp → PRZECHODZI (M-2); $HOME/Documents → odmowa
sekret w gleb/x1/x2/x3/session.secret; przed --katalog gleb → ok, exit 0  (granica głębokości, M-4)
```

Grep po ścieżkach poświadczeń: nowe pliki testowe zapisują `.credentials.json` **wyłącznie w atrapach
tmp** i kierują `CLAUDE_CONFIG_DIR` na atrapy (z przywracaniem w `finally`); treść prawdziwego
poświadczenia nie jest nigdzie czytana (brak `readFileSync`/hashu po nim w nowym kodzie). Jedyne
kontakty z prawdziwym plikiem: `statSync` w produkcyjnych ścieżkach bramki i M-1. Poza zakresem,
odnotowane: `tests/durability.test.ts` czyta treść prawdziwego poświadczenia jako needles do skanu
wycieku — wzorzec sprzed pakietu.

## Werdykt 1–4 szczegółowo

1. **Zgodność ze specem: ✅** (tabela wyżej; ruling i zakaz globalny potwierdzone w git; e2e 224/224
   przyjęte z raportu bez własnego powtórzenia — zgodnie z briefem).
2. **Jakość: zatwierdzony** (I-1 do domknięcia w kolejnym pakiecie, nieblokujące).
3. **Obawy implementatora** (jedna linia na obawę — szczegóły poniżej):
   - **Obawa 1** (RUN_ID/APP_DATA_DIR = deklaracja + weryfikacja, nie podpis kryptograficzny):
     **akceptowalna jako decyzja** — domyka klasę z audytu (osierocona instancja), uczciwe użycie
     jedno-`export`owe; świadome kłamstwo pozostaje poza zasięgiem i jest to jawnie powiedziane
     (M-2 pokazuje, że deklaracja katalogu jest najsłabsza).
   - **Obawa 2** (zaostrzenie acceptance — jawne zmienne): **zgodna z intencją właściciela, nie
     przesadzona**. Na osi „jawny APP_BASE_URL" pakiet NIE poszedł dalej niż intencja: domyślny 8790
     został, 8791 i poza-loopback odrzucane jak dotąd (audyt wiersz 2: „nie luka funkcjonalna").
     Nowy przymus (RUN_ID + APP_DATA_DIR) służy innej dziurze (4 — osierocona instancja pisze pod
     wspólną etykietą) i jest proporcjonalny: komunikat odmowy zawiera gotowe polecenia, koszt to dwa
     exporty, README pokazuje pełny działający przebieg, `pnpm start`/`pnpm dev` nietknięte.
   - **Obawa 3** (wyjątek tylko `agenticapp-test`+`.e2e`): **akceptowalna jako decyzja** — poprawna
     merytorycznie: `config.ts` faktycznie wiąże z prefiksem tylko tę etykietę, zwolnienie
     `agenticapp-dev`/`-acceptance` byłoby obietnicą bez egzekucji; w spiętych skryptach para i tak
     jest nieosiągalna (brak `--etykieta`).
   - **Obawa 4** (crash nadrzędnego omija porównanie odcisku): **wymaga poprawki** (I-1) — exit-hook
     albo plik-przenośnik; nieblokujące, ale to jedyna detekcja ścieżki serwerowego SDK.
   - **Obawa 5** (`.e2e-data` zostaje po przebiegu przez kolejność Playwright): **akceptowalna jako
     decyzja** — nigdy nie kasujemy spod żywego procesu, katalog jest wymazywany przy każdym bocie
     (`boot-server.ts`) i nie rośnie; resztkowy kosmetyczny ślad, nie śmieć kumulatywna.

## Re-review runda 1 — fix I-1 (commit `8c04b0d`, „Proby odbiorowe: porownanie odcisku takze przy nieprzechwyconym wyjatku; plik-przenosnik")

Zweryfikowane na HEAD `8c04b0d47c78…` (drzewo czyste, rodzic `a269d6e`), diff
`review-a269d6e..8c04b0d.diff` (4 pliki: `scripts/run-agent.mjs`, `scripts/acceptance-agent.mjs`,
`scripts/lib/acceptance-target.mjs`, `tests/acceptance-target.test.ts`).

### Werdykt dla I-1: **ADDRESSED**

- **Oba skrypty**: cały bieg po bramce w `try/catch/finally`; `finally` porównuje odcisk przy
  KAŻDYM kończeniu, w tym po nieprzechwyconym wyjątku — `scripts/run-agent.mjs:166-171` (finally z
  `sprawdzOdciskPoswiadczen(odciskPoswiadczen ?? odciskZPrzenosnika())`, `process.exit(5)` przy
  niezgodności), `:163-165` (krach bez naruszenia → `kodWyjscia = kodWyjscia || 1`); odpowiednio
  `scripts/acceptance-agent.mjs:245-256` (finally) i `:240-241` (krach → kod 1). Dawne
  `zakoncz`-tylko-na-jawnych-ścieżkach usunięte; `!res.ok` nie wychodzi już wcześniej, tylko
  ustawia kod i wpada do wspólnego finally.
- **Plik-przenośnik**: bramka zapisuje odcisk do pamięci ORAZ do pliku —
  `scripts/lib/acceptance-target.mjs:296-302` (`sciezkaPrzenosnika`: `APP_PRZENOSNIK_ODCISKU`
  albo `<cwd>/test-results/`), `:305-312` (`odciskZPrzenosnika`, `undefined` gdy brak),
  `:321-325` (`zapiszOdciskPoswiadczen` pisze `{plik, odcisk}`), `:385` (bramka przekazuje
  `sciezkaPrzenosnika(env)`). Treść przenośnika: **ścieżka + rozmiar:mtime — bez sekretu**
  (sprawdzone w kodzie, `acceptance-target.mjs:323`); `test-results/` gitignorowane
  (`.gitignore:9`); brak przenośnika i brak pamięci → głośny `throw` („brak zapisanego odcisku")
  → exit 5, fail-closed.

### Nowe uszkodzenia w tym diffie: Critical 0 / Important 0 / Minor 0

Asercje istniejących testów nie osłabione (kontrola przeciwna nadal wymaga dotarcia POST-ów;
stary test exit-5 nadal przechodzi). Semantyka kodów wyjścia zachowana: naruszenie → 5 (priorytet
nad wynikiem scenariuszy), krach bez naruszenia → 1 ze widocznym stosem (test asertuje
`SyntaxError` w stderr i brak „ZMIENIL SIE"), sukces → 0. Żaden test nie czyta treści prawdziwego
poświadczenia; nowe testy używają atrap i `APP_PRZENOSNIK_ODCISKU` w tmp. Otwarte pozycje z rundy 1
bez zmian (M-1 nadal aktualny: `runScript`/`:543` bez `CLAUDE_CONFIG_DIR` — stat prawdziwego pliku).

Deferred minor (poza zakresem tego diffu, jedna linia każdy):
- `mkdirSync`/`writeFileSync` przenośnika może rznąć w `requireAcceptanceInstance` (niezapisywalny
  katalog) → exit 3 z surowym błędem fs — fail-closed, komunikat mniej czytelny.
- Dwa równoległe przebiegi z tym samym `APP_PRZENOSNIK_ODCISKU` nadpisują nawzajem przenośnik
  (porównania w pamięci pozostają poprawne; osłabia to tylko ścieżkę dowodową po krachu).

### Weryfikacja twierdzeń implementatora

`pnpm vitest run tests/acceptance-target.test.ts` → **36/36, exit 0** (było 31, +5: 4 testy krachu
+ 1 test przenośnika — zgodne z przyrostem 1125 → 1130; pełny verify nie ponawiany, uznałem za
zbędny przy tym zakresie). Cztery testy krachu oblewają właściwy przypadek i asertują POWÓD:
- `run-agent: krach parsowania SSE w trakcie biegu NIE omija porownania — kod 5 z powodem` —
  exit 5, „ZMIENIL SIE", „poswiadczen", a sam `SyntaxError` widoczny (krach nie zamaskowany);
- `kontrola przeciwna: krach bez naruszenia pliku pozostaje krachem (kod 1)` — exit 1,
  `SyntaxError`, brak „ZMIENIL SIE";
- `acceptance-agent: krach w setupie NIE omija porownania — kod 5 z powodem` (stand-in z 500 na
  `GET /api/m/procurement/cases` — dokładnie ścieżka z I-1) — exit 5, „ZMIENIL SIE";
- `kontrola przeciwna: krach acceptance-agent bez naruszenia to kod 1` — exit 1,
  `procurement/cases -> 500`.
Plus `plik-przenosnik w test-results niesie odcisk i on jest czytany z powrotem` — zapis, odczyt,
wartość broni w `sprawdzOdciskPoswiadczen` (awaryjna ścieżka fix I-1).

### Ocena decyzji wzorca i dziury resztkowej

**try/catch/finally zamiast `process.on('exit')` — decyzja poprawna.** Argument implementatora jest
technikcznie słuszny: handler `exit` w Node uruchamia tylko kod synchroniczny, nie może zmienić
już przesądzonego kodu wyjścia ani głośno rzucić (throw w hooku jest połknięty), więc wymóg
„kod 5 z nazwaniem sprawcy" byłby w nim nieosiągalny; `finally` daje deterministyczne 5 z komunikatem
i zachowuje stos krachu (wydrukowany w `catch` przed `finally`). Koszt: `finally` nie działa przy
SIGINT/SIGTERM/SIGKILL — ale to ograniczenie dzieli z exit-hookiem (sygnał bez listenera kończy
proces bez `finally` i bez hooka); jedyna realna przewaga hooka (asynchroniczny zapis) nie istnieje,
bo zapis dzieje się wcześniej, przy bramce.

**Resztkowa dziura kill -9 — akceptowalna jako świadomy rezyduum.** Po `kill -9` żadne porównanie
się nie wykona, ale odcisk „przed" **przetrwa** w gitignorowanym `test-results/`
(`acceptance-credential-fingerprint.json`, stat-only: ścieżka + rozmiar:mtime), więc dowód jest
dostępny do ręcznego albo automatycznego sprawdzenia po fakcie — to dokładnie klasa „wykrywanie, nie
zapobieganie" jak w `e2e/credential-guard.ts`. Nadpisywalny `APP_PRZENOSNIK_ODCISKU` jest tu
zaletą (harness i testy kierują go na scratch, nie słabością). Nie blokuje; gdyby właściciel chciał
domknąć do końca, naturalnym miejscem byłby skromny check przenośnika na starcie następnego
przebiegu („poprzedni przebieg nie zdążył porównać odcisku") — odnotowane jako propozycja, nie wymóg.



Żadnego commita, żadnej mutacji repo (próby w /tmp i w harnessie vitest), brak pełnego `pnpm
test:e2e`, żadnych skryptów startujących serwery poza harnesem testowym; po próbach porządki
(`rm -rf` katalogów tymczasowych). Wszystkie ścieżki plików w tej recenzji są względne wobec
`lokalny katalog worktree szablonu/etap2-izolacja/`.
