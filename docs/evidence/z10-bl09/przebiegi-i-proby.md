# Z10 / BL-09 — przebiegi i próby zdolności wykrycia

Zapis przebiegów, na których oparte są oceny dwunastu kryteriów pakietu BL-09
(L11.7, L11.10, L11.12, L11.13, L11.15, L11.16, L11.18, L11.19, L11.20, L11.22, L11.23, L11.24).
Plik jest pisany ręcznie i **nie** powstaje z regresji — regresja zapisuje tylko
`pomiary-stop-procesy.json`, i tylko na żądanie (`pnpm evidence:z10`, czyli `APP_WRITE_EVIDENCE=1`).

**Tury modelu: 0.** Żaden spec modelowy nie był uruchamiany. Nowe dowody to *symulacja na granicy
adaptera SDK* (model zastąpiony scenariuszem; workspace, narzędzia, bramka zgody, publikacja,
sprzątanie i procesy prawdziwe) albo *test GUI bez modelu*.

## Przebiegi

| Polecenie | Kod wyjścia | Wynik |
|---|---|---|
| `pnpm verify` (czyste drzewo, commit `cd1964b`) | 0 | 45 plików / 721 testów; `git status --porcelain` po przebiegu: pusto |
| `pnpm exec playwright test e2e/consent-runs.spec.ts` | 0 | 5 testów |
| `pnpm exec playwright test e2e/run-continuity.spec.ts` | 0 | 4 testy |
| `pnpm exec playwright test e2e/sandbox-files.spec.ts` | 0 | 5 testów |
| `pnpm exec playwright test e2e/stop-children.spec.ts` | 0 | 1 test |
| `pnpm exec playwright test` (cały domyślny przebieg) | 1 | 172 zielone, 1 oblany: `e2e/bl10-agent-navigation.spec.ts` „cel w zwinietej sekcji…” — przewijanie do elementu nie zdążyło w 10 s przy trzech równoległych przebiegach przeglądarkowych na maszynie |
| powtórka tego samego specu razem z moimi (spokojna maszyna) | 0 | 18 zielonych, w tym oblany wcześniej test |
| `pnpm check:module-swap` | 0 | podmiana modułu na kontrolny; 163 s |
| `pnpm evidence:z10` | 0 | `pomiary-stop-procesy.json` (commit `c1c9d7c`, `brudneDrzewo: false`) |

Jedyne dwa oblane przebiegi na tym kodzie — pojedynczy test nawigacji wyżej oraz
`tests/measurements.test.ts` („223 ≤ 221”, próg tolerancji przekroczony o 2 ms) — wystąpiły przy
trzech równolegle działających zestawach przeglądarkowych i nie powtórzyły się na spokojnej maszynie.
Oba dotyczą cudzych testów i mierzą czas; żaden nie dotyka zmian tego pakietu.

## Próby zdolności wykrycia (G16)

Procedura: commit najpierw, próba na czystym drzewie, wycofanie **jednej** linii, przebieg,
`git checkout -- <plik>`, kontrola czystości. Wszystkie dziesięć oblało na spodziewanej asercji.

| # | Wycofana linia | Test | Jak oblał |
|---|---|---|---|
| A | porównanie `runId`/właściciela w `answerPermission` | `tests/consent.test.ts` | „odpowiedz z requestId innego uruchomienia nie rozstrzyga niczego” |
| B | `disallowedTools` w `sdkOptions` | `tests/consent.test.ts` | `expected undefined to deeply equal [ 'WebFetch', 'WebSearch' ]` |
| C | `markAwaitingConsent` | `tests/consent.test.ts` | `expected 'running' to be 'awaiting_consent'` |
| D | kompensacja `removeManagedFile` po awarii publikacji | `tests/publication.test.ts` | `osierocone bajty po nieudanej publikacji` |
| E | `workspace.dispose()` | `tests/publication.test.ts` | `workspace nie zostal sprzatniety` |
| F | słowo „wykresy” w `FILE_ANALYSIS.limits` | `tests/file-analysis.test.ts` | deklaracja rozjechana z zachowaniem parsera |
| F2 | przemianowanie zamienione na zapis wprost | `tests/publication.test.ts` | 2 testy — **na pozostawionym pliku tymczasowym**, nie na uciętym pliku (zob. niżej) |
| G | `markAwaitingConsent` | `e2e/consent-runs.spec.ts` | `/api/runs/active` po przeładowaniu nie zgłasza oczekiwania |
| J | `linkAttachments` | `e2e/sandbox-files.spec.ts` | `csv.attachedTo` puste |
| K | związanie procesu potomnego z sygnałem przerwania | `e2e/stop-children.spec.ts` | po 60 s proces nadal żyje (`expect.poll(...).toBe(0)`) |
| L | `abort.abort(new Error('run_timeout'))` | `e2e/run-continuity.spec.ts` | karta nigdy nie doszła do `data-phase="failed"` |

### Ograniczenie próby F2, powiedziane wprost

Asercja o atomowym zapisie wykrywa brak przemianowania **przez pozostawiony plik tymczasowy**, a nie
przez zobaczenie pliku uciętego w połowie. Własność „pod nazwą docelową nigdy nie ma pliku
niekompletnego” jest strukturalna: nazwa docelowa powstaje wyłącznie przez `rename`, który w obrębie
jednego systemu plików jest atomowy. Obserwacja stanu pośredniego wymagałaby czytelnika działającego
równolegle z zapisem, czego test deterministyczny nie zorganizuje.

### Znalezisko z próby K

Zepsute wiązanie procesu z sygnałem przerwania zostawiło po próbie osierocony proces
(`node -e setInterval(...)`, rodzic `1`). Został usunięty po dokładnej linii poleceń, a stand-in
utwardzono: proces kończy się teraz sam po pięciu minutach, więc zepsuta wersja wiązania nie zostawia
niczego na stałe.

## Naturalne próby (oblane przebiegi przed naprawą, na tym samym kodzie)

- **L11.18** — `e2e/run-continuity.spec.ts` oblał na markerze odpowiedzi, zanim powstało odświeżenie
  wiadomości po zakończeniu przebiegu, do którego klient tylko dołączył.
- **L11.24** — `e2e/sandbox-files.spec.ts` oblał na `artifact-preview`, zanim `files_publish_version`
  trafiło do `ARTIFACT_PRODUCING_TOOLS`.
- **L11.22** — ten sam spec oblał na „typ komorki pusta nie zostal odczytany”, zanim skrypt zaczął
  czytać pustą komórkę jawnie (iteracja po wierszach nie obejmuje końca wiersza).

## Pomiar Stop liczony w procesach

`pomiary-stop-procesy.json`: potomkowie procesu serwera **przed 0, w trakcie 1, po 0**, oraz trzy
rozdzielone momenty (potwierdzenie `POST /cancel`, stan końcowy w karcie, zniknięcie procesu i
katalogu roboczego). Milisekundy zależą od maszyny; powtarzalne jest to, co asertuje regresja:
kolejność momentów, ich rozdzielenie i liczby procesów.

**Czego ten pomiar nie pokazuje:** proces potomny jest prawdziwym procesem systemowym związanym z
sygnałem przerwania uruchomienia, ale stoi w miejscu procesu Claude Agent SDK na granicy adaptera.
Bez grantu tur modelu nie wykazano, że Stop kończy proces potomny samego SDK (L11.7 pozostaje otwarte).
