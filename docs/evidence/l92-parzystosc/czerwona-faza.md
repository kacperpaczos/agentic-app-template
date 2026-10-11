# L9.2 parzystość HTTP/MCP — faza czerwona (TDD)

- Repo: `/home/paczos/Documents/agentic-app-template`, gałąź `feat/l92-parzystosc`
- Punkt wyjścia: commit `4bf99a7` (kanon v0.4.1; kod niezmieniony — test pisany PRZED poprawkami)
- Data: 2026-10-11
- Test: `tests/parity-http-mcp.test.ts` (nowy plik — deklaratywna macierz `(operacja, przypadek) → {mcp, http, expected}`)
- Polecenie: `pnpm vitest run tests/parity-http-mcp.test.ts`
- Wynik: **exit 1 — 13 failed | 29 passed (42)**

## Ważne odchylenie od rozpoznania T09

Rozpoznanie (cytaty z ~L258 i ~L294 `index.ts`) było **częściowo nieaktualne** wobec kanonu
`4bf99a7`. Już obecne w kodzie na starcie:

1. walidacja `POST /cases/:caseId/criteria` współdzielonym `criteriaWeightsInput`
   (`parseOrThrow`, index.ts ~L299-307) — poprawka nr 1 **jest w kanonie**;
2. walidacja `GET /search` współdzielonym `searchInput` (index.ts ~L341-352) —
   połówka HTTP poprawki nr 2 **jest w kanonie**;
3. `saveComparisonArtifact` owinięte w `platform.idempotency.once` (services.ts ~L342-374) —
   połówka idempotencji poprawki nr 3 **jest w kanonie**.

Dlatego faza czerwona pada **nie** na `set_criteria_weights`/`search` (ich wiersze
parzystości przechodzą już na startcie — 29 zielonych), lecz na realnie istniejące braki:
brak drzwi HTTP dla `save_comparison` i `list_offers`, gołe `z.string()` w narzędziach
`get_case` i `find_price_provenance` oraz brak podłogi limitu w `ProcurementService.search`.

## Padające asercje (13) — przypisane do poprawek

### Poprawka 3 (HTTP save_comparison) — 4 asercje: brak drzwi (404 tekstowy Hono)

- `save_comparison / ok — zapis artefaktu oboma drzwiami`
- `save_comparison / brak operationId — naruszenie schematu`
- `save_comparison / cudzy zasob — forbidden druga tożsamością`
- `save_comparison / replay z operationId przez oba drzwi — dokładnie jeden artefakt`

Wyciąg: `AssertionError: HTTP: brak drzwi dla /api/m/procurement/cases/{caseId}/comparison: expected true to be false`

### Poprawka 5 (HTTP list_offers) — 6 asercji: brak drzwi (404 tekstowy Hono)

- `list_offers / ok — ta sama lista ofert z tą samą ściśłością wyniku`
- `list_offers / limit=0 — naruszenie schematu`
- `list_offers / limit=101 ponad sufit okna 100 — naruszenie schematu`
- `list_offers / limit='-1' — naruszenie schematu`
- `list_offers / limit='abc' — naruszenie schematu`
- `list_offers / cudzy zasob — forbidden drugą tożsamością`

Uwaga: wiersz „limit ponad sufit" dla `list_offers` to **101** (sufit `readWindowInput`
to `READ_WINDOW_MAX_LIMIT=100`), nie 51 — 51 było wartością z listy obowiązkowej dla
`search` (sufit `searchInput` = 50) i dla `list_offers` jest wartością poprawną.

### Poprawka 4 (schematy MCP get_case / find_price_provenance) — 2 asercje

- `get_case / caseId pusty ciąg` — `AssertionError: MCP: niezgodny kod błędu: expected 'not_found' to be 'validation_failed'`
  (gołe `z.string()` przepuszcza `''`, dopiero `repo.getCase` odpowiada `not_found`)
- `find_price_provenance / itemId pusty ciąg` — j.w.

