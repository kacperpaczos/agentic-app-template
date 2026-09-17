# Raport architekta — zamknięcie pakietów BL-01 i BL-02

> Zlecenie: rozbudowa szablonu o semantyczne UI sterowane rozmową (BL-01) i własne widoki agenta
> (BL-02), z próbami odbiorowymi T25, T26 i T27 na prawdziwym modelu.
> Gałąź: `bl01-bl02/integracja`, stan opisywany: **97a7945** (95 commitów ponad `main` 7f569c0,
> 156 plików, +29 430 / −1 335).
> Data: 2026-09-18. Plan i decyzje: [`docs/plans/2026-09-17-bl01-bl02.md`](plans/2026-09-17-bl01-bl02.md).
> Dziennik: [`FEEDBACK.md`](../FEEDBACK.md) §T2. Oceny kryteriów: [`docs/ACCEPTANCE.md`](ACCEPTANCE.md).

## 1. Co zostało dostarczone

| Pakiet | Kryteria | Stan | Rodzaj dowodu |
|---|---|---|---|
| BL-01 | L2.16, L2.17, L6.15, L6.16, L6.17 | zamknięty | prawdziwy model (T25, T26) + testy GUI bez modelu + testy kontraktu |
| BL-02 | L3.14, L3.15, L3.16, L3.17, L3.18 | zamknięty | prawdziwy model (T27) + testy GUI bez modelu + testy kontraktu |
| Próby | T25, T26, T27 | zaliczone | prawdziwy model, 21 tur, dowody w `docs/evidence/bl01-bl02-2026-09-17/` |

Poza zleconym zakresem dowód powstał także dla: **L3.3, L3.4, L3.12** (walidacja kompozycji na
serwerze), **L2.6** (rozróżnialne stany prezentacji), **L10.5, L10.12** (odświeżenie po mutacji,
nieudane odświeżenie nie udaje świeżego), **L6.1, L6.2** (stan widoku w kontekście kolejnego
polecenia). Zawężone zostały braki w **L2.1, L2.13, L2.14, L2.15, L3.11, L6.3**.

Sumy macierzy: **77 potwierdzonych / 107 częściowych / 9 niespełnionych / 7 niesprawdzonych**
(przed pracą: 59 / 118 / 15 / 8). Żadna warstwa nie jest zamknięta — to nadal nie jest odbiór 200
kryteriów.

## 2. Architektura, która faktycznie powstała

1. **Jeden mechanizm widoków.** Ekrany modułu (`/data`, `/cases`, `/cases/$caseId`, `/items/$itemId`)
   i karty w „Widokach agenta” są kompozycjami OpenUI Lang nad wspólnym katalogiem; React pozostaje w
   komponentach. Powłoka, router i gotowy czat zostają deterministycznym Reactem.
2. **Dane tylko z zarejestrowanych odczytów.** Komponenty danych dostają deskryptor
   `{operation, input}`, nigdy wartości. Moduł opisuje wynik odczytu: kolekcja, rodzaj rekordu, pole
   identyfikatora, pola z typami i jednostkami, akcje rekordu. Ten opis jest źródłem etykiet,
   formatowania, dozwolonych pól filtra i sortowania, mapowania rekord–pole i walidacji kompozycji.
3. **Stan widoku w adresie.** Zawężenie, sortowanie i strona są parametrami adresu, więc link,
   przeładowanie i Wstecz je zachowują. Ten sam stan widzą kontrolki użytkownika, agent (typowane
   akcje `ui_filter`, `ui_sort`) i kontekst kolejnego polecenia.
4. **Semantyczny opis ekranu.** Przeglądarka publikuje wersjonowany opis (widok, wersja kompozycji,
   instancje, rekord–pole, filtry, sortowanie, strona, grupowanie, dozwolone akcje, stan), a agent
   czyta go narzędziem `ui_state`. Wersja jest przypisana do konkretnej karty przeglądarki; zamknięta
   albo nieaktywna karta jest zgłaszana wprost.
5. **Walidacja kompozycji po stronie serwera.** Każda kompozycja przechodzi przez parser OpenUI Lang
   na tym samym katalogu, z którego renderuje przeglądarka. W przestrzeni widoków agenta obowiązuje
   węższa lista komponentów — model nie może wstawić własnych liczb ani wierszy.
6. **Interakcje przez te same operacje.** Akcja rekordu należy do odczytu, więc pojawia się tak samo w
   widoku domyślnym i w widoku agenta, a wykonuje się przez to samo wywołanie narzędzia co MCP, z
   właścicielem z sesji, ponownym odczytem rekordu i idempotencją.

Granica platforma–domena bez zmian: `packages/platform-*` nie zna nazw domeny, moduł dostarcza
encje, odczyty, widoki, komponenty i akcje, a łączy je wyłącznie warstwa składania. Kontrakt dla
autora modułu opisuje [`docs/NEW-APPLICATION.md`](NEW-APPLICATION.md) §3.1 i §3.2.

## 3. Jak to było prowadzone

Dziewięć zadań implementacyjnych i fala poprawek, każde w osobnym worktree, każde zakończone
niezależnym przeglądem przed scaleniem; przeglądy zawężone po każdej rundzie poprawek; dwa
równoległe przeglądy końcowe całej gałęzi (część serwerowa i część przeglądarkowa). Żaden
implementator nie oceniał własnej pracy, a raport implementatora nigdy nie był podstawą zamknięcia
zadania — po każdym scaleniu koordynator uruchamiał `pnpm verify`, a przy scaleniach zmieniających
UI także testy przeglądarkowe.

