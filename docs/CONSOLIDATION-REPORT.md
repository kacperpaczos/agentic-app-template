# Raport konsolidacji AgenticApp w szablon `agentic-app-template`

**Data:** 2026-09-16 · **Zakres fazy:** dokumentacja, złożenie szablonu z istniejącego kodu, regresja i
odtwarzalność istniejącej wersji, repozytorium i publikacja. Ocena 200 kryteriów służy w tej fazie
utworzeniu backlogu — brakujące funkcje nie były implementowane. **Nie jest to odbiór 200 kryteriów.**

## 0. Werdykt

- **Bazowa wersja szablonu jest złożona, zweryfikowana w czystej kopii i opublikowana jako
  wersja robocza** (§8). Istniejąca aplikacja działa w szablonie tak jak w źródle: `pnpm verify`
  (257/257 testów Vitest), `pnpm test:e2e` (63/63, w tym trzy tury na prawdziwym modelu), próba
  wymiany domeny, start produkcyjny z danymi startowymi i build obrazu Docker bez cache.
- **Szablon nie spełnia wszystkich wymagań specyfikacji.** Stan wyliczony z macierzy: §4.
  Otwarte kryteria są przypisane do pakietów w [`BACKLOG.md`](BACKLOG.md).
- Po drodze znaleziono i opisano realne wady odtwarzalności i wymienialności, których nie ujawniała
  praca w katalogu źródłowym (§5).

**Liczby z macierzy** (wyliczone przez `scripts/acceptance-matrix.mjs`): z 200 kryteriów **58 potwierdzonych**,
**117 częściowych**, **17 niespełnionych**, **8 niesprawdzonych**; **0 z 12 warstw zamkniętych**; z 27 prób
odbiorowych 1 potwierdzona (T05), 21 częściowych, 5 niespełnionych. Otwarte kryteria: 142 w 12 pakietach
backlogu.

Wynik „95/95” z AgenticApp dotyczył poprzedniej wersji wymagań i dowodów zebranych poza tym
repozytorium. Z tych 95 kryteriów w szablonie potwierdzonych jest **35**: nowa ocena wymaga dowodu
wykonanego na kodzie szablonu, a analiza testów pokazała, że część asercji nie pokrywa pełnej treści
kryteriów (§6.1). Z 105 nowych kryteriów potwierdzonych jest 23.

## 1. Struktura i odpowiedzialności

| Część | Katalogi | Odpowiedzialność |
|---|---|---|
| Platforma | `packages/platform-contracts`, `packages/platform-server`, `packages/platform-ui` | powłoka UI, gotowy czat OpenUI, wykonanie agenta (Mastra + Claude Agent SDK na subskrypcji), MCP, AG-UI, rozmowy, artefakty, pliki i sandbox, zadania w tle, nawigacja agenta, trwałość, diagnostyka |
| Składanie aplikacji | `apps/server`, `apps/web` | wybór modułów, trasy ekranów modułów, menu platformy — jedyne miejsce zależne od obu stron |
| Aplikacja przykładowa | `packages/module-procurement` | porównywanie ofert: encje, reguły, narzędzia, trasy, karty, ekrany, cele nawigacji, odczyty live, syntetyczne dane startowe |
| Moduł kontrolny | `packages/module-devkit-probe` | dowód, że platforma działa z innym modułem; nadal pełni tę rolę (test granicy + `pnpm check:module-swap`), nie ma połówki UI |
| Dokumentacja | `README.md`, `AGENTS.md`, `CLAUDE.md`, `FEEDBACK.md`, `docs/` | specyfikacja, kontrakt nowej aplikacji, macierz, backlog, mapa dokumentów, procedury, archiwum, dowody |

Kierunek zależności `apps/*` → `module-*` → `platform-*` → `platform-contracts` jest sprawdzany przez
`pnpm check:boundaries` w `pnpm verify`.

## 2. Dokumentacja — co zastąpiono, scalono i zachowano

Pełne rozliczenie każdego pliku: [`DOCUMENTATION-MAP.md`](DOCUMENTATION-MAP.md). W skrócie:

