# Platforma agentowa + moduł porównywania ofert zakupowych

> **Dokument historyczny z aplikacji AgenticApp** (stan z 2026-09-16, przed konsolidacją szablonu; sha256 oryginału `76c345b274aec24f…`).
> Opisuje próby wykonane w katalogu AgenticApp i ocenę wobec poprzedniej wersji specyfikacji (95 kryteriów).
> Nie potwierdza stanu tego repozytorium — aktualna ocena: [`docs/ACCEPTANCE.md`](../../ACCEPTANCE.md).
> Odnośniki do `docs/evidence/…` wskazują dowody, które pozostały lokalnie w AgenticApp i nie są publikowane; odnośniki do `docs/*.md` odpowiadają plikom w `docs/` tego repozytorium.
> README w tej postaci pochodzi sprzed zmiany odnośników w części A konsolidacji.

Lokalna aplikacja full stack, w której interfejs, dane biznesowe i agent tworzą jeden produkt.
Składa się z **platformy agentowej** (nieznającej żadnego pojęcia biznesowego) oraz
**modułu biznesowego** dopiętego do niej przez jawne kontrakty.

Stan odbioru i pełna macierz kryteriów: **[RAPORT-DOMKNIECIA-PLATFORMY.md](RAPORT-DOMKNIECIA-PLATFORMY.md)**.
Dziennik realizacji, decyzje i wszystkie znalezione problemy: **[FEEDBACK.md](FEEDBACK.md)**.
Audyt stanu sprzed domknięcia: [RAPORT-STANU-PLATFORMY.md](RAPORT-STANU-PLATFORMY.md).

---

## Szybki start

Wymagania: Node.js ≥ 22.12 (sprawdzone na 24.19.0), pnpm 9, konto Claude z subskrypcją
zalogowane lokalnie (`claude` CLI → `/login`; poświadczenie ląduje w `~/.claude/.credentials.json`).

```bash
pnpm install
pnpm dev          # backend :8791 + frontend :5173
```

Aplikacja migruje bazę i **wypełnia się danymi bazowymi przy pierwszym starcie**
— sprawa zakupowa z ofertami, pliki źródłowe i gotowa przestrzeń na canvasie —
więc po otwarciu jest na czym pracować, zamiast pustych list.

Dzieje się to **raz na moduł** i jest zapisywane w `app_settings`: dane, które
usuniesz, nie wracają po restarcie. Ręcznie:

```bash
pnpm seed           # dosiewa brakujące dane bazowe
pnpm seed --force   # ignoruje znacznik „już zasiane"
APP_SKIP_BASE_DATA=1 pnpm start   # start bez danych bazowych
```

Otwórz http://localhost:5173.

Tryb produkcyjny (bez serwera deweloperskiego Vite — backend serwuje zbudowany frontend):

```bash
pnpm build
pnpm start        # http://localhost:8791
```

### Docker — obraz wyłącznie ze źródeł

```bash
docker compose build --no-cache      # nic z cache: ani warstw, ani magazynu pnpm
docker compose up -d                 # http://localhost:8791
docker compose down                  # zatrzymanie; dane zostają w wolumenie
```

Albo bez compose:

```bash
docker build --no-cache --pull -t agenticapp:czysty .
docker run -d --name agenticapp -p 8791:8791 -v agenticapp-data:/data agenticapp:czysty
```

Co ten obraz gwarantuje, a czego nie:

- **Powstaje z kodu, nie ze stanu katalogu roboczego.** `.dockerignore` odcina
  `node_modules`, `dist`, `data`, `backups` i katalogi testowe, więc zawartość
  obrazu pochodzi ze źródeł i `pnpm-lock.yaml`. Wersje są przypięte
  (`--frozen-lockfile`) i nie mogą zostać ciszej podniesione.
- **Stan aplikacji nigdy nie jest w obrazie.** Baza, pliki i przestrzenie robocze
  żyją w wolumenie `/data`. `docker compose down` go nie usuwa; usuwa dopiero
  `down -v`.
- **Agent nie zadziała bez dostępu do Twojej subskrypcji.** Claude Agent SDK
  czyta poświadczenie z `~/.claude` na hoście, a w kontenerze tego katalogu nie
  ma. Aplikacja wstanie i będzie w pełni używalna — canvas, dane, pliki,
  rozmowy — ale polecenie do agenta zwróci „brak logowania". Poświadczenie
  **nie jest wbudowywane w obraz** i nie powinno być. Jeśli świadomie chcesz dać
  kontenerowi dostęp, odkomentuj montowanie `~/.claude` w `compose.yaml`.

