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
| **Składanie aplikacji** | `apps/server`, `apps/web` | wybór modułów, trasy ekranów modułu, menu platformy | logiki domenowej i platformowej |

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
3. **Przeglądarka — zarejestruj moduł** w `apps/web/src/compose.tsx` (`modules: [myUiModule]`),
   dodaj ekrany modułu jako trasy w `apps/web/src/router.tsx` i zależność w `apps/web/package.json`.
4. **Moduł przykładowy** odłącza się, usuwając go z tych trzech plików składania **oraz usuwając
   jego połówkę przeglądarkową** (`packages/module-procurement/src/ui` i eksport `./ui` w jego
   `package.json`). To drugie jest konieczne: ekrany przykładu używają typowanych linków TanStack
   Router (`to="/cases/$caseId"`), a typy tras pochodzą z globalnej rejestracji routera w
   `apps/web/src/router.tsx`. Bez tras przykładu w routerze `pnpm typecheck` oblewa w
   `module-procurement/src/ui/pages.tsx` — ustalone próbą `pnpm check:module-swap`. Własny moduł
   z typowanymi linkami ma tę samą zależność od routera aplikacji.
   **Połówki serwerowej nie usuwaj od razu**: testy platformy używają jej jako danych testowych
   (patrz §6).
5. **Obraz Docker** kopiuje manifesty pakietów osobno (warstwa instalacji). Dodaj linię
   `COPY packages/module-<nazwa>/package.json packages/module-<nazwa>/` w `Dockerfile`.
6. Uruchom `pnpm verify`, a następnie `pnpm test:e2e`.

Próbę dokładnie tej wymiany wykonuje `pnpm check:module-swap`: na kopii repozytorium zastępuje
moduł przykładowy modułem kontrolnym w `apps/` i usuwa połówkę UI przykładu (krok 4), sprawdza
sumami, że `packages/platform-*` się nie zmieniły, instaluje zależności z lockfile, uruchamia
kontrolę granicy, typecheck i build, startuje aplikację na wolnym porcie i sprawdza rejestr,
narzędzia, trasę modułu, walidację kompozycji, bazę i powłokę w przeglądarce. Moduł kontrolny nie
ma połówki przeglądarkowej, więc rejestracja renderera karty drugiego modułu nie jest tą próbą
objęta (pozycja w backlogu).

## 3. Serwer: `ServerModule`

Definicja: `packages/platform-contracts/src/module.ts`. Moduł jest fabryką
`(services: PlatformServices) => ServerModule`, więc korzysta z usług platformy (baza, pliki,
identyfikatory) bez importowania jej wnętrza w drugą stronę.

