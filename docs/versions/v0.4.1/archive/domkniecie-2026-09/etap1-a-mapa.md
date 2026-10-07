# Mapa zależności bramek macierzy (ETAP 1 / Subagent A)

Repo: worktree integracja, HEAD 763dd31. Ścieżki względne roota repo.
Odfiltrowane: node_modules/, .git/, dist/, docs/evidence/playwright-report/, .e2e-*. Zapisana przez orkiestratora z raportu subagenta (agent był read-only).

## 1. Źródła macierzy

**Bieżąca (200):** spec `docs/ARCHITECTURE.md` (kryteria `- [ ] **Lx.y**` w warstwach `### 1.`–`### 12.`, L210–603; próby T01–T27 L576–602; ostrzeżenie o 95: L6, L21) + oceny `docs/acceptance/assessment.json` (200 criteria, 27 scenarios, 6 pakietów; 187/11/2; 95 pól `historical`). Generowane: `docs/ACCEPTANCE.md`, `docs/BACKLOG.md` przez `scripts/acceptance-matrix.mjs` (SPEC/DATA/OUT_* L20–23).

**Historyczna (95):** spec `docs/archive/agenticapp-2026-09/stack-agentowy-ustalenia-i-materialy-95-kryteriow.md` (czytana przez closure-matrix.mjs:135 i audit-matrix.mjs:135) + statusy z tabel archiwalnego `docs/archive/agenticapp-2026-09/FEEDBACK.md` (95 wierszy, ręczne „Razem 95” L1606). Render closure wklejony ręcznie do archiwalnych RAPORT-DOMKNIECIA-PLATFORMY.md §3 (L1521, L1535) i RAPORT-STANU-PLATFORMY.md (L328, L530) — statyczne, nikt ich nie regeneruje.

## 2. Skrypty

| Skrypt | Czyta | Pisze | Rozjazd |
|---|---|---|---|
| `acceptance-matrix.mjs` | ARCHITECTURE.md, assessment.json | ACCEPTANCE.md + BACKLOG.md; --check porównanie bajtowe (L317–327) | exit 1 przy problemach/dryfie (L330); `EXPECTED={12,200,27}` L25; duplikaty L69–72; potwierdzone wymaga origin=szablon L108–111; otwarte: gap+backlog L112–119; istnienie plików dowodowych L160–162 |
| `matrix-summary.mjs` | WYŁĄCZNIE archiwalny FEEDBACK.md (L19–20) | stdout | exit 2: zero wierszy (L31–34); exit 1: „Razem”≠liczone (L85–89), per-status (L91–99), duplikaty (L101). Brak stałej 95; nie czyta spec-95; nic nie wiąże z 200 |
| `closure-matrix.mjs` | spec-95 (L135) + oceny zaszyte w obiekcie `A` (L18, 43–96, 98–129) | tylko stdout | exit 1 przy problemach (L213), ALE komunikat tylko w stdout (L204), a package.json:45 robi `--summary > /dev/null` → **cichy fail bez komunikatu** |
| `audit-matrix.mjs` | jw. | stdout | jw.; **NIEPODPIĘTY do npm — martwa duplikat-kopia `A`** (diff vs closure = tylko nagłówek; 213 linii oba) |
| `closure-evidence.sh` | — | uruchamia closure --summary → docs/evidence/closure-2026-09-15/05-matrix.txt (L33) | zwraca zawsze 0 (L23) — diagnostyka, nie bramka |
| `detection-trials.mjs` | rejestr detection-trials.json | evidence z13 | brak prób dotykających skryptów macierzowych |

## 3–4. Liczby 95/200 — pełne listy plików

