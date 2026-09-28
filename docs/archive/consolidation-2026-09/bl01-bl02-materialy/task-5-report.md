# Raport — Task 5: ekrany szczegolow modulu jako kompozycje

- Galaz / worktree: `bl01-bl02/t5-ekrany-modulu` — `/home/paczos/Documents/agentic-app-template-wt/t5-ekrany-modulu` (baza `3097586`)
- Data: 2026-09-17
- Status: **DONE** (po rundzie 1 poprawek — patrz sekcja „Fix round 1” na koncu)

Commity:

| SHA | Temat |
|---|---|
| `b852ae5` | Task 5: ekrany szczegolow modulu (/cases/$caseId, /items/$itemId) jako kompozycje OpenUI (10 plikow, +557/−122) |
| `1508ed1` | Fix round 1: napraw G9 (etykieta priceBasis, dowod inwariantu widok<->cel), realne naglowki sekcji (6 plikow, +101/−24) |

Rodzaje dowodow: **test kontraktu lub logiki** (Vitest, `tests/views-foundation.test.ts`), **test GUI bez modelu** (Playwright, `e2e/composed-views.spec.ts` i istniejace spece na wspolnej instancji). Prawdziwego modelu nie uzyto.

---

## 1. Co zostalo zrobione (punkty „Musi” z briefu)

1. **`/cases/$caseId` i `/items/$itemId` jako `ViewDefinition`.** `packages/module-procurement/src/server/views.ts`: `procurement.case.detail` (`params: ['caseId']`) i `procurement.item.provenance` (`params: ['itemId']`), oba renderowane przez `ComposedView`. Deterministyczne opakowania tras (`CaseDetailPage`, `ItemProvenancePage` w `ui/pages.tsx`) zachowuja: ustawienie `setResource`/`setSpace` i wywolanie `POST /api/canvas/spaces/for-scope` przy otwarciu sprawy (bez zmian), oraz `data-testid` stron.
2. **Czesci tabelaryczne jako `DataTable` na nowych odczytach z deskryptorami.**
   - Nowy odczyt `procurement.case_offer_items` (deskryptor `caseOfferItemRecords`: rekord `offer_item`, `idField: 'id'` — id samej pozycji, bo case ma wiele ofert i kazda wiele pozycji): pola `supplierName` (Dostawca), `name` (Nazwa), `unit` (Jednostka), `quantityMilli` (Ilosc, `quantity_milli`, `unitField: unit`), `unitPriceMinor` (Cena jednostkowa, `money_minor`, `unitField: currency`), `currency` (Waluta). Serwisowa metoda `ProcurementService.listCaseOfferItems` splaszcza `getCaseDetail(...).offers` do jednego wiersza na pozycje, z dostawca i waluta skopiowanymi z macierzystej oferty.
   - Ekran sprawy uzywa tez istniejacego odczytu `procurement.case_overview` dla tabeli „Pozycje wymagane” (`position, name, quantityMilli, spec`) — bez nowego odczytu, bo deskryptor `requirementRecords` juz istnial (Task 1) i nie byl jeszcze uzyty w zadnej kompozycji.
   - Czesci nietabelaryczne jako komponenty OpenUI modulu (`defineComponent`, typowane propsy `{caseId}`/`{itemId}`, wylacznie referencje — nigdy wartosci biznesowe): `CaseHeader` (naglowek sprawy: kod, tytul, opis, podstawa porownania), `CaseOfferSources` (oferty pogrupowane po dostawcy, z lączami „pochodzenie” do kazdej pozycji i zalacznikami zrodlowymi), `ItemProvenance` (karta pochodzenia jednej pozycji: pozycja, cena, dostawca, oferta, lista zrodel z lączem do pliku). Schematy propsow w react-free `packages/module-procurement/src/shared/openui-components.ts` (aby serwer mogl je pozniej zwalidowac — patrz sekcja 7).
3. **Zachowane `data-testid`, linki i teksty.** `case-detail-page`, `provenance-page`, tekst linku „Otworz przestrzen pracy na canvasie”, tekst linku „pochodzenie” (do `/items/$itemId`), tekst linku „zalacznik zrodlowy” i pobieralne zalaczniki (`<a href=".../content" download>`) — wszystkie zachowane bit-w-bit; sprawdzone przez niezmienione `e2e/app.spec.ts`, `e2e/session-restore.spec.ts`, `e2e/chat.spec.ts`, `e2e/access-context.spec.ts` (zielone, patrz sekcja 4).

