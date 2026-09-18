# Nowa aplikacja na szablonie — kontrakt modułu domenowego

Ten dokument opisuje, jak z szablonu zrobić **inny produkt**: co dostarcza moduł domenowy, co
zapewnia platforma i które pliki zmienia się przy składaniu aplikacji. Wymagania, które nowa
aplikacja nadal musi spełniać, są w [`ARCHITECTURE.md`](ARCHITECTURE.md); ich bieżący stan w
[`ACCEPTANCE.md`](ACCEPTANCE.md).

Przykładem wzorcowym jest `packages/module-procurement` (porównywanie ofert). Minimalnym dowodem,
że kontrakt nie jest przywiązany do tej domeny, jest `packages/module-devkit-probe`.

## 1. Podział odpowiedzialności

| Warstwa | Katalog | Zawiera | Nie zawiera |
|---|---|---|---|
| **Platforma** | `packages/platform-contracts`, `packages/platform-server`, `packages/platform-ui` | powłoka UI (nawigacja, canvas, gotowy czat OpenUI), rozmowy i mapowanie sesji Claude, rejestr uruchomień i strumień AG-UI, host MCP ze strażnikiem schematów, magazyn plików i artefaktów, sandbox, idempotencja, sesja aplikacji, nawigacja agenta po celach UI, diagnostyka | żadnych nazw, tabel ani reguł konkretnej działalności — pilnuje tego `pnpm check:boundaries` |
| **Moduł domenowy** | `packages/module-<nazwa>` | encje i migracje, serwisy z regułami, narzędzia MCP, trasy HTTP, komponenty kart i OpenUI, ekrany, cele nawigacji, odczyty live, dane startowe, opis domeny dla agenta | kodu czatu, transportu, sesji, plików, uruchomień agenta |
| **Składanie aplikacji** | `apps/server`, `apps/web` | wybór modułów i menu platformy; trasy ekranów modułu montuje z `registry.screens`, nie wypisuje | logiki domenowej i platformowej, nazw ekranów modułu |

Kierunek zależności: `apps/*` → `module-*` → `platform-*` → `platform-contracts`. Pakiet
`@platform/*` nie może deklarować ani importować `@module/*`.

## 2. Co zmienia autor nowej aplikacji

Nie kopiuje się ani nie przepisuje pakietów `platform-*`. Kroki:

1. **Utwórz pakiet modułu** `packages/module-<nazwa>` z `package.json`:
   ```json
   {
     "name": "@module/<nazwa>",
     "private": true,
     "type": "module",
     "agenticApp": { "domainVocabulary": ["słowo", "prefiks_tabeli_"] },
     "exports": { "./server": "./src/server/index.ts", "./ui": "./src/ui/index.tsx" },
     "dependencies": { "@platform/contracts": "workspace:*", "@platform/server": "workspace:*", "@platform/ui": "workspace:*" }
   }
   ```
   `agenticApp.domainVocabulary` to słownik, który **nie może** pojawić się w kodzie platformy
   (sprawdzane jako prefiks słowa, bez rozróżniania wielkości liter). Kontrola granicy odmawia
   zaliczenia, jeśli żaden moduł go nie deklaruje. Potem `pnpm install` (zmienia `pnpm-lock.yaml`
   o importer nowego pakietu).
2. **Serwer — zarejestruj moduł** w `apps/server/src/compose.ts`:
   ```ts
   import { createMyModule } from '@module/<nazwa>/server';
   // ...
   modules: (services) => [createMyModule(services)],
   ```
   i dodaj `"@module/<nazwa>": "workspace:*"` do `apps/server/package.json`.
3. **Przeglądarka — zarejestruj moduł** w `apps/web/src/compose.tsx` (`modules: [myUiModule]`) i
   dodaj zależność w `apps/web/package.json`. `apps/web/src/router.tsx` zostaje bez zmian: ekrany
   modułu deklaruje sam moduł w `UiModule.screens`, a router montuje je z `registry.screens`.
