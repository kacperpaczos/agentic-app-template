# REUSE-MATRIX — reuse istniejących dowodów modelowych

Powstała 2026-09-20 (ETAP 4 programu domknięcia, patrz `docs/RAPORT-STARTU-DOMKNIECIA.md`).
Cel: nie powtarzać prób modelowych, których dowód jest aktualny, kompletny i przypięty do
kodu, na którym twierdzenie opiera się.

Repo `integracja`, HEAD `763dd31`. Metoda: odczyt `POCHODZENIE.json`, treści plików dowodowych,
`git merge-base --is-ancestor` i `git diff --stat <commit>..HEAD -- <powierzchnia twierdzenia>`.
„Zmienione pliki" = pliki istotne dla twierdzenia dowodu, zmienione między commitem próby a HEAD
(komity BL-04 r4–6: `678fd4e`, `7431383`, `cd808bd`, `b25e3f0`, `b4fb7d8`, `95f7c30`, `70cd792`;
BL-12: `4cc174b`). Zakres: z11-bl03, z10-bl09, z12-bl04 — 26 zapisów JSON. Wszystkie 19 commitów
dowodowych (kod próby i commitDodania) jest przodkami HEAD. Wszystkie 26 JSON-ów parsuje się
poprawnie po redakcji higienicznej (HIGIENA-REDAKCJA.md — hash nie złamany).

Legenda werdyktów: REUSE = aktualny, nie powtarzać; DELTA = aktualny częściowo (podano co);
REPEAT = nieaktualny, wymaga powtórzenia na HEAD.

## z11-bl03 — przebiegi z prawdziwym modelem (grant BL-03: 21/25 tur wydanych)

| dowód | kryteria/próba | commit | przodek HEAD? | zmienione pliki | prawdziwy model? | kompletność | werdykt | oszczędne tury |
|---|---|---|---|---|---|---|---|---|
| runs/…00-26-37-453Z/e-relacje.json | L9.4, przebieg E, tura 1 | `49fe1b22` | TAK | brak na domenie (module-procurement, canvas nietknięte); spec zmieniony | TAK (zrodlo) | brak: srodowisko, brudneDrzewo, port (POCHODZENIE 9b0d4842) | REUSE (negatyw; rejestr próby) | 1 |
| runs/…00-29-50-327Z/e-relacje.json | L9.4, tura 2, z danymi narzędzia | `9b0d4842` | TAK | j.w. | TAK | j.w. (POCHODZENIE 1b34e75f) | REUSE (negatyw) | 1 |
| runs/…00-33-31-539Z/a-kanwa-rekord-nawigacja.json | L3.2, L3.10, L3.13, L6.6, L2.13; A, tury 3–6 | `a481893b` | TAK | services/canvas.ts nie; tools/ui.ts: tylko własny `cffb2f7` | TAK | brak: srodowisko, brudneDrzewo (POCHODZENIE cffb2f7) | REUSE (negatyw) | 4 |
| runs/…00-39-44-229Z/b-granice-izolacji.json | L11.3/11.4/11.5/11.11/11.9/9.16; B, tura 7 | `902ffce7` | TAK | real-path.ts (+212, przebudowa), permissions.ts, runtime.ts | TAK | brak: srodowisko, brudneDrzewo | REPEAT (kod izolacji przebudowany po próbie) | 0 |
| runs/…00-42-36-200Z/b-granice-izolacji.json | j.w., tura 8 (Odmowa→Zgoda) | `47758659` | TAK | j.w. | TAK | j.w. (POCHODZENIE d8d7040e) | REPEAT | 0 |
| runs/…00-53-58-916Z/d-szkic-a-dane.json | L6.5; C/D, run wydał 3 tury | `9a6846a5` | TAK | brak (canvas, events, runs nietknięte) | TAK | brak: srodowisko, brudneDrzewo (POCHODZENIE 0495f2e9) | REUSE (negatyw) | 3 |
| runs/…00-53-58-916Z/d-wznowienie-sesji.json | L8.5 (+obserwacja L7.13); wynik ZALICZONA | `9a6846a5` | TAK | runtime.ts (okablowanie uprawnień BL-04); events.ts/runs.ts nie | TAK | brak: srodowisko, brudneDrzewo | DELTA (rdzeń sesji stabilny; runtime dotknięty) | (2) |
| runs/…00-57-37-949Z/c-blad-narzedzia.json | L5.8, L7.3; ZALICZONA | `0495f2e9` | TAK | brak na ścieżce błędu (mcp.ts, toolkit.ts, canvas.ts — zero zmian) | TAK | brak: srodowisko, brudneDrzewo | REUSE | 1 |
| runs/…00-57-37-949Z/c-stop.json | L7.3, L1.6; niezaliczona | `0495f2e9` | TAK | runtime.ts (BL-04); events/runs nie | TAK | j.w. | REUSE (negatyw; nadpisany przez c-stop 11-16 ZALICZONA) | 2 |
| runs/…01-06-49-066Z/a-ustawienie-i-przestrzen.json | L2.13; ZALICZONA | `1b9a1809` | TAK | brak (tools/ui.ts i canvas.ts nietknięte od próby) | TAK | brak: srodowisko, brudneDrzewo (POCHODZENIE 237b17f5) | REUSE | 1 |
| runs/…01-07-31-714Z/c-sygnal.json | L1.6; niezaliczona | `1b9a1809` | TAK | runtime.ts; events/runs nie | TAK | j.w. | REUSE (negatyw; nadpisany przez c-sygnal 11-19 ZALICZONA) | 1 |
| runs/…11-09-53-315Z/b-granice-izolacji.json | L11.x; B, tury 16–17; kanarek w odpowiedzi (wyciek udokumentowany) | `d6462427` | TAK | real-path.ts (+163), permissions.ts, runtime.ts — rundy BL-04 4–6 (21 ucieczek) | TAK | pełna koperta; brak: port, nazwa modelu (model=null) | REPEAT (to jest próba odbiorcza naprawy — kod już inny) | 0 |
| runs/…11-14-21-733Z/b3-siec-i-zapis.json | L11.3 (sieć, zapis), L11.4, L9.16; tura 18 | `83caf5ef` | TAK | j.w. (walker, sandbox) | TAK | pełna koperta; brak: port, nazwa modelu | REPEAT | 0 |
| runs/…11-16-41-405Z/c-stop.json | L7.3, L1.6; ZALICZONA, tura 19 | `83caf5ef` | TAK | runtime.ts (70cd792 — zgoda/ścieżka); events, runs, http: zero zmian | TAK | pełna koperta; brak: port, nazwa modelu | DELTA | (1) |
| runs/…11-19-18-655Z/c-sygnal.json | L1.6; ZALICZONA, tura 20 (ostatnia udana) | `a071b60a` | TAK | j.w. | TAK | pełna koperta; brak: port, nazwa modelu | DELTA | (1) |
| runs/…2026-09-20…/t14-cztery-proby.json | L11.4, L11.5, ramię L11.11; T14, tura 21 — model NIE wystartował (blokada organizacji) | `5c1dcb9f` | TAK | permissions.ts (70cd792), runtime.ts (4 linie), sam spec t14 | NIE (zero wywołań — blokada subskrypcji) | pełna koperta + diagnoza-blokady-org.md; brak: port | REPEAT (1 polecenie po przywróceniu subskrypcji) | 0 |