**Poza zakresem** (zgodnie z brief): karty canvasu sprawy pozostaly specyfikacjami `component` (nie ruszane), akcje rekordu (Task 7).

---

## 2. Decyzje projektowe tam, gdzie brief zostawil wybor

### 2.1 Ramka ekranu musi zniknac przy braku dostepu — deterministyczne opakowanie nadal robi wlasny odczyt

`e2e/access-context.spec.ts` (istniejacy, nieedytowany test) wymaga, zeby po przelaczeniu tozsamosci i wejsciu na URL cudzej sprawy `data-testid="case-detail-page"` mial **liczbe 0** (nie tylko pokazywal blad w srodku ramki). `ComposedView`/`DataTable` same w sobie pokazuja stan bledu **wewnatrz** wlasnej ramki (`composed-view`, `data-state="error"`), co nie wystarcza — caly frame strony nie moze sie w ogole pojawic.

Rozwiazanie: `CaseDetailPage` i `ItemProvenancePage` nadal robia wlasny odczyt (odpowiednio `useReadOperation('procurement.case_overview', {caseId})` i `useModuleData(MODULE_ID, '/items/:id/provenance')` — dokladnie ta sama operacja/trasa, ktora **wewnatrz** kompozycji czytaja `CaseHeader`/`ItemProvenance`), wylacznie po to, by zdecydowac, czy w ogole wyrenderowac ramke. Dzieki wspolnemu kluczowi zapytania (TanStack Query, `qk.read`/`qk.module`) to jedno zadanie sieciowe, nie dwa — sprawdzone w praktyce (Network nie liczony automatycznie, ale ten sam `operation`+`input` daje jeden wpis w cache). Ten sam wzorzec byl juz w STARYM kodzie (przed T5) dla obu ekranow — zachowany, nie wymyslony na nowo.

### 2.2 `procurement.case.detail` i `procurement.item.provenance` bez wlasnego `UiTarget`

`ViewDefinition.params` -> `$nazwa` dziala niezaleznie od `UiTarget`; `checkViewAgainstTarget` (`registry/views.ts`) toleruje `target: undefined` (zaden blad startowy). Oba nowe ekrany sa rekordowe (jedna sprawa / jedna pozycja) i otwierane wylacznie przez `record.route` deskryptora (`caseRecords.record.route = '/cases/{id}'` z Task 1, link „pochodzenie” w `CaseOfferSources`) — nie przez `ui_navigate` na nazwany cel, bo nie ma sensu „przejdz do szczegolow sprawy” bez wskazania ktorej. Zaktualizowalem istniejacy test `tests/views-foundation.test.ts` („zwraca widoki modulow...”), ktory wczesniej sprawdzal, ze **kazdy** `id` widoku ma odpowiadajacy `UiTarget` — teraz sprawdza to tylko dla dwoch list (`procurement.data`, `procurement.cases`), z komentarzem wyjasniajacym dlaczego ekrany rekordowe nie potrzebuja wlasnego celu. To jest zmiana testu napisanego przez Task 1 dla jego wlasnego stanu (dwa widoki), nie zmiana kontraktu AD-4.

### 2.3 „pochodzenie” zostaje wlasnym komponentem, nie mechanizmem `record.route` na `DataTable`

`DataTable` umie zrobic z `titleField` link tylko wtedy, gdy tekstem linku jest **wartosc pola** (`formatFieldValue(record, titleField)`) — nigdy stale slowo. Test `e2e/app.spec.ts` wymaga linku o dokladnej, widocznej nazwie „pochodzenie” (nie nazwy pozycji). Zamiast wymyslac fikcyjne pole rekordu, ktorego jedyna wartoscia byloby zawsze slowo „pochodzenie” (myslace pole w deskryptorze), link „pochodzenie” zostal w `CaseOfferSources` — wlasnym, nietabelarycznym komponencie modulu, dokladnie tak jak brief sugeruje podzial tabelaryczne/nietabelaryczne. `case_offer_items` (DataTable) pokazuje dane pozycji; `CaseOfferSources` pokazuje grupowanie po ofercie, link „pochodzenie” i zalaczniki — bez duplikowania ilosci/ceny (te sa tylko w tabeli).

### 2.4 `offer.currency` dodane do odpowiedzi `findProvenance` (REST)

