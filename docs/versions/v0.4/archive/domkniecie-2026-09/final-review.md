# Final review sesji domknięcia — `domkniecie/integracja` 763dd31..5cfc97c

Data: 2026-09-20. Recenzent końcowy (nie autor żadnego z pakietów). Metoda: kod-review skill
(superpowers 6.3.0) — read-only, samodzielna weryfikacja twierdzeń briefu na diffie, statycznym
czytaniu i lekkich bramkach (`node scripts/*.mjs --check`, `pnpm run check:*`); pełne e2e i buildy
pozostawione przebiegom w tle. Zakres: 21 commitów, 3 pakiety (ETAP 1 bramki macierzowe, ETAP 2
izolacja, ETAP 3 jawny storage Mastry), dokumentacja, dowody.

---

## 1. Werdykt

**WYMAGA POPRAWEK — dokładnie 1 pozycja** (I-1: teardown e2e kasuje `.e2e-model-turns/`,
jedyny rejestr budżetu tur modelu). Poprawka jest tania (wykluczenie ścieżki albo warunek
kształtu danych instancji + 1 test) i nie kwestionuje architektury żadnego pakietu. Po jej
wniesieniu gałąź jest **gotowa do prezentacji właścicielowi**. Wszystkie pozostałe
ustalenia to odroczone minory z zapisem w raporcie końcowym.

---

## 2. Weryfikacja twierdzeń briefu

### 2.1 Bramki macierzowe — POTWIERDZONE (uruchomione własnoręcznie)

- `pnpm run check:acceptance` → 0: 200 kryteriów (187/11/2), 12 warstw, 27 prób, 5/12 warstw
  zamkniętych. `pnpm run check:matrix` → 0: „Podsumowanie zgodne z kanonem" — oba czytają
  jeden kanon przez `scripts/lib/matrix-core.mjs` (`EXPECTED = {layers:12, criteria:200, trials:27}`,
  funkcje czyste, zero ręcznych sum).
- `pnpm run check:closure` → 0; strzeże archiwum 95 twardą stałą `EXPECTED_ARCHIVE = {layers:12,
  criteria:95}`; problemy idą na STDERR (`ARCHIWUM 95: …`) + `process.exitCode = 1` — istotne,
  bo `check:closure` w `verify` pipes stdout do `/dev/null`, więc po cichu przejść się nie da.
- `oceny-95.json` = transkrypcja werbatim z FEEDBACK.md (kontrola `check:closure` przechodzi
  na parze spec-archiwum ↔ oceny; jakakolwiek zmiana słowa wywala bramkę).
- `audit-matrix.mjs` usunięty; grep po repo i dokumentacji: only odwołania historyczne
  (RAPORT-STARTU, ledger) + aktualne wzmianki dokładne (`docs/DOCUMENTATION-MAP.md:105`
  „usunięty: martwy duplikat"); wpis z klasyfikacji skryptów w
  `tests/acceptance-target.test.ts` również usunięty, `lib/matrix-core.mjs` i
  `lib/server-guard.mjs` dodane z poprawnymi powodami sieciowymi.
- Testy negatywne `tests/matrix-gates.test.ts`: 5 testów na fixture'ach (usunięte kryterium,
  zmiana statusu + rozjazd raportu pochodnego, duplikat ID, niezgodność EXPECTED, zmyślony
  raport) każde z asercją konkretnego komunikatu; 3 smoke'y na prawdziwych bramkach bez
  mutacji repo. Drzewo czyste po wszystkich uruchomieniach.

### 2.2 Izolacja — POTWIERDZONA, ruling uszanowany

- Kotwica `tests/isolation.test.ts:215-223` nietknięta (plik ostatnio ruszany w `1793b26`,
  przed sesją); `packages/platform-server/src/config.ts` bez zmian w diffie — naprawa wyłącznie
  w warstwie skryptowej, dokładnie po rulingu.
- Nowa straż `scripts/lib/server-guard.mjs`: wykrywanie `session.secret` w 3 kierunkach
  (powyżej — bez wyjątków; w katalogu; w głąb do 3), wyjątek wyłącznie dla pary
  (etykieta `agenticapp-test` + basename `.e2e`) albo własnego znacznika związanego ze
  ścieżką; katalog `data/` repo odmawiany zawsze, nawet ze znacznikiem; sonda TCP portu
  przed startem; po starcie weryfikacja /proc, że właściciel nasłuchu == pid z pidfile'u
  uruchamiający `apps/server/dist/server.js`, brak właściciela w /proc = odmowa (nie cisza).
