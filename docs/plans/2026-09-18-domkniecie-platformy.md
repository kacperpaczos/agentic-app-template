# Plan domknięcia specyfikacji platformy (BL-03 … BL-12)

> Dokument roboczy architekta. Start: 2026-09-18, baza `main` = e4fe9d7 (po zamknięciu BL-01 i BL-02).
> Gałąź integracyjna: `domkniecie/integracja`. Wiążąca jest `docs/ARCHITECTURE.md`; ten plan jest jej
> argumentem. Stan wyjściowy: **123 otwarte kryteria** (107 częściowych, 9 niespełnionych,
> 7 niesprawdzonych) w 10 pakietach, **23 próby** bez kompletu dowodów (zaliczone: T05, T25, T26, T27).

## 0. Co ten program ma osiągnąć

200/200 potwierdzonych, 12/12 warstw zamkniętych, T01–T27 z dowodami, BL-01 i BL-02 nadal działające.
Kryterium, którego nie da się uczciwie potwierdzić, **zostaje otwarte** — nie ma zamykania deklaracją,
atrapą, pustą asercją ani testem API zamiast testu UI. Ogłoszenie sukcesu jest wstrzymane, dopóki
wszystkie warunki odbioru nie są spełnione i niezależnie zweryfikowane.

## 1. Global Constraints (wiążą każde zadanie i każdy review)

Obowiązują **wszystkie** zasady z `<checkout szablonu>/docs/plans/2026-09-17-bl01-bl02.md` §1 (G1–G10)
— bezpieczeństwo instancji użytkownika, praca wyłącznie we własnym worktree, granica platforma–domena,
blokada na testy przeglądarkowe, jakość dowodów, zakaz wyłączania kontroli. Poniżej zmiany i dodatki:

**G11. Backend jest jedynym źródłem prawdy.** Dane, mutacje, uprawnienia i walidacja przechodzą przez
kontrakty domenowe i MCP. Żadne kryterium nie zostaje zamknięte dowodem, który omija serwis domenowy.

**G12. OpenUI renderuje wyłącznie katalog.** Agent nie wykonuje dowolnego kodu renderującego; każda
kompozycja przechodzi walidację serwera.

**G13. Rzeczywisty przepływ użytkownika.** Zadania długotrwałe, pliki, sandbox, praca w tle,
przełączanie rozmów, nawigacja, wskazywanie pól, filtry, sortowanie, paginacja i „Widoki agenta” mają
dowód z przepływu użytkownika (GUI), nie z samego API. API może przygotować dane i dodatkowo sprawdzić
rezultat.

**G14. Próby modelowe.** Tylko w odseparowanym środowisku testowym, wyłącznie `pnpm test:e2e:model`,
w ramach **przyznanego budżetu tur** (per zadanie, niżej). Nie nadpisujesz istniejących dowodów ani
rejestru tur. Kontrolowane błędy i kolejności wolno dowodzić stand-inem na granicy adaptera SDK —
oznaczonym w dowodzie jako **symulacja**, nigdy jako rzeczywisty model.

**G15. Langfuse pozostaje opcjonalny.** Platforma działa bez niego; włączony eksport wymaga dowodu
odbioru śladu.

**G16. Odporność testu.** Każde kryterium, które zamykasz testem, ma **kontrolę negatywną** albo próbę
zdolności wykrycia (wycofanie linii → test oblewa → przywrócenie). Procedura prób: commit najpierw,
próba na czystym drzewie, kontrola czystości po przywróceniu.

**G17. Warunek zgłoszenia zakończenia.** Zadanie wolno zgłosić jako gotowe dopiero, gdy: każde jego
kryterium ma dowód wykonywany w regresji szablonu (test w `tests/` lub `e2e/`, albo skrypt odbiorowy z
logiem), `pnpm verify` = 0, wskazane spece przeglądarkowe przechodzą pod blokadą, dowody leżą w
`docs/evidence/<zadanie>/`, a w raporcie jest tabela: kryterium → plik testu → rodzaj dowodu → kontrola
negatywna. Kryterium bez takiej linii zgłaszasz jako **otwarte**, z opisem braku.

