# Raport: ETAP 1 / Subagent B — patch bramki macierzy (FINALNY)

Worktree: `lokalny katalog worktree szablonu/z14-bramka`, gałąź `domkniecie/z14-bramka`,
start `763dd31`, koniec `172185c` (5 commitów). Nic niewypchnięte. Repo główne (integracja) nietknięte.

## 1. Co zmienione i dlaczego

Cel briefu: jedna kanoniczna macierz; `check:acceptance` i `check:matrix` czytają to samo źródło;
rozjazd liczby kryteriów kończy się błędem; liczby nie są wpisywane ręcznie; raporty są generowane.

| Plik | Zmiana | Dlaczego |
|---|---|---|
| `scripts/lib/matrix-core.mjs` (NOWY) | Wspólny rdzeń: `parseSpecification`, `parseAssessment`, `evaluateMatrix`, `parseArchiveSpecification`, `crossCheckArchive`, `parseAcceptanceSummary`/`compareAcceptanceSummary`, `parseBacklogSummary`/`compareBacklogSummary`, stałe `EXPECTED = {12, 200, 27}` i `EXPECTED_ARCHIVE = {12, 95}`, zbiory `STATUS`/`OPEN`/`EVIDENCE`/`ORIGIN` | dotychczas każda bramka miała własną arytmetykę; to jest mechanizm, który pozwalał na zielone 200 i zielone 95 obok siebie bez więzi |
| `scripts/acceptance-matrix.mjs` | przepięty na rdzeń; render bez zmian | `check:acceptance` przechodzi **bez regeneracji** — `docs/ACCEPTANCE.md` i `docs/BACKLOG.md` identyczne bajt w bajt (potwierdzone diffem wyjścia i zielonym `--check`) |
| `scripts/matrix-summary.mjs` | przepisany: liczy podsumowanie z kanonu przez rdzeń; asertuje `EXPECTED`; kros-kontrola 95↔200; porównuje liczby z WYGENEROWANYM `docs/ACCEPTANCE.md` (sekcja „Podsumowanie (wyliczone)”) i `docs/BACKLOG.md` (nagłówek + pakiety); nazwa polecenia `check:matrix` bez zmian | to sedno pakietu: zniknięcie kryterium z kanonu, rozjazd stałych, dryf raportu pochodnego albo naruszenie więzi 95↔200 = kod 1 z czytelnym powodem |
| `scripts/closure-matrix.mjs` | kontrola archiwum, jawnie nazwana: obiekt `A` (95 ocen) przeniesiony VERBATIM do `docs/archive/agenticapp-2026-09/oceny-95.json`; skrypt czyta z pliku; twarda stała `EXPECTED_ARCHIVE`; **problemy na STDERR**; nagłówek mówi wprost „KONTROLA ARCHIWUM HISTORYCZNEGO 95 — nie macierz bieżąca”; do tej pory `check:closure` failował po cichu (`stdout → /dev/null`) | translokacja, nie edycja ocen: równość z oryginałem potwierdzona programowo (95/95 wierszy, JSON identyczny) |
| `docs/archive/agenticapp-2026-09/oceny-95.json` (NOWY) | `{opis, oceny}`; `oceny` = dawny obiekt `A` 1:1 | oceny historyczne jako dane, nie kod |
| `scripts/audit-matrix.mjs` | USUNIĘTY | martwy duplikat `A`, nikt go nie wywoływał (potwierdzone grepem: tylko raporty historyczne i klasyfikacja testowa) |
| `tests/acceptance-target.test.ts` | klasyfikacja: usunięty wpis `audit-matrix.mjs`, dodany `lib/matrix-core.mjs` | reguła wymaga kompletności w OBIE strony: niesklasyfikowany skrypt oblewa **i** wpis wskazujący nieistniejący plik oblewa (L303–329, 325–327) |
| `tests/matrix-gates.test.ts` (NOWY) | 5 kontroli negatywnych na rdzeniu z fixture'ami stringowymi + 3 smoke na bramkach repo | AGENTS: kontrola negatywna jest dowodem; testy asertywne — każda asercja mówi ZA CO oblewa; zero mutacji plików repo w testach |
| `AGENTS.md`, `README.md`, `docs/archive/README.md`, `docs/DOCUMENTATION-MAP.md` (nowa sekcja 7) | role bramek opisane wprost: kanon 200 (`check:acceptance` + `check:matrix`), archiwum 95 (`check:closure`); wzmianka o `audit-matrix` usunięta z mapy dokumentacji; opis verify bez ogólnika | dokumentacja nie może uczyć starego rozjazdu |
| `FEEDBACK.md` | wpis **T8** (najwyższy poprzedni: T7) z decyzjami, kontrolami negatywnymi i otwartymi sprawami | obowiązkowy dziennik |
| `package.json` | **bez zmian** | `verify` już składał wszystkie trzy bramki; `check:closure > /dev/null` jest teraz bezpieczne, bo problemy idą na STDERR |

