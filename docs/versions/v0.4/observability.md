# Obserwowalność i eksport telemetrii

Stan na 2026-09-18. Wersje: `@mastra/core` 1.66.0, `@mastra/claude` 0.3.1,
`@anthropic-ai/claude-agent-sdk` 0.3.270.

## Co aplikacja rejestruje sama

Diagnostyka nie zależy od żadnej usługi zewnętrznej. Każde uruchomienie agenta ma
trwały ślad w bazie aplikacji:

| Tabela | Zawartość | Do czego służy |
|---|---|---|
| `agent_runs` | rozmowa, właściciel, status, `claude_session_id`, `enqueued_at`, `started_at`, `finished_at`, `first_token_ms`, `duration_ms`, kod i treść błędu | powiązanie rozmowy z wykonaniem i pomiary czasu |
| `run_events` | pełna, ponumerowana sekwencja zdarzeń AG-UI jednego uruchomienia | odtworzenie przebiegu co do zdarzenia, także po restarcie |
| `messages` | wiadomości rozmowy, w tym `toolCalls` i wyniki narzędzi (`role: "tool"`) | powiązanie rozmowy z narzędziem i jego wynikiem |
| `artifacts`, `artifact_versions` | artefakty i ich wersje, z `conversation_id` i `run_id` | powiązanie rozmowy i **wykonania** z artefaktem |

Punkty pomiaru są rozdzielone świadomie i opisane w kontrakcie `agentRunSchema`:
**zakolejkowanie** (`enqueuedAt`), **start wykonania** (`startedAt`, po zwolnieniu
kolejki rozmowy), **pierwszy tekst** (`firstTokenMs`, liczony od startu wykonania),
**koniec** (`finishedAt`, `durationMs`). Czas oczekiwania w kolejce (`queuedMs`)
jest raportowany osobno, więc uruchomienie czekające za innym nie jest obciążane
cudzym czasem.

### Brak metryki to nie zero

`firstTokenMs` jest `null`, kiedy uruchomienie nie wypowiedziało ani słowa —
na przykład wykonało narzędzie i skończyło. Zero znaczyłoby „natychmiast”, więc
podstawienie go zamieniłoby brak pomiaru w pomiar wyjątkowo dobry. Reguła
obowiązuje też w zapisie dowodu: `null` przechodzi do pliku jako `null` i jest
liczony osobno (`brakMetryki`).

## Powiązanie rozmowy z tym, co się wydarzyło

Łańcuch **rozmowa → wykonanie → narzędzie → mutacja → artefakt** da się przejść
w obie strony, wyłącznie po danych zapisanych:

1. `agent_runs.conversation_id` — rozmowa i jej wykonania;
2. `run_events` (`TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_RESULT`) —
   które narzędzie, z jakimi argumentami i z jakim wynikiem;
3. wynik narzędzia niesie **identyfikator rekordu i jego wersję**, a zdarzenie
   `platform.data_changed` — listę zmienionych zasobów;
4. `platform.artifact_created` oraz `artifacts.run_id` — który przebieg
   wytworzył artefakt. Artefakt zapisany poza wykonaniem ma `run_id = NULL`:
   powiązanie jest zapisywane, nigdy domyślane.

## Klasy błędów

Zapisane dane rozróżniają pięć rzeczy, bo każda znaczy co innego dla następnego
kroku — i piąta z nich nie jest zapisana tam, gdzie pozostałe:

| Kod | Kiedy | Gdzie widać |
|---|---|---|
| `model_failed` | strumień modelu istniał i zgłosił awarię | `agent_runs.error_code`, zdarzenie `RUN_ERROR` |
| `integration_failed` | wywołanie adaptera nie dało strumienia, albo minął limit czasu przebiegu | jw. |
| `sandbox_denied` | izolacja odmówiła albo była niedostępna | jw. |
| `rate_limited` / `unauthenticated` | limit GLM albo błąd konfiguracji dostępu GLM | jw. + ekran Ustawień |
| `domain_rule_violated` | reguła domeny odmówiła — to **nie** jest awaria przebiegu | wiadomość `role: "tool"` z `meta.isError`; uruchomienie kończy się jako `succeeded` |

