# Brief: ETAP 1 / Subagent B — patch bramki macierzy (FINALNY)

Pracujesz WYŁĄCZNIE w: `lokalny katalog worktree szablonu/z14-bramka`
(gałąź `domkniecie/z14-bramka`, start `763dd31`). Nie dotykasz innych worktree. Nie wysyłasz nic
na remote. Nie zlecasz pracy innym agentom.

## Cel (wymaganie właściciela)

Jedna kanoniczna macierz; `check:acceptance` i `check:matrix` czytają to samo źródło; rozjazd
liczby kryteriów kończy się błędem; liczby nie są wpisywane ręcznie; raporty są generowane.
Dziś: `check:acceptance` liczy 200 z kanonu (ARCHITECTURE.md + assessment.json), a `check:matrix`
liczy 95 z archiwalnego FEEDBACK.md — oba zielone, zero więzi.

Mapa stanu obecnego (przeczytaj w całości): `docs/versions/v0.4/archive/domkniecie-2026-09/etap1-a-mapa.md`

## Kształt rozwiązania (decyzje orkiestratora — wykonuj)

1. **Wspólny moduł** `scripts/lib/matrix-core.mjs`: parsowanie specyfikacji (`docs/ARCHITECTURE.md`)
   i ocen (`docs/acceptance/assessment.json`), stała `EXPECTED = { layers: 12, criteria: 200, scenarios: 27 }`,
   zbiory statusów/dowodów/pochodzenia, liczenie sum. Używają go oba `acceptance-matrix.mjs`
   i `matrix-summary.mjs`. Zachowuj dotychczasowe zachowanie wyjściowe `acceptance-matrix.mjs`
   (render ACCEPTANCE.md/BACKLOG.md bajt w bajt na obecnym stanie — `check:acceptance` musi dalej
   przechodzić BEZ regeneracji plików).
2. **`check:matrix` (`scripts/matrix-summary.mjs`) przepięty na kanon**: wylicza podsumowanie
   (200/187/11/2, warstwy zamknięte, pakiety) z kanonu przez matrix-core, asertuje `EXPECTED`
   (zniknięcie kryterium = błąd), porównuje swoje liczby z sekcją „Podsumowanie (wyliczone)” w
   WYGENEROWANYM `docs/ACCEPTANCE.md` (stary/zbajtowany raport pochodny = błąd), wypisuje czytelne
   podsumowanie. Nazwa polecenia zostaje `check:matrix`. Uwaga na format ACCEPTANCE.md — porównuj
   liczby sparsowane z sekcji, nie surowy tekst, jeśli to prostsze i równie twarde.
3. **Kontrola archiwum zostaje w `check:closure` (`scripts/closure-matrix.mjs`), jawnie nazwana
   jako archiwalna**: (a) przenieś obiekt `A` (95 ocen) VERBATIM do pliku danych
   `docs/archive/agenticapp-2026-09/oceny-95.json` (zero zmian treści — to translokacja, nie edycja
   ocen); skrypt czyta z niego; (b) dodaj twardą stałą `EXPECTED = { layers: 12, criteria: 95 }`;
   (c) komunikaty problemów idą na STDERR (dziś check:closure failuje po cichu: stdout→/dev/null,
   package.json:45); (d) nagłówek/dokumentacja skryptu mówi wprost: to kontrola archiwum
   historycznego 95, nie macierz bieżąca.
4. **Cross-check 95↔kanon** (zamyka lukę „nic nie porównuje światów”): w `matrix-summary.mjs`
   asercja, że `assessment.json` ma dokładnie 95 pól `historical`, a każdy z nich wskazuje ID
   istniejące w specyfikacji archiwalnej 95. Status-mapping (np. CZĘŚĆ↔częściowe) dodaj TYLKO jeśli
   po obejrzeniu danych jest jednoznaczny —_zero fałszywych alarmów_; jeśli niejednoznaczny, zrób
   tylko check liczby+ID i odnotuj decyzję w raporcie.
5. **Usuń `scripts/audit-matrix.mjs`** (martwy duplikat `A`, nikt go nie wywołuje). Zaktualizuj
   klasyfikację w `tests/acceptance-target.test.ts` (L336–403 wg mapy; wpisy wskazujące
   nieistniejący plik = błąd — sprawdź też, czy reguła wymaga kompletności listy).
6. **package.json**: `verify` dalej składa wszystkie trzy (acceptance, matrix, closure) — teraz
   spójne; sprawdź, czy opisy w README.md (L271) wymagają korekty.
7. **Dokumentacja**: `AGENTS.md` (L99 verify, L172–173 flow ocen), `docs/archive/README.md` (L10),
   `docs/DOCUMENTATION-MAP.md` (L28/30/62), nagłówek `scripts/matrix-summary.mjs` (komentarz
   o „95” zaktualizować), wpis w `FEEDBACK.md` (następny numer T — sprawdź najwyższy istniejący).
8. **Testy regresyjne bramek** (nowy plik, np. `tests/matrix-gates.test.ts`) — JEDNOSTKOWE na
   matrix-core z fixture'ami (stringi/tmp, ZERO mutacji plików repo w trakcie testu):
   (1) usunięcie jednego kryterium → oblewa; (2) zmiana statusu oceny → oblewa + dryf
   wygenerowanego dokumentu → oblewa; (3) duplikat ID → oblewa; (4) rozjazd EXPECTED vs
   sparsowane (np. 199/95) → oblewa; (5) podręczny „raport pochodny” ze zmyślonymi liczbami nie
   przechodzi weryfikacji. Plus jeden test-„smoke”: wywołuje `node scripts/acceptance-matrix.mjs
   --check`, `--check` matrix-summary i `check:closure` na repo (spawn, exit 0). Testy mają
   asertywne komunikaty — że oblewa ZA TO, a nie przypadkiem.

## Zakazy

- Nie zmieniaj `docs/acceptance/assessment.json` (żadnych zmian statusów w tym pakiecie) poza
  tym, co wynika z translokacji z pkt 3 ( jej nie dotyczy — assessment.json nietknięty).
- Archiwum `docs/archive/**` nietknięte POZA nowym plikiem `oceny-95.json` i opisem w README archiwum.
- Nie dotykaj `docs/evidence/**`, nie uruchamiaj `pnpm test:e2e`, nie zmieniaj zależności
  (lockfile bez zmian), nie używaj `--force`/wyłączania kontroli.

## Procedura

1. `pnpm install --frozen-lockfile` (świeży worktree).
2. Baseline: `pnpm check:acceptance`, `check:matrix`, `check:closure` — zapisz wyjścia (muszą
   być zielone przed zmianami).
3. Implementacja małymi commitami (polskie komunikaty, styl repo).
4. Przed zgłoszeniem: pełne `pnpm verify` (=0) + nowe testy + pokaz, że każdy test negatywny
   oblewa właściwy przypadek (wyjście testów).
5. Raport zapisz do: `docs/versions/v0.4/archive/domkniecie-2026-09/etap1-b-report.md`
   (co zmienione i dlaczego, decyzje zapasowe, wyniki baseline/verify/testów, lista commitów,
   znalezione problemy). W odpowiedzi zwrotnej TYLKO: status (DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED),
   lista commitów, jednozdaniowe podsumowanie testów, obawy.
