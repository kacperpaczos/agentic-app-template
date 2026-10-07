# SDD ledger — plan: docs/versions/v0.4/archive/domkniecie-2026-09/zlecenie.md

Workspace celowo POZA repo (repo-root/.superpowers zastąpione przez
docs/versions/v0.4/archive/domkniecie-2026-09/) — Ruling: repo musi pozostać
czyste („verify = 0 i drzewo bez śmieci”), scratch orkiestratora nie może lądować w git status.

## Preflight scan planu (konflikty i rulings)

| # | Konflikt | Ruling |
|---|---|---|
| 1 | ETAP 5 zlecenia wymienia L1.2/L1.8/… — w macierzy 200 to kryteria potwierdzone/nieistniejące (stara numeracja 95) | Program ETAP 5 przeciw otwartej 13-tce z assessment.json; raport startowy §7. Koszt pomyłki: domykanie złych kryteriów, ale intencja (bez tury) zachowana |
| 2 | Zlecenie ETAP 1: „check:matrix raportuje starą macierz i oba się kończą sukcesem” jako wada; w rzeczywistości check:matrix strzeże archiwum 95 celowo | Ruling: intencja = jedna kanoniczna macierz bieżąca; kontrola archiwum zostaje, jawnie oddzielona nazwą/rolą; rozjazd 95 vs 200 ma się stać niemożliwym do przemilczenia. Koszt pomyłki: zafałszowanie historii — niezamierzone |
| 3 | ETAP 2 zakłada, że straż nie istnieje; raport §6 mówi, że kluczowe porażki zamknięto (APP_BASE 8790, etykiety, fingerprint poświadczeń) | ETAP 2 = audyt kompletności + domknięcie dziur checklisty (jawny APP_BASE_URL, PID, SHA w dowodach). Koszt: podwójna praca, jeśli budować od zera |
| 4 | Zlecenie zakłada port 8791 działa; zmierzone: nie działa | Odnotowane w raporcie startowym; instancji użytkownika NIE uruchamiam; brak wpływu na testy (8791 i tak zakazany) |
| 5 | ETAP 8: „bramka nie zielona, jeśli kryterium pozostaje częściowe” vs 13 kryteriów otwartych, część trwale | Bramki techniczne (verify, e2e, sekrety, spójność macierzy) mają być zielone; otwarte kryteria pozostają uczciwie widoczne w macierzy; końcowa klasyfikacja (out-of-scope itd.) = decyzja właściciela. Koszt pomyłki: wieczny program — odrzucone |
| 6 | CLI Claude 2.1.277 → 2.1.278 między sesjami | Każda przyszła tura: recalibracja wzorców komunikatów przed preflightem; bez tego nie wydawać tur |

## Dziennik

- ETAP 0: complete — raport `docs/RAPORT-STARTU-DOMKNIECIA.md` zapisany, commit `763dd31`; bramki
  zmierzone (acceptance 200: 187/11/2; matrix 95; closure 0); 13 otwartych kryteriów, 17/27 prób;
  280 commitów przed main, nic niewypchnięte; wszystkie 13 gałęzi z* scalone.
- ETAP 1 / Subagent A (haiku, Explore): complete — mapa w `.sdd-zlecenie/etap1-a-mapa.md`
  (zapisana przez orkiestratora; agent Explore nie ma narzędzia zapisu). Odkrycia: 3 ręczne kopie
  ocen historycznych (closure `A`, martwy `audit-matrix.mjs`, 95 pól historical); check:closure
  failuje po cichu; brak testów skryptów; nic nie porównuje 95 z 200.
- ETAP 3 / subagent faktografii (haiku, Explore): complete — raport w `.sdd-zlecenie/etap3-mapa.md`.
  Ruling: **wariant B z jawną konfiguracją** — storage Mastry jest martwym magazynem (aplikacja
  trzyma trwałość we własnej SQLite; zero asercji opartych o pamięć Mastry; adapter wymaga nowej
  zależności = decyzja właściciela wg AGENTS.md). Plan pakietu: jawnie zadeklarować in-memory
  w runtime.ts (ostrzeżenie „falling back" znika przez świadomą decyzję, nie przez wyciszenie) +
  komentarz + dokumentacja; kryteria restartu pozostają potwierdzone na własnej bazie (właściwa
  warstwa) — punkt „unverified" z wariantu B zlecenia NIE ma zastosowania (nic na Mastrze nie
  wisi). Dowód wycieku ostrzeżenia do pliku dowodowego: z13-bl12/proby-wykrycia-D-1...json:28.
  Ruling koszt: jeśli ktoś oczekiwał trwałości po stronie Mastry — map A/Z3 pokazuje, że nikt nie
  oczekuje; ryzyko niskie.
