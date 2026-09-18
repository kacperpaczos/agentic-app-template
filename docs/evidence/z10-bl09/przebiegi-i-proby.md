# Z10 / BL-09 — przebiegi i próby zdolności wykrycia

Zapis przebiegów, na których oparte są oceny dwunastu kryteriów pakietu BL-09
(L11.7, L11.10, L11.12, L11.13, L11.15, L11.16, L11.18, L11.19, L11.20, L11.22, L11.23, L11.24).
Plik jest pisany ręcznie i **nie** powstaje z regresji — regresja zapisuje tylko
`pomiary-stop-procesy.json`, i tylko na żądanie (`pnpm evidence:z10`, czyli `APP_WRITE_EVIDENCE=1`).

**Tury modelu: 0.** Żaden spec modelowy nie był uruchamiany. Nowe dowody to *symulacja na granicy
adaptera SDK* (model zastąpiony scenariuszem; workspace, narzędzia, bramka zgody, publikacja,
sprzątanie i procesy prawdziwe) albo *test GUI bez modelu*.

## Przebiegi

| Polecenie | Kod wyjścia | Wynik |
|---|---|---|
| `pnpm verify` (czyste drzewo, commit `cd1964b`) | 0 | 45 plików / 721 testów; `git status --porcelain` po przebiegu: pusto |
| `pnpm exec playwright test e2e/consent-runs.spec.ts` | 0 | 5 testów |
| `pnpm exec playwright test e2e/run-continuity.spec.ts` | 0 | 4 testy |
| `pnpm exec playwright test e2e/sandbox-files.spec.ts` | 0 | 5 testów |
| `pnpm exec playwright test e2e/stop-children.spec.ts` | 0 | 1 test |
| `pnpm exec playwright test` (cały domyślny przebieg) | 1 | 172 zielone, 1 oblany: `e2e/bl10-agent-navigation.spec.ts` „cel w zwinietej sekcji…” — przewijanie do elementu nie zdążyło w 10 s przy trzech równoległych przebiegach przeglądarkowych na maszynie |
| powtórka tego samego specu razem z moimi (spokojna maszyna) | 0 | 18 zielonych, w tym oblany wcześniej test |
| `pnpm check:module-swap` | 0 | podmiana modułu na kontrolny; 163 s |
| `pnpm evidence:z10` | 0 | `pomiary-stop-procesy.json` (commit `c1c9d7c`, `brudneDrzewo: false`) |

Jedyne dwa oblane przebiegi na tym kodzie — pojedynczy test nawigacji wyżej oraz
`tests/measurements.test.ts` („223 ≤ 221”, próg tolerancji przekroczony o 2 ms) — wystąpiły przy
trzech równolegle działających zestawach przeglądarkowych i nie powtórzyły się na spokojnej maszynie.
Oba dotyczą cudzych testów i mierzą czas; żaden nie dotyka zmian tego pakietu.

## Próby zdolności wykrycia (G16)

Procedura: commit najpierw, próba na czystym drzewie, wycofanie **jednej** linii, przebieg,
`git checkout -- <plik>`, kontrola czystości. Wszystkie dziesięć oblało na spodziewanej asercji.

| # | Wycofana linia | Test | Jak oblał |
|---|---|---|---|
| A | porównanie `runId`/właściciela w `answerPermission` | `tests/consent.test.ts` | „odpowiedz z requestId innego uruchomienia nie rozstrzyga niczego” |
| B | `disallowedTools` w `sdkOptions` | `tests/consent.test.ts` | `expected undefined to deeply equal [ 'WebFetch', 'WebSearch' ]` |
| C | `markAwaitingConsent` | `tests/consent.test.ts` | `expected 'running' to be 'awaiting_consent'` |
| D | kompensacja `removeManagedFile` po awarii publikacji | `tests/publication.test.ts` | `osierocone bajty po nieudanej publikacji` |
| E | `workspace.dispose()` | `tests/publication.test.ts` | `workspace nie zostal sprzatniety` |
| F | słowo „wykresy” w `FILE_ANALYSIS.limits` | `tests/file-analysis.test.ts` | deklaracja rozjechana z zachowaniem parsera |
| F2 | przemianowanie zamienione na zapis wprost | `tests/publication.test.ts` | 2 testy — **na pozostawionym pliku tymczasowym**, nie na uciętym pliku (zob. niżej) |
| G | `markAwaitingConsent` | `e2e/consent-runs.spec.ts` | `/api/runs/active` po przeładowaniu nie zgłasza oczekiwania |
| J | `linkAttachments` | `e2e/sandbox-files.spec.ts` | `csv.attachedTo` puste |
| K | związanie procesu potomnego z sygnałem przerwania | `e2e/stop-children.spec.ts` | po 60 s proces nadal żyje (`expect.poll(...).toBe(0)`) |
| L | `abort.abort(new Error('run_timeout'))` | `e2e/run-continuity.spec.ts` | karta nigdy nie doszła do `data-phase="failed"` |