- Spinka przetestowana treścią plików (`tests/server-guard.test.ts`): straż PRZED `setsid`
  we wszystkich trzech skryptach, potwierdzenie pid PRZED komunikatem „started",
  `dev-server.sh` nie czeka na zdrowie pod stałym 8791; ponadto próba zdolności wykrycia
  (skrypt bez spinki jest wychwycony) i kontrole przeciwne przy każdej regule.
- Odcisk poświadczeń: stat-only `size:mtime` (nigdy treść — G21), przenośnik
  `test-results/acceptance-credential-fingerprint.json` (`APP_PRZENOSNIK_ODCISKU`), całe biegi
  `scripts/run-agent.mjs` i `scripts/acceptance-agent.mjs` w try/catch/finally; naruszenie =
  kod 5 z pierwszeństwem; fix I-1 (nieprzechwycony wyjątek nie omija porównania) przetestowany
  na prawdziwych krachach (zepsuty strumień SSE, 500 w setupie) z kontrolami przeciwnymi (kod 1).
  `tests/acceptance-target.test.ts` rozrasta się o bramkę środowiska odbiorczego: RUN_ID
  wymagany i porównywany z `/api/health.instanceRunId` (null = odrzucenie), APP_DATA_DIR musi
  wyglądać testowo (`.e2e` lub system tmp), odmowy PRZED pierwszym zapisem (`seen` bez POST).
- TOCTOU: wcześniej rozstrzygnięty i zaakceptowany; nic nowego na tej osi nie znalazłem.
  Nowe ścieżki zapisu tej sesji: znacznik straży, przenośnik odcisku, `.e2e-model-turns/`
  (istniał, ale AGENTS/README teraz jawnie dokumentują), rejestr w `e2e/credential-guard.ts`.
  Wszystkie gitignorowane, poza jednym problemem — zob. I-1.

### 2.3 Mastra — POTWIERDZONE

- Dokładnie 3 instancje `new Mastra(`: produkcyjna w `AgentRuntime` + 2 w
  `tests/observability.test.ts` — wszystkie z jawnym `storage: new InMemoryStore()` z
  publicznego eksportu `@mastra/core/storage`. Zero `getStore`/`agent.storage`/ukrytych
  założeń o trwałości Mastry gdziekolwiek w `packages/`; trwałość to własne SQLite (`app.db`).
- Straż regresji `tests/runtime.test.ts`: spy na `console.warn` + flush kolejki mikrozadań
  (`setImmediate`) i asercja, że dokładne pierwsze zdanie starego fallback-warninga nie
  wróci. `docs/observability.md` ma nową sekcję „Storage Mastry — świadome ograniczenie":
  dokumentacja mówi to samo, co kod.

### 2.4 Dokumentacja — POTWIERDZONA z jedną sprzecznością

- README (akceptacja z `APP_INSTANCE_RUN_ID` + `mktemp -d /tmp/.e2e-odbiorcza-XXXXXX`),
  AGENTS.md (opis `verify`, rejestr tur), DOCUMENTATION-MAP §7 (role bramek: kanon 200 vs
  archiwum 95), `docs/archive/README.md` — opisują stan rzeczywisty; wszystkie twierdzenia
  o bramkach potwierdziłem uruchomieniem.
- **Jedna sprzeczność dokumentacja↔kod**: AGENTS.md:140,150 i README.md:315 lokują rejestr
  tur w `.e2e-model-turns/` w korzeniu kopii roboczej — a nowy teardown e2e kasuje z korzenia
  repo wszystkie katalogi `.e2e*` bez listy wykluczeń. Zob. I-1.

---

## 3. Mocne strony

1. **Jedna arytmetyka zamiast dwóch.** Kanon 200 w `matrix-core.mjs` z twardymi stałymi,
   czyste funkcje, testy regresyjne na fixture'ach; archiwum 95 odseparowane i powiązane
   wyłącznie kontrolą krzyżową pól `historical` (dokładnie 95, ID w obie strony, statusy
   świadomie niemapowane). Koniec klasy błędu „dwa skrypty, dwie prawdy".
2. **Fail-closed konsekwentnie, nie hasłowo.** `null` z /proc = odmowa (kiedyś ciche przejście),
   brak przenośnika = throw, brak odcisku = głośny błąd, kopiowany znacznik = odrzucenie
   (lekcja state-tools wcięta w test). Komunikaty odmów mówią CO wykryto, nigdy treści sekretów.
