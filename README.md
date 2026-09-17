# agentic-app-template

Szablon lokalnej aplikacji agentowej full stack: interfejs, dane biznesowe i agent Claude tworzą
jeden produkt. Repozytorium ma trzy części:

1. **Platforma wielokrotnego użytku** — `packages/platform-contracts`, `packages/platform-server`,
   `packages/platform-ui`: powłoka z nawigacją, nieskończonym canvasem i gotowym czatem OpenUI,
   wykonanie agenta (Mastra + Claude Agent SDK na subskrypcji), MCP, AG-UI, rozmowy, artefakty,
   pliki z analizą w sandboxie, zadania w tle, nawigacja agenta po interfejsie.
2. **Wymienialna aplikacja przykładowa** — `packages/module-procurement` (porównywanie ofert
   zakupowych) oraz `packages/module-devkit-probe` (minimalny moduł kontrolny dowodzący, że
   platforma nie zależy od przykładu).
3. **Dokumentacja** — specyfikacja, kontrakt nowej aplikacji, macierz odbioru i backlog.

Kolejny produkt powstaje przez **zmianę modułu domenowego**, bez przepisywania czatu, integracji
agenta, historii, artefaktów i komunikacji: [`docs/NEW-APPLICATION.md`](docs/NEW-APPLICATION.md).

> **Stan: bazowa wersja robocza.** Aplikacja działa i przechodzi regresję, ale nie spełnia jeszcze
> wszystkich 200 kryteriów obowiązującej specyfikacji. Wyliczony stan każdego kryterium:
> [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md); otwarte prace: [`docs/BACKLOG.md`](docs/BACKLOG.md).

## Nowa aplikacja z szablonu

Na GitHubie: **Use this template → Create a new repository**, albo:

```bash
gh repo create <konto>/<nazwa> --private --template kacperpaczos/agentic-app-template --clone
```

Potem [`docs/NEW-APPLICATION.md`](docs/NEW-APPLICATION.md) (kontrakt modułu, pliki do zmiany) i
[`AGENTS.md`](AGENTS.md) (punkt wejścia dla agenta wykonującego pracę: pierwszeństwo źródeł,
granica platforma–domena, wymagane dowody).

## Wymagania

- Node.js ≥ 22.12 (sprawdzone na 24.19.0), pnpm 9.15.9 (`corepack enable`).
- Do testów przeglądarkowych: Chromium dla Playwright — `pnpm exec playwright install chromium`
  (w konsolidacji użyto przeglądarki z lokalnego cache; instalacja na nowej maszynie nie była sprawdzana).
- System z obsługą sandboxu Claude Agent SDK. Sprawdzone wyłącznie na Linuksie (Fedora 44);
  inne systemy nie były testowane.
- Do pracy agenta: konto Claude **z subskrypcją**, zalogowane lokalnie w CLI `claude` (`/login`;
  poświadczenie w `~/.claude/.credentials.json`). Klucz API Anthropic nie jest używany — zmienne
  `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, Bedrock/Vertex są usuwane z procesu agenta.
  Bez logowania aplikacja działa (canvas, dane, pliki, rozmowy), ale polecenia agenta kończą się
  czytelnym błędem.

## Uruchomienie

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start                 # backend serwuje zbudowany frontend: http://localhost:8791
```

Port i dozwolony origin zmienia się zmiennymi, np. `PORT=8790 APP_ALLOWED_ORIGINS=http://localhost:8790 pnpm start`.

Przy pierwszym starcie aplikacja tworzy bazę w `data/` i **wypełnia się syntetycznymi danymi
startowymi** modułu przykładowego: sprawa `PC-2026-01` z czterema ofertami, pliki źródłowe i gotowa
przestrzeń na canvasie. Dzieje się to raz na moduł (znacznik w `app_settings`), więc usunięte dane
nie wracają po restarcie.

```bash
pnpm seed                  # dosiewa brakujące dane startowe
pnpm seed --force          # ignoruje znacznik „już zasiane”
APP_SKIP_BASE_DATA=1 pnpm start   # start bez danych startowych
pnpm reset                 # UWAGA: kasuje data/, potem migracje i dane startowe od nowa
```

Tryb deweloperski: `pnpm dev` (backend :8791 + Vite :5173 z proxy `/api` na **stały port 8791**,
`apps/web/vite.config.ts`). Jeśli na 8791 działa inna instancja, proxy trafi do niej.

### Docker — obraz wyłącznie ze źródeł

```bash
docker compose build --no-cache
docker compose up -d       # http://localhost:8791; dane w wolumenie, nie w obrazie
docker compose down        # dane zostają; usuwa je dopiero `down -v`
```