Sam komunikat nie wystarcza do rozdzielenia dwóch pierwszych: „connection
reset” brzmi tak samo, gdy strumień nigdy nie powstał i gdy padł w trakcie.
Dlatego awarię ze strumienia opakowuje `ModelStreamError`, a klasyfikację robi
jedna funkcja — `classifyRunFailure` w `agent/runtime.ts`.

## Pomiary w regresji

Pomiary wytwarza regresja szablonu, nie ręczny przebieg:
`tests/measurements.test.ts` (`pnpm test`) i `e2e/measurements.spec.ts`
(`pnpm test:e2e`) zapisują wyniki do `docs/evidence/z3-bl05/`. Każdy pomiar
niesie zdanie „co”, zdarzenie **od**, zdarzenie **do**, warunki niezależne od
maszyny i liczbę próbek, a cały rekord — wersję kodu (commit, czystość drzewa,
wersje Node, Mastry i SDK). Milisekundy zależą od maszyny; powtarzalne jest to,
co asertuje regresja: kolejność punktów, ich rozdzielenie i obecność albo brak
metryki.

Stop jest mierzony jako **osobne momenty**, nie jako jedna liczba: potwierdzenie
żądania (`POST /api/runs/:id/cancel`), zakończenie strumienia (faza końcowa w
karcie użytkownika) i zakończenie procesów uruchomienia (zniknięty katalog
`workspace`, uruchomienie poza `/api/runs/active`, zakończony proces potomny).
Jedna liczba musiałaby znaczyć albo „backend cię usłyszał”, albo „praca
stanęła”, a to są różne chwile.

## Storage Mastry — świadome ograniczenie

Przy każdym uruchomieniu platformy @mastra/core 1.66.0 bez konfiguracji
`storage` sam buduje sobie zapasowy magazyn w pamięci i ostrzega: „No
`storage` configured on Mastra — falling back to an in-memory store…”.
Ostrzeżenie było prawdziwe, ale magazyn, którego dotyczyło, jest w tej
aplikacji martwy:

- Mastra służy wyłącznie jako rejestr agenta — aplikacja sięga do instancji
  tylko po `getAgent('appAgent')` (`agent/runtime.ts`), a adapter
  `@mastra/claude` 0.3.1 nie odwołuje się do storage w ogóle;
- trwałość realizuje **własna baza** (`app.db`): rozmowy i wiadomości
  (`conversations`, `messages`), przebiegi i ich zdarzenia (`agent_runs`,
  `run_events`), artefakty (`artifacts`, `artifact_versions`); wznowienie
  sesji idzie po `claude_session_id` z tej bazy, nie z pamięci Mastry;
- żadna asercja regresji i żadne kryterium restartu nie czyta z magazynu
  Mastry — wszystkie próby trwałości asertują po własnej bazie albo po
  procesie.

Dlatego konfiguracja jest **jawna i świadomie in-memory** (`InMemoryStore`
z publicznego eksportu `@mastra/core/storage`), z komentarzem na miejscu w
`agent/runtime.ts`. Wariant z prawdziwym adapterem (@mastra/libsql,
@mastra/pg) odrzucony: żaden adapter storage nie występuje w drzewie
zależności, więc oznaczałby nową zależność — decyzję właściciela — a nie dał
nic, bo nie ma czego w Mastrze przechowywać. Ta sama jawna konfiguracja jest
w instancjach testowych `tests/observability.test.ts`, które bez tego
zanieczyszczały wyjście regresji i mok loggera ostrzeżeniem o fallbacku.

Regresję pilnuje strażnik w `tests/runtime.test.ts`: tworzy platformę przez
`createPlatform`, przechwytuje ostrzeżenia i asertuje, że dokładnie ten
komunikat nie wrócił. Kontrola negatywna potwierdziła, że po usunięciu jawnej
konfiguracji strażnik pada z pełną treścią ostrzeżenia.

