# L3.3 — walidacja kompozycji openui przeciw katalogowi: faza czerwona (przebieg)

Zadanie: domknięcie dziury z braku próby T07 — „karty kind openui z nieznanym
komponentem przechodzą walidację (L3.3)". Plan zakładał czerwoną fazę: nowe
asercje o odrzuceniu mają paść, bo zapisy openui mają dziś przelatywać bez
sprawdzenia katalogu.

## Wynik: faza czerwona NIE zmaterializowała się

Nowe asercje (a) i (b) **przechodzą od razu** — walidacja istnieje i działa.
Bieg `pnpm vitest run tests/bl10-card-catalog.test.ts` po dopisaniu asercji:

```
 ✓ tests/bl10-card-catalog.test.ts > karta openui jest sprawdzana przeciw katalogowi takze w głąb drzewa > (a) nieznany komponent w drzewie odrzucony z nazwa, w obu trybach 39ms
 ✓ tests/bl10-card-catalog.test.ts > karta openui jest sprawdzana przeciw katalogowi takze w głąb drzewa > (b) nieznany komponent zagniezdzony glebiej (w dzieciach znanego) tez odrzucony 32ms
 ✓ tests/bl10-card-catalog.test.ts > karta openui jest sprawdzana przeciw katalogowi takze w głąb drzewa > (c) kontrola przeciwna: drzewo ze znanych komponentow jest przyjmowane i normalizowane 30ms
 ✓ tests/bl10-card-catalog.test.ts > karta openui jest sprawdzana przeciw katalogowi takze w głąb drzewa > canvas_add_card odrzuca drzewo z nieznanym komponentem i nic nie zapisuje 40ms
 ✓ tests/bl10-card-catalog.test.ts > karta openui jest sprawdzana przeciw katalogowi takze w głąb drzewa > canvas_update_card odrzuca drzewo z nieznanym komponentem i tresc karty zostaje 51ms

 Test Files  1 passed (1)
      Tests  10 passed (10)
```

## Dlaczego (rozpoznanie)

Dziura opisana w macierzy (docs/ACCEPTANCE.md, wiersz T07) pochodzi z audytu
2026-09-28 i sama ocena L3.3 przyznaje: „karty openui nie były oceniane" — to
zapis o braku próby, nie o wykonanym wykryciu. Kod zamyka każdą ścieżkę zapisu
przez `ComponentCatalog.validate` (packages/platform-server/src/registry/catalog.ts),
a gałąź `kind: 'openui'` wywołuje `validateComposition`
(packages/platform-server/src/registry/openui-validation.ts) parserem
`@openuidev/lang-core` przeciw katalogowi serwera. Gałąź istnieje od commita
7d6ce0c (widoki agenta), czyli od przed audytu; nota audytu jest nieaktualna
względem kodu.

Drzwi objęte walidacją (wszystkie wołają `catalog.validate`):

- narzędzie MCP `canvas_add_card` (agent/tools/canvas.ts),
- narzędzie MCP `canvas_update_card` (agent/tools/canvas.ts),
- `agent_view_create` / `agent_view_update` (agent/tools/agent-views.ts),
- HTTP `POST /api/canvas/cards` i `PATCH /api/canvas/cards/:id/spec` (http/app.ts),
- domyślny układ modułu (services/base-data.ts) i widoki modułów przy rejestracji
  (registry/modules.ts).

## Probierz: 17 kształtów drzewa z nieznanym komponentem — wszystkie odrzucone

Tymczasowy test probierczy (usunięty po rozeznaniu) na
`checkComposition` + `OpenUiServerCatalog`:

| kształt | wynik |
| --- | --- |
| `root = TotallyUnknownWidget("x")` | `unknown_component` |
| `root = Stack([TotallyUnknownWidget("x")])` (zagnieżdżony) | `unknown_component` |
| głęboko w propsach obiektu (`CardHeader({title: Ghost("x")})`) | `unknown_component` + `invalid_props` |
| instrukcja przez zmienną (`widzet = TotallyUnknownWidget(...)`) | `unknown_component` |
| ternary (`$flip ? Stack(...) : UnknownWidget(...)`) | `unknown_component` |
| named args (`Card({children: [UnknownWidget("x")]})`) | `unknown_component` + `invalid_props` |
| znany + nieznany w tej samej tablicy | `unknown_component` |
| nieznany jako argument znanego | `unknown_component` + `invalid_props` |
| w obiekcie zagnieżdżonym (`Tabs({items: [...]})`) | `unknown_component` + `invalid_props` |
| `UNKNOWNWIDGET` (mix case) | `unknown_component` |
| małe litery (`totallyunknownwidget(...)`) | `unresolved_reference` |
| nazwa z kropką (`modul.NieznanyKomponent({})`) | `unresolved_reference` |
| samo słowo bez nawiasów (`Stack([UnknownWidget])`) | `unresolved_reference` |
| `Each([1,2], "el", <nieznany>(el))` | `unresolved_reference` (Each poza katalogiem) |
| drzewo poprawne (`Stack`, `TextContent`, `Separator`) | brak problemów (kontrola) |

## Co z tego wynika

Realna luka była **testowa**, nie produkcyjna: nikt nigdzie nie asertował
(a) nieznanego komponentu **w drzewie** (a nie na poziomie instrukcji — to ma
asercję w `tests/agent-views.test.ts`), (b) zagnieżdżenia głębokiego, ani (c)
drzwi narzędzi MCP `canvas_add_card` / `canvas_update_card` dla kart openui.
Dopisane asercje w `tests/bl10-card-catalog.test.ts` zamykają te luki; dowód,
że faktycznie chronią — zob. `falsyfikacja.md` w tym katalogu.