### Uruchomienie na istniejących danych — najpierw kopia

Start nowego builda na istniejącym `data/` **zmienia dane**: stosuje migrację
`platform-0002-run-measurement-points` i odtwarza aktywność narzędzi w zapisanych
rozmowach. Kolejność:

```bash
# aplikacja zatrzymana (skrypt odmówi, jeśli nie jest)
pnpm backup --data data --out backups/data-$(date +%F)     # kopia + weryfikacja
pnpm migration:rehearsal --backup backups/data-$(date +%F) # próba na kopii, nie na danych
pnpm build && pnpm start
```

Kopia nie jest zwykłym `cp app.db`: w trybie WAL zatwierdzone transakcje siedzą w
`app.db-wal`, więc skopiowanie samego pliku głównego daje stan cofnięty do
ostatniego punktu kontrolnego — i wygląda na kompletny. Szczegóły i procedura
odzyskania: [`docs/odzyskiwanie-stanu.md`](docs/odzyskiwanie-stanu.md).

### Weryfikacja

```bash
pnpm typecheck            # TypeScript 7.0.2, 0 błędów
pnpm test                 # testy domeny, kontraktów i granicy modułów
pnpm check:boundaries     # kontrola granicy platforma–domena
pnpm test:e2e             # testy przeglądarkowe (własne porty 8795-8799 i katalogi .e2e*; agent-ui.spec.ts wydaje jedną turę subskrypcji)
pnpm backup:verify backups/data-2026-09-15   # ponowne sprawdzenie kopii stanu
pnpm check:matrix         # historyczna macierz w FEEDBACK.md zgodna ze swoimi tabelami
pnpm check:closure        # aktualna macierz odbioru: 95 kryteriów, bez braków i duplikatów
pnpm --filter @app/server diag   # rzeczywista sesja Claude: czy narzędzia MCP są widoczne
node scripts/run-agent.mjs "<polecenie>" --case <id> --space <id>   # jedno prawdziwe uruchomienie agenta
```

---

## Co można zrobić w aplikacji