- **Zastąpiono:** specyfikację 95 kryteriów wersją 200 (`docs/ARCHITECTURE.md`, wierna kopia; jedyna
  zmiana to usunięta pusta linia rozcinająca tabelę prób). Porównanie maszynowe: stara wersja nie ma
  wymagań unikalnych; L2.3 i L5.3 zaostrzone.
- **Scalono:** README aplikacji → README szablonu i `docs/NEW-APPLICATION.md`; wnioski z dziennika
  (rejestr adapterów, pułapki bibliotek, wymagania nowej domeny) → `docs/NEW-APPLICATION.md`;
  oceny 95 kryteriów i ograniczenia z raportu domknięcia → kolumna historyczna `ACCEPTANCE.md` i
  `BACKLOG.md`.
- **Zachowano i sprawdzono:** `docs/observability.md` (wersje i test zgodne z kodem),
  `docs/odzyskiwanie-stanu.md` (liczby oznaczone jako historyczne; dopisany brak `platform-0003` w
  próbie migracji).
- **Zarchiwizowano z adnotacją:** raporty i dziennik AgenticApp (wyniki dotyczą innego katalogu i
  wersji 95); plan szablonu z 2026-08 (Next.js/CopilotKit/BYOK — **sprzeczny** ze specyfikacją).
- **Nie opublikowano:** dowodów historycznych AgenticApp (lokalne ścieżki, identyfikatory sesji,
  ślady sieciowe), zleceń wykonawczych i wersji pośrednich specyfikacji.
- **W AgenticApp** (część A planu): `docs/ARCHITECTURE.md`, archiwum wersji 95 bajt w bajt, odsyłacz
  w miejscu starej specyfikacji, poprawione odnośniki README, `docs/DOCUMENTATION-MAP.md`; skrypty
  historycznej macierzy czytają archiwum — `pnpm check:closure` i `pnpm check:matrix` przechodzą.
  Kopia sprzed zmian: `agentic-app-template-consolidation-backup/` obok obu katalogów (lokalnie).

## 3. Kod — różnice względem AgenticApp

Źródło: AgenticApp po zakończeniu pracy wykonawcy nad panelem rozmowy (ostatnia tura 2026-09-16
08:19 UTC). Manifest z 08:28:13 UTC: 253 pliki, sha256
`c06a8f63fa409cd158259ca86e8f1de6b05817e509dde422b6662d75142b0d72`. Commit `7340863` to wierny import
183 plików kodu z tego stanu. Pełna lista zmian: `git diff 7340863 HEAD`.

| Plik | Zmiana | Powód |
|---|---|---|
| `scripts/check-boundaries.mjs` | pakiety platformy i moduły wykrywane po katalogach; słownik domeny z `agenticApp.domainVocabulary` modułów; odmowa, gdy żaden moduł nie deklaruje słownika | poprzednio skrypt czytał na sztywno manifest modułu przykładowego — po wymianie domeny kontrola padałaby. Kontrole negatywne: `evidence/template-consolidation/przebieg-2-7d6bd78/08-…` |
| `packages/module-procurement/package.json` | pole `agenticApp.domainVocabulary` (te same 12 pojęć) | j.w. |
| `scripts/check-module-swap.mjs` (nowy) | próba wymiany modułu przykładowego na kontrolny na kopii repozytorium | dowód wymienialności domeny (część D planu) |
| `scripts/acceptance-matrix.mjs` (nowy), `docs/acceptance/assessment.json` | macierz 200 kryteriów i 27 prób generowana ze specyfikacji; kontrola braków, duplikatów, dryfu i reguł statusu w `pnpm verify` | L12.9; sumy nie są wpisywane ręcznie |
| `scripts/matrix-summary.mjs`, `closure-matrix.mjs`, `audit-matrix.mjs` | czytają dokumenty z `docs/archive/agenticapp-2026-09/` | kontrole historycznych macierzy nie zostały wyłączone |
| `package.json` | nazwa `agentic-app-template`; skrypty `check:acceptance`, `acceptance:render`, `check:module-swap`; **`verify` buduje przed testami** | kolejność: patrz §5.1 |
| `.gitignore` | lokalne ustawienia narzędzi, logi, katalog próby wymiany | — |

