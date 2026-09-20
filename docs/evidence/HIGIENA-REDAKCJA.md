# Redakcja higieniczna dowodów — 2026-09-20

**Kto i dlaczego:** koordynator programu, na podstawie recenzji całej gałęzi. Reguła właściciela
repozytorium zabrania danych użytkownika i lokalnych ścieżek w repo; dwa zdarzenia z tej fazy
nie były zgodne. Redakcja jest mechaniczna, nie dotyka żadnej wartości pomiarowej ani werdyktu
żadnego testu i jest ujawniona w całości w tym pliku.

## Zakres

1. **Przestrzeń nazw ścieżek** — literał `/home/paczos` zastąpiony znakiem `~` w **38 plikach**
   `docs/evidence/**` (JSON, TXT, MD). Ścieżki w dowodach nie są pomiarem; struktura katalogów
   pozostała czytelna.
2. **Odciski tokenów poświadczeń** — wartości `accessTokenSha`/`refreshTokenSha` (prefiksy SHA-256,
   16 znaków hex, dwie generacje tokenu) zastąpione znacznikiem
   `[redakcja-higiena-bylo-SHA-256-prefiks-16-zn]` w **6 plikach** `docs/evidence/z12-bl04/`.
   Odciski wiązały zapis z realnym plikiem poświadczeń w celach antytamperowych; wszystkie
   wiązania zostały skonsumowane w przebiegach, do których należały (strażniki vitesta i e2e
   przeszły), więc redakcja nie odbija niczemu, co byłoby weryfikowalne ponownie.

## Czego redakcja NIE robi

- Nie zmienia statusów w `docs/acceptance/assessment.json`, treści kroków, wyników ani werdyktów.
- Nie dotyka kopert (commit, wytwórca, środowisko) ani rejestru `POCHODZENIE.json` — pliki
  dalej wskazują na te same commity i wykonania.
- Pozostawia legalne skróty artefaktów (manifesty, lockfile, obrazy Dockera) w
  `docs/evidence/template-consolidation/`.

## Procesowa uwaga (odnotowana, bo kosztowała)

Pierwszy przepust sed zjadał zamykający cudzysłów JSON (wzorzec obejmował `"` na końcu wartości,
zamiennik go nie przywracał) — 6 plików było chwilowo niepoprawnych; wychwycone natychmiastową
kontrolą `JSON.parse` i naprawione. Lekcja: redakcję zbiorczą prowadzi się z kontrolą poprawności
w tej samej komendzie, nie po fakcie.
