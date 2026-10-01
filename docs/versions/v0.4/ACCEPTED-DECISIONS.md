# Zatwierdzone decyzje v0.4

Ten rejestr zawiera wyłącznie decyzje właściciela przyjęte do v0.4. Nie jest
raportem implementacji ani dowodem, że wszystkie wymagania są już wdrożone.

## D-01 — Harness Claude Code, provider GLM/Z.AI

Claude Code / Claude Agent SDK pozostaje harnessiem sesji, narzędzi i kontroli
uprawnień. GLM/Z.AI jest providerem modelu przez endpoint zgodny z Anthropic.
GLM jest jedynym aktywnym providerem v0.4. Brak `APP_MODEL_PROVIDER` wybiera GLM;
jawne `subscription` odmawia startu. Aplikacja nie używa OAuth ani subskrypcji Anthropic użytkownika,
nie czyta ich poświadczeń i nie ma automatycznego fallbacku do innego providera.

## D-02 — Klasy wymagań

Każde kryterium ma jedną klasę: **produktowe**, **jakościowe** albo
**informacyjne / proceduralne**. Produktowe i jakościowe blokują odbiór.
Informacyjne opisują ograniczenia niewywoływalne rozsądnie na żądanie; wymagają
uzasadnienia, ale nie blokują warstw ani nie należą do backlogu.

## D-03 — Semantyczny kontekst i nawigacja interfejsu

Agent otrzymuje wersjonowany, semantyczny opis aktywnego UI. Potrafi odnaleźć
rekord lub pole, ustawić filtr, sortowanie i paginację, przejść do właściwej
przestrzeni oraz wskazać rezultat. Nawigacja, filtrowanie i podświetlenie nie
są trwałą mutacją danych biznesowych.

## D-04 — Widoki agenta i kontrolowane komponenty

Zakładka **Widoki agenta** jest obowiązkowa. Agent tworzy tam dynamiczne
kompozycje OpenUI z katalogu komponentów. Deweloper może opcjonalnie wystawić
zamkniętą listę miejsc i komponentów dla konkretnego widoku użytkownika. Poza
nią agent nie zmienia stałego UI ani nie wykonuje dowolnego kodu.

## D-05 — Globalne centrum zadań

Czat służy do rozmowy i wydawania poleceń; backend i centrum zadań są
właścicielami prac w tle. Centrum pokazuje status, postęp, użyte narzędzia,
pliki wejściowe, artefakty wynikowe, błędy, anulowanie i ponowienie. Zmiana
rozmowy nie zatrzymuje zadania. Zadanie wymagające uwagi ma formularz w centrum,
zdarzenie w rozmowie źródłowej, trwałą plakietkę i jednorazowy, nieinwazyjny
komunikat prowadzący do niego bez zmiany aktywnego kontekstu.

## D-06 — Trzy tryby zgód

| Tryb | Zachowanie |
|---|---|
| Ręczny | Agent prosi o zgodę przed każdą inicjowaną akcją. |
| Nadzorowany | Agent sam odczytuje dane, nawiguje, filtruje i używa dozwolonych komponentów; prosi przed trwałą mutacją, usunięciem albo skutkiem poza aplikacją. |
| Pełna automatyzacja | Agent nie prosi o zgodę na każdą akcję, lecz nadal jest ograniczony autoryzacją backendu, sandboxem, zakazami narzędzi i trwałym logiem. |

Tryb wybiera użytkownik, jest widoczny w centrum zadań i nie może zostać
podniesiony przez model.