## 2. Fale i zależności

```
Fala 1 (równolegle):  Z1 BL-06 | Z2 BL-07 | Z3 BL-05 | Z4 BL-10
Fala 2 (równolegle):  Z5 BL-11a kontekst | Z6 BL-11b orkiestracja+domena | Z7 BL-11c cache/artefakty
Fala 3 (równolegle):  Z8 BL-08a czat | Z9 BL-08b zdarzenia | Z10 BL-09 pliki/sandbox/tło
Fala 4 (sekwencyjnie): Z11 BL-03 (prawdziwy model) → Z12 BL-04 (uwierzytelnienie i limity)
Fala 5:               Z13 BL-12 (odbiór, dowody, indeks prób T01–T27)
```

Uzasadnienie kolejności: fale 1–3 dokładają funkcje i dowody deterministyczne; BL-03 i BL-04 dowodzą
na prawdziwym modelu tego, co wcześniej stało się stabilne (inaczej tury idą na cudze braki); BL-12
ocenia jakość całości i zbiera indeks dowodów.

## 3. Budżet tur modelu (granty architekta)

| Zadanie | Grant | Na co |
|---|---|---|
| Z11 (BL-03) | ≤ 25 tur | powtarzalne próby na prawdziwym modelu dla 19 kryteriów |
| Z12 (BL-04) | ≤ 8 tur | dowód subskrypcji i granic; reszta stand-inem (symulacja) |
| Z13 (BL-12) | ≤ 8 tur | uzupełnienie prób T01–T24 tam, gdzie kryterium wymaga modelu |
| rezerwa architekta | ≤ 9 tur | powtórki po poprawkach |

Razem ≤ 50 tur ponad dotychczasowe 21. Każde zadanie dostaje swój grant w zleceniu; przekroczenie
wymaga nowego grantu. Sufit `MODEL_TURN_BUDGET` podnosi koordynator, nigdy implementator.

## 4. Zadania

Każde zadanie czyta: `docs/BACKLOG.md` (sekcja swojego pakietu: opis, warunek zamknięcia, tabela
kryteriów z opisem braku), `docs/ACCEPTANCE.md` (wiersze swoich kryteriów), treść kryteriów w
`docs/ARCHITECTURE.md` i wiersze prób `Txx`, których dotyczy.

### Task 1: BL-06 — wymienialność modułu domenowego
Kryteria: **L9.11, L9.12**. Warunek zamknięcia z backlogu: testy platformy działają na module
kontrolnym albo fixture platformy; moduł kontrolny ma połówkę UI z rendererem karty sprawdzanym w
przeglądarce przez `pnpm check:module-swap`; moduł z ekranami przechodzi typecheck niezależnie od tego,
czy aplikacja go składa. Dowód: `pnpm check:module-swap` z krokiem przeglądarkowym + test kontraktu
rejestracji (schematy, narzędzia, odczyty, komponenty, nawigacja, migracje) i brak odwołań do tabel
nieobecnego modułu.

### Task 2: BL-07 — trwałość, kopia i migracje
Kryteria: **L7.13, L10.2, L10.16, L10.17, L10.18, L10.19**. Kopia obejmuje zatwierdzony stan SQLite z
WAL i pliki, jest weryfikowana i odczytywana ponownie; próba migracji na kopii porównuje tożsamość i
treść, dopuszczone zmiany i drugie uruchomienie bez skutku; procedura odtworzenia opisuje los sesji i
transkryptów; brak transkryptu SDK daje jawny wynik odzyskiwania. Dowody na danych **syntetycznych**;
próby nie mogą tknąć bazy użytkownika.