## 2. Decyzje zapasowe (w granicach briefu)

1. **Brak mapowania statusów archiwalnych (pkt 4 briefu — ścieżka „niejednoznaczny”).** Pola
   `historical` w `assessment.json` to werdykt PO domknięciu AgenticApp: wszystkie 95 ×
   „potwierdzone”. Tabele archiwalnego `FEEDBACK.md` to wcześniejszy snapshot z innym słownikiem
   (ZAL-R 50, ZAL-T 33, CZĘŚĆ 10, KOD 2). Mapowanie CZĘŚĆ↔częściowe byłoby tu fałszywe (te same
   kryteria mają „potwierdzone” w `historical`), więc kros-kontrola wiąże **tylko liczbę (dokładnie
   95) i zbiór identyfikatorów — w obie strony** (`crossCheckArchive`). Decyzja odnotowana w
   komentarzu `crossCheckArchive`, w nagłówku `matrix-summary.mjs`, w DOCUMENTATION-MAP §7 i w T8.
2. **Kontrola archiwalnego FEEDBACK.md wygasa.** Była jedynym zajęciem starego `check:matrix`;
   po przepięciu nikt nie pilnuje tabel w archiwalnym dzienniku. Zgodnie z decyzją briefu
   („kontrola archiwum zostaje w `check:closure`”) plik jest zarchiwizowany i zamrożony; stan
   udokumentowany w `docs/archive/README.md`.
3. **`check:matrix` nie sprawdza istnienia plików dowodowych** (flaga `evidenceRoot` rdzenia):
   zostaje w `check:acceptance`, jedna odpowiedzialność w jednym miejscu, bez dublowania komunikatów
   w `verify`. Coherence-checks ocen i prób rdzeń liczy w pełni (wspólna arytmetyka).
4. **Porównanie z raportem pochodnym po liczbach sparsowanych, nie po surowym tekście** — dopuszczone
   wprost przez brief; w praktyce pokrywa także per-warstwy (liczba kryteriów, otwarte, ID) i
   rozkłady dowodu/pochodzenia/historyczne, więc jest równie twarde jak porównanie bajtowe
   (smoke + N3 potwierdzają wykrywalność dryfu).
5. **Symetria kros-kontrolki**: poza wymaganiem briefu („dokładnie 95 pól, każdy ID istnieje w
   specyfikacji archiwalnej”) dodałem kierunek odwrotny (każde kryterium archiwalne ma swoje pole
   `historical`). Obecnie prawdziwe w obie strony; zniknięcie pola = błąd, co jest celem kontroli.
6. **`closure-matrix.mjs`: sumy liczone, nie wpisywane.** Napis „(7+6+7+8+8+7+7+8+9+10+10+8)”
   wyliczany z parsowanych warstw; dorzucone problemy o nieznanym statusie/rodzaju dowodu
   archiwalnym (wcześniej render wypisywał `undefined`). Wyjście `--summary` i pełny render
   identyczne bajt w bajt z baseline (diff pusty), więc zapisany dowód
   `docs/evidence/closure-2026-09-15/05-matrix.txt` pozostaje odtwarzalny.

## 3. Wyniki

### Baseline przed zmianami (763dd31, wszystkie zielone)

- `pnpm check:acceptance` → `kryteria: 200, warstwy: 12, próby: 27; potwierdzone=187, częściowe=11,
  niespełnione=2, niesprawdzone=0; warstwy zamknięte 5/12; pakiety backlogu 6; spójność: OK` (exit 0).
- `pnpm check:matrix` (stary) → 95 wierszy z archiwalnego FEEDBACK.md, `Podsumowanie macierzy
  zgodne z tabelami` (exit 0).
- `node scripts/closure-matrix.mjs --summary` → 95/95 potwierdzone, 12/12 warstw (exit 0).

### Po zmianach

- `pnpm verify` → **exit 0**: `check:boundaries`, `check:acceptance` (200/12/27, 187/11/2/0, bez
  dryfu — bez regeneracji), `check:matrix` (nowy: kanon + krosówka + raporty pochodne, `spójność:
  OK`), `check:closure` (archiwum 95, STDERR czysty), `typecheck` (3 konfiguracje), `build`,
  `test`: **69 plików / 1067 testów**, 0 niezdanych.
- Nowe testy: `npx vitest run tests/matrix-gates.test.ts` → **8/8** (5 kontroli negatywnych + 3
  smoke). `tests/acceptance-target.test.ts` → **14/14** po aktualizacji klasyfikacji.
- `git status` po verify czysty (verify niczego nie przepisuje).

### Kontrole negatywne (kopie w katalogach tymczasowych, zero mutacji repo)