Poświadczenie subskrypcji nie jest wbudowywane w obraz. Dostęp agenta w kontenerze wymaga
świadomego odkomentowania montowania `~/.claude` w `compose.yaml`.

### Istniejące dane — najpierw kopia

Nowy build uruchomiony na istniejącym `data/` stosuje zaległe migracje. Kolejność:

```bash
pnpm backup --data data --out backups/data-$(date +%F)       # przy zatrzymanej aplikacji; kopia z WAL + weryfikacja
pnpm migration:rehearsal --backup backups/data-$(date +%F)   # próba na kopii
pnpm build && pnpm start
```

Szczegóły, ograniczenia i procedura odtworzenia: [`docs/odzyskiwanie-stanu.md`](docs/odzyskiwanie-stanu.md).

## Weryfikacja

```bash
pnpm verify              # granica platforma–domena, macierz 200 kryteriów, macierze historyczne,
                         # typecheck (TypeScript 7), build frontendu i backendu, testy Vitest
                         # (tests/durability.test.ts skanuje zbudowane pakiety, dlatego build jest przed testami)
pnpm test:e2e            # Playwright na ISTNIEJĄCYM buildzie produkcyjnym — najpierw pnpm build lub pnpm verify;
                         # własne porty 8792–8799 i katalogi .e2e*; cztery testy zużywają tury subskrypcji Claude
pnpm check:module-swap   # próba wymiany modułu przykładowego na kontrolny, na kopii repozytorium
pnpm diag                # prawdziwa sesja Claude: czy narzędzia MCP są widoczne
```

> **Uwaga — `pnpm acceptance` i `scripts/run-agent.mjs`** wykonują scenariusze z prawdziwym modelem
> przeciw **działającej** instancji pod `APP_BASE` (domyślnie `http://127.0.0.1:8791`) i **zmieniają
> jej dane** (pozycje ofert, karty, pliki). Nie sprawdzają etykiety instancji testowej. Uruchamiaj je
> wyłącznie przeciw osobnej instancji z własnym katalogiem danych, np.
> `APP_BASE=http://127.0.0.1:8790 pnpm acceptance` przy serwerze wystartowanym z `PORT=8790
> APP_DATA_DIR=/ścieżka/do/kopii`.

Wyniki ostatniej regresji i czystej instalacji: [`docs/CONSOLIDATION-UPDATE-2026-09-17.md`](docs/CONSOLIDATION-UPDATE-2026-09-17.md)
(wcześniejsza konsolidacja: [`docs/CONSOLIDATION-REPORT.md`](docs/CONSOLIDATION-REPORT.md)).

## Konfiguracja

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `PORT` | `8791` | port backendu |
| `APP_DATA_DIR` | `<repo>/data` | baza SQLite, pliki, workspace uruchomień |
| `APP_ALLOWED_ORIGINS` | `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:8791`, `http://127.0.0.1:8791` | dozwolone originy (lista po przecinku) |
| `APP_WEB_DIST` | `apps/web/dist` | zbudowany frontend serwowany przez backend |
| `APP_MODEL` | `claude-sonnet-4-5` | model agenta |
| `APP_RUN_TIMEOUT_MS` | `300000` | twardy limit jednego uruchomienia |
| `APP_MAX_UPLOAD_BYTES` | `8388608` | limit wielkości pliku |
| `APP_SKIP_BASE_DATA` | brak | `1` = start bez danych startowych |
| `APP_INSTANCE_LABEL` | brak | **tylko testy**: wymusza port 8792–8799 i katalog danych `.e2e*`, podaje etykietę w `/api/health` |

Dostęp do aplikacji to osobna, lokalna sesja (podpisane HMAC ciasteczko, sekret w
`data/session.secret`); token subskrypcji nigdy nie pełni tej roli. Do ekranu Ustawień aplikacja
**czyta i parsuje cały** plik `~/.claude/.credentials.json` (więc tokeny przejściowo trafiają do
pamięci procesu), ale kopiuje z niego wyłącznie `subscriptionType` i `expiresAt` — tokenów nie
używa, nie zapisuje, nie loguje i nie przesyła. Odświeżanie tokena należy do SDK.

## Co pokazuje aplikacja przykładowa

