# Raport stanu platformy AgenticApp

> **Dokument historyczny z aplikacji AgenticApp** (stan z 2026-09-16, przed konsolidacją szablonu; sha256 oryginału `cc515cce6a117254…`).
> Opisuje próby wykonane w katalogu AgenticApp i ocenę wobec poprzedniej wersji specyfikacji (95 kryteriów).
> Nie potwierdza stanu tego repozytorium — aktualna ocena: [`docs/ACCEPTANCE.md`](../../ACCEPTANCE.md).
> Odnośniki do `docs/evidence/…` wskazują dowody, które pozostały lokalnie w AgenticApp i nie są publikowane; odnośniki do `docs/*.md` odpowiadają plikom w `docs/` tego repozytorium.
> Oczyszczenie: bezwzględną ścieżkę katalogu domowego zastąpiono `<katalog AgenticApp>`.

**Audyt diagnostyczny — 2026-09-15.** Dokument samowystarczalny: nie wymaga dostępu do rozmowy,
w której powstał, ani do wcześniejszych podsumowań. Dowody w
[`docs/evidence/audit-2026-09-15/`](docs/evidence/audit-2026-09-15/).

Zakres: sprawdzenie implementacji i dowodów, **bez przebudowy aplikacji i bez naprawiania kodu
produkcyjnego**. Wszystkie zmiany wprowadzone w trakcie audytu są wymienione w §1.4.

---

## 1. Werdykt i zakres weryfikacji

### 1.1 Werdykt

Platforma **działa end-to-end na rzeczywistym modelu przez subskrypcję** i została w tym audycie
przejechana 18 razy. Sześć warstw z dwunastu jest zamkniętych. Pozostałe sześć blokuje
**jedenaście kryteriów**, za którymi stoi **sześć nazwanych defektów** — nie brak funkcji.

| | |
|---|---|
| Kryteriów w dokumencie architektury | **95** (wyliczone, §3) |
| Potwierdzone | 84 |
| Częściowe | 10 |
| Niespełnione | 1 |
| Niesprawdzone | 0 |
| **Warstwy zamknięte** | **6 z 12** — L1, L3, L6, L7, L9, L11 |
| **Warstwy otwarte** | **6 z 12** — L2, L4, L5, L8, L10, L12 |

Poprzedni raport (`FEEDBACK.md`, 2026-09-14) podawał 3 warstwy zamknięte. Różnica **nie** wynika
z obniżenia wymagań — pochodzi z sześciu prób wykonanych w tym audycie (L3.2, L6.3, L6.5, L7.4,
L11.7) i jednej reklasyfikacji (L1.2), przy **jednoczesnym obniżeniu** czterech innych kryteriów
(L2.2, L4.4, L5.3, L12.5) i uznaniu jednego za niespełnione (L8.6). Każda zmiana jest uzasadniona
w §3 w kolumnie „konkretny brak" i zestawiona w §4.6.

**Czego ten werdykt nie mówi:** platforma nie jest sprawdzonym szablonem kolejnych aplikacji.
Blokady dotyczące ponownego użycia — w odróżnieniu od tych dotyczących wyłącznie demonstracji
ofert — są wskazane w §6.3.

### 1.2 Co rzeczywiście działa (sprawdzone w tym audycie)

- Pełna pętla agentowa: kompozytor → AG-UI → Mastra → Claude Agent SDK → MCP → serwis domenowy →
  zapis → widoczny wynik. 18 przebiegów, wszystkie na subskrypcji, zero mocków modelu w repozytorium.
- **Wszystkie cztery operacje canvasu wykonane przez model** (dodanie, aktualizacja, przesunięcie,
  usunięcie) — luka z poprzedniego raportu domknięta.
- **Współbieżność**: dwa polecenia w jednej rozmowie są szeregowane (okna wykonania rozłączne
  co do milisekundy), różne rozmowy biegną równolegle, odpowiedzi się nie mieszają, brak duplikatów
  wiadomości.
- **Stop**: potwierdzenie w 3 ms, strumień zamknięty po 2010 ms, **zero osieroconych procesów**,
  zero zapisów po anulowaniu, kolejka odblokowana (kolejne uruchomienie `succeeded`).
- **Idempotencja pod równoległością**: 8 jednoczesnych żądań z tym samym `operationId` → 8 odpowiedzi
  200 i **dokładnie jeden** przyrost wersji.
- **Izolacja właścicieli**: 403 na wszystkich sprawdzonych powierzchniach, rozłączne listy
  przestrzeni, plików i artefaktów.
- **Trwałość**: restart backendu zachowuje pliki co do sumy kontrolnej; przebieg przerwany
  `SIGTERM` oznaczany jako `failed`, nie „running".
- `get_context` faktycznie wywoływane przez model; model odróżnia zapisaną wartość od
  niezapisanego szkicu formularza.

### 1.3 Co blokuje zakończenie

Sześć defektów. Pełny opis z reprodukcją w §5.

| Id | Defekt | Kryteria | Rodzaj |
|---|---|---|---|
| **D-1** | Przy otwartej szufladzie rozmów wątek czatu nie jest widoczny; audyt nie znalazł kontrolki zamykającej | L2.2, (L5.3) | naprawa kodu |
| **D-2** | Wiadomości nie niosą `toolCalls` — aktywność narzędzi nie przeżywa przeładowania | L4.4, L5.3 | naprawa kodu |
| **D-3** | `probeAuth` raportuje `subscription` dla wygasłego poświadczenia | L8.6 | naprawa kodu |
| **D-4** | Tryb artefaktu `live` zapisywany i obiecany modelowi, ale nieobsługiwany przy odczycie | L10.10 | naprawa kodu lub wycofanie obietnicy |
| **D-5** | `first_token_ms` gubiony, gdy narzędzie poprzedza tekst | L12.3, L12.5 | naprawa kodu |
| **D-6** | Asercja „streaming dociera na ekran" dopasowuje się do etykiety podpowiedzi — jest pusta | L12.5 | brak testu |

Dodatkowo dwa kryteria są otwarte **bez** defektu produktu: L2.6 (stan „brak dostępu"
niewywołany w przeglądarce), L10.7 (klucze cache nie zawierają właściciela, a aplikacja nie ma
ścieżki do wywołania przejścia), L5.2 i L5.4 (ograniczenie gotowej biblioteki — §5.7).

### 1.4 Czego nie sprawdzono i dlaczego — rozróżnienie rodzajów braku

| Rodzaj | Pozycje |
|---|---|
| **Brak dostępu** | żaden. Subskrypcja Claude (plan `max`) dostępna przez cały audyt |
| **Brak implementacji** | D-4 (tryb `live`); `toolCalls` w kontrakcie wiadomości (D-2); porównanie `expiresAt` z czasem bieżącym (D-3) |
| **Brak dowodu** | L2.6, L10.7; sandbox (L11.3–L11.5) i zgody (L5.5, L11.9) opierają się na dowodach **historycznych** z 2026-09-14, nie powtórzonych dziś |
| **Ograniczenie zależności** | L5.2, L5.4 — `@openuidev/react-headless` 0.9.13 implementuje 13 z 32 zdarzeń protokołu AG-UI i nie zna `RUN_STARTED`/`RUN_FINISHED` (§5.7) |
| **Niewywoływalne bezpiecznie** | wyczerpanie limitu użycia (część L8.6). Nie wyczerpywano limitu celowo; wygaśnięcie zasymulowano na granicy adaptera |

**Nierozstrzygnięte:** w trzech obserwacjach nie znaleziono elementu narzędzia w DOM czatu mimo
poprawnych wywołań w strumieniu. Nie ustalono, czy przyczyną jest zasłonięcie przez D-1, czy brak
renderowania. Zakres zawężony, przyczyna nieustalona — patrz §5.2.

### 1.5 Stan repozytorium i środowisko

| | |
|---|---|
| Katalog | `<katalog AgenticApp>` |
| **Repozytorium git** | **brak** — `git rev-parse` zawodzi. Nie ma rewizji ani historii commitów; nie da się wskazać „zmian niezapisanych w commicie", bo nie ma punktu odniesienia. To samo w sobie jest brakiem dla powtarzalności audytu |
| Pliki źródłowe | 79 plików `.ts`/`.tsx` w `packages/` i `apps/` |
| Pierwotny prompt implementacyjny | **nieobecny w repozytorium**; podstawą oceny jest wyłącznie `stack-agentowy-ustalenia-i-materialy.md` (24 674 B, niezmieniony od 2026-09-14 10:58) |
| System | Linux 7.2.4-200.fc44.x86_64 (Fedora) |
| Node.js | 24.19.0 |
| pnpm | 9.15.9, workspaces, `--frozen-lockfile` przechodzi bez ostrzeżeń peer |
| Claude Code CLI | **2.1.272** (poprzedni audyt: 2.1.270 — dryf wersji poza kontrolą lockfile) |

Wersje rozwiązane z `node_modules` (nie z zakresów w `package.json`) —
[`02-versions.txt`](docs/evidence/audit-2026-09-15/02-versions.txt):

| Pakiet | Wersja | | Pakiet | Wersja |
|---|---|---|---|---|
| react / react-dom | 19.3.0 | | @mastra/core | 1.66.0 |
| typescript | 7.0.2 | | @mastra/claude | 0.3.1 |
| hono | 4.13.7 | | @anthropic-ai/claude-agent-sdk | 0.3.270 |
| @hono/node-server | 1.19.7 | | @openuidev/react-ui | 0.13.10 |
| drizzle-orm | 0.45.2 | | @openuidev/react-lang | 0.2.15 |
| better-sqlite3 | 13.0.3 | | @openuidev/react-headless | 0.9.13 |
| zod | 4.6.5 | | @xyflow/react | 12.11.6 |
| @tanstack/react-query | 5.102.8 | | @tanstack/react-router | 1.170.36 |
| zustand | 4.5.7 | | @ag-ui/core | 0.0.53 (**tylko tranzytywnie**) |

### 1.6 Środowisko testów i izolacja danych

Wszystkie próby wymagające zapisu biegły na **odseparowanej instancji**: własny katalog danych
(`$SCRATCH/audit-data`), własny port 8795, własna baza. Dane użytkownika w `data/` pozostały
nietknięte (`data/app.db` ze znacznikiem 2026-09-14 15:05 przed audytem i po nim).

