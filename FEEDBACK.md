# FEEDBACK — dziennik prac nad szablonem

Dziennik zmian w repozytorium `agentic-app-template`. Zaczyna się od konsolidacji z 2026-09-16.
Wcześniejsza historia kodu (wpisy #1–#39, próby z 2026-09-14…16) dotyczy aplikacji źródłowej
AgenticApp i jest w [`docs/archive/agenticapp-2026-09/FEEDBACK.md`](docs/archive/agenticapp-2026-09/FEEDBACK.md).
Tamte próby **nie** były wykonywane w tym repozytorium.

---

## T1 — 2026-09-16 — Konsolidacja AgenticApp w szablon

**Zakres fazy** (zgodnie z planem konsolidacji): dokumentacja, złożenie szablonu z istniejącego kodu,
regresja i odtwarzalność istniejącej wersji, repozytorium i publikacja. Ocena zgodności z 200
kryteriami służy do utworzenia backlogu — brakujące funkcje nie są w tej fazie implementowane.

### Stan źródła

- Konsolidacja zaczęła się po zakończeniu pracy wykonawcy nad panelem rozmowy w AgenticApp
  (ostatnia tura 2026-09-16 08:19 UTC: `pnpm verify` = 0, 257 testów Vitest, 63/63 Playwright).
- Manifest źródła o 08:28:13 UTC: 253 pliki (bez `node_modules`, `dist`, `data`, `backups`, katalogów
  testowych), sha256 manifestu `c06a8f63fa409cd158259ca86e8f1de6b05817e509dde422b6662d75142b0d72`.
- Pierwszy commit tego repozytorium (`7340863`) to wierny import 183 plików kodu z tego stanu, bez
  zmian treści — pozwala porównać każdą późniejszą zmianę z oryginałem.
- Kopia wszystkich dokumentów i źródeł sprzed zmian leży lokalnie poza repozytorium
  (`agentic-app-template-consolidation-backup`).

### Dokumentacja

- Specyfikacja 200 kryteriów trafiła do `docs/ARCHITECTURE.md` jako wierna kopia. Porównanie
  maszynowe z wersją 95: te same identyfikatory dla dawnych kryteriów, zmienione brzmienie L2.3 i L5.3,
  brak wymagań unikalnych dla starej wersji. Jedyna zmiana treści: usunięta pusta linia rozcinająca
  tabelę prób między T21 i T22.
- Stary plan szablonu (Next.js, CopilotKit, BYOK/LiteLLM) jest **sprzeczny** z obowiązującą
  specyfikacją — zarchiwizowany z adnotacją, nie scalany.
- Raporty i dziennik AgenticApp zarchiwizowane z adnotacją, że ich wyniki dotyczą innego katalogu i
  wersji 95 kryteriów. Dowody historyczne (`docs/evidence`) nie są publikowane: zawierają lokalne
  ścieżki, identyfikatory sesji i ślady sieciowe przeglądarki.
- Rozliczenie każdego dokumentu: `docs/DOCUMENTATION-MAP.md`. W AgenticApp wykonano część A planu:
  `docs/ARCHITECTURE.md`, archiwum wersji 95, odsyłacz w miejscu starej specyfikacji, poprawione
  odnośniki README, `docs/DOCUMENTATION-MAP.md`; skrypty `audit-matrix.mjs` i `closure-matrix.mjs`
  czytają archiwum, `pnpm check:closure` i `pnpm check:matrix` nadal przechodzą.

### Zmiany kodu i narzędzi względem AgenticApp

| Zmiana | Dlaczego |
|---|---|
| `scripts/check-boundaries.mjs` nie wymienia już modułu przykładowego ani jego słownika; pakiety platformy i moduły wykrywa po katalogach, słownik domeny czyta z `agenticApp.domainVocabulary` w manifestach modułów | poprzednia wersja czytała na sztywno `packages/module-procurement/package.json` — po wymianie domeny kontrola padałaby, a słownik nowej domeny wymagałby edycji skryptu. Ten sam słownik 12 pojęć przeniesiony do manifestu przykładu |
| `scripts/check-module-swap.mjs` (`pnpm check:module-swap`) | dowód wymiany domeny na kopii repozytorium, patrz niżej |
| `scripts/matrix-summary.mjs`, `closure-matrix.mjs`, `audit-matrix.mjs` czytają archiwum | kontrole historycznych macierzy nie zostały wyłączone, tylko wskazują przeniesione dokumenty |
| nazwa pakietu głównego `agentic-app-template`; `.gitignore` uzupełniony o lokalne ustawienia narzędzi i logi | tożsamość repozytorium |

Kod `apps/`, `packages/`, `tests/`, `e2e/` nie został zmieniony, z wyjątkiem pola
`agenticApp.domainVocabulary` w `packages/module-procurement/package.json`.

### Kontrole negatywne uogólnionej kontroli granicy

Na kopii w katalogu tymczasowym: import `@module/…` w pliku platformy → kod 1; słowo „dostawca”
w `platform-ui` → kod 1 z wskazaniem linii; brak `domainVocabulary` we wszystkich modułach → kod 1;
usunięcie `module-procurement` i słownik w module kontrolnym → kod 0 bez edycji skryptu.

### Próba wymiany domeny — trzy nieudane przebiegi, zanim zadziałała

1. **Oblana przez błąd skryptu.** Wyrażenie wycinające trasy ekranów przykładu z `router.tsx` było
   leniwe, ale mogło przeskoczyć przez granice definicji, więc usunęło też trasy platformy
   (`spacesRoute`, `filesRoute`, `settingsRoute`). Wykrył to typecheck w kopii. Poprawka: blok trasy
   dopasowywany bez przechodzenia przez średnik i asercja, że usunięto dokładnie cztery trasy
   przykładu, a trasy platformy zostały.
2. **Oblana przez rzeczywistą wadę wymienialności.** Po poprawnym usunięciu tras typecheck oblał w
   `packages/module-procurement/src/ui/pages.tsx`: ekrany przykładu używają typowanych linków TanStack
   Router (`to="/cases/$caseId"`), których typy pochodzą z globalnej rejestracji routera aplikacji.
   Moduł niezłożony do aplikacji nie przechodzi więc typecheck, jeśli zostaje w repozytorium.
   Pakiety platformy były przy tym nietknięte. Rozwiązanie w tej fazie: procedura odłączenia przykładu
   usuwa jego połówkę UI (połówka serwerowa zostaje jako fixture testów) — opisane w
   `docs/NEW-APPLICATION.md` §2; trwałe rozwiązanie w backlogu.
3. **Oblana przez błąd skryptu.** Import `@playwright/test` po ścieżce rozwiązanego pliku CJS dawał w
   ESM tylko `default`, bez `chromium`. Poprawka: `createRequire(...)('@playwright/test')`.
4. **Przeszła** (drzewo robocze przed commitem): pakiety platformy identyczne, kontrola granicy,
   typecheck i build w kopii, serwer z rejestrem `["probe"]`, narzędzia `probe_*`, trasa
   `/api/m/probe/notes`, kompozycja walidowana komponentem `probe.noteList`, brak tabel `pc_*`,
   powłoka w Chromium bez ekranów przykładu i bez błędów strony. Wynik na zatwierdzonym stanie:
   `docs/evidence/template-consolidation/`.

### Zauważone przy sprawdzaniu dokumentacji

- `scripts/migration-rehearsal.mjs` nie uwzględnia migracji `platform-0003-file-versions` na liście
  oczekiwanych zmian (tabela `files`), a porównuje odcisk wszystkich kolumn — dla kopii sprzed 0003
  z plikami zgłosi fałszywą zmianę. Analiza kodu; bez próby. Opisane w `docs/odzyskiwanie-stanu.md`,
  pozycja w backlogu.
- `apps/web/vite.config.ts` ma proxy na stały port 8791; `pnpm dev` przy zajętym 8791 trafia do obcej
  instancji. Na tej maszynie 8791 zajmuje działająca instancja AgenticApp, więc `pnpm dev` nie był
  uruchamiany w czasie konsolidacji.
- Komentarz w `packages/platform-ui/src/catalog/registry.tsx` powołuje się na
  `tests/catalog-parity.test.ts`, którego nie ma w repozytorium.

### Regresja w czystej kopii — pierwszy przebieg oblał

Czysta kopia commita `bf83bb6` (`git clone` poza repozytorium, `pnpm install --frozen-lockfile`):
`pnpm verify` = 1 (2 z 257 testów w `tests/durability.test.ts` wymagają zbudowanych pakietów, a
`verify` uruchamiał testy przed buildem), `pnpm test:e2e` = 1 (brak `apps/server/dist/server.js`).
To wada odtwarzalności obecna już w AgenticApp, ukryta przez `dist/` pozostający po wcześniejszych
buildach — tamtejsza „czysta instalacja” uruchamiała `pnpm build` przed `pnpm verify`. Poprawka
`7d6bd78`: build przed testami, dokumentacja wymagania buildu dla e2e. Żadnej kontroli nie wyłączono.

Czysta kopia `7d6bd78`: install 0, `verify` 0 (257/257), `test:e2e` 0 (63/63, 5,0 min, trzy tury
na prawdziwym modelu), `check:module-swap` 0, start produkcyjny z danymi startowymi, restart, `seed`,
`seed --force`, `APP_SKIP_BASE_DATA`. `docker build --no-cache --pull` 0; aplikacja w kontenerze
sprawdzona od wewnątrz. **Dostęp z hosta przez opublikowany port nie zadziałał** — ani dla obrazu
szablonu, ani dla kontrolnego minimalnego kontenera `node:22-alpine`, przy działającym wcześniej
uruchomionym kontenerze użytkownika. Uznane za ograniczenie tego demona rootless Docker; nie
ingerowano w konfigurację Dockera użytkownika.

Suita e2e zapisuje pomiary do `docs/evidence/closure-2026-09-15/` (nazwa po dawnych pracach) i tym
samym brudzi drzewo robocze. Pomiary z przebiegu skopiowano do dowodów; zmiana katalogu jest w backlogu.

### Ocena 200 kryteriów — historyczne „95/95” nie przeniosło się

Oceny przygotowano analizą kodu i testów szablonu wobec treści kryteriów (cztery równoległe
przeglądy warstw, tylko do odczytu), z historyczną oceną wykonawcy jako punktem wyjścia; potem
skorygowano je o wynik regresji. Zasada: „potwierdzone” wymaga dowodu wykonanego lub
przeanalizowanego na kodzie szablonu.

Wynik: 58 potwierdzonych, 117 częściowych, 17 niespełnionych, 8 niesprawdzonych, 0 z 12 warstw
zamkniętych. Z dawnych 95 kryteriów potwierdzonych w szablonie jest 35. Powody spadku, poza
wymogiem dowodu z szablonu: asercje testów nie pokrywają pełnej treści części kryteriów (np. próba
„praca w rozmowie B” restartuje serwer, więc zadanie A już nie trwa; test nawigacji wywołuje
`requestUi` z pominięciem modelu; test „widoczny fokus” sprawdza tylko fokus) oraz wady wykryte
analizą kodu. Najważniejsze sprawdziłem bezpośrednio:

- `get_context` zwraca kontekst ze startu wykonania (L6.3, L6.9 — niespełnione);
- `IdempotencyStore.once` nie porównuje treści żądania i nie rezerwuje klucza (L9.14);
- `saveComparisonArtifact` przyjmuje `operationId`, ale go nie używa (L9.7);
- `answerPermission` rozstrzyga zgodę po samym `requestId` (L11.13);
- `pnpm acceptance` i `scripts/run-agent.mjs` domyślnie kierują zmieniające dane scenariusze na
  `127.0.0.1:8791` — port, na którym zwykle działa instancja użytkownika (L1.8);
- `denyRead` sandboxu obejmuje tylko katalog danych aplikacji, a narzędzia plikowe są
  auto-zatwierdzane — dostęp kodu agenta do katalogu konfiguracji Claude wymaga próby (L11.4, L11.11).

Pełne oceny: `docs/ACCEPTANCE.md`; pakiety prac: `docs/BACKLOG.md`.

### Poprawki dokumentacji po ocenie

- README podawało porty e2e 8795–8799 (przeniesione z AgenticApp); suita używa 8793–8799.
- README skracało opis odczytu poświadczeń do „czyta wyłącznie dwa pola” — w rzeczywistości plik jest
  parsowany w całości, a kopiowane są dwa pola. Przywrócono dokładny opis.
- Dodano ostrzeżenie o `pnpm acceptance`/`run-agent.mjs` (README, `AGENTS.md`) i krok instalacji
  Chromium dla Playwright.

### Macierz jako kontrola w `pnpm verify`

`scripts/acceptance-matrix.mjs` generuje `docs/ACCEPTANCE.md` i `docs/BACKLOG.md` z
`docs/ARCHITECTURE.md` i `docs/acceptance/assessment.json`; `pnpm check:acceptance` (w `verify`)
oblewa przy braku oceny, dowodzie historycznym oznaczonym jako potwierdzenie, otwartym kryterium bez
pakietu, próbie spoza warstwy, ręcznej zmianie sum, zmianie brzmienia wymagań bez regeneracji i
duplikacie identyfikatora — `docs/evidence/template-consolidation/kontrole-negatywne-macierzy.txt`.

### Co zostało otwarte

Wszystko, co wymienia `docs/BACKLOG.md` (142 kryteria w 12 pakietach), oraz: mapowanie portu
kontenera z hosta (niesprawdzone w tym środowisku), `pnpm dev` (nieuruchamiany — proxy na 8791),
instalacja przeglądarek Playwright na nowej maszynie, licencja kodu (decyzja właściciela).

---

## T2 — 2026-09-17 — Aktualizacja o poprawki AgenticApp i publikacja publiczna

**Zakres:** przenieść wszystkie poprawki wykonane w AgenticApp po bazowej wersji szablonu, zachować
celowe zmiany szablonu, zweryfikować w czystej kopii, zaktualizować macierz i opublikować repozytorium
jako publiczne. Bez nowej rozbudowy. Pełny raport: `docs/CONSOLIDATION-UPDATE-2026-09-17.md`.

### Co przeniesiono

Manifest AgenticApp porównany z manifestem zapisanym po konsolidacji z 2026-09-16: 21 zmienionych i
4 nowe pliki kodu (zawężanie widoku `ui_filter` w adresie, `alwaysLoad`, reguła promptu „odpowiedź o
danych przenosi na ich widok”, wyszukiwanie `*` z `totals`, testy). Żaden z nich nie był zmieniany w
szablonie, więc kopiowanie nie nadpisało poprawek konsolidacji — sprawdzone przed kopiowaniem względem
commitu importu. Po przeniesieniu kod szablonu jest identyczny z AgenticApp poza 12 celowymi różnicami
(narzędzia i dokumentacja szablonu). Raport przekazania od wykonawcy odczytu potwierdził ten sam
zakres (25 plików, zero pominiętych poprawek) i wskazał ryzyka R1–R8 — każde rozliczone w raporcie.

### Regresja

Czysta kopia `d142b85`: install 0, `verify` 0 (278/278), `test:e2e` 0 (72/72, 7,0 min, cztery tury
na prawdziwym modelu, w tym nowy test „pytanie o dane przenosi na ich widok”), `check:module-swap` 0
(zmiana walidatora adresu w routerze nie zepsuła próby wymiany), start produkcyjny z danymi.

### Sonda `ui_filter` na prawdziwym modelu — pierwszy przebieg nie wystartował

Suita przeglądarkowa sprawdza zawężanie tylko serwerem skryptowanym, więc zmieniony przepływ
sprawdziłem jednorazową sondą na izolowanej instancji z konfiguracji repozytorium. Pierwsze
uruchomienie padło przy wczytaniu configu sondy (plik poza pakietem z `"type": "module"`, Playwright
wczytał go jako CJS) — błąd narzędzia próby, nie aplikacji. Drugie przeszło: „Pokaż tylko dostawców z
Polski.” → `/data?country=PL`, 3 z 4, pasek; „Pokaż z powrotem wszystkich dostawców.” → 4 wiersze.

**Obserwacja warta zapisania:** potwierdzenia klienta pokazują, że model najpierw użył
`country=Polska`, potem `country=Poland` (po 0 z 4, widoczne chwilowo na ekranie), a dopiero potem
`PL` — mimo że moduł deklaruje wartości `PL, FI, DE, CZ`. Mechanizm potwierdzenia z liczbami
zadziałał jako korekta; kosztem były dwie zbędne akcje na ekranie użytkownika. Zapisane w BL-01.

### Macierz

Przejrzane kryteria wskazane w przekazaniu (L2.13, L2.17, L6.13) i powiązane (L2.15, L6.1, L6.11,
L6.15, L6.17, T23, T26). Wynik: L6.13 potwierdzone (handler `ui_catalog` w teście, nawigacja przez
prawdziwy model); L2.17 i L6.17 z niespełnionych na częściowe; T26 częściowe. **BL-01 i L2.17 nie są
zamknięte:** zawężenie nie trafia do kontekstu agenta (`AppContext.filters` puste), nie ma sortowania,
paginacji ani trwałych preferencji. Sumy: 59 / 118 / 15 / 8.

### Publikacja

Adres e-mail autora w metadanych commitów występuje w 540 publicznych commitach tego konta na GitHubie,
więc zmiana widoczności nie ujawnia go po raz pierwszy — historii nie przepisywano. Wynik skanu i
potwierdzenie widoczności: raport aktualizacji §6.

---

## T2 — 2026-09-18 — Zamknięcie pakietów BL-01 i BL-02

**Zakres zlecenia:** rozbudowa, nie konsolidacja. Semantyczne UI sterowane rozmową (BL-01: L2.16,
L2.17, L6.15, L6.16, L6.17) i własne widoki agenta (BL-02: L3.14–L3.18), z próbami odbiorowymi
T25, T26 i T27 na prawdziwym modelu. Praca prowadzona przez koordynatora: dziewięć zadań
implementacyjnych plus fala poprawek, każde w osobnym worktree, każde z niezależnym przeglądem przed
scaleniem. Plan i decyzje architektoniczne: `docs/plans/2026-09-17-bl01-bl02.md`. Pełne rozliczenie:
`docs/RAPORT-ARCHITEKTA-BL01-BL02.md`.

### Co powstało

Jeden mechanizm widoków dla ekranów domyślnych i widoków agenta: ekrany modułu są kompozycjami
OpenUI Lang nad wspólnym katalogiem, dane płyną wyłącznie z zarejestrowanych odczytów opisanych przez
moduł (pola, typy, jednostki, akcje). Stan widoku — zawężenie, sortowanie, strona — żyje w adresie,
widać go w kontrolkach i trafia do kontekstu kolejnego polecenia. Przeglądarka publikuje wersjonowany,
semantyczny opis ekranu, a agent czyta go narzędziem `ui_state` i wykrywa nieaktualność. Przestrzeń
„Widoki agenta” jest powiązana z rozmową, a każda kompozycja jest walidowana na serwerze parserem
OpenUI Lang. Wskazanie wartości pola rekordu (`ui_show_value`) odsłania rekord mimo filtra i strony,
a akcje rekordu uruchamiają te same narzędzia modułu co MCP.

### Co ujawnił prawdziwy model (a czego testy skryptowane nie mogły pokazać)

1. **Kod sprawy użyty jako identyfikator.** Agent dwa razy złożył widok z `caseId: "PC-2026-01"` bez
   wcześniejszego odczytu. Platforma zachowała się poprawnie (odczyt odrzucony, karta pokazała odmowę,
   zero zmyślonych wartości), ale prompt widoków agenta nie mówił tego, co mówi sekcja wskazywania
   wartości. Po poprawce agent najpierw wyszukuje sprawę i używa prawdziwego identyfikatora.
2. **Obietnica wykresu, który się nie rysuje.** Model napisał „Dodano wykres słupkowy”, choć komponent
   odmówił rysowania serii mieszającej PLN i EUR. Narzędzia zwracają teraz `rendered: false` i zdanie,
   że kompozycja została zapisana, a nie narysowana, a reguła czytania stanu ekranu objęła
   `agent_view_*`. Po poprawce agent odczytał `ui_state` i powiedział użytkownikowi, dlaczego wykresu
   nie ma.
3. **Wartości pól zawężania.** Model nadal sięgał po „Polska” i „Poland”, mimo że katalog podaje kody.
   Teraz dozwolone wartości są wypisane przy celu w prompcie, z regułą używania ich dosłownie.

### Błędy znalezione przy okazji, nie w zleconym zakresie

- `RunEventStream.read` gubił wybudzenie: zdarzenie wysłane, gdy czytelnik obsługiwał poprzednie,
  czekało na następne. Komenda UI z prawdziwego handlera wracała po 8 s jako `no_client`. Znaleziona
  niezależnie przez dwa zadania, naprawiona jedną linią z testem regresji.
- Pomiar karty na canvasie przestawiał nieprzesunięte karty na (0,0) i podbijał wersję geometrii bez
  udziału użytkownika.
- Podczas strumieniowania odpowiedzi czat wysyłał odczyty dla niedokończonych nazw operacji
  (`procurement.`, `procurement.supp`).
- Sortowanie tabeli po kwocie ustawiało PLN i EUR na jednej skali, podczas gdy wykres w tej samej
  sytuacji odmawiał. Reguła jest teraz jedna i wspólna.
- Po zmianie konta opis ekranu mógł nieść dane poprzedniego użytkownika (instancje komponentów,
  rozmowa, przestrzeń, parametry `c`/`s` w adresie, identyfikator przestrzeni kart). Wyciek odtworzono
  na niepoprawionym kodzie i zamknięto filtrem epoki dostępu.

### Własne pomyłki procesu

- Dwóch implementatorów straciło niezacommitowaną pracę, bo próba wykrywalności przywracała plik przez
  `git checkout`. Obaj odtworzyli zmiany i powtórzyli próby na commitach; procedura („najpierw commit,
  próba na czystym drzewie, kontrola czystości po przywróceniu”) trafiła do wspólnych zasad.
- Koordynator podał w jednej notatce zły przykład wywołania z `null`; implementator to wychwycił.
- W próbach modelowych jedna tura poszła na własny błąd wykonawcy (nie podniesiony limit), a strażnik
  budżetu zapisywał turę przed odmową, przez co powstał pusty wpis. Kolejność odwrócono, wpis usunięto
  i opisano w rejestrze.
- Test odbiorowy T27 był przez pewien czas czerwony, bo kodował złe oczekiwanie (że wykres nad dwiema
  walutami się narysuje). Poprawiono oczekiwanie do faktycznego, uczciwego zachowania — bez osłabiania
  asercji.

### Pułapka, którą naprawiono w ostatniej chwili

Próby modelowe należały do domyślnego przebiegu `pnpm test:e2e`, a licznik tur mieszkał w katalogu
dowodów. Następny pełny przebieg wydałby turę, oblał na kolejnej i **nadpisał zapisane dowody T25, T26
i T27 werdyktem „niezaliczona”**. Teraz próby modelowe są poza domyślnym przebiegiem (osobne
polecenie), licznik leży poza repozytorium, dowody przebiegów zapisują się pod stemplem, a spec
odbiorowy pomija się, gdy budżet nie pokrywa całości. Sprawdzone: domyślny przebieg w czystej kopii
zostawił dowody bajt w bajt nietknięte.

### Weryfikacja koordynatora (czysta kopia, commit 97a7945)

`pnpm install --frozen-lockfile` 0; `pnpm verify` 0 (32 pliki / 542 testy, z nową kontrolą typów
katalogu `e2e/`); `pnpm test:e2e` 0 (114 testów, próby modelowe pominięte, zero tur);
`pnpm check:module-swap` 0; start produkcyjny na porcie testowym z własnym katalogiem danych
(`/api/health` z etykietą testową, `/api/status` odmawia bez sesji, strona 200). Instancja użytkownika
na porcie 8791 przez cały czas nietknięta — ten sam proces, identyczna suma kontrolna `dist`.

### Macierz

Zaktualizowane oceny dla kryteriów, dla których powstał dowód na tym kodzie. BL-01 i BL-02 zamknięte i
usunięte z backlogu (zostaje 10 pakietów). Sumy: **77 / 107 / 9 / 7** (było 59 / 118 / 15 / 8).
Żadna warstwa nie jest jeszcze zamknięta. Znane ograniczenia i pozycje odłożone: raport architekta §6.