3. **Kultura testów powyżej średniej.** Praktycznie każda reguła ma kontrolę przeciwną
   („straż, która odmawia zawsze, też by przeszła"), próby zdolności wykrycia (atrapa skryptu
   bez spinki), testy na prawdziwych skryptach z prawdziwymi krachami, a nie tylko na
   wyeksportowanych funkcjach.
4. **Uczciwa dokumentacja ograniczeń.** Sekcja o in-memory Mastra mówi wprost „świadome
   ograniczenie" zamiast ukrywać ostrzeżenie; DOCUMENTATION-MAP opisuje rolę każdej bramki.

---

## 4. Findings

### Critical — 0

### Important — 1

**I-1. `usunKatalogiInstancjiTestowych` skasuje `.e2e-model-turns/` — jedyny rejestr budżetu tur modelu.**
`e2e/global-teardown.ts:39-69` (wyzwolenie: `playwright.config.ts:38`, wywołanie po
`checkCredentialFingerprint` w `:73→:77`). Reguła `:53` — `if (!wpis.name.startsWith('.e2e')) continue;`
— po czym `directoryInUse(katalog) === false` → `rmSync(recursive, force)`. **Brak jakiejkolwiek
listy wykluczeń.** Tymczasem `.e2e-model-turns/` w korzeniu kopii roboczej to dokładnie taki
katalog, a AGENTS.md:140,150 i README.md:315 dokumentują go jako lokalizację rejestru
`z11-bl03.json` (budżet 21/25, sufit 25 — globalne ograniczenie zlecenia). Po scaleniu tej
gałęzi pierwszy `pnpm test:e2e` w kopii trzymającej rejestr go skasuje; `readZ11Ledger`
„bez pliku startuje od zera" (`e2e/support/model-turns.ts`, sekcja Z11) → sprawdzenie sufitu
przechodzi na pustym rejestrze → realne przekroczenie budżetu subskrypcji i utrata ewidencji
grantu, bez żadnego głośnego sygnału. Kolejność fingerprint-przed-sprzątaniem jest poprawna
i tego nie ratuje — naruszenie dotyczy danych programu, nie poświadczeń.

Dlaczego Important, nie Critical: dziś **latentne** — jedyny fizyczny rejestr leży w worktree
`z11-bl03` (HEAD `43dfce2`), który ma jeszcze stary teardown (`grep usunKatalogiInstancjiTestowych`
→ 0), a w `integracja` tego katalogu nie ma; materializuje się po scaleniu. Klasa szkody
(bezpowrotne usunięcie jedynego egzemplarza rejestru + ciche obejście sufitu) jest jednak
dokładnie tą, przed którą cała sesja miała chronić.

**Fix (tani, jednopunktowy):** w `usunKatalogiInstancjiTestowych` wyklucz `.e2e-model-turns`
(najprościej) albo — mocniej — kasuj tylko katalogi o kształcie danych instancji (obecność
`app.db` lub `session.secret`), co jednocześnie załatwia odroczony minor M-5. Dołożyc test
w `tests/global-teardown.test.ts` (dziś brak pokrycia `.e2e-model-turns` — potwierdzone).

### Minor — 2 (nowe)

