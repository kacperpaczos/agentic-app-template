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

---

## T3 — 2026-09-18 — BL-11c: cache i artefakty (L10.6, L10.7, L10.9, L10.11, L10.14, L10.15)

Pakiet dotyczy jednego pytania: czy użytkownik może zobaczyć dane, które nie są jego albo nie są
aktualne. Przed pracą sześć kryteriów miało dowód wyłącznie z testów kluczy cache i z dwóch odczytów
HTTP tego samego endpointu — czyli z rzeczy, które nie rozstrzygają ani jednego z tych pytań.

### Co było zepsute (nie tylko nieudowodnione)

- **Podgląd artefaktu w wiadomości nie istniał, a pełny widok wywracał się.** Do `AgentInterface`
  przekazywano `{ type, render }` rzutowane na `never`, podczas gdy biblioteka oczekuje
  `{ type, toolName, parser, preview, actual }`. Nic nie było więc zaindeksowane po nazwie narzędzia
  (artefakt nigdy nie pojawiał się pod wywołaniem), a przeglądarka artefaktów wołała
  `renderer.parser`, którego nie było. Rzutowanie na `never` ukryło to przed kompilatorem.
- **Przeglądarka artefaktów gotowego czatu czytała poza cache** (`createChatStorage` przez `apiGet`
  bez klucza), więc lista, pełny widok i podgląd były trzema niezależnymi obrazami jednego artefaktu.
- **Strumień `POST /api/agui/run` nie był związany z kontekstem dostępu.** Po przełączeniu
  tożsamości zdarzenia poprzedniego właściciela nadal dochodziły do reduktora i unieważniały klucze,
  które nowa tożsamość dopiero miała przeczytać. To samo dotyczyło żądań wątków (`restStorage`) i
  uploadu plików.
- **Stan klienta poza TanStack Query nie był czyszczony**: rozmowa, zadania, zaznaczenie, zasób,
  przestrzeń, załączniki i szkice poprzedniego właściciela trafiały do kontekstu następnego polecenia.
  Lista wątków i wiadomości gotowego czatu też zostawały na ekranie.
- **Otwarty widok live nie odświeżał się po zmianie źródła z UI**: formularz modułu wołał
  `invalidateBusinessData`, które nie unieważnia klucza `artifact`.
- **Wynik live nie niósł stanu źródła.** `definitionVersion` mówi, które pytanie zadano, `resolvedAt`
  — kiedy; nic nie mówiło, *co zobaczył* odczyt. Dwa odczyty minutę od siebie były nierozróżnialne.
- Moduł zakupowy tworzył artefakty typu `procurement.comparison` i nie dostarczał dla nich renderera.

### Co zbudowano

- `accessFetch` w `api/client.ts` — wspólny sygnał i sprawdzenie epoki dla żądań, które nie mogą iść
  przez `api()`: wątki gotowego czatu (`restStorage({ fetch })`), upload pliku, strumień uruchomienia.
- Strażnik epoki w `platformAdapter` — zdarzenie, które prześliźnie się obok przerwania, nie jest
  ani stosowane, ani przekazywane do czatu.
- `resetForAccessChange()` w `appState` (z `scopedAppState()` jako jedyną definicją stanu zakresu) i
  `registerAccessContextReset()`, montowane w powłoce po publikatorze opisu ekranu; czyści też
  parametry sesji `c` i `s` z adresu. `AgentInterface` dostaje klucz epoki dostępu — jedyny klucz,
  jaki wolno mu nadać.
- `createChatStorage(qc)` czyta artefakty przez `qc.fetchQuery` na kluczach `qk.artifact` /
  `qk.artifacts` i oddaje rendererowi **referencję** `{ artifactId }`, nigdy danych.
- `ArtifactPane` — jedno renderowanie artefaktu dla podglądu i pełnego widoku, z wersją, wersją
  definicji i odciskiem stanu źródła w atrybutach.
- `LiveResolution.sourceFingerprint` — skrót rekordów zwróconych przez zarejestrowany odczyt (nie
  całej koperty: wynik modułu potrafi nieść własny znacznik czasu, więc skrót koperty zmieniałby się
  przy każdym odczycie i mówiłby „źródło się ruszyło” zawsze).
- Renderer artefaktu `procurement.comparison` w module, na wydzielonym `ComparisonView`.

### Czego świadomie nie zrobiono

`refetchOnWindowFocus` zostaje wyłączony. Odświeżanie otwartego widoku live jest związane ze zmianą
danych (unieważnienie klucza `artifact`), a nie z powrotem do okna — okno wraca też wtedy, gdy nic się
nie zmieniło, a artefakt live przy każdym otwarciu uruchamia zapytanie na serwerze.

### Zmiana w cudzym specu

