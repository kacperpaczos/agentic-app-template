# Brief: Pakiet GLM-provider (jawny tryb, fail-closed) — FINALNY

Pracujesz WYŁĄCZNIE w worktree `worktree z16-glm`
(gałąź `domkniecie/z16-glm-provider`, start = bieżący HEAD integracji). Specyfikacja wykonawcza:
`zewnętrzny prompt właściciela PROMPT-CLAUDE-CODE-GLM.md` (przeczytaj
w całości). Inwentaryzacja powierzchni (plik:linia, ryzyka): `.sdd-zlecenie/glm-inwentaryzacja.md`.

## Decyzja właściciela (nadrzędna wobec dawnego „wyłącznie subskrypcja")

Claude Code / Claude Agent SDK zostaje harnesssem; provider modelu = GLM/Z.AI przez kompatybilny
endpoint Anthropic, w JAWNYM trybie. Prawdziwa subskrypcja Claude i OAuth Anthropic: nieużywane
i nieczytane. Port 8791 i dane użytkownika: nietykalne. Token Z.AI NIGDY nie trafia do kodu,
testów, logów, dowodów ani commitów — operátor podaje go env procesu serwera.

## Kształt trybu (wykonuj)

1. `APP_MODEL_PROVIDER` = `subscription` (domyślnie, zachowanie dziś dokładnie zachowane) | `glm`.
   Inna wartość → odmowa startu (fail-closed). W trybie `glm` WYMAGANE: `ANTHROPIC_BASE_URL`,
   `ANTHROPIC_AUTH_TOKEN`, `APP_MODEL`, `CLAUDE_CONFIG_DIR` — brak czegokolwiek = odmowa startu
   z komunikatem wymieniającym braki. `CLAUDE_CONFIG_DIR` w trybie glm NIE MOŻE wskazywać na
   domyślny `~/.claude` (resolve + porównanie z homedir; odmowa, jeśli wskazuje) — to izolacja
   od OAuth użytkownika; operator wskazuje pusty, izolowany katalog.
2. `subscriptionOnlyEnv` → provider-aware (podpis z parametrem trybu/konfigu): subscription =
   zachowanie bez zmian; glm = dodatkowo PRZEPUSZCZA `ANTHROPIC_BASE_URL` i `ANTHROPIC_AUTH_TOKEN`
   (MODEL idzie przez sdkOptions.model z configu — `ANTHROPIC_MODEL` zostaje skrubowany zawsze).
   BEZWARUNKOWO skrubowane w obu trybach: `ANTHROPIC_API_KEY`, `ANTHROPIC_BEDROCK_BASE_URL`,
   `ANTHROPIC_VERTEX_BASE_URL`, `AWS_BEARER_TOKEN_BEDROCK`, `CLAUDE_CODE_USE_BEDROCK/VERTEX`,
   `CLAUDE_CODE_*` (poza CLAUDE_CONFIG_DIR), HARNESS_EXTRA. Diag `scrubbedEnvKeys` spójnie.
3. Kontrakt (`platform-contracts/src/agent.ts`): `authMethodSchema` += `'glm'`;
   `apiKeyPolicy`: z.literal('refused') → enum `['refused','glm_explicit']`; `authIsUsable`/
   `authIsConfirmed`: gałąź dla `method==='glm'` (credential.present NIE wymagane; stan sesji
   `api_key` jest w GLM oczekiwany, nie dyskwalifikuje; nadal odmowa przy access revoked/refresh_refused).
   Zachowaj zasadę „żadne pole nie niesie wartości tokena".
4. `probeAuth` w glm: NIE czyta pliku poświadczeń w ogóle (bez stat, bez open) — credential
   raportowany jako nieistotny dla tego trybu; `apiKeyPolicy: 'glm_explicit'`; w subscription —
   bez zmian.
