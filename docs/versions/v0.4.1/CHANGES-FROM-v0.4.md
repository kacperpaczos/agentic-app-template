# Zmiany v0.4.1 względem v0.4

To wydanie aktualizuje dokumentację szablonu. Nie zmienia kodu aplikacji ani
ocen odbioru. Bazowe wymagania zachowują 12 warstw, 200 kryteriów i 27 prób.

| Zmiana | Dotknięte miejsca | Status i powód |
|---|---|---|
| Opis propozycji wykonywalnych grafów z React Flow i workflow Mastry | `WORKFLOW-GRAPHS.md`; odsyłacze w `ARCHITECTURE.md`, `README.md` i `DOCUMENTATION-MAP.md` | **Propozycja / do zatwierdzenia.** GraphDoc, typowane porty, kompilator, agent jako węzeł, zgody, trwałość, zdarzenia, edycja przez MCP i testy. Nie jest wymaganiem odbioru ani opisem implementacji. |
| Rozdzielenie storage bieżącego runtime i proponowanych workflow | `WORKFLOW-GRAPHS.md`, `observability.md` | Obecny `InMemoryStore` jest świadomym ograniczeniem; trwały storage workflow byłby zmianą zależności i wymaga weryfikacji adaptera oraz współistnienia z Drizzle. |
| Rejestr zmian i wskaźnik kanonu | `CHANGES-FROM-v0.4.md`, `README.md`, `docs/CURRENT.md` | v0.4 pozostaje niezmienioną historią; kanon dokumentacji wskazuje v0.4.1. |

Nowych kryteriów nie dodano. Elementy do zatwierdzenia i weryfikacji są
wypisane na końcu `WORKFLOW-GRAPHS.md`.
