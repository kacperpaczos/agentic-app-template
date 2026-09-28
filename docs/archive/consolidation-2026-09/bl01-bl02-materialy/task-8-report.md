# Raport — Task 8: Próby odbiorowe z prawdziwym modelem (T25, T26, T27)

**Gałąź:** `bl01-bl02/t8-proby-model`, worktree `/home/paczos/Documents/agentic-app-template-wt/t8-proby-model`.
**BASE:** `00a88a7` (gałąź integracyjna po scaleniu Tasków 1–7).
**Rodzaj dowodu dla całego pliku `e2e/bl01-bl02-model.spec.ts`: rzeczywisty model** (subskrypcja Claude,
runtime aplikacji, build produkcyjny, instancja testowa suity przeglądarkowej).

| Commit | Temat |
|---|---|
| `c309002` | Detektor próby T25 wydzielony do `e2e/support/show-value-probe.ts` i spec prób odbiorowych (T25, T26, T27) |
| `492bfbc` | Odczyt wyniku narzędzia przez MCP (bloki treści) i rejestr tur modelu w dowodach |
| `962e24a` | Próby czytają **ostatnie** wywołanie narzędzia UI w wykonaniu i zapisują wszystkie próby zawężenia |
| `118c871` | T27: instancje wiązane z kartami, cel mutacji z odczytu z akcją, świadek braku przeładowania |
| `7132b95` | T27: powód nieudanej kompozycji nazwany w asercji i zapisany w dowodach |
| `d0083ca` | T27 wariant B: sprawa otwarta na ekranie użytkownika; dowody wariantu A zachowane |
| `d097d67` | T27: opis ekranu odczytywany aż do ustalenia, akcja rekordu z klawiatury |
| `6254625` | Dowody prób odbiorowych: T25 i T26 zaliczone, T27 częściowo z ustaleniami |

---

## 0. Wynik w jednym akapicie

**T25 — zaliczona** z prawdziwym modelem (`run_37fe29692e9f4a6e908e`). **T26 — zaliczona** z prawdziwym
modelem w trzech turach jednej rozmowy (`run_b2183264d0f549afb822`, `run_ee4f0a7e02bd430e8a3a`,
`run_722fe4ef7c434fb1a1b4`). **T27 — niezaliczona**: potwierdzony jest krok pierwszy (otwarcie przestrzeni,
zestawienie z rozmowy, nowe identyfikatory z badanego wykonania, wartości równe backendowi), krok drugi dał
**ustalenie o produkcie** (model obiecał wykres, którego karta nie narysowała, i nie sprawdził wyniku), a
kroki trzeci–piąty **pozostają niesprawdzone z prawdziwym modelem**, bo budżet 12 tur wyczerpał się na 11.
Budżet: **11 z 12 tur**, wszystkie zapisane w `docs/evidence/bl01-bl02-2026-09-17/tury-modelu.json`.

---

## 1. Co powstało

### 1.1 `e2e/support/show-value-probe.ts` (nowy) — jeden detektor próby T25

Brief wymaga, żeby odpowiedź tekstowa oblewała próbę T25 i żeby **nie wymyślać detektora na nowo**.
Detektor Taska 6 był lokalną funkcją `e2e/show-value.spec.ts`; przeniosłem go bez zmiany treści werdyktu do
modułu wspólnego i wpiąłem w oba spece. Powód jest merytoryczny, nie porządkowy: druga kopia byłaby drugą
definicją zaliczenia, a wtedy kontrola negatywna ze scenariusza skryptowanego przestałaby cokolwiek mówić
o przebiegu z prawdziwym modelem.

Eksportuje: `watchHighlights` / `highlights` (obserwator `data-ui-highlight` założony **przed** poleceniem —
podświetlenie żyje 2,6 s i jest obserwowane, nie odpytywane), `toolResults`, `resultOf`, `lastResultOf`,
`allResultsOf` oraz `notShown(page, runId, expected, baseUrl?)` → lista braków.

`e2e/show-value.spec.ts` zmniejszył się o 127 linii i woła detektor przez dwa cienkie opakowania wiążące
adres jego własnej instancji (port 8798). Treść jego ośmiu testów jest bez zmian.

**Dwie zmiany w samym detektorze — obie wymuszone przez pierwszy przebieg z prawdziwym modelem:**

- **`parseToolContent`.** `TOOL_CALL_RESULT` skryptowanego handlera niesie sam obiekt wyniku; ten sam
  handler wywołany przez model **przez MCP** niesie bloki protokołu `[{type:"text", text:"<json>"}]`.
  Detektor czyta oba przebiegi, więc rozpakowanie należy do niego. Pierwsza tura T25 oblała dokładnie na tym,
  przy aplikacji, która zrobiła wszystko dobrze (sekcja 5.1).
- **`lastResultOf` zamiast `resultOf` w `notShown`.** O tym, co wykonanie zostawiło na ekranie, decyduje jego
  **ostatnie** wywołanie narzędzia UI. Prawdziwy model dochodzi do wartości zawężenia próbując jej
  (sekcja 4.2), więc pierwsze `ui_filter`/`ui_show_value` wykonania, które kończy się poprawnie, może
  spokojnie nie trafić. W scenariuszach skryptowanych, gdzie wywołanie jest jedno, zmiana nic nie zmienia.

### 1.2 `e2e/bl01-bl02-model.spec.ts` (nowy, 1077 linii) — trzy próby na instancji wspólnej

Trzy niezależne testy (nie `mode: 'serial'` — awaria jednej próby nie może pominąć pozostałych i zabrać im
dowodu). Każde polecenie wysyłane z kompozytora czatu; asercje wyłącznie na DOM, adresie, potwierdzeniach
komend UI, opisach ekranu (`GET /api/ui/snapshot`), dzienniku wykonania (`GET /api/runs/:id/events`) i
backendzie (`POST /api/read`, trasy modułu). **Nigdzie nie ma asercji na brzmienie odpowiedzi.**

Elementy wspólne:

- **Rejestr tur na dysku** (`docs/evidence/bl01-bl02-2026-09-17/tury-modelu.json`). Budżet dotyczy zadania,
  nie procesu: powtórzenie próby po poprawce testu też kosztuje turę, a licznik zerowany przy każdym
  uruchomieniu ukrywałby właśnie to, co budżet ma ograniczać. `sendForRun` dopisuje turę **przed** wysłaniem,
  uzupełnia identyfikator wykonania po odpowiedzi i odmawia wysłania trzynastej.
- **`AppContext` czytany z wychodzącego żądania** (`page.waitForRequest('/api/agui/run')` →
  `postDataJSON().context`). „Polecenie niosło stan widoku" to zdanie o tym, co wyszło z przeglądarki, i
  tylko ciało żądania jest tu prawdziwe albo fałszywe.
- **`settled(page, runId)`** czeka na *to* wykonanie (pasek stanu niesie `data-run-id`), nie na dowolną fazę
  `succeeded`, która mogłaby zostać po poprzedniej turze.
- **`expectInstanceMatchesBackend` / `expectChartMatchesBackend`** — porównanie generyczne: opis instancji
  (`ui_state`) mówi, którą operację i z jakim wejściem komponent pokazuje, odczyt wykonuje się **z tego**
  opisu, a oczekiwanie liczy się z jego rekordów. Dzięki temu kontrola nie zależy od tego, czy model wybrał
  operację, kolumny i porządek, które wybrałby test, a ekran nigdy nie jest porównywany sam ze sobą.
  Predykaty zawężenia wylicza w teście własny, niezależny ewaluator (`keepsRecord`, `eq|neq|contains|in`),
  a nie `rowMatchesPredicate` aplikacji.
- **`describedOnAgentViews`** — opis ekranu jest publikowany z opóźnieniem i zawsze opisuje ekran taki, jaki
  był; odczytanie go zaraz po wejściu na stronę daje instancje **poprzedniego** ekranu. Czytany jest więc do
  ustalenia (wszystkie instancje poza `loading`, spełniony warunek kroku).
- **Dowody pisane w `finally`**, także dla przebiegu nieudanego, bez identyfikatorów sesji Claude, bez
  sekretów i bez ścieżek spoza repozytorium (sprawdzone `grep`-em).

---

## 2. Co zostało dowiedzione — próba po próbie

### 2.1 T25 — ZALICZONA (rzeczywisty model)

**Wykonanie:** `run_37fe29692e9f4a6e908e`, 47,0 s, pierwszy tekst po 20,4 s.
Narzędzia z dziennika wykonania: `ToolSearch`, `procurement_search`, `ToolSearch`, `ui_show_value`.
Dowód: `docs/evidence/bl01-bl02-2026-09-17/t25-wskazanie-wartosci.json`, zrzut `t25-wskazana-wartosc.png`.

Warunek wstępny ustawił **użytkownik kontrolką** na ekranie `/data`: `Kraj = PL`, przez co „NordAV OY" (FI)
zniknął z widoku — asercja `tbody tr[data-record-id=…]` = 0 przed poleceniem. Polecenie: *„Jaki NIP ma
dostawca NordAV OY?"* — pytanie, nie prośba o pokazanie.

Potwierdzone:

- **detektor T25 zwrócił pustą listę** — ten sam detektor, który w `e2e/show-value.spec.ts` (b) oblewa
  wykonanie odpowiadające samym tekstem;
- komórka `td[data-record-kind="supplier"][data-record-id=…][data-field="taxId"]` ma tekst `FI12345678`
  i jest w widocznym obszarze; podświetlenie zaobserwowane `MutationObserver`-em założonym przed poleceniem;
- **zawężenie, które ukrywało rekord, zniknęło z adresu** (`country` = null, parametry widoku puste), a pasek
  nad widokiem mówi użytkownikowi: „Pole „NIP”", nazwa rekordu, `filter_cleared`, „dane sa bez zmian";
