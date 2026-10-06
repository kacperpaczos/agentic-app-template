# Raport: ETAP 3 / Subagent B — jawna konfiguracja storage Mastry

**Status: DONE**
Worktree: `lokalny katalog worktree szablonu/etap3-mastra`, gałąź
`domkniecie/etap3-mastra-storage`, start `b9467ac`, drzewo po pakiecie czyste.
Nic niewypchnięte. Inne worktree nietknięte.

## Wykonane kroki

1. **Procedura wejściowa.** `pnpm install --frozen-lockfile` (3.6 s, bez zmian w lockfile).
   Baseline `pnpm verify` = **0** (71 plików, 1130 testów) — warunek STOP nie wystąpił.
2. **Znalezienie importu.** `InMemoryStore` pochodzi z **publicznego eksportu**
   `@mastra/core/storage` (mapa eksportów w `node_modules/@mastra/core/package.json`:
   `"./storage"` → `dist/storage/index.js`; deklaracja:
   `dist/storage/mock.d.ts:22` — `export declare class InMemoryStore extends MastraCompositeStore`,
   alias `MockStore`). Typ pola konfiguracji: `storage?: MastraCompositeStore`
   (`dist/mastra/index.d.ts:91`). Żadnych ścieżek wewnętrznych `dist/`. Zero nowych
   zależności — `@mastra/core` 1.66.0 jest już zależnością `@platform/server`; lockfile nietknięty
   (`git status` po pakiecie: wyłącznie 4 zamierzone pliki).
3. **`packages/platform-server/src/agent/runtime.ts`** — w `new Mastra({ agents: { appAgent } })`
   dodane `storage: new InMemoryStore()` + komentarz polski na miejscu: ostrzeżenie, którego to
   dotyczy, dlaczego in-memory jest świadome (magazyn Mastry martwy; trwałość we własnej bazie
   `app.db`; żadne kryterium restartu nie wisi na pamięci Mastry), wskazówka do
   `docs/observability.md` i `FEEDBACK.md` (T10) oraz do testu strażnika.