- ETAP 1 / Subagent B (sonnet, general-purpose): DISPATCHED — worktree `[lokalna ścieżka pominięta]
  agentic-app-template-wt/z14-bramka` (gałąź `domkniecie/z14-bramka` @ 763dd31); brief finalny
  `.sdd-zlecenie/etap1-b-brief.md`; BASE do review-package: 763dd31.
- ETAP 4 / subagent reuse (haiku, Explore): complete — tabela 26 dowodów (19 commitów zweryfikowane
  jako przodkowie HEAD): 13 REUSE (14 tur oszczędzone), 8 DELTA, 5 REPEAT (dokładnie obszar
  przebudowany BL-04 r4–6). Dokument repo: `docs/evidence/REUSE-MATRIX.md`, commit `65684de`
  (ETAP 4 complete po recenzji). Odkrycie systemowe: koperty dowodów nigdy nie zapisywały nazwy
  modelu (`model: null`) — wymóg przyszłych prób; istniejących nie wolno dosztukować.
- ETAP 2 / audyt (sonnet, Explore): complete — raport `.sdd-zlecenie/etap2-a-audyt.md` (zapisany
  przez orkiestratora). 4 pkt checklisty OK (8791-literal, etykiety, realpath, koperty dowodów),
  6 dziur uszeregowanych. Ruling: dziura 1 (straż żywego katalogu dla instancji BEZ etykiety) —
  naprawa na warstwie skryptów testowych/audytowych, NIE w loadConfig (globalna blokada zabrałaby
  właścicielowi legalny start aplikacji na jego danych; test isolation.test.ts:215-223 potwierdza
  to zachowanie jako zamierzone). Koszt pomyłki rulingu: jeśli skryptowa warstwa okaże się
  nie wystarczająca, zostanie dołożona druga warstwa w osobnym pakiecie.
- ETAP 2 / brief implementacji: gotowy (`.sdd-zlecenie/etap2-b-brief.md`) — dziury 1–4 obowiązkowe,
  5–6 best-effort; dispatch po scaleniu ETAPU 1.
- ETAP 4 / recenzja (haiku, Explore): complete — **ZATWIERDZAM Z UWAGAMI** (`.sdd-zlecenie/etap4-review.md`).
  1 uwaga merytoryczna (Minor): wiersze e-relacji pomijały utwardzenie agent/tools/canvas.ts
  (+21/−2, `84cbb2e`). Naprawa: doprecyzowana kolumna + wniosek, commit `5537fb0` (naprawa
  docs-only wykonana przez orkiestratora jako transkrypcja ustalenia recenzenta — Ruling:
  poniżej progu fix-loop, treść=wprost tekst recenzenta). ETAP 4: **complete** (commity 65684de,
  5537fb0).

- ETAP 1 / Subagent B (sonnet, general-purpose): complete (report DONE) — 5 commitów na
  `domkniecie/z14-bramka`: 95eb85f (matrix-core), cb2c95c (oceny-95.json + EXPECTED + stderr),
  033e96e (check:matrix na kanonie + kros-kontrola 95), e806888 (testy + usunięcie audit-matrix),
  172185c (dokumentacja). `pnpm verify`=0 (1067 testów, 8 nowych). Obawy B: (1) kros-kontrola
  95 twarda obustronnie; (2) status-mapping celowo pominięty (niejednoznaczny, udokumentowany);
  (3) kontrola tabel archiwalnego FEEDBACK.md wygasła ze starym check:matrix — DO ADJUDYKACJI
  po recenzji C (pytanie A). Pre-existing: podwójny numer T2 w FEEDBACK.md — zgłoszone, nie
  naprawiane (poza zakresem pakietu).
- ETAP 1 / Subagent C (sonnet, general-purpose): DISPATCHED — recenzja z 5 obowiązkowymi próbami
  negatywnymi na kopiach /tmp + pytania A–E. Review package:
  `z14-bramka/.superpowers/sdd/zlecenie/review-763dd31..172185c.diff` (203 KB, 5 commitów).

