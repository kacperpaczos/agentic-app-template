# Brief: ETAP 3 — faktografia ostrzeżeń Mastra storage (READ-ONLY)

Repo: `worktree integracja`. Pytanie właściciela:
`No storage configured on Mastra — falling back to an in-memory store.` — gdzie to występuje,
czy jest zamierzone i czy któraś asercja testowa opiera się na trwałości, której in-memory
nie daje. Orkiestrator podejmie decyzję (wariant A: trwały storage + test restartu / wariant B:
jawne ograniczenie), ale potrzebuje BEZBŁĘDNEJ faktografii.

## Zadanie (odczyt, zero zmian, zero uruchamiania testów)

1. Gdzie tworzona jest instancja Mastry: produkcja (`packages/platform-server/src/`), testy
   (`tests/`), e2e wsparcie (`e2e/support/`), skrypty (`scripts/`). Dla każdego miejsca: plik:linia,
   czy podano `storage`, jaki.
2. Jak wygląda warstwa trwałości aplikacji poza Mastrą: SQLite/Drizzle (`app.db`), które dane
   (rozmowy, przebiegi, zdarzenia, karty, pliki, artefakty) są w własnej bazie, a które Mastra
   trzymałaby w swoim storage (wątki? wiadomości? przebiegi?). Kluczowe: czy testy twierdzące
   „po restarcie wraca stan" używają własnej bazy (wtedy ostrzeżenie Mastry jest niegroźne),
   czy pamięci Mastry.
3. Które testy emitują lub mogą emitować ostrzeżenie: grep po `new Mastra`, `storage`, po treści
   ostrzeżenia w `node_modules/@mastra/core` (znajdź źródło komunikatu i warunek jego emisji —
   plik:linia w node_modules, wersja 1.66.0).
4. Które testy twierdzą coś o restarcie/trwałości/wznowieniu: grep po `restart`, `reboot`,
   `reconcileOnBoot`, `resume`, `durability`, `afterRestart` — dla każdego: co asertuje i na jakiej
   warstwie danych (własna baza vs Mastra storage vs proces).
5. Czy cokolwiek w repo używa `@mastra/libsql` / `@mastra/sqlite` / innego adaptera storage
   (package.json, lockfile) — czyli czy wariant A ma dostępny adapter bez zmiany zależności.
6. Lista testów, gdzie in-memory jest JAWNIE zamierzony (nazwa, komentarz), vs testów, gdzie
   ostrzeżenie przecieka przypadkiem.

## Wynik

Zapisz raport do: `docs/versions/v0.4/archive/domkniecie-2026-09/etap3-mapa.md`
— tabelą: miejsce | storage? | ostrzeżenie? | testy dotknięte | asercje o trwałości | wniosek
(zamierzone/przypadkowe/groźne). Każde twierdzenie z plikiem i linią. W odpowiedzi zwrotnej TYLKO:
status, ścieżka raportu, 5-zdaniowe podsumowanie (w tym: czy KtóRKOLWIEK asercja o restarcie
opiera się na pamięci Mastry — tak/nie i dowód).
