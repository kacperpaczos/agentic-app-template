# Brief: ETAP 2 / Subagent C — recenzja pakietu izolacji (recenzent bezpieczeństwa + jakości)

Jesteś niezależnym recenzentem (NIE autorem). Pakiet ETAPU 2 w worktree:
`lokalny katalog worktree szablonu/etap2-izolacja` (gałąź `domkniecie/etap2-izolacja`,
HEAD `a269d6e`, BASE `bf97be6`, 7 commitów, 17 plików, +1980/−49).

Materiały (w tej kolejności):
1. Brief implementatora: `docs/versions/v0.4/archive/domkniecie-2026-09/etap2-b-brief.md`
2. Audyt wejściowy (lista dziur z dowodami): `docs/versions/v0.4/archive/domkniecie-2026-09/etap2-a-audyt.md`
3. Raport implementatora (z obawami 1–5): `docs/versions/v0.4/archive/domkniecie-2026-09/etap2-b-report.md`
4. Pełny diff: `lokalny katalog worktree szablonu/etap2-izolacja/.superpowers/sdd/zlecenie/review-bf97be6..a269d6e.diff`

## Soczewka bezpieczeństwa (Twój priorytet — zlecenie właściciela)

Ten pakiet istnieje, żeby żaden test/próba nie dotknął instancji użytkownika (port 8791, jej katalog
danych, poświadczenia). Sprawdź wprost:
- **TOCTOU**: między sprawdzeniem a użyciem — czy odmowa na żywym katalogu/porcie jest tuż przed
  aktem użycia (start serwera / pierwsze żądanie), czy da się wcisnąć się w okno? Czy sonda portu
  i sprawdzenie pidfile wykluczają podmianę?
- **Fail-open vs fail-closed**: każdy nowy strażnik — co robi, gdy dane niejednoznaczne (brak pliku,
  brak /proc, nieczytelny pidfile)? Odmowa musi być domyślna tam, gdzie ryzyko dotknięcia danych
  użytkownika.
- **Ścieżki i dowiązania**: czy nowe odmowy używają fizycznego rozwiązania ścieżek (real-path) czy
  leksykalnego porównania? Czy da się obejść prefiks `.e2e` dowiązaniem?
- **Poświadczenia**: czy hash poświadczeń jest read-only? Czy treść (nie odcisk) gdziekolwiek
  trafia do logów/dowodów? Czy porównanie odcisku da się pominąć częstą ścieżką (patrz obawa 4
  implementatora — crash nadrzędnego)?
- **Komunikaty odmowy**: czy nie ujawniają treści plików ani odcisków tokenów?
- **Zakaz globalny**: czy `packages/platform-server/src/config.ts` naprawdę nietknięty (diff)?
  Czy `pnpm start` bez etykiety działa jak dotychczas (test, który to kotwiczy)?

## Werdykty wymagane

1. Zgodność ze specem (brief + dziury 1–6 audytu: czy każda naprawiona, czy testy pokrywają).
2. Jakość (zatwierdzony/odrzucony).
3. Odpowiedź na 5 obaw implementatora: każda — akceptowalna jako decyzja / wymaga poprawki (której).
4. Ocena obawy 2 (zaostrzenie acceptance — jawne zmienne środowiskowe): zgodna z intencją
   właściciela („wymagaj jawnego APP_BASE_URL") czy przesadzona?

## Próby (na KOPIACH/tmp lub w worktree, bez mutowania repo)

- Uruchom `pnpm verify` w worktree (twierdzenie: 1125 testów) — potwierdź.
- Wybierz 3 nowe testy negatywne (żywy katalog → odmowa; zajęty port → odmowa z pidem; brak
  RUN_ID → odmowa przed zapisem) i uruchom je celowane (vitest run <plik>) — czy oblewają właściwy
  przypadek, czy asertują POWÓD odmowy?
- Sprawdź, czy żaden nowy test nie czyta prawdziwego poświadczenia użytkownika (grep po
  ścieżkach ~/.claude, .credentials — tylko przez stałe strażników).

## Wynik

Recenzja do: `docs/versions/v0.4/archive/domkniecie-2026-09/etap2-c-review.md`
(werdykty 1–4, findings Critical/Important/Minor z plik:linia, wyniki prób z komendami).
Zwróć TYLKO: werdykty 1–2, liczby findings, werdykt na obawy w jednej linii.

## Zakazy

Nie commituj, nie mutuj repo, nie uruchamiaj pełnego `pnpm test:e2e` (16 min — implementator już
to zrobił; wystarczy verify + testy celowane), nie dotykaj innych worktree, nie uruchamiaj
żadnych skryptów startujących serwery na portach poza harnesem testowym.