## z10-bl09 — zero tur (GUI bez modelu / scenariusz na granicy adaptera)

| dowód | kryteria/próba | commit | przodek HEAD? | zmienione pliki | prawdziwy model? | kompletność | werdykt | oszczędne tury |
|---|---|---|---|---|---|---|---|---|
| dowod-l97-idempotencja-narzedzi.json | L9.7 (platforma, nie model); 0 tur | `6a59a74e` | TAK | **diff pusty** na całej powierzchni (idempotent-tools, bl09-scenarios, canvas, tools) | NIE (jawnie: model zastąpiony scenariuszem; jeśli, czego dowód nie pokazuje, nazwane) | pełna koperta; brudneDrzewo=false | REUSE | 0 |
| pomiary-stop-procesy.json | L11.7 (pomiar procesów); 0 tur | `c1c9d7c9` | TAK | 12 plików (canvas 74, ui 45), stop-children.spec.ts (`93eca50`) | NIE (proces prawdziwy, ale nie SDK — nazwane) | pełna koperta (POCHODZENIE 5d60c6ef) | DELTA (pomiar ms maszynowy; L11.7 dalej otwarte) | 0 |

## z12-bl04 — zero tur (sondy SDK / GUI / zastępniki)

| dowód | kryteria/próba | commit | przodek HEAD? | zmienione pliki | prawdziwy model? | kompletność | werdykt | oszczędne tury |
|---|---|---|---|---|---|---|---|---|
| proba-generalna-refresh-refused.json | próba generalna (zastępnik, NIE dowód) | `97e6adf8` | TAK | probe-refresh-refused.ts (4cc174b — dopisanie pól CLI) | NIE (bez SDK, bez sieci, 0 tur) | brudneDrzewo=true (jawne) | REUSE (rola: generalna) | 0 |
| proba-generalna-revoked.json | j.w. | `97e6adf8` | TAK | j.w. | NIE | j.w. | REUSE (rola: generalna) | 0 |
| refresh-refused-…23-52-30-592Z.json | faza 2: rzeczywisty SDK, komunikat + klasyfikacja; 0 tur | `8c782808` | TAK | agent/auth.ts (`cd808bd` — prób H: jawny warunek frazy) | Rzeczywisty SDK, nie model (0 tur) | brudneDrzewo=true; klasyfikator utwardzony PO przebiegu | DELTA (nadpisana parą z 09-16) | 0 |
| revoked-…23-52-33-521Z.json | j.w. | `8c782808` | TAK | j.w. | j.w. | j.w. | DELTA (j.w.) | 0 |
| refresh-refused-…09-16-09-172Z.json | powtórka fazy 2 na aktualnym klasyfikatorze; 0 tur | `b824f4aa` | TAK | auth.ts **nie** (cd808bd jest przodkiem); probe: tylko dopisane pola CLI | Rzeczywisty SDK, nie model | brudneDrzewo=true; pola CLI dopisane deklaratywnie (BL-12) | REUSE | 0 |
| revoked-…09-16-26-938Z.json | j.w. | `b824f4aa` | TAK | j.w. | j.w. | j.w. | REUSE | 0 |
| sesja-sdk.json | ścieżka subskrypcji (accountInfo); 0 tur | `664c23b0` | TAK | agent/auth.ts (cd808bd), probe-sdk-session.ts (utworzony dopiero w BL-12) | Rzeczywiste wywołanie SDK, nie model | brak: brudneDrzewo; pola CLI dopisane 2026-09-19 (zadeklarowane w pliku) | DELTA (sonda tania, ale wymaga działającego logowania — G21 + blokada org) | 0 |
| skan-sekretow.json | L8.14 (kanarek w 12 powierzchniach); 0 tur | `7d1c18d4` | TAK | auth-limits.spec.ts, e2e/credential-guard.ts (doszła runda 7) | NIE (GUI + skan) | pełna koperta, brudneDrzewo=false | DELTA (powierzchnia urosła; powtórka 0 tur) | 0 |

