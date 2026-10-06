# Recenzja bezpieczeństwa: pakiet GLM-provider (recenzent C)

Data: 2026-09-20 · Przedmiot: `2d59906..eb6a0b8` (7 commitów, 34 pliki, +1443/−186) w
worktree `worktree z16-glm` ·
Spec: `zewnętrzny prompt właściciela PROMPT-CLAUDE-CODE-GLM.md` ·
Niezależna recenzja, autor zmian nie brał w niej udziału.

## Werdykty

| Pytanie | Werdykt |
|---|---|
| Zgodność ze specyfikacją PROMPT | **✅ z zastrzeżeniami** (wszystkie pkt spełnione; 2 Important nieodcinające granicy poświadczeń, patrz F1/F2) |
| Jakość (zatwierdzony/odrzucony) | **ZATWIERDZONY** — pod warunkiem zrobienia F1 i F2 przed pierwszą turą modelową (obie poprawki drobne, nie dotykają rdzenia) |
| Findings | **Critical 0 · Important 2 · Minor 4** |
| Próby modelowe na GLM | TAK — dopiero po F1+F2; pierwsze żywe spojrzenie: `pnpm probe:sdk-session` w trybie glm (0 tur), potem T15 (szczegóły na końcu) |

Granica poświadczeń — sedno zlecenia — jest **trzymana**: nie znalazłem żadnej ścieżki, którą
wartość `ANTHROPIC_AUTH_TOKEN` trafia do logów, `/api/status`, dowodów, komunikatów błędów,
konfiguracji, kontraktu czy rejestru tur; skruby API_KEY/Bedrock/Vertex są bezwarunkowe w obu
trybach; `probeAuth` w glm nie dotyka pliku poświadczeń (dowód wartowniczy, nie deklaracja);
rejestry tur subskrypcji są nietknięte; macierz nie domyka warstw fałszywie.

---

## Weryfikacja wg 8 punktów briefu

### 1. Token Z.AI nie wycieka — POTWIERDZONE

- Grep diffu i nowych plików po wzorcach (`sk-ant-*`, `Bearer`, hex-łańcuchy, `ZAHU*`): tylko
  atrapy konwencji repozytorium (`FAKE-GLM-TOKEN-…`, `sk-ant-SYNTETYCZNY`,
  `SYNTETYCZNY-NIE-JEST-TOKENEM`). Zero realnych wartości.
- `PlatformConfig` nie zawiera tokena (config.ts:75 `modelEndpointOrigin` = wyłącznie ORIGIN;
  test `poprawny tryb glm podaje model i wylacznie ORIGIN endpointu` atakuje URL z query i
  asertuje `not.toContain(FAKE_TOKEN)` na całej serializacji configu). Sprawdzone moją próbą:
  `https://user:sekretpass@glm.example.com/path?api_key=xyz` → origin `https://glm.example.com`
  (userinfo i query odpadają).
- Logi startowe (apps/server/src/main.ts:411-431) i diag (apps/server/src/cli/diag-agent.ts:314-335):
  endpoint wyłącznie jako ORIGIN z `config.modelEndpointOrigin`; wiersz „subskrypcja Claude:
  nieuzywana (tryb GLM)"; rekord diag niesie provider/model/endpoint-ORIGIN, komentarz wprost
  „wartość tokena nigdy nie trafia do zapisu".