| Pole | Obowiązkowe | Znaczenie | Uwagi z wdrożenia |
|---|---|---|---|
| `meta` | tak | `id` (przestrzeń nazw narzędzi, tras, celów UI), `title`, `version`, `description` | `id` jest trwałe — pojawia się w nazwach narzędzi i w zapisanych deskryptorach |
| `migrations` | tak | lista `{ id, sql }` stosowana raz, każda w transakcji | konwencja `id`: `<modul>-0001-init`; tabele z własnym prefiksem (przykład: `pc_`); zmiana schematu = nowa migracja, nie edycja starej |
| `tools` | tak (może być `[]`) | `ModuleToolDefinition`: `name`, `description`, `inputSchema` (`z.object`), `effect: 'read' \| 'write'`, `handler(input, ctx)` | nazwa MCP: `<moduleId>_<name>`; narzędzie to cienka nakładka na serwis; **bez `z.record()` i bez `.default()`** w schemacie wejścia (SDK cicho usuwa cały serwer MCP albo robi pole wymaganym) — `assertMcpCompatibleShape` przerywa start z nazwą pola; zamiast `.default()` użyj `.optional()` i wartości domyślnej w handlerze |
| `routes` | nie | `(register: RouteRegistrar) => void`; trasy montowane pod `/api/m/<moduleId>/…` | handler dostaje `PlatformRequest` z `ownerId` z sesji — nigdy z ciała żądania; ta sama metoda serwisu co narzędzie („jedna implementacja, dwoje drzwi”) |
| `cardComponents` | nie | serwerowa połowa katalogu: `id`, `description`, `propsSchema`, `usage` | backend waliduje każdą kompozycję agenta tym schematem; props niosą **referencje** (np. identyfikator rekordu), nie wartości biznesowe |
| `readOperations` | nie | nazwane odczyty dla artefaktów live: `name`, `inputSchema`, `run(input, { ownerId })` | nazwa kwalifikowana `<moduleId>.<name>`; odczyt musi być czysty (bez zapisu) — platforma woła go przy otwarciu artefaktu |
| `uiTargets` | nie | cele nawigacji agenta: `id` (z prefiksem modułu), `kind` (`view`/`section`/`setting`/`element`), `label`, `description`, `to` i/lub `selector` | selektor dotyczy markupu modułu; nieaktualny selektor ujawnia się dopiero w działaniu jako `not_present` — dodaj test |
| `agentBriefing` | nie | tekst o słowniku domeny do promptu systemowego | słownik, **nie reguły** — reguły są w serwisach |
| `describeResource` | nie | krótki opis zasobu z kontekstu UI (`{ kind, id }`) | pozwala agentowi zrozumieć „ten rekord” bez ładowania bazy |
| `defaultComposition` | nie | karty nowej przestrzeni dla zakresu `{ kind, id }` | przechodzi przez tę samą walidację katalogu co zmiany agenta |
| `seed` | nie | dane startowe; dostaje `ownerId` i `storeFile` | dane **syntetyczne i generowane w kodzie**; `ensureBaseData` wykonuje je raz na moduł i zapisuje znacznik w `app_settings` |
| `baseDataScopes` | nie | rekordy danych startowych, które mają od razu dostać przestrzeń na canvasie | platforma buduje przestrzeń z `defaultComposition` |

Kontekst wywołania narzędzia (`ToolCallContext`): `ownerId` (z sesji), `appContext` (rozmowa,
przestrzeń, zasób, zaznaczenie, filtry, szkice), `conversationId`, `runId`, `workspaceDir` (katalog
sandboxu uruchomienia), `emit(event)` (`data_changed` z listą zasobów, `canvas_changed`,
`artifact_created` — frontend unieważnia na tej podstawie zapytania) oraz `requestUi` (nawigacja z
potwierdzeniem klienta).

Wymagania specyfikacji, które spadają na moduł: walidacja w runtime i rozpoznawalne błędy
(`AppError`), sprawdzanie dostępu po `ownerId`, konflikt wersji przy zapisie, idempotencja operacji
zapisu, atomowość wieloetapowych zapisów (L9.3–L9.8, L9.14–L9.16). Serwisy mają być testowalne bez
modelu i bez UI (L9.10).

## 4. Przeglądarka: `UiModule`

Definicja: `packages/platform-ui/src/catalog/registry.tsx`.

| Pole | Znaczenie |
|---|---|
| `meta` | jak po stronie serwera |
| `cardRenderers` | komponenty React kart, kluczowane `id` z `cardComponents`; dostają `{ cardId, props }` i **same pobierają dane** z backendu (TanStack Query) |
| `openuiComponents` | komponenty OpenUI Lang (`defineComponent`), które agent może złożyć w wiadomości lub w karcie `openui`; dołączane do katalogu `@openuidev/react-ui` |
| `artifactRenderers` | renderery artefaktów po `rendererType` |
| `menu` | pozycje nawigacji: `section` (`workspace`, `records`, `data`, `files`, `settings`), `label`, `to`, `order` |
| `starters` | podpowiedzi poleceń w czacie — słownik domeny należy do modułu, nie do platformy |

