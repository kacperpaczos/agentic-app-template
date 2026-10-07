# ETAP 2/A — audyt izolacji testów (READ-ONLY)
# Zapisany przez orkiestratora z raportu subagenta (agent był read-only). HEAD weryfikacji: 65684de.

## Tabela checklisty

| # | Punkt | Status | Dowód (plik:linia) | Dziura | Ryzyko |
|---|---|---|---|---|---|
| 1 | Testy nie celują domyślnie w 8791 | **OK** | Strażnicy: `e2e/support/isolation.ts:62` (DEFAULT_APP_PORT, odrzucany w assertTestPort :79-83), `scripts/lib/acceptance-target.mjs:33,91-98` (APP_BASE=8791 → błąd). Domyślne: Playwright 8799 (playwright.config.ts:26), dev 8790 (dev-proxy.ts:39, apps/server/package.json:7), acceptance 8790 (acceptance-target.mjs:44). Pozostałe literały 8791: config.ts:144 (domyślny port aplikacji; instancja testowa na tym porcie odrzucana config.ts:86-91), config.ts:146 (allowedOrigins), dev-server.sh:24 (odczyt własnego health), komentarze; testy negatywne tests/isolation.test.ts:72,123,150,161,204,219, tests/acceptance-target.test.ts:175,438-447, tests/dev-proxy.test.ts:74,80. W e2e/*.spec.ts — 0 wystąpień | dev-server.sh startuje bez etykiety na domyślnym 8791 i bez sprawdzenia portu PRZED startem; przy zajętych 8791 curl trafi w cudzą instancję → skrypt zgłosi „started" i zapisze pidfile martwego procesu (dev-server.sh:9-27) | Niskie (mylenie operatora; zapis i tak szedłby w ROOT/data) |
| 2 | Jawny APP_BASE_URL/APP_BASE | **Częściowe** | Nie wymagany — bezpieczny domyśl + walidacja nadpisania: isolation.ts:214-218 + assertTestBaseUrl :156-177 (loopback + zgodność portu), acceptance-target.mjs:74-100 (8791 i poza-loopback odrzucone), dev-proxy.ts:63-83 (8791, 8792-8799 odrzucone) | Brak wymogu jawności; domyśl 8790/8799 bezpieczny — nie luka funkcjonalna | Minimalne |
| 3 | Etykieta na /api/health przed pierwszym żądaniem | **OK** | Echo etykiety: http/app.ts:340-348. Proxy: vite.config.ts:27-44 (502 zamiast forwardu), dev-proxy.ts:93-142. E2e współdzielona: global-setup.ts:25 + fixtures.ts:24-38; scenariuszowe: scripted.ts:154-162 (TEST_RUN_ID). Acceptance: acceptance-agent.mjs:30-35, run-agent.mjs:31-40; diag-frontend.mjs:23, probe-chat-composer.mjs:30. Anty-redirect: isolation.ts:259-262, acceptance-target.mjs:131-133 | Wszystkie ścieżki zapisujące pokryte; audit-server.sh/closure-server.sh bez etykiety, ale rodzicem jedynego żądania (własny health) — tests/acceptance-target.test.ts:367-373,392-399 | Minimalne |
| 4 | PID i katalog danych | **Częściowe** | Testy zabijają wyłącznie własne dziecko po pidzie: scripted.ts:87-89,177-197; odmowa zamiast kill: port-probe.ts:19-22,106-115; stop po pidfile: dev-server.sh:29-38, audit-server.sh:8,31-33. Katalog testowy wymuszony: isolation.ts:110-153, config.ts:82-134 przed mkdirSync (:158-163) | Brak związania „pid ↔ otwarty katalog danych" poza directoryInUse przez /proc (port-probe.ts:74-98); assertDirectoryFree fail-open bez /proc (port-probe.ts:124-125) | Niskie-średnie |
| 5 | realpath i dowiązania | **OK** | real-path.ts:40-42,88-189 (fail-closed przy „.." po nieistniejącym członie :144-157, limit dowiązań :158-161, ENOTDIR :182-185), isWithin :192-194, isSymlink :206-212; użycia: isolation.ts:2,114-151, config.ts:3,101-102, agent/permissions.ts, util/managed-fs.ts (wykaz real-path.ts:17-26), kopia .mjs state-tools.mjs:275,319 | Piąta równoległa kopia w state-tools.mjs — utrzymywana testem równoważności (isolation-paths.test.ts:319,411) | Minimalne |
| 5b | Testy zdolności realpath | **OK** | isolation-paths.test.ts:55-136, :355-487, :242-308 (UnresolvablePathError → sandbox_denied) | — | — |
| 6 | Blokada katalogu danych użytkownika | **Częściowe** | Instancja oznaczona: odrzucana poza repo / bez prefiksu .e2e / na data/ / na dowiązaniu — config.ts:104-123, isolation.ts:114-151; testy isolation.test.ts:203-236, isolation-paths.test.ts:140-191. Skrypty stanu: assertAwayFromLiveData rozpoznaje żywy katalog po session.secret — state-tools.mjs:449-499; marker własności :528-560. Fingerprint poświadczeń: setup-credential-guard.ts:47-57, e2e/credential-guard.ts:35-82, global-setup.ts:32, global-teardown.ts:16-19 | (a) Straż nie działa dla instancji BEZ etykiety: config.ts:83 natychmiast wraca, gdy brak agenticapp-test — pnpm start/dev-server.sh/audit-server.sh przyjmą APP_DATA_DIR na prawdziwe dane (celowo potwierdza tests/isolation.test.ts:215-223); (b) żadna warstwa nie nazywa ~/.local/share ani ~/Documents/AgenticApp; (c) fingerprint poświadczeń nie podpięty w acceptance/run-agent/audit | **Średnie** (najwyższe) |
| 7 | Tworzenie/usuwanie instancji testowych | **Częściowe** | Każdy spec własny .e2e-* katalog (38 miejsc), porty 8792-8799 (isolation.ts:59,84-89), workers: 1 (playwright.config.ts:34), reuseExistingServer: false (:81). Przygotowanie: assertPortFree+assertDirectoryFree przed rmSync — boot-server.ts:37-40, scripted.ts:102-115. Test negatywny „8791 → odmowa przed zapisem": ISTNIEJE — acceptance-target.test.ts:484-498 (exit 3, seen===['GET /api/health'], zero POST; kontrola przeciwna :500-517) + isolation.test.ts:144-164 | Porządki NIEpewne: global-teardown.ts:16-19 nie kasuje katalogów — w repo ~30 katalogów .e2e-* (gitignorowane). Osierocone procesy mitygowane assertPortFree (isolation-orphan.test.ts — L1.9) | Niskie |
| 8 | Dowody z SHA i wersjami | **OK** | Koperta egzekwowana: evidence-provenance.test.ts:80-99 (commit 7-40 hex, brudneDrzewo, srodowisko.node, pakiety, wersja CLI :121-131, brak HOME :137-139), rejestr przed-kopertowy :187 | Brak (stare dowody jawnie oznaczone) | — |
| 9 | Bonus: acceptance/run-agent vs e2e | **Częściowe** | Ta sama bramka: acceptance-target.mjs:57,112-155,164-169 używana przez run-agent.mjs:31-40, acceptance-agent.mjs:30-35; spójna z e2e (isolation.ts:248-324) i dev (dev-proxy.ts:93-110); skan klas: acceptance-target.test.ts:334-410 | Acceptance bez odpowiednika RUN_ID (e2e: isolation.ts:305-313) i bez wymogu katalogu testowego; audit-server.sh:7-15/closure-server.sh:15 startują instancję bez etykiety i bez kontroli prefiksu katalogu | Niskie-średnie |

## Dziury uszeregowane po ryzyku

1. **Średnie** — instancje bez etykiety omijają straż katalogu danych (config.ts:83). Audytor proponował
   naprawę w loadConfig; ORKIESTRATOR RULUJE: NIE w loadConfig (zablokowałoby legalny start aplikacji
   użytkownika na jego danych — zachowanie test isolation.test.ts:215-223 jest zamierzone), lecz na
   warstwie skryptów testowych/audytowych: dev-server.sh, audit-server.sh, closure-server.sh — odmowa,
   gdy APP_DATA_DIR zawiera session.secret (wzorzec state-tools.mjs:470-477) lub nie ma prefiksu testowego.
2. **Średnie** — brak odcisku poświadczeń w acceptance/run-agent/audit. Naprawa: fingerprint .credentials.json
   w requireAcceptanceInstance (acceptance-target.mjs:164-169) + porównanie na końcu, analogia e2e/credential-guard.ts:54-82.
3. **Niskie-średnie** — dev-server.sh raportuje sukces przy cudzym 8791: sonda portu przed setsid
   (wzorzec port-probe.ts:44-58) + weryfikacja własnego pidfile.
4. **Niskie-średnie** — acceptance bez RUN_ID i bez wymogu katalogu testowego: sprawdzanie APP_INSTANCE_RUN_ID
   (analogia isolation.ts:305-313) + wymóg .e2e*/tymczasowego katalogu danych instancji.
5. **Niskie** — porządki: global-teardown.ts:16-19 nie usuwa katalogów .e2e-* — usuwanie po pomyślnym
   checkCredentialFingerprint, pozostawienie przy niezgodności (dowód naruszenia).
6. **Niskie** — assertDirectoryFree fail-open bez /proc (port-probe.ts:124-125) — traktować null jako odmowę
   w harnessie, z jawnym komunikatem.

Wniosek audytora: oś strażników kompletna tam, gdzie historie awarii je stworzyły (konfiguracja, serwer,
tożsamość odpowiedzi, realpath, bramka skryptów, odcisk poświadczeń). Nieuwzględniona klasa: proces BEZ
etykiety testowej — dokładnie ten, który na tej maszynie jest aplikacją użytkownika.