95 (archiwum): archiwalny FEEDBACK.md (L4, 581, 587, 696, 748, 1597, 1606), RAPORT-DOMKNIECIA-PLATFORMY.md (L4, 23, 68, 1521, 1535), RAPORT-STANU-PLATFORMY.md (L4, 28, 328, 530), README-agenticapp.md (L4, 108–109), spec-95 (nazwa pliku), docs/archive/README.md L10.
95 (bieżące): ARCHITECTURE.md L6/L21; ACCEPTANCE.md etykiety „spoza 95” (L364–365); DOCUMENTATION-MAP.md L28/L30; CONSOLIDATION-REPORT.md L47/63/79/84/228–229; CONSOLIDATION-UPDATE-2026-09-17.md L96; RAPORT-STARTU-DOMKNIECIA.md L23/90–91; FEEDBACK.md (root) L40–41/49/115–126; acceptance-matrix.mjs L215/L274; matrix-summary.mjs L6/L18; closure-matrix.mjs L5/133–135; audit-matrix.mjs jw.; assessment.json (95 pól historical); evidence z10-bl09 L262.
200: ARCHITECTURE.md L3/L21/L631; acceptance-matrix.mjs L5/L25; ACCEPTANCE.md L8/L12/L364; BACKLOG.md L6; AGENTS.md L14/L20/L99; CONSOLIDATION-REPORT.md L6–7/20/47/78; CONSOLIDATION-UPDATE L19/202; DOCUMENTATION-MAP.md L27/30/62; FEEDBACK.md L8–9/29/115; RAPORT-STARTU L22/27–28/34/90–91; RAPORT-DOMKNIECIA-PLATFORMY.md L15–17/20/79; assessment.json L5/L2341; plans/2026-09-18 L181; closure/audit L134.
Fałszywe trafienia odfiltrowane: HTTP 200, p95, hash 0495f2e9, total:95 w tests/views-foundation.test.ts:526.

## 5. Ręczne wpisywanie statusów (wzorce do wyeliminowania)

1. `assessment.json` — kanon ocen 200 (+ 95 pól `historical` = ręcznie przepisana 3. kopia ocen historycznych, bez żadnej kontroli spójności z archiwum).
2. `closure-matrix.mjs` obiekt `A` — 95 ocen zaszytych w kodzie.
3. `audit-matrix.mjs` — druga kopia `A`, martwa.
4. Archiwalny FEEDBACK.md — tabele + ręczne podsumowanie (strzeżone przez check:matrix).
5. Statyczne wklejki renderu w archiwalnych raportach §3.
6. (NIE ręczne: ACCEPTANCE.md/BACKLOG.md — generowane, dryf wykrywany.)

## 6–7. Zależności i wywołania

verify (package.json L41): `check:boundaries && check:acceptance && check:matrix && check:closure && typecheck && build && test` — cztery bramki w łańcuchu, zero więzi 95↔200. Definicje: L35 check:acceptance, L39 acceptance:render, L44 check:matrix, L45 check:closure. Dokumenty: AGENTS.md L24/73/99/172–173; README.md L271/299; closure-evidence.sh L33; archiwalny README-agenticapp.md L108–109. Brak CI/hooków (brak .github/, .husky/ itd.) — bramki tylko lokalnie. `audit-matrix.mjs` — nikt nie wywołuje.

## 8. Testy skryptów macierzowych

Brak testów logiki wszystkich czterech skryptów. Jedyny punkt styczny: `tests/acceptance-target.test.ts` — klasyfikacja każdego pliku scripts/: acceptance L337, audit L338, closure L367, matrix-summary L391; reguła L303–329, test L420–426; **wpis wskazujący nieistniejący plik = błąd → usunięcie audit-matrix wymaga aktualizacji klasyfikacji**. Kontrole negatywne macierzy tylko jako artefakt ręczny: docs/evidence/template-consolidation/kontrole-negatywne-macierzy.txt.

## 9. Czego check:matrix NIE wykrywa

(a) brak stałej oczekiwanej liczby — zniknięcie 5 wierszy z FEEDBACK.md + korekta „Razem” na 90 przejdzie; (b) nie porównuje treści wierszy ze spec-95; (c) **nic w repo nie porównuje 95 z 200** — acceptance-matrix tylko wyświetla rozkład historical (L131–132, 214–216, 274), bez asercji liczby/treści; closure kontroluje tylko A↔spec-95, też bez stałej; (d) check:closure failuje po cichu (stdout→/dev/null).

## Pliki do dotknięcia przez patch B

1. scripts/acceptance-matrix.mjs — kanon; ew. wydzielić wspólny moduł parsowania
2. scripts/closure-matrix.mjs — oceny `A` do pliku danych; stała 95; problemy na stderr
3. scripts/audit-matrix.mjs — usunąć (duplikat)
4. scripts/matrix-summary.mjs — przepiąć na kanon + stała + porównanie z 200-światem
5. package.json — verify L41, check:matrix L44, check:closure L45
6. tests/acceptance-target.test.ts — klasyfikacja L336–403 po zmianie zbioru skryptów; miejsce na testy regresyjne bramek
7. docs/acceptance/assessment.json — pola historical jako źródło cross-checku 95
8. AGENTS.md L24/99/172–173; docs/archive/README.md L10; docs/DOCUMENTATION-MAP.md L28/30/62
9. scripts/closure-evidence.sh L33
10. FEEDBACK.md — wpis dziennika po pakiecie