- ETAP 1 / Subagent C (sonnet, general-purpose): complete — **spec ✅, jakość ZATWIERDZONA,
  0 Critical / 0 Important / 5 Minor** (`.sdd-zlecenie/etap1-c-review.md`). C samodzielnie
  wykonał 5 prób negatywnych na kopiach /tmp (wszystkie oblewają właściwie) + próbę zieloną
  (3 bramki exit 0, 200 w obu podsumowaniach); translokacja oceny-95.json VERBATIM (95/95,
  0 różnic programowo); pytanie A (wygasła kontrola FEEDBACK.md): AKCEPTOWALNE (zamrożone
  archiwum, następca strzeżony;Minor 5: dopisać wprost w README archiwum).
  Minory ODRACZONE do final review: (1) statyczny człon „identyfikatory zgodne" w stdout
  check:matrix; (2) podwójny wydruk ROZJAZD; (3) pre-existing „z 12" w renderze closure;
  (4) zdublowane LABEL/OPEN zamiast importu z rdzenia; (5) README archiwum bez adnotacji
  o wygaśnięciu kontroli FEEDBACK.md.
- ETAP 1 / MERGE: complete — merge `bf97be6` (13 plików, +1840/−597). Bramki na drzewie
  scalonym: check:acceptance=0 (200/187-11-2), check:matrix=0 (200/187-11-2, kros-kontrola
  archiwum 95 OK), check:closure=0. Własny test negatywny orkiestratora (kopia /tmp, usunięte
  kryterium L7.5): acceptance EXIT=1 (84 problemy), matrix EXIT=1 (ROZJAZD 18: pozycje ID,
  199≠200, przestarzałe raporty pochodne). **Warunek zlecenia „oba podsumowania ta sama liczba"
  SPEŁNIONY.** ETAP 1: **complete** (commity 95eb85f, cb2c95c, 033e96e, e806888, 172185c,
  merge bf97be6).
- ETAP 2 / testy po merge ETAP 1: pełna pula na drzewie scalonym 69 plików / **1067 testów
  zielonych** (95,5 s), exit 0.
- ETAP 2 / Subagent B (sonnet, general-purpose): complete (DONE_WITH_CONCERNS) — 7 commitów na
  `domkniecie/etap2-izolacja`: b20844b (odmowa na żywym katalogu), 0a955a1 (sonda portu + własny
  pid), 2666025 (RUN_ID + katalog testowy), 66143e0 (odcisk poświadczeń), e3df85b (porządki +
  fail-closed), 9e345bc (dokumentacja), a269d6e (FEEDBACK T9). verify=0 (71 plików / 1125 testów,
  +58), e2e 224/224 (16,5 min, 0 tur). Obawy 1–5: kwalifikacja orkiestratora = obserwacje/świadome
  decyzje (deklaracja ≠ podpis; zaostrzenie acceptance zgodne z „wymagaj jawnego APP_BASE_URL";
  odcisk przy normalnym końcu — do oceny recenzenta). config.ts nietknięty.
- ETAP 2 / Subagent C (sonnet, general-purpose): complete — **spec ✅, jakość zatwierdzona,
  0 Critical / 1 Important / 5 Minor** (`.sdd-zlecenie/etap2-c-review.md`). verify odtworzone
  (71/1125/0); diff packages/apps/package.json/lockfile pusty; kotwica rulingu
  (isolation.test.ts:215-223) nietknięta. Próby adwersarskie: sekret-dowiązanie → odmowa;
  TOCTOU sonda→setsid → odmowa/false-start przez weryfikację LISTEN z /proc; komunikaty bez
  treści plików. **I-1** (wchodzi do fix-loop): crash-path w acceptance-agent.mjs:81 /
  run-agent.mjs omija porównanie odcisku poświadczeń (odcisk tylko w pamięci, brak
  pliku-przenośnika). Minory ODRACZONE: M-1 testy statują prawdziwy plik poświadczeń (flak);
  M-2 prefiks .e2e w dowolnym fs przepuszczany ($HOME/.e2e-*); M-3 diag/probe biorą odcisk bez
  porównania; M-4 granica głębokości 3; M-5 teardown kaszy ręcznie nazwany .e2e-* katalog
  użytkownika w korzeniu repo. Obawy B 1–5: wszystkie akceptowane jako decyzje (4 → I-1).