### Ograniczenie próby F2, powiedziane wprost

Asercja o atomowym zapisie wykrywa brak przemianowania **przez pozostawiony plik tymczasowy**, a nie
przez zobaczenie pliku uciętego w połowie. Własność „pod nazwą docelową nigdy nie ma pliku
niekompletnego” jest strukturalna: nazwa docelowa powstaje wyłącznie przez `rename`, który w obrębie
jednego systemu plików jest atomowy. Obserwacja stanu pośredniego wymagałaby czytelnika działającego
równolegle z zapisem, czego test deterministyczny nie zorganizuje.

### Znalezisko z próby K

Zepsute wiązanie procesu z sygnałem przerwania zostawiło po próbie osierocony proces
(`node -e setInterval(...)`, rodzic `1`). Został usunięty po dokładnej linii poleceń, a stand-in
utwardzono: proces kończy się teraz sam po pięciu minutach, więc zepsuta wersja wiązania nie zostawia
niczego na stałe.

## Naturalne próby (oblane przebiegi przed naprawą, na tym samym kodzie)

- **L11.18** — `e2e/run-continuity.spec.ts` oblał na markerze odpowiedzi, zanim powstało odświeżenie
  wiadomości po zakończeniu przebiegu, do którego klient tylko dołączył.
- **L11.24** — `e2e/sandbox-files.spec.ts` oblał na `artifact-preview`, zanim `files_publish_version`
  trafiło do `ARTIFACT_PRODUCING_TOOLS`.
- **L11.22** — ten sam spec oblał na „typ komorki pusta nie zostal odczytany”, zanim skrypt zaczął
  czytać pustą komórkę jawnie (iteracja po wierszach nie obejmuje końca wiersza).

## Pomiar Stop liczony w procesach

`pomiary-stop-procesy.json`: potomkowie procesu serwera **przed 0, w trakcie 1, po 0**, oraz trzy
rozdzielone momenty (potwierdzenie `POST /cancel`, stan końcowy w karcie, zniknięcie procesu i
katalogu roboczego). Milisekundy zależą od maszyny; powtarzalne jest to, co asertuje regresja:
kolejność momentów, ich rozdzielenie i liczby procesów.

**Czego ten pomiar nie pokazuje:** proces potomny jest prawdziwym procesem systemowym związanym z
sygnałem przerwania uruchomienia, ale stoi w miejscu procesu Claude Agent SDK na granicy adaptera.
Bez grantu tur modelu nie wykazano, że Stop kończy proces potomny samego SDK (L11.7 pozostaje otwarte).

---

## Runda poprawek 1 (po recenzji)

### C1 — próba utraty sieci przechodziła z niewłaściwego powodu

Recenzent zmierzył własną sondą, że `BrowserContext.setOffline(true)` **nie zrywa nawiązanego
strumienia**: po przejściu w offline strumień dostawał dalsze fragmenty i zdarzenie końcowe na tym
samym połączeniu. Próba oparta na samym `setOffline` nie mogła więc oblać z powodu, który deklarowała.

Co zrobiono:

- **prawdziwe zerwanie**: przeglądarka rozmawia z instancją przez `e2e/support/cuttable-proxy.ts`,
  który na żądanie niszczy wszystkie połączenia i odrzuca nowe. `setOffline` zostaje obok wyłącznie po
  to, co robi uczciwie — zgłasza awarię stronie i wyzwala zdarzenia `offline`/`online`;
- próba asertuje teraz stan pośredni: po zerwaniu **strona nie sięga serwera** (`fetch` z wnętrza
  strony zwraca błąd) i **wynik nie pojawia się na ekranie**, a uruchomienie kończy się w backendzie
  (pytanym spoza przeglądarki) bez żadnego obserwatora;
- **naprawa produktu**: klient, który stracił strumień kończącego się przebiegu, nie miał żadnej
  automatycznej drogi do odpowiedzi — `GET /api/runs/active` zwraca wyłącznie statusy aktywne, więc po
  powrocie lista była pusta i `attachToRun` nie było wołane nigdy. `syncActiveRuns` dołącza teraz także
  do przebiegów, które ten klient śledził, a których backend już nie wymienia; odtworzenie od kursora
  przynosi zdarzenie końcowe, a za nim ponowny odczyt rozmowy. Bez przeładowania i bez zmiany rozmowy.

