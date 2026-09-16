# Archiwum dokumentów

Dokumenty historyczne zachowane dla kontekstu decyzji. **Żaden z nich nie opisuje stanu tego
repozytorium** — obowiązują [`../ARCHITECTURE.md`](../ARCHITECTURE.md) (wymagania),
[`../ACCEPTANCE.md`](../ACCEPTANCE.md) (stan) i [`../BACKLOG.md`](../BACKLOG.md) (otwarte prace).
Pełne rozliczenie: [`../DOCUMENTATION-MAP.md`](../DOCUMENTATION-MAP.md).

| Katalog | Co zawiera | Jak czytać |
|---|---|---|
| [`agenticapp-2026-09/`](agenticapp-2026-09/) | dokumenty aplikacji AgenticApp, z której skopiowano kod szablonu: dziennik `FEEDBACK.md` (#1–#39), audyt `RAPORT-STANU-PLATFORMY.md`, `RAPORT-DOMKNIECIA-PLATFORMY.md`, dawne `README` oraz specyfikacja w wersji 95 kryteriów | wyniki dotyczą prób w AgenticApp i starej wersji wymagań. Specyfikacja 95 kryteriów jest identyczna bajt w bajt z oryginałem, bo czytają ją skrypty historycznej macierzy (`pnpm check:closure`); pozostałe pliki mają adnotację na początku. `pnpm check:matrix` sprawdza spójność macierzy w archiwalnym `FEEDBACK.md` |
| [`plan-2026-08/`](plan-2026-08/) | plan i arkusz decyzji z 2026-08-16 dla wcześniejszej koncepcji (Next.js, CopilotKit, BYOK/LiteLLM) | **nieaktualny stos, sprzeczny ze specyfikacją**; zachowany jako zapis rozważanych alternatyw |

Dowody historyczne (`docs/evidence/…` przywoływane w raportach) pozostały lokalnie w AgenticApp:
zawierają lokalne ścieżki, identyfikatory sesji i ślady sieciowe przeglądarki. Nowe dowody, zebrane
na kodzie tego repozytorium, są w [`../evidence/template-consolidation/`](../evidence/template-consolidation/).
