## Task 8: Próby odbiorowe z prawdziwym modelem — T25, T26, T27

**Gałąź/worktree:** `t8-proby-model`. **Kryteria:** dowody „rzeczywisty model” dla BL-01 i BL-02.
**Zależy od:** Task 1–7 scalone.

**Musi:**
1. Spec `e2e/bl01-bl02-model.spec.ts` na instancji wspólnej (prawdziwy model), start z GUI
   (kompozytor), asercje wyłącznie na DOM, adresie, potwierdzeniach UI, snapshotach i danych backendu —
   nigdy na brzmieniu odpowiedzi.
   - **T25:** pytanie o wartość pola rekordu spoza bieżącego widoku i ukrytego zawężeniem → właściwy
     widok, podświetlone właściwe pole, `revealed` zgodne z backendem, nowa wersja `ui_state`.
   - **T26:** polecenie zawężenia i sortowania → kontrolki i wiersze zgodne; kolejne pytanie w tej
     samej rozmowie korzysta z zawężenia (wykonanie ma je w `app_context`; model wywołuje `ui_state`
     lub odpowiada o zawężonym zbiorze); usunięcie zawężenia przywraca pełny zakres; dane backendu bez
     zmian.
   - **T27:** otwarcie „Widoki agenta”, zestawienie bez nazwy komponentu, dodanie wykresu, zmiana
     zakresu rozmową, mutacja danych, przeładowanie → nowe identyfikatory z tego wykonania, wartości
     równe backendowi, pozostałe karty zachowane, odświeżenie po mutacji.
2. Kontrole negatywne na poziomie próby: odpowiedź tekstowa bez wskazania pola nie zalicza T25;
   zmiana danych zamiast filtra oblewa T26; zastana karta i wartości niezgodne z backendem oblewają
   T27. Kontrole deterministyczne z zadań 2–7 wskazane w raporcie.
3. Budżet: najwyżej 12 tur modelu łącznie z powtórzeniami; każdy przebieg (także nieudany) zapisany w
   `docs/evidence/bl01-bl02-2026-09-17/` (JSON z identyfikatorami wykonań, wersją kodu, wynikiem,
   zrzuty) bez sekretów.

---

## 4. Mapa styków (pre-flight) i reguły scalania

| Para | Wspólny plik / interfejs | Producent → konsument | Ryzyko i reguła |
|---|---|---|---|
| T1 → wszystkie | `views.ts`, `agent/tools/*`, `DataTable`, `uiSemantics`, `useReadOperation`, krok `call` | T1 produkuje | Kontrakty zamrożone po scaleniu T1; zmiana wymaga zgody koordynatora. |
| T2 × T3 | `UiCommandRunner.perform`, `appState.toAppContext`, `prompt.ts`, scenariusze skryptowane, powłoka | T2: stan widoku i sort; T3: snapshot i `uiVersion` | T3 czyta stan tylko z `uiSemantics`, nie z wnętrza `DataTable`. Konflikty tekstowe rozwiązuje koordynator przy scaleniu. |
| T2 × T4 | `DataTable` | T2: sort/strona; T4: `groupBy` | T4 dodaje grupowanie jako wydzieloną funkcję i minimalne wpięcie w render. |
| T4 × T5 | `ServerModule.views`, router | T4: walidacja widoków przy starcie; T5: nowe widoki | Po scaleniu obu `pnpm verify` musi przejść — kompozycje T5 muszą przejść walidator T4. |
| T6 ← T2, T3, T4, T5 | adres strony/filtra, `uiVersion`, parser kompozycji, widoki szczegółów | konsument | Fala 2 startuje po scaleniu całej fali 1. |
| T7 ← T4, T5 | narzędzia widoków agenta, `procurement.case_offer_items` | konsument | Jw. |
| T8 ← wszystkie | całość | konsument | Po scaleniu fali 2 i przeglądzie. |

Scalanie: gałąź zadania po pozytywnym review → `git merge --no-ff` do `bl01-bl02/integracja` →
`pnpm verify` na gałęzi integracyjnej. Konflikt nietrywialny: implementator zadania scala gałąź
integracyjną do swojej, rozwiązuje, ponawia bramkę G10, a zakres scalenia przechodzi review.

## 5. Odbiór przez koordynatora (po Task 8)

1. Przegląd całej gałęzi (najmocniejszy model) z listą odroczonych uwag z ledgera.
2. Niezależna weryfikacja w **świeżym** worktree gałęzi integracyjnej: `pnpm install
   --frozen-lockfile`, `pnpm verify`, pełne `pnpm test:e2e` (pod blokadą), `pnpm check:module-swap`,
   start produkcyjny na porcie testowym; porównanie stanu instancji użytkownika z zapisem bazowym.
3. Ocena kryteriów wyłącznie na podstawie dowodów z tego kodu → `assessment.json`,
   `pnpm acceptance:render`, `FEEDBACK.md`, `NEW-APPLICATION.md`, `README.md` (jeśli dotyczy),
   raport architekta w `docs/RAPORT-ARCHITEKTA-BL01-BL02.md`.