| # | Wycofana linia | Test | Jak oblał |
|---|---|---|---|
| O | dołączanie do przebiegów nieobecnych na liście aktywnych (`syncActiveRuns`) | `e2e/run-continuity.spec.ts` „utrata sieci zrywa strumien…” | po 60 s marker odpowiedzi nigdy nie pojawił się w wątku (linia 239) |

### I2 — atomowość zapisu mierzona wykonaną awarią

`node:fs` jest mockowany przepuszczającym hakiem na `renameSync` (`vi.spyOn` nie działa na przestrzeni
nazw ESM), co pozwala **wykonać** obie klauzule zamiast je opisywać.

| # | Wycofana linia / wstrzyknięta awaria | Test | Jak oblał |
|---|---|---|---|
| M | przemianowanie zastąpione zapisem wprost pod nazwę docelową | `tests/publication.test.ts` | **4 testy**, w tym „bajty trafiaja pod nazwe docelowa przez zmiane nazwy” |
| N | brak sprzątnięcia pliku tymczasowego po awarii zmiany nazwy | `tests/publication.test.ts` | „po awarii zmiany nazwy cos zostalo w magazynie: expected [ Array(1) ] to deeply equal []” |

Próba F2 z pierwszej rundy (która wykrywała tylko śmieci) jest zastąpiona przez M i N.

### I3 — luźna asercja w specu modelowym

`e2e/files-agent.spec.ts` wymaga w B1 **liczby**; komórka formuły z zapisanym `result` nie zalicza.
Biblioteka w workspace niczego nie liczy, więc niepusta wartość obok formuły mogłaby pochodzić tylko od
modelu — czyli od zachowania, które L11.23 wyklucza. Zmiana nie kosztuje tury.

### Drobne

- usunięcie pliku: wiersz i bajty znikają w **jednej transakcji** (wcześniej błąd po usunięciu wiersza
  rozjeżdżał magazyn z dyskiem);
- bajty czytane **raz**, nad bramką idempotencji — odcisk i publikacja z tego samego odczytu (postać
  uzgodniona do scalenia z pakietem orkiestracji);
- suma kontrolna porównywana z bajtami wgranymi przez użytkownika zamiast z samą sobą;
- pobranie **kliknięciem**, ze zdarzeniem pobrania, nazwą pliku i otwarciem zapisanego pliku;
- próba artefaktu produkuje własny artefakt (uruchamia się osobno) i publikuje pod własną nazwą, żeby
  przeglądarka artefaktów nie miała dwóch wpisów o tym samym tytule;
- deklaracja ograniczeń skoroszytu nazywa wyłącznie wykres, który ma próbę.

### Przebiegi rundy 1

| Polecenie | Kod | Wynik |
|---|---|---|
| `pnpm verify` | 0 | 45 plików / **723 testy**, drzewo po przebiegu czyste |
| `… playwright test e2e/run-continuity.spec.ts` | 0 | 4 testy (z prawdziwym zerwaniem połączenia) |
| `… playwright test e2e/sandbox-files.spec.ts` | 0 | 5 testów |
| `… playwright test e2e/sandbox-files.spec.ts -g "wynik jest artefaktem"` | 0 | 1 test — dowód, że nie zależy od sąsiadów |

### Domknięcie rundy 1 (commit `bd3198e`)

| Polecenie | Kod | Wynik |
|---|---|---|
| `… playwright test` (moje cztery spece) | 0 | **15 testów** |
| `… playwright test` (cały domyślny przebieg) | 0 | **174 testy**, zero oblanych — test nawigacji, który oblał przy trzech równoległych zestawach, przechodzi |
| `pnpm verify` | 0 | 45 plików / **723 testy**; `git status --porcelain` po przebiegu: pusto |

---

## Runda poprawek 2 (odtwarzanie a polecenia sterujące)

Recenzent zauważył, że dla przebiegu ze ścieżki wysyłki `lastSeq` zostawał zerem, więc odtworzenie
przepuszczało **wszystkie** zdarzenia własne, w tym polecenia sterujące interfejsem.

Trzy odpowiedzi, każda z próbą:

1. **Ochrona przez `commandId` już istnieje i obejmuje tę ścieżkę.** `UiCommandRunner` odmawia
   polecenia, które ta karta już wykonała (zbiór w pamięci + kopia w `sessionStorage` na wypadek
   przeładowania). Moja ścieżka jest łatwiejsza od tej, dla której ochronę pisano — karta nie jest
   przeładowywana.
