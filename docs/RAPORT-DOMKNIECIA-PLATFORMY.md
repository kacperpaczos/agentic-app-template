# Raport domknięcia platformy — 2026-09-20

Gałąź `domkniecie/integracja` @ `ad2ae79`; `main` = `e4fe9d7` = `origin/main`, nietknięte.
Zmiana względem `main`: **278 commitów, 395 plików, +68 822 / −2 583 linii**, 27 scaleni pakietów
i rund poprawek. **Nic nie zostało wypchnięte na GitHub — publikacja to osobna decyzja właściciela.**

## 1. Co znaczy „potwierdzone”

Kryterium jest potwierdzone wyłącznie na dowód z rzeczywistego działania. Właściciel wykluczył
sześć podstaw (sam kod; sam endpoint; deklaracja agenta; pusta asercja; test przechodzący na
wcześniej zapisanym artefakcie; test API zamiast testu rzeczywistego interfejsu) — ten raport
żadnej nie używa. Raport rozdziela **kod, który istnieje**, od **kodu, który został sprawdzony**;
to rozróżnienie jest jego głównym tematem, bo w trakcie programu zdarzył się raport o 16
domknięciach przy pliku `assessment.json` bajtowo identycznym z bazą. Od tamtej pory każde
domknięcie weryfikowano w pliku, nie w raporcie.

## 2. Macierz końcowa

**187 potwierdzonych / 11 częściowych / 2 niespełnione = 200.** Zero kryteriów bez decyzji.
`check:acceptance` = 0; rejestr pochodzenia dowodów kompletny (redakcja higieniczna opisana w §6).

### 2a. Kryteria otwarte NA ZAWSZE — powód nie znika przez dolożenie pracy

| Kryterium | Powód (zmierzony, nie domniemany) |
|---|---|
| **L8.11** | Komunikat przy WYCZERPANYM limicie subskrypcji: przebiegu nie da się wywołać na żądanie; symulacja limitu dowodzi symulacji, nie platformy. |
| **L8.10** | Skuteczne odświeżenie tokenu: bezpieczna obserwacja niemożliwa w tej konfiguracji — świadomie poza zakresem, nie brak dowodu. |
| **L5.8** | Błąd strumienia modelu (chunk error → `RUN_ERROR` z klasyfikacją): niewywoływalny na żądanie; pokryty symulacją `tests/run-lifecycle.test.ts`. |
| **L12.10** | 44 dowody sprzed koperty pochodzenia: commit i wytwórca znane, środowisko nieodtwarzalne wstecz. Rejestr zamknięty (może tylko maleć); nowe dowody kopertę mają. |
| **L11.11 ramię katalogu poświadczeń** (część kryterium) | NIEWYWOŁYWALNE BEZ SZKODY: zmierzono, że CLI przepisuje plik poświadczeń ze 193 na 121 bajtów i `accessToken` znika — próba wylogowałaby właściciela. Odseparowany `CLAUDE_CONFIG_DIR` z wymyślonym poświadczeniem nie uwierzytelnia sesji. Pokryte symulacją `tests/credential-guard.test.ts`. |

### 2b. Kryteria gotowe do domknięcia turą modelu — ZABLOKOWANE dostępem

Blokada: *„Your organization has disabled Claude subscription access for Claude Code"* — trwała,
po stronie konta/admina organizacji. Diagnoza bez tury: `docs/evidence/z11-bl03/runs/2026-09-20T02-26-53-975Z/`
i `diagnoza-blokady-org.md`. Tura 21 (T14) została wydana, skonsumowana i uczciwie zapisana jako
`niezaliczona` — zero wywołań, zero zgód; rezerwa niewydana, bo powtórka odtworzyłaby wynik.
Rejestr tur: **21/25**. Żadne z poniższych nie jest domknięte i żadne nie jest udawane.

