# Brief: ETAP 2 / audyt izolacji testów (READ-ONLY)

Repo: `worktree integracja` (HEAD 65684de). Kontekst:
właściciel wymaga, aby testy i próby NIGDY nie dotknęły instancji użytkownika (port 8791, jej
katalog danych, poświadczenia) ani danych użytkownika. Część straż już istnieje (raport §6
RAPORT-DOMKNIECIA-PLATFORMY.md wymienia porażki, które zamknięto: domyślne porty, etykiety
instancji, fingerprint poświadczeń, realpath-walk). Twoje zadanie: sprawdzić KOMPLETNOŚĆ wobec
checklisty poniżej i wskazać dziury — bez poprawiania czegokolwiek.

## Checklista (dla każdego punktu: istnieje? gdzie — plik:linia; jak jest egzekwowane — kod/test;
   jaka jest dziura?)

1. Testy nigdy nie celują domyślnie w port 8791 (sprawdź: playwright.config.ts, e2e/support/*,
   scripts/*, apps/*/vite.config, domyślne APP_BASE/APP_DEV_API_PORT; poszukaj literalu 8791
   i pokaż KAŻDE wystąpienie + kontekst — jest zakazane jako domyślne, dozwolone tylko jako
   jawnie chroniona wartość w strażniku).
2. Jawny APP_BASE_URL/APP_BASE wymagany przed pierwszym żądaniem (gdzie walidacja, co gdy brak).
3. Etykieta instancji sprawdzana na /api/health przed pierwszym żądaniem (które ścieżki sprawdzają:
   proxy dev, acceptance, run-agent, e2e support; czy wszystkie ścieżki zapisujące?).
4. PID i katalog danych: czy testy zapisują/odczytują PID i katalog danych instancji, czy jest
   kontrola, że instancja działa z katalogu testowym (nie użytkownika).
5. realpath i dowiązania: util/real-path.ts — co obejmuje, jakie ma testy zdolności wykrycia,
   czy wszystkie ścieżki otwarcia plików w strażnikach idą przez fizyczne rozwiązanie.
6. Blokada działającego katalogu danych użytkownika: czy istnieje straż odmawiająca działania,
   gdy katalog danych wskazuje na katalog użytkownika (~/.local/share/... , ~/Documents/AgenticApp,
   fingerprint poświadczeń) — gdzie, jakie testy.
7. Tworzenie i usuwanie instancji testowej: procedura w e2e/support (fixtures/scripted) — czy
   każdy spec dostaje własny katalog i port, czy porządki są pewne (poszukaj .e2e-* katalogów,
   globalTeardown), czy jest test negatywny „test skierowany na 8791 kończy się odmową przed
   zapisem".
8. Dowody z SHA: czy każda nowa koperta dowodowa zawiera commit/SHA i wersje (POCHODZENIE.json,
   rundy w docs/evidence/*/runs/) — wynik zapisano, czy brak.
9. Bonus: czy `pnpm acceptance` / scripts/run-agent.mjs mają ten sam straż (etykieta, port) co e2e.

## Wynik

Zapisz raport do: docs/versions/v0.4/archive/domkniecie-2026-09/etap2-a-audyt.md —
tabela: punkt checklisty | status (OK/częściowe/brak) | dowód (plik:linia) | dziura | ryzyko.
Na końcu: lista dziur uszeregowana po ryzyku, z propozycją minimalnej naprawy każdej.
W odpowiedzi zwrotnej TYLKO: status, ścieżka, 5 zdań (ile punktów OK, jakie 2–3 dziury najważniejsze).

## Zakazy

Zero zmian plików, zero uruchamiania testów (mogą dotykać portów/instancji), zero instalacji.
