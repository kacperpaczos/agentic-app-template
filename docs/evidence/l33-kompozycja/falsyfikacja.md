# L3.3 — falsyfikacja: wycofana walidacja openui wyróżnia nowe asercje

Metoda (zadanie, krok 4): `cp packages/platform-server/src/registry/catalog.ts
/tmp/catalog.ts.l33-backup`, gałąź `kind: 'openui'` w
`ComponentCatalog.validate` skrócona do `return spec;` (kompozycja przepuszcza
bez sprawdzenia katalogu — dokładnie stan opisany w nocie audytu T07), bieg
testów, przywrócenie backupu, `cmp` — bajty identyczne, bieg kontrolny zieleń.

## Bieg z wycofaną walidacją: 6 padających / 4 przechodzące

```
 FAIL ... > widok agenta odmawia kompozycji z wpisanymi liczbami
 FAIL ... > (a) nieznany komponent w drzewie odrzucony z nazwa, w obu trybach
 FAIL ... > (b) nieznany komponent zagniezdzony glebiej (w dzieciach znanego) tez odrzucony
 FAIL ... > (c) kontrola przeciwna: drzewo ze znanych komponentow jest przyjmowane i normalizowane
 FAIL ... > canvas_add_card odrzuca drzewo z nieznanym komponentem i nic nie zapisuje
 FAIL ... > canvas_update_card odrzuca drzewo z nieznanym komponentem i tresc karty zostaje

 Test Files  1 failed (1)
      Tests  6 failed | 4 passed (10)
```

Przykładowe komunikaty:

```
(a) AssertionError: catalog: root = Stack([opis, zjawa]) ... zjawa = NieznanyWidget("x"):
    expected undefined to be 'validation_failed'   // walidacja nie rzuciła — przelalo

canvas_update_card: AssertionError: promise resolved "{ cardId: ..., specVersion: 2 }"
    instead of rejecting   // nieznany GhostWidget("x") ZAPISANY w karcie, wersja podbita
```

Szósty padający (istniejący test „widok agenta odmawia kompozycji z wpisanymi
liczbami") potwierdza, że ta sama gałąź chroniła też wcześniejsze asercje.
(c) pada, bo bez gałęzi znika też normalizacja (zdjęcie ogrodzenia ```),
którą kontrola przeciwna asertuje.

## Przywrócenie

```
$ cp /tmp/catalog.ts.l33-backup packages/platform-server/src/registry/catalog.ts
$ cmp /tmp/catalog.ts.l33-backup packages/platform-server/src/registry/catalog.ts && echo OK
OK — bajty identyczne
$ pnpm vitest run tests/bl10-card-catalog.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

Wniosek: dopisane asercje wykrywają regressję „openui przelatuje bez katalogu”
na wszystkich trzech poziomach (walidator, drzwi dodania, drzwi zmiany) — próba
T07 dla tego fragmentu kryterium L3.3 jest od teraz wykonalna i zaliczona.
