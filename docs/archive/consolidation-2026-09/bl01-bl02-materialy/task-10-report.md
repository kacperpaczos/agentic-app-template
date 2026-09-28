# Task 10 — fala poprawek po przeglądzie całej gałęzi BL-01/BL-02

Worktree: `/home/paczos/Documents/agentic-app-template-wt/t10-fala-poprawek`, gałąź
`bl01-bl02/t10-fala-poprawek`, BASE `22d9b4d`.

Zakres: **sześć pozycji „Important”** z dwóch przeglądów (serwerowego i przeglądarkowego). Nic poza nimi.
Nie robiłem żadnych własnych refaktorów; jedyne dotknięcie kodu poza literalnymi liniami z briefu to
wydzielenia wymuszone przez G9 (jedna reguła — jedna implementacja), opisane niżej przy pozycjach 1 i 6.

## Commity

| SHA | Temat | Pozycje |
|---|---|---|
| `7a0fa7b` | Kanwa: blad przed danymi w opisie ekranu (jedna regula dla obu ekranow z kartami) | 6 |
| `09f1139` | Porzadek po kwocie w dwoch walutach odmawiany jak seria wykresu; refreshing oddzielone od not_applied | 1, 2 |
| `74c532c` | Katalog e2e w bramce typow: tsconfig.e2e.json i naprawa 16 bledow | 5 |
| `e3fb23c` | Spece modelowe poza domyslnym przebiegiem; licznik tur i dowody rozdzielone | 3 |
| `4328168` | Wykres bierze jednostke z tego samego przejscia, co regula (jedno miejsce zbierania jednostek) | 1 (dociągnięcie G9) |
| `41eea4b` | Sprawdzenie wstepne budzetu: spec odbiorowy pomija proby, zanim wyda ture na darmo | 3 (dopisek koordynatora) |

Pozycja 4 to poprawka w `task-8-report.md` (ten katalog), poza repozytorium kodu.

Łącznie w repozytorium: 30 plików (+ dopisek z rundy koordynatora, sekcja 7).

---

## 1. Sortowanie po kwocie w dwóch walutach

### Decyzja: **odmowa**, nie oznaczenie

Brief zostawiał wybór: „odmów tak jak wykres” albo „oznacz to nie do pomylenia w modelu i w opisie
semantycznym”. Wybrałem odmowę, z trzech powodów:

1. **Bo to jest ta sama reguła, a nie podobna.** Wykres odmawia narysowania serii mieszającej jednostki,
   bo słupek w PLN obok słupka w EUR wypowiada porównanie, którego dane nie znają. Uszeregowanie po tym
   samym polu wypowiada dokładnie to samo porównanie — tylko zamiast osi używa kolejności wierszy. Gdyby
   jedno miejsce odmawiało, a drugie oznaczało, mielibyśmy dwie odpowiedzi na jedno pytanie i G9 byłoby
   złamane nie w kodzie, lecz w zachowaniu.
2. **Bo oznaczona lista dalej jest listą.** Wymóg brzmiał: „użytkownik ani agent nigdy nie widzi listy
   »od najdroższych« zbudowanej na dwóch walutach”. Lista posortowana i opatrzona ostrzeżeniem nadal jest
   tą listą; pierwszy wiersz nadal wygląda na najdroższy. Odmowa jest jedyną odpowiedzią, przy której to
   zdanie jest prawdziwe dosłownie.
3. **Bo repozytorium ma już szew na „porządek, którego widok nie uznał”.** `rejectedSort` istnieje od
   Task 2: porządek z adresu, którego widok nie może zastosować, jest **odkładany i raportowany**, a nie
   zamieniany w ekran błędu — „rekordy wciąż warto pokazać, w porządku własnym widoku”. Nowa odmowa
   wchodzi w ten szew zamiast budować obok siebie drugi.

Stąd rozkład, symetryczny z wykresem:

| Skąd porządek | Co się dzieje | Dlaczego tak |
|---|---|---|
| kompozycja (`DataTable(..., sort)`) | `sortRecords` rzuca `validation_failed` z nazwami jednostek → komponent pokazuje odmowę zamiast danych | porządek kompozycji jest **częścią kompozycji**, tak jak błędnie nazwana kolumna i tak jak seria wykresu; `buildDataModel` odrzuca go już dziś, gdy pole jest niesortowalne |
| adres (`?sort=-pole`, też z `ui_sort`) | porządek **odłożony**: `rejectedSort = { …, reason: 'mixed_units', units }`, rekordy w porządku własnym widoku, pasek mówi dlaczego i wymienia jednostki | ręcznie sklejony link nie jest ekranem błędu (istniejąca zasada) |
| `ui_sort` | `executed: false`, `reason: 'mixed_units'`, `rejectedSort.units` w wyniku narzędzia; opis narzędzia mówi wprost: zawęź do jednej waluty i posortuj ponownie, a listy „od najdroższych” nie podawaj | wcześniej ta sama sytuacja wracała jako `not_applied`, czyli „coś jest zepsute” |

### Jedna implementacja (G9)

Reguła wykresu została **wyjęta**, nie skopiowana. W `@platform/contracts/records.ts`:

- `unitsInPlay(records, field)` — jednostki, w których faktycznie są wartości tego pola (puste komórki i
  wartości nieczytelne dla typu pola nie są na skali). Jedno przejście, jedno miejsce.
- `mixedUnits(records, field)` — sam osąd: jednostki, gdy się nie zgadzają; `null`, gdy zgadzają.
- `mixedUnitsMessage(subject, units)` — jedno zdanie odmowy, żeby użytkownik spotykał je na wykresie i na
  kolejności w identycznym brzmieniu.

`buildChartModel` używa `mixedUnits` do odmowy i `unitsInPlay` do wyznaczenia jednostki serii (przedtem
budował drugi zbiór tych samych wartości — `4328168`). `sortRecords` używa `mixedUnits` do odmowy.
`buildDataModel` używa `mixedUnits` przy porządku z adresu. **Komunikat wykresu nie zmienił brzmienia**
(`Seria Cena jednostkowa laczy rozne jednostki (PLN, EUR); zawez dane do jednej jednostki.`).

Typ odmowy też jest jeden: `RejectedSort` + `rejectedSortSchema` w `ui.ts` zastąpiły trzy lokalne
deklaracje `(DataSort & { reason: … })` w `DataModel`, `ViewStateReport` i (nowo) w wyniku komendy UI.
`REJECTED_SORT_FAILURES` to jedno mapowanie powodu na odmowę komendy, używane przez `UiCommandRunner`.

### Testy

| Dowód | Rodzaj | Co pokazuje |
|---|---|---|
| `tests/views-foundation.test.ts` „porzadek po kwotach w dwoch walutach jest odmawiany z nazwami jednostek…" | test kontraktu | `unitsInPlay`/`mixedUnits` (w tym: pusta kwota nie czyni kolumny mieszaną), `sortRecords` rzuca `validation_failed` z `details = { reason: 'mixed_units', field, units }` i dokładnym zdaniem; po zawężeniu do jednej waluty ten sam porządek działa; tekst nigdy nie jest skalą |
| `tests/views-foundation.test.ts` „sortowanie po kwocie w dwoch walutach: kompozycja odmawia, adres jest pomijany z jednostkami" | test logiki (model widoku) | na prawdziwym `procurement.comparison` (zasiew ma PLN i EUR): kompozycja → wyjątek; adres → `rejectedSort` z `units: ['PLN','EUR']`, `sort: null`, kolejność rekordów identyczna jak bez sortowania; **opis semantyczny instancji ma `sort: null`** (agent nie dowiaduje się o rankingu, którego nie ma); po zawężeniu do PLN porządek jest stosowany i malejący |
| `tests/view-state.test.ts` „kolejnosc po polu w dwoch jednostkach: mixed_units…" | test kontraktu | wynik `ui_sort` niesie `reason: 'mixed_units'` i `rejectedSort.units`, mapowanie `REJECTED_SORT_FAILURES` pokrywa wszystkie trzy powody, opis narzędzia uczy `mixed_units` i `rejectedSort.units` |

**Kontrola negatywna** jest wbudowana w oba testy modelu: ta sama operacja zawężona do jednej waluty
**musi** dać ranking (`ranked.rejectedSort === null`, wartości malejące) — odmowa, która odmawia zawsze,
oblałaby tak samo jak odmowa, która nie odmawia nigdy.

### Próba zdolności wykrycia

```
# drzewo czyste (git status --short puste), po commicie 09f1139
# wycofanie: blok `if (mixed) throw …` w sortRecords (packages/platform-contracts/src/records.ts)
pnpm exec vitest run tests/views-foundation.test.ts
  × porzadek po kwotach w dwoch walutach jest odmawiany z nazwami jednostek — ta sama regula co seria wykresu
  × sortowanie po kwocie w dwoch walutach: kompozycja odmawia, adres jest pomijany z jednostkami
  Tests  2 failed | 45 passed (47)
git checkout -- packages/platform-contracts/src/records.ts   # git status --short: puste
pnpm exec vitest run tests/views-foundation.test.ts  →  Tests  47 passed (47)
```

---

## 2. `not_applied` znaczyło dwie przeciwne rzeczy

Nowa odmowa `refreshing` (`UI_COMMAND_FAILURES.refreshing`) dla łagodnego przypadku „widok właśnie pobiera
dane, ekran nie osiągnął stanu, który ta komenda mogłaby potwierdzić”. `not_applied` zostaje wyłącznie
sygnałem wady („nikt tego nie zastosował, ponawianie nic nie da”).

Zmienione:

- **kontrakt** (`ui.ts`): oba powody mają teraz dokumentację, która mówi wprost, że jeden jest wart
  ponowienia, a drugi nie; lista „co dokłada klient” przy `SHOW_VALUE_REFUSALS` wymienia `refreshing`;
- **ścieżki klienta** (`uiReveal.ts`, dwa miejsca — oczekiwanie na osiadłą tabelę i oczekiwanie na komórkę):
  `findTable(reveal)?.refreshing ? refreshing : notPresent`;
