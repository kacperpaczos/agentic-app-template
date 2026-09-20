# Backlog rozwoju szablonu

> Plik generowany przez `node scripts/acceptance-matrix.mjs` z `docs/acceptance/assessment.json`.
> Każde otwarte kryterium macierzy (`docs/ACCEPTANCE.md`) należy do dokładnie jednego pakietu.

Otwartych kryteriów: **13** z 200, w 6 pakietach. Kolejność pakietów jest propozycją, nie harmonogramem.

| Pakiet | Tytuł | Kryteria | Liczba |
|---|---|---|---|
| BL-03 | Powtarzalne próby na prawdziwym modelu w szablonie | L1.6, L5.8, L11.4, L11.5, L11.11 | 5 |
| BL-04 | Uwierzytelnienie subskrypcyjne i limity — próby graniczne | L8.10, L8.11 | 2 |
| BL-07 | Trwałość, kopia i migracje | L7.13 | 1 |
| BL-09 | Pliki, sandbox i zadania w tle | L11.7, L11.12, L11.23 | 3 |
| BL-11 | Domena, backend i cache | L6.11 | 1 |
| BL-12 | Odbiór i jakość dowodów | L12.10 | 1 |

## BL-03 — Powtarzalne próby na prawdziwym modelu w szablonie

Funkcje potwierdzone w AgenticApp wyłącznie historycznym przebiegiem lub ręczną sondą, bez dowodu wykonywanego na kodzie szablonu. Trzeba je powtórzyć w szablonie i utrwalić jako powtarzalny, izolowany test lub skrypt odbiorowy z zapisem wersji i wyniku.

**Warunek zamknięcia:** każde kryterium pakietu ma dowód z przebiegu na commicie szablonu (test e2e z modelem lub skrypt odbiorowy z logiem), oznaczony jako rzeczywisty model, z kontrolą negatywną tam, gdzie wymaga jej treść kryterium.