- wynik narzędzia: `executed/found/shown/matchesBackend = true`, `target.viewId = procurement.data`,
  `backend.rawValue = revealed.rawValue = FI12345678`;
- **nowy kontekst potwierdza stan**: `uiVersion` z potwierdzenia = 3 > wersja z chwili wysłania polecenia
  (1); opis tej samej karty przeglądarki po wykonaniu ma wersję ≥ 3, `filter = []` i wszystkie cztery rekordy
  wśród widocznych;
- **dane backendu identyczne** przed i po (`POST /api/read procurement.suppliers`, `/api/m/procurement/suppliers`,
  `/api/m/procurement/cases`).

**Czego ten dowód nie obejmuje:** rekord był ukryty zawężeniem, ale nie był na dalszej stronie — zasiew
instancji wspólnej ma czterech dostawców przy `pageSize = 10`. Odsłonięcie przez **zmianę strony**
(`page_changed`) jest dowiedzione deterministycznie w `e2e/show-value.spec.ts` (a) na instancji z szesnastoma
dostawcami, nie z prawdziwym modelem.

### 2.2 T26 — ZALICZONA (rzeczywisty model, trzy tury jednej rozmowy)

Dowód: `docs/evidence/bl01-bl02-2026-09-17/t26-zawezenie-rozmowa.json`, zrzuty
`t26-zawezenie-i-sortowanie.png`, `t26-pelny-zakres.png`.

**Tura 1 — `run_b2183264d0f549afb822`** (52,7 s; `ui_filter`, `ui_filter`, `ui_sort`, `ui_state`).
Polecenie: *„Pokaz tylko polskich dostawcow, posortowanych po nazwie od Z do A."*

- wiersze = polscy dostawcy w malejącym porządku polskiej kolacji, policzonym **w teście** z odczytu
  backendu: `MediaPro Systemy`, `Konferencje24`, `AV Technika Sp. z o.o.`;
- adres: `country=PL`, `sort=-name`; **kontrolki zgodne**: `select[data-filter-field="country"]` = `PL`,
  nagłówek `name` `aria-sort="descending"`;
- pasek: „Widok zawezony przez agenta.", „Kraj (kod ISO): PL", „pokazane 3 z 4",
  „Sortowanie: Nazwa, malejaco.";
- ostatnie `ui_filter`: `executed: true, filtered {matched: 3, total: 4}`; ostatnie `ui_sort`:
  `sorted {field: name, direction: desc}`;
- **kontrola negatywna „zmiana danych zamiast filtra": dane backendu identyczne** przed i po — porównane
  dwoma niezależnymi świadkami (`POST /api/read` i trasy modułu `/api/m/procurement/*`).

**Tura 2 — `run_ee4f0a7e02bd430e8a3a`** (41,0 s; `ui_show_value`, `ui_show_value`).
Polecenie: *„Ktory dostawca jest teraz na pierwszym miejscu tej listy i jaki ma NIP?"*

Ta tura jest zaprojektowana tak, żeby „kolejne pytanie korzysta z zawężenia" dało się rozstrzygnąć **na
ekranie, a nie w słowach**: rekord, który trzeba wskazać, to pierwszy wiersz *zawężonego i przestawionego*
widoku. Agent, który zignorowałby stan, sięgnąłby po inny rekord — lista niezawężona zaczyna się od innego
dostawcy. Potwierdzone:

- `AppContext.filters['procurement.data']` w wychodzącym żądaniu **dokładnie** równe
  `{predicates:[{country,eq,PL}], sort:{name,desc}, page:{1,10,1}, matched:3, total:4}`;
- **detektor T25 zwrócił pustą listę dla `MediaPro Systemy`** — wskazana została komórka NIP-u pierwszego
  wiersza zawężonego widoku;
- `adjustments = []` — niczego nie trzeba było zdejmować, bo rekord **mieści się w zawężeniu**; adres po
  turze nadal `country=PL`, `sort=-name`, te same trzy wiersze;
- dane backendu nadal identyczne.

**Tura 3 — `run_722fe4ef7c434fb1a1b4`** (14,0 s; `ui_filter`).
Polecenie: *„Usun zawezenie i pokaz z powrotem wszystkich dostawcow."* → `country` zniknął z adresu, cztery
wiersze = pełny zbiór backendu, `select` wrócił do „wszystkie", licznik „pokazane X z Y" zniknął,
`sort=-name` został (użytkownik prosił o zdjęcie zawężenia, nie porządku). Dane backendu identyczne.

**Czego ten dowód nie obejmuje:** kontrola „pusty zbiór nie jest przedstawiony jako błąd" nie ma osobnej
tury — jest dowiedziona deterministycznie w `e2e/view-state.spec.ts` (e). Przy okazji jednak **prawdziwy
model wszedł w ten stan sam** (sekcja 4.2): `ui_filter` z wartością `Poland` odpowiedział
`executed: true, matched: 0, total: 4` — zastosowane zawężenie i liczba, nie błąd — i agent się poprawił.

### 2.3 T27 — NIEZALICZONA (jeden krok potwierdzony, jedno ustalenie, trzy kroki niesprawdzone)

Dowody: `t27-proba-a-kod-sprawy-jako-id.json` (wariant A), `t27-widoki-agenta.json` (wariant B),
zrzut `t27-zestawienie.png`.

#### Wariant A (dwie próby, obie niezaliczone) — ustalenie o rozwiązywaniu identyfikatorów

Polecenie: *„Zestaw mi w widokach agenta pozycje ofert ze sprawy PC-2026-01: dostawca, nazwa pozycji i cena
jednostkowa."*, wysłane z ekranu startowego.