- **opisy narzędzi**: `ui_show_value` uczy `refreshing (widok wlasnie odswieza dane — sprobuj ponownie)` i
  **nie wymienia już** `not_applied`; `ui_filter` i `ui_sort` — te dwa narzędzia, w których `not_applied`
  nadal może paść — dostały zdanie, że to wada i że ponawianie nic nie da (a `ui_filter` dodatkowo, że to
  co innego niż zawężenie, które nie dopasowało wiersza);
- **podpowiedź systemowa** (`prompt.ts`): jedno zdanie przeciwstawiające oba powody;
- **komentarz `UiCommandRunner`**, żeby opis odmów w obu połówkach mówił to samo.

### Testy i próba wykrycia

| Dowód | Rodzaj |
|---|---|
| `tests/show-value.test.ts` „tabela, ktora nie przestaje sie odswiezac: refreshing (nie not_applied)…" | test logiki (klient `performReveal` na sztucznym ekranie) — asercja pozytywna **i** negatywna: `reason` nie może być `not_applied` |
| `tests/show-value.test.ts` „odswiezany widok to refreshing, nie not_applied — w opisie narzedzia i w podpowiedzi" | test kontraktu — opis `ui_show_value` zawiera `refreshing (…)` i **nie zawiera** `not_applied`; prompt uczy różnicy |

```
# drzewo czyste, po commicie 09f1139
# (a) wycofanie: refreshing → notApplied w obu miejscach uiReveal.ts
pnpm exec vitest run tests/show-value.test.ts
  × tabela, ktora nie przestaje sie odswiezac: refreshing (nie not_applied), bez falszywego wskazania
  Tests  1 failed | 39 passed (40)
git checkout -- packages/platform-ui/src/shell/uiReveal.ts     # status puste
# (b) wycofanie: stary tekst opisu narzędzia w ui-show-value.ts
pnpm exec vitest run tests/show-value.test.ts
  × odswiezany widok to refreshing, nie not_applied — w opisie narzedzia i w podpowiedzi
  Tests  1 failed | 39 passed (40)
git checkout -- packages/platform-server/src/agent/tools/ui-show-value.ts   # status puste
```

---

## 3. Spec odbiorowy niszczył dowody odbioru

Trzy połówki, wszystkie zrobione. Wspólny mechanizm wylądował w nowym module `e2e/support/model-turns.ts`
(jedno miejsce, z którego korzystają `playwright.config.ts`, `e2e/global-setup.ts`, sam spec i test).

**(a) Spece modelowe poza domyślnym przebiegiem.** Bez `APP_E2E_MODEL=1` w konfiguracji **nie istnieje
projekt, którego zbiór plików obejmuje te trzy spece** — `testIgnore: MODEL_SPEC_PATTERNS` na jedynym
projekcie. Świadomie nie „drugi projekt obok”: Playwright uruchamia domyślnie **wszystkie** projekty, więc
drugi projekt nie byłby żadną barierą. Przy `APP_E2E_MODEL=1` lista projektów to wyłącznie `model`
z `testMatch` na te trzy pliki. Skrypt: `pnpm test:e2e:model`.

```
pnpm exec playwright test --list                  →  Total: 114 tests in 19 files
APP_E2E_MODEL=1 pnpm exec playwright test --list  →  Total: 8 tests in 3 files
```

Domyślny przebieg **mówi, co pominął**, z kosztem (wypis z ostatniego przebiegu bramki):

```
[e2e] pominieto spece z prawdziwym modelem: bl01-bl02-model.spec.ts (7), agent-ui.spec.ts (2),
files-agent.spec.ts (2). Kosztuja 11 tur subskrypcji na przebieg — uruchamia sie je swiadomie:
pnpm test:e2e:model.
```

**(b) Licznik tur w kopii roboczej.** Rejestr rozdzielony na dwa pliki:
`docs/evidence/bl01-bl02-2026-09-17/tury-modelu.json` (zamknięty grant, **tylko do odczytu** — spec już go
nie zapisuje) i `.e2e-model-turns/tury-modelu.json` (kopia robocza, dopisana do `.gitignore`). Licznik
roboczy jest **zasiewany raz** z rejestru zamkniętego, bo inaczej świeży checkout wydałby te 21 tur po raz
drugi — budżet jest budżetem planu, nie procesu.

**(c) Dowody nie do nadpisania.** Wszystko, co pisze przebieg (JSON prób i zrzuty ekranu), ląduje w
`docs/evidence/bl01-bl02-2026-09-17/runs/<stempel przebiegu>/`. `writeEvidence` przyjmuje wyłącznie zwykłą
nazwę pliku i odmawia nazwy, która mogłaby wyjść poza katalog przebiegu. Zapisane `t25-*`, `t26-*`,
`t27-*` i rejestr są więc poza zasięgiem jakiegokolwiek przyszłego przebiegu — w tym bloków `finally`,
które wpisują „niezaliczona”, kiedy próba nie dojdzie do końca.

**Dokumentacja** (te dwa pliki tylko dla tej pozycji): `README.md` („Sprawdzanie zmian”) i `AGENTS.md`
(„Bramki przed oddaniem”) — opt-in, koszt 11 tur na przebieg z rozbiciem na spece, gdzie leży licznik,
gdzie lądują dowody przebiegu, oraz `pnpm typecheck` = pakiety + `e2e/` (pozycja 5).

