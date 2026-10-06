# Brief: ETAP 3 / Subagent C — recenzja pakietu storage Mastry

Jesteś niezależnym recenzentem (NIE autorem). Pakiet ETAPU 3 w worktree:
`lokalny katalog worktree szablonu/etap3-mastra` (gałąź `domkniecie/etap3-mastra-storage`,
HEAD `9bbe77d`, BASE `b9467ac`, 3 commity, 5 plików, +157/−2).

Materiały:
1. Brief: `docs/versions/v0.4/archive/domkniecie-2026-09/etap3-b-brief.md`
2. Faktografia: `docs/versions/v0.4/archive/domkniecie-2026-09/etap3-mapa.md`
3. Raport implementatora: `docs/versions/v0.4/archive/domkniecie-2026-09/etap3-b-report.md`
4. Diff: `lokalny katalog worktree szablonu/etap3-mastra/.superpowers/sdd/zlecenie/review-b9467ac..9bbe77d.diff`

## Soczewka recenzencka

1. **Jawny storage w runtime.ts**: czy `InMemoryStore` importowany z PUBLICZNEGO eksportu
   `@mastra/core/storage` (nie ścieżek wewnętrznych dist)? Czy komentarz mówi uczciwie, PO CO
   (magazyn martwy, trwałość we własnej SQLite) i wskazuje dokument decyzji? Czy konfiguracja
   nie zmienia zachowania aplikacji poza zniknięciem ostrzeżenia (diff 13 linii — obejrzyj cały)?
2. **Strażnik w tests/runtime.test.ts**: czy asertuje DOKŁADNIE ten komunikat (pierwsze zdanie),
   czy jest nadmiernie luźny (np. sam „storage")? Czy potrafi oblać przy usuniętej konfiguracji
   (implementator pokazał mutację — powtórz ją TY na kopii w /tmp lub przez git stash w worktree
   i przywróć; worktree musi zostać czysty).
3. **tests/observability.test.ts**: czy jawny storage w instancjach obserwowalności zachowuje
   cel testu (punkt wpiecia telemetrii) i nie osłabia istniejących asercji?
4. **Dokumentacja**: czy sekcja w docs/observability.md i wpis T10 w FEEDBACK.md mówią: czego
   ostrzeżenie dotyczyło, co wykazała faktografia, dlaczego wariant A odrzucony (zero nowej
   zależności), co się zmieniło? Czy NIE twierdzi fałszywie, że „ostrzeżenie wyłączono"?
5. **Zakazy**: diff NIE może dotykać assessment.json, docs/evidence, lockfile, e2e, skryptów
   macierzowych, server-guard.mjs. Weryfikacja: `git diff --stat b9467ac..9bbe77d` vs lista plików.
6. **Verify**: uruchom `pnpm verify` w worktree (twierdzenie: 71/1131/0) i potwierdź.
7. **Głębokojsza pytanie**: czy jawny InMemoryStore w produkcji mógłby kogokolwiek wprowadzić w
   błąd (ktoś uzna, że „storage skonfigurowany = trwałość")? Jeśli tak — czy komentarz/dokument
   wystarczająco temu zapobiega?

## Wynik

Recenzja do: `docs/versions/v0.4/archive/domkniecie-2026-09/etap3-c-review.md`
(werdykt spec ✅/❌, werdykt jakości, findings Critical/Important/Minor z plik:linia, wyniki
własnych prób, odpowiedź na pkt 7).
Zwróć TYLKO: oba werdykty, liczby findings, odpowiedź na pkt 7 w jednym zdaniu.

## Zakazy

Nie commituj, nie mutuj repo (poza odwracalną próbą mutacyjną z natychmiastowym przywróceniem),
nie uruchamiaj e2e, nie dotykaj innych worktree.
