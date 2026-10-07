# Raport: Pakiet GLM-provider (jawny tryb, fail-closed) — Subagent B

Data: 2026-09-20 · Worktree: `worktree z16-glm` ·
Gałąź: `domkniecie/z16-glm-provider` · Start: `2d59906` · Koniec: `eb6a0b8` (8 commitów)

## Status: DONE_WITH_CONCERNS

Zrealizowano wszystkie etapy (a)–(e) briefu. Bramki: `pnpm verify` = 0 (72 pliki, **1158 testów**),
`pnpm test:e2e` = 0 (**228 testów**), `check:acceptance`/`check:matrix`/`check:closure` = 0.
Próby modelowe (T15/T16/T17, spece BL-01/02/03) **nie były uruchamiane** — zgodnie z briefem
następują po recenzji, osobnym rozkazem. Obawy: na końcu (2 pozycje, żadna nie blokuje recenzji).

## Commity (kolejność etapów)

| Hash | Tytuł |
|---|---|
| `2f8d3a6` | Tryb APP_MODEL_PROVIDER=glm: konfiguracja fail-closed, kontrakt auth i polityka srodowiska bez odczytu poswiadczen (etap a) |
| `26f6751` | UI, diagnostyka i e2e provider-aware: etykiety trybu GLM i nowe negatywy (etap b) |
| `af8ca1a` | Dowody i rejestr tur GLM: koperta provider-aware, sufit 25, rejestry subskrypcji nietkniete (etap c) |
| `19626b0` | Status „informacyjne / poza bramka odbioru" w macierzy; klasyfikacja wlasciciela 2026-09-20 (etap d) |
| `50f9b9d` | Decyzja wlasciciela 2026-09-20 w dokumentacji: harness Claude Code, provider GLM (etap e) |
| `af1e7b9` | Typ straznika macierzy zna pole openCriteria (poprawka typu w tescie) |
| `eb6a0b8` | Statyczna kontrola polaczenia preflight czyta sufit AKTYWNEGO rejestru (ACTIVE_BUDGET) |

Lockfile i `package.json`: **bez zmian** (`pnpm install --frozen-lockfile`). `docs/ARCHITECTURE.md`:
**bez zmian** (wymagania nietknięte). Port 8791 i dane użytkownika: **nietykalne** (brak jakichkolwiek
zmian w konfiguracji portów/danych; testy wyłącznie na portach 8792–8799 i katalogach `.e2e*`/tmp).

## Zmiany per plik

### Etap (a) — konfiguracja, kontrakt, auth, runtime, diag/main

- `packages/platform-server/src/config.ts` — `ModelProvider = 'subscription' | 'glm'`;
  `APP_MODEL_PROVIDER` (domyślnie `subscription`); **nieznana wartość = rzut przed czymkolwiek**
  (fail-closed, bez mkdir i bez otwarcia bazy); w glm wymagane `APP_MODEL`, `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CONFIG_DIR` — komunikat wymienia **wszystkie** braki naraz;
  `CLAUDE_CONFIG_DIR` wskazujące domyślny `~/.claude` odrzucone leksykalnie **i po `realResolve`**
  (dowiązanie też); `ANTHROPIC_BASE_URL` parsowany na URL, w konfiguracji zostaje wyłącznie
  `modelEndpointOrigin` (ORIGIN — pełny URL z query może nieść poświadczenie); **żadna wartość
  tokena nie trafia do `PlatformConfig`**.
- `packages/platform-contracts/src/agent.ts` — `authMethodSchema` += `'glm'`;
  `apiKeyPolicy`: z.literal('refused') → `z.enum(['refused','glm_explicit'])`;
  `authIsUsable`: gałąź glm (credential.present niewymagane; `sdkSession.state === 'api_key'`
  **oczekiwane**, nie dyskwalifikuje; nadal odmowa przy `revoked`/`refresh_refused`);
  `authIsConfirmed` bez zmian (korzysta z `authIsUsable`).