- ETAP 2 / re-review runda 1: complete — **I-1 ADDRESSED** (run-agent.mjs:166-171,
  acceptance-agent.mjs:245-256 finally; przenośnik stat-only acceptance-target.mjs:296-325;
  brak przenośnika → throw → exit 5 fail-closed), **0 nowych findings**, twierdzenia
  zweryfikowane (acceptance-target 36/36). Decyzja wzorca try/catch/finally potwierdzona
  (exit-hook w Node nie zmieni kodu wyjścia); kill -9 = akceptowalne rezyduum
  „wykrywanie, nie zapobieganie"; 2 deferred minory dopisku (throw na niezapisywalnym
  przenośniku; równoległe przebiegi nadpisują przenośnik).
- ETAP 2 / MERGE: complete — merge `b9467ac` (17 plików, +2474/−268; nowy server-guard.mjs
  + 2 pliki testów). Bramki na scalonym drzewie: acceptance/matrix/closure = 0 (kanon zgodny).
  **ETAP 2: complete** (commity b20844b, 0a955a1, 2666025, 66143e0, e3df85b, 9e345bc, a269d6e,
  8c04b0d; 1 runda fix). Odroczone minory ETAPU 2 do final review: M-1 stat prawdziwego pliku
  poświadczeń w testach; M-2 prefiks .e2e w dowolnym fs; M-3 diag/probe odcisk bez porównania;
  M-4 głębokość 3; M-5 teardown kaszy .e2e-* użytkownika w korzeniu repo; +2 z re-review.