4. **Moduł przykładowy** odłącza się, usuwając go z dwóch plików składania (`apps/server/src/compose.ts`,
   `apps/web/src/compose.tsx`). Jego pakiet może zostać na miejscu i dalej się kompiluje — moduł ze
   swoimi ekranami przechodzi typecheck niezależnie od tego, czy aplikacja go składa, bo jego strony
   czytają parametry trasy przez `useScreenParams()` i linkują przez `AppLink`, a nie przez typy tras
   zarejestrowanych przez aplikację. Sprawdza to `pnpm typecheck:modules` (każdy moduł we własnym
   programie, bez `apps/`) i `pnpm check:module-swap`.
   **Połówki serwerowej nie usuwaj od razu**: testy platformy używają jej jako danych testowych
   (patrz §6).
5. **Obraz Docker** kopiuje manifesty pakietów osobno (warstwa instalacji). Dodaj linię
   `COPY packages/module-<nazwa>/package.json packages/module-<nazwa>/` w `Dockerfile`.
6. Uruchom `pnpm verify`, a następnie `pnpm test:e2e`.

Próbę dokładnie tej wymiany wykonuje `pnpm check:module-swap`: na kopii repozytorium zmienia
wyłącznie te dwa pliki składania, sprawdza sumami SHA-256, że `packages/platform-*` **i**
`packages/module-procurement` są bez zmian, instaluje zależności z lockfile, uruchamia kontrolę
granicy, typecheck, build i regresję jednostkową (test dymny: testy w `tests/` budują platformę same
i nie przechodzą przez warstwę składania, więc mówią tylko, że podmiana niczego nie zepsuła — tym,
co naprawdę biegnie na module kontrolnym, jest `tests/module-contract.test.ts`), startuje aplikację
na wolnym porcie i sprawdza rejestr, narzędzia, operację odczytu, cel UI, widok, trasy modułu,
walidację kompozycji i bazę, a w przeglądarce — pozycję menu i nagłówek sekcji od modułu
kontrolnego, jego kartę na canvasie (treść z jego własnej trasy backendu), jego ekran wypełniony
kompozycją OpenUI i jego ekran z parametrem trasy. Kontrole negatywne (czego po wymianie nie wolno
zobaczyć) biorą słownik i nazwy tabel z manifestów oraz migracji modułów, których kopia nie składa —
wymiana modułu przykładowego nie czyni ich bezgłośnymi.

## 3. Serwer: `ServerModule`

Definicja: `packages/platform-contracts/src/module.ts`. Moduł jest fabryką
`(services: PlatformServices) => ServerModule`, więc korzysta z usług platformy (baza, pliki,
identyfikatory) bez importowania jej wnętrza w drugą stronę.

