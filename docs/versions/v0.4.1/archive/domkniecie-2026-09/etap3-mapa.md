# ETAP 3 — mapa ostrzeżeń Mastra storage (READ-ONLY, @mastra/core 1.66.0)

Zapisane przez orkiestratora z raportu subagenta (agent był read-only).

Źródło ostrzeżenia: `node_modules/@mastra/core/dist/mastra-B-GDpHtP.js:1013-1021`
(warunek: brak `config?.storage` → `new InMemoryStore()` L1015, flaga `#storageFallbackWarningPending` L1016,
`warn(...)` przez `queueMicrotask` L1020; identycznie `dist/mastra-De7KUlhk.cjs:1020`; wersja: `node_modules/@mastra/core/package.json:3`).
Tekst: „No `storage` configured on Mastra — falling back to an in-memory store…".

| miejsce | storage? | ostrzeżenie? | testy dotknięte | asercje o trwałości | wniosek |
|---|---|---|---|---|---|
| produkcja: `packages/platform-server/src/agent/runtime.ts:175-177` (`new Mastra({agents:{appAgent}})`), tworzona z `src/index.ts:180` | brak → InMemoryStore | TAK, przy każdym boocie | każdy test przez `createPlatform` (14 plików, m.in. `tests/helpers.ts:47`) i każdy proces e2e (`e2e/support/scripted-server.ts:19` → `apps/server/src/compose.ts`) | żadne — Mastra używana wyłącznie do `getAgent('appAgent')` (`runtime.ts:183`); `@mastra/claude` nie referuje storage (grep dist = 0) | przypadkowe (storage martwy; szum w logach — dowód wycieku: `docs/evidence/z13-bl12/proby-wykrycia-D-1-szuflada-nad-canvasem.json:28`) |
| `tests/observability.test.ts:21` (`new Mastra({agents:{}})`) | brak | TAK | ten plik | brak | zamierzone (komentarz 4-18: punkt wpiecia telemetrii) |
| `tests/observability.test.ts:26-30` (logger-mok) | brak | TAK → mok `warn` | ten plik; asercje 34–35 nie kolidują | brak | zamierzone; przeciek ostrzeżenia do moka przypadkiem |
| 16 plików z `new AgentRuntime` (runtime.test, background-runs, run-lifecycle, session-transcript, measurements, views-foundation…) | brak | TAK, 1/instancję | jw. | asercje trwałości po `services.*` (własna baza) | przypadkowe |
| e2e | brak | TAK, w logach serwera | wszystkie przez `scripted.restart()` (`e2e/support/scripted.ts:250-254`) | własna baza | przypadkowe |
| scripts/ | brak | nie | — | — | brak instancji |

## Warstwa trwałości poza Mastrą
- `app.db` = `<APP_DATA_DIR>/app.db` (`src/config.ts:138-141`), better-sqlite3+Drizzle, WAL (`src/db/client.ts:1-15`).
- Tabele: users, canvas_spaces/cards, conversations, messages, agent_runs, run_events, files, artifacts, artifact_versions, idempotency_keys, app_settings, message_attachments (`src/db/migrations.ts:19–152, 262`).
- Mastra (InMemoryStore) niczego nie trzyma dla aplikacji: rozmowy/wiadomości `conversations/messages` (`conversations.ts:68,339,401`), przebiegi `agent_runs/run_events` (`runs.ts:260`), wznowienie sesji po `claude_session_id` z własnej bazy (`conversations.ts:37`, `runtime.ts:529-566`).

## Testy o restarcie/trwałości — WSZYSTKIE: własna baza/proces, ZERO pamięci Mastry
- run-lifecycle.test.ts:189–207 (restart platformy, asercje conversations.messages); contracts.test.ts:405–421; publication.test.ts:373–385; live-artifacts.test.ts:267–300; runtime.test.ts:257–263 (reconcileOnBoot — runs.ts:260); run-reconnect.test.ts:242–281; domain-guarantees.test.ts:975–989 (idempotency.ts:91); base-data.test.ts:12–21; durability.test.ts:216–294; ui-snapshot.test.ts:409–425 (aplikacyjny in-memory UiSnapshotStore, zamierzony); e2e: tool-activity 168–238, background-tasks 114–200, app-context 254–547, session-restore; e2e/support/scripted.ts:250–254.
- Wzmianki bez asercji trwałości Mastry: dev-proxy.test.ts:143, run-correlation.test.ts:188, chat-history.test.ts:648.

## Adaptery storage
Brak @mastra/libsql/sqlite/pg/cloudflare w package.json (root L56; platform-server L12–13: @mastra/claude 0.3.1 + core 1.66.0) i lockfile (grep 0). Tranzytywnie tylko @mastra/schema-compat 1.3.9. → WARIANT A wymaga nowej zależności.

## Zamierzone vs przypadkowe
Zamierzone: observability.test.ts:21; ui-snapshot.test.ts:415–425. Przypadkowe: wszystkie createPlatform/AgentRuntime/e2e. Żaden test nie asertuje treści ostrzeżenia ani nie czyta z InMemoryStore (grep = 0).

## Werdykt
Ostrzeżenie rzeczywiste (produkcja+testy+e2e), ale magazyn martwy; niegroźne dla asercji, szkodliwe dla czystości logów/dowodów. Wariant B nie łamie żadnej asercji; wariant A wymaga zależności, a test restartu i tak asertuje po własnej bazie.