Wyjątek: `pnpm test` i `pnpm test:e2e` uruchomiono na konfiguracji domyślnej, bo to istniejące
kontrole projektu i taka jest ich normalna postać.

### 1.7 Zmiany wprowadzone w trakcie audytu

**Żaden plik produkcyjny nie został zmieniony.** Dodano wyłącznie materiały diagnostyczne,
wszystkie oznaczone nagłówkiem `DIAGNOSTIC (audit 2026-09-15) — not production code`:

| Plik | Rola |
|---|---|
| `scripts/audit-versions.mjs` | rozwiązanie faktycznych wersji z `node_modules` |
| `scripts/audit-server.sh` | odseparowana instancja backendu (własny katalog i port) |
| `scripts/audit-probes.ts` | degradacja uwierzytelnienia na granicy adaptera (symulacja) |
| `scripts/audit-probes-api.mjs` | izolacja właścicieli, idempotencja, konflikt wersji |
| `scripts/audit-probes-model.mjs` | canvas CRUD, `get_context`, współbieżność, Stop, szkic |
| `scripts/audit-probes-browser.mjs` | obserwacja czatu podczas rzeczywistego przebiegu |
| `scripts/audit-probe-remount.mjs` | eksperyment rozstrzygający dla hipotezy przemontowania |
| `scripts/audit-probe-chat-tools.mjs` | renderowanie aktywności narzędzi w czacie |
| `scripts/audit-probe-chat-layout.mjs` | charakterystyka układu panelu czatu |
| `scripts/audit-matrix.mjs` | generator macierzy §3 z wymaganiami czytanymi z dokumentu |
| `docs/evidence/audit-2026-09-15/**` | 22 pliki dowodowe (logi, zrzuty, wyniki sond) |

Sondy **nie** wchodzą do `pnpm test` ani `pnpm test:e2e` — znaczenie tych poleceń pozostaje
nienaruszone.

### 1.8 Dowody historyczne a dowody tego audytu

Macierz w §3 rozróżnia je jawnie: pozycje oparte na wcześniejszych przebiegach mają w kolumnie
„Dowód" adnotację `(hist.)` i wskazanie wpisu w `FEEDBACK.md`. Dotyczy to ośmiu kryteriów:
L5.5, L6.2, L6.6 (częściowo), L9.4, L11.1 (część sandboxowa), L11.3, L11.4, L11.5, L11.9.
Wszystkie pozostałe mają dowód z 2026-09-15.

---

## 2. Faktyczna architektura

### 2.1 Rzeczywista kolejność przepływu

Kolejność poniżej wynika z odczytu kodu i z zaobserwowanych sekwencji `run_events`, nie z deklaracji.

```
[1] Kompozytor czatu  (@openuidev/react-ui AgentInterface → textarea.openui-agent-thread-composer__input)
      ↓ ChatLLM.send()                       packages/platform-ui/src/chat/chatWiring.ts
[2] POST /api/agui/run  (ciało w kształcie AG-UI RunAgentInput, kontekst czytany ze store W MOMENCIE wysłania)
      ↓                                      packages/platform-server/src/http/app.ts:215
[3] Walidacja + utworzenie/rozpoznanie rozmowy + idempotentny zapis wiadomości użytkownika
      ↓ AgentRuntime.start()                 packages/platform-server/src/agent/runtime.ts:115
[4] KOLEJKA per rozmowa  → workspace uruchomienia → serwer MCP budowany PER URUCHOMIENIE
      ↓ mastra.getAgent('appAgent').stream() / .resumeStream()          runtime.ts:116, 335
[5] @mastra/claude ClaudeSDKAgent → Claude Agent SDK query() → proces potomny (natywny runtime SDK)
      ↓                                      dwa NIEZALEŻNE źródła zdarzeń:
      ├─ strumień Mastry  → wyłącznie delty tekstu      (getTextDelta czyta tylko stream_event)
      └─ hooki SDK        → SessionStart / PreToolUse / PostToolUse / PostToolUseFailure / Stop
      ↓ scalane w jedną kolejkę z numeracją sekwencyjną  agent/events.ts (RunEventStream)
[6] Narzędzie MCP → ModuleToolDefinition.handler → SERWIS DOMENOWY → SQLite (transakcja)
      ↓                                      module-procurement/src/server/services.ts
[7] ctx.emit() → zdarzenie CUSTOM na tym samym strumieniu
      ↓ streamSSE (hono/streaming), format: `data: <json AG-UI>`
[8] platformAguiAdapter → opakowuje agUIAdapter() z @openuidev/react-headless
      ├─ przekazuje każde zdarzenie do processStreamedMessage (tekst, narzędzia, RUN_ERROR)
      └─ przechwytuje CUSTOM → invalidateQueries TanStack Query
[9] Ponowne pobranie danych przez komponent karty → widoczny wynik na canvasie
```

**Rzeczywista kolejność różni się od naiwnej w dwóch miejscach:**

1. Zdarzenia narzędzi **nie** płyną przez Mastrę. `@mastra/claude` 0.3.1 kieruje je wyłącznie do
   telemetrii, więc tor narzędziowy i tor tekstowy są rozdzielone aż do `RunEventStream`.
   Kolejność zdarzeń w strumieniu jest „kolejnością zaobserwowaną", nie gwarantowaną przez adapter.
2. Zapis wiadomości użytkownika następuje **przed** wejściem do kolejki (krok 3), a `agent_runs.started_at`
   jest znacznikiem **zakolejkowania**, nie startu wykonania. Ma to konsekwencję diagnostyczną
   opisaną w §5.6.

### 2.2 Połączenia — moduł, właściciel stanu, format, błędy, test

| Połączenie | Plik | Właściciel stanu | Format | Błędy | Test integracyjny |
|---|---|---|---|---|---|
| Kompozytor → HTTP | `platform-ui/src/chat/chatWiring.ts` | store klienta (zustand) | `RunAgentInput` (AG-UI) | `getResponseErrorMessage` biblioteki | `e2e/agent-ui.spec.ts` |
| HTTP → runtime | `platform-server/src/http/app.ts:215` | backend | Zod `runAgentInputSchema` | `AppError` → status HTTP | `tests/contracts.test.ts` |
| Runtime → Mastra | `agent/runtime.ts:335` | Mastra | `MessageListInput` + `sdkOptions` | wyjątek → `classifyModelError` | sondy audytu |
| Mastra → SDK | `@mastra/claude` (biblioteka) | Claude SDK | `Options` SDK | chunk `type:'error'` | `pnpm diag` |
| SDK → MCP | `agent/mcp.ts` | backend | JSON Schema z Zod | `isError` w `CallToolResult` | `tests/mcp-schema.test.ts` |
| MCP → domena | `module-procurement/src/server/tools.ts` | serwisy domenowe | Zod `inputs.ts` | `AppError` z kodem | `tests/contracts.test.ts` |
| Domena → SQLite | `server/repository.ts` | baza | SQL + transakcje | compare-and-set → `conflict` | `04-probes-api.txt` |
| Runtime → klient | `agent/events.ts` + `streamSSE` | `run_events` | SSE `data: <json AG-UI>` | `RUN_ERROR` | `raw-probe-stop.log` |
| Klient → UI | `chat/platformAdapter.ts` | TanStack Query | zdarzenia AG-UI | `RUN_ERROR` → wyjątek w store | `e2e/agent-ui.spec.ts` |

### 2.3 Standard, własne rozszerzenie, obejście, pominięcie

**Użyte wprost z bibliotek:** pętla agentowa, sandbox, uprawnienia i sesje (Claude Agent SDK);
rejestracja agenta (Mastra); pan/zoom/drag/resize/minimapa (React Flow); lista rozmów, kompozytor,
strumieniowanie, przestrzeń artefaktów (`AgentInterface`); parser i renderer OpenUI Lang;
cache i unieważnianie (TanStack Query).

**Konfiguracja, nie kod:** endpointy rozmów napisane pod konwencje `restStorage()`
(`/get`, `/create`, `/get/:id`, `/update/:id`, `/delete/:id`).

**Własne adaptery (5):**

| Adapter | Czego brakowało | Plik |
|---|---|---|
| Most hooków SDK | `@mastra/claude` nie przekazuje narzędzi ani `session_id` | `agent/runtime.ts` |
| Serwer MCP per uruchomienie | brak izolacji kontekstu narzędzi między przebiegami | `agent/mcp.ts` |
| `assertMcpCompatibleShape` | SDK cicho usuwa serwer MCP przy `z.record()`; `z.default()` czyni pole wymaganym | `agent/mcp.ts` |
| `platformAguiAdapter` | gotowy czat ignoruje `CUSTOM` | `platform-ui/src/chat/platformAdapter.ts` |
| Kanał artefaktów | `restStorage` implementuje tylko kanał `thread` | `platform-ui/src/chat/chatWiring.ts` |

**Pominięcie wybranej technologii — istotne ustalenie audytu:**

> W całym kodzie źródłowym **nie ma ani jednego importu z `@ag-ui/*`** (sprawdzone: 0 wystąpień
> w `packages/`, `apps/`, `e2e/`, `tests/`). `@ag-ui/core` 0.0.53 jest obecny **wyłącznie
> tranzytywnie**, jako zależność `@openuidev/react-headless`. AG-UI uczestniczy w działaniu jako
> **protokół drutowy**: backend emituje obiekty o nazwach zdarzeń AG-UI, a parsuje je
> `agUIAdapter()` z OpenUI. Integracja `@ag-ui/mastra`, wskazana jako źródło w warstwie 5
> dokumentu architektury, **nie została użyta**.

To jest wybór działający, ale różny od deklaracji dokumentu i wart świadomej decyzji (§6.3).

### 2.4 Kto co przechowuje i jak wiążą się identyfikatory