Zasady: listy `cardComponents` (serwer) i `cardRenderers` (przeglądarka) muszą się zgadzać
(konflikt identyfikatora przerywa budowę rejestru). Ekrany modułu montuje `apps/web/src/router.tsx`;
router zachowuje parametry `c` (rozmowa) i `s` (przestrzeń) dla każdej trasy.

## 5. Co zapewnia platforma bez pracy po stronie modułu

- gotowy czat (OpenUI Agent Interface) z historią, tytułami, narzędziami, artefaktami i
  załącznikami; przywracanie rozmowy i przestrzeni po przeładowaniu;
- wykonanie agenta: Mastra + Claude Agent SDK na subskrypcji (bez klucza API), serwer MCP per
  uruchomienie, kolejka per rozmowa, zadania w tle niezależne od panelu, jawne Stop;
- narzędzia platformy dostępne dla agenta: kontekst aplikacji, canvas (dodanie, zmiana, przesunięcie,
  usunięcie karty), pliki i ich wersje, artefakty snapshot/live, nawigacja po celach UI;
- pliki PNG/JPEG/XLSX/CSV/tekst z analizą w sandboxie (biblioteki z kuratorowanej listy
  `agent/toolkit.ts`), zgoda użytkownika na uruchomienie kodu;
- trwałość (SQLite + WAL), migracje platformy, kopia i próba migracji (`docs/odzyskiwanie-stanu.md`),
  diagnostyka (`pnpm diag`), izolowane testy przeglądarkowe.

Czego platforma dziś **nie** zapewnia (pełna lista: [`BACKLOG.md`](BACKLOG.md)): semantycznego
opisu aktywnego ekranu z filtrami i sortowaniem dla agenta, sterowania filtrami przez rozmowę ani
osobnej przestrzeni „Widoki agenta” (L2.16–17, L3.14–18, L6.15–17).

## 6. Testy nowej aplikacji

| Zestaw | Zależność od modułu przykładowego | Co zrobić w nowej aplikacji |
|---|---|---|
| `tests/platform-boundary.test.ts` | używa modułu kontrolnego | zostawić — dowodzi niezależności platformy |
| `tests/helpers.ts` (`createHarness`) i większość `tests/*.test.ts` | **tak** — harness domyślnie rejestruje `module-procurement` i jego dane jako fixture testów platformy | zostawić pakiet przykładu jako fixture albo przepisać harness na własny moduł; oddzielenie testów platformy od przykładu jest w backlogu |
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
| `allowedTools` w SDK | nazwa na liście omija `canUseTool` (bramkę zgody) | narzędzia modułu są operacjami domenowymi za regułami backendu; powłoka idzie przez zgodę |
| `@mastra/claude` 0.3.1 przekazuje tylko tekst | brak zdarzeń narzędzi i `session_id` w strumieniu Mastry | most hooków SDK w `platform-server/src/agent/runtime.ts`; przy aktualizacji adaptera sprawdzić, czy zdarzenia nie zaczną się dublować |
| gotowy czat ignoruje zdarzenia `CUSTOM` | kanał platformy (unieważnienia, zgody) niewidoczny | `platformAdapter.ts` obsługuje je równolegle |
| dziecko `AgentInterface` bez roli slotu | renderuje się jako kolumna obok wątku | kontrolki kompozytora wstawiane portalem; test geometrii `e2e/chat-layout.spec.ts` |
| selektor celu UI w module | zmiana markupu psuje nawigację dopiero w działaniu | test przeglądarkowy celu |
| XLSX | formuły nie są przeliczane; wykresy i formatowanie warunkowe nie są zachowywane przy zapisie; `.xlsm`/`.xls` odrzucane | zakres jawny w `FILE_ANALYSIS` (kontrakty) |

Historia tych ustaleń: [`archive/agenticapp-2026-09/FEEDBACK.md`](archive/agenticapp-2026-09/FEEDBACK.md)
(wpisy #15, #17, #18, #23, #39 oraz sekcje 6–8).