`e2e/ui-state.spec.ts` („przelaczenie tozsamosci na Ustawieniach…”) miał **założenie**, że po zmianie
tożsamości tabela poprzedniego właściciela zostaje w czacie, a adres nadal niesie jego przestrzeń —
czyli dokładnie te braki, które ten pakiet zamyka (L10.7, L10.11). Zmienione zostały dwa założenia
(tabela ma zniknąć; adres nie ma nieść poprzedniej przestrzeni); wszystkie asercje o opisie ekranu
zostały bez zmian i nadal przechodzą, tylko spełniane są mocniej.

### Zaobserwowane, nienaprawione

- `e2e/streaming.spec.ts` i `e2e/view-filter.spec.ts` zapisują pliki dowodowe przy **każdym**
  domyślnym przebiegu (`docs/evidence/closure-2026-09-15/`, `docs/evidence/chat-ux-2026-09-16/`) —
  ta sama klasa problemu, którą G18 zamknął po stronie `pnpm verify`.
- Komponent nagłówka sprawy wysyła jeden odczyt `case_overview` z literałem `"undefined"` jako
  `caseId`, zanim parametr `$caseId` zostanie związany. Żądanie może się tylko nie powieść.
- Asercja `not.toContainText(<treść polecenia>)` na panelu czatu jest zawsze prawdziwa: gotowy czat
  nazywa wątek bez końcowej kropki. Warto przejrzeć pozostałe spece pod tym kątem.

---

## T4 — 2026-09-18 — BL-08a: czat i historia (L4.3, L4.5, L4.6, L4.7, L4.8, L4.9, L4.11, L4.13, L4.15)

Pakiet dotyczy powierzchni rozmowy i tego, co po niej zostaje: tytułów, przełączania rozmów,
powtórzonego żądania, skutku usunięcia, zadeklarowanego zakresu funkcji, tego, co widać w czacie,
oraz identyfikatorów, które nie mogą się zderzyć.

### Co było zepsute (nie tylko nieudowodnione)

- **`POST /api/agui/run` ignorował `runId` klienta.** Powtórzenie tego samego żądania — retry proxy,
  ponowione ciało — startowało **drugie** wykonanie: druga odpowiedź asystenta w wątku, skutki
  narzędzi wykonane dwa razy, a bez `threadId` także druga rozmowa. Deduplikowana była tylko
  wiadomość użytkownika (po id).
- **Usunięcie rozmowy nie miało określonego skutku dla trwającego zadania.** Wykonanie żyło dalej w
  pamięci, a jego wiersz `agent_runs` znikał kaskadowo; przy `foreign_keys = ON` każdy kolejny zapis
  zdarzenia i wiadomości był odrzucany, więc przebieg kończył się serią błędów klucza obcego i nie
  miał gdzie zapisać statusu końcowego.
- **`toolCallId` nie miał przestrzeni nazw wykonania.** Gotowy czat paruje wywołania z wynikami po
  tym identyfikatorze w **całej** historii rozmowy, a dostawca gwarantuje unikalność tylko w obrębie
  sesji (awaryjnie `tu_<Date.now()>`). Dwa wykonania w jednej rozmowie potrafiły podpiąć wynik
  drugiego pod wywołanie pierwszego.
- **Zmiana tytułu istniała wyłącznie w API.** `CHAT_CAPABILITIES.renameConversation` deklarowało
  funkcję jako dostępną, a menu wiersza gotowego `ThreadList` (@openuidev/react-ui 0.13.10) ma tylko
  `Delete` — ekran mówił o sobie nieprawdę (L4.8).

### Co zbudowano

- **Idempotencja polecenia** — `IdempotencyStore` w zakresie `agui.run`: pierwsze żądanie zapisuje
  `{runId, conversationId}` pod kluczem klienta, każde następne dostaje `X-Run-Replayed: 1` i
  **odtworzenie zdarzeń tego samego uruchomienia**, bez tworzenia rozmowy, dopisywania wiadomości i
  bez wejścia do modelu. Strumień odtworzenia i `GET /api/runs/:id/stream` korzystają z jednej
  funkcji, więc nie mogą się rozjechać.
- **Określony skutek usunięcia** — `ConversationService.delete` anuluje uruchomienia `queued` i
  `running` tej rozmowy przed skasowaniem wiersza i raportuje `cancelledRuns` obok
  `detachedArtifacts` i `removedViewSpaces`. `RunEventStream` i `AgentRuntime` znoszą zniknięcie
  wiersza: zdarzenie, którego nie ma gdzie zapisać, kończy dziennik komunikatem, zamiast wywracać
  przebieg; status końcowy nieistniejącego uruchomienia nie jest błędem.
- **Przestrzeń nazw identyfikatora narzędzia** — `${runId}~${tool_use_id}`, nadawana w jednym
  miejscu (most hooków SDK), więc żywy strumień i zapisana historia niosą ten sam identyfikator.
- **Kontrolka zmiany tytułu** — `chat/ConversationTitle.tsx`: renderowana wewnątrz `AgentInterface`
  (bo `useThreadList` istnieje tylko w jego kontekście), portalowana do własnego paska panelu (bo
  cokolwiek nierozpoznanego wewnątrz staje się kolumną obok wątku). Zapis idzie przez `updateThread`
  biblioteki, czyli przez `PATCH /api/threads/update/:id`.