| Rodzaj | Właściciel | Tabela / miejsce | Powiązanie |
|---|---|---|---|
| Rozmowy | platforma | `conversations` | `id`, `owner_id`, `space_id`, `claude_session_id` |
| Wiadomości | platforma | `messages` | `(conversation_id, id)` — unikalne, stąd idempotencja |
| Sesje Claude | Claude SDK; mapowanie w platformie | `conversations.claude_session_id`, `agent_runs.claude_session_id` | wiązane z hooka SDK lub z góry przy wznowieniu |
| Wykonania | platforma | `agent_runs` | `id` ↔ nagłówek `X-Run-Id` |
| Zdarzenia wykonania | platforma | `run_events` | `(run_id, seq)` — unikalne, umożliwia odtworzenie |
| Dane domenowe | serwisy modułu | `pc_cases`, `pc_suppliers`, `pc_requirements`, `pc_offers`, `pc_offer_items`, `pc_attachments`, `pc_provenance`, `pc_criteria` | klucze obce w obrębie modułu |
| Układ canvasu | platforma | `canvas_spaces`, `canvas_cards` | `scope_kind`/`scope_id` — **nieprzezroczyste** dla platformy |
| Specyfikacja OpenUI | platforma | `canvas_cards.spec` (JSON) | `spec_version` odrębne od `geometry_version` |
| Pliki | platforma | `files` + `data/files/` | `sha256`, `scope_kind`/`scope_id` |
| Artefakty | platforma | `artifacts`, `artifact_versions` | `(artifact_id, version)`; `file_id` → `files` |

Jedyne odwołanie modułu do platformy to `pc_attachments.file_id` — **celowo bez klucza obcego**,
bo cykl życia pliku należy do platformy.

### 2.5 Jak agent dostaje kontekst i przechodzi po relacjach

Kontekst ekranu podróżuje w ciele `RunAgentInput` (`appContextSchema`: rozmowa, przestrzeń, zasób,
zaznaczenie, filtry, viewport, szkice) i jest czytany **w momencie wysłania**, nie przy montowaniu
czatu. Schemat **nie ma pola właściciela** — własność pochodzi wyłącznie z ciasteczka, co
potwierdza 403 przy próbie podszycia się (`04-probes-api.txt`).

Do promptu systemowego trafia jedno zdanie opisu zasobu (`describeResource`), nigdy dane tabelaryczne.
Dalsze dane agent pobiera narzędziami: `get_context` (potwierdzone wywołanie w audycie),
`procurement_list_offers` i `procurement_search` z limitami, `procurement_compare_offers`
zwracające **policzony wynik**, nie surowe wiersze. Przejście po relacjach realizuje
`procurement_find_price_provenance`: pozycja → oferta → dostawca → załącznik → wiersz w pliku.

### 2.6 Mutacja ręczna i przez MCP

