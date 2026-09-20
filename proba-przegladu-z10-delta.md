# Próba przeglądowa z10-delta (L9.7) — recenzent, worktree rev-z10b, gałąź przeglad/z10-delta

Niezależny przebieg recenzenta delty `84cbb2e..e85dce8`. Zapis poza `docs/evidence/` (celowo),
jako próbę na gałęzi przeglądowej. Zero tur modelu; plik poświadczeń nietknięty; drzewo robocze
po próbach przywrócone do `e85dce8` (`git status --porcelain` pusto).

| Krok | Polecenie | Wynik |
|---|---|---|
| Instalacja i build (worktree bez node_modules) | `pnpm install --frozen-lockfile`, `pnpm --filter @app/web build`, `pnpm --filter @app/server build` | 3.4 s (store), build OK |
| Scena `bl09-l97` (jedyny uruchamiany spec; bez `APP_WRITE_EVIDENCE` — nic nie zapisano do `docs/evidence/`) | `pnpm exec playwright test e2e/idempotent-tools.spec.ts` | **1 passed** (12.7 s); instancja scenariuszowa 8797 (`.e2e-scripted-l97`), webServer 8799 (`.e2e-data`), etykieta `agenticapp-test` |
| Próba negatywna: cofnięcie wymagalności klucza — jedna linia w `packages/platform-server/src/agent/tools/canvas.ts`: `operationId: OPERATION_ID,` → `operationId: OPERATION_ID.optional(),` | ten sam spec | **1 failed** na asercji strażnika: `expect(keyless[0].isError, 'wywolanie bez klucza mialo byc odrzucene').toBe(true)` — Received: false, czyli wywołanie bez klucza przeszło do handlera; spec czuje dokładnie tę linię |
| Przywrócenie | `git checkout -- packages/platform-server/src/agent/tools/canvas.ts` | drzewo czyste, `e85dce8` |
| Kontrole plikowe | `pnpm check:acceptance`, `pnpm check:matrix`, `pnpm check:closure`, `npx vitest run tests/evidence-provenance.test.ts` | spójność OK (warstwy zamknięte 5/12), macierz zgodna, closure OK, **10/10** provenance |

Scena przeglądarkowa uruchomiona wyłącznie jako ta jedna; pełny suite e2e i pełny vitest nieuruchomione.
