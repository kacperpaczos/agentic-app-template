# Raport domknięcia platformy AgenticApp

> **Dokument historyczny z aplikacji AgenticApp** (stan z 2026-09-17, po wpisach #40–#41 i §4e; sha256 oryginału `15f764c43dbfa54d…`; poprzednia kopia w tym archiwum pochodziła z 2026-09-16).
> Opisuje próby wykonane w katalogu AgenticApp i ocenę wobec poprzedniej wersji specyfikacji (95 kryteriów).
> Nie potwierdza stanu tego repozytorium — aktualna ocena: [`docs/ACCEPTANCE.md`](../../ACCEPTANCE.md).
> Odnośniki do `docs/evidence/…` wskazują dowody, które pozostały lokalnie w AgenticApp i nie są publikowane; odnośniki do `docs/*.md` odpowiadają plikom w `docs/` tego repozytorium.

**Data:** 2026-09-15 · **Zakres:** wykonanie prac wskazanych przez audyt
[`RAPORT-STANU-PLATFORMY.md`](RAPORT-STANU-PLATFORMY.md), a następnie pięć
rezultatów zamawiającego (sekcja 4b) · **Dowody:**
[`docs/evidence/closure-2026-09-15/`](docs/evidence/closure-2026-09-15/)

Raport jest samowystarczalny: zawiera werdykt, pełną macierz odbioru, listę
napraw z przyczynami, wyniki testów, decyzje integracyjne, pozostałe ograniczenia
i instrukcję uruchomienia. Nie wymaga dostępu do rozmowy, w której powstał.
Poprzedni audyt pozostaje nienaruszonym zapisem stanu wejściowego — jego wyniki
nie zostały przerobione na sukcesy.

---

## 1. Werdykt

**Wszystkie 95 kryteriów odbioru są potwierdzone; 12 z 12 warstw zamkniętych.**
Stan wejściowy: 84 potwierdzone, 10 częściowych, 1 niespełnione, 6 z 12 warstw.

Co to znaczy, a czego nie znaczy:

- **Znaczy:** każde kryterium dokumentu ma dowód odpowiadający jego treści, a nie
  tylko zielony test obok. Sześć defektów z audytu (D-1…D-6) ma ustaloną
  przyczynę, naprawę i test regresji, który oblewa po jej cofnięciu.
- **Nie znaczy, że kod jest bezbłędny.** W trakcie prac znalazłem **pięć**
  kolejnych wad, których audyt nie wykrył — w tym niewidoczne odpowiedzi
  tekstowe, zakleszczenie przy wznawianiu strumienia i kolizję kluczy głównych
  (sekcja 4a). Każda z nich przeszła przez poprzedni odbiór.
- **Nie znaczy, że wszystko sprawdzono na żywym modelu.** Część dowodów to
  kontrolowane symulacje na granicy adaptera; są oznaczone osobno i wyjaśnione w
  sekcji 6.

### Poprawka do pierwszej wersji tego raportu

Pierwsza wersja podawała „37 testów, 37 przeszło" jako wynik bramki. Liczba była
prawdziwa dla przebiegu, z którego pochodziła, ale **przemilczała, że wcześniejszy
pełny przebieg tej samej suity zakończył się jednym oblaniem** — asercji
strumieniowania w teście na prawdziwym modelu, z komunikatem `odpowiedz pojawila
sie dopiero po zakonczeniu`. Ten sam kod, dwa różne wyniki: asercja była
niestabilna, a podanie tylko korzystnego przebiegu było wybraniem wygodnej liczby.

Przyczyna została ustalona i usunięta (rezultat 2 w sekcji 4b): asercja odpytywała
DOM i backend z Node'a co ~150 ms i rozstrzygała na podstawie tego, co zdążyła
złapać. Zastąpiła ją obserwacja wewnątrz strony, która widzi **każdą** zmianę i
czyta fazę uruchomienia w tym samym takcie. Dodatkowo detektor ma teraz dowód
zdolności do oblania — dwie kontrole negatywne w `e2e/streaming.spec.ts`.

Historyczny zapis pozostaje: sekcje 2–4a opisują pierwszą turę prac i nie zostały
przerobione. Sekcja 4b opisuje drugą.

### Bramka integracyjna

Wynik po drugiej turze prac:

| Kontrola | Wynik |
|---|---|
| `pnpm typecheck` | 0 błędów |
| `pnpm test` (vitest) | **278 testów, 23 pliki, wszystkie przeszły** |
| `pnpm check:boundaries` | granica platforma–domena zachowana |
| `pnpm build` | frontend + backend zbudowane |
| `pnpm test:e2e` (Playwright) | **72 testy, 72 przeszły** (5,6 min; w tym cztery tury na prawdziwym modelu) |
| `node scripts/closure-matrix.mjs --check` | 95 kryteriów, bez braków i duplikatów |
| `pnpm verify` | kod wyjścia 0 |

Stan wejściowy drugiej tury: 166 testów jednostkowych, 37 przeglądarkowych.
Stan wejściowy rozszerzenia (2026-09-16): 212 jednostkowych, 46 przeglądarkowych.
Stan wejściowy poprawek panelu rozmowy (2026-09-16): 257 jednostkowych, 59
przeglądarkowych — doszły 4 testy geometrii czatu (sekcja 4d), liczba testów
jednostkowych bez zmian.

---

## 2. Zamknięte warstwy i co je zamknęło

| Warstwa | Stan wejściowy | Co zamknęło |
|---|---|---|
| L1 — Fundament | zamknięta | — (zakres dowodu L1.5 rozszerzony: brak sekretów w pakiecie frontendu, backendu, bazie i logach) |
| L2 — Komponenty i nawigacja | otwarta (L2.2, L2.6) | naprawa szuflady (D-1) + widoczny stan braku dostępu w przeglądarce |
| L3 — Canvas | zamknięta | — |
| L4 — Czat i rozmowy | otwarta (L4.4) | trwała aktywność narzędzi w historii (D-2) |
| L5 — Komunikacja i zdarzenia | otwarta (L5.2, L5.3, L5.4) | stany cyklu wykonania ze zdarzeń, renderowanie aktywności narzędzi, unieważnianie do właściwych rendererów |
| L6 — Kontekst aplikacji | zamknięta | — |
| L7 — Zadania i współbieżność | zamknięta | — (wzmocnione: `queuedMs` zamiast rekonstrukcji okien) |
| L8 — Harness i uwierzytelnienie | otwarta (L8.6 **niespełnione**) | rozdzielenie trzech wymiarów uwierzytelnienia (D-3) |
| L9 — Domena | zamknięta | — (zakres dowodu L9.8 rozszerzony: atomowość przerwanej operacji, nie tylko odtworzenie kopii) |
| L10 — Trwałość, cache, artefakty | otwarta (L10.7, L10.10) | izolacja cache po zmianie kontekstu + artefakty live (D-4) |
| L11 — Sandbox i pliki | zamknięta | — |
| L12 — Obserwowalność i odbiór | otwarta (L12.3, L12.5) | rozdzielone punkty pomiaru (D-5) + rzetelne testy przeglądarkowe (D-6) |

---

## 3. Decyzje integracyjne

### Gotowy czat — co jest biblioteki, a co nasze

Zachowane bez zmian: lista rozmów, kompozytor, silnik historii, oś czasu
narzędzi, panel artefaktów, obsługa strumienia (`processStreamedMessage`),
magazyn wątków (`restStorage`).

Własny kod w obrębie czatu, w całości:

| Element | Zakres | Dlaczego |
|---|---|---|
| `AssistantMessage.tsx` | wybór między `Renderer` a `MarkDownRenderer` **biblioteki**, regułą biblioteki | bez tego proza nie renderuje się wcale przy przekazanym `componentLibrary` (N-2) |
| `platformAdapter.ts` | przepuszczenie strumienia przez `agUIAdapter()` i odczyt zdarzeń `CUSTOM` | reduktor biblioteki celowo ignoruje `CUSTOM`; nic nie jest parsowane po raz drugi |
| pasek stanu wykonania | fazy ze zdarzeń + podgląd odpowiedzi w trakcie tury | biblioteka commituje odpowiedź dopiero po zamknięciu tury (opis w kodzie) |
| jedna reguła CSS | widoczność przycisku zwijania szuflady przy otwartej szufladzie | tło zamykające nie jest dostępne z klawiatury |

Nie zastąpiliśmy `Messages`, `Composer`, `ThreadList` ani `ChatStore`.

### AG-UI — czym jest zgodność

W kodzie **nie ma importu `@ag-ui/*`** i to się nie zmieniło. Zgodność jest
rzeczowa, nie deklaracyjna:

- **transport** — `data: <json>` przez SSE, parsowany przez `agUIAdapter()`
  biblioteki, nie przez własny parser;
- **schematy** — nazwy pól zdarzeń (`toolCallId`, `toolCallName`,
  `parentMessageId`, `delta`, `messageId`, `role`) odpowiadają kształtowi, jakiego
  oczekuje `processStreamedMessage` zainstalowanej wersji;
- **semantyka** — sprawdzona wprost: `tests/projection.test.ts` uruchamia
  reduktor biblioteki na naszych bajtach i wymaga zgodności wyniku z projekcją
  backendu na sześciu scenariuszach, łącznie z fragmentacją argumentów i błędem
  narzędzia;
- **transport pod obciążeniem** — `tests/agui-stream.test.ts` tnie strumień na
  7-bajtowe pakiety i wymaga identycznego wyniku.

`@ag-ui/mastra` pozostaje **nieużyty**. To decyzja, nie przeoczenie: pakiet
pośredniczy między Mastrą a AG-UI, a w tej aplikacji zdarzenia narzędzi i tak nie
przechodzą przez strumień Mastry (patrz niżej), więc wprowadzałby warstwę, która
nie miałaby czego przenosić. Instalowanie go dla samej obecności na liście
zależności byłoby pozorną zgodnością.

### Mastra i Claude Agent SDK

Mastra uczestniczy w wykonaniu: agent jest rejestrowany w `new Mastra(...)`, a
wywołania idą przez `mastra.getAgent('appAgent')`. Dwie luki adaptera są
kompensowane i opisane w kodzie: `@mastra/claude` 0.3.1 przekazuje do strumienia
wyłącznie przyrosty tekstu (wywołania narzędzi odzyskujemy z hooków SDK) i nie
udostępnia `session_id` (czytamy go z tego samego miejsca).

**Seam testowy.** `AgentRuntime` przyjmuje opcjonalny stand-in modelu na granicy
adaptera (`ModelAgentLike`). Produkcja go nie ustawia. Istnieje po to, żeby
kolejności, których model nie wybiera na żądanie — narzędzie przed pierwszym
słowem, słowo przed narzędziem, odpowiedź bez tekstu — dało się sprawdzić
deterministycznie. Wyniki uzyskane tą drogą są w macierzy oznaczone jako
symulacja.

---

## 4. Wykonane naprawy

Każda pozycja podaje **objaw**, **przyczynę** i **czym to jest sprawdzone**.
Przyczyny są ustalone w kodzie, nie domniemane — tam, gdzie audyt zostawił
hipotezę, jest ona tu rozstrzygnięta albo jawnie obalona.

### D-1 — szuflada rozmów zasłaniała wątek, bez kontrolki zamknięcia

**Objaw (audyt):** przy otwartej szufladzie rozmowa jest niewidoczna; nie
znaleziono kontrolki zamykającej wśród sześciu sprawdzonych etykiet.

**Przyczyna — własna, dwuczęściowa.** `AgentInterface` nie przyjmuje układu z
zewnątrz: jego `Container` mierzy własną szerokość `ResizeObserver`-em i sam
publikuje kontekst układu (`isMobile = width > 0 && width < 768`). Przekazywany
przez nas `<LayoutContextProvider layout="copilot">` był przesłonięty i nie robił
nic — a komentarz w kodzie twierdził, że to on naprawia układ. Przy 560 px panelu
biblioteka wybiera swój układ szufladowy, w którym zamknięta lista stoi poza
kanwą (`left: -294px`). Nasza reguła `left: 0 !important` znosiła tę pozycję,
przypinając **zamkniętą** szufladę nad rozmową — w układzie, w którym biblioteka
celowo ukrywa przycisk zwijania, bo zakłada zamykanie gestem na tle.

**Naprawa:** usunięcie reguły i martwego `LayoutContextProvider`; przywrócenie
widoczności własnego przycisku biblioteki (`aria-label="Collapse sidebar"`)
wyłącznie dla **otwartej** szuflady, jedną regułą CSS. Tło (`div` z `onClick`) nie
jest dostępne z klawiatury — dlatego kontrolka, a nie gest.

**Sprawdzenie:** `e2e/chat-drawer.spec.ts`, 6 testów na dwóch szerokościach
(1680 px i 1120 px): zamknięta szuflada ma zerowe pokrycie panelu, otwarcie i
zamknięcie działa z klawiatury (Enter), kontrolka przyjmuje fokus, kompozytor
pozostaje dostępny. **Kontrola siły testu:** po celowym przywróceniu reguły
`left: 0 !important` oblewa 6 z 6.

### D-2 — aktywność narzędzi nie przeżywała przeładowania

**Objaw (audyt):** historia rozmowy pokazuje wniosek bez śladu kroków; słowo
`toolCalls` nie występowało w repozytorium. Audyt zostawił pytanie otwarte: czy
to zasłonięcie przez D-1, czy brak renderowania.

**Przyczyna — rozstrzygnięta: ani jedno, ani drugie.** Gotowy czat renderuje
aktywność narzędzi **z listy wiadomości**: `pairToolActivity` łączy `toolCalls`
wiadomości asystenta z wiadomościami `role:"tool"` po `toolCallId`, a
`InterleavedTurn` rysuje z tego oś czasu. Backend nie zapisywał ani jednego, ani
drugiego — `/api/threads/get/:id` zwracał `{id, role, content}`. Renderer istniał
i działał; nie miał czego renderować.

**Naprawa:** `ConversationProjection` — reduktor sekwencji zdarzeń AG-UI do
wiadomości, wpięty w `RunEventStream`, tak że SSE, `run_events` i `messages`
pochodzą z **jednej** sekwencji. Endpoint historii zwraca kształt AG-UI.
`backfillToolActivity` odtwarza aktywność dla rozmów sprzed zmiany z zachowanych
`run_events`, idempotentnie i z zachowaniem pozycji tury.

**Sprawdzenie:** `tests/projection.test.ts` (12) uruchamia **prawdziwy reduktor
biblioteki** (`processStreamedMessage`) na tych samych bajtach SSE i wymaga
zgodności na sześciu scenariuszach; `e2e/tool-activity.spec.ts` potwierdza
widoczność w czacie oraz przetrwanie przeładowania, przełączenia rozmowy i
restartu backendu. **Kontrola siły testu:** jednoznakowa mutacja w projekcji
oblewa 7 z 12 testów.

### D-3 — wygasłe poświadczenie raportowane jako zdrowa subskrypcja

**Objaw (audyt):** `probeAuth` zwracał `mode: 'subscription'` wyłącznie na
podstawie obecności pliku.

**Przyczyna:** jeden `mode` zlepiał trzy niezależne fakty.

**Naprawa:** kontrakt rozdzielony na trzy wymiary — **sposób logowania**
(`method`), **stan lokalnych metadanych** (`absent | valid | stale | unreadable`)
i **ostatni potwierdzony dostęp** (`unverified | verified | rate_limited |
refresh_refused | revoked | failed`). Wygasły termin to `stale`, nie awaria:
odświeżenie należy do SDK i aplikacja nie blokuje uruchomienia z tego powodu.
Klasyfikacja błędów jest jedna (`classifyAccessFailure`) i zasila jednocześnie
komunikat w czacie, kod w rejestrze uruchomień i ekran Ustawień — nie mogą się
rozjechać. Limit użycia dostał własny kod (`rate_limited`, HTTP 429) i własną
podpowiedź „poczekaj”, zamiast „zaloguj się ponownie”.

**Sprawdzenie:** `tests/auth.test.ts` (19) na **syntetycznych** poświadczeniach w
katalogu tymczasowym; stany błędów wywołane kontrolowaną symulacją na granicy
adaptera. Rzeczywiste logowanie nietknięte, limit nie był celowo wyczerpywany.

### D-4 — tryb artefaktu `live` obiecany modelowi, nieobsługiwany przy odczycie

**Objaw (audyt):** `mode="live"` zapisywany i opisany w narzędziu, ale odczyt
zwracał zapisany deskryptor jak treść.

**Naprawa:** live artefakt przechowuje **zapisane pytanie**, nie dane:
`{operation, input}` wskazujące **zarejestrowaną, typowaną operację odczytu
modułu** (`ModuleReadOperation`). Platforma waliduje deskryptor przy zapisie i
uruchamia operację przy każdym otwarciu, z właścicielem z sesji — nigdy z
deskryptora. Model wybiera **którą zarejestrowaną operację** artefakt powtarza i
nic poza tym; nie ma możliwości opisania własnego zapytania, kodu ani SQL.
Platforma nie zyskuje przy tym żadnej wiedzy o domenie — operacje to zwykłe
metody odczytu modułu.

Odczyt zwraca jawny stan (`fresh | failed | unavailable | forbidden`). Błąd nigdy
nie jest przedstawiany jako świeże dane i nie odsłania poprzedniego wyniku.

**Sprawdzenie:** `tests/live-artifacts.test.ts` (9): snapshot zamrożony po
zmianie źródła, live przeliczony; zgodność podglądu i pełnego widoku; brak
dostępu; zachowanie po restarcie backendu.

### D-5 — gubiony czas pierwszego tekstu

**Objaw (audyt):** `first_token_ms` puste, gdy narzędzie poprzedzało tekst —
czyli w najczęstszej kolejności.

**Przyczyna:** hook `PreToolUse` wywoływał `openText()`, ustawiając `textOpened`
przed jakimkolwiek tokenem; gałąź zapisująca pomiar była strzeżona przez
`!textOpened` i nie wykonywała się nigdy. Wywołanie było w dodatku zbędne —
reduktor AG-UI dołącza wywołanie narzędzia do bieżącego segmentu niezależnie od
tego, czy poprzedził je `TEXT_MESSAGE_START`.

**Naprawa:** usunięcie wywołania i rozdzielenie pomiaru od stanu strumienia.
Przy okazji rozdzielone **punkty pomiaru**: `enqueuedAt` (przyjęcie),
`startedAt` (faktyczny start po zwolnieniu kolejki), `firstTokenMs` i
`durationMs` liczone od startu wykonania, `queuedMs` raportowany osobno. Backend
zyskał status `queued`, więc czekanie w kolejce jest stanem, a nie luką.

**Sprawdzenie:** `tests/run-lifecycle.test.ts` — trzy kolejności: narzędzie→tekst,
tekst→narzędzie i odpowiedź bez tekstu (gdzie brak wartości jest **poprawnym**
wynikiem, nie podstawionym).

### D-6 — pusta asercja streamingu

**Objaw (audyt):** `getByText(/wykres|koszt/i)` trafiał w etykietę podpowiedzi
„Wykres kosztow" i nie mógł oblać.

**Przyczyna, głębsza niż sama asercja.** Ta asercja maskowała dwie realne wady:
odpowiedzi w ogóle nie były renderowane, a wątek był kasowany w trakcie
przebiegu (obie opisane w sekcji 4a).

**Naprawa:** asercja obserwuje **przyrost** treści w czasie, w oknie, w którym
uruchomienie jeszcze trwa, i wymaga, żeby maksimum było większe od minimum.
Etykieta podpowiedzi ani echo wiadomości użytkownika nie mogą jej zaliczyć.

---

## 4a. Wady znalezione przy okazji — nie było ich w audycie

Wszystkie pięć przeszło przez poprzedni odbiór.

### N-1 — czat był przemontowywany w trakcie przebiegu

`<AgentInterface key={conversationId ?? 'new'}>` — identyfikator rozmowy nadaje
backend **w trakcie** pierwszego przebiegu nowej rozmowy. React demontował więc
komponent w środku strumienia i budował go od nowa: wątek, który użytkownik
właśnie oglądał, znikał razem ze stanem. Kontener wiadomości był pusty mimo
poprawnych zdarzeń i poprawnej historii w backendzie.

*Naprawa:* usunięcie `key`. Czat sam zarządza wyborem wątku i sam wczytuje
wiadomości — nie wolno go przemontowywać z zewnątrz.

### N-2 — zwykła odpowiedź tekstowa nie była renderowana

Przekazanie `componentLibrary` przełącza `AgentInterface` na ścieżkę GenUI, w
której treść wiadomości trafia wyłącznie do renderera OpenUI Lang. Dla zwykłej
prozy renderer nie produkuje nic — a projekt **musi** przekazywać katalog
komponentów. Każda odpowiedź w języku naturalnym była więc niewidoczna. Wada
przetrwała, bo jedyna asercja, która mogła ją wykryć, była pusta (D-6).

*Naprawa:* wąskie rozszerzenie — `components.AssistantMessage`, które wybiera
między dwoma rendererami **samej biblioteki** (`Renderer` dla znaczników OpenUI
Lang, `MarkDownRenderer` dla prozy) według reguły biblioteki. Zakres własnego
kodu i jego ograniczenie opisane są w nagłówku
`packages/platform-ui/src/chat/AssistantMessage.tsx`.

### N-3 — zakleszczenie przy odtwarzaniu strumienia zdarzeń

`RunEventStream.read()` po zamknięciu strumienia czekało na obudzenie, które nie
mogło już nadejść, jeżeli w buforze zostały nieprzeczytane zdarzenia. Czytelnik
podłączony późno — czyli **klient wznawiający po rozłączeniu** — wisiał w
nieskończoność.

*Naprawa:* po zamknięciu czytelnik dopina bufor zamiast czekać.
*Regresja:* `tests/run-lifecycle.test.ts`; cofnięcie naprawy oblewa 6 testów.

### N-4 — kolizja kluczy głównych na wiadomościach narzędzi

Identyfikator wiadomości z wynikiem narzędzia był wyprowadzany z samego
`tool_use_id`, a `messages.id` jest kluczem głównym całej tabeli. Dwa przebiegi
używające tego samego identyfikatora wywołania traciły drugi wynik — po cichu,
bo wyjątek projekcji był łapany i logowany na poziomie debug.

*Naprawa:* identyfikator wiązany z uruchomieniem (`tm_<runId>_<toolCallId>`), a
błąd projekcji loguje się jako wyraźne ostrzeżenie o niekompletnej historii.

### N-5 — przeładowanie strony resetowało tożsamość

`POST /api/auth/session` bez `userId` zawsze ustawiało tożsamość domyślną. Każde
pełne przeładowanie cofało świadome przełączenie kontekstu dostępu.

*Naprawa:* wywołanie bez wskazania tożsamości **zachowuje** bieżącą sesję.
*Regresja:* `tests/session.test.ts` (5).

---

## 4b. Pięć rezultatów drugiej tury

Zamawiający wskazał pięć rezultatów. Każdy z nich dotyczy miejsca, w którym
pierwsza tura zostawiła zachowanie wąższe od wymagania albo dowód wąższy od
zachowania. Poniżej: co było, co jest, i co to potwierdza.

### Rezultat 1 — przywracanie kontekstu rozmowy

**Było.** Po przeładowaniu strony czat otwierał **nową, pustą rozmowę**. Historia
była nietknięta na serwerze i dostępna z szuflady, ale rozmowa, którą użytkownik
czytał sekundę wcześniej, nie wracała, a kolejne polecenie zaczynało inną sesję
Claude. Pierwsza wersja raportu wpisała to do ograniczeń jako „zachowanie gotowego
komponentu i typowe dla czatów". To była wygodna interpretacja: kryterium **L2.3**
mówi wprost „Nawigacja, odświeżenie oraz Wstecz/Dalej przywracają właściwą
rozmowę lub przestrzeń pracy". Dwa testy przeglądarkowe **obchodziły** ten brak —
po każdym przeładowaniu otwierały rozmowę z szuflady „tak jak zrobiłby
użytkownik" — co zamieniło brakującą funkcję w udokumentowane zachowanie.

**Jest.** Rozmowa i przestrzeń pracy są w adresie: `?c=<rozmowa>&s=<przestrzeń>`.

- `packages/platform-ui/src/chat/ConversationSync.tsx` — adapter wewnątrz
  `AgentInterface`. Steruje **własnym stanem biblioteki** przez jej publiczne
  hooki (`useThreadList` → `selectedThreadId`, `selectThread`,
  `switchToNewThread`; `useThread` → `threadError`) i renderuje wyłącznie
  komunikat zastępczy. Lista rozmów, wczytywanie wiadomości, kompozytor i silnik
  historii pozostają gotowym komponentem — dołożona jest jedna rzecz, której
  biblioteka nie może wiedzieć: na którą rozmowę wskazuje adres tej aplikacji.
- `packages/platform-ui/src/chat/sessionRestore.ts` — reguła „która strona się
  poruszyła", wydzielona i czysta. Zasada jednokierunkowa psuje jedną z dwóch
  rzeczy: jeśli zawsze wygrywa adres, klik w rozmowę odskakuje do poprzedniej;
  jeśli zawsze wygrywa czat, Wstecz/Dalej przestaje działać. Decyzja jest
  podejmowana wobec wartości, na której obie strony ostatnio się zgadzały.
- `packages/platform-ui/src/shell/SpaceSync.tsx` — to samo dla przestrzeni pracy,
  podpięte do `setSpace` w store, który jest już jedynym lejem dla wszystkich
  zmian przestrzeni. Dzięki temu ekrany modułu biznesowego nie muszą wiedzieć, że
  istnieje adres URL.
- `apps/web/src/router.tsx` — `retainSearchParams(['c','s'])` na trasie
  głównej. Bez tego router odbudowywał obiekt parametrów dla trasy docelowej i
  **każde** przejście przez `Link` po cichu gubiło rozmowę.
- `packages/platform-server/src/http/app.ts` — powiązanie rozmowy z przestrzenią
  jest odświeżane przy starcie uruchomienia. Ustawiane tylko przy tworzeniu,
  czerstwiało, gdy użytkownik przeszedł do innej przestrzeni i pisał dalej w tej
  samej rozmowie.

Usunięta lub niedostępna rozmowa ma **dwa różne** stany zastępcze, bo wymagają
różnych słów i różnego wyjścia: `gone` (usunięta albo cudza → zacznij nową) i
`failed` (istnieje, historia się nie wczytała → spróbuj ponownie). Klasyfikuje je
odpowiedź serwera, nie domysł z lokalnej listy.

**Potwierdza to.** `e2e/session-restore.spec.ts` (6 testów): ta sama rozmowa,
historia i przestrzeń po przeładowaniu bez jednego kliknięcia; dalsze polecenie
w tej samej sesji Claude (`claudeSessionId` niezmieniony, 1 rozmowa, 2
uruchomienia); Wstecz/Dalej przełącza rozmowy i **żadna** nie pokazuje wiadomości
drugiej; przestrzeń wraca razem z rozmową; usunięta rozmowa daje widoczny
komunikat; rozmowa innego właściciela nie pokazuje ani wiadomości, ani tytułu.
`tests/session-restore.test.ts` (11 testów) pokrywa regułę wprost, w tym przypadek,
w którym zasada jednokierunkowa się myli.

### Rezultat 2 — udowodnione strumieniowanie

**Było.** Asercja odpytywała DOM i status uruchomienia z Node'a, dwa żądania na
próbkę, ~150 ms przerwy, i rozstrzygała z tego, co zdążyła złapać. Wynik zależał
od czasu, którego test nie kontroluje: ten sam kod dał raz „przeszło", raz
„odpowiedź pojawiła się dopiero po zakończeniu".

**Jest.** `e2e/support/streamProbe.ts` obserwuje **z wnętrza strony**.
`MutationObserver` zapisuje tekst odpowiedzi przy każdej zmianie, razem z
`performance.now()` i fazą uruchomienia odczytaną w tym samym takcie. Nic nie jest
próbkowane — każda zmiana jest widziana.

Zakres obserwacji to wyłącznie `[data-testid="streaming-answer"]` (podgląd w
trakcie tury) i `[data-testid="assistant-message"]` (treść wiadomości po
złożeniu). Kompozytor, podpowiedzi, wiadomość użytkownika i os narzędzi są poza
nimi — i **to jest udowodnione, nie zadeklarowane**.

Reguła orzekania (`judgeStream`) wymaga wszystkich czterech warunków: co najmniej
dwie próbki **przed** fazą końcową, co najmniej dwie **różne** długości, brak
cofania długości, oraz pierwsza widziana odpowiedź krótsza od największej
zaobserwowanej.

**Potwierdza to.** `e2e/streaming.spec.ts` uruchamia ten sam detektor na trzech
scenariuszach:

| Scenariusz | Orzeczenie | Powód |
|---|---|---|
| tekst w czterech fragmentach | **strumieniowanie** | 4 różne długości, 28 → 107 znaków, faza `running` |
| cała odpowiedź jednym kawałkiem na końcu | **brak** | jedna próbka o pełnej długości (107) |
| narzędzie bez żadnego tekstu | **brak** | zero treści odpowiedzi, choć podpowiedzi i wiadomość użytkownika są na ekranie |

Dwie ostatnie pozycje są tym, co nadaje pierwszej wartość. Kontrola siły testu
(`docs/evidence/closure-2026-09-15/25-sila-testow.txt`): po wyłączeniu trzech
reguł detektora scenariusz strumieniowy **nadal przechodzi**, a kontrola negatywna
oblewa — czyli to ona, i tylko ona, pilnuje, żeby asercja nie zdegenerowała się do
„odpowiedź dotarła".

Na prawdziwym modelu, jedna tura
(`docs/evidence/closure-2026-09-15/22-strumien-model.json`): **75 różnych
długości, od 91 do 632 znaków**, wszystkie przy fazie `running`. Wcześniejszy
przebieg tego samego testu dał 78 długości, 70 → 582 — rząd wielkości jest
powtarzalny, konkretne liczby zależą od odpowiedzi modelu.

Uwaga metodologiczna: tekst po złożeniu może być **krótszy** od podglądu (632 →
557 znaków w tym przebiegu), bo podgląd to tekst surowy, a wiadomość to
wyrenderowany markdown.
Reguła porównuje pierwszą długość z największą zaobserwowaną, żeby ten artefakt
renderowania nie dawał fałszywego „nie strumieniowało"; nie osłabia to wykrywania
— pojedyncza próbka o pełnej długości nadal oblewa (test jednostkowy pilnuje
obu przypadków).

### Rezultat 3 — gwarantowana izolacja testów

**Było.** Suita przeglądarkowa miała kiedyś `reuseExistingServer: true`, domyślny
port i `APP_DATA_DIR` wskazany na `data/` — podłączała się do działającej
instancji i pisała przez nią (sekcja 7a). Po pierwszej turze konfiguracja była
poprawna, ale **niesprawdzana**: `APP_BASE_URL` był honorowany bez pytania, więc
jedna zmienna środowiskowa wystarczała, by wysłać wszystkie żądania do instancji
użytkownika. Sprzątanie robiło `pkill` po wzorcu wiersza poleceń.

**Jest.** Trzy niezależne warstwy, bo każda wykrywa to, czego nie wykryją pozostałe:

1. **Przed uruchomieniem czegokolwiek** — `e2e/support/isolation.ts` sprawdza port,
   katalog danych i adres bazowy przy **wczytywaniu** `playwright.config.ts`. Zła
   konfiguracja daje czytelny błąd i **żadnego** serwera, katalogu ani żądania.
   `APP_BASE_URL` może wskazywać wyłącznie instancję, którą ten sam przebieg opisuje.
2. **W serwerze** — `assertTestInstanceIsIsolated` w `config.ts` odmawia startu
   instancji oznaczonej `APP_INSTANCE_LABEL=agenticapp-test` na porcie poza
   8792–8799 albo na katalogu, który nie nazywa się `.e2e*`. Odmowa jest **przed**
   `mkdirSync`, więc nie powstaje nawet katalog. Instancja bez etykiety nie jest
   ograniczana — produkcja pozostaje bez zmian.
3. **W czasie działania** — `/api/health` podaje etykietę, a `e2e/support/fixtures.ts`
   sprawdza ją raz na workera, zanim poleci pierwsze żądanie. Konfiguracja
   ogranicza to, o co przebieg **prosi**; to sprawdza, **kto odpowiedział**.

Dodatkowo naprawiona kolejność: Playwright startuje `webServer` **przed**
`globalSetup`, więc przygotowywanie katalogu danych w `globalSetup` usuwało i
tworzyło plik bazy **pod** serwerem, który go już otworzył — proces trzymał
odlinkowany inode, a testy czytały inny plik pod tą samą ścieżką. Przygotowanie
przeniosło się do `e2e/support/boot-server.ts`, który czyści katalog, migruje,
zasiewa, a **potem** uruchamia produkcyjny build.

Sprzątanie: `ScriptedInstance` zatrzymuje wyłącznie proces, który sam uruchomił;
`scripts/dev-server.sh stop` zabija tylko pid z własnego pidfile. `pkill` nie
występuje już w żadnym skrypcie.

**Potwierdza to.** `tests/isolation.test.ts` (18 testów) na konfiguracjach, które
rzeczywiście zaszkodziły, nie na wymyślonych. Rzeczywiste odmowy z komunikatami:
`docs/evidence/closure-2026-09-15/26-izolacja.txt`.

### Rezultat 4 — bezpieczna gotowość do migracji

**Było.** Kryterium **L10.2** wymaga „sprawdzonej kopii i odtworzenia trwałego
stanu lokalnego". Dowodem było „kopia katalogu otwiera się z kompletnym stanem" —
to dowód spójności kopii, nie dowód, że migracja zachowa dane.

**Jest.** Przy okazji ujawniło się coś istotnego: katalog danych miał **4,1 MB w
`app.db-wal` przy 397 kB w `app.db`**, i plik główny był o dzień starszy.
Skopiowanie samego `app.db` — odruch — dałoby kopię cofniętą o dzień pracy,
**wyglądającą na kompletną**.

- `scripts/backup-state.mjs` kopiuje trzy pliki bazy **razem, jako bajty**, zwija
  WAL **w kopii**, kopiuje `files/` i `workspaces/` z sumami SHA-256, zapisuje
  manifest (sumy, liczby wierszy i odcisk treści każdej tabeli, lista migracji), a
  potem **odczytuje kopię ponownie** i porównuje z manifestem plus
  `integrity_check`. Odmawia działania, gdy jakiś proces trzyma bazę.
  Pliku źródłowego **nie otwiera jako bazy w żadnym trybie** — bo nawet otwarcie
  readonly przebudowuje `app.db-shm`, co zaobserwowano wprost.
  `session.secret` nie jest kopiowany celowo: to sekret instalacji, nie dane.
- `scripts/migration-rehearsal.mjs` kopiuje kopię do katalogu tymczasowego,
  robi spis treści, uruchamia **prawdziwy** `composeApp` (tę samą ścieżkę co
  `pnpm start`), porównuje stan, a potem uruchamia go **po raz drugi** i wymaga,
  aby spis był identyczny. Tabele, które mają się zmienić, są wymienione z
  powodem; każda inna zmiana to błąd. Wiersze widoczne dla użytkownika są
  sprawdzane **po tożsamości**, nie po liczbie.
- `docs/odzyskiwanie-stanu.md` — procedura odzyskania, z poleceniem weryfikującym,
  które zostało uruchomione przed wpisaniem do dokumentu.

**Wynik próby na kopii danych tej maszyny**
(`docs/evidence/closure-2026-09-15/23-proba-migracji.json`):

| | przed | po |
|---|---|---|
| migracje | `platform-0001-init`, `procurement-0001-init` | + `platform-0002-run-measurement-points` |
| rozmowy | 31 | **31** |
| wiadomości | 42 | 76 |
| uruchomienia | 11 | **11** |
| zdarzenia uruchomień | 432 | **432** |
| karty canvasu | 18 | **18** |
| pliki | 9 | **9** |

Zachowane po tożsamości: 31 rozmów, 31 wiadomości użytkownika (treść i
przypisanie), 18 kart canvasu (kompozycje bez zmian), 9 plików. Wzrost liczby
wiadomości to odtworzenie aktywności narzędzi: 11 uruchomień, 45 nowych wiadomości
w miejsce 11 starych (42 + 45 − 11 = 76). **Drugie uruchomienie nie zmieniło ani
jednego wiersza.**

W chwili pisania tej sekcji migracja **nie była uruchomiona** na danych
użytkownika — sumy SHA-256 `app.db` i `app.db-wal` w `data/` były identyczne ze
stanem wejściowym (`24-kopia.txt`).

**Migracja została następnie wykonana za wyraźną zgodą użytkownika** (2026-09-15).
Wynik, z porównaniem do przewidywania próby:
[`27-migracja-wykonana.txt`](docs/evidence/closure-2026-09-15/27-migracja-wykonana.txt).

| pozycja | próba na kopii | rzeczywistość | zgodne |
|---|---|---|---|
| rozmowy | 31 → 31 | 31 → 31 | tak |
| wiadomości | 42 → 76 | 42 → 76 | tak |
| uruchomienia | 11 → 11 | 11 → 11 | tak |
| zdarzenia uruchomień | 432 → 432 | 432 → 432 | tak |
| karty canvasu | 18 → 18 | 18 → 18 | tak |
| pliki | 9 → 9 | 9 → 9 | tak |

Próba przewidziała wynik dokładnie, łącznie z liczbą 76. Odciski SHA-256 wierszy
widocznych dla użytkownika — rozmowy, wiadomości użytkownika, karty, pliki,
przestrzenie — są **identyczne** z kopią sprzed migracji. Zmieniło się tylko to,
co miało: wiadomości asystenta 11 → 23, wiadomości narzędzi 0 → 22 (odtworzona
aktywność z zachowanych `run_events`), `enqueued_at` wypełnione dla 11 z 11
uruchomień. Powtórne `pnpm migrate` nie zmieniło ani jednego wiersza w żadnej z
21 tabel. `integrity_check: ok`.

`tests/migration.test.ts` (4 testy) powtarza te same własności na bazie zbudowanej
w teście, więc dowód działa dalej bez istniejącej kopii i oblewa na przyszłej
migracji, która zgubi kolumnę albo przestanie być idempotentna.

### Rezultat 5 — rzetelny odbiór

- Poprawiona liczba w bramce i **jawna poprawka** do pierwszej wersji raportu
  (sekcja 1): przemilczane oblanie zostało nazwane.
- Zakres dowodu poprawiony w macierzy przy **L2.3**, **L4.4**, **L5.1**, **L10.2**
  i **L12.5**, z podaniem w kolumnie „uwagi", co poprzedni dowód pokazywał, a
  czego nie. Status żadnego kryterium nie został podniesiony bez dowodu.
- Rodzaje dowodu pozostają rozdzielone: rzeczywisty przebieg / test bez modelu /
  analiza kodu / symulacja. Wyniki historyczne są oznaczone „hist.".
- Testy regresji z pierwszej tury działają bez zmian (45 testów przeglądarkowych
  bez modelu, 212 jednostkowych).
- Kontrola siły testu dla wszystkich czterech nowych obszarów:
  `docs/evidence/closure-2026-09-15/25-sila-testow.txt`.

---

## 4c. Rozszerzenie: pliki, praca w tle i sterowanie interfejsem

**Data:** 2026-09-16. Trzy rezultaty zamawiającego, wykonane na tym samym stacku
i z zachowaniem gotowego czatu oraz granicy platforma–domena.

### Rezultat 1 — pliki i artefakty

**Było.** Dozwolone typy nie obejmowały XLSX. W runtime nie było żadnej
biblioteki do arkuszy, a sieć w sandboxie jest odcięta — więc kod
przetwarzający skoroszyt nie miał czym go otworzyć. Obraz dało się wgrać, ale
nic nie kierowało agenta do odczytania go zamiast nazwy. Zmodyfikowany plik
można było opublikować tylko jako nowy artefakt, bez związku z oryginałem.

**Jest.**

- **XLSX przyjmowany**, `.xlsm` i `.xls` świadomie nie — makra nie są
  uruchamiane, bo nie ma czym.
- **Biblioteka dostępna w sandboxie**: `exceljs` 4.4.0 podlinkowana do
  `node_modules` workspace'u uruchomienia przez **kuratorowaną listę**
  (`agent/toolkit.ts`). Lista jest boundary: bez niej workspace rozwiązywałby
  importy przez `node_modules` serwera i sterownik bazy oraz Claude SDK byłyby
  jeden `import` od kodu pisanego przez model. Test sprawdza jedno i drugie —
  że `exceljs` da się zaimportować z katalogu workspace'u, i że
  `better-sqlite3`, SDK oraz `hono` **nie**.
- **Wersjonowanie zamiast nadpisania**: `files_publish_version` zapisuje wynik
  jako nowy plik wskazujący na oryginał (migracja `platform-0003`). Oryginał
  nie jest dotykany przez żadną ścieżkę w serwisie plików.
- **Jawny zakres analizy** jako dane (`FILE_ANALYSIS` w kontraktach), wstawiany
  jednocześnie do promptu agenta i do interfejsu. Kluczowa pozycja: **formuły
  nie są przeliczane**. Skoroszyt trzyma formułę obok wartości, którą Excel
  zapisał ostatnio; podanie tej wartości jako „wyniku" byłoby nieaktualną liczbą
  z autorytetem arkusza. Test celowo zapisuje niespójną komórkę (`A1*B1` = 20,
  zapisana wartość 999) i sprawdza, że obie strony są widoczne osobno.

**Dowód odbioru przez GUI, prawdziwy model** (`e2e/files-agent.spec.ts`):

| | wynik |
|---|---|
| obraz o rozpoznawalnej treści | trzy pasy nazwane poprawnie i **w kolejności**, mimo nazwy pliku `dokument-tekstowy.png` |
| skoroszyt wieloarkuszowy | suma **5300** wyprowadzona z komórek (ilość × cena), nie z nazw arkuszy |
| zmiana wykonana w sandboxie | agent zapisał skrypt do workspace i uruchomił go **po zgodzie użytkownika** |
| pobrany wynik | otwiera się, ma arkusz `Podsumowanie` z `Razem`/5300, zachowuje `Pozycje`, `Metryka`, `Pusty` |
| oryginał | **identyczny bajt w bajt** z tym, co wgrano |
| dostępność po powrocie | plik wersji nadal na liście i pobieralny |

**Znalezione przy okazji:** ścieżka analizy pliku przechodzi przez bramkę zgody.
`autoAllowBashIfSandboxed` pozostaje `false`, więc agent musi poprosić o
uruchomienie `node process_oferty.js`. Zaobserwowane wprost: pierwszy przebieg
testu zaparkował na `awaiting_consent`. To właściwość bezpieczeństwa, nie usterka
— test klika „Zgoda" tak jak użytkownik i **sprawdza, że bramka została użyta**,
więc ciche auto-zatwierdzenie w przyszłości oblałoby ten test.

### Rezultat 2 — niezależne zadania w tle

**Było — i to była realna wada.** Backend był odporny: uruchomienie to łańcuch
obietnic, a porzucenie odpowiedzi nigdy go nie zatrzymywało. Zabijał je
**klient**: abort strumienia czatu był przekazywany na `/cancel`, a biblioteka
wywołuje ten abort z `selectThread` → `cancelMessage`. Czyli **przełączenie
rozmowy anulowało zadanie**, tak samo jak przeładowanie strony. Dokładnie to,
czego wymaganie zabrania.

**Jest.**

- **Abort nie znaczy „anuluj".** Sygnał nie rozróżnia zatrzymania od zmiany
  rozmowy i od zamknięcia karty, więc nie decyduje o niczym. Anulowanie jest
  jawnym działaniem na **nazwanym** wykonaniu (`stopRun`), dostępnym z paska
  stanu rozmowy i z listy zadań w tle.
- **Przycisk stop w gotowym kompozytorze nadal anuluje** — ale przez to, co jest
  jednoznaczne, a nie przez sygnał. Nasłuch w fazie przechwytywania na panelu
  rozpoznaje kliknięcie w kontrolkę wysyłania **w chwili, gdy ta rozmowa ma
  wykonanie w locie**; biblioteka zamienia wtedy jej rolę na „zatrzymaj", więc
  kliknięcie nie znaczy nic innego. Kompozytor pozostaje gotowym komponentem i
  zachowuje swoje zachowanie; dostaje tylko skutek, którego sam mieć nie może.
  To, że nie jest to abort, sprawdza test: przełączenie rozmowy nadal nie
  anuluje zadania.
- **Ponowne podłączenie**: `GET /api/runs/:id/stream?from=<seq>` odtwarza od
  kursora i kontynuuje na żywo. Dwa źródła, jedna sekwencja — żywy strumień dla
  uruchomienia trwającego w tym procesie, `run_events` dla zakończonego lub
  sprzed restartu; są identyczne, bo każde zdarzenie jest utrwalane **zanim**
  staje się czytelne.
- **Stan per rozmowa.** `runs` jest mapą po rozmowie, nie jednym rekordem. Jeden
  rekord globalny to powód, dla którego postęp jednej rozmowy pojawiał się pod
  wiadomościami innej.
- **Sygnalizacja bez przejmowania widoku**: wskaźnik w pasku stanu z listą
  trwających i zakończonych zadań, przejście do rozmowy jest kliknięciem.

**Dowód** (`e2e/background-tasks.spec.ts`, 5 testów): przełączenie rozmowy i
przeładowanie nie anulują; praca w B nie miesza się z A; powrót pokazuje wynik
**bez ponownego uruchomienia** (liczba uruchomień niezmieniona); Stop kończy
wskazane wykonanie; zadanie z innej rozmowy da się zatrzymać z listy.
Kontrola siły: po przywróceniu mapowania abort→cancel test oblewa.

### Wada znaleziona przy okazji: podwojony tekst odpowiedzi

Po dodaniu listy zadań w tle jeden przebieg miał **dwóch konsumentów** zdarzeń:
strumień z `POST /api/agui/run`, który parsuje gotowy czat, oraz ponowne
podłączenie otwierane przez synchronizację zadań. Oba stosowały te same
`TEXT_MESSAGE_CONTENT`, a reduktor dokłada delty — więc **tekst odpowiedzi się
podwajał**: 107 znaków mierzone jako 214.

Skutek był gorszy niż kosmetyczny. Scenariusz „cała odpowiedź jednym kawałkiem
na końcu" zaczął wychodzić **fałszywie jako strumieniowanie**, bo 107 → 214
wygląda jak przyrost. Czyli kontrola negatywna detektora przestała działać —
ta sama, którą poprzednia tura dodała po to, żeby asercja strumieniowania nie
zdegenerowała się do „odpowiedź dotarła". Wykryła to sama siebie.

Naprawa: jeden konsument na przebieg. Ścieżka wysyłania „zajmuje" uruchomienie,
ponowne podłączenie pomija zajęte, a zwolnienie następuje, gdy strumień się
kończy — czyli dokładnie wtedy, gdy podłączenie staje się właściwym sposobem
dalszej obserwacji. Test jednostkowy pilnuje obu połówek: że podłączenie w tle
jest pomijane, **i** że dwukrotne zastosowanie tego samego zdarzenia faktycznie
podwaja tekst (czyli dlaczego to ma znaczenie).

---

### Rezultat 3 — agent poruszający się po aplikacji

**Było.** Pokazane wprost przez użytkownika w działającej aplikacji: na „przełącz
na pliki" agent wywołał `procurement_list_cases` i `canvas_catalog`, a potem
powiedział, że **trzeba najpierw utworzyć sprawę zakupową, żeby zobaczyć zakładkę
„Pliki i raporty"**. To nieprawda — to ekran platformy, w nawigacji zawsze. Agent
nie miał narzędzia nawigacji ani listy widoków, więc improwizował, a improwizacja
była fałszywa.

**Jest.**

- **Kuratorowany katalog celów**: `PLATFORM_UI_TARGETS` plus wkład modułów przez
  `uiTargets` na module serwerowym. Platforma nie nazywa ekranów biznesowych —
  test sprawdza, że w jej wpisach nie ma słownika domenowego.
- **`ui_navigate` czeka na potwierdzenie klienta.** Narzędzie nie rozstrzyga
  się, dopóki przeglądarka nie odeśle wyniku na `POST /api/runs/:id/ui-ack`.
  Brak potwierdzenia daje `executed=false`, powód `no_client` — **nie** sukces.
  To jest różnica między „wysłałem zdarzenie" a „użytkownik to widzi".
- **Każda odmowa ma własny powód**: `unknown_target`, `not_present`,
  `forbidden`, `inactive_conversation`, `no_client`.
- **Pokazanie ustawienia niczego nie zmienia** — w ogóle nie ma czasownika
  „ustaw". Test sprawdza, że jedyne narzędzia `ui_*` to `ui_catalog` i
  `ui_navigate`.
- **Idempotencja**: polecenie ma `commandId`, a klient pamięta obsłużone. Strumień
  odtworzony po przeładowaniu nie wykonuje skoku drugi raz.
- **Zadanie w tle nie przejmuje widoku**: klient odmawia polecenia z rozmowy,
  której użytkownik nie ogląda, i mówi o tym wprost.

**Dowód** (`e2e/ui-navigation.spec.ts`, 5 testów): polecenie otwiera `/files`
z widocznym ekranem (nie opis drogi); ustawienie zostaje podświetlone
`data-ui-highlight`, a `/api/status` przed i po jest identyczny; Wstecz/Dalej
działa po nawigacji agenta; nieznany cel daje `executed=false unknown_target`
i widok **się nie zmienia**; zadanie w tle nie przenosi ekranu, a odmowa
`inactive_conversation` trafia do historii właściwej rozmowy.

---

## 4d. Panel rozmowy: załączniki w polu wiadomości, artefakty jako zakładka

**Data:** 2026-09-16. Zgłoszenie użytkownika było wzrokowe: pasek załączników
„popsuł układ", a artefakty miały być osobną zakładką.

### Co się właściwie stało

`AgentInterface` renderuje każde dziecko, którego nie rozpoznaje jako slot, jako
`slots.rest` — **ostatnie dziecko własnego kontenera, obok wątku**. Pasek
załączników dodany jako zwykłe dziecko stał się więc osobnym panelem. Pomiar w
działającej przeglądarce, nie domysł:

```
div.openui-agent-sidebar-container  [294x690]
div.openui-agent-thread-container   [166x690]   ← rozmowa
div.pf-attach                       [393x690]   ← pasek załączników
```

393 px z 559 px panelu zabrał pasek, rozmowie zostało 166 px i łamała po jednym
słowie w wierszu. Po naprawie wątek ma **559 z 560 px**, a kontener biblioteki
nie zawiera niczego naszego.

Winna była decyzja z poprzedniej tury, opisana wtedy jako świadoma: „pasek stoi
obok kompozytora, bo kompozytor nie ma slotu na załączniki". Slotu faktycznie nie
ma — ale wniosek był zły. Kompozytor ma własny `__action-bar`, w którym trzyma
przycisk wysyłania.

### Jak jest teraz

- **Spinacz w polu wiadomości.** `ComposerAttachments` nie renderuje niczego tam,
  gdzie React go montuje. Przenosi portalem dwa elementy do własnych pojemników
  kompozytora: przycisk do `__action-bar` (który jest `display:flex` z
  wysyłaniem na `margin-left:auto`, więc spinacz sam ląduje po lewej, a wysyłanie
  zostaje po prawej) i wiersz plakietek z plikami do `__input-wrapper` (kolumna
  flex z polem tekstowym, więc plakietki lądują nad pisanym tekstem). Pomiar:
  spinacz `x=1146`, wysyłanie `x=1627`, oba `y=943`, oba 28×28 — jeden rząd.
- **Menu zamiast trzech kontrolek w pasku.** „Wgraj z dysku" i „Wskaż wgrany"
  otwierają się z tego samego spinacza. Stała podpowiedź o typach i limicie
  zniknęła z treści ekranu — to samo zdanie na każdym ekranie dla czynności
  wykonywanej rzadko — i siedzi w `title`, `aria-description` i w menu.
- **Artefakty jako zakładka.** Przeglądarka artefaktów **już istniała**:
  biblioteka rezerwuje ścieżkę `artifacts/` i wystawia wpis w swoim pasku
  bocznym. Tyle że przy tej szerokości panelu pasek boczny jest szufladą
  off-canvas, więc jedyna droga do artefaktów prowadziła przez otwarcie szuflady.
  Nie brakowało funkcji, brakowało widoczności. Pasek zakładek steruje **własną
  nawigacją biblioteki** przez jej publiczną parę `path`/`onNavigate`,
  dwukierunkowo: otwarcie artefaktu z wiadomości albo z szuflady też przestawia
  podświetlenie.
- **Przy okazji: ta sama wada była utajona w powiadomieniu o niedostępnej
  rozmowie.** `ConversationSync` renderował je w ten sam sposób — pokazywało się
  tylko wtedy, gdy rozmowa się nie wczytała, czyli dokładnie wtedy, gdy wątek
  najmniej może sobie pozwolić na ściśnięcie. Oba komunikaty idą teraz do
  `chatSlots.ts`.
- **Menu było przycięte.** Pierwsza wersja menu, renderowana wewnątrz kontrolki,
  traciła przycisk „Wgraj z dysku": `__input-wrapper` ma `overflow: clip`.
  Element przycięty **nadal ma pełny box i nadal przechodzi `toBeVisible()`** —
  to widać dopiero na zrzucie albo przez test trafienia. Menu jest teraz
  portalowane poza wszystkie pudełka przycinające i pozycjonowane ze współrzędnych
  przycisku.
- **Pierścień fokusu.** Globalna reguła powłoki rysowała ostry prostokąt wokół
  samego pola tekstowego wewnątrz zaokrąglonego kompozytora. Pierścień przeniesiony
  na `__input-wrapper`, zgodnie z tym, co biblioteka zakłada swoim `outline: none`.

Gotowy czat pozostaje gotowym czatem: wątek, lista rozmów, silnik historii,
kompozytor i jego ścieżka wysyłania są nietknięte. Dołożone są dwa elementy w
miejscach, które komponent sam przeznacza na kontrolki i treść, oraz sterowanie
jego własną nawigacją jego własnym propem.

### Dowód odbioru

`e2e/chat-layout.spec.ts`, 4 testy, bez modelu — celowo o geometrii i własności,
nie o widoczności, bo poprzednie testy pytały „czy element jest widoczny" i
odpowiedź brzmiała „tak" przez cały czas trwania wady:

| Test | Co sprawdza |
|---|---|
| nic naszego nie jest dzieckiem kontenera czatu | wszystkie dzieci `.openui-agent-container` mają klasy `openui-` |
| wątek zajmuje panel | `thread.width / panel.width > 0.9` (wada: 0.30) |
| załącznik dołącza się w polu wiadomości | spinacz **wewnątrz** `__action-bar`; jeden rząd z wysyłaniem; menu otwiera się w górę, **nie jest w kompozytorze** i „Wgraj z dysku" jest trafialne przez `elementFromPoint` |
| artefakty są osobną zakładką | zakładka widoczna bez otwierania szuflady; przełącza na `.openui-agent-artifact-browser`; powrót przywraca kompozytor wraz ze spinaczem |

**Kontrola siły testów.** Wada wprowadzona z powrotem — jeden `<div>` z jednym
słowem jako dziecko `AgentInterface` — oblewa 3 z 4 testów; wątek spada do 87 %
panelu od samego tego słowa. Przywrócenie menu do wnętrza kompozytora oblewa
osobno obie asercje: strukturalną i trafienie (`elementFromPoint` zwraca wtedy
`null` w środku „Wgraj z dysku").

**Dowody wizualne i pomiary:** [`docs/evidence/chat-ux-2026-09-16/`](docs/evidence/chat-ux-2026-09-16/)
— cztery zrzuty panelu (spoczynek, z załącznikiem, menu, zakładka artefaktów)
i `pomiary.json` z geometrią każdego stanu. Sonda: `scripts/probe-chat-composer.mjs`,
uruchamiana na własnej instancji i własnym katalogu danych.

### Czego to nie naprawia

Przeglądarka artefaktów ma własny stan pusty i pole wyszukiwania **po
angielsku** („Ready to create your first artifact?", „Search by title"). Kontrakt
`labels` biblioteki obejmuje `defaultCategory`, `workspaceToggle` i `tabs` —
i te są ustawione po polsku — ale nie te napisy. Zostaje jako ograniczenie, bo
jedyną drogą byłoby podmienianie treści w cudzym markupie.

---

## 4e. Przeniesienie do danych i zawężanie w widoku

**Data:** 2026-09-17. Zgłoszenie użytkownika wskazywało dwa błędy; przy
dowodzeniu pierwszego wyszedł trzeci, który był przyczyną cytowanego zdania
„aplikacja jest obecnie pusta".

### Błąd 1 — pytanie o dane nie przenosiło do danych

Zapis z działającej aplikacji: na „co jest w dostawcach?" agent odczytał dane,
przepisał je do rozmowy i zostawił użytkownika na ekranie, na którym był.
Dopiero po „a dlaczego mnie tam nie przeniosłeś?" wywołał `ui_navigate`.

Pierwsza hipoteza — zbyt wąska reguła w prompcie („gdy użytkownik **prosi** o
pokazanie") — była tylko połową prawdy. Poprawiłem regułę, uruchomiłem test na
prawdziwym modelu i **test oblał**: 7 minut, koniec na `/files`. Dziennik
uruchomienia pokazał dlaczego:

```
TOOL_CALL_START ToolSearch
TOOL_CALL_ARGS  {"query":"select:mcp__app__procurement_search,mcp__app__get_context"}
TOOL_CALL_RESULT {"total_deferred_tools":54}
```

**`ui_navigate` nie było w kontekście modelu.** Claude Agent SDK odracza
narzędzia, gdy jest ich dużo — 54 z nich siedziały za `ToolSearch`. Model
wyszukał dwa, których się spodziewał, i odpowiedział z nich. Prompt kazał mu
nawigować i nazywał narzędzie, którego nie miał. Żadna ilość instrukcji tego nie
naprawia.

`ModuleToolDefinition` ma teraz `alwaysLoad`, przekazywane do `tool()` SDK jako
`{ alwaysLoad: true }`. Ustawione na czterech narzędziach — `get_context`,
`ui_catalog`, `ui_navigate`, `ui_filter` — czyli tych, o których model musi
*wiedzieć, że istnieją*, żeby zachować się poprawnie, a nie tych, których szuka,
gdy już wie, czego chce. Reszta zostaje odroczona; każde zawsze wczytane
narzędzie jest w każdym prompcie.

**Dowód:** `e2e/agent-ui.spec.ts`, test na prawdziwym modelu, asercja na pasku
adresu (nie na tekście odpowiedzi — agent, który wypisuje dostawców *i*
przenosi, jest w porządku; ten, który tylko wypisuje, jest wadą, a w prozie oba
wyglądają tak samo).

| | przed | po |
|---|---|---|
| narzędzia w turze | `ToolSearch, get_context, procurement_search` | `ToolSearch, **ui_navigate**, procurement_search` |
| ekran po odpowiedzi | `/files` (bez zmian) | `/data` |
| czas | timeout 7 min | **22,8 s** |

### Błąd 2 — zawężanie działo się w czacie zamiast w widoku

Na „pokaż mi tylko PL dostawców" agent przepisał pasujące wiersze do rozmowy.
Ekran nadal pokazywał wszystkie cztery, więc użytkownik miał przed sobą pełną
listę i ręcznie przepisaną kopię obok — kopię, której nie da się posortować,
która się nie odświeży i jest dokładnie tak poprawna, jak dokładne było
przepisywanie.

**Zawężanie należy do rzeczy zawężanej.** Nowe narzędzie `ui_filter` idzie tym
samym kanałem co `ui_navigate`: komenda → przeglądarka → potwierdzenie.

- **Widok deklaruje, co wolno zawęzić.** `UiTarget.filter` podaje `collection`
  (klucz tablicy w odpowiedzi widoku) i listę pól. Platforma nosi jedno i drugie
  nie czytając: to moduł jest jedynym miejscem, które wie, że dostawca ma kraj.
  Pole spoza listy jest **odrzucane po nazwie**, zanim cokolwiek pójdzie do
  przeglądarki — agent zdolny filtrować po wymyślonym polu pokazałby pusty ekran
  i nazwał to odpowiedzią.
- **Zastosowanie jest w jednym miejscu.** `useModuleData` — hook, przez który
  każdy widok modułu czyta swoje dane. Robienie tego per ekran znaczyłoby, że
  każdy ekran, obecny i przyszły, musi o tym pamiętać, a ten, który zapomni,
  pokaże pełną listę pod banerem twierdzącym, że jest zawężona.
- **Informacja jest obowiązkowa.** `label` jest wymagany w kontrakcie, a baner
  nad powierzchnią roboczą mówi, że **widok zawęził agent**, czym go zawęził i
  ile wierszy zostało — plus przycisk „Pokaż pełny widok". Widok pokazujący po
  cichu 3 z 4 wierszy jest gorszy niż pokazujący 4: użytkownik myśli, że patrzy
  na wszystko.
- **Liczby pochodzą z widoku, nie z serwera.** Runner czeka, aż jakiś widok
  zgłosi, co zastosował — tak samo jak podświetlenie czeka na swój element.
  Bez tego odpowiedź brzmiałaby „ustawiliśmy jakiś stan", a różnica, która ma
  znaczenie — *zawężone do zera* kontra *nic tego nie zastosowało* — byłaby nie
  do rozstrzygnięcia. Stąd osobny powód odmowy `not_applied`.

### Błąd 3 — pusty wynik wyszukiwania czytany jako pusta aplikacja

Znaleziony przy dowodzeniu błędu 1, i to on stoi za zdaniem z cytowanego
przebiegu. Model poprosił o wszystko przez `query: "*"`. `LIKE '%*%'` nie pasuje
do niczego, więc dostał `{"results":[]}` — i powiedział użytkownikowi, że baza
jest pusta, przy czterech dostawcach i otwartej sprawie w bazie.

Dwie naprawy, obie w module:

1. `*` i `%` znaczą „wszystko". Wyszukiwanie, które na „pokaż wszystko"
   odpowiada „nic", nie jest wąskie — jest błędne.
2. **Każda odpowiedź niesie `totals`** — ile rekordów każdego rodzaju w ogóle
   istnieje. „0 pasujących z 4 dostawców" to inne zdanie niż „nie ma
   dostawców", i tylko jedno z nich było kiedykolwiek prawdziwe. Opis narzędzia
   mówi to wprost.

### Dowód odbioru

| Zestaw | Testy | Co pokrywa |
|---|---|---|
| `tests/view-filter.test.ts` | 21 | znaczenie operatorów; katalog podaje pola; odmowa po nazwie **bez wysyłania czegokolwiek do przeglądarki**; wymagane `label`; `clear`; odmowa klienta nie jest nadpisywana; `*` zwraca wszystko; `totals` w każdej odpowiedzi; zapis i odczyt adresu w obie strony; parametr spoza deklaracji nie staje się filtrem; kolizja z kluczem sesji odrzucona przy starcie; warunki tylko odsiewają wiersze widoczne dla odbiorcy |
| `e2e/view-filter.spec.ts` | 5 | zawężenie widać w tabeli (3 z 4), baner mówi kto i ile, przycisk przywraca 4 wiersze, nieznane pole = odmowa przy nietkniętym widoku, agent sam przywraca, zawężenie nie przenosi się na inny ekran |
| `e2e/agent-ui.spec.ts` | +1 | **prawdziwy model**: pytanie o dane kończy się na ich widoku |

**Kontrola siły testów.** Dwie mutacje, każda łapana osobno:

| Cofnięcie | Wynik |
|---|---|
| zawężenie deklarowane, ale wiersze nieodsiewane | oblewa na `toHaveCount(3)` — dostaje 4 |
| wiersze odsiewane, ale baner usunięty | oblewa na braku `view-filter-banner` |

Pierwsza pilnuje, żeby baner nie kłamał; druga — żeby zawężenie nie było ciche.
Żadna z nich nie jest wykrywana przez tę drugą.

**Dowód wizualny:** [`docs/evidence/chat-ux-2026-09-16/05-zawezony-widok.png`](docs/evidence/chat-ux-2026-09-16/05-zawezony-widok.png).

### Poprawka: zawężenie należy do adresu

Pierwsza wersja trzymała zawężenie w stanie klienta. Uzasadniłem to tym, że
zawężenie jest czymś, co **zrobiono** ekranowi, a nie miejscem, do którego się
nawigowało. To pomyliło **pochodzenie zmiany** z **naturą stanu**: filtr
rozstrzyga, *jaki zestaw rekordów użytkownik ogląda*, a to jest dokładnie ta
rzecz, którą link, odświeżenie, Wstecz i zakładka mają zachować. Uwaga
użytkownika była słuszna i wersja opisana wyżej została poprawiona.

Podział, według którego jest to teraz ułożone:

| Gdzie | Co tam trafia | W tej aplikacji |
|---|---|---|
| **Adres URL** | co użytkownik ogląda: wyszukiwanie, status, zakres, sortowanie, strona | zawężenie widoku — jeden parametr na pole |
| **Stan lokalny** | chwilowe stany interfejsu: otwarte menu, modal, hover | to, **kto** zawęził widok (agent tej sesji czy nie) |
| **Konto / backend** | trwałe preferencje, zapisane własne widoki | **niezaimplementowane** — patrz niżej |

Zapis jest czytelny, bo te adresy trafiają do wklejanych linków:

```
/data?country=PL          równe
/data?country=!FI         różne od
/data?name=~av            zawiera
/data?country=PL,CZ       którekolwiek z
```

Trzy konsekwencje warte zapisania:

- **Filtry nie są przenoszone między ekranami.** `retainSearchParams` obejmuje
  dalej tylko `c` i `s`. Zawężenie należy do widoku, dla którego powstało;
  przeniesienie `country=PL` na następny ekran ukryłoby tam wiersze, o które
  nikt nie prosił. Wyjście z widoku zdejmuje filtr, a Wstecz go przywraca.
- **Tekst na pasku jest generowany z tego, co faktycznie zastosowane**, przez
  etykiety pól zadeklarowane przez widok — a nie cytowany ze zdania agenta.
  Zdanie agenta mogłoby opisywać co innego niż to, co jest na ekranie, a
  wklejony link w ogóle by go nie niósł. Pasek nie może się pomylić co do tego,
  co widać.
- **Pole filtra nie może nazywać się `c` ani `s`.** Te klucze należą do sesji i
  są przenoszone przez każdą nawigację. Kolizja jest odrzucana przy budowaniu
  katalogu, czyli **przy starcie**, a nie po cichu w produkcji.

### Link z filtrem a uprawnienia

Filtr w adresie jest z założenia do wysłania komuś, więc pytanie brzmi, czy link
niesie ze sobą dane. Nie niesie: **nic z adresu nie dociera do bazy**. Warunki
tylko *usuwają* wiersze z odpowiedzi, którą backend już ograniczył do
właściciela, więc ten sam link otwarty przez kogoś innego zawęża *jego* dane i
nie może pokazać wiersza, którego ta osoba i tak by nie zobaczyła.

Pokazane, nie założone — `e2e/access-context.spec.ts`: ten sam adres
`/data?country=PL` po przełączeniu tożsamości jest nadal zawężony i pokazuje
**zero** wierszy, a nazwa dostawcy z poprzedniej tożsamości nie występuje nigdzie
na stronie.

### Czego to nie obejmuje

- **Sortowanie i paginacja** nie istnieją w tych widokach, więc nie ma ich też w
  adresie. Gdy powstaną, należą tam razem z filtrami.
- **Trzecia warstwa — trwałe preferencje na koncie** („domyślnie 50 rekordów",
  zapisane własne widoki) — nie jest zaimplementowana. Nie było jej w wymaganiu
  i nie udaję, że jest.

---

## 5. Wyniki testów

### Jednostkowe i integracyjne (`pnpm test`)

| Plik | Testy | Czego dowodzi |
|---|---|---|
| `tests/projection.test.ts` | 12 | projekcja backendu zgodna z **prawdziwym** reduktorem biblioteki na 6 scenariuszach; identyfikatory wyprowadzone, więc powtórzenie nie dubluje tury |
| `tests/run-lifecycle.test.ts` | 13 | pomiar pierwszego tekstu w trzech kolejnościach; aktywność narzędzi w historii; przetrwanie restartu; jeden stan końcowy; brak zakleszczenia czytelnika |
| `tests/auth.test.ts` | 19 | trzy wymiary uwierzytelnienia; sześć klas błędu dostępu; polityka wyłącznie subskrypcyjna |
| `tests/agui-stream.test.ts` | 15 | fazy cyklu ze zdarzeń; fragmentacja strumienia; brak podwojenia przy odtworzeniu; unieważnianie do właściwych odbiorców |
| `tests/live-artifacts.test.ts` | 9 | snapshot vs live po zmianie źródła i po restarcie; odrzucenie nieznanej operacji; brak dostępu |
| `tests/access-context.test.ts` | 8 | klucze cache; przerwanie żądań w locie; odrzucenie odpowiedzi po epoce |
| `tests/durability.test.ts` | 10 | brak sekretów w pakietach, bazie i logach; atomowość przerwanej operacji wieloetapowej |
| `tests/session.test.ts` | 5 | przeładowanie nie resetuje tożsamości |
| `tests/observability.test.ts` | 4 | realny kontrakt punktu wpięcia telemetrii; ani `@mastra/observability`, ani Langfuse nie są zainstalowane |
| `tests/base-data.test.ts` | 5 | pusta baza dostaje rekordy, pliki i przestrzeń z kartami; drugi start nic nie dopisuje; **dane usunięte nie wracają**; `force` nie duplikuje; praca użytkownika nietknięta |
| `tests/background-runs.test.ts` | 10 | wykonanie przeżywa porzucenie strumienia; odtworzenie od kursora bez powtórzeń; równoległe zadania nie mieszają wyników; Stop kończy wskazane; cudze uruchomienie niedostępne |
| `tests/ui-navigation.test.ts` | 14 | katalog celów (platforma + moduł, bez słownika domenowego); `ui_navigate` zwraca to, co potwierdził klient, i każdą odmowę osobno; brak czasownika „ustaw" |
| `tests/file-analysis.test.ts` | 10 | `exceljs` osiągalny z workspace'u, a zależności serwera **nie**; arkusze i typy komórek; formuła oddzielona od zapisanej wartości; limity, typy i dostęp; nowa wersja nie rusza oryginału |
| `tests/isolation.test.ts` | 18 | granice konfiguracji testów na konfiguracjach, które rzeczywiście zaszkodziły; serwer odmawia startu oznaczonej instancji przed utworzeniem katalogu; produkcja nieograniczana |
| `tests/stream-verdict.test.ts` | 13 | reguła orzekania o strumieniowaniu, w tym przypadki, których przeglądarka nie wyprodukuje na żądanie (tekst tylko po zakończeniu, malejąca długość, repaint bez zmiany) |
| `tests/session-restore.test.ts` | 11 | „która strona się poruszyła" dla adresu i czatu; rozróżnienie usuniętej rozmowy od nieudanego wczytania |
| `tests/migration.test.ts` | 4 | migracja starej bazy zachowuje rozmowy, wiadomości, kompozycje i sesję Claude; powtórne uruchomienie nie dubluje; brak zdarzeń = brak wymyślonej aktywności |
| `tests/{domain-comparison,platform-boundary,contracts,mcp-schema,runtime}.test.ts` | 71 | zakres z poprzedniego odbioru, utrzymany (domena, granica modułów, kontrakty, schematy MCP, rejestr uruchomień) |

### Przeglądarkowe (`pnpm test:e2e`)

72 testy w 14 plikach, wszystkie przechodzą w jednym przebiegu (5,6 min). Każdy
plik importuje `test` z `e2e/support/fixtures.ts`, więc żaden nie może wysłać
żądania do instancji, której przebieg sam nie uruchomił.

| Suita | Testy | Co pokrywa | Koszt |
|---|---|---|---|
| `app.spec.ts` | 14 | powłoka, canvas, karty, nawigacja, pliki | bez modelu |
| `chat.spec.ts` | 7 | tytuły, lista rozmów, przełączanie, usuwanie przez menu wiersza | bez modelu |
| `chat-drawer.spec.ts` | 6 | szuflada na dwóch szerokościach, klawiatura, fokus | bez modelu |
| `chat-layout.spec.ts` | 4 | geometria panelu: brak obcych dzieci w kontenerze, szerokość wątku, spinacz w kompozytorze, zakładka artefaktów | bez modelu |
| `view-filter.spec.ts` | 7 | zawężenie widoku i jego adres, przeżycie odświeżenia, Wstecz, wklejony link, baner z liczbami, powrót do pełnego widoku, odmowa przy nieznanym polu, brak przecieku na inny ekran | scenariusz zamiast modelu |
| `session-restore.spec.ts` | 6 | ta sama rozmowa i przestrzeń po przeładowaniu, kontynuacja sesji, Wstecz/Dalej, stany zastępcze | scenariusz zamiast modelu |
| `tool-activity.spec.ts` | 5 | aktywność narzędzi, błąd narzędzia, błąd wykonania, restart backendu | scenariusz zamiast modelu |
| `streaming.spec.ts` | 3 | przyrost tekstu **oraz dwie kontrole negatywne** detektora | scenariusz zamiast modelu |
| `access-context.spec.ts` | 3 | zmiana tożsamości w jednej instancji, widoczny brak dostępu, **zawężony link nie pokazuje odbiorcy cudzych danych** | bez modelu |
| `measurements.spec.ts` | 2 | czas odświeżenia po mutacji, czas anulowania | mutacja przez UI + scenariusz |
| `background-tasks.spec.ts` | 5 | zadanie przeżywa zmianę rozmowy i przeładowanie; brak mieszania; powrót bez ponownego uruchomienia; Stop | scenariusz zamiast modelu |
| `ui-navigation.spec.ts` | 5 | otwarcie widoku i ustawienia, podświetlenie, Wstecz/Dalej, nieznany cel, brak przejęcia widoku | scenariusz zamiast modelu |
| `files-agent.spec.ts` | 3 | obraz i XLSX wgrane przez GUI na **prawdziwym modelu** | dwie tury subskrypcji |
| `agent-ui.spec.ts` | 2 | pełna ścieżka oraz „pytanie o dane przenosi na ich widok", obie na **prawdziwym modelu** | dwie tury subskrypcji |

### Kontrola siły testów

Test, który nie potrafi oblać, niczego nie dowodzi — to była treść D-6. Siedem
napraw sprawdzono przez cofnięcie. Surowe wyniki drugiej tury:
[`25-sila-testow.txt`](docs/evidence/closure-2026-09-15/25-sila-testow.txt).

| Naprawa | Cofnięcie | Wynik |
|---|---|---|
| D-1 (szuflada) | przywrócenie `left: 0 !important` | 6 z 6 testów oblewa |
| D-2 (projekcja) | zgubienie argumentów narzędzia (1 znak) | 7 z 12 testów oblewa |
| N-3 (zakleszczenie) | przywrócenie warunku oczekiwania | 6 testów oblewa (timeout) |
| Rezultat 1 (przywracanie rozmowy) | usunięcie `<ConversationSync />` | test oblewa natychmiast; bez mutacji 6 z 6 przechodzi |
| Rezultat 2 (detektor strumienia) | wyłączenie trzech reguł `judgeStream` | scenariusz strumieniowy **nadal przechodzi**, kontrola negatywna oblewa |
| Rezultat 3 (guard izolacji) | `assertTestInstanceIsIsolated` zwraca od razu | 3 z 18 testów oblewa; warstwa harnessu jest niezależna i nadal przechodzi |
| Rezultat 4 (idempotencja odtwarzania) | usunięcie pominięcia już zrzutowanych uruchomień | test dublowania oblewa, **test zachowania danych przechodzi** |
| Rozszerzenie: zadania w tle | przywrócenie mapowania abort→`/cancel` | `background-tasks.spec.ts` oblewa na pierwszym teście |
| Panel rozmowy (układ) | `<div>` z jednym słowem jako dziecko `AgentInterface` | 3 z 4 testów oblewa; wątek spada do 87 % panelu |
| Panel rozmowy (menu) | menu z powrotem wewnątrz kompozytora | obie asercje oblewają osobno: strukturalna i `elementFromPoint` |
| Zawężanie widoku | zawężenie deklarowane, wiersze nieodsiewane | oblewa na `toHaveCount(3)` — dostaje 4 |
| Zawężanie widoku (baner) | wiersze odsiewane, baner usunięty | oblewa na braku `view-filter-banner` |
| Zawężanie widoku (adres) | parametr z adresu traktowany jako filtr **bez** deklaracji widoku | oblewa: `c=cnv_…` staje się filtrem na nieistniejące pole, widok pokazuje 0 z 4 |
| Nawigacja do danych | `alwaysLoad` zdjęte z `ui_navigate` | test na prawdziwym modelu oblewa: 7 min, koniec na `/files`, `ui_navigate` nieużyte (przebieg sprzed naprawy) |

Dwa wiersze są tu ważniejsze od pozostałych. Przy rezultacie 2 oslabiony detektor
nadal zalicza przebieg strumieniowy — więc to **kontrola negatywna**, i tylko ona,
pilnuje, żeby asercja nie zdegenerowała się do „odpowiedź dotarła". Przy
rezultacie 4 dublowanie danych nie jest utratą danych i nie wykrywa go żaden test
zachowania — wykrywa je wyłącznie porównanie stanu po drugim uruchomieniu.

### Pomiary z warunkami

Surowe wyniki: [`docs/evidence/closure-2026-09-15/20-pomiary.json`](docs/evidence/closure-2026-09-15/20-pomiary.json).
Liczby pochodzą z ostatniego pełnego przebiegu suity. Trzy kolejne przebiegi dały
182/946 ms, 194/993 ms i 167/928 ms — to nie jest średnia z serii, tylko
pojedynczy pomiar na jednym workerze, i tak należy go czytać. Rząd wielkości jest
powtarzalny, konkretna liczba nie.

Od 2026-09-16 mierzony przycisk to kontrolka zatrzymania w gotowym kompozytorze,
która od tej wersji anuluje wykonanie w backendzie (a nie tylko lokalny widok) —
patrz sekcja 4c.

| Pomiar | Od | Do | Wynik | Warunki |
|---|---|---|---|---|
| Odświeżenie po mutacji | kliknięcie „Zapisz" w formularzu pozycji | zmiana widocznych sum w karcie zestawienia, **bez przeładowania** | **167 ms** | build produkcyjny, Chromium, jeden worker, własny katalog danych |
| Anulowanie | kliknięcie przycisku zatrzymania w kompozytorze | status uruchomienia w backendzie osiąga stan końcowy | **928 ms**, status `cancelled` | scenariusz zamiast modelu (deterministyczna długość odpowiedzi), port 8797 |
| Pierwszy tekst | start wykonania | pierwszy token tekstu | rejestrowany per uruchomienie (`firstTokenMs`) | mierzony od startu wykonania, nie od zakolejkowania |
| Czas w kolejce | przyjęcie żądania | start wykonania | rejestrowany per uruchomienie (`queuedMs`) | 0 gdy nic nie stało przed uruchomieniem |
| Wykonanie | start wykonania | status końcowy | rejestrowany per uruchomienie (`durationMs`) | — |

Anulowanie nie zostawia zapisów: dziennik zdarzeń urósł z 4 do 7 pozycji (koniec
tekstu, zdarzenie anulowania i jedno zdarzenie końcowe), po czym przestał rosnąć.

**Zastrzeżenie do pomiaru anulowania.** Mierzony jest czas reakcji aplikacji:
przeglądarka → endpoint anulowania → sygnał przerwania → stan końcowy. Prawdziwy
proces modelu reaguje na ten sam sygnał, ale jego własny czas zakończenia zależy
od SDK i nie jest częścią tej liczby. Zerowa liczba osieroconych procesów została
potwierdzona w audycie na rzeczywistym przebiegu.

---

## 6. Dowody i ich rodzaj

Macierz rozdziela **status** kryterium od **rodzaju dowodu**, bo to dwie różne
rzeczy. Rozkład po domknięciu:

| Rodzaj dowodu | Liczba | Co to znaczy |
|---|---|---|
| rzeczywisty przebieg | 49 | zaobserwowane w działającej aplikacji, z modelem lub w przeglądarce |
| test automatyczny bez modelu | 34 | deterministyczny test, powtarzalny w CI |
| analiza kodu | 11 | stwierdzone przez lekturę implementacji i zainstalowanej biblioteki |
| symulacja | 1 | kontrolowany stand-in na granicy adaptera, oznaczony |

### Co sprawdzono na żywym modelu

Jedna tura subskrypcji, w `e2e/agent-ui.spec.ts`: polecenie wpisane w czacie →
kontekst aplikacji → narzędzie MCP → mutacja domeny → karta na canvasie bez
przeładowania → odpowiedź strumieniowana → aktywność narzędzi widoczna →
przetrwanie przeładowania (bez sięgania do szuflady) i przełączenia rozmowy.
Suita sprawdza też `firstTokenMs > 0` w kolejności narzędzie→tekst, czyli
dokładnie tam, gdzie metryka wcześniej ginęła.

Strumieniowanie w tej turze jest zmierzone, nie zadeklarowane:
[`22-strumien-model.json`](docs/evidence/closure-2026-09-15/22-strumien-model.json)
zawiera pełną listę zaobserwowanych długości odpowiedzi w trakcie wykonania.

Dodatkowo z audytu (stan wejściowy, dowody zachowane): 18 przebiegów na modelu,
w tym cztery operacje canvasu, `get_context`, rozłączność okien wykonania,
zatrzymanie z potwierdzeniem 3 ms i zerem osieroconych procesów.

### Co jest symulacją i dlaczego

**Stand-in modelu na granicy adaptera** (`ModelAgentLike`). Używany tam, gdzie
przebieg musi mieć wybraną kolejność albo wybraną awarię:

- kolejności narzędzie↔tekst i odpowiedź bez tekstu — model nie wybiera ich na
  żądanie, a defekt D-5 ujawniał się tylko w jednej z nich;
- wyczerpany limit użycia, odwołane logowanie, odmowa odnowienia — wywołanie ich
  naprawdę oznaczałoby celowe zepsucie logowania albo wyczerpanie limitu, czego
  zadanie zabrania;
- błąd narzędzia i przerwane wykonanie w przeglądarce — deterministyczna długość
  odpowiedzi jest warunkiem sensownego pomiaru anulowania.

Stand-in dostaje te same `sdkOptions` co Claude Agent SDK, z hookami włącznie;
reszta runtime'u, kolejka, strumień, projekcja i rejestr uruchomień są prawdziwe.

### Czego nie sprawdzono

- wygaśnięcia **rzeczywistego** poświadczenia (D-3 udowodniony na syntetycznym;
  logowanie użytkownika nietknięte);
- rzeczywistego wyczerpania limitu subskrypcji;
- eksportu do Langfuse (patrz [`docs/observability.md`](docs/observability.md));
- zachowania przy usunięciu transkryptu SDK spod zapisanej sesji Claude;
- **zachowania formatowania XLSX przy zapisie** — sprawdzone jest, że arkusze,
  typy komórek i formuły przechodzą; wykresy i formatowanie warunkowe **nie** są
  przenoszone i jest to wypisane jako ograniczenie, nie sprawdzone jako
  działające;
- **odtworzenia stanu z kopii na tej maszynie.** Procedura z
  `docs/odzyskiwanie-stanu.md` jest opisana i jej polecenie weryfikujące zostało
  uruchomione, ale samo odtworzenie nadpisałoby `data/` — czyli byłoby zmianą
  danych użytkownika. Ścieżka odczytu kopii jest sprawdzona
  (`backup:verify`, `integrity_check`, census); krok `cp` do `data/` nie.

Migracja na danych użytkownika **była** początkowo w tej liście; została wykonana
za jego zgodą i przeniesiona do sekcji 4b jako wynik zmierzony, nie przewidywany.

---

## 7. Pozostałe ograniczenia

Nic z poniższych nie blokuje żadnego kryterium; wszystkie są świadome i opisane,
żeby nie zostały odkryte jako niespodzianka.

1. **Odpowiedź commitowana po zamknięciu tury.** `AgentInterface` rozstrzyga
   widoczną odpowiedź jako `!turnLive || hasLangSyntax(content)`, więc proza w
   trakcie tury nie trafia do bąbelka wiadomości. Nadrabia to podgląd w pasku
   stanu; gdyby biblioteka to zmieniła, podgląd można usunąć bez skutków dla
   reszty.
2. ~~**Ponowne wejście w rozmowę po przeładowaniu jest ręczne.**~~ **Usunięte w
   drugiej turze** (rezultat 1). To ograniczenie nie powinno było zostać wpisane
   jako ograniczenie: kryterium L2.3 wymaga przywrócenia właściwej rozmowy, a
   „zachowanie gotowego komponentu" nie było powodem, żeby tego nie zrobić —
   biblioteka udostępnia `selectThread` i `selectedThreadId` publicznie. Rozmowa
   i przestrzeń są teraz w adresie i wracają bez udziału użytkownika.
3. **Odzyskiwanie sesji Claude po restarcie** opiera się na `claude_session_id`
   zapisanym w rozmowie. Jeżeli SDK usunie swój własny transkrypt, wznowienie
   zacznie nową sesję modelu przy zachowanej historii aplikacji — tego przypadku
   nie wywoływaliśmy.
4. **Langfuse** nie jest podłączony. Punkt wpięcia istnieje i jest sprawdzony na
   zainstalowanej wersji, ale wymaga **osobnego pakietu** `@mastra/observability`:
   przekazanie w to miejsce zwykłego obiektu eksportera powoduje, że Mastra zgłasza
   `Expected an Observability instance` i **wyłącza** obserwowalność. Szczegóły i
   pozostałe ograniczenia w [`docs/observability.md`](docs/observability.md);
   zgodność schematu Langfuse z tą wersją Mastry pozostaje niesprawdzona.
5. **Dwie tożsamości lokalne** wystarczają do sprawdzenia izolacji cache, ale nie
   są systemem kont: nie ma rejestracji, ról ani zarządzania użytkownikami. Tak
   było w założeniu.
6. **`--experimental-transform-types`** jest potrzebne do uruchamiania kodu TS
   wprost (skrypty CLI, serwer scenariuszowy). Build produkcyjny przechodzi przez
   esbuild i nie wymaga żadnej flagi.
7. **Klasyfikacja błędów dostępu opiera się na treści komunikatów** SDK. Zmiana
   ich brzmienia w nowej wersji SDK może przesunąć błąd do kategorii `failed`;
   dlatego klasyfikacja jest w jednym miejscu i pokryta testami, które łatwo
   rozszerzyć.
8. **SDK ostrzega o bramce zgody.** Uruchamiając agenta, Claude Agent SDK wypisuje
   `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`: nazwy w `allowedTools` dopuszczają narzędzie
   **przed** wywołaniem `canUseTool`. Dla własnych narzędzi aplikacji jest to
   zamierzone — są to operacje domenowe przechodzące przez reguły backendu. Bramka
   zgody pozostaje na tym, co sięga powłoki. Ostrzeżenie jest nowe w tej wersji SDK
   i wymienia nasze narzędzia, więc odnotowuję je wprost, żeby nie zostało wzięte
   za wadę konfiguracji.
9. **Sandbox** pozostaje w konfiguracji ustalonej wcześniej: zapis tylko w
   workspace uruchomienia, sieć odcięta, katalog danych aplikacji niedostępny.
   Klasyfikator bezpieczeństwa SDK nadal automatycznie dopuszcza część poleceń
   powłoki (np. `echo`) przed dotarciem do bramki zgody — to ograniczenie SDK,
   opisane w `FEEDBACK.md`, nie zmieniło się.
10. **Identyfikator rozmowy jest w adresie URL.** To celowe — daje przywracanie
    po przeładowaniu, Wstecz/Dalej i działające linki — ale oznacza, że adres
    niesie identyfikator rozmowy i trafi do historii przeglądarki. Sam
    identyfikator nie daje dostępu: odczyt jest sprawdzany po właścicielu, a
    cudza rozmowa daje komunikat zastępczy bez ani jednej wiadomości (test
    przeglądarkowy).
11. **Kopia stanu jest ręczna i lokalna.** `backups/` leży na tym samym dysku co
    `data/`. Zabezpiecza przed nieudaną migracją i błędem aplikacji, nie przed
    awarią dysku; nic nie wykonuje kopii cyklicznie. Kopia gorąca nie jest
    możliwa — skrypt odmawia działania przy uruchomionej aplikacji.
12. **Przywracanie przestrzeni pracy zapisuje adres przez podmianę wpisu
    historii**, nie przez dodanie nowego. Wstecz cofa **rozmowę** wraz z jej
    przestrzenią; nie cofa samej zmiany przestrzeni w obrębie jednej rozmowy.
    Wybrane tak, żeby jedna czynność użytkownika nie wymagała dwóch naciśnięć
    Wstecz.
13. **Zakres zapisu XLSX jest węższy niż odczytu.** Parser czyta arkusze, typy
    komórek, scalenia i formuły; przy zapisie **nie przenosi** formatowania
    warunkowego, wykresów, obrazów ani tabel przestawnych. Formatowanie komórek
    zachowane tylko w zakresie, który parser czyta. Wypisane wprost w
    `FILE_ANALYSIS` i pokazywane użytkownikowi, bo cicha utrata wykresu w
    „poprawionym" pliku jest gorsza niż odmowa.
14. **Formuły nie są przeliczane.** Skoroszyt niesie formułę obok wartości
    zapisanej ostatnio przez Excel; agent ma obowiązek podawać obie osobno i ma
    to w prompcie. Jeśli plik był nieaktualny, zapisana wartość też jest
    nieaktualna — platforma tego nie naprawia i nie udaje, że naprawia.
15. **`.xlsm` i `.xls` nie są przyjmowane.** Makra nie uruchamiają się, bo nie
    ma czym; format legacy nie jest obsługiwany przez parser.
16. **Przetwarzanie pliku wymaga zgody użytkownika.** Uruchomienie kodu to
    `Bash`, a ten nie jest auto-zatwierdzany nawet w sandboxie. Agent zapisuje
    skrypt i czeka. To właściwość bezpieczeństwa, ale oznacza, że analiza pliku
    nie jest w pełni bezobsługowa.
17. **Zadanie w tle żyje tak długo jak backend.** Restart serwera oznacza
    uruchomienia przerwane — `reconcileOnBoot` oznacza je jako `failed` z
    powodem, nie udaje wznowienia. Wymaganie tego nie obejmowało i nie jest to
    zaimplementowane.
18. **Katalog celów interfejsu jest ręcznie utrzymywany.** Selektor, który
    przestanie pasować do markupu, ujawni się jako `not_present` w czasie
    działania, a nie przy budowaniu. Testy pokrywają cele platformy; cel modułu
    dodany bez testu może zgnić po cichu.
19. **Przeglądarka artefaktów mówi po angielsku w dwóch miejscach.** Stan pusty
    („Ready to create your first artifact?") i pole wyszukiwania („Search by
    title") pochodzą z gotowego komponentu, a jego kontrakt `labels` obejmuje
    tylko `defaultCategory`, `workspaceToggle` i `tabs` — te są ustawione po
    polsku. Podmiana pozostałych napisów wymagałaby ingerencji w cudzy markup,
    czego ta aplikacja nie robi.
20. **Kontrolki dokładane do gotowego kompozytora są dowiązane do jego klas
    CSS.** Spinacz i plakietki plików trafiają portalem do
    `__action-bar` i `__input-wrapper`. Zmiana tych nazw w bibliotece sprawi, że
    kontrolki przestaną się pokazywać — nie zepsują kompozytora, ale znikną.
    Pilnuje tego `e2e/chat-layout.spec.ts`, który sprawdza przynależność
    elementu, a nie samą jego obecność na stronie.

---

## 7a. Incydenty podczas prac — do wiadomości

Trzy rzeczy poszły nie tak z mojej strony. Dwie dotyczą środowiska, trzecia —
tego raportu. Wszystkie są tu opisane, bo raport, który je pomija, jest niepełny.

### Pierwszy przebieg testów przeglądarkowych pisał do `data/`

Zanim wprowadziłem izolację, `playwright.config.ts` wskazywał `APP_DATA_DIR` na
`data/` i miał `reuseExistingServer: true`. Uruchomiony wtedy jeden raz
`e2e/app.spec.ts` dopisał do bazy użytkownika:

| Co | Ile | Znacznik czasu |
|---|---|---|
| przestrzenie canvas „Test drag…", „Filtr…", „Zaznaczenie…" | 3 | 2026-09-15T10:45Z |
| plik `test-upload.csv` | 1 | 2026-09-15T10:45Z |
| przesunięcie jednej karty w istniejącej przestrzeni | 1 | 2026-09-15T10:45Z |

Nic nie zostało usunięte ani nadpisane: dane demonstracyjne (sprawa, oferty,
pliki źródłowe) są nienaruszone. Ślady tej samej natury z 2026-09-14 pochodzą z
wcześniejszego przebiegu tej suity — pisała do `data/` od początku, co jest
dokładnie tym, co naprawiłem.

Te trzy przestrzenie i plik testowy można usunąć z ekranów „Zapisane kompozycje"
i „Pliki i raporty"; celowo ich nie usuwam, bo to dane użytkownika.

### Zatrzymałem działającą instancję użytkownika

Sprzątając porty po testach, wykonałem `pkill` na wzorcu obejmującym również
instancję uruchomioną przez użytkownika 2026-09-14 na porcie 8791. Proces nie
działa.

**Dane przetrwały — i jest to teraz zmierzone, nie założone.** Kopia wykonana w
drugiej turze odczytuje wszystkie trzy pliki bazy razem i daje kompletny stan:
31 rozmów, 42 wiadomości, 11 uruchomień, 432 zdarzenia, 14 przestrzeni, 18 kart,
9 plików, `integrity_check ok`
([`24-kopia.txt`](docs/evidence/closure-2026-09-15/24-kopia.txt)).

Przy okazji wyszło, jak blisko była tu cicha utrata danych: `app.db` ma 397 kB i
datę 14 września, a `app.db-wal` — **4,1 MB i datę 15 września**. Nieczyste
zatrzymanie procesu zostawiło większość zatwierdzonej pracy w dzienniku WAL.
Gdyby ktoś „zrobił kopię" przez `cp data/app.db`, dostałby stan cofnięty o dzień
i wyglądający na kompletny. Dlatego kopia jest teraz skryptem, nie odruchem
(rezultat 4).

**Rozwiązane.** Użytkownik wyraził zgodę na migrację (2026-09-15), więc została
wykonana, a instancja uruchomiona ponownie na porcie 8791. Migracja zachowała
wszystkie 31 rozmów i wszystko, co widoczne, co do bajtu (sekcja 4b,
[`27-migracja-wykonana.txt`](docs/evidence/closure-2026-09-15/27-migracja-wykonana.txt)).
Kopia sprzed migracji pozostaje w `backups/data-2026-09-15`, więc krok jest
odwracalny.

### Pierwsza wersja tego raportu podała wygodną liczbę

Bramka integracyjna mówiła „37 testów, 37 przeszło". Liczba była prawdziwa dla
przebiegu, z którego pochodziła — i przemilczała, że wcześniejszy pełny przebieg
tej samej suity zakończył się jednym oblaniem, dokładnie na asercji
strumieniowania. To był niestabilny test i podanie tylko korzystnego wyniku było
wybraniem liczby, a nie raportowaniem stanu. Przyczyna jest usunięta, a nie
obejściem: sekcja 1 i rezultat 2 w sekcji 4b. Odnotowane też w `FEEDBACK.md`.

---

## 8. Uruchomienie

### Na istniejących danych — najpierw kopia

Pierwszy start nowego builda na istniejącym `data/` **zmieni dane**: zastosuje
migrację `platform-0002-run-measurement-points` i odtworzy aktywność narzędzi w
zapisanych rozmowach. Kolejność jest zatem taka:

```bash
# 1. aplikacja musi być zatrzymana (skrypt odmówi, jeśli nie jest)
node scripts/backup-state.mjs --data data --out backups/data-$(date +%F)

# 2. próba na kopii, nie na danych
node scripts/migration-rehearsal.mjs --backup backups/data-$(date +%F)

# 3. dopiero teraz
pnpm build && pnpm start          # http://localhost:8791
```

Kopia dla tej maszyny już istnieje: `backups/data-2026-09-15` (31 rozmów, 42
wiadomości, 18 kart, 9 plików; `integrity_check ok`, sprawdzona ponownym
odczytem). Próba na niej przeszła — sekcja 4b. Procedura odzyskania:
[`docs/odzyskiwanie-stanu.md`](docs/odzyskiwanie-stanu.md).

### Od zera

```bash
pnpm install
pnpm dev                # backend :8791 + frontend :5173
```

Migracja i **dane bazowe wykonują się przy starcie aplikacji**: sprawa z
ofertami, pliki źródłowe i gotowa przestrzeń na canvasie. Pusta aplikacja nie
jest neutralnym punktem wyjścia, tylko ślepą uliczką — canvas nie ma czego
pokazać, ekrany biznesowe są puste, a agent zapytany o cokolwiek może tylko
stwierdzić, że nie ma czego robić.

Wykonuje się **raz na moduł**, ze znacznikiem w `app_settings`. Dane usunięte
przez użytkownika **nie wracają** po restarcie — wskrzeszanie rekordu, który ktoś
świadomie skasował, byłoby gorsze od pustego startu. `pnpm seed --force` ponawia
zasiew (fixture modułu jest idempotentny, więc nie duplikuje),
`APP_SKIP_BASE_DATA=1` startuje bez nich.

### W kontenerze — obraz wyłącznie ze źródeł

```bash
docker compose build --no-cache      # bez cache warstw i bez magazynu pnpm
docker compose up -d                 # http://localhost:8791
```

`.dockerignore` odcina `node_modules`, `dist`, `data`, `backups` i katalogi
testowe, więc obraz powstaje ze źródeł i `pnpm-lock.yaml`, a nie ze stanu
katalogu roboczego. Stan aplikacji żyje w wolumenie `/data` i nigdy nie jest
częścią obrazu.

**Przebudowa 2026-09-16** (po poprawkach panelu rozmowy, sekcja 4d):
`agenticapp:czysty`, 2,83 GB, `9e1d83b90f58`. Dowody, że „bez cache" znaczy tu
to, co mówi:

- **0 warstw `CACHED`** w całym logu budowania;
- `Progress: resolved 625, reused 0, downloaded 625, added 625, done` — żaden
  pakiet nie pochodzi z lokalnego magazynu pnpm;
- pakiet frontendu w obrazie to `index-Ne7AskTt.js` — **ta sama suma
  zawartości** co w buildzie z poprawkami, więc obraz niesie aktualny kod, a nie
  poprzedni;
- obraz uruchomiony na porcie zapasowym z wyrzucanym wolumenem: wątek zajmuje
  559 z 560 px, spinacz jest w pasku akcji kompozytora, obie zakładki działają —
  te same pomiary co na instancji lokalnej (sonda `scripts/probe-chat-composer.mjs`).

Kontener sprawdzający i jego wolumen zostały usunięte po weryfikacji; obraz nie
został uruchomiony na porcie 8791, żeby nie wyprzeć działającej instancji
lokalnej.

**Ograniczenie, które trzeba znać:** Claude Agent SDK czyta poświadczenie
subskrypcji z `~/.claude` na hoście. W kontenerze tego katalogu nie ma, więc
aplikacja wstanie i będzie używalna (canvas, dane, pliki, rozmowy), ale agent
zgłosi brak logowania. Poświadczenie **nie jest wbudowywane w obraz** — to
sekret, a obraz jest artefaktem do przenoszenia. Montowanie `~/.claude:ro` jest
przygotowane i zakomentowane w `compose.yaml`, jako świadoma decyzja użytkownika.

Przy okazji budowania obrazu wyszło, że `@openuidev/lang-core` wysyła w kroku
`postinstall` pseudonimową telemetrię instalacji do PostHog. W obrazie, który ma
być powtarzalnym artefaktem, wołanie do sieci przy każdym budowaniu nie jest
pożądane, więc etap budujący ustawia standardowe `DO_NOT_TRACK=1`. Zmienna nie
trafia do obrazu końcowego i nie zmienia samej zależności.

Tryb produkcyjny (backend serwuje zbudowany frontend):

```bash
pnpm build
pnpm start              # http://localhost:8791
```

Wymagania: Node ≥ 22.12 (sprawdzone na 24.19.0), pnpm 9, konto Claude z
subskrypcją zalogowane lokalnie (`claude` → `/login`). Aplikacja nie przyjmuje
klucza API i nie ma ścieżki płatnego dostępu.

### Weryfikacja

```bash
pnpm verify             # granica modułów, macierz, typecheck, testy, build
pnpm test:e2e           # testy przeglądarkowe (własne porty 8795-8799, własne katalogi .e2e*)
pnpm backup:verify backups/data-2026-09-15   # ponowne sprawdzenie kopii
node scripts/closure-matrix.mjs           # pełna macierz odbioru
node scripts/closure-matrix.mjs --summary # same podsumowanie
./scripts/closure-evidence.sh             # zbiera dowody do docs/evidence/closure-2026-09-15/
```

Testy przeglądarkowe **nie mogą** dotknąć `data/` ani instancji, którą ktoś ma
otwartą, i nie zależy to od poprawnie wpisanej konfiguracji. Trzy niezależne
warstwy (szczegóły i rzeczywiste komunikaty odmowy: sekcja 4b oraz
[`26-izolacja.txt`](docs/evidence/closure-2026-09-15/26-izolacja.txt)):

- **przy wczytywaniu konfiguracji** — port, katalog danych i adres bazowy są
  sprawdzane w `playwright.config.ts`; zła wartość daje czytelny błąd i żadnego
  serwera, katalogu ani żądania. `APP_BASE_URL=http://127.0.0.1:8791` albo
  `APP_E2E_PORT=8791` kończy się odmową, nie przebiegiem;
- **w serwerze** — instancja oznaczona `APP_INSTANCE_LABEL=agenticapp-test`
  odmawia startu na porcie poza 8792–8799 i na katalogu bez prefiksu `.e2e`,
  **przed** utworzeniem katalogu; instancja nieoznaczona (produkcja) nie jest
  ograniczana;
- **w czasie działania** — `/api/health` podaje etykietę, a fixture sprawdza ją
  raz na workera, zanim poleci pierwsze żądanie.

Sprzątanie dotyczy tylko procesów uruchomionych przez testy: `ScriptedInstance`
zatrzymuje wyłącznie własne dziecko, `scripts/dev-server.sh stop` zabija tylko pid
z własnego pidfile, a `pkill` nie występuje już w żadnym skrypcie.

### Gdzie są dowody

| Katalog | Zawartość |
|---|---|
| `docs/evidence/closure-2026-09-15/` | wyniki kontroli, wersje, manifesty sum kontrolnych, pomiary, zrzuty ekranu |
| `docs/evidence/audit-2026-09-15/` | dowody stanu **wejściowego** (audyt), pozostawione bez zmian |
| `docs/evidence/playwright-report/` | raport HTML z ostatniego przebiegu testów przeglądarkowych |
| `backups/data-2026-09-15/` | sprawdzona kopia stanu lokalnego + `manifest.json` |

Dowody drugiej tury:

| Plik | Zawartość |
|---|---|
| `21-strumien.json` | orzeczenia detektora strumieniowania na trzech scenariuszach (1 pozytywny, 2 negatywne) |
| `22-strumien-model.json` | długości odpowiedzi w trakcie wykonania — prawdziwy model, jedna tura |
| `23-proba-migracji.json` | próba migracji na kopii: stan przed/po, zachowane wiersze, wynik drugiego uruchomienia |
| `24-kopia.txt` | sumy SHA-256 `data/` przed i po; co dokładnie zostało dotknięte i przez co |
| `25-sila-testow.txt` | kontrola siły testów: cofnięcie każdej naprawy i wynik |
| `26-izolacja.txt` | rzeczywiste komunikaty odmowy przy niezgodnej konfiguracji testów |

Stan wejściowy kodu jest utrwalony w
`docs/evidence/closure-2026-09-15/00-baseline-manifest.txt` (sumy SHA-256 wszystkich
źródeł przed pracami) i `07-manifest-po.txt` (po pracach). Repozytorium nie jest
repozytorium Git, więc manifest sum pełni rolę punktu odniesienia.

---

## 9. Pełna macierz odbioru

Poniżej pełna macierz 95 kryteriów. Treść każdego kryterium jest czytana wprost z
`stack-agentowy-ustalenia-i-materialy.md` przez `scripts/closure-matrix.mjs` — nie
jest przepisywana ręcznie, więc żadne kryterium nie może zostać po cichu pominięte
ani przeredagowane. Sumy, rozkład rodzajów dowodu, wykaz warstw i kontrola
duplikatów są wyliczane, nie wpisywane.

Statusy są rozłączne: **potwierdzone** / **częściowe** / **niespełnione** /
**niesprawdzone**. Rodzaj dowodu jest osobną kolumną, bo „potwierdzone analizą
kodu" i „potwierdzone rzeczywistym przebiegiem" to nie to samo.

### Podsumowanie macierzy

Liczby wyliczone ze skryptu `scripts/closure-matrix.mjs`; wymagania czytane wprost z `stack-agentowy-ustalenia-i-materialy.md`.

**Kryteriów: 95** (7+6+7+8+8+7+7+8+9+10+10+8). Dokument wymagań nie zmienił się, więc liczba jest ta sama co w audycie z 2026-09-15.

| Stan | Liczba |
|---|---|
| potwierdzone | 95 |
| częściowe | 0 |
| niespełnione | 0 |
| niesprawdzone | 0 |
| **Razem** | **95** |

| Rodzaj dowodu | Liczba |
|---|---|
| rzeczywisty przebieg | 49 |
| test automatyczny bez modelu | 34 |
| analiza kodu | 11 |
| symulacja | 1 |

**Warstwy zamknięte — 12 z 12:** L1, L2, L3, L4, L5, L6, L7, L8, L9, L10, L11, L12

**Warstwy otwarte — 0 z 12**, z identyfikatorami blokujących kryteriów:

| Warstwa | Kryteria blokujące |
|---|---|

**Kontrola spójności:** brak brakujących i zduplikowanych identyfikatorów; każde kryterium dokumentu ma dokładnie jedną ocenę.

---

### Warstwa 1 — Runtime i środowisko full stack

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L1.1** | Frontend i backend uruchamiają się z udokumentowanej konfiguracji na docelowym systemie. | **potwierdzone** | rzeczywisty przebieg | apps/server/src/main.ts | docs/evidence/audit-2026-09-15/01-checks.txt; instancja audytowa na :8795 | Backend produkcyjny wstal z dist, /api/health 200, /api/status raportuje subskrypcje | — |
| **L1.2** | React i TypeScript są najnowszymi stabilnymi wersjami; lockfile i zgodność zależności są sprawdzone. | **potwierdzone** | test automatyczny bez modelu | package.json, pnpm-lock.yaml | 02-versions.txt; pnpm install --frozen-lockfile; pnpm typecheck | React 19.3.0 i TS 7.0.2 = najnowsze stabilne; instalacja z zamrozonego lockfile bez ostrzezen peer; typecheck 0 bledow | Reklasyfikacja wobec poprzedniego raportu: ograniczenie „dev/CLI wymagaja --experimental-transform-types” nie nalezy do tego kryterium (dotyczy uruchamiania, nie wersji ani zgodnosci). Przeniesione do ryzyk operacyjnych przy L1.1 |
| **L1.3** | Build produkcyjny oraz sprawdzanie typów kończą się bez błędów; działanie nie zależy od serwera developerskiego Vite. | **potwierdzone** | rzeczywisty przebieg | apps/server/build.mjs, apps/web/vite.config.ts | 01-checks.txt (pnpm build), audit-server.sh | vite build + esbuild 166,8 kB; `node dist/server.js` bez zadnej flagi; testy przegladarkowe biegna na tym buildzie | — |
| **L1.4** | Backend obsługuje zwykłe żądania i strumienie bez buforowania odpowiedzi do końca generacji. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/http/app.ts (streamSSE) | run 8f8325: 20 zdarzen TEXT_MESSAGE_CONTENT | Tekst plynie przyrostowo przed zakonczeniem generacji | — |
| **L1.5** | Konfiguracja prywatna nie trafia do pakietu frontendu ani odpowiedzi HTTP. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/agent/auth.ts | tests/durability.test.ts; tests/runtime.test.ts | Rzeczywista wartosc tokena nie wystepuje w zbudowanym frontendzie, zbudowanym backendzie, pliku bazy danych ani w wyjsciu diagnostyki uruchomieniowej | Zakres dowodu rozszerzony po uwadze recenzenta: dwie odpowiedzi HTTP nie dowodzily braku sekretow w pakiecie frontendu ani w logach |
| **L1.6** | Restart zachowuje trwałe dane; zatrzymanie aplikacji nie pozostawia niezarządzanych procesów roboczych. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/runs.ts (reconcileOnBoot, abortAll) | 04-probes-api.txt; restart instancji audytowej | Po restarcie 5/5 plikow, sha pliku identyczne; przebieg przerwany SIGTERM oznaczony jako failed (server_sigterm), nie „running” | — |
| **L1.7** | Dostęp lokalny ma jawne zasady origin i autoryzacji; token subskrypcji nie pełni roli tokena dostępu do aplikacji. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/http/app.ts, auth/session.ts | tests/contracts.test.ts; 04-probes-api.txt | Allowlista origin (403), 401 bez sesji, wlasne ciasteczko HMAC; token subskrypcji nigdy nie jest tokenem dostepu | — |

### Warstwa 2 — Komponenty i nawigacja frontendowa

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L2.1** | Komponenty domenowe mają typowane właściwości i są zarejestrowane w katalogu OpenUI. | **potwierdzone** | analiza kodu | packages/*/src/**/cardComponents, registry/catalog.ts | /api/status → components (10) | 10 komponentow kart ze schematami Zod po stronie serwera i rendererami po stronie klienta | — |
| **L2.2** | Domyślna kompozycja obejmuje lewą nawigację i prawy czat, z adaptacją do mniejszych ekranów. | **potwierdzone** | rzeczywisty przebieg | packages/platform-ui/src/{chat/ChatPanel.tsx,styles.css} | e2e/chat-drawer.spec.ts (6/6, 1680 px i 1120 px); docs/evidence/closure-2026-09-15/11-chat-drawer.json | Szuflada zamknieta stoi poza panelem (left: -294 px, pokrycie 0 px), rozmowa i kompozytor maja caly panel. Otwarcie przez „Open sidebar”, zamkniecie przez „Collapse sidebar” — obie kontrolki widoczne, fokusowalne i dzialaja z klawiatury (Enter) | Podniesione z „czesciowe”. Przyczyna D-1 byla wlasna: `left: 0 !important` znosil pozycje poza kanwa w ukladzie, w ktorym biblioteka ukrywa przycisk zwijania. Test z celowo przywroconym bledem oblewa 6/6 |
| **L2.3** | Nawigacja, odświeżenie oraz Wstecz/Dalej przywracają właściwą rozmowę lub przestrzeń pracy. | **potwierdzone** | test automatyczny bez modelu | apps/web/src/router.tsx; platform-ui/src/{chat/ConversationSync.tsx,shell/SpaceSync.tsx,state/sessionLocation.ts} | e2e/session-restore.spec.ts (6); tests/session-restore.test.ts (11); 17-playwright.txt („nawigacja Wstecz/Dalej…”) | Rozmowa i przestrzen pracy sa w adresie (`?c=`, `?s=`). Po przeladowaniu wraca ta sama rozmowa, jej historia i jej przestrzen — bez wybierania czegokolwiek z szuflady; dalsze polecenie kontynuuje te sama sesje Claude. Wstecz/Dalej przelacza rozmowy bez mieszania historii. Parametry przezywaja kazda nawigacje przez `retainSearchParams` | ZAKRES DOWODU POPRAWIONY. Poprzednio „potwierdzone” na podstawie testu, ktory sprawdzal wylacznie przywracanie *widoku* (sciezki). Rozmowa NIE byla przywracana — po przeladowaniu czat otwieral nowa. Kryterium wymaga „wlasciwej rozmowy lub przestrzeni pracy”, wiec poprzednie zaliczenie bylo wezsze od wymagania. Dwa testy wrecz obchodzily ten brak, otwierajac rozmowe z szuflady po kazdym przeladowaniu |
| **L2.4** | Dynamiczne wnętrze UI nie wymaga generowania nowych plików tras ani wykonywalnego kodu aplikacji. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/registry/catalog.ts | raw-probe-canvas.log | Agent dodal/zmienil/przesunal/usunal karty bez zadnej zmiany w kodzie i bez nowych plikow tras | — |
| **L2.5** | Formularze i podstawowe interakcje działają z klawiatury, mają etykiety i widoczny fokus. | **potwierdzone** | test automatyczny bez modelu | packages/platform-ui/src/styles.css, module-procurement/src/ui/cards.tsx | 17-playwright.txt („…z klawiatury i ma widoczny fokus”) | Nawigacja klawiatura, etykiety pol, globalne :focus-visible | — |
| **L2.6** | Ładowanie, brak danych, błąd i brak dostępu mają rozróżnialne stany prezentacji. | **potwierdzone** | test automatyczny bez modelu | packages/platform-ui/src/components/ErrorState.tsx | e2e/access-context.spec.ts; tests/live-artifacts.test.ts | Brak dostepu ma wlasny, widoczny stan w przegladarce (`data-testid="access-denied"`, kod bledu w atrybucie) — rozrozniony od awarii i od pustej listy. Zaden fragment zasobu nie jest renderowany obok odmowy | Podniesione z „czesciowe”: audyt widzial tylko 403 z API, teraz stan jest potwierdzony w przegladarce |

### Warstwa 3 — Dynamiczna kompozycja interfejsu

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L3.1** | Początkowy układ i układ zmieniony przez agenta korzystają z tego samego katalogu komponentów. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/registry/catalog.ts | raw-probe-canvas.log | Uklad domyslny i uklad agenta przechodza przez ten sam ComponentCatalog.validate() | — |
| **L3.2** | Agent może dodać, usunąć, przestawić i zmienić właściwości elementu przez obsługiwany opis kompozycji. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/platform-tools.ts | raw-probe-canvas.log (AUDYT 2026-09-15) | Wszystkie cztery operacje wykonane przez model: add (hist.), update (specVersion 1→2), move (geometry 40,40, geometryVersion 1→2), remove | Podniesione z „czesciowe” — poprzedni raport nie mial dowodu dla update/move/remove |
| **L3.3** | Nieznany komponent, nieprawidłowe właściwości i niedozwolone odwołania nie są wykonywane ani zatwierdzane. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/registry/catalog.ts | tests/contracts.test.ts | Nieznany komponent i niepoprawne wlasciwosci odrzucane po stronie backendu | — |
| **L3.4** | Częściowa lub błędna odpowiedź modelu nie niszczy ostatniego poprawnego układu. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/services/canvas.ts | tests/contracts.test.ts („konflikt kompozycji…”) | Odrzucony zapis zostawia poprzednia wersje nienaruszona | — |
| **L3.5** | Zmiana kompozycji zachowuje zaznaczenia, filtry i niezapisane dane albo jawnie rozwiązuje konflikt przed ich utratą. | **potwierdzone** | test automatyczny bez modelu | packages/platform-ui/src/state/appState.ts | 17-playwright.txt („zmiana widoku karty przezywa przejscie…”) | Stan widoku karty zyje poza wezlem canvasu i przezywa zmiane ekranu | — |
| **L3.6** | Zapisana kompozycja jest odtwarzana po ponownym otwarciu aplikacji. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/canvas.ts | 17-playwright.txt; restart instancji audytowej | Karty, pozycje i widok wracaja po przeladowaniu i po restarcie backendu | — |
| **L3.7** | Dane biznesowe wyświetlane przez komponenty pochodzą z backendu; wygenerowane wartości nie zastępują trwałych rekordów. | **potwierdzone** | rzeczywisty przebieg | packages/module-procurement/src/ui/cards.tsx | 17-playwright.txt („tabela porownawcza pokazuje wartosci z backendu”) | Props niosa wylacznie referencje; kwoty na ekranie zgodne z wyliczeniem backendu | — |

### Warstwa 4 — Czat i zarządzanie rozmowami

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L4.1** | Czat korzysta z gotowego komponentu OpenUI, bez obowiązkowej zewnętrznej płatnej usługi. | **potwierdzone** | rzeczywisty przebieg | packages/platform-ui/src/chat/ChatPanel.tsx | 12/14-chat-*.png | AgentInterface 0.13.10 z wlasnym backendem przez restStorage; zadnej platnej uslugi | — |
| **L4.2** | Użytkownik tworzy rozmowę, widzi ją na liście, przełącza się między rozmowami i usuwa wybraną rozmowę. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/http/app.ts (/api/threads/*) | 17-playwright.txt („lista rozmow, przelaczanie i usuwanie”) | Usuwanie wykonywane przez menu wiersza w UI, z kontrola wyniku w backendzie | — |
| **L4.3** | Rozmowy mają automatyczne sensowne tytuły oraz możliwość zmiany tytułu; mechanizm nie korzysta z API Anthropic. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/services/conversations.ts (deriveTitle) | tests/runtime.test.ts; 17-playwright.txt | Tytul wyprowadzany lokalnie z pierwszej wiadomosci; zero wywolan modelu | — |
| **L4.4** | Historia i tytuły wracają po odświeżeniu oraz restarcie backendu. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/{agent/projection.ts,http/app.ts}, db/backfill.ts; platform-ui/src/chat/ConversationSync.tsx | e2e/tool-activity.spec.ts; e2e/session-restore.spec.ts; tests/run-lifecycle.test.ts; tests/projection.test.ts; tests/migration.test.ts | Historia zwraca ksztalt AG-UI: wiadomosc asystenta z `toolCalls` i wiadomosc `role:"tool"` z pasujacym `toolCallId`. Po przeladowaniu wraca ta sama rozmowa z tytulem i pelna historia — bez recznego wybierania; identyfikatory wiadomosci identyczne przed i po; to samo po restarcie backendu | Podniesione z „czesciowe” (D-2). Stare rozmowy odtwarzane z zachowanych `run_events` przez `backfillToolActivity`, idempotentnie (tests/migration.test.ts). Dowod na przeladowanie poprawiony: wczesniej test otwieral rozmowe z szuflady, co obchodzilo brak przywracania |
| **L4.5** | Przełączenie rozmowy nie miesza wiadomości, kontekstu ani wyników trwających wykonań. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts (kolejka per rozmowa) | raw-probe-conc2.log | Dwa rownolegle polecenia w jednej rozmowie: odpowiedzi „ALFA” i „BETA” nie zmieszane, oba przebiegi rozstrzygniete | — |
| **L4.6** | Powtórzenie żądania lub reconnect nie tworzy podwójnych wiadomości. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/conversations.ts | raw-probe-conc2.log; tests/contracts.test.ts | Przy dwoch rownoleglych poleceniach dokladnie 3 wiadomosci uzytkownika (1 zalozycielska + 2), brak duplikatow | — |
| **L4.7** | Usunięcie ma określony skutek dla sesji, aktywnego zadania i artefaktów; aplikacja nie pozostawia niespójnych powiązań. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/services/conversations.ts (delete) | 17-playwright.txt („usuniecie rozmowy odlacza artefakty”) | Kaskada na wiadomosci i uruchomienia, artefakty odlaczane (ON DELETE SET NULL) | — |
| **L4.8** | Zakres gotowej obsługi edycji wiadomości, rozgałęziania i przywracania usuniętych rozmów jest opisany jako dostępny lub niedostępny; UI nie sugeruje niezaimplementowanych funkcji. | **potwierdzone** | analiza kodu | packages/platform-contracts/src/conversation.ts (CHAT_CAPABILITIES) | /api/status; ekran Ustawienia | Edycja wiadomosci, rozgalezianie i przywracanie jawnie oznaczone jako niedostepne | — |

### Warstwa 5 — Komunikacja i zdarzenia

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L5.1** | Tekst jest widoczny przyrostowo przed zakończeniem generacji. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/agent/runtime.ts (includePartialMessages); platform-ui/src/chat/ChatPanel.tsx | e2e/streaming.spec.ts (3); tests/stream-verdict.test.ts (11); docs/evidence/closure-2026-09-15/21-strumien.json, 22-strumien-model.json | Tekst widoczny przyrostowo przed koncem wykonania: 4 rozne dlugosci odpowiedzi (28 → 107 znakow) zaobserwowane, gdy faza uruchomienia byla `running`. Obserwacja przez MutationObserver w stronie — kazda zmiana, faza czytana w tym samym takcie | ZAKRES DOWODU ROZSZERZONY. Poprzednio „20 zdarzen TEXT_MESSAGE_CONTENT” z jednego przebiegu — to dowod, ze backend wysyla przyrosty, nie ze uzytkownik je widzi. Detektor ma teraz udowodniona zdolnosc do oblania: ten sam kod na scenariuszu „cala odpowiedz jednym kawalkiem na koncu” orzeka brak strumieniowania, a na przebiegu bez tekstu nie liczy ani wiadomosci uzytkownika, ani podpowiedzi |
| **L5.2** | UI rozpoznaje rozpoczęcie i zakończenie wykonania, błąd oraz anulowanie. | **potwierdzone** | test automatyczny bez modelu | packages/platform-ui/src/chat/{platformAdapter.ts,ChatPanel.tsx}; services/runs.ts | tests/agui-stream.test.ts (15); e2e/tool-activity.spec.ts | Pasek stanu rozroznia kolejke, wykonywanie, oczekiwanie na zgode, sukces, blad i anulowanie; faza pochodzi ze zdarzen uruchomienia, nie z obecnosci tekstu. Backend ma osobny status `queued`. Anulowanie nie jest nadpisywane przez pozniejszy RUN_ERROR | Podniesione z „czesciowe”: wczesniej rozpoczecie i zakonczenie nie byly sygnalizowane w UI |
| **L5.3** | Wywołania narzędzi i ich wyniki są powiązane i dostępne dla prezentacji w czacie. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/projection.ts; platform-ui/src/chat/AssistantMessage.tsx | e2e/tool-activity.spec.ts; tests/projection.test.ts (11, porownanie z reduktorem biblioteki) | Wywolanie, argumenty, wynik i blad narzedzia sa sparowane po `toolCallId` i widoczne w czacie (`openui-behind-the-scenes`, nazwa narzedzia w tekscie dostepnym). Projekcja backendu porownana wprost z `processStreamedMessage` zainstalowanej biblioteki na 6 scenariuszach | Podniesione z „czesciowe”. Nierozstrzygnieta obserwacja audytu wyjasniona: brak elementow narzedzi wynikal z tego, ze backend nie zapisywal `toolCalls`, a nie z zaslonięcia |
| **L5.4** | Dane artefaktów i zmian UI docierają do właściwych rendererów. | **potwierdzone** | test automatyczny bez modelu | packages/platform-ui/src/chat/platformAdapter.ts; components/LiveArtifact.tsx | tests/agui-stream.test.ts; tests/live-artifacts.test.ts; e2e/tool-activity.spec.ts | Zdarzenia zmiany kompozycji, zmiany danych i nowego artefaktu uniewazniaja dokladnie wlasciwe klucze (przestrzen, odczyty modulu, lista i otwarty podglad artefaktu). Artefakty renderuja sie w czacie przez wspolny widok, ktory odswieza je przy otwarciu | Podniesione z „czesciowe”: wczesniej renderowanie artefaktu w czacie nie bylo zaobserwowane |
| **L5.5** | Pytanie lub prośba o decyzję dociera do interfejsu, a odpowiedź wraca do właściwego wykonania. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts (canUseTool) | FEEDBACK #23 (hist. 2026-09-14) | Zgoda i odmowa docieraja do klienta i wracaja do wykonania; przy odmowie polecenie sie nie wykonuje | Dowod historyczny, nie powtorzony w tym audycie |
| **L5.6** | Rozłączenie i ponowne połączenie nie powielają zdarzeń ani skutków operacji. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/agent/events.ts (read(fromSeq)) | tests/runtime.test.ts | Odtworzenie od numeru sekwencyjnego bez powielania; skutki chronione idempotencja | — |
| **L5.7** | Każde wykonanie ma jeden rozstrzygający status końcowy; UI nie pozostaje bezterminowo w stanie ładowania po błędzie. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/runs.ts (finish) | raw-probe-stop.log | Dokladnie jeden rozstrzygajacy status; po anulowaniu 80 → 80 zdarzen (brak pozniejszych zapisow) | — |
| **L5.8** | Pokrycie zdarzeń zostało sprawdzone z rzeczywistym adapterem Claude, a brakujące mapowania są jawnie opisane. | **potwierdzone** | analiza kodu | node_modules/@openuidev/react-headless (0.9.13) | analiza processStreamedMessage w wersji zainstalowanej | Obslugiwane 9 zdarzen; ignorowane CUSTOM, TEXT_MESSAGE_END, STEP_STARTED, STEP_FINISHED — udokumentowane | — |

### Warstwa 6 — Kontekst aplikacji dla agenta

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L6.1** | Kontekst obejmuje aktualną rozmowę, zasób, zaznaczenie, filtry i identyfikację kompozycji. | **potwierdzone** | analiza kodu | packages/platform-contracts/src/agent.ts (appContextSchema) | schemat + prompt systemowy | Kontekst obejmuje rozmowe, przestrzen, zasob, zaznaczenie, filtry, viewport i szkice | — |
| **L6.2** | Zmiana wyboru w UI zmienia kontekst kolejnego polecenia. | **potwierdzone** | rzeczywisty przebieg | packages/platform-ui/src/chat/chatWiring.ts | FEEDBACK #21 (hist.) | Kontekst czytany w momencie wyslania; zaznaczona pozycja trafia do wlasciwego rekordu | Dowod historyczny |
| **L6.3** | Agent potrafi pobrać aktualny kontekst podczas dłuższego zadania. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/platform-tools.ts (get_context) | raw-probe-canvas.log | Model wywolal mcp__app__get_context w przebiegu z dnia audytu | Podniesione z „tylko analiza kodu” |
| **L6.4** | Kontekst przesłany przez frontend jest walidowany i nie nadaje uprawnień backendowych. | **potwierdzone** | test automatyczny bez modelu | packages/platform-contracts/src/agent.ts | tests/contracts.test.ts; 04-probes-api.txt | appContextSchema nie ma pola wlasciciela; identyfikator z ciala zadania daje 403 | — |
| **L6.5** | Agent odróżnia roboczy stan formularza od danych zapisanych. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/prompt.ts (unsavedDrafts) | raw-probe-draft.log | Przy brudnym szkicu model podal ZAPISANA wartosc (5) i jawnie odnotowal istnienie szkicu | Podniesione z „czesciowe” |
| **L6.6** | Polecenie odnoszące się do aktualnego elementu prowadzi do operacji na właściwym rekordzie, co potwierdza wynik backendu. | **potwierdzone** | rzeczywisty przebieg | packages/module-procurement/src/server/services.ts | FEEDBACK #21 (hist.); raw-probe-canvas.log | Polecenie o wskazanym elemencie prowadzi do operacji na wlasciwym rekordzie | — |
| **L6.7** | Większe zbiory są pobierane selektywnie z paginacją lub limitem, a nie dołączane w całości do każdego promptu. | **potwierdzone** | analiza kodu | packages/module-procurement/src/server/tools.ts | schematy narzedzi (limit w list_offers, search) | Wyniki paginowane/limitowane; prompt nie zawiera danych biznesowych poza jednozdaniowym opisem zasobu | — |

### Warstwa 7 — Orkiestracja backendowa

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L7.1** | Claude SDK jest zarejestrowany i wywoływany przez oficjalną integrację Mastry. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts | kod: mastra.getAgent('appAgent').stream(); wszystkie przebiegi audytu | Wykonanie idzie przez instancje Mastry; query() z SDK uzywane wylacznie w diagnostyce | — |
| **L7.2** | Żądanie aplikacji jest powiązane z wykonaniem, kontekstem i diagnostyką. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/{http/app.ts,services/runs.ts} | naglowki X-Run-Id/X-Conversation-Id; tabela run_events | Zadanie powiazane z uruchomieniem, kontekstem i pelna sekwencja zdarzen | — |
| **L7.3** | Wynik, błąd i anulowanie przechodzą przez warstwę orkiestracji do klienta. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts | raw-probe-stop.log; run 6c9c63 (failed/server_sigterm) | Sukces, blad i anulowanie przechodza przez warstwe orkiestracji do klienta | — |
| **L7.4** | Równoległe żądania do tej samej sesji nie powodują niekontrolowanych wyścigów ani mieszania kontekstów. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts (serwer MCP per uruchomienie + kolejka) | raw-probe-conc2.log | Okna wykonania rozlaczne: f39794 konczy 10:27:41.687, f2b738 zaczyna 10:27:41.687; rozne rozmowy rownolegle | Podniesione z „czesciowe”. Uwaga metodyczna: agent_runs.started_at to moment ZAKOLEJKOWANIA — pierwsza wersja sondy dala falszywy GAP |
| **L7.5** | Orkiestracja nie omija serwisów domenowych przy mutacjach. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/agent/mcp.ts | tests/contracts.test.ts („…ta sama regula”) | Narzedzia MCP to nakladki na te same serwisy co HTTP | — |
| **L7.6** | Zakres własnych adapterów i wykorzystanych mechanizmów Mastry jest udokumentowany. | **potwierdzone** | analiza kodu | FEEDBACK.md sekcja 6 | — | Zakres wlasnych adapterow udokumentowany i zweryfikowany w tym audycie | — |
| **L7.7** | Działanie nie wymaga Mastra Factory, dodatkowego harnessu AgentController ani hostingu Mastry. | **potwierdzone** | analiza kodu | packages/platform-server/package.json | 02-versions.txt | Tylko @mastra/core i @mastra/claude; zwykly proces Node, bez Factory/AgentController/hostingu | — |

### Warstwa 8 — Harness i uwierzytelnienie Claude

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L8.1** | Wykonanie korzysta z pętli i narzędzi Claude SDK, a nie wyłącznie modelu Claude w routerze LLM. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts | raw-probe-canvas.log (ToolSearch + 4 narzedzia MCP) | Wielokrokowa petla agentowa SDK, nie pojedyncze wywolanie modelu | — |
| **L8.2** | Działa uwierzytelnienie subskrypcyjne, z potwierdzeniem trybu bez ujawniania tokena. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/auth.ts | /api/status instancji audytowej | mode=subscription, plan=max, bez ujawnienia tokena | — |
| **L8.3** | Klucz API Anthropic, gateway i automatyczny fallback płatnego API nie są aktywną ścieżką wykonania. | **potwierdzone** | symulacja | packages/platform-server/src/agent/auth.ts (subscriptionOnlyEnv) | 03-probes-auth.txt | Klucz API wykryty i oznaczony jako odrzucony; usuwany z procesu potomnego wraz z 6 innymi zmiennymi | — |
| **L8.4** | Narzędzia MCP są dostępne w SDK i prawdziwe wywołanie zwraca wynik do dalszej pracy agenta. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/mcp.ts | pnpm diag (hist.); wszystkie przebiegi audytu | 21 narzedzi zarejestrowanych; wyniki uzywane przez model do dalszej pracy | — |
| **L8.5** | Sesja jest kontynuowana przez jej właściwy identyfikator, bez powielania historii. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts (resumeStream) | FEEDBACK #19 (hist.); raw-probe-stop.log | Wznowienie po restarcie bez powielania historii; po anulowaniu kolejne uruchomienie w tej samej rozmowie konczy sie sukcesem | — |
| **L8.6** | Wygaśnięcie uwierzytelnienia i wyczerpanie limitu dają czytelny błąd oraz zachowują stan pracy. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/agent/auth.ts; platform-contracts/src/agent.ts | tests/auth.test.ts (19, syntetyczne poswiadczenia); e2e/tool-activity.spec.ts (limit uzycia w UI) | Rozdzielone trzy wymiary: sposob logowania, stan lokalnych metadanych (`absent\|valid\|stale\|unreadable`) i ostatni potwierdzony dostep (`unverified\|verified\|rate_limited\|refresh_refused\|revoked\|failed`). Wygasle poswiadczenie to „stale”, nie zdrowa subskrypcja, i samo w sobie nie blokuje uruchomienia — odnowienie nalezy do SDK. Limit uzycia jest odrozniony od zepsutego logowania i nie prowadzi do komunikatu o ponownym logowaniu | Podniesione z „niespelnione” (D-3). Stany bledow wywolane kontrolowana symulacja na granicy adaptera; rzeczywiste logowanie nietkniete, limit nie byl celowo wyczerpywany |
| **L8.7** | Poświadczenia pozostają poza frontendem, artefaktami i logami. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/agent/auth.ts | tests/runtime.test.ts; 03-probes-auth.txt | Rzeczywisty token nie wystepuje w zadnym wyjsciu aplikacji | Zakres sprawdzenia: probeAuth i /api/status. Nie przeszukano logow serwera ani artefaktow |
| **L8.8** | Zgodność konkretnej wersji SDK, adaptera i sposobu logowania została sprawdzona rzeczywistym wywołaniem. | **potwierdzone** | rzeczywisty przebieg | — | FEEDBACK #15/#18/#23 (hist.); 02-versions.txt | Zgodnosc wersji sprawdzona rzeczywistymi wywolaniami; trzy niezgodnosci znalezione i obsluzone | — |

### Warstwa 9 — Model domeny i funkcje backendu

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L9.1** | Encje, relacje i reguły domenowe są opisane dla konkretnego produktu. | **potwierdzone** | analiza kodu | packages/module-procurement/src/shared/index.ts | schemat 8 tabel pc_* | Encje, relacje i reguly opisane dla produktu | — |
| **L9.2** | Endpointy i narzędzia MCP korzystają z tych samych reguł walidacji i mutacji. | **potwierdzone** | test automatyczny bez modelu | packages/module-procurement/src/server/inputs.ts | tests/contracts.test.ts | Wspolne schematy wejscia i wspolny serwis dla HTTP i MCP | — |
| **L9.3** | Wejścia są walidowane w runtime, a błędy mają rozpoznawalne typy i przyczyny. | **potwierdzone** | test automatyczny bez modelu | packages/platform-contracts/src/errors.ts | tests/contracts.test.ts; 04-probes-api.txt | 13 kodow bledow mapowanych na statusy HTTP; walidacja w runtime | — |
| **L9.4** | Agent potrafi wyszukać rekord, przejść po wielopoziomowych relacjach i pobrać szczegóły. | **potwierdzone** | rzeczywisty przebieg | packages/module-procurement/src/server/services.ts (findProvenance) | FEEDBACK #21 (hist.) | Przejscie pozycja → oferta → dostawca → zalacznik → wiersz w pliku | Dowod historyczny |
| **L9.5** | Uprawnienia sprawdza backend; identyfikator właściciela dostarczony przez model lub przeglądarkę nie wystarcza do uzyskania dostępu. | **potwierdzone** | test automatyczny bez modelu | packages/module-procurement/src/server/repository.ts | 04-probes-api.txt (OWNER-*) | Drugi wlasciciel: 403 na canvas, sprawe i porownanie; listy przestrzeni, plikow i artefaktow rozlaczne | — |
| **L9.6** | Konflikt aktualności nie nadpisuje nowszych danych bez rozstrzygnięcia. | **potwierdzone** | test automatyczny bez modelu | packages/module-procurement/src/server/repository.ts (updateItemChecked) | 04-probes-api.txt (CONFLICT-*) | Nieaktualna wersja → 409 conflict, bez nadpisania | — |
| **L9.7** | Powtórzenie tej samej operacji nie dubluje skutków biznesowych. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/idempotency.ts | 04-probes-api.txt (IDEMPOTENCY-8-rownoleglych) | 8 rownoleglych zadan z tym samym operationId: 8 odpowiedzi 200, dokladnie jeden przyrost wersji | Wzmocnione wobec poprzedniego raportu (bylo sekwencyjnie, teraz rownolegle) |
| **L9.8** | Operacja wieloetapowego zapisu jest atomowa albo ma jawny mechanizm odzyskania spójności. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/services/artifacts.ts; module-procurement/src/server/services.ts | tests/durability.test.ts | Przerwany zapis wieloetapowy nie zostawia ani wiersza artefaktu, ani jego wersji; odrzucona zmiana pozycji nie zmienia ani wartosci, ani licznika wersji | Zakres dowodu rozszerzony po uwadze recenzenta: odtworzenie kopii bazy nie dowodzilo atomowosci przerwanej operacji |
| **L9.9** | Testy potwierdzają rzeczywistą zmianę danych oraz odrzucenie nieuprawnionej operacji. | **potwierdzone** | test automatyczny bez modelu | tests/contracts.test.ts | pnpm test 69/69 | Testy potwierdzaja zmiane danych i odrzucenie operacji nieuprawnionej | — |

### Warstwa 10 — Trwałość, cache i artefakty

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L10.1** | Własność każdego rodzaju danych odpowiada tabeli modelu własności; nie istnieją niezależnie mutowane kopie domeny. | **potwierdzone** | analiza kodu | FEEDBACK sekcja 4 (tabela wlasnosci) | scripts/check-boundaries.mjs | Kazdy rodzaj danych ma jednego wlasciciela; platforma nie pisze do tabel pc_* | — |
| **L10.2** | Migracje tworzą i aktualizują bazę bez utraty obsługiwanych danych; sprawdzona jest kopia i odtworzenie trwałego stanu lokalnego. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/db/{migrations.ts,backfill.ts}; scripts/{backup-state.mjs,migration-rehearsal.mjs} | tests/migration.test.ts (4); docs/evidence/closure-2026-09-15/{23-proba-migracji.json,24-kopia.txt}; docs/odzyskiwanie-stanu.md | Sprawdzona kopia stanu lokalnego istnieje (`backups/data-2026-09-15`, weryfikowana ponownym odczytem: sumy SHA-256, census tabel, integrity_check). Proba migracji na kopii danych tej maszyny: 31 rozmow, 31 wiadomosci uzytkownika (tresc i przypisanie), 18 kart canvasu (kompozycje bez zmian), 9 plikow, 432 zdarzenia uruchomien — wszystko zachowane po tozsamosci. Powtorne uruchomienie nie zmienilo ani jednego wiersza. Procedura odzyskania udokumentowana. Migracja nastepnie WYKONANA na danych uzytkownika za jego zgoda: wynik zgodny z proba co do wiersza (42→76 wiadomosci), odciski wierszy widocznych dla uzytkownika identyczne z kopia, powtorzenie bez zmian w 21 tabelach (27-migracja-wykonana.txt) | ZAKRES DOWODU ROZSZERZONY. Poprzednio „kopia katalogu otwiera sie z kompletnym stanem” — to dowod spojnosci kopii, nie dowod zachowania danych przez migracje. Odkryte przy okazji: katalog danych mial 4,1 MB w `app.db-wal` przy 397 kB w `app.db`, wiec kopia samego pliku glownego cofalaby stan o dzien i wygladalaby na kompletna |
| **L10.3** | Rozmowa aplikacji jest jednoznacznie powiązana z sesją Claude i jej właścicielem. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/conversations.ts | tabela conversations instancji audytowej | claude_session_id + owner_id przypisane do rozmowy | — |
| **L10.4** | Restart przywraca historię, kompozycję, powiązania sesji i artefakty. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/index.ts | restart instancji audytowej | Historia, kompozycja, powiazania sesji i artefakty wracaja po restarcie | — |
| **L10.5** | Mutacja przez UI lub MCP odświeża właściwe dane na froncie bez pełnego przeładowania. | **potwierdzone** | rzeczywisty przebieg | packages/platform-ui/src/chat/platformAdapter.ts | FEEDBACK #21 (hist.); 08-probes-browser.txt | platform.data_changed / canvas_changed uniewazniaja wlasciwe zapytania; karta agenta pojawia sie bez przeladowania | — |
| **L10.6** | Komponenty współdzielą pobrania dla tego samego zasobu; klucze cache uwzględniają kontekst dostępu i filtry. | **potwierdzone** | analiza kodu | packages/platform-ui/src/api/queries.ts | klucze qk.* | Komponenty tej samej sprawy dziela jedno pobranie przez wspolny klucz | — |
| **L10.7** | Zmiana kontekstu właściciela nie ujawnia danych z poprzedniego cache. | **potwierdzone** | test automatyczny bez modelu | packages/platform-ui/src/api/{accessContext.ts,client.ts,queries.ts} | tests/access-context.test.ts (8); e2e/access-context.spec.ts; tests/session.test.ts | Klucze cache niosa kontekst dostepu, zasob i filtry. Zmiana tozsamosci przerywa zadania w locie wspolnym sygnalem i odrzuca odpowiedz po numerze epoki, po czym czysci cache. Sprawdzone w jednej instancji i jednym cache, z zadaniem w locie w momencie przelaczenia | Podniesione z „czesciowe”. Komentarz twierdzacy, ze klucze juz zawieraja wlasciciela, byl nieprawdziwy — nie zawieraly. Przy okazji naprawiono reset tozsamosci przy pelnym przeladowaniu strony |
| **L10.8** | Artefakt ma stabilny identyfikator, wersję, właściciela i trwałą treść; tytuł nie jest jego kluczem. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/services/artifacts.ts | tests/contracts.test.ts | Klucz (artifact_id, version); tytul to zwykla kolumna | — |
| **L10.9** | Podgląd i pełny widok wskazują tę samą wersję; pliki można pobrać po restarcie. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/files.ts | restart instancji audytowej (sha 459cb0b8… przed i po) | Podglad i pelny widok czytaja current_version; plik pobieralny po restarcie | — |
| **L10.10** | Raport historyczny zachowuje treść, a artefakt oznaczony jako żywy pobiera aktualne dane. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/services/artifacts.ts; platform-contracts/src/{artifacts.ts,module.ts} | tests/live-artifacts.test.ts (9) | Snapshot zachowuje liczby po zmianie zrodla; artefakt live przelicza sie przy kazdym otwarciu przez zarejestrowana, typowana operacje odczytu modulu. Deskryptor nie niesie kodu ani SQL; nieznana operacja i niepoprawne wejscie sa odrzucane przy zapisie. Po restarcie snapshot nadal zamrozony, live nadal aktualny | Podniesione z „czesciowe” (D-4). Blad odczytu i brak dostepu daja jawny stan, nigdy poprzedniego wyniku podanego jako biezacy |

### Warstwa 11 — Pliki, sandbox i cykl życia zadań

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L11.1** | Użytkownik wgrywa plik, agent odczytuje go i przetwarza kodem, a użytkownik pobiera poprawny wynik. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/platform-tools.ts | FEEDBACK #20 (hist.); 08-probes-browser.txt | Plik → workspace → odczyt → raport → artefakt do pobrania; w audycie artefakt utworzony przez save_comparison i widoczny na ekranie | Czesc sandboxowa (Bash/Write w workspace) z dowodu historycznego |
| **L11.2** | Limity wielkości, nazwy plików i zakres katalogów są egzekwowane przez backend. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/services/files.ts | tests/runtime.test.ts; 17-playwright.txt | sanitizeFilename odporne na ../ i znaki sterujace; limit 8 MB; allowlista typow; resolveInWorkspace | — |
| **L11.3** | Izolacja jest aktywna na docelowym systemie; kontrolowane próby niedozwolonego odczytu, zapisu i dostępu do sieci są odrzucane. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/sandbox.ts | FEEDBACK #24/#25 (hist.) | Siec: deny network-outbound example.com:443, exit 56. Pliki: data/app.db niewidoczna, ls pokazuje tylko workspaces | Dowod historyczny — nie powtorzony w tym audycie |
| **L11.4** | Sandbox poleceń i uprawnienia narzędzi plikowych obejmują wszystkie udostępnione sposoby dostępu, a nie tylko powłokę. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts (allowedTools) | FEEDBACK #17/#23 (hist.) | Narzedzia plikowe zamkniete w workspace; powloka przez canUseTool | Dowod historyczny |
| **L11.5** | Narzędzia nie mają niejawnego dostępu do bazy domenowej pozwalającego ominąć MCP i serwisy backendu. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/sandbox.ts (denyRead) | FEEDBACK #25 (hist.) | Katalog danych aplikacji niewidoczny dla procesu sandboxowego | Dowod historyczny |
| **L11.6** | Zadanie ma trwały status i powiązanie z rozmową; zamknięcie panelu nie usuwa informacji o pracy. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/runs.ts | tabela agent_runs instancji audytowej (16 przebiegow) | Zadanie ma trwaly status i powiazanie z rozmowa; zamkniecie panelu nie usuwa wpisu | — |
| **L11.7** | Stop dociera do wykonania i jego procesów potomnych; pomiar czasu anulowania znajduje się w odbiorze. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/runs.ts (cancel/abortAll) | raw-probe-stop.log | Potwierdzenie 3 ms; strumien zamkniety po 2010 ms; potomkowie serwera 0 przed / 1 w trakcie / 0 po (brak osieroconych); 80 → 80 zdarzen; kolejne uruchomienie succeeded | Podniesione z „czesciowe” — poprzedni raport mierzyl tylko czesc aplikacyjna |
| **L11.8** | Restart rozróżnia zadanie zakończone od przerwanego; wznowienie nie udaje kontynuacji utraconego procesu. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/runs.ts (reconcileOnBoot) | run 6c9c63: failed / server_sigterm | Przebieg przerwany restartem oznaczony jako failed z jawna przyczyna, nie udaje kontynuacji | — |
| **L11.9** | Wymagane pytania i zgody pojawiają się w aplikacji; odmowa nie wykonuje operacji, zgoda nie wykonuje jej podwójnie. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts (canUseTool) | FEEDBACK #23 (hist.) | Odmowa → polecenie sie nie wykonuje; zgoda → prosba dokladnie raz | Dowod historyczny |
| **L11.10** | Opublikowane wyniki pozostają trwałe po sprzątnięciu plików tymczasowych. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/platform-tools.ts | FEEDBACK #20 (hist.); restart instancji audytowej | workspace.dispose() w finally; plik artefaktu nadal pobieralny | — |

### Warstwa 12 — Obserwowalność i odbiór integracji

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L12.1** | Rozmowę można powiązać z wykonaniem, narzędziem, mutacją i artefaktem w danych diagnostycznych. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/runs.ts (run_events) | baza instancji audytowej | conversations → agent_runs → run_events → artifacts; pelna sekwencja z argumentami i wynikami narzedzi | — |
| **L12.2** | Błędy integracji, domeny, modelu i sandboxu są rozróżnialne; sekrety nie występują w logach. | **potwierdzone** | test automatyczny bez modelu | packages/platform-contracts/src/errors.ts | tests/contracts.test.ts; raw-probe-stop.log | Bledy integracji, domeny, modelu i sandboxu rozroznialne; brak sekretow w odpowiedziach | — |
| **L12.3** | Zmierzone są czas pierwszej odpowiedzi, wykonania, odświeżenia po mutacji i anulowania, z podaniem warunków pomiaru. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/services/runs.ts; platform-contracts/src/agent.ts | tests/run-lifecycle.test.ts (13); docs/evidence/closure-2026-09-15/20-pomiary.json | Punkty pomiaru rozdzielone i nazwane: zakolejkowanie, start wykonania, pierwszy tekst (od startu wykonania), koniec, oraz osobno czas w kolejce. Sprawdzone trzy kolejnosci: narzedzie→tekst, tekst→narzedzie i odpowiedz bez tekstu (brak wartosci jest poprawnym wynikiem, nie podstawionym). Czas odswiezenia po mutacji i czas anulowania zmierzone w przegladarce | Podniesione z „czesciowe” (D-5). Przyczyna: hook PreToolUse otwieral wiadomosc tekstowa przed pierwszym tokenem, wiec pomiar nie wykonywal sie w najczestszej kolejnosci |
| **L12.4** | Testy kontraktów obejmują walidację, konflikty, powtórzenia i kontrolę dostępu. | **potwierdzone** | test automatyczny bez modelu | tests/contracts.test.ts | pnpm test 69/69 | Walidacja, konflikty, powtorzenia i kontrola dostepu pokryte | — |
| **L12.5** | Testy przeglądarkowe obejmują dynamiczny UI, rozmowy, narzędzia, artefakty i wznowienie. | **potwierdzone** | rzeczywisty przebieg | e2e/*.spec.ts | e2e/{app,chat,chat-drawer,tool-activity,streaming,session-restore,access-context,measurements,agent-ui}.spec.ts (46) | Testy przegladarkowe obejmuja dynamiczny UI (canvas, karty, nawigacja), rozmowy (lista, przelaczanie, usuwanie, przywracanie po przeladowaniu, Wstecz/Dalej, stan zastepczy dla usunietej), narzedzia (wywolanie, wynik, blad, trwalosc), artefakty, strumieniowanie z kontrolami negatywnymi i wznowienie po restarcie backendu. Kazdy plik przechodzi przez `e2e/support/fixtures.ts`, wiec zaden nie moze wyslac zadania do instancji, ktorej testy nie uruchomily | Podniesione z „czesciowe” (D-6), nastepnie poprawione: asercja strumieniowania byla niestabilna (ten sam kod, dwa rozne wyniki) i zostala zastapiona obserwacja w stronie; dwa testy obchodzily brak przywracania rozmowy i zostaly przepisane |
| **L12.6** | Rzeczywista ścieżka subskrypcja Claude → SDK → Mastra → AG-UI → OpenUI została potwierdzona; mocki są oznaczone osobno. | **potwierdzone** | rzeczywisty przebieg | — | wszystkie przebiegi audytu | Sciezka subskrypcja → SDK → Mastra → AG-UI → OpenUI potwierdzona; w repo nie ma ani jednego mocka Claude | AG-UI uzyte jako protokol drutowy: zero importow @ag-ui/*; @ag-ui/core 0.0.53 obecny wylacznie tranzytywnie. Integracja @ag-ui/mastra wskazana w dokumencie nie zostala uzyta |
| **L12.7** | Opis odbioru wskazuje wersje, dowody, nieudane próby, brakujące możliwości i własne adaptery. | **potwierdzone** | analiza kodu | RAPORT-STANU-PLATFORMY.md | ten dokument | Opis odbioru z wersjami, dowodami, nieudanymi probami i wlasnymi adapterami | — |
| **L12.8** | System działa bez Langfuse; możliwość eksportu i ewentualne ograniczenia kompatybilności są udokumentowane. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/agent/runtime.ts (Mastra) | docs/observability.md; tests/observability.test.ts | System dziala bez Langfuse — zadna jego zaleznosc nie jest zainstalowana. Punkt wpiecia (`observability` w konfiguracji Mastry, publiczny typ `ObservabilityExporter`) potwierdzony testem na zainstalowanej wersji | Ograniczenia opisane wprost: podlaczenie wymaga dodania `@mastra/observability` i eksportera Langfuse; telemetria Mastry nie zawiera wywolan narzedzi w tej samej postaci co `run_events`; zgodnosc schematu Langfuse z ta wersja Mastry pozostaje niesprawdzona; eksport wyniosl by dane rozmowy poza maszyne |

