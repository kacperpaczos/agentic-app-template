# Trzy decyzje — arkusz wyboru

> **Archiwum — nieaktualny stos.** Plan z 2026-08-16 (status „Proposed”) dla wcześniejszej koncepcji: Next.js, CopilotKit,
> BYOK/LiteLLM, workspace dokument + formularz. Jest **sprzeczny z obowiązującą specyfikacją** ([`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md)):
> Vite + Hono, OpenUI Agent Interface, Mastra + Claude Agent SDK wyłącznie na subskrypcji (L8.3).
> Zachowany jako zapis rozważanych decyzji. Rozliczenie treści: [`docs/DOCUMENTATION-MAP.md`](../../DOCUMENTATION-MAP.md) §3.

> **ROZSTRZYGNIĘTE 2026-08-16.** Wybór właściciela:
> **1 → Dokument rich text** · **2 → Local + PIN** · **3 → LiteLLM jako kontrakt**
> Skutki w planie: [PLAN.md §15](./PLAN.md), ADR-007 i ADR-008.
> **Rekomendacja w §1 (JSON strukturalny) obowiązuje — ale tylko dla części produktu.** Doprecyzowanie zakresu (2026-08-16) pokazało, że aplikacja to **workspace z zakładkami: formularz + edytor**, nie sam edytor. Wybór nie jest więc „albo–albo": zakładka **formularz** dostaje `json-patch` (dokładnie wariant A poniżej), a zakładka **dokument** — `pm-steps` (wariant B). Obie odpowiedzi były trafne, każda dla swojej powierzchni. Rebase kosztuje wyłącznie zakładkę dokumentu.
> Szczegóły: [PLAN.md §1.1](./PLAN.md), ADR-007 i ADR-009. Ten dokument zostaje jako zapis rozważanych alternatyw i sygnałów, przy których warto do nich wrócić.

Uzupełnienie do [PLAN.md §15](./PLAN.md). Żadna z tych decyzji nie blokowała E0 (spike).
Wszystkie trzy blokowały E1, bo każda zmienia kształt kodu pisanego w pierwszym tygodniu.

Struktura każdej sekcji: **co naprawdę jest wybierane** → warianty → co się zmienia w kodzie → rekomendacja → jak bezpiecznie odroczyć.

---

## Pytanie 1 — Domena artefaktu

### Co naprawdę jest wybierane

Nie „która biblioteka edytora". Wybierasz **format patcha**, a ten przesądza o czterech rzeczach naraz:

1. kształcie `agent_operations.payload`,
2. sposobie wykrywania konfliktu przy zatwierdzaniu,
3. tym, czy inline diff jest w ogóle wykonalny,
4. tym, czy dwie propozycje na tym samym artefakcie mogą współistnieć.

Biblioteka to konsekwencja, nie przyczyna.

### Warianty

| | Format patcha | Wykrywanie konfliktu | Overlay | Biblioteka |
|---|---|---|---|---|
| **A. JSON strukturalny** | JSON Patch (RFC 6902) | `baseRevision` + kolizja ścieżek | Podświetlenie pola + panel | `fast-json-patch` (~3 kB) |
| **B. Dokument rich text** | ProseMirror Steps | rebase kroków albo `baseRevision` | Decorations inline (ghost text) | TipTap / ProseMirror |
| **C. Kod / plik tekstowy** | Unified diff hunks | hash pliku + linie kontekstu | Merge view | CodeMirror 6 |
| **D. Graf / canvas** | Operacje `addNode` / `removeEdge` / `setProp` | `baseRevision` per węzeł | Podświetlenie węzła + minimapa | React Flow |

### Przykład — ten sam zamiar, cztery payloady

Użytkownik: *„popraw tytuł i dodaj tag `pilne`"*.

**A — JSON strukturalny**

```json
{
  "type": "propose_patch",
  "artifactId": "art_01J...",
  "baseRevision": 7,
  "ops": [
    { "op": "replace", "path": "/title", "value": "Wniosek — korekta Q3" },
    { "op": "add",     "path": "/tags/-", "value": "pilne" }
  ]
}
```

Diff renderuje się sam: `path` → pole w formularzu, `value` → nowa wartość obok starej. Konflikt = dwie propozycje dotykają tej samej `path`. Do wykrycia jednym `Set`.

**B — dokument rich text**

```json
{
  "type": "propose_patch",
  "baseRevision": 7,
  "steps": [
    { "stepType": "replace", "from": 12, "to": 34,
      "slice": { "content": [{ "type": "text", "text": "Wniosek — korekta Q3" }] } }
  ]
}
```

Pozycje `from`/`to` są **wrażliwe na każdą wcześniejszą edycję**. Jeśli użytkownik dopisał zdanie na początku, zanim kliknął „Zatwierdź", offsety są nieaktualne. Albo rebase'ujesz kroki (ProseMirror to potrafi, ale to osobny mechanizm do napisania i przetestowania), albo odrzucasz propozycję jako stale. **Trzecia opcja nie istnieje.**

**C — kod / plik**

```diff
@@ -1,4 +1,4 @@
-# Wniosek Q3
+# Wniosek — korekta Q3
 tags:
   - budżet
+  - pilne
```

Dopasowanie po liniach kontekstu. Działa świetnie, dopóki plik nie zdryfował; potem `patch` cicho trafia w złe miejsce albo odpada. Wymaga hasha pliku, nie tylko numeru rewizji.

**D — graf**

```json
{
  "type": "propose_patch",
  "baseRevision": 7,
  "ops": [
    { "op": "setProp", "nodeId": "n_4", "key": "label", "value": "Korekta Q3" },
    { "op": "addNode", "node": { "id": "n_9", "type": "tag", "label": "pilne" } },
    { "op": "addEdge", "from": "n_4", "to": "n_9" }
  ]
}
```

Konflikt jest per-węzeł, więc dwie propozycje na różnych gałęziach współistnieją bez problemu. Ale format jest w pełni autorski — piszesz walidator, migrator i renderer diffa od zera.

### Co się zmienia w kodzie

| Wariant | Realny koszt E1 |
|---|---|
| **A** | Najniższy. Zero bibliotek edytora, diff to funkcja czysta, testy jednostkowe trywialne |
| **B** | +TipTap, +Decorations, +rebase albo świadoma decyzja o odrzucaniu stale propozycji, +testy pozycji |
| **C** | +CodeMirror, +hashowanie pliku, +obsługa dryfu kontekstu |
| **D** | +React Flow, +autorski walidator ops, +autorski renderer diffa |

### Rekomendacja *(nieaktualna — patrz nagłówek)*

> ⚠️ Poniższa rekomendacja zakładała **nieznaną domenę**. Domena okazała się tekstem, co ją unieważnia: wybrany został wariant **B**. Zapis zostaje, bo argument „bramka zgody jest trywialnie poprawna tylko w A" pozostaje prawdziwy — i dlatego rebase z [PLAN.md §5.5](./PLAN.md) dostał osobny spike, osobny zestaw testów i inwariant „widziane == zapisane".

**A (JSON strukturalny)** jako domyślny `kind` artefaktu.

Powód nie jest estetyczny. To jedyny wariant, w którym bramka zgody jest **trywialnie poprawna**: `baseRevision` plus zestaw ścieżek wystarczy, żeby udowodnić, że propozycja jest aktualna. W B i C poprawność zależy od dodatkowego mechanizmu, który trzeba napisać i przetestować — a to jest właśnie ta warstwa, w której błąd oznacza cichy zapis nie tam, gdzie użytkownik widział.

Kluczowe: **`artifacts.kind` istnieje od dnia 1**. Dodanie drugiego rodzaju (dokument, graf) później to nowy `kind` + nowy renderer + nowy walidator patcha. **To nie jest migracja architektury** — bramka zgody, outbox, audit log i strumień się nie zmieniają.

### Jak bezpiecznie odroczyć

Zaprojektuj `AgentOperation.payload` jako union dyskryminowany od początku:

```ts
type PatchPayload =
  | { format: "json-patch"; ops: JsonPatchOp[] }
  | { format: "pm-steps";   steps: unknown[] }   // dokłada się w E1+
  | { format: "graph-ops";  ops: GraphOp[] };    // dokłada się w E1+
```

Jedno pole `format` dziś, zerowa migracja jutro.

---

## Pytanie 2 — Tożsamość

### Co naprawdę jest wybierane

Nie „czy jest ekran logowania". Wybierasz, **czy zapytania do bazy mają wymiar właściciela**.

To jest ta decyzja, która najdroższiej się cofa. Dołożenie logowania do gotowej aplikacji to jeden tydzień. Dołożenie scope'owania do zapytań, które go nie miały, to polowanie na miejsca, gdzie go zabrakło — i to jest dokładnie ten mechanizm, którym powstają wycieki między najemcami.

### Warianty

| | Auth | `Actor` | CSRF | Scope w zapytaniach | Autoryzacja replayu strumienia |
|---|---|---|---|---|---|
| **A. Local, bez auth** | brak, bind `127.0.0.1` | `{ type: "local" }` | zbędny (brak ciasteczek) | brak | brak |
| **B. Local + PIN/hasło** | cookie sesyjne | `{ type: "user", id }` | **wymagany** | brak (jeden użytkownik) | brak |
| **C. Wielu użytkowników** | sesja / magic link | `{ type: "user", id, roles }` | **wymagany** | **w każdym zapytaniu** | **per wątek** |
| **D. OIDC / SSO** | IdP korporacyjny | jak C + `tenantId` | **wymagany** | **w każdym zapytaniu** | **per wątek + tenant** |

### Przykład — ta sama funkcja w wariancie A i C

**A — bez scope'u**

```ts
export async function listArtifacts(uow: Uow) {
  return uow.artifacts.all();          // wszystko, bo i tak jest jeden użytkownik
}
```

**C — ze scope'em**

```ts
export async function listArtifacts(uow: Uow, actor: Actor) {
  return uow.artifacts.ownedBy(actor.id);   // WHERE owner_id = ?
}
```

Różnica wygląda na kosmetyczną. Nie jest: w wariancie C **każde** zapytanie, **każdy** replay strumienia i **każda** komenda musi ją mieć, a kompilator tego nie wymusi, jeśli `actor` nie jest wymaganym argumentem.

### Wzorzec, który zamyka lukę na poziomie typów

```ts
// packages/domain/src/actor.ts
export type Actor =
  | { type: "local" }                                       // wariant A
  | { type: "user"; id: string; roles: Role[]; tenantId?: string };

// packages/application/ — actor jest OBOWIĄZKOWY w każdym use case,
// nawet gdy dziś zawsze wynosi { type: "local" }
export async function approveOperation(cmd: ApproveCmd, actor: Actor) { … }
```

Repozytorium przyjmuje `Actor` i samo dokleja `WHERE`, zamiast ufać wołającemu:

```ts
// packages/db/src/repo/artifacts.ts
class ArtifactRepo {
  // brak metody all() bez actora — nie da się o niej zapomnieć
  async visibleTo(actor: Actor) {
    return actor.type === "local"
      ? this.db.select().from(artifacts)
      : this.db.select().from(artifacts).where(eq(artifacts.ownerId, actor.id));
  }
}
```

Koszt dziś: jeden dodatkowy argument w sygnaturach. Koszt retrofitu: audyt każdego zapytania w aplikacji.

### Rekomendacja

**Wdrażaj A (albo B), buduj jak C.**

Konkretnie: `Actor` jest wymaganym argumentem każdego use case'u od pierwszego commita, repozytoria nie wystawiają metod bez scope'u, `audit_log` zapisuje `actor` od początku. Realnie działa w trybie `{ type: "local" }`. Przejście na C to podmiana producenta `Actor` (odczyt z sesji zamiast stałej) plus ekran logowania — **zero zmian w domenie i w warstwie aplikacji**.

Wybierz **B zamiast A**, jeśli aplikacja ma kiedykolwiek nasłuchiwać na innym adresie niż `127.0.0.1`. Bind na `0.0.0.0` bez uwierzytelnienia oznacza, że każdy w sieci lokalnej ma pełny dostęp — łącznie z zatwierdzaniem operacji i, w trybie B modelu, z Twoim kluczem LLM.

### Jak bezpiecznie odroczyć

Nie da się odroczyć samego `Actor`. Da się odroczyć **wszystko poza nim**: ekran logowania, RBAC, tenant scoping. Warunek: `Actor` istnieje w sygnaturach od E1.

---

## Pytanie 3 — Provider trybu B

### Co naprawdę jest wybierane

Nie „gdzie stoi model". Wybierasz **jak wiarygodne jest tool calling** — a od tego zależy, czy cała architektura z §5 planu w ogóle działa.

Agent, który nie potrafi rzetelnie wyemitować ustrukturyzowanego wywołania narzędzia, nie stworzy propozycji. Nie zawiedzie głośno — zamiast tego opisze zmianę prozą w czacie, a `agent_operations` zostanie puste. Dla użytkownika wygląda to jak „agent gada, ale nic nie robi".

**To jest największe ryzyko techniczne trybu B** i dlatego E0 musi je zmierzyć, a nie założyć.

### Warianty

| | URL | Klucz | Tool calling | Kiedy |
|---|---|---|---|---|
| **A. Ollama** | `http://localhost:11434/v1` | brak | zależny od modelu, **zmienny** | Dev, demo, offline |
| **B. vLLM / TGI** | `http://host:8000/v1` | opcjonalny | dobry przy modelu z szablonem narzędziowym | Własne GPU, wysoka przepustowość |
| **C. LiteLLM proxy** | `http://host:4000` | zarządzany centralnie | dziedziczony z modelu docelowego | Wiele providerów, budżety, audyt |
| **D. Brama korporacyjna** | `{{URL}}` | polityka firmowa | zależny od tego, co za bramą | Wymóg compliance |

### Przykład — konfiguracja i to, co się psuje

**A — Ollama**

```bash
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen3:14b
# LLM_API_KEY niepotrzebny
```

Zero konfiguracji, działa bez sieci. Ryzyko: małe modele bywają niestabilne w tool callingu — potrafią wypisać wywołanie jako tekst zamiast wyemitować blok narzędzia. Okno kontekstu też jest realnie mniejsze niż nominalne.

**B — vLLM**

```bash
LLM_BASE_URL=http://gpu-01:8000/v1
LLM_MODEL=Qwen/Qwen3-14B-Instruct
LLM_API_KEY=whatever          # vLLM akceptuje dowolny, gdy nie wymusza auth
```

Przewidywalna przepustowość i opóźnienia. Wymaga uruchomienia serwera z właściwym parserem narzędzi (`--enable-auto-tool-choice --tool-call-parser …`) — bez tego tool calling po prostu nie działa, mimo poprawnego endpointu.

**C — LiteLLM**

```bash
LLM_BASE_URL=http://litellm:4000
LLM_MODEL=claude-opus-5       # albo lokalny alias, albo cokolwiek innego
LLM_API_KEY=sk-litellm-…      # klucz wirtualny, nie klucz providera
```

Jeden endpoint, za nim dowolny provider. Klucze prawdziwych providerów nie opuszczają proxy. Dostajesz limity per-klucz, budżety i centralny log — czyli dokładnie to, czego wymaga §14.1 szablonu, bez pisania tego samemu.

### Test, który musi być w E0

Zanim cokolwiek zostanie zbudowane na trybie B, jeden pomiar:

```ts
// tests/probe/tool-calling.spec.ts
// Dwadzieścia przebiegów tego samego promptu wymagającego użycia narzędzia.
// Liczymy, ile razy model wyemitował strukturalny tool call zamiast opisu prozą.
const SUCCESS_THRESHOLD = 0.95;
```

Próg poniżej 95% oznacza, że przepływ propozycji będzie zawodził losowo — a błędy losowe w bramce zgody są najgorszym rodzajem błędu, bo użytkownik traci zaufanie, zanim ktokolwiek je zdiagnozuje.

Jeśli próg nie jest osiągalny na docelowym modelu, są trzy wyjścia — w tej kolejności:

1. **Zamień model.** Najtańsze. Nie każdy model dobrze wołający narzędzia jest duży.
2. **Wymuś structured output** — schemat JSON zamiast swobodnego tool callingu. Węższe, ale deterministyczne.
3. **Zdegraduj do trybu read-only** dla tego modelu: agent czyta i steruje UI, ale nie proponuje mutacji. Jawnie zakomunikowane w UI, nie ciche.

### Rekomendacja

**Traktuj LiteLLM jako kontrakt, nawet jeśli dziś stoi za nim Ollama.**

Aplikacja zna wtedy dokładnie jedną rzecz: „endpoint zgodny z OpenAI pod `LLM_BASE_URL`". Podmiana Ollama → vLLM → API chmurowe jest zmianą konfiguracji proxy, nie zmianą kodu aplikacji. To normalizuje też różnice w kształcie błędów, które inaczej wyciekają do warstwy UI.

Dla czystego dev-loopu bez sieci: **A (Ollama) bezpośrednio**, bo LiteLLM to wtedy jeden kontener nadmiaru.

### Jak bezpiecznie odroczyć

Kod aplikacji nigdy nie odwołuje się do nazwy providera. Wyłącznie do `LLM_BASE_URL` + `LLM_MODEL`. Przy takim ograniczeniu ta decyzja jest odwracalna zmienną środowiskową — pod jednym warunkiem, że **próg tool callingu został zmierzony na modelu docelowym**, a nie na tym, którym testowałeś.

---

## Podsumowanie — koszt zwłoki

| Decyzja | Odroczenie bezpieczne, jeśli… | Koszt złego wyboru |
|---|---|---|
| **1. Artefakt** | `payload` jest unionem dyskryminowanym z polem `format` | Niski — nowy `kind`, nie migracja |
| **2. Tożsamość** | `Actor` jest wymaganym argumentem od E1 | **Wysoki** — retrofit scope'u to audyt każdego zapytania |
| **3. Provider** | Kod zna tylko `LLM_BASE_URL` + `LLM_MODEL` | Średni — ale nie da się odroczyć **pomiaru** tool callingu |

Innymi słowy: pytania 1 i 3 można odłożyć projektując na nie miejsce. Pytania 2 odłożyć się nie da — można tylko zdecydować, że dziś działa w trybie jednoosobowym.