- `packages/platform-server/src/agent/auth.ts` — `probeAuth(env, now)` w glm: **nie czyta pliku
  poświadczeń w ogóle** (bez stat, bez open), credential raportowany jako nieistotny
  (kształt `absent`), `apiKeyPolicy: 'glm_explicit'`; ścieżka subscription bez zmian.
  `subscriptionOnlyEnv(env, provider)` i `scrubbedEnvKeys(env, provider)`: glm przepuszcza
  **wyłącznie** `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`; `ANTHROPIC_API_KEY`,
  `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`, `AWS_BEARER_TOKEN_BEDROCK`,
  `CLAUDE_CODE_USE_BEDROCK/VERTEX`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_*` (poza `CLAUDE_CONFIG_DIR`)
  i `HARNESS_EXTRA` — skrubowane **bezwarunkowo w obu trybach** (słownik `PROVIDER_OVERRIDES`
  nietknięty; glm to jawna przepustowa lista 2 zmiennych, nie „mniejszy scrub").
- `packages/platform-server/src/agent/runtime.ts` — konstruktor przyjmuje `env` procesu;
  `sdkOptions.env = subscriptionOnlyEnv(this.#env, config.modelProvider)`; `sdkOptions.model`
  z configu (MODEL zawsze z configu, `ANTHROPIC_MODEL` skrubowany).
- `packages/platform-server/src/agent/session-probe.ts` — `ProbeOptions.provider` (sonda opisuje
  tę samą politykę co przebieg).
- `packages/platform-server/src/http/app.ts` + `index.ts` — platforma przekazuje `env` jawnie do
  aplikacji i runtime; `/api/status` woła `probeAuth(deps.env)` — status opisuje konfigurację
  tej platformy, nie powłokę wołającą.
- `apps/server/src/main.ts` — log startowy provider-aware: glm → `provider modelu: GLM/Z.AI |
  endpoint: <ORIGIN> | model: <APP_MODEL>` oraz `subskrypcja Claude: nieuzywana (tryb GLM);
  plik poswiadczen OAuth nie jest czytany`; wiersz subskrypcji bez zmian.
- `apps/server/src/cli/diag-agent.ts` — provider-aware wiersze + `env: subscriptionOnlyEnv(
  process.env, config.modelProvider)`; rekord diag zapisuje provider/model/endpoint-ORIGIN.
- `scripts/probe-refresh-refused.ts` — w glm pomina próbę **zanim cokolwiek dotknie pliku
  poświadczeń**, z zapisanym powodem (JSON na stdout, exit 0).
- `scripts/probe-sdk-session.ts` — wariant oczekiwań wg trybu: w glm `srodowiskoAplikacji`
  ma **nie** raportować subskrypcji OAuth (oczekiwany `api_key`/`other`); rekord z providerem
  i endpoint-ORIGIN; wartość tokena nigdy do rekordu.

### Etap (b) — UI, e2e, nowe negatywy

- `packages/platform-ui/src/shell/AppShell.tsx` — etykieta glm: „GLM/Z.AI — dostęp
  niesprawdzony/potwierdzony/odrzucony przez endpoint/limit/błąd połączenia”; prefiks
  `Agent (Claude Code):` (harness i provider nazwane osobno); gałąź „sesja SDK na kluczu API
  — niezgodna z polityką” w glm nie wypala; `data-auth-method` na pasku.
- `packages/platform-ui/src/shell/SettingsPage.tsx` — `METHOD_LABEL` (glm → „GLM/Z.AI (endpoint
  kompatybilny z Anthropic)”); `data-method`/`data-policy`; wiersz Poświadczenie lokalne w glm:
  „nieistotne dla trybu GLM — plik poświadczeń OAuth nie jest czytany”; wiersz Klucz API i Polityka
  per provider (bez kłamstwa „odrzucany”); `ACCESS_REMEDY_GLM` (revoked/refresh_refused → „sprawdź
  ANTHROPIC_AUTH_TOKEN i ANTHROPIC_BASE_URL”, nie „/login”); `sdkSessionLabel/Badge`: api_key w glm
  = „poświadczenie endpointu — oczekiwane w trybie GLM”.
- `e2e/app.spec.ts` — nowy test provider-aware czytający tryb ze strony (`data-method`);
  asercje istniejące (subscription) bez zmian; statyczny „Claude:” poszerzony o wariant glm.
- `e2e/auth-limits.spec.ts` — nowy blok „tryb GLM” (3 testy): instancja scenariuszowa z
  `APP_MODEL_PROVIDER=glm`, endpoint `.invalid` (nieosiągalny), **atrapa** tokena,
  `SDK_SESSION=glm` (stand-in sondy) — asercje: method/policy/model w /api/status i UI, pasek
  glm neutralny przy niesprawdzonym dostępie, sesja endpointu oczekiwana, token i treść pliku
  poświadczeń absens w UI/logu/statusie; plik `.credentials.json` z syntetycznym planem „max”
  napisany **po** starcie serwera — UI nadal mówi „nieistotne”, więc nic nie otworzyło pliku.
- `e2e/measurements.spec.ts` — kanarek w `ANTHROPIC_AUTH_TOKEN` tylko w trybie subskrypcji:
  `test.skip` z powodem, gdy `APP_MODEL_PROVIDER=glm` (skan sekretów dotyczy zmiennych
  skrubowanych; w glm AUTH_TOKEN celowo przechodzi do dziecka).
- `e2e/support/scripted-server.ts` — odpowiedź sesji SDK `'glm'` (`api_key`,
  źródło `ANTHROPIC_AUTH_TOKEN`, plan bez limitów).
- `tests/credential-guard.test.ts` — nowy test: izolowany `CLAUDE_CONFIG_DIR` ze **środowiska
  serwera** jest chroniony przez wszystkie trzy mechanizmy (protectedDirsFor + sandbox
  denyRead/denyWrite + odmowa strażnika narzędzi plikowych, łącznie z `${dir}.json`).
- `tests/diagnostics.test.ts` — ten sam kanarek pod polityką glm obok subskrypcyjnej: token
  **obecny w env dziecka** (jedynego miejsca, gdzie jego miejsce), API_KEY skrubowany,
  `scrubbedEnvKeys` spójne per provider; powierzchnie (logi/baza/status/dowody) czyste w obu.

### Etap (c) — dowody i rejestr GLM

- `e2e/support/model-turns.ts` — `modelProvider/glmMode/turnUnit/providerZrodlo/configuredModel`;
  `writeEvidence` i `writeZ11Evidence`: `zrodlo` provider-aware + pole `model` = APP_MODEL
  (domyka lukę `model: null`); `rodzajWykonania: 'rzeczywisty model'` **bez zmian** (słownik
  rodzajów nietknięty — evidence-provenance przechodzi bez zmian).
- NOWY rejestr `.e2e-model-turns/glm.json` (schemat jak z11): sufit **25**, źródło „grant
  koordynatora dla prób GLM: 25 tur, licznik wlasny”; w glm `readLedger/writeLedger` oraz warianty
  z11 kierują tury do rejestru GLM — **zamknięte rejestry subskrypcyjne nietknięte**
  (`z11-bl03.json` i ledger BL-01/02 nigdy nie są w glm zapisywane ani cytowane).
- Komunikaty budżetowe „tur GLM”/„tur subskrypcji” z jednego źródła (`turnUnit`); preflight i
  strażniki sufitu czytają budżet **z rejestru**, nie ze stałej grantu
  (`e2e/support/bl03-model.ts`, `e2e/bl01-bl02-model.spec.ts`).

### Etap (d) — macierz „informacyjne / poza bramką”

- `scripts/lib/matrix-core.mjs` — `STATUS.informacyjne = 'informacyjne / poza bramką odbioru'`;
  **poza `OPEN`** (nie blokuje zamknięcia warstwy, nie liczy się do otwartych ani do liczby
  otwartej backlogu); wymaga uzasadnienia w polu braku; **zakazuje** pakietu backlogu;
  `ev.openCriteria` jako jedno źródło liczby otwartych (render + `compareBacklogSummary`).
- `scripts/acceptance-matrix.mjs` — nagłówek BACKLOG z `ev.openCriteria` + dopisek o statusie
  informacyjnym.
- `docs/acceptance/assessment.json` — L8.10, L8.11, L5.8, L12.10 → `informacyjne` (proof
  nietknięty, gap = dotychczasowe uzasadnienie + dopisek „KLASYFIKACJA WŁAŚCICIELA 2026-09-20:
  proceduralne/niewywoływalne — poza bramką odbioru”; backlog zdjęty); L11.11 — dopisek w gap:
  ramię poświadczeń niewywoływalne = informacyjne, ramię plików/sekretów pozostaje otwarte jako
  funkcja bezpieczeństwa (bez rozdzielania ID); pakiety puste po przesunięciu (BL-04, BL-12)
  usunięte z backlogu (walidacja „pakiet bez kryteriów”).
- `docs/ACCEPTANCE.md` / `docs/BACKLOG.md` — zregenerowane `pnpm acceptance:render`:
  potwierdzone 187, częściowe 7, niespełnione 2, **informacyjne 4**, warstwy zamknięte **8/12**
  (L2, L3, L4, L5, L8, L9, L10, L12), backlog 4 pakiety, spójność OK.
- `tests/matrix-gates.test.ts` — nowy strażnik 2b: informacyjne poza bramką, wymaga uzasadnienia,
  zakaz backlogu; dryf etykiety nadal obla (compare iteruje po `STATUS`).

### Etap (e) — dokumentacja

- `AGENTS.md` — decyzja właściciela 2026-09-20 zamiast „Claude wyłącznie z subskrypcji”:
  harness = Claude Code/Claude Agent SDK w każdym wariancie; subskrypcja domyślna bez zmian;
  glm jawny, fail-closed, OAuth nieużywane i nieczytane, zero tokena w zapisie.
- `README.md` — sekcja „Tryb GLM (jawny provider modelu)” (komenda startu + zasady), wiersze
  `APP_MODEL_PROVIDER`/`APP_MODEL` w tabeli konfiguracji, wiersz Agent w tabeli stosu, wymaganie
  konta Claude z adnotacją o alternatywie GLM.
- `FEEDBACK.md` — wpis **T11**: jawny zapis odwrotu od „wyłącznie subskrypcja” decyzją
  zamawiającego, kształt trybu, kontrole negatywne, bramki, „czego to NIE dowodzi”.

## Jak weryfikowano fail-closed (kontrole negatywne)

`tests/provider-mode.test.ts` (21 testów, nowy plik):

1. Nieznany `APP_MODEL_PROVIDER` → odmowa startu (komunikat z dozwolonymi wartościami).
2. glm bez żadnej wymaganej zmiennej → odmowa wymieniająca **wszystkie 4 braki**; każdy brak
   wykrywany też osobno (w tym wartość pusta/whitespace).
3. `CLAUDE_CONFIG_DIR=~/.claude` → odmowa; **dowiązanie symboliczne** do `~/.claude` → odmowa po
   rozwiązaniu (`realResolve`).
4. Poprawny glm: `modelProvider='glm'`, model z APP_MODEL, `modelEndpointOrigin` = wyłącznie ORIGIN
   (URL z query → query odrzucone), zero wartości tokena w serializacji configu.
5. Zły URL endpointu → odmowa startu.
6. Env dziecka: subskrypcja — wszystkie zmienne providera znikają (istniejące asercje podzielone,
   nie skasowane); glm — BASE_URL+AUTH_TOKEN obecne, API_KEY/Bedrock/Vertex/MODEL/CLAUDE_CODE_*
   skrubowane, kanarek API_KEY nie przetrwa serializacji; `scrubbedEnvKeys` per provider spójne;
   domyślne wywołanie bez parametru = subskrypcja.
7. **Wartownik braku odczytu pliku** (podwójny): (a) istniejący, *czytelny* plik z tokenami →
   glm raportuje `absent` (gdyby sonda otworzyła, byłby `present/valid`), wartości tokenów nie ma
   w statusie; (b) *katalog* o nazwie `.credentials.json` (otwarcie rzuciłoby EISDIR →
   `unreadable`) → glm raportuje `absent`, a ścieżka subskrypcyjna dla kontrastu `unreadable`.
8. `probeAuth` glm: `method='glm'`, `policy='glm_explicit'`, `apiKeyDetected` przy AUTH_TOKEN,
   zero wartości tokena w statusie.
9. `authIsUsable/Confirmed` w glm: brak pliku nie dyskwalifikuje; sesja `api_key` oczekiwana
   (a w subskrypcji ta sama odpowiedź nadal dyskwalifikuje); revoked/refresh_refused odrzucają
   oba tryby; potwierdzenie wymaga `verified`.
10. `/api/status` w glm (prawdziwa platforma z env glm): method `glm`, policy `glm_explicit`,
    model = APP_MODEL, zero wartości tokena.

Ponadto: `tests/matrix-gates.test.ts` 2b (macierz), rozszerzenia `credential-guard`
(izolowany katalog chroniony przez 3 mechanizmy) i `diagnostics` (polityka glm na kanarku),
e2e `auth-limits` (blok glm na instancji z endpointem `.invalid`) i `app.spec`
(warunkowość per tryb).

## Jak chroniony token

- Token nigdy nie jest wczytywany do konfiguracji ani kontraktu: w `PlatformConfig` zostaje
  wyłącznie ORIGIN endpointu; `ANTHROPIC_AUTH_TOKEN` żyje wyłącznie w env i jest **przepuszczany
  przez** `subscriptionOnlyEnv` bez czytania wartości (przepust pary klucz→wartość).
- Testy używają wyłącznie atrap (`FAKE-GLM-TOKEN-…`, `sk-ant-SYNTETYCZNY` zgodnie z konwencją
  repozytorium); skan diff-a gałęzi po wzorcach tokenów: tylko atrapy.
- Diag/logi: endpoint wyłącznie jako ORIGIN; log startowy i diag wypisują „subskrypcja Claude:
  nieuzywana (tryb GLM)”; smoke-check `pnpm diag` w glm (fałszywy endpoint `.invalid`, atrapa
  tokena, katalog tmp): `[diag] provider modelu: GLM/Z.AI | endpoint: https://glm.endpoint.invalid |
  model: glm-fake-model`, zero wystąpień wartości tokena na wyjściu.
- Prawdziwe `~/.claude/.credentials.json` w glm: nieczytane w ogóle (wartownik w teście jednostkowym;
  e2e glm wskazuje CLAUDE_CONFIG_DIR na tmp; `tests/e2e-credential-guard.test.ts` mierzy nietknięcie
  prawdziwego pliku w całym przebiegu e2e — zielone).
- Rejestry tur: zamknięte granty subskrypcji nietknięte; w glm tury idą do `.e2e-model-turns/glm.json`
  (plik nie powstał — żadna próba modelowa nie była uruchamiana).

## Wyniki bramek (stan końcowy, czyste przebiegi)

| Bramka | Wynik |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0, lockfile bez zmian |
| baseline `pnpm verify` przed zmianami | exit 0 (71 plików / 1135 testów) |
| `pnpm verify` po zmianach | **exit 0** (72 pliki / 1158 testów; check:boundaries, check:acceptance, check:matrix, check:closure, typy ×3, build, testy) |
| `pnpm test:e2e` po zmianach | **exit 0** (228 testów; domyślny tryb subskrypcji; spece modelowe poza przebiegiem) |
| `pnpm acceptance:render` | spójność OK: 187 potwierdzonych / 7 częściowych / 2 niespełnione / 4 informacyjne; warstwy zamknięte 8/12; backlog 4 pakiety |

## Komunikaty diagnostyczne w glm (smoke, bez prawdziwego endpointu)

```
[diag] provider modelu: GLM/Z.AI | endpoint: https://glm.endpoint.invalid | model: glm-fake-model
[diag] subskrypcja Claude: nieuzywana (tryb GLM); poswiadczenie OAuth nie jest czytane
[diag] poswiadczenie endpointu w srodowisku: wykryte | ANTHROPIC_API_KEY, Bedrock, Vertex: usuwane ze srodowiska agenta
[diag] zadeklarowanych narzedzi: 33
```

(Instancja na endpointzie `.invalid` — SDK nie nawiązuje połączenia, co jest oczekiwanym wynikiem
smoke-checku; wartość tokena: 0 wystąpień na wyjściu.)

## Czego to NIE dowodzi (zgodnie ze specyfikacją właściciela)

- **Żadna próba modelowa nie była uruchamiana w trybie GLM** (T15/T16/T17, spece BL-01/02/03) —
  zgodnie z briefem następują po recenzji, osobnym rozkazem. Rejestr GLM i komunikaty budżetowe
  przygotowane, puste.
- Testy GLM nie dowodzą działania subskrypcji Claude; dowody z subskrypcją pozostają dowodami
  subskrypcji. Statusy „informacyjne” niczego nie twierdzą o GLM, a GLM (do czasu prób) nie
  potwierdza żadnego kryterium.
- Rzeczywista odpowiedź `accountInfo()` SDK w trybie GLM (czy `api_key` z źródłem
  `ANTHROPIC_AUTH_TOKEN`?) pozostaje **niezweryfikowanym oczekiwaniem** — stand-in `SDK_SESSION=glm`
  koduje oczekiwanie, nie obserwację; weryfikacja po recenzji: `pnpm probe:sdk-session` w glm
  (0 tur) i próby modelowe.
- „Aplikacja nie wysyła żądań do endpointu Claude OAuth” w glm: pośrednio (env dziecka bez
  poświadczeń OAuth, katalog izolowany, plik nieczytany — więc CLI nie ma czego odświeżać);
  bezpośrednia obserwacja sieci SDK należy do prób modelowych.

## Obawy (2, niew blokujące)

1. **„Nie czytane” vs. SDK w czasie próby:** gwarancja „plik poświadczeń nie jest czytany” dotyczy
   kodu aplikacji (potwierdzone wartownikiem); sam **CLI wbudowany w SDK** w trybie glm może odczytać
   swój `CLAUDE_CONFIG_DIR` (izolowany, wskazany przez operatora) — to pożądane (tam SDK trzyma własną
   konfigurację), ale obserwacja „CLI nic po stronie OAuth nie zrobił z pliku użytkownika” jest
   zabezpieczona konstrukcyjnie izolacją katalogu, a nie osobną próbą. Próba potwierdzająca po
   recenzji.
2. **Rzeczywista odpowiedź sondy sesji w glm nieznana** (jak wyżej) — stand-in `SDK_SESSION=glm`
   oraz oczekiwania `probe-sdk-session.ts` w glm są deklaracją oczekiwania; pierwsze prawdziwe
   uruchomienie sondy (0 tur) powinno być częścią recenzji/prób, zanim etykieta „oczekiwane w trybie
   GLM” zostanie obejrzena na żywej odpowiedzi.

Uwaga środowiskowa (bez działania): w powłoce, w której biegły bramki, istnieje
`ANTHROPIC_BASE_URL` wskazujące na endpoint Z.AI (bez wartości tokena w tym repozytorium);
w trybie subskrypcji zmienna ta jest i pozostaje skrubowana (istniejące testy przechodzą),
a test `diagnostics.test.ts` pisany tak, by nie zakładał jej braku.

## Fix round 1 (F1/F2/F3) + minimalna próba GLM (zmiana zakresu właściciela)

Commit: `6b92fae` — „Recenzja F1-F3: provider do sondy sesji z zadania; odmowa tyldy i drzewa ~/.claude w glm".

- **F1** — `/api/sdk-session` dispatchuje sondę z providerem platformy (`modelProviderFromEnv(deps.env)`); `SessionProbe` przyjmuje `provider?` (stand-iny bez argumentów pozostają zgodne); domyślna sonda to `probeSdkSession({provider})`. Testy: sonda z żądania dostaje `glm` (i `subscription` jako kontrola pozytywna) — 2 nowe testy w `tests/provider-mode.test.ts`.
- **F2** — `CLAUDE_CONFIG_DIR` z członem zaczynającym się od `~` odmawia startu (tylda nierozwijana → dosłowne `~/.claude` utworzyłoby katalog o nazwie „~"). Test negatywny: `~/.claude`, `~/x`, człon `~` w środku ścieżki.
- **F3 (zrobiony razem, tani)** — katalog wewnątrz drzewa `~/.claude` odmówiony (porównanie prefiksu leksykalne i po `realResolve`, łapie dowiązania wchodzące do drzewa). Test: podkatalog `~/.claude/*` i dowiązanie z zewnątrz rozwiązujące się do drzewa; kontrola pozytywna izolowanego katalogu przechodzi.
- F4/F5/F6 — odroczone (zgodnie z decyzją recenzenta).

Recenzja scoped różnicy F1–F3: jedno miejsce wywołania sondy (`http/app.ts`), brak zmian ścieżki subskrypcyjnej, F2/F3 zawężają wyłącznie akceptację konfiguracji glm; brak nowych powierzchni sekretów.

### Wyniki wymaganych komend (po poprawkach)

- `pnpm exec vitest run tests/provider-mode.test.ts tests/auth.test.ts tests/diagnostics.test.ts tests/credential-guard.test.ts tests/isolation.test.ts tests/isolation-paths.test.ts` → **6 plików / 153 testy, 0 faili** (provider-mode: 26).
- `pnpm typecheck` → **0** (trzy programy: src + moduły + e2e).
- `pnpm build` → **0**.
- Poza zakresem minimalnym (nieuruchamiane po poprawkach): pełne `pnpm test:e2e`, T15/T16/T17.

### Minimalna próba GLM (jedna, izolowana — rozkaz właściciela 2026-09-20)

- Uruchomienie: build produkcyjny (`node apps/server/dist/server.js`), **port 8796** (zakres testowy),
  `APP_DATA_DIR=.e2e-glm-proba-<stamp>` (usunięty po próbie), `APP_INSTANCE_LABEL=agenticapp-test`,
  `APP_MODEL_PROVIDER=glm`, `APP_MODEL=glm-5.3-flash[1m]`, **izolowany pusty** `CLAUDE_CONFIG_DIR` (tmp,
  usunięty), `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` dziedziczone ze środowiska operatora
  (wartość tokena nigdzie nie zapisana ani wypisana). Port 8791 i dane użytkownika: nietknięte.
- `/api/health`: `{"ok":true,"instanceLabel":"agenticapp-test"}`; `/api/status`: `auth.method = glm`,
  `apiKeyPolicy = glm_explicit`, `model = glm-5.3-flash[1m]`.
- Jedno polecenie przez `POST /api/agui/run`: „Odpowiedz jednym slowem: dziala." →
  **`RUN_FINISHED`, rzeczywista odpowiedź modelu: „Działa."** (~8 s, 1 tura GLM).
- Zatrzymano wyłącznie własny PID serwera; rejestr `.e2e-model-turns/glm.json` nie był pisany (próba
  poszła poza suite e2e; nie jest dowodem kryterium, jest dowodem działania ścieżki).

### Stan gałęzi (koniec)

`domkniecie/z16-glm-provider` @ `6b92fae` (9 commitów od `2d59906`), drzewo czyste, **bez scalania**
do `domkniecie/integracja` i **bez wypychania**. F4/F5/F6 odroczone; konsolidacja worktree/gałęzi/doków
v0.4 — poza tym zadaniem.
