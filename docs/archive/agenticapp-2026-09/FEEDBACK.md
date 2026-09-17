# FEEDBACK — raport techniczny realizacji

> **Dokument historyczny z aplikacji AgenticApp** (stan z 2026-09-17, po wpisach #40–#41 i §4e; sha256 oryginału `7ede758288062e65…`; poprzednia kopia w tym archiwum pochodziła z 2026-09-16).
> Opisuje próby wykonane w katalogu AgenticApp i ocenę wobec poprzedniej wersji specyfikacji (95 kryteriów).
> Nie potwierdza stanu tego repozytorium — aktualna ocena: [`docs/ACCEPTANCE.md`](../../ACCEPTANCE.md).
> Odnośniki do `docs/evidence/…` wskazują dowody, które pozostały lokalnie w AgenticApp i nie są publikowane; odnośniki do `docs/*.md` odpowiadają plikom w `docs/` tego repozytorium.

Samodzielny raport z budowy platformy agentowej i przykładowej aplikacji do porównywania ofert
zakupowych. Zrozumiały bez dostępu do rozmowy, w której powstał.

Ostatnia aktualizacja: 2026-09-16, wpis #38 (dane bazowe przy pierwszym uruchomieniu).

> **Stan aktualny jest w [`RAPORT-DOMKNIECIA-PLATFORMY.md`](RAPORT-DOMKNIECIA-PLATFORMY.md).**
> Ten plik to dziennik realizacji: sekcje 1, 5 i 7 opisują stan z chwili, w której
> je pisano, i **nie są aktualizowane wstecz** — liczby testów, luki i macierz w
> nich to zapis historyczny. Bieżące wyniki, macierz i ograniczenia: raport
> domknięcia. Wpisy #34–#36 w dzienniku opisują, co się od tego czasu zmieniło i
> dlaczego.

**Spis:** [1. Aktualny stan](#1-aktualny-stan) · [2. Środowisko](#2-środowisko-i-konfiguracja) ·
[3. Dziennik](#3-dziennik-realizacji) · [4. Architektura](#4-architektura-faktycznie-wdrożona) ·
[5. Macierz odbioru](#5-macierz-odbioru) · [6. Integracje i własny kod](#6-integracje-i-własny-kod) ·
[7. Problemy i ograniczenia](#7-problemy-i-ograniczenia) · [8. Wnioski](#8-wnioski-końcowe)

---

## 1. Aktualny stan

> **Zapis historyczny** (stan z 2026-09-14, przed audytem i przed dwiema turami
> prac). Zostawiony bez zmian celowo — przerabianie go wstecz zatarłoby to, co
> raporty miały pokazać. Liczby „69 testów Vitest / 22 Playwright" poniżej to
> stan wejściowy; obecnie jest 212 i 46. Aktualne: `RAPORT-DOMKNIECIA-PLATFORMY.md` §1.

### Co działa — potwierdzone rzeczywistym wykonaniem

| Obszar | Dowód |
|---|---|
| Pełna ścieżka **subskrypcja → Claude SDK → Mastra → AG-UI → OpenUI** | 10 rzeczywistych przebiegów agenta, [`docs/evidence/02-agent-run.md`](docs/evidence/02-agent-run.md) |
| Agent czyta dane przez MCP i pokazuje wynik backendu na canvasie | wpis #16 |
| Agent zmienia dane przez reguły domeny; zależne widoki przeliczają się | scenariusz `mutation`, wpis #21 |
| Agent przechodzi po relacjach do pliku źródłowego ceny | scenariusz `provenance`, wpis #21 |
| Agent zmienia kompozycję bez gubienia istniejącej pracy | scenariusz `layout`: 4 → 6 kart, wszystkie poprzednie zachowane |
| Przetworzenie CSV w sandboxie → trwały artefakt do pobrania | wpis #20, suma 49 410,00 PLN zgodna z ręcznym rachunkiem |
| Wznowienie rozmowy po restarcie bez powtarzania mutacji | wpis #19: 0 wywołań narzędzi, poprawna liczba z pamięci sesji |
| Zgoda i odmowa użytkownika na operację powłoki | scenariusze `consent-denied` / `consent-allowed`, wpis #23 |
| Izolacja sandboxa: sieć odcięta, baza aplikacji niewidoczna | wpisy #24, #25 |
| 21 narzędzi MCP widocznych w prawdziwej sesji | `pnpm --filter @app/server diag` |
| **Pełna ścieżka z interfejsu**: polecenie w czacie → karta na canvasie → przeładowanie | `e2e/agent-ui.spec.ts`, wpis #31 |

### Co działa — potwierdzone testem automatycznym

69 testów Vitest (domena, kontrakty, granica modułów, schematy MCP, runtime, brak wycieku tokena) i
22 testy Playwright na buildzie produkcyjnym — w tym jeden przejeżdżający **pełną ścieżkę
użytkownika z prawdziwym modelem**: polecenie wpisane w czacie → odpowiedź → karta na canvasie →
przetrwanie przeładowania. Szczegóły w [macierzy odbioru](#5-macierz-odbioru).

### Co pozostaje otwarte

| Luka | Dlaczego |
|---|---|
| `canvas_update_card` / `canvas_move_card` / `canvas_remove_card` nieużyte przez model | pokryte testami kontraktowymi, ale nie trafiły do żadnego przebiegu odbiorowego |
| Wygaśnięcie poświadczenia i wyczerpanie limitu | obsługa zaimplementowana, ale nie da się jej wywołać na żądanie |
| Dwa równoległe przebiegi na tej samej rozmowie | mechanizm (kolejka + serwer MCP per uruchomienie) zweryfikowany konstrukcją, nie uruchomiony współbieżnie |
| Czas zatrzymania procesu modelu po `Stop` | zmierzona tylko część aplikacyjna (< 50 ms) |
| Artefakt w trybie `live` | zaimplementowany, nieużyty w danych demonstracyjnych |
| Eksport telemetrii do Langfuse | nie podłączony; ograniczenie opisane w L12.8 |

### Co blokuje odbiór

Wcześniejsza wersja tego raportu mówiła „nic nie blokuje odbioru". **To było zbyt mocne** i zostało
skorygowane (wpis #30). Trzeba rozdzielić dwie rzeczy:

**Nic nie blokuje używania platformy.** Dostęp jest, wszystkie scenariusze produktowe wykonują się
z poprawnym wynikiem, build i testy przechodzą.

**Odbioru jako sprawdzonego szablonu nie można jeszcze ogłosić.** Zgodnie z regułą z dokumentu
architektury („warstwa jest zamknięta, gdy *wszystkie* jej kryteria mają dowód z działającego
systemu") **zamknięte są 3 z 12 warstw** — L2, L4 i L9. Pozostałych dziewięć pozostaje otwartych,
każda z powodu jednego lub dwóch kryteriów wymienionych imiennie w [podsumowaniu macierzy](#podsumowanie-macierzy).

Braki dzielą się na trzy rodzaje:

| Rodzaj | Kryteria | Co trzeba zrobić |
|---|---|---|
| **Brak próby**, którą da się przeprowadzić | L3.2, L6.3, L7.4, L10.7, L11.7, L12.3 | dopisać scenariusze: pozostałe operacje canvasu, wymuszenie `get_context`, dwa równoległe przebiegi, przełączenie użytkownika, pomiar zatrzymania procesu, osobny pomiar odświeżenia |
| **Ograniczenie gotowej biblioteki** | L5.2, L5.4 | zależy od `@openuidev/react-headless`; obejście działa, ale kryterium w pełnym brzmieniu nie jest spełnione |
| **Nie da się wywołać na żądanie** | L8.6 | wygaśnięcie poświadczenia i wyczerpanie limitu — potrzebne środowisko testowe albo sztuczne wymuszenie błędu |

Szacunek domknięcia: pierwsza grupa to praca na kilka godzin, druga wymaga decyzji (obejście vs.
zmiana biblioteki), trzecia — osobnego stanowiska testowego.

### Jak uruchomić

```bash
pnpm install
pnpm migrate      # data/app.db
pnpm seed         # dane demonstracyjne
pnpm dev          # backend :8791 + frontend :5173
```

Produkcyjnie (bez serwera deweloperskiego): `pnpm build && pnpm start` → http://localhost:8791

Weryfikacja:

```bash
pnpm typecheck                          # 0 błędów (TypeScript 7.0.2)
pnpm test                               # 278 testów w 23 plikach
pnpm check:boundaries                   # granica platforma–domena
pnpm test:e2e                           # 72 testy przeglądarkowe (cztery wydają tury subskrypcji)
pnpm check:matrix                       # podsumowanie macierzy zgodne z tabelami
pnpm --filter @app/server diag          # prawdziwa sesja Claude: widoczność narzędzi MCP
node scripts/acceptance-agent.mjs       # 6 scenariuszy z prawdziwym modelem (kosztuje tury)
```

### Gdzie szukać dowodów

| Plik | Zawartość |
|---|---|
| [`docs/evidence/01-sdk-probe.md`](docs/evidence/01-sdk-probe.md) | pierwsze rzeczywiste wywołanie SDK, przed budową reszty |
| [`docs/evidence/02-agent-run.md`](docs/evidence/02-agent-run.md) | cztery pełne przebiegi agentowe z logami zdarzeń |
| [`docs/evidence/03-canvas.png`](docs/evidence/03-canvas.png) | zrzut działającej aplikacji |
| [`docs/evidence/04-server-start.txt`](docs/evidence/04-server-start.txt) | log startu backendu produkcyjnego |
| [`docs/evidence/05-acceptance-agent.txt`](docs/evidence/05-acceptance-agent.txt) | surowe wyjście scenariuszy odbiorowych |
| [`docs/evidence/06-playwright.txt`](docs/evidence/06-playwright.txt) | wynik testów przeglądarkowych |

---

## 2. Środowisko i konfiguracja

| Element | Wersja |
|---|---|
| System | Linux 7.2.4-200.fc44.x86_64 (Fedora) |
| Node.js | 24.19.0 (linia LTS) |
| pnpm | 9.15.9, workspaces |
| TypeScript | **7.0.2** (najnowsze stabilne; port natywny) |
| React / React DOM | **19.3.0** (najnowsze stabilne) |
| Vite | 8.3.0 |
| Hono / `@hono/node-server` | 4.13.7 / 1.19.7 |
| Drizzle ORM / better-sqlite3 | 0.45.2 / 13.0.3 |
| Zod | 4.6.5 |
| `@mastra/core` / `@mastra/claude` | 1.66.0 / 0.3.1 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.270 |
| Claude Code CLI (spawnowane przez SDK) | 2.1.270 |
| `@openuidev/react-ui` | 0.13.10 |
| `@openuidev/react-lang` / `lang-core` | 0.2.15 / 0.2.18 |
| `@openuidev/react-headless` | 0.9.13 |
| `@ag-ui/core` | tranzytywnie przez `react-headless` |
| `@xyflow/react` (canvas) | 12.11.6, MIT |
| TanStack Router / Query | 1.170.36 / 5.102.8 |
| Vitest / Playwright | 5.0.0 / 1.63.0 |
| esbuild (bundle backendu) | 0.27.3 |

Dokładne wersje utrwala `pnpm-lock.yaml`. Model: `claude-sonnet-4-5` (zmienna `APP_MODEL`).

### Tryb uwierzytelnienia Claude

**Wyłącznie subskrypcja, egzekwowana a nie zakładana.**

Claude Agent SDK czyta poświadczenie OAuth z `~/.claude/.credentials.json` — tego samego pliku,
który zapisuje `claude` CLI przy `/login`.

Precyzyjnie o tym, co robi **aplikacja**: `probeAuth()` **czyta i parsuje** ten plik, bo inaczej nie
pozna planu ani daty wygaśnięcia. Z rozpakowanego obiektu kopiuje wyłącznie `subscriptionType`
i `expiresAt`; pól `accessToken` i `refreshToken` nigdy nie dotyka, nie przechowuje, nie loguje
i nie przesyła. Nie jest to deklaracja — dwa testy biorą rzeczywistą wartość tokena z dysku
i sprawdzają, że nie pojawia się w żadnym wyjściu aplikacji (wpis #33).

Token dociera do modelu wyłącznie przez SDK, które czyta ten plik niezależnie. Aplikacja nie leży
na tej ścieżce.

`subscriptionOnlyEnv()` (`packages/platform-server/src/agent/auth.ts`) usuwa z procesu potomnego:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`, `ANTHROPIC_MODEL`,
  `AWS_BEARER_TOKEN_BEDROCK` — żeby płatne API ani gateway nie mogły stać się ścieżką wykonania;
- wszystko pasujące do `CLAUDE_CODE_*` (poza `CLAUDE_CONFIG_DIR`), `CLAUDECODE`, `CLAUDE_PID`,
  `CLAUDE_EFFORT`, `AI_AGENT` — żeby osadzony SDK nie podłączył się do nadrzędnej sesji powłoki
  agentowej, gdyby aplikację uruchomiono z jej wnętrza.

`settingSources: []` odcina prywatną konfigurację dewelopera: `~/.claude/settings.json`,
jego serwery MCP i pliki CLAUDE.md. Potwierdzone diagnostyką: *„izolacja konfiguracji OK:
brak obcych serwerow MCP"*.

Dostęp do samej aplikacji to **osobna** lokalna sesja (ciasteczko podpisane HMAC, sekret
generowany przy pierwszym starcie do `data/session.secret`, tryb 0600). Token subskrypcji nigdy
nie pełni roli tokena dostępu do aplikacji.

### Źródła wykorzystane przy implementacji

Zamiast dokumentacji użyto **bezpośredniej inspekcji typów i kodu zainstalowanych pakietów** — to
jedyna metoda dająca pewność zgodności z konkretną wersją. Kluczowe pliki:

- `@anthropic-ai/claude-agent-sdk/sdk.d.ts` (9 221 linii) — `Options`, `hooks`, `HookInput`,
  `canUseTool`, `PermissionMode`, `SandboxSettings`, `tool()`, `createSdkMcpServer()`.
- `@mastra/claude/dist/index.js` — `runClaudeAsMastraStream`, `getTextDelta`, `runClaude`
  (to tam widać, że per-wywołaniowe `sdkOptions` są scalane i że narzędzia idą tylko do telemetrii).
- `@openuidev/react-headless/dist/index.mjs` — `agUIAdapter`, `restStorage`,
  `processStreamedMessage` (pełna lista obsługiwanych zdarzeń AG-UI).
- `@openuidev/react-ui/dist/index.d.mts` — `AgentInterface`, `openuiLibrary`, `LayoutContextProvider`.
- `@openuidev/lang-core/dist/index.d.mts` — `Library`, `LibraryDefinition`, `createLibrary`.

---

## 3. Dziennik realizacji

### #1 — 11:05 — Rozpoznanie środowiska i dostępności pakietów

**Cel:** ustalić, czy stack z dokumentu architektury w ogóle istnieje.

**Wynik:** Node 24.19.0, pnpm 9.15.9, `claude` CLI 2.1.270 obecne.
**Problem:** pakiet `openui` na npm to porzucona biblioteka z 2017 (React 15) — **nie** ta OpenUI.
Wyszukiwanie rejestru wskazało właściwą rodzinę `@openuidev/*` od `thesysdev`, z homepage
`openui.com` zgodną z linkami w dokumencie architektury.

### #2 — 11:09 — Wczesna weryfikacja rzeczywistej integracji Claude

**Cel:** zgodnie z poleceniem sprawdzić prawdziwą ścieżkę agentową **przed** budową reszty.

**Działanie:** minimalny skrypt: `query()` z SDK, serwer MCP z jednym narzędziem, wymuszone wywołanie.

**Wynik — sukces.** Model wywołał narzędzie, dostał `{"magic":4711}` i odpowiedział `MAGIC=4711`.
`session_id` dostępny w komunikacie `system/init`. Czas 10,3 s.

**Uboczne ustalenie:** w liście narzędzi pojawiły się `mcp__context7__*` — SDK domyślnie dziedziczy
`~/.claude/settings.json` dewelopera. Skutek: `settingSources: []` w aplikacji.

Dowód: [`docs/evidence/01-sdk-probe.md`](docs/evidence/01-sdk-probe.md).

### #3 — 11:12 — Inspekcja API OpenUI zamiast dokumentacji

**Problem:** dokumentacja nie mówi, których zdarzeń AG-UI faktycznie używa gotowy czat ani jakiego
kontraktu wymaga storage.

**Ustalenia z kodu:**

1. `agUIAdapter()` parsuje zwykłe SSE `data: <json>` ze zdarzeniem AG-UI.
2. `processStreamedMessage` obsługuje **tylko**: `TEXT_MESSAGE_START/CONTENT/CHUNK`,
   `TOOL_CALL_START/ARGS/CHUNK/END/RESULT`, `RUN_ERROR`. **Ignoruje** `RUN_STARTED`,
   `RUN_FINISHED`, `TEXT_MESSAGE_END`, `STATE_SNAPSHOT` i **`CUSTOM`**.
3. `restStorage({baseUrl})` używa konwencji `/get`, `/create`, `/get/:id`, `/update/:id`,
   `/delete/:id` → backend napisano dokładnie pod nią, więc czat działa na samej konfiguracji.
4. `restStorage` implementuje **tylko** kanał `thread`; kanał `artifact` trzeba napisać samemu.

### #4 — 11:20 — Odkrycie luk w adapterze `@mastra/claude`

Odczyt `dist/index.js` pokazał, że `runClaudeAsMastraStream` przekazuje do strumienia Mastry
**wyłącznie deltę tekstu**. Wywołania narzędzi trafiają tylko do telemetrii
(`recordClaudeToolTelemetry`), a `session_id` **nie jest eksponowany w ogóle**.

**Skutek bez obejścia:** brak wywołań narzędzi w czacie i brak możliwości wznowienia rozmowy.

**Decyzja:** most na **hookach Claude SDK** — `SessionStart`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Stop`. `BaseHookInput` zawiera `session_id`, a `PostToolUseHookInput`
dodatkowo `tool_use_id`, `tool_name`, `tool_input`, `tool_response`. To udokumentowany mechanizm
SDK, nie obejście biblioteki.

**Odrzucone:** (a) porzucenie `@mastra/claude` i bezpośrednie `query()` — dokument architektury
wymaga oficjalnej integracji Mastry (L7.1); (b) przechwycenie telemetrii Mastry — prywatny
interfejs adaptera, a i tak nie daje `session_id`.

### #5 — 11:26 — Wybór biblioteki canvasu

**Decyzja:** `@xyflow/react` 12.11.6 (React Flow), MIT, lokalnie i bezpłatnie. Daje pan/zoom,
przeciąganie, zaznaczanie, zmianę rozmiaru i minimapę. Krawędzie są opcjonalne, więc używamy go
jako czystego płótna kart.

**Odrzucone:** `tldraw` (licencja nie jest bezpłatna komercyjnie), `react-zoom-pan-pinch`
(brak zmiany rozmiaru i zaznaczania — trzeba by dopisać sporo własnego kodu).

### #6 — 11:30 — Struktura granicy platforma–domena

**Decyzja:** osobne pakiety pnpm workspace, bo wtedy granicę wymusza `package.json`, a nie
konwencja katalogów. Kontrakty rejestracji (`ServerModule`, `UiModule`, `RouteRegistrar`,
`CardComponentDescriptor`) w `@platform/contracts`.

Kluczowy element: `CardComponentDescriptor` to **serwerowa** połowa katalogu komponentów, żeby
walidacja kompozycji proponowanej przez agenta działała po stronie backendu, a nie tylko w
przeglądarce — inaczej byłaby nieegzekwowalna.

### #7 — 11:45 — Rozdzielenie zapisu pozycji karty od zapisu treści

Wymaganie: *„Zapis położenia karty nie może konkurować z zapisem jej treści."*

Karta ma **dwa niezależne kanały zapisu i dwa liczniki wersji**: geometria
(`PATCH .../geometry`, `geometry_version`) i treść (`PATCH .../spec`, `spec_version`).
Piszą rozłączne kolumny. Przeciąganie karty w trakcie edycji przez agenta nie może nadpisać tej
edycji ani odwrotnie; konflikt jest możliwy tylko w obrębie jednego kanału.

### #8 — 11:50 — Model danych domeny i reguły

Wszystkie kwoty w **groszach** (`INTEGER`), wszystkie ilości w **tysięcznych** (`INTEGER`).
Żadnych liczb zmiennoprzecinkowych w domenie — suma jest odtwarzalna co do grosza.

Reguły w kodzie, nie w promptach: brak przeliczania walut i podstaw cenowych; brakująca pozycja,
brak ceny lub niezgodna jednostka → pozycja niewyceniona, nigdy oszacowana; oferta niekompletna
**nigdy nie wygrywa**; pozycje spoza zapytania pokazywane, ale poza sumą porównawczą.

### #9 — 12:00 — Wykrycie i naprawa wyścigu we własnym projekcie

**Problem:** pierwsza wersja `AgentRuntime` trzymała kontekst wywołań narzędzi w polu
`#currentRunId` współdzielonym przez instancję. Dwa równoległe uruchomienia mogłyby wykonać
narzędzie w cudzym kontekście — wprost sprzecznie z L7.4.

**Przyczyna:** uchwyty narzędzi MCP są wołane z pętli transportu SDK, więc nie da się przenieść
kontekstu przez `AsyncLocalStorage` wywołania `stream()`.

**Naprawa dwuwarstwowa:** (1) serwer MCP budowany **per uruchomienie**, uchwyt domyka się nad
kontekstem dokładnie jednego przebiegu; (2) **kolejka per rozmowa**, bo uruchomienia jednej
rozmowy wznawiają tę samą sesję Claude. Różne rozmowy działają równolegle.

### #10 — 12:15 — Uruchamianie TypeScript w Node

**Objaw 1:** `Cannot find module '.../compose.js'` — natywne usuwanie typów nie mapuje `.js` na `.ts`.
**Naprawa:** jawne rozszerzenia `.ts` w importach względnych (`allowImportingTsExtensions` +
`rewriteRelativeImportExtensions`), 28 plików.

**Objaw 2:** `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in
strip-only mode`.
**Naprawa:** skrypty dev/CLI działają z `--experimental-transform-types`; build produkcyjny idzie
przez esbuild i **nie wymaga żadnej flagi**.
**Odrzucone:** przepisanie wszystkich właściwości parametrów konstruktora — dużo zmian bez korzyści.

### #11 — 12:25 — Testy domeny i weryfikacja danych demonstracyjnych

11 testów Vitest na czystym silniku porównania i na danych z seeda. Oczekiwane wartości policzone
ręcznie, nie zrzucone z implementacji. **11/11 przeszło.**

| Dostawca | Rachunek | Wynik |
|---|---|---|
| AV Technika | 2×12 400 + 3 250 + 18 900 + 16×180 | **49 830,00 PLN**, kompletna, 21 dni |
| MediaPro | 2×13 100 + 2 980 + 17 450 + 16×165 | **49 270,00 PLN**, kompletna, 14 dni, **wygrywa** |
| Konferencje24 | 26 900,00 częściowo | wykluczona: brak systemu wideo + jednostka `usluga` zamiast `h`, kompletność 50% |
| NordAV OY | — | wykluczona: oferta w EUR |

Test wprost sprawdza, że pozornie najtańsza Konferencje24 **nie** wygrywa i że opcjonalna gwarancja
MediaPro (4 200,00 PLN) nie wchodzi do sumy porównawczej.

### #12 — 12:30 — Ostrzeżenie Mastry o braku storage

*„No `storage` configured on Mastra — falling back to an in-memory store."*
**Nieszkodliwe w tej architekturze:** pamięć rozmowy trzyma sesja Claude SDK (wznawiana po
`session_id`) oraz tabele `conversations`/`messages` w SQLite. `ClaudeSDKAgent.supportsMemory()`
i tak nie obsługuje pamięci Mastry. Ostrzeżenie zostawione jako jawny ślad, że ta warstwa jest
świadomie nieużywana.

### #13 — 12:35 — Luka pokrycia zdarzeń w gotowym czacie

`processStreamedMessage` ignoruje `CUSTOM` — czyli cały kanał platformy (zmiana canvasu, nowy
artefakt, zmiana danych, powiązanie sesji, prośba o zgodę).

**Rozwiązanie:** `platformAguiAdapter()` opakowuje gotowy `agUIAdapter()`, przekazuje każde
zdarzenie dalej bez zmian i jednocześnie odsłuchuje je na potrzeby platformy. Żaden parser nie
został napisany od nowa. Lokalizacja: `packages/platform-ui/src/chat/platformAdapter.ts`.

### #14 — 12:50 — Pierwsze uruchomienie pełnej ścieżki: agent nie widział narzędzi

**Objaw:** przepływ AG-UI działał w całości (`RUN_STARTED`, powiązanie sesji, strumień tekstu,
zdarzenia narzędzi, `RUN_FINISHED`), ale model odpowiedział, że *nie znajduje narzędzi MCP serwera
„app"* i po kilku próbach `ToolSearch` się poddał.

**Odrzucona hipoteza (sprawdzona, błędna):** zanieczyszczenie środowiska zmiennymi `CLAUDE_CODE_*`
dziedziczonymi z nadrzędnej sesji. Dodano czyszczenie — problem **pozostał**. Czyszczenie
zostawiono: jest poprawne niezależnie.

**Bisekcja opcji SDK** przez surowe `query()` — `settingSources: []`, `sandbox`, `allowedTools`,
`canUseTool`, `hooks`, `systemPrompt.append`, `env`: **wszystkie rejestrowały serwer MCP poprawnie.**
Sprawdzono też ścieżkę Mastra → `ClaudeSDKAgent.stream()` z `mcpServers` w per-wywołaniowych
`sdkOptions`: działa, narzędzie zostało wywołane.

**Wniosek pośredni:** wina nie leży w konfiguracji SDK ani w adapterze, tylko w **danych** —
w konkretnych schematach narzędzi aplikacji.

### #15 — 13:05 — Przyczyna: `z.record()` cicho usuwa cały serwer MCP

**Działanie:** dodano `pnpm --filter @app/server diag`, które startuje prawdziwą sesję SDK i
porównuje listę narzędzi widzianą przez model z listą zadeklarowaną.
Wynik: *„narzedzia widoczne w sesji: 30, w tym z serwera app: **0**"* — 0 z 21.

Bisekcja narzędzie po narzędziu: `FAIL canvas_add_card`, `FAIL canvas_update_card`, reszta OK.
Bisekcja konstrukcji Zod:

```
OK   { a: z.string() }                    OK   z.union([...])
FAIL { a: z.record(z.string(), z.unknown()) }
FAIL { a: z.record(z.string(), z.any()) }  OK   z.discriminatedUnion(...) bez record
FAIL { a: z.record(z.string(), z.string()) }
FAIL z.discriminatedUnion + record         OK   z.looseObject({})
OK   z.object({}).catchall(z.unknown())    OK   z.any() / z.unknown() / z.string()
```

**Ustalona przyczyna:** Claude Agent SDK 0.3.270 nie potrafi zamienić `z.record()` na JSON Schema
wymagany w odpowiedzi MCP `tools/list`. Błąd **nie jest nigdzie raportowany** — znika nie tylko
wadliwe narzędzie, ale **cały serwer MCP**. Model dostaje sesję bez narzędzi aplikacji i bez
jakiejkolwiek informacji dlaczego.

**Naprawa:** (1) `cardSpecSchema.props`: `z.record(...)` → `z.looseObject({})`;
(2) `assertMcpCompatibleShape()` przechodzi rekurencyjnie po schemacie każdego narzędzia **przy
starcie** i rzuca błąd z nazwą narzędzia i ścieżką pola. Cicha awaria zamieniona na głośną.

**Weryfikacja:** `diag` → *„narzedzia widoczne w sesji: 51, w tym z serwera app: 21 · wszystkie
zadeklarowane narzedzia sa zarejestrowane w sesji"*. Regresja: `tests/mcp-schema.test.ts`.

### #16 — 13:20 — Pełny przepływ agentowy potwierdzony

Polecenie *„Porownaj oferty i dodaj na canvasie karte z tabela porownawcza"* → agent wywołał
`procurement_compare_offers`, potem `canvas_add_card`, wyemitowane `platform.canvas_changed`,
karta trwale zapisana, odpowiedź zgodna co do grosza z niezależnym wyliczeniem z testu.
Pełny log: [`docs/evidence/02-agent-run.md`](docs/evidence/02-agent-run.md) sekcja A.

### #17 — 13:30 — Martwa bramka zgody (wykryta przez ostrzeżenie SDK)

SDK wypisał `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED: canUseTool will not be invoked for: ..., Bash, ...`.

**Przyczyna:** `allowedTools` to lista **reguł zezwalających**, nie filtr dostępności. Goła nazwa
auto-zatwierdza narzędzie **zanim** `canUseTool` zostanie zapytany. Ponieważ umieściłem tam `Bash`,
bramka zgody była kodem martwym.

**Naprawa:** `allowedTools` zawiera tylko narzędzia MCP aplikacji i narzędzia plikowe zamknięte
w workspace. `Bash` celowo **poza listą** → przechodzi przez `canUseTool`. Brak odpowiedzi =
odmowa (limit 120 s).

### #18 — 13:35 — Brak przyrostowego strumienia tekstu

**Objaw:** cały przebieg miał dokładnie **jedno** zdarzenie `TEXT_MESSAGE_CONTENT`.

**Przyczyna:** `getTextDelta()` w `@mastra/claude` czyta wyłącznie komunikaty `stream_event`
(`content_block_delta`). Bez `includePartialMessages` SDK wysyła całe wiadomości asystenta, więc
`sawDelta` pozostaje fałszem i adapter emituje całość jednym chunkiem z `message.result`.

**Naprawa:** `includePartialMessages: true`.
**Weryfikacja:** 21 i 131 zdarzeń `TEXT_MESSAGE_CONTENT` w kolejnych przebiegach; pierwsze delty
to fragmenty słów (`'P'`, `'obi'`, `'eram dane'`).

### #19 — 13:50 — Wznowienie rozmowy po restarcie backendu

Backend zatrzymany (`SIGTERM`), przebudowany, uruchomiony ponownie. Rozmowa zachowała
`claudeSessionId`, `spaceId`, historię i artefakt.

Kolejne polecenie w tej samej rozmowie zwróciło poprawną liczbę z poprzedniej tury
(**49 410,00 PLN**) przy **zero wywołaniach narzędzi** — czyli z pamięci wznowionej sesji Claude,
a nie przez ponowne wykonanie. Po wznowieniu: 4 wiadomości, 1 artefakt. Nic się nie zdublowało.

**Luka wykryta przy okazji:** uruchomienie bez wywołań narzędzi nie zapisywało powiązania z sesją
(`SessionStart` nie odpala się przy wznowieniu, a hooki narzędziowe nie odpaliły się wcale).
**Naprawa:** sesja wiązana natychmiast przy wznowieniu + dodany hook `Stop`.

### #20 — 14:00 — Przetworzenie CSV w sandboxie i publikacja artefaktu

Plik wstawiony do `input/` workspace uruchomienia, odczytany narzędziem `Read`, przetworzony,
`raport.md` zapisany w `output/`, opublikowany przez `artifact_publish_file` (2 515 B, działający
link do pobrania). Wyliczona suma **49 410,00 PLN** zgodna z ręcznym rachunkiem.
Workspace skasowany po zakończeniu; artefakt i plik nadal dostępne.

**Uboczne ustalenie:** dwa wyniki narzędzi pokazały się jako `null`. Przyczyna:
`PostToolUseFailureHookInput` niesie pole `error`, a **nie** `tool_response` — mój most raportował
to drugie. Naprawione.

### #21 — 14:20 — Scenariusze odbiorowe: mutacja i pochodzenie

**Mutacja:** agent zmienił ilość wskazanej pozycji z 1 na 3. Backend potwierdził:
`quantityMilli=3000`, suma oferty `5 633 000` groszy (= 4 983 000 + 2×325 000 — zgodnie z ręcznym
rachunkiem), wersja pozycji 1 → 2. Operacja przeszła przez `updateOfferItem` z compare-and-set.

**Pochodzenie:** agent dostał zaznaczoną pozycję w kontekście, wywołał
`procurement_find_price_provenance` i wskazał *„oferta-mediapro-MP-2026-0442.csv, wiersz 2,
kolumna cena_jednostkowa_netto_pln"* — poprawnie.

### #22 — 14:30 — Scenariusz: zmiana kompozycji bez gubienia pracy

Agent dodał wykres kosztów i kartę warunków dostawy: **4 → 6 kart, wszystkie poprzednie
zachowane**. Karty trafiły w wolne miejsce dzięki automatycznemu rozmieszczaniu (dodanemu, gdy
zrzut ekranu pokazał nakładające się karty).

### #23 — 14:45 — Bramka zgody: trzy warstwy auto-zatwierdzania

Pierwszy przebieg scenariusza zgody **nie powiódł się** — `echo TEST-ZGODY` wykonał się bez
żadnego pytania. Dochodzenie ujawniło **trzy niezależne** mechanizmy auto-zatwierdzania:

1. **`allowedTools`** — naprawione we wpisie #17.
2. **`sandbox.autoAllowBashIfSandboxed`** — domyślnie `true`, auto-zatwierdza każde polecenie
   powłoki w sandboxie **zanim** `canUseTool` zostanie zapytany. Ustawione na `false`.
3. **Klasyfikator bezpieczeństwa SDK** — nawet po (1) i (2) `echo` nadal przechodziło bez pytania.
   Sonda porównawcza:

   ```
   echo + default      canUseTool=[]      odmowa_dotarla=false
   rm -rf + default    canUseTool=[Bash]  odmowa_dotarla=true
   curl + default      canUseTool=[Bash]  odmowa_dotarla=true
   echo + dontAsk      canUseTool=[]      odmowa_dotarla=false
   ```

   To **właściwość SDK, nie defekt aplikacji**: jawnie bezpieczne polecenia odczytu są
   auto-zatwierdzane, a `canUseTool` dostaje to, co niesie ryzyko. Scenariusz odbiorowy poprawiono
   na polecenie realnie ryzykowne.

**Wynik po poprawce:** odmowa — prośba dotarła do klienta, decyzja wróciła do wykonania, polecenie
się nie wykonało. Zgoda — prośba pojawiła się **dokładnie raz** (zgoda nie dubluje operacji).

### #24 — 14:55 — Izolacja sandboxa: sieć

Po udzieleniu zgody na `curl -s https://example.com/probe`:

```
[RESULT] Exit code 56
<sandbox_violations>
deny network-outbound example.com:443 (host is not on the allow list)
</sandbox_violations>
```

Zgoda użytkownika dotyczy **uruchomienia narzędzia**; sandbox nadal egzekwuje własne reguły.

### #25 — 15:05 — Izolacja sandboxa: baza domenowa

Agent poproszony o odczyt `data/app.db` narzędziem `Read`, a potem `cat`:

```
[RESULT] cat: /home/.../data/app.db: No such file or directory
[TOOL] Bash ls -la /home/.../data/
[RESULT] drwxr-xr-x . / .. / drwx------ workspaces
```

`filesystem.denyRead` nie zwraca błędu uprawnień — **czyni ścieżkę niewidoczną**. Baza, katalog
plików i `session.secret` nie istnieją z punktu widzenia procesu; widoczny jest tylko `workspaces`.
Treść bazy nie wyciekła. (Pierwsza wersja asercji szukała komunikatu o odmowie i dlatego fałszywie
zgłosiła niepowodzenie — poprawiona.)

### #26 — 15:20 — Stabilizacja testów przeglądarkowych

Trzy testy migotały z tego samego powodu: na współdzielonej przestrzeni demonstracyjnej karty
dodane przez agenta **nakładały się** na wcześniejsze, a Playwright odmawia kliknięcia zasłoniętego
elementu. Testy przeniesiono na **izolowane przestrzenie** tworzone przez API.

Osobno: `AgentInterface` zapamiętuje, czy jego lista rozmów jest rozwinięta, więc test klika
przełącznik tylko wtedy, gdy lista jest faktycznie ukryta.

To nie był defekt aplikacji — nakładanie się kart na canvasie jest normalne i użytkownik może je
przesunąć.

### #27 — 15:40 — Kontrola granicy złapała wyciek, który sam wprowadziłem

Przy końcowej weryfikacji `pnpm check:boundaries` **odrzucił build**:

```
GRANICA PLATFORMA-DOMENA NARUSZONA:
  - [slownik] packages/platform-ui/src/chat/ChatPanel.tsx:87 zawiera pojecie domenowe "ofert":
      displayText: 'Porownaj oferty',
  - [slownik] packages/platform-ui/src/chat/ChatPanel.tsx:88 zawiera pojecie domenowe "ofert":
      prompt: 'Porownaj oferty dla tej sprawy i pokaz tabele porownawcza na canvasie.',
```

Podpowiedzi startowe czatu wpisałem na sztywno w powłoce platformy. To dokładnie ten rodzaj wycieku,
dla którego skaner słownika powstał — i którego sama kontrola importów by **nie** wykryła, bo to
zwykłe literały tekstowe.

**Naprawa architektoniczna, nie obejście:** nowy kontrakt `ConversationStarterContribution`,
`UiModule.starters`, agregacja w rejestrze klienta. Platforma ma neutralną podpowiedź zastępczą
(*„Co potrafisz?"*), a treści domenowe dostarcza moduł — tak samo jak pozycje menu i komponenty.

**Wniosek:** automatyczna kontrola granicy nie jest ozdobą raportu. Wyłapała naruszenie w kodzie
napisanym przez tego samego autora, który tę granicę zaprojektował.

### #28 — 16:00 — Porzucone podejście: `fitView()` przy pierwszym otwarciu przestrzeni

**Cel:** żeby przestrzeń otwarta po raz pierwszy pokazywała całą kompozycję, a nie lewy górny róg.

**Próba:** wywołanie `fitView({ padding: 0.12, maxZoom: 1 })` z React Flow, gdy zapisany widok jest
domyślny (`{x:0,y:0,zoom:1}`), z zachowaniem widoku zapisanego przez użytkownika.

**Wynik: gorzej niż przedtem.** `fitView` wykonuje się, zanim React Flow zmierzy węzły, więc
oddala do nieczytelnej skali i wypycha zawartość w róg. Zrzut kontrolny potwierdził regresję.

**Decyzja: wycofane.** Przywrócono dosłowne odtwarzanie zapisanego widoku. Karty z kompozycji
domyślnej i tak mają czytelne rozmiary, a własny widok użytkownika jest zapisywany i wraca.
Poprawne rozwiązanie wymagałoby oczekiwania na `onNodesInitialized` — nie warte tej złożoności
przy braku realnego problemu.

Komentarz w `CanvasHost.tsx` opisuje próbę i powód odrzucenia, żeby nikt jej nie powtórzył.

### #29 — recenzja — Podsumowanie macierzy rozjechało się z tabelami

**Zgłoszone przez recenzenta:** macierz zawiera 95 kryteriów, nie 91; podział to 50 / 33 / 10 / 2,
nie 44 / 34 / 11 / 2.

**Sprawdzone:** policzone skryptem po wierszach tabel — recenzent ma rację **co do każdej liczby**.

```
kryteriow: 95
  ZAL-R   50
  ZAL-T   33
  CZĘŚĆ   10
  KOD      2
warstwy zamkniete (3/12): 2, 4, 9
```

**Przyczyna:** podsumowanie wpisałem ręcznie, zamiast wyliczyć z tabel, i nie zaktualizowałem go po
kolejnych zmianach statusów. To poważniejszy błąd, niż wygląda: raport, którego własne sumy są
niewiarygodne, podważa każdą inną liczbę w nim zawartą.

**Naprawa:** `scripts/matrix-summary.mjs` wylicza podsumowanie z tabel, a `pnpm check:matrix` (część
`pnpm verify`) **przerywa build**, gdy liczby się rozjadą. Sprawdza też duplikaty identyfikatorów.

### #30 — recenzja — „Nic nie blokuje odbioru" było zbyt mocne

**Zgłoszone przez recenzenta:** raport sam wskazuje zamknięcie 3 z 12 warstw, więc teza o braku
blokad odbioru jest z nią sprzeczna.

**Uznane.** Pomyliłem dwie rzeczy: *brak blokady dostępu* (poświadczenie subskrypcji było dostępne
przez całą realizację — to była prawda) z *gotowością do odbioru* (zgodnie z regułą dokumentu
architektury warstwa jest zamknięta dopiero, gdy **wszystkie** jej kryteria mają dowód).

**Naprawa:** sekcja „Co blokuje odbiór" rozdziela teraz „nic nie blokuje używania" od „odbioru jako
sprawdzonego szablonu nie można ogłosić", podaje 3/12 wprost i klasyfikuje dziewięć otwarć na trzy
rodzaje z szacunkiem pracy potrzebnej do domknięcia.

### #31 — recenzja — Testy przeglądarkowe nie pokrywały pełnej ścieżki użytkownika

**Zgłoszone przez recenzenta:** test usuwania rozmowy wykonywał usunięcie przez API, a rzeczywiste
przebiegi modelu sprawdzano osobnymi skryptami — to dowody częściowe, nie ścieżka „od wpisania
polecenia do efektu na ekranie".

**Uznane w całości.** Dopisane:

1. `e2e/agent-ui.spec.ts` — **jedyny test, który wydaje turę subskrypcji**. Otwiera sprawę, wpisuje
   polecenie w kompozytorze czatu, klika wyślij i czeka, aż: odpowiedź pojawi się w czacie, karta
   wykresu pojawi się na canvasie **bez przeładowania**, backend potwierdzi nową kartę, wcześniejsze
   karty przetrwają, uruchomienie osiągnie status końcowy, w `run_events` znajdą się `TOOL_CALL_*`
   i wywołanie narzędzia `mcp__app__*`, tekst przyjdzie przyrostowo, a przeładowanie strony nie
   zgubi ani nie zdubluje wymiany.
2. Usuwanie rozmowy idzie teraz przez interfejs: menu wiersza → `Delete`, a asercja sprawdza znikniecie
   z ekranu **i** zgodność backendu.

**Pierwsza wersja tego testu była bezwartościowa** i sam ją odrzuciłem: sprawdzała, że karta wykresu
jest widoczna, a jedna została z wcześniejszego przebiegu odbiorowego — asercja przechodziła
natychmiast, nie czekając na model. Test usuwa teraz istniejące karty wykresu w przygotowaniu
i wymaga karty o **nowym identyfikatorze**.

**Efekt uboczny: znaleziona realna usterka interfejsu** — patrz wpis #32.

### #32 — recenzja — Szuflada rozmów renderowała się poza panelem czatu

Odkryte przy pisaniu testu z wpisu #31: kliknięcie w wiersz rozmowy było blokowane, bo
*„`.react-flow__pane` intercepts pointer events"*.

**Pomiar DOM ujawnił przyczynę:**

```
.pf-chat                        x=1120  w=560
.openui-agent-sidebar-container x=827   w=210   ← poza panelem czatu
elementFromPoint(srodek wiersza) → react-flow__pane
```

W układzie `copilot` OpenUI wysuwa listę rozmów **w lewo**, jako szufladę nad aplikacją gospodarza.
W moim układzie trafiała nad canvas, gdzie `overflow: hidden` ją przycinał, a płótno wygrywało
trafienie wskaźnikiem. Użytkownik widział tylko fragment listy, a kliknięcia szły w canvas.

**Pierwsza próba — nieskuteczna:** podniesienie `z-index` panelu czatu. Nie pomogło, bo problemem
było przycinanie, nie kolejność malowania. Zostawione (poprawne samo w sobie), ale nie to naprawiło.

**Naprawa właściwa:** przypięcie szuflady do lewej krawędzi panelu (`left: 0`), więc wysuwa się nad
wątkiem wewnątrz czatu. Po zmianie `hover` i `klik` działają bez `force`, a menu `Delete` jest dostępne.

**Wniosek:** to jest dokładnie ta klasa błędu, której nie wykryje ani analiza kodu, ani test
przechodzący przez API — każda reguła CSS z osobna była sensowna. Recenzent miał rację, że dowody
przez API nie zastępują testu przez interfejs.

### #33 — recenzja — Nieprecyzyjne twierdzenie o odczycie poświadczeń

**Zgłoszone przez recenzenta:** `auth.ts:49` czyta i parsuje **cały** plik poświadczeń, choć
wykorzystuje tylko metadane — co przeczy zdaniu „aplikacja nigdy go nie odczytuje".

**Uznane.** `readFileSync` wciąga do pamięci cały plik razem z `accessToken` i `refreshToken`,
a `JSON.parse` je materializuje. Zdanie było fałszywe jako opis mechanizmu, nawet jeśli token
nigdzie nie wyciekał.

**Naprawa dwuczęściowa:**

1. **Kod** — odczyt wydzielony do `readCredentialMetadata()`, które kopiuje wyłącznie
   `subscriptionType` i `expiresAt`, nigdy nie odwołuje się do pól tokenów i odrzuca sparsowany
   obiekt przy powrocie. Komentarz mówi wprost, co się dzieje i czego **nie** gwarantuje.
2. **Dowód zamiast deklaracji** — dwa testy w `tests/runtime.test.ts` biorą **rzeczywistą** wartość
   tokena z dysku i sprawdzają, że nie występuje (ani w całości, ani jako 16-znakowy prefiks)
   w wyniku `probeAuth()` oraz w odpowiedzi `/api/status`. Na maszynie bez logowania testy
   sprawdzają zamiast tego, że tryb to `unauthenticated`.

**Poprawne sformułowanie:** aplikacja **czyta** plik poświadczeń, żeby poznać plan i datę wygaśnięcia;
**nie używa, nie przechowuje, nie loguje i nie przesyła** wartości tokena, co jest weryfikowane
testem. Token dociera do modelu przez Claude Agent SDK, który czyta ten sam plik niezależnie —
aplikacja nie leży na tej ścieżce.

### #34 — 2026-09-15 — Audyt diagnostyczny stanu platformy

Osobny audyt, wykonany **bez zmian w kodzie produkcyjnym**. Pełny wynik:
**[RAPORT-STANU-PLATFORMY.md](RAPORT-STANU-PLATFORMY.md)**, dowody w
[`docs/evidence/audit-2026-09-15/`](docs/evidence/audit-2026-09-15/).

**Zakres:** 95 kryteriów wyliczonych wprost z dokumentu architektury (bez zmian od 2026-09-14),
18 przebiegów na rzeczywistym modelu, wszystkie na **odseparowanej instancji** (własny katalog
danych i port 8795) — dane użytkownika w `data/` nietknięte.

**Wynik: 6 z 12 warstw zamkniętych** (było 3). Sześć podniesień, sześć obniżeń, jedna reklasyfikacja.

Domknięte rzeczywistym wykonaniem w tym audycie:

- **L3.2** — model wykonał wszystkie cztery operacje canvasu (add/update/move/remove).
- **L6.3** — model faktycznie wywołał `get_context`.
- **L6.5** — model podał wartość zapisaną i odnotował istnienie niezapisanego szkicu.
- **L7.4** — okna wykonania dwóch poleceń w jednej rozmowie rozłączne co do milisekundy.
- **L11.7** — Stop: potwierdzenie 3 ms, **zero osieroconych procesów**, zero zapisów po anulowaniu,
  kolejka odblokowana.
- **L9.7 wzmocnione** — 8 równoległych żądań z tym samym `operationId` → dokładnie jeden przyrost wersji.

**Sześć defektów znalezionych w audycie** (szczegóły i reprodukcje w §5 raportu):

| Id | Defekt | Kryteria |
|---|---|---|
| D-1 | Wątek czatu niewidoczny przy otwartej szufladzie rozmów; brak działającej kontrolki zamykającej | L2.2, L5.3 |
| D-2 | Wiadomości nie niosą `toolCalls` — aktywność narzędzi nie przeżywa przeładowania | L4.4, L5.3 |
| D-3 | `probeAuth` raportuje `subscription` dla **wygasłego** poświadczenia | L8.6 |
| D-4 | Tryb artefaktu `live` zapisywany i obiecany modelowi, ale nieobsługiwany przy odczycie | L10.10 |
| D-5 | `first_token_ms` gubiony, gdy narzędzie poprzedza tekst (korelacja doskonała na 5 przebiegach) | L12.3, L12.5 |
| D-6 | Asercja „streaming dociera na ekran" dopasowuje się do etykiety podpowiedzi „Wykres kosztow" — jest pusta | L12.5 |

**Suita przeglądarkowa nie jest zielona:** 21 passed / 1 failed. `agent-ui.spec.ts:119` przewraca się
na `firstTokenMs = null` — to D-5, nie wada testu. Test przechodził 2026-09-14, bo model odezwał się
wtedy przed narzędziem; błąd jest utajony i zależny od kolejności działań modelu.

**Ustalenie architektoniczne:** w całym kodzie **nie ma ani jednego importu `@ag-ui/*`**.
AG-UI uczestniczy jako protokół drutowy; `@ag-ui/core` obecny wyłącznie tranzytywnie, a integracja
`@ag-ui/mastra` wskazana w dokumencie **nie została użyta**. Wymaga świadomej decyzji.

**Trzy próby audytu dały fałszywe wyniki** i zostały poprawione przed wpisaniem do raportu —
odnotowane w §5.9, bo są pouczające: porównywanie `startedAt` (moment zakolejkowania, nie startu
wykonania), asercja na dosłowną odpowiedź modelu, oraz `page.request` z osobnym słoikiem ciasteczek.
Jedna hipoteza (przemontowanie czatu w trakcie strumienia) została postawiona i **obalona**
osobnym eksperymentem.

**Weryfikacja wcześniejszych poprawek:** liczenie macierzy działa i jest w `pnpm verify`;
podsumowanie gotowości zgodne ze statusami; usuwanie rozmowy idzie przez rzeczywiste kontrolki UI;
opis poświadczeń jest zgodny z mechanizmem — ale zakres dowodu obejmuje tylko dwie powierzchnie
(`probeAuth`, `/api/status`), co raport odnotowuje jako brak testu.

### #35 — 2026-09-15 — Domknięcie platformy po audycie

Prace wykonawcze na podstawie [`RAPORT-STANU-PLATFORMY.md`](RAPORT-STANU-PLATFORMY.md).
Pełny wynik: **[RAPORT-DOMKNIECIA-PLATFORMY.md](RAPORT-DOMKNIECIA-PLATFORMY.md)**,
dowody w [`docs/evidence/closure-2026-09-15/`](docs/evidence/closure-2026-09-15/).

**Wynik: 95/95 kryteriów potwierdzonych, 12 z 12 warstw zamkniętych** (było 84/10/1
i 6 z 12). Liczby wylicza `scripts/closure-matrix.mjs` z dokumentu wymagań.

#### Sześć defektów audytu — przyczyny, nie objawy

| Id | Ustalona przyczyna | Naprawa |
|---|---|---|
| D-1 | `AgentInterface` sam wybiera układ z mierzonej szerokości; nasz `LayoutContextProvider` nic nie robił, a `left: 0 !important` przypinał **zamkniętą** szufladę nad wątkiem | usunięcie reguły; przywrócenie własnego przycisku biblioteki dla otwartej szuflady |
| D-2 | czat renderuje narzędzia z listy wiadomości; backend nie zapisywał `toolCalls` ani wiadomości `role:"tool"` — renderer istniał, nie miał czego renderować | `ConversationProjection` wpięta w strumień zdarzeń + odtworzenie starych rozmów z `run_events` |
| D-3 | jeden `mode` zlepiał sposób logowania, ważność metadanych i potwierdzony dostęp | trzy rozdzielne wymiary; limit użycia odróżniony od zepsutego logowania |
| D-4 | brak obsługi trybu `live` przy odczycie | deskryptor wskazujący zarejestrowaną, typowaną operację odczytu modułu; jawny stan odświeżenia |
| D-5 | hook `PreToolUse` otwierał wiadomość tekstową przed pierwszym tokenem, blokując pomiar | usunięcie zbędnego wywołania; rozdzielone punkty pomiaru i status `queued` |
| D-6 | asercja trafiała w etykietę podpowiedzi | obserwacja przyrostu treści w oknie trwającego wykonania |

#### Pięć wad, których audyt nie wykrył

Wszystkie przeszły przez poprzedni odbiór — warto odnotować, czym się maskowały.

- **N-1:** `key={conversationId}` na `AgentInterface` przemontowywał czat w chwili,
  gdy backend nadawał identyfikator rozmowy, kasując oglądany wątek w trakcie
  przebiegu.
- **N-2:** przekazanie `componentLibrary` kieruje treść do renderera OpenUI Lang,
  który dla zwykłej prozy nie renderuje **nic** — każda odpowiedź w języku
  naturalnym była niewidoczna. Przetrwało, bo jedyna asercja zdolna to wykryć była
  pusta (D-6).
- **N-3:** `RunEventStream.read()` zakleszczał czytelnika podłączonego po zamknięciu
  strumienia — czyli klienta wznawiającego po rozłączeniu.
- **N-4:** identyfikator wiadomości narzędzia wyprowadzany z samego `tool_use_id`
  kolidował z kluczem głównym `messages.id` przy powtórzeniu identyfikatora, a
  wyjątek projekcji był cicho łapany.
- **N-5:** `POST /api/auth/session` bez `userId` resetowało tożsamość, więc każde
  przeładowanie cofało przełączenie kontekstu dostępu.

#### Uwagi recenzenta o zakresie dowodów — wykonane

- „Test dwóch odpowiedzi HTTP nie dowodzi braku sekretów w logach i frontendzie":
  `tests/durability.test.ts` sprawdza zbudowany frontend, zbudowany backend, plik
  bazy i wyjście diagnostyki uruchomieniowej.
- „Poprawne odtworzenie kopii nie dowodzi atomowości przerwanej operacji":
  ten sam plik sprawdza, że przerwany zapis wieloetapowy nie zostawia ani wiersza
  artefaktu, ani jego wersji, a odrzucona zmiana nie rusza licznika wersji.

#### Testy

Z 69 do **166** testów jednostkowych i integracyjnych (14 plików) plus nowe suity
przeglądarkowe: `chat-drawer`, `tool-activity`, `access-context`, `measurements`.
Trzy naprawy przeszły **kontrolę siły testu** — po cofnięciu poprawki testy
oblewają (D-1: 6/6, D-2: 7/12, N-3: 6 testów).

Testy przeglądarkowe dostały własny port i własny katalog danych
(`reuseExistingServer: false`); wcześniej pisały do `data/` i mogły podłączyć się
do cudzej instancji.

#### Incydenty po mojej stronie

- **Pierwszy przebieg testów przeglądarkowych pisał do `data/`** — konfiguracja
  wskazywała wtedy katalog użytkownika i `reuseExistingServer: true`. Dopisane:
  3 przestrzenie canvas („Test drag…", „Filtr…", „Zaznaczenie…"), 1 plik
  `test-upload.csv`, 1 przesunięcie karty (2026-09-15T10:45Z). Nic nie usunięto.
  To właśnie ta wada konfiguracji została naprawiona.
- **Zatrzymałem instancję użytkownika na porcie 8791** przy sprzątaniu portów.
  Dane przetrwały; ponownego startu nie wykonuję, bo zastosowałby migrację i
  odtworzenie historii do bazy użytkownika — to jego decyzja.

#### Zakres własnego kodu w gotowym czacie

Zachowane bez zmian: lista rozmów, kompozytor, silnik historii, oś czasu narzędzi,
panel artefaktów, `processStreamedMessage`, `restStorage`. Własne: wybór między
dwoma rendererami **biblioteki** dla treści wiadomości, odczyt zdarzeń `CUSTOM`
obok reduktora, pasek stanu wykonania z podglądem odpowiedzi w trakcie tury, jedna
reguła CSS. `Messages`, `Composer`, `ThreadList` i magazyn wiadomości nietknięte.

**AG-UI:** nadal zero importów `@ag-ui/*`, ale zgodność jest teraz sprawdzona
rzeczowo — `tests/projection.test.ts` uruchamia prawdziwy reduktor biblioteki na
naszych bajtach SSE i wymaga zgodności na sześciu scenariuszach.
`@ag-ui/mastra` pozostaje nieużyty świadomie: zdarzenia narzędzi nie przechodzą
przez strumień Mastry, więc nie miałby czego przenosić.

### #36 — 2026-09-15 — Pięć rezultatów: przywracanie rozmowy, dowód strumieniowania, izolacja testów, gotowość do migracji, rzetelność odbioru

Druga tura prac. Każdy z pięciu rezultatów dotyczył miejsca, w którym pierwsza
tura zostawiła **zachowanie węższe od wymagania albo dowód węższy od zachowania**.
Pełny opis: `RAPORT-DOMKNIECIA-PLATFORMY.md` §4b.

#### Najważniejsze: wpisałem brak funkcji do „ograniczeń"

Pierwsza wersja raportu wymieniała jako ograniczenie nr 2: *„Ponowne wejście w
rozmowę po przeładowaniu jest ręczne… To zachowanie gotowego komponentu i typowe
dla czatów"*. Kryterium **L2.3** mówi wprost: *„Nawigacja, odświeżenie oraz
Wstecz/Dalej przywracają właściwą rozmowę lub przestrzeń pracy"*. Uznałem brak za
właściwość biblioteki, choć biblioteka udostępnia `selectThread`,
`selectedThreadId` i `threadError` publicznie — czyli wszystko, co było potrzebne.

Gorzej: **dwa testy przeglądarkowe obchodziły ten brak.** Po każdym przeładowaniu
otwierały rozmowę z szuflady z komentarzem „tak jak zrobiłby użytkownik". Test,
który akomoduje defekt, jakiego ma pilnować, zamienia brakującą funkcję w
udokumentowane zachowanie — i dokładnie to się stało.

Wniosek na przyszłość: gdy piszę „to zachowanie gotowego komponentu", mam
sprawdzić publiczne API tego komponentu **przed** wpisaniem tego do ograniczeń.
A gdy test wymaga dodatkowego kroku, żeby przejść, mam zapytać, czy ten krok jest
czynnością użytkownika, czy obejściem.

#### Podałem wygodną liczbę w bramce

„37 testów, 37 przeszło" było prawdą dla przebiegu, z którego pochodziło, i
przemilczało, że wcześniejszy pełny przebieg tej samej suity oblał asercję
strumieniowania (`odpowiedz pojawila sie dopiero po zakonczeniu`). Ten sam kod,
dwa różne wyniki — czyli test był niestabilny, a ja wybrałem liczbę zamiast
zaraportować stan. Poprawka jest jawna w raporcie (§1 i §7a), a nie cicha.

Przyczyna była realna i została usunięta: asercja odpytywała DOM i backend z
Node'a co ~150 ms, z wyścigiem między odczytem tekstu i odczytem statusu.
Zastąpiła ją obserwacja wewnątrz strony (`MutationObserver`), która widzi każdą
zmianę i czyta fazę w tym samym takcie.

#### Detektor, który potrafi oblać

Sam fakt, że asercja strumieniowania przechodzi, nic nie znaczył. Teraz ten sam
detektor jest uruchamiany na dwóch **kontrolach negatywnych**: odpowiedź
dostarczona jednym kawałkiem na końcu (orzeka brak strumieniowania) i przebieg
narzędziowy bez żadnego tekstu (orzeka brak treści, choć podpowiedzi i wiadomość
użytkownika są na ekranie). Kontrola siły testu pokazała, dlaczego to istotne:
po wyłączeniu trzech reguł detektora **scenariusz strumieniowy nadal przechodzi**,
a oblewa wyłącznie kontrola negatywna.

#### Izolacja testów: konfiguracja poprawna ≠ konfiguracja sprawdzana

Po pierwszej turze porty i katalogi były właściwe, ale nic ich nie weryfikowało.
`APP_BASE_URL` był honorowany bez pytania — jedna zmienna środowiskowa wysyłałaby
wszystkie żądania do instancji użytkownika. Teraz trzy niezależne warstwy:
sprawdzenie przy wczytywaniu `playwright.config.ts` (zero serwerów i żądań przy
złej konfiguracji), guard w `loadConfig` serwera (odmowa przed `mkdirSync`), oraz
etykieta w `/api/health` sprawdzana przez fixture przed pierwszym żądaniem.

Usunięty też `pkill` ze `scripts/dev-server.sh` — to on zabił instancję
użytkownika. Sprzątanie może usuwać wyłącznie to, co samo utworzyło.

#### Znalezione przy okazji: kolejność w Playwrighcie

Playwright startuje `webServer` **przed** `globalSetup`. Przygotowywanie katalogu
danych w `globalSetup` usuwało i tworzyło plik bazy **pod** serwerem, który go już
otworzył: proces trzymał odlinkowany inode, a testy czytały inny plik pod tą samą
ścieżką. Testy przechodziły, więc nikt tego nie zauważył. Przygotowanie przeniosło
się do `e2e/support/boot-server.ts`, który czyści, migruje, zasiewa, a **potem**
uruchamia produkcyjny build.

#### Znalezione przy okazji: 4,1 MB w WAL

Katalog danych miał `app.db` 397 kB z datą 14 września i `app.db-wal` **4,1 MB z
datą 15 września** — skutek nieczystego zatrzymania procesu (mojego `pkill`).
`cp data/app.db` dałoby kopię cofniętą o dzień pracy, **wyglądającą na kompletną**.
Dlatego `scripts/backup-state.mjs` kopiuje trzy pliki razem i zwija WAL w kopii.

Drugie odkrycie w tym samym miejscu: **otwarcie bazy nawet w trybie readonly
przebudowuje `app.db-shm`**. Zaobserwowane wprost — po kopii wszystkie trzy sumy
SHA-256 były identyczne, a `-shm` zmienił się dopiero, gdy uruchomiłem polecenie
weryfikujące. Stąd zasada w skrypcie: źródła nie otwieramy jako bazy w żadnym
trybie.

#### Co potwierdza

`pnpm verify` → 0. 212 testów jednostkowych (18 plików), 46 przeglądarkowych
(w tym jedna tura na prawdziwym modelu: 75 różnych długości odpowiedzi, 91 → 632
znaków, wszystkie przy fazie `running`). Próba migracji na kopii danych tej
maszyny: 31 rozmów, 31 wiadomości użytkownika, 18 kart, 9 plików zachowane po
tożsamości; drugie uruchomienie nie zmieniło ani jednego wiersza. Cztery kontrole
siły testu: `docs/evidence/closure-2026-09-15/25-sila-testow.txt`.

#### Migracja — wykonana za zgodą, wynik zgodny z próbą

Użytkownik zgodził się na migrację tego samego dnia. Wykonana: 42 → 76 wiadomości,
**dokładnie** tyle, ile przewidziała próba na kopii. Odciski SHA-256 wierszy
widocznych dla użytkownika (rozmowy, wiadomości użytkownika, karty, pliki,
przestrzenie) identyczne z kopią sprzed migracji; powtórne uruchomienie nie
zmieniło ani jednego wiersza w 21 tabelach. `27-migracja-wykonana.txt`.

Wniosek metodologiczny: próba na kopii okazała się przewidywaniem co do wiersza,
nie przybliżeniem. Warto było ją zrobić przed, a nie zamiast.

#### Czego nadal nie zrobiłem

Odtworzenia kopii do `data/` — nadpisałoby dane użytkownika. Ścieżka odczytu
kopii jest sprawdzona, sam `cp` do `data/` nie.

### #37 — 2026-09-16 — Rozszerzenie: pliki, praca w tle, sterowanie interfejsem

Trzy rezultaty zamawiającego. Pełny opis: `RAPORT-DOMKNIECIA-PLATFORMY.md` §4c.

#### Wadę pokazał mi użytkownik, nie test

W działającej aplikacji napisał „przełącz na pliki". Agent wywołał dwa
niepowiązane narzędzia odczytu, a potem oznajmił, że **trzeba najpierw utworzyć
sprawę zakupową, żeby zobaczyć zakładkę „Pliki i raporty"**. To nieprawda — to
ekran platformy, w lewej nawigacji zawsze.

Mechanizm jest pouczający: agent nie miał ani narzędzia nawigacji, ani listy
widoków. Postawiony przed prośbą, której nie umie spełnić, nie powiedział „nie
umiem" — wygenerował prawdopodobnie brzmiące wyjaśnienie. Model bez możliwości
działania improwizuje opis, a opis brzmi tak samo pewnie jak fakt.

Wniosek projektowy: jeśli agent ma coś robić w interfejsie, musi dostać
**enumerowalny katalog** tego, co istnieje. Wtedy „nie ma takiego celu" jest
prawdziwą odpowiedzią zamiast zmyślonej drogi.

#### Samo wysłanie zdarzenia to nie wykonanie

Najprostsza implementacja nawigacji — wyemituj zdarzenie, zwróć „zrobione" —
przechodzi każdy test, jaki napisałbym po stronie serwera, i nie mówi nic o tym,
czy użytkownik cokolwiek zobaczył. Klient może być rozłączony, element może nie
istnieć na tym ekranie, polecenie może pochodzić z rozmowy, której użytkownik nie
ogląda.

Dlatego `ui_navigate` **nie rozstrzyga się**, dopóki przeglądarka nie odeśle
wyniku; brak potwierdzenia daje `executed=false` z powodem `no_client`. To ta
sama konstrukcja co bramka zgody — i ten sam powód.

#### Zadania w tle: backend był w porządku, klient je zabijał

Napisałem najpierw test backendu i przeszedł od razu — uruchomienie to łańcuch
obietnic, porzucenie odpowiedzi nigdy go nie zatrzymywało. **Ale to nie był
dowód naprawy**, bo wada była w przeglądarce: abort strumienia czatu był
przekazywany na `/cancel`, a biblioteka wywołuje ten abort z `selectThread`.
Czyli przełączenie rozmowy anulowało zadanie. Tak samo przeładowanie.

Odnotowuję to osobno, bo o mały włos zaliczyłbym rezultat na podstawie zielonego
testu, który mierzył inną warstwę niż ta, w której siedział defekt. Dowodem jest
test przeglądarkowy — i oblewa on po przywróceniu starego mapowania.

Konsekwencja projektowa: sygnał abort nie odróżnia „zatrzymaj" od „zmieniam
rozmowę" i od „zamykam kartę", więc **nie może** o niczym decydować. Anulowanie
jest jawnym działaniem na nazwanym wykonaniu.

#### Bramka zgody obejmuje analizę plików — i dobrze

Pierwszy przebieg testu XLSX zawisł. Agent zapisał skrypt do workspace i czekał
na zgodę na `Bash: node process_oferty.js` — bo `autoAllowBashIfSandboxed`
pozostaje `false`. To nie jest przeszkoda do obejścia: przetwarzanie pliku to
uruchamianie kodu, a uruchamianie kodu ma pytać. Test klika „Zgoda" jak
użytkownik i **sprawdza, że bramka została użyta**, więc ciche auto-zatwierdzenie
w przyszłości go obleje.

#### Biblioteka w sandboxie to granica, nie wygoda

Najprościej byłoby pozwolić workspace'owi rozwiązywać importy przez
`node_modules` serwera. Wtedy sterownik bazy i Claude SDK byłyby **jeden
`import` od kodu pisanego przez model**. Zamiast tego jest kuratorowana lista
(`agent/toolkit.ts`) linkowana pojedynczo do workspace'u — i test sprawdza obie
strony: że `exceljs` się importuje, a `better-sqlite3`, SDK i `hono` nie.

#### Formuła to nie wynik

Skoroszyt trzyma formułę obok wartości, którą Excel zapisał ostatnio. Podanie tej
wartości jako „wyniku" byłoby nieaktualną liczbą z autorytetem arkusza — cichy
błąd, najgorszy rodzaj. Zakres analizy jest danymi (`FILE_ANALYSIS`) wstawianymi
jednocześnie do promptu i do interfejsu, a test celowo zapisuje niespójną komórkę
(formuła `A1*B1` = 20, zapisana wartość 999), żeby sprawdzić, że obie strony są
widoczne osobno.

#### Usunięcie mapowania abort→anuluj zepsuło przycisk stop

Konsekwencja, której nie przewidziałem: gdy abort przestał anulować, przycisk
stop w gotowym kompozytorze zatrzymywał już tylko widok. Wychwycił to **istniejący**
test pomiaru czasu anulowania, który klika właśnie tę kontrolkę.

Naprawa nie polega na cofnięciu decyzji — sygnał nadal nie odróżnia zatrzymania
od zmiany rozmowy. Polega na rozpoznaniu zdarzenia, które *jest* jednoznaczne:
kliknięcia w kontrolkę wysyłania w chwili, gdy ta rozmowa ma wykonanie w locie.
Biblioteka zamienia wtedy rolę przycisku na „zatrzymaj".

Wniosek: usuwając zachowanie, warto sprawdzić, co jeszcze na nim polegało —
i czy da się odtworzyć skutek z lepszej przesłanki, zamiast wracać do złej.

#### Kontrola negatywna złapała wadę, którą sam wprowadziłem

Dodanie listy zadań w tle dało jednemu przebiegowi **dwóch konsumentów** zdarzeń:
strumień z `POST /api/agui/run` i ponowne podłączenie z synchronizacji zadań.
Oba stosowały te same delty tekstu, więc odpowiedź się podwajała — 107 znaków
mierzone jako 214.

Najciekawsze jest, co to zepsuło: scenariusz „cała odpowiedź jednym kawałkiem na
końcu" zaczął wychodzić **fałszywie jako strumieniowanie**, bo 107 → 214 wygląda
jak przyrost. Czyli kontrola negatywna dodana w poprzedniej turze — ta, której
jedynym zadaniem było pilnować, żeby asercja nie zdegenerowała się do „odpowiedź
dotarła" — złapała regresję, której żaden test pozytywny by nie zauważył. Test
strumieniowania nadal przechodził.

Wniosek: testy, które sprawdzają, że coś **nie** przechodzi, wykrywają inną
klasę wad niż testy pozytywne, i warto je pisać nawet wtedy, gdy wyglądają na
formalność.

#### Co potwierdza

`pnpm verify` → 0. 252 testy jednostkowe (21 plików), 59 przeglądarkowych
(z trzema turami na prawdziwym modelu). Obraz: trzy pasy nazwane poprawnie i w
kolejności mimo mylącej nazwy pliku. Skoroszyt: suma 5300 wyprowadzona z komórek,
wynik otwiera się z nowym arkuszem, **oryginał identyczny bajt w bajt**.

#### Czego nie zrobiłem

Zachowywania formatowania warunkowego, wykresów i tabel przestawnych przy zapisie
— parser tego nie przenosi i jest to wypisane wprost jako ograniczenie, nie
przemilczane. Plików `.xlsm` i `.xls` aplikacja nie przyjmuje.

### #38 — 2026-09-16 — Dane bazowe przy pierwszym uruchomieniu

Pusta aplikacja nie jest neutralnym punktem wyjścia, tylko ślepą uliczką: canvas
nie ma czego pokazać, ekrany biznesowe są pustymi listami, a agent zapytany o
cokolwiek może tylko stwierdzić, że nie ma czego robić. Dokładnie to zobaczył
użytkownik po postawieniu aplikacji na świeżo — i wyglądało to jak awaria, a nie
jak nowa instalacja.

`ensureBaseData` uruchamia się przy starcie serwera i wypełnia bazę raz na moduł.

#### Dwie decyzje, które warto zapisać

**Znacznik, nie „czy baza jest pusta".** Gdyby wyzwalaczem była pustka bazy,
usunięcie demonstracyjnej sprawy kończyłoby się jej wskrzeszeniem przy następnym
restarcie — i użytkownik nie miałby sposobu, żeby się jej pozbyć. Fakt zasiewu
jest zapisany w `app_settings`, a test nazywa się wprost „usunięte dane bazowe
NIE wracają przy kolejnym starcie".

**W korzeniu kompozycji, nie w `createPlatform`.** Gdyby konstruktor platformy
po cichu wypełniał bazę, każda asercja liczby wierszy w testach zależałaby od
fixture'u modułu biznesowego. Platforma udostępnia funkcję; wywołuje ją
`apps/server/src/main.ts`. Harness testowy dostaje bazę, o którą poprosił.

#### Przy okazji: sama sprawa to za mało

Pierwsza wersja zasiewała rekordy i aplikacja nadal otwierała się na „Brak
przestrzeni pracy" — czyli większość pustki została. Moduł deklaruje teraz
`baseDataScopes`, a platforma materializuje z tego przestrzeń przez ten sam
`defaultComposition` i tę samą walidację katalogu, co ścieżka HTTP. Efekt: 3
karty na canvasie od razu po otwarciu.

---

### #39 — 2026-09-16 — Układ czatu: co naprawdę robi `AgentInterface` z dziećmi

Zgłoszenie było wzrokowe — „załączniki z boku popsuły układ" — i miało zrzut
ekranu. Przyczyna okazała się jednym zdaniem z dokumentacji, którego wcześniej
nie sprawdziłem w działającej stronie.

#### Reguła, którą złamałem

`AgentInterface` wyciąga z `children` znane sloty (`Route`, `Sidebar`,
`Composer`, `Workspace`), a **całą resztę renderuje jako `slots.rest` — ostatnie
dziecko własnego kontenera, obok wątku**. Nie jest to pojemnik na dodatki. To
pozycja w układzie.

Pomiar w przeglądarce, po tym jak zapytałem stronę zamiast czytać kod:

```
div.openui-agent-sidebar-container  [294x690]
div.openui-agent-thread-container   [166x690]
div.pf-attach                       [393x690]
```

Pasek załączników zabrał 393 z 559 px panelu.

#### Dlaczego żaden test tego nie złapał

Bo wszystkie pytały „czy element jest widoczny". Był widoczny — wada polegała na
tym, **gdzie** i **jak szeroko**. Nowa suita `e2e/chat-layout.spec.ts` pyta o
geometrię i przynależność: `thread.width / panel.width > 0.9` oraz „żadne dziecko
kontenera nie ma klasy spoza `openui-`". Cofnięcie naprawy do jednego `<div>` z
jednym słowem oblewa 3 z 4 testów; sam ten `<div>` spycha wątek do 87 % panelu.

To jest ta sama lekcja co przy #32 (szuflada renderowana poza panelem), tylko z
drugiej strony: tam popsułem cudzy układ swoim CSS-em, tu popsułem go swoim
dzieckiem.

#### Druga rzecz: przycięty element nadal przechodzi `toBeVisible()`

Pierwsza wersja menu spinacza renderowała się wewnątrz kontrolki. Kompozytorowy
`__input-wrapper` ma `overflow: clip`, więc menu było ucięte na krawędzi
kompozytora — na ekranie została sama lista plików, bez przycisku „Wgraj z
dysku". Playwright tego nie widział: przycięty element ma pełny box i normalny
`display`, więc `toBeVisible()` zwraca `true`.

Zobaczyłem to dopiero na zrzucie, który zrobiłem jako dowód dla użytkownika.
Asercja, która to łapie, to test trafienia: `elementFromPoint` respektuje
przycinanie, więc odpowiada na pytanie „czy użytkownik może w to kliknąć".
W cofniętej wersji zwraca `null` w środku przycisku.

**Wniosek do zapisania:** przy pracy nad wyglądem zrzut ekranu jest częścią
weryfikacji, a nie ilustracją do niej. Dwie wady tej tury — przycięte menu i
pierścień fokusu rysowany prostokątem w zaokrąglonym kompozytorze — wyszły
wyłącznie z oglądania zrzutów.

#### Trzecia: funkcji nie brakowało, brakowało widoczności

„Artefakty to osobna zakładka" brzmiało jak prośba o nowy ekran. Przeglądarka
artefaktów **już była**: biblioteka rezerwuje ścieżkę `artifacts/` i sama wystawia
wpis w pasku bocznym. Tyle że przy 560 px pasek boczny jest szufladą off-canvas,
więc trzeba było wiedzieć, że tam jest. Pasek zakładek steruje własną nawigacją
biblioteki jej publicznym propem `path`/`onNavigate` — zero nowej logiki
artefaktów.

Przed pisaniem czegokolwiek warto sprawdzić, czy gotowy komponent już tego nie
robi w miejscu, którego użytkownik nie znajduje.

#### Przy okazji: ta sama wada leżała utajona

`ConversationSync` renderował komunikat o niedostępnej rozmowie tak samo — jako
dziecko `AgentInterface`. Pokazywał się tylko przy nieudanym wczytaniu rozmowy,
czyli dokładnie wtedy, gdy wątek najmniej może stracić szerokość. Oba komunikaty
idą teraz przez `chatSlots.ts`, poza kontener biblioteki.

#### Potknięcie w trakcie: sonda dowodowa zderzyła się z suitą

Zostawiłem instancję dowodową na porcie 8798, w zakresie zarezerwowanym dla
Playwrighta (8792–8799). Suita scenariuszowa próbowała tam wstać, zastała cudzy
serwer i **odmówiła pracy** — `TestIsolationError`, zero operacji. Straż z
rezultatu 3 zadziałała dokładnie tak, jak miała. Sonda przeniesiona na 8788.

---

### #40 — 2026-09-17 — Prompt nie naprawi narzędzia, którego model nie ma

Użytkownik zgłosił dwa błędy z własnego przebiegu. Trzeci wyszedł przy
dowodzeniu pierwszego i to on był przyczyną zdania, które w tym przebiegu
najbardziej rzucało się w oczy.

#### Naprawa, która nie zadziałała, i to, czego nauczyła

Na „co jest w dostawcach?" agent odpowiadał tekstem i nie przenosił ekranu.
Reguła w prompcie brzmiała „gdy użytkownik **prosi** o pokazanie", a pytanie tak
nie brzmi — więc rozszerzyłem regułę, uruchomiłem test na prawdziwym modelu i
**oblał**. Siedem minut, koniec na `/files`.

Dziennik uruchomienia odpowiedział czym innym, niż zakładałem:

```
TOOL_CALL_START ToolSearch
TOOL_CALL_RESULT {"total_deferred_tools":54}
narzędzia w turze: ToolSearch, get_context, procurement_search
```

SDK odracza narzędzia, gdy jest ich dużo. `ui_navigate` **nie było w kontekście
modelu** — siedziało za `ToolSearch`, a model wyszukał tylko te dwa, których się
spodziewał. Prompt kazał mu nawigować i nazywał narzędzie, którego nie miał.

Wniosek do zapisania: **kiedy model „nie słucha instrukcji", najpierw sprawdź,
czy ma czym ją wykonać.** Pisałem trzeci akapit instrukcji do narzędzia, którego
nie było w promptcie. Po dodaniu `alwaysLoad` na czterech narzędziach sterujących
ten sam test przeszedł w 22,8 s, a w turze widać `mcp__app__ui_navigate`
wywołane **przed** odczytem danych.

Drugi wniosek, ogólniejszy: test na prawdziwym modelu zarobił tu na siebie.
Wersja z samą poprawką promptu wyglądała na skończoną i przeszłaby każdy test
scenariuszowy, bo scenariusz robi to, co w nim napisano.

#### Zawężanie: kopia w czacie zamiast filtra w widoku

Na „pokaż tylko PL dostawców" agent przepisywał wiersze do rozmowy. Ekran
pokazywał dalej wszystkie cztery — użytkownik dostawał pełną listę i ręczną
kopię obok, z poleceniem czytania kopii.

Trzy decyzje warte zapisania:

**Zastosowanie w jednym miejscu, nie w każdym widoku.** Wymaganie brzmiało
„w każdym widoku". Gdyby każdy ekran implementował to sam, wymaganie byłoby
obietnicą, którą każdy nowy ekran musi pamiętać — a ten, który zapomni, pokaże
pełną listę pod banerem mówiącym, że jest zawężona. Filtr działa w
`useModuleData`, baner nad powierzchnią roboczą. Jedno i drugie jest prawdziwe
o ekranach, których jeszcze nie ma.

**Zdanie dla użytkownika jest w kontrakcie wymagane.** `label` nie jest
opcjonalny, bo widok pokazujący po cichu 3 z 4 wierszy jest gorszy niż
pokazujący 4 — użytkownik myśli, że patrzy na wszystko.

**Liczby przychodzą z widoku.** Runner czeka, aż jakiś widok zgłosi, co
zastosował. Serwer policzyłby to samo, ale wtedy „executed" znaczyłoby „tak nam
się wydaje", a różnica między *zawężone do zera* a *nic tego nie zastosowało*
byłaby nie do rozstrzygnięcia. Stąd osobny powód odmowy `not_applied`.

#### „Aplikacja jest pusta" przy pełnej bazie

To zdanie było w przebiegu użytkownika i wyglądało na halucynację. Nie było.
Model poprosił o wszystko przez `query: "*"`, a wyszukiwanie robi
`LIKE '%*%'` — co nie pasuje do niczego. Dostał `{"results":[]}` i wyciągnął
jedyny wniosek, jaki dawała ta odpowiedź.

Naprawa nie polega na dopisaniu modelowi ostrożności. `*` znaczy teraz
„wszystko", a **każda** odpowiedź wyszukiwania niesie `totals` — ile rekordów
każdego rodzaju w ogóle jest. „0 pasujących z 4 dostawców" nie da się
sparafrazować jako „nie ma dostawców" bez zaprzeczenia treści odpowiedzi.

Ogólna zasada, którą zapisuję sobie na przyszłość: jeżeli agent mówi coś
nieprawdziwego o danych, sprawdź najpierw, co naprawdę zwróciło narzędzie.
Dwa razy w tej turze wyglądało to na błąd modelu i dwa razy był to kontrakt
narzędzia.

---

### #41 — 2026-09-17 — Pomyliłem pochodzenie zmiany z naturą stanu

Zawężenie widoku zbudowałem na stanie klienta i uzasadniłem to w raporcie tak:
„to jest coś, co **zrobiono** ekranowi użytkownika, a nie miejsce, do którego
nawigował; przeładowanie ma oddać dane, a nie przywrócić cudzy filtr".

Użytkownik odpisał, że filtry należą do adresu, i miał rację. Moje zdanie było
prawdziwe o **pochodzeniu** zmiany i nic nie mówiło o **naturze** stanu. Filtr
rozstrzyga, jaki zestaw rekordów użytkownik ogląda — a to jest dokładnie ta
rzecz, którą link, odświeżenie, Wstecz i zakładka mają zachować. Trzymając ją w
pamięci odebrałem wszystkie cztery.

#### Podział, który sobie zapisuję

| Gdzie | Co tam trafia |
|---|---|
| **URL** | co użytkownik ogląda: wyszukiwanie, status, zakres dat, sortowanie, strona |
| **stan lokalny** | chwilowe stany interfejsu: otwarte menu, modal, rozwinięty panel, hover |
| **konto / backend** | trwałe preferencje, zapisane własne widoki |

Ciekawe jest to, że po przeniesieniu filtra do URL **jedna rzecz została w
pamięci i to była właśnie ta, o którą mi chodziło**: czy zawężenie zrobił agent
tej sesji. Tego adres nieść nie powinien — ten sam URL otwarty z wklejonego
linku albo przyciskiem Wstecz to ten sam widok, zawężony przez nikogo. Moja
intuicja dotyczyła prawdziwej rzeczy, tylko przypisałem ją do złego kawałka
stanu.

#### Co wyszło przy okazji przenoszenia

**Pasek przestał cytować agenta.** Skoro filtr jest w adresie, zdanie opisujące
go trzeba wygenerować z tego, co w adresie stoi — przez etykiety pól
zadeklarowane przez widok. Wyszło lepiej niż było: cytowane zdanie agenta mogło
opisywać co innego niż to, co faktycznie zastosowano, a wklejony link w ogóle by
go nie niósł. Wygenerowany pasek nie może się pomylić co do tego, co widać.

**`validateSearch` po cichu zjadał wszystko, czego nie znał.** Walidator roota
zwracał tylko `c` i `s`, więc `?country=PL` znikał, zanim jakikolwiek ekran mógł
go przeczytać. Godzina na filtrze, który „nie działa", bo router go kasował.

**Filtry celowo NIE są przenoszone między ekranami.** `retainSearchParams`
obejmuje dalej tylko `c` i `s`. To wypadło dobrze samo z siebie: wyjście z
widoku zdejmuje filtr, a Wstecz go przywraca.

#### Zastrzeżenie o uprawnieniach, które trzeba było sprawdzić, nie odpowiedzieć

Użytkownik dopisał, że link z filtrem nie może omijać uprawnień. Konstrukcyjnie
nie może — parametry tylko *usuwają* wiersze z odpowiedzi, którą backend już
ograniczył do właściciela, i nic z adresu nie dociera do bazy. Ale to jest
argument, a nie dowód, więc jest test: ten sam adres `/data?country=PL` po
przełączeniu tożsamości pokazuje zero wierszy, a nazwa z poprzedniej tożsamości
nie występuje nigdzie na stronie.

Mutacja, która to pilnuje: gdy parametry z adresu traktować jako filtry **bez**
sprawdzania deklaracji widoku, `c=cnv_…` staje się filtrem na nieistniejące pole
i widok pokazuje 0 z 4. Deklaracja pól jest więc nośna, a nie ozdobna.

---

## 4. Architektura faktycznie wdrożona

### Granica platforma–domena

```
apps/server, apps/web           warstwa składania — jedyne miejsce znające obie strony
        ↓
packages/module-procurement     domena: ./server, ./ui, ./shared
packages/module-devkit-probe    minimalny moduł testowy
        ↓
packages/platform-server        Hono, SQLite, pliki, runtime Claude, AG-UI, MCP, sandbox
packages/platform-ui            powłoka React: nawigacja, canvas, czat, katalog
        ↓
packages/platform-contracts     kontrakty Zod + interfejsy rejestracji (zero domeny)
```

Kierunek jest jednokierunkowy. `pnpm check:boundaries` sprawdza **trzy** rzeczy niezależnie:

1. żaden `package.json` platformy nie deklaruje zależności od `@module/*`;
2. żaden plik platformy nie importuje z `@module/*`;
3. żaden plik platformy nie używa słownika domenowego (12 pojęć: `supplier`, `dostawc`, `oferta`,
   `unitPrice`, `priceBasis`, `pc_cases`, …) — łapie wyciek nawet jako literał tekstowy.

Zakres modułu przekazywany jest jako nieprzezroczysta para `scopeKind`/`scopeId`, której platforma
**nigdy nie interpretuje**.

**Platforma uruchamia się z pustym rejestrem modułów** — obsługiwana konfiguracja, weryfikowana
przez `tests/platform-boundary.test.ts`: pusty stan zamiast błędu, brak tabel `pc_*`, a moduł
testowy `probe` (własna tabela, narzędzie, trasa, komponent) instaluje się bez zmian w platformie.

### Własność danych

| Rodzaj | Właściciel | Gdzie |
|---|---|---|
| Dane biznesowe | serwisy modułu | `pc_cases`, `pc_suppliers`, `pc_requirements`, `pc_offers`, `pc_offer_items`, `pc_attachments`, `pc_provenance`, `pc_criteria` |
| Kompozycja UI | platforma | `canvas_spaces`, `canvas_cards` |
| Rozmowa | platforma | `conversations`, `messages` |
| Sesja Claude | Claude SDK; mapowanie w platformie | `conversations.claude_session_id`, `agent_runs.claude_session_id` |
| Artefakt | platforma | `artifacts`, `artifact_versions` |
| Plik | platforma | `files` + `data/files/` |
| Stan zadania | platforma | `agent_runs`, `run_events` |
| Klucz idempotencji | platforma | `idempotency_keys` |

Wspólna fizyczna baza SQLite, rozdzielona odpowiedzialność za zapis. Jedyne odwołanie modułu do
platformy to `pc_attachments.file_id` — celowo **bez klucza obcego**, bo cykl życia pliku należy
do platformy i moduł nie ma prawa go ograniczać.

Stan roboczy formularza żyje wyłącznie w kliencie i podróżuje do agenta jako `unsavedDrafts`
z jawną adnotacją, że **nie są to dane zapisane**.

### Powiązanie rozmowy, sesji, canvasu i artefaktów

```
conversation ──1:1──> claude_session_id      (wznowienie przez resumeStream)
     │
     ├──1:N──> messages                      (idempotentne po id klienta)
     ├──1:N──> agent_runs ──1:N──> run_events (pełna sekwencja AG-UI, trwała)
     ├──0:1──> canvas_space ──1:N──> canvas_cards
     └──1:N──> artifacts ──1:N──> artifact_versions ──0:1──> files
```

Odpowiedź na `POST /api/agui/run` niesie `X-Run-Id` i `X-Conversation-Id`, więc klient może
powiązać strumień z rekordami bez zgadywania.

### Kontrakty MCP

Jeden serwer MCP `app`, budowany **per uruchomienie** w procesie backendu.

**Narzędzia platformy (12):** `get_context`, `canvas_catalog`, `canvas_list_cards`,
`canvas_add_card`, `canvas_update_card`, `canvas_move_card`, `canvas_remove_card`, `files_list`,
`files_stage`, `workspace_outputs`, `artifact_create`, `artifact_publish_file`.

**Narzędzia modułu (9):** `procurement_list_cases`, `procurement_get_case`,
`procurement_list_offers`, `procurement_compare_offers`, `procurement_update_offer_item`,
`procurement_find_price_provenance`, `procurement_search`, `procurement_set_criteria_weights`,
`procurement_save_comparison`.

Każde narzędzie to cienka nakładka na metodę serwisu — **tę samą**, którą wywołuje HTTP.
Walidacja, własność, optymistyczna współbieżność i idempotencja dzieją się raz, w serwisie, i nie
da się ich ominąć wybierając jedno wejście zamiast drugiego. Potwierdza to test porównujący oba
wejścia.

### Zdarzenia AG-UI

Backend emituje SSE `data: <json>` w formacie AG-UI. Zdarzenia pochodzą z **dwóch niezależnych
producentów** — strumienia tekstu Mastry i callbacków hooków SDK — i są scalane w jedną kolejkę
z numeracją sekwencyjną, trwale zapisywaną w `run_events`, co pozwala odtworzyć strumień od
dowolnego numeru przy ponownym połączeniu.

Zdarzenia platformy (`CUSTOM`): `platform.canvas_changed`, `platform.data_changed`,
`platform.artifact_created`, `platform.session_bound`, `platform.permission_request`,
`platform.run_cancelled`.

### Kompozycja canvasu

Biblioteka canvasu (React Flow) odpowiada **wyłącznie za geometrię** — pan, zoom, przeciąganie,
zaznaczanie. OpenUI odpowiada za **dozwolone komponenty i zawartość kart**.

Karta ma dwa kanały zapisu z osobnymi wersjami (wpis #7). Props kart niosą **wyłącznie referencje**
(`caseId`, `offerId`, `itemId`) i opcje widoku — nigdy wartości biznesowych. Każdy komponent
pobiera dane sam, przez TanStack Query, z backendu.

Stan widoku karty (filtry, rozwinięcia) żyje w sklepie aplikacji **poza** danymi węzła canvasu,
więc przestawienie układu — przez użytkownika albo przez agenta — go nie gubi.

### Trwałość artefaktów

Tożsamość to `id`; tytuł jest zwykłą, zmienną kolumną. Wersje w `artifact_versions` z kluczem
`(artifact_id, version)`. Tryb `snapshot` zamraża treść (raport historyczny zachowuje liczby),
tryb `live` zapisuje deskryptor zapytania. Pliki wyprodukowane w sandboxie są **kopiowane** do
magazynu aplikacji przy publikacji, więc przeżywają skasowanie workspace uruchomienia.

---

## 5. Macierz odbioru

> **Zapis historyczny — stan na 2026-09-14 (zbudowanie).** Ta macierz jest
> zachowana bez zmian jako zapis tego, co było wiadomo w chwili zbudowania
> platformy; nie jest przerabiana po fakcie. Stan aktualny (po audycie z
> 2026-09-15 i pracach domykających) jest w
> [`RAPORT-DOMKNIECIA-PLATFORMY.md`](RAPORT-DOMKNIECIA-PLATFORMY.md), sekcja 9;
> liczy go `scripts/closure-matrix.mjs`. Stan pośredni — wynik samego audytu —
> jest w [`RAPORT-STANU-PLATFORMY.md`](RAPORT-STANU-PLATFORMY.md).

Identyfikatory stabilne: `L<warstwa>.<numer>` w kolejności z dokumentu architektury.

| Status | Znaczenie |
|---|---|
| **ZAL-R** | zaliczone **rzeczywistym wykonaniem** (prawdziwa sesja Claude / uruchomiona aplikacja / przeglądarka) |
| **ZAL-T** | zaliczone **testem automatycznym** bez modelu (Vitest / Playwright) |
| **CZĘŚĆ** | częściowo — opis mówi, czego brakuje |
| **KOD** | zaimplementowane, potwierdzone **wyłącznie analizą kodu**, nieuruchomione |
| **NIE / BLK** | niezaliczone / zablokowane |

Sama obecność biblioteki nigdzie nie zalicza kryterium.

### Warstwa 1 — Runtime i środowisko full stack

| ID | Kryterium | Status | Wynik i dowód |
|---|---|---|---|
| L1.1 | Frontend i backend z udokumentowanej konfiguracji | **ZAL-R** | `pnpm dev` (Vite :5173 + Hono :8791) i `pnpm start`. Port 8787 z dokumentu zmieniono na 8791 — 8787 był zajęty przez niepowiązany proces na tej maszynie. Log: `docs/evidence/04-server-start.txt` |
| L1.2 | React i TS najnowsze stabilne; lockfile i zgodność | **CZĘŚĆ** | React 19.3.0, TypeScript 7.0.2 — oba najnowsze stabilne; lockfile w repo; `pnpm typecheck` czysty. **Ograniczenie:** TS 7 to port natywny bez API JS, a natywne usuwanie typów w Node nie obsługuje właściwości parametrów konstruktora → skrypty dev/CLI wymagają `--experimental-transform-types` (wpis #10). Build produkcyjny bez flag |
| L1.3 | Build produkcyjny i typecheck bez błędów; niezależność od dev servera | **ZAL-R** | `pnpm build` → `apps/web/dist` + `apps/server/dist/server.js` (162 kB). `pnpm start` = `node dist/server.js`, zero flag. Testy Playwright działają właśnie na tym buildzie |
| L1.4 | Strumienie bez buforowania do końca generacji | **ZAL-R** | Pierwszy token po 6 172–14 458 ms, dziesiątki kolejnych zdarzeń przed końcem (do 131 w jednym przebiegu) |
| L1.5 | Konfiguracja prywatna poza pakietem frontendu i odpowiedziami | **ZAL-T** | Testy skanujące `/api/status` i całą stronę Ustawień pod kątem `sk-ant`, `accessToken`, `refreshToken` |
| L1.6 | Restart zachowuje dane; brak osieroconych procesów | **ZAL-R** | Wpis #19. Wyłączenie loguje `SIGTERM`, wywołuje `abortAll()` i zamyka bazę; test „zatrzymanie serwera przerywa wszystkie uruchomienia" |
| L1.7 | Jawne zasady origin i autoryzacji; token subskrypcji ≠ token dostępu | **ZAL-T** | Allowlista originów (403 dla obcego), 401 bez sesji, własne ciasteczko HMAC. Token subskrypcji nigdy nie jest przyjmowany jako token aplikacji |

### Warstwa 2 — Komponenty i nawigacja frontendowa

| ID | Kryterium | Status | Wynik i dowód |
|---|---|---|---|
| L2.1 | Komponenty domenowe typowane i w katalogu OpenUI | **ZAL-R** | 10 komponentów kart ze schematami Zod (3 platformowe + 7 domenowych) widocznych w `/api/status` i na ekranie Ustawień; 2 komponenty OpenUI Lang dołączone do `openuiLibrary` przez `createLibrary` |
| L2.2 | Lewa nawigacja + prawy czat, adaptacja do mniejszych ekranów | **ZAL-R** | `docs/evidence/03-canvas.png`; testy „lewa nawigacja, canvas i czat wspolistnieja" oraz „na waskim ekranie menu jest zwiniete, a czat nadal dostepny" (820 px). Współistnienie wymagało naprawy: szuflada rozmów czatu renderowała się poza panelem i canvas przechwytywał kliknięcia (wpis #32) |
| L2.3 | Nawigacja, odświeżenie, Wstecz/Dalej przywracają kontekst | **ZAL-T** | Test Back/Forward oraz test przeładowania po przesunięciu karty |
| L2.4 | Dynamiczne wnętrze UI bez nowych plików tras i kodu | **ZAL-R** | Agent dodał karty bez żadnej zmiany w kodzie — kompozycja to dane walidowane katalogiem |
| L2.5 | Klawiatura, etykiety, widoczny fokus | **ZAL-T** | Test nawigacji klawiaturą; `<label for>` na wszystkich polach formularza; globalne `:focus-visible` |
| L2.6 | Rozróżnialne stany: ładowanie, brak danych, błąd, brak dostępu | **ZAL-R** | Osobne klasy `.pf-state`/`--empty`/`--error`; komponent `Failure` mapuje `forbidden` → „Brak dostępu", `not_found` → „Rekord nie istnieje" |

### Warstwa 3 — Dynamiczna kompozycja interfejsu

| ID | Kryterium | Status | Wynik i dowód |
|---|---|---|---|
| L3.1 | Układ początkowy i zmieniony z tego samego katalogu | **ZAL-R** | Oba przechodzą przez `ComponentCatalog.validate()` |
| L3.2 | Agent dodaje, usuwa, przestawia, zmienia właściwości | **CZĘŚĆ** | `canvas_add_card` potwierdzone trzema rzeczywistymi przebiegami. `update`/`move`/`remove` zaimplementowane i pokryte testami kontraktowymi, ale **nie wywołane** przez model w przebiegu odbiorowym |
| L3.3 | Nieznany komponent, złe właściwości, niedozwolone odwołania odrzucane | **ZAL-T** | Walidacja po stronie **backendu**, więc nie da się jej ominąć; dwa testy kontraktowe |
| L3.4 | Błędna odpowiedź nie niszczy ostatniego poprawnego układu | **ZAL-T** | Test konfliktu: odrzucony zapis zostawia poprzednią wersję nienaruszoną; walidacja rzuca przed jakimkolwiek zapisem |
| L3.5 | Zmiana kompozycji zachowuje zaznaczenia, filtry, niezapisane dane | **ZAL-T** | Stan widoku karty poza węzłem canvasu; test „zmiana widoku karty przezywa przejscie miedzy ekranami" |
| L3.6 | Zapisana kompozycja odtwarzana po ponownym otwarciu | **ZAL-R** | Karty, pozycje i widok wracają po przeładowaniu i po restarcie backendu |
| L3.7 | Dane biznesowe z backendu; wygenerowane wartości nie zastępują rekordów | **ZAL-R** | Props niosą wyłącznie referencje; test przeglądarkowy porównuje wyświetlone kwoty (49 270,00 / 49 830,00 PLN) z wyliczeniem backendu |

### Warstwa 4 — Czat i zarządzanie rozmowami

| ID | Kryterium | Status | Wynik i dowód |
|---|---|---|---|
| L4.1 | Gotowy komponent OpenUI, bez płatnej usługi | **ZAL-R** | `AgentInterface` 0.13.10, własny backend przez `restStorage` |
| L4.2 | Tworzenie, lista, przełączanie, usuwanie | **ZAL-T** | `e2e/chat.spec.ts` „lista rozmow, przelaczanie i usuwanie" — usuwanie wykonywane **przez interfejs** (menu wiersza → `Delete`), z asercją zarówno na ekranie, jak i w backendzie. Wcześniejsza wersja szła przez API i nie dowodziła, że użytkownik może to zrobić (wpis #31) |
| L4.3 | Automatyczne tytuły i zmiana; bez API Anthropic | **ZAL-R** | `deriveTitle()` — czysta funkcja tekstowa, zero wywołań modelu; rzeczywiste tytuły na zrzucie; testy w dwóch pakietach |
| L4.4 | Historia i tytuły po odświeżeniu i restarcie | **ZAL-R** | Wpis #19 |
| L4.5 | Przełączenie nie miesza wiadomości ani kontekstu | **ZAL-T** | Test „przelaczenie rozmowy nie miesza wiadomosci"; uruchomienia szeregowane per rozmowa, osobne strumienie |
| L4.6 | Powtórzenie lub reconnect nie tworzy podwójnych wiadomości | **ZAL-T** | Unikalny indeks `(conversation_id, id)` + test |
| L4.7 | Usunięcie ma określony skutek; brak niespójnych powiązań | **ZAL-T** | Wiadomości i uruchomienia kaskadowo, artefakty **odłączane** (`ON DELETE SET NULL`); test potwierdza, że liczba artefaktów się nie zmienia |
| L4.8 | Zakres edycji, rozgałęziania, przywracania opisany | **ZAL-R** | `CHAT_CAPABILITIES` w `/api/status` i na ekranie Ustawień: edycja wiadomości **niedostępna**, rozgałęzianie **niedostępne**, przywracanie usuniętych **niedostępne**, zmiana tytułu i anulowanie **dostępne** |

### Warstwa 5 — Komunikacja i zdarzenia

| ID | Kryterium | Status | Wynik i dowód |
|---|---|---|---|
| L5.1 | Tekst przyrostowo przed końcem generacji | **ZAL-R** | Po naprawie z wpisu #18: 21 i 131 zdarzeń w dwóch przebiegach, pierwsze delty to fragmenty słów |
| L5.2 | UI rozpoznaje start, koniec, błąd, anulowanie | **CZĘŚĆ** | Backend emituje `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `CUSTOM platform.run_cancelled`. **Ograniczenie:** gotowy `processStreamedMessage` ignoruje `RUN_STARTED`/`RUN_FINISHED` (wpis #13) — czat rozpoznaje koniec po zamknięciu strumienia. Własny adapter odbiera pełny zestaw |
| L5.3 | Wywołania narzędzi i wyniki powiązane i dostępne w czacie | **ZAL-R** | Most hooków generuje `TOOL_CALL_START/ARGS/END/RESULT` z tym samym `tool_use_id`; w przebiegu CSV 7 wywołań i 7 wyników, wszystkie sparowane |
| L5.4 | Dane artefaktów i zmian UI docierają do rendererów | **CZĘŚĆ** | `platform.artifact_created` i `platform.canvas_changed` obserwowane w rzeczywistych przebiegach i unieważniają właściwe zapytania; renderery zarejestrowane w `AgentInterface`. **Nieprzetestowane:** wizualne wyrenderowanie artefaktu w panelu czatu |
| L5.5 | Pytanie lub prośba o decyzję dociera do UI, odpowiedź wraca | **ZAL-R** | Scenariusze `consent-denied` i `consent-allowed` (wpis #23): prośba dotarła, decyzja wróciła do `canUseTool`, polecenie odpowiednio wykonane lub nie |
| L5.6 | Rozłączenie i reconnect nie powielają zdarzeń ani skutków | **ZAL-T** | `RunEventStream.read(fromSeq)` + idempotencja operacji i unikalność id wiadomości |
| L5.7 | Jeden rozstrzygający status końcowy | **ZAL-T** | `finish()` z warunkiem `WHERE status='running'`; test; blok `finally` zawsze zamyka strumień |
| L5.8 | Pokrycie zdarzeń sprawdzone z rzeczywistym adapterem; braki opisane | **ZAL-R** | Lista obsługiwanych zdarzeń odczytana z kodu i potwierdzona przebiegami; braki we wpisie #13 i w L5.2 |

### Warstwa 6 — Kontekst aplikacji dla agenta

| ID | Kryterium | Status | Wynik i dowód |
|---|---|---|---|
| L6.1 | Kontekst: rozmowa, zasób, zaznaczenie, filtry, kompozycja | **ZAL-R** | `appContextSchema` obejmuje wszystko plus `viewport` i `drafts`; trafia do promptu i jest dostępny przez `get_context` |
| L6.2 | Zmiana wyboru w UI zmienia kontekst kolejnego polecenia | **ZAL-R** | Kontekst czytany ze sklepu **w momencie wysłania**; scenariusz `provenance` przekazał zaznaczoną pozycję i agent zadziałał na właściwym rekordzie |
| L6.3 | Agent pobiera aktualny kontekst podczas dłuższego zadania | **KOD** | `get_context` zarejestrowane i widoczne w sesji (21/21). W przebiegach model nie potrzebował go wywołać — kontekst był w prompcie. **Niepotwierdzone rzeczywistym wywołaniem** |
| L6.4 | Kontekst walidowany, nie nadaje uprawnień | **ZAL-T** | `appContextSchema` **nie ma pola właściciela**; test „identyfikator wlasciciela z ciala zadania nie daje dostepu" → 403 |
| L6.5 | Agent odróżnia roboczy stan formularza od danych zapisanych | **CZĘŚĆ** | Szkice podróżują jako `unsavedDrafts` z jawną adnotacją w prompcie i w wyniku `get_context`; formularz oznacza pola brudne. **Nieprzetestowane** zachowanie modelu wobec szkicu |
| L6.6 | Polecenie o aktualnym elemencie → operacja na właściwym rekordzie | **ZAL-R** | Scenariusz `mutation`: backend potwierdził ilość 3 i sumę 5 633 000 groszy |
| L6.7 | Większe zbiory selektywnie, nie w całości do promptu | **ZAL-R** | Limity w `list_offers` i `search`; `compare_offers` zwraca policzony wynik. Prompt nie zawiera danych biznesowych poza jednozdaniowym opisem zasobu |

### Warstwa 7 — Orkiestracja backendowa

| ID | Kryterium | Status | Wynik i dowód |
|---|---|---|---|
| L7.1 | Claude SDK przez oficjalną integrację Mastry | **ZAL-R** | `new Mastra({ agents: { appAgent: new ClaudeSDKAgent(...) } })`; wykonanie przez `mastra.getAgent('appAgent').stream()`/`.resumeStream()`. Sonda potwierdziła, że `getAgent` zwraca tę samą instancję i że narzędzie MCP podane per wywołanie zostaje wywołane |
| L7.2 | Żądanie powiązane z wykonaniem, kontekstem i diagnostyką | **ZAL-R** | `X-Run-Id`, `X-Conversation-Id`; wiersz w `agent_runs` z kontekstem, czasami i sesją; sekwencja w `run_events` |
| L7.3 | Wynik, błąd i anulowanie przechodzą do klienta | **ZAL-R** | Sukces i `RUN_ERROR` zaobserwowane w rzeczywistych przebiegach; anulowanie pokryte testem |
| L7.4 | Równoległe żądania bez wyścigów i mieszania kontekstów | **CZĘŚĆ** | Naprawiony realny wyścig (wpis #9): serwer MCP **per uruchomienie**, kolejka **per rozmowa**. Potwierdzone konstrukcją i analizą kodu; **nieuruchomione** dwa równoległe przebiegi z modelem |
| L7.5 | Orkiestracja nie omija serwisów domenowych | **ZAL-T** | Każde narzędzie MCP to nakładka na serwis; dwa testy porównujące oba wejścia. Sandbox dodatkowo blokuje odczyt katalogu danych |
| L7.6 | Zakres własnych adapterów udokumentowany | **ZAL-R** | Sekcja 6 |
| L7.7 | Bez Mastra Factory, AgentController, hostingu | **ZAL-R** | Zależności to tylko `@mastra/core` i `@mastra/claude`; zwykły proces Node |

### Warstwa 8 — Harness i uwierzytelnienie Claude

| ID | Kryterium | Status | Wynik i dowód |
|---|---|---|---|
| L8.1 | Pętla i narzędzia SDK, nie tylko model w routerze | **ZAL-R** | Przebiegi wielokrokowe: `ToolSearch`, narzędzia MCP, `Read`, `Write`, potem odpowiedź |
| L8.2 | Uwierzytelnienie subskrypcyjne z potwierdzeniem trybu bez tokena | **ZAL-R** | `/api/status` → `mode: subscription`, `subscriptionType: max`, data wygaśnięcia. Wartość tokena nigdy nie jest czytana |
| L8.3 | Klucz API, gateway, fallback nie są aktywną ścieżką | **ZAL-T** | `subscriptionOnlyEnv()` usuwa 7 zmiennych przekierowujących; test potwierdza. `ANTHROPIC_API_KEY` nie występuje w tym środowisku, a polityka i tak jest egzekwowana |
| L8.4 | Narzędzia MCP dostępne; prawdziwe wywołanie zwraca wynik do dalszej pracy | **ZAL-R** | `diag` → 21 z 21. Model użył wyniku `procurement_compare_offers` do dodania karty i sformułowania wniosku |
| L8.5 | Sesja kontynuowana przez właściwy identyfikator, bez powielania | **ZAL-R** | Wpis #19: `resumeStream({sessionId})`, poprawna liczba z pamięci, zero wywołań narzędzi, 4 wiadomości, 1 artefakt |
| L8.6 | Wygaśnięcie i limit dają czytelny błąd, stan zachowany | **KOD** | `classifyModelError()` mapuje na `unauthenticated`/`model_failed`; częściowy tekst zapisywany przed zgłoszeniem błędu. **Nieuruchomione** — nie da się wywołać na żądanie |
| L8.7 | Poświadczenia poza frontendem, artefaktami i logami | **ZAL-T** | Testy biorą **rzeczywistą** wartość tokena z `~/.claude/.credentials.json` i sprawdzają, że nie występuje (ani w całości, ani jako 16-znakowy prefiks) w `probeAuth()` ani w `/api/status`; osobno skanowana strona Ustawień. Uwaga na sformułowanie: aplikacja **czyta** ten plik, żeby poznać plan i datę wygaśnięcia — nie używa, nie przechowuje i nie przesyła wartości tokena (wpis #33) |
| L8.8 | Zgodność wersji SDK, adaptera i logowania sprawdzona wywołaniem | **ZAL-R** | `diag` + 10 rzeczywistych przebiegów; znalezione i naprawione trzy realne niezgodności (wpisy #15, #18, #23) |

### Warstwa 9 — Model domeny i funkcje backendu

| ID | Kryterium | Status | Wynik i dowód |
|---|---|---|---|
| L9.1 | Encje, relacje i reguły opisane dla produktu | **ZAL-R** | 8 tabel `pc_*`; reguły w `module-procurement/src/shared/index.ts` |
| L9.2 | Endpointy i MCP korzystają z tych samych reguł | **ZAL-T** | Wspólne schematy wejścia i wspólny serwis. Test wprost porównuje oba wejścia — to on wykrył pierwotną niespójność kodów błędu |
| L9.3 | Wejścia walidowane w runtime; błędy rozpoznawalne | **ZAL-T** | Zod na obu wejściach; 13 kodów `AppErrorCode` mapowanych na statusy HTTP |
| L9.4 | Agent wyszukuje, przechodzi po relacjach, pobiera szczegóły | **ZAL-R** | Scenariusz `provenance`: pozycja → oferta → dostawca → załącznik → wiersz w pliku |
| L9.5 | Uprawnienia sprawdza backend; identyfikator od modelu nie wystarcza | **ZAL-T** | Własność z ciasteczka, sprawdzana na wierszu w repozytorium; testy 403 |
| L9.6 | Konflikt aktualności nie nadpisuje nowszych danych | **ZAL-T** | Compare-and-set po `version`; test potwierdza, że pierwszy zapis przeżywa |
| L9.7 | Powtórzenie operacji nie dubluje skutków | **ZAL-T** | `IdempotencyStore`; testy dla mutacji pozycji, dodania karty i wiadomości |
| L9.8 | Operacja wieloetapowa atomowa lub z odzyskaniem spójności | **ZAL-T** | Transakcje SQLite w `updateOfferItem` i w tworzeniu artefaktu; test kopii/odtworzenia po checkpoint WAL |
| L9.9 | Testy potwierdzają zmianę danych i odrzucenie nieuprawnionej operacji | **ZAL-T** | 21 testów kontraktowych; dodatkowo scenariusz `mutation` z prawdziwym agentem |

### Warstwa 10 — Trwałość, cache i artefakty

| ID | Kryterium | Status | Wynik i dowód |
|---|---|---|---|
| L10.1 | Własność zgodna z modelem; brak niezależnie mutowanych kopii | **ZAL-T** | Tabela w sekcji 4; `check:boundaries` |
| L10.2 | Migracje bez utraty danych; kopia i odtworzenie sprawdzone | **ZAL-T** | Rejestr `schema_migrations`, każda migracja w transakcji. Test „skopiowany katalog danych otwiera sie z kompletnym stanem" sprawdza artefakty, pliki, canvas i dane domenowe |
| L10.3 | Rozmowa powiązana z sesją Claude i właścicielem | **ZAL-R** | `conversations.claude_session_id` + `owner_id`; po restarcie sesja nadal przypisana |
| L10.4 | Restart przywraca historię, kompozycję, powiązania, artefakty | **ZAL-R** | Wpis #19 — wszystkie cztery sprawdzone |
| L10.5 | Mutacja odświeża właściwe dane bez pełnego przeładowania | **ZAL-R** | `platform.data_changed`/`canvas_changed` → `invalidateQueries`; po scenariuszu `mutation` porównanie zwróciło nową sumę bez restartu |
| L10.6 | Komponenty współdzielą pobrania; klucze uwzględniają kontekst | **ZAL-R** | TanStack Query z kluczami `['module', …]` — trzy karty tej samej sprawy dzielą jedno pobranie |
| L10.7 | Zmiana kontekstu właściciela nie ujawnia poprzedniego cache | **CZĘŚĆ** | `resetOwnerScope()` czyści cache przy nawiązaniu sesji, a backend i tak odmówiłby (403). **Nieprzetestowane w przeglądarce** — aplikacja nie ma UI zmiany użytkownika |
| L10.8 | Artefakt: stabilny id, wersja, właściciel, trwała treść; tytuł nie kluczem | **ZAL-T** | Klucz główny `(artifact_id, version)`; tytuł to zwykła kolumna |
| L10.9 | Podgląd i pełny widok = ta sama wersja; pliki po restarcie | **ZAL-R** | Oba widoki czytają `current_version` z jednego endpointu; `raport.md` pobrany po restarcie |
| L10.10 | Raport historyczny zachowuje treść; artefakt żywy pobiera aktualne dane | **ZAL-T** | Test „artefakt-snapshot zachowuje tresc mimo pozniejszej zmiany danych". Tryb `live` zaimplementowany, ale **nieużyty** w danych demonstracyjnych |

### Warstwa 11 — Pliki, sandbox i cykl życia zadań

| ID | Kryterium | Status | Wynik i dowód |
|---|---|---|---|
| L11.1 | Użytkownik wgrywa plik, agent przetwarza kodem, użytkownik pobiera wynik | **ZAL-R** | Wpis #20: plik → workspace → `Read` → przetworzenie → `raport.md` → artefakt z działającym linkiem. Suma 49 410,00 PLN zgodna z ręcznym rachunkiem |
| L11.2 | Limity wielkości, nazw i zakresu katalogów egzekwowane przez backend | **ZAL-T** | `sanitizeFilename` (odporne na `../`, ścieżki Windows, znaki sterujące), limit 8 MB, allowlista typów, `resolveInWorkspace`. Test przeglądarkowy potwierdza komunikat dla `.exe` |
| L11.3 | Izolacja aktywna; niedozwolony odczyt, zapis i sieć odrzucane | **ZAL-R** | **Sieć:** `deny network-outbound example.com:443`, exit 56 (wpis #24). **Pliki:** `data/app.db` niewidoczna dla procesu, `ls` pokazuje tylko `workspaces` (wpis #25). Treść bazy nie wyciekła |
| L11.4 | Sandbox i uprawnienia obejmują wszystkie sposoby dostępu | **ZAL-R** | Narzędzia plikowe mają `cwd` w workspace i podlegają regułom `filesystem`; powłoka wymaga zgody. Trzy warstwy auto-zatwierdzania rozbrojone (wpisy #17, #23) |
| L11.5 | Brak niejawnego dostępu do bazy domenowej z pominięciem MCP | **ZAL-R** | `denyRead`/`denyWrite` na katalogu danych; potwierdzone rzeczywistą próbą odczytu (wpis #25) i testem konfiguracji |
| L11.6 | Zadanie ma trwały status i powiązanie z rozmową | **ZAL-T** | `agent_runs` + `GET /api/conversations/:id/runs`; zamknięcie panelu nie usuwa wpisu |
| L11.7 | Stop dociera do wykonania i procesów potomnych; pomiar czasu | **CZĘŚĆ** | `AbortController` przekazany do SDK propaguje się na proces CLI. Zmierzona **część aplikacyjna: < 50 ms**. **Niezmierzone** rzeczywiste zatrzymanie procesu modelu |
| L11.8 | Restart rozróżnia zadanie zakończone od przerwanego | **ZAL-T** | `reconcileOnBoot()` oznacza `running` jako `failed` z komunikatem „Przerwane restartem serwera; proces wykonania nie istnieje" i sprząta workspace |
| L11.9 | Pytania i zgody w aplikacji; odmowa nie wykonuje, zgoda nie dubluje | **ZAL-R** | Wpis #23: odmowa → polecenie się nie wykonało; zgoda → prośba dokładnie raz |
| L11.10 | Opublikowane wyniki trwałe po sprzątnięciu tymczasowych | **ZAL-R** | `workspace.dispose()` w `finally`; `raport.md` nadal do pobrania |

### Warstwa 12 — Obserwowalność i odbiór integracji

| ID | Kryterium | Status | Wynik i dowód |
|---|---|---|---|
| L12.1 | Rozmowa ↔ wykonanie ↔ narzędzie ↔ mutacja ↔ artefakt | **ZAL-R** | `conversations` → `agent_runs` (sesja, czasy) → `run_events` (każde wywołanie z argumentami i wynikiem) → `artifacts.conversation_id`. Dostępne przez `GET /api/runs/:id/events` |
| L12.2 | Błędy rozróżnialne; brak sekretów w logach | **ZAL-T** | 13 kodów; `classifyModelError()` rozdziela `unauthenticated`/`model_failed`/`sandbox_denied`/`integration_failed`; testy skanujące |
| L12.3 | Zmierzone czasy z warunkami pomiaru | **CZĘŚĆ** | Zmierzone: pierwsza odpowiedź **6 172–14 458 ms**, wykonanie **7 697–120 055 ms**, anulowanie (część aplikacyjna) **< 50 ms**. **Niezmierzone osobno:** odświeżenie po mutacji — zachodzi w tym samym przebiegu. Warunki: Fedora, Node 24.19.0, `claude-sonnet-4-5`, sieć domowa |
| L12.4 | Testy kontraktów: walidacja, konflikty, powtórzenia, dostęp | **ZAL-T** | 21 testów w `tests/contracts.test.ts` — wszystkie cztery obszary |
| L12.5 | Testy przeglądarkowe: dynamiczny UI, rozmowy, narzędzia, artefakty, wznowienie | **CZĘŚĆ** | 22 testy Playwright na buildzie produkcyjnym, w tym `e2e/agent-ui.spec.ts` — **pełna ścieżka z prawdziwym modelem**: polecenie wpisane w kompozytorze → odpowiedź w czacie → karta na canvasie bez przeładowania → potwierdzenie w backendzie → `TOOL_CALL_*` i narzędzie `mcp__app__*` w `run_events` → przetrwanie przeładowania strony. Pokrywa dynamiczny UI, rozmowy (tworzenie, przełączanie, usuwanie przez menu wiersza), narzędzia i wznowienie po przeładowaniu. **Poza przeglądarką pozostaje:** wytworzenie artefaktu przez agenta i wznowienie po restarcie *backendu* — jedno i drugie pokryte `scripts/acceptance-agent.mjs` (wpisy #19, #20) |
| L12.6 | Ścieżka subskrypcja → SDK → Mastra → AG-UI → OpenUI potwierdzona; mocki oznaczone | **ZAL-R** | Cała ścieżka przejechana 10 razy. **W projekcie nie ma ani jednego mocka Claude** — testy z modelem wołają prawdziwy model, testy bez modelu nie udają, że go mają |
| L12.7 | Opis odbioru: wersje, dowody, nieudane próby, braki, adaptery | **ZAL-R** | Ten dokument |
| L12.8 | System działa bez Langfuse; eksport i ograniczenia udokumentowane | **ZAL-R** | Langfuse niezainstalowany i niewymagany. **Ograniczenie eksportu:** `@mastra/claude` kieruje wywołania narzędzi do telemetrii Mastry, ale aplikacja jej nie odbiera — własne dane są w `run_events`. Podłączenie Langfuse wymagałoby eksportera OTel po stronie Mastry; **nie sprawdzone** |

### Podsumowanie macierzy

Liczby poniżej są **wyliczane z tabel** przez `node scripts/matrix-summary.mjs`, a `pnpm verify`
przerywa build, gdy się rozjadą. Wcześniejsza wersja tego podsumowania była wpisana ręcznie
i podawała 91 kryteriów zamiast 95 — patrz wpis #29.

| Status | Liczba |
|---|---|
| ZAL-R — rzeczywiste wykonanie | 50 |
| ZAL-T — test automatyczny | 33 |
| CZĘŚĆ | 10 |
| KOD — tylko analiza kodu | 2 |
| NIE / BLK | 0 |
| **Razem** | **95** |

**Warstwy zamknięte — 3 z 12:** L2, L4, L9.

**Warstwy otwarte — 9 z 12**, z dokładnym powodem każdego otwarcia:

| Warstwa | Blokujące kryterium | Czego brakuje |
|---|---|---|
| L1 | L1.2 CZĘŚĆ | TS 7 wymaga flagi eksperymentalnej w dev/CLI |
| L3 | L3.2 CZĘŚĆ | `canvas_update_card`, `canvas_move_card`, `canvas_remove_card` nieużyte przez model |
| L5 | L5.2, L5.4 CZĘŚĆ | gotowy czat ignoruje `RUN_STARTED`/`RUN_FINISHED`; renderowanie artefaktu w czacie niesprawdzone wizualnie |
| L6 | L6.3 KOD, L6.5 CZĘŚĆ | `get_context` niewywołane przez model; zachowanie modelu wobec szkicu formularza niesprawdzone |
| L7 | L7.4 CZĘŚĆ | brak próby dwóch równoległych przebiegów na jednej rozmowie |
| L8 | L8.6 KOD | wygaśnięcie poświadczenia i limit niewywołane |
| L10 | L10.7 CZĘŚĆ | brak UI zmiany użytkownika, więc izolacja cache niesprawdzona w przeglądarce |
| L11 | L11.7 CZĘŚĆ | niezmierzony czas zatrzymania procesu modelu |
| L12 | L12.3, L12.5 CZĘŚĆ | niezmierzone osobno odświeżenie po mutacji; brak eksportu telemetrii |

Otwarcie warstwy **nie** znaczy, że funkcja nie działa — znaczy, że któremuś kryterium brakuje
dowodu z rzeczywistego wykonania.

---

## 6. Integracje i własny kod

Rozróżnienie: **biblioteka** = użyta bez zmian; **konfiguracja** = gotowa funkcja ustawiona pod nasz
backend; **adapter** = kod, który trzeba było dopisać, bo gotowe rozwiązanie tego nie dawało.

### 6.1 Most hooków SDK → zdarzenia narzędzi i identyfikator sesji

**Czego brakowało:** `@mastra/claude` 0.3.1 przekazuje do strumienia Mastry **tylko deltę tekstu**.
Wywołania narzędzi idą wyłącznie do telemetrii, a `session_id` nie jest eksponowany w ogóle.
Bez tego nie da się (a) pokazać narzędzi w czacie, (b) wznowić rozmowy.

**Co dopisano:** rejestracja hooków `SessionStart`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Stop` w `sdkOptions`; callback tłumaczy je na zdarzenia AG-UI i przechwytuje
`session_id`. Pomijane jest ruch subagentów (`agent_id`), żeby nie dublować pracy głównego wątku.

**Lokalizacja:** `packages/platform-server/src/agent/runtime.ts` (`hookCallback`).
**Sprawdzenie:** 7 wywołań i 7 wyników sparowanych w przebiegu CSV; sesja związana w każdym przebiegu.
**Ograniczenie:** kolejność zdarzeń to kolejność **zaobserwowana** — tekst i hooki to dwa niezależne
producenty. W praktyce wystarcza, bo czat i tak grupuje po `tool_use_id`.
**Ponowne użycie:** tak, bez zmian — to kod platformy, niezależny od domeny.

### 6.2 Serwer MCP budowany per uruchomienie

**Czego brakowało:** uchwyty narzędzi MCP są wołane z pętli transportu SDK, więc `AsyncLocalStorage`
wywołania `stream()` do nich nie sięga. Jeden współdzielony serwer oznaczałby współdzielony kontekst.

**Co dopisano:** `buildMcpServer()` wołane w `#execute`, z kontekstem domkniętym w closure;
`mcpServers` podawane w per-wywołaniowych `sdkOptions` (adapter je scala — potwierdzone w jego kodzie
i sondą). Dodatkowo kolejka per rozmowa.

**Lokalizacja:** `packages/platform-server/src/agent/{mcp,runtime}.ts`.
**Ponowne użycie:** tak.

### 6.3 `assertMcpCompatibleShape` — strażnik zgodności schematów

**Czego brakowało:** SDK cicho usuwa **cały** serwer MCP, gdy którykolwiek schemat narzędzia zawiera
`z.record()`; a `z.default()` zgłasza pole modelowi jako **wymagane**. Żaden z tych błędów nie jest
raportowany (wpisy #15, #18).

**Co dopisano:** rekurencyjny przegląd schematu każdego narzędzia przy starcie, rzucający błąd
z nazwą narzędzia i ścieżką pola. Śledzi zagnieżdżenie w `optional`/`nullable`, żeby nie fałszować.

**Lokalizacja:** `packages/platform-server/src/agent/mcp.ts`.
**Sprawdzenie:** 10 testów w `tests/mcp-schema.test.ts` + diagnostyka `diag`.
**Ponowne użycie:** tak — i **będzie potrzebny** w każdej kolejnej aplikacji na tym SDK.

### 6.4 `platformAguiAdapter` — kanał zdarzeń platformy

**Czego brakowało:** `processStreamedMessage` z `@openuidev/react-headless` ignoruje `CUSTOM`,
czyli cały kanał platformy.

**Co dopisano:** cienkie opakowanie gotowego `agUIAdapter()`, które przepuszcza każde zdarzenie
bez zmian i **równolegle** obsługuje zdarzenia platformy (unieważnienia cache, prośby o zgodę).
Żaden parser nie został napisany od nowa.

**Lokalizacja:** `packages/platform-ui/src/chat/platformAdapter.ts`.
**Ponowne użycie:** tak.

### 6.5 Kanał artefaktów dla czatu OpenUI

**Czego brakowało:** `restStorage()` implementuje **tylko** kanał `thread`. Bez kanału `artifact`
nawigacja Artefaktów w gotowym czacie w ogóle się nie pojawia.

**Co dopisano:** implementacja `ArtifactStorage` (`list`/`get`/`update`) na naszym API, składana
z kanałem `thread` z `restStorage`.

**Lokalizacja:** `packages/platform-ui/src/chat/chatWiring.ts`.
**Ponowne użycie:** tak.

### 6.6 Endpointy rozmów pod konwencje `restStorage`

**To konfiguracja, nie adapter.** Backend implementuje dokładnie ścieżki, których oczekuje gotowa
fabryka (`/get`, `/create`, `/get/:id`, `/update/:id`, `/delete/:id`), więc czat działa bez
jakiegokolwiek tłumaczenia po stronie klienta.

### 6.7 `subscriptionOnlyEnv` — polityka wyłącznie subskrypcyjna i izolacja powłoki

**Czego brakowało:** SDK nie ma trybu „tylko subskrypcja"; dziedziczy też zmienne nadrzędnej sesji
Claude Code.

**Co dopisano:** filtr środowiska procesu potomnego (sekcja 2) + `scrubbedEnvKeys()` do diagnostyki.
**Lokalizacja:** `packages/platform-server/src/agent/auth.ts`. **Ponowne użycie:** tak.

### 6.8 Ograniczenie `AgentInterface` do panelu bocznego

**Czego brakowało:** `AgentInterface` wymiaruje się do okna (zmierzone 1680×1000 wewnątrz kolumny
560 px), więc wątek i kompozytor renderowały się poza ekranem.

**Co dopisano:** `LayoutContextProvider layout="copilot"` + trzy reguły CSS przypinające kontener do
panelu. To **jedyna** zmiana, jaką wprowadzamy w layout gotowego czatu.
**Lokalizacja:** `packages/platform-ui/src/{chat/ChatPanel.tsx,styles.css}`.

### 6.9 Neutralny kontrakt HTTP dla modułów

**Czego brakowało:** gdyby moduł przyjmował `Hono.Context`, byłby przywiązany do frameworku.

**Co dopisano:** `RouteRegistrar` / `PlatformRequest` / `PlatformResponse` w kontraktach; platforma
montuje je na Hono pod `/api/m/<moduleId>`. **Ponowne użycie:** tak.

### 6.10 Automatyczne rozmieszczanie kart

**Czego brakowało:** gdy agent nie poda geometrii, karta lądowała na (0,0) i zasłaniała pracę użytkownika.

**Co dopisano:** `#nextFreeSlot()` — pod dolną krawędzią istniejącej zawartości.
**Ograniczenie:** gdy agent **poda** geometrię, jest ona respektowana — nakładanie się jest wtedy
możliwe i normalne dla canvasu.

### Co pochodzi wprost z bibliotek (bez naszego kodu)

Pętla agentowa, sandbox, uprawnienia i sesje — Claude Agent SDK. Rejestracja agenta i typy
wykonania — Mastra. Pan/zoom/przeciąganie/zmiana rozmiaru/minimapa — React Flow. Lista rozmów,
kompozytor, strumieniowanie, aktywność narzędzi, przestrzeń artefaktów — OpenUI `AgentInterface`.
Parser OpenUI Lang i renderer — `@openuidev/react-lang`. Katalog komponentów bazowych i wykresy —
`@openuidev/react-ui`. Cache i unieważnianie — TanStack Query. Routing — TanStack Router.

---

## 7. Problemy i ograniczenia

Wpisy z oznaczeniem **[naprawione]** zostawiono celowo — opisują realne pułapki tego stacku.

### P1 — `z.record()` cicho usuwa cały serwer MCP **[naprawione]**

**Objaw:** model twierdzi, że nie widzi żadnych narzędzi aplikacji; `ToolSearch` nic nie znajduje.
**Reprodukcja:** dowolne narzędzie MCP z `z.record()` gdziekolwiek w schemacie wejścia,
SDK 0.3.270 + zod 4.6.5.
**Przyczyna:** brak konwersji `z.record()` na JSON Schema; błąd nieraportowany, znika **cały serwer**.
**Wpływ na użytkownika:** agent bez narzędzi, bez komunikatu wyjaśniającego.
**Rozwiązanie:** `z.looseObject({})` + strażnik przy starcie (6.3).

### P2 — `z.default()` czyni pole MCP wymaganym **[naprawione]**

**Objaw:** narzędzie odrzuca wywołanie bez pola, które ma wartość domyślną:
`Invalid input: expected nonoptional, received undefined`.
**Wpływ:** model marnuje tury na odgadnięcie wymaganych pól.
**Rozwiązanie:** `.optional()` + wartość domyślna w uchwycie; strażnik wykrywa naruszenia.

### P3 — Trzy warstwy auto-zatwierdzania obchodzą bramkę zgody **[częściowo naprawione]**

1. `allowedTools` auto-zatwierdza gołe nazwy przed `canUseTool` — **naprawione**.
2. `sandbox.autoAllowBashIfSandboxed` domyślnie `true` — **naprawione** (`false`).
3. Klasyfikator bezpieczeństwa SDK auto-zatwierdza jawnie bezpieczne polecenia (`echo`) —
   **nie do wyłączenia z poziomu aplikacji**.

**Wpływ:** operacje jednoznacznie nieszkodliwe wykonają się bez pytania. Ryzykowne (sieć,
kasowanie) trafiają do `canUseTool`. Warto to wiedzieć, projektując politykę zgód.

### P4 — Adapter Mastry nie przekazuje narzędzi ani sesji **[obejście]**

Opisane w #4 i 6.1. **Ryzyko na przyszłość:** nowsza wersja `@mastra/claude` może zacząć emitować
zdarzenia narzędzi — wtedy most na hookach zacznie je dublować. Warto sprawdzić przy aktualizacji.

### P5 — Gotowy czat ignoruje zdarzenia `CUSTOM` **[obejście]**

Opisane w #13 i 6.4. Konsekwencja pozostająca: czat nie pokazuje wprost „uruchomienie zakończone" —
rozpoznaje to po zamknięciu strumienia (L5.2).

### P6 — TypeScript 7 i uruchamianie w Node **[obejście]**

Port natywny nie udostępnia API JS, a natywne usuwanie typów nie obsługuje właściwości parametrów
konstruktora. Dev/CLI wymagają `--experimental-transform-types`; produkcja nie. Gdyby jakieś
narzędzie wymagało API JS TypeScriptu, trzeba by doinstalować TS 5.x obok — **nie było potrzebne**.

### P7 — Port 8787 zajęty **[obejście środowiskowe]**

Na tej maszynie 8787 zajmował niepowiązany proces (`herdr-gui`). Aplikacja domyślnie używa
**8791**; zmienna `PORT`.

### P8 — Ostrzeżenie Mastry o braku storage **[zaakceptowane]**

Opisane w #12. Nieszkodliwe; zostawione jako jawny ślad, że pamięć Mastry jest świadomie nieużywana.

### P9 — Nakładające się karty na canvasie **[zaakceptowane]**

Gdy agent poda jawną geometrię, karta może zasłonić istniejące. Automatyczne rozmieszczanie działa
tylko przy braku geometrii. Użytkownik może przesunąć kartę. Testy przeglądarkowe używają
izolowanych przestrzeni (wpis #26).

### P10 — Duży bundle frontendu **[znane]**

`dist/assets/index.js` ≈ 2,65 MB (778 kB gzip) — `@openuidev/react-ui` wciąga Recharts, Radix,
react-markdown i podświetlanie składni. Dla aplikacji lokalnej akceptowalne; dla wdrożenia zdalnego
wymagałoby dzielenia kodu.

### P11 — Nierozwiązane

- Zachowanie przy wygaśnięciu poświadczenia i wyczerpaniu limitu (L8.6) — nie da się wywołać na żądanie.
- Dwa równoległe przebiegi na jednej rozmowie (L7.4) — mechanizm jest, próba współbieżna nieprzeprowadzona.
- Czas zatrzymania procesu modelu po `Stop` (L11.7).
- Eksport telemetrii do Langfuse (L12.8).
- Zachowanie modelu wobec niezapisanego szkicu formularza (L6.5).

---

## 8. Wnioski końcowe

### Czy stack spełnia wymagania

Trzeba rozdzielić dwa pytania, bo pierwsza wersja tego raportu je zlewała (wpis #30).

**Czy stack działa?** Tak. Pełna ścieżka subskrypcja → Claude Agent SDK → Mastra → AG-UI → OpenUI
została przejechana jedenaście razy na prawdziwym modelu, w tym raz **w całości z interfejsu**
— od wpisania polecenia w czacie po kartę na canvasie i przetrwanie przeładowania. Wszystkie
scenariusze produktowe z zadania wykonały się z poprawnym, sprawdzalnym wynikiem.

**Czy stack jest odebrany jako sprawdzony szablon?** Jeszcze nie. Zgodnie z regułą dokumentu
architektury zamknięte są **3 z 12 warstw**; dziewięć pozostaje otwartych z powodu jednego lub
dwóch kryteriów każda, wymienionych imiennie w [podsumowaniu macierzy](#podsumowanie-macierzy).
Żadne z otwarć nie wynika z niedziałającej funkcji — sześć to brakujące próby, dwa to ograniczenie
gotowej biblioteki, jedno jest niewywoływalne na żądanie.

Najważniejsze: **żadne kryterium nie jest zaliczone samą obecnością biblioteki**, a integracja
okazała się istotnie trudniejsza, niż sugerowałaby dokumentacja — trzy realne niezgodności
(`z.record()`, `z.default()`, potrójne auto-zatwierdzanie zgód) były niewykrywalne bez uruchomienia
prawdziwej sesji i bisekcji.

### Wynik rzeczywistej integracji Claude na subskrypcji — oddzielnie

Ta sekcja dotyczy **wyłącznie** tego, co zostało potwierdzone prawdziwym modelem:

| Sprawdzone | Wynik |
|---|---|
| Uwierzytelnienie wyłącznie subskrypcyjne, bez klucza API | działa |
| 21 narzędzi MCP zarejestrowanych i wołanych | działa |
| Wielokrokowa pętla agentowa z narzędziami aplikacji i plikowymi | działa |
| Odczyt danych i pokazanie wyniku backendu na canvasie | działa |
| Mutacja przez reguły domeny z przeliczeniem zależnych widoków | działa |
| Przejście po relacjach do pliku źródłowego | działa |
| Zmiana kompozycji bez gubienia istniejącej pracy | działa |
| Przetworzenie pliku w sandboxie → trwały artefakt | działa |
| Wznowienie rozmowy po restarcie bez powtórzenia mutacji | działa |
| Zgoda i odmowa użytkownika na operację powłoki | działa |
| Izolacja sandboxa: sieć i katalog danych | działa |
| Strumieniowanie przyrostowe | działa |
| Wygaśnięcie poświadczenia / limit | **niesprawdzone** |
| Dwa równoległe przebiegi na jednej rozmowie | **niesprawdzone** |

Wszystkie pozostałe wyniki w tym raporcie pochodzą z testów bez modelu i są tak oznaczone.

### Co z platformy jest gotowe do ponownego użycia

Bez żadnych zmian: powłoka UI (nawigacja, canvas, host czatu), katalog komponentów z walidacją po
obu stronach, rozmowy i mapowanie sesji Claude, rejestr uruchomień i strumień AG-UI, host MCP ze
strażnikiem schematów, magazyn plików i artefaktów z wersjonowaniem, workspace i sandbox,
idempotencja, optymistyczna współbieżność, sesja aplikacji, kontrola granicy modułów,
diagnostyka `diag` i skrypty odbiorowe.

### Co trzeba dostarczyć dla nowej domeny

Moduł biznesowy to **dwie połowy i żadnej zmiany w platformie**:

**Serwer** (`ServerModule`): migracje SQL z własnym prefiksem tabel · serwisy domenowe (czysta
logika, testowalna bez modelu i bez UI) · narzędzia (`ModuleToolDefinition`) — cienkie nakładki na
serwisy, ze schematami Zod **bez `z.record()` i bez `z.default()`** · opcjonalne trasy HTTP przez
`RouteRegistrar` · `cardComponents` — serwerowa połowa katalogu · `agentBriefing` — słownik domeny,
**nie reguły** · `describeResource` · `defaultComposition` · `seed`.

**Przeglądarka** (`UiModule`): renderery kart pobierające dane z backendu (props tylko referencje) ·
opcjonalne komponenty OpenUI Lang przez `defineComponent` · pozycje menu.

**Warstwa składania:** dwie linijki w `apps/server/src/compose.ts` i `apps/web/src/compose.tsx`.

Szacunek na podstawie modułu zakupowego (8 tabel, 9 narzędzi, 7 komponentów, 4 ekrany):
**ok. 2 000 linii kodu modułu**, z czego mniej więcej połowa to czysta logika domenowa, a reszta
to deklaratywne opakowania. Platforma to ok. 5 000 linii, których nie trzeba pisać ponownie.

### Luki, które pozostają

Wymienione w sekcji 7 (P11) i oznaczone w macierzy jako CZĘŚĆ lub KOD. Żadna nie blokuje
używania aplikacji; każda jest brakiem **dowodu**, nie brakiem **funkcji** — z wyjątkiem eksportu
telemetrii do Langfuse, którego po prostu nie podłączono.
