# Recenzja: ETAP 1 / Subagent C — pakiet bramki macierzy (z14-bramka)

Recenzent: niezależny (nie autor zmiany). Data: 2026-09-20.
Zakres: `763dd31..172185c`, gałąź `domkniecie/z14-bramka`, 5 commitów (95eb85f, cb2c95c, 033e96e, e806888, 172185c).
Metoda: lektura diffu i plików docelowych w worktree + **własne próby negatywne na kopiach w /tmp**
(`rsync` repo bez `node_modules`/`.git`; `node_modules` podlinkowany z worktree; repo i worktree nie mutowane).

## Werdykt

| Kryterium | Werdykt |
|---|---|
| Zgodność ze specem (brief implementatora + wymagania właściciela) | **✅** (pełny zakres, bez przekroczeń; 3 rozsądne rozszerzenia poza literą briefu, wszystkie ujawnione) |
| Jakość | **ZATWIERDZONY** |
| Findings | **Critical: 0, Important: 0, Minor: 5** |

## 1. Zgodność ze specem — punkta po punkcie

| Wymaganie | Stan | Dowód |
|---|---|---|
| Wspólny moduł `scripts/lib/matrix-core.mjs`, EXPECTED={12,200,27}, używają go acceptance-matrix i matrix-summary | ✅ | `matrix-core.mjs` L30; oba skrypty importują i nie mają własnej arytmetyki sum |
| Render ACCEPTANCE.md/BACKLOG.md bajt w bajt bez regeneracji | ✅ | na kopii: stary skrypt (763dd31) i nowy wygenerowały **identyczne bajty**, oba == plikom w commicie (`diff` pusty, ACCEPTANCE i BACKLOG) |
| `check:matrix` na kanonie + asercja EXPECTED + porównanie z wygenerowanym raportem | ✅ | `matrix-summary.mjs` L72–96; próba N1 i N5 |
| Oceny archiwalne `A` → `docs/archive/agenticapp-2026-09/oceny-95.json` VERBATIM; stała 95; problemy na STDERR; nagłówek „archiwum, nie macierz bieżąca” | ✅ | translokacja potwierdzona programowo (95/95 wpisów głęboko równych, kolejność kluczy identyczna — mocniejsze niż wymagane 10 próbek); `closure-matrix.mjs` L3–27, L129, L138 |
| Cross-check 95↔200 (95 pól `historical`, ID istnieją w spec-95) | ✅ + rozszerzenie | `crossCheckArchive` (matrix-core L306–323); dodany kierunek odwrotny (symetria) — poza literą briefu, ujawnione w raporcie B §2.5 |
| Status-mapping tylko przy jednoznaczności | ✅ decyzja „nie mapuję” | zweryfikowana na danych: `historical` = 95×„potwierdzone” (werdykt po domknięciu), tabele archiwalnego FEEDBACK = ZAL-R 50 / ZAL-T 33 / CZĘŚĆ 10 / KOD 2 (L588–591) — np. L1.1: „potwierdzone” vs „ZAL-R”; mapowanie robiłoby fałszywe alarmy |
| Usunięcie `audit-matrix.mjs` + klasyfikacja w `tests/acceptance-target.test.ts` | ✅ | plik usunięty; wpis usunięty, dodany `lib/matrix-core.mjs`; pozostałe wzmianki tylko w zapisach historycznych (FEEDBACK T1/T2, CONSOLIDATION-REPORT, log evidence) — słusznie nietknięte |
| package.json | ✅ bez zmian | `check:closure > /dev/null` bezpieczne, bo problemy idą na STDERR (potwierdzone próbą N4b) |
| Dokumentacja: AGENTS.md, docs/archive/README.md, DOCUMENTATION-MAP, nagłówek matrix-summary, FEEDBACK T8 | ✅ | T8 = poprawny następny numer (poprzedni najwyższy T7); README L271 zaktualizowane; nowa sekcja DOCUMENTATION-MAP §7 (nadzbiór wymagania) |
| Testy regresyjne bramek (5 negatywnych + smoke, asertywne komunikaty, zero mutacji repo) | ✅ | `tests/matrix-gates.test.ts` — 5 przypadków z briefu 1:1 + 3 smoke; wszystkie asercje na treść komunikatów; fixture'y stringowe |
| Zakazy: assessment.json / docs/evidence / lockfile / archiwum poza oceny-95.json+README / verify=0 | ✅ | diff stat: 13 plików, żadnego z zakazanych; `pnpm verify` = 0 (ponżej) |

