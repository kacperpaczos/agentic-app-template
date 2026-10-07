# Wykonywalne grafy na kanwie — propozycja rozszerzenia v0.4.1

> **Status: propozycja / do zatwierdzenia.** Dokument opisuje kierunek dla
> szablonu aplikacji agentowej. Nie jest zatwierdzoną decyzją, wymaganiem
> odbioru ani opisem istniejącej implementacji.

## Cel i zmiana względem obecnego v0.4

W v0.4 kanwa używa React Flow do rozmieszczania kart. Karta wskazuje
zarejestrowany komponent, właściwości lub powiązania danych, geometrię i wersje.
Ten model nie ma wykonawczych krawędzi, typowanych portów ani logiki workflow.
Obecny runtime Mastry konfiguruje `InMemoryStore`; kod i
[`observability.md`](observability.md) uzasadniają to tym, że adapter
nie używał storage do trwałości aplikacji. `@mastra/libsql` nie znajduje się
obecnie w zależnościach. Wykonywalne workflow ze snapshotami zmieniłyby to
założenie i wymagają osobnej decyzji o adapterze oraz migracji.

Ta propozycja dodaje drugi, jawnie wykonywalny rodzaj zawartości kanwy:

- **GraphDoc** zapisuje węzły, ich parametry, pozycje oraz krawędzie danych;
- rejestr węzłów wiąże ich definicję UI i kontrakty danych z wykonaniem;
- serwer waliduje GraphDoc i kompiluje go do workflow Mastry;
- wynikowe artefakty mogą być wyświetlane jako dotychczasowe karty;
- agent może zmieniać graf wyłącznie przez autoryzowane narzędzia MCP.

Karty artefaktów zachowują dotychczasową rolę. Graf nie zastępuje backendu jako
właściciela danych biznesowych, a React Flow nie staje się silnikiem wykonania.
Silnikiem wykonania w tej propozycji jest workflow Mastry. Granicę kompilacji
opisuje `GraphRunner`, aby przyszła zmiana runnera nie wymagała zmiany GraphDoc
ani edytora.

Docelowym wdrożeniem pozostaje lokalna aplikacja: jeden proces Node.js, SQLite,
bez osobnego serwera bazy i bez założenia współbieżnej edycji przez wielu
użytkowników.

## Status twierdzeń

- **Potwierdzone w dokumentacji/API:** w bieżących materiałach Mastry workflow
  jest budowany przez `createWorkflow`, kroki przez `createStep`, a definicję
  kończy `.commit()`. Udokumentowany builder obsługuje łączenie `.then()`,
  rozgałęzienia `.branch()`, równoległość `.parallel()` i iteracje `.foreach()`.
  Workflow może emitować zdarzenia strumienia, w tym zdarzenia początku i
  wyniku kroku. Współczesna dokumentacja opisuje snapshoty przy zawieszeniu,
  zapis w skonfigurowanym storage oraz wznowienie zawieszonego przebiegu.
- **Potwierdzone lokalnie:** repo ma `@mastra/core` **1.66.0** i
  `@mastra/claude` **0.3.1**. Typy zainstalowanego `@mastra/core` zawierają
  `createStep`, `createWorkflow`, `commit()`, `stream()`, `watch()` i
  `resumeStream()`. Typy lokalne workflow zawierają schematy wejścia/wyjścia
  oraz suspend/resume. To potwierdza obecność API w paczce, nie zgodność całej
  projektowanej integracji ani zachowanie runtime w tej aplikacji.
- **Decyzja projektowa proponowana tutaj:** kanonicznym dokumentem grafu jest
  GraphDoc, wykonywany po walidacji serwerowej przez workflow Mastry; UI nie
  wykonuje logiki samodzielnie.
- **Pytania otwarte / DO WERYFIKACJI:** konkretne mapowanie dowolnego DAG-u na
  builder Mastry, wspólny plik SQLite z Drizzle, awaria w środku kroku,
  konwersja JSON Schema MCP do Zod oraz dokładne zdarzenia wymagane przez
  używane wersje pakietów.

## 1. Model danych: GraphDoc

### 1.1 Proponowany kontrakt

GraphDoc jest wersjonowanym dokumentem JSON. Serwer zapisuje jego treść w
SQLite przez warstwę Drizzle. Szkic kontraktu (nazwy schematów Zod są
ilustracyjne):

