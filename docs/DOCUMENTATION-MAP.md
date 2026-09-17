# Mapa dokumentacji — rozliczenie przed konsolidacją szablonu

## Po co ta mapa

Konsolidacja z 2026-09-16 połączyła trzy zbiory dokumentów w jeden zestaw w repozytorium
`agentic-app-template`. Każdy wcześniejszy dokument ma tu jedną decyzję: **aktualizacja**,
**scalenie**, **archiwum** albo **usunięcie duplikatu**. Nic nie zostało usunięte bez rozliczenia
unikalnej treści. Stan kodu i wyniki testów nie wynikają z tej mapy: rozstrzyga o nich
[`ACCEPTANCE.md`](ACCEPTANCE.md) oraz [`CONSOLIDATION-REPORT.md`](CONSOLIDATION-REPORT.md).

Oznaczenia źródeł:

| Skrót | Czym jest | Czy trafia do repozytorium |
|---|---|---|
| `AgenticApp/` | działająca aplikacja, z której skopiowano kod szablonu; pozostaje na miejscu z własnymi danymi | kod i dokumenty — po decyzjach poniżej; `data/`, `backups/`, dowody historyczne — nie |
| `stary-szablon/` | wcześniejsza zawartość katalogu `agentic-app-template` (plan z 2026-08-16, inny stos) | tylko jako archiwum z adnotacją |
| `materiały/` | katalog roboczy ze specyfikacją, promptami i planem konsolidacji, poza obydwoma repozytoriami | tylko treść specyfikacji (jako `docs/ARCHITECTURE.md`) |
| `szablon/` | repozytorium `agentic-app-template` po konsolidacji | — |

Lokalna kopia wszystkich dokumentów sprzed zmian leży poza repozytorium, w katalogu
`agentic-app-template-consolidation-backup` obok obu projektów.

## 1. Specyfikacja

| Stara ścieżka | Rola | Unikalna treść | Decyzja | Docelowa ścieżka | Uzasadnienie |
|---|---|---|---|---|---|
| `materiały/stack-agentowy-ustalenia-i-materialy.md` (2026-09-16) | zaakceptowany projekt techniczny: 12 warstw, 200 kryteriów, 27 prób | cała obowiązująca treść wymagań | **aktualizacja** — kopia wierna | `szablon/docs/ARCHITECTURE.md`; `AgenticApp/docs/ARCHITECTURE.md` | źródło pierwszeństwa nr 1. Jedyna zmiana: usunięta pusta linia, która rozcinała tabelę prób między T21 i T22 (bez niej T22–T27 renderowały się jako tekst). Dopisany nagłówek statusu. Porównanie treści maszynowe: poza tymi dwoma miejscami pliki są identyczne |
| `AgenticApp/stack-agentowy-ustalenia-i-materialy.md` (2026-09-14, 95 kryteriów) | wersja specyfikacji, wobec której oceniano `AgenticApp` | brak nowych wymagań. 95 kryteriów ma w nowej wersji te same identyfikatory (pierwsze pozycje każdej warstwy); zmieniło się brzmienie **L2.3** (dodane „aktywną rozmowę i przestrzeń… bez ręcznego wyszukiwania”) i **L5.3** („rzeczywiście widoczne… podczas wykonania oraz po odtworzeniu”). Zdania bez odpowiednika dosłownego: „natywna integracja Mastry przez adapter Hono” (w nowej wersji: „endpointy i strumienie współpracujące z Mastrą”) oraz akapit o rozróżnianiu w raporcie funkcji bibliotek, konfiguracji, adapterów i logiki domenowej — pokryty przez sekcję „Macierz i raport” oraz L12.7 i L12.15 | **archiwum** + odsyłacz w starym miejscu | `AgenticApp/docs/archive/stack-agentowy-ustalenia-i-materialy-95-kryteriow.md` (bajt w bajt); `szablon/docs/archive/agenticapp-2026-09/stack-agentowy-ustalenia-i-materialy-95-kryteriow.md` | raporty historyczne i skrypty `audit-matrix.mjs`/`closure-matrix.mjs` odnoszą się do tej wersji; bez archiwum ich wyniki byłyby nieczytelne. W starym miejscu zostaje krótki odsyłacz, żeby nie istniała konkurencyjna specyfikacja |
| `materiały/rozszerzenie-pliki-tlo-nawigacja.md` | krótki zakres rozszerzenia (pliki, praca w tle, nawigacja) + „Uzupełnienie: semantyczne UI i własne widoki agenta” | brak nowych kryteriów: wszystkie są w specyfikacji (L2.13–17, L3.14–18, L5.16–17, L6.13–17, L11.15–24, T22–T27). Unikalne jest tylko sformułowanie „dowodu odbioru” trzech rezultatów | **scalenie** | `szablon/docs/ARCHITECTURE.md` (kryteria); `szablon/docs/BACKLOG.md` (część „Uzupełnienie”, której wykonawca nie otrzymał) | plan konsolidacji zabrania drugiej, konkurencyjnej listy odbioru |
| `materiały/stack-agentowy-projekt-175-kryteriow.md`, `materiały/stack-agentowy-projekt-pierwotny-95-kryteriow.md`, `materiały/stack-agentowy-ustalenia-i-materialy.przed-specyfikacja.bak` | wersje pośrednie specyfikacji | brak — zastąpione wersją 200 kryteriów | **usunięcie duplikatu** (nie kopiowane) | — | pośrednie wersje tej samej listy; archiwum 95 wystarcza do czytania raportów historycznych |
| `materiały/plan-konsolidacji-agentic-app-template.md`, `materiały/prompt-*.md`, `materiały/checklista-migracji-react-agentowa.md` | zlecenia dla wykonawców | treść zleceń (kolejność prac, ograniczenia) | **nie przenoszone** | wynik konsolidacji: `szablon/docs/CONSOLIDATION-REPORT.md`; zasady pracy: `szablon/AGENTS.md` | zlecenia zawierają ścieżki lokalne autora i nie są dokumentacją produktu; to, co w nich trwałe (zasady dowodu, subskrypcja, izolacja testów), jest w `AGENTS.md` |

