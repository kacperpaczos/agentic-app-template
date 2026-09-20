# Raport startu programu domknięcia — 2026-09-20

Kontrolowana inwentaryzacja przed wznowieniem prac. Wszystkie liczby poniżej są odczytane z
rzeczywistego stanu (git, skrypty bramek w trybie `--check`, `assessment.json`), nie przepisane
z raportów. Nic w tym kroku nie zmienia kodu ani ocen.

## 1. Stan gałęzi i worktree

- Gałąź robocza: `domkniecie/integracja` @ `3692094` w
  `/home/paczos/Documents/agentic-app-template-wt/integracja`, drzewo **czyste** (git status: brak zmian).
- **280 commitów** przed `main` (`e4fe9d7..HEAD`), brak upstream, **nic niewypchnięte**.
- Wszystkie 13 gałęzi pakietowych `domkniecie/z*` jest przodkami `domkniecie/integracja`
  (sprawdzone `git merge-base --is-ancestor` — scalone w całości).
- Worktree: 27 aktywnych (integracja + 13 pakietowych + 13 przeglądowych `rev-*`). To pozostałości
  zakończonych pakietów — kandydaci do sprzątania po ETAP 8, na razie nietknięte.
- Publiczny `main` @ `e4fe9d7` = `origin/main` = tag `v0.3.0-bl01-bl02-2026-09-18`, czysty, nietknięty.

## 2. Wyniki bramek (zmierzone dzisiaj)

| Bramka | Wynik | Uwaga |
|---|---|---|
| `check:acceptance` | 0 | 200 kryteriów (187 potwierdzonych / 11 częściowych / 2 niespełnione), 12 warstw, 27 prób, 5/12 warstw zamkniętych, spójność OK |
| `check:matrix` | 0 | raportuje **95 kryteriów** — historyczna macierz AgenticApp z `docs/archive/agenticapp-2026-09/FEEDBACK.md`, wewnętrznie spójna |
| `check:closure` | 0 | druga wariacja macierzy historycznej 95 (`scripts/closure-matrix.mjs`, oceny zaszyte w skrypcie) |
| `node_modules` | obecne | brak potrzeby `pnpm install` przed bramkami |

Rozjazd 200 vs 95 potwierdzony **jako fakty**, ale z niuansem: to nie dwie wersje jednej macierzy,
lecz macierz bieżąca (200, generowana z `docs/ARCHITECTURE.md` + `docs/acceptance/assessment.json`)
i **archiwum historyczne** projektu AgenticApp (95), strzeżone przez dwa osobne skrypty. Problem
ETAP 1 jest rzeczywisty: `pnpm verify` traktuje je jak równorzędne bramki bez żadnej więzi spójności
z kanonem, a nazwy (`check:matrix`) nie mówią, że strzegą archiwum. Oceny w `closure-matrix.mjs`
są wpisane **ręcznie w kod skryptu** — dokładnie wzorzec, który zlecenie każe wyeliminować.

## 3. Otwarte kryteria (13 z 200, z `assessment.json`)

| ID | Stan | Backlog | Rodzaj braku |
|---|---|---|---|
| L1.6 | częściowe | BL-03 | wymaga tury modelu (spec T15 gotowy, próba generalna zielona) |
| L5.8 | częściowe | BL-03 | niewywoływalny na żądanie (awaria adaptera / wyczerpany limit); raport §2a |
| L6.11 | częściowe | BL-11 | wymaga tury modelu (spec T16) |
| L7.13 | częściowe | BL-07 | wymaga tury modelu (którą z dwóch reakcji daje brak transkryptu) |
| L8.10 | częściowe | BL-04 | świadomie poza zakresem — bezpieczna obserwacja niemożliwa; raport §2a |
| L8.11 | częściowe | BL-04 | wymaga rzeczywistego wyczerpania limitu (nie do wywołania na żądanie) |
| L11.4 | **niespełnione** | BL-03 | rzeczywista luka: narzędzia plikowe poza strażnikiem; **naprawa możliwa bez modelu**; test odbiorczy istnieje i oblewa |
| L11.5 | częściowe | BL-03 | ramię plikowe = tylko symulacja; rozstrzygnięcie po przebudowie strażnika + tura |
| L11.7 | częściowe | BL-09 | wymaga tury modelu (Stop a proces potomny samego SDK, spec T15) |
| L11.11 | **niespełnione** | BL-03 | ramię sekretów = luka L11.4; ramię poświadczeń — niewywoływalne bez wylogowania właściciela |
| L11.12 | częściowe | BL-09 | wymaga tury modelu (kolejność mechanizmów SDK, spec T17) |
| L11.23 | częściowe | BL-09 | wymaga tury modelu (spec T16) |
| L12.10 | częściowe | BL-12 | 44 dowody sprzed koperty — środowisko nieodtwarzalne; regeneracja byłaby zmyśleniem |

Otwarte próby: **17 z 27** (T01–T24 wg `assessment.json`; lista pełna w raporcie macierzy).

## 4. Blockery

1. **Dostęp organizacyjny do Claude Code zablokowany** — *„Your organization has disabled Claude
   subscription access for Claude Code”*; diagnoza z tury 21 w `docs/evidence/z11-bl03/runs/…/diagnoza-blokady-org.md`.
   Blokuje ETAP 6 (T14–T17) i domknięcie ~9 kryteriów. Status z ostatniej sesji (raport z 2026-09-20);
   ponowna próba bez nowego sygnału od właściciela jest zabroniona zleceniem.
