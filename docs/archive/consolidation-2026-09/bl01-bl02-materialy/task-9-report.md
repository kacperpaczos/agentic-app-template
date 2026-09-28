# Raport — Task 9: Poprawki z ustaleń prób modelowych (F1, F2, F3)

**Gałąź:** `bl01-bl02/t9-poprawki-modelowe`, worktree `/home/paczos/Documents/agentic-app-template-wt/t9-poprawki-modelowe`.
**BASE:** `00a88a7` (gałąź integracyjna po scaleniu i przeglądzie Tasków 1–7).
**Zakres:** wyłącznie instrukcja modelu i treść wyników narzędzi. Żadnej nowej funkcji, żadnej walidacji
zależnej od danych, żadnej zmiany zachowania klienta ani backendu poza polami dopisanymi do dwóch wyników.

| Commit | Temat |
|---|---|
| `807f982` | Poprawki z ustalen prob modelowych: identyfikatory z odczytu, zapisane to nie narysowane, wartosci pola zawezania |
| `a51e237` | Test ostrzezenia bierze kompozycje wprost z proby T27 (ceny jednostkowe pozycji ofert w PLN i EUR) |

Statystyka `00a88a7..HEAD`: 6 plików, +341 / −8.

---

## 0. Wynik w jednym akapicie

Zamknięte są trzy ustalenia z raportu Taska 8. **F1** — sekcja promptu o widokach agenta mówi teraz, skąd
biorą się identyfikatory w `source.input` (z odczytu albo z kontekstu, nigdy z kodu wpisanego przez
użytkownika), że walidator sprawdza schemat a nie istnienie rekordu, i jak **wygląda odmowa odczytu** w opisie
ekranu. **F2** — wyniki `agent_view_create` / `agent_view_update` niosą `rendered: false` i zdanie `readBack`
(kompozycja ZAPISANA, nie narysowana; co widać, odczytuje się przez `ui_state`), reguła promptu „## Stan
ekranu" obejmuje `agent_view_*`, a przy serii wykresu, której pole niesie jednostkę z rekordu, wynik zawiera
ostrzeżenie `warnings[unit_from_record]` — z deskryptora, bez czytania danych, **nigdy jako odmowa**.
**F3** — lista celów w prompcie podaje zadeklarowane `values` pola zawężania w nawiasie, a sekcja
„## Zawężanie widoku" oraz opisy `ui_catalog` / `ui_filter` mówią, że wartość bierze się z tej listy dosłownie.
Bramka: `pnpm verify` **exit 0** (31 plików, 529 testów), cztery spece przeglądarkowe pod blokadą **exit 0**
(28 testów), pięć prób zdolności wykrycia — każda oblała właściwy test i została przywrócona.

---

## 1. Co powstało

### 1.1 F1 — identyfikator rekordu nie jest kodem biznesowym

`packages/platform-server/src/agent/tools/agent-views.ts`, `agentViewsPromptSection`, sekcja
„## Co wolno wpisac do kompozycji", **bezpośrednio po** linii opisującej `source = {operation, input}` (tam,
gdzie model czyta, co wpisać do źródła — nie na końcu listy):

```
- Identyfikatory w source.input musza pochodzic z ODCZYTU: z wyniku narzedzia modulu (wyszukiwanie, lista,
  operacja odczytu) albo z biezacego kontekstu (zasob, zaznaczenie, opis ekranu z ui_state). NIGDY nie wstawiaj
  kodu biznesowego, ktory uzytkownik wpisal w rozmowie (np. "PC-2026-01"), jako identyfikatora rekordu —
  kod i identyfikator to rozne rzeczy. Gdy uzytkownik nazywa rekord slowem albo kodem, najpierw go znajdz
  narzedziem modulu i wez identyfikator z wyniku.
- Walidator sprawdza schemat kompozycji, a NIE istnienie rekordu: zmyslony identyfikator przechodzi walidacje,
  a odmowa przychodzi dopiero przy odczycie. Tak wyglada odmowa w opisie ekranu: instancja ma state = forbidden
  (albo error), error.code not_found lub forbidden, error.message podaje powod, zero rekordow, a karta pokazuje
  komunikat o odmowie zamiast danych. Wtedy widok NIE pokazuje danych — powiedz to uzytkownikowi i popraw
  identyfikator; nie wymyslaj wartosci.
```