## 2. Dokumenty aplikacji `AgenticApp`

| Stara ścieżka | Rola | Unikalna treść | Decyzja | Docelowa ścieżka | Uzasadnienie |
|---|---|---|---|---|---|
| `AgenticApp/README.md` | uruchomienie i opis aplikacji | szybki start, Docker, kopia przed startem na istniejących danych, dane demonstracyjne, pliki / praca w tle / nawigacja agenta / panel rozmowy, drzewo pakietów, kanały canvasu, uwierzytelnienie, zmienne środowiskowe, izolacja testów, dodawanie modułu | **aktualizacja** w `AgenticApp` (odnośniki do nowej specyfikacji i mapy; opis `check:closure` jako historycznej macierzy 95). **Scalenie** w szablonie | `AgenticApp/README.md`; `szablon/README.md` (start, konfiguracja, ograniczenia, mapa); `szablon/docs/NEW-APPLICATION.md` (moduł); kopia historyczna `szablon/docs/archive/agenticapp-2026-09/README-agenticapp.md` | README szablonu ma innego czytelnika (autor nowej aplikacji); treść o module przeszła do kontraktu nowej aplikacji, reszta do README |
| `AgenticApp/FEEDBACK.md` | dziennik realizacji #1–#39 + architektura wdrożona (§4), macierz 95 (§5), integracje i własny kod (§6), problemy P1–P11 (§7), wnioski (§8) | decyzje i przyczyny wad; rejestr własnych adapterów (§6.1–6.10); pułapki bibliotek (P1 `z.record()`, P2 `z.default()`, P3 auto-zatwierdzanie, P4 adapter Mastry, P5 zdarzenia CUSTOM); lista „co trzeba dostarczyć dla nowej domeny” (§8) | **archiwum** (historia) + **scalenie** wniosków | `szablon/docs/archive/agenticapp-2026-09/FEEDBACK.md`; pułapki i wymagania modułu → `szablon/docs/NEW-APPLICATION.md`; nowy dziennik → `szablon/FEEDBACK.md` | dawne wpisy opisują próby wykonane w `AgenticApp`; nowy dziennik nie może ich przedstawiać jako prób na szablonie. `pnpm check:matrix` sprawdza teraz archiwalny plik |
| `AgenticApp/RAPORT-STANU-PLATFORMY.md` | audyt z 2026-09-15 (84/95 przed domknięciem) | wynik wejściowy audytu, faktyczna architektura przepływu (§2), próby nieudane | **archiwum** | `szablon/docs/archive/agenticapp-2026-09/RAPORT-STANU-PLATFORMY.md` | dowód historyczny; oczyszczony z lokalnej ścieżki katalogu domowego |
| `AgenticApp/RAPORT-DOMKNIECIA-PLATFORMY.md` | domknięcie 95 kryteriów + rozszerzenie (§4c) + panel rozmowy (§4d), wyniki testów, ograniczenia (§7), incydenty (§7a), macierz 95 (§9) | decyzje integracyjne (§3), kontrola siły testów (§5), 20 świadomych ograniczeń (§7), ostatnia ocena 95 kryteriów | **archiwum** + **scalenie** ocen i ograniczeń | `szablon/docs/archive/agenticapp-2026-09/RAPORT-DOMKNIECIA-PLATFORMY.md`; oceny 95 kryteriów → kolumna „ocena historyczna” w `szablon/docs/ACCEPTANCE.md`; ograniczenia → `szablon/docs/BACKLOG.md` i `szablon/README.md` | werdykt „95/95” dotyczy starej wersji wymagań; nowa macierz pokazuje go osobno i nie zalicza nim kryteriów szablonu |
| `AgenticApp/docs/observability.md` | telemetria i opcjonalny Langfuse | stan faktyczny punktu wpięcia (`@mastra/observability` wymagany), ograniczenia eksportu | **aktualizacja** (sprawdzone: wersje `@mastra/core` 1.66.0, `@mastra/claude` 0.3.1, SDK 0.3.270 zgodne z `package.json`; test `tests/observability.test.ts` istnieje) | `szablon/docs/observability.md` | procedura nadal obowiązuje |
| `AgenticApp/docs/odzyskiwanie-stanu.md` | kopia WAL, próba migracji, odtworzenie | procedura kopii i odtworzenia, uzasadnienie `app.db-wal` | **aktualizacja** w szablonie | `szablon/docs/odzyskiwanie-stanu.md` | sprawdzone pod kątem zgodności: liczby z „tej maszyny” oznaczono jako przykład historyczny; dopisano, że próba migracji nie obejmuje jeszcze `platform-0003-file-versions` (skrypt nie wymienia tabeli `files` wśród oczekiwanych zmian — pozycja w backlogu) |
| `AgenticApp/docs/evidence/**` | dowody historyczne (logi, zrzuty, raport Playwright ze śladami) | surowe wyniki prób z 2026-09-14…16 | **pozostaje lokalnie** | `AgenticApp/docs/evidence/` | zawiera lokalne ścieżki, identyfikatory sesji i ślady sieciowe przeglądarki; archiwalne raporty w szablonie mają adnotację, że ich odnośniki do `docs/evidence` wskazują oryginał. Nowe dowody: `szablon/docs/evidence/template-consolidation/` |
| `AgenticApp/docs/DOCUMENTATION-MAP.md`, `AgenticApp/docs/ARCHITECTURE.md` | powstały w tej konsolidacji | — | **nowe** | te same pliki w `szablon/docs/` | część A planu konsolidacji |