Dane demonstracyjne opisują sprawę `PC-2026-01` („Wyposażenie sali konferencyjnej", PLN, ceny netto)
z czterema ofertami. Wartości są tak dobrane, żeby dało się je sprawdzić ręcznie:

| Dostawca | Suma | Status |
|---|---|---|
| MediaPro Systemy | 49 270,00 PLN | kompletna, 14 dni — **najlepsza** |
| AV Technika | 49 830,00 PLN | kompletna, 21 dni |
| Konferencje24 | 26 900,00 PLN częściowo | **wykluczona**: brak systemu wideo + jednostka `usluga` zamiast `h` |
| NordAV OY | 11 120,00 EUR | **wykluczona**: inna waluta niż podstawa sprawy |

Pozornie najtańsza oferta (Konferencje24) **nie wygrywa** — jest niekompletna.
Żadna kwota w EUR nie jest przeliczana bez jawnego ujednolicenia.

Przykładowe polecenia dla agenta:

- „Porównaj oferty dla tej sprawy i pokaż tabelę na canvasie."
- „Dodaj wykres kosztów i pokaż warunki dostawy obok."
- „Zmień ilość pozycji X na 3." — przechodzi przez reguły domeny, wszystkie widoki się przeliczają.
- „Znajdź, skąd pochodzi ta cena." — agent przechodzi po relacjach do pliku źródłowego.
- „Przetwórz ten CSV i przygotuj raport." — plik czytany i przetwarzany w sandboxie,
  wynik zapisany jako trwały artefakt do pobrania.


### Panel rozmowy

Dwie zakładki: **Rozmowa** i **Artefakty**. Druga to przeglądarka artefaktów
wytworzonych w rozmowach, z wyszukiwaniem po tytule — widok gotowego komponentu,
udostępniony jako zakładka, bo przy tej szerokości panelu jego własny pasek
boczny jest szufladą.

### Pliki dołączone do rozmowy

Spinacz w polu pisania wiadomości, obok przycisku wysyłania: **Wgraj z dysku**
(PNG, JPEG, XLSX, CSV, tekst, JSON, PDF; max 8 MB) albo wskazanie pliku już
wgranego. Dołączone pliki widać jako plakietki nad pisanym tekstem. Agent czyta
rzeczywistą treść — obraz bezpośrednio, skoroszyt kodem uruchomionym w
sandboxie.

Zakres analizy jest jawny, bo cicha pomyłka byłaby tu najgorsza:

| | czytane | ograniczenia |
|---|---|---|
| XLSX | wszystkie arkusze, typy komórek, scalenia, formuły | **formuły nie są przeliczane** (zapis formuły ≠ jej wynik); wykresy, formatowanie warunkowe i tabele przestawne nie są zachowywane przy zapisie; makra nie działają, `.xlsm`/`.xls` nieprzyjmowane |
| PNG, JPEG | treść obrazu czytana przez model | brak OCR poza tym, co model odczyta |

Zmodyfikowany plik agent publikuje jako **nową wersję** — oryginał zostaje
nietknięty i nadal jest do pobrania. Uruchomienie kodu wymaga Twojej zgody;
agent zapisuje skrypt i czeka na kliknięcie.

### Zadania w tle

Wykonanie należy do backendu, nie do panelu. Przełączenie rozmowy, zamknięcie
panelu, przeładowanie strony i rozłączenie **nie anulują** pracy — po powrocie
widać jej bieżący stan albo gotowy wynik, bez ponownego uruchamiania. Wskaźnik
w pasku stanu pokazuje, co trwa i co się skończyło w innych rozmowach.

Zatrzymanie jest jawne i dotyczy **wskazanego** wykonania: przycisk „Zatrzymaj"
w pasku stanu rozmowy albo przy pozycji na liście zadań.

### Agent porusza się po aplikacji

Poproś w czacie „przełącz na pliki", „pokaż ustawienie logowania", „otwórz tę
przestrzeń" — agent otworzy właściwy widok, przewinie do elementu i chwilowo go
podświetli. Działa z Wstecz/Dalej.

Cele pochodzą z kontrolowanego katalogu (ekrany platformy + wkład modułów), więc
nieistniejący cel daje czytelną odmowę zamiast wymyślonej drogi. **Pokazanie
ustawienia go nie zmienia** — nie ma operacji zapisu. Agent dowiaduje się, czy
działanie faktycznie nastąpiło: narzędzie czeka na potwierdzenie przeglądarki,
a brak potwierdzenia to niepowodzenie, nie sukces. Polecenie z rozmowy, której
nie oglądasz, nie przełączy Ci widoku.
---

## Architektura

```
apps/
  server/                  warstwa składania backendu (jedyne miejsce znające obie strony)
  web/                     warstwa składania frontendu
packages/
  platform-contracts/      kontrakty Zod + interfejsy rejestracji modułu (zero domeny)
  platform-server/         Hono, SQLite/Drizzle, magazyn plików, runtime Claude, AG-UI, MCP, sandbox
  platform-ui/             powłoka React: nawigacja, canvas, czat, katalog komponentów
  module-procurement/      moduł biznesowy: ./server, ./ui, ./shared
  module-devkit-probe/     minimalny moduł testowy (dowód, że kontrakt rozszerzeń działa)
```

Kierunek zależności jest jednokierunkowy: `apps/*` → `module-*` → `platform-*` → `platform-contracts`.
Żaden pakiet `@platform/*` nie deklaruje ani nie importuje `@module/*`; sprawdza to
`pnpm check:boundaries`, które dodatkowo skanuje kod platformy pod kątem słownika domenowego.

Platforma uruchamia się z **pustym rejestrem modułów** — to obsługiwana konfiguracja,
weryfikowana przez `tests/platform-boundary.test.ts`.

### Podział odpowiedzialności w canvasie

| Kanał | Endpoint | Wersja | Właściciel |
|---|---|---|---|
| Geometria karty | `PATCH /api/canvas/cards/:id/geometry` | `geometryVersion` | wskaźnik użytkownika |
| Treść karty | `PATCH /api/canvas/cards/:id/spec` | `specVersion` | autor kompozycji (agent / układ domyślny) |

Kanały piszą rozłączne kolumny i mają rozłączne liczniki wersji, więc przeciąganie karty
i równoczesna edycja jej treści przez agenta nie mogą się nawzajem nadpisać.

### Uwierzytelnienie

**Wyłącznie subskrypcja Claude.** Token dociera do modelu przez Claude Agent SDK,
który czyta `~/.claude/.credentials.json` niezależnie od aplikacji.

Aplikacja **czyta i parsuje** ten sam plik, żeby poznać plan i datę wygaśnięcia —
inaczej nie dałoby się ich pokazać. Z odczytanego obiektu kopiuje wyłącznie
`subscriptionType` i `expiresAt`; wartości `accessToken` i `refreshToken` nie
używa, nie przechowuje, nie loguje i nie przesyła. Pliku nigdy nie zapisuje:
odświeżanie tokena należy do SDK.

Ekran Ustawień rozdziela trzy niezależne rzeczy, bo ich zlepienie sprawiało, że
wygasłe logowanie wyglądało na zdrowe:

| Wymiar | Co mówi |
|---|---|
| sposób logowania | polityka instalacji — tu zawsze subskrypcja |
| stan poświadczenia | `brak` / `termin ważny` / `termin minął` / `nieczytelne` — minięty termin nie jest werdyktem, SDK może odnowić token |
| ostatni dostęp | `niesprawdzony` / `potwierdzony` / `limit użycia` / `odnowienie odrzucone` / `logowanie odwołane` / `błąd` |

Kontrola braku wycieku obejmuje zbudowany frontend, zbudowany backend, plik bazy
danych i wyjście diagnostyki uruchomieniowej (`tests/durability.test.ts`), a nie
tylko dwie odpowiedzi HTTP.

Zmienne mogące przekierować wykonanie na płatne API lub gateway
(`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, Bedrock, Vertex, `CLAUDE_CODE_USE_*`)
są usuwane z procesu potomnego SDK — polityka jest egzekwowana, nie zakładana.

Dostęp do samej aplikacji to osobna, lokalna sesja (podpisane HMAC ciasteczko).
Token subskrypcji nigdy nie pełni roli tokena dostępu do aplikacji.

---

## Konfiguracja

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `PORT` | `8791` | port backendu |
| `APP_DATA_DIR` | `<repo>/data` | baza, pliki, workspace uruchomień |
| `APP_ALLOWED_ORIGINS` | `localhost:5173`, `localhost:8791` (+ 127.0.0.1) | dozwolone originy |
| `APP_WEB_DIST` | `apps/web/dist` | zbudowany frontend serwowany w trybie produkcyjnym |
| `APP_MODEL` | `claude-sonnet-4-5` | model używany przez agenta |
| `APP_RUN_TIMEOUT_MS` | `300000` | twardy limit jednego uruchomienia agenta |
| `APP_MAX_UPLOAD_BYTES` | `8388608` | limit wielkości pliku |
| `APP_INSTANCE_LABEL` | brak | **tylko testy.** Ustawiona na `agenticapp-test` sprawia, że serwer odmawia startu na porcie poza 8792–8799 albo na katalogu bez prefiksu `.e2e`, i podaje etykietę w `/api/health`. Produkcja jej nie ustawia i nie jest ograniczana |

`pnpm reset` kasuje `data/`, uruchamia migracje i seed od nowa.

### Izolacja testów

Testy nie mogą wysłać żądania do instancji, której same nie uruchomiły, ani zapisać
niczego w `data/` — i nie zależy to od poprawnie wpisanej konfiguracji. Sprawdzane
w trzech miejscach: przy wczytywaniu `playwright.config.ts` (zła wartość = błąd i
zero uruchomionych serwerów), w `loadConfig` serwera (odmowa przed utworzeniem
katalogu) i w czasie działania przez etykietę w `/api/health`. `APP_BASE_URL`
wskazujący inny port kończy się odmową, nie przebiegiem.

---

## Dodanie kolejnego modułu biznesowego

Moduł dostarcza dwie połowy i **nie wymaga żadnej zmiany w platformie**:

- **serwer** (`ServerModule`): migracje SQL, narzędzia (`ModuleToolDefinition`) będące cienkimi
  nakładkami na serwisy domenowe, opcjonalne trasy HTTP przez neutralny `RouteRegistrar`,
  opis komponentów kart (`CardComponentDescriptor`), briefing dla agenta, `describeResource`,
  `defaultComposition`, `seed`.
- **przeglądarka** (`UiModule`): renderery kart, komponenty OpenUI Lang, pozycje menu.

Warstwa składania (`apps/server/src/compose.ts`, `apps/web/src/compose.tsx`) łączy jedno z drugim.
Szczegółowa lista tego, co trzeba dostarczyć, i czego brakuje — w sekcji 8 `FEEDBACK.md`.

> Uwaga przy pisaniu schematów narzędzi: `z.record()` i `z.default()` są niezgodne z warstwą MCP
> Claude Agent SDK (szczegóły: wpisy #15 i #18 w `FEEDBACK.md`). Platforma wykrywa oba przy starcie
> i przerywa z czytelnym błędem zamiast po cichu zgubić narzędzia.