`apps/`, `packages/*/src`, `tests/`, `e2e/`, `Dockerfile`, `compose.yaml`, `pnpm-lock.yaml` — **bez zmian**.
Stan źródła po zakończeniu prac: manifest końcowy: 256 plików, sha256 134cc4bdf8aa955872e55f220f0cf190aad295e960b91974c1a6db7e2edc5584; dodane: docs/ARCHITECTURE.md, docs/DOCUMENTATION-MAP.md, docs/archive/stack-agentowy-ustalenia-i-materialy-95-kryteriow.md; usunięte: —; zmienione: README.md, scripts/audit-matrix.mjs, scripts/closure-matrix.mjs, stack-agentowy-ustalenia-i-materialy.md — wyłącznie zmiany z części A konsolidacji (§2), bez równoległych zmian kodu.

## 4. Status warstw i kryteriów

| Warstwa | Kryteria | Potwierdzone | Otwarte |
|---|---|---|---|
| L1 — Runtime i środowisko full stack | 13 | 7 | 6 |
| L2 — Komponenty i nawigacja frontendowa | 17 | 4 | 13 |
| L3 — Dynamiczna kompozycja interfejsu | 18 | 4 | 14 |
| L4 — Czat i zarządzanie rozmowami | 15 | 6 | 9 |
| L5 — Komunikacja i zdarzenia | 17 | 6 | 11 |
| L6 — Kontekst aplikacji dla agenta | 17 | 0 | 17 |
| L7 — Orkiestracja backendowa | 13 | 6 | 7 |
| L8 — Harness i uwierzytelnienie Claude | 14 | 2 | 12 |
| L9 — Model domeny i funkcje backendu | 16 | 3 | 13 |
| L10 — Trwałość, cache i artefakty | 19 | 6 | 13 |
| L11 — Pliki, sandbox i cykl życia zadań | 24 | 6 | 18 |
| L12 — Obserwowalność i odbiór integracji | 17 | 8 | 9 |
| **Razem** | **200** | **58** | **142** (117 częściowe, 17 niespełnione, 8 niesprawdzone) |

Rodzaj najmocniejszego dowodu: test kontraktu lub logiki 56, test GUI bez modelu 54, rzeczywisty model 43,
analiza kodu 29, symulacja 6, brak dowodu w szablonie 12. Dowody historyczne nie liczą się jako
potwierdzenie. Kontrole negatywne generatora macierzy:
[`evidence/template-consolidation/kontrole-negatywne-macierzy.txt`](evidence/template-consolidation/kontrole-negatywne-macierzy.txt).

Zasada oceny: **„potwierdzone” wymaga dowodu wykonanego lub przeanalizowanego na kodzie tego
repozytorium** (regresja §5, analiza kodu tam, gdzie jest adekwatna). Wynik historyczny z AgenticApp
jest pokazany osobno i sam nie zalicza kryterium. Oceny przygotowano przez analizę kodu i testów
szablonu wobec treści kryteriów, z historyczną oceną wykonawcy jako punktem wyjścia; następnie
skorygowano je o wyniki regresji. Szczegóły, dowody i braki każdego kryterium: [`ACCEPTANCE.md`](ACCEPTANCE.md).

## 5. Regresja, czysta instalacja, wymiana domeny

Dowody: [`evidence/template-consolidation/`](evidence/template-consolidation/).

### 5.1 Przebieg 1 — commit `bf83bb6` — nieudany

| Polecenie | Kod | Wynik |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | — |
| `pnpm verify` | **1** | 2 z 257 testów oblały w `tests/durability.test.ts`: testy skanują zbudowane pakiety pod kątem sekretów, a `verify` uruchamiał je przed buildem |
| `pnpm test:e2e` | **1** | brak `apps/server/dist/server.js` — suita testuje istniejący build |

Wada istniała w AgenticApp, ale była niewidoczna, bo `dist/` zostawał po wcześniejszych buildach
(tamtejsza „czysta instalacja” wykonała `pnpm build` przed `pnpm verify`). Poprawka `7d6bd78`: build
przed testami; README i `AGENTS.md` mówią, że `test:e2e` wymaga wcześniejszego buildu.