Drugi akapit jest odpowiedzią na §4.3 raportu Taska 8: `state` mówi `forbidden`, a `error.code` mówi
`not_found`, bo `isAccessFailure` w `DataFrame.tsx` traktuje je jednakowo, żeby ekran nie zdradzał, czy cudzy
rekord istnieje. Model, który przeczyta tylko `state`, musi wiedzieć, że to nie sprzeczność — dlatego wymienione
są obie nazwy naraz.

Do opisu narzędzia `agent_view_create` dopisane jedno zdanie o pochodzeniu identyfikatorów (opis narzędzia jest
w kontekście modelu zawsze, prompt tylko przy zarejestrowanych odczytach).

Wzorem jest sąsiednia, sprawdzona reguła: „## Pokazanie wartosci pola rekordu" od początku mówi „znajdz rekord
i jego identyfikator narzedziem modulu", i ta ścieżka **ani razu** nie dała tej pomyłki (§4.1 raportu Taska 8) —
w obu przebiegach z pytaniem o NIP model najpierw ustalił rekord, potem wskazał wartość.

### 1.2 F2a — wynik mówi, że kompozycja jest zapisana, a nie narysowana

`agent-views.ts`: stała `NOT_RENDERED_NOTE` i pole `rendered: false` w **trzech** miejscach zwrotu —
`agent_view_create`, `agent_view_update` (zmiana) i `agent_view_update` (`unchanged: true`). Ostatnie celowo:
brak zmiany nie zbliża modelu do zobaczenia ekranu ani o krok.

```
rendered: false,
readBack: 'Kompozycja zostala ZAPISANA, ale nie narysowana: ten wynik nie mowi nic o tym, co karta pokazuje.
  Zanim powiesz uzytkownikowi, co widok przedstawia, odczytaj ekran przez mcp__app__ui_state (stan instancji,
  liczba rekordow, ewentualna odmowa komponentu). Jesli opis ekranu nie wymienia tej karty (uzytkownik patrzy
  gdzie indziej), powiedz tylko, ze widok powstal — nie opisuj, co przedstawia.'
warnings: [...]
```

Dopisane **na końcu** obiektu, po dotychczasowych polach — `cardId` zostaje pierwszym kluczem, więc asercja
`e2e/agent-views.spec.ts` na echo wyniku w czacie (`[call:agent_view_create] {"cardId":"…`) trzyma się nadal.
Do opisów obu narzędzi dopisane to samo zdanie.

### 1.3 F2b — reguła „## Stan ekranu" obejmuje `agent_view_*`

`packages/platform-server/src/agent/prompt.ts`, zaraz po zdaniu o `ui_navigate` / `ui_filter` / `ui_sort`:

```
Po agent_view_create i agent_view_update tez odczytaj ui_state, ZANIM powiesz, co widok pokazuje: te narzedzia
ZAPISUJA kompozycje, nie rysuja jej, i nie zwracaja uiVersion — podaj minVersion i clientId, jesli masz je
z wczesniejszego ui_navigate / ui_filter / ui_sort, a w przeciwnym razie odczytaj bez nich.
NIE mow, ze wykres, tabela albo podsumowanie cos pokazuje, jesli nie odczytales tego z opisu ekranu: komponent
moze odmowic rysowania (state = error, error.message mowi dlaczego), a odczyt moze byc odrzucony (state = forbidden).
Gdy opis ekranu nie wymienia twojej karty ani jej instancji, bo uzytkownik patrzy na co innego — powiedz, ze widok
powstal albo sie zmienil, i nie opisuj, co przedstawia.
```

Bliźniacza sekcja „## Po utworzeniu albo zmianie widoku" w `agentViewsPromptSection` (przy narzędziach, z
odesłaniem do „## Stan ekranu"), bo model komponujący widok czyta tamtą część promptu, a nie tę.

### 1.4 F2c — ostrzeżenie `unit_from_record` (statyczne, z deskryptora)

`compositionWarnings(source, services)` w `agent-views.ts`. Dla każdej instancji `DataChart` w zapisanej
kompozycji sprawdza, czy któreś pole z `series` ma w deskryptorze operacji `unitField` — czyli niesie jednostkę
**z rekordu**, a nie stałą. Jeśli tak, wynik dostaje:

```json
{"code": "unit_from_record", "statementId": "wykres",
 "message": "Instrukcja wykres (DataChart): serie Cena jednostkowa (jednostka z pola currency) niosa jednostke
   z rekordu, wiec dopiero dane pokaza, czy jest jednolita. Jesli nie jest (np. PLN i EUR naraz), wykres odmowi
   narysowania. Nie obiecuj tego wykresu uzytkownikowi, zanim nie odczytasz ekranu przez mcp__app__ui_state."}
```

**Dlaczego to jest bezpieczne** (i dlaczego to ostrzeżenie, nie odmowa — decyzja koordynatora):

- pytanie jest zadane **deskryptorowi**, nie danym: nie ma tu `POST /api/read`, nie ma wierszy, nie ma
  własności użytkownika w grze. Odpowiedź jest taka sama dziś i za rok, dopóki moduł nie zmieni deklaracji;
- to, co sprawdzam, jest **słabsze** niż to, co odmawia narysować `buildChartModel`: nie „ta seria łączy
  jednostki", tylko „o tej serii nie da się tego rozstrzygnąć przed narysowaniem". Pole z `unitField` może
  narysować się bez zarzutu, gdy wszystkie rekordy są w PLN — dlatego kompozycja zostaje zapisana;
- odmowa byłaby wprost sprzeczna z ustaleniem koordynatora: dane zmieniają się później, więc kompozycja
  odrzucona dziś dla dzisiejszych wierszy byłaby odrzucona także wtedy, gdy wiersze są w porządku, a
  kompozycja przyjęta dziś i tak może nie narysować się jutro. Trwałą strażą zostaje uczciwa odmowa komponentu;
- `findDataInstances` jest w `try/catch`, a nierozpoznana operacja jest pomijana: **ostrzeżenie nigdy nie może
  być powodem, dla którego zapisany widok zostaje zgłoszony jako błąd**.

W badanym przebiegu `run_96c52b19607e4a21a589` model dostałby to ostrzeżenie dokładnie na tej kompozycji —
test `a51e237` bierze ją wprost z próby (`procurement.case_offer_items`, seria `unitPriceMinor`, pozycje
wycenione w PLN i EUR).

### 1.5 F3 — zadeklarowane wartości pola zawężania

Trzy miejsca, żadne nie zmienia kontraktu:

1. `prompt.ts`, `describeFilterField` — linia celu interfejsu podaje wartości w nawiasie:
   `| zawezanie po: country (PL|FI|DE|CZ), name, taxId` oraz
   `| zawezanie po: status (draft|collecting|decided), currency (PLN|EUR), title, code`.
   Pole bez `values` zostaje samą nazwą, więc kontrast jest widoczny w jednej linii. Lista jest **ucinana** po
   12 wartościach (`PROMPT_FILTER_VALUES`) dopiskiem „... pelna lista w ui_catalog" — schemat dopuszcza 40
   wartości po 120 znaków, a prompt nie jest miejscem na 4,8 kB jednego pola;
2. `prompt.ts`, sekcja „## Zawezanie widoku" — akapit „Pole moze miec podane DOZWOLONE WARTOSCI … uzyj JEDNEJ
   Z NICH DOSLOWNIE, tak jak jest zapisana (np. kod kraju PL, nie „Polska" ani „Poland"). Nie tlumacz ich na
   slowa i nie dochodz do nich probami … Pole bez values przyjmuje dowolna wartosc.";
3. `agent/tools/ui.ts` — po jednym zdaniu w opisach `ui_catalog` i `ui_filter`.

Sam wynik `ui_catalog` **nie był zmieniany**: `values` zwracał już od Taska 2 (`ui.ts:41-45`), co potwierdza
dodatkowa asercja w teście — porównuje to, co jest w prompcie, z tym, co zwraca rejestr, żeby jedno nie
odjechało od drugiego.

---

## 2. Decyzje tam, gdzie brief zostawił wybór