Stary `findProvenance` (uzywany przez `ItemProvenancePage` i karte canvasu `ProvenanceCard`) zwracal tylko `unitPriceFormatted` (string sformatowany serwerowo przez `formatMinor`), bez surowej waluty oferty. Zeby nowy `ItemProvenance` mogl formatowac cene przez `formatFieldValue` (M7 — patrz sekcja 2.5) zamiast ufac cudzemu stringowi, dodalem `currency: offer.currency` do `offer` w odpowiedzi — zmiana wylacznie addytywna (nowe pole), `ProvenanceCard` (karta canvasu, poza zakresem) nadal czyta `unitPriceFormatted` bez zmian.

### 2.5 M7 (handoff Task 1): migracja na `formatFieldValue`

**Poprawione w Fix round 1 — patrz tez ustalenie I1 na koncu.** Ten opis byl w pierwszym przebiegu niekompletny: pokrywal cene (`unitPriceMinor`), ale nie wspominal, ze `CaseHeader` nadal formatowal `priceBasis` recznym ternary (`c.priceBasis === 'net' ? 'netto' : 'brutto'`), co duplikowalo etykiety juz zadeklarowane w `caseRecords.fields` (`server/views.ts`) — dokladnie ten rodzaj duplikacji, ktorego migracja na `formatFieldValue` miala unikac. Po poprawce:

- Oba przekonwertowane ekrany nie uzywaja juz `formatMinor`/`formatQuantity` (usuniete z importow `ui/pages.tsx`). Cena i ilosc w tabelach ida przez `DataTable`+deskryptor (`formatFieldValue` automatycznie).
- W `ItemProvenance` (wlasny komponent, nie `DataTable`) cena jest formatowana jawnym wywolaniem `formatFieldValue({unitPriceMinor, currency}, unitPriceField)` z lokalna stala `RecordField` o tym samym ksztalcie co pole `unitPriceMinor` w `caseOfferItemRecords` (drobna, akceptowana duplikacja **ksztaltu** pola — nie tresci enumu, bo `money_minor` nie ma `values` do zdublowania; dwaj rozni konsumenci, jeden REST jeden `/api/read`, nie warto ich sprzegac dla czterech linijek).
- W `CaseHeader` cena podstawy (`priceBasis`) jest teraz formatowana `formatFieldValue({priceBasis}, priceBasisField)`, gdzie `priceBasisField.values` **jest** (nie kopiuje) `PRICE_BASIS_LABELS` — nowa, jedyna deklaracja etykiet „netto”/„brutto” w `shared/index.ts`, ktorej uzywaja tez `caseRecords.fields` i `comparisonRecords.fields` w `server/views.ts` (obie mialy wlasna kopie tych samych dwoch etykiet — usuniete przy okazji, patrz I1).
- Przejrzane pod katem innych recznie formatowanych wartosci biznesowych: `CaseOfferSourcesView` pokazuje `offer.currency` jako czysty tekst (typ `text`, bez enumu — nie ma czego zdublowac), `ItemProvenanceView` pokazuje `p.field` (kod pochodzenia, np. `unit_price`) tak jak przed T5 — nie ma dla niego zadnego zarejestrowanego deskryptora (pozycje pochodzenia nie sa odczytem), wiec nie ma zrodla, z ktorego `formatFieldValue` moglby wziac etykiete; pozostawione bez zmian.

`formatMinor`/`formatQuantity` **zostaja** (nieruszane) w: `packages/module-procurement/src/ui/cards.tsx` (karty canvasu — poza zakresem T5), `packages/module-procurement/src/server/tools.ts` (odpowiedzi narzedzi MCP dla modelu — inna warstwa, nie ekran), `packages/module-procurement/src/server/services.ts` (`findProvenance.item.quantity`/`unitPriceFormatted` — pole REST nadal czytane przez `ProvenanceCard`).

### 2.6 Puste wiersze pytania z briefu, ktore nie wymagaly wyboru

- `CaseHeader`/`CaseOfferSources` czytaja `procurement.case_overview` (nie nowy odczyt): jeden odczyt, jeden cache, trzy komponenty (naglowek, oferty, tabela wymaganych pozycji na tym samym ekranie) — bez powielania zapytania.
- Nazwy komponentow OpenUI (`CaseHeader`, `CaseOfferSources`, `ItemProvenance`) sprawdzone pod katem kolizji z istniejacym katalogiem (`DataTable/DataChart/DataSummary`, `OfferComparison`, `OfferCostChart`) — unikalne.

---

## 3. Zmienione pliki