| Próba | Wykonanie | Narzędzia | Co złożył model | Skutek |
|---|---|---|---|---|
| 1 | `run_39bc79cc133d4bce8fcc` | `agent_view_create` | `input: {caseId: "PC-2026-01"}` | `POST /api/read` → 404 `not_found` |
| 2 | `run_24132e16b1cf49a9a624` | `ToolSearch`, `agent_view_create` | `input: {caseId: "PC-2026-01"}` | instancja `forbidden`, `error.code = not_found` („Sprawa PC-2026-01 nie istnieje."), 0 wierszy |

Dwa razy pod rząd model wstawił **kod sprawy w miejsce jej identyfikatora** i **nie wykonał wcześniej
żadnego odczytu ani wyszukania modułu** — poszedł prosto do `agent_view_create`. Zgodnie z briefem nie
powtarzałem tego samego scenariusza trzeci raz.

**Platforma zachowała się poprawnie**: walidator sprawdza schemat, nie istnienie rekordu (AD-3, kontrakt
Taska 4 — „propsy niosą referencje, odmowa dostępu przychodzi przy odczycie"), odczyt odmówił, a karta
pokazała odmowę zamiast zmyślonych wartości. **Brak jest po stronie promptu**: sekcja „## Pokazanie wartosci
pola rekordu" mówi wprost „znajdz rekord i jego identyfikator narzedziem modulu", a sekcja o widokach agenta
nie mówi tego o `source.input`.

#### Wariant B (scenariusz inny, nie powtórzenie) — użytkownik ma sprawę otwartą na ekranie

Żeby zbadać **pozostałą część** kryterium T27, a nie jeszcze raz to samo, przeniosłem punkt wyjścia: użytkownik
otwiera „Widoki agenta" z nawigacji (stan `no-conversation`), przechodzi na ekran sprawy przez „Wszystkie
sprawy" → kafelek, i stamtąd wysyła polecenie *„Zestaw mi w widokach agenta pozycje ofert tej sprawy…"*.

**Krok 1 — potwierdzony z prawdziwym modelem** (`run_0de7b080d1764c2fbcca`, 26,1 s; `agent_view_create`):

- mając sprawę na ekranie, model złożył kompozycję z **prawdziwym identyfikatorem**
  (`input: {caseId: "pcs_88524ec47ef94db1aaf3"}`) — to samo polecenie co w wariancie A, inny wynik, więc
  ustalenie z wariantu A dotyczy rozwiązywania identyfikatora, nie samego komponowania;
- karta ma **nowy identyfikator z badanego wykonania** (`crd_8d0f90ea401c472dabb0` z wyniku
  `agent_view_create`); **każda** karta w przestrzeni rozmowy pochodzi z tego wykonania (zastana karta by nie
  zaliczyła — G6);
- przestrzeń rozmowy nie jest przestrzenią roboczą użytkownika, a adres i `s` użytkownika są po wykonaniu bez
  zmian;
- zestawienie powstało **bez nazwy komponentu w poleceniu**; tabela w stanie `ready`, 16 wierszy,
  **każda komórka równa `POST /api/read`** dla źródła instancji, a opis instancji (`ui_state`) wymienia te
  same rekordy w kolejności z ekranu.

**Krok 2 — ustalenie o produkcie** (`run_96c52b19607e4a21a589`, 25,7 s; `agent_views_list`,
`agent_view_update`). Polecenie: *„Dodaj do tego wykres cen jednostkowych tych pozycji."*

Model dopisał do swojej karty
`wykres = DataChart({operation: "procurement.case_offer_items", input: {caseId: …}}, "bar", "name", ["unitPriceMinor"], "Ceny jednostkowe pozycji ofert")`.
Walidator serwera **przyjął** kompozycję (pole liczbowe, zadeklarowane, operacja zarejestrowana) i narzędzie
odpowiedziało sukcesem. Na ekranie instancja `DataChart` jest w stanie **`error`**:

> „Seria Cena jednostkowa laczy rozne jednostki (PLN, EUR); zawez dane do jednej jednostki."

Pozycje tej sprawy są wycenione w PLN i w EUR, a seria pieniężna niesie walutę rekordu — komponent słusznie
odmawia narysowania obrazka, który byłby kłamstwem. Model odpowiedział użytkownikowi: **„Dodano wykres
słupkowy cen jednostkowych do widoku."** — czyli oznajmił sukces, nie oglądając wyniku.

To są **dwa braki, widoczne tylko z prawdziwym modelem**:

1. walidacja kompozycji przyjmuje serię pieniężną, której jednostka nie jest jednolita **w danych**, więc
   odmowa przychodzi dopiero przy rysowaniu, a narzędzie zwraca sukces;
2. sekcja promptu „## Stan ekranu" nakazuje `ui_state` po `ui_navigate`/`ui_filter`/`ui_sort`, **ale nie po**
   `agent_view_create`/`agent_view_update`, a wynik tych narzędzi nie mówi nic o tym, co karta narysowała —
   model nie ma z czego się dowiedzieć, że obiecał wykres, którego nie ma.

Test **oblewa w tym miejscu celowo**; powód jest zapisany komentarzem w speku i w pliku dowodu.

**Czego T27 nie obejmuje (niesprawdzone z prawdziwym modelem):**

- **krok 3** — zmiana zakresu zestawienia rozmową;
- **krok 4** — mutacja danych akcją rekordu i odświeżenie widoku agenta bez przeładowania;
- **krok 5** — przeładowanie i odtworzenie kart z wartościami z backendu.

Kod tych kroków jest napisany i przetestowany typami, ale nie został wykonany: budżet 12 tur zatrzymał się na
11, a pełne powtórzenie próby T27 kosztuje 3. Deterministycznie te same trzy kroki są dowiedzione bez modelu
w `e2e/agent-views.spec.ts` (patch zmienia zakres, druga karta i przesunięcie użytkownika zostają;
przeładowanie i przełączanie rozmów odtwarzają widoki właściwej rozmowy) oraz `e2e/interactions.spec.ts`
(a)–(c) (zmiana ceny akcją na ekranie sprawy i w widoku agenta widoczna w karcie bez przeładowania).

---

## 3. Budżet tur — pełny rejestr

`docs/evidence/bl01-bl02-2026-09-17/tury-modelu.json`, **11 z 12**:

| # | Próba | Wykonanie | Polecenie | Wynik |
|---|---|---|---|---|
| 1 | T25 | `run_e3f0eb8de955422387a8` | „Jaki NIP ma dostawca NordAV OY?" | aplikacja OK, **test oblał własnym błędem** (5.1) |
| 2 | T25 | `run_37fe29692e9f4a6e908e` | jw. | **zaliczona** |
| 3 | T26 | `run_b1b0125692144790afbf` | „Pokaz tylko polskich dostawcow…" | ekran poprawny, **test oblał własnym błędem** (5.2) |
| 4 | T26 | `run_b2183264d0f549afb822` | jw. | zaliczona |
| 5 | T26 | `run_ee4f0a7e02bd430e8a3a` | „Ktory dostawca jest teraz na pierwszym miejscu…" | zaliczona |
| 6 | T26 | `run_722fe4ef7c434fb1a1b4` | „Usun zawezenie…" | zaliczona → **T26 zaliczona** |
| 7 | T27 A | `run_39bc79cc133d4bce8fcc` | „…ze sprawy PC-2026-01…" | **ustalenie**: kod sprawy jako identyfikator |
| 8 | T27 A | `run_24132e16b1cf49a9a624` | jw. (próba 2 z 2) | **ustalenie** powtórzone |
| 9 | T27 B | `run_443631b2fddf406eaf31` | „…pozycje ofert tej sprawy…" | model OK (prawdziwy id), **test oblał własnym błędem** (5.3) |
| 10 | T27 B | `run_0de7b080d1764c2fbcca` | jw. | **krok 1 potwierdzony** |
| 11 | T27 B | `run_96c52b19607e4a21a589` | „Dodaj do tego wykres…" | **ustalenie**: wykres w stanie `error`, model oznajmił sukces |

Trzy z jedenastu tur (1, 3, 9) poszły na błędy **testu**, nie aplikacji — w każdym przypadku produkt zrobił
to, czego wymagało kryterium, i mam na to zapis z dziennika wykonania. Każda z tych trzech odsłoniła realną
różnicę między przebiegiem skryptowanym a prawdziwym, której nie dało się przewidzieć z kodu
(sekcja 5); poprawki są wspólne dla obu ścieżek.

---

## 4. Ustalenia o produkcie z przebiegów, które przeszły

### 4.1 Agent sięga po `ui_show_value`, gdy użytkownik pyta o wartość

W obu przebiegach, w których padło pytanie o NIP (T25 i T26 tura 2), model najpierw ustalił rekord
(`procurement_search` albo z kontekstu zawężonego widoku), a potem wywołał `ui_show_value`. Odpowiedź tekstem
bez wskazania — czyli to, co reguła promptu Taska 6 miała wyeliminować — **nie wystąpiła ani razu**.

### 4.2 Model nie zna dozwolonych **wartości** pola zawężania i dochodzi do nich próbami

Wszystkie trzy przebiegi T26 tury 1 zaczęły od wartości słownej:

- tura 3 rejestru: `country=Polska` (matched 0) → `agent_view_create` + `ui_navigate` na Widoki agenta,
  żeby **zobaczyć kraje** → powrót → `country=Poland` (matched 0) → `country=PL` (matched 3). 138 s,
  17 wywołań narzędzi;
- tura 4 rejestru: `country=Poland` (matched 0) → `country=PL` (matched 3). 53 s, 4 wywołania.

Prompt i `ui_catalog` podają **nazwy** pól zawężania (`filterableFields`), nie ich zadeklarowane wartości
(`UiTarget.filter.fields[].values`), choć kontrolka na ekranie rysuje z nich listę wyboru. To kosztuje tury i
czas, a użytkownik widzi po drodze pusty widok. Zmiana jest jednolinijkowa po stronie wyniku `ui_catalog` i
linii celu w prompcie — **nie robiłem jej**, bo to zmiana kontraktu narzędzia poza zakresem Taska 8
(NEEDS_CONTEXT dla koordynatora).

Przy okazji: zachowanie platformy w tym stanie jest **poprawne i jest realnym dowodem kontroli negatywnej
T26** — `ui_filter` z wartością bez dopasowań odpowiada `executed: true, filtered {matched: 0, total: 4}`,
czyli „zastosowane, tyle zostało", a nie błędem.

### 4.3 `not_found` odczytu pokazuje się jako stan `forbidden` instancji

Celowe (`isAccessFailure` w `DataFrame.tsx` traktuje `forbidden | not_found | unauthenticated` jednakowo, żeby
ekran nie zdradzał, czy cudzy rekord istnieje). Odnotowuję, bo w opisie semantycznym instancji `state` mówi
`forbidden`, a `error.code` mówi `not_found` — czytający opis (także model) musi wiedzieć, że to nie
sprzeczność. Sam komunikat modułu („Sprawa PC-2026-01 nie istnieje.") jest w tym miejscu bardziej rozmowny
niż stan, ale to treść modułu, nie platformy.

---

## 5. Nieudane przebiegi i ich wyjaśnienie

### 5.1 Tura 1 (T25) — wynik narzędzia przez MCP ma inny kształt niż skryptowany

Detektor czytał `JSON.parse(payload.content)` i dostał tablicę bloków `[{type:"text", text:"…"}]` zamiast
obiektu, więc zgłosił pięć braków przy wyniku `ui_show_value` = `{executed, found, shown, matchesBackend: true,
adjustments:[filter_cleared], highlighted: true, uiVersion: 3}`. **Aplikacja zrobiła wszystko dobrze.**
Poprawka: `parseToolContent` w module wspólnym (commit `492bfbc`). Skryptowane spece nie mogły tego wykryć —
ich `content` jest obiektem; to różnica, którą widzi wyłącznie przebieg z prawdziwym modelem.

### 5.2 Tura 3 (T26) — test czytał **pierwsze** `ui_filter` wykonania

Ekran po turze był poprawny (wiersze, adres, kontrolki, pasek — wszystkie asercje przed tą jedną przeszły),
ale asercja na wynik narzędzia patrzyła na pierwsze z czterech wywołań, czyli na `country=Polska`
(matched 0). Poprawka: `lastResultOf` + zapis **wszystkich** prób zawężenia i porządku do dowodu
(commit `962e24a`), więc raport pokazuje drogę modelu, a nie tylko jej koniec.

### 5.3 Tura 9 (T27 B) — opis ekranu odczytany, zanim nadążył za nawigacją

Po `openAgentViews` test odczytał opublikowany opis natychmiast i dostał instancje **ekranu sprawy**, na
którym publikacja została złożona; na stronie Widoków agenta nie było wtedy żadnej opisanej instancji.
Karta, kompozycja i dane były poprawne (model użył prawdziwego identyfikatora sprawy). Poprawka:
`describedOnAgentViews` czyta opis do ustalenia (commit `d097d67`). Ta sama pomyłka czaiła się w krokach 2,
3, po mutacji i po przeładowaniu — poprawiona we wszystkich pięciu miejscach.

### 5.4 Tury 7 i 8 (T27 A) — to **nie** jest błąd testu

Opisane w 2.3. Zgodnie z briefem: dwie próby, obie w raporcie, bez trzeciej.

---

## 6. Kontrole negatywne

### 6.1 Wykonane w tym zadaniu, na przebiegach z prawdziwym modelem

| Kontrola | Gdzie | Wynik |
|---|---|---|
| odpowiedź tekstowa nie zalicza T25 | detektor `notShown` na `run_37fe29692e9f4a6e908e` i `run_ee4f0a7e02bd430e8a3a` | lista braków pusta **tylko** dlatego, że `shown`, `matchesBackend`, podświetlenie i widoczność komórki są prawdziwe |
| zmiana danych zamiast filtra (T26) | `POST /api/read` + `/api/m/procurement/*` przed i po każdej z trzech tur | dane identyczne |
| usunięcie zawężenia przywraca pełny zakres (T26) | tura 3 | 4 wiersze = pełny zbiór backendu, `country` poza adresem |
| kolejne pytanie **musi** użyć zawężenia (T26) | wskazany rekord = pierwszy wiersz *zawężonego i przestawionego* widoku, nie listy pełnej | zaliczone |
| zastana karta nie zalicza T27 | każda karta w przestrzeni rozmowy musi mieć identyfikator z wyniku `agent_view_create` **badanego wykonania** | zaliczone (`crd_8d0f90ea401c472dabb0`) |
| wartości równe backendowi, nie tekstowi (T27) | 16 wierszy × 3 kolumny porównane z `POST /api/read` źródła instancji | zaliczone |
| zadanie w tle nie przejmuje aktywnego ekranu (T27) | przestrzeń rozmowy ≠ przestrzeń robocza, `s` i adres użytkownika bez zmian po wykonaniu | zaliczone |
| kompozycja, której nie da się narysować, nie udaje, że pokazuje dane | krok 2 wariantu B | instancja w stanie `error` z powodem — **kontrola zadziałała**, oblała natomiast obietnica modelu |

### 6.2 Deterministyczne — wskazane, nie powtarzane turami (zgodnie z briefem)

| Kryterium | Spec | Test |
|---|---|---|
| odpowiedź tekstowa oblewa detektor T25 | `e2e/show-value.spec.ts` | (b) „kontrola detektora T25…" |
| błędny rekord → `record_not_found`, ekran nietknięty | `e2e/show-value.spec.ts` | (c) |
| niejednoznaczność → `ambiguous` bez zmiany ekranu | `e2e/show-value.spec.ts` | (d) |
| brak dostępu → `forbidden`, ekran nietknięty | `e2e/show-value.spec.ts` | (e) |
| odsłonięcie przez zmianę **strony** | `e2e/show-value.spec.ts` | (a) |
| pusty zbiór to stan „0 z N", nie błąd; wyczyszczenie przywraca zakres | `e2e/view-state.spec.ts` | (e) |
| odmowa sortowania (pole nieznane / niesortowalne), widok nietknięty | `e2e/view-state.spec.ts` | (e) |
| stan widoku w kolejnym poleceniu (`AppContext.filters`) | `e2e/view-state.spec.ts` | (a)+(d) |
| `ui_state`: `stale`, `no_client`, `other_conversation`, wersje kart | `e2e/ui-state.spec.ts` | 9 testów |
| nieznany komponent, wykres z wpisanymi liczbami, niezarejestrowana operacja | `e2e/agent-views.spec.ts` | „nieznany komponent…" |
| **zadanie w tle nie przejmuje ekranu innej rozmowy** | `e2e/agent-views.spec.ts` | „wykonanie rozmowy A … adres i ekran B bez zmian" |
| zmiana zakresu patchem; druga karta i przesunięcie użytkownika zostają | `e2e/agent-views.spec.ts` | „patch zmienia grupowanie…" |
| przeładowanie i przełączanie rozmów odtwarzają widoki | `e2e/agent-views.spec.ts` | „przeladowanie i przelaczanie rozmow…" |
| mutacja → odświeżenie widoku agenta **bez przeładowania** | `e2e/interactions.spec.ts` | (a), (b), (c) |
| akcja cudzej sesji odrzucona; nieudane odświeżenie pokazuje błąd, nie stare wartości | `e2e/interactions.spec.ts` | dwie kontrole negatywne |

### 6.3 Próba zdolności wykrycia (procedura z `dispatch-common.md`)

Na zacommitowanym kodzie, `git status --short` puste przed i po:

```
# wycofanie: w e2e/support/show-value-probe.ts
-  if (marked.length === 0) problems.push('zadna komorka tego rekordu i pola nie zostala podswietlona');
+  if (false) problems.push('zadna komorka tego rekordu i pola nie zostala podswietlona');

flock … pnpm exec playwright test e2e/show-value.spec.ts -g "kontrola detektora T25"
  1 failed  (show-value.spec.ts:270 — expect(problems).toContain('zadna komorka … podswietlona'))

git checkout -- e2e/support/show-value-probe.ts
git status --short            → puste
flock … pnpm exec playwright test e2e/show-value.spec.ts -g "kontrola detektora T25"
  1 passed (9.6s)
```

Detektor, który przestaje wymagać podświetlenia, natychmiast przestaje odróżniać wykonanie wskazujące
wartość od wykonania, które tylko o niej mówi — i ten sam detektor wydał werdykt dla przebiegów z prawdziwym
modelem. **Czego ta próba nie pokrywa:** `parseToolContent` (5.1) jest niewykrywalne bez tury subskrypcji —
w scenariuszu skryptowanym treść wyniku jest obiektem, więc wycofanie rozpakowania niczego nie oblewa.
Mówię to wprost, zamiast udawać próbę.

---

## 7. Polecenia, kody wyjścia, liczby testów

| Polecenie | Wynik |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0 |
| `pnpm verify` | **exit 0**; Vitest **31 plików / 526 testów**, wszystkie zielone |
| `flock … playwright test e2e/show-value.spec.ts` | **8 passed** (31,8 s) — po wydzieleniu detektora |
| `flock … playwright test e2e/bl01-bl02-model.spec.ts -g "T25"` | **1 passed** (49,3 s) — rzeczywisty model |
| `flock … playwright test e2e/bl01-bl02-model.spec.ts -g "T26"` | **1 passed** (1,9 min) — rzeczywisty model |
| `flock … playwright test e2e/bl01-bl02-model.spec.ts -g "T27"` | **1 failed** (57,2 s) — ustalenie z 2.3, celowe |
| `flock … playwright test e2e/show-value.spec.ts -g "kontrola detektora T25"` | wycofanie → **1 failed**; po `git checkout` → **1 passed** |

Nie uruchamiałem pełnej suity (`pnpm test:e2e`) ani `e2e/agent-ui.spec.ts` / `e2e/files-agent.spec.ts` — G4
i budżet. Każdy przebieg pod `flock /home/paczos/Documents/agentic-app-template-wt/.e2e.lock`, po `pnpm build`.

---

## 8. Zmienione pliki (`00a88a7..HEAD`: 13 plików, +1756 / −111)

| Plik | Zmiana |
|---|---|
| `e2e/support/show-value-probe.ts` | **nowy**, 188 linii — detektor próby T25 wspólny dla obu speców |
| `e2e/bl01-bl02-model.spec.ts` | **nowy**, 1077 linii — trzy próby z prawdziwym modelem |
| `e2e/show-value.spec.ts` | −127/+16 — detektor z modułu wspólnego, dwa opakowania wiążące własny adres |
| `docs/evidence/bl01-bl02-2026-09-17/*` | README, 5 plików JSON (w tym rejestr tur), 4 zrzuty ekranu |

Nie tknąłem żadnego pliku produkcyjnego. Dokumentów prowadzonych przez koordynatora (G8) nie zmieniałem.

---

## 9. Decyzje tam, gdzie brief zostawił wybór

**9.1 Detektor przeniesiony, nie skopiowany.** Brief mówi „reuse it, do not re-invent". Import z pliku speca
do speca jest w Playwright legalny, ale robi z `show-value.spec.ts` bibliotekę; wydzielenie do `support/` jest
tym samym ruchem, którym repozytorium trzyma `scripted-agent.ts` czy `streamProbe.ts`.

**9.2 Rejestr tur na dysku.** Alternatywą był licznik w procesie. Ponieważ próby uruchamiałem osobno (żeby
awaria jednej nie kasowała budżetu pozostałych), licznik w procesie liczyłby od zera przy każdym
uruchomieniu i budżet nie byłby egzekwowany, tylko deklarowany.

**9.3 Trzy niezależne testy zamiast `mode: 'serial'`.** Serial pominąłby T26 i T27 po awarii T25 — a brief chce
uczciwego wyniku cząstkowego dla każdej próby z osobna.

**9.4 T26 tura 2 rozstrzygana wskazaniem, nie słowami.** Kryterium dopuszcza „model wywołuje `ui_state` **albo**
odpowiada o zawężonym zbiorze". Druga możliwość jest niesprawdzalna bez asercji na brzmienie, a pierwsza
zależy od wyboru narzędzia. Dlatego pytanie jest tak dobrane, że poprawna obsługa **musi** zmienić ekran:
wskazany zostaje NIP pierwszego wiersza zawężonego i przestawionego widoku. To silniejszy dowód niż
obecność wywołania `ui_state` w dzienniku.

**9.5 Mutacja w T27 wykonywana z GUI, nie narzędziem modelu.** Akcję rekordu (Task 7) klika użytkownik —
w karcie widoku agenta, jeśli jej odczyt deklaruje akcję, a w przeciwnym razie na ekranie sprawy. Nie kosztuje
tury, a funkcją badaną jest odświeżenie widoku, nie samo wywołanie narzędzia. Świadek braku przeładowania to
znacznik w `window` założony przed zmianą. Przywrócenie ceny z zasiewu idzie przez `POST /api/actions`
(sprzątanie, nie dowód) — ekran, na którym akcję wykonano, może już nie istnieć.

**9.6 Wariant B próby T27 jako osobny scenariusz, nie trzecia próba wariantu A.** Wariant A ustalił, że model
myli kod z identyfikatorem; powtarzanie go nie dodałoby nic. Wariant B bada **inną** część kryterium
(komponowanie, rysowanie, trwałość przestrzeni rozmowy) przy punkcie wyjścia, w którym identyfikator jest na
ekranie użytkownika. Oba warianty są w raporcie i w dowodach.

**9.7 Porównanie z backendem generyczne.** Test nie zakłada, jaką operację i jakie kolumny wybierze model —
czyta to z opisu instancji i porównuje każdą narysowaną komórkę z odczytem tego właśnie źródła. Inaczej próba
mierzyłaby zgodność modelu z gustem autora testu, a nie zgodność ekranu z danymi.

---

## 10. Kontrakt dla autora modułu

Moduł **nie deklaruje nic nowego** — to zadanie nie dodało kontraktu. Co wynika z niego dla piszącego moduł:

- **Pole zawężania z listą wartości** (`UiTarget.filter.fields[].values`) rysuje listę wyboru w kontrolce, ale
  agent widzi dziś tylko **nazwę** pola. Jeśli wartości są kodami (`PL`, `FI`), licz się z tym, że model
  dojdzie do nich próbami — albo opisz je w `UiTarget.filter.fields[].label`/opisie celu, dopóki `ui_catalog`
  ich nie podaje (4.2).
- **`source.input` kompozycji musi nieść identyfikator rekordu, nie jego kod biznesowy.** Walidator sprawdza
  schemat wejścia, nie istnienie rekordu; niepoprawna referencja staje się kartą, która pokazuje odmowę
  odczytu. Jeśli moduł ma czytelny kod (`PC-2026-01`), warto dać narzędzie rozwiązujące kod → identyfikator,
  bo model sięgnie po kod (2.3).
- **Seria pieniężna z `unitField` wymaga jednolitej jednostki w danych, które trafiają na wykres.** Odczyt
  zwracający rekordy w kilku walutach da `DataChart` w stanie `error` („laczy rozne jednostki"), mimo że
  kompozycja jest poprawna. Jeśli operacja może zwrócić kilka walut, przewidź, że wykres nad nią wymaga
  zawężenia do jednej — albo udostępnij odczyt już ujednolicony (4.3, 2.3).
- **Deskryptor z `actions` daje akcję w każdej tabeli nad tym odczytem** — również w karcie widoku agenta
  złożonej przez model. To właśnie dzięki temu mutacja w próbie T27 może być zrobiona z GUI, bez tury
  subskrypcji.
- **Dla piszącego testy odbiorowe:** werdykt „wartość została pokazana" jest jeden i mieszka w
  `e2e/support/show-value-probe.ts` (`notShown`). Wynik narzędzia czytaj przez `toolResults` z tego modułu —
  rozpakowuje bloki treści MCP, których skryptowany handler nie produkuje. O tym, co wykonanie zostawiło na
  ekranie, mówi `lastResultOf`, nie `resultOf`.

---

## 11. Self-review — ustalenia

1. **Pierwsza wersja `notShown` w nowym module miała podwójną definicję zaliczenia.** Gdybym zostawił kopię
   w speku, kontrola negatywna (b) pilnowałaby kopii, a przebieg z prawdziwym modelem — oryginału. Poprawione
   zanim cokolwiek uruchomiłem.
2. **`expect(state1.cards.map(id)).toEqual(created1)` było zbyt sztywne** — wykonanie, które utworzy i usunie
   kartę, oblałoby na porządku, a nie na treści kryterium. Zamienione na „każda karta w przestrzeni pochodzi
   z tego wykonania", czyli dokładnie na zdanie z G6.
3. **Porównanie z backendem początkowo zakładało operację `procurement.case_offer_items`.** To by znaczyło, że
   test wymaga od modelu wyboru, którego kryterium nie wymaga. Przerobione na czytanie źródła z opisu
   instancji.
4. **`instancesOnAgentViews`** dodane po zauważeniu, że opis ekranu obejmuje też tabelę wstawioną w odpowiedź
   czatu — taka tabela nie jest kartą i nie może ani zaliczyć, ani oblać próby T27.
5. **Zrzuty ekranu nie są dowodem przebiegu w czasie** (ARCHITECTURE.md „Jakość testów") — wszystkie
   twierdzenia o strumieniu, podświetleniu i odświeżeniu opierają się na obserwatorach i dzienniku wykonania;
   zrzuty są tylko ilustracją stanu końcowego.
6. **Nie zweryfikowałem, czy `pnpm test:e2e` jako całość przechodzi** — nie wolno mi (G4) i kosztowałoby to
   tury. Mój spec w pełnym przebiegu wyda **9 tur** (3+3+3) i obecnie zakończy się jedną porażką T27.

---

## 12. Obawy

1. **T27 nie ma dowodu „rzeczywisty model" dla kroków 3–5.** To główny brak tego zadania. Do zamknięcia
   potrzeba 3 tur ponad budżet Taska 8 — decyzja koordynatora.
2. **Test T27 zostaje w repozytorium jako czerwony.** Świadomie: próba, która dokumentuje niespełnione
   kryterium, musi oblewać. Powód jest opisany komentarzem w speku i w pliku dowodu, żeby nikt nie wziął tego
   za niestabilność. Jeśli koordynator woli mieć zieloną gałąź, alternatywą jest `test.fixme` z tym samym
   opisem — nie zrobiłem tego sam, bo to ukrywa wynik odbioru.
3. **Cena pełnej suity rośnie.** `e2e/bl01-bl02-model.spec.ts` dokłada do `agent-ui.spec.ts` i
   `files-agent.spec.ts` kolejne 9 tur na przebieg. Jeśli odbiór ma powtarzać pełne `pnpm test:e2e`, warto to
   policzyć zawczasu.
4. **Dwa ustalenia z sekcji 2.3 i 4.2 dotykają promptu i walidatora**, czyli kodu Tasków 3, 4 i 6. Nie
   dotykałem go — Task 8 jest zadaniem dowodowym. Rekomendacje: (a) `ui_catalog` podaje wartości pól
   zawężania; (b) sekcja promptu o widokach agenta mówi, że identyfikator rekordu ustala się narzędziem
   modułu; (c) po `agent_view_create`/`agent_view_update` model czyta `ui_state` — albo wynik tych narzędzi
   niesie stan zamontowanych instancji karty.
5. **Instancja wspólna a dane.** Próba T27 (krok 4) zmienia cenę pozycji oferty i przywraca ją w `finally`.
   W przebiegach, które wykonałem, do mutacji nie doszło, więc baza `.e2e-data` jest w stanie zasiewu — ale
   przy pełnym przebiegu warto pamiętać, że `e2e/app.spec.ts` sprawdza literalną sumę `49 830,00 PLN`.
   Przywracanie idzie przez `POST /api/actions`, a kolejność plików w suicie stawia `app.spec.ts` przed moim.
6. **Zasiew instancji wspólnej jest mały** (4 dostawców, 1 sprawa), więc próba T25 nie mogła pokazać
   odsłonięcia przez zmianę strony, a T26 działa na trzech wierszach. Zwiększanie zasiewu wspólnej bazy
   z poziomu jednego speca uznałem za zbyt ryzykowne dla pozostałych speców tej instancji.

---

# T27 — dokończenie (po scaleniu Task 9)

Gałąź integracyjna `9c3d750` scalona do `bl01-bl02/t8-proby-model` (`b96f64e`, bez konfliktów).
`pnpm verify` po scaleniu: **exit 0**, Vitest **31 plików / 529 testów**.

| Commit | Temat |
|---|---|
| `b96f64e` | Scalenie `bl01-bl02/integracja` (Task 9) |
| `e07fe47` | Dokończenie próby T27: scenariusz z kodem sprawy, kroki 4–5, nowe pola wyniku w dowodach |
| `30aaf8f` | Wartości wykresu oceniane po ustaleniu zakresu rozmową; usunięta martwa referencja |
| `d986b89` | Odczyt opisu ekranu odporny na opis wycofany przeładowaniem; test kroków 5–6 |
| `15c8994` | Przycisk „New chat” z nagłówka czatu; dowody kroków 5–6 |

**Budżet: 6 z 6 tur wykorzystane** (tury 12–17 w `tury-modelu.json`; licznik pliku to 17 z 18, bo obejmuje
12 tur Taska 8). Dwie próby scenariusza, zgodnie z limitem.

## Czy poprawki Task 9 zmieniły zachowanie modelu — tak, i widać to co do tury

| Ustalenie | Przed Task 9 | Po Task 9 |
|---|---|---|
| **F1** identyfikator z odczytu | `run_39bc79cc133d4bce8fcc`, `run_24132e16b1cf49a9a624`: **prosto** do `agent_view_create` z `input: {caseId: "PC-2026-01"}` (kod sprawy), zero odczytów | **`run_3e583d1184894cb2b1d4`**, `run_335ba5ea2b1a47cfb046`, `run_9411a0c692a04d8f822c`: `procurement_search` → `agent_view_create` z prawdziwym `pcs_…` |
| **F2** zapisane ≠ narysowane | `run_96c52b19607e4a21a589`: `agent_views_list` → `agent_view_update` → **koniec**; użytkownik usłyszał „Dodano wykres słupkowy cen jednostkowych do widoku.", a wykres był w stanie `error` | **`run_3213d8f04366476f91d7`**: `agent_views_list` → `agent_view_update` (wynik `rendered: false`, `warnings: ["unit_from_record"]`) → **`ui_state`** → odpowiedź: „wykres nie mógł się narysować, bo pozycje zawierają różne waluty (PLN i EUR)" + trzy propozycje i pytanie, który wariant wybrać |
| **F3** wartości pola zawężania | (T26, Task 8) `country=Polska` → `country=Poland` → `country=PL`; 138 s i 17 wywołań | poza zakresem tego dokończenia — nie wydawałem tury na powtórzenie T26 |

F1 i F2 są potwierdzone **w scenariuszu, w którym pękły**. F2 działa dokładnie tak, jak zaprojektowano:
model czyta ekran po zapisie i **nie obiecuje** wykresu, którego nie ma — a że dane sprawy są w dwóch
walutach, pyta użytkownika o zawężenie. To nie jest obejście kryterium, tylko jego druga połowa: T27
wymaga „dodania wykresu **i zmiany zakresu rozmową**", więc odpowiedź na to pytanie jest kolejnym krokiem
próby. Dlatego w drugim podejściu trzecia tura brzmi *„Zawez zestawienie i wykres do pozycji w PLN."*

## Co jest teraz dowiedzione — krok po kroku

Przebieg główny (druga próba scenariusza): `run_335ba5ea2b1a47cfb046`, `run_efa90d9f55664e7c9e39`,
`run_893c41ea783949bdbb7a`. Dowód: `docs/evidence/bl01-bl02-2026-09-17/t27-widoki-agenta.json`.

| Krok | Stan | Czym dowiedziony |
|---|---|---|
| 1. otwarcie przestrzeni + zestawienie bez nazwy komponentu | **potwierdzony** | `data-state="no-conversation"` przed poleceniem; karta `crd_fd1c74706dbf4edeb503` z wyniku `agent_view_create` **tego** wykonania, każda karta przestrzeni z tego wykonania; `stanInstancji: ready`, 16 wierszy, każda komórka = `POST /api/read`; przestrzeń rozmowy ≠ przestrzeń robocza, adres i `s` użytkownika bez zmian |
| 2. dodanie wykresu | **potwierdzony jako dołożenie do widoku**, z odnotowanym stanem | wykres dołożony patchem do tej samej karty (`nowaKarta: false`), tabela nietknięta; `stanPoDodaniu: "error"` — „Seria Cena jednostkowa laczy rozne jednostki (PLN, EUR)"; narzędzie zwróciło `rendered: false` + `unit_from_record`, model odczytał ekran i powiedział prawdę |
| 3. zmiana zakresu rozmową | **potwierdzony** | po *„Zawez zestawienie i wykres do pozycji w PLN."*: tabela 16 → **12 wierszy, wszystkie `currency = PLN`**, `specVersion` 3; **wykres `ready`**, zakres serii równy `POST /api/read` dla jego własnego, zawężonego źródła; obie instancje zachowane |
| 4. mutacja danych i odświeżenie | **potwierdzony** | akcja rekordu **wewnątrz widoku agenta** (`pci_4a66a7de841d4a4f9602` → `7777,50 PLN`); backend `unitPriceMinor = 777750`; wartość na ekranie = świeży odczyt; świadek w `window` potwierdza **brak przeładowania** |
| 5. przeładowanie | **potwierdzony** | `run_9411a0c692a04d8f822c` (`t27-kroki-5-6.json`): po `page.reload()` ta sama karta wraca, jest widoczna, a wszystkie wartości — ze zmienioną ceną — są równe backendowi |
| 6. wyjście do innej rozmowy i powrót | **niesprawdzony** | błąd testu, nie produktu — niżej |

Przebieg zamykający `run_9411a0c692a04d8f822c` jest przy okazji najlepszym pojedynczym dowodem F1+F2:
**w jednej turze** model wyszukał sprawę, złożył `Stack([tabela, wykres])`, wpisał **obu** instancjom
`filter: [{field: "currency", op: "eq", value: "PLN"}]` — czyli sam zawęził do jednej jednostki, o którą
ostrzega `unit_from_record` — i odczytał ekran przez `ui_state`. Obie instancje `ready`, po 12 rekordów,
wartości i zakres serii równe backendowi.

## Krok 6 — dlaczego nie ma dowodu

`run_9411a0c692a04d8f822c`, przebieg zakończony limitem czasu testu (11 min). Przyczyna jest w moim kodzie:
selektor `.pf-chat [aria-label="New chat"]` trafił w **duży** przycisk „New chat” z szuflady rozmów, a nie
w ikonę w nagłówku czatu. Przy zamkniętej szufladzie duży przycisk jest poza kadrem, więc na `/agent-views`
kliknięcie przechwytuje `react-flow__pane`:

```
- attempting click action
  - element is visible, enabled and stable
  - <div class="react-flow__pane draggable">…</div> from <main class="pf-main">…</main>
    subtree intercepts pointer events
  - retrying click action        (do limitu czasu testu)
```

`e2e/session-restore.spec.ts` opisuje dokładnie tę pułapkę („dwa przyciski New chat… kliknięcie ląduje na
canvasie") i używa `.pf-chat .openui-icon-button[aria-label="New chat"]`. Poprawiłem oba wystąpienia w
swoim specu (commit `15c8994`); przebiegu nie da się powtórzyć bez kolejnej tury, a **budżet 6 tur jest
wyczerpany**, więc krok 6 zostaje niesprawdzony z prawdziwym modelem. Deterministycznie ta sama własność
jest dowiedziona w `e2e/agent-views.spec.ts` („przeladowanie i przelaczanie rozmow odtwarzaja widoki
wlasciwej rozmowy") — na kompozycjach skryptowanych, nie modelowych.

**To nie jest ustalenie o produkcie.** Nie twierdzę, że przycisk jest nieklikalny dla użytkownika: ikona w
nagłówku jest zawsze na wierzchu i to jej używa reszta suity.

## Nieudane przebiegi w tej rundzie

| # | Wykonania | Co się stało |
|---|---|---|
| 1 (próba 1/2) | `run_3e583d1184894cb2b1d4`, `run_3213d8f04366476f91d7` | Krok 1 przeszedł (F1 działa). Krok 2: wykres w stanie `error` (dwie waluty) — wtedy test oceniał wartości wykresu **przed** ustaleniem zakresu, czyli wymagał rzeczy, której dane nie pozwalają narysować. Przebudowa: wartości wykresu oceniane po kroku 3 (`30aaf8f`) |
| 2 (próba 2/2) | `run_335ba5ea2b1a47cfb046`, `run_efa90d9f55664e7c9e39`, `run_893c41ea783949bdbb7a` | Kroki 1–5 przeszły. Test pękł **po** przeładowaniu: `publishedSnapshot` rzucił na `snapshot: null`, bo przeładowanie wycofuje opis karty (`pagehide` → `DELETE /api/ui/snapshot`), a moja pętla `expect.poll` nie tolerowała przerwy zamiast ponawiać. Poprawione (`d986b89`) |
| 3 (zamykający, 1 tura) | `run_9411a0c692a04d8f822c` | Kroki 1–5 przeszły, krok 6 padł na selektorze „New chat” (wyżej) |

Trzy porażki, wszystkie w teście, żadna w aplikacji. W każdej produkt zrobił to, czego wymaga kryterium, i
mam na to zapis z dziennika wykonania i z opisu ekranu.

## Nowe ustalenie o moim własnym gate’cie

`pnpm typecheck` **nie obejmuje katalogu `e2e/`** (`tsconfig.json` wymienia `packages`, `apps`, `tests`,
`scripts`). Playwright uruchamia TypeScript bez sprawdzania typów, więc martwa referencja w specu
(`supplierNames` po przebudowie kroku 3) przeszłaby do przebiegu i zabrała turę. Złapałem ją jednorazowym
`tsc` po `e2e/**` i tak sprawdzałem każdą zmianę przed wydaniem tury. Katalog nie przechodzi dziś czysto
jako całość (typowanie fixture’ów Playwrighta w `e2e/support/fixtures.ts`, `chat-drawer.spec.ts` i trzy
scenariusze skryptowane), więc **nie** dopisałem go do wspólnej bramki — to zmiana w `tsconfig.json` i w
cudzych plikach, poza moim zakresem. Rekomendacja dla koordynatora: osobny `tsconfig.e2e.json` w bramce,
po uporządkowaniu tych kilku miejsc.

## Stan próby T27 po dokończeniu (NIEAKTUALNE — stan z rundy „dokończenie po Task 9”)

> **Ta sekcja została zastąpiona.** Opisuje stan po rundzie 6 tur i **nie jest** wynikiem próby T27.
> Obowiązuje sekcja **„T27 — domknięcie (grant 4 tur…)”** niżej w tym raporcie, a w szczególności jej
> „Tabela kroków próby T27” i „Stan końcowy prób”. W skrócie, co zmienił ostatni grant: **próba T27 jest
> zaliczona w całości (6/6 kroków) w jednej rozmowie** (`cnv_7eeb2c33b5d74ee08c7a`, wykonania
> `run_1063a97fce11422d86c8`, `run_f0520015edfc48708557`, `run_adca8dc48ad946248e1f`); oczekiwanie
> kroku 2 zostało przepisane na **dwie uczciwe ścieżki o tej samej mocy** (`ready` z zakresem z backendu
> albo nazwana na ekranie odmowa rysowania, domykana w kroku 3), więc **żaden test tego zadania nie jest
> już czerwony**; pomocniczy test `T27 (kroki 5-6)` został **usunięty**; koszt jednego przebiegu
> `e2e/bl01-bl02-model.spec.ts` to **7 tur** (T25 1, T26 3, T27 3), a nie 10. Łączny wydatek planu:
> **21 tur**. Poniższy akapit zostaje jako zapis tego, co było wiadomo w tamtej rundzie.

**(stan z rundy 6 tur, zastąpiony)** **Kroki 1–5 potwierdzone z rzeczywistym modelem**, krok 6
niesprawdzony (błąd testu, budżet wyczerpany).
Test `T27` w repozytorium jest **czerwony** na kroku 2 (wykres `error` przed zawężeniem) — i to jest
poprawny wynik: przy danych w dwóch walutach karta nie może narysować serii pieniężnej, a agent słusznie
pyta o zawężenie zamiast obiecywać obrazek. Test `T27 (kroki 5-6)` jest czerwony na kroku 6 z powodu
opisanego wyżej, już poprawionego w kodzie. Oba zostawiam czerwone zgodnie z poleceniem: „jeśli krok nadal
oblewa, to jest wynik”.

**(zastąpione) Koszt pełnej suity po tej rundzie:** `e2e/bl01-bl02-model.spec.ts` wydaje **10 tur** na
przebieg (T25 1, T26 3, T27 3, T27 kroki 5–6 1 — plus tura, jeśli któryś krok trzeba powtórzyć).

---

## Luka w bramce: `pnpm typecheck` nie obejmuje `e2e/`

> **Zamknięte w Task 10.** `tsconfig.e2e.json` jest w bramce (`pnpm typecheck` = `typecheck:src` +
> `typecheck:e2e`), a wszystkie 16 błędów z tabeli niżej jest poprawionych — w tym ich źródło
> (`Step['input']` w `e2e/support/scripted-agent.ts`). Opis luki zostaje jako zapis ustalenia.

`tsconfig.json` wymienia `packages/*/src`, `apps/*/src`, `tests`, `scripts` — **katalogu `e2e/` nie ma**.
Playwright uruchamia TypeScript przez esbuild, czyli bez sprawdzania typów, więc błąd typu w specu nie
zatrzymuje niczego: wychodzi dopiero jako wyjątek w trakcie przebiegu. W zadaniu z budżetem tur to jest
koszt liczony w turach — martwa referencja `supplierNames`, która została mi po przebudowie kroku 3,
przeszłaby `pnpm typecheck` i wybuchła po wydaniu tury. Złapałem ją jednorazowym `tsc` po `e2e/**` i od
tego momentu sprawdzałem tak każdą zmianę przed każdym uruchomieniem.

Katalog nie przechodzi dziś czysto jako całość. Pełna lista (stan `9ffd570`):

| Plik | Błędy | Rodzaj |
|---|---|---|
| `e2e/support/agent-views-scenario.ts` | 7 × TS7006 | `Parameter 'calls' implicitly has an 'any' type` — funkcje `input: (calls) => …` w krokach `call` |
| `e2e/support/show-value-scenario.ts` | 3 × TS7006 | jw. |
| `e2e/support/interactions-scenario.ts` | 3 × TS7006 (`calls`) + 1 × TS7006 (`c`) | jw. |
| `e2e/support/fixtures.ts` | 1 × TS2345 | `test.extend` z fixture o zakresie worker: `void` z `use` nie pasuje do `never` w `TestFixture` |
| `e2e/chat-drawer.spec.ts` | 1 × TS2345 | `test.use({ viewport })` typowane jako `Fixtures`, nie jako opcje |

Moje pliki (`e2e/bl01-bl02-model.spec.ts`, `e2e/support/show-value-probe.ts`, `e2e/show-value.spec.ts`)
przechodzą czysto.

**Czego wymagałby `tsconfig.e2e.json`** (rekomendacja na falę poprawek, nie robiłem tego — to zmiana
wspólnej bramki i cudzych plików):

1. Osobny plik: `{ "extends": "./tsconfig.base.json", "compilerOptions": { "noEmit": true, "types": ["node"] }, "include": ["e2e/**/*.ts"] }` i `"typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.e2e.json"` w `package.json`.
   Osobny plik, nie dopisanie `e2e/**` do głównego `include`: `e2e` nie ma `vite/client` i nie powinno
   ciągnąć typów przeglądarki do bramki pakietów.
2. Trzy pliki scenariuszy: nadać typ parametrowi `calls` — `CallRecord[]` jest już wyeksportowany
   z `e2e/support/scripted-agent.ts`, więc to jedna adnotacja na funkcję.
3. `e2e/support/fixtures.ts`: fixture `isolatedInstance` o zakresie worker zadeklarować jako `void` po
   stronie typu generycznego zgodnie z sygnaturą `TestFixture` (albo użyć `unknown` i zwrócić `undefined`).
4. `e2e/chat-drawer.spec.ts`: `test.use({ viewport: … })` w miejscu, w którym typ opcji jest widoczny
   (wewnątrz `describe`), albo z jawnym typem `PlaywrightTestOptions`.

## Koszt pełnej suity w turach subskrypcji

> **Nieaktualne od Task 10.** `pnpm test:e2e` nie wydaje już żadnej tury: trzy spece modelowe nie należą
> do projektu domyślnego przebiegu i uruchamia je wyłącznie `pnpm test:e2e:model` (11 tur: `agent-ui` 2,
> `files-agent` 2, `bl01-bl02-model` 7). Tabela niżej zostaje jako zapis stanu z tej rundy — liczba 8 dla
> `bl01-bl02-model.spec.ts` odnosi się do wersji z pomocniczym testem „T27 kroki 5–6", usuniętym w rundzie
> domknięcia. Szczegóły: `task-10-report.md`, punkt 3.

Kto uruchamia `pnpm test:e2e` bez wskazania plików, wydaje **12 tur** subskrypcji:

| Spec | Tur | Co wydaje |
|---|---|---|
| `e2e/agent-ui.spec.ts` | 2 | pełna ścieżka użytkownika (1) + „pytanie o dane przenosi na ich widok" (1) |
| `e2e/files-agent.spec.ts` | 2 | dwa polecenia z plikiem |
| `e2e/bl01-bl02-model.spec.ts` | **8** | T25 (1), T26 (3), T27 (3), T27 kroki 5–6 (1) |
| pozostałe 18 speców | 0 | model skryptowany albo brak modelu |

Każde powtórzenie pliku z prawdziwym modelem to pełny koszt tego pliku — Playwright nie wznawia od kroku,
na którym stanął. Przy `retries > 0` koszt mnoży się przez liczbę prób, dlatego `playwright.config.ts` ma
`retries: 0` i nie należy tego zmieniać bez policzenia tur.

---

# T27 — domknięcie (grant 4 tur, ostatni wydatek subskrypcji w planie)

`pnpm verify` przed wydaniem tury: **exit 0** (31 plików / 529 testów).
`e2e/agent-views.spec.ts` (skryptowany, bez tur) przed wydaniem tury: **7 passed**.
`flock … playwright test e2e/bl01-bl02-model.spec.ts -g "T27 — widoki agenta"`: **1 passed (2,1 min)**.

**Próba T27 jest zaliczona w całości, w jednej rozmowie** (`cnv_7eeb2c33b5d74ee08c7a`), w scenariuszu, który
przed Task 9 oblewał dwa razy: użytkownik nazywa sprawę kodem („…ze sprawy PC-2026-01…"), polecenie idzie
z przestrzeni „Widoki agenta".

| Tura | Wykonanie | Narzędzia | Czas |
|---|---|---|---|
| 19 | `run_1063a97fce11422d86c8` | `ToolSearch`, `procurement_search`, `agent_view_create`, **`ui_state`** | 39,4 s |
| 20 | `run_f0520015edfc48708557` | `agent_views_list`, `agent_view_update`, **`ui_state`** | 38,2 s |
| 21 | `run_adca8dc48ad946248e1f` | `agent_view_update`, **`ui_state`** | 40,1 s |

Tura 18 (`run_94540037b0394f86878f`) to mój błąd: nie podniosłem stałej `MODEL_TURN_BUDGET` przed
uruchomieniem, więc strażnik przepuścił krok 1 i odmówił kroku 2. Tura poszła na krok już dowiedziony.
Poprawiłem przy okazji kolejność w `sendForRun` — **najpierw odmowa, potem zapis do rejestru** — bo stara
kolejność zaksięgowała turę, która nigdy nie opuściła przeglądarki (wpis 19 bez `runId`, usunięty z rejestru
i opisany w polu `odrzuconeBezWysłania`).

## Krok 2 — poprawiona, nieosłabiona asercja

Miałeś rację, że czerwony test kodował złe oczekiwanie. Teraz spec asercjonuje **obie uczciwe ścieżki, z tą
samą mocą**, i wyklucza trzecią:

- `state = ready` → zakres serii równy `POST /api/read` dla własnego źródła instancji;
- `state = error` → komponent **mówi, dlaczego**: `data-state="error"`, `[role="alert"][data-error-code="validation_failed"]`
  z tekstem odmowy, **zero** `figcaption [data-series]`, **zero** `.pf-data__chart`, `visibleRecordIds = []`
  (czyli ani pustej karty, ani zmyślonych liczb); wynik narzędzia niósł `rendered: false` i ostrzeżenie
  `unit_from_record`, które to przewidziało; wykonanie **odczytało ekran** (`ui_state` po `agent_view_*`);
- w obu razach każdy zapis kompozycji musi mieć `rendered: false` i zdanie `readBack` — „zapisane" nigdy nie
  może się podać za „narysowane";
- a krok 3 wymaga, żeby **ta sama karta** (`card-<id>` + `data-ui-instance`) była po zawężeniu `ready`
  z zakresem z backendu — więc odmowa nie może być stanem końcowym.

W przebiegu 19–21 zadziałała ścieżka odmowy i została domknięta: `stanPoDodaniu: "error"` („Seria Cena
jednostkowa laczy rozne jednostki (PLN, EUR); zawez dane do jednej jednostki.") →
`stanPoZmianieZakresu: "ready"`, `ścieżka: "odmowa rysowania, opisana na ekranie i odczytana przez wykonanie"`.

## Tabela kroków próby T27

| Krok | Wynik | Wykonania | Rodzaj dowodu | Czym potwierdzony |
|---|---|---|---|---|
| **1** otwarcie przestrzeni agenta i zestawienie bez nazwy komponentu | **potwierdzony** | `run_1063a97fce11422d86c8` | rzeczywisty model | `data-state="no-conversation"` przed poleceniem; `procurement_search` → `agent_view_create` z prawdziwym `pcs_f39d9113550740619d34`; karta `crd_7d1c99f1a60f4cf3a064` z wyniku **tego** wykonania, każda karta przestrzeni z tego wykonania; 16 wierszy, każda komórka = `POST /api/read`; opis instancji wymienia te same rekordy w kolejności z ekranu; przestrzeń rozmowy ≠ przestrzeń robocza, adres i `s` użytkownika bez zmian |
| **2** dodanie wykresu | **potwierdzony** (ścieżka odmowy, domknięta w kroku 3) | `run_f0520015edfc48708557` | rzeczywisty model | wykres dołożony patchem do tej samej karty, tabela nietknięta; odmowa rysowania **nazwana na ekranie**, bez serii, bez treści wykresu, `visibleRecordIds = []`; `rendered: false` + `unit_from_record`; wykonanie odczytało ekran przez `ui_state` |
| **3** zmiana zakresu rozmową | **potwierdzony** | `run_adca8dc48ad946248e1f` | rzeczywisty model | „Zawez zestawienie i wykres do pozycji w PLN." → 16 → **12 wierszy, wszystkie `currency = PLN`**, `specVersion` 3; **ta sama karta** i ta sama instancja wykresu w stanie `ready`, zakres serii = `POST /api/read` |
| **4** mutacja danych i odświeżenie | **potwierdzony** | (bez tury) | test GUI bez modelu, na kompozycji modelu | akcja rekordu **wewnątrz widoku agenta** (`pci_3da7c3a0b1b14d5fb97a` → `7777,50 PLN`); backend `unitPriceMinor = 777750`; wartości = świeży odczyt; świadek w `window` potwierdza **brak przeładowania** |
| **5** przeładowanie | **potwierdzony** | (bez tury) | test GUI bez modelu, na kompozycji modelu | po `page.reload()` ta sama karta wraca i jest widoczna; wszystkie wartości, ze zmienioną ceną, równe backendowi |
| **6** wyjście do innej rozmowy i powrót | **potwierdzony** | (bez tury) | test GUI bez modelu, na kompozycji modelu | „New chat" → `data-state="no-conversation"` i **karty rozmowy nie są widoczne**; powrót z szuflady po tytule → `data-conversation-id` tej rozmowy, ten sam zestaw kart, wartości równe backendowi, bez przeładowania |

Kroki 4–6 są dowiedzione **na kartach, które napisał model** w krokach 1–3 tej samej rozmowy — dlatego
„test GUI bez modelu" opisuje tu sposób wykonania kroku (użytkownik klika), nie pochodzenie obiektu.

> **Zastrzeżenie do wierszy 4 i 6 (dopisane po przeglądzie).** Dwie asercje, które dziś strzegą tych
> wierszy — twarda asercja świadka braku przeładowania w kroku 6 (I1) i wymóg przycisku akcji w karcie
> widoku agenta w kroku 4 (I2) — **zostały dopisane po ostatnim przebiegu z modelem i nie były przez niego
> wykonane**; grant tur jest zamknięty. Zapisany dowód z tur 19–21 podaje dokładnie te wartości
> (`poPowrocieDoRozmowy.bezPrzeladowaniaOdOstatniego = true`, `mutacja.gdzie = "akcja rekordu w widoku
> agenta"`), więc asercje są z nim zgodne, ale sprawdzi je dopiero najbliższy pełny przebieg suity.
> Szczegóły: sekcja „Domknięcie po przeglądzie".

## Sprzątanie i stan repozytorium

- Usunąłem pomocniczy test `T27 (kroki 5-6)`: powstał tylko po to, żeby sięgnąć kroków 5–6, gdy główna próba
  do nich nie dochodziła. Teraz dubluje pokrycie i kosztowałby **dodatkową turę** przy każdym przebiegu
  suity. Jego dowód (tura 17, `run_9411a0c692a04d8f822c`) zostaje w
  `docs/evidence/bl01-bl02-2026-09-17/t27-kroki-5-6.json` oznaczony jako archiwalny.
- **Koszt pełnej suity spada z 12 do 11 tur**: `agent-ui.spec.ts` 2, `files-agent.spec.ts` 2,
  `bl01-bl02-model.spec.ts` **7** (T25 1, T26 3, T27 3).
- Dane instancji testowej po przebiegu: 16 pozycji ofert, suma cen **9 769 000** — dokładnie zasiew,
  przywrócenie po mutacji wykonało się.
- **Żaden test tego zadania nie jest już czerwony.** `test.fixme` nie użyty nigdzie.

## Stan końcowy prób

| Próba | Wynik | Rodzaj dowodu |
|---|---|---|
| **T25** | **zaliczona** | rzeczywisty model — `run_37fe29692e9f4a6e908e` |
| **T26** | **zaliczona** | rzeczywisty model — `run_b2183264d0f549afb822`, `run_ee4f0a7e02bd430e8a3a`, `run_722fe4ef7c434fb1a1b4` |
| **T27** | **zaliczona** (6/6 kroków) | rzeczywisty model — `run_1063a97fce11422d86c8`, `run_f0520015edfc48708557`, `run_adca8dc48ad946248e1f` |

Budżet łącznie: **21 tur** — 11 z 12 (Task 8), 6 z 6 (dokończenie po Task 9), 4 z 4 (domknięcie). Pełny
rejestr z podziałem na granty: `docs/evidence/bl01-bl02-2026-09-17/tury-modelu.json`.

---

# Domknięcie po przeglądzie

Dwie asercje były słabsze niż twierdzenia, które się na nich opierały. Poprawione **bez wydania tury** —
grant jest zamknięty.

## I1 — świadek braku przeładowania w kroku 6 był liczony, ale nieasercjonowany

Krok 6 wyliczał `stillWithoutReload` i zapisywał go do dowodu, po czym nikt go nie sprawdzał, podczas gdy
komentarz w specu i wiersz 6 tabeli mówiły „bez przeładowania" jako o rzeczy dowiedzionej. Analogiczny
świadek kroku 4 był asercjonowany od początku — ten został pominięty. Dopisana twarda asercja:

```ts
expect(
  stillWithoutReload,
  'strona zostala przeladowana miedzy wyjsciem z rozmowy a powrotem — to nie jest przelaczenie rozmowy',
).toBe(true);
```

Bez niej krok 6 przechodziłby także wtedy, gdyby przeglądarka przeładowała stronę przy powrocie — czyli
gdyby „przełączenie rozmowy" w ogóle nie było przełączeniem, tylko drugim przeładowaniem.

## I2 — rozgałęzienie na obecności przycisku akcji ukrywało wadę, której krok szuka

Krok 4 sprawdzał, czy karta widoku agenta ma przycisk `change_unit_price`, i **jeśli nie miała, po cichu
szedł na ekran sprawy i nadal przechodził**. Akcja rekordu jest własnością *odczytu*, więc każda tabela nad
tym odczytem musi ją dawać — ekran modułu, czat i karta agenta tak samo (kontrakt Taska 7). Obecność
przycisku jest więc częścią tego, co ten krok dowodzi, a nie warunkiem rozgałęzienia. Teraz:

```ts
if (showsItems) {
  await expect(
    actionButton,
    'karta widoku agenta czyta odczyt z akcja rekordu, ale nie daje jej przycisku',
  ).toHaveCount(1);
}
```

Ekran sprawy zostaje jako ścieżka **tylko** dla karty nad innym odczytem. Masz rację, że usunięcie testu
pomocniczego w `a69f8af` zabrało asercję, która nie była duplikatem — ta wraca tu, w miejscu, w którym
należy do kroku 4 głównej próby.

## Uczciwie: te dwie asercje nie były wykonane w przebiegu z modelem

**Żadna z powyższych asercji nie przeszła przez wykonanie z prawdziwym modelem.** Grant tur jest zamknięty
i specu modelowego nie uruchamiałem. Dowód zapisany z tur 19–21 pokazuje dokładnie te wartości, których
teraz wymagają:

- `poPowrocieDoRozmowy.bezPrzeladowaniaOdOstatniego = true` (I1),
- `mutacja.gdzie = "akcja rekordu w widoku agenta"` (I2 — przebieg szedł gałęzią, która teraz jest jedyną
  dopuszczalną dla karty nad tym odczytem).

To znaczy, że asercje są **zgodne** z zapisanym przebiegiem, ale **nie zostały przez niego sprawdzone**:
wykona je najbliższy pełny przebieg suity. Wiersze 4 i 6 tabeli kroków należy czytać z tym zastrzeżeniem —
same kroki są dowiedzione zapisanymi wartościami z tur 19–21, natomiast **strażnicy** tych wartości są
nowi i niesprawdzeni w boju.

## Rozliczenie budżetu i rejestru

- `MODEL_TURN_BUDGET = 22` to **sufit** (12 + 6 + 4 przyznanych), nie wydatek. Wydane: **21** — 11 z
  pierwszego grantu, 6 z drugiego, 4 z trzeciego. Jedna tura nierozliczona to niewykorzystana reszta grantu
  Taska 8, nie zapas na kolejny przebieg. Komentarz przy stałej mówi to wprost i dodaje, że grant jest
  zamknięty, a stałej nie wolno podnieść bez zgody koordynatora.
- `tury-modelu.json`: tura 18 miała `etap` z drugiego grantu, choć `granty` przypisują 18–21 do trzeciego.
  Etapy są teraz wyliczone z numeru tury dla **wszystkich** wpisów i zgodne z `granty`; wpis
  `odrzuconeBezWysłania` też dostał etap. Doszły `sufitStraznika` i `uwagaORozliczeniu`.
- `docs/evidence/bl01-bl02-2026-09-17/README.md`: nowa sekcja **„Który commit zapisuje który dowód"**
  (tabela plik → `kodCommit` → co wtedy działało) i **„Dlaczego późniejsze zmiany speca nie unieważniają
  zapisanych przebiegów"** — cztery zmiany po kolei: `resultOf`→`lastResultOf` (zmienia, **które** wywołanie
  ocenia detektor; w zapisanych przebiegach było jedno), dopisane `expect(snapshot).toBeTruthy()` (warunek
  ostrzejszy na wartość już podaną: `opisEkranuPo.wersja = 3`), oraz obie dzisiejsze asercje — z jawną
  adnotacją, że dwie ostatnie nie były wykonane w przebiegu z modelem.

## Bramka

| Polecenie | Wynik |
|---|---|
| `pnpm verify` | **exit 0**; Vitest **31 plików / 529 testów** |
| `flock … playwright test e2e/show-value.spec.ts e2e/agent-views.spec.ts e2e/interactions.spec.ts` | **21 passed** (1,7 min) |

Speców modelowych nie uruchamiałem. Kod produkcyjny nietknięty w całym zakresie zadania.