- **Deklaracja czytelna maszynowo** — wiersze możliwości czatu w Ustawieniach niosą
  `data-available`, więc test sprawdza zgodność deklaracji z interfejsem bez asercji o brzmieniu.

### Ograniczenie biblioteki, przypięte testem

Proza wypowiedziana **przed** wywołaniem narzędzia nie trafia do bańki odpowiedzi gotowego czatu.
`InterleavedTurn` (0.13.10) uznaje za odpowiedź wyłącznie ostatni segment tury, a prozę wcześniejszych
segmentów wkłada jako krok tekstowy do osi „Behind the scenes”, która po zakończeniu tury jest
zwinięta — i wtedy nie ma jej w DOM. Tekst nie ginie (jest w historii i na ekranie po jednym
kliknięciu), ale nie jest widoczny bez tego kliknięcia. Zgłoszony jako defekt składania tury; po
sprawdzeniu to zachowanie gotowego komponentu, a nie nasza projekcja — `tests/chat-history.test.ts`
pokazuje, że historia ma oba człony tury w dobrej kolejności. Test
`e2e/chat-history.spec.ts` przypina jedno i drugie do tej wersji biblioteki.

### Zaobserwowane, nienaprawione

- `e2e/app-context.spec.ts` obchodzi nieistniejący już defekt: komentarz mówi, że po zmianie
  tożsamości panel rozmowy trzyma rozmowę poprzedniego właściciela i dlatego test zakłada nową
  rozmowę. Pakiet BL-11c dodał klucz epoki dostępu na `AgentInterface` i czyszczenie `c`/`s` z
  adresu, więc obejście jest już zbędne — zostawione, bo to cudzy spec i nadal przechodzi.
- `e2e/support/scripted-agent.ts` wywołuje hooki kroków `kind: 'tool'` **przed** otwarciem strumienia,
  więc taki krok zawsze poprzedza każdy token. Kolejność „tekst, potem narzędzie” da się odtworzyć
  tylko krokiem `kind: 'call'` (wykonywanym w strumieniu) — wykorzystane w scenariuszu tego pakietu.
  Dotyczy kryterium L5.13, spoza tego pakietu.

### Runda poprawek 1 (po recenzji)

- **`RunEventStream.emit` znosił każdą awarię zapisu zdarzenia jako ostrzeżenie.** Zawężone do
  `SQLITE_CONSTRAINT_FOREIGNKEY`, czyli do jedynego przypadku, który jest oczekiwany (wiersz
  uruchomienia zniknął razem z rozmową). Każda inna awaria zapisu w jedynym źródle prawdy jest
  `console.error` z przyczyną i mówi wprost, że dziennik jest od tego miejsca niepełny i taki zostanie
  odtworzony — ten sam wzorzec, co catch projekcji piętnaście linii niżej.
- **Klucz idempotencji rezerwowany na czas startu.** Zapis do `idempotency_keys` następuje po
  `await runtime.start(...)`, więc dwa *równoczesne* kopie jednego żądania mogły obie nie znaleźć
  klucza i obie wystartować. Rejestr `startingRuns` (w pamięci, ustawiany w tym samym takcie, w którym
  start jest wywoływany) zamyka to okno; powtórzenie czeka na pierwszy start i dostaje odtworzenie.
  Test: „dwa rownoczesne zadania z tym samym runId”.
- **Test usunięcia rozmowy dostał artefakt.** Usuwana rozmowa najpierw publikuje własny artefakt
  prawdziwym narzędziem, więc asercja o odłączeniu ma czego dotyczyć: artefakt zostaje na liście, jest
  otwieralny z treścią i nie wskazuje już rozmowy. Wcześniej liczba artefaktów nie mogła się zmienić.
- **Asercja paska stanu w teście przełączania rozmów** była owinięta w `if (count > 0)` i przechodziła
  przez nieobecność elementu. Teraz to brak *konkretnego* elementu: paska z identyfikatorem
  uruchomienia rozmowy A.
- **Nowy test objawu** dla zgłoszonego defektu „polecenie w kolejce po zmianie tożsamości”: przełącz
  właściciela, wyślij polecenie natychmiast, doczekaj `succeeded`. Dotąd dowodziliśmy, że przyczyny
  nie ma; ten test oblewa, gdy objaw wróci **dowolną** drogą. Próba P13 (wyłączone czyszczenie `c`/`s`
  z adresu) odtwarza go dokładnie — faza zostaje `queued`.
- Komentarz przy teście prozy sprzed narzędzia mówi teraz, że przypięcie jest **dwukierunkowe**:
  wersja biblioteki, która to naprawi, obleje te same linie, i wtedy należy asercję rozluźnić, a nie
  obchodzić.

### Naprawa po integracji (scalenie z pakietem orkiestracji)

Dwie kolizje, obie widoczne dopiero w drzewie, w którym istnieją oba pakiety.