**M-N1. Nagłówek `server-guard.mjs` nieprecyzyjny co do zakresu wyjątku `.e2e`.**
`scripts/lib/server-guard.mjs:95` — „inside the repository, so only that pair may waive the
secret check". Tymczasem `config.ts:82-134` sprawdza wyłącznie basename (as-written i realpath)
— przynależności do repo nie sprawdza nikt. Komentarz opisuje gwarancję, której nie ma
(zob. też odroczony M-2). Fix: jedno zdanie w komentarzu („prefiks basename, niezależnie od
lokalizacji") albo domknięcie M-2, które komentarz uprawdopodobni.

**M-N2. README/AGENTS nie ostrzegają, że `pnpm test:e2e` czyści `.e2e*` z korzenia repo.**
Czyszczenie ~30 nagromadzonych katalogów jest zamierzone i uzasadnione, ale jedyny opis
konwencji `.e2e*` (AGENTS.md:60, README:336) nie mówi, że uruchomienie e2e usuwa takie
katalogi. Fix: jedno zdanie w README przy opisie `test:e2e`; naturalnie robi się przy naprawie I-1.

### Obserwacje bez kwalifikacji (do raportu, nie do poprawek)

- `scripts/matrix-summary.mjs:106` drukuje statyczne „identyfikatory zgodne…" nawet gdy
  `crossCheckArchive` znalazł problemy — to odroczony minor ETAP-1(1); bramka i tak kończy
  exit 1 z STDERR, więc nic nie przechodzi po cichu.
- Twardy „z 12" w renderze `closure-matrix.mjs` — odroczony ETAP-1(3), kosmetyka nad strażą
  na twardych stałych.
- Teardown usunie też `.e2e-bl07`, `.e2e-scripted-*` z korzenia `integracja` przy pierwszym
  przebiegu — to śmieci po instancjach testowych, zamierzone zachowanie.

---

## 5. Triage 14 odroczonych minorów

**MUST-FIX przed publikacją: 1.**

| # | Pozycja (ledger) | Triage | Uzasadnienie / zapis do raportu |
|---|---|---|---|
| ETAP2 M-5 | teardown kaszy ręcznie nazwany `.e2e-*` katalog użytkownika | **MUST-FIX** | Eskalowany do I-1: realny scenariusz istnieje — `.e2e-model-turns/` jest dokumentowanym rejestrem budżetu. Naprawa wraz z I-1. |
| ETAP2 M-2 | prefiks `.e2e` akceptowany gdziekolwiek w fs (`$HOME/.e2e-*`) | odroczony | Para (etykieta + prefiks) to świadoma deklaracja operatora; kierunek „sekret powyżej" nie ma wyjątku, więc `.e2e-*` na cudzych danych nie przepuszcza gdy cel leży w środku. Tanie utwardzenie na później: zawęzić do repo/tmp — ta sama reguła co w bramce acceptance (`problemSrodowiskaOdbiorczego`). Zapis w raporcie. |
| ETAP2 M-1 | testy statują prawdziwy plik poświadczeń | odroczony | Stat-only size:mtime, treść nigdy nie czytana — zgodne z G21; potwierdzone testami. |
| ETAP2 M-3 | diag/probe liczą odcisk bez porównania | odroczony | Sondy read-only; ryzyko teoretyczne, zapis w raporcie. |
| ETAP2 M-4 | głębokość 3 w `sekretWKataloguLubPonizej` | odroczony | Udokumentowana granica (ta sama co state-tools), przetestowana na krawędzi (3 poziomy = null, nie awaria). |
| ETAP2 +1 | brak throw przy niezapisywalnym przenośniku | odroczony | Fail-closed i tak następuje na końcu (brak przenośnika = throw); skutkuje tylko późniejszym błędem. |
| ETAP2 +2 | równoległe biegi nadpisują przenośnik | odroczony | Założenie jednego pisarza; `APP_PRZENOSNIK_ODCISKU` pozwala rozdzielić; zapis w raporcie. |
| ETAP1 (1) | statyczny wydruk „identyfikatory zgodne" przy problemach | odroczony | Kosmetyka stdout; problemy i tak idą na STDERR + exit 1. |
| ETAP1 (2) | podwójny wydruk ROZJAZD | odroczony | Kosmetyka. |
| ETAP1 (3) | twardy „z 12" w renderze closure | odroczony | Kosmetyka; arytmetyka strażnika na stałych. |
| ETAP1 (4) | zdublowane stałe LABEL/OPEN zamiast importu z rdzenia | odroczony | Ryzyko dryfu małe; smoke-testy obu bramek wyłapią rozjazd. |
| ETAP1 (5) | adnotacja README archiwum | odroczony | Docs nice-to-have. |
| ETAP3 (1) | asercja pierwszego zdania ostrzeżenia (runtime.test.ts) | odroczony | Sztuczna kruchość jest tu intencjonalna: przypina dokładne zdanie fallback-warninga, by każda zmiana treści wymusiła przegląd; zapis w raporcie. |
| ETAP3 (2) | potwierdzić InMemoryStore w mock.d.ts przy aktualizacji rdzenia | odroczony | Nota śledząca na następny bump `@mastra/core`. |

---

## 6. Rekomendacje (poza MUST-FIX)

1. Przy naprawie I-1 dodać test teardownu na `.e2e-model-turns` (dziś `tests/global-teardown.test.ts`
   pokrywa reguły, ale nie ten katalog — luka potwierdzona).
2. W kolejnym pakiecie (nie blokuje publikacji): zawęzić wyjątek `.e2e` w `server-guard.mjs`
   do repo/tmp i tym samym uprawdopodobnić komentarz z M-N1 (domknięcie M-2 + M-N1 jednym cięciem).
3. Nota w README przy `test:e2e` o destrukcyjnym porządku `.e2e*` (M-N2).
4. Przed jakąkolwiek turą modelu po scaleniu: skopiować `.e2e-model-turns/` z `z11-bl03` do
   miejsca pracy (procedura już zakłada „kopię roboczą") — niezależnie od naprawy I-1.

---

## 7. Czy to realna jakość, czy teatr proceduralny

Realna jakość — i to widać najlepiej po tym, czego tu **nie ma**. Nie ma łatki na objawie: zamiast
ponownego zliczenia 95 vs 200 w dwóch skryptach powstał jeden kanon z twardymi stałymi i kontrolą
krzyżową, a rozjazd stał się błędem kompilacji-à-propos (`--check` + exit 1), czyli klasa błędu
„dwa źródła prawdy" została usunięta, nie obsłużona. Nie ma straży, która odmawia zawsze: prawie
każda reguła ma kontrolę przeciwną pisaną wprost pod to ryzyko (atrapa skryptu bez spinki, katalog
bez strażnej zawartości, sonda bez `--port`), co jest rzadkim poziomem samokrytycyzmu. Nie ma
również teatru w dokumentacji — ograniczenie Mastry opisano jako świadome zamiast zgaszać
ostrzeżenie, a to szerszy wzorzec całej gałęzi (statusy „dowód ≠ status" dotrzyma się w treści
komunikatów). Kosztem jest jedna realna dziura nowego typu (I-1): mechanizm sprzątający, pisany
słusznie defensywnie (tylko katalogi, tylko nieżywe, fingerprint najpierw), dostał regułę
prefiksową bez listy wyjątków — czyli dokładnie ten sam błąd „prefiks znaczy bezpiecznie", który
pakiet ETAP 2 zwalczał w pozostałych warstwach. To nie unieważnia jakości pracy; pokazuje, że
stały wzorzec („nazwa ≠ tożsamość danych") trzeba jeszcze dokończyć w ostatnim miejscu, gdzie
żyje. Po naprawie I-1 teza „ta sesja podniosła realne zabezpieczenia szablonu" jest obronna
przeciwko każdemu z trzech pakietów z osobna.

---

## 8. Assessment

Trzy pakiety dostarczyły to, co obiecały, i weryfikuje się to bez wzięcia czegokolwiek na wiarę:
bramki uruchomiłem (3× exit 0, drzewo czyste), kotwice przeczytałem (`tests/isolation.test.ts:215-223`,
`config.ts` bez zmian), grepy po `audit-matrix` i storage Mastry czyste, dokumentacja zgadza się
z kodem — z wyjątkiem jednej sprzeczności, która jest istotą jedynego MUST-FIX. Findings:
**0 Critical / 1 Important (I-1, teardown vs `.e2e-model-turns/`) / 2 Minor nowe (M-N1, M-N2)**;
triage 14 odroczonych minorów: **1 MUST-FIX (M-5 via I-1), 13 odroczonych z zapisem**.
Verdykt: **WYMAGA POPRAWEK** — wyłącznie I-1; poprawka jest punktowa (wykluczenie rejestru lub
warunek kształtu danych instancji w `e2e/global-teardown.ts:39-69` + test), nie dotyka
architektury żadnego pakietu i po jej wniesieniu gałąź rekomenduję jako **gotową do prezentacji
właścicielowi**.

---

## 9. Re-review fix round 2 — commit `6bdb42f` (2026-09-20)

Zakres: diff `5cfc97c..6bdb42f` w worktree `etap2-izolacja` + `git show 6bdb42f` + celowany
`npx vitest run tests/global-teardown.test.ts` (9/9 zielone, 175 ms).

### Werdykt I-1: ADDRESSED

Commit dotyka dokładnie 4 plików (README, `e2e/global-teardown.ts`, `scripts/lib/server-guard.mjs`,
`tests/global-teardown.test.ts`; +128/−16). Nowa reguła teardownu: kształt zamiast prefiksu —
`nosiCechyDanychInstancji` (`e2e/global-teardown.ts:57`: `existsSync(app.db) ||
existsSync(session.secret)` bezpośrednio w katalogu), sprawdzana przed sondą żywotności
(`:78`); katalog bez cech zostaje z powodem „nie nosi cech danych instancji". Ochrona jest
realna i klasowa: `.e2e-model-turns/` przechowuje wyłącznie JSON-y rejestrów (nigdy `app.db`
ani `session.secret`), a reguła białej listy po kształcie chroni z definicji także przyszłe
dane nieinstancyjne — lista wyjątków nie jest potrzebna. Instancje, które kiedykolwiek
wystartowały, zawsze zostawiają `app.db` (SQLite przy boocie) i/lub `session.secret` (init
auth), więc kasowanie instancji nie zostało zepsute. Testy potwierdzają obie strony: rejestr
tur przeżywa z powodem i nietkniętą treścią (`z11-bl03.json` z „21"), kontrola przeciwna kasuje
te same dane z `app.db`, PROBA ZDOLNOSCI WYKRYCIA dokumentuje, że reguła czysto prefiksowa
rejestr by skasowała, a kolejność fingerprint-przed-porządkami zostaje zachowana.

### Trade-off zgłoszony przez implementatora: AKCEPTOWALNY

Katalog instancji przerwany przed pierwszym zapisem `app.db` ZOSTAJE — strona bezpieczna
(sztuka zamiast skasowanej nie-instancji), zdarza się rzadko (krach bootu przed pierwszym
zapisem), a koszt to gitignorowany katalog `.e2e-*` do ręcznego usunięcia.

### Nowe findings: 0 Critical / 1 Important / 1 Minor

**I-2 (Important) — topologia dostarczenia: fix nie jest potomkiem `5cfc97c`; „diff tylko ten
commit" w pakiecie recenzyjnym nie jest prawdą.** `merge-base(5cfc97c, 6bdb42f) = 8c04b0d`:
gałąź fixa odgałęzia się przed scaleniem ETAP 3 i brakuje jej 5 commitów integracji
(`git log 6bdb42f..5cfc97c | wc -l` = 5; `InMemoryStore` w jej `runtime.ts` = 0). Dlatego
plik `review-5cfc97c..6bdb42f.diff` (9 plików) to fix + **odwrócone hunksy ETAP 3**
(FEEDBACK T10 −59, `docs/observability.md` −33, `runtime.ts` −13, `tests/observability.test.ts`
−12, `tests/runtime.test.ts` −42) — artefakt range-diffa między rozbieżnymi gałęziami,
NIE destrukcja dokonana przez commit (`git show --stat` = 4 pliki). Konsekwencje:
(a) ktoś czytający pakiet doszedłby do wniosku, że commit cofnął ETAP 3 — nie cofnął;
(b) twierdzenie implementatora „verify = 0, 71/1134" powstało na drzewie BEZ ETAP 3
(1131 po T10 − 1 strażnik + 4 nowe testy teardownu = 1134 — zgadza się co do jednego), więc
nie waliduje stanu złożonego. Wymóg lądowania: cherry-pick `6bdb42f` na `domkniecie/integracja`
albo zwykły merge gałęzi (git zachowa stronę ETAP 3), **nigdy** reset/checkout gałęzi fixa na
integrację; po wlądowaniu powtórzyć verify na gałęzi złożonej.

**M-R2N1 (Minor, odroczony) — nowy komentarz `server-guard.mjs:95-98` wciąż w połowie nieścisły.**
Poprawnie mówi, że `config.ts` sprawdza wyłącznie basename, ale twierdzenie „containment in the
repository is added by the harness" nie ma pokrycia w kodzie: żadna warstwa nie wymusza
przynależności do repo (straż akceptuje basename `.e2e` gdziekolwiek z etykietą — to odroczony
M-2; `audit-server.sh`/`closure-server.sh` trzymają dane w `/tmp`, dev w `$ROOT/data` —
konwencja, nie wymuszenie). Do przepisania przy okazji domknięcia M-2.

### Adnotacja M-N2 (README): zgodna z faktami

README (sekcja `pnpm test:e2e`) mówi teraz, że teardown usuwa katalogi instancji `.e2e-*`
rozpoznawane po `app.db`/`session.secret`, a dane nieinstancyjne jak `.e2e-model-turns/`
zostają — dokładnie to, co robi kod.

### Nota

Pierwszy test teardownu utracil asercję `zostawione).toEqual([])` (zmiana treści testu,
nie osłabienie reguły — puste `zostawione` pokrywa kontrola przeciwna i PROBA). Bez kwalifikacji.

### Werdykt częściowy

I-1 domknięte po treści; gałąź pozostaje **WYMAGA POPRAWEK** wyłącznie proceduralnie (I-2):
prawidłowe przeniesienie `6bdb42f` na `domkniecie/integracja` (cherry-pick/merge, nie reset)
+ verify na drzewie złożonym (z ETAP 3). Po tym — gotowa do prezentacji.
