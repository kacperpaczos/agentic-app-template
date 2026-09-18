# Dowody zadania Z8 (pakiet BL-08a — czat i historia)

Kryteria: L4.3, L4.5, L4.6, L4.7, L4.8, L4.9, L4.11, L4.13, L4.15.

- `01-verify.txt` — pelny `pnpm verify` (exit 0, 44 pliki / 709 testow; przed pakietem 43 / 697)
- `02-e2e-pelny-przebieg.txt` — `pnpm exec playwright test` pod blokada (169 testow (13,4 min), spece modelowe poza przebiegiem)
- `03-proby-wykrycia.txt` — 16 prob zdolnosci wykrycia wedlug G16, w tym dwie, ktore zlapaly **test**, a nie kod
- `04-stan-drzewa.txt` — bramka G17/G18: `pnpm verify` = 0 i puste `git status --porcelain`

Zaden test nie zapisuje do tego katalogu — pliki pochodza z recznych przebiegow (G18).

Odtworzenie:

```
pnpm verify
pnpm build && flock -w 5400 ../.e2e.lock pnpm exec playwright test e2e/chat-history.spec.ts
```

Tury modelu subskrypcyjnego wydane przez ten pakiet: **0**. Model jest zastapiony
skryptowanym stand-inem na granicy adaptera (`e2e/support/chat-history-scenario.ts`,
stand-in w `tests/chat-history.test.ts`); wszystkie wyniki przegladarkowe i kontraktowe
sa **symulacjami** w tym sensie i tak sa oznaczone.