| ID | Wymaganie | Stan | Brak |
|---|---|---|---|
| L1.6 | Restart zachowuje trwałe dane; zatrzymanie aplikacji nie pozostawia niezarządzanych procesów roboczych. | częściowe | Polowa o procesach NIE jest jeszcze dowiedziona. Kontrola uzyta w turze 20 szukala procesow jako POTOMKOW pid serwera juz po jego wyjsciu — osierocony proces jest wtedy przepiety do init i z definicji przestaje byc potomkiem, wiec lista wracala pusta niezaleznie od tego, czy wyciek nastapil; dowod zapisal same nazwy, wiec nie da sie tego zinterpretowac po fakcie. Kontrola zostala wymieniona na odpytywanie po tozsamosci (pid plus czas startu) zapamietanej PRZED sygnalem, z proba zdolnosci wykrycia na zastepniku: scenariusz z potomkiem ignorujacym SIGTERM jest przez nowa kontrole ZNAJDOWANY, a stara zwraca pusto (e2e/bl03-rehearsal.spec.ts „kontrola wycieku procesow POTRAFI oblac"). Brakuje jednego przebiegu z prawdziwym modelem na poprawionej kontroli. |
| L5.8 | Pokrycie zdarzeń zostało sprawdzone z rzeczywistym adapterem Claude, a brakujące mapowania są jawnie opisane. | częściowe | Trzecia sciezka z opisu braku — blad strumienia modelu (chunk error prowadzacy do RUN_ERROR z klasyfikacja) — pozostaje SYMULACJA (tests/run-lifecycle.test.ts). Nie da sie jej wywolac na zadanie bez prawdziwej awarii adaptera albo wyczerpania limitu subskrypcji, a limitu nie wolno udawac. Swiadoma decyzja koordynatora: zamykamy te polowe, ktora zaobserwowano, i nazywamy druga wprost. |
| L11.4 | Sandbox poleceń i uprawnienia narzędzi plikowych obejmują wszystkie udostępnione sposoby dostępu, a nie tylko powłokę. | niespełnione | Narzedzia plikowe (Read, Write, Edit, Glob, Grep) sa auto-zatwierdzone i ograniczone wylacznie lista trzech chronionych katalogow straznika (katalog danych, katalog konfiguracji Claude, ~/.claude.json). Wszystko poza ta lista jest dla agenta czytelne i zapisywalne wszedzie tam, gdzie siega proces serwera — czyli sandbox polecen NIE obejmuje wszystkich udostepnionych sposobow dostepu. Poszerzanie listy nie zamyka klasy, bo klasa jest komplementarna; zamyka ja regula pozytywna (blockReadsOutsideWorkingDirectories plus allowWrite ograniczony do workspace), czyli ten sam ksztalt, ktory ma juz sandbox powloki. Naprawa nalezy do pakietu bedacego wlascicielem straznika. Test odbiorczy naprawy jest gotowy i dzis OBLEWA: e2e/bl03-model-isolation.spec.ts „narzedzia plikowe". Jawny ksztalt niekontrolowany (runda 7): wyscig TOCTOU na pre-walku Z4 — przeciwnik musi podmienic dowiazanie miedzy sprawdzeniem a otwarciem, co wymaga Bash, czyli ZGODY uzytkownika; zgoda jest pytaniem, nie ochrona (ta sama pozycja co A10b i D1). |
| L11.5 | Narzędzia nie mają niejawnego dostępu do bazy domenowej pozwalającego ominąć MCP i serwisy backendu. | częściowe | Ramie narzedzi plikowych jest pokryte wylacznie SYMULACJA. Proba na prawdziwym modelu (tura 17) nie rozstrzygnela: model napisal „1: ODCZYTANE (narzedzie dotarlo do pliku; odmowa dotyczyla tylko formatu binarnego, nie dostepu)" o pliku bazy, ale w strumieniu zdarzen tego wykonania nie ma ZADNEGO wywolania Read na bazie — ani udanego, ani odrzuconego. Albo model zmyslil te linie, albo wywolanie nie trafilo do strumienia zdarzen; druga mozliwosc byla by wada obserwowalnosci i znaczylaby, ze odmowy tez nikt by nie zobaczyl. Danych do rozstrzygniecia juz nie ma (katalog .e2e-data jest czyszczony przy kazdym starcie suity). Rozstrzygniecie wymaga jednej tury po przebudowie straznika. |
| L11.11 | Próby izolacji obejmują zarówno narzędzia powłoki, jak i plikowe; obejście jednej ścieżki przez drugą nie zapewnia dostępu do bazy lub sekretów. | niespełnione | Sekrety spoza katalogu danych sa dostepne sciezka narzedzi plikowych, ktora dla powloki jest zamknieta — to jest dokladnie asymetria, o ktora pyta kryterium, i jest wykazana kontrprzykladem. Ramie katalogu POSWIADCZEN nie zostalo sprawdzone na prawdziwym modelu: celowanie w prawdziwy plik jest zabronione (G21 — zmierzono, ze CLI przepisuje plik poswiadczenia, 193 na 121 bajtow, accessToken znika, wiec proba na prawdziwym katalogu wylogowalaby uzytkownika), a odseparowany CLAUDE_CONFIG_DIR z wymyslonym poswiadczeniem nie uwierzytelnia sesji, wiec przebieg nie doszedlby do wywolania narzedzia. To ramie pokrywa symulacja tests/credential-guard.test.ts. Naprawa i ponowna proba zaplanowane po przebudowie straznika. Jawny ksztalt niekontrolowany (runda 7): wyscig TOCTOU na pre-walku Z4 — przeciwnik musi podmienic dowiazanie miedzy sprawdzeniem a otwarciem, co wymaga Bash, czyli ZGODY uzytkownika; zgoda jest pytaniem, nie ochrona (ta sama pozycja co A10b i D1). |

## BL-04 — Uwierzytelnienie subskrypcyjne i limity — próby graniczne

Zachowanie przy wygaśnięciu i odświeżeniu tokena, odrzuconym odświeżeniu, odwołanym logowaniu i limicie użycia, sprawdzone na granicy adaptera aż do widocznego UI, bez niszczenia poświadczeń użytkownika i bez przedstawiania symulacji jako rzeczywistego limitu.

**Warunek zamknięcia:** kontrolowane stand-iny na granicy adaptera SDK dają rozróżnialne stany w UI i zachowują historię bez powtórki mutacji; dowód oznaczony jako symulacja; opis odczytu poświadczeń zgodny z kodem.

| ID | Wymaganie | Stan | Brak |
|---|---|---|---|
| L8.10 | Przeterminowany access token nie blokuje automatycznie możliwości odświeżenia przez SDK; skuteczne i odrzucone odświeżenie mają sprawdzone zachowanie. | częściowe | SWIADOMIE POZA ZAKRESEM, nie brak dowodu. Skuteczne odswiezenie nie zostalo zaobserwowane i nie da sie go zaobserwowac BEZPIECZNIE w tej konfiguracji. Powod jest ustaleniem z tego pakietu: w bundlu CLI 2.1.277 zapis odswiezonego poswiadczenia jest compare-and-swap po refreshTokenie (odswiezenie WYMIENIA zestaw tokenow), a przy odmowie CLI KASUJE poswiadczenie na dysku — co obie proby graniczne potwierdzily obserwacyjnie. Proba "skutecznego odswiezenia na kopii" zostawilaby wiec w pliku uzytkownika refresh token poprzedniej generacji, a przy jego najblizszym uzyciu CLI wyczyscilo by mu logowanie — szkoda ujawniajaca sie kilka godzin pozniej, dlugo po tym, jak ktokolwiek powiazalby ja z ta praca. Proba byla autoryzowana i NIE zostala wykonana. Domkniecie wymaga konta testowego odrebnego od konta uzytkownika. Tansza droga posrednia: biernie porownac skrot refresh tokena przed i po rutynowym odswiezeniu sesji uzytkownika (zero tur, zero ryzyka) — jesli rotacji nie ma, proba na kopii staje sie bezpieczna; opis w docs/evidence/z12-bl04/przebiegi-i-proby.md. |
| L8.11 | Limit użycia jest odróżniany od odwołanego logowania, błędu sieci i błędu narzędzia; zachowuje historię i nie powoduje automatycznej powtórki mutacji. | częściowe | Dwa z czterech przypadkow opieraja sie na niepotwierdzonych podciagach: (1) komunikatu przy WYCZERPANYM limicie nikt nie widzial — takiego przebiegu nie da sie wywolac na zadanie, a symulowany limit nie jest limitem wyczerpanym (sonda sesji czyta rzeczywiste wykorzystanie okien planu, czyli ODCZYT, nie wyczerpanie); (2) "socket hang up" dla bledu sieci pozostaje zalozony. Ta polowa trzyma kryterium otwarte niezaleznie od wszystkiego innego. OSOBNO, i wezej niz w pierwszej wersji tego opisu: proby fazy 2 pokazaly, ze PRZY POSWIADCZENIU Z NIEPRAWIDLOWYM REFRESH TOKENEM SDK 0.3.270 podaje ten sam tekst niezaleznie od tego, czy access token wygasl. To NIE jest dowod, ze SDK myli odwolane logowanie z odmowa odnowienia: oba tryby proby zapisuja tak samo nieprawidlowy refresh token i roznia sie WYLACZNIE wartoscia expiresAt, wiec oba koncza tym samym zdarzeniem — odnowieniem, ktore nie moglo sie udac, a identyczny tekst jest spodziewanym skutkiem takiego ustawienia. Prawdziwe odwolanie (poprawny refresh token odrzucony po stronie serwera) nie zostalo wytworzone, bo wymagaloby konta testowego; czy da sie je odroznic — POZOSTAJE NIEZNANE. |

## BL-07 — Trwałość, kopia i migracje

Pozostaje jedno pytanie, na które nie da się odpowiedzieć bez tury modelu: którą z dwóch reakcji daje prawdziwy SDK, gdy transkrypt wznawianej sesji nie istnieje. Obie ścieżki są obsłużone i sprawdzone stand-inem na granicy adaptera; kopia z WAL, próba migracji sprzed każdej migracji platformy i odtworzenie są przećwiczone w szablonie na danych syntetycznych (Z2, 2026-09-18).

**Warunek zamknięcia:** jedna próba na prawdziwym modelu: rozmowa z sesją, usunięcie jej transkryptu, kolejne polecenie — zapisany komunikat SDK rozstrzyga, która ścieżka zachodzi, i potwierdza albo uzupełnia wzorce rozpoznawania w isMissingSessionTranscript.

| ID | Wymaganie | Stan | Brak |
|---|---|---|---|
| L7.13 | Brak transkryptu SDK dla zachowanej rozmowy daje jawny wynik odzyskiwania lub błąd; aplikacja nie deklaruje zachowania pamięci, której nie odtworzyła. | częściowe | Nie sprawdzono na prawdziwym SDK, którą z dwóch reakcji daje faktycznie brak transkryptu (odmowa wznowienia czy cicha nowa sesja) — zadanie nie miało budżetu tur, a przypadku nie da się wywołać bez usunięcia transkryptu prawdziwej sesji; rozpoznanie opiera się na wzorcach komunikatów, więc nieznane brzmienie z nowszej wersji SDK wpadnie w integration_failed zamiast we własny kod. Dla ścieżki „cicha nowa sesja” jawny wynik to zdarzenie, wpis w run_events i ostrzeżenie serwera — uruchomienie celowo nie jest przerywane (przerwanie przy hipotetycznym rozwidlaniu sesji przez SDK zepsułoby każdą kontynuację), więc użytkownik nie widzi wtedy komunikatu w wątku. |

## BL-09 — Pliki, sandbox i zadania w tle

To, co w warstwie 11 zostało po zamknięciu zgód, publikacji i pracy w tle (2026-09-18): trzy kryteria, których nie da się potwierdzić bez tury modelu — zakończenie procesu potomnego samego Claude Agent SDK przy Stop, faktyczna kolejność mechanizmów uprawnień SDK i to, czy odpowiedź agenta nie podaje zapisanej wartości formuły jako wyniku przeliczenia.

**Warunek zamknięcia:** każde z pozostałych kryteriów ma dowód z przebiegu na prawdziwym modelu, w ramach przyznanego budżetu tur, oznaczony jako rzeczywisty model; części niezależne od modelu są już pokryte regresją szablonu z kontrolami negatywnymi.

| ID | Wymaganie | Stan | Brak |
|---|---|---|---|
| L11.7 | Stop dociera do wykonania i jego procesów potomnych; pomiar czasu anulowania znajduje się w odbiorze. | częściowe | Proces liczony w próbie jest prawdziwym procesem systemowym, ale stand-inem procesu Claude Agent SDK na granicy adaptera — bez grantu tur modelu nie wykazano, że Stop kończy proces potomny samego SDK ani poleceń powłoki uruchomionych w sandboxie. Pozostała część kryterium (pomiar anulowania liczony w procesach, nie tylko w statusie) jest w regresji szablonu. |
| L11.12 | Polityka automatycznych zgód i pytań odpowiada faktycznej kolejności mechanizmów SDK; lista allowedTools nie jest traktowana jako gwarancja wywołania bramki zgody. | częściowe | Kolejność mechanizmów SDK (allowedTools zatwierdza przed canUseTool; klasyfikator SDK auto-zatwierdza część poleceń powłoki) to zachowanie cudzego kodu i można je zaobserwować tylko na turze modelu — w szablonie nie ma takiej próby. Macierz jest więc zbudowana jako obrona w dwóch miejscach (reguła SDK + odmowa w bramce), a nie jako dowód kolejności. |
| L11.23 | Formuły i zakres zachowania skoroszytu mają jawną semantykę; wynik nie udaje przeliczonego, jeżeli wykonano tylko zapis formuły lub odczyt starej wartości. | częściowe | Nie sprawdzono na modelu, że odpowiedź agenta nie podaje zapisanej wartości formuły jako wyniku przeliczenia — to zachowanie modelu i wymaga tury. W szablonie wykazano tylko, że plik nie daje takiej możliwości (formuła bez wartości) i że ograniczenia są zadeklarowane zgodnie z faktycznym zachowaniem parsera. |

## BL-11 — Domena, backend i cache

Braki w warstwach 6, 7, 9 i 10 niepasujące do innych pakietów: współbieżność, atomowość, konflikty, kontekst podczas długiego wykonania, cache.

**Warunek zamknięcia:** kryteria pakietu mają test kontraktu lub test GUI w regresji szablonu, z próbami negatywnymi.

| ID | Wymaganie | Stan | Brak |
|---|---|---|---|
| L6.11 | Brak lub nieaktualność zasobu i utrata dostępu są odróżniane od pustego wyniku; agent nie uzupełnia braków wymyślonymi danymi. | częściowe | Zachowanie agenta — ze nie uzupelnia brakow wymyslonymi danymi — nadal nie ma proby z prawdziwym modelem w szablonie. Platforma podaje juz rozroznialne stany i wprost zakazuje zmyslania, ale czy model sie do tego stosuje, moze wykazac tylko przebieg modelowy (Z5 mial grant zero tur). |

## BL-12 — Odbiór i jakość dowodów

Macierz, wersje w dowodach, kontrola negatywna testów, raportowanie nieudanych przebiegów i rozdzielenie ocen — tam, gdzie obecny proces odbioru nie spełnia treści kryterium w pełni.

**Warunek zamknięcia:** kryteria pakietu są potwierdzone procesem odbioru wykonywanym w szablonie (pnpm verify, zapis dowodów z wersjami, raport z nieudanymi przebiegami).

| ID | Wymaganie | Stan | Brak |
|---|---|---|---|
| L12.10 | Każdy dowód wskazuje wersję kodu, środowisko i rodzaj wykonania; dawny wynik nie potwierdza automatycznie zmienionej integracji. | częściowe | 44 dowody zapisane przed koperta (docs/evidence/POCHODZENIE.json) maja commit, wytworce i rodzaj wykonania w rejestrze, ale nie maja zapisu SRODOWISKA przebiegu i nie da sie go odtworzyc — pole czegoBrakujeWPliku mowi to wprost przy kazdym z nich. Dopisanie im srodowiska byloby zmysleniem, a regeneracja nalezy do pakietow, ktore te dowody wytworzyly. |