### Task 3: BL-05 — pomiary i obserwowalność
Kryteria: **L11.14, L12.1, L12.2, L12.3, L12.13**. Rozdzielone: czas kolejki, start wykonania, pierwszy
tekst, zakończenie, widoczny refetch, faktyczne anulowanie (Stop mierzony do zakończenia procesów
potomnych); brak tekstu = brak metryki, nie zero; powiązanie rozmowa → wykonanie → narzędzie → mutacja →
artefakt w danych diagnostycznych; rozróżnialne klasy błędów; brak sekretów w diagnostyce.

### Task 4: BL-10 — frontend, dostępność i stany UI
Kryteria: **L2.1, L2.3, L2.5, L2.8, L2.9, L2.11, L2.12, L2.14, L2.15, L3.5, L3.7, L3.11**. Testy GUI:
klawiatura, etykiety, widoczny fokus, szuflada rozmów na wąskim i szerokim panelu, pan/zoom/przesunięcie
i zmiana rozmiaru kart bez przerywania czatu, stany zastępcze dla usuniętej i cudzej rozmowy, zachowanie
zaznaczeń i niezapisanych danych przy zmianie kompozycji, proza obok OpenUI w jednej wiadomości,
odsłanianie elementu w zwiniętej sekcji.

### Task 5: BL-11a — kontekst aplikacji dla agenta
Kryteria: **L6.3, L6.4, L6.7, L6.8, L6.9, L6.10, L6.11, L6.12, L6.14**. Aktualny kontekst w trakcie
długiego zadania (nie snapshot ze startu), walidacja kontekstu bez nadawania uprawnień, selektywne
pobieranie z limitem, kontekst czytany w chwili wysłania, cel rozpoczętej operacji niezmieniany przez
późniejszą nawigację, rozróżnienie braku zasobu od pustego wyniku, brak przecieku kontekstu po zmianie
rozmowy/przestrzeni/właściciela, zadanie w tle nie przejmuje nowego zaznaczenia.

### Task 6: BL-11b — orkiestracja i domena
Kryteria: **L7.4, L7.8, L7.9, L7.10, L9.2, L9.3, L9.5, L9.6, L9.7, L9.8, L9.14, L9.15**. Brak wyścigów
w jednej sesji (pomiar po starcie wykonania, nie po zakolejkowaniu), równoległe rozmowy bez mieszania,
błąd i anulowanie zwalniają kolejkę, te same reguły dla HTTP i MCP, konflikt wersji, idempotencja przy
jednoczesnych ponowieniach, atomowość wieloetapowego zapisu z wymuszoną awarią.

### Task 7: BL-11c — cache i artefakty
Kryteria: **L10.6, L10.7, L10.9, L10.11, L10.14, L10.15**. Współdzielone pobrania i klucze z kontekstem
dostępu, brak danych poprzedniego właściciela po przełączeniu (także z opóźnionych żądań i strumieni),
podgląd i pełny widok tej samej wersji, snapshot kontra live po zmianie źródła i po restarcie,
rozróżnienie wersji definicji i świeżości wyniku.

### Task 8: BL-08a — czat i historia
Kryteria: **L4.3, L4.5, L4.6, L4.7, L4.8, L4.9, L4.11, L4.13, L4.15**. Tytuły bez API Anthropic,
przełączanie rozmów bez mieszania, brak podwójnych wiadomości po reconnect, skutek usunięcia rozmowy
(sesja, zadanie, artefakty), jawny zakres edycji/rozgałęzień/kosza, proza i OpenUI widoczne, historia
narzędzi z powiązaniem wywołanie–wynik, brak kolizji identyfikatorów, rozszerzenia renderera bez utraty
prezentacji narzędzi i artefaktów.

### Task 9: BL-08b — zdarzenia i strumień
Kryteria: **L5.2, L5.3, L5.4, L5.5, L5.6, L5.11, L5.12, L5.13, L5.14, L5.15**. Rozpoznanie startu,
końca, błędu i anulowania; wywołania narzędzi i wyniki widoczne w czacie i po odtworzeniu; artefakty i
zmiany UI do właściwych rendererów; pytanie o zgodę wraca do właściwego wykonania; reconnect bez
duplikatów; zgodność AG-UI sprawdzana dla schematów i zachowania; korelacja przy równoległych
przebiegach; kolejności tekst–narzędzie i brak tekstu; ograniczenia parsera potwierdzone dla użytej wersji.

