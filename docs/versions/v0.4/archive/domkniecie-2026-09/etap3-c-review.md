# Recenzja: ETAP 3 / Subagent C — pakiet storage Mastry (niezależna)

Recenzent: Subagent C (nie jest autorem zmian). Data: 2026-09-20.
Pakiet: worktree `lokalny katalog worktree szablonu/etap3-mastra`,
gałąź `domkniecie/etap3-mastra-storage`, BASE `b9467ac`, HEAD `9bbe77d`, 3 commity,
5 plików, +157/−2. Stan drzewa na początku i po recenzji: czysty.

## Werdykty

- **Werdykt spec: ✅** (wszystkie punkty briefu B wykonane i zweryfikowane własnymi próbami)
- **Werdykt jakości: ZATWIERDZONY**
- **Findings: 0 Critical / 0 Important / 2 Minor**

## Soczewka 1 — jawny storage w runtime.ts

**Zgodne.** Import wyłącznie z publicznego eksportu: `packages/platform-server/src/agent/runtime.ts:3`
(`import { InMemoryStore } from '@mastra/core/storage'`). Zweryfikowane u źródła:
`node_modules/@mastra/core/package.json` (1.66.0) mapuje `"./storage"` →
`dist/storage/index.js`, a `InMemoryStore` figuruje na liście eksportów tego modułu
(deklaracja: `dist/storage/mock.d.ts:22`, `extends MastraCompositeStore`). Żadnych
ścieżek wewnętrznych `dist/` w kodzie aplikacji.

Komentarz (`runtime.ts:178-188`) jest uczciwy i kompletny: cytuje komunikat
ostrzeżenia, nazywa decyzję świadomą („nie zaniedbanie"), podaje powód (magazyn
Mastry martwy — jedyna rola to rejestracja agenta; trwałość w własnej SQLite
`app.db`, warstwa `services`; żadne kryterium restartu nie opiera się o pamięć
Mastry), mówi o odrzuceniu prawdziwego adaptera jako nowej zależności (decyzja
właściciela) i wskazuje dokument decyzji (`docs/observability.md`, `FEEDBACK.md`
T10) oraz test strażnika. Rzeczywistość w kodzie odpowiada komentarzowi
(zweryfikowane: jedyna referencja do instancji to `getAgent('appAgent')`,
`runtime.ts:196`).

**Zachowanie aplikacji poza zniknięciem ostrzeżenia — sprawdzone w dist @mastra/core.**
Obecność `config.storage` ustawia wyłącznie flagę `#storageExplicit`
(`dist/mastra-B-GDpHtP.js:1013`) i pomija gałąź fallbacku (`:1014-1021`,
`new InMemoryStore()` + `queueMicrotask(warn)`). Jedyny inny konsument flagi to
`__registerFsStorage` (`:1901`) — metoda „intended to be called by the bundler/dev
generated entry, not by user code". W repo nie ma żadnego użycia
`__registerFsStorage` ani zależności `@mastra/deployer`/`@mastra/bundler`
(grep = 0), więc flaga jest tu nieaktywna. Konfigurowany obiekt to **ta sama
klasa**, którą biblioteka sama podstawia przy fallbacku — diff 13 linii nie zmienia
zachowania poza uciszeniem ostrzeżenia. Potwierdzone.

## Soczewka 2 — strażnik w tests/runtime.test.ts

**Zgodny i skuteczny.** `tests/runtime.test.ts:627-663`:

- Celuje w **dokładne pierwsze zdanie** (`:638-640`): `No \`storage\` configured on
  Mastra — falling back to an in-memory store` — zgodne litera w litera z
  `dist/mastra-B-GDpHtP.js:1020` (pełny tekst zweryfikowany u źródła). Nie jest
  luźny (nie wystarcza słowo „storage").
- Przechodzi produkcyjną ścieżką: `createHarness({ withModule: false })` →
  `createPlatform` (`tests/helpers.ts:47`) → `AgentRuntime` → `new Mastra(...)`.
- Asynchronia obsłużona poprawnie: ostrzeżenie idzie z `queueMicrotask`, test
  domyka kolejkę przez `await new Promise(resolve => setImmediate(resolve))`
  (`:654-656`) — mikrotaski wykonują się przed fazą check timera `setImmediate`.
- Cel szpiega poprawny: brak własnego loggera w `new Mastra({...})` → domyślny
  `ConsoleLogger`, którego `warn` woła `console.warn`
  (`dist/logger-DGUE8DHx.js:241`; wybór domyślnego loggera: `mastra-B-GDpHtP.js:999-1006`).
  `spy.mockRestore()` i `h?.dispose()` w `finally` — brak przecieków między testami.

**Własna próba mutacyjna (powtórzona przez recenzenta, nie przejęta z raportu):**
na czystym drzewie strażnik w izolacji przechodzi (1 passed). Następnie usunąłem
linię `storage: new InMemoryStore(),` (backup do /tmp, `git diff --stat`: 1 plik,
1 delecja) — strażnik **padł** z pełną treścią:
`No \`storage\` configured on Mastra — falling back to an in-memory store. In-memory
storage is not durable: all data is lost on restart, and it is not safe for
production. Configure a persistent storage adapter (e.g. @mastra/libsql, @mastra/pg,
@mastra/cloudflare). See https://mastra.ai/docs/storage`. Plik przywrócony z kopii;
`git status --porcelain` i `git diff --stat HEAD` puste — drzewo czyste.

## Soczewka 3 — tests/observability.test.ts

**Zgodne, celu nie osłabia.** Oba `new Mastra(...)` (`:30`, `:35-40`) dostają
`storage: new InMemoryStore()`; zmiana nie dotyka żadnej asercji — test kontraktu
dalej pinuje `Expected an Observability instance` i `@mastra/observability`
(`:44-45`), testy o braku pakietów (`:48-56`) nietknięte. Punkt wpiecia telemetrii
pozostaje pinned: pierwszy test nadal konstruuje Mastrę **bez konfiguracji
telemetrii** (dodany jedynie storage, którego ten test nie bada). Usunięte zostało
wyłącznie przypadkowe zanieczyszczenie moka `warn` ostrzeżeniem o fallbacku — na
które wcześniej nic nie asertowało, więc nic nie osłabiono. Komentarz nad
`describe` (`:20-26`) uczciwie opisuje decyzję i prowadzi do dokumentacji.

## Soczewka 4 — dokumentacja

**Zgodna, bez fałszywych twierdzeń.**

- `docs/observability.md:83-114` — nowa sekcja przed „Langfuse — stan faktyczny":
  czego ostrzeżenie dotyczyło, trzy fakty faktografii (rejestr agenta jako jedyna
  rola; trwałość we własnej bazie z wyliczeniem tabel; zero asercji/kryteriów
  czytających z pamięci Mastry), dlaczego wariant A odrzucony (brak adaptera
  w drzewie zależności → nowa zależność = decyzja właściciela; nie da nic),
  co się zmieniło, kto pilnuje regresji i jaki był wynik kontroli negatywnej.
  Sekcja **nie twierdzi**, że „ostrzeżenie wyłączono" — mówi o jawnej, świadomej
  konfiguracji in-memory. Uczciwie.
- `FEEDBACK.md:979-1035` — wpis T10 (najwyższym poprzednim był T9; pre-existing
  duplikat T2 nietknięty — poprawnie poza zakresem). Pełny łańcuch: problem →
  faktografia → decyzja (wariant A odrzucony z uzasadnieniem zależnościowym,
  wariant B wykonany) → zmiana w trzech commitach → kontrola negatywna →
  weryfikacja (71/1131) → otwarte (warunki otwarcia decyzji przy realnym użyciu
  magazynu). `docs/acceptance/assessment.json` bez zmian — zgodnie z briefem.

## Soczewka 5 — zakazy

**Dotrzymane.** `git diff --stat b9467ac..9bbe77d`: dokładnie 5 plików
(FEEDBACK.md, docs/observability.md, runtime.ts, tests/observability.test.ts,
tests/runtime.test.ts). Zero dotknięć: assessment.json, docs/evidence/**,
lockfile (pnpm-lock.yaml), e2e/**, skryptów macierzowych, server-guard.mjs.
Żadnej kontroli nie wyłączono, żadnej asercji nie osłabiono (przejrzane obie
zmienione pliki testowe linia po linii).

## Soczewka 6 — verify (własny przebieg)

**Potwierdzony.** `pnpm verify` uruchomiony samodzielnie na czystym drzewie
(HEAD 9bbe77d): pełny łańcuch `check:boundaries && check:acceptance &&
check:matrix && check:closure && typecheck (src+modules+e2e) && build && test`
— **kod wyjścia 0, Test Files 71 passed (71), Tests 1131 passed (1131)**.
Zgłoszone 71/1131/0 = zgodne co do liczby. Przyrost +1 test względem baseline
1130 to wyłącznie strażnik.

Dodatkowo: `grep "new Mastra("` po `apps/ packages/ e2e/ scripts/` (poza testami)
— jedyna instancja produkcyjna to `runtime.ts:176`, pokryta konfiguracją, więc
ostrzeżenie znika też z logów e2e bez zmian w e2e (potwierdzenie twierdzenia
raportu).

## Findings

**Critical: 0. Important: 0.**

**Minor:**

1. **`tests/runtime.test.ts:638` — sprzężenie strażnika z brzmieniem komunikatu.**
   Strażnik asertuje dokładne pierwsze zdanie w wersji 1.66.0; gdyby @mastra/core
   w przyszłej wersji przeformułował ostrzeżenie fallbacku, `not.toContain`
   przeszłoby trywialnie mimo powrotu fallbacku. Celowe (ogon komunikatu to
   dokumentacja biblioteki podlegająca zmianom), komitetująco opisane w kodzie
   i w „Obawach" raportu; ewentualne utwardzenie: dodatkowa luźniejsza asercja
   (`/No .storage. configured/`) obok dokładnej. Nie blokuje.
2. **`packages/platform-server/src/agent/runtime.ts:3` — `InMemoryStore` deklarowany
   w `mock.d.ts`.** Klasa pochodzi z publicznego eksportu `@mastra/core/storage`
   (zweryfikowane w mapie eksportów package.json — status publiczny niepodważalny),
   ale nazwa pliku deklaracji bywa czytana jako „tylko do testów". Przy aktualizacji
   @mastra/core warto potwierdzić, że klasa zostaje w eksportach publicznych —
   usunięcie złapie `pnpm typecheck` (import typów) i strażnik w `pnpm test`.
   Implementator sam to flagował (Obawy #2); rejestruję dla porządku.

## Soczewka 7 — odpowiedź na pytanie głębokie

Tak, ryzyko wprowadzenia w błąd istnieje: `storage: new InMemoryStore()` w
produkcyjnym konstruktorze na pierwszy rzut oka sugeruje „storage ogarnięty"
(nazwa klasy o tym nie przeczy, a deklaracja mieszka w `mock.d.ts`), ale
zapobiegają temu tri subtly: 10-linijkowy komentarz dokładnie nad polem (jawne
słowa „martwy" i „trwałość realizuje własna baza SQLite"), sekcja w
`docs/observability.md` i wpis T10 powtarzają tę treść wraz z warunkiem otwarcia
decyzji, a strażnik testowy uniemożliwia ciche zniknięcie świadomej konfiguracji —
resztkowe ryzyko (czytelnik pomijający komentarze) jest tym samym order of magnitude,
co przed zmianą, i nie uzasadnia dalszych działań poza zapiskami już dokonanymi.

## Weryfikacja niezależności i czystości

- Próba mutacyjna wykonana na kopii pliku (backup /tmp), przywrócona bajt w bajt;
  po recenzji `git status --porcelain` = puste, `git diff --stat HEAD` = puste.
- Nie commitowano, nie wypychano, e2e nieuruchamiane (poza zakresem briefu),
  inne worktree nietknięte.
