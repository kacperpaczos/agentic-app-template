# Brief: ETAP 3 / Subagent B — jawna konfiguracja storage Mastry (FINALNY)

Pracujesz WYŁĄCZNIE w wyznaczonym worktree (podam ścieżkę w dispatchu; gałąź `domkniecie/etap3-mastra-storage`).
Faktografia (przeczytaj w całości): `docs/versions/v0.4/archive/domkniecie-2026-09/etap3-mapa.md`

## Decyzja orkiestratora (wykonuj; nie wracaj do wariantu A)

Ostrzeżenie `No storage configured on Mastra — falling back to an in-memory store` pochodzi z
@mastra/core 1.66.0 przy braku `config.storage`. Faktografia dowodzi: magazyn Mastry jest MARTWY
(aplikacja trzyma trwałość wyłącznie we własnej SQLite; `getAgent('appAgent')` to jedyna
referencja; zero asercji testowych opartych o pamięć Mastry). Wariant A odrzucony (wymaga nowej
zależności — decyzja właściciela wg AGENTS.md). Wykonujemy **wariant B: jawne ograniczenie**:

1. W `packages/platform-server/src/agent/runtime.ts` (miejsce: `new Mastra({agents:{appAgent}})`,
   ~L175-177): skonfiguruj storage JAWNO na `InMemoryStore` z publicznego eksportu @mastra/core
   (znajdź właściwą ścieżkę importu w node_modules/@mastra/core — wersja 1.66.0; użyj publicznego
   API, nie ścieżek wewnętrznych dist/). Obok komentarz (polski, styl repo): dlaczego in-memory
   jest świadomą decyzją — magazyn Mastry nie jest używany, trwałość realizuje własna baza
   (app.db), wskazówka do dokumentu decyzji.
2. **Test regresyjny strażnika** (nowy, np. w istniejącym pliku testowym runtime): przy tworzeniu
   platformy (`createPlatform`) przechwyć ostrzeżenia i asertuj, że NIE pojawia się komunikat
   o braku storage („No `storage` configured”). Test ma potrafić oblać: po usunięciu jawnej
   konfiguracji pada (jeśli da się to pokazać na mutacji — opisz w raporcie; minimum: asercja
   istnieje i celuje w dokładnie ten komunikat).
3. Testy jawnie zamierzone NIE ruszane: `tests/observability.test.ts:21` (goła Mastra do
   telemetrii — zostaje; jej ostrzeżenie jest niegroźne i lokalne; jeśli trywialne, dodaj tam
   jawny storage z tym samym komentarzem — decyzja Twoja, uzasadnij).
4. Dokumentacja: krótka sekcja decyzji (gdzie: docs/observability.md — nagłówek o storage Mastry;
   + wpis w FEEDBACK.md, kolejny numer T). Wpis musi mówić: czego ostrzeżenie dotyczyło, co
   wykazała faktografia, dlaczego wariant A odrzucony, co się zmieniło.
5. `docs/acceptance/assessment.json` — BEZ ZMIAN (żadne kryterium nie opiera się o pamięć Mastry;
   potwierdzzone kryteria restartu idą po własnej bazie — to prawidłowa warstwa).

## Zakazy

- Zero nowych zależności (lockfile nietknięty). Zero zmian w e2e. Zero dotykania
  `docs/evidence/**`. Dane użytkownika nietykalne. Nie wyłączasz żadnej kontroli.
- Nie oznaczasz żadnego kryterium jako unverified — faktografia tego nie wymaga.

## Procedura

1. `pnpm install --frozen-lockfile`; baseline `pnpm verify` (musi być 0 przed zmianą — jeśli nie,
   STOP i zgłoś BLOCKED z wyjściem).
2. Implementacja, test, `pnpm verify` (=0), pokaz, że nowy test asertuje właściwy komunikat.
3. Commity po polsku, małe. Raport do: `docs/versions/v0.4/archive/domkniecie-2026-09/etap3-b-report.md`.
   W odpowiedzi TYLKO: status, commity, podsumowanie testów, obawy.