### Task 10: BL-09 — pliki, sandbox i praca w tle
Kryteria: **L11.7, L11.10, L11.12, L11.13, L11.15, L11.16, L11.18, L11.19, L11.20, L11.22, L11.23,
L11.24**. Stop dociera do procesów potomnych; wyniki trwałe po sprzątaniu; polityka zgód zgodna z
kolejnością mechanizmów SDK; zgoda i odmowa przypisane do wykonania; zamknięcie panelu i utrata sieci nie
przerywają zadania; publikacja atomowa; odzyskanie statusu po reconnect; sygnał oczekiwania na decyzję;
PNG/JPEG/XLSX/CSV/tekst; odczyt treści obrazu; wiele arkuszy i typów komórek; semantyka formuł; artefakt
z podglądem i pobraniem po restarcie.

### Task 11: BL-03 — powtarzalne próby na prawdziwym modelu (grant ≤ 25 tur)
Kryteria: **L1.6, L2.13, L3.2, L3.10, L3.13, L5.8, L6.5, L6.6, L7.3, L7.11, L8.5, L9.4, L9.13, L9.16,
L11.3, L11.4, L11.5, L11.9, L11.11**. Każde ma przebieg na commicie szablonu, oznaczony jako rzeczywisty
model, z kontrolą negatywną tam, gdzie wymaga jej treść kryterium.

### Task 12: BL-04 — uwierzytelnienie i limity (grant ≤ 8 tur)
Kryteria: **L8.2, L8.3, L8.6, L8.7, L8.8, L8.9, L8.10, L8.11, L8.12, L8.13, L8.14**. Stand-iny na
granicy adaptera dają rozróżnialne stany w UI i zachowują historię bez powtórki mutacji; opis odczytu
poświadczeń zgodny z kodem; testy negatywne nie niszczą logowania użytkownika.

### Task 13: BL-12 — odbiór i jakość dowodów (grant ≤ 8 tur)
Kryteria: **L1.2, L1.8, L1.9, L1.11, L1.12, L12.5, L12.7, L12.10, L12.12, L12.15** oraz **indeks prób
T01–T27**: każda próba ma dowód, rodzaj dowodu i wskazanie pliku testu; próby, które wymagają modelu,
dostają przebieg w ramach grantu.

## 5. Proces każdego pakietu

1. Implementacja w osobnym worktree (zadanie ma własną gałąź `domkniecie/<zadanie>`).
2. Niezależny review innego subagenta: zgodność z kryteriami, jakość testów, granica platforma–domena,
   brak atrap i pustych asercji.
3. Runda poprawek + zawężony re-review.
4. Bramka G17 i scalenie przez koordynatora; po scaleniu koordynator uruchamia `pnpm verify`, a przy
   zmianach UI także spece przeglądarkowe.
5. Aktualizacja `docs/acceptance/assessment.json` (koordynator), dowody w `docs/evidence/<zadanie>/`,
   wpis w `FEEDBACK.md`.
6. Pakiet oznaczony jako zamknięty dopiero po tym wszystkim.

## 6. Odbiór końcowy

`pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm test`, `pnpm test:e2e`, `pnpm test:e2e:model`
(w izolowanym środowisku), `pnpm check:module-swap`, macierz 200/200, 12/12 warstw, T01–T27 z dowodami,
brak kryteriów częściowych/niespełnionych/niesprawdzonych, brak sekretów i ścieżek lokalnych, dokumenty
opisujące stan faktyczny. Produkty końcowe: `docs/RAPORT-DOMKNIECIA-PLATFORMY.md`, `FEEDBACK.md`,
macierz, indeks dowodów, lista decyzji architektonicznych, lista zmian względem `v0.3.0`, lista
pozostałych ograniczeń. Publikacja na GitHuba **dopiero po akceptacji raportu przez zamawiającego**.