Rozszerzenia poza briefem (wszystkie ujawnione w raporcie B, żadnego sprzeciwu):
porównanie dryfu także z `docs/BACKLOG.md`; symetryczny kierunek kros-kontrolki; jawna walidacja
nieznanego statusu/rodzaju dowodu w closure (usuwała render `undefined`); sekcja DOCUMENTATION-MAP §7.

## 2. Próby własne (kopie w /tmp/etap1c, komendy `node scripts/...` jak w package.json)

Próba „na zielono” (kopia niezmieniona): `pnpm run check:acceptance` → **0** (`kryteria: 200`),
`pnpm run check:matrix` → **0** (`kanon: kryteria 200`), `pnpm run check:closure` → **0**.
Ta sama liczba 200 w obu podsumowaniach.

| # | Mutacja na kopii | Komenda | Exit | Kluczowy fragment wyjścia |
|---|---|---|---|---|
| 1 | usunięte kryterium L12.10 z `docs/ARCHITECTURE.md` | `check:acceptance --check` / `check:matrix --check` | **1 / 1** | `199 kryteriów…`→`PROBLEMY (10): specyfikacja: L12.11 na pozycji L12.10…`; matrix: `ROZJAZD (23)` |
| 2 | legalna zmiana statusu L1.6 `czesciowe→niespelnione` (spójność ocen OK) bez regeneracji | jw. | **1 / 1** | acc: `DRYF: docs/ACCEPTANCE.md nie odpowiada ocenam…`; matrix: `status „częściowe”: raport mówi 11, a oceny dają 10` |
| 3 | powielony wiersz `- [ ] **L1.1**` w kanonie | jw. | **1 / 1** | `specyfikacja: duplikat L1.1`, `specyfikacja: L1.1 na pozycji L1.2` |
| 4a | usunięte pole `historical` z L1.1 | `check:matrix --check` | **1** | `oceny: 94 pól "historical" zamiast 95`, `kryterium archiwalne L1.1 nie ma pola "historical"` |
| 4b | usunięte kryterium (ostatnie L12) ze spec-95 | `check:closure --summary > /dev/null` / `check:matrix --check` | **1 / 1** | closure **na STDERR mimo /dev/null**: `specyfikacja archiwalna: 94 kryteriów zamiast 95`, `ocena L12.8 bez odpowiednika w dokumencie`; matrix: `pole "historical" wskazuje L12.8, którego nie ma w archiwalnej specyfikacji 95` |
| 5 | ręcznie wpisane `187→180` w „Podsumowanie (wyliczone)” `docs/ACCEPTANCE.md` | `check:matrix --check` / `check:acceptance --check` | **1 / 1** | matrix: `status „potwierdzone”: raport mówi 180, a oceny dają 187`; acc: `DRYF` (bajtowy) |

Dodatkowa weryfikacja tożsamości renderów (na kopii): stary `acceptance-matrix` (763dd31) vs nowy —
ACCEPTANCE.md i BACKLOG.md identyczne bajt w bajt i równe plikom z commitu; stary vs nowy
`closure-matrix` (pełny render i `--summary`) — identyczne bajt w bajt (dowód
`05-matrix.txt` jest odtwarzalny; sam plik leży w lokalnym AgenticApp, nie w tym repo — zgodnie
z docs/archive/README.md).

## 3. Findings

**Critical: 0.** **Important: 0.**

**Minor:**

1. `scripts/matrix-summary.mjs:106` — wiersz podsumowania ma **statyczny** człon „identyfikatory
   zgodne ze specyfikacją archiwalną”, drukowany także wtedy, gdy krosówka właśnie wykazała rozjazd
   (obserwowane w N4b: `95 pól "historical"… identyfikatory zgodne` + poniżej `ROZJAZD (2)` o L12.8).
   Kod wyjścia i lista problemów są jednoznaczne, ale czytelnik samego stdout może być wprowadzony
   w błąd. Naprawa: uzależnić sformułowanie od `problems.length` ( warunkowy „zgna/niezgodne —
   patrz ROZJAZD”).
2. `scripts/matrix-summary.mjs:108` i `122–124` — lista ROZJAZD drukowana dwukrotnie w `--check`
   (raz w bloku na stdout, raz na STDERR). Świadome (ujawnione w raporcie B §5.3); szum przy dłuższej
   liście. Naprawa jednym wierszem: pominąć problems w bloku stdout w trybie `--check`.