## Langfuse — stan faktyczny

**Langfuse nie jest zainstalowany i nie jest wymagany.** Aplikacja uruchamia się,
wykonuje zadania i raportuje przebieg bez niego; potwierdza to każdy przebieg
testów, w których żadna zależność Langfuse nie występuje w drzewie zależności.

### Gdzie jest punkt wpięcia

Mastra 1.66.0 przyjmuje obserwowalność w konfiguracji instancji:

```ts
new Mastra({
  agents: { appAgent },
  observability: new Observability({
    configs: { default: { serviceName: 'mastra', exporters: [/* eksporter */] } },
  }),
});
```

**Wymagany jest osobny pakiet.** `Observability` i `MastraStorageExporter`
pochodzą z `@mastra/observability`, którego ten projekt **nie instaluje**.
Przekazanie w to miejsce zwykłego obiektu eksportera nie działa: Mastra zgłasza
`Observability configuration error: Expected an Observability instance…` i
**wyłącza** obserwowalność. Ta odpowiedź jest sprawdzona, nie domniemana —
`tests/observability.test.ts` pinuje ją jako kontrakt, razem z faktem, że ani
`@mastra/observability`, ani Langfuse nie są zainstalowane.

Podłączenie Langfuse oznacza zatem trzy kroki, nie jeden: dodanie
`@mastra/observability`, dodanie eksportera Langfuse i przekazanie instancji
`Observability` przy tworzeniu `Mastra` w `AgentRuntime`. Żaden z nich nie wymaga
zmian w reszcie aplikacji.

### Ograniczenia, których nie należy pomijać

1. **Telemetria Mastry nie jest źródłem prawdy tej aplikacji.** `@mastra/claude`
   0.3.1 przekazuje do strumienia Mastry wyłącznie przyrosty tekstu; wywołania
   narzędzi trafiają do telemetrii adaptera, ale nie do strumienia. Dlatego
   aplikacja odtwarza aktywność narzędzi z hooków Claude Agent SDK i zapisuje ją
   w `run_events` oraz `messages`. Eksport do Langfuse pokazałby obraz Mastry,
   który **nie zawiera** tych zdarzeń w tej samej postaci.
2. **Eksport wyniósłby dane rozmowy poza maszynę.** Treści poleceń, odpowiedzi i
   argumenty narzędzi to dane biznesowe użytkownika. Włączenie eksportu jest
   decyzją o wysyłce tych danych do usługi zewnętrznej i wymaga świadomej zgody —
   dlatego nie jest domyślne.
3. **Nie sprawdzono zgodności z konkretną wersją Langfuse.** Punkt wpięcia został
   zweryfikowany po stronie Mastry; zgodność schematu spanów Langfuse z tą wersją
   Mastry pozostaje niesprawdzona i zostałaby ustalona dopiero przy podłączaniu.
4. **Sekrety.** Gdyby eksport został włączony, obowiązuje ta sama zasada, co w
   logach aplikacji: żadna wartość poświadczenia nie może trafić do eksportu.
   `tests/durability.test.ts` sprawdza brak wartości tokena w zbudowanym
   backendzie, zbudowanym frontendzie, bazie danych i wyjściu diagnostycznym;
   `tests/diagnostics.test.ts` dokłada kanarka wstawionego do środowiska procesu
   i szuka go w przechwyconych logach, w `agent_runs`, `run_events`, `messages`,
   w odpowiedzi `/api/status`, w plikach bazy (razem z dziennikiem WAL) i w
   plikach dowodów; `e2e/measurements.spec.ts` skanuje wyjście serwera
   produkcyjnego po pełnej turze. Dla eksportu zewnętrznego analogicznej
   kontroli **nie wykonano**, bo nie ma czego kontrolować przy wyłączonym
   eksporcie.
