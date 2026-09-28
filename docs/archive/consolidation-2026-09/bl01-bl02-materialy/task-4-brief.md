## Task 4: BL-02 — przestrzeń „Widoki agenta”, walidacja kompozycji i narzędzia

**Gałąź/worktree:** `t4-widoki-agenta`. **Kryteria:** **L3.15**, **L3.16**, **L3.17**, część
agentowa **L3.14**; wkład do L3.3, L3.12. **Zależy od:** Task 1.

**Musi:**
1. **Walidator** `packages/platform-server/src/registry/openui-validation.ts` na `@openuidev/lang-core`:
   parsuje źródło, zbiera wywołania komponentów i ich argumenty; odrzuca nieznane komponenty, błędy
   składni i źródła częściowe, komponenty danych z niezarejestrowaną operacją lub wejściem
   niezgodnym ze schematem, pola (`columns`, `x`, `series`, `fields`, `filter.field`, `sort.field`,
   `groupBy`) spoza deskryptora oraz serie nienumeryczne. Tryb `agent-views` z jawną listą
   dozwolonych komponentów (AD-8). Używany przez `ComponentCatalog.validate` dla każdej karty `openui`
   (nieznany komponent zawsze odrzucony) i przy starcie dla `ServerModule.views` (niepoprawny widok
   modułu zatrzymuje start z czytelnym błędem). Serwerowa lista komponentów zgodna z biblioteką
   przeglądarki — test zgodności nazw.
2. **Przestrzeń rozmowy:** `canvas.ensureScopedSpace` z zakresem `conversation:<id>`; usunięcie
   rozmowy usuwa jej przestrzeń widoków (bez osieroconych rekordów).
3. **Narzędzia** `agent/tools/agent-views.ts`: `agent_views_list`, `agent_view_create {title, source,
   operationId?}`, `agent_view_update {cardId, source? | patch?, title?, expectedSpecVersion?,
   operationId?}` (patch = instrukcje OpenUI Lang scalane z istniejącą kompozycją przez
   `mergeStatements`, pozostałe instrukcje bez zmian), `agent_view_remove {cardId}`. Zawsze przestrzeń
   rozmowy wykonania; karta innej rozmowy lub właściciela odrzucona; emisja `canvas_changed`.
4. **Komponenty:** `DataTable.groupBy?` (grupy z nagłówkami, liczność) i przełączanie
   `DataChart.kind` — oba jako zmiana kompozycji; stan użytkownika w karcie (np. rozwinięcia, geometria)
   przeżywa zmianę treści.
5. **UI:** strona `AgentViewsPage` (platform-ui) na `/agent-views` (router w warstwie składania),
   pozycja „Widoki agenta” w menu platformy, cel `platform.agentViews`; pokazuje przestrzeń aktywnej
   rozmowy (z `c`), **bez zmiany** roboczej przestrzeni użytkownika (`s`); stany: brak rozmowy, brak
   widoków, błąd; kompozycje przeżywają przeładowanie i przełączenie rozmowy.
6. **Prompt:** kiedy tworzyć/zmieniać widok agenta, dobór formy do intencji bez nazwy komponentu od
   użytkownika, wyłącznie komponenty danych z operacjami i polami z listy, zmiana istniejącego widoku
   przez `patch`, zakaz wpisywania wartości, jawne ujawnienie ograniczenia katalogu, brak samowolnej
   nawigacji.

**Poza zakresem:** akcje rekordu i dowód odświeżania po mutacji (Task 7); ekrany szczegółów modułu
(Task 5).

**Testy i dowody (minimum):**
- Vitest walidatora i narzędzi: każdy rodzaj odrzucenia z komunikatem, poprawne przyjęte, patch
  zachowuje inne instrukcje, zakres rozmowy i właściciela, usunięcie rozmowy, start z niepoprawnym
  widokiem modułu odrzucony.
- E2E skryptowane (port 8798, `.e2e-scripted-agentviews`): wykonanie woła prawdziwe
  `agent_view_create` (tabela z `procurement.comparison`) i drugi raz (wykres) → w „Widoki agenta”
  (otwartych z nawigacji) widać nowe karty o identyfikatorach zwróconych w tym wykonaniu; wartości
  równe `/api/read`; podpis wykresu (serie, jednostka, zakres) zgodny z backendem; `agent_view_update`
  z patchem zmienia grupowanie/typ, druga karta i zmieniona przez użytkownika geometria bez zmian;
  przeładowanie i przełączenie rozmów odtwarzają kompozycje właściwej rozmowy. Negatywne: nieznany
  komponent odrzucony i poprzednia wersja widoczna; wykres z literalnymi liczbami odrzucony;
  niezarejestrowana operacja odrzucona; wykonanie rozmowy A tworzy widok, gdy użytkownik jest w B —
  adres i ekran B bez zmian, widok A nie pojawia się w B.

---