3. `scripts/closure-matrix.mjs:119–120` — **przed istnienia tej zmiany** zaszyte `z 12` w dwóch
   stringach renderu (baseline L198–199). Celowo zachowane dla identyczności bajtowej renderu, ale to
   jedyna ręcznie wpisana liczba poza stałymi. Naprawa: przy najbliższej zmianie, która i tak
   dotyka renderu archiwum, podstawić `EXPECTED_ARCHIVE.layers`.
4. `scripts/closure-matrix.mjs:42–44` — `LABEL` i `OPEN` zduplikowane lokalnie zamiast importu z
   rdzenia (`LABEL` ≡ wartości `STATUS`, `OPEN` identyczny zbiór; `DOWOD` słusznie osobny — słownik
   archiwalny różni się od kanonu). Ryzyko przyszłego dryfu słownika. Naprawa: import `STATUS`/`OPEN`
   z `matrix-core.mjs`.
5. `docs/archive/README.md` (wiersz agenticapp-2026-09) — opisuje nowy podział ról, ale **nie mówi
   wprost**, że wewnętrzna spójność tabel archiwalnego `FEEDBACK.md` nie jest już kontrolowana przez
   żadną bramkę. Jedno zdanie: „Spójność wewnętrzną archiwalnego FEEDBACK.md nie sprawdza już
   żadna bramka (dawniej: stary check:matrix); plik jest zamrożonym zapisem stanu z 2026-09-17”.

## 4. Odpowiedzi na pytania A–E

**A. Co strzeże dziś archiwum; czy utrata kontroli FEEDBACK.md to realne ryzyko — werdykt: akceptowalne.**
Archivum strzeżą dziś dwa mechanizmy: `check:closure` (spec-95 ↔ `oceny-95.json`: twarda stała 12/95,
pozycyjne ID, duplikaty, brakujące/nadmiarowe oceny, nieznane statusy/dowody — problemy na STDERR) oraz
kros-kontrolka w `check:matrix` (95 pól `historical` ↔ zbiór ID spec-95, w obie strony); natomiast
**wewnętrzna spójność tabel archiwalnego `FEEDBACK.md` nie ma dziś żadnego strażnika** — jej jedynym
strażnikiem był stary `check:matrix`. To akceptowalne: plik jest zamrożonym zapisem stanu z 2026-09-17,
żywe oceny 95 mają strzeżonego następcę (`oceny-95.json`), żaden generowany artefakt z niego nie korzysta,
a każda jego edycja jest widoczna w diffie i łamie politykę nietykania archiwum (Minor 5: warto to
napisać wprost w README archiwum).

**B. Translokacja VERBATIM: potwierdzona programowo, mocniej niż zlecone 10 próbek.** Wyekstrahowałem
obiekt `A` z `git show 763dd31:scripts/closure-matrix.mjs` (L18–129) i porównałem głęboko z
`oceny` z `docs/archive/agenticapp-2026-09/oceny-95.json`: 95/95 kluczy, **0 różnic treści**,
kolejność kluczy identyczna; próbki L1.1, L2.3, L3.6, L4.8, L6.1, L7.3, L8.5, L9.6, L10.6, L11.5 —
identyczne.

**C. Tak.** `tests/matrix-gates.test.ts` asertuje powody oblewania (treść komunikatów), nie sam kod
wyjścia, np. `toContain('specyfikacja: 2 kryteriów zamiast 3')`, `'ocena L1.2 bez kryterium w specyfikacji'`,
`'specyfikacja: duplikat L1.1'`, `'status „częściowe”: raport mówi 1, a oceny dają 0'`,
`'raport mówi 100 kryteriów, a oceny i specyfikacja dają 3'`, `'9 pakietów, a oceny dają 1'` — plus
kontrola pozytywna (spójny raport przechodzi, fixture czysty) i smoke asertujące treść stdout
(`kryteria: 200`, `spójność: OK`), nie tylko status procesu.

**D. Nie — żadnej nowej ręcznie wpisanej liczby kryteriów/statusów.** Cała arytmetyka idzie przez
stałe rdzenia (`EXPECTED`, `EXPECTED_ARCHIVE`); jedyne pozostałe zaszyte liczby to **przed istnienia**
kosmetyczne `z 12` w stringach renderu closure (L119–120, celowo zachowane dla identyczności bajtowej —
Minor 3).

**E. `pnpm verify` = 0 — potwierdzone własnym przebiegiem na worktree** (`/tmp/etap1c-verify.log`):
wszystkie bramki zielone, typecheck, build, `Test Files 69 passed (69)`, `Tests 1067 passed (1067)` —
zgadza się z twierdzeniem raportu B; `git status` po verify czysty (verify niczego nie przepisuje).
