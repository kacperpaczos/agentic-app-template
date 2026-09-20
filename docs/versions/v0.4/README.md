# Dokumentacja v0.4 — punkt startowy

Ta książka jest kanonem dla osoby lub agenta, który ma dokończyć projekt. Nie
opisuje, że wymagania są już spełnione: oddziela to, **co ma powstać**, od
**decyzji właściciela**, **aktualnego odbioru**, **otwartej pracy**, **dowodów**
i **historii**.

## Kolejność czytania

1. [ARCHITECTURE.md](ARCHITECTURE.md) — cel, założenia, architektura, 12 warstw,
   pełne 200 wymagań i 27 prób; jedyne źródło definicji systemu.
2. [ACCEPTED-DECISIONS.md](ACCEPTED-DECISIONS.md) — wiążące decyzje właściciela,
   w tym aktywny provider GLM/Z.AI i rola Claude Code / Claude Agent SDK jako
   harnessu.
3. [ACCEPTANCE.md](ACCEPTANCE.md) — wygenerowany stan i dowody dla każdego
   kryterium; nie zmienia treści wymagań.
4. [BACKLOG.md](BACKLOG.md) — wygenerowana lista otwartych prac blokujących
   odbiór; nie jest drugą specyfikacją.
5. Zależnie od zadania: [NEW-APPLICATION.md](NEW-APPLICATION.md) (kontrakt
   modułu), [ADAPTERY.md](ADAPTERY.md) (rejestr adapterów),
   [observability.md](observability.md) i [odzyskiwanie-stanu.md](odzyskiwanie-stanu.md)
   (załączniki operacyjne).

## Role dokumentów i źródła prawdy

| Dokument lub materiał | Rola | Czy definiuje bieżący system? |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | wymagania i architektura | tak — wyłącznie on |
| [ACCEPTED-DECISIONS.md](ACCEPTED-DECISIONS.md) | decyzje właściciela | tak, w zakresie decyzji |
| [ACCEPTANCE.md](ACCEPTANCE.md) | stan odbioru i odwołania do dowodów | nie — jest projekcją wymagań i ocen; zapisane w dowodach OAuth lub subskrypcji są historią, nie dowodem bieżącego GLM |
| [BACKLOG.md](BACKLOG.md) | otwarte prace | nie — jest projekcją ocen |
| [NEW-APPLICATION.md](NEW-APPLICATION.md), [ADAPTERY.md](ADAPTERY.md) | kontrakty rozszerzeń i rejestr wdrożeniowy | tylko w swoim wąskim zakresie |
| `docs/evidence/` i raporty poza v0.4 | dowody z określonym pochodzeniem | nie — należy je czytać jako dowody, nie instrukcje |
| [CHANGES-FROM-v0.3.md](CHANGES-FROM-v0.3.md), [DOCUMENTATION-MAP.md](DOCUMENTATION-MAP.md), v0.3 i archiwum | historia i pochodzenie | nie |

GLM/Z.AI przez endpoint kompatybilny z Anthropic jest jedynym aktywnym
providerem modelu. Claude Code / Claude Agent SDK są harnessiem. OAuth,
subskrypcja i poświadczenia Anthropic użytkownika nie są alternatywnym aktywnym
trybem v0.4.

## Model aktywnych plików

Ten katalog jest kanonem. Pliki w `docs/` poza `CURRENT.md`, krótkim `README.md`
i katalogiem `versions/` są technicznymi projekcjami v0.4, których wymagają
generatory, skrypty i testy; nie tworzą konkurencyjnej dokumentacji. Zmiana
takiej projekcji musi pozostać bajtowo zgodna z odpowiednim plikiem v0.4.
Nie używa się symlinków.

v0.3 pozostaje nieedytowaną historią. [CHANGES-FROM-v0.3.md](CHANGES-FROM-v0.3.md)
jest changelogiem, a nie drugą specyfikacją.