- **`artifact_create` wymaga teraz `operationId`**, a scenariusz `chat-history` go nie podawał —
  wywołanie zostałoby odrzucone przed handlerem. Naprawiony **wywołujący**, nie schemat: klucz jest
  mintowany **per wywołanie** (`crypto.randomUUID()`), bo ta gałąź scenariusza gra więcej niż raz w
  jednym przebiegu i instancja bywa restartowana na tym samym katalogu danych — drugi przebieg jest
  nową operacją, nie ponowieniem. Stałe brzmienie klucza odtwarzałoby pierwszy artefakt i test
  oglądałby opowieść harnessu o idempotencji zamiast tego, o czym jest.
- **Tytuł rozmowy dłuższy niż limit wejścia jest teraz odrzucany, nie przycinany.** Trasy wątków mają
  `threadWriteSchema` (`title` max 200) i bare `ZodError` staje się `validation_failed`, więc PATCH z
  400 znakami odpowiada 400 z nazwanym polem. To **nie** jest regresja przycinania: tytuł w granicach
  schematu nadal skraca się do 120 znaków, co test dowodzi osobno (180 → 120). Asercja rozszerzona na
  oba fakty: skrócenie tego, co trasa przyjmuje, i odmowa tego, czego nie — z kontrolą, że odmowa
  niczego nie zmieniła w bazie.

Sprawdzone próbą przed zmianą asercji (`180 → 200/len 120`, `400 → 400 validation_failed`, tytuł w
bazie nietknięty), a nie dopasowane do tego, co akurat przechodzi.

---

## T5 — 2026-09-18 — BL-09: pliki, sandbox i praca w tle (L11.7, L11.10, L11.12, L11.13, L11.15, L11.16, L11.18, L11.19, L11.20, L11.22, L11.23, L11.24)

Pakiet o tym, co się dzieje, gdy coś idzie nie tak albo zostaje przerwane: odmowa zgody, odpowiedź
wysłana dwa razy, zamknięty panel, zerwana sieć, awaria w połowie publikacji, uszkodzony plik.
Ścieżka „wszystko się udało” była pokryta próbą z modelem; jej rodzeństwo nie było pokryte wcale.

### Co było zepsute (nie tylko nieudowodnione)

- **Odpowiedź na zgodę nie była związana z wykonaniem.** `answerPermission` rozstrzygał po samym
  `requestId` z mapy procesu, a punkt HTTP sprawdzał właściciela uruchomienia **z adresu**. Odpowiedź
  wysłana pod adres własnego uruchomienia, z `requestId` cudzego, rozstrzygała cudze. `requestId`
  pochodził z `Math.random`.
- **Stop nie docierał do wykonania czekającego na zgodę.** Sygnał przerwania trafia do strumienia
  modelu, a przebieg stojący w `canUseTool` nie jest *w* strumieniu — czekał na obietnicę, której nikt
  nie zamierzał rozstrzygnąć. Zatrzymanie skutkowało dopiero po wygaśnięciu prośby (do 120 s), z
  katalogiem roboczym wciąż na dysku.
- **Status `awaiting_consent` nie był zapisywany.** `listActive` wymieniał go w SQL, ale nikt go nie
  ustawiał, więc zadanie czekające na decyzję zgłaszało się klientowi jako `running`. Klient, który
  nie oglądał tej rozmowy — po przeładowaniu, w innej rozmowie, po powrocie — nie miał skąd
  dowiedzieć się, że coś na niego czeka.
- **Dokończony wynik zadania, do którego klient tylko dołączył, nie pojawiał się na ekranie.** Gotowy
  czat zatwierdza odpowiedź, którą sam odebrał; o przebiegu przejętym przez ponowne podłączenie nic
  nie wie. Odpowiedź leżała w bazie, a wątek na ekranie kończył się na poleceniu — aż do wyjścia z
  rozmowy i powrotu. Test, który po przeładowaniu ręcznie otwierał rozmowę, brał tę lukę za normę.
- **Publikacja wyniku nie była atomowa.** Bajty szły prosto pod nazwę docelową, wiersz `files`
  wstawiał się po zapisie, a artefakt powstawał osobnym wywołaniem: awaria między krokami zostawiała
  plik bez wiersza albo wiersz bez artefaktu, a awaria w trakcie zapisu — **ucięty plik pod nazwą
  docelową**, czyli wynik wyglądający na kompletny.
- **Wynik `files_publish_version` nie był artefaktem.** Był wierszem w `files` i niczym więcej, więc
  zakładka Artefakty rozmowy nie pokazywała nic, a jedyną drogą do wyniku był ekran Plików.
- **Narzędzia sieciowe SDK nie były zabronione, tylko „do decyzji”.** `WebFetch` i `WebSearch`
  działają w procesie SDK, poza sandboxem poleceń, więc pusta lista domen ich nie ogranicza — między
  odciętą siecią a modelem stało jedno kliknięcie „Zgoda”.
