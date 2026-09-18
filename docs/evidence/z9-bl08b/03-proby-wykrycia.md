# Próby zdolności wykrycia (G16) — pakiet BL-08b

Procedura każdej próby: commit najpierw, próba na czystym drzewie, wycofanie **jednej** rzeczy,
uruchomienie wskazanego testu, `git checkout -- <plik>`, sprawdzenie `git status --porcelain`.
Po każdej próbie drzewo było puste (zapisane w przebiegach jako `czystosc: []`).

Dwie próby (T4 i T9) **oblały po stronie testu, a nie kodu** — obie zostały opisane niżej i obie
skończyły się wzmocnieniem asercji, nie rozluźnieniem.

| Próba | Co wycofano | Test | Wynik |
|---|---|---|---|
| **T1** | `chat/platformAdapter.ts`: ponowne podłączenie po strumieniu wysłania, który skończył się przed uruchomieniem | `e2e/run-events.spec.ts -g "zatrzymanie z kompozytora"` | oblewa na `run-events.spec.ts:149` — „zakladka nie pokazala anulowania”, faza została w `running` przez pełne 25 s |
| **T2u** | `agent/runtime.ts`: emisja `platform.permission_resolved` | `tests/run-reconnect.test.ts` | oblewają 3 z 5 testów (zgoda, wygaśnięcie, Stop przy zgodzie) |
| **T2b** | to samo | `e2e/reconnect-live.spec.ts -g "prosba o zgode rozstrzygnieta"` | oblewa na `reconnect-live.spec.ts:295` — po przeładowaniu faza zostaje `awaiting_consent` |
| **T3** | `agent/events.ts`: stempel `PLATFORM_CUSTOM_PAYLOAD_VERSION` w `custom()` | `tests/agui-conformance.test.ts` | oblewają 3 z 5, reguła `custom_payload` na pozycji zdarzenia (`platform.session_bound`, `platform.artifact_created`, `platform.run_cancelled`, `platform.permission_request`) |
| **T4** | `e2e/support/scripted-agent.ts`: krok `tool` z `inline` traktowany jak zwykły (hooki przed strumieniem) | `e2e/run-events.spec.ts -g "tekst przed narzedziem"` | **pierwsze podejście: oblała tylko asercja dziennika (`:262`), asercja ekranowa przeszła** — patrz niżej. Po poprawce testu oblewa też na `:276` |
| **T5** | `agent/runtime.ts`: emisja `TOOL_CALL_RESULT` w haku `PostToolUse` | `e2e/run-events.spec.ts -g "tresc udanego wyniku"` | oblewa na `run-events.spec.ts:203` — „probki z trescia: 0” |
| **T6** | `chat/ArtifactPane.tsx`: renderer wybierany na sztywno zamiast po `a.type` | `e2e/artifact-renderers.spec.ts` | oblewa na `artifact-renderers.spec.ts:130` — artefakt typu nierejestrowanego narysowany jako `[]` |
| **T7** | `agent/runtime.ts`: przestrzeń nazw `runId` w `scopeToolId` | `tests/run-correlation.test.ts` | oblewa „hooki narzedzi i zdarzenia domeny trafiaja do strumienia swojego uruchomienia” |
| **T8** | `chat/ChatPanel.tsx`: podgląd `streaming-answer` w pasku uruchomienia | `e2e/run-events.spec.ts -g "proza w turze z narzedziem"` | oblewa na `run-events.spec.ts:443` — brak próbek z podwojeniem (`strip` stale 0) |
| **T9** | `agent/runtime.ts`: `pending.runId !== input.runId` w `answerPermission` | `tests/run-correlation.test.ts`, `tests/consent.test.ts` | **pierwsze podejście: `run-correlation` przeszedł**, oblał tylko `consent.test.ts` — patrz niżej. Po poprawce testu oblewa też `run-correlation` |

## T4 — próba złapała test

Asercja „proza była na ekranie, zanim pojawiło się wywołanie” czytała **cały panel** (`.pf-chat`).
Pasek uruchomienia tej aplikacji maluje fragment tekstu w tym samym takcie, w którym dociera, a oś
biblioteki dopiero w następnej klatce — więc panel przez chwilę pokazuje „proza bez narzędzia” także
wtedy, gdy wywołanie dotarło pierwsze. Pomiar przeniesiony do `.openui-agent-thread-messages`
(rendering samej biblioteki), gdzie próba oblewa na oczekiwanej linii.

Przy okazji zmierzone i zapisane w teście: po narysowaniu wywołania gotowy wątek stawia je **nad**
poprzedzającą je prozą (proza na pozycji 35 bez wywołania, potem wywołanie na 56 i proza na 88).
Kolejność przestrzenna nie jest więc asercjonowana — dowodem jest czas pojawienia się i dziennik.

## T9 — próba złapała test

Przy dwóch różnych `requestId`, każdym odpowiedzianym pod własnym adresem, związanie odpowiedzi z
uruchomieniem nie jest w ogóle wykonywane — test mówił prawdę o niezależności bramek i nic o
związaniu. Test odpowiada teraz najpierw pod **cudzym** adresem i wymaga `answered === false`.