### 5.2 Przebieg 2 — commit `7d6bd78` — udany

| Polecenie | Kod | Wynik |
|---|---|---|
| `git clone` + `pnpm install --frozen-lockfile` | 0 | 2 s, lockfile sha256 `f2cfa663…` |
| `pnpm verify` | 0 | granica, macierze historyczne, typecheck, build, **Vitest 22 pliki / 257 testów** |
| `pnpm test:e2e` | 0 | **63/63** w 5,0 min; trzy tury na prawdziwym modelu subskrypcyjnym (pełna ścieżka polecenie → narzędzie → mutacja → canvas → strumień → trwałość; treść obrazu; zmiana skoroszytu w sandboxie po zgodzie, oryginał nietknięty) |
| `pnpm check:module-swap` | 0 | moduł przykładowy zastąpiony kontrolnym w `apps/` + usunięta połówka UI przykładu; `packages/platform-*` identyczne (SHA-256); install, granica, typecheck, build; serwer z rejestrem `["probe"]`, narzędzia `probe_*`, trasa modułu, kompozycja walidowana komponentem `probe.noteList`, brak tabel `pc_*`; powłoka w Chromium bez ekranów przykładu i błędów strony |
| `pnpm start` (własny port, domyślny `data/`) | — | dane startowe `PC-2026-01` (MediaPro 49 270,00 PLN — ranking 1; AV Technika — 2; Konferencje24 i NordAV wykluczone), 1 przestrzeń, 5 plików; restart bez ponownego zasiewania; `pnpm seed` respektuje znacznik, `--force` bez duplikatów; `APP_SKIP_BASE_DATA=1` — pusto; zrzut ekranu |
| `docker build --no-cache --pull` | 0 | 129 s; instalacja w obrazie bez magazynu hosta (`reused 0, downloaded 621`) |
| kontener | — | od wewnątrz: health, moduł, dane startowe, `credential=absent`, brak `~/.claude`, użytkownik `node`. **Dostęp z hosta przez opublikowany port nie powiódł się** — także dla kontrolnego minimalnego kontenera, przy działającym wcześniej uruchomionym kontenerze użytkownika: ograniczenie środowiska (rootless Docker na tej maszynie), mapowanie portu niesprawdzone |

Pomiary zapisane przez suitę: odświeżenie po mutacji przez UI 181 ms; anulowanie (scenariusz bez
modelu) 959 ms do stanu `cancelled`; strumień prawdziwego modelu: 77 różnych długości tekstu przed
końcem wykonania.

### 5.3 Próba wymiany domeny — nieudane przebiegi przed udanym

Na drzewie roboczym, przed commitem: (1) błąd skryptu — wyrażenie wycinające trasy przykładu usunęło
też trasy platformy, wykrył to typecheck; (2) **rzeczywista wada wymienialności** — typowane linki
TanStack Router w `module-procurement/src/ui/pages.tsx` zależą od globalnej rejestracji routera
aplikacji, więc moduł niezłożony do aplikacji nie przechodzi typecheck, gdy zostaje w repozytorium
(platforma nietknięta); procedura odłączenia przykładu usuwa jego połówkę UI, trwałe rozwiązanie w
BL-06; (3) błąd skryptu przy imporcie Playwrighta. Czwarty przebieg i przebieg na zatwierdzonym stanie
przeszły.

### 5.4 Izolacja od instancji i danych użytkownika

Wszystkie przebiegi działały w czystych kopiach poza obydwoma repozytoriami, na portach testowych
8795–8799 lub efemerycznych. Instancja użytkownika AgenticApp (port 8791) działała przez cały czas.
Na początku i na końcu prac ten sam proces (pid 2785270) był jedynym procesem trzymającym pliki bazy
AgenticApp, a `app.db`, `app.db-shm` i `app.db-wal` miały identyczne rozmiary i czasy modyfikacji
(10:12:55, sprzed rozpoczęcia konsolidacji):
[`evidence/template-consolidation/izolacja-agenticapp.txt`](evidence/template-consolidation/izolacja-agenticapp.txt).
Nie zabijano żadnych procesów użytkownika; nie używano `pnpm dev`, `pnpm acceptance` ani
`scripts/run-agent.mjs`, które domyślnie celują w port 8791.