```ts
const GraphDocV1Schema = z.object({
  version: z.literal(1),
  nodes: z.array(z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    position: z.object({ x: z.number(), y: z.number() }),
    params: z.record(z.string(), z.unknown()),
  })),
  edges: z.array(z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    sourceHandle: z.string().min(1),
    target: z.string().min(1),
    targetHandle: z.string().min(1),
  })),
});
```

Id krawędzi nie był wymagany w briefie, ale jest proponowany dla stabilnej
tożsamości krawędzi w UI, diagnostyce i zdarzeniach. Zakres pól `params` jest
sprawdzany ponownie przez schemat konkretnego typu węzła; `unknown` nie oznacza
akceptowania danych bez walidacji.

Tabela aplikacji przechowuje GraphDoc wraz z właścicielem, identyfikatorem
przestrzeni, czasem aktualizacji i wersją zapisu. Nazwa tabeli i dokładny
podział na kolumny wymagają uzgodnienia z istniejącymi migracjami Drizzle.
Duże dane, pliki i binarne artefakty nie są wkładane do GraphDoc.

### 1.2 Otwarcie starych kanw i migracje

Wymóg: graf lub kanwa zapisana przez starszą wersję musi dać się otworzyć.

1. Reader rozpoznaje format po `version` lub po jawnym typie rekordu. Brak
   wersji w starym rekordzie uruchamia ścieżkę kompatybilności, nie domyślne
   wykonanie.
2. Każda migracja dokumentu jest deterministyczną transformacją
   `version N -> version N+1`, walidowaną przed i po transformacji.
3. Przy nieznanej przyszłej wersji UI otwiera dokument tylko do odczytu lub
   pokazuje czytelny błąd; nie zapisuje go wstecz jako pustego grafu.
4. Dotychczasowe karty są wyświetlane jako karty artefaktów. Nie stają się
   automatycznie wykonywalnymi węzłami. Opcjonalna konwersja do GraphDoc wymaga
   jawnego działania i zachowuje źródłowy rekord.
5. Migracja utrwalonego dokumentu odbywa się transakcyjnie. Błąd migracji
   pozostawia oryginał dostępny do odczytu i diagnostyki.

Dokładny kształt aktualnych rekordów kanwy, ich migracja do rekordu grafu
i polityka wersji zapisu: **DO WERYFIKACJI** przed implementacją.

### 1.3 Walidacja po stronie serwera

Przed zapisaniem zmian agenta oraz przed każdym uruchomieniem serwer:

- waliduje GraphDoc przez schemat wersji i schemat parametrów każdego węzła;
- odrzuca nieznany typ węzła, nieznane porty i zduplikowane identyfikatory;
- sprawdza, czy źródło i cel każdej krawędzi istnieją;
- sprawdza zgodność typów portów i to, czy wymagane wejścia są zasilone;
- wykrywa cykle, chyba że w przyszłości wprowadzimy osobny, jawnie ograniczony
  węzeł iteracji;
- sprawdza właściciela, uprawnienia, dozwolone narzędzia i parametry operacji;
- odrzuca payload większy od ustalonego limitu oraz niepoprawne referencje.

Graf uruchamia narzędzia i może trwale zmieniać dane. Klient jest niezaufany;
walidacja UI jest tylko informacją dla użytkownika. Reguły autoryzacji,
akceptacji parametrów i zgód egzekwuje serwer przy każdej operacji.

## 2. Rejestr typów węzłów

### 2.1 Wspólny kontrakt

Proponuje się jeden katalog kontraktów dostępny frontendowi i backendowi.
Definicja typu zawiera stabilną nazwę, etykietę, opis, porty wejściowe i
wyjściowe, schematy parametrów Zod oraz referencję do funkcji wykonania.
Schematy walidują payload w runtime; nie polegamy na samych typach TypeScript.

Rejestr jest źródłem definicji, ale implementacja wykonania pozostaje
serwerowa. Frontend pobiera bezpieczne metadane i renderer/formularz; kod
handlerów ani sekrety nie trafiają do bundla. Podział eksportów klient/serwer
zostanie ustalony na etapie projektu pakietu.

Z jednego opisu rejestru generuje się lub składa:

- komponent React Flow z uchwytami portów, etykietami i formularzem parametrów;
- `isValidConnection` dla natychmiastowej informacji w edytorze;
- serwerową walidację grafu oraz przygotowanie kroku Mastry;
- opis narzędzia dla agenta, jeśli dany węzeł może być dodawany przez MCP.

`isValidConnection` jest kontrolą UX, nie granicą bezpieczeństwa. Serwer
powtarza te kontrole na GraphDoc, który otrzymał.

### 2.2 Typy portów

Każdy port ma stabilne `id`, etykietę, kierunek, schemat wartości Zod i
proponowany identyfikator `dataType`. `dataType` pozwala odrzucić oczywiście
niezgodne połączenia; schemat Zod waliduje rzeczywiste dane w runtime.
Automatyczne ustalanie zgodności na podstawie dowolnych schematów Zod nie jest
zakładane.

Reguła zgodności między różnymi, lecz strukturalnie kompatybilnymi schematami
jest **pytaniem otwartym**. Do czasu decyzji obowiązuje dokładna zgodność
`dataType`, a każdy krok waliduje wejście i wyjście własnym schematem.

### 2.3 Proponowane typy startowe — do zatwierdzenia

To lista do przeglądu domenowego, nie zamknięty zakres:

| Typ | Wejście → wyjście | Uwagi |
|---|---|---|
| `input` | formularzowe wartości → dane typowane | jawny początek grafu |
| `agent` | prompt i kontekst → tekst lub strukturalny wynik | pętla SDK pozostaje wewnątrz kroku |
| `mcp-tool` | argumenty narzędzia → wynik narzędzia | tylko zarejestrowane narzędzie i uprawnienia backendu |
| `transform` | dane typowane → dane typowane | deterministyczna transformacja z kodu modułu |
| `condition` | wartość warunku → wybrane wyjście | semantyka i dopuszczalne typy do ustalenia |
| `approval` | podsumowanie operacji → zatwierdzenie/odmowa | krok zawieszający przebieg, jeśli API i runtime to potwierdzą |
| `artifact` | wynik → referencja artefaktu | zapis artefaktu przez backend |

Obsługa pętli/foreach jako osobnego węzła, retry, anulowania i grupowania
podgrafów wymaga decyzji produktowej oraz próby kompilatora.

### 2.4 Węzły z narzędzi MCP

Propozycja: zarejestrowane narzędzie MCP może wystawić definicję węzła z
kontraktu nazwy, opisu, schematu wejściowego/wyjściowego i klasy skutku.
Generator nie tworzy narzędzi spoza listy serwerowej i nie omija istniejących
serwisów domenowych. Frontend dostaje bezpieczny opis do renderowania, a
wykonanie wywołuje tę samą autoryzowaną warstwę co inne narzędzia.

Automatyczna konwersja dowolnego JSON Schema MCP do równoważnego Zod, w tym
referencje, unie, formaty i rozszerzenia vendorowe: **DO WERYFIKACJI**. Nie
należy deklarować pełnej obsługi, dopóki generator nie przejdzie testów
zgodności na rzeczywistych schematach MCP w użytym SDK.

## 3. Kompilator GraphDoc → workflow Mastry

### 3.1 Kontrakt runnera

Proponowany interfejs oddziela format grafu od implementacji wykonawczej:

```ts
interface GraphRunner {
  run(graphDoc: GraphDoc, hooks: GraphRunHooks): Promise<GraphRunHandle>;
}
```

`GraphRunHooks` przenosi zdarzenia typowane do adaptera AG-UI i otrzymuje
sygnał anulowania. `GraphRunHandle` udostępnia stabilny `runId`, status,
możliwość anulowania oraz wynik albo referencję do zadania backendowego.
Dokładne kształty kontraktów i semantyka anulowania są do zatwierdzenia.

### 3.2 Etapy kompilacji

1. Serwer odczytuje GraphDoc i waliduje jego wersję, topologię, porty,
   parametry, autoryzację oraz wymagane wejścia.
2. Kompilator tworzy `createStep` dla każdego węzła na podstawie serwerowej
   definicji rejestru. Każdy krok waliduje wejście i wynik schematem runtime.
3. Kompilator przekłada zależności na udokumentowane konstrukcje Mastry:
   sekwencję `.then()`, rozgałęzienie `.branch()`, równoległe gałęzie
   `.parallel()` i iterowanie `.foreach()` tam, gdzie struktura grafu
   odpowiada semantyce tych konstrukcji.