- `/api/status` (http/app.ts:394-401) woła `probeAuth(deps.env)`; `AuthStatus` to kształty, nie
  wartości (kontrakt platform-contracts/src/agent.ts:306 „None of these fields ever carries a
  token value"); test na prawdziwej platformie asertuje zero tokena w odpowiedzi.
- e2e auth-limits.spec.ts:1107-1161: atrapa tokena w env instancji → asercja nieobecności w UI,
  w logu serwera i na drucie `/api/status`; plus wartownik odwrotny — plik `.credentials.json` z
  syntetycznym planem „max" pisany **po** starcie serwera, UI nadal „nieistotne", czyli nic nie
  otworzyło pliku (auth-limits.spec.ts:1127-1145).
- `subscriptionOnlyEnv` przepuszcza token parą klucz→wartość bez czytania (auth.ts); test
  diagnostics.test.ts:519-537: w glm token obecny WYŁĄCZNIE w env dziecka, API_KEY skrubowany,
  `scrubbedEnvKeys` spójny per provider, powierzchnie diagnostyczne czyste w obu politykach.

### 2. Bezwarunkowe skruby nietknięte — POTWIERDZONE

- `PROVIDER_OVERRIDES` (auth.ts:2002-2012) nietknięty; glm to jawna przepustowa lista **dwóch**
  zmiennych (`GLM_PASSTHROUGH = {ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN}`, auth.ts:2018),
  nie „mniejszy scrub": `PROVIDER_OVERRIDES.has(k) && !(provider==='glm' && GLM_PASSTHROUGH.has(k))`.
- Bezwarunkowo skrubowane w OBU trybach (tests/provider-mode.test.ts:167-190): `ANTHROPIC_API_KEY`,
  `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`, `AWS_BEARER_TOKEN_BEDROCK`,
  `CLAUDE_CODE_USE_BEDROCK/VERTEX`, `ANTHROPIC_MODEL`; `CLAUDE_CODE_*` poza `CLAUDE_CONFIG_DIR`
  w obu trybach; `HARNESS_EXTRA` w obu.
- `runtime.ts` buduje env dziecka z **tego samego env, z którego zbudowano konfigurację**
  (`subscriptionOnlyEnv(this.#env, services.config.modelProvider)`), polityka nie zależy od tego,
  co siedzi w `process.env` w chwili wywołania.
- Stare testy NIE osłabione: `tests/auth.test.ts`, `runtime.test.ts` **w ogóle nie są w diffie** —
  stare asercje zostały nietknięte dosłownie, bo domyślny parametr `subscriptionOnlyEnv(env)`
  = subskrypcja (provider-mode.test.ts:199-203 pilnuje tego jawnie). Lepsze niż dzielenie.

### 3. Fail-closed konfiguracji — POTWIERDZONE z jednym przeciekiem walidacji (F2)

- Walidacja w JEDNYM miejscu, w `loadConfig`, **przed** `mkdirSync` i otwarciem bazy. Moja próba:
  glm bez zmiennych → odmowa, a katalog danych NIE powstaje (`mkdir-check istnieje: false`).
- Nieznany provider: `GLM`, `' glm '` (spacje), `openai` → odmowa (moje próby + testy). Domyślnie
  (brak zmiennej) = subskrypcja. Fail-closed bez cichego fallbacku.
- glm bez czegokolwiek → komunikat wymienia **wszystkie 4** braki naraz (test) + każdy brak
  osobno, w tym wartość whitespace (test).
- `CLAUDE_CONFIG_DIR` = `/home/x/.claude` → odmowa; dowiązanie do `~/.claude` → odmowa po
  `realResolve` (test). **ALE**: dosłowne `~/.claude` (tylda niewyexpandowana) przechodzi — F2.
  Podkatalog wewnątrz `~/.claude` też przechodzi — F3.
- Zły/`userinfo` URL → origin tylko; niepoprawny URL → odmowa (test).
- Obejścia providerem po starcie: nie ma — `process.env.APP_MODEL_PROVIDER` nigdzie nie jest
  mutowany w trakcie życia procesu (grep), `/api/status` czyta `deps.env` z jednego źródła.

### 4. Brak odczytu poświadczeń w glm — POTWIERDZONE

- `probeAuth` (auth.ts:1944-1954): gałąź glm zwraca **przed** jakimkolwiek `credentialFilePath()`
  — brak `stat`, brak `open`; kształt `absent`, polityka `glm_explicit`.
- Wartownik podwójny i atakowo solidny (provider-mode.test.ts:215-251):
  (a) istniejący, **czytelny** plik z tokenami → glm odpowiada `absent` (gdyby cokolwiek
  odczytało — `readFileSync` czy inne API — byłoby `present/valid`, więc stan „absent" jest
  dowodem braku odczytu dowolnym API, nie tylko `readFileSync`);
  (b) **katalog** o nazwie `.credentials.json` → glm `absent`, a ścieżka subskrypcyjna dla
  kontrastu `unreadable` (odczyt rzuciłby EISDIR; kontrast dowodzi, że wykrywacz działa).
- Inne wywołania `credentialFilePath`: `scripts/probe-refresh-refused.ts` w glm wychodzi
  **przed** `fingerprintRealCredential()` (skok exit 0 w linii 71-83, pierwszy odczyt pliku
  dopiero w linii 128 — kolejność poprawna); `scripts/audit-probes.ts` czyta wyłącznie atrapy w
  mkdtemp; e2e `bl03-model-t15.spec.ts` używa samego katalogu (`claudeConfigDir`), nie pliku.
- G21 (CLI przepisuje plik poświadczeń) pozostaje respektowany: żaden test tej gałęzi nie
  dotyka prawdziwego `~/.claude`.

### 5. authIsUsable / authIsConfirmed w glm — POTWIERDZONE

- contracts/agent.ts:1866-1874: glm = `access.state ∉ {revoked, refresh_refused}`; plik
  poświadczeń nie dyskwalifikuje; `sdkSession.state === 'api_key'` **oczekiwane** (test pokazuje
  kontrast: ta sama odpowiedź w subskrypcji dalej dyskwalifikuje).
- `access` jest procesowo-globalne i zasilane wyłącznie realnymi wynikami przebiegów
  (`recordVerification` → `classifyAccessFailure`): w glm błąd 401/„invalid api key" od endpointu
  daje `revoked` → aplikacja NIE pokaże „zdrowy" (pasek: „GLM/Z.AI — dostep odrzucony przez
  endpoint; sprawdz token", AppShell.tsx:2498-2514). `authIsConfirmed` wymaga `verified` —
  „potwierdzony" pojawi się tylko po udanym wywołaniu.
- Kolkucja stanów między trybami niemożliwa: tryb jest ustalony przy starcie, env nie mutate.

### 6. Prawdziwość UI/dowodów — POTWIERDZONE

- Etykiety: AppShell prefiks `Agent (Claude Code):` oddziela harness od providera; gałąź
  „sesja SDK na kluczu API — niezgodna z polityka" w glm nie wypala; `data-auth-method` na pasku.
  SettingsPage: `METHOD_LABEL[glm]`, wiersz poświadczenia „nieistotne dla trybu GLM — plik
  poświadczeń OAuth nie jest czytany" (nie kłamie „brak"), wiersz polityki `glm_explicit` mówi
  wprost co przechodzi i co jest usuwane, `ACCESS_REMEDY_GLM` nie posyła po `/login`.