2. **Budżet tur: 21/25** (rejestr `.e2e-model-turns/z11-bl03.json`, sufit 25). T15 = dokładnie 4
   (reszta budżetu); T16/T17 wymagają podniesienia sufitu — decyzja właściciela (§10.3 raportu).
3. **Claude Code CLI zaktualizowane 2.1.277 → 2.1.278** między sesjami. Dowody prób powstały na
   2.1.277; wzorce rozpoznawania (m.in. `isMissingSessionTranscript`, komunikaty blokady org) mogą
   wymagać recalibracji przed jakąkolwiek nową turą.
4. **Port 8791 NIE działa** (odstępstwo od stanu opisanego w zleceniu; instancja użytkownika
   wyłączona, `ss`/`curl`: brak nasłuchu). Dla programu neutralne — testy i tak nie mogą celować w
   8791 — ale weryfikacja „czy port 8791 działa” kończy się: nie działa. Instancji nie uruchamiam.
5. **Brak CLI MiniMax**. Dostępny tani tier: `opencode`, `qwen`, `gemini`, `codex` (stan logowania
   do sprawdzenia przed użyciem) oraz subagenți na modelu Haiku. Plan zlecenia „MiniMax/OpenCode”
   realizuję jako: tani tier = Haiku/opencode, mocny tier = Sonnet/Opus.

## 5. Budżet tej sesji

- Okno kontekstu orkiestratora: 15,0 mln tokenów (na starcie); dotychczasowe zużycie inwentaryzacji ~2%.
- Tury modelu Claude: **4 dostępne** (T15) — wydane tylko po spełnieniu wszystkich preflightów ETAPU 6.
- Ograniczenia: dwa przebiegi bez zamknięcia kryterium = pakiet `blocked`; pełna regresja tylko po
  integracji pakietu.

## 6. Kryteria wymagające prawdziwego Claude (ETAP 6)

T14 → L11.4, L11.5, ramię sekretów L11.11; T15 → L1.6, L7.13, L11.7; T16 → L6.11, L11.23;
T17 → L11.12. Spece jedno-poleceniowe gotowe (`e2e/bl03-model-t1[4-7].spec.ts`), próby generalne
zielone (14/14 na stand-inie), rejestry zapisywane przed asercjami. Warunki uruchomienia: dostęp org,
kolejność T15→T16→T17, licznik w kopii `z11-bl03`, ewentualny sufit dla T16/T17.

## 7. Kryteria i prace możliwe bez tury (skorygowany ETAP 5)

**Ustalenie: lista ETAP 5 zlecenia (L1.2, L1.8, L1.9, L1.11, L1.12, L7.11, L9.7, L9.13, L12.7,
L12.10, L12.12, L12.15) jest nieaktualna** — te identyfikatory pochodzą ze starej macierzy 95 i w
macierzy 200 są to kryteria **potwierdzone** (np. L9.7, L12.7) albo nieistniejące (95 ma 9 kryteriów
w L9, 200 ma 13). Program ETAP 5 wykonuję przeciw **rzeczywistym** otwartym kryteriom; intencja
zlecenia („najpierw to, co nie wymaga tury”) pozostaje nadrzędna:

1. **ETAP 1 (P0)** — jedna kanoniczna macierz; `check:acceptance` i `check:matrix` czytają to samo
   źródło; rozjazd kończy się błędem; oceny nie wpisane ręcznie w skrypt (`closure-matrix.mjs`).
2. **ETAP 2** — straż izolacji już istnieje (etykieta instancji, APP_BASE domyślnie 8790 „nigdy 8791”,
   fingerprint poświadczeń, realpath-walk — raport §6 wymienia porażki, które zamknięto); trzeba
   **zweryfikować kompletność** względem checklisty zlecenia (jawny `APP_BASE_URL`, PID, katalog
   danych, blokada działającego katalogu użytkownika, SHA w dowodach) i domknąć dziury.
3. **ETAP 3** — analiza ostrzeżeń `No storage configured on Mastra`; decyzja wariant A/B per test.
4. **ETAP 4** — `docs/evidence/REUSE-MATRIX.md` (aktualność dowodów z11/z10/z12, oszczędność tur).
5. **Przebudowa strażnika narzędzi plikowych** (L11.4/L11.11 — reguła pozytywna allowlist) — kod,
   testy czerwone/zielone i kontrola negatywna są możliwe bez modelu; **domknięcie kryteriów i tak
   czeka na turę** (statusów nie ruszam).
6. L8.10/L5.8/L12.10/L8.11/ramię poświadczeń L11.11 — bez pracy do odłożenia; statusy bez zmian do
   czasu decyzji właściciela o akceptacji odchyleń (§10.4 raportu domknięcia).

## 8. Zasady potwierdzone w repo (wiązane dla subagentów)

`AGENTS.md`: port akceptacyjny 8790 nigdy 8791; etykieta instancji przed pierwszym żądaniem;
dane użytkownika nietykalne; Claude wyłącznie z subskrypcji (zero kluczy API); dowód ≠ status;
kontrola negatywna dla każdej krytycznej naprawy; `pnpm verify` nie zapisuje dowodów (`APP_WRITE_EVIDENCE=1`
na żądanie); testy modelowe tylko przez `test:e2e:z11` z rejestrem i preflightem budżetu.

## 9. Decyzja o starcie

Bramki wyjściowe odczytane, raport zapisany — zgodnie z zleceniem mogę rozpocząć ETAP 1 (naprawa
bramki macierzy, P0). ETAP 6 zostaje zamrożony do czasu sygnału właściciela o dostępie org.