4. Definicja otrzymuje identyfikator i schematy workflow, jest finalizowana
   przez `.commit()`, a następnie uruchamiana przez API workflow.
5. Adapter zbiera zdarzenia wykonania, wiąże je z identyfikatorami węzłów
   i publikuje zdarzenia aplikacyjne.

W używanej wersji API Mastry należy potwierdzić kompilatorem i testem
integracyjnym dokładne kształty buildera dla dynamicznej liczby kroków oraz
dzielenia danych między krawędziami. Typowanie TypeScript istnieje podczas
budowania programu, lecz nie waliduje danych JSON otrzymanych z klienta w
runtime. Dlatego walidacja Zod przed kompilacją oraz na każdym wejściu/wyjściu
kroku jest obowiązkowa.

### 3.3 Granice modelu grafu

Builder Mastry składa wykonanie z kroków, sekwencji, rozgałęzień,
równoległych ścieżek i iteracji. Sam fakt posiadania krawędzi w React Flow nie
dowodzi, że dowolny DAG można odwzorować bezstratnie. Propozycja ogranicza
pierwszą wersję do acyklicznego grafu, w którym zależności da się wyrazić
przez te konstrukcje i ich jawne wejścia/wyjścia. Dowolne złączenia gałęzi,
wielokrotne cykle oraz podgrafy wymagają osobnej decyzji.

**DO WERYFIKACJI:** deterministyczny kompilator dla tego podzbioru, sposób
przenoszenia wyników z kilku poprzedników, obsługa wspólnych węzłów po
rozgałęzieniu i tożsamość definicji przy edycji grafu podczas aktywnego runu.
Modyfikacja zapisanego GraphDoc nie zmienia definicji już uruchomionego runu;
run powinien zachować migawkę definicji lub jej checksumę.

## 4. Agent jako węzeł

Węzeł `agent` jest jednym krokiem workflow. Pętla Claude Agent SDK, wywołania
modelu i rozmowa narzędziowa pozostają wewnątrz tego kroku; nie są
automatycznie rozwijane do osobnych węzłów kanwy.

Proponowane wejścia:

- `prompt`: instrukcja dla tego kroku;
- `context`: ograniczone, jawne dane z poprzedników albo referencje do rekordów;
- opcjonalnie referencje do plików i konfiguracja wyjścia strukturalnego.

Proponowane wyjścia: tekst lub wynik zgodny z zadeklarowanym schematem oraz
referencje do artefaktów opublikowanych przez backend. Zawartości dużych
plików nie przenosi się przez GraphDoc ani snapshot workflow.

Agent otrzymuje tylko MCP tools jawnie dozwolone dla danego węzła/runu.
Połączenia do narzędzi przechodzą przez serwisy backendu i ich autoryzację.
Zgoda użytkownika nie zastępuje kontroli dostępu. Mapowanie konkretnej sesji
Claude Agent SDK i `@mastra/claude` na wejście/wyjście kroku wymaga próby na
zainstalowanych wersjach `@mastra/core` 1.66.0 i `@mastra/claude` 0.3.1;
szczegóły adaptera: **DO WERYFIKACJI**.

## 5. Zgody, zawieszenie i wznowienie

Obowiązujące tryby zgód v0.4 są zdefiniowane w D-06
([ACCEPTED-DECISIONS.md](ACCEPTED-DECISIONS.md)). Propozycja mapuje je na
bramki workflow:

| Tryb | Proponowane zachowanie grafu |
|---|---|
| Ręczny | Bramka zgody przed każdą akcją inicjowaną przez agenta lub węzeł; szczegółowa klasyfikacja akcji do ustalenia. |
| Nadzorowany | Odczyty, nawigacja i bezpieczne widoki bez pytania; krok przed trwałą zmianą danych, usunięciem lub działaniem poza aplikacją zawiesza workflow i czeka na decyzję. |
| Pełna automatyzacja | Brak pytania przy każdej akcji; autoryzacja backendu, zakazy narzędzi i rejestr wykonania nadal obowiązują. |

