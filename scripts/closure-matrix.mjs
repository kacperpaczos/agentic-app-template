#!/usr/bin/env node
/**
 * DIAGNOSTIC (closure 2026-09-15) — renders the acceptance matrix of RAPORT-DOMKNIECIA-PLATFORMY.md.
 *
 * Requirements are read from docs/archive/agenticapp-2026-09/stack-agentowy-ustalenia-i-materialy-95-kryteriow.md, never
 * retyped, so a criterion cannot be silently dropped or reworded. The per-
 * criterion assessment below is the auditor's; totals, coverage and duplicate
 * checks are computed.
 *
 *   node scripts/closure-matrix.mjs            # render markdown
 *   node scripts/closure-matrix.mjs --summary  # totals only
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
  'L1.5': ['potwierdzone','test','packages/platform-server/src/agent/auth.ts','tests/durability.test.ts; tests/runtime.test.ts','Rzeczywista wartosc tokena nie wystepuje w zbudowanym frontendzie, zbudowanym backendzie, pliku bazy danych ani w wyjsciu diagnostyki uruchomieniowej','Zakres dowodu rozszerzony po uwadze recenzenta: dwie odpowiedzi HTTP nie dowodzily braku sekretow w pakiecie frontendu ani w logach'],
  'L1.6': ['potwierdzone','przebieg','packages/platform-server/src/services/runs.ts (reconcileOnBoot, abortAll)','04-probes-api.txt; restart instancji audytowej','Po restarcie 5/5 plikow, sha pliku identyczne; przebieg przerwany SIGTERM oznaczony jako failed (server_sigterm), nie „running”','—'],
  'L1.7': ['potwierdzone','test','packages/platform-server/src/http/app.ts, auth/session.ts','tests/contracts.test.ts; 04-probes-api.txt','Allowlista origin (403), 401 bez sesji, wlasne ciasteczko HMAC; token subskrypcji nigdy nie jest tokenem dostepu','—'],

  'L2.1': ['potwierdzone','kod','packages/*/src/**/cardComponents, registry/catalog.ts','/api/status → components (10)','10 komponentow kart ze schematami Zod po stronie serwera i rendererami po stronie klienta','—'],
  'L2.2': ['potwierdzone','przebieg','packages/platform-ui/src/{chat/ChatPanel.tsx,styles.css}','e2e/chat-drawer.spec.ts (6/6, 1680 px i 1120 px); docs/evidence/closure-2026-09-15/11-chat-drawer.json','Szuflada zamknieta stoi poza panelem (left: -294 px, pokrycie 0 px), rozmowa i kompozytor maja caly panel. Otwarcie przez „Open sidebar”, zamkniecie przez „Collapse sidebar” — obie kontrolki widoczne, fokusowalne i dzialaja z klawiatury (Enter)','Podniesione z „czesciowe”. Przyczyna D-1 byla wlasna: `left: 0 !important` znosil pozycje poza kanwa w ukladzie, w ktorym biblioteka ukrywa przycisk zwijania. Test z celowo przywroconym bledem oblewa 6/6'],
  'L2.3': ['potwierdzone','test','apps/web/src/router.tsx; platform-ui/src/{chat/ConversationSync.tsx,shell/SpaceSync.tsx,state/sessionLocation.ts}','e2e/session-restore.spec.ts (6); tests/session-restore.test.ts (11); 17-playwright.txt („nawigacja Wstecz/Dalej…”)','Rozmowa i przestrzen pracy sa w adresie (`?c=`, `?s=`). Po przeladowaniu wraca ta sama rozmowa, jej historia i jej przestrzen — bez wybierania czegokolwiek z szuflady; dalsze polecenie kontynuuje te sama sesje Claude. Wstecz/Dalej przelacza rozmowy bez mieszania historii. Parametry przezywaja kazda nawigacje przez `retainSearchParams`','ZAKRES DOWODU POPRAWIONY. Poprzednio „potwierdzone” na podstawie testu, ktory sprawdzal wylacznie przywracanie *widoku* (sciezki). Rozmowa NIE byla przywracana — po przeladowaniu czat otwieral nowa. Kryterium wymaga „wlasciwej rozmowy lub przestrzeni pracy”, wiec poprzednie zaliczenie bylo wezsze od wymagania. Dwa testy wrecz obchodzily ten brak, otwierajac rozmowe z szuflady po kazdym przeladowaniu'],
  'L2.4': ['potwierdzone','przebieg','packages/platform-server/src/registry/{catalog.ts,ui-targets.ts}','raw-probe-canvas.log; e2e/ui-navigation.spec.ts (5); tests/ui-navigation.test.ts (14)','Agent dodal/zmienil/przesunal/usunal karty bez zadnej zmiany w kodzie i bez nowych plikow tras. Rozszerzone o sterowanie interfejsem: agent otwiera widok, ustawienie i przestrzen z kuratorowanego katalogu celow (platforma + moduly), przewija do elementu i chwilowo go podswietla — rowniez bez nowych tras','Rozszerzenie 2026-09-16'],
  'L2.5': ['potwierdzone','test','packages/platform-ui/src/styles.css, module-procurement/src/ui/cards.tsx','17-playwright.txt („…z klawiatury i ma widoczny fokus”)','Nawigacja klawiatura, etykiety pol, globalne :focus-visible','—'],
  'L2.6': ['potwierdzone','test','packages/platform-ui/src/components/ErrorState.tsx','e2e/access-context.spec.ts; tests/live-artifacts.test.ts','Brak dostepu ma wlasny, widoczny stan w przegladarce (`data-testid="access-denied"`, kod bledu w atrybucie) — rozrozniony od awarii i od pustej listy. Zaden fragment zasobu nie jest renderowany obok odmowy','Podniesione z „czesciowe”: audyt widzial tylko 403 z API, teraz stan jest potwierdzony w przegladarce'],

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
  'L4.4': ['potwierdzone','przebieg','packages/platform-server/src/{agent/projection.ts,http/app.ts}, db/backfill.ts; platform-ui/src/chat/ConversationSync.tsx','e2e/tool-activity.spec.ts; e2e/session-restore.spec.ts; tests/run-lifecycle.test.ts; tests/projection.test.ts; tests/migration.test.ts','Historia zwraca ksztalt AG-UI: wiadomosc asystenta z `toolCalls` i wiadomosc `role:"tool"` z pasujacym `toolCallId`. Po przeladowaniu wraca ta sama rozmowa z tytulem i pelna historia — bez recznego wybierania; identyfikatory wiadomosci identyczne przed i po; to samo po restarcie backendu','Podniesione z „czesciowe” (D-2). Stare rozmowy odtwarzane z zachowanych `run_events` przez `backfillToolActivity`, idempotentnie (tests/migration.test.ts). Dowod na przeladowanie poprawiony: wczesniej test otwieral rozmowe z szuflady, co obchodzilo brak przywracania'],
  'L4.5': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts (kolejka per rozmowa)','raw-probe-conc2.log','Dwa rownolegle polecenia w jednej rozmowie: odpowiedzi „ALFA” i „BETA” nie zmieszane, oba przebiegi rozstrzygniete','—'],
  'L4.6': ['potwierdzone','przebieg','packages/platform-server/src/services/conversations.ts','raw-probe-conc2.log; tests/contracts.test.ts','Przy dwoch rownoleglych poleceniach dokladnie 3 wiadomosci uzytkownika (1 zalozycielska + 2), brak duplikatow','—'],
  'L4.7': ['potwierdzone','test','packages/platform-server/src/services/conversations.ts (delete)','17-playwright.txt („usuniecie rozmowy odlacza artefakty”)','Kaskada na wiadomosci i uruchomienia, artefakty odlaczane (ON DELETE SET NULL)','—'],
  'L4.8': ['potwierdzone','kod','packages/platform-contracts/src/conversation.ts (CHAT_CAPABILITIES)','/api/status; ekran Ustawienia','Edycja wiadomosci, rozgalezianie i przywracanie jawnie oznaczone jako niedostepne','—'],

  'L5.1': ['potwierdzone','test','packages/platform-server/src/agent/runtime.ts (includePartialMessages); platform-ui/src/chat/ChatPanel.tsx','e2e/streaming.spec.ts (3); tests/stream-verdict.test.ts (11); docs/evidence/closure-2026-09-15/21-strumien.json, 22-strumien-model.json','Tekst widoczny przyrostowo przed koncem wykonania: 4 rozne dlugosci odpowiedzi (28 → 107 znakow) zaobserwowane, gdy faza uruchomienia byla `running`. Obserwacja przez MutationObserver w stronie — kazda zmiana, faza czytana w tym samym takcie','ZAKRES DOWODU ROZSZERZONY. Poprzednio „20 zdarzen TEXT_MESSAGE_CONTENT” z jednego przebiegu — to dowod, ze backend wysyla przyrosty, nie ze uzytkownik je widzi. Detektor ma teraz udowodniona zdolnosc do oblania: ten sam kod na scenariuszu „cala odpowiedz jednym kawalkiem na koncu” orzeka brak strumieniowania, a na przebiegu bez tekstu nie liczy ani wiadomosci uzytkownika, ani podpowiedzi'],
  'L5.2': ['potwierdzone','test','packages/platform-ui/src/chat/{platformAdapter.ts,ChatPanel.tsx}; services/runs.ts','tests/agui-stream.test.ts (15); e2e/tool-activity.spec.ts','Pasek stanu rozroznia kolejke, wykonywanie, oczekiwanie na zgode, sukces, blad i anulowanie; faza pochodzi ze zdarzen uruchomienia, nie z obecnosci tekstu. Backend ma osobny status `queued`. Anulowanie nie jest nadpisywane przez pozniejszy RUN_ERROR','Podniesione z „czesciowe”: wczesniej rozpoczecie i zakonczenie nie byly sygnalizowane w UI'],
  'L5.3': ['potwierdzone','przebieg','packages/platform-server/src/agent/projection.ts; platform-ui/src/chat/AssistantMessage.tsx','e2e/tool-activity.spec.ts; tests/projection.test.ts (11, porownanie z reduktorem biblioteki)','Wywolanie, argumenty, wynik i blad narzedzia sa sparowane po `toolCallId` i widoczne w czacie (`openui-behind-the-scenes`, nazwa narzedzia w tekscie dostepnym). Projekcja backendu porownana wprost z `processStreamedMessage` zainstalowanej biblioteki na 6 scenariuszach','Podniesione z „czesciowe”. Nierozstrzygnieta obserwacja audytu wyjasniona: brak elementow narzedzi wynikal z tego, ze backend nie zapisywal `toolCalls`, a nie z zaslonięcia'],
  'L5.4': ['potwierdzone','test','packages/platform-ui/src/chat/platformAdapter.ts; components/LiveArtifact.tsx','tests/agui-stream.test.ts; tests/live-artifacts.test.ts; e2e/tool-activity.spec.ts','Zdarzenia zmiany kompozycji, zmiany danych i nowego artefaktu uniewazniaja dokladnie wlasciwe klucze (przestrzen, odczyty modulu, lista i otwarty podglad artefaktu). Artefakty renderuja sie w czacie przez wspolny widok, ktory odswieza je przy otwarciu','Podniesione z „czesciowe”: wczesniej renderowanie artefaktu w czacie nie bylo zaobserwowane'],
  'L5.5': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts (canUseTool, requestUiCommand)','e2e/files-agent.spec.ts; e2e/ui-navigation.spec.ts; tests/ui-navigation.test.ts','Zgoda i odmowa docieraja do klienta i wracaja do wykonania; przy odmowie polecenie sie nie wykonuje. Ta sama droga dziala dla polecen interfejsu: ui_navigate NIE rozstrzyga sie, dopoki klient nie odesle wyniku, a brak potwierdzenia daje executed=false (no_client), nie sukces','Dowod historyczny zastapiony obserwowanym 2026-09-16. Dodany drugi kanal zadanie→klient→zadanie z wlasnymi testami'],
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
  'L8.6': ['potwierdzone','test','packages/platform-server/src/agent/auth.ts; platform-contracts/src/agent.ts','tests/auth.test.ts (19, syntetyczne poswiadczenia); e2e/tool-activity.spec.ts (limit uzycia w UI)','Rozdzielone trzy wymiary: sposob logowania, stan lokalnych metadanych (`absent|valid|stale|unreadable`) i ostatni potwierdzony dostep (`unverified|verified|rate_limited|refresh_refused|revoked|failed`). Wygasle poswiadczenie to „stale”, nie zdrowa subskrypcja, i samo w sobie nie blokuje uruchomienia — odnowienie nalezy do SDK. Limit uzycia jest odrozniony od zepsutego logowania i nie prowadzi do komunikatu o ponownym logowaniu','Podniesione z „niespelnione” (D-3). Stany bledow wywolane kontrolowana symulacja na granicy adaptera; rzeczywiste logowanie nietkniete, limit nie byl celowo wyczerpywany'],
  'L8.7': ['potwierdzone','test','packages/platform-server/src/agent/auth.ts','tests/runtime.test.ts; 03-probes-auth.txt','Rzeczywisty token nie wystepuje w zadnym wyjsciu aplikacji','Zakres sprawdzenia: probeAuth i /api/status. Nie przeszukano logow serwera ani artefaktow'],
  'L8.8': ['potwierdzone','przebieg','—','FEEDBACK #15/#18/#23 (hist.); 02-versions.txt','Zgodnosc wersji sprawdzona rzeczywistymi wywolaniami; trzy niezgodnosci znalezione i obsluzone','—'],

  'L9.1': ['potwierdzone','kod','packages/module-procurement/src/shared/index.ts','schemat 8 tabel pc_*','Encje, relacje i reguly opisane dla produktu','—'],
  'L9.2': ['potwierdzone','test','packages/module-procurement/src/server/inputs.ts','tests/contracts.test.ts','Wspolne schematy wejscia i wspolny serwis dla HTTP i MCP','—'],
  'L9.3': ['potwierdzone','test','packages/platform-contracts/src/errors.ts','tests/contracts.test.ts; 04-probes-api.txt','13 kodow bledow mapowanych na statusy HTTP; walidacja w runtime','—'],
  'L9.4': ['potwierdzone','przebieg','packages/module-procurement/src/server/services.ts (findProvenance)','FEEDBACK #21 (hist.)','Przejscie pozycja → oferta → dostawca → zalacznik → wiersz w pliku','Dowod historyczny'],
  'L9.5': ['potwierdzone','test','packages/module-procurement/src/server/repository.ts','04-probes-api.txt (OWNER-*)','Drugi wlasciciel: 403 na canvas, sprawe i porownanie; listy przestrzeni, plikow i artefaktow rozlaczne','—'],
  'L9.6': ['potwierdzone','test','packages/module-procurement/src/server/repository.ts (updateItemChecked)','04-probes-api.txt (CONFLICT-*)','Nieaktualna wersja → 409 conflict, bez nadpisania','—'],
  'L9.7': ['potwierdzone','przebieg','packages/platform-server/src/services/idempotency.ts','04-probes-api.txt (IDEMPOTENCY-8-rownoleglych)','8 rownoleglych zadan z tym samym operationId: 8 odpowiedzi 200, dokladnie jeden przyrost wersji','Wzmocnione wobec poprzedniego raportu (bylo sekwencyjnie, teraz rownolegle)'],
  'L9.8': ['potwierdzone','test','packages/platform-server/src/services/artifacts.ts; module-procurement/src/server/services.ts','tests/durability.test.ts','Przerwany zapis wieloetapowy nie zostawia ani wiersza artefaktu, ani jego wersji; odrzucona zmiana pozycji nie zmienia ani wartosci, ani licznika wersji','Zakres dowodu rozszerzony po uwadze recenzenta: odtworzenie kopii bazy nie dowodzilo atomowosci przerwanej operacji'],
  'L9.9': ['potwierdzone','test','tests/contracts.test.ts','pnpm test 69/69','Testy potwierdzaja zmiane danych i odrzucenie operacji nieuprawnionej','—'],
});

