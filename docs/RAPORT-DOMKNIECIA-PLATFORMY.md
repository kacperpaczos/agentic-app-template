# Raport domknięcia platformy — 2026-09-20 (sesja kontrolowanego dokończenia)

Gałąź `domkniecie/integracja`; `main` = `e4fe9d7` = `origin/main`, nietknięte.
**Nic nie zostało wypchnięte na GitHub — publikacja to osobna decyzja właściciela (§8).**

> **Zmiana dostawcy (decyzja właściciela, 2026-09-20 wieczór):** Claude Code / Claude Agent SDK
> pozostaje harnesssem, providerem modelu jest **GLM/Z.AI przez kompatybilny endpoint Anthropic**
> w jawnym trybie `APP_MODEL_PROVIDER=glm` (fail-closed; subskrypcja Claude i OAuth Anthropic
> nieużywane i nieczytane w tym trybie). Próby modelowe na GLM są **wstrzymane do jednoznacznego
> sygnału właściciela** (równoległa edycja specyfikacji v0.4 w toku — zmiany `ARCHITECTURE.md`
> i `docs/versions/` w drzewie roboczym należą do właściciela i są nietknięte; bramki dryfu
> zgłaszają rozjazd do czasu ich skommitowania). Sonda SDK w trybie glm potwierdziła: sesja nie
> jest subskrypcją OAuth (stan „other"), poświadczenie z endpointu; dowód
> `docs/evidence/z12-bl04/sesja-sdk-glm.json`. Rejestr tur GLM: `1/25` (tura dymna).
> **Implikacja dla T17:** przeredagowane L11.12 (tryby zgód: ręczny/nadzorowany/pełna
> automatyzacja) zmienia znaczenie kryterium — dzisiejszy spec T17 (kolejność allowedTools/
> canUseTool) odpowiada STAREMU brzmieniu i wymaga przepracowania wobec nowego, zanim cokolwiek
> domknie. Naprawiony przy okazji defekt: sonda `probe:sdk-session` w trybie glm nadpisała
> istniejący dowód BL-04 (`sesja-sdk.json`) — dowód przywrócony z gita, wynik glm zachowany jako
> `sesja-sdk-glm.json`, ścieżka zapisu sondy provider-aware (`7db6634`).

Sesja to kontynuacja porannego programu (raport z rana opisywał stan `ad2ae79`/`3692094`).
Ta sesja NIE domyka nowych kryteriów modelowych (dostęp organizacyjny nadal zablokowany) —
domyka infrastrukturę odbioru: P0 bramki macierzowe, dziury izolacji testów i decyzję o
storage Mastry. Macierz pozostaje **187 / 11 / 2 = 200** — celowo, bo żaden z 13 otwartych
kryteriów nie wisi na pracach tej sesji (§3).

## 1. Co się zmieniło w tej sesji (3 pakiety, pełny cykl implementacja → recenzja → scalenie)

### ETAP 1 (P0) — jedna kanoniczna macierz (`bf97be6`)
- `check:acceptance` i `check:matrix` czytają **to samo źródło** (kanon: `docs/ARCHITECTURE.md` +
  `docs/acceptance/assessment.json`) przez wspólny rdzeń `scripts/lib/matrix-core.mjs`;
  oba podsumowania pokazują **200 / 187-11-2**.
- Rozjazd liczby kryteriów **kończy się błędem**: usunięcie jednego kryterium → exit 1
  (próba orkiestratora: 84 problemy + ROZJAZD 18 z nazwaniem liczb „raport mówi X, a oceny dają Y”).
- Kontrola archiwum 95 zostaje w `check:closure`, jawnie nazwana jako archiwalna: oceny
  przeniesione VERBATIM z kodu do `docs/archive/agenticapp-2026-09/oceny-95.json`, twarda stała
  95, problemy na STDERR (wcześniej cichy fail). Martwy duplikat `audit-matrix.mjs` usunięty.
- Kros-kontrola światów: dokładnie 95 pól `historical` w kanonie, ID zgodne ze spec-95 —
  luka „nic nie porównuje 95 z 200” zamknięta.
- 8 nowych testów bramek (`tests/matrix-gates.test.ts`); niezależny recenzent wykonał 5 prób
  negatywnych na kopiach /tmp (wszystkie oblewają) + potwierdził translokację VERBATIM (95/95).

### ETAP 2 — dziury izolacji testów (`b9467ac` + fix `3d87dda`)
Audyt (9-punktowa checklisty zlecenia): 4 OK, 6 dziur. Naprawione na warstwie skryptów
testowych/audytowych — **`pnpm start` bez etykiety działa jak dotychczas** (decyzja świadoma:
właściciel ma prawo uruchamiać swoją aplikację na swoich danych; kotwica `tests/isolation.test.ts:215-223`):
1. Skrypty startujące (`dev-server.sh`, `audit-server.sh`, `closure-server.sh`): odmowa, gdy
   `APP_DATA_DIR` nosi cechy żywych danych (`session.secret`) — przed startem.
2. Fingerprint poświadczeń w `acceptance-agent.mjs`/`run-agent.mjs` — brany przy bramce,
   porównywany w `finally` (przeżywa nieprzechwycony wyjątek; plik-przenośnik w gitignorowanym
   `test-results/`, kontakt z poświadczeniami wyłącznie `statSync`).
3. `dev-server.sh`: sonda portu PRZED startem + potwierdzenie własnego pid z /proc (koniec z
   fałszywym „started” przy zajętych 8791).
4. Bramka odbiorowa: wymagane `APP_INSTANCE_RUN_ID` + testowy katalog danych (odmowa przed
   pierwszym żądaniem zapisującym).
5. Porządki e2e: kasowanie katalogów instancji **po kształcie danych** (`app.db`/`session.secret`),
   nie po prefiksie — `.e2e-model-turns/` (rejestr budżetu tur 21/25) jest z natury bezpieczny
   (testy przeżycia w `tests/global-teardown.test.ts` 9/9). Poprawka po final review, które
   wykryło, że pierwsza wersja (reguła prefiksowa) kasowałaby rejestr tur.
6. `assertDirectoryFree` bez /proc: fail-closed.
Pełne e2e przeglądarkowe po pakiecie: 224/224 (18,5 min).

### ETAP 3 — storage Mastry: świadome ograniczenie (`5cfc97c`)
Faktografia (@mastra/core 1.66.0): magazyn Mastry jest **martwy** — aplikacja trzyma trwałość
wyłącznie we własnej SQLite (`app.db`), jedyna referencja to `getAgent('appAgent')`, zero
asercji opartych o pamięć Mastry. Decyzja (wariant B): jawny `InMemoryStore` z publicznego
eksportu `@mastra/core/storage` + komentarz + sekcja „Storage Mastry — świadome ograniczenie”
(`docs/observability.md`) + strażnik testowy (asercja dokładnego komunikatu o fallbacku;
mutacja oblewa). **Zero nowych zależności; żaden status kryterium nie zmieniony** (kryteria
restartu potwierdzone na właściwej warstwie — własnej bazie).

## 2. Bramki końcowe (drzewo złożone `3d87dda`)

| Bramka | Wynik |
|---|---|
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm verify` (worktree) | 0 — 71 plików / **1135 testów** |
| `pnpm verify` (świeży klon `3d87dda`, izolowany) | 0 — **1135/1135**, zgodny z worktree |
| `pnpm test:e2e` (pełny, przeglądarkowy) | **224/224** na `5cfc97c` (18,5 min) i **224/224** na finalnym `3d87dda` (16,5 min); log końcowy pokazuje naprawiony teardown przy pracy (katalog nieinstancyjny zostaje z podanym powodem) |
| `check:acceptance` | 0 — 200 kryteriów, 187/11/2, spójność OK |
| `check:matrix` | 0 — kanon 200, kros-kontrola archiwum 95 OK |
| `check:closure` | 0 — archiwum 95, stała twarda, STDERR |
| `check:module-swap` | 0 |
| Skan sekretów diffu sesji | czysty (jedyna trafiona linia = zadeklarowana atrapa w teście) |
| Ścieżki `/home/paczos` w diffie sesji | 0 |
| `docs/acceptance/assessment.json` w diffie sesji | **nietknięty** (żaden status nie zmieniony) |
| Nieśledzone bazy/tokeny | brak (katalogi `.e2e-*` z poprzednich sesji są gitignorowane) |

## 3. Macierz — bez zmian statusów, uczciwie

**187 potwierdzonych / 11 częściowych / 2 niespełnione = 200. 5/12 warstw zamkniętych.**
Otwarte kryteria (13) i otwarte próby (17/27) — bez zmian wobec porannego raportu:

- **Zablokowane dostępem organizacyjnym — potwierdzone DWUKROTNIE** (rano 02:26 sondu czystą,
  wieczorem 19:22 prawdziwą próbą w aplikacji, run `4a63bb99`: `[model_failed] Your organization
  has disabled Claude subscription access for Claude Code`, nagłówek „błąd płacenia z modelem";
  `pnpm diag` rozdziela warstwy: poświadczenie valid, plan Claude Max, firstParty — blokada działa
  na poziomie **inferencji**, nie poświadczenia): L1.6, L6.11, L7.13, L11.4, L11.5, L11.7, L11.11
  (ramię sekretów), L11.12, L11.23. Rejestr tur: **22/25** — tura 22 wydana na T15 i uczciwie
  zapisana (proba `17-06-16-992Z`: padła na błędnym założeniu speca, **0 tur**; poprawka speca
  `e954150` po recenzji; proba `17-22-07-307Z`: 1 tura, blokada org). Pozostałe **3 tury są
  bezużyteczne do czasu włączenia dostępu przez admina organizacji**; T15 wstrzymane na 1/4 tur.
  Spece T16/T17 zweryfikowane recenzją pod kątem wady T15 — czyste. REUSE-MATRIX
  (`docs/evidence/REUSE-MATRIX.md`): 13 dowodów aktualnych (oszczędność 14 tur), 5 do powtórzenia.
- **Trwale ograniczone** (poranny raport §2a bez zmian): L5.8, L8.10, L8.11, L12.10, ramię
  poświadczeń L11.11. Klasyfikacja końcowa (`out-of-scope`/`library-limit`/`blocked-by-access`)
  pozostaje **decyzją właściciela** — w tej sesji żadnych statusów nie przestawiano.
- Nowy wymóg dla przyszłych prób ujawniony przez REUSE-MATRIX: koperty dowodów muszą zapisywać
  nazwę modelu (do dziś każda miała `model: null`); istniejących dowodów nie wolno dosztukować.

## 4. Defekty znalezione i zamknięte w tej sesji

1. **P0**: trzy ręczne kopie ocen historycznych + cichy fail `check:closure` + brak więzi
   95↔200 (ETAP 1).
2. **Important**: crash-path omijał porównanie odcisku poświadczeń (recenzja ETAP 2, fix runda 1).
3. **Important**: teardown prefiksowy kasowałby rejestr budżetu tur `.e2e-model-turns/`
   (final review, fix runda 2 — obrona kształtem danych).
4. Dziury izolacji 1–6 (audyt ETAP 2), w tym brak odcisku poświadczeń w acceptance i fałszywe
   „started" `dev-server.sh` przy cudzym 8791.
5. Systemowe: `model: null` w kopertach dowodów (do uzupełnienia w przyszłych próbach).

Odroczone minory (13, z triage final review — żadne nie blokuje publikacji): pełna lista w
`.sdd-zlecenie/final-review.md` i ledgerze; najistotniejsze: M-2 (prefiks `.e2e` akceptowany
poza repo — do przepisania razem z M-R2N1 „containment added by harness" bez pokrycia w kodzie),
M-5 (ręcznie nazwany `.e2e-*` katalog użytkownika w korzeniu repo), M-1 (testy statują prawdziwy
plik poświadczeń), sprzężenie strażnika Mastry z brzmieniem 1.66.0.

## 5. Koszt sesji

- **Tury modelu Claude: 1** (rejestr 21/25 → 22/25: tura wydana na T15, zablokowana polityką
  organizacji na poziomie inferencji; próba uczciwie zapisana, bez powtórki do czasu decyzji
  admina; pozostałe 3 tury nietknięte).
- Subagenci: **13** (4 analizy read-only na modelu tanim: mapa macierzy, faktografia Mastry,
  reuse-dowodów, audyt izolacji; 3 implementatorów Sonnet; 4 recenzentów Sonnet; 1 final review
  najmocniejszym modelem). 7 pełnych recenzji pakietowych + 2 re-review + final review.
- Fix-loops: ETAP 2 — 2 rundy (I-1 odcisk/crash, I-1 teardown/rejestr tur); pozostałe pakiety
  bez rund.
- Czas aktywny sesji: ~5 h wall-clock (ETAP 0 → ETAP 8); oczekiwanie na e2e: ~37 min w dwóch
  przebiegach.
- Incydent bez skutku: równoległość „świeży verify + pełne e2e" spowodowała kolizję portu 8798
  (wada harmonogramu orkiestratora, nie repo; powtórzono w izolacji — zielono).
- SHA końcowego drzewa: **3d87dda431ffeba95fda3e5fd29741e40838d28c**.

## 6. Kod istniejący vs kod sprawdzony

Wszystko, co scalono w tej sesji, ma regresję (verify 1135) i przegląd (7 pakietów +
2 re-review + final review). Zmiany tej sesji nie dotykają granicy adaptera modelowego, więc
nie wymagają tur; kryteria wymagające prawdziwego modelu pozostają otwarte i nie są udawane.

## 7. Zmiany nieopublikowane

`domkniecie/integracja` = 283 commity przed `main` (280 z porannego programu + 3 commity
dokumentacyjne + scalenia tej sesji; dokładnie: 763dd31..3d87dda = 21 commitów sesji + raport).
Zero push, zero tagów. Worktree pakietowe sesji (`z14-bramka`, `etap2-izolacja`, `etap3-mastra`)
pozostają na dysku, scalone i czyste — do usunięcia po decyzji właściciela.

## 8. Decyzje właściciela (po tej sesji)

1. **Publikacja** — gałąź gotowa do prezentacji; push/tag wyłącznie na Twoje polecenie.
2. **Dostęp organizacyjny** — blokada inferencji potwierdzona dwukrotnie (poranny probe + wieczorna
   próba w aplikacji); wymaga akcji admina organizacji („enable access") albo świadomej zmiany
   polityki. Po jej zdjęciu: dokończenie T15 (3 tury do 4 zadeklarowanych), potem REPEAT izolacji
   i T16/T17 — wszystko **poza aktualnym grante 25** (zostały 3 tury), czyli wymagany nowy grant
   koordynatora z podanym sufitem. Spece gotowe i zrecenzowane; wzorce komunikatów do
   recalibracji wobec CLI w SDK (2.1.270) przy pierwszym zielonym przebiegu.
3. **Klasyfikacja odchyleń** — statusy końcowe kryteriów trwale ograniczonych (§3) do akceptacji.
4. **Sufit grantu** — podniesienie `MODEL_TURN_BUDGET` dla T16/T17, jeśli akceptujesz §2b.