- **Powiązanie załącznika z poleceniem istniało tylko w locie.** `attachFileIds` przychodziły z
  żądaniem i nigdzie nie były zapisywane; po przeładowaniu nie dało się powiedzieć, z którym
  poleceniem plik poszedł.
- **Deklaracja o skoroszytach była w jednym punkcie nieprawdziwa.** `FILE_ANALYSIS` mówił, że obrazy
  nie są zachowywane przy zapisie — parser je zachowuje. Wykresy faktycznie znikają, ale z innego
  powodu, niż mówiła lista: zapisany skoroszyt powstaje z modelu parsera, więc znika każda część,
  której parser nie modeluje.

### Co zbudowano

- `agent/permissions.ts` — macierz uprawnień z trzecią kategorią (zabronione), zasilająca
  `disallowedTools` SDK **i** bramkę zgody; nierozpoznane narzędzie trafia do pytania, nie do zgody.
- Zgoda przypisana do wykonania: `runId` i właściciel zapisane przy prośbie i porównywane przy
  odpowiedzi, `requestId` z `crypto`. Powtórzona, skrzyżowana i spóźniona odpowiedź nie rozstrzygają
  niczego. Przerwanie uruchomienia odrzuca jego oczekujące prośby, więc Stop działa natychmiast.
- `awaiting_consent` jako zapisany status uruchomienia (anulowalny, sprzątany przy restarcie).
- `FileService.storeWith` — publikacja jako jeden krok: plik tymczasowy + przemianowanie, wiersz i
  artefakt w jednej transakcji, kompensacja przy awarii.
- `util/managed-fs.ts` — każda operacja kasująca w serwerze sprawdza ścieżkę **w chwili wykonania**,
  niezależnie od tego, skąd ścieżka pochodzi (workspace z bazy, `rel_path` z bazy, plik tymczasowy).
- `files_publish_version` tworzy artefakt rozmowy w tej samej transakcji; narzędzie dopisane do
  `ARTIFACT_PRODUCING_TOOLS`, więc podgląd pojawia się pod wywołaniem, a pełny widok w zakładce.
- Trwałe powiązanie załącznika z poleceniem (`message_attachments`, migracja `platform-0005`),
  widoczne na ekranie Plików i w wiadomości rozmowy.
- Odświeżenie wiadomości po zakończeniu przebiegu, do którego klient tylko dołączył.
- `APP_CONSENT_TIMEOUT_MS` i sekcja README „Co kończy wykonanie bez Stop”: jawne Stop, twardy limit
  czasu, restart backendu — i osobno wygaśnięcie prośby o zgodę, które jest **odmową**.

### Dowody

Nowe: `tests/consent.test.ts`, `tests/publication.test.ts`, trzy próby semantyki zapisu w
`tests/file-analysis.test.ts`, `e2e/consent-runs.spec.ts`, `e2e/run-continuity.spec.ts`,
`e2e/sandbox-files.spec.ts`, `e2e/stop-children.spec.ts` (Stop liczony w procesach potomnych serwera
z `/proc`, pomiar w `docs/evidence/z10-bl09/`, zapis na żądanie: `pnpm evidence:z10`).

Wszystko poza istniejącymi próbami z modelem to **symulacja na granicy adaptera**: scenariusz zamiast
modelu, prawdziwe wszystko inne — bramka zgody, narzędzia, workspace, publikacja, sprzątanie, procesy.

### Co zostało otwarte

- **L11.7** — proces liczony w próbie jest prawdziwym procesem systemowym, ale stand-inem procesu
  Claude Agent SDK; bez grantu tur nie wykazano, że Stop kończy proces potomny samego SDK.
- **L11.12** — kolejności mechanizmów SDK nie da się zaobserwować bez tury modelu; macierz jest
  zbudowana jako obrona w dwóch miejscach, a nie jako dowód kolejności.
- **L11.23** — nie sprawdzono na modelu, że odpowiedź agenta nie podaje zapisanej wartości formuły
  jako wyniku; w szablonie wykazano, że plik nie daje takiej możliwości (formuła bez wartości).

---

## T6 — 2026-09-18 — BL-08b: zdarzenia i strumień (L5.2, L5.3, L5.4, L5.5, L5.6, L5.11, L5.12, L5.13, L5.14, L5.15)

Ostatni pakiet fali. Dziesięć kryteriów warstwy L5, wszystkie zamknięte; wszystkie dowody bez tury
modelu (stand-in na granicy adaptera SDK, oznaczony jako symulacja).

### Zbudowane

- **Schematy i wersja zdarzeń `CUSTOM`** (`packages/platform-contracts/src/agui-payloads.ts`). AG-UI
  nie opisuje, co jest w środku `CUSTOM`, więc dotąd nie opisywało tego nic. Mapa schematów jest
  **totalna** względem `PLATFORM_CUSTOM_EVENTS` (nowe zdarzenie bez schematu to błąd kompilacji), a
  `RunEventStream.custom` stempluje wersję kształtu w jednym miejscu.