5. UI: `AppShell.tsx` etykieta dla glm (np. „GLM/Z.AI — dostęp niesprawdzony" + istniejące pole
   model pokaże nazwę z /api/status); `SettingsPage.tsx` mapa metod (glm → czytelna etykieta),
   wiersz polityki per provider (bez kłamstwa „odrzucany"). `e2e/app.spec.ts:64-77` — asercje
   etykiet warunkowe per tryb (domyślny przebieg = subscription, bez zmian).
6. Diag/logi: `main.ts` + `diag-agent.ts` provider-aware (provider, model, endpoint — tylko ORIGIN
   URL-a, nigdy pełny URL z tokenem w query, nigdy wartość tokena); diag w glm wypisuje
   „subskrypcja Claude: nieużywana (tryb GLM)". `probe-refresh-refused.ts` w glm: pomija próbę
   z zapisanym powodem (czytanie prawdziwego pliku poświadczeń jest sprzeczne z trybem);
   `probe-sdk-session.ts`: wariant oczekiwania uzależniony od trybu (token nigdy do rekordu).
7. Dowody: `model-turns.ts` (writeEvidence :233, writeZ11Evidence :402) — `zrodlo` i pole `model`
   z configu providera (glm: zrodlo „model GLM/Z.AI przez kompatybilny endpoint Anthropic;
   Claude Agent SDK jako harness; subskrypcja Claude nieużywana"; model = APP_MODEL — domyka lukę
   `model: null`); rejestry i komunikaty budżetowe: „tury GLM". NOWY rejestr `.e2e-model-turns/glm.json`
   (schemat jak z11; budżet 25; źródło: „grant koordynatora dla prób GLM"). Z11-register nietknięty.
8. Testy (każda zmiana z kontrolą negatywną):
   - konfiguracja: fail-closed (nieznany provider; glm bez BASE_URL/TOKEN/MODEL/CLAUDE_CONFIG_DIR;
     CLAUDE_CONFIG_DIR=~/.claude odrzucony); przepust env dziecka w glm (BASE_URL/TOKEN obecne,
     API_KEY nieobecne) i brak przepustu w subscription (obecne testy podzielone, nie skasowane);
   - probeAuth glm: plik poświadczeń NIE czytany (atrapa-fs lub sentinel: odczyt = fail);
   - `/api/status` w glm: method 'glm', policy 'glm_explicit', model = APP_MODEL;
   - kanarki sekretów: w glm asercja „token NIE w logach/statusie/dowodach, ALE w env dziecka"
     (tests/diagnostics.test.ts:519-527 — wersja warunkowa); `measurements.spec.ts:186` —
     scenariusz z kanarkiem w AUTH_TOKEN tylko w trybie subscription (guard: skip+powód w glm);
   - `scripted-server.ts` SDK_SESSION: dodaj odpowiedź 'glm' (sessionProbe stand-in), test
     auth-limits z tą odpowiedzią;
   - sandbox/permissions: izolowany CLAUDE_CONFIG_DIR w env SERWERA → protectedDirs/sandbox
     strzegą IZOLEOWANEGO katalogu (rozszerz tests/credential-guard.test.ts:256-275);
   - dowody: koperta glm zawiera provider/model i przechodzi evidence-provenance bez zmian słownika
     rodzajów („rzeczywisty model" zostaje; GLM opisuje zrodlo/model).
9. Macierz — kategoria „informacyjne / poza bramką": `acceptance-matrix.mjs` STATUS += `informacyjne`
   (etykieta „informacyjne / poza bramką odbioru"), NIE liczone do OPEN (nie blokują zamknięcia
   warstwy), osobny wiersz w podsumowaniu; w `assessment.json` przełącz statusy: L8.10, L8.11,
   L5.8, L12.10 → `informacyjne` (gap zostaje jako uzasadnienie, dopisek „klasyfikacja
   właściciela 2026-09-20: proceduralny/niewywoływalny — poza bramką"); L11.11 — opis zrodzielony:
   ramię plikowe/sekretów pozostaje otwarte (funkcja bezpieczeństwa), ramię poświadczeń =
   informacyjne (niewywoływalne bez wylogowania właściciela) — zrealizuj przez dopisek w gap,
   bez rozdzielania ID. `pnpm acceptance:render` + bramki muszą przejść (ACCEPTANCE/BACKLOG
   regenerowane). Zero zmian wymagań w ARCHITECTURE.md.
10. Dokumentacja: AGENTS.md — decyzja właściciela 2026-09-20 (harness Claude Code, provider GLM;
    subskrypcja nieużywana; zero OAuth-read w glm; reguła fail-closed), README sekcja auth,
    FEEDBACK.md wpis (kolejny numer T) z jawnym zapisem odwrotu od „wyłącznie subskrypcja" decyzją
    zamawiającego.

## Zakazy

- Zero wartości tokena w plikach/commitach/logach/dowodach (testy używają atrap typu FAKE).
- Nie ruszaj: portu 8791, danych użytkownika, z11-rejestru tur, istniejących dowodów (tylko NOWE
  pola/wpisy), wymagań ARCHITECTURE.md, izolacji `settingSources: []`, scrubów API_KEY/Bedrock/Vertex.
- Nie uruchamiaj prób modelowych (T15/T16/T17) — to następuje PO recenzji, osobnym rozkazem.
- Lockfile bez zmian; `pnpm verify` = 0 przed zgłoszeniem; pełne `pnpm test:e2e` = zielone.

## Procedura

1. `pnpm install --frozen-lockfile`; baseline verify=0.
2. Implementacja etapami: (a) konfiguracja+kontrakt+auth+runtime+diag/main, (b) UI+testy
   warunkowe+nowe negatywy, (c) dowody+rejestr GLM, (d) macierz „informacyjne"+assessment.json,
   (e) dokumentacja. Commity po polsku, opisowe (osobny commit przełączenia providera).
3. `pnpm verify`=0, `pnpm test:e2e`=0 (subscription-mode domyślnie; nowy test glm-konfiguracji
   w vitest).
4. Raport: `docs/versions/v0.4/archive/domkniecie-2026-09/glm-b-report.md`
   (zmiany per plik, jak weryfikowano fail-closed, jak chroniony token, wyniki bramek, commity).
Zwrotnie TYLKO: status, commity, podsumowanie testów, obawy.