| Pole | Obowiązkowe | Znaczenie | Uwagi z wdrożenia |
|---|---|---|---|
| `meta` | tak | `id` (przestrzeń nazw narzędzi, tras, celów UI), `title`, `version`, `description` | `id` jest trwałe — pojawia się w nazwach narzędzi i w zapisanych deskryptorach |
| `migrations` | tak | lista `{ id, sql }` stosowana raz, każda w transakcji | konwencja `id`: `<modul>-0001-init`; tabele z własnym prefiksem (przykład: `pc_`); zmiana schematu = nowa migracja, nie edycja starej |
| `tools` | tak (może być `[]`) | `ModuleToolDefinition`: `name`, `description`, `inputSchema` (`z.object`), `effect: 'read' \| 'write'`, `handler(input, ctx)` | **odczyt listy bierze okno**: rozsyp `readWindowInput` (`limit`, `offset`) do schematu i zwróć `applyReadWindow(items, input)` razem z `window` i `readWindowNote(...)` — odpowiedź narzędzia trafia do kontekstu modelu i nie może rosnąć z danymi użytkownika (L6.7); zapis rekordu z wersją bierze `expectedVersion` jako **wymagane**, żeby zapis oparty na starym odczycie kończył się `conflict`, a nie cichym nadpisaniem (L6.10). nazwa MCP: `<moduleId>_<name>`; narzędzie to cienka nakładka na serwis; **bez `z.record()` i bez `.default()`** w schemacie wejścia (SDK cicho usuwa cały serwer MCP albo robi pole wymaganym) — `assertMcpCompatibleShape` przerywa start z nazwą pola; zamiast `.default()` użyj `.optional()` i wartości domyślnej w handlerze; `alwaysLoad: true` trzyma narzędzie w prompcie zamiast za `ToolSearch` SDK — tylko dla narzędzi, o których model musi wiedzieć, żeby zachować się poprawnie (platforma ustawia je dla `get_context`, `ui_catalog`, `ui_navigate`, `ui_filter`); każde takie narzędzie jest w każdym prompcie |
| `routes` | nie | `(register: RouteRegistrar) => void`; trasy montowane pod `/api/m/<moduleId>/…` | handler dostaje `PlatformRequest` z `ownerId` z sesji — nigdy z ciała żądania; ta sama metoda serwisu co narzędzie („jedna implementacja, dwoje drzwi”) |
| `cardComponents` | nie | serwerowa połowa katalogu: `id`, `description`, `propsSchema`, `usage` | backend waliduje każdą kompozycję agenta tym schematem; props niosą **referencje** (np. identyfikator rekordu), nie wartości biznesowe |
| `readOperations` | nie | nazwane odczyty: `name`, `description`, `inputSchema`, `run(input, { ownerId })` oraz **`result`** — opis wyniku, bez którego odczyt nie zasili widoku ani komponentu danych | nazwa kwalifikowana `<moduleId>.<name>`; odczyt musi być czysty (bez zapisu) — platforma woła go przy otwarciu artefaktu live, przy `POST /api/read` i przy każdej akcji rekordu. Opis wyniku (`ReadResultDescriptor`) i akcje: sekcja 3.1 |
| `views` | nie | ekrany modułu jako kompozycje OpenUI Lang: `id` (równe `id` celu `UiTarget`, jeśli ekran ma własną trasę), `title`, `composition`, `params?`, `primaryOperation?` | sekcja 3.2; kompozycja jest walidowana przy starcie — niepoprawny widok zatrzymuje aplikację z nazwą modułu, widoku i miejsca |
| `openuiComponents` | nie | serwerowa deklaracja komponentów OpenUI modułu: `name`, `description`, `propsSchema` | ten sam plik bez Reacta zasila `defineComponent` w przeglądarce i tę deklarację; bez niej komponent modułu nie przejdzie walidacji kompozycji (`unknown_component`) |
| `uiTargets` | nie | cele nawigacji agenta: `id` (z prefiksem modułu), `kind` (`view`/`section`/`setting`/`element`), `label`, `description`, `to` i/lub `selector`; opcjonalnie `filter: { collection, fields: [{ field, label, values? }] }` — co agent może zawęzić w widoku | selektor dotyczy markupu modułu; nieaktualny selektor ujawnia się dopiero w działaniu jako `not_present` — dodaj test. `collection` to klucz tablicy w odpowiedzi trasy modułu, którą widok czyta przez `useModuleData`; pola to właściwości jej wierszy. Pole `c` lub `s` (klucze sesji w adresie) jest odrzucane przy starcie. Pole spoza listy agent dostaje jako odmowę `unknown_field` |
| `agentBriefing` | nie | tekst o słowniku domeny do promptu systemowego | słownik, **nie reguły** — reguły są w serwisach |
| `describeResource` | nie | krótki opis zasobu z kontekstu UI (`{ kind, id }`) | pozwala agentowi zrozumieć „ten rekord” bez ładowania bazy. **Zwracaj `null` wyłącznie dla rodzaju, którego twój moduł nie opisuje.** Rekord usunięty albo cudzy to nie „brak opisu”, tylko błąd — pozwól serwisowi rzucić `AppError` (`not_found` / `forbidden`); platforma zamieni to na stan `ResourceDescription` i powie agentowi wprost, czego nie wolno zmyślać. Połknięcie błędu do `null` sprawia, że usunięty, cudzy i nieopisany rekord są nierozróżnialne (L6.11) |
| `defaultComposition` | nie | karty nowej przestrzeni dla zakresu `{ kind, id }` | przechodzi przez tę samą walidację katalogu co zmiany agenta |
| `seed` | nie | dane startowe; dostaje `ownerId` i `storeFile` | dane **syntetyczne i generowane w kodzie**; `ensureBaseData` wykonuje je raz na moduł i zapisuje znacznik w `app_settings` |
| `baseDataScopes` | nie | rekordy danych startowych, które mają od razu dostać przestrzeń na canvasie | platforma buduje przestrzeń z `defaultComposition` |