## 6. Braki i ograniczenia

### 6.1 Implementacja (funkcji brakuje lub działa niezgodnie ze specyfikacją)

**Zakres nieprzekazany wykonawcy** (dopisany do specyfikacji po zleceniu): semantyczny odczyt UI,
wskazanie wartości pola, filtry i sortowanie przez rozmowę (L2.16, L2.17, L6.15–L6.17 → BL-01);
przestrzeń „Widoki agenta” (L3.14, L3.15; L3.16–L3.18 częściowe/niesprawdzone → BL-02).

**Wady w istniejącym kodzie** — ustalone analizą kodu i testów szablonu. Najważniejsze sprawdziłem
bezpośrednio w kodzie: `get_context`, `IdempotencyStore.once`, `saveComparisonArtifact`,
`answerPermission`, domyślny adres `pnpm acceptance`. Nie wykonywano prób, które by je wywołały:

| Kryterium | Brak |
|---|---|
| L6.3, L6.9 | `get_context` zwraca kontekst ze startu wykonania; nie ma kanału odczytu nowszego kontekstu podczas długiego zadania |
| L6.12 | po przełączeniu tożsamości bez przeładowania kolejne polecenie niesie zasób, przestrzeń, zaznaczenie i szkice poprzedniego właściciela |
| L4.7 | usunięcie rozmowy nie anuluje trwającego wykonania; jego wiersz znika kaskadowo |
| L7.13 | brak wykrywania utraty transkryptu SDK — wznowienie może po cichu zacząć nową sesję |
| L9.2 | nie wszystkie operacje mają te same reguły w HTTP i MCP (wagi kryteriów, limit wyszukiwania) |
| L9.7, L9.14 | `procurement_save_comparison` ignoruje `operationId`; ten sam klucz z inną treścią zwraca stary wynik zamiast odrzucenia; sprawdzenie i zapis klucza nie są atomowe |
| L9.8 | część wieloetapowych zapisów poza transakcją (wagi kryteriów, publikacja pliku jako artefaktu) |
| L11.13 | odpowiedź na prośbę o zgodę rozstrzygana po samym `requestId`, bez powiązania z wykonaniem |

Wady częściowe o dużym znaczeniu (pełna lista w `ACCEPTANCE.md`): wolniejsza odpowiedź poprzedniej
rozmowy może nadpisać nowszy wybór przestrzeni (L2.8); karty `openui` z nieznanym komponentem
przechodzą walidację (L3.3); powtórzone `POST /api/agui/run` tworzy nowe wykonanie (L4.6); reconnect
odtwarza zdarzenia od początku, co może powtórzyć nawigację lub prośbę o zgodę (L5.6); narzędzia
plikowe są auto-zatwierdzane bez reguł ścieżek, a katalog konfiguracji Claude nie jest na liście
`denyRead` sandboxu (L11.4, L11.11 — do sprawdzenia próbą); `pnpm acceptance` i
`scripts/run-agent.mjs` domyślnie zapisują dane w instancji na porcie 8791 bez sprawdzenia etykiety
(L1.8 — ostrzeżenie dopisane do README i `AGENTS.md`); typowane trasy modułu zależą od routera
aplikacji, a testy platformy od modułu przykładowego (L9.11, L9.12).

### 6.2 Brak próby w szablonie (funkcja prawdopodobnie działa, ale nie ma powtarzalnego dowodu)

Kryteria bez żadnego wykonywanego dowodu w szablonie (**niesprawdzone**): L3.17, L6.5, L6.8, L7.4,
L7.10, L11.3, L11.4, L11.11. Dodatkowo pakiet **BL-03** (20 kryteriów) zbiera funkcje potwierdzone w
AgenticApp tylko historycznym przebiegiem lub ręczną sondą — m.in. izolacja sandboxu (sieć, katalog
danych), zmiana/przesunięcie/usunięcie karty przez model, zgoda i odmowa w powłoce, wznowienie po
restarcie, nawigacja przez prawdziwy `ui_navigate`. Kopia stanu, próba migracji i odtworzenie
(`scripts/backup-state.mjs`, `migration-rehearsal.mjs`) nie były wykonywane w szablonie (BL-07).

