# Brief: ETAP 1 / Subagent C — recenzja pakietu bramki macierzy

Jesteś niezależnym recenzentem (NIE jesteś autorem zmiany). Recenzujesz pakiet ETAPU 1 w worktree:
`lokalny katalog worktree szablonu/z14-bramka` (gałąź `domkniecie/z14-bramka`,
HEAD `172185c`, BASE `763dd31`, 5 commitów).

Materiały (przeczytaj w tej kolejności):
1. Wymagania (brief implementatora): `docs/versions/v0.4/archive/domkniecie-2026-09/etap1-b-brief.md`
2. Mapa stanu wyjściowego: `docs/versions/v0.4/archive/domkniecie-2026-09/etap1-a-mapa.md`
3. Raport implementatora: `docs/versions/v0.4/archive/domkniecie-2026-09/etap1-b-report.md`
4. Pełny diff (commity + stat + diff -U10): `lokalny katalog worktree szablonu/z14-bramka/.superpowers/sdd/zlecenie/review-763dd31..172185c.diff`

## Wymagania właściciela (globalne ograniczenia — Twoja soczewka)

- Jedna kanoniczna macierz; `check:acceptance` i `check:matrix` czytają to samo źródło.
- Rozjazd liczby kryteriów kończy się BŁĘDEM (kodem wyjścia ≠ 0), nie ostrzeżeniem.
- Liczby nie wpisane ręcznie (oceny w danych, nie w kodzie).
- Raporty generowane z macierzy; podręczny raport pochodny nie może udawać aktualnego.
- Zakazy dla implementatora (sprawdź, czy dotrzymane): assessment.json bez zmian STATUSÓW;
  `docs/archive/**` nietknięte poza NOWYM plikiem `oceny-95.json` (+ README archiwum);
  `docs/evidence/**` nietknięte; lockfile nietknięty; `pnpm verify` = 0.

## Obowiązkowe próby negatywne (WYKONAJ je samodzielnie na KOPIACH w /tmp — nigdy nie mutuj repo;
   skrypty czytają ścieżki względem swojej lokalizacji, więc kopia repo w /tmp działa):

1. Usunięcie jednego kryterium z kanonu → czy `check:acceptance` OBLEWA (exit ≠ 0)?
2. Zmiana statusu jednego kryterium w ocenach → czy OBLEWA (dryf wygenerowanych plików)?
3. Duplikat ID kryterium → czy WYKRYWA?
4. Rozjazd 95/200: usunięcie pola `historical` / kryterium → czy `check:matrix` WYKRYWA i oblewa?
5. Podręczny raport pochodny (ręcznie wpisane sumy w docs/ACCEPTANCE.md na kopii) → czy `check:matrix`
   ODRZUCA jako przestarzały/sfałszowany?
Dla każdej próby: komenda, kod wyjścia, fragment wyjścia. Próba „na zielono”: wszystkie trzy bramki
(check:acceptance, check:matrix, check:closure) na NIEZNIECONEJ kopii → exit 0 i ta sama liczba 200
w podsumowaniach.

## Dodatkowe pytania recenzenckie (na podstawie raportu implementatora)

A. Implementator zgłasza, że kontrola tabel archiwalnego FEEDBACK.md „wygasła” ze starym
   check:matrix — zweryfikuj: CO dokładnie strzeże dziś archiwum (które pliki, które asercje)?
   Czy utrata wewnętrznej kontroli FEEDBACK.md tworzy realne ryzyko (plik zamrożony w docs/archive)?
   Twój werdykt: akceptowalne / Critical.
B. Przepięcie `oceny-95.json` — czy translokacja była VERBATIM (porównaj losowo 10 wpisów z
   dawnym obiektem A w diffie — treści nie mogły się zmienić)?
C. Czy nowy `tests/matrix-gates.test.ts` asertuje POWÓD oblewania (komunikat), a nie sam kod wyjścia?
D. Czy cokolwiek w nowym kodzie wpisało liczbę kryteriów/statusów ręcznie poza stałą EXPECTED?
E. Czy `pnpm verify` na worktree rzeczywiście = 0 (uruchom; raport implementatora twierdzi 1067 testów).

## Wynik

Zapisz recenzję do: `docs/versions/v0.4/archive/domkniecie-2026-09/etap1-c-review.md`:
- Werdykt zgodności ze specem: ✅/❌ + lista braków/nadmiarów (co w briefie, czego brak; co poza briefem).
- Werdykt jakości: zatwierdzony/odrzucony.
- Wyniki 5 prób negatywnych + próby „na zielono" (komenda, exit, dowód).
- Findings: Critical / Important / Minor, każde z plikiem, linią i proponowaną naprawą.
- Odpowiedzi na pytania A–E.
Zwróć TYLKO: oba werdykty, liczbę findings per kategoria, odpowiedź na A w 2 zdaniach.

## Zakazy

Nie commituj, nie zmieniaj plików repo (nawet w worktree), nie wypychaj, nie instaluj zależności
na nowo (`pnpm install --frozen-lockfile` dozwolony, jeśli worktree nie ma node_modules), nie
uruchamiaj `pnpm test:e2e` (długi; verify wystarcza).
