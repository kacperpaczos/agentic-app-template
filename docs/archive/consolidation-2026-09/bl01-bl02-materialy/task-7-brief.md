## Task 7: BL-02 — odświeżanie po mutacji i interakcje widoków agenta

**Gałąź/worktree:** `t7-interakcje`. **Kryteria:** **L3.18**. **Zależy od:** Task 4, Task 5.

**Musi:**
1. Kontrakt akcji rekordu w deskryptorze odczytu (AD-9): `actions?: [{ id, label, tool, input:
   mapowanie kluczy wejścia narzędzia na `$record.<pole>` lub pole formularza, form?: [{ key, label,
   type }] }]` — narzędzie musi być narzędziem zapisu tego modułu (sprawdzane przy starcie).
2. `POST /api/actions { operation, action, recordId, values, operationId }`: właściciel z sesji,
   ponowny odczyt rekordu przez odczyt operacji, budowa wejścia, wywołanie handlera narzędzia przez
   rejestr (ten sam co MCP), idempotencja, odpowiedź ze zmienionymi zasobami; klient unieważnia
   `['read']` i `['module']`.
3. `DataTable` renderuje akcje rekordu (przycisk + mały formularz, dostępne z klawiatury) tak samo w
   widoku domyślnym i w widoku agenta; błąd pokazany, a nieaktualne dane nie udają świeżych.
4. Procurement: akcja zmiany ceny jednostkowej na `procurement.case_offer_items` przez istniejące
   narzędzie aktualizacji pozycji oferty.

**Testy i dowody (minimum):**
- Vitest `/api/actions`: sukces zmienia dane, idempotencja, walidacja, rekord innego właściciela
  odrzucony bez zmian, akcja wskazująca narzędzie odczytu lub obce odrzucona przy starcie.
- E2E skryptowane (port 8798, `.e2e-scripted-interactions`): widok agenta (utworzony prawdziwym
  narzędziem) z tabelą i wykresem nad danymi sprawy; (a) zmiana ceny akcją w widoku domyślnym →
  tabela i wykres widoku agenta pokazują nowe wartości bez przeładowania; (b) zmiana przez narzędzie
  MCP w wykonaniu (krok `call`) → oba widoki odświeżone; (c) akcja w widoku agenta → ta sama zmiana w
  backendzie i w widoku domyślnym. Negatywne: akcja na rekordzie drugiego właściciela odrzucona i
  dane bez zmian; nieudane odświeżenie pokazuje błąd, nie stare wartości.

---

