# Plan budowy aplikacji agentowej — jeden strumień danych UI ↔ agent

> **Archiwum — nieaktualny stos.** Plan z 2026-08-16 (status „Proposed”) dla wcześniejszej koncepcji: Next.js, CopilotKit,
> BYOK/LiteLLM, workspace dokument + formularz. Jest **sprzeczny z obowiązującą specyfikacją** ([`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md)):
> Vite + Hono, OpenUI Agent Interface, Mastra + Claude Agent SDK wyłącznie na subskrypcji (L8.3).
> Zachowany jako zapis rozważanych decyzji. Rozliczenie treści: [`docs/DOCUMENTATION-MAP.md`](../../DOCUMENTATION-MAP.md) §3.

> Status: **Proposed** · Wersja 0.1 · 2026-08-16
> Dokument bazowy: *Szablon technologiczny aplikacji agentowej v1.0 (14.08.2026)*
> Ten plan **realizuje** szablon w wariancie minimalnym: sekcja 23 szablonu („Minimalny wariant startowy") + sekcja 11 („Frontend, UI i edytor") jako oś ciężkości.

---

## 0. Streszczenie decyzji

| Pytanie | Odpowiedź | Dlaczego |
|---|---|---|
| Jeden język czy dwa? | **TypeScript end-to-end** | UI jest kluczowe. Dwa runtime'y (Python + Node) to podwójny build, podwójny deploy i podwójna serializacja kontraktów — koszt bez pokrycia w wymaganiach. |
| Shell aplikacji | **Next.js App Router** (SSR + route handler w jednym procesie) | Workspace agentowy jest w większości interaktywny i współdzieli stan → szablon §22 sam wskazuje „pełniejsza aplikacja React/SPA". Astro + osobne FastAPI to 3 procesy zamiast 1. |
| Runtime agenta | **`@copilotkit/runtime/v2` → `BuiltInAgent`** | Zamyka pętlę model↔tool↔stream bez LangGraph. Runtime i `react-core` bez bramki. |
| **Trwałość wątków** | **Własny `ThreadsPanel` na `/api/threads`** | `useThreads` wymaga klucza Intelligence i nie przyjmuje endpointu; wątki są naszym źródłem prawdy — §2.4, ADR-010 pkt 1. |
| **Render UI agenta** | **CopilotKit w całości** — `CopilotChat` + wbudowane gen-UI przez `render` | Dokumentacja CopilotKit dzieli produkt jednoznacznie: chat, frontend tools i **gen-UI są w darmowym OSS**; za bramką jest wyłącznie trwałość wątków i platforma ops. OpenUI odpada jako niepotrzebne — ADR-010. |
| Protokół strumienia | **AG-UI** (jeden endpoint `/api/copilotkit`) | To jest literalna realizacja „UI i agent to jeden strumień danych": tekst, tool lifecycle, state delta i interrupt lecą jednym kanałem zdarzeń. |
| LLM | **BYOK z UI** *albo* **LiteLLM pod `LLM_BASE_URL`** | Wymóg wprost od właściciela. Rozstrzygane serwerowo per-request przez `agents: ({request}) => ...`. |
| Trwałość | **SQLite** (`SqliteAgentRunner` na wątki + Drizzle na domenę) | Jeden plik, jeden host, zero operacji. Próg przejścia na Postgres: szablon §8.4. |
| **Powierzchnie** | **Zakładki: dokument + formularz** (+ chat boczny) | Decyzja właściciela (2026-08-16). Edytor i formularz obok siebie, agent pracuje na obu — §1.1, §7.0. |
| **Artefakty** | **Dwa rodzaje, dwa formaty patcha, jedna bramka** — `pm-steps` (dokument) i `json-patch` (formularz) | Rebase kosztuje tylko dokument. Autoryzacja pozostaje jedna — §5.4, ADR-007, ADR-009. |
| **Tożsamość** | **Local + PIN**, sesja cookie, CSRF od E1 | Decyzja właściciela (2026-08-16). `Actor` obowiązkowy w każdej sygnaturze — ADR-008. |
| Bramka mutacji | **Propozycja → zgoda → deterministyczna mutacja** | Nienegocjowalne. To jedyna rzecz, której „minimalny wariant" nie może wyciąć. |

> **Decyzje 1–3 rozstrzygnięte 2026-08-16.** Uzasadnienia wariantów: [DECISIONS-OPEN.md](./DECISIONS-OPEN.md).
> Wybór rich textu przenosi ciężar poprawności z „porównaj numer rewizji" na „przelicz propozycję przez zmiany, które zaszły w międzyczasie". To jest teraz najbardziej ryzykowna część systemu i dostaje własną sekcję (§5.5) oraz własny zestaw testów.

**Zdanie, które trzeba zapamiętać:** *jeden strumień transportu, jedno źródło prawdy w bazie.* Strumień AG-UI niesie **projekcje i delty**, nie jest bazą. To rozstrzyga pozorny konflikt między „UI i agent to jeden strumień" a zasadą „jedno źródło prawdy" z §2 szablonu.

---

## 1. Karta projektu

| Pole | Wartość |
|---|---|
| Nazwa | `{{PROJECT_NAME}}` — referencyjny workspace agentowy |
| Właściciel produktu | `{{PRODUCT_OWNER}}` |
| Właściciel techniczny | `{{TECH_OWNER}}` |
| Użytkownicy | `{{PRIMARY_USERS}}` — pojedynczy operator / mały zespół |
| Główne zadanie | **Praca w workspace z zakładkami: redagowanie dokumentu i wypełnianie formularza, z asystą agenta.** Agent czyta obie powierzchnie, proponuje zmiany i sygnalizuje; człowiek pracuje i zatwierdza |
| Model wdrożenia | **LOCAL / SINGLE-TENANT** (SaaS dopiero po §12) |
| Klasy danych | `{{INTERNAL}}` — domyślnie; klucz LLM traktowany jako **SECRET** |
| Zakładana skala | 1–20 użytkowników, 1 host, ≤ 500 runów/dzień |
| SLO | Dostępność best-effort; **TTFT strumienia < 800 ms p95**; RPO 24 h, RTO 4 h |

### 1.1. Przesłanka produktowa — workspace z zakładkami: formularz + edytor

*(potwierdzone przez właściciela 2026-08-16)*

Produkt nie jest ani czystym edytorem, ani czystym formularzem. Jest **workspace'em z zakładkami**, w którym te powierzchnie stoją obok siebie, a agent pracuje na obu:

| Powierzchnia | Artefakt | Typowa praca agenta |
|---|---|---|
| **Edytor** | dokument (ProseMirror) | Przepisz akapit, popraw język, zrestrukturyzuj sekcję |
| **Formularz** | rekord strukturalny (JSON + Zod) | Uzupełnij pola z treści dokumentu, popraw niespójność, wyjaśnij walidację |
| **Zakładki** | — | Nawigacja między powierzchniami; agent **sygnalizuje**, nie przełącza siłą |
| **Chat** | wątek | Rzeczy nieprzypisane do konkretnego fragmentu ani pola |

#### Kluczowa konsekwencja: dwa rodzaje artefaktu, dwa formaty patcha, **jedna** bramka

To jest ta decyzja, która ratuje wcześniejszą analizę zamiast ją unieważniać. Union `format` z `AgentOperation.payload`, wstawiony wcześniej jako furtka na przyszłość, jest teraz nośny:

| `kind` | Format patcha | Konflikt | Rebase |
|---|---|---|---|
| `document` | `pm-steps` | mapowanie kroków | **tak** — §5.5, cały koszt tu |
| `form` | `json-patch` | kolizja ścieżek (`Set`) | **nie potrzebny** |

Formularz dostaje tańszą i łatwiejszą do udowodnienia ścieżkę, którą pierwotnie rekomendowałem dla całości. Rebase pozostaje kosztem **jednej** powierzchni, a nie całego systemu.

**Czego to nie zmienia:** `approveOperation` pozostaje jedną funkcją (ADR-006). Rodzaj artefaktu wybiera *aplikator kroków*, nie ścieżkę autoryzacji. Dwie bramki zgody byłyby regresją bezpieczeństwa, nie uproszczeniem — patrz ADR-009.

#### Reszta konsekwencji

| Konsekwencja | Gdzie |
|---|---|
| ProseMirror to właściwy model dla zakładki „dokument", nie wybór „mimo kosztu" | ADR-007 |
| Narzędzia READ i PROPOSE są **świadome rodzaju artefaktu** | §5.1, §5.2 |
| Agent musi wiedzieć, **gdzie jest użytkownik** — semantyczny kontekst UI | §6.4 |
| Zakładki: propozycja w nieaktywnej zakładce → **plakietka, nie przełączenie** | §7.0, §7.2 |
| Cofanie (Ctrl+Z) musi współgrać z rewizjami i propozycjami | §5.6 |
| Formularz waliduje się tym samym schematem Zod po obu stronach | §5.2, §10 |
| `artifact_revisions` to najszybciej rosnąca tabela w systemie | §15, retencja |

### 1.2. Założenia, które ten plan przyjmuje

1. UI jest projektowane przez programistę. Agent **wybiera i parametryzuje** z rejestru przygotowanych komponentów — nigdy nie generuje DOM, markupu ani kodu. Powierzchnie komponowane przez agenta (§7.6) mieszczą się w tej zasadzie, bo węzeł spoza rejestru jest odrzucany **przed** renderem, tak samo jak węzeł spoza schematu ProseMirror.
2. Klucz LLM nie jest własnością aplikacji. Albo należy do użytkownika (wpisany w UI), albo do hosta (env).
3. Każda mutacja domenowa przechodzi przez jedną funkcję serwerową. Nie ma drugiej ścieżki zapisu.
4. Reconnect nie gubi zdarzeń. Klient dostaje historię wątku przed wejściem w live.

---

## 2. Wynik researchu — minimalny stack

### 2.1. Backend / runtime

| Pakiet | Rola | Status | Uwaga |
|---|---|---|---|
| `next` (App Router) | SSR + route handler + BFF | Core | Jeden proces w dev i w prod |
| `@copilotkit/runtime` (`/v2`) | `CopilotRuntime`, `BuiltInAgent`, `createCopilotRuntimeHandler` | Core | Fetch-native — działa też na Bun/Deno/Workers, gdyby zaszła potrzeba |
| `@copilotkit/sqlite-runner` | `SqliteAgentRunner` — trwałe wątki + `connect()` do replayu | Core | Peer: `better-sqlite3` |
| `ai` + `@ai-sdk/openai` | `streamText`, `createOpenAI({ baseURL, apiKey })` | Core | Ścieżka BYOK i „system URL" |
| `@ai-sdk/openai-compatible` | `createOpenAICompatible` | Core | Ollama / LM Studio / vLLM / LiteLLM |
| `@ai-sdk/anthropic` | provider Anthropic | Opcjonalny | Gdy użytkownik wkleja klucz `sk-ant-…` |
| `zod` | schematy narzędzi **i** DTO domenowych | Core | Jedno źródło walidacji, wspólne front↔back |
| `drizzle-orm` + `drizzle-kit` | schemat, repozytoria, migracje | Core | Migracje wersjonowane od dnia 1 |
| `prosemirror-model` + `prosemirror-transform` | **rebase Steps po stronie serwera** | Core | Serwer musi umieć odtworzyć dokument i przemapować kroki — §5.5 |
| `node:crypto` (`scrypt`, `timingSafeEqual`) | hash PIN-u, porównanie w stałym czasie | Core | Wbudowane — zero zależności na auth |

### 2.2. Frontend

| Pakiet | Rola | Status | Uwaga |
|---|---|---|---|
| `@copilotkit/react-core` | `useCoAgent`, `useCoAgentStateRender`, `useFrontendTool` | Core | Audyt open-core w E0 (§2.4) |
| `@copilotkit/react-ui` | `CopilotChat` i reszta komponentów bazowych | Core | **Darmowe, bez bramki.** Weryfikacja w E0 razem z resztą |
| ~~`CopilotThreadsDrawer` + `useThreads`~~ | ~~lista i przełączanie rozmów~~ | **Odrzucone** | Wymaga klucza Intelligence (także w wariancie self-hosted); `useThreads` przyjmuje tylko `agentId`, brak propa na `/api/threads` |
| `useFrontendTool` + `render` | **Gen-UI**: powierzchnie komponowane przez agenta (§7.6) | Core | Wbudowane w darmowy OSS — nie wymaga zewnętrznej biblioteki |
| Własny `ThreadsPanel` | Lista i wybór rozmów przeciwko `/api/threads` | Core | Wątki zostają w naszym SQLite; stylizacja spójna z resztą |
| ~~`@thesysdev/openui`~~ | ~~render powierzchni komponowanych~~ | **Odrzucone** | Rozwiązywałoby problem, którego nie ma: gen-UI jest w darmowym CopilotKit. Drugi kontrakt bez zysku |
| `tailwindcss` | Design system, wspólny dla komponentów własnych i CopilotKit | Core | Spójna stylizacja `ThreadsPanel` z resztą |
| `@tiptap/react` + `@tiptap/starter-kit` | Edytor strukturalny (zakładka „dokument") | Core | **Nie** podlega generowaniu przez agenta |
| Wzorzec „collaboration" **bez** Yjs | Numeracja rewizji i wysyłka Steps na serwer | Core | Brak współpracy w czasie rzeczywistym: jeden autor + agent |
| ProseMirror `Decoration` / `DecorationSet` | Ghost text i inline diff propozycji | Core | Prezentacja, **nie** trwałość propozycji |
| `@playwright/test` + `@axe-core/playwright` | E2E + bramka a11y | Dev | — |
| `vitest` | Domena, use case'y, repozytoria | Dev | — |

### 2.3. Czego **nie** ma w minimalnym wariancie

LangGraph · FastAPI · SQLAlchemy/Alembic · Astro · Nanostores · AJV · Redis · osobny worker · LanguageTool · sentence-transformers · **Yjs / CRDT**.

Yjs zasługuje na wzmiankę, bo przy TipTap jest domyślnym odruchem. Rozwiązuje konwergencję wielu jednoczesnych autorów — problem, którego tu nie ma. Jest jeden autor i agent, który **proponuje**, a nie edytuje. Rebase z §5.5 pokrywa całą potrzebę mniejszym kosztem.

Każde z nich ma w §12 nazwany sygnał, który je odblokowuje. Nie dodajemy ich „na zapas".

---

### 2.4. Audyt open-core — stała reguła, nie jednorazowa reakcja

**Znalezisko z praktyki, 2026-08-16 — zweryfikowane w dokumentacji CopilotKit tego samego dnia.**

Trwałość wątków wymaga klucza licencyjnego CopilotKit Intelligence. Cytat z ich własnej dokumentacji: *„The use of threads requires a valid CopilotKit Intelligence license key. If a license key is not provided, the drawer will display a locked view instead of the list of conversations."* Sygnatura hooka to potwierdza: `useThreads({ agentId, includeArchived?, limit? })` — **brak propa na własny endpoint**.

**Self-hosting Intelligence istnieje**, ale nie ratuje sprawy w naszej skali: Helm chart, osobny serwis, własna baza — i **nadal klucz** (`apiKey` + `organizationId` są wymagane także tam). Kubernetes obok aplikacji na jednym hoście z SQLite przeczy całemu §8.

**Zakres bramki — i korekta wcześniejszego zapisu.** Bramka dotyczy **wyłącznie trwałości wątków**. Runtime, `@copilotkit/react-core`, `useCoAgent`, `useFrontendTool` i `CopilotChat` z `@copilotkit/react-ui` są darmowe i bez bramki. Pierwsza wersja tej sekcji uogólniała znalezisko na całą warstwę React CopilotKit — to była nadinterpretacja, poprawiona 2026-08-16.

To nie jest usterka biblioteki. To model biznesowy **open-core**, i trzeba go traktować jak każdą inną własność zależności: sprawdzać przed wpięciem, nie po. Wniosek na przyszłość jest też o nas: **znalezisko z jednego komponentu nie uogólnia się na paczkę** — zakres bramki trzeba zmierzyć, tak samo jak jej istnienie.

#### Trzy pytania przed wpięciem czegokolwiek w ścieżkę krytyczną

1. **Co konkretnie milczy bez licencji?** Nie „czy licencja jest wymagana", tylko które funkcje przestają działać — i czy robią to głośno, czy cicho.
2. **Co woła cudzą chmurę i czy da się wskazać własny endpoint?** Brak propa na własne API jest twardym wykluczeniem, nie niedogodnością.
3. **Czy ta zależność trzyma dane, które są naszym źródłem prawdy?** Jeśli tak, a nie da się jej wskazać naszego API — **odpada**, niezależnie od licencji.

Pytanie trzecie jest tym, które zabolało. Wątki są naszym źródłem prawdy (ADR-005), a `useThreads` nie potrafi ich u nas szukać. Konflikt był nieunikniony i dałoby się go zobaczyć wcześniej.

#### Wynik audytu

| Zależność | Werdykt | Podstawa |
|---|---|---|
| `@copilotkit/runtime/v2` + `SqliteAgentRunner` | Zostaje, **warunkowo** | Trwałość jest jawnie samohostowana. E0 potwierdza brak analogicznych bramek |
| `@copilotkit/react-core` (hooki) | Zostaje, **warunkowo** | E0 sprawdza `useCoAgent` / `useFrontendTool` bez licencji |
| `@copilotkit/react-ui` — `CopilotChat` i komponenty bazowe | Zostaje | Brak bramki; potwierdzenie w E0 |
| `CopilotThreadsDrawer` + `useThreads` | **Odpada** | Pytanie 1 i 3: wymaga klucza Intelligence, a wątki są naszym źródłem prawdy i nie da się ich wskazać |
| `@thesysdev/openui` | **Nieaktualne** | Rozważane, gdy sądziliśmy, że warstwa UI CopilotKit odpada. Po weryfikacji niepotrzebne |
| LiteLLM, Drizzle, TipTap, ProseMirror | Czyste | Brak wariantu komercyjnego w ścieżce krytycznej |

**Audyt jest pozycją w E0 i w release gate**, nie notatką. Kryterium wprost: *żadna funkcja w ścieżce krytycznej nie wymaga licencji ani cudzej chmury.*

## 3. Model dostarczania LLM (BYOK)

Dwa tryby, rozstrzygane **serwerowo, per-request**. Frontend nigdy nie decyduje, który tryb obowiązuje — tylko dostarcza materiał.

### Tryb A — klucz w UI (BYOK)

```
Użytkownik wkleja klucz w /settings
  → sessionStorage (NIE localStorage)
  → nagłówek `x-llm-api-key` przy każdym żądaniu do /api/copilotkit
  → serwer buduje provider per-request
  → klucz nie jest logowany, nie trafia do DB, nie trafia do eventów
```

### Tryb B — model w systemie (base URL)

```
LLM_BASE_URL=http://localhost:11434/v1     # Ollama / vLLM / LiteLLM / brama firmowa
LLM_API_KEY=…                              # opcjonalny
LLM_MODEL=…
  → UI nie pokazuje pola na klucz
  → /api/llm/status zwraca { mode: "system", model, ready }
```

### Rozstrzyganie (szkic — `apps/web/app/api/copilotkit/route.ts`)

```ts
import { CopilotRuntime, BuiltInAgent, createCopilotHonoHandler } from "@copilotkit/runtime/v2";
import { SqliteAgentRunner } from "@copilotkit/sqlite-runner";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { resolveModel } from "./resolve-model";

const runtime = new CopilotRuntime({
  runner: new SqliteAgentRunner({ dbPath: "./data/threads.db" }),
  // Fabryka per-request — bez niej instancja agenta jest współdzielona
  // między równoległymi runami (błąd „concurrent run").
  agents: ({ request }) => {
    const cfg = resolveModel(request);        // A: nagłówek · B: env · brak → 428
    const provider = createOpenAICompatible({
      name: cfg.providerName,
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
    });
    return {
      default: new BuiltInAgent({
        model: provider(cfg.model),
        prompt: SYSTEM_PROMPT,
        // narzędzia READ/PROPOSE — patrz §5
      }),
    };
  },
});
```

**Do zweryfikowania w E0:** dokładny kształt `agents` jako fabryki oraz notacja `model` (dokumentacja pokazuje zarówno `"openai:gpt-…"`, jak i `"openai/gpt-…"` — instancja `LanguageModel` z AI SDK omija ten problem i to jest forma preferowana).

### Profile modeli — wartości domyślne

Gdy użytkownik wkleja klucz Anthropic, domyślny profil to **Claude Opus 5** (`claude-opus-5`, 1M kontekstu, $5 / $25 za MTok). Alternatywy w tej samej rodzinie: `claude-sonnet-5` ($3 / $15) dla ruchu wysokowolumenowego, `claude-haiku-4-5` ($1 / $5, 200K kontekstu) do prostych klasyfikacji. Dla trybu B model wynika z `LLM_MODEL` i nie jest przez aplikację zgadywany.

> Profil modelu (`role`, `model`, `timeout`, `maxSteps`, `maxTokens`) jest **wersjonowany** i zapisywany przy runie — szablon §13. Bez tego nie da się odtworzyć, dlaczego run z zeszłego tygodnia zachował się inaczej.

### Granica zaufania — powiedziane wprost

W trybie A klucz użytkownika **przechodzi przez nasz serwer**. To jest świadoma decyzja, nie przeoczenie: serwer musi wykonać pętlę narzędziową i bramkę zgody, więc nie da się wołać providera bezpośrednio z przeglądarki bez utraty całej warstwy autoryzacji. Konsekwencje, które trzeba wdrożyć jako kod, nie jako intencję:

- `sessionStorage`, nie `localStorage` — klucz ginie po zamknięciu karty.
- Nagłówek `x-llm-api-key` jest usuwany z każdego logu, span'u telemetrii i payloadu eventu.
- Serwer **nigdy** nie persystuje klucza — ani w DB, ani w checkpoincie, ani w cache.
- Komunikat błędu providera jest sanitizowany przed powrotem do UI (odpowiedzi 401/403 potrafią echo'ować fragment klucza).
- `/settings` mówi to użytkownikowi jednym zdaniem, zanim wklei klucz.

---

## 4. Architektura — warstwy i repozytorium

### 4.1. Reguła zależności

```
apps/web (UI, route handlers)
        │  zależy od
        ▼
packages/agent  ──────►  packages/application  ──────►  packages/domain
(graf, tool registry)     (use cases, policy, UoW)       (encje, invarianty, eventy)
        │                          │
        └──────────────────────────┴──────►  packages/db  (schemat, repozytoria, outbox)
```

Strzałki wyłącznie do środka. `domain` nie importuje niczego z `next`, `drizzle` ani `@copilotkit/*`. Agent **nie** ma dostępu do repozytoriów — woła use case'y przez adaptery narzędzi.

### 4.2. Struktura

```
apps/web/
  app/
    api/copilotkit/route.ts        # jedyny endpoint AG-UI
    api/llm/status/route.ts        # tryb A/B + gotowość, bez sekretów
    (workspace)/page.tsx           # SSR bootstrap
    settings/page.tsx              # BYOK
  src/
    ui/                            # design system, powierzchnie
    agent-ui/
      capabilities.ts              # allowlist client tools
      frontend-tools.tsx           # useFrontendTool — UI + HITL
      state-bridge.ts              # useCoAgent → projekcja, nie źródło prawdy
packages/
  domain/                          # encje, value objects, invarianty, eventy
  application/                     # use cases, policies, approval gate, UoW
  agent/                           # tool registry, prompt, capability matrix
  db/                              # drizzle schema, repozytoria, outbox, migracje
docs/
  PLAN.md                          # ten plik
  adr/                             # ADR-001 … ADR-006
tests/
  unit/ contract/ e2e/ a11y/
```

Cztery paczki, nie osiem. Granice fizyczne od dnia 1, bo w pnpm są tanie, a „wydzielimy później" nigdy się nie zdarza.

---

## 5. Matryca narzędzi — serce bezpieczeństwa

| Klasa | Przykłady | Kto wykonuje | Dostęp modelu |
|---|---|---|---|
| **READ** | `get_artifact`, `search_items`, `list_attachments` | Serwer | Bezpośredni przez registry |
| **UI** | `focus_field`, `open_panel`, `highlight_range`, `switch_tab` | Klient (`useFrontendTool`) | Tylko z allowlisty capabilities |
| **PROPOSE** | `propose_patch`, `propose_action` | Serwer → zapisuje `agent_operations` | Tworzy trwałą propozycję |
| **MUTATING** | `apply_patch`, `delete_item` | **Nigdy przez model** | Wyłącznie use case po zgodzie |

Trzy niepodważalne reguły:

1. **Model nie ma w rejestrze ani jednego narzędzia klasy MUTATING.** Nie „ma, ale zablokowane" — nie ma go w liście podanej do LLM.
2. **`propose_patch` nie mutuje.** Zapisuje `AgentOperation` w stanie `pending` z `baseRevision` i zwraca `operationId`. To wszystko.
3. **Zatwierdzenie jest komendą HTTP**, nie tool callem. Frontend woła `POST /api/operations/:id/approve` (CSRF + auth), nie przechodzi przez model.

### 5.1. Kontekst podawany modelowi — ograniczony z definicji

Rich text kusi, żeby wysłać modelowi cały dokument. Nie robimy tego (szablon §11.2: *„selection: ograniczony tekst + revision"*). Narzędzia READ są celowo wąskie i **świadome rodzaju artefaktu**:

**Zakładka „dokument"**

| Narzędzie | Zwraca |
|---|---|
| `get_outline` | Drzewo nagłówków + `revision`. Tanie, daje orientację |
| `get_selection` | Zaznaczony tekst, `rangeId`, `revision`, ±N znaków kontekstu |
| `get_range(rangeId)` | Fragment z twardym limitem znaków |

**Zakładka „formularz"**

| Narzędzie | Zwraca |
|---|---|
| `get_form_schema` | Nazwy pól, typy, wymagalność, enumy. **Bez wartości** — sama struktura |
| `get_form_state` | Wartości + `revision` + status walidacji per pole |
| `get_field(path)` | Jedno pole: wartość, błąd walidacji, etykieta |

Powody są dwa i oba twarde: koszt tokenów rośnie liniowo z rozmiarem artefaktu przy **każdej** turze, a wszystko wrzucone do promptu to wszystko jako powierzchnia prompt injection.

Rozdzielenie `get_form_schema` od `get_form_state` nie jest kosmetyczne. Schemat jest stabilny i cache'owalny w prefiksie promptu; wartości zmieniają się co turę. Sklejenie ich w jedno narzędzie unieważniałoby cache przy każdej edycji pola.

### 5.2. Kształt propozycji

```ts
// packages/domain/src/operation.ts
type ProposePayload = {
  artifactId: string;
  baseRevision: number;   // rewizja, na której propozycja powstała
  rationale: string;      // dla człowieka, nie dla maszyny
} & (
  | { format: "pm-steps";   steps: StepJSON[] }      // kind: "document"
  | { format: "json-patch"; ops: JsonPatchOp[] }     // kind: "form"
);
```

`format` musi zgadzać się z `artifacts.kind` — niezgodność jest odrzucana przy tworzeniu propozycji, nie przy zatwierdzaniu.

**Model nie wylicza offsetów.** Narzędzie `propose_patch` przyjmuje intencję w kategoriach domenowych — identyfikator zakresu zwrócony wcześniej przez `get_selection` plus tekst docelowy — a `Steps` buduje z tego **serwer** przez `Transform`. LLM proszony o gołe pozycje znakowe pomyli się, a błąd offsetu w rich text nie jest widoczną awarią: to zapis w złym miejscu dokumentu.

#### Narzędzia PROPOSE są operacjami na artefakcie, nie generykiem

Model nie dostaje jednego `propose_patch`, tylko wąski zestaw czasowników dopasowanych do powierzchni.

**Zakładka „dokument"** — każdy przyjmuje `rangeId` (z `get_selection`) i zwraca `operationId`:

| Narzędzie | Intencja | Co buduje serwer |
|---|---|---|
| `propose_rewrite` | „przepisz to inaczej" | `replaceWith` na zakresie |
| `propose_shorten` / `propose_expand` | zmiana długości bez zmiany sensu | jw., z limitem odchylenia długości |
| `propose_fix` | poprawki językowe i interpunkcja | seria drobnych `replace` |
| `propose_insert` | dopisz akapit / przypis w miejscu | `insert` w pozycji |
| `propose_restructure` | zmień hierarchię nagłówków, podziel akapit | `setNodeMarkup` / `split` |
| `propose_delete` | usuń fragment | `delete` na zakresie |

**Zakładka „formularz"** — każdy przyjmuje ścieżkę pola i zwraca `operationId`:

| Narzędzie | Intencja | Co buduje serwer |
|---|---|---|
| `propose_field_change` | zmień wartość jednego pola | `replace` na `/path` |
| `propose_form_fill` | uzupełnij wiele pól naraz | seria `replace` / `add` |
| `propose_field_clear` | wyczyść pole | `remove` albo `replace` na `null` |

**Walidacja przy tworzeniu, nie przy zatwierdzaniu.** Serwer sprawdza proponowane wartości tym samym schematem Zod, którego używa formularz, **zanim** zapisze `agent_operations`. Propozycja niezgodna ze schematem nie powstaje. Użytkownik nigdy nie ogląda propozycji, której nie da się zastosować — a to jest realny scenariusz, bo model zaproponuje datę w złym formacie albo wartość spoza enuma częściej, niż się wydaje.

**`propose_form_fill` czytający dokument jest sensem posiadania obu powierzchni naraz.** Agent czyta treść w zakładce „dokument" i wypełnia z niej pola w zakładce „formularz". To jedyna operacja w tym systemie, która przekracza granicę artefaktów — i dlatego:

- tworzy **dwie** propozycje z jednym `correlationId`, nie jedną propozycję dotykającą dwóch artefaktów,
- każda jest zatwierdzana osobno, ze swoim `baseRevision`,
- panel pokazuje je jako parę z etykietą źródła („z sekcji *Dane klienta*").

Jedna propozycja obejmująca dwa agregaty złamałaby granicę transakcyjną i wymusiła dwufazowe zatwierdzanie. Nie warto.

Wąskie czasowniki dają trzy rzeczy naraz, których generyk nie daje: walidację specyficzną dla operacji (`propose_shorten`, które wydłuża tekst, odpada serwerowo), czytelną etykietę w panelu i w audycie, oraz dane o tym, o co użytkownik faktycznie prosi.

**`propose_patch` zostaje** jako furtka dla operacji spoza listy — ale jest oznaczony w audycie i to on pierwszy trafia pod lupę, gdy propozycje zaczną wyglądać dziwnie.

### 5.3. Schematy treści są artefaktami domenowymi

Obie powierzchnie mają schemat, który **musi być identyczny po stronie serwera i przeglądarki**, i obie płacą tę samą cenę za rozjazd.

| Powierzchnia | Schemat | Gdzie mieszka | Co się psuje przy rozjeździe |
|---|---|---|---|
| Dokument | ProseMirror | `packages/domain/src/pm-schema.ts` | `Step.fromJSON` rzuca przy otwarciu starego dokumentu |
| Formularz | Zod | `packages/domain/src/form-schema.ts` | Walidacja przepuszcza rekord, którego UI nie umie wyrenderować |

Zasady wspólne:

- Import przez **obie** strony z `packages/domain`, nigdy dwie kopie „zsynchronizowane ręcznie".
- Każdy ma `contentSchemaVersion`. Zmiana węzłów/marków albo pól/typów to **migracja**, tak samo jak zmiana kolumny w bazie.
- Treść zapisana pod starszą wersją przechodzi migrator, **zanim** serwer spróbuje ją zwalidować albo mapować na niej kroki.

Pominięcie tego jest klasyczną drogą do „działało w dev, produkcja rzuca `RangeError` przy otwarciu starego dokumentu".

### 5.4. Bramka zgody — jedna funkcja

```ts
// packages/application/src/approve-operation.ts
export async function approveOperation(
  cmd: { operationId: string; seenRevision: number },
  actor: Actor,
): Promise<Result<OperationApplied, DomainError>> {
  return withUnitOfWork(async (uow) => {
    const op = await uow.operations.findPending(cmd.operationId);
    if (!op) return err("OPERATION_NOT_PENDING");

    // 1. autoryzacja
    if (!policy.canApprove(actor, op)) return err("FORBIDDEN");

    // 2. użytkownik zatwierdza DOKŁADNIE tę wersję propozycji, którą widział.
    //    Rebase w międzyczasie → odmowa, klient przerysowuje i człowiek klika raz jeszcze.
    if (op.baseRevision !== cmd.seenRevision) return err("STALE_PROPOSAL");

    const doc = await uow.artifacts.byId(op.artifactId);
    if (doc.revision !== op.baseRevision) return err("STALE_REVISION");

    // 3. decyzja domenowa — aplikator zależy od rodzaju artefaktu,
    //    ścieżka autoryzacji nie zależy od niczego (ADR-009)
    const events = applyProposal(doc, op, actor);

    // 4. agregat + historia kroków + outbox w JEDNEJ transakcji
    await uow.artifacts.save(doc);
    await uow.revisions.append(doc.id, doc.revision, op.steps, op.id);
    await uow.operations.markApplied(op.id, actor);
    await uow.outbox.append(events);

    // 5. nowa rewizja unieważnia offsety pozostałych propozycji — przelicz je tu i teraz
    await rebasePending(uow, doc.id, op.baseRevision, doc.revision);

    return ok({ artifactId: doc.id, revision: doc.revision });
  });
}
```

Ta funkcja jest **jedynym** miejscem, gdzie propozycja staje się faktem. Jeśli w code review pojawi się drugie — to jest blocker, nie uwaga.

Rodzaj artefaktu wybiera wyłącznie **aplikator kroków**, nigdy ścieżkę autoryzacji:

```ts
// packages/domain/src/apply-proposal.ts
function applyProposal(a: Artifact, op: Operation, actor: Actor): DomainEvent[] {
  switch (op.format) {
    case "pm-steps":   return a.applySteps(op.steps, actor);   // kind: "document"
    case "json-patch": return a.applyOps(op.ops, actor);       // kind: "form"
  }
}
```

Dodanie trzeciej powierzchni to nowa gałąź `switch` i nowy walidator. **Nie** nowy endpoint zatwierdzania — patrz ADR-009.

### 5.5. Rebase propozycji — serwer jest właścicielem

> **Dotyczy wyłącznie `kind: "document"`.** Formularz (`json-patch`) rebase'u nie potrzebuje: konflikt to kolizja ścieżek, wykrywalna porównaniem zbiorów. Propozycja zmiany pola `/tytul` przeżywa dowolną liczbę edycji pola `/data` bez przeliczania. Cały koszt poniżej płaci jedna zakładka.

To najbardziej ryzykowna część systemu.

**Problem.** Propozycja powstaje na rewizji 7. Użytkownik dopisuje zdanie na początku akapitu. Offsety `from`/`to` w krokach propozycji wskazują teraz nie to miejsce, co trzeba. Twarde odrzucanie stale propozycji byłoby poprawne, ale bezużyteczne: przy edytorze tekstu propozycja umierałaby po każdym naciśnięciu klawisza.

**Rozwiązanie.** Po zapisie każdej nowej rewizji serwer przelicza wszystkie oczekujące propozycje dla tego artefaktu.

```ts
// packages/application/src/rebase-pending.ts
export async function rebasePending(
  uow: Uow, artifactId: string, from: number, to: number,
) {
  const between = await uow.revisions.stepsBetween(artifactId, from, to);
  const mapping = buildMapping(between);              // prosemirror-transform

  for (const op of await uow.operations.pendingFor(artifactId)) {
    const rebased: StepJSON[] = [];
    let conflict = false;

    for (const raw of op.steps) {
      const mapped = Step.fromJSON(schema, raw).map(mapping);
      if (!mapped) { conflict = true; break; }        // zakres zniknął — nie ma czego mapować
      rebased.push(mapped.toJSON());
    }

    if (conflict || op.rebaseCount >= MAX_REBASES) {
      await uow.operations.markConflicted(op.id);
      await uow.outbox.append(operationConflicted(op.id));
    } else {
      await uow.operations.rebase(op.id, rebased, to);
      await uow.outbox.append(operationRebased(op.id, to));
    }
  }
}
```

**Dlaczego serwer, a nie klient.** Gdyby rebase robił klient, klient i serwer mogłyby dojść do różnych wyników — a wtedy użytkownik zatwierdza jedno, zapisuje się drugie. To najgorsza klasa błędu w tym systemie, bo jest cicha. Serwer liczy, klient renderuje to, co dostał przez `STATE_DELTA`. Zgodne z ADR-005: baza jest prawdą.

**Inwariant do przetestowania, nie do założenia:**

> Decoration wyrenderowana użytkownikowi jest zbudowana z **tych samych** `steps`, które zastosuje `approveOperation`.

Test: wyrenderuj propozycję → wykonaj edycję wymuszającą rebase → zatwierdź → porównaj wynikowy dokument z tym, co pokazywała decoration po przerysowaniu.

**Wyścig, który zostaje.** Edycja może wpaść między wyrenderowaniem propozycji a kliknięciem „Zatwierdź". Wtedy `seenRevision` się nie zgadza i approve odpada z `STALE_PROPOSAL`. To jest **głośna, odwracalna porażka**: klient przerysowuje przeliczoną propozycję, użytkownik klika drugi raz. Świadomie wybieramy to zamiast cichego zastosowania czegoś, czego nikt nie oglądał.

**Ograniczniki.** `MAX_REBASES` (start: 20) i TTL propozycji. Bez nich propozycja może wisieć w nieskończoność, przeliczana przy każdej literze, coraz mniej podobna do tego, co agent miał na myśli.

**Koszt w danych.** `artifact_revisions` musi trzymać **kroki**, nie tylko snapshoty — bez nich nie da się zbudować `Mapping`. Snapshot co K rewizji zostaje, ale dla szybkiego ładowania, nie dla rebase'u.

### 5.6. Cofanie — jedna reguła, która trzyma resztę

W edytorze tekstu Ctrl+Z jest odruchem, nie funkcją. Musi działać także na zmianę, którą przed chwilą wprowadził agent — z punktu widzenia użytkownika to po prostu ostatnia rzecz, która zmieniła dokument.

**Reguła:** cofnięcie tworzy **nową rewizję**, nigdy nie cofa licznika `revision`.

To nie jest formalność. Gdyby cofnięcie przewijało `revision` wstecz, pękłyby trzy rzeczy naraz: append-only w `artifact_revisions` (§8), `baseRevision` wszystkich oczekujących propozycji, oraz `Mapping` budowany przez przejście kroków do przodu (§5.5). Zamiast tego Ctrl+Z generuje kroki odwrotne i wysyła je **tą samą ścieżką zapisu**, co każda inna edycja użytkownika → rewizja N+2, której kroki są odwrotnością N+1.

Konsekwencje, które z tego wypadają za darmo:

- Cofnięcie to nowa rewizja, więc **automatycznie odpala `rebasePending`**. Mechanizm składa się sam, bez przypadku szczególnego.
- Zatwierdzona zmiana agenta wchodzi do lokalnego stosu historii (`addToHistory: true`), więc Ctrl+Z zachowuje się dokładnie tak, jak użytkownik oczekuje: cofa ostatnią zmianę niezależnie od tego, kto ją wprowadził.
- Obok Ctrl+Z toast po zatwierdzeniu ma jawne **„Cofnij"** — sam skrót klawiszowy nie jest dostępną afordancją.

**Sygnał produktowy, który warto zbierać od początku:** `audit_log` zapisuje cofnięcie jako osobną akcję z referencją do cofniętej operacji. Wysoki odsetek „zatwierdź → natychmiast cofnij" oznacza, że propozycje agenta są słabe — i lepiej to widzieć w danych niż domyślać się z opinii.

### 5.7. Idempotencja

Podwójne kliknięcie „Zatwierdź" i retry po timeoutcie mają dać jeden skutek. Mechanizm: stan terminalny operacji (`pending → applied` jest przejściem jednokierunkowym, wymuszonym `UPDATE … WHERE status='pending'` z kontrolą liczby zmienionych wierszy) + `Idempotency-Key` na tworzeniu runów i uploadach.

---

## 6. Kontrakt strumienia

### 6.1. Kanał agenta — AG-UI

Jeden endpoint, jeden strumień. Typy zdarzeń, na których stoi UI:

| Zdarzenie | Co robi UI |
|---|---|
| `RUN_STARTED` / `RUN_FINISHED` | Ramka runu, stan „agent pracuje" |
| `TEXT_MESSAGE_START` / `_CONTENT` / `_END` | Progresywny render tekstu w live region |
| `TOOL_CALL_START` / `_ARGS` / `_END` / `_RESULT` | Karta narzędzia: szkielet → częściowe argumenty → wynik |
| `STATE_SNAPSHOT` | Pełna projekcja stanu współdzielonego (po reconnect) |
| `STATE_DELTA` | JSON Patch — inkrementalna aktualizacja powierzchni |
| `CUSTOM` | Zdarzenia domenowe wystawione do UI (`operation.proposed`) |

Stan współdzielony (`useCoAgent`) to **projekcja read-model**, nie baza. Jeśli klient i serwer się rozjadą, prawdą jest serwer — `STATE_SNAPSHOT` nadpisuje.

### 6.2. Replay i reconnect

`SqliteAgentRunner.connect(threadId)` odtwarza zdarzenia wątku z dysku, zanim klient wejdzie w live. To realizuje „replayable realtime" z §2 szablonu bez budowania własnego outboxu na starcie.

Wymagania, które muszą przejść testy:

- Kill procesu w połowie streamu → po restarcie klient dostaje pełną historię i domyka run.
- Zamknięcie karty w trakcie `await_approval` → po powrocie widoczna ta sama pending operation.
- Luka retencyjna → jawny sygnał `resync_required`, klient pobiera snapshot. Nie cicha niespójność.

### 6.3. Envelope zdarzeń domenowych

Outbox (`events`) — dla zdarzeń biznesowych niezależnych od runu agenta:

| Pole | Opis |
|---|---|
| `id` | Monotoniczny, źródło replayu |
| `event_type` | Z wersją: `artifact.updated.v1` |
| `occurred_at` | Czas faktu |
| `aggregate_id` | Źródło |
| `correlation_id` | Łączy komendę / run / job |
| `causation_id` | Co to wywołało |
| `schema_version` | Wersja payloadu |
| `payload` | Minimum. **Bez BLOB-ów, bez sekretów** |

---

### 6.4. Semantyczny kontekst UI — agent musi wiedzieć, gdzie jest użytkownik

Przy jednej powierzchni to było wygodne. Przy zakładkach jest konieczne: bez tego agent proponuje zmianę pola, gdy użytkownik redaguje akapit.

Kontekst leci jako `properties` z `<CopilotKit>` i ląduje w `input.forwardedProps` po stronie runtime'u (§3).

| Pole | Przekazujemy | **Nie** przekazujemy |
|---|---|---|
| `activeTab` | Stabilne ID zakładki (`"document"`, `"form"`) | Selektorów DOM, nazw komponentów |
| `activeField` | Kanoniczna ścieżka pola (`"/klient/nip"`) | Współrzędnych ekranu, `id` z HTML-a |
| `selection` | `rangeId` + ograniczony tekst + `revision` | Pełnego dokumentu |
| `validation` | Podsumowanie + błędy aktualnie widoczne | Całej historii walidacji |
| `capabilities` | Allowlista narzędzi klienckich dla tej zakładki | Niczego, co pozwoliłoby modelowi nazwać narzędzie spoza listy |

**Stabilne ID, nigdy selektory DOM.** Selektor przeżyje do pierwszego refaktoru markupu, a wtedy agent zacznie się mylić w sposób, którego nikt nie powiąże ze zmianą w CSS-ie. ID zakładki i ścieżka pola są kontraktem — zmieniają się świadomie, jak każdy inny kontrakt.

**`capabilities` jest per zakładka.** W formularzu nie ma `propose_rewrite`, w dokumencie nie ma `propose_field_change`. Model dostaje tylko to, co ma sens tam, gdzie stoi użytkownik — mniej okazji do pomyłki i krótszy prompt.

### 6.5. Jeden kontrakt — AG-UI niesie także gen-UI

Rozważaliśmy drugi format (OpenUI Lang) obok AG-UI. **Okazał się niepotrzebny**: gen-UI jest częścią darmowego OSS CopilotKit i jedzie tym samym strumieniem AG-UI.

Mechanizm: narzędzie rejestrowane przez `useFrontendTool` ma funkcję `render`. Model woła narzędzie z argumentami, AG-UI niesie `TOOL_CALL_ARGS` i `TOOL_CALL_RESULT`, a `render` zamienia argumenty na komponent. Streaming działa z definicji, bo argumenty przychodzą częściowo — to jest ta sama ścieżka, która daje karty narzędzi z §7.1.

| Warstwa | Kto niesie | Co opisuje |
|---|---|---|
| Zdarzenia runu | AG-UI | `RUN_*`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `STATE_SNAPSHOT/DELTA`, interrupt |
| Co wyrenderować | `render` przy zarejestrowanym narzędziu | Komponent + propsy z argumentów wywołania |

**Zysk: jeden kontrakt do wersjonowania zamiast dwóch.** Rejestr komponentów nadal istnieje (§7.6), ale jest po prostu **zbiorem zarejestrowanych narzędzi z `render`** — nie osobnym językiem opisu UI. Wersjonuje się razem ze schematami narzędzi.

## 7. Płynne UI — wymagania wykonawcze

To nie jest sekcja „ładny wygląd". To lista rzeczy, których brak sprawia, że strumieniowy agent *wygląda* na zepsuty, nawet gdy działa.

### 7.0. Układ — zakładki jako powierzchnia główna, chat jako pomoc

Chat nie może być bohaterem ekranu. Człowiek przychodzi pisać i wypełniać, nie rozmawiać.

```
┌───────────────────────────────────────────────┬──────────────┐
│  [ Dokument ]  [ Formularz ②]  [ Źródła ]     │              │
├───────────────────────────────────────────────┤  Chat +      │
│                                               │  panel       │
│   AKTYWNA POWIERZCHNIA                        │  propozycji  │
│   edytor TipTap  albo  formularz              │              │
│   — decorations / podświetlenia pól inline    │  wspólny dla │
│                                               │  wszystkich  │
│   ┌────────────────────────┐                  │  zakładek;   │
│   │ ✦ Selection Action Bar │ ← przy           │  zwijany     │
│   └────────────────────────┘   zaznaczeniu    │              │
└───────────────────────────────────────────────┴──────────────┘
      ② = liczba oczekujących propozycji w tej zakładce
```

**Wejście do agenta jest w powierzchni, nie w czacie.** W dokumencie to Selection Action Bar: zaznaczenie pokazuje pływający pasek z czasownikami z §5.2 — *Przepisz · Skróć · Rozwiń · Popraw* — plus pole na własne polecenie. W formularzu to afordancja przy aktywnym polu — *„Zapytaj agenta o to pole"*. Czat zostaje dla rzeczy nieprzypisanych do fragmentu ani pola: *„uzupełnij formularz z treści dokumentu"*, *„sprawdź spójność terminologii"*.

#### Reguła zakładek — agent sygnalizuje, nie przełącza

Propozycja w zakładce, której użytkownik nie ogląda, pokazuje się jako **plakietka z licznikiem**. Widok się nie zmienia.

- **Agent może przełączyć zakładkę na wyraźną prośbę** („pokaż mi formularz"). To jest wykonanie polecenia.
- **Agent nie może przełączyć zakładki, żeby pokazać własną pracę.** To jest porwanie kontekstu — użytkownik traci miejsce, w którym pisał, żeby zobaczyć coś, o co nie prosił.

Rozróżnienie jest wykonalne, bo `switch_tab` jest narzędziem klienckim wołanym w turze, która ma polecenie użytkownika, a nie efektem ubocznym `propose_*`.

#### Panel propozycji jest wspólny dla zakładek

Jedno miejsce z wszystkimi oczekującymi propozycjami, każda z etykietą zakładki i fragmentu. Panel per zakładka zmusiłby użytkownika do polowania na to, co agent zrobił — a przy `propose_form_fill`, który produkuje parę powiązanych propozycji w dwóch zakładkach (§5.2), byłoby to wprost mylące.

#### Pozostałe zasady układu

- **Panel boczny jest zwijany i praca bez niego jest możliwa.** Jeśli z zamkniętym panelem nie da się pisać ani wypełniać, produkt jest czatem z edytorem, a nie workspace'em z agentem.
- **Aktywna powierzchnia nigdy nie traci fokusu** przy propozycji, streamie ani toaście. Człowiek pracuje w trakcie pracy agenta — to stan normalny, nie wyjątek.
- **Szerokość kolumny tekstu ograniczona** (~70 znaków) niezależnie od okna. Panel zabiera miejsce ekranu, nie miejsce tekstu.
- **Zakładki mają stabilne ID** i są adresowalne w URL — deep link do zakładki działa po odświeżeniu i po reconnect.

### 7.1. Renderowanie strumienia

- **Zero skoków layoutu.** Kontenery tekstu i kart narzędzi mają zarezerwowaną wysokość minimalną. Nowy token nigdy nie przesuwa treści, którą użytkownik właśnie czyta.
- **Trzy stany karty narzędzia:** `pending` (szkielet) → `executing` (częściowe argumenty, spinner) → `complete` (wynik). Przejścia animowane, nie skokowe.
- **Progres agenta z `useCoAgentStateRender`** — pokazuj *co* agent robi (`nodeName`, `status`), nie tylko że „myśli".
- **Batching tokenów w rAF.** Render per-token zabija main thread; buforuj do ramki.
- **Autoscroll ustępuje użytkownikowi.** Gdy użytkownik przewinie w górę, przypnij pozycję i pokaż „↓ nowe wiadomości". Nie ściągaj widoku siłą.

### 7.2. Agent steruje UI — bez porywania kontroli

- **User gesture wins.** Ręczna zmiana fokusu lub zakładki unieważnia oczekujące `focus_field` / `switch_tab` od agenta. Zawsze. Bez wyjątków.
- **Zakładka to najdroższa rzecz, jaką agent może zabrać.** `switch_tab` wolno tylko w turze z wyraźnym poleceniem użytkownika (§7.0). Nigdy jako efekt uboczny propozycji.
- **Każda akcja UI agenta jest widoczna i odwracalna** — krótki toast „Agent otworzył zakładkę Źródła" z „Cofnij".
- **`prefers-reduced-motion`** wyłącza przejścia, zostawia zmiany stanu.
- **Bez modali od agenta.** Propozycje żyją w panelu bocznym i jako inline decoration; nie blokują pracy.

### 7.3. Warstwa propozycji

- Inline diff / ghost text renderuje `DecorationSet` zbudowany z `steps` propozycji. **To nie jest jej trwałość** — trwałość to rekord `agent_operations` na serwerze.
- **Wymagany alternatywny panel listy propozycji.** Gdy decoration wypada poza viewport albo użytkownik pracuje z klawiatury — panel jest jedyną dostępną drogą. To nie jest opcja, to warunek dostępności.
- Akceptuj / Odrzuć wysyłają komendę z `seenRevision` i pokazują stan optymistyczny z rollbackiem przy błędzie.

Rich text dokłada trzy stany, których wariant JSON by nie miał:

| Stan propozycji | Co widzi użytkownik |
|---|---|
| `rebased` (offsety przeliczone po edycji) | Decoration **przeskakuje w nowe miejsce bez migotania**. Bez toastu — to jest normalna praca, nie zdarzenie |
| `conflicted` (zakres zniknął) | Decoration znika, w panelu wpis „Propozycja straciła kontekst" + przycisk „Poproś agenta ponownie" |
| `STALE_PROPOSAL` po kliknięciu | Przycisk wraca do stanu aktywnego, decoration przerysowuje się na aktualną wersję, krótkie „Dokument się zmienił — sprawdź i zatwierdź" |

Ostatni wiersz jest celowo widoczny. Cicha akceptacja przeliczonej propozycji oznaczałaby, że użytkownik zatwierdził coś, czego nie oglądał.

### 7.4. Dostępność (bramka, nie życzenie)

- Strumieniowany tekst w `aria-live="polite"`; zmiana statusu runu w `aria-live="assertive"`.
- Pełna obsługa klawiatury dla accept/reject, z widocznym focus ringiem.
- Kontrast AA na wszystkich stanach kart narzędzi (łatwo przegapić stan `pending`).
- `axe-core` w CI blokuje merge przy regresji.

### 7.5. Stany brzegowe, które trzeba zaprojektować, nie odkryć

| Stan | Co widzi użytkownik |
|---|---|
| Brak klucza LLM | Panel setupu, nie błąd. Chat nieaktywny z wyjaśnieniem |
| Klucz odrzucony (401) | „Klucz odrzucony przez providera" + link do ustawień. **Bez treści odpowiedzi providera** |
| Utrata połączenia | Baner „Ponawiam…", strumień wznawia się sam, historia zachowana |
| `resync_required` | Cichy refetch snapshotu + jednorazowy toast |
| Run przekroczył budżet | Run zamknięty jawnym komunikatem, propozycje częściowe zachowane |

---

### 7.6. Trzy klasy powierzchni — co agent komponuje, a czego nie dotyka

Gen-UI wprowadza rozróżnienie, którego wcześniej nie było. Bez niego „generative UI" zjadłoby edytor.

| Klasa | Przykłady | Kto projektuje | Kontrakt |
|---|---|---|---|
| **Stała** | Zakładka dokumentu (TipTap), zakładka formularza (Zod), nawigacja, ustawienia | Programista, w kodzie | Zwykły React. Agent **nie dotyka** |
| **Komponowana** | Odpowiedzi w czacie, zestawienia, porównania, podsumowania wyników, doraźne widoki | Agent, z rejestru | `useFrontendTool` + `render`: model wybiera narzędzie, my renderujemy komponent |
| **Nakładkowa** | Inline diff, ghost text, podświetlenia pól, plakietki zakładek | Programista, sterowane danymi propozycji | `DecorationSet` / stany z §7.3 |

**Edytor i formularz są stałe i takie zostają.** Model nie generuje powierzchni, na której człowiek pracuje — generuje powierzchnie, na których agent *pokazuje*. To rozróżnienie jest tanie do utrzymania i eliminuje całą klasę pytań w rodzaju „co, jeśli agent przebuduje formularz w trakcie wypełniania".

#### Rejestr komponentów jest allowlistą

Dokładnie ten sam wzorzec, co schemat ProseMirror w §5.3 — z tą wygodą, że przy `useFrontendTool` **allowlista powstaje sama**: model może wywołać wyłącznie zarejestrowane narzędzie, a nieznanej nazwy po prostu nie ma w liście podanej do modelu.

- Rejestr mieszka w `packages/domain` obok schematów narzędzi i jest z nimi wersjonowany.
- Argumenty walidowane Zodem per narzędzie — to ta sama walidacja, co dla każdego innego toola.
- Brak `dangerouslySetInnerHTML`, brak przekazywania surowego HTML-a jako propa. Model dostarcza **dane**, nie markup.
- Nieznane narzędzie → wywołanie odrzucone przed renderem, w logu wpis z `runId`.

#### Akcje w powierzchni komponowanej nie są nową ścieżką zapisu

Przycisk w wygenerowanym panelu **nie może** wykonać dowolnej akcji. Wiąże się wyłącznie z:

- narzędziem klienckim z `capabilities` tej zakładki (§6.4), albo
- komendą zatwierdzenia/odrzucenia istniejącej propozycji.

Innymi słowy: agent może narysować przycisk „Zatwierdź", ale ten przycisk woła to samo `POST /api/operations/:id/approve`, co panel propozycji. **Nie ma drugiej ścieżki mutacji** — ADR-006 i ADR-009 obowiązują tak samo w powierzchni komponowanej.

## 8. Model danych (minimum)

| Tabela | Kluczowe kolumny | Constrainty |
|---|---|---|
| `artifacts` | `id`, **`kind`**, `revision`, `content_json`, `content_schema_version` | `kind CHECK IN (document,form)`, `UNIQUE(scope_id, kind)`, `revision` monotoniczna |
| `artifact_revisions` | `artifact_id`, `revision`, `parent_revision`, **`patch_json`**, `operation_id`, `snapshot_json?` | Append-only. Dla `document` `patch_json` to kroki PM i jest **wymagane** (bez niego nie ma `Mapping` do rebase'u); dla `form` to operacje JSON Patch |
| `agent_operations` | `id`, `thread_id`, `artifact_id`, **`format`**, `verb`, **`patch_json`**, `base_revision`, **`rebase_count`**, `status`, `rationale`, `correlation_id`, `actor`, `decided_at` | `format CHECK IN (pm-steps,json-patch)` **zgodny z `artifacts.kind`**; `status CHECK IN (pending,rebased,conflicted,approved,rejected,expired,applied)`; terminal nieodwracalny |
| `sessions` | `id`, `created_at`, `last_seen_at`, `expires_at` | TTL wymuszony w zapytaniu, nie tylko w cronie |
| `auth_secret` | `pin_hash` (scrypt), `salt`, `failed_attempts`, `locked_until` | Jeden wiersz. Blokada po N nieudanych próbach |
| `events` | `id`, `event_type`, `aggregate_id`, `correlation_id`, `causation_id`, `schema_version`, `payload` | Monotoniczne `id`, insert-only |
| `audit_log` | `actor`, `action`, `target`, `revision`, `at` | Insert-only |

Wątki i wiadomości agenta trzyma `SqliteAgentRunner` w swojej bazie. **Nie duplikujemy ich w schemacie domenowym** — to byłoby drugie źródło prawdy dla tego samego faktu.

### Profil SQLite (na każdym connection)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

**Reguła twarda:** żadnej otwartej transakcji podczas oczekiwania na LLM, na sieć ani na wysyłkę do strumienia. Transakcje krótkie, wyłącznie wokół zapisu agregatu i outboxu.

### JSON vs kolumny

`content_json` i `patch_json` są JSON-em, bo taki jest ich natywny format. Ale wszystko, po czym filtrujemy, autoryzujemy lub sprawdzamy integralność — `kind`, `format`, `status`, `revision`, `base_revision`, `rebase_count`, `correlation_id` — to **kolumny**. Każdy payload JSON ma wersję schematu, limit rozmiaru i migrator aplikacyjny.

`content_json` jest polimorficzny i dyskryminowany przez `kind`: dla `document` trzyma dokument ProseMirror, dla `form` — rekord walidowany Zodem. `content_schema_version` odnosi się do właściwego schematu (PM albo Zod), zależnie od `kind`.

Trzy wersje, których nie wolno pomylić, bo zmieniają się niezależnie i każda potrzebuje własnego migratora:

| Wersja | Czego dotyczy |
|---|---|
| `content_schema_version` przy `kind: document` | Schemat ProseMirror — jakie węzły i marki są legalne |
| `content_schema_version` przy `kind: form` | Schemat Zod formularza — jakie pola i typy |
| Wersja migracji Drizzle | Kształt samych tabel |

---

## 9. Plan wdrożenia

### E0 — Spike weryfikacyjny (1–2 dni) · *dowód, nie kod produkcyjny*

Cel: rozbroić ryzyka integracyjne, zanim powstanie architektura wokół nich.

- [ ] `pnpm create next-app` + `@copilotkit/react-core` + `runtime/v2` — pusty czat działa end-to-end
- [ ] **Fabryka agenta per-request** czyta `x-llm-api-key` i buduje provider (potwierdzenie kształtu API)
- [ ] `createOpenAICompatible` przeciwko **LiteLLM**, za nim Ollama — tryb B działa bez klucza w aplikacji
- [ ] **Próba tool callingu: 20 przebiegów, próg 95%** na modelu docelowym. Poniżej progu → ścieżka awaryjna z §3
- [ ] **Spike rebase'u ProseMirror** *(najważniejszy punkt E0)* — patrz niżej
- [ ] `useFrontendTool` z `renderAndWaitForResponse` — HITL wraca poprawnie do modelu
- [ ] `useCoAgent` — dwustronna synchronizacja stanu
- [ ] `SqliteAgentRunner` + zabicie procesu w połowie streamu → reconnect odtwarza wątek
- [ ] **Przypięcie wszystkich wersji** (`pnpm-lock.yaml` w repo) i zapis odchyleń od tego planu

#### Audyt open-core — bramka, nie notatka *(§2.4)*

- [ ] **Podsłuch ruchu sieciowego przez cały spike.** Jedyny dozwolony ruch wychodzący to `LLM_BASE_URL`. Każde inne żądanie — do CopilotKit, do thesys, gdziekolwiek — jest znaleziskiem
- [ ] `@copilotkit/react-core`: `useCoAgent` i `useFrontendTool` działają **bez licencji i bez konta**
- [ ] `@copilotkit/runtime/v2` + `SqliteAgentRunner`: pełna pętla bez wywołań do CopilotKit Intelligence
- [ ] `CopilotChat` **i gen-UI przez `useFrontendTool` + `render`** działają bez klucza licencyjnego
- [ ] **Headless UI** (jeśli będzie potrzebne) — dokumentacja mówi o **darmowym** kluczu z rejestracji; sprawdzić, czy waliduje się offline i czy prebuilt chat wystarczy bez niego
- [ ] **Licencja repo** potwierdzona z pliku `LICENSE` — materiały mówią raz MIT, raz Apache 2.0
- [ ] Nieznane narzędzie: wywołanie odrzucone **przed** renderem, z czytelnym komunikatem
- [ ] Każda zależność ścieżki krytycznej przeszła trzy pytania z §2.4; wynik zapisany w tabeli

**Jeśli którakolwiek funkcja warstwy renderującej okaże się za bramką** — to zmiana modelu biznesowego CopilotKit, nie doprecyzowanie. Wtedy audyt §2.4 od nowa i decyzja o warstwie UI wraca na stół.

#### Spike rebase'u — kryteria zaliczenia

Poza aplikacją, na gołym `prosemirror-transform`. Cztery scenariusze:

| Scenariusz | Oczekiwane |
|---|---|
| Edycja **przed** zakresem propozycji | Kroki mapują się, offsety przesunięte, treść identyczna |
| Edycja **wewnątrz** zakresu propozycji | Kroki mapują się albo jawny konflikt — **nigdy cichy zapis obok** |
| **Usunięcie** zakresu propozycji | `step.map()` zwraca `null` → status `conflicted` |
| 20 kolejnych edycji, propozycja żyje cały czas | Brak dryfu; wynik identyczny z zastosowaniem propozycji na końcu |

**Jeśli scenariusz 2 nie daje deterministycznego wyniku, plan wraca do rewizji** — wtedy artefakt idzie w stronę bloków strukturalnych (akapit/sekcja jako adresowalna jednostka) zamiast swobodnych offsetów znakowych. Lepiej dowiedzieć się tego w dniu drugim niż w E2.

**Wyjście:** ADR-001..010 przechodzą z *Proposed* w *Accepted*, z poprawkami z E0.

### E1 — MVP: płynne UI + jeden strumień (~1,5 tygodnia)

> Estymata urosła z tygodnia po decyzjach z 2026-08-16: TipTap ze wspólnym schematem ~2 dni, PIN + CSRF + `Actor` ~1 dzień, druga powierzchnia (formularz + zakładki + kontekst UI) ~2 dni.

**Fundament**

- [ ] Monorepo z granicami `domain` / `application` / `agent` / `db` + lint zależności
- [ ] **Dwa schematy w `packages/domain`**, importowane przez serwer i przeglądarkę: ProseMirror (dokument) i Zod (formularz), oba z `content_schema_version`
- [ ] Schemat Drizzle z `kind` i `format`, pierwsza migracja + drill fresh/upgrade
- [ ] `Actor` jako **wymagany** argument każdego use case'u; repozytoria bez metod bez scope'u

**Wejście**

- [ ] **Uwierzytelnienie PIN**: `scrypt` + `timingSafeEqual`, cookie sesyjne, blokada po N próbach
- [ ] **CSRF na wszystkich komendach mutujących** + kontrola `Origin` / `Sec-Fetch-Site`; sesja sprawdzana także na endpoincie strumienia
- [ ] `/settings` z BYOK + `/api/llm/status`; LiteLLM w `compose.yaml`

**Powierzchnie**

- [ ] **Zakładki ze stabilnymi ID**, adresowalne w URL, z plakietką liczby oczekujących propozycji
- [ ] Edytor TipTap + zapis rewizji (`patch_json` do `artifact_revisions`)
- [ ] **Formularz** na schemacie Zod: walidacja per pole, ten sam schemat po obu stronach
- [ ] **Selection Action Bar** (dokument) + afordancja przy aktywnym polu (formularz)
- [ ] **Cofanie tą samą ścieżką zapisu** (§5.6): Ctrl+Z → kroki odwrotne → nowa rewizja, nigdy cofnięcie licznika
- [ ] Układ z §7.0: zakładki jako powierzchnia główna, **wspólny** panel propozycji, praca możliwa z panelem zamkniętym
- [ ] **Rejestr komponentów jako narzędzia z `render`** (`useFrontendTool`), wersjonowany razem ze schematami narzędzi; argumenty walidowane Zodem
- [ ] Powierzchnie komponowane (§7.6) renderują się przez `render`, **bez** zewnętrznej biblioteki gen-UI
- [ ] **Własny `ThreadsPanel`** przeciwko `/api/threads` — lista, wybór, tworzenie rozmowy; zero zależności od CopilotKit Intelligence
- [ ] Przyciski w powierzchni komponowanej wiążą się **wyłącznie** z `capabilities` zakładki albo z komendą approve/reject — test to sprawdza

**Agent**

- [ ] Narzędzia **READ** świadome rodzaju: `get_outline` / `get_selection` / `get_range` oraz `get_form_schema` / `get_form_state` / `get_field`, wszystkie z limitami
- [ ] **Semantyczny kontekst UI** (§6.4) przez `properties` → `forwardedProps`: `activeTab`, `activeField`, `selection`, `validation`
- [ ] **`capabilities` per zakładka** — model widzi tylko narzędzia sensowne tam, gdzie stoi użytkownik
- [ ] `switch_tab` dozwolone **wyłącznie** w turze z poleceniem użytkownika; test pilnuje, że nie jest efektem ubocznym `propose_*`
- [ ] Streaming z §7.1 w komplecie — bez skoków layoutu, batching w rAF, autoscroll ustępuje
- [ ] Wszystkie stany brzegowe z §7.5 mają zaprojektowany widok

**DoD:** agent czyta ograniczony kontekst **obu** powierzchni, wie w której zakładce jest użytkownik, sygnalizuje bez porywania widoku i streamuje płynnie; wejście chronione PIN-em. **Jeszcze nic nie mutuje.**

### E2 — Bramka zgody + rebase + trwałość (~1,5 tygodnia)

> Rebase i jego testy to ok. 3 dni ponad pierwotną estymatę. To jest koszt rich textu i był znany przy podejmowaniu decyzji.

- [ ] Czasowniki `propose_*` (dokument i formularz) → serwer buduje patch z intencji → rekord `agent_operations`
- [ ] **Walidacja Zod przy tworzeniu propozycji formularza** — niezgodna nie powstaje, użytkownik jej nie widzi
- [ ] `approveOperation` / `rejectOperation` jako **jedyna** ścieżka mutacji, z `applyProposal` dyspozycjonującym po `format`
- [ ] `propose_form_fill` z dokumentu → **para** propozycji ze wspólnym `correlation_id`, zatwierdzane osobno
- [ ] **`rebasePending` po każdej nowej rewizji dokumentu** + `MAX_REBASES` + TTL propozycji
- [ ] Kontrola `seenRevision` → `STALE_PROPOSAL` z przerysowaniem po stronie klienta
- [ ] Stany `rebased` / `conflicted` w `STATE_DELTA` i w UI (§7.3)
- [ ] Outbox `events` w tej samej transakcji co agregat i co rebase
- [ ] Inline diff z `DecorationSet` **+ obowiązkowy** panel listy propozycji
- [ ] Audit log: kto, co, kiedy, na jakiej rewizji, po ilu rebase'ach
- [ ] Testy: dwa równoległe approve → jeden skutek; approve po rebase → `STALE_PROPOSAL`; usunięcie zakresu → `conflicted`
- [ ] **Test inwariantu z §5.5:** decoration po rebase == wynik `approveOperation`
- [ ] Test cofania: zatwierdź → Ctrl+Z → `revision` **rośnie** do N+2, dokument wraca do stanu N, oczekujące propozycje przeliczone
- [ ] `audit_log` rozróżnia „zatwierdzenie" i „cofnięcie zatwierdzonej operacji"
- [ ] Test formularza: kolizja ścieżek → konflikt; edycja `/a` nie unieważnia propozycji na `/b`
- [ ] **Test jednej bramki (ADR-009):** obie ścieżki (`pm-steps`, `json-patch`) przechodzą przez `approveOperation`; grep po repo nie znajduje drugiego zapisu do `artifacts`

**DoD:** żadna ścieżka nie zapisuje z pominięciem bramki, a to, co użytkownik widział, jest dokładnie tym, co zostało zapisane. Weryfikowane testem, nie przeglądem.

### E3 — Hardening (1 tydzień)

- [ ] Budżety runu: kroki, tool calls, czas, tokeny — **wymuszane serwerowo**
- [ ] Rate limit na tworzenie runów i na endpointy komend
- [ ] Sanityzacja: rozmiar wyniku narzędzia, Markdown bez raw HTML, redakcja sekretów w logach
- [ ] Backup SQLite (online backup API) + **wykonany drill restore**
- [ ] Structured logging z `correlationId` / `runId` / `operationId`
- [ ] Bramka a11y (`axe`) i security baseline w CI
- [ ] E2E: reconnect, approval, resume po restarcie

**DoD:** release gate z §16.1 szablonu jest zielony.

### E4 — Skala (tylko na sygnał)

Nic z tego etapu nie wchodzi bez pomiaru. Patrz §12.

---

## 10. Testy i bramki

| Warstwa | Co musi być pokryte |
|---|---|
| Domena | Invarianty rewizji, przejścia stanów operacji, polityki |
| Application | Idempotencja approve, rollback UoW, atomowość outboxu |
| Repozytorium | FK, constrainty, migracja JSON, współbieżność |
| Agent battery | Model **nie ma** narzędzi MUTATING · odmowy · budżety · interrupt/resume · prompt injection |
| **Rebase** (`document`) | Cztery scenariusze z E0 · `MAX_REBASES` · TTL · **inwariant „widziane == zapisane"** · property test: N losowych edycji, brak dryfu |
| **Formularz** (`json-patch`) | Kolizja ścieżek → konflikt; niezależność ścieżek; propozycja niezgodna z Zodem **nie powstaje** |
| **Jedna bramka** | Oba `format` przez `approveOperation`; brak drugiego zapisu do `artifacts` w całym repo |
| **Międzypowierzchniowe** | `propose_form_fill` tworzy parę ze wspólnym `correlation_id`; odrzucenie jednej nie blokuje drugiej |
| **Rejestr komponentów** | Węzeł spoza rejestru odrzucony przed renderem; propsy walidowane Zodem; brak `dangerouslySetInnerHTML` w całym repo |
| **Izolacja sieciowa** | Smoke test nie generuje ruchu poza `LLM_BASE_URL` |
| **Kontekst UI** | `activeTab` / `activeField` docierają do modelu; `capabilities` per zakładka nie przecieka |
| **Zakładki** | `switch_tab` nie odpala się jako efekt uboczny `propose_*`; ręczna zmiana zakładki unieważnia oczekujące `switch_tab` |
| **Schematy treści** | Dokument w starej wersji schematu PM ładuje się po migracji (`Step.fromJSON` nie rzuca); rekord w starej wersji schematu Zod migruje się przed walidacją |
| Contract | Zod ↔ schematy narzędzi ↔ typy AG-UI |
| Stream | Replay, reconnect, kill-mid-stream, `resync_required` |
| E2E | Propozycja → edycja wymuszająca rebase → zgoda → aktualizacja UI → reconnect |
| A11y | Klawiatura, live regions, focus, kontrast, overlays, **skok decoration po rebase nie kradnie fokusu** |
| Security | Macierz authz, brute-force PIN-u, CSRF, XSS w Markdown, wyciek klucza do logów/eventów |

### Release gate

- [ ] Pełny suite zielony, brak wyłączonych testów bez zaakceptowanego wyjątku
- [ ] Fresh DB i upgrade z poprzedniej wersji dochodzą do tego samego head migracji
- [ ] Backup został **odtworzony**, nie tylko utworzony
- [ ] E2E potwierdza reconnect strumienia i resume agenta po restarcie
- [ ] Skan zależności i sekretów bez blockerów; audyt a11y bez blockerów
- [ ] **Grep na klucz LLM w logach, eventach i checkpointach zwraca zero trafień**
- [ ] **Żadna funkcja w ścieżce krytycznej nie wymaga licencji ani cudzej chmury** — potwierdzone podsłuchem ruchu w smoke teście, nie deklaracją w README zależności (§2.4)

---

## 11. Bezpieczeństwo

| Zagrożenie | Kontrola w tym planie |
|---|---|
| Prompt injection | Treść zewnętrzna jako **dane**, nie instrukcje; allowlista narzędzi; brak MUTATING w rejestrze modelu |
| Tool abuse | Zod na wejściu, policy check w use case, rate limit, budżety runu |
| Approval bypass | Jedna funkcja mutująca; test kontraktowy pilnuje, że nie ma drugiej |
| Stale write | `baseRevision` + `seenRevision` + rebase po stronie serwera (§5.5) |
| **Zapis niezgodny z podglądem** | Inwariant „decoration == zastosowane kroki", wymuszony testem w E2 |
| Wyciek klucza LLM | `sessionStorage`, brak persystencji, redakcja w logach/eventach/błędach providera |
| **Brute-force PIN-u** | `scrypt` + `timingSafeEqual`, `failed_attempts`, `locked_until`, rate limit na `/api/auth/login` |
| **Przejęcie sesji** | Cookie `HttpOnly` + `Secure` + `SameSite=Lax`, TTL wymuszany w zapytaniu, rotacja id przy logowaniu |
| XSS | Sanityzacja Markdown, brak raw HTML domyślnie, **allowlista węzłów i marków w schemacie ProseMirror** |
| **Wstrzyknięcie komponentu** | Model może wywołać wyłącznie zarejestrowane narzędzie; argumenty walidowane Zodem; zero `dangerouslySetInnerHTML`; model dostarcza **dane**, nie markup (§7.6) |
| **Akcja z powierzchni komponowanej** | Przyciski wiążą się wyłącznie z `capabilities` zakładki albo z komendą approve/reject. Brak drugiej ścieżki mutacji |
| **Zależność wołająca cudzą chmurę** | Audyt open-core (§2.4) jako bramka E0 i release gate |
| CSRF | Komendy mutujące pod ochroną CSRF + kontrola `Origin` / `Sec-Fetch-Site` |
| DoS | Limity body, liczby streamów, runów, tool calls, **rozmiaru dokumentu i liczby kroków w propozycji** |
| Supply chain | Lockfile w repo, skan zależności, przypięte obrazy |

**Prompt injection zasługuje na osobne zdanie.** Model może przeczytać wrogą treść w artefakcie i „postanowić" ją zastosować. Nie chroni nas prompt — chroni nas to, że najgorsze, co model może zrobić, to **zaproponować** zmianę, którą człowiek zobaczy jako diff przed zatwierdzeniem. Dlatego brak narzędzi MUTATING w rejestrze modelu jest kontrolą bezpieczeństwa, a nie decyzją architektoniczną, którą można wygodnie poluzować.

Rich text zaostrza to na dwa sposoby i oba mają odpowiedź:

- **Dokument jest powierzchnią ataku**, bo agent go czyta. Ograniczone narzędzia READ z §5.1 zmniejszają ekspozycję na turę, ale jej nie usuwają. Bramka zgody pozostaje jedyną realną kontrolą.
- **Agent proponuje strukturę, nie tylko tekst.** Odpowiedzią jest allowlista w schemacie ProseMirror: jeśli węzeł nie istnieje w schemacie, `Step.fromJSON` go odrzuci, zanim ktokolwiek zdąży go wyrenderować. Schemat jest tu granicą bezpieczeństwa, nie tylko modelem treści.

### 11.1. Uwierzytelnienie (PIN)

| Element | Rozstrzygnięcie |
|---|---|
| Hash | `node:crypto.scrypt`, sól per instalacja, porównanie `timingSafeEqual` |
| Token sesji | 32 losowe bajty; w bazie **hash tokenu**, nie token — wyciek pliku DB nie daje wtedy ważnej sesji |
| Cookie | `HttpOnly`, `Secure` (prod), `SameSite=Lax`, TTL sprawdzany w zapytaniu, nie tylko w cronie |
| Rotacja | Nowe `session.id` przy każdym logowaniu |
| Blokada | `failed_attempts` + `locked_until`, wykładniczy backoff |
| CSRF | Kontrola `Origin` / `Sec-Fetch-Site` na komendach + `SameSite=Lax`; token double-submit jako druga warstwa |
| Strumień | `GET /api/copilotkit` sprawdza sesję jak każdy inny endpoint — **strumień nie jest wyjątkiem** |

**Punkt, który łatwo przeoczyć:** klucz LLM z trybu A zostaje w `sessionStorage` przeglądarki i **nie wchodzi do sesji serwerowej**. Sesja serwerowa jest trwała; klucz nie ma być trwały. Wsadzenie klucza do sesji „bo wygodnie" cofnęłoby całą decyzję z §3 o braku persystencji.

---

## 12. Sygnały zmiany architektury

Zmiana wchodzi **po pomiarze**, nie po przeczuciu.

| Sygnał (mierzalny) | Zmiana |
|---|---|
| `SQLITE_BUSY` > 1% zapisów lub p95 lock wait > budżetu mimo optymalizacji | PostgreSQL |
| Więcej niż jeden host API/worker musi dzielić bazę | PostgreSQL |
| Pojawia się przewidywalny, wieloetapowy proces (research → generate → QA → render) z retry i audytem | LangGraph **lub** dedykowana kolejka — nie oba naraz |
| Zadania w tle > 60 s blokują request | Osobny worker + tabela `queue_items` z lease |
| BLOB-y dominują backup i RTO | Object storage + metadane w DB |
| Realna współpraca wielu osób na jednym dokumencie | WebSocket + CRDT/Yjs |
| Wiele zespołów wdraża niezależnie | Ostrożne wydzielenie usług po bounded contexts |
| Agent to jedno pytanie bez narzędzi | Usunięcie CopilotKit — zostaje samo AI SDK |
| **Zależność ze ścieżki krytycznej przechodzi na open-core** albo zaczyna wymagać cudzej chmury | Audyt §2.4 od nowa; dla każdej pozycji w tabeli ma być gotowa ścieżka wyjścia |
| **CopilotKit przesuwa za bramkę cokolwiek z warstwy renderującej** (chat, frontend tools, gen-UI) | Zmiana modelu biznesowego, nie doprecyzowanie — audyt §2.4 od nowa, decyzja o warstwie UI wraca na stół |

---

## 13. Decyzje architektoniczne (ADR-ready)

### ADR-001 — TypeScript end-to-end zamiast Python + FastAPI

- **Status:** Proposed
- **Kontekst:** Szablon rekomenduje FastAPI. Nasza skala to 1 host, ≤ 20 użytkowników, a punktem ciężkości jest UI. Kontrakt między agentem a UI to AG-UI, którego pierwszorzędne implementacje UI są w TS.
- **Decyzja:** Jeden runtime — Node/TypeScript. Domena, use case'y i agent w TS. Granica: gdyby wszedł pipeline ML/NLP wymagający ekosystemu Pythona, wydzielamy go jako osobną usługę z własnym kontraktem, nie przepisujemy aplikacji.
- **Alternatywy:** FastAPI + LangGraph + Astro (odrzucone: 3 procesy, 2 menedżery pakietów, duplikacja typów przy każdej zmianie kontraktu).
- **Konsekwencje:** (+) jeden build, jeden deploy, typy współdzielone bez generatora. (−) brak dostępu do bibliotek Pythona bez wydzielenia usługi.
- **Sygnał rewizji:** wymóg biblioteki dostępnej wyłącznie w Pythonie w gorącej ścieżce.

### ADR-002 — CopilotKit `BuiltInAgent` zamiast LangGraph w MVP

- **Status:** Proposed · bez zmian. Runtime CopilotKit **i** `@copilotkit/react-core` / `CopilotChat` zostają — bramka Intelligence dotyczy tylko trwałości wątków (§2.4, ADR-010).
- **Kontekst:** LangGraph daje jawny graf, checkpointy i `interrupt/resume`. Nasz MVP to jedna pętla: kontekst → model → narzędzie → propozycja → zgoda. HITL pokrywa `renderAndWaitForResponse`, trwałość — `SqliteAgentRunner`.
- **Decyzja:** `BuiltInAgent` z rejestrem narzędzi. Bramka zgody żyje w warstwie **domenowej**, nie w grafie — dzięki temu wymiana runtime'u agenta nie rusza logiki autoryzacji.
- **Alternatywy:** LangGraph od startu (odrzucone: framework grafowy bez grafu do wyrażenia).
- **Konsekwencje:** (+) mniej pojęć, szybsze dojście do działającego UI. (−) brak gotowych checkpointów per-węzeł, gdy pojawi się długi pipeline.
- **Sygnał rewizji:** proces z ≥ 3 etapami, retry per-etap i wymogiem audytu etapów.

### ADR-003 — BYOK rozstrzygane serwerowo per-request

- **Status:** Proposed
- **Kontekst:** Klucz może pochodzić od użytkownika (UI) albo od hosta (env, OpenAI-compatible URL). Współdzielona instancja agenta powodowałaby błędy równoległych runów i mieszanie kontekstów kluczy.
- **Decyzja:** `agents` jako fabryka `({ request }) => …`. Provider budowany per-request. Klucz nie jest nigdy persystowany.
- **Alternatywy:** Klucz w `.env` na sztywno (odrzucone: łamie wymóg). Wołanie providera z przeglądarki (odrzucone: nie da się wtedy egzekwować bramki zgody ani pętli narzędziowej).
- **Konsekwencje:** (+) oba tryby jednym kodem, izolacja per-request. (−) klucz użytkownika przechodzi przez nasz serwer — granica zaufania musi być zakomunikowana w UI i wymuszona w kodzie (§3).
- **Sygnał rewizji:** wymóg zgodności, który zabrania kluczowi użytkownika opuszczać przeglądarkę.

### ADR-004 — SQLite + `SqliteAgentRunner` jako trwałość startowa

- **Status:** Proposed
- **Kontekst:** Skala to jeden host. `SqliteAgentRunner` daje trwałe wątki i `connect()` do replayu — bez pisania własnego outboxu dla strumienia agenta.
- **Decyzja:** Dwie bazy SQLite: wątki agenta (runner) i domena (Drizzle). Alembic-owy odpowiednik: `drizzle-kit` jako **jedyny** właściciel schematu domenowego. Zero `create_all`.
- **Alternatywy:** PostgreSQL od startu (odrzucone: operacje bez uzasadnienia w skali). `InMemoryAgentRunner` (odrzucone: gubi stan przy restarcie — łamie wymóg replayu).
- **Konsekwencje:** (+) jeden plik, trywialny backup, zero infry. (−) jeden host; równoległe zapisy wymagają dyscypliny krótkich transakcji.
- **Sygnał rewizji:** progi z §12, wiersz SQLite.

### ADR-005 — Strumień jako transport, baza jako źródło prawdy

- **Status:** Proposed
- **Kontekst:** Wymaganie „UI i agent to jeden strumień danych" bywa czytane jako „stan żyje w strumieniu". To prowadzi do dwóch źródeł prawdy i niespójności po reconnect.
- **Decyzja:** AG-UI jest **jednym kanałem transportu**. Stan `useCoAgent` jest **projekcją read-model**. Po `resync_required` lub `STATE_SNAPSHOT` prawdą jest serwer i on nadpisuje klienta.
- **Alternatywy:** Klient jako autorytet dla stanu roboczego (odrzucone: rozjazd po reconnect, brak audytu).
- **Konsekwencje:** (+) reconnect jest deterministyczny, audyt kompletny. (−) potrzebna jawna projekcja i jawny snapshot — nie „store i tyle".
- **Sygnał rewizji:** realna współpraca wielu osób → CRDT zmienia model własności stanu.

### ADR-006 — Bramka zgody w warstwie domenowej, nie w UI ani w grafie

- **Status:** Proposed
- **Kontekst:** Zgoda wyrenderowana w komponencie React jest kontrolką UX, nie kontrolą bezpieczeństwa. Ktoś może wywołać endpoint bezpośrednio.
- **Decyzja:** `approveOperation` w `packages/application` jest jedyną ścieżką mutacji. Sprawdza autoryzację, `baseRevision` i stan terminalny operacji. UI tylko ją woła. Test kontraktowy pilnuje unikalności tej ścieżki.
- **Alternatywy:** Zgoda w węźle grafu (odrzucone: wiąże bezpieczeństwo z runtime'em agenta). Zgoda w route handlerze (odrzucone: mnoży się przy każdym nowym endpoincie).
- **Konsekwencje:** (+) jedna ścieżka do audytu i przetestowania. (−) trochę więcej ceremonii przy dodawaniu typu operacji.
- **Sygnał rewizji:** brak — to jest inwariant, nie preferencja.

### ADR-007 — Rich text, ProseMirror Steps, rebase po stronie serwera

- **Status:** Proposed *(decyzja właściciela 2026-08-16; do zatwierdzenia po spike'u E0)*
- **Kontekst:** Zakładka „dokument" jest przestrzenią **pisania i redagowania tekstu** (§1.1, potwierdzone 2026-08-16); zakładka „formularz" idzie osobną ścieżką (`json-patch`, ADR-009). Wcześniejsza analiza wariantów ([DECISIONS-OPEN.md §1](./DECISIONS-OPEN.md)) rekomendowała JSON strukturalny — ale ta rekomendacja była **warunkowa wobec nieznanej domeny**: przy niewiadomym artefakcie najtańszy i najłatwiejszy do udowodnienia format wygrywa. Gdy domeną okazuje się tekst redagowany przez człowieka, JSON nie jest tańszą alternatywą, tylko niewłaściwym modelem — musiałby symulować dokument przez pola, tracąc kursor, zaznaczenie, hierarchię i inline diff. Rebase nie znika przy JSON; przenosi się gdzie indziej albo chowa za gorszym UX.
- **Decyzja:** Patch to `Step[]` ProseMirror. **Serwer jest jedynym właścicielem rebase'u**: po każdej nowej rewizji przelicza oczekujące propozycje przez `Mapping` i publikuje wynik przez `STATE_DELTA`. Klient wyłącznie renderuje. Obowiązuje inwariant „decoration == zastosowane kroki", `MAX_REBASES` i TTL propozycji. Schemat ProseMirror mieszka w `packages/domain` i jest wersjonowany jak schemat bazy.
- **Alternatywy:**
  - *Twarde odrzucanie stale propozycji* — poprawne, ale bezużyteczne: propozycja ginie po każdym naciśnięciu klawisza.
  - *Rebase po stronie klienta* — odrzucone: klient i serwer mogłyby dojść do różnych wyników, a wtedy użytkownik zatwierdza jedno, a zapisuje się drugie. Błąd cichy, czyli najgorszy.
  - *Yjs / CRDT* — odrzucone: rozwiązuje współpracę w czasie rzeczywistym, której nie ma w wymaganiach, a dokłada cały model konwergencji.
- **Konsekwencje:** (+) najbogatszy możliwy UX dla produktu dokumentowego, inline ghost text. (−) rebase staje się podsystemem krytycznym dla poprawności; `artifact_revisions` musi trzymać kroki; schemat PM to kolejny artefakt do migrowania; E2 rośnie o ok. 3 dni.
- **Sygnał rewizji:** jeśli scenariusz 2 spike'u E0 (edycja **wewnątrz** zakresu propozycji) nie daje deterministycznego wyniku — przejście na adresowanie blokowe (akapit/sekcja jako jednostka) zamiast offsetów znakowych.

### ADR-008 — Local + PIN, ale `Actor` od dnia pierwszego

- **Status:** Proposed *(decyzja właściciela 2026-08-16)*
- **Kontekst:** Wdrożenie jest jednoosobowe, ale aplikacja może nasłuchiwać poza `127.0.0.1`. Bez uwierzytelnienia oznaczałoby to, że każdy w sieci lokalnej może zatwierdzać operacje.
- **Decyzja:** PIN + sesja cookie + CSRF **od E1**, nie od E3. Niezależnie od tego `Actor` jest wymaganym argumentem każdego use case'u, a repozytoria nie wystawiają metod bez scope'u — mimo że dziś istnieje jeden użytkownik.
- **Alternatywy:** *Brak auth* (odrzucone: patrz kontekst). *Pełny multi-user teraz* (odrzucone: koszt bez odbiorcy).
- **Konsekwencje:** (+) przejście na wielu użytkowników to podmiana producenta `Actor` plus ekran logowania — zero zmian w domenie. (−) CSRF i obsługa sesji wchodzą tydzień wcześniej, ok. 1 dzień pracy.
- **Sygnał rewizji:** pojawia się drugi użytkownik albo wymóg SSO.

### ADR-009 — Wiele rodzajów artefaktu, **jedna** bramka zgody

- **Status:** Proposed *(decyzja właściciela 2026-08-16)*
- **Kontekst:** Workspace ma zakładki: dokument (ProseMirror) i formularz (JSON + Zod). Formularz jest wyraźnie prostszy — nie potrzebuje rebase'u, konflikt to kolizja ścieżek. Kusi więc, żeby dać mu własny, lekki endpoint zatwierdzania i nie obciążać go maszynerią pisaną dla dokumentu.
- **Decyzja:** Jedna `approveOperation`. `format` wybiera **aplikator** (`applyProposal`), nigdy ścieżkę autoryzacji. Nowa powierzchnia to nowa gałąź `switch` plus nowy walidator — **nie** nowy endpoint.
- **Alternatywy:** *Osobny endpoint per `kind`* — odrzucone. Każdy nowy endpoint zatwierdzania to nowe miejsce, w którym można zapomnieć o policy check, o `baseRevision` albo o wpisie do audytu. Tak właśnie przeciekają bramki zgody: nie przez obejście, tylko przez drugą, „tymczasowo prostszą" ścieżkę, która zostaje na stałe.
- **Konsekwencje:** (+) jedno miejsce do przetestowania i zaudytowania; koszt dodania powierzchni jest płytki i liniowy. (−) `approveOperation` musi znać wszystkie formaty — przy piątym rodzaju `switch` warto zamienić na rejestr aplikatorów.
- **Sygnał rewizji:** więcej niż cztery rodzaje artefaktu, albo rodzaj wymagający **innego modelu autoryzacji** (np. dwóch zatwierdzających) — wtedy różnica jest w polityce, nie w aplikatorze, i wymaga osobnego przemyślenia.

### ADR-010 — CopilotKit w całości; własna trwałość wątków

- **Status:** Proposed *(2026-08-16, po dwóch korektach tego samego dnia)*
- **Kontekst:** Dokumentacja CopilotKit dzieli produkt jawnie, w dedykowanej stronie *OSS vs Enterprise Intelligence Platform*:
  > *„The open-source version is suitable for building agentic applications using framework-native APIs, **prebuilt chat, frontend tools, and gen-UI**. […] The Enterprise Intelligence Platform extends these features by providing **durable threads, persistence across devices, realtime WebSocket synchronization, and a hosted inspection and admin console**."*

  Granica biegnie więc po jednej osi: **wszystko, co renderuje i reaguje — darmowe; trwałość i platforma operacyjna — płatne.** To nie jest pole minowe, tylko czytelny podział open-core.
- **Decyzja:**
  1. **CopilotKit używamy w pełni** — runtime, `react-core`, `CopilotChat`, `useFrontendTool` z `render` (gen-UI), `useCoAgent`.
  2. **Własny `ThreadsPanel` na `/api/threads`** — jedyny element, który budujemy sami. Nie z powodu ceny, tylko dlatego, że wątki są naszym źródłem prawdy (ADR-005), a `useThreads` nie przyjmuje endpointu. Self-hosted Intelligence rozwiązuje własność danych, ale dokłada Kubernetes obok SQLite, co przeczy §8.
  3. **OpenUI odrzucone.** Rozwiązywało problem, którego nie ma: gen-UI jest w darmowym OSS. Wchodziłoby jako drugi kontrakt do wersjonowania bez zysku funkcjonalnego.
  4. Rejestr komponentów zostaje jako allowlista, ale realizowany **zarejestrowanymi narzędziami z `render`** (§7.6), nie osobnym językiem opisu UI.
  5. Zasada „agent nie generuje UI" **utrzymana** — model wybiera narzędzie i dostarcza dane, komponent jest nasz.
- **Alternatywy:**
  - *Licencja Intelligence (chmura lub self-hosted)* — odrzucone. Chmurowa oddaje wątki na zewnątrz; self-hosted dokłada klaster do aplikacji, która miała mieć „zero operacji". Cena nie jest tu głównym argumentem.
  - *OpenUI zamiast `CopilotChat`* — odrzucone po weryfikacji. Uzasadnienie („warstwa UI CopilotKit wypada") okazało się nieprawdziwe.
- **Konsekwencje:** (+) jeden kontrakt (AG-UI), jedna biblioteka UI, mniej kodu do utrzymania; jedyna własna część to panel wątków, który i tak **już istnieje**. (−) zależność od jednego dostawcy w warstwie UI — łagodzona tym, że jest otwarta i że AG-UI jest protokołem, nie produktem.
- **Sygnał rewizji:** CopilotKit przesuwa za bramkę cokolwiek z warstwy renderującej (chat, frontend tools, gen-UI). Byłaby to zmiana modelu biznesowego, nie doprecyzowanie — i uruchamia audyt §2.4 od nowa.

---

## 14. Checklist inicjalizacji

- [ ] Karta projektu uzupełniona (`{{…}}` zastąpione), klasy danych i SLO zatwierdzone
- [ ] **Spike rebase'u E0 zaliczony** — cztery scenariusze, w tym edycja wewnątrz zakresu
- [ ] E0 wykonane; ADR-001..010 przeniesione w *Accepted* z poprawkami
- [ ] Matryca READ / UI / PROPOSE / MUTATING spisana i pokryta testem
- [ ] **Audyt open-core (§2.4) wykonany dla całej ścieżki krytycznej**, wynik zapisany w tabeli
- [ ] Trzy artefakty wersjonowane w `packages/domain`: schemat ProseMirror, schemat Zod formularza, **rejestr narzędzi z `render`** — każdy z migratorem
- [ ] Test „jednej bramki" (ADR-009) w CI — grep nie znajduje drugiej ścieżki zapisu do `artifacts`
- [ ] Bramka zgody, kontrola rewizji, rebase i audit log zaprojektowane przed pierwszą mutacją
- [ ] Strategia BYOK zakomunikowana użytkownikowi w UI i wymuszona w kodzie
- [ ] Ścieżka odzyskania PIN-u istnieje i jest udokumentowana
- [ ] Reconnect / replay / `resync_required` przetestowane, nie założone
- [ ] Backup + **wykonany** restore drill
- [ ] Bramki a11y i security w CI
- [ ] Wersje przypięte; `pnpm-lock.yaml` w repo

---

## 15. Decyzje rozstrzygnięte i to, co zostało

Pełny rozbiór wariantów i koszt zwłoki: **[DECISIONS-OPEN.md](./DECISIONS-OPEN.md)**.

### Rozstrzygnięte 2026-08-16

| # | Decyzja | Skutek w planie |
|---|---|---|
| 1 | **Dokument rich text** (TipTap/ProseMirror) | §5.1–5.7, §7.3, §8, ADR-007. TipTap z profilu opcjonalnego → Core. Rebase staje się podsystemem krytycznym |
| 2 | **Local + PIN** | §11.1, §8 (`sessions`, `auth_secret`), ADR-008. CSRF i sesja przesuwają się z E3 do E1 |
| 3 | **LiteLLM jako kontrakt** | §2.1, §3, E0. Aplikacja zna tylko `LLM_BASE_URL` + `LLM_MODEL` |
| 4 | **Workspace z zakładkami: formularz + edytor** — nie sam edytor | §1.1, §5.1–5.2, §6.4, §7.0, §8, ADR-009. Dwa rodzaje artefaktu, dwa formaty patcha, **jedna** bramka. E1 rośnie o ~2 dni |
| 5 | **CopilotKit w całości + własny `ThreadsPanel`; OpenUI odrzucone** | §2.2, §2.4, §6.5, §7.6, ADR-010. Granica open-core biegnie po osi „render vs trwałość" — gen-UI jest darmowe, więc OpenUI rozwiązywałoby nieistniejący problem |

**Domknięcie sporu o format patcha.** Analiza rekomendowała JSON strukturalny; decyzja 1 wybrała ProseMirror. Decyzja 4 pokazuje, że to nie był wybór „albo–albo": produkt ma **obie** powierzchnie, więc obie odpowiedzi były trafne — każda dla swojej zakładki.

- **Formularz** dostaje `json-patch`: konflikt to kolizja ścieżek, brak rebase'u, poprawność bramki trywialna. Dokładnie to, co rekomendowała analiza.
- **Dokument** dostaje `pm-steps`: bez tego nie ma kursora, zaznaczenia, hierarchii ani inline diff. JSON musiałby symulować dokument przez pola i przegrywał z definicji.

Union `format`, wstawiony pierwotnie jako furtka na przyszłość, okazał się nośnym elementem architektury — a nie hedgingiem.

Koszt rebase'u zostaje i jest wyceniony wprost: **+3 dni w E2, jeden podsystem krytyczny dla poprawności, jeden dodatkowy schemat do migrowania.** Ale płaci go teraz **jedna zakładka**, nie cały system. Bramka bezpieczeństwa bez zmian: spike E0 jest go/no-go dla **formatu patcha dokumentu** (offsety znakowe vs. adresowanie blokowe), nie dla rich textu i nie dla formularza.

### Otwarte, ale nieblokujące E0

| Pytanie | Kiedy potrzebne | Założenie tymczasowe |
|---|---|---|
| **Jakie zakładki** faktycznie są? Plan zakłada `dokument` + `formularz`; „Źródła" w diagramie §7.0 jest ilustracją | Początek E1 | Dwie zakładki + chat. Trzecia dokłada się bez zmiany architektury |
| **Zakres schematu ProseMirror** — akapity, nagłówki, listy, linki, kod, tabele? | Początek E1 | `starter-kit` bez tabel. Tabele zauważalnie komplikują mapowanie kroków |
| **Schemat formularza** — pola stałe czy definiowalne przez użytkownika? | Początek E1 | Stałe, w kodzie. Definiowalne oznaczałyby schemat jako **dane**, czyli trzeci rodzaj artefaktu i własny cykl wersjonowania |
| **Odzyskiwanie PIN-u** — co, gdy właściciel zapomni? | E1 | Komenda CLI `pnpm auth:reset` działająca lokalnie na pliku bazy. Brak resetu mailem |
| **Model domyślny za LiteLLM** i czy wdrożenie ma GPU | Przed próbą tool callingu w E0 | Próba biegnie na tym, co skonfigurowane; wynik zapisany w notatce z E0 |
| **Retencja rewizji** — historia rośnie z każdą edycją | E3 | Snapshot co 100 rewizji, kroki starsze niż N dni kompaktowane do snapshotu |

Ostatni wiersz nie jest kosmetyczny: przy dokumencie w aktywnej redakcji `artifact_revisions` rośnie szybciej niż jakakolwiek inna tabela w tym systemie, a kroków nie da się usunąć bez utraty możliwości rebase'u wstecz. Polityka retencji musi powstać, zanim baza urośnie — nie po.
