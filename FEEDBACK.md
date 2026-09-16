# FEEDBACK — dziennik prac nad szablonem

Dziennik zmian w repozytorium `agentic-app-template`. Zaczyna się od konsolidacji z 2026-09-16.
Wcześniejsza historia kodu (wpisy #1–#39, próby z 2026-09-14…16) dotyczy aplikacji źródłowej
AgenticApp i jest w [`docs/archive/agenticapp-2026-09/FEEDBACK.md`](docs/archive/agenticapp-2026-09/FEEDBACK.md).
Tamte próby **nie** były wykonywane w tym repozytorium.

---

## T1 — 2026-09-16 — Konsolidacja AgenticApp w szablon

**Zakres fazy** (zgodnie z planem konsolidacji): dokumentacja, złożenie szablonu z istniejącego kodu,
regresja i odtwarzalność istniejącej wersji, repozytorium i publikacja. Ocena zgodności z 200
kryteriami służy do utworzenia backlogu — brakujące funkcje nie są w tej fazie implementowane.

### Stan źródła

- Konsolidacja zaczęła się po zakończeniu pracy wykonawcy nad panelem rozmowy w AgenticApp
  (ostatnia tura 2026-09-16 08:19 UTC: `pnpm verify` = 0, 257 testów Vitest, 63/63 Playwright).
- Manifest źródła o 08:28:13 UTC: 253 pliki (bez `node_modules`, `dist`, `data`, `backups`, katalogów
  testowych), sha256 manifestu `c06a8f63fa409cd158259ca86e8f1de6b05817e509dde422b6662d75142b0d72`.
- Pierwszy commit tego repozytorium (`7340863`) to wierny import 183 plików kodu z tego stanu, bez
  zmian treści — pozwala porównać każdą późniejszą zmianę z oryginałem.
- Kopia wszystkich dokumentów i źródeł sprzed zmian leży lokalnie poza repozytorium
  (`agentic-app-template-consolidation-backup`).

### Dokumentacja

- Specyfikacja 200 kryteriów trafiła do `docs/ARCHITECTURE.md` jako wierna kopia. Porównanie
  maszynowe z wersją 95: te same identyfikatory dla dawnych kryteriów, zmienione brzmienie L2.3 i L5.3,
  brak wymagań unikalnych dla starej wersji. Jedyna zmiana treści: usunięta pusta linia rozcinająca
  tabelę prób między T21 i T22.
- Stary plan szablonu (Next.js, CopilotKit, BYOK/LiteLLM) jest **sprzeczny** z obowiązującą
  specyfikacją — zarchiwizowany z adnotacją, nie scalany.
- Raporty i dziennik AgenticApp zarchiwizowane z adnotacją, że ich wyniki dotyczą innego katalogu i
  wersji 95 kryteriów. Dowody historyczne (`docs/evidence`) nie są publikowane: zawierają lokalne
  ścieżki, identyfikatory sesji i ślady sieciowe przeglądarki.
- Rozliczenie każdego dokumentu: `docs/DOCUMENTATION-MAP.md`. W AgenticApp wykonano część A planu:
  `docs/ARCHITECTURE.md`, archiwum wersji 95, odsyłacz w miejscu starej specyfikacji, poprawione
  odnośniki README, `docs/DOCUMENTATION-MAP.md`; skrypty `audit-matrix.mjs` i `closure-matrix.mjs`
  czytają archiwum, `pnpm check:closure` i `pnpm check:matrix` nadal przechodzą.

### Zmiany kodu i narzędzi względem AgenticApp

| Zmiana | Dlaczego |
|---|---|
| `scripts/check-boundaries.mjs` nie wymienia już modułu przykładowego ani jego słownika; pakiety platformy i moduły wykrywa po katalogach, słownik domeny czyta z `agenticApp.domainVocabulary` w manifestach modułów | poprzednia wersja czytała na sztywno `packages/module-procurement/package.json` — po wymianie domeny kontrola padałaby, a słownik nowej domeny wymagałby edycji skryptu. Ten sam słownik 12 pojęć przeniesiony do manifestu przykładu |
| `scripts/check-module-swap.mjs` (`pnpm check:module-swap`) | dowód wymiany domeny na kopii repozytorium, patrz niżej |
| `scripts/matrix-summary.mjs`, `closure-matrix.mjs`, `audit-matrix.mjs` czytają archiwum | kontrole historycznych macierzy nie zostały wyłączone, tylko wskazują przeniesione dokumenty |
| nazwa pakietu głównego `agentic-app-template`; `.gitignore` uzupełniony o lokalne ustawienia narzędzi i logi | tożsamość repozytorium |

Kod `apps/`, `packages/`, `tests/`, `e2e/` nie został zmieniony, z wyjątkiem pola
`agenticApp.domainVocabulary` w `packages/module-procurement/package.json`.

### Kontrole negatywne uogólnionej kontroli granicy

Na kopii w katalogu tymczasowym: import `@module/…` w pliku platformy → kod 1; słowo „dostawca”
w `platform-ui` → kod 1 z wskazaniem linii; brak `domainVocabulary` we wszystkich modułach → kod 1;
usunięcie `module-procurement` i słownik w module kontrolnym → kod 0 bez edycji skryptu.

### Próba wymiany domeny — trzy nieudane przebiegi, zanim zadziałała

1. **Oblana przez błąd skryptu.** Wyrażenie wycinające trasy ekranów przykładu z `router.tsx` było
   leniwe, ale mogło przeskoczyć przez granice definicji, więc usunęło też trasy platformy
   (`spacesRoute`, `filesRoute`, `settingsRoute`). Wykrył to typecheck w kopii. Poprawka: blok trasy
   dopasowywany bez przechodzenia przez średnik i asercja, że usunięto dokładnie cztery trasy
   przykładu, a trasy platformy zostały.
2. **Oblana przez rzeczywistą wadę wymienialności.** Po poprawnym usunięciu tras typecheck oblał w
   `packages/module-procurement/src/ui/pages.tsx`: ekrany przykładu używają typowanych linków TanStack
   Router (`to="/cases/$caseId"`), których typy pochodzą z globalnej rejestracji routera aplikacji.
   Moduł niezłożony do aplikacji nie przechodzi więc typecheck, jeśli zostaje w repozytorium.
   Pakiety platformy były przy tym nietknięte. Rozwiązanie w tej fazie: procedura odłączenia przykładu
   usuwa jego połówkę UI (połówka serwerowa zostaje jako fixture testów) — opisane w
   `docs/NEW-APPLICATION.md` §2; trwałe rozwiązanie w backlogu.
3. **Oblana przez błąd skryptu.** Import `@playwright/test` po ścieżce rozwiązanego pliku CJS dawał w
   ESM tylko `default`, bez `chromium`. Poprawka: `createRequire(...)('@playwright/test')`.
4. **Przeszła** (drzewo robocze przed commitem): pakiety platformy identyczne, kontrola granicy,
   typecheck i build w kopii, serwer z rejestrem `["probe"]`, narzędzia `probe_*`, trasa
   `/api/m/probe/notes`, kompozycja walidowana komponentem `probe.noteList`, brak tabel `pc_*`,
   powłoka w Chromium bez ekranów przykładu i bez błędów strony. Wynik na zatwierdzonym stanie:
   `docs/evidence/template-consolidation/`.

### Zauważone przy sprawdzaniu dokumentacji

- `scripts/migration-rehearsal.mjs` nie uwzględnia migracji `platform-0003-file-versions` na liście
  oczekiwanych zmian (tabela `files`), a porównuje odcisk wszystkich kolumn — dla kopii sprzed 0003
  z plikami zgłosi fałszywą zmianę. Analiza kodu; bez próby. Opisane w `docs/odzyskiwanie-stanu.md`,
  pozycja w backlogu.
- `apps/web/vite.config.ts` ma proxy na stały port 8791; `pnpm dev` przy zajętym 8791 trafia do obcej
  instancji. Na tej maszynie 8791 zajmuje działająca instancja AgenticApp, więc `pnpm dev` nie był
  uruchamiany w czasie konsolidacji.
- Komentarz w `packages/platform-ui/src/catalog/registry.tsx` powołuje się na
  `tests/catalog-parity.test.ts`, którego nie ma w repozytorium.
