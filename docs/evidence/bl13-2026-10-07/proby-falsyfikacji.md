# Proby falsyfikacji nowej logiki testowej — BL-13 (L11.12, L11.19)

Data: 2026-10-07. Baza: commit `b4b4019` (gałąź `feat/bl13-tryby-zgod-centrum-zadan`).
Metoda: wstrzykniecie realnego bledu produkcyjnego do kodu z wdrozona funkcja,
uruchomienie nowych asercji (maja pasc), przywrocenie pliku z backupu
(`/tmp/bl13-falsyfikacja/`) i dowod tozsamosci bajtowej (`cmp`). Zadna proba nie
byla przeplywem modelowym; instancje wylacznie skryptowane, port 8791 nietkniety.

## F1 — tryb zgody ignorowany w bramce (L11.12)

- Wstrzykniecie: `packages/platform-server/src/agent/runtime.ts`,
  `#consentModeOfRun` zwraca zawsze `'supervised'` (tryb z rekordu przestaje
  byc czytany przy decyzjach bramki i przy budowie `sdkOptions`).
- Rezultat: `pnpm vitest run tests/consent-modes.test.ts` → **5 failed / 14 passed**
  (m.in. „tryb auto: Bash wykonuje sie bez permissionRequest…", „tryb manual:
  odczyt MCP aplikacji pyta…", „retry runu manual tworzy run manual",
  „allowedTools bez kategorii decyzja…").
- Przywrocenie: `cmp` — identycznosc bajtowa potwierdzona.

## F2 — pytanie o zgode nie trafia do centrum zadan (L11.19)

- Wstrzykniecie: `packages/platform-server/src/http/app.ts`, `taskPayload`:
  `pendingPermission` ustawione na `undefined` niezaleznie od stanu runu.
- Rezultat: `pnpm vitest run tests/consent-modes.test.ts tests/task-center.test.ts`
  → **1 failed**: „pendingPermission w centrum zadan: pojawia sie w fazie
  oczekiwania i znika po odpowiedzi" (26 passed).
- Przywrocenie: `cmp` — identycznosc bajtowa potwierdzona.

## F3 — toast powtarza sie po zamknieciu (L11.19, jednorazowosc)

Prob wstepnych (uczciwie, bo uczą):

1. **F3v1** — ominięcie `!notified.has(r.id)` w latchu przejsc
   (`AttentionToast.tsx`). Test NIE spadl: `notified` chroni tylko ponowne
   latchowanie (run pyta po raz drugi), a jednorazowosc w oknie jednego
   czekania egzekwuje konsumpcja `pendingAttention` przy ogloszeniu.
   Wstrzykniecie w zly punkt.
2. **F3v2** — brak konsumpcji latchu (`pendingAttention.current.delete`
   usuniety przy ogloszeniu). Asercje DOM-owe (licznik w stalych momentach)
   NIE spadly w teście głównym, choć sonda (`e2e/zz-probe-toast.spec.ts`,
   skasowana po diagnozie) pokazala powrot toastu. Przyczyna: okno widocznosci
   jest przejsciowe (do auto-hide 8 s) i przesuwa się względem stałych momentów
   kontroli — pojedyncze sprawdzenie oblewa się o transient. Dodatkowo ustalone:
   draft rozmowy nie ma `c` w adresie (pojawia się po wyslaniu), a nawigacja
   „New chat" jest asynchroniczna — wczesne odczyty URL dawaly `null` i prózne
   asercje.
3. **F3 finalny** — asercja przepisana na obserwowalnosc bez wyścigu:
   `MutationObserver` po stronie strony zapisuje kazde pojawienie sie
   `[data-testid="attention-toast"]`, a asercja końcowa wymaga braku wpisów po
   momencie zamknięcia. Wstrzykniecie F3v2 → **test spadl**:
   „toast nie wraca po zamknieciu — zadne ponowne ogloszenie tego samego
   czekania" (Expected −1 / Received +10 wpisów; korelacja ze sladem konsoli
   `pokazuj run… aktywna=cnv…` po `zamknij`). Ponadto test 1 zyskal drugie
   zadanie czekajace w tle (badge=2) i poprawne, opóznione odczyty nawigacji.
- Przywrocenie: `cmp` — identycznosc bajtowa; `pnpm build` z czystego zrodla;
  `e2e/attention-consent.spec.ts` → **3 passed** na poprawnym kodzie.

## Wnioski do macierzy

- L11.12: zachowanie trzech trybów, brak eskalacji i niezmienniki sdkOptions
  maja falsyfikowalna regresje (F1).
- L11.19: pytanie w centrum zadan ma falsyfikowalna regresje (F2); jednorazowosc
  toastu ma falsyfikowalna regresje (F3 finalny) — obserwowana strona strony,
  nie moment DOM.