Przy oczekiwaniu UI pokazuje zadanie i rozmowę źródłową, nazwę węzła,
planowaną operację, jej cel i istotne parametry, przyciski zatwierdź/odrzuć
oraz informację o skutku. Odpowiedź jest przypisana do konkretnego `runId`,
`nodeId` i żądania decyzji, walidowana przez serwer i przekazywana do wznowienia
tego samego zawieszonego przebiegu. Powtórzony albo spóźniony formularz nie może
wykonać mutacji po raz drugi.

Dokumentacja Mastry opisuje `suspend`/`resume`, workflow snapshots oraz
`resumeStream`; lokalne typy 1.66.0 mają `resumeStream`. Sposób ponownego
podłączenia po przerwanym HTTP streamie i konkretna obsługa `suspend()` wewnątrz
tworzonego kroku wymagają integracyjnego potwierdzenia. Maksymalny czas
oczekiwania na człowieka pozostaje **pytaniem otwartym**.

## 6. Trwałość, storage i restart

Mastra dokumentuje snapshoty zawieszonych workflow zapisywane w skonfigurowanym
storage; dokumentacja wskazuje LibSQL jako domyślny adapter i `workflow_snapshots`
jako tabelę snapshotów w tym adapterze. Zaleca przenosić duże dane przez
referencje, nie wkładać ich wprost do stanu workflow.

### Proponowane granice własności

- Drizzle pozostaje właścicielem tabel aplikacji: GraphDoc, uprawnienia,
  mapowanie runu na rozmowę/właściciela, stan UI, artefakty i odwołania do plików.
- Storage Mastry jest właścicielem tabel wewnętrznych workflow/snapshotów.
- Użytkownik i aplikacja nie edytują bezpośrednio tabel Mastry.
- Każde wykonanie zachowuje GraphDoc lub wersjonowaną migawkę definicji oraz
  wejściowe referencje potrzebne do audytu i wznowienia.
- Stan workflow przechowuje ID plików/artefaktów i inne małe serializowalne
  wartości, nie zawartość plików.

Propozycja dla lokalnego wdrożenia to skonfigurować trwały storage Mastry
oparty na SQLite/LibSQL bez osobnego serwera. Obecny `InMemoryStore` pozostaje
poprawny dla istniejącego rejestru agenta, ale nie spełnia wymogu snapshotów
wykonywalnych workflow. Adapter LibSQL i jego wersja byłyby nową zależnością
względem obecnego lockfile; wersja zgodna z `@mastra/core` 1.66.0: **DO
WERYFIKACJI**.

Czy storage Mastry powinien współdzielić fizyczny plik SQLite z Drizzle, czy
otrzymać osobny plik lokalny, rozstrzyga się po sprawdzeniu adaptera i
migracji. Współdzielenie pliku może ograniczyć liczbę baz, ale dwaj właściciele
migracji wymagają potwierdzonego zachowania schematu, połączeń, WAL, kopii i
zamykania. Do czasu próby: **DO WERYFIKACJI**; nie zakładać, że oba storage
można bezpiecznie skonfigurować na tym samym pliku.

### Awaria i idempotencja

Wymagane jest rozróżnienie jawnie zawieszonego runu od runu przerwanego awarią.
Snapshot przy suspend/resume nie dowodzi sam w sobie automatycznego wznowienia
pracy przerwanej w środku aktywnego kroku. W aktualnie dostępnych materiałach
nie potwierdzono, czy wybrany silnik i adapter automatycznie odtworzą taki run.
Dlatego kontrakt brzmi: **automatyczne wznowienie po awarii w środku kroku —
DO WERYFIKACJI**. Do czasu testu aplikacja po restarcie oznacza run jako
przerwany/nieznany i nie uruchamia skutków ponownie bez jawnej polityki.

Każdy węzeł powodujący mutację zewnętrzną lub domenową musi być idempotentny
albo korzystać z klucza operacji powiązanego z runem i węzłem. Ponowienie
wykonania, wznowienie po suspend i odzyskanie stanu nie mogą duplikować zapisu,
publikacji pliku ani zewnętrznego skutku.

## 7. Zdarzenia na żywo: Mastra → AG-UI → React Flow