Obie prowadzą do **tej samej metody serwisu** i tych samych schematów wejścia
(`module-procurement/src/server/inputs.ts`). Test `tests/contracts.test.ts` („narzedzie MCP
i endpoint HTTP prowadza do tej samej reguly") sprawdza to wprost — to on wykrył pierwotną
niespójność kodów błędu. Sandbox dodatkowo odcina proces agenta od katalogu danych, więc ominięcie
serwisu przez bezpośredni zapis do bazy jest zablokowane na poziomie systemu plików (L11.5).

Po mutacji: narzędzie emituje `CUSTOM platform.data_changed`, adapter unieważnia zapytania
TanStack Query, karty pobierają dane ponownie. Kontekst agenta odświeża się przy kolejnym poleceniu,
bo jest czytany w momencie wysłania.

### 2.7 Czy platforma działa z innym modułem domenowym

**Tak, bez zmian w kodzie platformy** — dowód dwustopniowy:

1. `packages/module-devkit-probe` — minimalny moduł z własną tabelą, narzędziem, trasą i komponentem
   karty. `tests/platform-boundary.test.ts` uruchamia platformę z `modules: []` (pusty stan zamiast
   błędu, brak tabel `pc_*`) i z modułem `probe` (migracja, narzędzia `probe_*`, trasa
   `/api/m/probe/notes`, komponent w katalogu).
2. `pnpm check:boundaries` sprawdza trzy rzeczy niezależnie: brak `@module/*` w manifestach
   platformy, brak importów, oraz **brak słownika domenowego** w kodzie platformy (12 pojęć).
   Kontrola jest realna — w poprzedniej iteracji odrzuciła build z powodu podpowiedzi czatu
   zawierających słowo „oferty".

**Zależności od porównywania ofert w warstwie platformy: nie znaleziono.** Zastrzeżenie: obie
kontrole sprawdzają kierunek zależności i słownik, nie kompletność kontraktu — czy kontrakt
wystarcza dla *innej* domeny, wiadomo dopiero z drugiej realnej aplikacji (§6.3).

---

## 3. Pełna macierz odbioru

Wymagania czytane wprost z `stack-agentowy-ustalenia-i-materialy.md` przez
`node scripts/audit-matrix.mjs` — nie są przepisywane, więc żadne nie może zostać pominięte ani
złagodzone. Sumy, pokrycie i kontrola duplikatów wyliczane automatycznie.

**Liczba kryteriów: 95.** Zgadza się z poprzednią macierzą; dokument architektury nie zmienił się
od 2026-09-14 (znacznik czasu 10:58, 24 674 B). Do tej liczby **nie** wliczono wymagania z sekcji
„Odbiór całego systemu", że zamknięcie wszystkich warstw wymaga dodatkowo potwierdzenia przepływów
między nimi — traktuję je jako osobną bramkę, opisaną w §5.10.

<!-- WYGENEROWANE: node scripts/audit-matrix.mjs -->

### Podsumowanie macierzy

Liczby wyliczone ze skryptu `scripts/audit-matrix.mjs`; wymagania czytane wprost z `stack-agentowy-ustalenia-i-materialy.md`.

**Kryteriów: 95** (7+6+7+8+8+7+7+8+9+10+10+8). Zgadza się z liczbą z poprzedniej macierzy — dokument nie zmienił się od 2026-09-14.

| Stan | Liczba |
|---|---|
| potwierdzone | 84 |
| częściowe | 10 |
| niespełnione | 1 |
| niesprawdzone | 0 |
| **Razem** | **95** |

| Rodzaj dowodu | Liczba |
|---|---|
| rzeczywisty przebieg | 51 |
| test automatyczny bez modelu | 28 |
| analiza kodu | 14 |
| symulacja | 2 |

**Warstwy zamknięte — 6 z 12:** L1, L3, L6, L7, L9, L11

**Warstwy otwarte — 6 z 12**, z identyfikatorami blokujących kryteriów:

| Warstwa | Kryteria blokujące |
|---|---|
| L2 — Komponenty i nawigacja frontendowa | L2.2 (częściowe), L2.6 (częściowe) |
| L4 — Czat i zarządzanie rozmowami | L4.4 (częściowe) |
| L5 — Komunikacja i zdarzenia | L5.2 (częściowe), L5.3 (częściowe), L5.4 (częściowe) |
| L8 — Harness i uwierzytelnienie Claude | L8.6 (niespełnione) |
| L10 — Trwałość, cache i artefakty | L10.7 (częściowe), L10.10 (częściowe) |
| L12 — Obserwowalność i odbiór integracji | L12.3 (częściowe), L12.5 (częściowe) |

**Kontrola spójności:** brak brakujących i zduplikowanych identyfikatorów; każde kryterium dokumentu ma dokładnie jedną ocenę.

---

### Warstwa 1 — Runtime i środowisko full stack

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L1.1** | Frontend i backend uruchamiają się z udokumentowanej konfiguracji na docelowym systemie. | **potwierdzone** | rzeczywisty przebieg | apps/server/src/main.ts | docs/evidence/audit-2026-09-15/01-checks.txt; instancja audytowa na :8795 | Backend produkcyjny wstal z dist, /api/health 200, /api/status raportuje subskrypcje | — |
| **L1.2** | React i TypeScript są najnowszymi stabilnymi wersjami; lockfile i zgodność zależności są sprawdzone. | **potwierdzone** | test automatyczny bez modelu | package.json, pnpm-lock.yaml | 02-versions.txt; pnpm install --frozen-lockfile; pnpm typecheck | React 19.3.0 i TS 7.0.2 = najnowsze stabilne; instalacja z zamrozonego lockfile bez ostrzezen peer; typecheck 0 bledow | Reklasyfikacja wobec poprzedniego raportu: ograniczenie „dev/CLI wymagaja --experimental-transform-types” nie nalezy do tego kryterium (dotyczy uruchamiania, nie wersji ani zgodnosci). Przeniesione do ryzyk operacyjnych przy L1.1 |
| **L1.3** | Build produkcyjny oraz sprawdzanie typów kończą się bez błędów; działanie nie zależy od serwera developerskiego Vite. | **potwierdzone** | rzeczywisty przebieg | apps/server/build.mjs, apps/web/vite.config.ts | 01-checks.txt (pnpm build), audit-server.sh | vite build + esbuild 166,8 kB; `node dist/server.js` bez zadnej flagi; testy przegladarkowe biegna na tym buildzie | — |
| **L1.4** | Backend obsługuje zwykłe żądania i strumienie bez buforowania odpowiedzi do końca generacji. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/http/app.ts (streamSSE) | run 8f8325: 20 zdarzen TEXT_MESSAGE_CONTENT | Tekst plynie przyrostowo przed zakonczeniem generacji | — |
| **L1.5** | Konfiguracja prywatna nie trafia do pakietu frontendu ani odpowiedzi HTTP. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/agent/auth.ts | tests/runtime.test.ts; 03-probes-auth.txt | Rzeczywista wartosc tokena nie wystepuje w probeAuth() ani /api/status; sonda z tokenem fabrykowanym potwierdza | — |
| **L1.6** | Restart zachowuje trwałe dane; zatrzymanie aplikacji nie pozostawia niezarządzanych procesów roboczych. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/runs.ts (reconcileOnBoot, abortAll) | 04-probes-api.txt; restart instancji audytowej | Po restarcie 5/5 plikow, sha pliku identyczne; przebieg przerwany SIGTERM oznaczony jako failed (server_sigterm), nie „running” | — |
| **L1.7** | Dostęp lokalny ma jawne zasady origin i autoryzacji; token subskrypcji nie pełni roli tokena dostępu do aplikacji. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/http/app.ts, auth/session.ts | tests/contracts.test.ts; 04-probes-api.txt | Allowlista origin (403), 401 bez sesji, wlasne ciasteczko HMAC; token subskrypcji nigdy nie jest tokenem dostepu | — |

### Warstwa 2 — Komponenty i nawigacja frontendowa

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L2.1** | Komponenty domenowe mają typowane właściwości i są zarejestrowane w katalogu OpenUI. | **potwierdzone** | analiza kodu | packages/*/src/**/cardComponents, registry/catalog.ts | /api/status → components (10) | 10 komponentow kart ze schematami Zod po stronie serwera i rendererami po stronie klienta | — |
| **L2.2** | Domyślna kompozycja obejmuje lewą nawigację i prawy czat, z adaptacją do mniejszych ekranów. | **częściowe** | rzeczywisty przebieg | packages/platform-ui/src/{shell/AppShell.tsx,styles.css,chat/ChatPanel.tsx} | 12/14-chat-*.png; 16-probe-chat-layout.txt; 17-playwright.txt | Lewa nawigacja + canvas + czat wspolistnieja; adaptacja do 820 px dziala. ALE przy otwartej szufladzie rozmow watek nie jest widoczny, a audyt nie znalazl kontrolki ja zamykajacej | Defekt D-1 (sekcja 5): brak widocznej kontrolki zamkniecia szuflady; watek zaslonięty |
| **L2.3** | Nawigacja, odświeżenie oraz Wstecz/Dalej przywracają właściwą rozmowę lub przestrzeń pracy. | **potwierdzone** | test automatyczny bez modelu | apps/web/src/router.tsx | 17-playwright.txt („nawigacja Wstecz/Dalej…”) | Wstecz/Dalej i przeladowanie przywracaja wlasciwy widok | — |
| **L2.4** | Dynamiczne wnętrze UI nie wymaga generowania nowych plików tras ani wykonywalnego kodu aplikacji. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/registry/catalog.ts | raw-probe-canvas.log | Agent dodal/zmienil/przesunal/usunal karty bez zadnej zmiany w kodzie i bez nowych plikow tras | — |
| **L2.5** | Formularze i podstawowe interakcje działają z klawiatury, mają etykiety i widoczny fokus. | **potwierdzone** | test automatyczny bez modelu | packages/platform-ui/src/styles.css, module-procurement/src/ui/cards.tsx | 17-playwright.txt („…z klawiatury i ma widoczny fokus”) | Nawigacja klawiatura, etykiety pol, globalne :focus-visible | — |
| **L2.6** | Ładowanie, brak danych, błąd i brak dostępu mają rozróżnialne stany prezentacji. | **częściowe** | test automatyczny bez modelu | packages/module-procurement/src/ui/cards.tsx (Loading/Failure) | 17-playwright.txt („odrzucony typ pliku daje czytelny blad”) | Ladowanie, brak danych i blad maja rozroznialne stany; komponent Failure mapuje forbidden/not_found | Stan „brak dostepu” nie zostal wywolany w przegladarce — tylko w API (403) |

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
| **L4.4** | Historia i tytuły wracają po odświeżeniu oraz restarcie backendu. | **częściowe** | rzeczywisty przebieg | packages/platform-server/src/http/app.ts (/api/threads/get/:id) | odpowiedz API: klucze [content,id,role] | Historia tekstowa i tytuly wracaja po odswiezeniu i restarcie | Defekt D-2: wiadomosci nie niosa toolCalls — aktywnosc narzedzi nie przezywa przeladowania; w calym repo brak slowa „toolCalls” |
| **L4.5** | Przełączenie rozmowy nie miesza wiadomości, kontekstu ani wyników trwających wykonań. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts (kolejka per rozmowa) | raw-probe-conc2.log | Dwa rownolegle polecenia w jednej rozmowie: odpowiedzi „ALFA” i „BETA” nie zmieszane, oba przebiegi rozstrzygniete | — |
| **L4.6** | Powtórzenie żądania lub reconnect nie tworzy podwójnych wiadomości. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/conversations.ts | raw-probe-conc2.log; tests/contracts.test.ts | Przy dwoch rownoleglych poleceniach dokladnie 3 wiadomosci uzytkownika (1 zalozycielska + 2), brak duplikatow | — |
| **L4.7** | Usunięcie ma określony skutek dla sesji, aktywnego zadania i artefaktów; aplikacja nie pozostawia niespójnych powiązań. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/services/conversations.ts (delete) | 17-playwright.txt („usuniecie rozmowy odlacza artefakty”) | Kaskada na wiadomosci i uruchomienia, artefakty odlaczane (ON DELETE SET NULL) | — |
| **L4.8** | Zakres gotowej obsługi edycji wiadomości, rozgałęziania i przywracania usuniętych rozmów jest opisany jako dostępny lub niedostępny; UI nie sugeruje niezaimplementowanych funkcji. | **potwierdzone** | analiza kodu | packages/platform-contracts/src/conversation.ts (CHAT_CAPABILITIES) | /api/status; ekran Ustawienia | Edycja wiadomosci, rozgalezianie i przywracanie jawnie oznaczone jako niedostepne | — |

### Warstwa 5 — Komunikacja i zdarzenia

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L5.1** | Tekst jest widoczny przyrostowo przed zakończeniem generacji. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts (includePartialMessages) | run 8f8325: 20 x TEXT_MESSAGE_CONTENT | Tekst przyrostowy potwierdzony w przebiegu z dnia audytu | — |
| **L5.2** | UI rozpoznaje rozpoczęcie i zakończenie wykonania, błąd oraz anulowanie. | **częściowe** | rzeczywisty przebieg | packages/platform-server/src/agent/events.ts | raw-probe-stop.log; 13-probe-chat-tools.txt | Anulowanie: status „cancelled”, ostatnie zdarzenia TEXT_MESSAGE_END → CUSTOM → RUN_ERROR; po zakonczeniu brak wskaznika trwajacego wykonania | Gotowy czat nie zna RUN_STARTED/RUN_FINISHED — nie ma ich w EventType biblioteki (13 z 32 zdarzen protokolu). Rozpoczecie/zakonczenie nie sa sygnalizowane przez komponent, tylko przez zamkniecie strumienia |
| **L5.3** | Wywołania narzędzi i ich wyniki są powiązane i dostępne dla prezentacji w czacie. | **częściowe** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts (most hookow) | 13-probe-chat-tools.txt; 12-chat-z-narzedziami.png | Wywolania i wyniki sa poprawnie sparowane w strumieniu i w run_events (TOOL_CALL_START/ARGS/END/RESULT) | Defekt D-2 + obserwacja nierozstrzygnieta: w zadnej z 3 obserwacji nie znaleziono elementu narzedzia w DOM czatu mimo wywolan w strumieniu. Nie ustalono, czy to zaslonięcie przez szuflade (D-1), czy brak renderowania |
| **L5.4** | Dane artefaktów i zmian UI docierają do właściwych rendererów. | **częściowe** | rzeczywisty przebieg | packages/platform-ui/src/chat/platformAdapter.ts | 08-probes-browser.txt; 07-artefakty.png | Artefakt utworzony przez agenta pojawia sie na ekranie Pliki i raporty; nawigacja artefaktow obecna w czacie | Renderowanie artefaktu wewnatrz czatu nie zostalo zaobserwowane |
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
| **L8.6** | Wygaśnięcie uwierzytelnienia i wyczerpanie limitu dają czytelny błąd oraz zachowują stan pracy. | **niespełnione** | symulacja | packages/platform-server/src/agent/auth.ts:probeAuth | 03-probes-auth.txt (AUTH-wygasly) | Poswiadczenie z expiresAt w przeszlosci jest raportowane jako mode=subscription | Defekt D-3: probeAuth nigdy nie porownuje expiresAt z czasem biezacym. Wyczerpanie limitu w ogole niewywolane |
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
| **L9.8** | Operacja wieloetapowego zapisu jest atomowa albo ma jawny mechanizm odzyskania spójności. | **potwierdzone** | test automatyczny bez modelu | packages/module-procurement/src/server/services.ts | tests/runtime.test.ts (kopia i odtworzenie) | Transakcje SQLite; stan spojny po checkpoint WAL i kopii katalogu | — |
| **L9.9** | Testy potwierdzają rzeczywistą zmianę danych oraz odrzucenie nieuprawnionej operacji. | **potwierdzone** | test automatyczny bez modelu | tests/contracts.test.ts | pnpm test 69/69 | Testy potwierdzaja zmiane danych i odrzucenie operacji nieuprawnionej | — |

### Warstwa 10 — Trwałość, cache i artefakty

| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |
|---|---|---|---|---|---|---|---|
| **L10.1** | Własność każdego rodzaju danych odpowiada tabeli modelu własności; nie istnieją niezależnie mutowane kopie domeny. | **potwierdzone** | analiza kodu | FEEDBACK sekcja 4 (tabela wlasnosci) | scripts/check-boundaries.mjs | Kazdy rodzaj danych ma jednego wlasciciela; platforma nie pisze do tabel pc_* | — |
| **L10.2** | Migracje tworzą i aktualizują bazę bez utraty obsługiwanych danych; sprawdzona jest kopia i odtworzenie trwałego stanu lokalnego. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/db/migrations.ts | tests/runtime.test.ts; restart instancji audytowej | Migracje w transakcjach z rejestrem; kopia katalogu otwiera sie z kompletnym stanem; po restarcie sha pliku identyczne | — |
| **L10.3** | Rozmowa aplikacji jest jednoznacznie powiązana z sesją Claude i jej właścicielem. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/conversations.ts | tabela conversations instancji audytowej | claude_session_id + owner_id przypisane do rozmowy | — |
| **L10.4** | Restart przywraca historię, kompozycję, powiązania sesji i artefakty. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/index.ts | restart instancji audytowej | Historia, kompozycja, powiazania sesji i artefakty wracaja po restarcie | — |
| **L10.5** | Mutacja przez UI lub MCP odświeża właściwe dane na froncie bez pełnego przeładowania. | **potwierdzone** | rzeczywisty przebieg | packages/platform-ui/src/chat/platformAdapter.ts | FEEDBACK #21 (hist.); 08-probes-browser.txt | platform.data_changed / canvas_changed uniewazniaja wlasciwe zapytania; karta agenta pojawia sie bez przeladowania | — |
| **L10.6** | Komponenty współdzielą pobrania dla tego samego zasobu; klucze cache uwzględniają kontekst dostępu i filtry. | **potwierdzone** | analiza kodu | packages/platform-ui/src/api/queries.ts | klucze qk.* | Komponenty tej samej sprawy dziela jedno pobranie przez wspolny klucz | — |
| **L10.7** | Zmiana kontekstu właściciela nie ujawnia danych z poprzedniego cache. | **częściowe** | analiza kodu | packages/platform-ui/src/api/queries.ts (qk, resetOwnerScope) | analiza kodu | Ochrona polega wylacznie na qc.clear() przy nawiazaniu sesji; backend i tak odmawia (403) | Klucze cache NIE zawieraja wlasciciela; aplikacja nie ma UI zmiany uzytkownika, wiec przejscia nie da sie wywolac — brak dowodu i brak sciezki do jego zdobycia bez zmiany produktu |
| **L10.8** | Artefakt ma stabilny identyfikator, wersję, właściciela i trwałą treść; tytuł nie jest jego kluczem. | **potwierdzone** | test automatyczny bez modelu | packages/platform-server/src/services/artifacts.ts | tests/contracts.test.ts | Klucz (artifact_id, version); tytul to zwykla kolumna | — |
| **L10.9** | Podgląd i pełny widok wskazują tę samą wersję; pliki można pobrać po restarcie. | **potwierdzone** | rzeczywisty przebieg | packages/platform-server/src/services/files.ts | restart instancji audytowej (sha 459cb0b8… przed i po) | Podglad i pelny widok czytaja current_version; plik pobieralny po restarcie | — |
| **L10.10** | Raport historyczny zachowuje treść, a artefakt oznaczony jako żywy pobiera aktualne dane. | **częściowe** | analiza kodu | packages/platform-server/src/services/artifacts.ts | grep: brak sciezki odczytu dla mode='live' | Polowa „snapshot” dziala i jest pokryta testem | Defekt D-4: tryb „live” jest zapisywany i wyswietlany, ale NIGDZIE nieobslugiwany przy odczycie. Opis narzedzia artifact_create obiecuje modelowi, ze live „odswieza sie przy otwarciu” — obietnica niepokryta kodem |

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
| **L12.3** | Zmierzone są czas pierwszej odpowiedzi, wykonania, odświeżenia po mutacji i anulowania, z podaniem warunków pomiaru. | **częściowe** | rzeczywisty przebieg | packages/platform-server/src/agent/runtime.ts:345 | baza audytu: first_token_ms NULL w 2 przebiegach | Zmierzone: wykonanie (5367–40691 ms, mediana 19206) i anulowanie (potwierdzenie 3 ms, zamkniecie 2010 ms) | Defekt D-5: first_token_ms gubiony, gdy narzedzie poprzedza tekst — openText() wolane z mostu hookow ustawia textOpened, wiec galaz metryki nigdy sie nie wykonuje. Korelacja doskonala: NULL dokladnie w przebiegach „narzedzie pierwsze”. Odswiezenie po mutacji nadal niemierzone |
| **L12.4** | Testy kontraktów obejmują walidację, konflikty, powtórzenia i kontrolę dostępu. | **potwierdzone** | test automatyczny bez modelu | tests/contracts.test.ts | pnpm test 69/69 | Walidacja, konflikty, powtorzenia i kontrola dostepu pokryte | — |
| **L12.5** | Testy przeglądarkowe obejmują dynamiczny UI, rozmowy, narzędzia, artefakty i wznowienie. | **częściowe** | test automatyczny bez modelu | e2e/*.spec.ts | 17-playwright.txt: 21 passed / 1 FAILED | Suita pokrywa powloke, canvas, kompozycje, trwalosc, rozmowy i pliki | Defekt D-6: asercja „streaming dociera na ekran” (agent-ui.spec.ts:78) dopasowuje sie do etykiety podpowiedzi „Wykres kosztow” — jest pusta. Dodatkowo suita NIE jest zielona: agent-ui.spec.ts:119 przewraca sie na firstTokenMs=null (D-5) |
| **L12.6** | Rzeczywista ścieżka subskrypcja Claude → SDK → Mastra → AG-UI → OpenUI została potwierdzona; mocki są oznaczone osobno. | **potwierdzone** | rzeczywisty przebieg | — | wszystkie przebiegi audytu | Sciezka subskrypcja → SDK → Mastra → AG-UI → OpenUI potwierdzona; w repo nie ma ani jednego mocka Claude | AG-UI uzyte jako protokol drutowy: zero importow @ag-ui/*; @ag-ui/core 0.0.53 obecny wylacznie tranzytywnie. Integracja @ag-ui/mastra wskazana w dokumencie nie zostala uzyta |
| **L12.7** | Opis odbioru wskazuje wersje, dowody, nieudane próby, brakujące możliwości i własne adaptery. | **potwierdzone** | analiza kodu | RAPORT-STANU-PLATFORMY.md | ten dokument | Opis odbioru z wersjami, dowodami, nieudanymi probami i wlasnymi adapterami | — |
| **L12.8** | System działa bez Langfuse; możliwość eksportu i ewentualne ograniczenia kompatybilności są udokumentowane. | **potwierdzone** | analiza kodu | — | 02-versions.txt; podscieżki @mastra/core | System dziala bez Langfuse; @mastra/core wystawia ./observability, ./telemetry i ./telemetry/otel-vendor, wiec mozliwosc integracji jest zachowana | Eksporter niepodlaczony i niezweryfikowany — wg zadania nie blokuje odbioru |

---

## 4. Sprawdzenie wcześniej zgłoszonych poprawek

Każdą pozycję sprawdzono ponownie w kodzie i wykonaniu; nie przyjęto deklaracji z `FEEDBACK.md`.

### 4.1 Automatyczne liczenie macierzy — **działa i jest włączone**

`scripts/matrix-summary.mjs` istnieje i jest wpięte w `pnpm verify` przez `pnpm check:matrix`.
Uruchomione dziś: `Podsumowanie macierzy zgodne z tabelami`, exit 0
([`01-checks.txt`](docs/evidence/audit-2026-09-15/01-checks.txt)).

Niezależnie policzyłem kryteria wprost z dokumentu architektury i skonfrontowałem identyfikatory
z macierzą w `FEEDBACK.md`: **95 kryteriów, 95 wierszy, zero duplikatów, zero braków pokrycia.**
Skrypt wykrywa też duplikaty — sprawdzone.

**Zastrzeżenie:** skrypt weryfikuje *zgodność sum z tabelami*, nie *poprawność statusów*. Tego
drugiego nie da się zautomatyzować i to właśnie było przedmiotem tego audytu (§4.6).

### 4.2 Podsumowanie gotowości a statusy warstw — **zgodne**

`FEEDBACK.md` podaje „3 z 12" i wymienia dziewięć warstw otwartych z identyfikatorami; skrypt zwraca
to samo. Sekcja „Co blokuje odbiór" rozdziela „nic nie blokuje używania" od „odbioru jako
sprawdzonego szablonu nie można ogłosić". **Nie znalazłem rozbieżności.**

### 4.3 Test przez przeglądarkę — **częściowo, z istotną wadą**

`e2e/agent-ui.spec.ts` rzeczywiście: wpisuje polecenie w kompozytorze (`composer.fill`), klika
`Send message`, czeka na kartę, wiąże ją z konkretnym wykonaniem (`runs[0]`, `run_events`,
`TOOL_CALL_START` z prefiksem `mcp__app__`), sprawdza trwałość po przeładowaniu i — co ważne —
usuwa istniejące karty wykresu w przygotowaniu, więc **zastana karta nie zalicza testu**
(`clearChartCards`, wymaganie identyfikatora nieobecnego wcześniej).

**Ale asercja „streaming dociera na ekran" jest pusta** (defekt D-6):

```ts
// e2e/agent-ui.spec.ts:78
await expect(page.locator('.pf-chat').getByText(/wykres|koszt/i).first()).toBeVisible(...)
```

Podpowiedź startowa w czacie ma etykietę **„Wykres kosztow"** (`module-procurement/src/ui/index.tsx:27`),
więc wyrażenie `/wykres|koszt/i` jest spełnione **zawsze**, także bez jakiejkolwiek odpowiedzi modelu.
Test nigdy nie dowiódł, że odpowiedź dotarła na ekran.

**Dodatkowo suita nie jest zielona.** Uruchomienie z dnia audytu:
**21 passed, 1 failed** ([`17-playwright.txt`](docs/evidence/audit-2026-09-15/17-playwright.txt)).
Przewraca się `agent-ui.spec.ts:119` — `expect(runs[0].firstTokenMs).toBeGreaterThan(0)` otrzymuje
`null`. To nie jest wada testu, tylko defekt D-5: metryka ginie, gdy model wywoła narzędzie przed
tekstem. Test przechodził 2026-09-14, bo wtedy model odezwał się przed narzędziem — czyli błąd jest
utajony i zależny od kolejności działań modelu.

### 4.4 Przełączanie i usuwanie rozmowy przez UI — **działa, przez rzeczywiste kontrolki**

`e2e/chat.spec.ts` wykonuje: kliknięcie w wiersz rozmowy (`click({ force: true })`) oraz usunięcie
przez `[aria-label="Thread actions"]` → `getByRole('menuitem', { name: /delete|usu/i })`.
API służy wyłącznie **przygotowaniu danych** (`seedThread`) i **kontroli wyniku**
(`GET /api/threads/get` po usunięciu) — czyli dokładnie tak, jak dopuszcza zadanie.
Potwierdzone sprawdzeniem menu w tym audycie: kliknięcie `Thread actions` otwiera pozycję `Delete`
([`16-probe-chat-layout.txt`](docs/evidence/audit-2026-09-15/16-probe-chat-layout.txt)).

**Zastrzeżenie:** kliknięcie wiersza używa `force: true`, co pomija kontrolę „element stabilny".
Uzasadnienie w kodzie (lista przerysowuje się w trakcie ładowania) jest wiarygodne, ale `force`
maskowałby też defekt zasłonięcia — a D-1 pokazuje, że w tym panelu takie defekty występują.

### 4.5 Opis poświadczeń a mechanizm — **zgodny, z jednym doprecyzowaniem**

Rozróżnienie wymagane przez zadanie:

| | Stan |
|---|---|
| **Odczyt pliku w procesie** | **TAK.** `readCredentialMetadata()` wykonuje `readFileSync` + `JSON.parse` całego `.credentials.json`; tokeny przechodzą przez pamięć procesu na czas parsowania |
| **Przechowywanie** | **NIE.** Kopiowane są wyłącznie `subscriptionType` i `expiresAt`; sparsowany obiekt jest porzucany przy powrocie |
| **Logowanie** | **Nie znaleziono.** Brak `console.*` z poświadczeniami w `auth.ts`; w logu serwera audytowego brak wartości tokena |
| **Udostępnienie przez endpoint** | **NIE.** `/api/status` zwraca tryb, plan, datę wygaśnięcia i flagę wykrycia klucza |

Aktualny opis w `FEEDBACK.md` §2 jest **poprawny** — mówi wprost „aplikacja **czyta** ten plik"
i nie twierdzi, że go nie czyta. Poprawka z poprzedniej iteracji została faktycznie wprowadzona.

**Doprecyzowanie zakresu dowodu.** Istniejące testy sprawdzają brak tokena w **dwóch** wyjściach
(`probeAuth`, `/api/status`). Zadanie słusznie zauważa, że to nie dowodzi braku ujawnienia w całym
systemie. **Niesprawdzone powierzchnie:** logi serwera, treść artefaktów, pliki w magazynie,
`run_events`, odpowiedzi tras modułowych, zrzuty diagnostyczne. Ujęte w §6.2 jako brak testu.

W tym raporcie ani w dowodach **nie ma żadnej wartości sekretnej**; sondy uwierzytelnienia używają
wyłącznie fabrykowanych łańcuchów (`FAKE-NOT-A-REAL-TOKEN`).

### 4.6 Zestawienie zmian statusów wobec poprzedniej macierzy

| ID | Było | Jest | Powód |
|---|---|---|---|
| L1.2 | częściowe | **potwierdzone** | reklasyfikacja: ograniczenie flagi eksperymentalnej nie należy do kryterium o wersjach i lockfile; przeniesione do ryzyk operacyjnych. Wersje i `--frozen-lockfile` sprawdzone dziś |
| L3.2 | częściowe | **potwierdzone** | model wykonał update, move i remove (`raw-probe-canvas.log`) |
| L6.3 | analiza kodu | **potwierdzone** | model wywołał `get_context` |
| L6.5 | częściowe | **potwierdzone** | model podał wartość zapisaną i odnotował szkic |
| L7.4 | częściowe | **potwierdzone** | okna wykonania rozłączne; poprzedni brak wynikał z braku próby |
| L11.7 | częściowe | **potwierdzone** | zmierzone zatrzymanie procesu potomnego, zero osieroconych |
| **L2.2** | potwierdzone | **częściowe** | D-1: wątek niewidoczny przy otwartej szufladzie |
| **L4.4** | częściowe | częściowe *(inny powód)* | D-2: brak `toolCalls` w kontrakcie wiadomości |
| **L5.3** | potwierdzone | **częściowe** | D-2 + nieznalezienie elementu narzędzia w DOM |
| **L8.6** | analiza kodu | **niespełnione** | D-3: wygasłe poświadczenie raportowane jako zdrowe |
| **L10.10** | potwierdzone | **częściowe** | D-4: tryb `live` nieobsługiwany |
| **L12.5** | częściowe | częściowe *(gorzej)* | D-6 (pusta asercja) + suita nie jest zielona |
| L2.6 | potwierdzone | **częściowe** | stan „brak dostępu" niewywołany w przeglądarce |

Sześć podniesień, sześć obniżeń, jedna reklasyfikacja.

---

## 5. Braki i testy przekrojowe

Lista z poprzedniego raportu („sześć brakujących prób, dwa ograniczenia biblioteki, wygaśnięcie
poświadczenia") **nie jest już aktualna**. Faktyczny stan po audycie: **pięć z sześciu prób
wykonano** (canvas CRUD, `get_context`, szkic, współbieżność, Stop), pozostała jedna
(przełączenie właściciela — niewykonalna bez zmiany produktu); ograniczenie biblioteki jest
**jedno**, nie dwa; doszło **pięć defektów** wcześniej nieznanych.

### 5.1 D-1 — wątek czatu niewidoczny przy otwartej szufladzie rozmów

- **Kryterium:** L2.2, pośrednio L5.3
- **Reprodukcja:** wejść na `/cases` → otworzyć sprawę → „Otworz przestrzen pracy na canvasie".
  Szuflada rozmów jest otwarta (`.openui-agent-thread-list` widoczna).
- **Obserwacja:** tekst panelu czatu zawiera wyłącznie listę rozmów i podpowiedzi startowe
  (742 znaki); brak wiadomości i brak elementu narzędzia. Zrzuty
  [`12`](docs/evidence/audit-2026-09-15/12-chat-z-narzedziami.png),
  [`14`](docs/evidence/audit-2026-09-15/14-chat-szuflada-otwarta.png).
- **Geometria** ([`16-probe-chat-layout.txt`](docs/evidence/audit-2026-09-15/16-probe-chat-layout.txt)):
  panel `x=1120 w=560`, szuflada `x=1121 w=260`, wątek `x=1121 w=559` — szuflada nakłada się na
  lewą połowę wątku wewnątrz panelu. Kompozytor mieści się (`-25 px`).
- **Kontrolka zamykająca: NIE ZNALEZIONA.** Sprawdzono `Collapse sidebar`, `Close sidebar`,
  `Hide sidebar`, `Toggle sidebar`, `Expand sidebar`, `Open sidebar`. Widoczny jest `Open sidebar`,
  ale kliknięcie go nie zamyka szuflady.
- **Skutek dla użytkownika:** po wejściu tą ścieżką rozmowa jest nieczytelna i nie ma oczywistego
  sposobu, żeby to naprawić w interfejsie.
- **Najmniejsze uzupełnienie:** przywrócić działającą kontrolkę zwijania szuflady
  (lub domyślnie ją zwijać w układzie `copilot`) i dodać test przeglądarkowy, który po otwarciu
  sprawy wymaga widocznej ostatniej wiadomości.
- **Uwaga:** panel czatu był poprawny na zrzucie z 2026-09-14
  ([`docs/evidence/03-canvas.png`](docs/evidence/03-canvas.png)) — to regresja względem tamtego stanu,
  prawdopodobnie związana z regułami CSS przypinającymi szufladę (`platform-ui/src/styles.css`).

### 5.2 D-2 — aktywność narzędzi nie jest utrwalana

- **Kryterium:** L4.4, L5.3
- **Dowód kodowy:** `GET /api/threads/get/:id` zwraca `{ id, role, content }` i nic więcej
  (`platform-server/src/http/app.ts`). Słowo `toolCalls` **nie występuje w całym repozytorium**
  (0 trafień w `packages/`, `apps/`). Sprawdzenie na żywo: wiadomości rozmowy z trzema wywołaniami
  narzędzi mają klucze `['content','id','role']`.
- **Skutek:** wywołania i wyniki narzędzi istnieją w strumieniu i w `run_events`, ale znikają
  z rozmowy po przeładowaniu lub jakimkolwiek przemontowaniu komponentu. Typ `Message` w OpenUI
  obsługuje `toolCalls` oraz osobne wiadomości `role:'tool'` — kontrakt storage tego nie wykorzystuje.
- **Nierozstrzygnięte:** w trzech obserwacjach **nie znaleziono** elementu narzędzia w DOM czatu
  *także w trakcie* przebiegu, mimo poprawnych zdarzeń `TOOL_CALL_*`. Nie ustalono, czy to skutek
  D-1 (zasłonięcie), czy brak renderowania. Sprawdzone selektory:
  `.openui-agent-tool-call`, `[class*="tool-call"]`, `[class*="ToolCall"]`, `[class*="openui-agent-tool"]`,
  `[data-testid*="tool"]` — wszystkie zero trafień; brak jakiejkolwiek klasy zawierającej `tool`.
- **Najmniejsze uzupełnienie:** najpierw naprawić D-1, potem powtórzyć obserwację; jeśli element
  nadal nie występuje, rozstrzygnąć, czy `AgentInterface` wymaga jawnego przekazania renderera
  aktywności narzędzi. Utrwalanie `toolCalls` to osobna, większa zmiana kontraktu storage.

### 5.3 D-3 — wygasłe poświadczenie raportowane jako zdrowa subskrypcja

- **Kryterium:** L8.6
- **Reprodukcja (symulacja, bezpieczna):** katalog tymczasowy z `.credentials.json` zawierającym
  `claudeAiOauth.expiresAt` z przeszłości i fabrykowane tokeny; wywołanie
  `probeAuth({ CLAUDE_CONFIG_DIR: <katalog> })`.
- **Wynik:** `mode=subscription` mimo `expiresAt = 2026-09-15T09:23:42Z` (godzinę przed próbą)
  — [`03-probes-auth.txt`](docs/evidence/audit-2026-09-15/03-probes-auth.txt).
- **Przyczyna w kodzie:** `probeAuth` ustala tryb wyłącznie jako
  `credentialsPresent ? 'subscription' : 'unauthenticated'`; `expiresAt` jest tylko raportowane.
- **Skutek:** ekran Ustawień i `/api/status` twierdzą, że wszystko jest w porządku, podczas gdy
  kolejne wywołanie modelu zawiedzie. Diagnostyka wprowadza w błąd dokładnie wtedy, gdy jest potrzebna.
- **Najmniejsze uzupełnienie:** porównać `expiresAt` z czasem bieżącym i wprowadzić trzeci stan
  (np. `expired`) w `authModeSchema`, plus test.
- **Niezweryfikowane świadomie:** wyczerpanie limitu użycia. Nie wyczerpywano limitu celowo;
  ścieżka `classifyModelError` dla `usage limit` pozostaje niesprawdzona i nie da się jej wywołać
  z zewnątrz, bo funkcja nie jest eksportowana.

### 5.4 D-4 — tryb artefaktu `live` nie jest zaimplementowany

- **Kryterium:** L10.10
- **Dowód:** `mode: 'live'` występuje w schemacie, w opisie narzędzia i w wyświetlanej etykiecie.
  **Żadna ścieżka odczytu go nie rozróżnia** — `artifacts.ts` zwraca zapisany `content` niezależnie
  od trybu; brak deskryptora zapytania i brak jego wykonania.
- **Zaostrzenie:** opis narzędzia `artifact_create` mówi modelowi, że
  `mode="live" zapisuje deskryptor zapytania i odswieza sie przy otwarciu`. To obietnica złożona
  agentowi, której kod nie dotrzymuje — agent może na niej polegać.
- **Najmniejsze uzupełnienie:** albo usunąć `live` ze schematu i z opisu narzędzia (mniejsza zmiana,
  uczciwa), albo zaimplementować odczyt deskryptora. **Wymaga decyzji użytkownika.**

### 5.5 D-5 — `first_token_ms` gubiony, gdy narzędzie poprzedza tekst

- **Kryterium:** L12.3, skutkiem także L12.5
- **Przyczyna w kodzie:** `runtime.ts:345` zapisuje metrykę tylko w gałęzi `if (!textOpened)`,
  a `openText()` jest wywoływane również z mostu hooków przy `PreToolUse`. Gdy narzędzie idzie
  pierwsze, `textOpened` jest już `true` i metryka nigdy się nie zapisuje.
- **Dowód korelacyjny — doskonały.** Z pięciu przebiegów, w których wystąpiły i narzędzia, i tekst:

  | Przebieg | pierwsze narzędzie | pierwszy tekst | kolejność | `first_token_ms` |
  |---|---|---|---|---|
  | 7aa67f | seq 13 | seq 3 | tekst pierwszy | 13658 |
  | f0826e | seq 13 | seq 3 | tekst pierwszy | 10908 |
  | 49a96a | seq 15 | seq 3 | tekst pierwszy | 11054 |
  | **e6be00** | **seq 4** | **seq 17** | **narzędzie pierwsze** | **NULL** |
  | **8f8325** | **seq 4** | **seq 17** | **narzędzie pierwsze** | **NULL** |

- **Skutek:** metryka „czas pierwszej odpowiedzi" jest niewiarygodna i zależy od kolejności działań
  modelu; `e2e/agent-ui.spec.ts` przewraca się losowo.
- **Najmniejsze uzupełnienie:** zapisywać metrykę przy pierwszej **delcie tekstu**, niezależnie od
  `textOpened` (osobna flaga), plus test kolejności.

### 5.6 D-6 — pusta asercja w teście przeglądarkowym (§4.3)

Najmniejsze uzupełnienie: asercja na treść, której nie ma w statycznym interfejsie — np. znacznik
wstawiony do polecenia i wymagany w odpowiedzi. Metoda sprawdzona w audycie
(`audit-probe-remount.mjs` używa `ZNACZNIK-PIERWSZY`).

Przy okazji: `agent_runs.started_at` to moment **zakolejkowania**, a nie startu wykonania, więc
czas oczekiwania w kolejce jest niewidoczny w danych diagnostycznych. Pierwsza wersja mojej sondy
współbieżności dała z tego powodu **fałszywy GAP** — okna wykonania trzeba rekonstruować jako
`[finishedAt - durationMs, finishedAt]`. To nie blokuje żadnego kryterium, ale utrudnia diagnozę.

### 5.7 Ograniczenie zależności — `@openuidev/react-headless` 0.9.13

- **Kryteria:** L5.2, L5.4
- **Źródło:** odczyt `processStreamedMessage` w **zainstalowanej** wersji (nie z dokumentacji).
- **Minimalna reprodukcja:** `EventType` biblioteki zawiera **13** nazw; `@ag-ui/core` 0.0.53
  definiuje **32**. `processStreamedMessage` obsługuje 9 z nich:
  `TEXT_MESSAGE_START/CONTENT/CHUNK`, `TOOL_CALL_START/ARGS/CHUNK/END/RESULT`, `RUN_ERROR`.
  Ignoruje `CUSTOM`, `TEXT_MESSAGE_END`, `STEP_STARTED`, `STEP_FINISHED`.
  **`RUN_STARTED` i `RUN_FINISHED` w ogóle nie istnieją w jej `EventType`** — nasz backend emituje
  zdarzenia, których ten klient nie ma w słowniku.
- **Ograniczenie upstream, nie błąd naszej integracji.** Nasz adapter `platformAguiAdapter`
  prawidłowo przechwytuje `CUSTOM` obok gotowego parsera; to jedyna możliwa droga bez zastępowania
  komponentu.
- **Możliwy adapter i konsekwencje:** własny komponent wiadomości (`components.AssistantMessage`)
  mógłby renderować stan wykonania z naszego kanału `CUSTOM`. **Konsekwencja:** przejmujemy
  odpowiedzialność za prezentację rozmowy, czyli częściowo rezygnujemy z „gotowego czatu".
  **Nie zmieniam tego w ramach audytu** i nie rekomenduję bez decyzji użytkownika.

### 5.8 Wyniki prób przekrojowych wymaganych przez zadanie

| Próba | Wynik | Dowód |
|---|---|---|
| Równoległe rozmowy | różne rozmowy biegną równolegle, osobne identyfikatory | `raw-probe-conc2.log` |
| Dwa polecenia w jednej rozmowie | szeregowane, okna rozłączne (koniec 10:27:41.687 = start następnego), „ALFA"/„BETA" niezmieszane, 3 wiadomości użytkownika bez duplikatów | `raw-probe-conc2.log` |
| Stop — zakończenie wykonania | potwierdzenie 3 ms, strumień zamknięty 2010 ms, status `cancelled` | `raw-probe-stop.log` |
| Stop — procesy potomne | 0 przed / 1 w trakcie / **0 po**, brak osieroconych | `raw-probe-stop.log` |
| Stop — brak późniejszych zapisów | 80 → 80 zdarzeń | `raw-probe-stop.log` |
| Stop — odblokowanie kolejki | kolejne uruchomienie `succeeded` (19813 ms) | `raw-probe-stop.log` |
| Restart serwera | 5/5 plików, sha identyczne; przerwany przebieg → `failed`/`server_sigterm` | restart instancji audytowej |
| Wznowienie rozmowy | historia spójna, brak powtórzonych operacji | FEEDBACK #19 *(hist.)* |
| Canvas: add/update/move/remove przez agenta | wszystkie cztery, `specVersion` i `geometryVersion` niezależne | `raw-probe-canvas.log` |
| Aktualność po mutacji | `data_changed` → unieważnienie → nowa suma bez przeładowania | FEEDBACK #21 *(hist.)* |
| Brak wycieku między zakresami cache | backend: 403 na wszystkich powierzchniach. Klient: **klucze bez właściciela**, przejścia nie da się wywołać | `04-probes-api.txt` |
| Upload → sandbox → artefakt → pobranie | artefakt utworzony przez agenta, widoczny na ekranie Pliki i raporty | `08-probes-browser.txt`, `07-artefakty.png` |
| Artefakty statyczne vs zależne od danych | snapshot działa; **live nieobsługiwany** (D-4) | analiza kodu |
| Zgody, odmowy, błędy narzędzi | zgoda/odmowa potwierdzone *(hist.)*; po zakończeniu brak pozornego oczekiwania *(dziś)* | FEEDBACK #23, `13-probe-chat-tools.txt` |
| Początek i zakończenie wykonania w czacie | **nie sygnalizowane przez komponent** — brak `RUN_STARTED`/`RUN_FINISHED` w bibliotece | §5.7 |
| Ograniczenia sandboxu — sieć | `deny network-outbound example.com:443`, exit 56 | FEEDBACK #24 *(hist.)* |
| Ograniczenia sandboxu — pliki | `data/app.db` niewidoczna dla procesu | FEEDBACK #25 *(hist.)* |
| Wygaśnięcie uwierzytelnienia | **symulacja**: raportowane jako zdrowe (D-3) | `03-probes-auth.txt` |
| Limit użycia | **niewywołane świadomie** | — |

### 5.9 Próby nieudane i pominięte — pełna lista

Zapisuję je, bo trzy z nich dały fałszywe wyniki, które mogłyby trafić do raportu:

1. **Sonda kolejkowania, wersja 1** — porównywała `startedAt` z `finishedAt` i zgłosiła **fałszywy
   GAP** „przebiegi nakładają się". `startedAt` to moment zakolejkowania. Poprawione na rekonstrukcję
   okien wykonania; po poprawce OK.
2. **Sonda Stop, asercja kolejki** — wymagała dosłownej odpowiedzi `PO-STOPIE` i zgłosiła **fałszywy
   GAP**. Przebieg faktycznie zakończył się sukcesem; wznowiona sesja niosła przerwane zadanie, więc
   model odpowiedział inaczej. Poprawione na sprawdzenie statusu uruchomienia.
3. **Sonda przeglądarkowa, wersja 1** — użyła `page.request` (własny słoik ciasteczek → 401) i
   sprawdziła DOM przed zakończeniem przebiegu; zgłosiła **dwa fałszywe GAP-y**. Poprawione na
   `page.evaluate(fetch, {credentials:'include'})` i oczekiwanie na status końcowy.
4. **Restart instancji audytowej w trakcie sondy przeglądarkowej** — mój błąd sekwencjonowania;
   unieważnił przebieg (`run 6c9c63`, `server_sigterm`). Powtórzone sekwencyjnie. Ubocznie dał
   dowód dla L11.8.
5. **Hipoteza przemontowania czatu** — postawiona po zaobserwowaniu braku odpowiedzi; sprawdzona
   osobnym eksperymentem (`audit-probe-remount.mjs`) i **obalona**: pierwsza odpowiedź w nowej
   rozmowie pojawia się poprawnie. Zapisuję, bo wyklucza jedną z przyczyn D-1/D-2.
6. **Próba zamknięcia szuflady** — sześć etykiet `aria-label`, żadna nie zamyka. Nierozstrzygnięte,
   czy kontrolka istnieje pod inną nazwą.
7. **Pominięte świadomie:** wyczerpanie limitu użycia; przełączenie właściciela w przeglądarce
   (brak UI); powtórzenie sandboxu i zgód (dowody historyczne uznane za wystarczające przy
   ograniczonym budżecie tur).

### 5.10 Bramka przekrojowa z dokumentu architektury

Dokument wymaga ponadto, żeby zamknięcie wszystkich warstw potwierdzić **przepływami między nimi**
(odczyt i mutacja przez MCP, odświeżenie UI, zmiana kompozycji, przetworzenie pliku, zapis artefaktu,
kontynuacja rozmowy po restarcie, plus błąd, odmowa, anulowanie i konflikt).

Stan: wszystkie te przepływy mają dowód — część z tego audytu, część historyczną — **z wyjątkiem
widoczności przebiegu w gotowym czacie** (D-1/D-2/§5.7). Bramka pozostaje otwarta razem z L5.

---

## 6. Dowody i lista prac do zamknięcia

### 6.1 Uruchomione kontrole

| Polecenie | Wynik | Dowód |
|---|---|---|
| `pnpm check:boundaries` | exit 0 — granica zachowana | `01-checks.txt` |
| `pnpm check:matrix` | exit 0 — podsumowanie zgodne z tabelami | `01-checks.txt` |
| `pnpm typecheck` (TS 7.0.2) | exit 0 | `01-checks.txt` |
| `pnpm test` (Vitest) | **69/69**, exit 0 | `01-checks.txt` |
| `pnpm build` | exit 0; `dist/server.js` 166,8 kB | `01-checks.txt` |
| `pnpm test:e2e` (Playwright) | **21 passed, 1 FAILED** | `17-playwright.txt` |
| `pnpm install --frozen-lockfile` | exit 0, brak ostrzeżeń peer | §1.5 |
| `node scripts/audit-versions.mjs` | wersje z `node_modules` | `02-versions.txt` |
| `node scripts/audit-probes.ts` | 5 OK, **1 GAP** (D-3) | `03-probes-auth.txt` |
| `node scripts/audit-probes-api.mjs` | 6 OK | `04-probes-api.txt` |
| `node scripts/audit-probes-model.mjs canvas-crud` | 4 OK | `raw-probe-canvas.log` |
| `node scripts/audit-probes-model.mjs concurrency` | 4 OK | `raw-probe-conc2.log` |
| `node scripts/audit-probes-model.mjs stop` | 5 OK + 1 fałszywy GAP (§5.9) | `raw-probe-stop.log` |
| `node scripts/audit-probes-model.mjs draft` | 1 OK | `raw-probe-draft.log` |
| `node scripts/audit-probes-browser.mjs` | 6 OK, **2 GAP** | `08-probes-browser.txt` |
| `node scripts/audit-probe-remount.mjs` | hipoteza obalona | `11-probe-remount.txt` |
| `node scripts/audit-probe-chat-tools.mjs` | **GAP** — brak elementu narzędzia w DOM | `13-probe-chat-tools.txt` |
| `node scripts/audit-probe-chat-layout.mjs` | brak kontrolki zamykającej szufladę | `16-probe-chat-layout.txt` |

**Zielony build nie jest odbiorem integracji.** `pnpm test` i `pnpm build` przechodzą, a mimo to
sześć defektów pozostaje otwartych — pięć z nich nie jest wykrywanych przez żaden istniejący test.

Zrzuty i ślady przeglądarki: `06`, `07`, `09`, `10`, `12`, `14`, `15` w katalogu dowodów; powiązanie
wykonania z widocznym rezultatem w `08-probes-browser.txt` (identyfikator przebiegu w pasku stanu
na zrzucie `06`: `run 418f8325`).

### 6.2 Lista prac do zamknięcia

| Kryterium | Brak | Proponowane rozwiązanie | Rodzaj | Zależności | Sposób potwierdzenia | Decyzja użytkownika |
|---|---|---|---|---|---|---|
| L2.2, L5.3 | D-1: wątek niewidoczny przy otwartej szufladzie | przywrócić działającą kontrolkę zwijania lub domyślnie zwijać szufladę w układzie `copilot` | naprawa kodu | — | test przeglądarkowy: po otwarciu sprawy ostatnia wiadomość widoczna | brak |
| L4.4, L5.3 | D-2: brak `toolCalls` w kontrakcie wiadomości | rozszerzyć `messages` i `/api/threads/get/:id` o `toolCalls` oraz wiadomości `role:'tool'` | naprawa kodu | D-1 (najpierw wykluczyć zasłonięcie) | po przeładowaniu aktywność narzędzi nadal widoczna | brak |
| L5.3 | nierozstrzygnięte: brak elementu narzędzia w DOM | powtórzyć obserwację po naprawie D-1; jeśli nadal brak — ustalić, czy `AgentInterface` wymaga jawnego renderera | brak testu / adapter | D-1 | element narzędzia obecny w DOM w trakcie przebiegu | brak |
| L8.6 | D-3: wygasłe poświadczenie raportowane jako zdrowe | porównać `expiresAt` z czasem bieżącym; trzeci stan w `authModeSchema` | naprawa kodu | — | test jednostkowy z poświadczeniem fabrykowanym (sonda już istnieje) | brak |
| L8.6 | limit użycia niewywołany | symulacja na granicy adaptera: wyeksportować `classifyModelError` i pokryć testem | brak testu | — | test mapowania komunikatu limitu na `model_failed` | brak |
| L10.10 | D-4: tryb `live` nieobsługiwany | **albo** usunąć `live` ze schematu i opisu narzędzia, **albo** zaimplementować deskryptor zapytania | naprawa kodu lub świadome ograniczenie | — | artefakt `live` zwraca aktualne dane po zmianie źródła | **TAK** — wybór wariantu |
| L12.3, L12.5 | D-5: `first_token_ms` gubiony | zapisywać metrykę przy pierwszej delcie tekstu, niezależnie od `textOpened` | naprawa kodu | — | przebieg z narzędziem przed tekstem ma niezerowe `firstTokenMs`; `agent-ui.spec.ts` przestaje migotać | brak |
| L12.5 | D-6: pusta asercja | asercja na znacznik wstawiony do polecenia, nieobecny w statycznym UI | brak testu | — | test przewraca się przy wyłączonym strumieniowaniu | brak |
| L12.3 | odświeżenie po mutacji niemierzone | pomiar od `data_changed` do zakończenia refetchu | brak testu | — | wartość w raporcie odbioru z warunkami pomiaru | brak |
| L2.6 | stan „brak dostępu" niewywołany w UI | test przeglądarkowy otwierający cudzy zasób | brak testu | — | widoczny komunikat „Brak dostępu" | brak |
| L10.7 | klucze cache bez właściciela; brak ścieżki wywołania | dodać `ownerId` do kluczy `qk.*` **lub** udokumentować jako świadome ograniczenie aplikacji jednoużytkownikowej | adapter integracyjny lub świadome ograniczenie | — | przełączenie właściciela nie pokazuje danych poprzednika | **TAK** — czy platforma ma być wieloużytkownikowa |
| L5.2, L5.4 | ograniczenie `@openuidev/react-headless` | własny `components.AssistantMessage` renderujący stan z kanału `CUSTOM` | adapter integracyjny | — | początek i zakończenie wykonania widoczne w czacie | **TAK** — oznacza częściową rezygnację z gotowego czatu |
| — | brak repozytorium git | zainicjować repozytorium i zacommitować stan | naprawa infrastruktury | — | `git rev-parse HEAD` zwraca rewizję | brak |
| — | `@ag-ui/mastra` nieużyte | pozostawić protokół drutowy **lub** wprowadzić oficjalną integrację | świadome ograniczenie | — | decyzja udokumentowana | **TAK** |
| L12.8 | eksporter Langfuse niepodłączony | podłączyć przez `@mastra/core/observability` lub `./telemetry/otel-vendor` | adapter integracyjny | — | ślad wykonania widoczny w Langfuse | brak (opcjonalne) |

### 6.3 Co blokuje ponowne użycie platformy, a co dotyczy tylko demonstracji ofert

**Blokuje ponowne użycie w kolejnych aplikacjach** (dotyczy warstwy platformy):

- **D-1** — powłoka czatu jest wspólna dla każdej aplikacji na tej platformie.
- **D-2** — kontrakt storage rozmów jest platformowy; każda kolejna aplikacja odziedziczy brak
  utrwalania aktywności narzędzi.
- **D-3** — diagnostyka uwierzytelnienia jest platformowa.
- **D-5** — metryka pierwszej odpowiedzi jest platformowa.
- **L10.7** — klucze cache są platformowe; wymaga decyzji o wieloużytkownikowości.
- **L5.2/L5.4** — ograniczenie gotowego czatu dotknie każdą aplikację.
- **Brak repozytorium git** — uniemożliwia rozgałęzienie platformy pod nową domenę.

**Dotyczy wyłącznie demonstracji ofert:**

- **D-4** — tryb `live` jest wprawdzie w narzędziu platformowym `artifact_create`, ale jedynym
  konsumentem jest dziś moduł zakupowy; można go wyłączyć bez wpływu na platformę.
- **D-6** — pusta asercja jest w teście scenariusza zakupowego.
- **L2.6** — stan „brak dostępu" sprawdzany na ekranach modułu.

**Niezweryfikowane dla ponownego użycia:** czy kontrakt `ServerModule`/`UiModule` wystarcza dla
domeny o innym kształcie. `module-devkit-probe` dowodzi, że kontrakt *działa*, ale jest trywialny
(jedna tabela, dwa narzędzia). Pewność da dopiero druga realna aplikacja.

---

## 7. Podsumowanie dla decyzji o kolejnym zadaniu

Platforma jest **funkcjonalnie kompletna w torze agentowym** i niekompletna w **prezentacji
przebiegu w interfejsie** oraz w **diagnostyce**. Sześć defektów jest nazwanych, zreprodukowanych
i przypisanych do kryteriów; żaden nie wymaga przebudowy architektury.

Najkrótsza droga do zamknięcia kolejnych warstw:

1. **L2 i L5** — naprawić D-1, powtórzyć obserwację czatu, rozstrzygnąć nierozstrzygnięte
   z §5.2. Największy zwrot: odblokowuje dwie warstwy i bramkę przekrojową §5.10.
2. **L12** — naprawić D-5 (jedna gałąź warunku) i D-6 (jedna asercja). Ubocznie stabilizuje
   suitę przeglądarkową.
3. **L8** — naprawić D-3 (porównanie dat) i pokryć testem mapowanie limitu.
4. **L10** — decyzja co do D-4 i co do wieloużytkownikowości (L10.7).
5. **L4** — D-2, największa zmiana kontraktu; sensowna dopiero po rozstrzygnięciu §5.2.

Trzy decyzje należą do użytkownika i nie da się ich podjąć z poziomu audytu: wariant dla `live`,
wieloużytkownikowość cache, oraz czy rezygnować z części „gotowego czatu" na rzecz własnego
komponentu wiadomości.
