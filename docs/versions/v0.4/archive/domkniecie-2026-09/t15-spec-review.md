# Recenzja poprawki specu T15 — commit bf84172 (worktree z15-spec-t15)

**Recenzent:** niezależny (agent). **Data:** 2026-09-20.
**Zakres:** 1 plik, +11/−3, `e2e/bl03-model-t15.spec.ts`.

## Werdykt: ZATWIERDZAM

Poprawka usuwa dokładnie tę przyczynę, która spaliła próbę 2026-09-20T17-06-16-992Z
(asercja `?c=` zaraz po `openApp`, zero wydanych tur), a tożsamość rozmowy w turach
2–4 jest czytana przed restartem i stosowana po nim bez zmian ryzyka.

## Weryfikacja punkt po punkcie

### 1. Czy poprawka usuwa przyczynę? — TAK

- Przed (`bf84172^`): `openApp` → odczyt `?c=` + `expect(...).toBeTruthy()` — na świeżej
  instancji żadna rozmowa nie istnieje i nie jest wybrana, asercja padała zanim cokolwiek
  kosztowało. Dowód: `integracja/docs/evidence/z11-bl03/runs/2026-09-20T17-06-16-992Z/t15-t1-blad-narzedzia.json`
  — `wynik: "niezaliczona"`, `turyWydaneWTymPliku: 0`, `kroki: []`; screenshot
  `integracja/test-results/bl03-model-t15-*/test-failed-1.png` (zdrowa aplikacja bez wybranej rozmowy).
- Po: `openApp` → `run.command` (tura zapisana w rejestrze i wysłana) → `settled` →
  dopiero wtedy odczyt `?c=` + asercja (bl03-model-t15.spec.ts:130-132). Rozmowa już
  istnieje (tworzona przy pierwszym poleceniu) i URL ją niesie — zgodnie ze wzorcem
  `bl03-model-lifecycle.spec.ts:119` (odczyt po pierwszym poleceniu; ten spec przeszedł
  na prawdziwym modelu). Asertywne `toBeTruthy()` zostaje jako strażnik: pada tylko,
  gdy aplikacja naprawdę nie utworzy/powiąże rozmowy — czyli wykrywa prawdziwy defekt, nie artefakt
  stanu początkowego.
- T15 czyta `?c=` po `settled`, lifecycle zaraz po `run.command` — wariant T15 jest
  ściśle bezpieczniejszy (bez zależności od momentu aktualizacji URL).

### 2. Tury 2–4: tożsamość rozmowy — NIEZAWODNA

- Tura 2 (linia 160): `page.goto(`${BASE}/?c=${conversationId}`)` — `conversationId`
  ustawione w turze 1; tryb `serial` gwarantuje kolejność, a gdyby asercja tury 1 padła,
  tury 2–4 są pomijane (nawigacja `?c=null` niemożliwa).
- Tura 3: `convId` czytany z istniejącej wartości modułowej PRZED restartem
  (linia 207; SIGTERM w linii 233), po restarcie `openApp` + `goto(?c=${convId})`
  (linie 243-244). Restart kasuje tylko proces i stronę — zmienna modułowa przeżywa,
  URL jest jedynym kanałem dołączenia nowej strony do starej rozmowy. To jest konieczne
  i poprawne.
- Tura 4: `convId` linia 274, `goto` linia 276. Poprawnie.
- Deep-link `?c=` jest w tym specie potrzebny (każdy test = nowa strona) i sprawdzony
  bojowo: lifecycle linia 133 robi identyczną nawigację po restarcie i przeszedł na
  modelu; aplikacja utrzymuje parametr (`apps/web/src/router.tsx:86` —
  `retainSearchParams(['c', 's'])`).

### 3. T16/T17 — CZYSTE (brak tej samej wady)

Oba czytają `?c=` PO pierwszym poleceniu, dokładnie jak zweryfikowany wzorzec:

- `e2e/bl03-model-t16.spec.ts:94` — po `run.command` (linie 82-93); `conversationId`
  używane potem tylko do `assistantText` (linia 100). Żadnej nawigacji `?c=`, żadnego
  restartu.
- `e2e/bl03-model-t17.spec.ts:80` — po `run.command` (linie 72-79); użycie tylko
  w `assistantText` (linia 124).

Wzorzec „odczyt zaraz po `run.command`, przed `settled`" jest tym, który lifecycle
przeszedł na prawdziwym modelu, a T14 stosuje wariant leniwy po poleceniu
(`bl03-model-t14.spec.ts:102`). Blocking findings: **brak**.

### 4. Komentarz — PRAWDA (z literówką kosmetyczną)

Komentarz (linie 114-121) mówi: świeża instancja nie ma rozmowy; aplikacja tworzy ją
przy pierwszym poleceniu; próba 2026-09-20T17-06-16-992Z oblała asercją przed
poleceniem przy zerze tur; wzorzec zgodny z lifecycle. Każdy z tych faktów potwierdzony
powyżej. Jedno słowo kłamie gramatycznie, nie merytorycznie: „**ciepia** te tozsamosc"
— nie ma takiego słowa (chodzi zapewne o „spinają" albo „niosą"). Nieblokujące.

## Findings

| # | Waga | Miejsce | Opis |
|---|------|---------|------|
| 1 | minor | e2e/bl03-model-t15.spec.ts:120 | Literówka „ciepia" (zam. „spinają"/„niosą") — poprawić przy następnej okazji, nie wymaga nowego commitu przed uruchomieniem. |

## Wykonane sprawdzenia (bez uruchamiania modelu)

- `git show bf84172` — diff zgodny z opisem (1 plik, +11/−3).
- `npm run typecheck:e2e` — czysto.
- `APP_E2E_MODEL=1 APP_E2E_MODEL_Z11=1 playwright test e2e/bl03-model-t15.spec.ts --list` — 4 testy, parsują się.
- Domyślny `--list` (bez opt-in) nie widzi T15 — potwierdza, że spec nie może przypadkiem
  spalić tur poza `pnpm test:e2e:z11` (playwright.config.ts:60-70).