Mastra udostępnia strumień zdarzeń workflow, w tym zdarzenia startu i wyniku
kroku, postępu, zawieszenia, wznowienia i zakończenia. AG-UI pozostaje
protokołem frontendowym, a mapowanie Mastra → AG-UI jest adapterem aplikacji.
`STEP_STARTED`, `STEP_FINISHED` i `STATE_DELTA` w tym dokumencie są
proponowanymi semantycznymi zdarzeniami aplikacji; nie deklarują nazw
standardowych typów Mastry ani standardu AG-UI. Wybór typów AG-UI albo
wersjonowanego zdarzenia własnego trzeba potwierdzić dla użytych pakietów.

Każde zdarzenie grafu niesie co najmniej `runId`, `graphId`, `graphVersion`,
`nodeId`, numer sekwencji oraz czas. Adapter tłumaczy zdarzenie kroku Mastry na
zdarzenie aplikacyjne, np. `STEP_STARTED`, `STEP_FINISHED`, `STEP_FAILED`,
`STEP_SUSPENDED` i zmiany stanu. Błędy są bezpieczne dla UI i zachowują
identyfikator korelacji.

UI utrzymuje nietrwały stan prezentacyjny obok TanStack Query:

| Stan UI | Znaczenie |
|---|---|
| `pending` | węzeł jeszcze nie wystartował w tym runie |
| `running` | węzeł wykonuje się |
| `awaiting-approval` | węzeł lub bramka czeka na odpowiedź człowieka |
| `done` | węzeł zakończył się poprawnie |
| `error` | węzeł zakończył się błędem |

Stan podstawowy runu i kolejność zdarzeń odtwarza się z backendu; store UI jest
projekcją do renderowania i nie jest źródłem prawdy. Powtórzone zdarzenie jest
idempotentne. Utrata strumienia powoduje ponowny odczyt snapshotu/statusu,
jeśli backend udostępnia takie API.

Podgląd wartości na krawędzi pokazuje tylko zatwierdzony, bezpieczny fragment
wyjścia albo referencję/typ; nie ujawnia sekretów ani całych dużych plików.
Retencja, limity rozmiaru i filtrowanie danych podglądu są **pytaniem otwartym**.

Pozycja każdego węzła jest zapisywana w `position`. Automatyczne rozmieszczenie
nie uruchamia się po edycji ani imporcie; może być osobną, jawną akcją
użytkownika. Biblioteka auto-layout (np. elkjs lub dagre) wymaga osobnej
decyzji o zależności i nie jest teraz dodawana do stacku.

## 8. Edycja grafu przez agenta

Agent może zmieniać graf wyłącznie przez zarejestrowane narzędzia MCP, np.
`add_node`, `update_node`, `connect_nodes` i `remove_node`. Nazwy są
przykładowe, nie ustalają jeszcze publicznego kontraktu.

Każde narzędzie:

1. odczytuje aktualny GraphDoc i wersję zapisu na serwerze;
2. sprawdza właściciela, zgodę, uprawnienia i Zod schema;
3. stosuje zmianę na kopii i waliduje cały graf, w tym porty, cykle i wymagane
   wejścia;
4. zapisuje atomowo przy zgodności wersji; konflikt zwraca stan do ponownego
   odczytu, nie nadpisuje cichej zmiany użytkownika;
5. emituje przez AG-UI potwierdzenie z nową wersją GraphDoc.

Bezpośredni zapis tabel GraphDoc przez agenta jest zabroniony. Serwer może
odmówić mutacji wymagającej zgody i przedstawić ją użytkownikowi. Narzędzia
MCP muszą wywoływać tę samą logikę walidacji co operacje UI.

## 9. Karty artefaktów i krawędzie

Karta artefaktu pozostaje osobnym typem zawartości kanwy. Węzeł wynikowy może
opublikować artefakt przez backend i utworzyć/odświeżyć kartę wskazującą jego
ID i wersję. Karta nie przechowuje drugiej, niezależnie mutowanej kopii wyniku.
GraphDoc i karta mają jawne powiązanie oraz odrębnych właścicieli danych.

Propozycja semantyki krawędzi: krawędzie GraphDoc oznaczają **przepływ danych
wykonawczych** między portami. Pochodzenie artefaktu (który run/węzeł go
utworzył) zapisuje się jako metadane źródła artefaktu i odnośnik do węzła/runu,
nie jako drugą klasę krawędzi w GraphDoc. Uzasadnienie: unika to mylenia
zależności wykonania z relacją historii. Widoczny link pochodzenia może być
osobnym widokiem UI.