## 3. Wcześniejszy katalog szablonu

| Stara ścieżka | Rola | Unikalna treść | Decyzja | Docelowa ścieżka | Uzasadnienie |
|---|---|---|---|---|---|
| `stary-szablon/docs/PLAN.md` (2026-08-16, status „Proposed”) | plan aplikacji na Next.js + CopilotKit + BYOK/LiteLLM, workspace dokument + formularz | reguła audytu open-core przed wpięciem zależności (§2.4); bramka „propozycja → zgoda → deterministyczna mutacja” i rebase kroków ProseMirror (§5); `Actor` obowiązkowy w sygnaturach (ADR-008); sygnały zmiany architektury (§12) | **archiwum** z adnotacją „nieaktualny stos” | `szablon/docs/archive/plan-2026-08/PLAN.md` | **sprzeczny z obowiązującą specyfikacją**: Next.js (spec: Vite + Hono), CopilotKit zamiast OpenUI Agent Interface, BYOK/LiteLLM zamiast wyłącznie subskrypcji Claude (L8.3). Idee zgodne ze specyfikacją są już w niej obecne: semantyczny kontekst UI (L6.1, L6.15), zadanie w tle nie przełącza widoku (L6.14), atomowa i idempotentna mutacja (L9.7, L9.14), własność danych po stronie backendu (L10.1). Nieprzeniesione: rebase dokumentu, PIN, BYOK — nie należą do obecnego zakresu |
| `stary-szablon/docs/DECISIONS-OPEN.md` | arkusz trzech decyzji (format patcha, tożsamość, provider trybu B) | wzorzec „wdrażaj lokalnie, buduj jak dla wielu użytkowników” (`Actor` w sygnaturach) | **archiwum** z adnotacją | `szablon/docs/archive/plan-2026-08/DECISIONS-OPEN.md` | decyzja 3 (LiteLLM) jest sprzeczna z L8.3; decyzja 2 jest zgodna z kierunkiem L9.5 i L10.11, lecz nie wnosi wymagania spoza specyfikacji |

## 4. Nowe dokumenty szablonu