| Grupa | Kryteria | Spec (jedno polecenie po przywróceniu dostępu) | Budżet |
|---|---|---|---|
| T14 | L11.4, L11.5, ramię sekretów L11.11 | `npx playwright test e2e/bl03-model-t14.spec.ts` | 1+1 rezerwy |
| T15 | L1.6, L7.13, L11.7 | `npx playwright test e2e/bl03-model-t15.spec.ts` | 4 — dokładnie pozostałe |
| T16 | L6.11, L11.23 | `npx playwright test e2e/bl03-model-t16.spec.ts` | 1 (wymaga podniesienia sufitu) |
| T17 | L11.12 (+ obserwacje `updatedInput`, „odmawia czy pyta") | `npx playwright test e2e/bl03-model-t17.spec.ts` | 1 (j.w.) |

**Warunek uruchomienia (ważne):** licznik grantu jest per kopia robocza i nie zasiewa się z dowodów —
jedno-polecenia biegać w kopii `agentic-app-template-wt/z11-bl03` (prawdziwy rejestr) albo przenieść
`.e2e-model-turns/z11-bl03.json`. **Kolejność T15 → T16 → T17 obowiązkowa**: przy 21/25 preflight
T16/T17 przepuści przed T15 i skonsumuje tury T15. Każdy spec ma próbę generalną zieloną na
stand-inie (łącznie 14/14) i rejestry zapisywane przed asercjami (naprawa obroniła się empirycznie:
tura 21 padła na asercji nr 1, a `finally` i tak zapisał pełny rekord).

**L8.7** — wróciło na `potwierdzone`: pierwotny dowód `gui` istnieje, a obie drogi kontrprzykładów
znalezione w trakcie programu (kanarek poświadczeń w czacie; publikacja pliku spoza workspace jako
artefakt) są zamknięte i związane regresją (odwrócone próby A6e/C1 w pakiecie ataków). Historia
zapisana w polu `proof`.

## 3. Warstwy

- **Zamknięte z kompletem dowodów:** L2, L3, L4, L10.
- **Częściowo otwarte:** L1 (L1.6 — przyrząd pid+czas-startu dowiedziony próbami i mutacjami, tura
  czeka), L5/L6/L7/L8/L9/L11/L12 — patrz §2a/§2b.

## 4. Pakiety

Scalone z pełnym cyklem (implementacja → niezależna recenzja → poprawki → próby pozytywne i negatywne
→ scalenie → bramka): BL-05, BL-06, BL-07, BL-10, BL-11a, BL-11b, BL-11c, BL-08a, BL-08b, BL-09,
BL-04 (9 rund strażnika + mikrorundy), BL-12, BL-03 (fazy A/B, przedtura, tura T14 zablokowana).
Wykaz scaleni: `git log --first-parent --oneline e4fe9d7..HEAD | grep -i scalenie`.

## 5. Wyniki bramek końcowych (na `ad2ae79`)

| Bramka | Wynik |
|---|---|
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm verify` | 0 — 68 plików / **1059 testów** |
| `pnpm check:module-swap` | 0 |
| `pnpm check:acceptance` | 0 |
| `pnpm test:e2e` (pełny, przeglądarkowy) | patrz adnotacja poniżej |
| Macierz | 187/11/2 — odchylenia jawnie uzasadnione w §2a/§2b |
| Plik poświadczeń | nietknięty przez program; trzy obserwowane rotacje ~8 h (10:40 / 18:40 / 02:36) to własna kadencja sesji właściciela — potwierdzone strukturą i świeżością tokenu; strażniki vitest i e2e zielone w oknach wszystkich przebiegów |



### 5a. Pełny test przeglądarkowy na `ad2ae79`

**224/224 zielone, exit 0 (16,5 min).** W trakcie przebiegu strażnik poświadczeń z rundy 7
potwierdził sam: *„[e2e] poświadczenie użytkownika nietknięte (odcisk zgodny z globalSetup)"* —
mechanizm wykrywania zadziałał w produkcji, nie tylko w próbie zdolności wykrycia.

## 6. Wady bezpieczeństwa znalezione i zamknięte w programie

Odczyt pliku poświadczeń; obejście strażnika przez podwykonawcę; publikacja przez dowiązanie
symboliczne; domyślne celowanie proxy deweloperskiego w port instancji użytkownika (8791) i to samo
w komendzie akceptacyjnej; leksykalne zwijanie `..` przed rozwiązaniem fizycznym — w **dwóch
niezależnych miejscach** (strażnik narzędzi agenta i `util/real-path.ts` strażników izolacji);
wyrocznia istnienia w komunikatach odmów; martwa gałąź `decideTool` (narzędzie w `allowedTools`
z pominięciem bramki); brak wiązania `settings.permissions` w dowolnym teście; zaszyta ścieżka
właściciela w harnessie prób. W dowodach: odciski prawdziwych tokenów i ścieżki `/home/paczos` —
**zredagowane mechanicznie z pełnym rejestrem** (`docs/evidence/HIGIENA-REDAKCJA.md`); koperta
pochodzenia nie wiąże plików hashami, więc redakcja nie łamie żadnego łańcucha.

## 7. Ograniczenia biblioteki i znane kształty (uczciwie)

- Semantyka `updatedInput` na prawdziwym CLI — nieweryfikowalna bez tury (otwarte Z7); **odmowa
  działa niezależnie od przepisywania** — potwierdzone mutacją (wyłączenie przepisywania nie oblewa
  ani jednego testu odmów).
- `blockReadsOutsideWorkingDirectories` — poszlaki z łańcuchów binarki mówią „pyta", nie „odmawia";
  rozstrzygnięcie wymaga tury (Read poza workspace). Pozostaje otwarte.
- TOCTOU pre-walka wzorców (W4) oraz kształty A10b/D1 — wymagają zdolności Bash, czyli zgody
  użytkownika: kategoria **„zgoda to pytanie, nie ochrona"**, wpisana jawnie w gap L11.4/L11.11.
- `Query.readFile()` nie jest świadkiem decyzji bramki uprawnień — sprawdzone i odrzucone jako dowód.
- Ograniczenie stand-inu: odrzucone `ask` nie zostawia kroku narzędzia (realny SDK ogłasza wywołanie
  przed bramką — potwierdzone dowodem tury z 2026-09-19); asercja kroku Bash należy do tury T17.

## 8. Kod istniejący vs kod sprawdzony

Wszystko, co scalono, ma regresję. Rozróżnienie dotyczy dowodów z prawdziwym modelem: platforma jest
testowana na granicy adaptera skryptowanym stand-inem (ograniczenie stand-inu nazwane w §7), a
kryteria wymagające prawdziwego modelu są otwarte do czasu tury — z gotowymi specami i próbami
generalnymi. Kryteria zamknięte na „rzeczywisty model" mają dowody z przebiegów t1–t20
(`docs/evidence/*/runs/`), związane rejestrem pochodzenia.

## 9. Wnioski metodyczne (pełna wersja w `FEEDBACK.md`)

1. **Kod bezpieczeństwa „wyglądający poprawnie" nie jest dowodem poprawności** — strażnik granic
   przeszedł trzy recenzje przez lekturę i za każdym razem padał na próbach; sedno: tryb awaryjny
   walkera był leksykalny, a ucieczki nie wymagały przygotowania (dowiązania `node_modules` tworzył
   sam `createRunWorkspace`).
2. **Równoważność kopii mierzy się na kształtach rozbieżnych** — TS↔`.mjs` „zgodne" w teście,
   które nie porównuje kształtów rozbieżnych, dowodzi zgody już istniejącej, nie braku dryfu.
3. **Granica testu ma zbiegać się z granicą twierdzenia** — dwa razy test egzekwował mniej, niż
   obiecywał komentarz; poprawki tanie, rozjazdy ciche.
4. **Liczy się zdarzenie narzędzia ze strumienia, nie zdanie modelu** — i rejestry dowodu zapisuje
   się przed asercjami.
5. **Mechanizm naprawiający klasę potrafi w niej stworzyć nową dziurę** (przepisywanie
   `updatedInput` zamieniające ENOENT w udany odczyt poza workspace) — każda poprawka strażnika
   dostaje własny pakiet ataków.
6. **Zgoda użytkownika to pytanie, nie ochrona** — trzy kształty wymagające Bash zapisane jawnie
   jako kategoria, z nazwaniem zdolności przeciwnika.
7. **Audyt wyliczany z rejestru znajduje więcej niż skarga** — luka mówiła o trzech narzędziach,
   audyt znalazł czwarte; reguła z rejestru MCP psuje się sama przy nowym narzędziu.
8. **Wykrywanie bije zapobieganie — ale tylko tam, gdzie biega** — zakaz dotykania pliku
   poświadczeń złamano cztery razy, mechanizm odcisku nie zawiódł nigdy; luką okazało się pokrycie
   (Playwright miał zakaz, nie miał mechanizmu — domknięte rundą 7).
9. **Recenzja przed turami to nie formalność** — licznik zdarzeń w T17 z błędną nazwą oblewałby
   każdą wydaną turę; wyłapała go recenzja, nie próba generalna (bliźniak nie asertował
   rozstrzygnięć).

## 10. Decyzje właściciela

1. **Publikacja** — push to osobna decyzja; nic nie wypchnięto.
2. **Tury modelowe** — po przywróceniu dostępu: §2b, z warunkiem licznika i kolejnością.
3. **Sufit grantu** — T16/T17 wymagają podniesienia `MODEL_TURN_BUDGET` (plan 22 → realny stan 21/25;
  T15 mieści się na styk).
4. **Akceptacja odchyleń** — §2a jako stan końcowy części kryteriów.