### 6.3 Dostęp do usług i środowisko

- Claude wyłącznie z subskrypcji — dostęp był aktywny; trzy tury e2e przeszły. Wyczerpanie limitu,
  wygaśnięcie i odwołanie logowania nie są wywoływalne na żądanie (BL-04).
- Docker: publikowanie portów nowych kontenerów nie działało w demonie rootless na tej maszynie (§5.2).
- `pnpm dev` nie był uruchamiany: proxy Vite ma stały port 8791, zajęty przez instancję użytkownika.
- Langfuse nie jest podłączony (opcjonalny).

### 6.4 Decyzje użytkownika

- Licencja kodu — repozytorium nie ma pliku licencji; wybór nie został dokonany za właściciela.
- Widoczność repozytorium — utworzone jako **prywatne** (domyślnie według planu).
- Migracja danych w AgenticApp — poza zakresem; nie wykonywano.

## 7. Oryginalna aplikacja

- **Kod i dane AgenticApp zachowane.** Źródła: zmiany wyłącznie z części A (dokumentacja: `docs/ARCHITECTURE.md`,
  `docs/DOCUMENTATION-MAP.md`, archiwum specyfikacji 95, odsyłacz w `stack-agentowy-ustalenia-i-materialy.md`,
  odnośniki w `README.md`; skrypty `scripts/audit-matrix.mjs` i `scripts/closure-matrix.mjs` czytają
  archiwum). Po zmianach `pnpm check:closure` i `pnpm check:matrix` w AgenticApp przechodzą. Nie
  budowano AgenticApp (build nadpisałby `dist/` serwowany przez działającą instancję).
- **Dane i proces**: bez zmian (§5.4). Migracji nie wykonywano.
- **Kopia sprzed konsolidacji**: `agentic-app-template-consolidation-backup/` obok obu katalogów —
  wcześniejsza zawartość katalogu szablonu, źródła AgenticApp bez `node_modules`/`data`/`backups`,
  manifest startowy.
- Czyste kopie do weryfikacji powstały poza oboma repozytoriami (w katalogu cache użytkownika) i
  zostały usunięte po zakończeniu prób; obrazy, kontenery i wolumeny weryfikacyjne Dockera usunięto
  od razu po próbie.

## 8. Publikacja

- Repozytorium: **https://github.com/kacperpaczos/agentic-app-template** — prywatne, oznaczone jako
  GitHub template. Utworzone w tej konsolidacji; wcześniej nie istniało (sprawdzone przed utworzeniem),
  więc żadna zawartość nie została nadpisana. Brak force-push.
- Historia: `7340863` wierny import kodu → `bf83bb6` dostosowanie i dokumentacja → `7d6bd78` naprawa
  kolejności `verify` (**zweryfikowany kod**: §5.2) → commit z macierzą, backlogiem, dowodami i tym
  raportem. Ostatni commit zmienia względem `7d6bd78` wyłącznie dokumentację, dowody,
  `scripts/acceptance-matrix.mjs` i skrypty `check:acceptance`/`acceptance:render` w `package.json`
  (weryfikowalne: `git diff --stat 7d6bd78 HEAD`).
- Weryfikacja wysłanego stanu: czysta kopia z GitHuba ostatniego commitu, `pnpm install --frozen-lockfile`
  i `pnpm verify`. Wynik jest zapisany w wiadomości adnotowanego tagu `v0.1.0-baseline` wskazującego
  ten commit — raport nie może zawierać hasha commitu, w którym sam się znajduje.
- Przed wysłaniem sprawdzono śledzone pliki i całą historię wzorcami sekretów (klucze Anthropic,
  GitHub, AWS, klucze prywatne, wartości `accessToken`/`refreshToken`, `Bearer`), adres e-mail i ścieżki
  katalogu domowego — trafienia wyłącznie w syntetycznych wartościach testowych (`sk-ant-SYNTETYCZNY`).
- **Status: wersja robocza** — nie „gotowy oficjalny szablon”, bo kryteria odbioru nie są spełnione (§4).