Kontekst wywołania narzędzia (`ToolCallContext`): `ownerId` (z sesji), `appContext` (rozmowa,
przestrzeń, zasób, zaznaczenie, filtry, szkice), `conversationId`, `runId`, `workspaceDir` (katalog
sandboxu uruchomienia), `emit(event)` (`data_changed` z listą zasobów, `canvas_changed`,
`artifact_created` — frontend unieważnia na tej podstawie zapytania) oraz `requestUi` (nawigacja i opcjonalne zawężenie `filter` z
potwierdzeniem klienta).

Wymagania specyfikacji, które spadają na moduł: walidacja w runtime i rozpoznawalne błędy
(`AppError`), sprawdzanie dostępu po `ownerId`, konflikt wersji przy zapisie, idempotencja operacji
zapisu, atomowość wieloetapowych zapisów (L9.3–L9.8, L9.14–L9.16). Serwisy mają być testowalne bez
modelu i bez UI (L9.10).

### 3.1 Opis wyniku odczytu (`ReadResultDescriptor`) i akcje rekordu

Odczyt bez `result` nadal działa jako źródło artefaktu live, ale **nie** zasili widoku, tabeli,
wykresu ani podsumowania — platforma nie zgaduje, co jest rekordem i co znaczy pole.

```ts
result: {
  collection: 'suppliers',              // klucz tablicy rekordów w wyniku; brak = wynik jest tablicą albo jednym rekordem
  record: { kind: 'supplier', idField: 'id', titleField: 'name', route: '/suppliers/{id}' },
  fields: [
    { field: 'name',          label: 'Nazwa',         type: 'text' },
    { field: 'country',       label: 'Kraj',          type: 'enum', values: [{ value: 'PL', label: 'Polska' }] },
    { field: 'unitPriceMinor',label: 'Cena jedn.',    type: 'money_minor', unitField: 'currency' },
    { field: 'quantityMilli', label: 'Ilosc',         type: 'quantity_milli', unitField: 'unit', sortable: false },
  ],
  actions: [{ id: 'change_unit_price', label: 'Zmien cene', tool: 'update_offer_item',
              input: [{ key: 'itemId', from: '$record.id' }, { key: 'unitPrice', from: '$form.unitPrice' }],
              form: [{ key: 'unitPrice', label: 'Nowa cena', type: 'number' }] }],
}
```

Reguły, które platforma egzekwuje (naruszenie zatrzymuje start z nazwą modułu, odczytu i pola):

- typy pól: `text`, `number`, `money_minor` (grosze), `quantity_milli` (tysięczne), `date` (ISO),
  `boolean`, `enum`; `unitField` i `titleField` muszą wskazywać **zadeklarowane** pole, a każdy
  `{placeholder}` w `record.route` — pole albo `idField`;
- pole spoza `fields` jest odrzucane po nazwie wszędzie: w kolumnach, seriach, filtrze, sortowaniu,
  grupowaniu, w `ui_filter`, `ui_sort` i w kompozycji agenta;
- **jednostka jest częścią wartości**: seria wykresu i porządek sortowania po polu z `unitField` są
  odrzucane, gdy rekordy nie zgadzają się co do jednostki (PLN obok EUR nie jest jedną skalą);
- akcja rekordu wskazuje narzędzie **tego samego** modułu o `effect: 'write'`; mapowane klucze muszą
  istnieć w schemacie wejścia narzędzia, a wartości `$record.<pole>` pochodzą z ponownego odczytu po
  stronie serwera, nigdy z przeglądarki. Platforma wykonuje ją przez `POST /api/actions` tym samym
  wykonaniem co MCP, z właścicielem z sesji i wymaganym `operationId` (idempotencja).

