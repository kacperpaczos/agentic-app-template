# Brief: ETAP 2 / Subagent B — domknięcie dziur izolacji (FINALNY)

Pracujesz WYŁĄCZNIE w wyznaczonym worktree (ścieżka w dispatchu; gałąź `domkniecie/etap2-izolacja`).
Audyt wejściowy (przeczytaj w całości — to Twoja lista zadań z dowodami plik:linia):
`docs/versions/v0.4/archive/domkniecie-2026-09/etap2-a-audyt.md`

## Zakres (dziury 1–4 z audytu obowiązkowo, 5–6 do zrobienia jeśli trywialne, inaczej odnotuj)

**ZASADA NADRZĘDNA (ruling orkiestratora):** nie zmieniasz zachowania `pnpm start` aplikacji bez
etykiety — właściciel ma prawo uruchamiać swoją aplikację na swoich danych (test
`tests/isolation.test.ts:215-223` potwierdza to zachowanie celowo). Wszystkie naprawy dotyczą
KONTEKSTÓW TESTOWYCH/AUDYTOWYCH: skrypty (`dev-server.sh`, `audit-server.sh`, `closure-server.sh`,
`acceptance-target.mjs`, `run-agent.mjs`), harness e2e i testy.

1. **Dziura 1 (skryptowa warstwa żywego katalogu):** `dev-server.sh`, `audit-server.sh`,
   `closure-server.sh` — przed startem: odmowa, gdy `APP_DATA_DIR` istnieje i zawiera wskaźnik
   żywych danych (`session.secret` — wzorzec `scripts/lib/state-tools.mjs:470-477`), chyba że
   instancja ma etykietę testową i katalog z prefiksem testowym. Komunikat odmowy podaje, co
   wykryto, bez drukowania treści plików.
2. **Dziura 2 (fingerprint poświadczeń w acceptance):** w `scripts/lib/acceptance-target.mjs`
   (`requireAcceptanceInstance`) zapisz odcisk `.credentials.json` (wzorzec:
   `e2e/credential-guard.ts:54-82`, read-only hash), a skrypty korzystające
   (`acceptance-agent.mjs`, `run-agent.mjs`) porównują na końcu i kończą się błędem przy zmianie.
3. **Dziura 3 (dev-server.sh fałszywe „started"):** sonda portu PRZED startem procesu (wzorzec
   `port-probe.ts:44-58`); po starcie weryfikacja, że odpowiada własny pid z pidfile, nie cudza
   instancja.
4. **Dziura 4 (RUN_ID + katalog testowy w acceptance):** sprawdzanie `APP_INSTANCE_RUN_ID`
   (analogia `e2e/support/isolation.ts:305-313`) i wymóg, by katalog danych instancji acceptance
   był katalogiem testowym (`.e2e*`/tmp), odmowa przed pierwszym żądaniem zapisującym.
5. **Dziura 5 (porządki):** `e2e/global-teardown.ts` usuwa katalogi instancji testowych po
   pomyślnym `checkCredentialFingerprint`; przy niezgodności NIE usuwa (dowód naruszenia).
6. **Dziura 6:** `assertDirectoryFree` — `null` z `directoryInUse` traktuj jako odmowę z jawnym
   komunikatem (tylko harness testowy).

## Testy (każda naprawa: test pozytywny + negatywny, styl repo)

- Skrypty: odmowa na żywym katalogu (fixture z fałszywym `session.secret` w tmp), przepust na
  katalogu testowym; dev-server: fałszywie zajęty port → brak „started".
- Fingerprint: zmiana odcisku w trakcie → błąd końcowy; brak pliku poświadczeń w środowisku CI-like
  → zachowanie jawne (nie crash bez komunikatu).
- RUN_ID/katalog: brak RUN_ID → odmowa przed zapisem; właściwy RUN_ID + katalog testowy → przejdzie.
- Regresja istniejących strażników nie może się cofnąć (pełny `pnpm verify` + `pnpm test:e2e`
  na końcu pakietu).

## Zakazy

- Nie dotykaj `packages/platform-server/src/config.ts` (warstwa serwerowa bez zmian).
- Nie dotykaj danych użytkownika; fixture'y żywego katalogu TYLKO w tmp z FAŁSZYWYM sekretem
  (nigdy nie czytaj prawdziwego poświadczenia poza policzeniem hashu — bez zapisu treści gdziekolwiek).
- Zero nowych zależności; lockfile nietknięty; `docs/evidence/**` nietknięte.
- FEEDBACK.md: wpis dziennika (kolejny numer T) po ukończeniu.

## Procedura

1. `pnpm install --frozen-lockfile`; baseline `pnpm verify` = 0 (inaczej STOP, BLOCKED + wyjście).
2. Naprawy punkt po punkcie, małe commity po polsku.
3. `pnpm verify` = 0 + `pnpm test:e2e` (pełny, bez modelu) = zielony.
4. Raport: `docs/versions/v0.4/archive/domkniecie-2026-09/etap2-b-report.md`
   (co i dlaczego, testy z wyjściami, decyzje, commity). Zwrotnie TYLKO: status, commity,
   podsumowanie testów, obawy.
