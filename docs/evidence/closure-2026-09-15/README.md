# Dowody domknięcia — 2026-09-15

Materiały przywołane w [`RAPORT-DOMKNIECIA-PLATFORMY.md`](../../../RAPORT-DOMKNIECIA-PLATFORMY.md).
Dowody stanu **wejściowego** są w [`../audit-2026-09-15/`](../audit-2026-09-15/) i
nie były zmieniane.

| Plik | Co zawiera |
|---|---|
| `00-baseline-manifest.txt` | sumy SHA-256 wszystkich źródeł **przed** pracami — punkt odniesienia zamiast repozytorium Git |
| `00-pnpm-lock-before.yaml` | lockfile przed pracami |
| `01-typecheck.txt` | `pnpm typecheck` |
| `02-tests.txt` | `pnpm test` — pełne wyjście vitest |
| `03-boundaries.txt` | `pnpm check:boundaries` — kontrola granicy platforma–domena |
| `04-build.txt` | `pnpm build` |
| `05-matrix.txt` | podsumowanie macierzy odbioru |
| `06-wersje.txt` | przypięcia wersji z manifestów obszaru roboczego, potwierdzone w magazynie pnpm |
| `07-manifest-po.txt` | sumy SHA-256 źródeł **po** pracach |
| `08-e2e.txt` | pełny przebieg testów przeglądarkowych (46/46, w tym tura na prawdziwym modelu) |
| `10-chat-initial.png` | panel czatu w stanie wyjściowym |
| `11-chat-drawer.json` | zmierzona geometria szuflady rozmów w obu stanach i na dwóch szerokościach |
| `11-drawer-open-*.png` | szuflada otwarta — 1680 px i 1120 px |
| `12-drawer-closed-*.png` | szuflada zamknięta — 1680 px i 1120 px |
| `20-pomiary.json` | czas odświeżenia po mutacji i czas anulowania, z warunkami pomiaru |

### Druga tura — pięć rezultatów

| Plik | Co zawiera |
|---|---|
| `21-strumien.json` | orzeczenia detektora strumieniowania na trzech scenariuszach: tekst fragmentami (strumieniowanie), cała odpowiedź naraz na końcu (brak), narzędzie bez tekstu (brak treści) |
| `22-strumien-model.json` | wszystkie długości odpowiedzi zaobserwowane w trakcie wykonania — prawdziwy model, jedna tura |
| `23-proba-migracji.json` | próba migracji na kopii danych tej maszyny: stan przed i po, wiersze zachowane po tożsamości, wynik drugiego uruchomienia |
| `24-kopia.txt` | sumy SHA-256 `data/` przed i po pracach; co dokładnie zostało dotknięte i przez co (`app.db-shm` — przez otwarcie readonly) |
| `25-sila-testow.txt` | kontrola siły testów: cofnięcie każdej z czterech napraw i wynik testów |
| `26-izolacja.txt` | rzeczywiste komunikaty odmowy przy niezgodnej konfiguracji testów, w trzech warstwach |
| `30-rozszerzenie.txt` | rozszerzenie 2026-09-16: pliki, praca w tle, sterowanie interfejsem — wyniki bramki, kontrole siły testów i znalezione wady |
| `28-czysta-instalacja.txt` | postawienie od zera: usunięte wszystko pochodne, instalacja z lockfile, build, świeża baza, obraz Docker `--no-cache` |
| `27-migracja-wykonana.txt` | migracja **wykonana** na danych użytkownika za jego zgodą: stan przed/po, zgodność z przewidywaniem próby, odciski wierszy identyczne z kopią, idempotencja na prawdziwych danych |

Kopia stanu lokalnego, do której odnoszą się `23` i `24`, leży w
[`../../../backups/data-2026-09-15/`](../../../backups/data-2026-09-15/) razem z
własnym `manifest.json`.

## Jak odtworzyć

```bash
./scripts/closure-evidence.sh     # 01–07
pnpm exec playwright test         # 08, 20, 21, 22
node scripts/closure-probe-chat-layout.mjs   # 10–12 (wymaga ./scripts/closure-server.sh start)

# 23, 24 — kopia i próba migracji (aplikacja musi być zatrzymana)
pnpm backup --data data --out backups/data-$(date +%F)
pnpm migration:rehearsal --backup backups/data-$(date +%F) \
  --json docs/evidence/closure-2026-09-15/23-proba-migracji.json
```

`25-sila-testow.txt` i `26-izolacja.txt` powstały z ręcznie wykonanych kontroli
opisanych w tych plikach — cofnięcia napraw i celowo błędnych konfiguracji.

Skrypty `scripts/closure-*` są narzędziami diagnostycznymi, nie kodem produkcyjnym.
Każdy z nich działa na własnym katalogu danych i własnym porcie.