Ta sama akcja pojawia się wszędzie, gdzie widoczny jest ten odczyt — w widoku domyślnym i w widoku
agenta — bo należy do odczytu, nie do ekranu.

### 3.2 Widoki modułu (`views`) i „Widoki agenta”

Ekran modułu to program OpenUI Lang nad wspólnym katalogiem; React zostaje w komponentach:

```ts
{ id: 'procurement.data', title: 'Dostawcy', primaryOperation: 'procurement.suppliers',
  composition: [
    'root = Stack([lead, tabela])',
    'lead = TextContent("Dostawcy zarejestrowani w aplikacji.")',
    `tabela = DataTable({operation: "procurement.suppliers"}, ["name", "country"], null, 10)`,
  ].join('\n') }
```

- argumenty są **pozycyjne**, w kolejności kluczy schematu: `DataTable(source, columns?, title?,
  pageSize?, filter?, sort?, groupBy?)`, `DataChart(source, kind, x, series, title?, filter?, sort?)`,
  `DataSummary(source, fields, title?)`; `null` pomija argument opcjonalny;
- `params` udostępnia parametry trasy jako `$nazwa` (ekran rekordu: `/cases/$caseId`); ekran z
  `params` nie ma własnego `UiTarget` — otwiera się go linkiem rekordu (`record.route`);
- `primaryOperation` wskazuje odczyt instancji głównej: to ona bierze zawężenie, sortowanie i stronę
  z adresu i raportuje „N z M”. Cel `UiTarget` z `filter` wymaga `primaryOperation`, a jego pola i
  podpowiadane wartości muszą pochodzić z deskryptora;
- kompozycja przechodzi walidację serwera (parser OpenUI Lang) przy starcie i przy każdym zapisie:
  nieznany komponent, błąd składni, opis częściowy, instrukcja nieosiągalna z `root`, niezarejestrowana
  operacja, niezgodne wejście i pole spoza deskryptora są odrzucane z nazwą;
- w przestrzeni „Widoki agenta” (zakres `conversation:<id>`) obowiązuje węższa lista komponentów:
  komponenty danych, komponenty modułu zadeklarowane w `openuiComponents` i jawna lista komponentów
  układu. Komponenty przyjmujące liczby albo wiersze od modelu są tam zabronione, żeby widok nie stał
  się drugą bazą danych w treści odpowiedzi.

## 4. Przeglądarka: `UiModule`

Definicja: `packages/platform-ui/src/catalog/registry.tsx`.

| Pole | Znaczenie |
|---|---|
| `meta` | jak po stronie serwera |
| `cardRenderers` | komponenty React kart, kluczowane `id` z `cardComponents`; dostają `{ cardId, props }` i **same pobierają dane** z backendu (TanStack Query) |
| `openuiComponents` | komponenty OpenUI Lang (`defineComponent`), które agent może złożyć w wiadomości lub w karcie `openui`; dołączane do katalogu `@openuidev/react-ui` |
| `artifactRenderers` | renderery artefaktów po `rendererType` |
| `menu` | pozycje nawigacji: `section` (`workspace`, `records`, `data`, `files`, `settings`), `label`, `to`, `order` |
| `menuSections` | jak moduł nazywa sekcje, w których ma pozycje, np. `{ records: 'Sprawy zakupowe' }`. Zbiór sekcji należy do platformy, ich **nazwy** do modułu; sekcja, której nikt nie nazwał, dostaje neutralny nagłówek (`NEUTRAL_MENU_SECTION_LABELS`). Dwa moduły nazywające tę samą sekcję inaczej przerywają budowę rejestru |
| `screens` | ekrany modułu: `{ id, path, component }`; `path` może mieć segmenty `$param`. Montuje je warstwa składania, więc żaden plik poza modułem nie nazywa jego ekranu. Konflikt `id` albo `path` (także ze ścieżką ekranu platformy) przerywa budowę rejestru |
| `starters` | podpowiedzi poleceń w czacie — słownik domeny należy do modułu, nie do platformy |

