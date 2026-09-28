# Obserwowalność i eksport telemetrii

Stan na 2026-09-15. Wersje: `@mastra/core` 1.66.0, `@mastra/claude` 0.3.1,
`@anthropic-ai/claude-agent-sdk` 0.3.270.

## Co aplikacja rejestruje sama

Diagnostyka nie zależy od żadnej usługi zewnętrznej. Każde uruchomienie agenta ma
trwały ślad w bazie aplikacji:

| Tabela | Zawartość | Do czego służy |
|---|---|---|
| `agent_runs` | rozmowa, właściciel, status, `claude_session_id`, `enqueued_at`, `started_at`, `finished_at`, `first_token_ms`, `duration_ms`, kod i treść błędu | powiązanie rozmowy z wykonaniem i pomiary czasu |
| `run_events` | pełna, ponumerowana sekwencja zdarzeń AG-UI jednego uruchomienia | odtworzenie przebiegu co do zdarzenia, także po restarcie |
| `messages` | wiadomości rozmowy, w tym `toolCalls` i wyniki narzędzi (`role: "tool"`) | powiązanie rozmowy z narzędziem i jego wynikiem |
| `artifacts`, `artifact_versions` | artefakty i ich wersje, z `conversation_id` | powiązanie rozmowy z artefaktem |

Punkty pomiaru są rozdzielone świadomie i opisane w kontrakcie `agentRunSchema`:
**zakolejkowanie** (`enqueuedAt`), **start wykonania** (`startedAt`, po zwolnieniu
kolejki rozmowy), **pierwszy tekst** (`firstTokenMs`, liczony od startu wykonania),
**koniec** (`finishedAt`, `durationMs`). Czas oczekiwania w kolejce (`queuedMs`)
jest raportowany osobno, więc uruchomienie czekające za innym nie jest obciążane
cudzym czasem.

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
   dla eksportu zewnętrznego analogicznej kontroli **nie wykonano**, bo nie ma
   czego kontrolować przy wyłączonym eksporcie.