- Koperta dowodowa: `zrodlo` provider-aware w `writeEvidence` i `writeZ11Evidence`; pole `model`
  = APP_MODEL (domyka lukę `model: null`); `rodzajWykonania: 'rzeczywisty model'` nietknięty
  (słownik repozytorium; GLM opisuje zrodlo/model — evidence-provenance przechodzi bez zmian).
  Dowód glm NIE może być czytany jako dowód subskrypcji — zrodlo nazywa GLM wprost.
- Rejestry: `readLedger`/`readZ11Ledger` w glm kierują do `readGlmLedger`
  (`.e2e-model-turns/glm.json`, sufit 25); `writeLedger`/`writeZ11Ledger` piszą do rejestru GLM;
  sufit czytany z rejestru (`ACTIVE_BUDGET`, `ledger.budzet`), nie ze stałej. Z11 i ledger
  BL-01/02 nietknięte — i plik `.e2e-model-turns/` w ogóle nie powstał (żadnej tury nie było).
- Macierz: `informacyjne` poza `OPEN` (matrix-core.mjs:2819 OPEN = {czesciowe, niespelnione,
  niesprawdzone}); wymaga uzasadnienia; **zakazuje** pakietu backlogu; `openCriteria` liczy tylko
  OPEN. Przeliczyłem `assessment.json` sam: 200 = 187 potwierdzonych + 7 częściowych + 2
  niespełnione + 4 informacyjne; otwarte 9; warstwy zamknięte 8/12 (L2,L3,L4,L5,L8,L9,L10,L12);
  L11.11 pozostał `niespelnione` z backlogiem BL-03, a dopisek w braku otwarcie mówi, że ramię
  plikowe/sekretów **zostaje otwarte jako funkcja bezpieczeństwa** — podział bez rozdzielenia ID,
  zgodnie z zleceniem. Cztery przeniesione kryteria (L8.10, L8.11, L5.8, L12.10) mają pełne
  dotychczasowe uzasadnienia + dopisek klasyfikacji; pakiet bez kryteriów (BL-04, BL-12) zdjęty,
  kryteria nie zniknęły z ACCEPTANCE (własny wiersz statusu w tabelach). Strażnik 2b
  (matrix-gates.test.ts) pilnuje wszystkich trzech własności na fixture'ach.