Ekran złożony z kompozycji (`ViewDefinition`) renderuje `<ComposedView viewId=… params={…} />`, a dane
pobierają komponenty danych przez `POST /api/read` (`useReadOperation`). Instancja główna widoku —
`DataTable` czytający `primaryOperation` — bierze z adresu zawężenie, sortowanie i stronę, raportuje
„N z M” do paska nad powierzchnią roboczą i do potwierdzenia dla agenta. Zawężenie i porządek odsiewają
i układają wiersze **już pobrane**: to prezentacja, nie filtr po stronie serwera.

Ekran, który pobiera dane inaczej (własny `useModuleData(moduleId, path)` po trasie modułu), nadal
działa i nadal dostaje zawężenie z adresu dla kolekcji zadeklarowanej w `uiTargets[].filter`, ale nie ma
sortowania, stron ani opisu semantycznego dla agenta — agent zobaczy taki ekran jako widok bez instancji
danych, a `ui_sort` odpowie `not_sortable`.

Nawigacja w module idzie przez dwa pomocniki z `@platform/ui` i tylko przez nie: `useScreenParams()`
zwraca parametry trasy ekranu, na którym jesteśmy (`Record<string, string>`), a `AppLink` prowadzi pod
ścieżkę (`to`, opcjonalnie `params` dla segmentów `$…`). Moduł **nie** importuje `@tanstack/react-router`
— jego rejestracja jest globalna, więc moduł, który po nią sięga, typuje swoje ekrany względem tablicy
tras akurat złożonej aplikacji i przestaje się kompilować dla innej. Pilnuje tego `pnpm check:boundaries`
(manifest i importy) oraz `pnpm typecheck:modules`.

Zasady: listy `cardComponents` (serwer) i `cardRenderers` (przeglądarka) muszą się zgadzać
(konflikt identyfikatora przerywa budowę rejestru). Router zachowuje parametry `c` (rozmowa) i `s`
(przestrzeń) przy każdej nawigacji — także dla `AppLink`; pozostałe parametry (np. zawężenie
`?country=PL`) walidator przepuszcza, ale nie przenoszą się na inny ekran.

### Słownik domeny w manifeście modułu

`pnpm check:boundaries` odmawia, gdy pakiet platformy zawiera pojęcie domenowe — w kodzie **albo** w
konfiguracji. Skąd bierze pojęcia: z manifestu każdego modułu, w dwóch listach o różnym dopasowaniu.

```jsonc
"agenticApp": {
  // przedrostki przy granicy słowa — identyfikatory, prefiksy tabel
  "domainVocabulary": ["supplier", "dostawc", "unitPrice", "pc_cases"],
  // całe słowa i frazy — to, co użytkownik widzi na ekranie
  "domainLabels": ["sprawa", "sprawy", "sprawe", "cena jednostkowa"],
  // zakresy canvasu, na które odpowiada `defaultComposition` tego modułu
  "scopeKinds": ["case"]
}
```

Dwie listy, bo jedna nie umiałaby obu rzeczy naraz: `dostawc` musi łapać `dostawcy` i `supplierName`,
a `spraw` jako przedrostek skazałby w powłoce każde „sprawdza”, „sprawne” i „Sprawdz”. Etykieta
dopasowuje się jako całe słowo lub fraza. Obie listy muszą być niepuste u co najmniej jednego modułu —
inaczej kontrola przechodziłaby, nie mając czego sprawdzać.

`scopeKinds` jest tam z innego powodu niż dwie listy słownika: `pnpm check:module-swap` bierze stamtąd
zakres modułu, który składa (musi **wytworzyć** jego kompozycję domyślną), i zakresy modułów, których
nie składa (nie mają wytworzyć niczego). Deklaracja rozjechana z `defaultComposition` oblewa w
`tests/module-contract.test.ts`, a nie dopiero w próbie wymiany.