| Ścieżka | Zawartość | Źródło treści |
|---|---|---|
| `README.md` | czym jest szablon, uruchomienie, wymagania, ograniczenia, mapa dokumentacji | `AgenticApp/README.md`, sprawdzone poleceniami na czystej kopii |
| `AGENTS.md` | punkt wejścia dla wykonawcy: cel, pierwszeństwo źródeł, granica platforma–domena, zasady pracy i dowodu | plan konsolidacji, specyfikacja (sekcje o jakości testów i raporcie) |
| `CLAUDE.md` | jedna linia importująca `AGENTS.md` | pozwala Claude Code wczytać ten sam punkt wejścia bez kopiowania treści |
| `FEEDBACK.md` | dziennik prac nad szablonem, od konsolidacji | nowy |
| `docs/NEW-APPLICATION.md` | kontrakt nowej domeny: co dostarcza moduł, co zapewnia platforma, gdzie się go rejestruje | `packages/platform-contracts/src/module.ts`, `AgenticApp/FEEDBACK.md` §6–§8, `AgenticApp/README.md` |
| `docs/ACCEPTANCE.md` | macierz 200 kryteriów i 27 prób, generowana | `docs/ARCHITECTURE.md` + `docs/acceptance/assessment.json`, `scripts/acceptance-matrix.mjs` |
| `docs/BACKLOG.md` | otwarte kryteria pogrupowane w pakiety, generowany | jw. |
| `docs/CONSOLIDATION-REPORT.md` | raport z konsolidacji | nowy |
| `docs/archive/README.md` | spis archiwum i zasady czytania dokumentów historycznych | nowy |

## 5. Aktualizacja 2026-09-17 — poprawki AgenticApp po konsolidacji

Pełna mapa różnic kodu i decyzji: [`CONSOLIDATION-UPDATE-2026-09-17.md`](CONSOLIDATION-UPDATE-2026-09-17.md).

| Stara ścieżka | Rola | Decyzja | Docelowa ścieżka | Uzasadnienie |
|---|---|---|---|---|
| `AgenticApp/FEEDBACK.md` (wpisy #40–#41) | dziennik: `alwaysLoad`, zawężanie widoku, wyszukiwanie `*`, przeniesienie filtra do adresu | **archiwum** (kopia zaktualizowana do stanu z 2026-09-17) + **scalenie** wniosków | `szablon/docs/archive/agenticapp-2026-09/FEEDBACK.md`; pułapki → `szablon/docs/NEW-APPLICATION.md` §7 | nowe wpisy opisują próby w AgenticApp; wnioski (sprawdź dostępność narzędzia, zanim poprawisz prompt; `totals` w wyszukiwaniu) są trwałe dla autorów modułów. `pnpm check:matrix` przechodzi na nowej kopii |
| `AgenticApp/RAPORT-DOMKNIECIA-PLATFORMY.md` (§4e) | opis i dowody poprawek z 2026-09-17 | **archiwum** (kopia zaktualizowana) | `szablon/docs/archive/agenticapp-2026-09/RAPORT-DOMKNIECIA-PLATFORMY.md` | liczby w §4e dotyczą przebiegów w AgenticApp; szablon ma własną regresję |
| `AgenticApp/README.md` (sekcja „Zawężanie widoku przez agenta”) | opis funkcji | **scalenie** | `szablon/README.md` („Co pokazuje aplikacja przykładowa”), `szablon/docs/NEW-APPLICATION.md` §3–§5 (kontrakt `UiTarget.filter`, `useModuleData`, `alwaysLoad`) | README szablonu opisuje też ograniczenia (brak sortowania, filtr poza kontekstem agenta) |
| `AgenticApp/docs/evidence/chat-ux-2026-09-16/05-zawezony-widok.png`, zmienione `docs/evidence/closure-2026-09-15/2*.json` | dowody lokalne | **pozostają lokalnie** | — | jak wszystkie dowody AgenticApp; szablon ma własne: `szablon/docs/evidence/template-update-2026-09-17/` |
| `materiały/handoff-poprawki-agenticapp-2026-09-17.md` | przekazanie od wykonawcy odczytu: zakres 25 plików, celowe różnice szablonu, ryzyka R1–R8 | **nie przenoszone**, **rozliczone** | `szablon/docs/CONSOLIDATION-UPDATE-2026-09-17.md` §3 | dokument roboczy z lokalnymi ścieżkami; każdy punkt i ryzyko ma decyzję w raporcie aktualizacji |
| `AgenticApp/docs/ARCHITECTURE.md`, `docs/DOCUMENTATION-MAP.md`, `stack-agentowy-ustalenia-i-materialy.md` | bez zmian od 2026-09-16 | **bez działania** | — | treść zgodna z odpowiednikami szablonu (różnią się tylko nagłówkiem lokalnym) |