### Poprawka 2 (połówka usługowa: podłoga/sufit w `ProcurementService.search`) — 1 asercja

- `usługa search wymusza podłogę 1 i sufit 50 na limicie (także NaN)` —
  `AssertionError: ujemny limit nie może znaczyć "bez limitu": expected 16 to be 1`
  (`Math.min(limit, 50)` bez podłogi: `-5` → SQLite `LIMIT -5` = „bez limitu" → 16 wyników;
  gałąź NaN nie została osiągnięta, bo asercja podłogi padła pierwsza).

## Przechodzące na startcie (29) — potwierdzają stan kanonu

Wszystkie wiersze parzystości `set_criteria_weights` (ok, -50, 999, 1.5, nieznany klucz,
pusta tablica, forbidden), `search` (ok, limit 0/-1/'abc'/51, puste q, q>120),
`compare_offers` (ok, forbidden, pusty caseId), `get_case` (ok, forbidden),
`find_price_provenance` (ok, forbidden), `list_cases` (ok + asymetria okna),
`update_offer_item` (ok, brak expectedVersion, cena ujemna → 422, forbidden, conflict,
replay międzydrzwiowy) — walidacje i mutacje tych operacji są dziś wspólne obu drzwiom.

## Weryfikacja detekcji „braku drzwi"

Puste segmenty ścieżki (`/cases/`, `/cases//comparison`, `/items//provenance`) NIE pasują
do tras Hono — odpowiedź to tekstowy 404 bez JSON-u `AppError`, co sterownik czyta jako
`doorMissing` (asymetria jawna, nie porażka). Potwierdzone w tej fazie na wierszach
`get_case/caseId pusty` i `compare_offers/caseId pusty` (połówki HTTP przeszły jako
`httpDoorMissing`).

---

# Falsyfikacja poprawki nr 1 (po zieleni)

Poprawka nr 1 (walidacja `POST /cases/:caseId/criteria` współdzielonym
`criteriaWeightsInput` przez `parseOrThrow`) jest częścią kanonu `4bf99a7`, więc
falsyfikacja polegała na **czasowym wycofaniu jej do formy sprzed poprawki** — trasa
przekazuje `body.weights` prosto do `service.setCriterionWeights` (taki jak dawniej
kształt trasy, bez `parseOrThrow`):

1. `cp index.ts /tmp/l92-index.ts.fixed` — backup; `cmp` → identyczne.
2. Edycja `packages/module-procurement/src/server/index.ts`: trasa criteria bez
   walidacji (`(req.body)?.weights as never` prosto do usługi).
3. `pnpm vitest run tests/parity-http-mcp.test.ts` → **exit 1 — 5 failed | 37 passed**:

   - `set_criteria_weights / waga -50 — naruszenie schematu`
   - `set_criteria_weights / waga 999 — naruszenie schematu`
   - `set_criteria_weights / waga 1.5 (nie całkowita) — naruszenie schematu`
   - `set_criteria_weights / nieznany klucz kryterium — naruszenie schematu`
   - `set_criteria_weights / pusta tablica wag — naruszenie schematu`

   Asertacja: `AssertionError: HTTP: niezgodny status: expected 200 to be 400` —
   nieprawidłowe wagi **zapisały się** przez HTTP (200), podczas gdy drzwi MCP te same
   wagi odrzuciły (`validation_failed`): dokładnie rozjazd, przed którym chroni
   poprawka nr 1. Wiersz `forbidden` i wiersz `ok` pozostały zielone (własność i
   poprawne wagi były respektowane i bez schematu), więc padła wyłącznie grupa
   asercji schematu wag — falsyfikacja trafiona, nie „strzelba".

4. `cp /tmp/l92-index.ts.fixed index.ts` — przywrócenie; `cmp` → **identyczne**.
5. `pnpm vitest run tests/parity-http-mcp.test.ts` → **42 passed (42)**, zieleń.

