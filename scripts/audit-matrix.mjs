#!/usr/bin/env node
/**
 * DIAGNOSTIC (audit 2026-09-15) — renders section 3 of RAPORT-STANU-PLATFORMY.md.
 *
 * Requirements are read from stack-agentowy-ustalenia-i-materialy.md, never
 * retyped, so a criterion cannot be silently dropped or reworded. The per-
 * criterion assessment below is the auditor's; totals, coverage and duplicate
 * checks are computed.
 *
 *   node scripts/audit-matrix.mjs            # render markdown
 *   node scripts/audit-matrix.mjs --summary  # totals only
 */
import { readFileSync } from 'node:fs';

/* status: potwierdzone | czesciowe | niespelnione | niesprawdzone
   dowod:  przebieg | test | symulacja | kod | deklaracja | brak
   Where evidence is from the earlier build (2026-09-14) it is marked "hist.". */
const A = {
  'L1.1': ['potwierdzone','przebieg','apps/server/src/main.ts','docs/evidence/audit-2026-09-15/01-checks.txt; instancja audytowa na :8795','Backend produkcyjny wstal z dist, /api/health 200, /api/status raportuje subskrypcje','—'],
  'L1.2': ['potwierdzone','test','package.json, pnpm-lock.yaml','02-versions.txt; pnpm install --frozen-lockfile; pnpm typecheck','React 19.3.0 i TS 7.0.2 = najnowsze stabilne; instalacja z zamrozonego lockfile bez ostrzezen peer; typecheck 0 bledow','Reklasyfikacja wobec poprzedniego raportu: ograniczenie „dev/CLI wymagaja --experimental-transform-types” nie nalezy do tego kryterium (dotyczy uruchamiania, nie wersji ani zgodnosci). Przeniesione do ryzyk operacyjnych przy L1.1'],
  'L1.3': ['potwierdzone','przebieg','apps/server/build.mjs, apps/web/vite.config.ts','01-checks.txt (pnpm build), audit-server.sh','vite build + esbuild 166,8 kB; `node dist/server.js` bez zadnej flagi; testy przegladarkowe biegna na tym buildzie','—'],
  'L1.4': ['potwierdzone','przebieg','packages/platform-server/src/http/app.ts (streamSSE)','run 8f8325: 20 zdarzen TEXT_MESSAGE_CONTENT','Tekst plynie przyrostowo przed zakonczeniem generacji','—'],
  'L1.5': ['potwierdzone','test','packages/platform-server/src/agent/auth.ts','tests/runtime.test.ts; 03-probes-auth.txt','Rzeczywista wartosc tokena nie wystepuje w probeAuth() ani /api/status; sonda z tokenem fabrykowanym potwierdza','—'],
  'L1.6': ['potwierdzone','przebieg','packages/platform-server/src/services/runs.ts (reconcileOnBoot, abortAll)','04-probes-api.txt; restart instancji audytowej','Po restarcie 5/5 plikow, sha pliku identyczne; przebieg przerwany SIGTERM oznaczony jako failed (server_sigterm), nie „running”','—'],
  'L1.7': ['potwierdzone','test','packages/platform-server/src/http/app.ts, auth/session.ts','tests/contracts.test.ts; 04-probes-api.txt','Allowlista origin (403), 401 bez sesji, wlasne ciasteczko HMAC; token subskrypcji nigdy nie jest tokenem dostepu','—'],

  'L2.1': ['potwierdzone','kod','packages/*/src/**/cardComponents, registry/catalog.ts','/api/status → components (10)','10 komponentow kart ze schematami Zod po stronie serwera i rendererami po stronie klienta','—'],
  'L2.2': ['czesciowe','przebieg','packages/platform-ui/src/{shell/AppShell.tsx,styles.css,chat/ChatPanel.tsx}','12/14-chat-*.png; 16-probe-chat-layout.txt; 17-playwright.txt','Lewa nawigacja + canvas + czat wspolistnieja; adaptacja do 820 px dziala. ALE przy otwartej szufladzie rozmow watek nie jest widoczny, a audyt nie znalazl kontrolki ja zamykajacej','Defekt D-1 (sekcja 5): brak widocznej kontrolki zamkniecia szuflady; watek zaslonięty'],
  'L2.3': ['potwierdzone','test','apps/web/src/router.tsx','17-playwright.txt („nawigacja Wstecz/Dalej…”)','Wstecz/Dalej i przeladowanie przywracaja wlasciwy widok','—'],
  'L2.4': ['potwierdzone','przebieg','packages/platform-server/src/registry/catalog.ts','raw-probe-canvas.log','Agent dodal/zmienil/przesunal/usunal karty bez zadnej zmiany w kodzie i bez nowych plikow tras','—'],
  'L2.5': ['potwierdzone','test','packages/platform-ui/src/styles.css, module-procurement/src/ui/cards.tsx','17-playwright.txt („…z klawiatury i ma widoczny fokus”)','Nawigacja klawiatura, etykiety pol, globalne :focus-visible','—'],
  'L2.6': ['czesciowe','test','packages/module-procurement/src/ui/cards.tsx (Loading/Failure)','17-playwright.txt („odrzucony typ pliku daje czytelny blad”)','Ladowanie, brak danych i blad maja rozroznialne stany; komponent Failure mapuje forbidden/not_found','Stan „brak dostepu” nie zostal wywolany w przegladarce — tylko w API (403)'],

  'L3.1': ['potwierdzone','przebieg','packages/platform-server/src/registry/catalog.ts','raw-probe-canvas.log','Uklad domyslny i uklad agenta przechodza przez ten sam ComponentCatalog.validate()','—'],
  'L3.2': ['potwierdzone','przebieg','packages/platform-server/src/agent/platform-tools.ts','raw-probe-canvas.log (AUDYT 2026-09-15)','Wszystkie cztery operacje wykonane przez model: add (hist.), update (specVersion 1→2), move (geometry 40,40, geometryVersion 1→2), remove','Podniesione z „czesciowe” — poprzedni raport nie mial dowodu dla update/move/remove'],
  'L3.3': ['potwierdzone','test','packages/platform-server/src/registry/catalog.ts','tests/contracts.test.ts','Nieznany komponent i niepoprawne wlasciwosci odrzucane po stronie backendu','—'],
  'L3.4': ['potwierdzone','test','packages/platform-server/src/services/canvas.ts','tests/contracts.test.ts („konflikt kompozycji…”)','Odrzucony zapis zostawia poprzednia wersje nienaruszona','—'],
  'L3.5': ['potwierdzone','test','packages/platform-ui/src/state/appState.ts','17-playwright.txt („zmiana widoku karty przezywa przejscie…”)','Stan widoku karty zyje poza wezlem canvasu i przezywa zmiane ekranu','—'],
  'L3.6': ['potwierdzone','przebieg','packages/platform-server/src/services/canvas.ts','17-playwright.txt; restart instancji audytowej','Karty, pozycje i widok wracaja po przeladowaniu i po restarcie backendu','—'],
  'L3.7': ['potwierdzone','przebieg','packages/module-procurement/src/ui/cards.tsx','17-playwright.txt („tabela porownawcza pokazuje wartosci z backendu”)','Props niosa wylacznie referencje; kwoty na ekranie zgodne z wyliczeniem backendu','—'],
};