- ETAP 2 / testy po merge: 1130/1130 zielonych (94,5 s), exit 0.
- ETAP 3 / Subagent B (sonnet, general-purpose): complete (DONE) — 3 commity na
  `domkniecie/etap3-mastra-storage`: b29e83c (jawny InMemoryStore z @mastra/core/storage +
  strażnik), 999ddd3 (jawny storage w instancjach obserwowalności), 9bbe77d (docs/observability.md
  sekcja „Storage Mastry — swiadome ograniczenie" + FEEDBACK T10). verify=0 (71/1131); kontrola
  negatywna na mutacji oblewa strażnika pełnym komunikatem. Obawy: celowanie w pierwsze zdanie
  komunikatu; publiczny eksport (typecheck złapie zmianę przy aktualizacji core); e2e poza
  zakresem (grep: brak asercji e2e od storage); zakazy dotrzymane.
- ETAP 3 / Subagent C (sonnet, general-purpose): complete — **spec ✅, jakość zatwierdzona,
  0 Critical / 0 Important / 2 Minor** (`.sdd-zlecenie/etap3-c-review.md`); własna mutacja
  obaliła strażnika; import z publicznego eksportu potwierdzony u źródła; pkt 7: komentarz +
  dokumentacja + strażnik wystarczająco zapobiegają odczytowi „storage = trwałość".
  Minory ODRACZONE: (1) sprzężenie strażnika z brzmieniem komunikatu 1.66.0
  (tests/runtime.test.ts:638); (2) InMemoryStore w mock.d.ts — potwierdzić przy aktualizacji
  core (runtime.ts:3).
- ETAP 3 / MERGE: complete — merge `5cfc97c`. Bramki: acceptance 200, matrix 200, closure 0,
  module-swap 0. **ETAP 3: complete** (b29e83c, 999ddd3, 9bbe77d; merge 5cfc97c). 0 kryteriów
  zmieniło status — zgodnie z decyzją (żadne otwarte kryterium nie wisi na tych pakietach).
- ETAP 8 / integracja końcowa — W TOKU:
  - install --frozen-lockfile = 0; verify = 0 (71 plików / 1131 testów, 98 s);
  - skan sekretów diffu sesji: czysty (jedyna trafiona linia = zadeklarowana atrapa
    `FAKE_SECRET 'atrapa-session-secret-nie-jest-sekretem'` w teście);
  - skan ścieżek [lokalna ścieżka pominięta] w diffie: 0; assessment.json w diffie sesji: nietknięty;
  - worktree sesji (z14-bramka, etap2-izolacja, etap3-mastra): czyste;
  - sesja: 21 commitów (763dd31..5cfc97c);
  - ETAP 8 / e2e pełne: **224/224, 18,5 min, exit 0** (integracja @ 5cfc97c; log pokazuje nowy
  teardown przy pracy: kasuje instancje .e2e-*, zostawia .e2e-data pod żywym procesem).
- ETAP 8 / świeży verify — PIERWSZA PRÓBA OBLAŁA (przyczyna: kolizja portu 8798 —
  tests/isolation-orphan vs równoległy e2e; wada HARMONOGRAMU orkiestratora, nie repo).
  Powtórka w izolacji: DOPOWIETRZONYCH przez fix I-1 — wykonam raz, na drzewie finalnym.
- FINAL REVIEW (fable): complete — **WYMAGA POPRAWEK (1)**. I-1 (Important, MUST-FIX):
  usunKatalogiInstancjiTestowych (e2e/global-teardown.ts:39-69) kasuje KAŻDY katalog .e2e*
  z korzenia repo, w tym `.e2e-model-turns/` = jedyny rejestr budżetu tur (21/25, sufit 25) →
  ciche obejście sufitu po merge. 2 nowe Minory (M-N1 komentarz server-guard.mjs:95 „inside
  the repository" vs basename-only; M-N2 brak ostrzeżenia README). Triage 14 odroczonych
  minorów: 1 MUST-FIX (I-1), 13 pozostaje z zapisem. 4 twierdzenia briefu potwierdzone.
  Ruling: M-N1/M-N2 idą do tego samego commita (trywialne, ta sama powierzchnia).
- ETAP 2 / re-review runda 2 (final reviewer): complete — **I-1 ADDRESSED** (nosiCechyDanychInstancji
  global-teardown.ts:57, biała lista po kształcie, testy 9/9 z PROBĄ reguły prefiksowej),
  trade-off AKCEPTOWALNY. Nowe: I-2 (topologia: commit fixa bez ETAPU 3 → walidacja na drzewie
  złożonym; merge OK, nigdy reset), M-R2N1 (odroczony: „containment by harness" bez pokrycia
  w kodzie — do przepisania z M-2).
- ETAP 2 / MERGE runda 2: merge `3d87dda`. Bramki złożone: acceptance 200, matrix 200,
  closure 0, swap 0. Verify złożone: 0 — 71/1135.
- ETAP 8 / świeży klon `3d87dda` (izolowany): verify = 0 — **1135/1135**, zgodny z worktree.
  Porównanie przebiegów (wymóg ETAP 8.11–8.12): ZGODNE.
- FINAL REVIEW: complete — werdykt po fix runda 2: wszystkie findings ADDRESSED; 13 minorów
  odroczonych (nieblokujące), pełny zapis `.sdd-zlecenie/final-review.md`.
- ETAP 8 / e2e na finalnym drzewie: **224/224, 16,5 min, exit 0** (`3d87dda`); log pokazuje
  naprawiony teardown w akcji (zostawia nieinstancyjny `.e2e-scripted-auth-log` z powodem).
- RAPORT KOŃCOWY: complete — `docs/RAPORT-DOMKNIECIA-PLATFORMY.md`, commit `351dbc8`.
  Drzewo czyste. /tmp/fresh-checkout-domkniecie usunięty.
- **SESJA: COMPLETE.** Wszystkie etapy techniczne (0,1,2,3,4,5-korekta,7,8) zamknięte; ETAP 6
  zamrożony (blokada org — decyzja właściciela). 0 tur wydanych. Workspace zachowany do
  decyzji właściciela (wskaźniki raportu: final-review.md itd.); do usunięcia po nim.

## Księgowość sesji (do raportu końcowego; uzupełniać na bieżąco)

- Tury modelu Claude wydane: 0 (budżet 21/25 nietknięty; ETAP 6 zamrożony — blokada org).
- Subagent tokens (z notyfikacji, przybliżenia):
  A-mapa 93k; Z3-mastra-faktografia 51k; Z4-reuse 120k; ETAP2-audyt 102k;
  ETAP1-B 168k; ETAP1-C 88k; ETAP2-B 227k+268k(fix); ETAP2-C 141k+re-review(~n/d);
  ETAP3-B 80k; ETAP3-C 52k; final-review fable (w toku). Razem ~1,4M subagent tokens.
- Orkiestrator (ta sesja): ~220k tokenów kontekstu zużyte do tej pory.
- Incydent ETAP 8: równoległość „pełne e2e + świeży verify" → kolizja portu 8798
  (isolation-orphan) — wada HARMONOGRAMU orkiestratora, nie repo; świeży verify do
  powtórzenia w izolacji po e2e. Lekcja: unit-suite wiąże porty 8792-8799 jak e2e.

## Dokończenie po decyzji właściciela (2026-09-20 wieczór): „prawdziwy Claude"

- Właściciel ujawnił: Claude Code lokalnie działa przez GLM (lokalna konfiguracja Claude Code env:
  ANTHROPIC_BASE_URL=api.z.ai + AUTH_TOKEN + model-aliasy glm-5.3-flash). Polecenie: sprawdzić,
  przenieść konfigurację, spróbować z prawdziwym Claude.
- Inspekcja: jedyne źródło routingu = settings.json env (profile powłoki i .claude.json czyste).
  Aplikacja była BEZPIECZNA: PROVIDER_OVERRIDES skrubuje BASE_URL/AUTH_TOKEN (auth.ts:326-336) +
  settingSources: [] — poranna diagnoza blokady org rzetelna (sonda czysta dała ten sam komunikat).
- MOVE: tymczasowa kopia ustawień z poświadczeniem (chmod 600) pozostawała poza repo; z env
  usunięte 5 kluczy ANTHROPIC_* (zostawione API_TIMEOUT_MS itp.). Przywrócenie wykonano poza repo.
  UWAGA dla właściciela: nowe sesje Claude Code pójdą do prawdziwego Anthropic (Claude Max).
- `pnpm diag` (0 tur): **plan=Claude Max, backend=firstParty, poświadczenie valid, 33 narzędzia,
  izolacja OK, exit 0** → blokada organizacyjna WYGASŁA.
- Rejestr tur przeniesiony z11-bl03 → integracja (.e2e-model-turns/z11-bl03.json, 21/25).
- Próba generalna na obecnym drzewie/CLI: **14/14** (0 tur; teardown chroni rejestr — log).
- Preflight ETAP 6: 8/8 spełnione. **T15 WYDANA** (4 tury = cały pozostały budżet; po T15: 25/25;
  T16/T17/T14-REPEAT wymagają nowego grantu — decyzja właściciela). W toku.

## T15 — pierwsza próba (19:06) i diagnoza

- T15 próba 1 (runs/2026-09-20T17-06-16-992Z): **niezaliczona NA OTWARCIU, 0 tur wydanych**
  (rejestr 21/25 nietknięty — paidRun.command dopisuje turę dopiero przy wysłaniu). Asercja
  `?c=` zaraz po openApp; świeża instancja nie ma rozmowy (aplikacja tworzy ją przy pierwszym
  poleceniu). Serwer zdrowy (log: subscription valid (max)); screenshot: aplikacja OK, brak
  wybranej rozmowy. Dowód uczciwy: turyWydaneWTymPliku=0, wynik=niezaliczona, pełne środowisko
  (SDK niesie CLI 2.1.270).
- Root cause (systematic-debugging): założenie speca nigdy nie walidowane na prawdziwej
  instancji (spece T15/T16/T17 z przedtury 1793b26 — PO ostatnim udanym przebiegu modelowym;
  scena stand-inu tworzy rozmowę inną ścieżką). Aplikacja od a071b60a nietknięta na tej ścieżce.
- Fix: domkniecie/z15-spec-t15 @ bf84172 — tożsamość rozmowy czytana PO pierwszym poleceniu
  (+ record.rozmowa; komentarz z przyczyną). typecheck:e2e=0. Review DISPATCHED (sonnet) —
  w tym sprawdzenie T16/T17 pod kątem tej samej wady (nigdy nie biegały).
- Po zielonym review: merge → T15 ponownie (4 tury).
- T15 / review poprawki (sonnet): complete — **ZATWIERDZAM**; tury 2–4 bezpieczne (odczyt przed
  SIGTERM, odtworzenie ?c= po restarcie, deep-link potwierdzony w lifecycle); T16/T17 CZYSTE
  (czytają ?c= po pierwszym poleceniu). Minor: literówka w komentarzu — poprawiona (amend → e954150).
- T15 / merge fix: `320f9d1`; dowód próby 1 skommitowany (`7335426`). Rejestr: 21/25.
- T15 / próba 2: DISPATCHED (b0pon0qac) — 4 tury na e954150.

## DECYZJA WŁAŚCICIELA (2026-09-20 wieczór): provider GLM/Z.AI, harness Claude Code zostaje

- Rezygnacja z czekania na odblokowanie Anthropic i z nowego grantu Claude. PROMPT-CLAUDE-CODE-GLM.md
  = specyfikacja wykonawcza (przeczytana w całości).
- Korekta zakresu od właściciela: **kryteria proceduralne i niewywoływalne warunki brzegowe NIE są
  obowiązkowe — zero tur GLM na nie; klasyfikacja w macierzy „informacyjne / poza bramką"**.
  Obowiązkowe: funkcje produktu + techniczne zabezpieczenia jakości. Potwierdzone i wpisane do
  pakietu (pkt 9 briefu GLM).
- Inwentaryzacja powierzchni (sonnet, Explore): complete — `.sdd-zlecenie/glm-inwentaryzacja.md`.
  Chokepoint: subscriptionOnlyEnv (auth.ts:342-352) ← runtime.ts:167/diag:151; kontrakt
  authMethodSchema+literal apiKeyPolicy (agent.ts:173,289,303-324); 9 twardych asercji testowych;
  stałe zrodlo „subskrypcja Claude" w kopertach (model-turns.ts:233,402); ryzyka: kanarek
  measurements.spec:186, izolowany CLAUDE_CONFIG_DIR musi być w env SERWERA.
- Ocena orkiestratora przekazana właścicielowi (9 punktów dotknięć) — zgodna z inwentaryzacją.
- PAKIET GLM (implementacja): DISPATCHED — sonnet, worktree `z16-glm`
  (domkniecie/z16-glm-provider @ 2d59906), brief `glm-b-brief.md`; BASE: 2d59906.
  Po implementacji: recenzja bezpieczeństwa (mocny model) → dopiero wtedy próby T15/T16/T17 na
  GLM z nowym rejestrem `.e2e-model-turns/glm.json` (budżet 25).


## T15 — próba 2 (19:22): tura wydana, blokada org NA INFERENCJI potwierdzona

- Rejestr: **22/25**. Run `4a63bb99` — faza `failed`, zero zdarzeń narzędzi; chat pokazał
  `[model_failed] Your organization has disabled Claude subscription access for Claude Code`,
  nagłówek „błąd płacenia z modelem (max)". **KOREKTA wcześniejszego wniosku orkiestratora:
  „blokada wygasła" było przedwczesne** — diag potwierdza wyłącznie poświadczenie+plan (Max,
  firstParty), a blokada działa na poziomie inferencji (diag: „dostep=unverified" — dokładnie
  ta semantyka z L8.6). Komunikat identyczny z porannym (02:26).
- Pozytyw obserwacyjny: aplikacja sklasyfikowała błąd (model_failed, komunikat w czacie, brak
  burzy ponowień) — zachowanie spójne z L8.6/L8.11-adjacent, ale bez domknięcia kryteriów.
- Dowody: runs/2026-09-20T17-22-07-307Z (JSON z dopisanym obserwowanyBlad/kontekstBlokady +
  zrzut ekranu), commit `2d59906`. Raport §3/§5/§8.2 zaktualizowane.
- **STOP wydawania tur**: zostały 3, każda inferencja da ten sam wynik do czasu akcji admina
  organizacji. T15 wstrzymane na 1/4 tur. Spece poprawione i zrecenzowane (T15 fix e954150;
  T16/T17 czyste).
- Lekcja procesowa (do FEEDBACK): diag (żądania sterujące) NIE jest pełnym preflightem dostępu —
  pełny preflight inferencji wymaga pierwszego zielonego wykonania; koszt poznania: 1 tura.

## PAKIET GLM — implementacja (sonnet): DONE_WITH_CONCERNS

- 7 commitów na `domkniecie/z16-glm-provider`: 2f8d3a6 (konfiguracja fail-closed + kontrakt +
  polityka środowiska bez odczytu poświadczeń), 26f6751 (UI/diag/e2e provider-aware + nowe
  negatywy), af8ca1a (koperta dowodowa provider-aware + rejestr GLM sufit 25), 19626b0 (macierz:
  status „informacyjne / poza bramką", klasyfikacja właściciela), 50f9b9d (dokumentacja decyzji),
  af1e7b9 (typ strażnika macierzy), eb6a0b8 (preflight czyta sufit AKTYWNEGO rejestru).
- verify=0 (72 pliki / 1158 testów; nowy tests/provider-mode.test.ts — 21 fail-closed, wartownik
  braku odczytu pliku poświadczeń); e2e=0 (228, 17,1 min, domyślny tryb subscription + blok GLM
  w auth-limits). Lockfile i ARCHITECTURE.md nietknięte; zero prób modelowych; zero tokenu w plikach.
- Obawy: (1) CLI w glm czyta swój IZOLOWANY CLAUDE_CONFIG_DIR — zabezpieczone konstrukcyjnie,
  bez osobnej obserwacji; (2) accountInfo SDK w glm — oczekiwanie zakodowane w stand-inie,
  do potwierdzenia `pnpm probe:sdk-session` (0 tur) po recenzji.
- Recenzja bezpieczeństwa: DISPATCHED (opus, brief glm-c-brief.md; diff 348 KB, 34 pliki).

## PAKIET GLM — recenzja bezpieczeństwa (opus): zatwierdzona WARUNKOWO

- Spec ✅ (pkt po pkt PROMPT), jakość: zatwierdzona pod warunkiem F1+F2 przed pierwszą turą.
- **F1 (Important)**: /api/sdk-session bez `provider` (http/app.ts:382, index.ts:188) — glm opisuje
  ścieżkę subskrypcji; ścieżka produkcyjna niepokryta testem. **F2 (Important)**: strażnik
  CLAUDE_CONFIG_DIR przepuszcza dosłowne `~/.claude` (tylda nierozwijana; potwierdzone próbą na
  loadConfig). Minory F3-F6 odroczone (F3 do rozważenia przy F2).
- Granica poświadcń TRZYMANA: zero ścieżek wycieku tokena (logi/status/dowody/config = ORIGIN +
  nazwa polityki); skruby API_KEY/Bedrock/Vertex bezwarunkowe; wartownik „plik nieczytany"
  atakowo solidny; rejestry rozdzielone i puste; macierz uczciwa (187+7+2+4=200, otwarte 9,
  L11.11 celowo otwarte — ramię plikowe to funkcja bezpieczeństwa).
- verify odtworzony przez recenzenta: 0 (72/1158). Zakazy dochowane (zero nowych dowodów,
  lockfile/ARCHITECTURE nietknięte, 8791 tylko w kontekście).
- Fix round 1/5: DISPATCHED (F1 provider do sondy + test; F2 tylda + negatyw; F3 jeśli tania).
- Ścieżka po fixie: scoped re-review (opus) → merge → `pnpm probe:sdk-session` glm (0 tur) →
  T15/T16/T17 na GLM (rejestr glm.json, sufit 25), nigdy 8791.

## PAKIET GLM — fix round 1/5: complete (commit 6b92fae)

- F1: provider dispatchowany do sondy /api/sdk-session (SessionProbe(provider?)) + test jednostkowy glm.
- F2: odmowa CLAUDE_CONFIG_DIR z członem `~` + negatyw. F3: odmowa katalogu wewnątrz drzewa
  ~/.claude (też po realResolve) + negatyw. provider-mode: 26 testów; targeted 6 plików/153 testy=0;
  typecheck=0, build=0.
- DEVIACJA procesowa (odnotowana): implementator wykonał 1-turową próbę dymną GLM (izolowana
  instancja 8796, pusty izolowany CLAUDE_CONFIG_DIR w tmp, token z env operatora niewypisywany):
  /api/status auth.method=glm/glm_explicit, model glm-5.3-flash[1m]; RUN_FINISHED „Działa." (~8 s).
  Koszt: 1 tura GLM. Zrobione po fixie F1-F3, ale przed re-review — do oceny w re-review.
- Scoped re-review DISPATCHED (opus, review-eb6a0b8..6b92fae).

## DECYZJE WŁAŚCICIELA (AskUserQuestion, ~22:2x) — edycje spec + próby

1. Zmiany ARCHITECTURE.md + docs/versions/ = **własność właściciela, zostaw nietknięte** — skommituje
   je sam/a. Bramki dryfu (ACCEPTANCE/BACKLOG stale) pozostają czerwone do czasu jego commita;
   wtedy acceptance:render + bramki od nowa.
2. **Wstrzymaj wszystkie próby modelowe** do jednoznacznego sygnału (edycja spec w toku).
3. Implikacja: nowe L11.12 (tryby zgód) ≠ stary spec T17 — T17 wymaga przepracowania; T15 (L1.6,
   L7.13, L11.7) nietknięte edycją, gotowe do odpalenia po sygnale.

## Stan końcowy sesji (po decyzjach)

- Integracja: 23c2802 (merge GLM) + 7db6634 (sonda provider-aware) + raport; drzewo: + obce edycje
  właściciela (nietknięte). Macierz: 200 = 187/7/2/4 informacyjne, 8/12 warstw.
- GLM: pakiet scalony po re-review (F1-F3 ADDRESSED, 0 C/I); sonda glm = dowód
  z12-bl04/sesja-sdk-glm.json; rejestr glm.json 1/25 (tura dymna zaksięgowana).
- Próby: WSTRZYMANE. Do wznowienia po sygnale właściciela: T15 (4 glm), T16 (1), T17 po
  przepracowaniu nowego L11.12, ew. REPEAT izolacji.
- Budżety: Claude z11 22/25 (zamrożony); GLM 1/25.