| Przypadek | Stara bramka (763dd31) | Nowa bramka |
|---|---|---|
| usunięte kryterium L12.10 z `ARCHITECTURE.md` | (n/d — stara nie czyta spec) | kod 1: 21 problemów (pozycje, `199 kryteriów zamiast 200`, osierocona ocena, pusty pakiet, dryf ACCEPTANCE i BACKLOG) |
| zmiana statusu oceny bez regeneracji | kod 0 (nie czyta ocen) | kod 1 (rozkład statusów + dryf) |
| zmyślona liczba w podręcznym raporcie pochodnym (`187→180`) | **kod 0** — `Podsumowanie macierzy zgodne z tabelami` | kod 1: `raport mówi 180, a oceny dają 187` |
| usunięte pole `historical` (94 zamiast 95) | kod 0 | kod 1: `94 pól "historical" zamiast 95`, `L1.1 nie ma pola "historical"` + dryf tabeli historycznej |
| brak oceny kryterium w archiwum 95 (`oceny-95.json`) | kod 0 (oceny w kodzie, nie do ruszenia) | kod 1, komunikat widoczny na STDERR mimo `--summary > /dev/null` |
| usunięte kryterium ze specyfikacji archiwalnej | kod 0 (brak stałej) | kod 1: `94 kryteriów zamiast 95` + `archiwum: 94 ocenionych kryteriów zamiast 95` |

Kluczowe przed/po: na tym samym zmanipulowanym stanie (kanon + raport pochodny) stary
`check:matrix` z 763dd31 kończy się **0** z komunikatem „zgodne”, nowy — **1** z pięcioma
konkretnymi powodami.

## 4. Commity (gałąź `domkniecie/z14-bramka`, od `763dd31`)

1. `95eb85f` — Bramki: wspolny rdzen macierzy (scripts/lib/matrix-core.mjs), acceptance-matrix liczy z rdzenia
2. `cb2c95c` — Archiwum 95: oceny z kodu do pliku danych, twarda stala EXPECTED, problemy na STDERR
3. `033e96e` — Bramki: check:matrix liczy z kanonu 200, kros-kontrola archiwum 95, dryf raportow = blad
4. `e806888` — Testy: regresja bramek macierzowych; usuniety martwy audit-matrix.mjs
5. `172185c` — Dokumentacja: role bramek macierzowych opisane wprost (kanon 200 vs archiwum 95)

Nic niewypchnięte na remote. `docs/acceptance/assessment.json`, `docs/evidence/**`, archiwum
(poza nowym `oceny-95.json` i README archiwum), lockfile i zależności — nietknięte. W commitach i
raporcie brak sekretów i prywatnych ścieżek.

## 5. Znalezione problemy (nie z tego pakietu, do rozliczenia przez właściciela)

1. **Podwójny numer T2 w `FEEDBACK.md`** (`T2 — 2026-09-17` i `T2 — 2026-09-18`). Numeracji
   historii nie zmieniam — dziennik jest zapisem przebiegu; zgłoszone w T8 i tu. Następny numer to T8
   (wykorzystany przez ten pakiet).
2. **Wklesłe renderowanie `undefined` w archiwalnej macierzy** przy nieznanym statusie/dowodzie
   (`closure-matrix` sprzed zmiany) — usunięte przez jawną walidację; na danych archiwalnych nie
   zmienia wyjścia.
3. **Duplikaty komunikatów przy rozjeździe**: nowy `check:matrix` wypisuje ROZJAZD raz w podsumowaniu
   (stdout) i raz na STDERR w trybie `--check` — świadome, bo `verify` pokazuje oba strumienie, a
   bramka ma być czytelna także wtedy, gdy ktoś czyta tylko stderr. Jeśli przeszkadza, do usunięcia
   jednym wierszem.
4. Statyczne wklejki renderu w archiwalnych `RAPORT-DOMKNIECIA-PLATFORMY.md` §3 i
   `RAPORT-STANU-PLATFORMY.md` pozostają statyczne (nikt ich nie regeneruje i nie pilnuje) — zgodnie
   z zakazem dotykania archiwum; zapisane w DOCUMENTATION-MAP §1–2 jako zapis historyczny.

## 6. Obawy

- Kros-kontrola 95↔200 jest teraz twarda w obie strony; jeśli właściciel kiedyś świadomie usunie
  pole `historical` z któregoś z 95 kryteriów (np. przy wymianie modułu), `check:matrix` obleje —
  wtedy trzeba będzie jawnie zmienić regułę, nie oszukać danych. To zamierzone, ale warto wiedzieć.
- `tests/matrix-gates.test.ts` smoke uruchamia `pnpm run check:closure` wewnątrz Vitest — wymaga
  pnpm na PATH (jak każdy przebieg regresji w tym repo).
