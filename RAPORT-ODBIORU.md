# Raport odbioru — szablon agentic-app-template v0.4.1

Data: 2026-10-08. Stan kodu: `04a9a8c` + commity fali dowodowej na gałęzi
`feat/l126-bl07-macierz` (ostatni: bramka przekrojowa). Macierz odbioru:
`docs/versions/v0.4.1/ACCEPTANCE.md` (generowana z `docs/acceptance/assessment.json`
— `pnpm acceptance:render`; `pnpm check:acceptance`/`check:matrix`/`check:closure`
pilnują spójności). Ten raport NIE zastępuje macierzy — wskazuje ją i opisuje to,
czego macierz sama nie powie.

## 1. Stan odbioru

- **196/200 kryteriów potwierdzonych** dowodem na kodzie tego repozytorium;
- **1 częściowe** (L7.13 — patrz §6: granica mierzalności zewnętrznego SDK);
- **3 informacyjne / poza bramką** (L8.10, L8.11, L12.10 — jawnie nieblokujące, D-02);
- **warstwy zamknięte: 11/12** (otwarta L7 wyłącznie przez L7.13);
- próby odbiorowe: 10 potwierdzonych, 16 częściowych, 1 niespełniona (T08; jej
  kryteria potwierdzone innymi dowodami) — rozliczenie w macierzy, §5 niżej.

**Trójpodział (L12.17).** (i) *Ukończenie implementacji*: kod i regresja na main,
`pnpm verify` EXIT 0 (1225 testów). (ii) *Odbiór w izolacji*: dowody z
`.e2e*`/katalogów tymczasowych na portach testowych — w tym fala modelowa GLM
(docs/evidence/z11-bl03/runs/, bramka przekrojowa) i pełna regresja
przeglądarkowa (237 testów). (iii) *Wdrożenie na danych użytkownika*: **NIE
zostało wykonane** — próby na kopiach nie uprawniają do deklaracji wdrożenia;
aktualność kopii sprawdzana tuż przed ewentualnym wdrożeniem
(docs/odzyskiwanie-stanu.md).

## 2. Architektura faktycznie wdrożona

Zgodna z `docs/versions/v0.4.1/ARCHITECTURE.md`: React 19 + TypeScript 7 +
Vite (frontend), Hono + Node 24 LTS (backend), Mastra 1.66 z adapterem
`@mastra/claude` 0.3.1, **Claude Agent SDK 0.3.270 / wbudowany CLI 2.1.270**
jako harness, **GLM/Z.AI jako jedyny provider** przez endpoint zgodny z
Anthropic (D-01; fail-closed, bez OAuth/subskrypcji/fallbacku), MCP
(narzędzia aplikacji `mcp__app__*`, 33 zarejestrowane w sesji — `pnpm diag`),
AG-UI jako kontrakt zdarzeń, OpenUI Agent Interface + Lang/Renderer, SQLite +
Drizzle (migracje platform-0001…0008), sandbox powłoki (bwrap) + reguła
pozytywna SDK (`blockReadsOutsideWorkingDirectories`) + strażnicy bramki
`canUseTool` jako jedyny autorytet dostępu plikowego (narzędzia plikowe poza
`allowedTools` we wszystkich trybach — c88f563).

Trzy tryby zgód (ręczny/nadzorowany/pełna automatyzacja; D-06) przypisane do
wykonania (`agent_runs.consent_mode`), czytane z rekordu — bez eskalacji w
trakcie; centrum zadań z formularzem decyzji, plakietką uwagi i jednorazowym
komunikatem (L11.12/L11.19).

## 3. Granica platforma–domena

`packages/platform-*` nie importują `@module/*`; słownik domenowy pochodzi z
modułów (`pnpm check:boundaries`); kompozycja wyłącznie w `apps/*/src/compose.*`;
moduł przykładowy (procurement) podpinany przez kontrakty
`platform-contracts`. Wymiana modułu sprawdzona (`pnpm check:module-swap`,
docs/evidence/z3-bl05).

## 4. Rejestr adapterów i wersje

Adaptery i ich granice: `docs/ADAPTERY.md` (A-01…A-18). Wersje rozwiązane:
lockfile + `tests/versions.test.ts` (React 19.3.0, TypeScript 7.0.2, Vite 8.3.0,
Hono 4.13.7, Drizzle 0.45.2, @mastra/core 1.66.0, @mastra/claude 0.3.1,
@openuidev/react-ui 0.13.10, SDK 0.3.270/CLI 2.1.270, Playwright 1.63.0 — pełny
wykaz w kopertach dowodów, pole `srodowisko`). Odtworzenie: README (instalacja z
lockfile → `pnpm verify` → `pnpm start`), tryb GLM: README „GLM/Z.AI".
Odtworzenie danych: `docs/odzyskiwanie-stanu.md` + `pnpm backup/restore/migration:rehearsal`.