### Testy i próba wykrycia

Cztery testy w `tests/isolation.test.ts` (test kontraktu/konfiguracji — ten plik już pilnuje, żeby suita
przeglądarkowa nie zrobiła krzywdy):

1. domyślna konfiguracja ma jeden projekt `chromium` z `testIgnore` równym liście trzech speców i bez
   `testMatch`; `modelSpecsRequested` reaguje tylko na `APP_E2E_MODEL=1`;
2. wypis pominięcia wymienia wszystkie trzy pliki, łączny koszt i polecenie opt-in;
3. `WORKING_LEDGER` jest w `.e2e-model-turns/` (i to jest w `.gitignore`), **nie** pod `docs/evidence/`;
   zasiew czyta `wydane` z rejestru zamkniętego;
4. `evidencePath(name)` dla czterech nazw zapisanych dowodów wskazuje `…/runs/<stempel>/`, a nie plik
   zapisany; `evidencePath('../t25-…')` i `evidencePath('runs/../t25.json')` są odrzucane.

```
# drzewo czyste, po commicie e3fb23c — trzy wycofania, każde osobno
# (a) usunięcie `testIgnore: MODEL_SPEC_PATTERNS` z playwright.config.ts
pnpm exec vitest run tests/isolation.test.ts
  × domyslny przebieg nie ma projektu, ktory obejmuje spece modelowe; opt-in ma tylko je
  Tests  1 failed | 21 passed (22)
pnpm exec playwright test --list | grep -c bl01-bl02-model   →  3     # wada wraca widocznie
git checkout -- playwright.config.ts                                  # status puste
# (b) runEvidenceDir() → EVIDENCE_ROOT (dowody znów lądują na zapisanych)
  × dowody przebiegu ida pod stempel przebiegu — zapisane werdykty sa nie do nadpisania
git checkout -- e2e/support/model-turns.ts                            # status puste
# (c) WORKING_LEDGER → rejestr w docs/evidence/
  × licznik tur jest w kopii roboczej (ignorowanej przez git), a nie w dowodach
git checkout -- e2e/support/model-turns.ts                            # status puste
```

---

## 4. `task-8-report.md` przeczył sam sobie

Sekcja „Stan próby T27 po dokończeniu” (dawne wiersze 645–655) **nie została usunięta** — została
oznaczona jako nieaktualna, z cytowalnym wskazaniem, co obowiązuje:

- tytuł: „Stan próby T27 po dokończeniu (NIEAKTUALNE — stan z rundy »dokończenie po Task 9«)”;
- blok cytatu na wejściu: sekcja została zastąpiona przez „T27 — domknięcie (grant 4 tur…)”, z jej
  „Tabelą kroków próby T27” i „Stanem końcowym prób”, plus streszczenie różnicy: próba T27 **zaliczona
  6/6 kroków w jednej rozmowie** (z identyfikatorami wykonań), krok 2 przepisany na dwie uczciwe ścieżki
  o tej samej mocy, **żaden test nie jest już czerwony**, pomocniczy test „T27 kroki 5–6" usunięty, koszt
  przebiegu **7 tur, nie 10**, łącznie 21 tur;
- oba stare akapity zostały, przedrostkowane „(stan z rundy 6 tur, zastąpiony)” / „(zastąpione)”.

Przy okazji — bo te dwie sekcje mówią o bramkach, które właśnie zmieniłem, i po zmianie wprowadzałyby
czytelnika w błąd — dopisałem **krótkie noty**, nie ruszając treści:

- „Koszt pełnej suity w turach subskrypcji”: nieaktualne od Task 10, `pnpm test:e2e` nie wydaje już żadnej
  tury, opt-in kosztuje 11;
- „Luka w bramce: `pnpm typecheck` nie obejmuje `e2e/`”: zamknięte w Task 10, z odesłaniem do punktu 5.

To jedyne miejsca poza wskazanym akapitem, których dotknąłem w cudzym raporcie; zgłaszam to wprost,
bo brief mówił o jednej sekcji.

**Próba zdolności wykrycia: nie dotyczy** — poprawka jest wyłącznie redakcyjna, nie ma linii kodu do
wycofania ani testu, który by ją pokrywał.

---

## 5. `e2e/` w bramce typów

Nowy `tsconfig.e2e.json` (`e2e/**/*.ts` + `playwright.config.ts`, `types: ["node"]`, bez `vite/client`, bo
katalog `e2e` nie powinien wciągać typów przeglądarki do bramki pakietów — to była rekomendacja z Task 8 i
jest sensowna). `package.json`: `typecheck` = `typecheck:src` + `typecheck:e2e`, więc `pnpm verify` obejmuje
oba; `pnpm check:module-swap` też, bo uruchamia `pnpm typecheck` w kopii.

Wszystkie 16 błędów z tabeli Task 8 poprawione:

- **14 × TS7006** — poprawione **u źródła**, nie adnotacjami w scenariuszach. `Step['input']` było
  `unknown | ((earlier: CallRecord[]) => unknown)`; `unknown` pochłania każdy inny człon unii, więc typ
  zwijał się do `unknown` i forma funkcyjna traciła typ kontekstowy. Zastąpione jawnym
  `export type CallInput = Record<string, unknown> | ((earlier: CallRecord[]) => Record<string, unknown>)`.
  Żaden z siedmiu plików scenariuszy nie wymagał zmiany — parametr `calls` jest teraz typowany
  kontekstowo jako `CallRecord[]`.
- **2 × TS2345** — jedna przyczyna. `base.extend<Record<string, never>, …>` zakłada na tablicę fixture'ów
  indeks o typie `never`, więc fixture o zakresie worker jest sprawdzany wobec `TestFixture<never, …>`
  i jego `use(): void` przestaje pasować. `object` mówi to, co miało być powiedziane („żadnych fixture'ów
  testowych”) i naprawia **oba** błędy — `e2e/support/fixtures.ts` i `e2e/chat-drawer.spec.ts`
  (`test.use({ viewport })` dziedziczyło ten sam typ).

### Próba zdolności wykrycia

```
# drzewo czyste, po commicie 74c532c
# wycofanie: CallInput → unknown | ((earlier: CallRecord[]) => unknown)
pnpm exec tsc -p tsconfig.e2e.json --noEmit | grep -c TS7006   →  14
  e2e/support/agent-views-scenario.ts(64,17): error TS7006: Parameter 'calls' implicitly has an 'any' type.
  …
git checkout -- e2e/support/scripted-agent.ts
pnpm exec tsc -p tsconfig.e2e.json --noEmit   →  exit 0        # status puste
```

---

## 6. `CanvasHost` ogłaszał karty przy ekranie błędu

`state: data ? 'loaded' : error ? 'error' : 'loading'` było liczone przed `if (error) return
<QueryErrorState …>`, więc nieudane odświeżenie nad zapełnionym cache opisywało agentowi karty, na które
użytkownik nie patrzy.

Wzorzec z `AgentViewsPage` został **wydzielony, a nie skopiowany** (G9: to jedna reguła dwóch ekranów).
W `state/displayedCanvas.ts`:

```ts
export function cardsOnScreen(input: { spaceId; scopeKind; data; error }): DisplayedCanvas
// błąd → { cards: null, state: 'error' }; brak danych → 'loading'; inaczej 'loaded' z kartami
```

`CanvasHost` woła to zamiast wyrażenia w miejscu; `agentViewsDisplay` woła to samo dla swoich gałęzi
„błąd / ładowanie / wczytane” (jego pozostałe odpowiedzi — brak rozmowy, brak przestrzeni, brak kart —
zostały bez zmian, razem z istniejącym testem w `tests/ui-snapshot.test.ts`, który przechodzi).

### Testy

Nowy `tests/canvas-display.test.ts` (3 testy) — **test GUI bez modelu**: `CanvasSurface` renderowany do
tekstu nad przygotowanym cache (dane w cache **plus** stan błędu zapytania, jak przy nieudanym
odświeżeniu), `useDisplayCanvas` podmieniony na rejestrator. Asercje z obu stron naraz:

- na co patrzy użytkownik: `data-testid="query-error"` jest, `data-testid="card-crd_1"` **nie ma**;
- co dostaje agent: `{ cards: null, state: 'error' }`;
- kontrola pozytywna: bez błędu `state: 'loaded'` z identyfikatorami kart, bez odpowiedzi `'loading'`;
- reguła sama w sobie (`cardsOnScreen`) — test logiki.

### Próba zdolności wykrycia

```
# drzewo czyste, po commicie 7a0fa7b
# wycofanie: przywrócenie wyrażenia `state: data ? 'loaded' : error ? 'error' : 'loading'` w CanvasHost.tsx
pnpm exec vitest run tests/canvas-display.test.ts
  × nieudane odswiezenie nad zapelnionym cache: error i brak kart, nie „loaded” z kartami
  AssertionError: expected { spaceId: 'spc_canvas_1', …(3) } to match object { spaceId: …, …(2) }
  Tests  1 failed | 2 passed (3)
git checkout -- packages/platform-ui/src/canvas/CanvasHost.tsx   # status puste
pnpm exec vitest run tests/canvas-display.test.ts  →  Tests  3 passed (3)
```

---

## Bramka (G10)

Wszystko na `4328168`, drzewo czyste.

| Polecenie | Wynik |
|---|---|
| `pnpm verify` | **exit 0** — 32 pliki / **540 testów** (baza 22d9b4d: 31 / 529; +11 testów z tej fali, +1 plik) |
| `pnpm check:module-swap` | **exit 0** — 19 kroków OK, w tym `typecheck` (już z `tsconfig.e2e.json`), build, serwer na module kontrolnym |
| `flock … pnpm exec playwright test <19 speców niemodelowych>` | **exit 0** — **114 passed (6,7 min)** |

Lista uruchomionych speców (`ls e2e/*.spec.ts` minus trzy modelowe): `access-context`, `agent-views`,
`app`, `background-tasks`, `chat-drawer`, `chat-layout`, `chat`, `composed-views`, `interactions`,
`measurements`, `scripted-call`, `session-restore`, `show-value`, `streaming`, `tool-activity`,
`ui-navigation`, `ui-state`, `view-filter`, `view-state`.