Etykiety widoczne w interfejsie **należą do modułu**: nagłówek sekcji menu podaje się przez
`UiModule.menuSections`, a nie wpisuje w powłokę. Teksty stanów pustych platformy mówią o „rekordzie”,
bo platforma nie wie, czym jest rekord w twojej domenie.

## 5. Co zapewnia platforma bez pracy po stronie modułu

- gotowy czat (OpenUI Agent Interface) z historią, tytułami, narzędziami, artefaktami i
  załącznikami; przywracanie rozmowy i przestrzeni po przeładowaniu;
- wykonanie agenta: Mastra + Claude Agent SDK na subskrypcji (bez klucza API), serwer MCP per
  uruchomienie, kolejka per rozmowa, zadania w tle niezależne od panelu, jawne Stop;
- narzędzia platformy dostępne dla agenta: kontekst aplikacji, canvas (dodanie, zmiana, przesunięcie,
  usunięcie karty), pliki i ich wersje, artefakty snapshot/live, nawigacja po celach UI;
- pliki PNG/JPEG/XLSX/CSV/tekst z analizą w sandboxie (biblioteki z kuratorowanej listy
  `agent/toolkit.ts`), zgoda użytkownika na uruchomienie kodu;
- zawężanie widoku przez agenta (`ui_filter`) dla widoków deklarujących `filter`: stan w adresie, pasek z liczbami i powrotem do pełnego widoku, potwierdzenie klienta;
- trwałość (SQLite + WAL), migracje platformy, kopia i próba migracji (`docs/odzyskiwanie-stanu.md`),
  diagnostyka (`pnpm diag`), izolowane testy przeglądarkowe.

Czego platforma dziś **nie** zapewnia (pełna lista: [`BACKLOG.md`](BACKLOG.md)): semantycznego
opisu aktywnego ekranu (instancje komponentów, rekord–pole, wersja kompozycji) dla agenta, sortowania
i paginacji sterowanych rozmową, wskazania wartości pola rekordu ani osobnej przestrzeni „Widoki
agenta” (L2.16–17, L3.14–18, L6.15–17). Zawężanie filtrem działa tylko w widokach deklarujących pola
i tylko na danych już pobranych przez widok.

## 6. Testy nowej aplikacji

| Zestaw | Zależność od modułu przykładowego | Co zrobić w nowej aplikacji |
|---|---|---|
| `tests/platform-boundary.test.ts` | używa modułu kontrolnego | zostawić — dowodzi niezależności platformy |
| `tests/module-contract.test.ts` | używa modułu kontrolnego (obie połówki) | zostawić — sprawdza wszystkie kontrakty rejestracji modułu i brak odwołań do tabel nieobecnego modułu |
| `tests/helpers.ts` (`createHarness`) i większość `tests/*.test.ts` | **tak** — harness rejestruje `module-procurement` i jego dane jako fixture; to testy zachowań platformy *na przykładowej aplikacji*, nie testy wymienialności | zostawić pakiet przykładu jako fixture albo przepisać harness na własny moduł. Cała ta regresja przechodzi także wtedy, gdy aplikacja składa inny moduł — sprawdza to `pnpm check:module-swap`, który uruchamia `pnpm test` na kopii z modułem kontrolnym |
| `tests/domain-comparison.test.ts` | testy reguł przykładu | zastąpić testami reguł własnej domeny (bez modelu i UI) |
| `e2e/*.spec.ts` | część scenariuszy (`app`, `chat`, `agent-ui`, `measurements`, `files-agent`) klika w ekrany i dane przykładu | dostosować do ekranów nowej domeny; zachować zasady izolacji z `e2e/support/isolation.ts` |
| `scripts/acceptance-agent.mjs`, `scripts/run-agent.mjs` | scenariusze z prawdziwym modelem na danych przykładu | przepisać scenariusze na własną domenę |