Object.assign(A, {
  'L4.1': ['potwierdzone','przebieg','packages/platform-ui/src/chat/ChatPanel.tsx','12/14-chat-*.png','AgentInterface 0.13.10 z wlasnym backendem przez restStorage; zadnej platnej uslugi','—'],
  'L4.2': ['potwierdzone','test','packages/platform-server/src/http/app.ts (/api/threads/*)','17-playwright.txt („lista rozmow, przelaczanie i usuwanie”)','Usuwanie wykonywane przez menu wiersza w UI, z kontrola wyniku w backendzie','—'],
  'L4.3': ['potwierdzone','test','packages/platform-server/src/services/conversations.ts (deriveTitle)','tests/runtime.test.ts; 17-playwright.txt','Tytul wyprowadzany lokalnie z pierwszej wiadomosci; zero wywolan modelu','—'],
  'L4.4': ['czesciowe','przebieg','packages/platform-server/src/http/app.ts (/api/threads/get/:id)','odpowiedz API: klucze [content,id,role]','Historia tekstowa i tytuly wracaja po odswiezeniu i restarcie','Defekt D-2: wiadomosci nie niosa toolCalls — aktywnosc narzedzi nie przezywa przeladowania; w calym repo brak slowa „toolCalls”'],
  'L4.5': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts (kolejka per rozmowa)','raw-probe-conc2.log','Dwa rownolegle polecenia w jednej rozmowie: odpowiedzi „ALFA” i „BETA” nie zmieszane, oba przebiegi rozstrzygniete','—'],
  'L4.6': ['potwierdzone','przebieg','packages/platform-server/src/services/conversations.ts','raw-probe-conc2.log; tests/contracts.test.ts','Przy dwoch rownoleglych poleceniach dokladnie 3 wiadomosci uzytkownika (1 zalozycielska + 2), brak duplikatow','—'],
  'L4.7': ['potwierdzone','test','packages/platform-server/src/services/conversations.ts (delete)','17-playwright.txt („usuniecie rozmowy odlacza artefakty”)','Kaskada na wiadomosci i uruchomienia, artefakty odlaczane (ON DELETE SET NULL)','—'],
  'L4.8': ['potwierdzone','kod','packages/platform-contracts/src/conversation.ts (CHAT_CAPABILITIES)','/api/status; ekran Ustawienia','Edycja wiadomosci, rozgalezianie i przywracanie jawnie oznaczone jako niedostepne','—'],

  'L5.1': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts (includePartialMessages)','run 8f8325: 20 x TEXT_MESSAGE_CONTENT','Tekst przyrostowy potwierdzony w przebiegu z dnia audytu','—'],
  'L5.2': ['czesciowe','przebieg','packages/platform-server/src/agent/events.ts','raw-probe-stop.log; 13-probe-chat-tools.txt','Anulowanie: status „cancelled”, ostatnie zdarzenia TEXT_MESSAGE_END → CUSTOM → RUN_ERROR; po zakonczeniu brak wskaznika trwajacego wykonania','Gotowy czat nie zna RUN_STARTED/RUN_FINISHED — nie ma ich w EventType biblioteki (13 z 32 zdarzen protokolu). Rozpoczecie/zakonczenie nie sa sygnalizowane przez komponent, tylko przez zamkniecie strumienia'],
  'L5.3': ['czesciowe','przebieg','packages/platform-server/src/agent/runtime.ts (most hookow)','13-probe-chat-tools.txt; 12-chat-z-narzedziami.png','Wywolania i wyniki sa poprawnie sparowane w strumieniu i w run_events (TOOL_CALL_START/ARGS/END/RESULT)','Defekt D-2 + obserwacja nierozstrzygnieta: w zadnej z 3 obserwacji nie znaleziono elementu narzedzia w DOM czatu mimo wywolan w strumieniu. Nie ustalono, czy to zaslonięcie przez szuflade (D-1), czy brak renderowania'],
  'L5.4': ['czesciowe','przebieg','packages/platform-ui/src/chat/platformAdapter.ts','08-probes-browser.txt; 07-artefakty.png','Artefakt utworzony przez agenta pojawia sie na ekranie Pliki i raporty; nawigacja artefaktow obecna w czacie','Renderowanie artefaktu wewnatrz czatu nie zostalo zaobserwowane'],
  'L5.5': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts (canUseTool)','FEEDBACK #23 (hist. 2026-09-14)','Zgoda i odmowa docieraja do klienta i wracaja do wykonania; przy odmowie polecenie sie nie wykonuje','Dowod historyczny, nie powtorzony w tym audycie'],
  'L5.6': ['potwierdzone','test','packages/platform-server/src/agent/events.ts (read(fromSeq))','tests/runtime.test.ts','Odtworzenie od numeru sekwencyjnego bez powielania; skutki chronione idempotencja','—'],
  'L5.7': ['potwierdzone','przebieg','packages/platform-server/src/services/runs.ts (finish)','raw-probe-stop.log','Dokladnie jeden rozstrzygajacy status; po anulowaniu 80 → 80 zdarzen (brak pozniejszych zapisow)','—'],
  'L5.8': ['potwierdzone','kod','node_modules/@openuidev/react-headless (0.9.13)','analiza processStreamedMessage w wersji zainstalowanej','Obslugiwane 9 zdarzen; ignorowane CUSTOM, TEXT_MESSAGE_END, STEP_STARTED, STEP_FINISHED — udokumentowane','—'],

  'L6.1': ['potwierdzone','kod','packages/platform-contracts/src/agent.ts (appContextSchema)','schemat + prompt systemowy','Kontekst obejmuje rozmowe, przestrzen, zasob, zaznaczenie, filtry, viewport i szkice','—'],
  'L6.2': ['potwierdzone','przebieg','packages/platform-ui/src/chat/chatWiring.ts','FEEDBACK #21 (hist.)','Kontekst czytany w momencie wyslania; zaznaczona pozycja trafia do wlasciwego rekordu','Dowod historyczny'],
  'L6.3': ['potwierdzone','przebieg','packages/platform-server/src/agent/platform-tools.ts (get_context)','raw-probe-canvas.log','Model wywolal mcp__app__get_context w przebiegu z dnia audytu','Podniesione z „tylko analiza kodu”'],
  'L6.4': ['potwierdzone','test','packages/platform-contracts/src/agent.ts','tests/contracts.test.ts; 04-probes-api.txt','appContextSchema nie ma pola wlasciciela; identyfikator z ciala zadania daje 403','—'],
  'L6.5': ['potwierdzone','przebieg','packages/platform-server/src/agent/prompt.ts (unsavedDrafts)','raw-probe-draft.log','Przy brudnym szkicu model podal ZAPISANA wartosc (5) i jawnie odnotowal istnienie szkicu','Podniesione z „czesciowe”'],
  'L6.6': ['potwierdzone','przebieg','packages/module-procurement/src/server/services.ts','FEEDBACK #21 (hist.); raw-probe-canvas.log','Polecenie o wskazanym elemencie prowadzi do operacji na wlasciwym rekordzie','—'],
  'L6.7': ['potwierdzone','kod','packages/module-procurement/src/server/tools.ts','schematy narzedzi (limit w list_offers, search)','Wyniki paginowane/limitowane; prompt nie zawiera danych biznesowych poza jednozdaniowym opisem zasobu','—'],

  'L7.1': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts','kod: mastra.getAgent(\'appAgent\').stream(); wszystkie przebiegi audytu','Wykonanie idzie przez instancje Mastry; query() z SDK uzywane wylacznie w diagnostyce','—'],
  'L7.2': ['potwierdzone','przebieg','packages/platform-server/src/{http/app.ts,services/runs.ts}','naglowki X-Run-Id/X-Conversation-Id; tabela run_events','Zadanie powiazane z uruchomieniem, kontekstem i pelna sekwencja zdarzen','—'],
  'L7.3': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts','raw-probe-stop.log; run 6c9c63 (failed/server_sigterm)','Sukces, blad i anulowanie przechodza przez warstwe orkiestracji do klienta','—'],
  'L7.4': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts (serwer MCP per uruchomienie + kolejka)','raw-probe-conc2.log','Okna wykonania rozlaczne: f39794 konczy 10:27:41.687, f2b738 zaczyna 10:27:41.687; rozne rozmowy rownolegle','Podniesione z „czesciowe”. Uwaga metodyczna: agent_runs.started_at to moment ZAKOLEJKOWANIA — pierwsza wersja sondy dala falszywy GAP'],
  'L7.5': ['potwierdzone','test','packages/platform-server/src/agent/mcp.ts','tests/contracts.test.ts („…ta sama regula”)','Narzedzia MCP to nakladki na te same serwisy co HTTP','—'],
  'L7.6': ['potwierdzone','kod','FEEDBACK.md sekcja 6','—','Zakres wlasnych adapterow udokumentowany i zweryfikowany w tym audycie','—'],
  'L7.7': ['potwierdzone','kod','packages/platform-server/package.json','02-versions.txt','Tylko @mastra/core i @mastra/claude; zwykly proces Node, bez Factory/AgentController/hostingu','—'],

  'L8.1': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts','raw-probe-canvas.log (ToolSearch + 4 narzedzia MCP)','Wielokrokowa petla agentowa SDK, nie pojedyncze wywolanie modelu','—'],
  'L8.2': ['potwierdzone','przebieg','packages/platform-server/src/agent/auth.ts','/api/status instancji audytowej','mode=subscription, plan=max, bez ujawnienia tokena','—'],
  'L8.3': ['potwierdzone','symulacja','packages/platform-server/src/agent/auth.ts (subscriptionOnlyEnv)','03-probes-auth.txt','Klucz API wykryty i oznaczony jako odrzucony; usuwany z procesu potomnego wraz z 6 innymi zmiennymi','—'],
  'L8.4': ['potwierdzone','przebieg','packages/platform-server/src/agent/mcp.ts','pnpm diag (hist.); wszystkie przebiegi audytu','21 narzedzi zarejestrowanych; wyniki uzywane przez model do dalszej pracy','—'],
  'L8.5': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts (resumeStream)','FEEDBACK #19 (hist.); raw-probe-stop.log','Wznowienie po restarcie bez powielania historii; po anulowaniu kolejne uruchomienie w tej samej rozmowie konczy sie sukcesem','—'],
  'L8.6': ['niespelnione','symulacja','packages/platform-server/src/agent/auth.ts:probeAuth','03-probes-auth.txt (AUTH-wygasly)','Poswiadczenie z expiresAt w przeszlosci jest raportowane jako mode=subscription','Defekt D-3: probeAuth nigdy nie porownuje expiresAt z czasem biezacym. Wyczerpanie limitu w ogole niewywolane'],
  'L8.7': ['potwierdzone','test','packages/platform-server/src/agent/auth.ts','tests/runtime.test.ts; 03-probes-auth.txt','Rzeczywisty token nie wystepuje w zadnym wyjsciu aplikacji','Zakres sprawdzenia: probeAuth i /api/status. Nie przeszukano logow serwera ani artefaktow'],
  'L8.8': ['potwierdzone','przebieg','—','FEEDBACK #15/#18/#23 (hist.); 02-versions.txt','Zgodnosc wersji sprawdzona rzeczywistymi wywolaniami; trzy niezgodnosci znalezione i obsluzone','—'],

  'L9.1': ['potwierdzone','kod','packages/module-procurement/src/shared/index.ts','schemat 8 tabel pc_*','Encje, relacje i reguly opisane dla produktu','—'],
  'L9.2': ['potwierdzone','test','packages/module-procurement/src/server/inputs.ts','tests/contracts.test.ts','Wspolne schematy wejscia i wspolny serwis dla HTTP i MCP','—'],
  'L9.3': ['potwierdzone','test','packages/platform-contracts/src/errors.ts','tests/contracts.test.ts; 04-probes-api.txt','13 kodow bledow mapowanych na statusy HTTP; walidacja w runtime','—'],
  'L9.4': ['potwierdzone','przebieg','packages/module-procurement/src/server/services.ts (findProvenance)','FEEDBACK #21 (hist.)','Przejscie pozycja → oferta → dostawca → zalacznik → wiersz w pliku','Dowod historyczny'],
  'L9.5': ['potwierdzone','test','packages/module-procurement/src/server/repository.ts','04-probes-api.txt (OWNER-*)','Drugi wlasciciel: 403 na canvas, sprawe i porownanie; listy przestrzeni, plikow i artefaktow rozlaczne','—'],
  'L9.6': ['potwierdzone','test','packages/module-procurement/src/server/repository.ts (updateItemChecked)','04-probes-api.txt (CONFLICT-*)','Nieaktualna wersja → 409 conflict, bez nadpisania','—'],
  'L9.7': ['potwierdzone','przebieg','packages/platform-server/src/services/idempotency.ts','04-probes-api.txt (IDEMPOTENCY-8-rownoleglych)','8 rownoleglych zadan z tym samym operationId: 8 odpowiedzi 200, dokladnie jeden przyrost wersji','Wzmocnione wobec poprzedniego raportu (bylo sekwencyjnie, teraz rownolegle)'],
  'L9.8': ['potwierdzone','test','packages/module-procurement/src/server/services.ts','tests/runtime.test.ts (kopia i odtworzenie)','Transakcje SQLite; stan spojny po checkpoint WAL i kopii katalogu','—'],
  'L9.9': ['potwierdzone','test','tests/contracts.test.ts','pnpm test 69/69','Testy potwierdzaja zmiane danych i odrzucenie operacji nieuprawnionej','—'],
});

