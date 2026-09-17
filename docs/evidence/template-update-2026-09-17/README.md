# Dowody aktualizacji szablonu — 2026-09-17

Dowody zebrane na kodzie **tego repozytorium** po przeniesieniu poprawek AgenticApp z 2026-09-17,
w czystej kopii zatwierdzonego commitu `d142b85` (`git clone` poza repozytorium,
`pnpm install --frozen-lockfile`). Logi mają rozszerzenie `.txt` (repozytorium ignoruje `*.log`).
Ścieżki lokalne zastąpiono znacznikami `<czysta-kopia>`, `<repozytorium-zrodlowe>`,
`<katalog-tymczasowy>`, `<katalog-sondy>`, `<scratchpad>`, `~`.

Środowisko: Linux 7.2.5 (Fedora 44) x86_64, Node 24.19.0, pnpm 9.15.9 — szczegóły w
`przebieg-d142b85/01-srodowisko.txt`. Na porcie 8791 działała instancja użytkownika aplikacji
źródłowej; żaden przebieg z niej nie korzystał (testy: porty 8792–8799, pozostałe próby: porty
efemeryczne).

## Przebieg — commit `d142b85`

[`przebieg-d142b85/`](przebieg-d142b85/)

| Plik | Co dowodzi | Wynik |
|---|---|---|
| `00-przebieg.txt`, `01-srodowisko.txt` | kolejność, czasy, wersje, commit, lockfile | — |
| `03-install.txt` | instalacja z lockfile | exit 0 |
| `04-verify.txt` | `check:boundaries`, `check:acceptance`, `check:matrix`, `check:closure`, `typecheck`, `build`, `test` | exit 0; Vitest 23 pliki, **278/278** |
| `05-test-e2e.txt` | Playwright na buildzie produkcyjnym, izolowane instancje | exit 0; **72/72** w 7,0 min; cztery tury na prawdziwym modelu: `agent-ui.spec.ts` „polecenie → narzędzie → mutacja → canvas → strumień → trwałość” (43,4 s) i **„pytanie o dane przenosi na ich widok, a nie tylko je opisuje”** (25,6 s, nowy), `files-agent.spec.ts` obraz (16,8 s) i skoroszyt; `view-filter.spec.ts` 7/7 (serwer skryptowany, port 8792) |
| `pomiary-e2e/*.json` | pomiary zapisane przez suitę (katalog o historycznej nazwie — backlog) | — |
| `09-sonda-ui-filter-model.txt`, `09-sonda-ui-filter-model.json` | **jednorazowa sonda na prawdziwym modelu**, poza regresją: polecenia w czacie zawężają `/data` i przywracają pełny widok; zapis potwierdzeń klienta z `/api/runs/:id/ui-ack` | exit 0, 56,2 s; tura 1: `/data?country=PL`, 3 z 4, pasek „Widok zawężony przez agenta…”; tura 2: 4 wiersze, bez parametru. Model najpierw użył `country=Polska` i `country=Poland` (0 z 4), potem `PL` |
| `09-sonda-ui-filter-model-proba1-blad-configu.txt` | **nieudane** pierwsze uruchomienie sondy | config sondy poza pakietem ESM wczytany jako CJS (`Cannot use 'import.meta' outside a module`) — błąd narzędzia próby; poprawka: `package.json` z `"type": "module"` w katalogu sondy |
| `sonda-model-filter.spec.ts.txt`, `sonda-make-config.sh.txt` | kod sondy i generator jej configu (do odtworzenia) | — |
| `06-module-swap.txt`, `06-module-swap.json` | `pnpm check:module-swap` po zmianie walidatora adresu w routerze | exit 0 |
| `start-czysta-kopia.txt`, `start-czysta-kopia.png` | `pnpm start` z danymi startowymi, restart, `seed`, `seed --force`, `APP_SKIP_BASE_DATA` | wszystkie kroki OK; 26 narzędzi platformy (w tym `ui_filter`) |

## Czego nie powtórzono w tej aktualizacji

- `docker build --no-cache` — `Dockerfile` i zależności bez zmian od przebiegu z 2026-09-16
  (`docs/evidence/template-consolidation/przebieg-2-7d6bd78/07-docker*.txt`).
- Kontrole negatywne `check:boundaries` i `check:acceptance` — skrypty bez zmian od 2026-09-16
  (`docs/evidence/template-consolidation/*kontrole-negatywne*`).
