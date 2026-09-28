## Task 5: BL-02 — ekrany szczegółów modułu jako kompozycje

**Gałąź/worktree:** `t5-ekrany-modulu`. **Kryteria:** część „widoki domyślne” **L3.14**; wkład do
L2.1. **Zależy od:** Task 1.

**Musi:**
1. `/cases/$caseId` i `/items/$itemId` jako `ViewDefinition` z `params` (`$caseId`, `$itemId`),
   renderowane przez `ComposedView`; ustawianie zasobu i przestrzeni przy otwarciu sprawy zostaje w
   deterministycznym opakowaniu trasy.
2. Części tabelaryczne jako `DataTable` na nowych odczytach z deskryptorami, w tym
   `procurement.case_offer_items` (rekord `offer_item`, `idField` pozycji, pola: dostawca, nazwa,
   jednostka, ilość `quantity_milli`, cena jednostkowa `money_minor` z walutą, waluta). Części
   nietabelaryczne jako komponenty OpenUI modułu (`defineComponent`, typowane propsy).
3. Zachowane `data-testid` (`case-detail-page`, `provenance-page`), linki i teksty, na których opierają
   się istniejące testy; wszystkie wartości z backendu.

**Poza zakresem:** karty canvasu sprawy (pozostają specyfikacjami `component`), akcje rekordu (Task 7).

**Testy i dowody (minimum):** Vitest nowych odczytów (właściciel, brak rekordu, deskryptor);
e2e: rozszerzenie `e2e/composed-views.spec.ts` o oba ekrany (wartości równe backendowi, `data-view-id`,
brak rekordu → stan „nie istnieje”); `e2e/app.spec.ts` i `e2e/session-restore.spec.ts` zielone.

---

