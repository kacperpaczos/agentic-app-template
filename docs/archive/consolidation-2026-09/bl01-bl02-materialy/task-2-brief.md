## Task 2: BL-01 — sortowanie, paginacja, kontrolki filtra i stan widoku w kontekście agenta

**Gałąź/worktree:** `t2-stan-widoku`. **Kryteria:** **L2.17**; wkład do L6.17 (stan po akcji w
kontekście), T26. **Zależy od:** Task 1.

**Musi:**
1. Stan widoku w adresie wg AD-6 dla instancji głównej `DataTable`: sortowanie wg typu pola
   (liczby/kwoty liczbowo, daty chronologicznie, tekst `localeCompare('pl')`, puste na końcu),
   strona z `pageSize`, reset strony przy zmianie filtra lub sortowania, strona spoza zakresu
   przycinana i raportowana. Rozszerzona odmowa kluczy zarezerwowanych (`c`, `s`, `sort`, `page`).
2. **Kontrolki użytkownika:** nagłówki sortowalnych kolumn jako przyciski z `aria-sort`, pasek
   zawężenia z polami dla pól `UiTarget.filter` (lista wyboru dla `values`, pole tekstowe dla
   pozostałych — `contains`), wyczyszczenie, paginacja „Poprzednia/Następna, strona X z Y”. Obsługa z
   klawiatury, etykiety, widoczny fokus. Każda zmiana to nawigacja (Wstecz cofa). Pasek nad widokiem
   opisuje też sortowanie i stronę.
3. **Akcje agenta:** `uiCommandSchema.sort` (`{field, direction}` | `null` = wyczyść) i
   `UiCommandResult.sorted?`, `page?`; narzędzie `ui_sort` w `agent/tools/ui-sort.ts`
   (`targetId`, `field?`, `direction?`, `clear?`, `reason?`), odmowy po nazwie z listą dozwolonych
   (`unknown_field` albo nowy kod `not_sortable`), `not_applied`, gdy żadna instancja nie zastosowała
   sortowania; `ui_catalog` zwraca `sortableFields`. Wynik `ui_filter` niesie informację o stronie.
4. **Kontekst:** stan aktywnego widoku trafia do `useAppState` i `toAppContext().filters =
   { [targetId]: { predicates, sort, page, matched, total } }` w chwili wysłania; `get_context` i prompt
   pokazują go; prompt uczy `ui_sort` i mówi, że filtr/sortowanie zmieniają prezentację, nie dane.

**Poza zakresem:** snapshot i wersjonowanie (Task 3), odsłanianie rekordu (Task 6).

**Testy i dowody (minimum):**
- Vitest: kodowanie/dekodowanie `sort`/`page`, klucze zarezerwowane, porządek wg typów, matematyka
  stron, mapowanie do `AppContext.filters`, odmowy `ui_sort`.
- E2E skryptowane (port 8798, `.e2e-scripted-viewstate`): (a) agent ustawia zawężenie i sortowanie →
  kolejność wierszy zgodna z posortowanymi danymi z `/api/read`, kontrolki pokazują stan
  (`aria-sort`, wartości pól), adres zawiera parametry, **dane backendu niezmienione** (porównanie
  przed/po); (b) użytkownik zmienia pole zawężenia w kontrolce → wiersze, adres i pasek; (c)
  paginacja z więcej niż jedną stroną (test dopisuje rekordy do **własnej** bazy przed startem
  instancji) i Wstecz; (d) kolejne polecenie wysłane z GUI niesie w `app_context` wykonania
  (`GET /api/conversations/:id/runs` lub przechwycone żądanie) zawężenie i sortowanie; (e) negatywne:
  niezadeklarowane pole sortowania odrzucone i widok nietknięty; zawężenie do zera wierszy pokazuje
  stan pusty „0 z N”, nie błąd; wyczyszczenie przywraca pełny zakres i stronę 1.
- `e2e/view-filter.spec.ts` i `e2e/composed-views.spec.ts` zielone.

---