| Plik | Zmiana |
|---|---|
| `packages/module-procurement/src/server/views.ts` | nowy deskryptor `caseOfferItemRecords`; 2 nowe `ViewDefinition` |
| `packages/module-procurement/src/server/services.ts` | nowa `listCaseOfferItems`; `findProvenance` zwraca tez `offer.currency` |
| `packages/module-procurement/src/server/index.ts` | nowy odczyt `case_offer_items` |
| `packages/module-procurement/src/shared/openui-components.ts` (nowy) | schematy propsow (`caseHeaderPropsSchema`, `caseOfferSourcesPropsSchema`, `itemProvenancePropsSchema`), react-free |
| `packages/module-procurement/src/shared/index.ts` | re-eksport nowego pliku |
| `packages/module-procurement/src/ui/detailComponents.tsx` (nowy) | `CaseHeaderView`, `CaseOfferSourcesView`, `ItemProvenanceView` + `defineComponent` (`procurementDetailOpenuiComponents`) |
| `packages/module-procurement/src/ui/index.tsx` | dolaczenie nowych komponentow do katalogu OpenUI modulu |
| `packages/module-procurement/src/ui/pages.tsx` | `CaseDetailPage`/`ItemProvenancePage` przepisane na `ComposedView` + gating odczyt |
| `tests/views-foundation.test.ts` | 5 nowych testow (`describe('procurement.case_offer_items')`, `GET /api/ui/views`); zaktualizowane 2 istniejace asercje list widokow |
| `e2e/composed-views.spec.ts` | nowy `test.describe('ekrany szczegolow modulu...')`, 3 testy |

Nie edytowano: dokumentow koordynatora (G8), zaleznosci (G7), `apps/*` poza wynikami `pnpm build`.

---

## 4. Polecenia, kody wyjscia, liczby testow