Wymaga zatwierdzenia, czy artefakt ma być zwykłą kartą dołączoną do tej samej
przestrzeni kanwy, czy kartą wynikową zagnieżdżoną/wskazywaną przez węzeł.

## 10. Plan testów

Plan nie jest dowodem implementacji. Nowe próby powinny być niezależne od
dostępu do prawdziwego modelu, o ile nie testują konkretnej integracji modelu.

- **Vitest — GraphDoc i migracje:** akceptacja wersji wspieranych, migracja
  starych rekordów, odrzucenie nieznanej wersji, round-trip JSON oraz brak
  utraty danych przy błędzie migracji.
- **Vitest — walidator:** cykl, brak źródła/celu, brak wejścia wymaganego,
  niezgodny typ portu, nieznany typ, parametry spoza schematu, nieprawidłowy
  właściciel i nieaktualna wersja.
- **Vitest — rejestr i kompilator:** wszystkie typy mają render/porty/schemat/
  wykonanie; grafy sekwencyjne, rozgałęzione, równoległe i foreach dla
  zatwierdzonego podzbioru; wynik Zod każdego kroku; odrzucenie grafów spoza
  podzbioru kompilatora.
- **Testy integracyjne workflow:** wykonanie Mastry z atrapą agenta i atrapami
  MCP; sukces, błąd, anulowanie, suspend/resume, duplikat żądania, restart oraz
  idempotencja skutku. Test restartu rozstrzyga zachowanie w środku aktywnego
  kroku i jawnego suspend osobno.
- **Playwright — edytor:** ręczna zmiana pozycji, połączenie portów i zapis;
  odrzucenie połączenia niezgodnych typów; widoczność statusów na żywo;
  zatwierdzenie/odmowa i wznowienie; reconnect/reload bez podwójnego wykonania;
  otwarcie starej kanwy i zachowanie kart artefaktów.

Testy używają osobnej bazy, katalogu danych i procesu, zgodnie z zasadami
izolacji v0.4. Test UI nie jest dowodem semantyki runu bez sprawdzenia
backendowego stanu i skutków operacji.

## 11. Zależności, licencje i ścieżka wyjścia

Workflow Mastry pozostaje w obrębie przyjętego stacku TypeScript. Pakiety
`@mastra/core` 1.66.0 i `@mastra/claude` 0.3.1 są wersjami zapisanymi obecnie
w manifestach repozytorium; wymagają aktualizacji i ponownej weryfikacji przed
implementacją. Dokumentacja dostępna podczas przygotowania tej propozycji
opisuje wybrane API workflow, ale nie potwierdza całego adaptera i scenariusza
wykonania z GLM/Z.AI.

Nie używamy funkcji Enterprise Edition z katalogów `ee/` (w szczególności
SSO/RBAC Mastry ani Agent Builder) jako wymagań tego lokalnego szablonu.
Autoryzacja i zgoda pozostają w aplikacji oraz serwisach backendu. Aktualna
oferta i materiały Mastry wskazują licencję EE dla produkcyjnego Agent Builder
i funkcji SSO/RBAC; dokładny zakres licencji sprawdzamy ponownie przy wyborze
konkretnych importów. Funkcje frameworku OSS, takie jak workflow, są odrębną
ścieżką.

Dagu i n8n są poza proponowanym stackiem: wymagają oddzielnego runtime,
nie zapewniają w tym projekcie wspólnego typowanego kontraktu node/port oraz
mają niepasujące założenia licencyjne/produktowe. To uzasadnienie jest
założeniem zadania; szczegółowa opinia prawna nie jest częścią tej
specyfikacji.

### Opcjonalna ścieżka wyjścia: Restate

Jeżeli później wymagane będą silniejsza trwałość i odzyskiwanie długich,
kosztownych kroków niż potwierdzi Mastra, `GraphRunner` może otrzymać drugi
adapter Restate bez zmiany GraphDoc i UI. To ścieżka przyszła, nie zależność
ani wymaganie MVP. Restate wymaga dodatkowego procesu/usługi i zmienia model
operacyjny lokalnego wdrożenia. Serwer Restate jest oferowany na licencji
BSL 1.1 z Additional Use Grant, a TypeScript SDK na MIT; warunki produkcyjnego
użycia trzeba sprawdzić dla konkretnej wersji i przypadku użycia.