Opis funkcji nie jest dowodem ich działania — stan i dowód każdego zachowania: [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

- porównanie ofert liczone przez backend (oferta niekompletna lub w innej walucie nie wygrywa),
  tabela i wykres na canvasie, pochodzenie ceny aż do wiersza pliku źródłowego;
- polecenia w czacie zmieniające dane przez reguły domeny i kompozycję canvasu;
- załączniki PNG/JPEG/XLSX/CSV/tekst w polu wiadomości; analiza skoroszytu kodem w sandboxie
  (po zgodzie użytkownika), wynik jako nowa wersja pliku — oryginał bez zmian;
- zadania w tle: przełączenie rozmowy, zamknięcie panelu i przeładowanie nie anulują pracy; Stop
  jest jawny i dotyczy wskazanego wykonania;
- nawigacja agenta: „przełącz na pliki”, „pokaż ustawienie logowania” otwiera widok i podświetla
  element, z potwierdzeniem klienta; pokazanie ustawienia go nie zmienia; pytanie o dane, które mają
  swój ekran („co jest w dostawcach?”), też przenosi na ten ekran;
- zawężanie widoku przez agenta: „pokaż tylko dostawców z Polski” zawęża **widok**, nie rozmowę.
  Zawężenie trafia do adresu (`/data?country=PL` — równe, `country=!FI` — różne od, `name=~av` —
  zawiera, `country=PL,CZ` — którekolwiek z), więc przeżywa odświeżenie, działa jako link i cofa się
  przyciskiem Wstecz; wyjście na inny ekran je zdejmuje. Nad zawężonym ekranem stoi pasek z opisem
  wygenerowanym z faktycznie zastosowanych warunków, liczbą wierszy i przyciskiem „Pokaż pełny
  widok”. Pola, po których wolno zawężać, deklaruje moduł (`UiTarget.filter`); pole spoza listy jest
  odrzucane. Link nie omija uprawnień: parametry tylko odsiewają wiersze z odpowiedzi, którą backend
  już ograniczył do właściciela. Sortowanie, paginacja i odczyt semantycznego stanu ekranu nie są
  zaimplementowane (backlog BL-01).

## Najważniejsze ograniczenia

- Specyfikacja nie jest w pełni spełniona — patrz [`docs/BACKLOG.md`](docs/BACKLOG.md). Brakuje m.in.
  semantycznego odczytu aktywnego ekranu, sortowania przez rozmowę, wskazania wartości pola rekordu
  oraz przestrzeni „Widoki agenta”; zawężanie widoku filtrem jest zaimplementowane tylko dla widoków,
  które deklarują pola.
- XLSX: formuły nie są przeliczane; wykresy, formatowanie warunkowe i tabele przestawne nie są
  zachowywane przy zapisie; `.xlsm` i `.xls` są odrzucane.
- Zadanie w tle żyje tak długo jak proces backendu; restart oznacza je jako przerwane.
- Część testów platformy używa modułu przykładowego jako danych testowych
  ([`docs/NEW-APPLICATION.md`](docs/NEW-APPLICATION.md) §6).
- Langfuse nie jest podłączony ([`docs/observability.md`](docs/observability.md)).
- Kopia stanu jest ręczna, lokalna i wymaga zatrzymania aplikacji.

## Dokumentacja

| Dokument | Po co |
|---|---|
| [`AGENTS.md`](AGENTS.md) | punkt wejścia dla wykonawcy (agent lub człowiek) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | obowiązująca specyfikacja: 12 warstw, 200 kryteriów, 27 prób |
| [`docs/NEW-APPLICATION.md`](docs/NEW-APPLICATION.md) | kontrakt modułu domenowego i kroki tworzenia nowej aplikacji |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | wyliczona macierz kryteriów z dowodami |
| [`docs/BACKLOG.md`](docs/BACKLOG.md) | otwarte kryteria pogrupowane w pakiety prac |
| [`docs/CONSOLIDATION-REPORT.md`](docs/CONSOLIDATION-REPORT.md) | raport utworzenia szablonu: zmiany, regresja, publikacja (2026-09-16) |
| [`docs/CONSOLIDATION-UPDATE-2026-09-17.md`](docs/CONSOLIDATION-UPDATE-2026-09-17.md) | aktualizacja o poprawki AgenticApp z 2026-09-17: mapa różnic, regresja, publikacja publiczna |
| [`docs/DOCUMENTATION-MAP.md`](docs/DOCUMENTATION-MAP.md) | rozliczenie wcześniejszych dokumentów |
| [`docs/observability.md`](docs/observability.md) | diagnostyka i opcjonalny eksport telemetrii |
| [`docs/odzyskiwanie-stanu.md`](docs/odzyskiwanie-stanu.md) | kopia, próba migracji, odtworzenie |
| [`FEEDBACK.md`](FEEDBACK.md) | dziennik prac nad szablonem |
| [`docs/archive/`](docs/archive/) | historia: dokumenty aplikacji źródłowej i nieaktualny plan z 2026-08 |

## Licencja

Repozytorium nie zawiera pliku licencji. Wybór licencji należy do właściciela; do tego czasu
obowiązują domyślne prawa autorskie.