- **`platform.permission_resolved`**. Prośba o zgodę zostaje w dzienniku na zawsze; klient, który
  odtwarzał dziennik po przeładowaniu, pokazywał zamkniętą już prośbę jako otwartą — i jej przyciski
  nic nie robiły, bo bramka rozstrzyga raz. Rozstrzygnięcie emituje teraz **każde** wyjście z bramki:
  decyzja, wygaśnięcie i odmowa wydana przy zatrzymaniu uruchomienia.
- **Powrót do strumienia po lokalnym przerwaniu** (`chat/platformAdapter.ts`). Kontrolka kompozytora
  w trakcie tury jest przyciskiem stop: biblioteka przerywa wtedy `fetch`, a `useComposerStop` mówi
  backendowi „anuluj”. Odpowiedź na to (`platform.run_cancelled`, potem `RUN_ERROR`) szła na strumień,
  którego nikt już nie czytał, więc zakładka zostawała w fazie `running` — zmierzone ~30 s, w zasadzie
  bez końca. Strumień wysłania, który skończył się **przed** uruchomieniem, podłącza się teraz ponownie
  od kursora. Świadomie nie łatane odpowiedzią z `/cancel`: ta wraca, zanim uruchomienie się rozliczy,
  więc byłaby deklaracją klienta zamiast statusu backendu.
- **Krok `tool` z `inline: true`** w skryptowanym stand-inie. Dotąd wszystkie hooki narzędzi szły przed
  pierwszym fragmentem tekstu, więc kolejności tekst→narzędzie **nie dało się odtworzyć** w
  przeglądarce. Flaga, nie zmiana domyślnego zachowania: na dotychczasowym opierają się pomiary innych
  pakietów.

### Zmierzone i opisane, nie obejściem

W turze **z narzędziem** to samo zdanie jest w trakcie na ekranie dwa razy — w osi „Behind the scenes”
biblioteki i w pasku podglądu tej aplikacji (przez moment nawet trzy: sama biblioteka rysuje je
chwilowo podwójnie). Pasek istnieje dlatego, że w turze **bez** narzędzia biblioteka nie renderuje
prozy wcale.

Rozważona i **odrzucona** naprawa — ukrycie paska w turach, które wywołały narzędzie — ma trzy wady,
z których dwie wyszły dopiero z własnego dziennika prób i recenzji:

1. **nie naprawia.** W próbie T8 (pasek usunięty) sama oś biblioteki nadal pokazywała zdanie **dwa
   razy** przez część tury — zapis `running:0/2` w `docs/evidence/z9-bl08b/03-proby-wykrycia-przebieg.txt`.
   Zostaje resztkowa dubla, tyle że już bez podglądu strumienia;
2. **kosztuje tury subskrypcji.** `e2e/agent-ui.spec.ts` — dowód L5.1 i L5.9 na **prawdziwym modelu** —
   czyta ten sam pasek w turze z wywołaniem narzędzia, więc zmiana wymaga ponownego, płatnego pomiaru
   dwóch kryteriów, żeby odzyskać dowód, który dziś jest;
3. zabiera jedyny podgląd strumienia dla tur z narzędziem i psuje `e2e/measurements.spec.ts` (Z3).

Podmiana `Messages` jest wykluczona przez `AGENTS.md`. Zachowanie jest więc przypięte dwukierunkowo
testem i opisane w `docs/NEW-APPLICATION.md` §7; decyzja koordynatora: **nie naprawiamy**. Przy okazji
zmierzone: gotowy wątek stawia narysowane wywołanie **nad** poprzedzającą je prozą, więc kolejność wolno
dowodzić czasem pojawienia się i dziennikiem, nigdy pozycją w DOM.

### Dwie próby wykrycia złapały test, nie kod

- **T4** — asercja „proza przed narzędziem” przechodziła przy zepsutej kolejności: pasek tej aplikacji
  maluje fragment natychmiast, a oś biblioteki dopiero w następnej klatce, więc cały panel przez chwilę
  pokazuje „proza bez narzędzia” także wtedy, gdy wywołanie dotarło pierwsze. Pomiar przeniesiony do
  `.openui-agent-thread-messages`.
- **T9** — usunięcie związania zgody z uruchomieniem zostawiało test korelacji zielonym: przy dwóch
  różnych `requestId`, każdym odpowiedzianym pod własnym adresem, związanie nie było w ogóle
  wykonywane. Test odpowiada teraz najpierw pod cudzym adresem.

### Stale w opisie braków

Cztery zdania z kolumny „brak” opisywały stan sprzed wcześniejszych pakietów: wiązanie odpowiedzi na
zgodę z uruchomieniem, spóźniona odpowiedź, odmowa bez skutku i brak odpowiedzi jako odmowa były już
zrobione i pokryte (BL-09, `tests/consent.test.ts`, `e2e/consent-runs.spec.ts`); podobnie odmowa
powtórzonego polecenia interfejsu po przeładowaniu (`sessionStorage` w `UiCommandRunner`). Zostało to
sprawdzone w kodzie przed pisaniem czegokolwiek nowego.