## Podsumowanie liczbowe

- **REUSE: 13 dowodów** (8 z BL-03, 1 z BL-09, 4 z BL-04) — **14 tur plikowo** (12 tury unikalnych
  po odjęciu nakładania wspólnego przebiegu 00-53; rejestr grantu BL-03: 21/25 wydanych).
- **DELTA: 8 dowodów** (3 BL-03 — 4 tury częściowo; 1 BL-09; 4 BL-04) — rdzeń twierdzeń stabilny,
  dotknięty wyłącznie runtime.ts okablowania uprawnień albo narzędzia sondujące.
- **REPEAT: 5 dowodów** (wyłącznie BL-03: izolacja plikowa L11.4/L11.5/ramię L11.11 i T14) —
  6 tur historycznie; powtórka po przywróceniu subskrypcji to ~5–6 tur (przebieg B 2–3 + T14 1,
  zapas na niezaliczenia).
- **Łączna oszczędność dzięki REUSE: 14 tur modelu** (całość w grantzie BL-03; z10 i z12 kosztowały
  0 tur — ich reuse oszczędza przebiegi e2e/sond, nie tury subskrypcji).

## Wnioski systemowe dla przyszłych prób

1. **Niekompletność kopert ma strukturę czasową**: przebiegi poranne (15 tur, 00:26–01:08) nie
   zapisywały środowisko ani `brudneDrzewo` (łatane rejestrem POCHODZENIE), popołudniowe mają już
   pełną kopertę — ale **nazwa modelu (`model: null`) nie została zapisana nigdy**. Wymóg przyszłych
   prób: koperta musi zawierać model; istniejących dowodów nie da się uzupełnić bez zmyślenia.
2. **REPEAT pokrywa się z dryfem kodu**: wszystkie 5 dowodów do powtórzenia leży dokładnie w obszarze
   przebudowanym po próbach (BL-04 r4–6: `real-path.ts`, `permissions.ts`, 21 załatanych ucieczek) —
   izolacja plikowa L11.4/L11.5/ramię L11.11 i T14. Reszta powierzchni domenowej ma zero zmian od
   swoich prób.
3. Redakcja higieniczna (`HIGIENA-REDAKCJA.md`) nie złamała żadnego z 26 zapisów JSON (parsowane
   po redakcji); tura 21 (T14) jest uczciwym dowodem blokady organizacji, nie próbą kryteriów.
