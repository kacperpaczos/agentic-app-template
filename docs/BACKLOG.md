# Backlog rozwoju szablonu

> Plik generowany przez `node scripts/acceptance-matrix.mjs` z `docs/acceptance/assessment.json`.
> Każde otwarte kryterium macierzy (`docs/ACCEPTANCE.md`) należy do dokładnie jednego pakietu.

Otwartych kryteriów: **2** z 200, w 2 pakietach. Kolejność pakietów jest propozycją, nie harmonogramem. Kryteria „informacyjne / poza bramką odbioru” nie są w tej liczbie — nie blokują zamknięcia warstwy ani nie należą do backlogu.

| Pakiet | Tytuł | Kryteria | Liczba |
|---|---|---|---|
| BL-07 | Trwałość, kopia i migracje | L7.13 | 1 |
| BL-13 | v0.4 — centrum zadań, tryby zgód i pełna ścieżka GLM | L12.6 | 1 |

## BL-07 — Trwałość, kopia i migracje

Pytanie L7.13 ma pierwszą turę modelową (2026-10-08): SDK wznowił ten sam identyfikator sesji bez zdarzenia utraty — nierozstrzygnięte, czy chirurgia trafiła w żywy transkrypt CLI 2.1.270. Pozostałe kryteria trwałości (kopia z WAL, migracje, odtworzenie) są potwierdzone regresją.

**Warunek zamknięcia:** Jedna tura modelowa z chirurgią transkryptu potwierdzoną (plik istniał przed i nie istnieje po, w katalogu faktycznie czytanym przez CLI przy wznowieniu); zapisany komunikat SDK rozstrzyga, która ścieżka zachodzi, i potwierdza albo uzupełnia wzorce rozpoznawania w isMissingSessionTranscript.

| ID | Wymaganie | Stan | Brak |
|---|---|---|---|
| L7.13 | Brak transkryptu SDK dla zachowanej rozmowy daje jawny wynik odzyskiwania lub błąd; aplikacja nie deklaruje zachowania pamięci, której nie odtworzyła. | częściowe | Tura modelowa 2026-10-08 (t15-t4): brak zdarzeń utraty/wiązania i identyczny identyfikator sesji — nie rozstrzyga, czy usunięto ŻYWY transkrypt CLI 2.1.270 (zmiana układu katalogów), czy SDK po cichu kontynuuje bez transkryptu. Następny krok: weryfikacja układu transkryptów CLI 2.1.270 i jedna tura ponowna z chirurgią potwierdzoną (plik istniał przed i nie istnieje po, w katalogu faktycznie czytanym przez CLI przy wznowieniu). |

## BL-13 — v0.4 — centrum zadań, tryby zgód i pełna ścieżka GLM

L11.12 i L11.19 potwierdzone (PR #1). Obserwacja z realnego SDK (t17): statyczna analiza bezpieczeństwa CLI 2.1.270 wykonuje trywialne komendy sandboxowalne bez konsultacji canUseTool mimo autoAllowBashIfSandboxed: false — do decyzji właściciela (research CLI albo egzekwowanie przez PreToolUse). Otwarte pozostaje L12.6: izolowany dowód pełnej ścieżki GUI przez GLM.

**Warunek zamknięcia:** L12.6 ma izolowany dowód pełnej ścieżki GLM/Z.AI → Claude Code / Claude Agent SDK → Mastra → AG-UI → OpenUI z oznaczoną wersją, środowiskiem i providerem.

| ID | Wymaganie | Stan | Brak |
|---|---|---|---|
| L12.6 | Rzeczywista ścieżka GLM/Z.AI → Claude Code / Claude Agent SDK → Mastra → AG-UI → OpenUI została potwierdzona; mocki są oznaczone osobno. | częściowe | v0.4 wymaga rzeczywistej, izolowanej ścieżki GLM od GUI przez Claude Agent SDK, Mastrę, AG-UI i OpenUI z widocznym wynikiem oraz oznaczoną kopertą dowodu. Historyczny przebieg subskrypcyjny nie potwierdza nowego providera. |