### Runda poprawek 1 (recenzja)

Recenzja nie znalazła krytycznych; poprawione zostały zapisy i ostrość kilku asercji.

- **Osierocony wskaźnik.** Zamknięcie pakietu BL-08 zostawiło dwa miejsca kierujące defekt „proza przed
  wywołaniem narzędzia" do nieistniejącego pakietu (`L3.11.gap`, próba `T04`) — i to **zdaniem, które
  zmierzyłem jako nieprawdziwe** („brak jej w panelu"). Proza *jest* w panelu, w krokach szuflady
  biblioteki, na żywo i po odtworzeniu; po turze jest o jedno kliknięcie. Oba miejsca opisują teraz
  pomiar i wskazują na jawnie niespełnione wymaganie przy L5.15.
- **Kolumna „Brak" przy L5.15** nazywa jawnie niespełnioną część zamiast świecić pustką.
- **Zastrzeżenie o starych dziennikach** przeniesione z raportu zadania do `NEW-APPLICATION.md` §7.1,
  pod opis zdarzenia `platform.permission_resolved`.
- **Trzy kryteria odzyskały cytaty z prawdziwego modelu** (L5.3, L5.4 — `agent-ui`; L5.5 — `files-agent`,
  jedyny zapis, że model dotarł do bramki zgód) wraz z notą, dlaczego rodzaj dowodu zmienił się na „test
  GUI bez modelu": powtarzalnym dowodem w regresji jest test przeglądarkowy, przebieg modelowy zostaje
  jako potwierdzenie obok.
- **Ostrość asercji:** schematy zdarzeń i ładunków są `strict`, więc wykrywają też pole dodane przez
  pomyłkę (z własną kontrolą negatywną); przypięcia wersji mają komunikaty mówiące, co zrobić zamiast
  podbijać literał; trzy asercje kursora zastąpione trzema, które mogą oblać niezależnie; przypadek
  restartu ma dowód pozytywny (kolejne polecenie w tej samej rozmowie kończy się sukcesem), bo sama
  negacja przechodziła też dla pustego ekranu; komunikat „operacja wykonała się dwa razy" zawężony do
  tego, co asercja widzi — idempotencja usuwa duplikat, zanim artefakt powstanie.

---

## T7 — 2026-09-19 — BL-03 faza 1: projekt prób modelowych, próba generalna i to, co udało się zamknąć bez tury

Pakiet BL-03 ma **19 kryteriów i grant 25 tur** prawdziwego modelu. Faza 1 (ta) nie wydaje ani jednej
tury: projektuje przebiegi, sprawdza je na skryptowanym stand-inie i zabiera z planu wszystko, co da
się potwierdzić bez modelu. Tury wydaje faza 2, po autoryzacji koordynatora.

### Żądania sterujące SDK kosztują zero tur — i odpowiadają na dwa kryteria

`Query` z Claude Agent SDK ma metody sterujące (`initializationResult`, `mcpServerStatus`,
`accountInfo`), obsługiwane przez CLI lokalnie. Sesja otwarta ze **strumieniem wejściowym, który nigdy
nic nie podaje**, nie przekazuje modelowi żadnej wiadomości, więc nie kosztuje tury — a `mcpServerStatus()`
podaje stan serwera MCP i listę narzędzi, które naprawdę się w niej zarejestrowały.

Trzy rzeczy z tego wyszły:

1. **`pnpm diag` przestał ryzykować turę.** Poprzednia wersja wysyłała `prompt: 'ok'` i przerywała na
   `system/init`; czy wiadomość zdążyła dojść do modelu przed `interrupt()`, było wyścigiem. Teraz
   diagnostyka pyta wyłącznie żądaniami sterującymi, trwa ~2 s i porównuje 33 zadeklarowane narzędzia
   z listą w sesji. Kończy się kodem ≠ 0, gdy czegoś brakuje albo gdy w sesji są obce serwery MCP.
2. **Niezgodny schemat naprawdę znika po cichu — zmierzone, nie opowiedziane.** Serwer MCP z jednym
   narzędziem na `z.record()` raportuje się w sesji jako `connected` z **zerem narzędzi i bez błędu**
   (`--proba-niezgodnego-schematu`, kod wyjścia 1). W procesie ta sama konwersja rzuca wyjątek, który
   CLI połyka. To jest dokładnie ten stan, którego nie da się zdiagnozować od strony modelu, i
   jedyne, co go dziś zatrzymuje, to własny strażnik `assertMcpCompatibleShape` przy starcie.
3. **`settingSources: []` nie wystarcza do izolacji MCP.** W sesji zbudowanej tak, jak robi to runtime,
   pojawił się **obcy serwer MCP podpięty do konta** (łącznik z claude.ai) — jego narzędzia działają w
   procesie SDK, poza sandboxem powłoki, czyli dokładnie tam, gdzie `WebFetch` jest zabroniony zamiast
   pytany. Runtime dostał `strictMcpConfig: true`; bez tej flagi obcy serwer wraca
   (`pnpm --filter @app/server diag -- --proba-bez-izolacji-mcp`, kod wyjścia 1).

### Co SDK naprawdę ogłasza (`tests/mcp-published-schema.test.ts`)

`assertMcpCompatibleShape` to statyczny obchód kształtu Zod, czyli zestaw **przekonań o cudzym
konwerterze**. Nowy test czyta JSON Schema, które SDK wyprowadza z każdego realnego narzędzia, i woła
narzędzia przez własną walidację serwera:

- wszystkie zadeklarowane narzędzia są ogłoszone, z opisem i schematem obiektu;
- jedno narzędzie z `z.record()` zabiera całą listę (kontrola: samo zdrowe narzędzie ogłasza się
  normalnie);
- **`.default()` pod `.optional()` jest ogłaszane jako NIEwymagane i uzupełniane przy wywołaniu**, gdy
  obiekt nadrzędny jest podany — to jest ta semantyka, na którą strażnik pozwala i której nikt
  wcześniej nie sprawdził (L9.13). Kontrola negatywna: obiekt bez `.optional()` jest wymagany i
  wywołanie bez niego oblewa.

### Opis skutku i zakresu dostępu w każdym narzędziu (L9.16)

Opisy narzędzi rzadko mówiły, co narzędzie zmienia i dokąd sięga. Zdanie jest teraz **wyprowadzane z
pola `effect`** i doklejane w `buildMcpServer`, a nie pisane ręcznie przy każdym narzędziu: zdanie,
które trzeba pamiętać, jest zdaniem, którego kolejne narzędzie nie będzie miało. Test sprawdza je na
opisie, który SDK naprawdę publikuje.

### Próba generalna złapała pięć błędów scenariusza, zanim kosztowały turę

`e2e/bl03-rehearsal.spec.ts` prowadzi **te same asercje**, których użyją próby płatne
(`e2e/support/bl03-checks.ts`), przeciwko skryptowanym scenariuszom wołającym prawdziwe uchwyty
narzędzi. Osiem testów, zero tur. Znalazła:

1. polecenie wysłane z canvasu **nie niesie rekordu** — `resource` czyści się przy wyjściu z ekranu
   sprawy, więc scenariusz odtwarzający spec karty z kontekstu padał; zmiana karty musi czytać kartę,
   która jest, a nie budować ją od nowa (to samo ograniczenie dotyczy poleceń w próbie płatnej);
2. w fixture jest **jedna** przestrzeń pracy, więc „przełącz na drugą” nie miało celu — druga
   przestrzeń jest teraz przygotowywana przez API;
3. wyszukiwanie zwraca `kind: "offer_item"`, nie `item`;
4. `workspace_outputs` odpowiada polem `outputs`, nie `files`;
5. szczegół sprawy ma `offers[].offer.id`, nie `offers[].id`; a karta dodana przez API wymaga
   przeładowania, żeby pojawiła się na ekranie.

Każdy z tych pięciu byłby w fazie 2 turą wydaną na błąd w skrypcie.

### Zmiany w regresji

- `tests/contracts.test.ts`: kontrakt `removeCard` (usuwa wskazaną kartę, nie rusza pozostałych,
  powtórzenie tego samego `operationId` nie usuwa drugi raz, cudza karta nie jest do usunięcia).
- `tests/isolation.test.ts`: domyślny projekt przeglądarkowy ignoruje **oba** zestawy specek
  modelowych; spece BL-03 wymagają drugiej zgody (`APP_E2E_MODEL_Z11`) i mają własny licznik tur.
  Ten test złapał moją zmianę jako pierwszy — dopisanie czterech płatnych specek bez rozszerzenia
  `testIgnore` oblało go natychmiast.
- `tests/runtime.test.ts`: uruchomienie przekazuje SDK `strictMcpConfig` i wyłącznie serwer `app`.

### Czego faza 1 **nie** rozstrzyga

Nie zmieniam ocen w `docs/acceptance/assessment.json`. Warunek zamknięcia BL-03 brzmi „dowód z
przebiegu na commicie szablonu, oznaczony jako rzeczywisty model”; wpisanie werdyktu przed przebiegiem
byłoby deklaracją, której ten program zabrania. Projekt siedmiu przebiegów, ich koszt w turach i lista
kryteriów, które mogą zostać otwarte, są w raporcie zadania.

Jedno odrzucone skrótowe rozwiązanie warto zapisać: `Query.readFile()` jest żądaniem sterującym i
dokumentacja mówi, że podlega „tym samym regułom uprawnień, co narzędzie Read”. Gdyby tak było,
L11.4 i L11.11 dałoby się zamknąć bez tury. Sprawdzone: `readFile` zachowuje się **identycznie** przy
sandboxie i bez niego oraz w trybie `default` i `bypassPermissions` — jest po prostu ograniczony do
`cwd`. Nie jest więc świadkiem decyzji bramki uprawnień i nie został użyty jako dowód.