Zasady dowodu, które obowiązują także nową aplikację: test GUI zaczyna się interakcją w GUI i
kończy widocznym wynikiem; próba z prawdziwym modelem jest oznaczona osobno; testy nie używają
instancji ani katalogu danych użytkownika; kontrola negatywna musi umieć oblać test. Szczegóły:
[`../AGENTS.md`](../AGENTS.md) i sekcja „Jakość testów” w [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 7. Znane pułapki stosu

| Pułapka | Skutek | Ochrona |
|---|---|---|
| `z.record()` w schemacie narzędzia | SDK usuwa **cały** serwer MCP, agent „nie widzi narzędzi” | `assertMcpCompatibleShape` przy starcie; `z.looseObject({})` zamiast `z.record()` |
| `.default()` w schemacie narzędzia | pole staje się wymagane dla modelu | `.optional()` + wartość domyślna w handlerze |
| `allowedTools` w SDK | nazwa na liście zatwierdza narzędzie **przed** `canUseTool`, więc bramka zgody staje się martwym kodem | macierz w `agent/permissions.ts`: `Bash` celowo nie jest na liście; `sandbox.autoAllowBashIfSandboxed` pozostaje `false`, bo zatwierdza polecenia powłoki jeszcze wcześniej |
| narzędzia sieciowe SDK (`WebFetch`, `WebSearch`) | działają w procesie SDK, **poza** sandboxem poleceń, więc pusta lista domen ich nie ogranicza; bez kategorii „zabronione” trafiały do pytania, na które użytkownik mógł odpowiedzieć „tak” | kategoria `forbidden` w macierzy → `disallowedTools` w SDK **oraz** odmowa w bramce (obrona w dwóch miejscach) |
| odpowiedź na zgodę bez powiązania z wykonaniem | odpowiedź wysłana pod adres jednego uruchomienia z `requestId` innego rozstrzygała to drugie | `answerPermission` porównuje `runId` i właściciela; powtórzona i spóźniona odpowiedź zwraca `answered: false` |
| `@mastra/claude` 0.3.1 przekazuje tylko tekst | brak zdarzeń narzędzi i `session_id` w strumieniu Mastry | most hooków SDK w `platform-server/src/agent/runtime.ts`; przy aktualizacji adaptera sprawdzić, czy zdarzenia nie zaczną się dublować |
| SDK odracza narzędzia, gdy jest ich dużo (`ToolSearch`) | model nie ma w kontekście narzędzia, które prompt każe mu wywołać (zaobserwowane: `ui_navigate` za `ToolSearch`, agent odpowiadał tekstem zamiast przenieść ekran) | `alwaysLoad: true` dla nielicznych narzędzi sterujących; gdy model „nie słucha instrukcji”, najpierw sprawdź w zdarzeniach uruchomienia, czy narzędzie było dostępne |
| wyszukiwanie z `LIKE '%*%'` | „pokaż wszystko” zwracało pustą listę, a model mówił, że aplikacja jest pusta | w przykładzie `*` znaczy „wszystko”, a odpowiedź niesie `totals`; ta sama zasada dotyczy własnych narzędzi wyszukiwania |
| gotowy czat ignoruje zdarzenia `CUSTOM` | kanał platformy (unieważnienia, zgody) niewidoczny | `platformAdapter.ts` obsługuje je równolegle |
| dziecko `AgentInterface` bez roli slotu | renderuje się jako kolumna obok wątku | kontrolki kompozytora wstawiane portalem; test geometrii `e2e/chat-layout.spec.ts` |
| selektor celu UI w module | zmiana markupu psuje nawigację dopiero w działaniu | test przeglądarkowy celu |
| XLSX | formuły nie są przeliczane (formuła zapisana przez agenta nie niesie żadnej wartości); części, których parser nie modeluje — wykresy, tabele przestawne — znikają przy zapisie, bo skoroszyt powstaje z modelu parsera; obrazy i formatowanie komórek **przetrwają**; `.xlsm`/`.xls` odrzucane | zakres jawny w `FILE_ANALYSIS` (kontrakty), sprawdzany w `tests/file-analysis.test.ts` (część wstrzykiwana do archiwum i szukana po zapisie) |

Historia tych ustaleń: [`archive/agenticapp-2026-09/FEEDBACK.md`](archive/agenticapp-2026-09/FEEDBACK.md)
(wpisy #15, #17, #18, #23, #39, #40, #41 oraz sekcje 6–8).