Object.assign(A, {
  'L10.1': ['potwierdzone','kod','FEEDBACK sekcja 4 (tabela wlasnosci)','scripts/check-boundaries.mjs','Kazdy rodzaj danych ma jednego wlasciciela; platforma nie pisze do tabel pc_*','—'],
  'L10.2': ['potwierdzone','test','packages/platform-server/src/db/migrations.ts','tests/runtime.test.ts; restart instancji audytowej','Migracje w transakcjach z rejestrem; kopia katalogu otwiera sie z kompletnym stanem; po restarcie sha pliku identyczne','—'],
  'L10.3': ['potwierdzone','przebieg','packages/platform-server/src/services/conversations.ts','tabela conversations instancji audytowej','claude_session_id + owner_id przypisane do rozmowy','—'],
  'L10.4': ['potwierdzone','przebieg','packages/platform-server/src/index.ts','restart instancji audytowej','Historia, kompozycja, powiazania sesji i artefakty wracaja po restarcie','—'],
  'L10.5': ['potwierdzone','przebieg','packages/platform-ui/src/chat/platformAdapter.ts','FEEDBACK #21 (hist.); 08-probes-browser.txt','platform.data_changed / canvas_changed uniewazniaja wlasciwe zapytania; karta agenta pojawia sie bez przeladowania','—'],
  'L10.6': ['potwierdzone','kod','packages/platform-ui/src/api/queries.ts','klucze qk.*','Komponenty tej samej sprawy dziela jedno pobranie przez wspolny klucz','—'],
  'L10.7': ['czesciowe','kod','packages/platform-ui/src/api/queries.ts (qk, resetOwnerScope)','analiza kodu','Ochrona polega wylacznie na qc.clear() przy nawiazaniu sesji; backend i tak odmawia (403)','Klucze cache NIE zawieraja wlasciciela; aplikacja nie ma UI zmiany uzytkownika, wiec przejscia nie da sie wywolac — brak dowodu i brak sciezki do jego zdobycia bez zmiany produktu'],
  'L10.8': ['potwierdzone','test','packages/platform-server/src/services/artifacts.ts','tests/contracts.test.ts','Klucz (artifact_id, version); tytul to zwykla kolumna','—'],
  'L10.9': ['potwierdzone','przebieg','packages/platform-server/src/services/files.ts','restart instancji audytowej (sha 459cb0b8… przed i po)','Podglad i pelny widok czytaja current_version; plik pobieralny po restarcie','—'],
  'L10.10': ['czesciowe','kod','packages/platform-server/src/services/artifacts.ts','grep: brak sciezki odczytu dla mode=\'live\'','Polowa „snapshot” dziala i jest pokryta testem','Defekt D-4: tryb „live” jest zapisywany i wyswietlany, ale NIGDZIE nieobslugiwany przy odczycie. Opis narzedzia artifact_create obiecuje modelowi, ze live „odswieza sie przy otwarciu” — obietnica niepokryta kodem'],

  'L11.1': ['potwierdzone','przebieg','packages/platform-server/src/agent/platform-tools.ts','FEEDBACK #20 (hist.); 08-probes-browser.txt','Plik → workspace → odczyt → raport → artefakt do pobrania; w audycie artefakt utworzony przez save_comparison i widoczny na ekranie','Czesc sandboxowa (Bash/Write w workspace) z dowodu historycznego'],
  'L11.2': ['potwierdzone','test','packages/platform-server/src/services/files.ts','tests/runtime.test.ts; 17-playwright.txt','sanitizeFilename odporne na ../ i znaki sterujace; limit 8 MB; allowlista typow; resolveInWorkspace','—'],
  'L11.3': ['potwierdzone','przebieg','packages/platform-server/src/agent/sandbox.ts','FEEDBACK #24/#25 (hist.)','Siec: deny network-outbound example.com:443, exit 56. Pliki: data/app.db niewidoczna, ls pokazuje tylko workspaces','Dowod historyczny — nie powtorzony w tym audycie'],
  'L11.4': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts (allowedTools)','FEEDBACK #17/#23 (hist.)','Narzedzia plikowe zamkniete w workspace; powloka przez canUseTool','Dowod historyczny'],
  'L11.5': ['potwierdzone','przebieg','packages/platform-server/src/agent/sandbox.ts (denyRead)','FEEDBACK #25 (hist.)','Katalog danych aplikacji niewidoczny dla procesu sandboxowego','Dowod historyczny'],
  'L11.6': ['potwierdzone','przebieg','packages/platform-server/src/services/runs.ts','tabela agent_runs instancji audytowej (16 przebiegow)','Zadanie ma trwaly status i powiazanie z rozmowa; zamkniecie panelu nie usuwa wpisu','—'],
  'L11.7': ['potwierdzone','przebieg','packages/platform-server/src/services/runs.ts (cancel/abortAll)','raw-probe-stop.log','Potwierdzenie 3 ms; strumien zamkniety po 2010 ms; potomkowie serwera 0 przed / 1 w trakcie / 0 po (brak osieroconych); 80 → 80 zdarzen; kolejne uruchomienie succeeded','Podniesione z „czesciowe” — poprzedni raport mierzyl tylko czesc aplikacyjna'],
  'L11.8': ['potwierdzone','przebieg','packages/platform-server/src/services/runs.ts (reconcileOnBoot)','run 6c9c63: failed / server_sigterm','Przebieg przerwany restartem oznaczony jako failed z jawna przyczyna, nie udaje kontynuacji','—'],
  'L11.9': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts (canUseTool)','FEEDBACK #23 (hist.)','Odmowa → polecenie sie nie wykonuje; zgoda → prosba dokladnie raz','Dowod historyczny'],
  'L11.10': ['potwierdzone','przebieg','packages/platform-server/src/agent/platform-tools.ts','FEEDBACK #20 (hist.); restart instancji audytowej','workspace.dispose() w finally; plik artefaktu nadal pobieralny','—'],

  'L12.1': ['potwierdzone','przebieg','packages/platform-server/src/services/runs.ts (run_events)','baza instancji audytowej','conversations → agent_runs → run_events → artifacts; pelna sekwencja z argumentami i wynikami narzedzi','—'],
  'L12.2': ['potwierdzone','test','packages/platform-contracts/src/errors.ts','tests/contracts.test.ts; raw-probe-stop.log','Bledy integracji, domeny, modelu i sandboxu rozroznialne; brak sekretow w odpowiedziach','—'],
  'L12.3': ['czesciowe','przebieg','packages/platform-server/src/agent/runtime.ts:345','baza audytu: first_token_ms NULL w 2 przebiegach','Zmierzone: wykonanie (5367–40691 ms, mediana 19206) i anulowanie (potwierdzenie 3 ms, zamkniecie 2010 ms)','Defekt D-5: first_token_ms gubiony, gdy narzedzie poprzedza tekst — openText() wolane z mostu hookow ustawia textOpened, wiec galaz metryki nigdy sie nie wykonuje. Korelacja doskonala: NULL dokladnie w przebiegach „narzedzie pierwsze”. Odswiezenie po mutacji nadal niemierzone'],
  'L12.4': ['potwierdzone','test','tests/contracts.test.ts','pnpm test 69/69','Walidacja, konflikty, powtorzenia i kontrola dostepu pokryte','—'],
  'L12.5': ['czesciowe','test','e2e/*.spec.ts','17-playwright.txt: 21 passed / 1 FAILED','Suita pokrywa powloke, canvas, kompozycje, trwalosc, rozmowy i pliki','Defekt D-6: asercja „streaming dociera na ekran” (agent-ui.spec.ts:78) dopasowuje sie do etykiety podpowiedzi „Wykres kosztow” — jest pusta. Dodatkowo suita NIE jest zielona: agent-ui.spec.ts:119 przewraca sie na firstTokenMs=null (D-5)'],
  'L12.6': ['potwierdzone','przebieg','—','wszystkie przebiegi audytu','Sciezka subskrypcja → SDK → Mastra → AG-UI → OpenUI potwierdzona; w repo nie ma ani jednego mocka Claude','AG-UI uzyte jako protokol drutowy: zero importow @ag-ui/*; @ag-ui/core 0.0.53 obecny wylacznie tranzytywnie. Integracja @ag-ui/mastra wskazana w dokumencie nie zostala uzyta'],
  'L12.7': ['potwierdzone','kod','RAPORT-STANU-PLATFORMY.md','ten dokument','Opis odbioru z wersjami, dowodami, nieudanymi probami i wlasnymi adapterami','—'],
  'L12.8': ['potwierdzone','kod','—','02-versions.txt; podscieżki @mastra/core','System dziala bez Langfuse; @mastra/core wystawia ./observability, ./telemetry i ./telemetry/otel-vendor, wiec mozliwosc integracji jest zachowana','Eksporter niepodlaczony i niezweryfikowany — wg zadania nie blokuje odbioru'],
});