### 7. Zakazy procesowe — POTWIERDZONE

- Brak nowych przebiegów: `git status docs/evidence .e2e-model-turns` czysty; żaden commit
  2d59906..eb6a0b8 nie dotyka `docs/evidence`; `.e2e-model-turns/glm.json` nie istnieje.
- `pnpm-lock.yaml` i `docs/ARCHITECTURE.md` nieobecne w diffie.
- 8791 w diffie wyłącznie w istniejących domyślnych/komentarzach kontekstowych i w istniejącym
  teście odmowy portu — konfiguracja portu nietknięta. Dane użytkownika nietknięte; testy na
  8796-8799 i w tmp.

### 8. Verify / e2e — POTWIERDZONE

- Uruchomiłem `pnpm verify` sam: **exit 0, 72 pliki / 1158 testów** — dokładnie według twierdzenia
  (check:boundaries, check:acceptance, check:matrix, check:closure, typy, build, testy).
- e2e przyjmuję z raportu (228, zielone) — blok glm e2e czytany w całości: endpoint `.invalid`,
  atrapa tokena, izolowany katalog tmp, `SDK_SESSION=glm` jako stand-in; nic w nim nie może
  dosięgnąć sieci ani poświadczeń. Rapor e2e nie budzi wątpliwości po lekturze diffu testów.

---

## Findings

### Critical (0)

Brak.

### Important (2)

**F1 — sonda sesji SDK w glm opisuje złą ścieżkę (provider nie jest przekazywany).**
`packages/platform-server/src/http/app.ts:382` woła `deps.sessionProbe()` **bez argumentów**, a
`packages/platform-server/src/index.ts:188` binduje gołe `probeSdkSession` — więc w trybie glm
kontrola „Sesja SDK" w Ustawieniach bierze politykę **subskrypcji** (AUTH_TOKEN/BASE_URL
skrubowane, izolowany pusty katalog) i opisuje środowisko, w którym agent nie działa — wbrew
własnemu kontraktowi z session-probe.ts:2168-2175 („the probe must describe the same environment
the agent gets"). Następstwa: myląca diagnoza w UI (spodziewany `api_key` z `ANTHROPIC_AUTH_TOKEN`
nie może się pojawić; pokaże się `unavailable`/`other`), ścieżka produkcyjna niepokryta testem
(e2e przechodzi wyłącznie przez stand-in `SDK_SESSION=glm`), `recordSdkSession` zapisuje tę
mylącą odpowiedź do statusu. BEZ wycieku (sonda skrubuje więcej, nie mniej) i bez skutku
bramkowego (`authIsUsable` w glm ignoruje sdkSession) — dlatego Important, nie Critical.
Naprawa: przekazać provider (z configu) do wywołania sondy w `/api/sdk-session` — 2 linie + test.