**Żadnego spec-a z prawdziwym modelem nie uruchomiłem.** Grant jest zamknięty; `.e2e-model-turns/` nie
powstało ani razu, a `docs/evidence/bl01-bl02-2026-09-17/` jest bit w bit jak na `22d9b4d`
(`git diff 22d9b4d..HEAD -- docs/evidence/bl01-bl02-2026-09-17` — pusty).

Po przebiegu przeglądarkowym usunąłem nieśledzone dowody wygenerowane przez cudze spece
(`docs/evidence/chat-ux-2026-09-16/`, `docs/evidence/closure-2026-09-15/`), zgodnie z `dispatch-common.md`.

### Nieudane przebiegi

Jeden, mój błąd narzędziowy, bez wpływu na kod: wstawiając zdanie o `refreshing` do `prompt.ts` trafiłem
w środek zdania rozbitego na dwie linie tablicy i zduplikowałem fragment „sie zrobic i dlaczego.”.
Zauważone natychmiast przy odczycie pliku, poprawione przed jakimkolwiek commitem — zdanie stoi teraz za
akapitem o `unreadable`. Żaden inny przebieg testów w tym zadaniu nie oblał poza celowymi próbami
zdolności wykrycia opisanymi wyżej.

---

## Kontrakt dla autora modułu

Co się zmienia dla kogoś, kto pisze moduł na tym szablonie:

1. **Pole z `unitField` jest polem bez wspólnej skali, dopóki rekordy nie zgodzą się co do jednostki.**
   Deklarując `{ type: 'money_minor', unitField: 'currency', sortable: true }` deklarujesz pole, po którym
   **wolno** sortować, ale platforma uszereguje po nim tylko rekordy w jednej walucie. Kompozycja, która
   sortuje po takim polu nad danymi w kilku walutach, pokaże odmowę zamiast tabeli — jeśli chcesz mieć tam
   ranking, zawęź źródło (`filter` kompozycji) albo daj operację odczytu zwracającą jedną walutę. Dotyczy
   tak samo `quantity_milli` z `unitField` (szt./kg) i `number` z `unit`.
2. **`sortable: false` i „mieszane jednostki” to dwie różne odmowy.** Pierwsza jest twoją decyzją
   w deskryptorze i widać ją w `ui_catalog` (`sortableFields`). Druga zależy od danych i pada dopiero tam,
   gdzie są rekordy: w modelu widoku (`rejectedSort.reason = 'mixed_units'`, `rejectedSort.units`) i jako
   odmowa `mixed_units` w wyniku `ui_sort`.
3. **`refreshing` to nie `not_applied`.** Jeśli twój komponent danych zgłasza się jako odświeżany, komendy
   UI odpowiedzą `refreshing` — agentowi wolno wtedy spróbować ponownie. `not_applied` zostaje sygnałem,
   że nikt komendy nie zastosował, i ponawianie nie ma sensu.
4. **Ekran pokazujący karty opisuje się przez `cardsOnScreen`.** Jeśli piszesz własny ekran nad przestrzenią
   canvas, użyj tej funkcji zamiast układać własną kolejność „dane / błąd / ładowanie” — błąd zawsze bije
   dane z cache.
5. **Testy z prawdziwym modelem są opt-in.** `pnpm test:e2e` ich nie uruchamia; `pnpm test:e2e:model`
   (`APP_E2E_MODEL=1`) uruchamia wyłącznie je i kosztuje tury subskrypcji. Nowy spec z prawdziwym modelem
   dopisz do `MODEL_SPEC_FILES` w `e2e/support/model-turns.ts` razem z jego kosztem w turach — inaczej
   znajdzie się w domyślnym przebiegu.
6. **`pnpm typecheck` obejmuje `e2e/`.** Błąd typu w specu zatrzymuje bramkę, a nie przebieg.

---

## Self-review — ustalenia

- **Nie poszerzyłem zakresu, ale dwa wydzielenia były konieczne.** `cardsOnScreen` (pozycja 6) i
  `unitsInPlay`/`mixedUnits` (pozycja 1) to nie moje refaktory z upodobania — brief przy pozycji 1 wprost
  zakazuje drugiej reguły porównywania jednostek, a przy pozycji 6 każe „skopiować wzorzec”, co bez
  wydzielenia dałoby dwie kopie tej samej kolejności odpowiedzi.
- **Odmowa przy porządku z adresu nie czyści adresu.** Gdy `ui_sort` dostanie `mixed_units`, parametr
  `sort=` zostaje w pasku adresu, choć widok go nie zastosował. Tak samo zachowuje się dziś `not_applied`,
  a pasek widoku nazywa sytuację i ma przycisk „przywróć widok”, więc zostawiłem to bez zmiany —
  wycofywanie nawigacji byłoby nowym zachowaniem, o które nikt nie prosił.
- **`unitAcross` w `views/model.ts` (wiersz 276) to trzecie miejsce czytające jednostki pola.** Nie ruszałem
  go: odpowiada na inne pytanie („jaką jednostkę wpisać do opisu semantycznego”), a nie „czy te wartości są
  porównywalne”. Zgłaszam jako obserwację, nie jako dług tej fali.
