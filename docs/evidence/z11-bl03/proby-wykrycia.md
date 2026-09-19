# Próby zdolności wykrycia — BL-03, faza 1

Procedura (G16): commit najpierw, próba na czystym drzewie, wycofanie **jednej linii**, test oblewa
**w spodziewanym miejscu**, `git checkout -- <plik>`, drzewo znów czyste.

Commit, na którym wykonano próby: `2d4b598` („BL-03 faza 1: projekt prob modelowych, proba
generalna, zero tur wydanych”).

| # | Co wycofano | Co miało oblać | Czym oblało |
|---|---|---|---|
| T1 | `strictMcpConfig: true` w `packages/platform-server/src/agent/runtime.ts` (sdkOptions) | `tests/runtime.test.ts` „uruchomienie przekazuje SDK strictMcpConfig i wylacznie serwer »app«” | `tests/runtime.test.ts:585` — `bez strictMcpConfig sesja dostaje takze serwery MCP skonfigurowane na koncie: expected undefined to be true`; 1 failed / 25 passed |
| T2 | doklejenie `toolEffectNote(def.effect)` do opisu narzędzia w `agent/mcp.ts` | `tests/mcp-published-schema.test.ts` „kazde zadeklarowane narzedzie jest ogloszone, z opisem i schematem obiektu” | `tests/mcp-published-schema.test.ts:81` — `get_context: opis nie podaje skutku`; 1 failed / 2 passed |
| T3 | `input.operationId` → `undefined` w `services/canvas.ts` `removeCard` (klucz idempotencji) | `tests/contracts.test.ts` „usuniecie karty … nie powtarza sie” | `tests/contracts.test.ts:282` — `AppError: Card crd_… not found.` (powtórzenie stało się drugim, prawdziwym usunięciem); 1 failed / 21 passed |
| T4 | — (tryb diagnostyki, nie wycofanie) `pnpm --filter @app/server diag -- --proba-niezgodnego-schematu` | porównanie „zadeklarowane vs. w sesji” ma wykryć cichą utratę narzędzi | serwer MCP melduje się jako `connected` z **zerem narzędzi i bez błędu**; diagnostyka: `BRAKUJACE narzedzia (2)`, kod wyjścia **1** |
| T5 | — (tryb diagnostyki) `pnpm --filter @app/server diag -- --proba-bez-izolacji-mcp` | kontrola obcych serwerów MCP ma wykryć brak `strictMcpConfig` | `UWAGA: obce serwery MCP w sesji: claude.ai Claude Docs[claudeai]`, kod wyjścia **1** |
| T6 | `spec_version = spec_version + 1` w `services/canvas.ts` `updateSpec` (próba przeglądarkowa) | `e2e/bl03-rehearsal.spec.ts` „A: cztery operacje kompozycji …” | `e2e/bl03-rehearsal.spec.ts:126` — `expect(afterChange.specVersion).toBeGreaterThan(created.card!.specVersion)`; 1 failed. Po przywróceniu i przebudowie: 8 passed |
| T7 | rejestr grantu ustawiony na `wydane: 25` (wyczerpany) | spec płatny ma zostać **pominięty**, zanim cokolwiek pójdzie do modelu | `pnpm test:e2e:z11 e2e/bl03-model-relations.spec.ts` → **1 skipped, 0 uruchomionych**, rejestr nadal `25` |

## Uwaga do T4 i T5

To nie są wycofania linii, tylko **tryby samej diagnostyki**: budują sesję z serwerem, który ma
niekonwertowalne narzędzie, albo bez `strictMcpConfig`. Zostały tu wpisane, bo pełnią tę samą rolę —
pokazują, że kontrola potrafi oblać — i mają tę przewagę, że są powtarzalne jednym poleceniem, bez
edytowania kodu. T5 jest zależne od maszyny: tam, gdzie do konta nie jest podpięty żaden łącznik MCP,
nie ma czego znaleźć i tryb kończy się kodem 0. To uczciwe „nie do odtworzenia tutaj”, nie zaliczenie.

## Uwaga do T7 — dlaczego z bezpiecznikiem

Sprawdzenie „spec pomija się przy wyczerpanym grancie” trzeba wykonać na prawdziwym specu, a gdyby
pominięcie zawiodło, próba wydałaby turę — czyli zepsułaby dokładnie to, czego pilnuje. Na czas próby
do `typeCommand` (`e2e/support/bl03-checks.ts`) dopisano jedną linię rzucającą wyjątek, gdy ustawiona
jest zmienna `Z11_PROBA_BEZ_WYSYLANIA`: gdyby test jednak wszedł w ciało, nic nie zostałoby wpisane w
kompozytor. Bezpiecznik **nie zadziałał** (test został pominięty), a linia została usunięta po próbie;
drzewo sprawdzone jako czyste.