Kod obsługi trwałej musi respektować deterministyczne odtwarzanie: efekty
zewnętrzne wykonywać w granicach trwałych operacji `ctx.run`, a duże dane
przenosić jako identyfikatory/referencje. Dokładne API SDK TypeScript i
ograniczenia deterministycznego replay są **DO WERYFIKACJI**, zanim Restate
zostanie zatwierdzone.

## Pytania otwarte

1. Czy zatwierdzamy GraphDoc jako odrębny format obok kanwy kart, czy przebudowujemy istniejący model kart?
2. Które proponowane typy węzłów są potrzebne na start i które mogą dodawać autorzy modułów?
3. Czy typy portów mają używać ścisłych identyfikatorów `dataType`, czy potrzebujemy reguł zgodności schematów?
4. Jaki podzbiór grafów jest wymagany w pierwszej wersji: sekwencje, branch, parallel, foreach, joins, podgrafy?
5. Czy dane w jednym węźle/edge-preview mogą zawierać dane domenowe wrażliwe; jakie są limity i retencja?
6. Jak długo run może czekać na człowieka przed wygaśnięciem?
7. Jak UI pokazuje wynik artefaktu: karta w kanwie, karta przy węźle, czy obie formy?
8. Jaką politykę przyjmujemy dla ponownego uruchamiania błędnego węzła i wpływu na dalsze węzły?
9. Czy automatyczny layout ma być dostarczony później jako opcjonalna zależność/akcja?

## DO WERYFIKACJI

1. Kompilacja GraphDoc o dynamicznych ID kroków i wszystkich planowanych kształtach połączeń do API `createStep`/`createWorkflow` w `@mastra/core` 1.66.0.
2. Użycie `.branch()`, `.parallel()`, `.foreach()` i `.commit()` dla planowanych grafów; typowane wejścia/wyjścia i warunki w runtime.
3. Konkretny mechanizm `suspend`/`resumeStream` dla approval-step, w tym ponowne podłączenie klienta po przerwanym strumieniu.
4. Czy workflow po restarcie automatycznie odzyskuje awarię wewnątrz aktywnego kroku, czy wznowienie dotyczy tylko zapisanego suspend.
5. Konfiguracja storage Mastry/LibSQL w użytej wersji oraz bezpieczne współistnienie z tabelami, migracjami, WAL i backupem Drizzle.
6. Dostępność workflow snapshots w wybranym lokalnym adapterze; nie zakładać, że domyślny storage jest odpowiedni dla lokalnego SQLite bez konfiguracji.
7. Zgodność rzeczywistej pętli `@mastra/claude` 0.3.1 i Claude Agent SDK z GLM/Z.AI wewnątrz kroku workflow.
8. Konwersja JSON Schema narzędzi MCP do Zod/typów portów, zwłaszcza `$ref`, unii, nullable, formatów i dodatkowych właściwości.
9. Dokładne mapowanie zdarzeń Mastry 1.66.0 na obsługiwane typy AG-UI w repo; nie zakładać, że `STEP_STARTED` i `STEP_FINISHED` są standardowymi eventami któregoś protokołu.
10. Licencje EE dla wybranych importów z `@mastra/core/*/ee` i Agent Builder w konkretnym planie wdrożenia.
11. Dla ewentualnego Restate: aktualny pakiet TypeScript SDK, wymagania serwera i runtime, przypadek użycia Additional Use Grant, `ctx.run` i zasady replay.
12. Repozytorium obecnie używa `InMemoryStore`, a `@mastra/libsql` nie jest zainstalowane; potwierdzić wersję i konfigurację trwałego adaptera workflow przed zmianą zależności.

## Źródła sprawdzone przy przygotowaniu propozycji

- [Mastra workflows](https://mastra.ai/docs/workflows/overview)
- [Mastra streaming](https://mastra.ai/docs/guides/streaming)
- [Mastra workflow snapshots](https://mastra.ai/en/reference/workflows/snapshots)
- [Mastra Agent Builder — wymagania i licencja](https://mastra.ai/templates/agent-builder)
- [Mastra pricing — framework OSS i EE](https://mastra.ai/pricing)
- [Restate server license](https://github.com/restatedev/restate/blob/main/LICENSE)
- [Restate TypeScript SDK license](https://github.com/restatedev/sdk-typescript/blob/main/LICENSE)