- **Budżet tur pozostaje 21/22.** Nie ruszyłem `MODEL_TURN_BUDGET` — podniesienie sufitu to decyzja
  koordynatora o grancie, nie poprawka. Skutek: autoryzowany `pnpm test:e2e:model` wyda 22. turę w T25
  i oblanie strażnika w T26. **Różnica wobec stanu sprzed tej fali jest taka, że nic już przy tym nie
  ginie** — dowody idą pod stempel przebiegu, rejestr zamknięty jest tylko czytany.
  **[Domknięte w rundzie koordynatora — sekcja 7: spec nie wyda już tej 22. tury, tylko pominie próby.]**
- Pozycja 4 nie ma testu i nie da się dla niej zrobić próby wykrycia; mówię to wprost, zamiast udawać.

## Obawy

1. **Ścieżka `mixed_units` w `UiCommandRunner` nie ma dowodu przeglądarkowego.** Oba jej końce są
   przetestowane (widok, który odkłada porządek — test modelu; narzędzie, które przekazuje odmowę
   i jednostki — test kontraktu; mapowanie powodów — test kontraktu), ale samego sklejenia
   (`viewReport.rejectedSort` → `reason`) nie wykonuje żaden test w przeglądarce. Zbudowanie takiego
   przypadku wymaga celu `UiTarget` z widokiem nad danymi w dwóch walutach, a `procurement.data`
   (dostawcy) jednostek nie ma; robienie nowego celu albo nowego zasiewu byłoby poszerzeniem zakresu.
   Rekomendacja dla następnej fali, jeśli koordynator uzna to za istotne.
2. **`docs/evidence/<zadanie>/runs/` nie jest w `.gitignore`** — świadomie: to dowody, a nie śmieci, i to
   koordynator ma zdecydować, czy przebieg wart jest commitu. Skutkiem jest to, że autoryzowany przebieg
   modelowy zostawi nieśledzony katalog.
3. **Zmiana `Step['input']` zwęża typ z `unknown` do `Record<string, unknown>`.** Wszystkie siedem
   scenariuszy podaje obiekty, więc nic nie pękło, ale scenariusz, który chciałby podać do narzędzia
   wartość nieobiektową, będzie musiał to zadeklarować.
4. **Trzy spece modelowe zostały wyłączone z domyślnego przebiegu razem** — także `agent-ui.spec.ts`
   i `files-agent.spec.ts`, które nie miały problemu z dowodami. Tak brzmiał brief („the model-spending
   specs … must NOT run in the default `pnpm test:e2e`”) i tak jest uczciwiej, ale oznacza to, że pełna
   suita domyślna nie sprawdza już niczego na prawdziwym modelu; to musi być świadomy krok koordynatora
   przed odbiorem.


---

# 7. Dopisek z rundy koordynatora: sprawdzenie wstępne budżetu (commit `41eea4b`)

Wprost z obawy 2. Strażnik per polecenie w `sendForRun` nie wystarczał sam: przy rejestrze 21 i suficie 22
przepuszczał T25 — **jedna tura naprawdę wysłana** — i dopiero T26 odmawiał. Płatna tura szła na nic,
a przebieg i tak nie kończył próby.

## Co doszło

**Koszt zadeklarowany per próba**, bo pytanie „czy starczy” dotyczy całego spec-a, a nie pojedynczej
komendy:

```ts
export const ACCEPTANCE_TEST_TURNS = { T25: 1, T26: 3, T27: 3 } as const;   // e2e/support/model-turns.ts
export const ACCEPTANCE_TURNS_NEEDED = 7;                                    // suma, nie druga liczba
```

`MODEL_SPEC_TURNS['bl01-bl02-model.spec.ts']` **wyprowadza się** z tej sumy, więc koszt w wypisie
pominięcia (11 tur na przebieg) i koszt w sprawdzeniu wstępnym nie mogą się rozjechać; test tego pilnuje.

**Decyzja** — czysta funkcja obok reszty rachunkowości:

```ts
budgetPreflight({ budget, spent, needed })
  → { ok: true,  budget, spent, left, needed }
  → { ok: false, …, shortfall, message }
acceptancePreflight(budget)   // to samo pytanie wobec licznika na dysku
```

**Pominięcie** w `e2e/bl01-bl02-model.spec.ts`: `const preflight = acceptancePreflight(MODEL_TURN_BUDGET)`
liczone **raz, przy załadowaniu pliku**, i `test.skip(!preflight.ok, preflight.message)` w `test.beforeEach`
całego `describe`. Komunikat jest raz wypisywany na konsolę, żeby nie zginął w adnotacji raportu.

Dwie decyzje warte nazwania:

1. **Raz, nie per próba.** Pytanie brzmi „czy reszta budżetu pokrywa **cały** spec”. Gdyby zadawać je przed
   każdą próbą z pełnym `needed = 7`, to w poprawnie sfinansowanym przebiegu T25 wydałaby swoją turę,
   a T26 zostałaby pominięta jako „za mało na cały spec” — czyli lekarstwo gorsze od choroby.
