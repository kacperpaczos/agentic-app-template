# Dowody zadania Z9 (pakiet BL-08b — zdarzenia i strumień)

Kryteria: L5.2, L5.3, L5.4, L5.5, L5.6, L5.11, L5.12, L5.13, L5.14, L5.15 — wszystkie zamknięte.

- `01-verify.txt` — `pnpm verify` na drzewie scalonym z gałęzią integracyjną (exit 0, 53 pliki / 816
  testów; przed pakietem 49 / 799)
- `02-e2e-pelny-przebieg.txt` — `pnpm exec playwright test` pod blokadą (**196** testów, 14,9 min;
  spece modelowe poza przebiegiem — wypisane jako pominięte wraz z kosztem)
- `03-proby-wykrycia.md` — dziewięć prób zdolności wykrycia wg G16, z plikiem i linią, na której każda
  oblewa; **dwie złapały test, a nie kod** (T4, T9) i obie skończyły się wzmocnieniem asercji
- `03-proby-wykrycia-przebieg.txt` — surowy zapis tych prób, razem z `git status` po każdym przywróceniu
- `05-runda-poprawek-1.txt` — bramka po recenzji (verify = 0, 11 testów przeglądarkowych z trzech
  poprawionych speców, zero tur modelu)
- `04-stan-drzewa.txt` — bramka G17/G18/G19: `pnpm verify` = 0, pusty `git status --porcelain` po
  regresji **i** po pełnym przebiegu przeglądarkowym

Żaden test nie zapisuje do tego katalogu — pliki pochodzą z ręcznych przebiegów (G18).

Odtworzenie:

```
pnpm verify
pnpm build && flock -w 5400 ../.e2e.lock pnpm exec playwright test \
  e2e/run-events.spec.ts e2e/reconnect-live.spec.ts e2e/artifact-renderers.spec.ts
```

Tury modelu subskrypcyjnego wydane przez ten pakiet: **0**. Model jest zastąpiony skryptowanym
stand-inem na granicy adaptera (`e2e/support/scripted-agent.ts`, `tests/support/model-standin.ts`);
wszystkie wyniki przeglądarkowe i kontraktowe są w tym sensie **symulacjami** i tak są oznaczone.