Tury subskrypcji: **21**, w trzech przyznanych budżetach (12 / 6 / 4), w tym jedna stracona na błąd
wykonawcy. Rejestr: `docs/evidence/bl01-bl02-2026-09-17/tury-modelu.json`.

## 4. Weryfikacja koordynatora (czysta kopia gałęzi, 97a7945)

| Kontrola | Wynik |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm verify` (granica, macierze, typy pakietów **i** `e2e/`, build, testy) | exit 0 — 32 pliki / 542 testy |
| `pnpm test:e2e` (domyślny przebieg) | exit 0 — 114 testów; próby modelowe pominięte, zero tur |
| Dowody odbioru po tym przebiegu | bajt w bajt nietknięte |
| `pnpm check:module-swap` | exit 0 |
| Start produkcyjny na porcie testowym | `/api/health` z etykietą testową, `/api/status` odmawia bez sesji, strona 200 |
| Instancja użytkownika (port 8791) | nietknięta: ten sam proces, identyczna suma kontrolna `dist` |

Środowisko: Node v24.19.0, pnpm 9.15.9, zależności z lockfile. Odtworzenie: `pnpm install
--frozen-lockfile`, `pnpm verify`, `pnpm test:e2e`; próby modelowe wyłącznie `pnpm test:e2e:model`
(11 tur subskrypcji na przebieg).

## 5. Czego prawdziwy model nauczył o produkcie

1. Agent użył kodu sprawy jako identyfikatora rekordu, bo prompt widoków agenta nie mówił tego, co
   sekcja wskazywania wartości. Platforma odmówiła odczytu i nie wpuściła zmyślonych danych; po
   poprawce agent wyszukuje rekord i używa prawdziwego identyfikatora.
2. Agent ogłosił wykres, który się nie narysował (seria mieszająca PLN i EUR). Narzędzia zwracają
   teraz `rendered: false` i zdanie, że kompozycja została zapisana, a nie narysowana, a reguła
   czytania stanu ekranu objęła `agent_view_*`. Po poprawce model odczytał ekran i powiedział
   użytkownikowi, dlaczego wykresu nie ma.
3. Agent sięgał po „Polska” zamiast kodu `PL`, choć katalog podaje wartości — teraz są wypisane przy
   celu w prompcie, z regułą używania ich dosłownie.

Każde z tych ustaleń powstało dopiero na prawdziwym modelu; testy skryptowane dowodziłyby wyłącznie
tego, że skrypt robi to, co mówi skrypt.

## 6. Znane ograniczenia i pozycje odłożone

**Zaakceptowane świadomie** (nie blokują odbioru, opisane, by nie zostały odkryte jako niespodzianka):

- Sortowanie po polu z jednostką z rekordu jest **odrzucane**, gdy rekordy nie zgadzają się co do
  jednostki. Przy tworzeniu takiego widoku agent nie dostaje jednak ostrzeżenia (jak przy wykresie) —
  zobaczy dopiero uczciwy błąd na karcie.
- `pnpm test:e2e:model` kosztuje 11 tur, ale bramka budżetu chroni tylko spec odbiorowy;
  `agent-ui.spec.ts` i `files-agent.spec.ts` wydają swoje 4 tury bez liczenia.
- Wskazanie wartości działa w tabeli (`DataTable`); podsumowanie i wykres nie odsłaniają dowolnego
  rekordu. Ekran rekordowy jest kandydatem tylko wtedy, gdy przeglądarka akurat go pokazuje.
- `ui_state` nie niesie informacji o sortowaniu odrzuconym przez adres, a `get_context` nadal zwraca
  zaznaczenie i szkice z chwili startu wykonania (L6.3 pozostaje częściowe).
- Wpisany tekst w otwartym formularzu akcji przepada, gdy wiersz opuszcza stronę — tak samo przy
  ręcznej zmianie strony.
- Dwie asercje w specyfikacji odbiorowej wzmocniono po ostatnim przebiegu modelu, więc **nie były
  wykonane w turze**; zapisane dowody pokazują wartości, które teraz wymuszają.

**Sprzed tej pracy, nie zamknięte i nie liczone jako naprawione:** panel czatu i stan powłoki nie są
resetowane po zmianie konta, więc tabela w czacie może nadal pokazywać wiersze poprzedniego
użytkownika; canvas po przełączeniu konta pokazuje błąd, dopóki użytkownik nie zmieni przestrzeni.
Do agenta te dane nie trafiają (opis ekranu jest filtrowany epoką dostępu), ale przy ocenie L10.11 i
próby T12 należy je uwzględnić.

Pełna lista pozycji odłożonych z przeglądów (47) i rozstrzygnięć koordynatora (45) jest w ledgerze
przebiegu: `.superpowers/sdd/2026-09-17-bl01-bl02/progress.md` (poza publikowanym szablonem).

## 7. Rozdzielenie odbioru

Zgodnie z L12.17:

- **Ukończenie implementacji:** tak, dla pakietów BL-01 i BL-02, w zakresie opisanym w §1.
- **Odbiór w izolacji:** tak — weryfikacja w czystej kopii gałęzi na instancji testowej (§4), z
  dowodami prób modelowych.
- **Uruchomienie z migracją na danych użytkownika:** **nie wykonano.** Ta praca nie dotykała danych
  użytkownika ani jego instancji; gałąź nie została scalona do `main` ani opublikowana. Migracje
  platformy i modułu nie zmieniły się w tym zakresie, ale wdrożenie na danych to osobne zdarzenie,
  które wymaga kopii, próby na kopii i decyzji właściciela.