2. **`beforeEach`, nie `beforeAll`.** `test.skip(warunek, powód)` działa w `beforeEach` i pomija każdy test
   przed wejściem w jego ciało — a więc **zanim cokolwiek trafi do kompozytora**. `beforeAll` nie potrafi
   pominąć testów tego opisu.

Treść odmowy (przy stanie gałęzi: rejestr 21, sufit 22):

```
Budzet tur modelu nie pokrywa tego speca: rejestr ma 21 z 22 tur (zostaje 1), a spec potrzebuje 7 —
brakuje 6. NIC nie zostalo wyslane do modelu i zaden zapisany dowod nie zostal ruszony. Podniesienie
sufitu MODEL_TURN_BUDGET wymaga grantu koordynatora; licznik roboczy: <…>/.e2e-model-turns/tury-modelu.json.
```

Pominięcie jest tu uczciwe: nic nie jest twierdzone, nic nie jest wydane, a zapisane werdykty prób
odbiorowych zostają nietknięte. `docs/` (README, AGENTS) dostały po jednym zdaniu o tym zachowaniu.

## Testy

| Dowód | Rodzaj | Co pokazuje |
|---|---|---|
| `tests/isolation.test.ts` „budzet niepokrywajacy calego speca: decyzja o pominieciu…" | test kontraktu/logiki | **brak budżetu → pominięcie**: 21/22 z `needed 7` → `ok: false`, `left 1`, `shortfall 6`, a komunikat nazywa rejestr („21 z 22"), resztę („zostaje 1"), potrzebę („potrzebuje 7"), brak („brakuje 6"), fakt niewysłania niczego, grant koordynatora i ścieżkę licznika. **Budżet z zapasem → przebieg**: 40/21 → `ok: true`, `left 19`. Granica dokładnie na styku: `28 − 21 = 7` przechodzi, `27 − 21 = 6` nie. Rejestr wyczerpany (22/22) i przekroczony (30/22) też są pominięciem. Koszt per próba sumuje się do kosztu spec-a i do `MODEL_SPEC_TURNS`. Na stanie gałęzi `acceptancePreflight(22).ok === false` |
| `tests/isolation.test.ts` „spec odbiorowy pomija proby na podstawie sprawdzenia wstepnego, zanim cokolwiek wysle" | test kontraktu (statyczny) | spec liczy `preflight` raz z `acceptancePreflight(MODEL_TURN_BUDGET)`, woła `test.skip(!preflight.ok, …)`, a `beforeEach` stoi **przed** pierwszym `sendForRun` w pliku |

Drugi test jest świadomie statyczny: wykonanie hooka wymagałoby uruchomienia spec-a modelowego, czego to
zadanie nie robi. Mówię wprost — **sam hook nie został wykonany**; sprawdzone jest, że istnieje, że bierze
decyzję z tej funkcji i że stoi przed wysyłką.

## Próba zdolności wykrycia

```
# drzewo czyste, po commicie 41eea4b — dwa wycofania, każde osobno
# (a) osłabienie decyzji: `left >= needed` → `left >= 0` w budgetPreflight
pnpm exec vitest run tests/isolation.test.ts
  × budzet niepokrywajacy calego speca: decyzja o pominieciu, z rejestrem, sufitem i brakiem
  Tests  1 failed | 23 passed (24)
git checkout -- e2e/support/model-turns.ts                       # git status --short: puste
# (b) usunięcie `test.skip(!preflight.ok, …)` ze spec-a
pnpm exec vitest run tests/isolation.test.ts
  × spec odbiorowy pomija proby na podstawie sprawdzenia wstepnego, zanim cokolwiek wysle
  Tests  1 failed | 23 passed (24)
git checkout -- e2e/bl01-bl02-model.spec.ts                      # status puste
pnpm exec vitest run tests/isolation.test.ts  →  Tests  24 passed (24)
```

## Bramka po dopisku (`41eea4b`)

| Polecenie | Wynik |
|---|---|
| `pnpm verify` | **exit 0** — 32 pliki / **542 testy** (+2 z tej rundy) |
| `pnpm check:module-swap` | **exit 0** |
| `flock … pnpm exec playwright test <19 speców niemodelowych>` | **exit 0** — **114 passed (6,3 min)** |

Żadnego spec-a modelowego nie uruchomiłem. `docs/evidence/bl01-bl02-2026-09-17/` nadal bit w bit jak na
`22d9b4d`; nieśledzone dowody cudzych speców po przebiegu usunięte; drzewo czyste.

## Co to zmienia w obawach

Obawa 2 jest domknięta w tej części, która była realnym kosztem: autoryzowany `pnpm test:e2e:model` na
zamkniętym grancie nie wyda już 22. tury — pominie próby i powie, czego brakuje. Sam sufit
(`MODEL_TURN_BUDGET = 22`) nadal jest decyzją koordynatora: żeby przebieg odbiorowy w ogóle ruszył,
potrzeba grantu na co najmniej 7 tur ponad rejestr (czyli sufitu ≥ 28 przy obecnym rejestrze 21).
Pozostałe obawy (1, 2-reszta, 3, 4) bez zmian.
