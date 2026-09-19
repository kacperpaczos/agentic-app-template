# Dowody pakietu BL-03 (zadanie Z11)

Pakiet BL-03 powtarza w szablonie funkcje, które w AgenticApp potwierdzał wyłącznie przebieg
historyczny albo ręczna sonda. Jego warunek zamknięcia brzmi: **dowód z przebiegu na commicie
szablonu, oznaczony jako rzeczywisty model**, z kontrolą negatywną tam, gdzie wymaga jej treść
kryterium.

Ten katalog trzyma dwa rodzaje zapisów i **nie miesza ich**.

## 1. Sesja SDK bez tury modelu — `sesja-sdk/`

`pnpm diag` otwiera **prawdziwą** sesję Claude Agent SDK i pyta ją wyłącznie **żądaniami
sterującymi** (`initializationResult`, `mcpServerStatus`, `accountInfo`). Strumień wejściowy nigdy nic
nie podaje, więc model nie dostaje żadnej wiadomości i przebieg **nie kosztuje tury**. To nie jest
symulacja — serwer MCP aplikacji naprawdę łączy się z CLI i naprawdę ogłasza swoje narzędzia — ale
nie jest też odpowiedzią modelu, i tak jest opisany w każdym wierszu macierzy, który się na niego
powołuje.

| Plik | Co pokazuje |
|---|---|
| `sesja-sdk/diag-<stempel>.txt` | 33 zadeklarowane narzędzia, 33 w sesji, brak obcych serwerów MCP, kod wyjścia 0 |
| `sesja-sdk/proba-niezgodnego-schematu-<stempel>.txt` | próba zdolności wykrycia: serwer z `z.record()` melduje się jako `connected` z **zerem narzędzi i bez błędu**, diagnostyka kończy się kodem 1 |
| `sesja-sdk/proba-bez-izolacji-mcp-<stempel>.txt` | próba zdolności wykrycia: bez `strictMcpConfig` do sesji wchodzi obcy serwer MCP podpięty do konta, diagnostyka kończy się kodem 1 |

Polecenia:

```bash
pnpm --filter @app/server diag
pnpm --filter @app/server diag -- --proba-niezgodnego-schematu
pnpm --filter @app/server diag -- --proba-bez-izolacji-mcp
```

Uwaga do drugiej próby: na maszynie bez łącznika MCP na koncie nie ma czego znaleźć i tryb kończy
się kodem 0. To uczciwe „nie do odtworzenia tutaj”, a nie zaliczenie.

## 2. Przebiegi z prawdziwym modelem — `runs/<stempel przebiegu>/`

Każde uruchomienie płatnych specek (`pnpm test:e2e:z11`) zapisuje swoje wyniki **pod własnym stemplem
przebiegu**, obok wyników każdego wcześniejszego. Nic nie jest nadpisywane: zapisany werdykt to fakt o
przebiegu, który się odbył, a nie ślad po ostatnim uruchomieniu kogokolwiek (G18). Pliki powstają w
blokach `finally`, więc przebieg nieudany też zostawia zapis — z `wynik: "niezaliczona"`.

| Plik | Przebieg | Kryteria |
|---|---|---|
| `a-kanwa-rekord-nawigacja.json` | A | L3.2, L3.10, L3.13, L6.6, L2.13 |
| `b-granice-izolacji.json` | B | L11.3, L11.4, L11.5, L11.11, L9.16, L11.9 |
| `c-blad-narzedzia.json`, `c-stop.json`, `c-sygnal.json` | C | L5.8, L7.3, L1.6 |
| `d-wznowienie-sesji.json`, `d-szkic-a-dane.json` | D | L8.5, L6.5 |
| `e-relacje.json` | E | L9.4 |

Rejestr wydanych tur tego grantu leży w kopii roboczej (`.e2e-model-turns/z11-bl03.json`,
ignorowanej przez git), a nie tutaj: licznik to plik roboczy, który każdy przebieg zapisuje, a dowód
to zapis jednego zrecenzowanego przebiegu. Rejestr **zamkniętego** grantu BL-01/BL-02
(`docs/evidence/bl01-bl02-2026-09-17/tury-modelu.json`) nie jest przez ten pakiet czytany ani pisany.

## Czego tu nie ma

- **Sekretów.** Przebieg B celowo prosi model o próbę odczytu pliku poświadczeń subskrypcji; zapisuje
  wyłącznie werdykt („odmowa” / „odczytane”), a test bierze prawdziwy token z dysku i sprawdza, że nie
  występuje ani w rozmowie, ani w dowodzie. Kanarek spoza workspace jest ciągiem wymyślonym przez
  test, więc można go szukać bezpiecznie.
- **Symulacji podanej jako model.** Próba generalna scenariuszy (`e2e/bl03-rehearsal.spec.ts`) jest
  symulacją na granicy adaptera i nie zapisuje niczego do tego katalogu. Jej rolą jest wyłapać błąd w
  skrypcie, zanim kosztuje turę — nie dowieść kryterium.
