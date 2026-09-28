## Task 3: BL-01 — semantyczny opis aktywnego UI i świeżość kontekstu

**Gałąź/worktree:** `t3-opis-ui`. **Kryteria:** **L6.15**, **L6.17**. **Zależy od:** Task 1.

**Musi:**
1. Kontrakt `uiSnapshotSchema` (w `views.ts` albo osobnym pliku kontraktów) z limitami: `version`
   (monotoniczna w obrębie klienta), `clientId`, `capturedAt`, `conversationId`, `spaceId`, `url`,
   `view {id, title, compositionVersion}|null` (hash źródła kompozycji dla widoków modułu,
   `specVersion` dla kart), `cards` aktywnej przestrzeni (`cardId`, `title`, komponent lub `openui`,
   `specVersion`), `instances: SemanticInstance[]` (≤ 30), `actions` dozwolone na widoku.
2. Klient: budowa snapshotu z `uiSemantics` i stanu powłoki; nowa wersja tylko przy istotnej zmianie;
   `UiSnapshotPublisher` w powłoce publikuje z opóźnieniem (debounce) `PUT /api/ui/snapshot`;
   `clientId` na kartę przeglądarki; `UiCommandRunner` przed wysłaniem potwierdzenia wymusza publikację
   i dołącza `uiVersion`. `toAppContext().ui = { version, clientId, viewId, url }`
   (`appContextSchema.ui` nullable z domyślnym `null`).
3. Serwer: `services/ui-snapshots.ts` (pamięć procesu; klucz właściciel + `clientId`; indeks rozmowa →
   najnowszy klient), `PUT /api/ui/snapshot` (walidacja, właściciel z sesji, limit rozmiaru),
   `GET /api/ui/snapshot?conversationId=` (diagnostyka i testy, tylko własne).
4. Narzędzie `ui_state` (`agent/tools/ui-state.ts`, `effect: 'read'`, `alwaysLoad`): wejście
   `minVersion?`, `waitMs?` ≤ 5000; wynik `{ snapshot|null, version, capturedAt, ageMs, stale,
   reason?: 'no_client'|'older_than_requested'|'other_conversation' }`; snapshot tylko od klienta,
   którego aktywna rozmowa to rozmowa wykonania. Prompt: po `ui_navigate`/`ui_filter`/`ui_sort` odczytaj
   `ui_state` z `minVersion` z wyniku, zanim opiszesz ekran; porównuj wersję z `AppContext.ui.version`.

**Poza zakresem:** zmiany `DataTable` inne niż wymagane do opisu (stan sortowania i strony dostarcza
Task 2 przez ten sam rejestr); odsłanianie wartości (Task 6).

**Testy i dowody (minimum):**
- Vitest: limity schematu, monotoniczność wersji, izolacja właścicieli (drugi właściciel nie czyta),
  `other_conversation`, `minVersion` z oczekiwaniem i przekroczeniem czasu (`stale: true`),
  `AppContext.ui` w wykonaniu.
- E2E skryptowane (port 8798, `.e2e-scripted-uistate`): (a) wejście użytkownika na zawężony link
  `/data?country=PL` → snapshot zawiera widok `procurement.data`, instancję `DataTable`, pola z
  etykietami, predykaty i widoczne identyfikatory równe rekordom z `/api/read` po zawężeniu; (b)
  wykonanie: `ui_filter` przez prawdziwy gate, potem krok `call` `ui_state` z `minVersion` =
  `uiVersion` potwierdzenia → wynik ma nowszą wersję i nowy filtr; (c) negatywne: `minVersion` wyższe
  niż jakakolwiek publikacja → `stale: true`; wykonanie rozmowy A, gdy przeglądarka pokazuje B →
  `other_conversation`; kolejne polecenie niesie `AppContext.ui.version` równe wersji z chwili wysłania.

---