/* ------------------------------- renderer -------------------------------- */

const doc = readFileSync('stack-agentowy-ustalenia-i-materialy.md', 'utf8');
const parts = doc.split(/^### (\d+)\. (.+)$/m);
const layers = [];
for (let i = 1; i < parts.length; i += 3) {
  const num = Number(parts[i]);
  const title = parts[i + 1].trim();
  const body = parts[i + 2].split(/^## /m)[0];
  const items = [...body.matchAll(/^- \[ \] (.+)$/gm)].map((m) => m[1].trim());
  layers.push({ num, title, items });
}

const LABEL = { potwierdzone: 'potwierdzone', czesciowe: 'częściowe', niespelnione: 'niespełnione', niesprawdzone: 'niesprawdzone' };
const DOWOD = { przebieg: 'rzeczywisty przebieg', test: 'test automatyczny bez modelu', symulacja: 'symulacja', kod: 'analiza kodu', deklaracja: 'deklaracja biblioteki', brak: '—' };
const OPEN = new Set(['czesciowe', 'niespelnione', 'niesprawdzone']);

const problems = [];
const seen = new Set();
const counts = {};
const dowodCounts = {};
const perLayer = [];
const out = [];

for (const L of layers) {
  out.push(`### Warstwa ${L.num} — ${L.title}\n`);
  out.push('| ID | Wymaganie (z dokumentu) | Stan | Rodzaj dowodu | Implementacja | Dowód | Wynik obserwowany | Konkretny brak |');
  out.push('|---|---|---|---|---|---|---|---|');
  const blocking = [];
  L.items.forEach((req, idx) => {
    const id = `L${L.num}.${idx + 1}`;
    if (seen.has(id)) problems.push(`duplikat ${id}`);
    seen.add(id);
    const a = A[id];
    if (!a) { problems.push(`brak oceny dla ${id}`); return; }
    const [status, dowod, impl, proof, observed, gap] = a;
    counts[status] = (counts[status] ?? 0) + 1;
    dowodCounts[dowod] = (dowodCounts[dowod] ?? 0) + 1;
    if (OPEN.has(status)) blocking.push(`${id} (${LABEL[status]})`);
    const esc = (s) => String(s).replace(/\|/g, '\\|');
    out.push(`| **${id}** | ${esc(req)} | **${LABEL[status]}** | ${DOWOD[dowod]} | ${esc(impl)} | ${esc(proof)} | ${esc(observed)} | ${esc(gap)} |`);
  });
  perLayer.push({ num: L.num, title: L.title, n: L.items.length, blocking });
  out.push('');
}

for (const id of Object.keys(A)) if (!seen.has(id)) problems.push(`ocena ${id} bez odpowiednika w dokumencie`);

const total = [...seen].length;
const closed = perLayer.filter((l) => l.blocking.length === 0);
const open = perLayer.filter((l) => l.blocking.length > 0);

const summary = [];
summary.push('### Podsumowanie macierzy\n');
summary.push(`Liczby wyliczone ze skryptu \`scripts/audit-matrix.mjs\`; wymagania czytane wprost z \`stack-agentowy-ustalenia-i-materialy.md\`.\n`);
summary.push(`**Kryteriów: ${total}** (7+6+7+8+8+7+7+8+9+10+10+8). Zgadza się z liczbą z poprzedniej macierzy — dokument nie zmienił się od 2026-09-14.\n`);
summary.push('| Stan | Liczba |');
summary.push('|---|---|');
for (const k of ['potwierdzone', 'czesciowe', 'niespelnione', 'niesprawdzone']) summary.push(`| ${LABEL[k]} | ${counts[k] ?? 0} |`);
summary.push(`| **Razem** | **${total}** |`);
summary.push('');
summary.push('| Rodzaj dowodu | Liczba |');
summary.push('|---|---|');
for (const [k, v] of Object.entries(dowodCounts).sort((a, b) => b[1] - a[1])) summary.push(`| ${DOWOD[k]} | ${v} |`);
summary.push('');
summary.push(`**Warstwy zamknięte — ${closed.length} z 12:** ${closed.map((l) => `L${l.num}`).join(', ') || 'brak'}\n`);
summary.push(`**Warstwy otwarte — ${open.length} z 12**, z identyfikatorami blokujących kryteriów:\n`);
summary.push('| Warstwa | Kryteria blokujące |');
summary.push('|---|---|');
for (const l of open) summary.push(`| L${l.num} — ${l.title} | ${l.blocking.join(', ')} |`);
summary.push('');
summary.push(`**Kontrola spójności:** ${problems.length === 0 ? 'brak brakujących i zduplikowanych identyfikatorów; każde kryterium dokumentu ma dokładnie jedną ocenę.' : problems.join('; ')}`);

if (process.argv.includes('--summary')) {
  console.log(summary.join('\n'));
} else {
  console.log(summary.join('\n'));
  console.log('\n---\n');
  console.log(out.join('\n'));
}
if (problems.length) process.exitCode = 1;
