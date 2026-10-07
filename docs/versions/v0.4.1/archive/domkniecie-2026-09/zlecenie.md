# PLAN: Zlecenie — kontrolowane dokończenie AgenticApp (2026-09-20)

Źródło: prompt właściciela w tej sesji. Rolą orkiestratora jest koordynacja, delegowanie
implementacji subagentom, niezależny review, integracja, bramki jakości, raporty. Praca w
`worktree integracja` (gałąź `domkniecie/integracja`).
Zakaz: praca w `lokalny katalog AgenticApp`, modyfikacja instancji 8791, push bez decyzji właściciela.

## Zadania (etapy)

- ETAP 0: inwentaryzacja bez zmian kodu + `docs/RAPORT-STARTU-DOMKNIECIA.md` — **ZROBIONE** (raport skommitowany).
- ETAP 1 (P0): naprawa bramki macierzy. Subagent A (analiza, read-only) → Subagent B (patch, jedna
  kanoniczna macierz; check:acceptance i check:matrix czytają to samo źródło; rozjazd = błąd; zero
  ręcznych liczb) → Subagent C (review negatywny: usunięcie kryterium, zmiana statusu, duplikat ID,
  rozjazd 95/200, pochodny raport nie może udawać aktualnego). Po scaleniu: check:acceptance,
  check:matrix, check:closure + własny test negatywny. Nie iść dalej, dopóki podsumowania nie pokażą
  tej samej liczby.
- ETAP 2: weryfikacja/domiekanie straż izolacji testów (brak domyślnego 8791, jawny APP_BASE_URL,
  etykieta instancji, PID, katalog danych, realpath, blokada katalogu użytkownika, tworzenie/usuwanie
  instancji testowej, SHA w dowodach). Uwaga: znaczna część już istnieje — scope = audyt kompletności + dziury.
- ETAP 3: analiza ostrzeżeń Mastra storage (in-memory); decyzja wariant A (trwały storage + test
  restartu) albo B (jawne ograniczenie: kryteria restartu unverified, bez ukrywania ostrzeżeń).
- ETAP 4: odczyt istniejących dowodów (z11-bl03, z10-bl09, z12-bl04) + `docs/evidence/REUSE-MATRIX.md`.
- ETAP 5: prace bez prawdziwego modelu przeciw RZECZYWISTYM otwartym kryteriom (lista w zleceniu
  była ze starej macierzy 95 — ruling w raporcie startowym §7). Rdzeń: przebudowa strażnika
  narzędzi plikowych (L11.4/L11.11 — czerwony test już istnieje i oblewa).
- ETAP 6: próby modelowe T15→T16→T17 (ew. T14) — zamrożone do czasu przywrócenia dostępu org;
  preflight obowiązkowy.
- ETAP 7: dwóch recenzentów na pakiet (jakość testów + bezpieczeństwo); recenzent ≠ autor.
- ETAP 8: integracja końcowa, verify x2 (drugi na świeżym checkoutcie), skan sekretów, brak ścieżek
  lokalnych/danych użytkownika.
- Raport końcowy: `docs/RAPORT-DOMKNIECIA-PLATFORMY.md` aktualizacja; statusy: confirmed/partial/
  unverified/blocked-by-access/library-limit/out-of-scope/failed. Publikacja tylko po decyzji właściciela.

## Global constraints

- Każdy pakiet w osobnym worktree; osobny recenzent; recenzent nie autorem.
- Testy przeglądarkowe: nie dwa na tym samym porcie; osobne bazy danych.
- Dowody tylko z jawnym przełącznikiem, bez nadpisywania; każdy dowód: commit, Node, pakiety,
  SDK/CLI, model, tryb, port, katalog danych, wynik, koszt tur.
- Raporty generowane z macierzy; zero ręcznych sum.
- Publikacja: osobna decyzja właściciela.
- 2 przebiegi bez postępu = pakiet `blocked`; pełna regresja tylko po integracji pakietu.
- Dane użytkownika nietykalne; Claude wyłącznie z subskrypcji; tury 21/25 (4 wolne, T15=4).
- Kryterium wymagające prawdziwego modelu NIGDY nie jest domykane stand-inem.

## Rulings orkiestratora (na starcie)

1. Lista ETAP 5 ze zlecenia (L1.2…) pochodzi ze starej macierzy 95; program przeciw otwartej 13-tce
   z assessment.json (raport startowy §7).
2. Rozjazd 200/95: dwie różne macierze (bieżąca vs archiwum historyczne); naprawa ETAP 1 = jedna
   kanoniczna macierz bieżąca + jawnie oddzielona kontrola archiwum (szczegóły po mapie A).
3. ETAP 2: straż już istnieje (raport §6) — scope to audyt kompletności względem checklisty zlecenia.
4. Port 8791 nie działa (zmiana vs założenie zlecenia) — odnotowane, instancji nie uruchamiam.
5. „Zielona bramka” ETAP 8 = spójność macierzy, przechodzące bramki i uczciwe statusy; 13 otwartych
   kryteriów pozostaje widocznych w macierzy (klasyfikacja końcowa: decyzja właściciela §10.4).
