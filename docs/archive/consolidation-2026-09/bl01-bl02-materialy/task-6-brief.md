## Task 6: BL-01 — wskazanie wartości pola rekordu

**Gałąź/worktree:** `t6-wskazanie-wartosci`. **Kryteria:** **L2.16**, **L6.16**; T25.
**Zależy od:** Task 2, Task 3, Task 4 (parser kompozycji), Task 5 (widoki szczegółów jako kandydaci).

**Musi:**
1. Narzędzie `ui_show_value` (`agent/tools/ui-show-value.ts`): wejście `{ recordKind, recordId,
   field, targetId?, reason? }`. Serwer wyznacza kandydatów: widoki modułów i karty widoków agenta
   rozmowy, których kompozycja ma instancję danych z `record.kind = recordKind` i renderowanym polem.
   Wyniki rozróżnione: `unknown_field`, `no_renderer` (brak kandydata), `ambiguous` (więcej niż jeden
   kandydat bez `targetId`, z listą), `record_not_found`, `forbidden`, a po stronie klienta
   `inactive_conversation`, `not_present`, `no_client`.
2. Wartość backendu z odczytu kandydata (właściciel z sesji) **przed** komendą UI. Wynik narzędzia
   rozróżnia `found` (backend) od `shown` (potwierdzenie klienta) i podaje `matchesBackend`.
3. Klient: nawigacja do widoku, a gdy rekord ukrywa zawężenie lub paginacja — jawna zmiana prezentacji
   (wyczyszczenie lub zmiana zawężenia, przejście na stronę) przez ten sam adres co Task 2, zgłoszona w
   `adjustments`; przewinięcie i czasowe podświetlenie komórki `[data-record-kind][data-record-id]
   [data-field]`; potwierdzenie `{ executed, revealed: { recordKind, recordId, field, displayedText,
   rawValue, page, adjustments } }` i `uiVersion`. Dane biznesowe niezmienione.
4. Prompt: pytanie o wartość pola rekordu → wyszukanie rekordu narzędziem modułu, potem
   `ui_show_value`; odpowiedź tylko o tym, co potwierdził klient.

**Testy i dowody (minimum):**
- Vitest: wyznaczanie kandydatów 0/1/wiele, `unknown_field`, `record_not_found`, `forbidden` (drugi
  właściciel), `no_renderer` (pole nierenderowane), porównanie z backendem.
- E2E skryptowane (port 8798, `.e2e-scripted-showvalue`): rekord na drugiej stronie i ukryty zawężeniem
  → otwarty właściwy widok, zawężenie jawnie zmienione (pasek), właściwa strona, podświetlona komórka
  o właściwych atrybutach, `rawValue` = `/api/read`, snapshot `ui_state` z nową wersją. Negatywne:
  błędny identyfikator → `record_not_found` i ekran bez zmian; niejednoznaczność; brak dostępu;
  **kontrola detektora T25:** wykonanie, które odpowiada tylko tekstem, nie spełnia asercji próby.

---

