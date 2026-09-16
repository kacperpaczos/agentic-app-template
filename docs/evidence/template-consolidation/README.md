# Dowody konsolidacji szablonu — 2026-09-16

Dowody zebrane na kodzie **tego repozytorium**, w czystych kopiach zatwierdzonych commitów
(`git clone` do katalogu poza repozytorium, `pnpm install --frozen-lockfile`, bez `node_modules`,
`dist` ani `data` z innych instalacji). Logi mają rozszerzenie `.txt` (repozytorium ignoruje `*.log`). Ścieżki lokalne zastąpiono znacznikami `<czysta-kopia>`,
`<repozytorium-zrodlowe>`, `<katalog-tymczasowy>`, `~`. Pliki nie zawierają tokenów; skan
wzorców sekretów przed commitem nie znalazł trafień.

Środowisko obu przebiegów: Linux 7.2.5 (Fedora 44) x86_64, Node 24.19.0, pnpm 9.15.9,
Claude Code CLI 2.1.273, lockfile sha256 `f2cfa663f6be5fe7f7cd7a619226a9e1f39b7aff4a0830ee74501cc4d3ceae52`.
Na porcie 8791 działała w tym czasie instancja użytkownika aplikacji źródłowej — żaden przebieg z
niej nie korzystał (testy mają porty 8793–8799, pozostałe próby wolne porty efemeryczne).

## Przebieg 1 — commit `bf83bb6` — **nieudany**

[`przebieg-1-bf83bb6-nieudany/`](przebieg-1-bf83bb6-nieudany/)

| Krok | Wynik |
|---|---|
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm verify` | **1** — `tests/durability.test.ts`: 2 z 257 testów oblały („brak zbudowanego frontendu/backendu — uruchom pnpm build”); `verify` uruchamiał testy przed buildem |
| `pnpm test:e2e` | **1** — `ERR_MODULE_NOT_FOUND apps/server/dist/server.js`: suita uruchamia istniejący build produkcyjny, którego nie było |

Przyczyna i poprawka: commit `7d6bd78` (build przed testami w `verify`; dokumentacja wymagania
buildu dla `test:e2e`). Wada była niewidoczna w aplikacji źródłowej, bo `dist/` zostawał po
wcześniejszych buildach.

## Przebieg 2 — commit `7d6bd78` — udany

[`przebieg-2-7d6bd78/`](przebieg-2-7d6bd78/)

| Plik | Co dowodzi | Wynik |
|---|---|---|
| `00-przebieg.txt`, `01-srodowisko.txt` | kolejność kroków, czasy, wersje, commit, lockfile | — |
| `03-install.txt` | instalacja z lockfile | exit 0, 2 s |
| `04-verify.txt` | `check:boundaries`, `check:matrix`, `check:closure`, `typecheck`, `build`, `test` | exit 0; Vitest: 22 pliki, **257/257** |
| `05-test-e2e.txt` | Playwright na buildzie produkcyjnym, izolowane instancje | exit 0; **63/63** w 5,0 min; trzy tury na prawdziwym modelu subskrypcyjnym: `agent-ui.spec.ts` „polecenie → narzędzie → mutacja → canvas → strumień → trwałość” (1,0 min), `files-agent.spec.ts` „agent odnosi się do treści obrazu, nie do jego nazwy” (15,9 s) i „agent zmienia skoroszyt w sandboxie, a oryginał zostaje nietknięty” (1,1 min); pozostałe testy używają skryptowanego serwera lub API bez modelu |
| `pomiary-e2e/*.json` | pomiary zapisane przez suitę: odświeżenie po mutacji 181 ms, anulowanie 959 ms (scenariusz bez modelu), strumień skryptowany i strumień prawdziwego modelu (77 różnych długości przed końcem) | suita zapisuje je do `docs/evidence/closure-2026-09-15/` — nazwa katalogu odziedziczona po aplikacji źródłowej (backlog) |
| `06-module-swap.txt`, `06-module-swap.json` | `pnpm check:module-swap`: moduł przykładowy zastąpiony kontrolnym w warstwie składania, platforma bez zmian (sumy SHA-256), install, granica, typecheck, build, start, rejestr, narzędzia, trasa, kompozycja, baza, powłoka w Chromium | exit 0 |
| `start-czysta-kopia.txt`, `start-czysta-kopia.png` | `pnpm start` na czystej kopii, własny port, domyślny `data/`: dane startowe `PC-2026-01` i wynik porównania, restart bez ponownego zasiewania, `pnpm seed` i `pnpm seed --force` bez duplikatów, `APP_SKIP_BASE_DATA=1` | wszystkie kroki OK; zrzut pokazuje syntetyczne dane i typ planu subskrypcji lokalnego konta |
| `07-docker.txt`, `07-docker-build.txt` | `docker build --no-cache --pull` z czystej kopii | exit 0, 129 s; instalacja w obrazie: `reused 0, downloaded 621` |
| `07-docker-uruchomienie.txt` | kontener: aplikacja sprawdzona **od wewnątrz** (health, moduł, dane startowe, `credential=absent`, brak `~/.claude`, użytkownik `node`) | działa; **dostęp z hosta przez opublikowany port nie powiódł się** — także dla kontrolnego minimalnego kontenera `node:22-alpine`, podczas gdy wcześniej uruchomiony kontener użytkownika odpowiadał. Ograniczenie środowiska (publikowanie portów nowych kontenerów w tym demonie rootless Docker), nie aplikacji; mapowanie portu z hosta pozostaje niesprawdzone w tej konsolidacji |
| `08-kontrole-negatywne-granicy.txt` | `check:boundaries` oblewa przy imporcie `@module/*` w platformie, słowie domenowym, zależności w manifeście platformy i braku słownika; przechodzi po usunięciu przykładu bez edycji skryptu | zgodnie z oczekiwaniem |

## Pozostałe

| Plik | Co dowodzi |
|---|---|
| [`izolacja-agenticapp.txt`](izolacja-agenticapp.txt) | stan plików bazy i procesu instancji użytkownika aplikacji źródłowej na początku i końcu prac |
| `kontrole-negatywne-macierzy.txt` | `pnpm check:acceptance` oblewa przy brakującej ocenie, dryfie wygenerowanych plików, „potwierdzone” z dowodem historycznym i otwartym kryterium bez backlogu |