4. **Test strażnika** — nowy `describe` na końcu `tests/runtime.test.ts`
   („storage Mastry — straznik ostrzezenia o braku storage"):
   - tworzy platformę przez `createPlatform` (przez `createHarness({ withModule: false })`),
   - przechwytuje `console.warn` (`vi.spyOn`) — Mastra bez własnego loggera pisze przez
     `ConsoleLogger`, którego `warn` woła `console.warn` (`dist/logger-DGUE8DHx.js`, metoda `warn`),
   - domyka kolejkę mikrotasków przed asercją (`setImmediate`), bo ostrzeżenie idzie z
     `queueMicrotask` (`dist/mastra-B-GDpHtP.js:1013-1021`),
   - asertuje `not.toContain` na **dokładnie pierwsze zdanie** komunikatu:
     `No \`storage\` configured on Mastra — falling back to an in-memory store`
     (stała `OSTRZEZENIE_O_BRAKU_STORAGE`, cytowana w całości z komentarzem „dlaczego w całości").
   - **Kontrola negatywna (mutacja, niecommitowana):** usunięcie jawnej konfiguracji z
     `runtime.ts` → strażnik pada z pełną treścią komunikatu („No `storage` configured on Mastra —
     falling back to an in-memory store. In-memory storage is not durable: all data is lost on
     restart, and it is not safe for production. Configure a persistent storage adapter
     (e.g. @mastra/libsql, @mastra/pg, @mastra/cloudflare). See https://mastra.ai/docs/storage").
     Plik przywrócony; `git diff` po przywróceniu pokazuje wyłącznie zamierzone 13 linii zmiany.
5. **`tests/observability.test.ts` (instancje zamierzone) — decyzja: dodany jawny storage.**
   Orkiestrator zostawił to jako decyzję wykonawcy („jeśli trywialne … decyzja Twoja, uzasadnij").
   Zdecydowałem dodać, bo: (a) trywialne — jeden import, dwa pola; (b) spójne z produkcją — ta sama
   świadoma decyzja wyrażona w kodzie; (c) usuwa ostatnie źródło ostrzeżenia w regresji, w tym
   **przypadkowy przeciek** ostrzeżenia o storage do moka loggera w teście kontraktu
   obserwowalności (asercje `Expected an Observability instance` / `@mastra/observability`
   nie kolidowały, ale przeciek był przypadkiem — teraz mock `warn` dostaje wyłącznie komunikaty
   obserwowalności); (d) nie zmienia żadnej asercji — testy dalej pinują punkt wpięcia telemetrii
   i brak pakietów; zmiana opisana w komentarzu nad `describe`. Test „goła Mastra działa" pozostał
   prawdziwy w swoim intencie: dotyczy braku konfiguracji **telemetrii**, nie storage.
6. **Dokumentacja:**
   - `docs/observability.md` — nowa sekcja „Storage Mastry — świadome ograniczenie" (przed
     „Langfuse — stan faktyczny"): czego ostrzeżenie dotyczyło, trzy fakty faktografii (rejestr
     agenta jako jedyna rola Mastry; trwałość we własnej bazie `app.db`; zero asercji z pamięci
     Mastry), dlaczego wariant A odrzucony, co się zmieniło, kto pilnuje regresji.
   - `FEEDBACK.md` — wpis **T10** (kontynuacja po najwyższym istniejącym numerze T9; podwójne,
     pre-existing T2 pominięte zgodnie z decyzją orkiestratora). Wpis zawiera: problem, wynik
     faktografii, decyzję (odrzucenie wariantu A z uzasadnieniem zależnościowym, wykonanie
     wariantu B), opis zmiany w trzech commitach, kontrolę negatywną i weryfikację.
7. **Nietknięte, zgodnie z briefem:** `docs/acceptance/assessment.json` (zero zmian — żadne
   kryterium nie opiera się o pamięć Mastry), `docs/evidence/**`, `e2e/**`, lockfile, skrypty
   macierzowe (`scripts/lib/matrix-core.mjs` itd.), straż izolacji z ETAPU 2
   (`scripts/lib/server-guard.mjs`), dane użytkownika. Żadnej kontroli nie wyłączono, żadnego
   kryterium nie oznaczono unverified.

## Commity (3, po polsku, małe)

| commit | treść |
|---|---|
| `b29e83c` | Jawny storage Mastry: InMemoryStore z publicznego eksportu + straznik ostrzezenia (ETAP 3) |
| `999ddd3` | Testy zamierzone: jawny storage w instancjach Mastry obserwowalnosci (ETAP 3) |
| `9bbe77d` | Dokumentacja: sekcja „Storage Mastry — swiadome ograniczenie" i dziennik T10 (ETAP 3) |

## Weryfikacja

- Baseline przed zmianą: `pnpm verify` = **0** (71 plików, 1130 testów).
- Po pakiecie (stan roboczy): `pnpm verify` = **0** (71 plików, 1131 testów) — jedyny nowy test to
  strażnik storage.
- **Stan po commitach (finalne drzewo): `pnpm verify` = 0 (71 plików, 1131 testów), kod wyjścia 0.**
- Instancje z jawnym storage w `observability.test.ts`: wszystkie 4 testy pliku przechodzą bez
  zmian asercji.
- `grep "new Mastra("` po `apps/ packages/ e2e/ scripts/`: jedyna instancja produkcyjna to
  `runtime.ts:176` — pokryta. `compose.ts` (produkcja i e2e) składa platformę przez
  `createPlatform`, więc ostrzeżenie znika też z logów e2e **bez zmian w e2e**.
- Sprawdzone: żaden test e2e ani jednostkowy nie asertuje treści logów serwera (grep po
  `warn|storage` w `e2e/` — brak asercji), więc zniknięcie ostrzeżenia niczego nie odbija.
- `pnpm test:e2e` nie był uruchamiany — poza zakresem briefu (bramką zgłoszenia jest `verify = 0`);
  zmiana nie dotyka warstwy e2e i żadna asercja e2e nie zależy od storage Mastry (faktografia,
  wiersz „e2e" mapy).

## Obawy / otwarte

1. **Strażnik asertuje pierwsze zdanie ostrzeżenia, nie cały komunikat.** Celowe: ogon
   („In-memory storage is not durable…") to dokumentacja @mastra/core i może się zmienić przy
   aktualizacji; nośna treść (fallback bez `storage`) jest w pierwszym zdaniu. Mutacja potwierdziła,
   że asercja łapie pełny komunikat.
2. **`InMemoryStore` jest deklarowany w pliku `mock.d.ts`.** Nazwa pliku sugeruje „tylko do testów",
   ale to klasa z **publicznego eksportu** `@mastra/core/storage` (przykład użycia w jej
   dokumentacji: `const storage = new InMemoryStore()`), o złożoności zastrzeżonej prywatnie — i to
   dokładnie ta klasa, którą sam @mastra/core podstawia przy fallbacku. Użycie jej jawnie nie
   wprowadza żadnej ścieżki, której biblioteka by nie tworzyła. Wskazane przy ewentualnej
   aktualizacji @mastra/core sprawdzić, czy klasa pozostaje w publicznym eksportach (strażnik
   typu + test złapią usunięcie przy pierwszym `pnpm typecheck`/`pnpm test`).
3. **Jeśli kiedyś magazyn Mastry miałby być realnie używany** (memory, workflows, background
   tasks), decyzję trzeba otworzyć: adapter storage = nowa zależność (decyzja właściciela) plus
   regresja trwałości po nim. Dziś nic na nim nie wisi — potwierdzone faktografią.