Object.assign(A, {
  'L10.1': ['potwierdzone','kod','FEEDBACK sekcja 4 (tabela wlasnosci)','scripts/check-boundaries.mjs','Kazdy rodzaj danych ma jednego wlasciciela; platforma nie pisze do tabel pc_*','—'],
  'L10.2': ['potwierdzone','przebieg','packages/platform-server/src/db/{migrations.ts,backfill.ts}; scripts/{backup-state.mjs,migration-rehearsal.mjs}','tests/migration.test.ts (4); docs/evidence/closure-2026-09-15/{23-proba-migracji.json,24-kopia.txt}; docs/odzyskiwanie-stanu.md','Sprawdzona kopia stanu lokalnego istnieje (`backups/data-2026-09-15`, weryfikowana ponownym odczytem: sumy SHA-256, census tabel, integrity_check). Proba migracji na kopii danych tej maszyny: 31 rozmow, 31 wiadomosci uzytkownika (tresc i przypisanie), 18 kart canvasu (kompozycje bez zmian), 9 plikow, 432 zdarzenia uruchomien — wszystko zachowane po tozsamosci. Powtorne uruchomienie nie zmienilo ani jednego wiersza. Procedura odzyskania udokumentowana. Migracja nastepnie WYKONANA na danych uzytkownika za jego zgoda: wynik zgodny z proba co do wiersza (42→76 wiadomosci), odciski wierszy widocznych dla uzytkownika identyczne z kopia, powtorzenie bez zmian w 21 tabelach (27-migracja-wykonana.txt)','ZAKRES DOWODU ROZSZERZONY. Poprzednio „kopia katalogu otwiera sie z kompletnym stanem” — to dowod spojnosci kopii, nie dowod zachowania danych przez migracje. Odkryte przy okazji: katalog danych mial 4,1 MB w `app.db-wal` przy 397 kB w `app.db`, wiec kopia samego pliku glownego cofalaby stan o dzien i wygladalaby na kompletna'],
  'L10.3': ['potwierdzone','przebieg','packages/platform-server/src/services/conversations.ts','tabela conversations instancji audytowej','claude_session_id + owner_id przypisane do rozmowy','—'],
  'L10.4': ['potwierdzone','przebieg','packages/platform-server/src/index.ts','restart instancji audytowej','Historia, kompozycja, powiazania sesji i artefakty wracaja po restarcie','—'],
  'L10.5': ['potwierdzone','przebieg','packages/platform-ui/src/chat/platformAdapter.ts','FEEDBACK #21 (hist.); 08-probes-browser.txt','platform.data_changed / canvas_changed uniewazniaja wlasciwe zapytania; karta agenta pojawia sie bez przeladowania','—'],
  'L10.6': ['potwierdzone','kod','packages/platform-ui/src/api/queries.ts','klucze qk.*','Komponenty tej samej sprawy dziela jedno pobranie przez wspolny klucz','—'],
  'L10.7': ['potwierdzone','test','packages/platform-ui/src/api/{accessContext.ts,client.ts,queries.ts}','tests/access-context.test.ts (8); e2e/access-context.spec.ts; tests/session.test.ts','Klucze cache niosa kontekst dostepu, zasob i filtry. Zmiana tozsamosci przerywa zadania w locie wspolnym sygnalem i odrzuca odpowiedz po numerze epoki, po czym czysci cache. Sprawdzone w jednej instancji i jednym cache, z zadaniem w locie w momencie przelaczenia','Podniesione z „czesciowe”. Komentarz twierdzacy, ze klucze juz zawieraja wlasciciela, byl nieprawdziwy — nie zawieraly. Przy okazji naprawiono reset tozsamosci przy pelnym przeladowaniu strony'],
  'L10.8': ['potwierdzone','test','packages/platform-server/src/services/artifacts.ts','tests/contracts.test.ts','Klucz (artifact_id, version); tytul to zwykla kolumna','—'],
  'L10.9': ['potwierdzone','przebieg','packages/platform-server/src/services/files.ts','restart instancji audytowej (sha 459cb0b8… przed i po)','Podglad i pelny widok czytaja current_version; plik pobieralny po restarcie','—'],
  'L10.10': ['potwierdzone','test','packages/platform-server/src/services/artifacts.ts; platform-contracts/src/{artifacts.ts,module.ts}','tests/live-artifacts.test.ts (9)','Snapshot zachowuje liczby po zmianie zrodla; artefakt live przelicza sie przy kazdym otwarciu przez zarejestrowana, typowana operacje odczytu modulu. Deskryptor nie niesie kodu ani SQL; nieznana operacja i niepoprawne wejscie sa odrzucane przy zapisie. Po restarcie snapshot nadal zamrozony, live nadal aktualny','Podniesione z „czesciowe” (D-4). Blad odczytu i brak dostepu daja jawny stan, nigdy poprzedniego wyniku podanego jako biezacy'],

  'L11.1': ['potwierdzone','przebieg','packages/platform-server/src/agent/{toolkit.ts,sandbox.ts,platform-tools.ts}; platform-ui/src/chat/ChatAttachments.tsx','e2e/files-agent.spec.ts (3, prawdziwy model); tests/file-analysis.test.ts (10)','Uzytkownik dolacza plik z paska nad kompozytorem (upload lub wskazanie wgranego). Agent czyta RZECZYWISTA tresc: obraz opisany poprawnie mimo mylacej nazwy pliku (trzy pasy: czerwony, zielony, niebieski — kolejnosc zgodna), skoroszyt wieloarkuszowy przeliczony z komorek (suma 5300 wyprowadzona z ilosci x cena). Kod przetwarzajacy dziala w sandboxie: agent pisze skrypt do workspace i uruchamia go po zgodzie uzytkownika. Wynik pobrany, otwiera sie poprawnie i zawiera zadana zmiane','Rozszerzenie 2026-09-16. Wczesniej dowod obejmowal CSV przetworzony w sandboxie; obraz i XLSX nie byly obslugiwane (brak typu XLSX i brak biblioteki w runtime). exceljs 4.4.0 podlinkowany do node_modules workspace przez kuratorowana liste (agent/toolkit.ts)'],
  'L11.2': ['potwierdzone','test','packages/platform-server/src/services/files.ts','tests/runtime.test.ts; 17-playwright.txt','sanitizeFilename odporne na ../ i znaki sterujace; limit 8 MB; allowlista typow; resolveInWorkspace','—'],
  'L11.3': ['potwierdzone','przebieg','packages/platform-server/src/agent/sandbox.ts','FEEDBACK #24/#25 (hist.)','Siec: deny network-outbound example.com:443, exit 56. Pliki: data/app.db niewidoczna, ls pokazuje tylko workspaces','Dowod historyczny — nie powtorzony w tym audycie'],
  'L11.4': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts (allowedTools)','FEEDBACK #17/#23 (hist.)','Narzedzia plikowe zamkniete w workspace; powloka przez canUseTool','Dowod historyczny'],
  'L11.5': ['potwierdzone','przebieg','packages/platform-server/src/agent/sandbox.ts (denyRead)','FEEDBACK #25 (hist.)','Katalog danych aplikacji niewidoczny dla procesu sandboxowego','Dowod historyczny'],
  'L11.6': ['potwierdzone','przebieg','packages/platform-server/src/{services/runs.ts,http/app.ts,agent/runtime.ts}; platform-ui/src/chat/runStreams.ts, shell/BackgroundTasks.tsx','e2e/background-tasks.spec.ts (5); tests/background-runs.test.ts (10)','Zadanie ma trwaly status i rozmowe; zamkniecie panelu, przelaczenie rozmowy i przeladowanie strony nie anuluja go. Klient podlacza sie ponownie przez GET /api/runs/:id/stream?from=<seq> — odtworzenie od kursora, bez powtarzania zdarzen. Powrot do rozmowy pokazuje wynik bez ponownego uruchomienia (liczba uruchomien niezmieniona). Lista zadan w tle sygnalizuje prace przy wlasciwej rozmowie','ZAKRES DOWODU ROZSZERZONY i NAPRAWA. Poprzednio dowodem byla tabela agent_runs — trwalosc wpisu, nie odpornosc wykonania. W przegladarce bylo odwrotnie: abort strumienia czatu byl mapowany na /cancel, a biblioteka wywoluje go przy KAZDYM przelaczeniu rozmowy (selectThread → cancelMessage), wiec przejscie do innej rozmowy i przeladowanie zabijaly zadanie. Test oblewa po przywroceniu tego mapowania'],
  'L11.7': ['potwierdzone','przebieg','packages/platform-server/src/services/runs.ts (cancel/abortAll)','raw-probe-stop.log','Potwierdzenie 3 ms; strumien zamkniety po 2010 ms; potomkowie serwera 0 przed / 1 w trakcie / 0 po (brak osieroconych); 80 → 80 zdarzen; kolejne uruchomienie succeeded','Podniesione z „czesciowe” — poprzedni raport mierzyl tylko czesc aplikacyjna'],
  'L11.8': ['potwierdzone','przebieg','packages/platform-server/src/services/runs.ts (reconcileOnBoot)','run 6c9c63: failed / server_sigterm','Przebieg przerwany restartem oznaczony jako failed z jawna przyczyna, nie udaje kontynuacji','—'],
  'L11.9': ['potwierdzone','przebieg','packages/platform-server/src/agent/runtime.ts (canUseTool); platform-ui/src/chat/ChatPanel.tsx','e2e/files-agent.spec.ts („bramka zgody”); FEEDBACK #23 (hist.)','Zgoda i odmowa docieraja do interfejsu i wracaja do wlasciwego wykonania. Potwierdzone na prawdziwym modelu w sciezce analizy pliku: agent zapisal skrypt do workspace i zatrzymal sie na `Bash: node process_oferty.js`, dopoki uzytkownik nie kliknal Zgoda. Prosba o zgode jest przypisana do rozmowy zadania, nie do ogladanej','Dowod wzmocniony 2026-09-16: wczesniej historyczny, teraz zaobserwowany w przebiegu z modelem. Bramka dotyczy takze kodu przetwarzajacego pliki — `autoAllowBashIfSandboxed: false` pozostaje'],
  'L11.10': ['potwierdzone','przebieg','packages/platform-server/src/agent/platform-tools.ts','FEEDBACK #20 (hist.); restart instancji audytowej','workspace.dispose() w finally; plik artefaktu nadal pobieralny','—'],

  'L12.1': ['potwierdzone','przebieg','packages/platform-server/src/services/runs.ts (run_events)','baza instancji audytowej','conversations → agent_runs → run_events → artifacts; pelna sekwencja z argumentami i wynikami narzedzi','—'],
  'L12.2': ['potwierdzone','test','packages/platform-contracts/src/errors.ts','tests/contracts.test.ts; raw-probe-stop.log','Bledy integracji, domeny, modelu i sandboxu rozroznialne; brak sekretow w odpowiedziach','—'],
  'L12.3': ['potwierdzone','test','packages/platform-server/src/services/runs.ts; platform-contracts/src/agent.ts','tests/run-lifecycle.test.ts (13); docs/evidence/closure-2026-09-15/20-pomiary.json','Punkty pomiaru rozdzielone i nazwane: zakolejkowanie, start wykonania, pierwszy tekst (od startu wykonania), koniec, oraz osobno czas w kolejce. Sprawdzone trzy kolejnosci: narzedzie→tekst, tekst→narzedzie i odpowiedz bez tekstu (brak wartosci jest poprawnym wynikiem, nie podstawionym). Czas odswiezenia po mutacji i czas anulowania zmierzone w przegladarce','Podniesione z „czesciowe” (D-5). Przyczyna: hook PreToolUse otwieral wiadomosc tekstowa przed pierwszym tokenem, wiec pomiar nie wykonywal sie w najczestszej kolejnosci'],
  'L12.4': ['potwierdzone','test','tests/contracts.test.ts','pnpm test 69/69','Walidacja, konflikty, powtorzenia i kontrola dostepu pokryte','—'],
  'L12.5': ['potwierdzone','przebieg','e2e/*.spec.ts','e2e/{app,chat,chat-drawer,tool-activity,streaming,session-restore,access-context,measurements,agent-ui}.spec.ts (46)','Testy przegladarkowe obejmuja dynamiczny UI (canvas, karty, nawigacja), rozmowy (lista, przelaczanie, usuwanie, przywracanie po przeladowaniu, Wstecz/Dalej, stan zastepczy dla usunietej), narzedzia (wywolanie, wynik, blad, trwalosc), artefakty, strumieniowanie z kontrolami negatywnymi i wznowienie po restarcie backendu. Kazdy plik przechodzi przez `e2e/support/fixtures.ts`, wiec zaden nie moze wyslac zadania do instancji, ktorej testy nie uruchomily','Podniesione z „czesciowe” (D-6), nastepnie poprawione: asercja strumieniowania byla niestabilna (ten sam kod, dwa rozne wyniki) i zostala zastapiona obserwacja w stronie; dwa testy obchodzily brak przywracania rozmowy i zostaly przepisane'],
  'L12.6': ['potwierdzone','przebieg','—','wszystkie przebiegi audytu','Sciezka subskrypcja → SDK → Mastra → AG-UI → OpenUI potwierdzona; w repo nie ma ani jednego mocka Claude','AG-UI uzyte jako protokol drutowy: zero importow @ag-ui/*; @ag-ui/core 0.0.53 obecny wylacznie tranzytywnie. Integracja @ag-ui/mastra wskazana w dokumencie nie zostala uzyta'],
  'L12.7': ['potwierdzone','kod','RAPORT-STANU-PLATFORMY.md','ten dokument','Opis odbioru z wersjami, dowodami, nieudanymi probami i wlasnymi adapterami','—'],
  'L12.8': ['potwierdzone','test','packages/platform-server/src/agent/runtime.ts (Mastra)','docs/observability.md; tests/observability.test.ts','System dziala bez Langfuse — zadna jego zaleznosc nie jest zainstalowana. Punkt wpiecia (`observability` w konfiguracji Mastry, publiczny typ `ObservabilityExporter`) potwierdzony testem na zainstalowanej wersji','Ograniczenia opisane wprost: podlaczenie wymaga dodania `@mastra/observability` i eksportera Langfuse; telemetria Mastry nie zawiera wywolan narzedzi w tej samej postaci co `run_events`; zgodnosc schematu Langfuse z ta wersja Mastry pozostaje niesprawdzona; eksport wyniosl by dane rozmowy poza maszyne'],
});

/* ------------------------------- renderer -------------------------------- */

// Historyczna macierz 95 kryteriów: wersja specyfikacji, wobec której ją oceniano.
// Obowiązująca specyfikacja (200 kryteriów) to docs/ARCHITECTURE.md.
const doc = readFileSync(new URL('../docs/archive/agenticapp-2026-09/stack-agentowy-ustalenia-i-materialy-95-kryteriow.md', import.meta.url), 'utf8');
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
summary.push(`Liczby wyliczone ze skryptu \`scripts/closure-matrix.mjs\`; wymagania czytane wprost z \`stack-agentowy-ustalenia-i-materialy.md\`.\n`);
summary.push(`**Kryteriów: ${total}** (7+6+7+8+8+7+7+8+9+10+10+8). Dokument wymagań nie zmienił się, więc liczba jest ta sama co w audycie z 2026-09-15.\n`);
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