**F2 — strażnik `CLAUDE_CONFIG_DIR` przepuszcza dosłowne `~/.claude`.**
`packages/platform-server/src/config.ts:202-217` porównuje `resolve(given)` i `realResolve(given)`
z `resolve(homedir(), '.claude')`; dosłowna tylda nie jest rozwijana nigdzie w tym porównaniu, więc
`CLAUDE_CONFIG_DIR=~/.claude` oznacza dla walidacji `$cwd/~/.claude` i **start jest dopuszczony**
(potwierdziłem próbą na `loadConfig`: „~/.claude literalnie: OK provider=glm"). Gwarancja izolacji
od OAuth użytkownika opiera się wtedy na niezweryfikowanym założeniu, że CLI w dziecku też nie
rozwija tyldy. To dokładnie ta wartość, której odmowy żąda brief (pkt 3). Naprawa: wymagać ścieżki
absolutnej (odmowa dla zaczynającej się od `~`) i dodatkowo porównać po jawnym rozwinięciu tyldy —
2-3 linie + kontrola negatywna.

### Minor (4)

**F3 — dozwolony `CLAUDE_CONFIG_DIR` wewnątrz drzewa `~/.claude`** (config.ts:202-217; potwierdzone
próbą: `[lokalna ścieżka pominięta]` startuje). Plik `.credentials.json` użytkownika leży w
korzeniu katalogu, więc **nie jest czytany**; ale CLI dostaje prawo zapisu wewnątrz katalogu
poświadczeń użytkownika, wbrew duchowi trybu. Proponowane: odmowa dla wszystkiego, co
`isWithin(real, ~/.claude)`.

**F4 — nagłówek sekcji „Uwierzytelnienie Claude" w glm** (`SettingsPage.tsx:149`). Kosmetyka
prawdziwości etykiet: sekcja o uwierzytelnieniu nazywa Claude, gdy metodą jest GLM
(`METHOD_LABEL` niżej jest poprawny). Zmienić nagłówek warunkowo albo uciąć do
„Uwierzytelnienie".

**F5 — nazwa `subscription` dla przebiegu „srodowiskoAplikacji" w glm** (`scripts/probe-sdk-session.ts:105`).
Zmienna/klucz nadal nazywa wynik „subscription" choć w glm opisuje ścieżkę glm; rekord jest
poprawny merytorycznie (warunki + wniosek są provider-aware), myli tylko przy czytaniu kodu.

**F6 — kanarek w `measurements.spec.ts` chroniony dwoma `test.skip` opisanymi ręcznie**
(e2e/measurements.spec.ts:203, 442). Poprawne dziś (oba opisy z `slow` mają skip; instancja z
kanarkiem nie startuje w glm), ale Mechanizm jest dyscypliną, nie barierą: kolejny opis używający
`slow` bez własnego skipu połknie kanarek w AUTH_TOKEN w trybie glm. Do rozważenia: jeden strażnik
na poziomie pliku lub asercja w `beforeAll` instancji.

---

## Zgodność ze specyfikacją PROMPT (pkt po pkt)

| Punkt spec | Ocena | Dowód |
|---|---|---|
| Nienaruszalne rozdzielenie (harness = Claude Code/SDK; GLM providerem; bez własnej pętli/MiniMax/OpenAI; bez OAuth; port 8791 i dane nietykalne) | ✅ | harness nietknięty (runtime.ts zmienia tylko model/env); żadnego nowego wywołania modelu poza SDK; 8791 nietknięte; OAuth nieczytane (pkt 4 wyżej) |
| Konfiguracja dostawcy (BASE_URL, AUTH_TOKEN w env procesu, model zapisany; zero tokena w kodzie/testach/logach/commitach; `subscriptionOnlyEnv` otwarte tylko dla jawnego trybu; fail-closed dla nieznanych) | ✅ z F2 | config.ts (fail-closed, pełna lista braków, ORIGIN), auth.ts (przepust 2 zmiennych), token tylko w env; F2 to przeciek samego strażnika katalogu, nie sekretów |
| Zachowanie funkcjonalne (czat, AG-UI, MCP, zgody, pliki/sandbox, zadania, UI, trwałość) | ✅ (potwierdzone testami) | bramka `pnpm verify` 0 (72/1158) uruchomiona przeze mnie; e2e 228 wg raportu; żadnej ścieżki funkcjonalnej nie tknięto poza `sdkOptions.model/env` |
| Testy i dowody (test konfiguracji dowodzący glm-nie-OAuth; diag bez tokena; T15 + próby na GLM; koperta z providerem; nie oznaczać GLM jako Claude; pełne testy w izolacji; negatyw OAuth; nic na 8791) | ✅ częściowo — próby modelowe ŚWIADOMIE po recenzji | testy konfiguracji i wartowniki: provider-mode.test.ts (21), e2e auth-limits glm; diag provider-aware; koperta provider-aware; **T15/T16/T17 nie wykonane** — zgodnie z zleceniem następują po recenzji; izolacja: tmp + 8796-8799 |
| Raport/macierz (rozdzielenie kryteriów GLM/Claude/proceduralnych; nie twierdzić, że GLM dowodzi subskrypcji; zdanie o harnessie wprost) | ✅ | macierz „informacyjne / poza bramką odbioru" + zachowane uzasadnienia + L11.11 otwarte; raport/macierz wprost: „dopóki próby GLM nie pójdą, informacyjne nic nie twierdzi o GLM"; zdanie z PROMPT obecne w FEEDBACK/README/AGENTS |
| Osobny commit przełączenia providera | ✅ | `2f8d3a6` (konfiguracja+polityka), potem etapy b-e osobno |

## Czego ten pakiet NIE dowodzi (zgadzam się z raportem implementatora)

- Żadna tura GLM nie została wydana; rejestr glm pusty; „informacyjne" nie twierdzą nic o GLM.
- Rzeczywista odpowiedź `accountInfo()` w glm jest nadal oczekiwaniem (stand-in `SDK_SESSION=glm`
  koduje oczekiwanie) — pierwsze żywe spojrzenie to `pnpm probe:sdk-session` w glm (0 tur).
- Obserwacja sieciowa „aplikacja nie wysyła żądań do endpointu Claude OAuth" jest konstrukcyjna
  (dziecko bez poświadczeń OAuth + izolowany katalog), nie bezpośrednia; po F1 sonda w glm
  przestanie biec ścieżką subskrypcji, co tą konstrukcyjną gwarancję wzmacnia.

## Czy wolno uruchomić próby modelowe na GLM — i warunki

**TAK, ale dopiero po naprawie F1 i F2** (obie drobne: przekazanie `provider` do sondy w
`/api/sdk-session`; odmowa dla `CLAUDE_CONFIG_DIR` zaczynającej się od `~` + kontrola negatywna),
a pierwszym żywym dotknięciem GLM ma być `pnpm probe:sdk-session` w trybie glm (0 tur) —
potwierdzenie rzeczywistego kształtu sesji — po którym T15 (i ewentualnie T16/T17) idą w ramach
rejestru `.e2e-model-turns/glm.json` z sufit 25, wyłącznie na instancji testowej, nigdy na 8791.

## Podpis procesowy

Recenzent przeczytał pełny diff (348 KB, wszystkie 34 pliki), uruchomił `pnpm verify` (0),
wykonał własne próby negatywne na `loadConfig` (tylda, wielkość liter, spacje, userinfo, mkdir,
katalog wewnątrz ~/.claude) — wyłącznie na atrapach i w /tmp, bez startu serwera, bez sond,
bez jakiegokolwiek wywołania modelu. Repo worktree nietknięte (pliki robocze próby w /tmp).

---

# Re-review fix round 1 (commit `6b92fae`, 6 plików, +163/−13)

Zakres: wyłącznie F1/F2/F3 z recenzji głównej. Przeczytałem cały diff commitu, uruchomiłem
`pnpm vitest run tests/provider-mode.test.ts` (**26/26 zielone**) i powtórzyłem własne próby
adversarialne na `loadConfig` (atrapy w /tmp, bez startu serwera i bez modelu).

## Werdykty

**F1 — ADDRESSED.** `SessionProbe` przyjmuje teraz `provider?` (session-probe.ts:92), endpoint
`/api/sdk-session` dispatchuje `modelProviderFromEnv(deps.env)` z żądania (http/app.ts:261),
a domyślna sonda w `index.ts:294-295` przekazuje go do `probeSdkSession({ provider })`. Test
jednostkowy ścieżki istnieje i jest zrobiony dobrze: stand-in **przechwytuje** to, co endpoint
faktycznie wysłał — glm → `['glm']` i `apiKeySource: 'ANTHROPIC_AUTH_TOKEN'`, subskrypcja →
`['subscription']` (provider-mode.test.ts:322-381). Widok `provider?` (opcjonalny parametr)
jest świadomą decyzją kompatybilności: zero-argumentowe stand-iny e2e nadal pasują typowo.
Dodatkowo `probeAuth` przeszedł na to samo źródło odczytu (`modelProviderFromEnv`, auth.ts:55)
— jedna tolerancyjna funkcja, ścisła odmowa tylko w `loadConfig`; dla started procesu wartość
nieznana nie może wystąpić, więc nie ma rozjazdu między walidacją a dispatchem. Zbieżne z moją
weryfikacją: `modelProviderFromEnv({}) = subscription`, `{'GLM'} = subscription` (tolerancyjnie),
a `loadConfig({'GLM'})` i tak odmawia startu.

**F2 — ADDRESSED.** Każdy człon ścieżki zaczynający się od `~` (separatory `/` i `\`) odmawia
startu z czytelnym komunikatem (config.ts:178-185). Potwierdzone moimi próbami: `~/.claude`,
`~/.claude/`, `~/glm-izolowany`, człon `~` w środku (`/home/u/katalogi/~.claude`) i prefiks
tyldy w nazwie (`/home/u/~xd`) — wszystkie ODMOWA. Nadmiarowa odmowa dla dziwnych nazw z `~`
jest zamierzona i fail-closed; komunikat tłumaczy dlaczego.

**F3 — ADDRESSED.** Odmowa dla katalogu wewnątrz drzewa `~/.claude` działa **dwutorowo**:
leksykalnie po `resolve` ORAZ po `realResolve` (config.ts:195-206, `isWithin` na obu). Symlink
nadal łapany — potwierdzone próbą: dowiązanie położone **poza** katalogiem domowym, wskazujące
w `~/.claude` (i jego korzeń, i podkatalog) → ODMOWA po rozwiązaniu. Kierunek odwrotny
(ścieżka leksykalnie w drzewie, rozwiązująca się na zewnątrz) też daje odmowę — nadmiarowa,
bezpieczna strona. Rodzeństwo (`.claudeX`) i izolowany katalog poza drzewem przechodzą
(kontrola pozytywna także w teście, provider-mode.test.ts:407-410).

## Nowe uszkodzenia w tym diffie

**Critical: 0 · Important: 0.** Zmiany są hermetyczne: strażniki tyldy/drzewa siedzą wyłącznie
w gałęzi `glm` `loadConfig` (ścieżka subskrypcji nietknięta), typ `SessionProbe` tylko poszerzony
(zero-argumentowe stand-iny nadal przypisywalne), `probeAuth` zamiana źródła odczytu
behawioralnie identyczna. `pnpm vitest tests/provider-mode.test.ts` 26/26.

Odłożone minors (nieblokujące, do backloka):
1. **Tura dymna nie zaksięgowana w rejestrze GLM** — próba zużyła 1 turę z grantu 25, a
   `.e2e-model-turns/glm.json` nadal nie istnieje (drzewo pracy czyste), więc licznik mówi 0/25.
   Zaksięgować wpis (albo adnotację w dowodzie próby), żeby sufit był szczery.
2. `realResolve(given)` przy egzotycznych ścieżkach (`..` po członie nieistniejącym) rzuca
   `UnresolvablePathError` poza komunikatem `loadConfig` — start i tak odmówiony (fail-closed),
   tylko kosmetyka komunikatu; kształt przeniesiony z commitu bazowego, nie nowy.
3. Dispatch providera pokryty testem jednostkowym (stand-in z przechwytem); e2e stand-in
   ignoruje provider z konstrukcji — akceptowalne, nota dla pełności.

## Werdykt próby dymnej (1 tura GLM, port 8796, izolowany pusty CLAUDE_CONFIG_DIR w tmp)

**Brak red flags dla granicy poświadczeń:** port 8796 to zakres testowy (8791 nietykalny),
pusty izolowany katalog w tmp wyłącza poświadczenia OAuth użytkownika z gry (CLI buduje własną
konfigurację w tmp — G21 dotyczy jego własnego katalogu, nie pliku użytkownika), token z env
operatora to zaprojektowany kanał, a wszystkie przeglądane miejsca wypisu podają wyłącznie
ORIGIN i nazwę polityki — `RUN_FINISHED` jest spójne z przyjęciem tokena przez endpoint GLM
i nic w opisie nie sugeruje, by wartość tokena pojawiła się na jakiejkolwiek powierzchni;
jedyna szczątka to zaksięgowanie tej tury w rejestrze (minor 1 powyżej).

## Wniosek

F1/F2/F3 ADDRESSED, zero nowych uszkodzeń — warunki z recenzji głównej spełnione. Droga do
prób modelowych otwarta: najpierw `pnpm probe:sdk-session` w glm (0 tur) dla żywego kształtu
sesji, potem T15 w ramach rejestru GLM (sufit 25, z zaksięgowaniem tury dymnej), wyłącznie na
instancji testowej.