## 5. Dowody kluczowe (wskaźniki)

- Macierz: każde kryterium ma wpis z zakresem i odniesieniem — 200/200.
- Fala modelowa GLM (38/45 tur grantu): izolacja narzędzi plikowych
  (L11.4/L11.5/L11.11), cykl życia (L1.6/L5.8), Stop (L11.7), braki bez
  zmyślania + formuła (L6.11/L11.23), wznowienie sesji (L8.5) —
  docs/evidence/z11-bl03/runs/.
- **Bramka przekrojowa** („Odbiór całego systemu"): jednej rozmowy dowód
  połączeń — odczyt i mutacja przez MCP (`1240000→1239900` minor, `version`
  +1, `platform.data_changed`, odświeżenie UI) → karta kompozycji powiązana z
  wykonaniem → plik CSV → artefakt powiązany z runem → SIGTERM → wznowienie
  tej samej sesji; ogon na tych samych identyfikatorach: odmowa dostępu (403
  forbidden, cudza tożsamość), konflikt (409, stale `expectedVersion`),
  anulowanie (Stop → cancelled), błąd (404 not_found — jedna implementacja,
  dwa wejścia). docs/evidence/bramka-przekrojowa/manifest.json.

## 6. Znane ograniczenia i otwarte pozycje

1. **L7.13 (częściowe)** — utrata transkryptu SDK nie jest sygnalizowana przez
   CLI 2.1.270; chirurgia „usuń `projects/<id>.jsonl`" nie jest wykonywalna
   (plik nie istnieje w tym układzie; próby 14-20/14-33/14-40). Wymuszone
   wznowienie nieznanej sesji przechodzi po cichu (historia wraca z projekcji
   aplikacji). Do decyzji: przeklasyfikowanie na informacyjne (D-02) albo
   research store CLI i ponowna próba.
2. **Bash-auto-allow (do decyzji właściciela)** — statyczna analiza CLI 2.1.270
   wykonuje trywialne komendy sandboxowalne (`echo`) bez konsultacji
   `canUseTool` mimo `autoAllowBashIfSandboxed: false` (t17 + obserwacja
   2026-09-16). Zgodne z literą D-06; odstaje od polityki „Bash zawsze pyta".
3. **Luki dowodowe prób „częściowych"** (nie blokują warstw; pełna lista w
   macierzy), najistotniejsze: T04 (proza przed narzędziem w gotowym czacie —
   zmierzone ograniczenie @openuidev/react-ui 0.13.10), T09 (L9.2 egzekwowane
   nie dla wszystkich operacji), T07 (zmiana/przesunięcie/usunięcie karty
   przez model bez próby w szablonie), T23 (podświetlenie ustawienia realnym
   modelem), T22 (równoległość A/B w przeglądarce), T24 (obrazy: PNG tylko).
4. **Wariancja modelu GLM**: bywa, że nie wykonuje poleceń powłoki (tura 2 t15 —
   skip z uzasadnieniem); koszty tur nieprzewidywalne w 100%.
5. Systemy poza Linux/Fedora 44 nieweryfikowane (README); Langfuse opcjonalny,
   nieaktywny.

## 7. Nieudane przebiegi i naprawy (L12.14)

- Fala 1 (4 tury): padła na atrapie GLM w instancji scenariuszowej → naprawa
  a6e3b1d; na binarnej kontroli CLI i braku Glob/Grep → poprawki pomiarowe
  9da6491. Fala 2 (3 tury): t15 String(args), t16 bez otwarcia aplikacji →
  0be7c04. Pełna e2e 231/237: porty scenariuszowe po falach → izolowany rerun
  10/10 (strażnik izolacji zadziałał poprawnie). T17 (1 tura): Bash-auto-allow
  (§6.2). Tury 14-20/14-33: wariancja modelu (§6.4). Wszystkie opisane w
  FEEDBACK §A31–A33 i w kopertach.

## 8. Kryteria informacyjne (jawnie nieblokujące)

L8.10 (częściowe — realne odświeżenie tokenu niewywoływalne bez ryzyka),
L8.11 (częściowe — realny limit/nieudane przebiegi podciagi klasyfikatora),
L12.10 (częściowe — 44 dowody sprzed koperty bez zapisu środowiska),
L7.13-ramie poświadczeń (niewywoływalne bez szkody — G21).