| Polecenie | Wynik |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm exec vitest run tests/views-foundation.test.ts` | exit 0, **45 passed** (40 istniejacych + 5 nowych) |
| `pnpm exec vitest run` (pelna suita) | exit 0, **332 passed** (25 plikow) |
| `pnpm build` | exit 0 |
| `pnpm verify` (check:boundaries, check:acceptance, check:matrix, check:closure, typecheck, build, test) | **exit 0**, Vitest 25 plikow / 332 testy |
| `flock … pnpm exec playwright test e2e/composed-views.spec.ts` | exit 0, **7 passed** (4 istniejace + 3 nowe) |
| `flock … pnpm exec playwright test e2e/app.spec.ts e2e/access-context.spec.ts` | exit 0, **17 passed** |
| `flock … pnpm exec playwright test e2e/session-restore.spec.ts e2e/chat.spec.ts` | exit 0, **13 passed** |
| `flock … pnpm exec playwright test e2e/measurements.spec.ts e2e/view-filter.spec.ts` | exit 0, **9 passed** (kontrola dodatkowa — nie wymagane przez brief, uruchomione bo dotykaja tego samego ekranu sprawy) |
| `flock … pnpm exec playwright test e2e/access-context.spec.ts e2e/composed-views.spec.ts` (powtorka po przywroceniu z proby negatywnej #2, sekcja 5) | exit 0, **10 passed** |

Po kazdym przebiegu e2e katalog roboczy sprawdzony `git status --porcelain` — bez nieoczekiwanych plikow (usuniety jeden nieposledzony `docs/evidence/*` wygenerowany przez `view-filter.spec.ts`/`measurements.spec.ts`, nie moj dowod).

`e2e/agent-ui.spec.ts` nie uruchamiany (zastrzezone dla Task 8, model realny).

---

## 5. Kontrole negatywne i proby zdolnosci wykrycia

| # | Co zepsuto (bez commitu) | Test | Wynik przed | Po przywroceniu |
|---|---|---|---|---|
| 1 | `services.ts`, `listCaseOfferItems`: `currency: offer.currency` -> `currency: 'XXX'` | `tests/views-foundation.test.ts` „splaszcza pozycje wszystkich ofert...” | **1 failed** — `expected 'XXX' to be 'PLN'` (waluta pozycji przestala sie zgadzac z waluta oferty) | `pnpm exec vitest run ... -t case_offer_items`: **4 passed** |
| 2 | `pages.tsx`, `CaseDetailPage`: warunek bledu wylaczony (`if (false && error)`), warunek pustych danych oslabiony (`if (!data && !error)`) — ramka renderuje sie nawet przy odmowie dostepu | `flock … pnpm exec playwright test e2e/access-context.spec.ts` | **1 failed / 2 passed** — „brak widocznego stanu braku dostepu”, `getByTestId('access-denied')` nie znaleziony (bo zamiast niego wyrenderowala sie pusta ramka `case-detail-page`) | `pnpm build` + `flock … playwright test e2e/access-context.spec.ts e2e/composed-views.spec.ts`: **10 passed** |

Obie proby pokazuja realny mechanizm: (1) ze nowy odczyt naprawde niesie wlasciwa walute z oferty, nie zbieg okolicznosci formatowania; (2) ze gating w deterministycznym opakowaniu jest jedynym powodem, dla ktorego `case-detail-page` znika przy braku dostepu — usuniecie go od razu psuje test napisany przez Task 1 (nie mojego autorstwa), co dowodzi, ze mechanizm faktycznie dziala, a nie ze test jest przypadkowo zielony.

Kontrole negatywne z tresci kryterium (nie osobna proba wycofania, ale test wprost): `tests/views-foundation.test.ts` „sprawa innego wlasciciela jest odrzucona” (403/forbidden, nie pusta lista) i „nieistniejaca sprawa daje not_found” (404) dla `case_offer_items`; `e2e/composed-views.spec.ts` „sprawa i pozycja, ktore nie istnieja: stan «nie istnieje», nie pusta ramka ekranu” (oba ekrany, `data-error-code="not_found"`, `data-testid` ramki ma liczbe 0).

---

## 6. Nieudane przebiegi (poza celowymi probami z sekcji 5)

Zaden nieoczekiwany nieudany przebieg. Jedyne opoznienie: druga proba negatywna (#2) wymagala `flock` na wspolnej blokadzie e2e, ktora byla zajeta przez rownolegle zadania przez okolo 10 minut — zgodnie z dispatch-common („Blokada moze czekac na inne zadania — to normalne”), bez akcji z mojej strony poza czekaniem.

---

## 7. Kontrakt dla autora modulu — uzupelnienie

- **Ekran rekordowy bez wlasnego celu UI.** Widok, ktory otwiera sie wylacznie przez `record.route` innego deskryptora (link „szczegoly”/„pochodzenie” itp.), nie musi miec odpowiadajacego `UiTarget` — `checkViewAgainstTarget` akceptuje `target: undefined`, o ile widok nie deklaruje `primaryOperation` wymuszanego przez `filter` celu.
- **Ramka strony musi zniknac przy braku dostepu do rekordu.** Jesli deterministyczne opakowanie trasy renderuje wlasny `data-testid` ekranu (nie tylko `ComposedView`), musi samo zrobic gating-odczyt (ten sam `operation`/`input` lub ta sama trasa modulu, ktora czyta kompozycja) i nie renderowac ramki przy bledzie — inaczej test przelaczenia tozsamosci widzi „fragment cudzego zasobu” tam, gdzie powinien byc tylko `access-denied`. Wspolny klucz zapytania (TanStack Query) sprawia, ze to nie podwaja zadania sieciowego.
- **Link o stalym tekscie (nie o tekscie pola) nie jest `record.route`.** `DataTable`'owy mechanizm linku pokazuje zawsze **wartosc** `titleField`. Link, ktorego widoczny tekst ma byc stalym slowem niezaleznym od rekordu (jak „pochodzenie”), pisze sie jako wlasny, nietabelaryczny komponent modulu — nie jako sztuczne pole deskryptora.
- **Komponenty nietabelaryczne modulu**: `defineComponent` z propsami zawierajacymi wylacznie referencje (id), schemat w react-free pliku (`shared/openui-components.ts` w tym module) — gotowe do wykorzystania przez `ServerModule.openuiComponents` (Task 4), bez importu Reacta po stronie serwera.

---

## 8. Self-review — ustalenia

- Sprawdzone, ze `case_overview` (istniejacy odczyt Task 1, nieuzyty dotad w zadnej kompozycji) i nowy `case_offer_items` **nie duplikuja** logiki biznesowej: oba wywoluja `getCaseDetail`, jedno bezposrednio, drugie przez nowa `listCaseOfferItems`, ktora rowniez woloa `getCaseDetail` — jedno zrodlo prawdy o tym, jakie pozycje istnieja w sprawie (patrz komentarz w `services.ts`).
- Granica platforma-domena: `pnpm check:boundaries` w `pnpm verify` — OK; nowe pliki modulu nie importuja niczego domenowego do `platform-*`.
- `openui-components.ts` celowo bez importu `react`/`@openuidev/react-lang` — zweryfikowane wizualnie (brak importow poza `zod`).
- Nie zmienialem `docs/*`, `.claude/`, zaleznosci; nie dotykalem instancji uzytkownika (8791) ani innych worktree.

---

## 9. Obawy (concerns)

1. **Podwojny odczyt w deterministycznym opakowaniu** (sekcja 2.1) jest architektonicznie uzasadniony testem, ale jest to wzorzec, ktory kazdy przyszly ekran rekordowy z wlasnym `data-testid` bedzie musial powtorzyc recznie — nie ma dla niego wspolnej abstrakcji (np. „gated ComposedView”). Zostawione tak, bo tylko dwa ekrany tego dzis potrzebuja; koordynator moze rozwazyc wspolna pomoc, jesli Task 6 doda kolejne ekrany rekordowe.
2. **Drobna duplikacja deklaracji pola** `unitPriceMinor` (`money_minor`, `unitField: 'currency'`) miedzy `caseOfferItemRecords` (serwer) a lokalna stala w `detailComponents.tsx` (przegladarka, dla `ItemProvenance`, ktory nie czyta tego samego odczytu) — patrz sekcja 2.5, uznane za nieszkodliwe.
3. Nie zmienialem zadnych `docs/*` mimo ze `docs/ACCEPTANCE.md`/macierze moga wciaz odwolywac sie do stanu sprzed T5 (jak w obawie #4 raportu Task 1) — poza moim zakresem (G8).

---

## Fix round 1 (po przegladzie: „Needs fixes”, spec ❌ na G9)

Commit: `1508ed1` — Fix round 1: napraw G9 (etykieta priceBasis, dowod inwariantu widok<->cel), realne naglowki sekcji (6 plikow, +101/−24).

### I1 — niekompletna migracja na `formatFieldValue`: zdublowane etykiety enumu `priceBasis`

**Znalezisko.** `packages/module-procurement/src/ui/detailComponents.tsx:63` (`CaseHeaderView`) nadal mial `{c.priceBasis === 'net' ? 'netto' : 'brutto'}` — recznie napisany ternary duplikujacy etykiety `net -> netto`, `gross -> brutto` juz zadeklarowane w `caseRecords.fields` (`server/views.ts:43-49`), naruszenie G9.

**Poprawka.**
- Dodane `PRICE_BASIS_LABELS: Array<{value: PriceBasis; label: string}>` w `packages/module-procurement/src/shared/index.ts` — jedyne miejsce, w ktorym `net`/`gross` dostaja polskie etykiety.
- `caseRecords.fields` **i** `comparisonRecords.fields` w `server/views.ts` (obie mialy wlasna, identyczna kopie `[{value:'net',label:'netto'},{value:'gross',label:'brutto'}]`) zamienione na `values: PRICE_BASIS_LABELS` — druga duplikacja znaleziona przy okazji audytu, nie byla w tresci zalecenia, ale to ten sam blad.
- `CaseHeaderView` formatuje teraz `formatFieldValue({priceBasis: c.priceBasis}, priceBasisField)`, gdzie `priceBasisField.values = PRICE_BASIS_LABELS` (ta sama tablica, nie kopia jej tresci).
- Przejrzane oba przekonwertowane ekrany pod katem innych recznie formatowanych wartosci biznesowych (opisane w poprawionej sekcji 2.5): `CaseOfferSourcesView.offer.currency` to zwykly tekst bez enumu (nic do zdublowania), `ItemProvenanceView`'s `p.field` (kod pochodzenia typu `unit_price`) nie ma zadnego zarejestrowanego deskryptora, z ktorego `formatFieldValue` moglby wziac etykiete — zostawiony tak jak byl przed T5.
- Raport skorygowany w sekcji 2.5 (bylo niekompletne — nie wspominalo `priceBasis` w ogole).

**Dowod (Vitest + e2e, real backend value comparison).** `pnpm exec vitest run` — 332/332 (bez regresji). Nowa asercja w `e2e/composed-views.spec.ts` („szczegoly sprawy: naglowek i obie tabele rowne backendowi”): etykieta w `.pf-page__lead` porownana z `formatFieldValue` na **prawdziwym deskryptorze** operacji `procurement.cases` pobranym przez `POST /api/read` (nie z lokalnie wpisanym „netto”), wiec test rowniez nie duplikuje etykiety.

**Proba zdolnosci wykrycia** (bez commitu, `pnpm build` + `flock … playwright test`):
| Zmiana | Wynik | Przywrocono |
|---|---|---|
| `PRICE_BASIS_LABELS[0].label`: `'netto'` -> `'ZMIENIONE-TEST'` | `e2e/composed-views.spec.ts` „Wszystkie sprawy: etykiety kodow…” (istniejacy test Task 1, `toHaveText('netto')`) — **1 failed**: `Expected: "netto" / Received: "ZMIENIONE-TEST"` na komorce `priceBasis` tabeli `procurement.cases`. Nowy test szczegolow sprawy pozostal zielony (liczy oczekiwanie z zywego deskryptora, wiec podazyl za zmiana) — co samo w sobie dowodzi jednego zrodla prawdy. | `git diff` przywrocony recznie do `'netto'`, `pnpm build` + oba testy: zielone. |

To jednoczesnie dowod, ze `procurement.cases` (lista) i `CaseHeader` (szczegoly) czytaja **dokladnie te sama** deklaracje etykiety, a nie dwie zgodne przez przypadek.

### I2 — oslabiony test niezmiennika widok<->UiTarget

**Znalezisko.** `tests/views-foundation.test.ts:186` (`GET /api/ui/views`) zastapil ogolna kontrole „kazdy id widoku ma UiTarget” zaszywanym `for (const id of ['procurement.data', 'procurement.cases'])` — test przestal byc dowodem niczego wiecej niz „te dwa konkretne stringi sa na liscie”, i nie wykrylby przyszlego widoku bez parametrow, ktory zapomnial swojego celu.

**Poprawka.** Kontrola wyprowadzona z rzeczywistej listy widokow zwroconej przez `GET /api/ui/views`, dla kazdego z osobna:
- widok **bez** `params` (albo pusta tablica) -> musi byc na liscie `GET /api/ui/targets`;
- widok **z** `params` -> **nie moze** byc na tej liscie (ekran rekordowy otwierany przez `record.route`, nie przez `ui_navigate`).

**Proba zdolnosci wykrycia** (dwa kierunki, bez commitu, `pnpm exec vitest run tests/views-foundation.test.ts -t "zwraca widoki modulow"`):
| Zmiana | Wynik | Przywrocono |
|---|---|---|
| `procurement.case.detail`: `params: ['caseId']` zakomentowane (widok wyglada jak bezparametrowy, bez celu) | **1 failed** — `widok procurement.case.detail bez parametrow powinien miec UiTarget: expected […] to include 'procurement.case.detail'` | `git diff` -> przywrocone `params: ['caseId']`; test zielony. |
| Dodany falszywy `UiTarget` o `id: 'procurement.item.provenance'` (widok z `params`, ktory nie powinien miec celu) do `uiTargets` w `server/index.ts` | **1 failed** — `widok procurement.item.provenance ma parametry trasy, nie powinien miec statycznego UiTarget: expected […] to not include 'procurement.item.provenance'` | Wpis usuniety; test zielony. |

Obie proby pokazuja, ze test faktycznie wyprowadza oczekiwanie z danych, w obie strony — nie tylko sprawdza obecnosc dwoch znanych stringow.

### R1 (ustalenie koordynatora) — utracona semantyka naglowka sekcji

**Znalezisko.** `"Pozycje wymagane"` i `"Oferty"` (`server/views.ts:161,164` w pierwszym przebiegu) byly `TextContent(...)`. Sprawdzone w skompilowanym zrodle `@openuidev/react-ui`: `TextContent` renderuje zwykly `<div className="text-content …">` — bez `h1`-`h6`, bez `role="heading"`. Ekran stracil dwa wpisy w konspekcie dokumentu (document outline) dla technologii wspomagajacych, ktore mial przed T5 (`<h2>Pozycje wymagane</h2>`, `<h2>Oferty</h2>`).

**Poprawka.** Sprawdzony caly katalog `@openuidev/react-ui` (`README.md` + skompilowane `dist/components/*`) pod katem gotowego komponentu tekstowego z semantyka naglowka — brak takiego (`CardHeader` tez renderuje plain `<div>`, sprawdzone w jego zrodle). Dodany nowy, maly komponent modulu: `SectionHeading` (`packages/module-procurement/src/ui/detailComponents.tsx`, schemat `sectionHeadingPropsSchema` w react-free `shared/openui-components.ts`) — renderuje `<h2>{text}</h2>`, ten sam poziom co przed T5. Kompozycja `procurement.case.detail` (`server/views.ts`) uzywa teraz `SectionHeading("Pozycje wymagane")` / `SectionHeading("Oferty")` zamiast `TextContent(...)`. `text` to stala tresc UI wybrana przez kompozycje (jak w `TextContent` z katalogu), nie wartosc rekordu — jedyny wyjatek od zasady „propsy = referencje” w tym module, udokumentowany w naglowku `shared/openui-components.ts`.

**Dowod (e2e, asercja po roli).** `e2e/composed-views.spec.ts`, test „szczegoly sprawy…”: `detailPage.getByRole('heading', { level: 2, name: 'Pozycje wymagane' })` i `{ level: 2, name: 'Oferty' }`, oba `toBeVisible()`.

**Proba zdolnosci wykrycia** (bez commitu): `SectionHeading(...)` -> `TextContent(...)` w obu liniach kompozycji, `pnpm build` + `flock … playwright test e2e/composed-views.spec.ts -g "naglowek i obie tabele"` — **1 failed**: `getByRole('heading', {name: 'Pozycje wymagane', level: 2})` — `element(s) not found` (timeout 15000ms). Przywrocone `SectionHeading(...)`, test zielony.

### Testy pokrywajace i polecenia

| Polecenie | Wynik |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm exec vitest run` | exit 0, **332 passed** (25 plikow; bez zmiany liczby wzgledem przed poprawkami — I2 to modyfikacja istniejacego testu, nie nowy) |
| `pnpm build` | exit 0 |
| `flock … playwright test e2e/composed-views.spec.ts e2e/app.spec.ts` | exit 0, **21 passed** |
| `flock … playwright test e2e/composed-views.spec.ts e2e/app.spec.ts e2e/access-context.spec.ts e2e/session-restore.spec.ts e2e/chat.spec.ts` (pelna kontrola koncowa, wszystkie pliki dotkniete lub potencjalnie wrazliwe na zmiane markupu) | exit 0, **37 passed** |
| `pnpm verify` (check:boundaries, check:acceptance, check:matrix, check:closure, typecheck, build, test) | **exit 0**, 332 Vitest |
| `node scripts/check-boundaries.mjs` | exit 0, granica platforma-domena zachowana |

Po e2e: `git status --porcelain` czysty (bez nieposledzonych plikow `docs/evidence/*`).

### Kontrakt dla autora modulu — uzupelnienie

- **Etykiety enumu deklaruje sie raz**, w react-free stalej modulu (np. `shared/index.ts`), i **wskazuje sie ja** (nie kopiuje) z kazdego miejsca, ktore jej potrzebuje: deskryptor odczytu (`RecordField.values`) i kazdy wlasny komponent modulu formatujacy te sama wartosc poza `DataTable`/`DataSummary`. Recznie napisany `value === 'x' ? 'a' : 'b'` w komponencie ekranu jest zawsze podejrzany, jesli ten sam kod/etykieta pojawia sie tez w jakimkolwiek deskryptorze.
- **Test „widok ma cel UI” powinien byc wyprowadzony z deklaracji widoku** (`params` obecne/nieobecne), nie z zaszytej listy znanych dzis widokow — inaczej test milczy dokladnie wtedy, gdy nowy widok popelnia ten sam blad, ktory mial wykrywac.
- **`TextContent` z katalogu OpenUI nie ma semantyki naglowka.** Sekcja ekranu, ktora ma byc czescia konspektu dokumentu (document outline), potrzebuje albo prawdziwego naglowka z katalogu (jesli kiedys taki bedzie), albo malego, wlasnego komponentu modulu renderujacego `<hN>` — nigdy `TextContent`.

---

## Odpowiedz koncowa

Status: **DONE**
Commity: `b852ae5` (Task 5), `1508ed1` (Fix round 1: G9 — etykieta priceBasis + dowod inwariantu widok<->cel; naglowki sekcji)
Testy: `pnpm verify` exit 0 (332 Vitest, bez regresji); e2e pod blokada po poprawkach: composed-views+app 21/21, pelna kontrola (composed-views+app+access-context+session-restore+chat) 37/37; 3 proby zdolnosci wykrycia (I1, I2 w obie strony, R1) — wszystkie oblaly przed poprawka i przeszly po przywroceniu.
Obawy: bez zmian wzgledem sekcji 9 pierwszego przebiegu (brak wspolnej abstrakcji „gated ComposedView”); nowa: `SectionHeading` to jedyny komponent tego modulu, ktorego prop nie jest referencja — udokumentowane w kodzie i w tym raporcie.
Raport: `/home/paczos/Documents/agentic-app-template-wt/integracja/.superpowers/sdd/2026-09-17-bl01-bl02/task-5-report.md`
