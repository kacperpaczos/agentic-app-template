# Faza czerwona — granica narzedzi plikowych (BL-03)

Data: 2026-10-08, gałąź `feat/bl03-granica-narzedzi-plikowych`, PRZED zmianą w `runtime.ts` (stary kształt `allowedTools`). Polecenie: `pnpm vitest run tests/consent-modes.test.ts tests/consent.test.ts` — kod wyjścia 1.

Zmienione asercje (nowy kształt niezmiennika): plikowe (`Read`, `Write`, `Edit`, `Glob`, `Grep`) nie mogą być w `allowedTools` w żadnym trybie; na liście wyłącznie narzędzia aplikacji. Obie padły. Nowe asercje braku regresji UX (Read w workspace → allow bez pytania) przeszły już na starym kodzie — są strażą, nie dowodem czerwonym.

```

 RUN  v5.0.0 /home/paczos/Documents/agentic-app-template

 ❯ tests/consent.test.ts (10 tests | 1 failed) 955ms
   ❯ macierz uprawnien narzedzi (3)
     ✓ trzy kategorie sa rozlaczne i kazda ma tresc 90ms
     ✓ decyduje o narzedziu po nazwie, a nieznane trafia do pytania 21ms
     × uruchomienie przekazuje SDK reguly zgodne z macierza 45ms
   ✓ bramka zgody (6)
     ✓ narzedzie zabronione jest odrzucone bez pytania uzytkownika 33ms
     ✓ narzedzie wymagajace zgody pyta i czeka; odmowa nie wykonuje operacji 39ms
     ✓ zgoda wykonuje operacje dokladnie raz, a powtorzona odpowiedz nie wykonuje jej drugi raz 47ms
     ✓ odpowiedz z requestId innego uruchomienia nie rozstrzyga niczego 43ms
     ✓ brak odpowiedzi konczy sie odmowa, nie zgoda 429ms
     ✓ oczekiwanie na zgode mozna zatrzymac, a uruchomienie konczy sie jako anulowane 40ms
   ✓ punkt HTTP odpowiedzi na zgode (1)
     ✓ odpowiedz na wlasciwym adresie rozstrzyga, a na cudzym uruchomieniu nie 159ms
 ❯ tests/consent-modes.test.ts (21 tests | 1 failed) 1040ms
   ✓ macierz decyzyjna trzech trybow (6)
     ✓ macierz: narzedzie MCP aplikacji 69ms
     ✓ macierz: narzedzie plikowe 21ms
     ✓ macierz: powloka — kategoria decyzja 21ms
     ✓ macierz: narzedzie nieznane 19ms
     ✓ macierz: narzedzie zabronione 20ms
     ✓ wywolanie bez trybu pozostaje zachowaniem obecnym (supervised) 20ms
   ❯ niezmienniki sdkOptions we wszystkich trybach (1)
     × allowedTools bez kategorii decyzja, disallowedTools = zabronione, bramka przekazana 63ms
   ✓ narzedzia plikowe docieraja do bramki (2)
     ✓ Read w workspace: bramka allow bez pytania (supervised) 31ms
     ✓ Read w workspace: bramka allow bez pytania (auto) 27ms
   ✓ narzedzie zabronione we wszystkich trybach (1)
     ✓ zero permissionRequest i zero skutku, niezaleznie od trybu 41ms
   ✓ tryb auto (1)
     ✓ Bash wykonuje sie bez permissionRequest i bez fazy oczekiwania na zgode 55ms
   ✓ tryb manual (2)
     ✓ odczyt MCP aplikacji pyta; odmowa zostawia zero skutku 36ms
     ✓ zgoda wykonuje odczyt dokladnie raz 38ms
   ✓ tryb zgody przy starcie runu (3)
     ✓ (c) brak pola consentMode w payloadzie: run jest supervised 60ms
     ✓ (d) niepoprawne consentMode: 400 i zaden run nie powstaje 23ms
     ✓ (e) tryb z payloadu trafia do agent_runs.consent_mode i do GET /api/tasks 32ms
   ✓ pendingPermission w centrum zadan (1)
     ✓ pojawia sie w fazie oczekiwania i znika po odpowiedzi 44ms
   ✓ katalog narzedzi MCP (1)
     ✓ nie zawiera narzedzia zmieniajacego tryb zgody 79ms
   ✓ brak eskalacji trybu w trakcie wykonania (1)
     ✓ consentMode w zadaniu zgody nie zmienia decyzji kolejnej bramki tego runu 250ms
   ✓ ponowienie (retry) dziedziczy tryb zgody (2)
     ✓ retry runu manual tworzy run manual 51ms
     ✓ retry runu bez zapisanego trybu (stary wiersz po migracji = supervised) tworzy supervised 35ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/consent-modes.test.ts > niezmienniki sdkOptions we wszystkich trybach > allowedTools bez kategorii decyzja, disallowedTools = zabronione, bramka przekazana
AssertionError: tryb supervised: wylacznie narzedzia aplikacji: expected [ 'mcp__app__get_context', …(28) ] to deeply equal [ 'mcp__app__get_context', …(23) ]

- Expected
+ Received

@@ -21,6 +21,11 @@
    "mcp__app__agent_views_list",
    "mcp__app__agent_view_create",
    "mcp__app__agent_view_update",
    "mcp__app__agent_view_remove",
    "mcp__app__ui_show_value",
+   "Read",
+   "Write",
+   "Edit",
+   "Glob",
+   "Grep",
  ]

 ❯ tests/consent-modes.test.ts:304:86
    302|         expect(options!.allowedTools, `tryb ${mode}: allowedTools ma b…
    303|       } else {
    304|         expect(options!.allowedTools, `tryb ${mode}: wylacznie narzedz…
       |                                                                                      ^
    305|           ...capturing.toolNames,
    306|         ]);

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  tests/consent.test.ts > macierz uprawnien narzedzi > uruchomienie przekazuje SDK reguly zgodne z macierza
AssertionError: Read na allowedTools omija straznikow sciezek: expected [ 'mcp__app__get_context', …(28) ] to not include 'Read'
 ❯ tests/consent.test.ts:187:92
    185|      */
    186|     for (const tool of TOOL_PERMISSION_MATRIX.auto) {
    187|       expect(options.allowedTools, `${tool} na allowedTools omija stra…
       |                                                                                            ^
    188|     }
    189|     for (const tool of TOOL_PERMISSION_MATRIX.consent) {

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  2 failed (2)
      Tests  2 failed | 29 passed (31)
   Start at  00:03:11
   Duration  8.14s (transform 63%, import 24%, tests 13%)

  Transform  transforming modules took 10.02s · 63% of tracked time, re-done on every run
             persist transforms across runs with fsModuleCache: true
             learn more: https://vitest.dev/guide/improving-performance#caching-between-reruns

```