2. **Kursor**: `platformAdapter` liczy zastosowane zdarzenia i zapisuje `lastSeq`. Numeru nie da się
   odczytać z drutu (gotowy parser oddaje zdarzenia, nie linię `id:`), ale backend numeruje od 1 co 1 i
   wysyła w kolejności od początku, więc licznik **jest** numerem ostatniego.
3. **Odtworzenie zakończonego przebiegu nie niesie poleceń sterujących.** Takie polecenie to pytanie,
   na które nikt już nie czeka — agent dostał `no_client`. Filtr działa wyłącznie w ścieżce z
   dziennika; przebieg trwający dostaje polecenia ze strumienia na żywo.

| # | Wycofana linia | Test | Jak oblał |
|---|---|---|---|
| P | zapis kursora w `platformAdapter` | `e2e/run-continuity.spec.ts` „po powrocie… nawigacja agenta nie powtarza sie” | `klient poprosil o odtworzenie od poczatku` (`from > 0`) |
| Q | kursor **i** filtr jednocześnie | ten sam test | oblał **wyłącznie** na asercji o kursorze, która stoi za asercjami o ekranie — czyli ekran utrzymało samo `commandId` |
| R | filtr poleceń sterujących w odtworzeniu | `tests/run-replay.test.ts` | „odtworzenie zakonczonego uruchomienia niesie polecenie sterujace interfejsem” |

Kolejność asercji w teście przeglądarkowym zmieniona celowo: **skutek widoczny przed mechanizmem**,
żeby próba psująca mechanizm mogła pokazać, czy ekran się utrzymał. Asercja, która nigdy się nie
wykona, niczego nie dowodzi.

### Zawężone opisy (bez zmian w kodzie)

- cięcie zrywa odcinek **przeglądarka–pośrednik**; gniazdo pośrednika do aplikacji zostaje otwarte.
  Połówkę po stronie serwera pokrywa próba zamknięcia karty;
- `reachable === false` jest strażnikiem ustawienia, nie dowodem (spełnia go samo przejście w offline);
  ciężar niosą: koniec przebiegu przy odciętej stronie i **brak znacznika na ekranie** w tym czasie;
- odzyskiwanie odpalają tylko `online`, montowanie i zmiana rozmowy, a nieudane `attachToRun` nie jest
  ponawiane — zapisane przy kodzie jako świadoma decyzja (ponowienie wymagałoby harmonogramu i licznika
  czasu, który potrafi odpalić po zmianie tożsamości).

### Przebiegi rundy 2

| Polecenie | Kod | Wynik |
|---|---|---|
| `… playwright test` (run-continuity + bl10-agent-navigation + ui-navigation + interactions) | 0 | **20 testów** |
| `… playwright test` (cały domyślny przebieg) | 0 | **175 testów**, zero oblanych |
| `pnpm verify` | 0 | 45 plików / **725 testów**; drzewo po przebiegu czyste |

---

## Synchronizacja z gałęzią integracyjną (G19)

Scalone 33 commity (orkiestracja, czat, cache). **Szesnaście plików w konflikcie**, rozstrzygnięte jako
suma. Szczegóły w raporcie zadania, §11; tutaj sam wynik bramki.

| Polecenie | Kod | Wynik |
|---|---|---|
| `pnpm verify` (pierwszy przebieg po scaleniu) | 1 | 7 oblanych z 799 — **wszystkie moje**: 5 przez wymagany od teraz `operationId` (`artifact_create`, `artifact_publish_file`), 1 przez lint scenariuszy, który to złapał, 1 przez status oczekiwania w cudzym teście |
| `pnpm verify` (po naprawach u źródła) | 0 | 45 plików / **799 testów**; drzewo po przebiegu czyste |
| `pnpm exec playwright test` (cały domyślny przebieg, pod blokadą) | 0 | **185 testów**, zero oblanych |

Kontrole spójności po scaleniu: `assessment.json` — 200 kryteriów, **95 bloków historycznych**,
L11.7 / L11.12 / L11.23 nadal otwarte, moje dziewięć nadal potwierdzone; `docs/ACCEPTANCE.md` i
`docs/BACKLOG.md` **odtworzone generatorem**, nie rozstrzygane ręcznie; migracje: obie strony obecne
(`platform-0005-idempotency-reservation` z gałęzi integracyjnej zachowuje numer, moja przesunięta na
`platform-0006-message-attachments`), sprawdzone testem migracji i próbą na kopii sprzed każdej z nich.