**(a) Statyczna kontrola mieszanych jednostek — zrobiona, w kształcie ostrzeżenia.** Brief dopuszczał ją
warunkowo („jeśli znajdziesz tanią, niezależną od danych"). Znalazłem dokładnie ten przykład, który brief
wymienia: seria, której `unitField` czyni jednolitość niesprawdzalną. Uzasadnienie bezpieczeństwa — §1.4.
Kontrola **nie odmawia** i **nie czyta danych**.

**(b) `rendered: false` także przy `unchanged: true`.** Brief mówił o wyniku „create/update". Przypadek
„patch nic nie zmienia" zwraca wcześniej, osobną gałęzią — pominięcie go zostawiłoby jedyną ścieżkę, w której
model dostaje sukces bez słowa o tym, że nie widział ekranu.

**(c) Reguła w dwóch miejscach promptu.** Brief wskazał „## Stan ekranu". Dopisałem tam pełną regułę, a przy
narzędziach widoków krótką sekcję z odesłaniem. Powód: „## Stan ekranu" powstaje tylko, gdy rejestr ma cele
interfejsu (`uiTargets.length`), a sekcja widoków agenta — gdy ma operacje odczytu (`readOperations.length`).
To są **różne warunki**; moduł deklarujący odczyty bez celów UI dostałby widoki agenta bez reguły odczytu
wstecz. Poza tym model komponujący widok czyta sekcję widoków, nie sekcję sterowania interfejsem.

**(d) Co powiedzieć, gdy użytkownik patrzy na inny ekran.** To jest realne ograniczenie, nie niedopatrzenie:
`ui_state` zwraca opis ekranu karty przeglądarki pokazującej rozmowę wykonania, a karta widoku agenta jest
narysowana tylko na ekranie Widoków agenta. W `run_96c52b19607e4a21a589` użytkownik był na ekranie sprawy,
więc `ui_state` **nie pokazałby** tego wykresu. Reguła „nie przełączaj ekranu z własnej inicjatywy" zostaje
nietknięta, a wyjściem jest uczciwość: powiedz, że widok powstał, i nie opisuj, co przedstawia. To zamyka
ustalenie w jego istocie — model ma nie twierdzić, że wykres coś pokazuje, skoro tego nie widział.

**(e) Bez nowej walidacji wartości `ui_filter`.** Kusiło, żeby odrzucać wartość spoza `values`. Nie zrobiłem
tego: `op` bywa `contains`, wartość bywa tablicą, a platforma zachowuje się dziś poprawnie i jest to realny
dowód kontroli negatywnej T26 (`executed: true, filtered {matched: 0, total: 4}` — „zastosowane, tyle
zostało", nie błąd). Zmiana byłaby poza zakresem i zniszczyłaby ten dowód.

**(f) Jeden commit na wszystkie trzy ustalenia.** `prompt.ts` niesie hunki F2 i F3, a `agent-views.ts` F1 i
F2 — rozdzielenie wymagałoby cięcia po hunkach w jednym pliku. Treść commita rozpisuje trzy ustalenia osobno.

---

## 3. Zmienione pliki

| Plik | Co |
|---|---|
| `packages/platform-server/src/agent/tools/agent-views.ts` | `NOT_RENDERED_NOTE`, `CompositionWarning`, `compositionWarnings`; `rendered`/`readBack`/`warnings` w trzech zwrotach; opisy `agent_view_create` i `agent_view_update`; w prompcie: identyfikatory w `source.input` + sekcja „## Po utworzeniu albo zmianie widoku" |
| `packages/platform-server/src/agent/prompt.ts` | „## Stan ekranu" obejmuje `agent_view_*`; akapit o `values` w „## Zawezanie widoku"; `describeFilterField` + `PROMPT_FILTER_VALUES` w linii celu |
| `packages/platform-server/src/agent/tools/ui.ts` | zdanie o `values` w opisach `ui_catalog` i `ui_filter` |
| `tests/agent-views.test.ts` | nowy test kształtu wyniku i ostrzeżenia (z kompozycją z próby T27); asercje promptu F1 i F2 w istniejącym teście promptu |
| `tests/ui-snapshot.test.ts` | nowy test: „## Stan ekranu" obejmuje `agent_view_create` / `agent_view_update` |
| `tests/view-filter.test.ts` | nowy test: wartości w linii celu, reguła dosłowności, zgodność z rejestrem |

---

## 4. Testy — rodzaj dowodu przy każdym

Wszystkie nowe testy to **testy kontraktu lub logiki**. Zgodnie z briefem **nie wydano ani jednej tury
modelu** — sprawdzenie zachowania modelu należy do ponownego przebiegu T27 w Tasku 8.

| Test | Plik | Co dowodzi | Rodzaj dowodu |
|---|---|---|---|
| „wynik mowi, ze kompozycja jest ZAPISANA a nie narysowana, i ostrzega o serii z jednostka z rekordu" | `tests/agent-views.test.ts` | `rendered: false`, `readBack` z nazwą `mcp__app__ui_state` w create, update i `unchanged`; ostrzeżenie dla serii z `unitField`, brak dla serii bez niego i dla `DataTable`; karta zostaje zapisana (ostrzeżenie ≠ odmowa); kompozycja z `run_96c52b19607e4a21a589` | test kontraktu / logiki |
| „prompt opisuje widoki agenta sygnaturami z katalogu" (rozszerzony) | `tests/agent-views.test.ts` | reguła identyfikatorów, „walidator sprawdza schemat a NIE istnienie rekordu", opis odmowy (`state = forbidden`, `error.code not_found lub forbidden`), sekcja „## Po utworzeniu albo zmianie widoku" | test kontraktu / logiki |
| „prompt: po agent_view_create / agent_view_update tez odczytaj ekran…" | `tests/ui-snapshot.test.ts` | reguła leży **wewnątrz** sekcji „## Stan ekranu" (asercje na wycinku między nagłówkami, nie na całym prompcie) | test kontraktu / logiki |
| „podaje zadeklarowane wartosci pola zawezania i kaze uzyc ich doslownie" | `tests/view-filter.test.ts` | `zawezanie po: … country (PL|FI|DE|CZ)`, „uzyj JEDNEJ Z NICH DOSLOWNIE", „nie „Polska" ani „Poland"", „Pole bez values przyjmuje dowolna wartosc"; te same wartości co w rejestrze | test kontraktu / logiki |

### Kontrole negatywne

- **ostrzeżenie nie jest odmową**: po wywołaniu z ostrzeżeniem karta jest w bazie i niesie `DataChart`
  (asercja na `canvas.getCard(...).spec.source`);
- **seria bez `unitField`** (`score`, `number` bez jednostki) → `warnings: []`;
- **`DataTable` nad tą samą operacją** (kolumna `totalMinor` z `unitField`) → `warnings: []`; ostrzeżenie
  dotyczy wykresu, bo to wykres odmawia rysowania, a nie tabela;
- **pole bez `values`** (`name`, `taxId`, `title`, `code`) zostaje w prompcie samą nazwą — widać w wycinku
  linii celu przytoczonym w §1.5;
- **wartości w prompcie = wartości w rejestrze**: test czyta `uiTargets()` i porównuje, więc rozjazd między
  promptem a `ui_catalog` oblewa.

### Próby zdolności wykrycia (procedura z `dispatch-common.md`)

Każda: commit najpierw (`807f982`), `git status --short` puste, wycofanie linii, test, przywrócenie przez
`git checkout -- <plik>`, `git status --short` puste.

| # | Co wycofano | Test | Wynik |
|---|---|---|---|
| 1 | akapit o identyfikatorach w `source.input` (1031 znaków) z `agentViewsPromptSection` | `tests/agent-views.test.ts` | **oblał** — `expected '…' to contain 'Identyfikatory w source.input musza p…'` (1 failed / 31 passed) |
| 2 | `rendered` + `readBack` + `warnings` ze zwrotu `agent_view_create` | `tests/agent-views.test.ts` | **oblał** — `expected undefined to be false` (1 failed / 31 passed) |
| 3 | warunek `f?.unitField` w `compositionWarnings` (zamieniony na fałsz) | `tests/agent-views.test.ts` | **oblał** — `expected [] to have a length of 1 but got +0` (1 failed / 31 passed) |
| 4 | akapit o `agent_view_*` z „## Stan ekranu" (773 znaki) | `tests/ui-snapshot.test.ts` + `tests/agent-views.test.ts` | **oblał** — `expected '## Stan ekranu"…' to contain 'Po agent_view_create i agent_view_upd…'` (1 failed / 88 passed) |
| 5a | `describeFilterField` → `(f) => f.field` w linii celu | `tests/view-filter.test.ts` | **oblał** — `to match /zawezanie po: .*country \(PL\|FI\|DE\…/` (1 failed / 21 passed) |
| 5b | akapit o `DOZWOLONE WARTOSCI` z „## Zawezanie widoku" (448 znaków) | `tests/view-filter.test.ts` | **oblał** — `to contain 'uzyj JEDNEJ Z NICH DOSLOWNIE'` (1 failed / 21 passed) |

Po każdej próbie drzewo wracało do stanu czystego; po ostatniej zestaw trzech plików znowu **111 passed**.

---

## 5. Polecenia, kody wyjścia, liczby testów

```
cd /home/paczos/Documents/agentic-app-template-wt/t9-poprawki-modelowe

pnpm typecheck                                        # exit 0
pnpm verify                                           # exit 0 — 31 plików testowych, 529 testów
pnpm build                                            # exit 0 (dist/server.js 429,7 kB)

flock -w 5400 /home/paczos/Documents/agentic-app-template-wt/.e2e.lock \
  pnpm exec playwright test e2e/agent-views.spec.ts e2e/composed-views.spec.ts \
                           e2e/interactions.spec.ts e2e/show-value.spec.ts
                                                      # exit 0 — 28 passed (1.9m)

pnpm exec vitest run tests/agent-views.test.ts tests/view-filter.test.ts tests/ui-snapshot.test.ts
                                                      # exit 0 — 111 testów
```

**Dobór speców przeglądarkowych.** Brief wymagał `e2e/agent-views.spec.ts` i speców z asercjami na treść
promptu. Żaden spec przeglądarkowy nie asercjonuje promptu (jedyne wystąpienie słowa „prompt" w `e2e/*.spec.ts`
to komentarz w `agent-ui.spec.ts`, którego nie wolno uruchamiać). Uruchomiłem dodatkowo trzy spece, które
wywołują prawdziwe handlery `agent_view_create` / `agent_view_update` przez agenta skryptowanego, bo to one
zobaczyłyby rozjazd kształtu wyniku: `composed-views.spec.ts`, `interactions.spec.ts`, `show-value.spec.ts`.
**Nie uruchamiałem** `agent-ui.spec.ts`, `files-agent.spec.ts` ani `bl01-bl02-model.spec.ts` (tury
subskrypcji), zgodnie z briefem.

**Nieudanych przebiegów nie było.** `pnpm verify` i spece przeszły za pierwszym razem, po typecheck bez błędów.

---

## 6. Kontrakt dla autora modułu

1. **`unitField` na polu liczbowym to deklaracja o konsekwencjach.** Pole z `unitField` niesie jednostkę
   z rekordu (waluta oferty, jednostka miary pozycji). Wykres nad taką serią **odmówi narysowania**, jeśli
   rekordy w danym zestawie mają różne jednostki (`buildChartModel` w `platform-ui/src/views/model.ts`) —
   i jest to zachowanie zamierzone: słupek w PLN obok słupka w EUR twierdziłby coś, czego dane nie mówią.
   Od tego zadania agent dostaje o tym ostrzeżenie `warnings[unit_from_record]` już przy zapisie kompozycji.
   Jeśli chcesz, żeby wykres nad polem rysował się zawsze, zadeklaruj **stałą** `unit` (jak
   `completenessPct: '%'`) albo udostępnij operację odczytu zawężoną do jednej jednostki.
2. **Zadeklaruj `values` w `filter.fields`, jeśli zbiór jest mały i znany.** Od tego zadania te wartości są
   w prompcie przy nazwie pola, a nie tylko w wyniku `ui_catalog` — to jest różnica między „model wpisuje
   `PL` od razu" a „model próbuje `Polska`, potem `Poland`, a użytkownik dwa razy widzi pusty widok". Pole
   bez `values` przyjmuje dowolną wartość i tak jest opisane. Powyżej 12 wartości prompt ucina listę
   dopiskiem, że pełna jest w `ui_catalog` — nadal deklaruj wszystkie.
3. **`agent_view_create` / `agent_view_update` nie mówią, co karta narysowała.** Wynik ma teraz
   `rendered: false` i `readBack`. Jeśli piszesz własne narzędzie zapisujące kompozycję, powiedz w jego
   wyniku to samo: przyjęcie kompozycji przez walidator jest zdaniem o schemacie, nie o obrazku.
4. **Walidator kompozycji sprawdza schemat, nie istnienie rekordu** (AD-3, kontrakt Taska 4). Identyfikator
   z palca przechodzi walidację; odmowa przychodzi przy odczycie i pokazuje się jako instancja `forbidden`
   z `error.code = not_found`. Nazwy narzędzi modułu, którymi rekord się **znajduje**, mają być w opisach
   tych narzędzi — model dostał teraz regułę, żeby ich użyć.

---

## 7. Self-review — ustalenia

- **Kolejność w prompcie.** Pierwsza wersja wstawiła akapit o identyfikatorach na końcu listy „Co wolno
  wpisac do kompozycji", za zdaniem o odrzucanych komponentach. Przeniosłem go pod linię o `source`, bo tam
  model czyta, co wpisać do źródła. Zmiana wyłącznie kolejnościowa, testy te same.
- **`unchanged: true` też dostaje `rendered: false`.** Wyłapane przy czytaniu wczesnego `return` w
  `agent_view_update`; bez tego jedna ścieżka sukcesu milczałaby.
- **`try/catch` wokół `findDataInstances`.** Zapisana kompozycja jest walidowana przy zapisie, ale ścieżka
  `unchanged` czyta kompozycję zapisaną **kiedyś** — moduł mógł się od tego czasu zmienić. Ostrzeżenie nie
  może zamienić udanego wywołania w błąd.
- **Asercja na wycinku sekcji, nie na całym prompcie.** Test „## Stan ekranu" sprawdza tekst między
  nagłówkami sekcji, więc przeniesienie reguły w inne miejsce promptu oblewa — a o to chodzi: reguła ma być
  tam, gdzie model czyta o odczycie ekranu.
- **Limit wartości w linii celu.** Schemat dopuszcza 40 wartości po 120 znaków. Bez ucięcia jedno pole mogłoby
  dołożyć ~4,8 kB do promptu każdego uruchomienia.
- **Kształt wyniku jest wstecznie zgodny.** Pola dopisane na końcu; `cardId` zostaje pierwszym kluczem
  (asercja echa w `e2e/agent-views.spec.ts`), a testy używają `toMatchObject` / `objectContaining`.
  Potwierdzone przebiegiem czterech speców.

---

## 8. Obawy

1. **F2 jest zamknięte w tym, co model może powiedzieć — nie w tym, co zobaczy.** Gdy użytkownik patrzy na
   inny ekran niż Widoki agenta, `ui_state` nie opisze karty agenta i model **nie ma jak** sprawdzić, czy
   wykres się narysował. Reguła każe wtedy powiedzieć, że widok powstał, i nie opisywać, co przedstawia —
   to usuwa nieprawdę, ale nie daje potwierdzenia. Gdyby koordynator chciał potwierdzenia, trzeba by osobnej
   zdolności (np. serwerowego „renderu próbnego" kompozycji albo raportowania stanu instancji przez kartę,
   która karty widoków agenta trzyma w tle) — to jest nowa funkcja i wykracza poza to zadanie.
2. **Ostrzeżenie `unit_from_record` jest z definicji nadmiarowe.** Zapala się dla każdej serii z `unitField`,
   także takiej, która narysuje się bez zarzutu (wszystkie rekordy w PLN). Taka jest cena niezależności od
   danych. Jeśli w praktyce okaże się szumem, naturalnym następnym krokiem jest nie zaostrzenie go, tylko
   danie modelowi sposobu na odczytanie wyniku rysowania (obawa 1).
3. **Skuteczności tych reguł nie dowodzi żaden test w tym zadaniu.** Dowiedzione jest, że reguły są
   w prompcie i że wyniki niosą właściwe pola. Czy model po nich przestanie wstawiać kody spraw jako
   identyfikatory i przestanie obiecywać nienarysowane wykresy — rozstrzygnie dopiero ponowny przebieg T27
   z prawdziwym modelem (Task 8). Sugeruję, żeby powtórka wariantu A (`„…ze sprawy PC-2026-01…"`) była
   pierwszą turą: to jest dokładnie ten scenariusz, który dwa razy pod rząd zawiódł.
4. **Kroki 3–5 kryterium T27 nadal nie są sprawdzone z prawdziwym modelem** — to stan odziedziczony po
   Tasku 8 (budżet 12 tur zatrzymał się na 11), nie skutek tego zadania. Deterministycznie te kroki są
   dowiedzione w `e2e/agent-views.spec.ts` i `e2e/interactions.spec.ts`.
