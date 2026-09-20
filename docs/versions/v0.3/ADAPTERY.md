# Rejestr własnych adapterów i deklaracji szablonu

> Sprawdzany przez `tests/adapters-register.test.ts`: każdy plik wymieniony niżej musi istnieć, każdy
> adapter musi mieć próbę zgodności wskazującą istniejący test, a **każdy plik w
> `packages/platform-ui/src/chat/` musi być tu wymieniony** — nowy adapter nie wejdzie do
> repozytorium po cichu. Kryteria: L12.7 (opis odbioru wskazuje własne adaptery), L12.15 (opisy
> odpowiadają działaniu).

Rozróżnienie jest to samo, którego używał FEEDBACK §6 w poprzedniej fazie:

- **biblioteka** — użyta bez zmian;
- **konfiguracja** — gotowa funkcja ustawiona pod ten backend;
- **adapter** — kod dopisany dlatego, że gotowe rozwiązanie tego nie dawało.

Pełny rejestr z fazy AgenticApp jest w [`docs/archive/agenticapp-2026-09/FEEDBACK.md`](archive/agenticapp-2026-09/FEEDBACK.md) §6.
Ten plik jest jego aktualną wersją dla szablonu: obejmuje także adaptery powstałe po tamtym zapisie.

## Adaptery interfejsu (gotowy czat OpenUI `AgentInterface`)

## A-01 — Kanał zdarzeń platformy w strumieniu czatu

- **Rodzaj:** adapter
- **Czego brakowało:** `processStreamedMessage` z `@openuidev/react-headless` obsługuje `TEXT_MESSAGE_*`, `TOOL_CALL_*` i `RUN_ERROR`, a pozostałe zdarzenia AG-UI po cichu pomija — w tym `CUSTOM`, którym platforma przekazuje zmiany danych, canvasu, artefaktów i polecenia interfejsu.
- **Co dopisano:** opakowanie strumienia, które przepuszcza zdarzenia do gotowego reduktora i równolegle wystawia zdarzenia platformy własnym konsumentom.
- **Pliki:** `packages/platform-ui/src/chat/platformAdapter.ts`
- **Próba zgodności:** `tests/agui-stream.test.ts`
- **Ograniczenie:** jeden konsument zdarzenia — dwukrotne zastosowanie tego samego zdarzenia podwaja tekst, co test trzyma jawnie.
- **Ponowne użycie:** tak, niezależne od dziedziny.

## A-02 — Miejsca na kontrolki, których gotowy czat nie zna

- **Rodzaj:** adapter
- **Czego brakowało:** `AgentInterface` układa własne dzieci jako `slots.rest` i przycina wszystko, czego nie rozpoznaje; kontrolki platformy (tytuł rozmowy, załączniki) nie miały gdzie usiąść.
- **Co dopisano:** deklaracja miejsc i portale, które wstawiają kontrolki w wyliczone punkty gotowego układu.
- **Pliki:** `packages/platform-ui/src/chat/chatSlots.ts`
- **Próba zgodności:** `e2e/chat-layout.spec.ts`
- **Ograniczenie:** miejsca są wyliczane z klas biblioteki; zmiana jej markupu wymaga poprawki i jest chroniona testem przynależności kontrolek.
- **Ponowne użycie:** tak.

## A-03 — Wysłanie polecenia i anulowanie po stronie backendu

- **Rodzaj:** adapter
- **Czego brakowało:** gotowy czat wysyła polecenie własnym transportem i zna tylko `AbortSignal` swojego żądania; platforma potrzebuje uruchomienia, które żyje w backendzie dłużej niż połączenie.
- **Co dopisano:** wysyłka z kontekstem aplikacji i osobne, jawne anulowanie przez `POST /api/runs/:id/cancel`.
- **Pliki:** `packages/platform-ui/src/chat/chatWiring.ts`
- **Próba zgodności:** `e2e/chat.spec.ts`
- **Ograniczenie:** sygnał przerwania żądania celowo **nie** anuluje uruchomienia — to była przyczyna gubienia zadań w tle.
- **Ponowne użycie:** tak.

## A-04 — Stop w gotowym kompozytorze

- **Rodzaj:** adapter
- **Czego brakowało:** przycisk Stop gotowego kompozytora przerywa strumień w przeglądarce i nie mówi backendowi nic.
- **Co dopisano:** przechwycenie akcji Stop i wywołanie anulowania wskazanego uruchomienia.
- **Pliki:** `packages/platform-ui/src/chat/useComposerStop.ts`
- **Próba zgodności:** `e2e/stop-children.spec.ts`
- **Ograniczenie:** Stop dotyczy uruchomienia widocznego w panelu; zadania innych rozmów zatrzymuje się z listy zadań.
- **Ponowne użycie:** tak.

## A-05 — Trwałe podłączenie do pracy backendu

- **Rodzaj:** adapter
- **Czego brakowało:** gotowy czat wiąże wykonanie z otwartym żądaniem; po przeładowaniu strony albo przełączeniu rozmowy praca backendu traciła odbiorcę.
- **Co dopisano:** rejestr żywych strumieni z ponownym podłączeniem od numeru sekwencyjnego zdarzenia.
- **Pliki:** `packages/platform-ui/src/chat/runStreams.ts`
- **Próba zgodności:** `e2e/reconnect-live.spec.ts`
- **Ograniczenie:** ponowne podłączenie odtwarza zdarzenia od początku uruchomienia (L5.6) — może powtórzyć nawigację albo prośbę o zgodę.
- **Ponowne użycie:** tak.

## A-06 — Polecenia interfejsu wykonywane przez przeglądarkę

- **Rodzaj:** adapter
- **Czego brakowało:** żaden gotowy element nie wykonuje poleceń agenta dotyczących interfejsu (przejście do widoku, podświetlenie pola) ani nie odsyła potwierdzenia.
- **Co dopisano:** reduktor zdarzeń uruchomienia z wykonawcą poleceń wpinanym przez referencję, żeby czysta część nie zależała od routera.
- **Pliki:** `packages/platform-ui/src/chat/runEvents.ts`
- **Próba zgodności:** `e2e/ui-navigation.spec.ts`
- **Ograniczenie:** ochrona przed ponowieniem polecenia żyje w pamięci komponentu i nie przeżywa przeładowania (L2.15).
- **Ponowne użycie:** tak.

## A-07 — Wybór rozmowy zgodny z adresem strony

- **Rodzaj:** adapter
- **Czego brakowało:** `AgentInterface` sam jest właścicielem wyboru wątku; adres strony i lista rozmów rozjeżdżały się przy nawigacji Wstecz/Dalej.
- **Co dopisano:** dwukierunkowa synchronizacja przez publiczne API biblioteki, z regułą pierwszeństwa wyliczaną osobno i bez efektów ubocznych.
- **Pliki:** `packages/platform-ui/src/chat/ConversationSync.tsx`, `packages/platform-ui/src/chat/sessionRestore.ts`
- **Próba zgodności:** `tests/session-restore.test.ts`, `e2e/session-restore.spec.ts`
- **Ograniczenie:** rozstrzyganie kolejności opiera się na kolejności zdarzeń biblioteki; reguła jest trzymana w osobnej, czystej funkcji właśnie po to, żeby dało się ją sprawdzić bez przeglądarki.
- **Ponowne użycie:** tak.

## A-08 — Tytuł rozmowy i zmiana nazwy

- **Rodzaj:** adapter
- **Czego brakowało:** gotowy czat nie pokazuje tytułu rozmowy ani nie daje go zmienić, choć backend ma `PATCH /api/threads/update/:id`.
- **Co dopisano:** kontrolka tytułu osadzona w miejscu z A-02.
- **Pliki:** `packages/platform-ui/src/chat/ConversationTitle.tsx`
- **Próba zgodności:** `e2e/chat-history.spec.ts`
- **Ograniczenie:** tytuł nadawany automatycznie pochodzi z backendu; kontrolka go tylko pokazuje i pozwala nadpisać.
- **Ponowne użycie:** tak.

## A-09 — Załączniki w gotowym kompozytorze

- **Rodzaj:** adapter
- **Czego brakowało:** kompozytor biblioteki nie ma pola załącznika; dziecko dołożone od zewnątrz trafia do `slots.rest` i jest przycinane.
- **Co dopisano:** portal wstawiający pole i listę załączników do wnętrza gotowego kompozytora.
- **Pliki:** `packages/platform-ui/src/chat/ComposerAttachments.tsx`
- **Próba zgodności:** `e2e/sandbox-files.spec.ts`
- **Ograniczenie:** obsługiwane formaty to PNG, JPEG, XLSX, CSV i tekst; inne są odrzucane w polu załącznika.
- **Ponowne użycie:** tak.

## A-10 — Treść wiadomości asystenta (proza, OpenUI, wynik narzędzia)

- **Rodzaj:** adapter
- **Czego brakowało:** ścieżka GenUI `AgentInterface` renderuje wyłącznie to, co rozpozna jako komponent, i gubi prozę obok opisu interfejsu.
- **Co dopisano:** własny renderer treści wiadomości, który pokazuje prozę, skomponowany opis OpenUI i wynik narzędzia obok siebie.
- **Pliki:** `packages/platform-ui/src/chat/AssistantMessage.tsx`
- **Próba zgodności:** `e2e/bl10-composition.spec.ts`
- **Ograniczenie:** tekst wypowiedziany **przed** wywołaniem narzędzia gotowy czat traktuje jako krok osi „Behind the scenes”, nie jako odpowiedź (L5.15).
- **Ponowne użycie:** tak.

## A-11 — Artefakt w podglądzie i w pełnym widoku

- **Rodzaj:** adapter
- **Czego brakowało:** gotowa przestrzeń artefaktów pobierała artefakt sama, więc podgląd w wiadomości i pełny widok były dwoma niezależnymi obrazami tego samego artefaktu.
- **Co dopisano:** jeden wspólny odczyt artefaktu dla obu powierzchni, z rendererem wskazanym przez typ artefaktu.
- **Pliki:** `packages/platform-ui/src/chat/ArtifactPane.tsx`
- **Próba zgodności:** `e2e/artifact-views.spec.ts`, `e2e/artifact-renderers.spec.ts`
- **Ograniczenie:** artefakt `live` odświeża się przy odczycie; snapshot pozostaje zamrożony — różnica jest widoczna w atrybutach wersji.
- **Ponowne użycie:** tak.

## A-12 — Panel rozmowy osadzony w powłoce aplikacji

- **Rodzaj:** adapter
- **Czego brakowało:** `AgentInterface` jest pomyślany jako całe okno; tu jest bocznym panelem obok nawigacji i canvasu.
- **Co dopisano:** panel składający gotowy czat z kontrolkami platformy i podpinający wszystkie adaptery wyżej.
- **Pliki:** `packages/platform-ui/src/chat/ChatPanel.tsx`
- **Próba zgodności:** `e2e/chat-drawer.spec.ts`, `e2e/chat-layout.spec.ts`
- **Ograniczenie:** przy szerokości panelu poniżej 768 px biblioteka przełącza się na układ mobilny z szufladą rozmów — to jej własna decyzja, podjęta z mierzonej szerokości.
- **Ponowne użycie:** tak.

## Adaptery backendu

## A-13 — Most hooków SDK: zdarzenia narzędzi i identyfikator sesji

- **Rodzaj:** adapter
- **Czego brakowało:** `@mastra/claude` przekazuje do strumienia wyłącznie deltę tekstu; wywołania narzędzi idą do telemetrii, a `session_id` nie jest wystawiony wcale — bez tego nie da się pokazać narzędzi w czacie ani wznowić rozmowy.
- **Co dopisano:** rejestracja hooków SDK i tłumaczenie ich na zdarzenia AG-UI, z przechwyceniem identyfikatora sesji.
- **Pliki:** `packages/platform-server/src/agent/runtime.ts`
- **Próba zgodności:** `tests/runtime.test.ts`, `tests/session.test.ts`
- **Ograniczenie:** kolejność zdarzeń to kolejność zaobserwowana — tekst i hooki to dwa niezależne źródła.
- **Ponowne użycie:** tak.

## A-14 — Projekcja rozmowy zgodna z reduktorem biblioteki

- **Rodzaj:** adapter
- **Czego brakowało:** czat składa strumień reduktorem biblioteki, a backend musi zapisać te same wiadomości dla przeładowania — dwa reduktory nad jedną sekwencją to zaproszenie do rozjazdu.
- **Co dopisano:** projekcja backendu prowadzona tak samo jak `processStreamedMessage`, z testem, który przepuszcza te same bajty przez prawdziwy reduktor biblioteki.
- **Pliki:** `packages/platform-server/src/agent/projection.ts`
- **Próba zgodności:** `tests/projection.test.ts`
- **Ograniczenie:** zgodność jest sprawdzana na zdarzeniach, które produkuje ten backend, nie na całej przestrzeni zdarzeń AG-UI.
- **Ponowne użycie:** tak.

## A-15 — Strażnik zgodności schematów MCP

- **Rodzaj:** adapter
- **Czego brakowało:** `z.record()` w schemacie narzędzia cicho usuwa **cały** serwer MCP w SDK 0.3.270, bez żadnego komunikatu; `z.default()` czyni pole wymaganym.
- **Co dopisano:** kontrola kształtu schematów przy starcie, która odrzuca konstrukcje niezgodne z konwersją SDK.
- **Pliki:** `packages/platform-server/src/agent/mcp.ts`
- **Próba zgodności:** `tests/mcp-schema.test.ts`
- **Ograniczenie:** lista zakazanych konstrukcji pochodzi z zaobserwowanych awarii tej wersji SDK, nie z jego specyfikacji.
- **Ponowne użycie:** tak.

## A-16 — Polityka wyłącznie subskrypcyjna i izolacja konfiguracji

- **Rodzaj:** adapter
- **Czego brakowało:** SDK dziedziczy zmienne środowiska i prywatne ustawienia użytkownika; klucz API w środowisku milcząco zmienia sposób rozliczania.
- **Co dopisano:** przycięte środowisko procesu agenta (`subscriptionOnlyEnv`) i `settingSources: []`.
- **Pliki:** `packages/platform-server/src/agent/sandbox.ts`, `packages/platform-server/src/agent/auth.ts`
- **Próba zgodności:** `tests/credential-guard.test.ts`, `tests/auth.test.ts`
- **Ograniczenie:** samo odcięcie zmiennych jest sprawdzone jako konfiguracja i skanem powierzchni; nie jako próba z prawdziwie wyczerpanym limitem (L8.11).
- **Ponowne użycie:** tak.

## A-17 — Macierz uprawnień narzędzi SDK

- **Rodzaj:** adapter
- **Czego brakowało:** SDK ma trzy niezależne mechanizmy decydujące o wywołaniu narzędzia i stosuje je w kolejności, której nazwy nie sugerują; bez trzeciej kategorii („zabronione”) każde nieznane narzędzie trafiało do pytania o zgodę.
- **Co dopisano:** jedna macierz kategorii zasilająca `disallowedTools`, `allowedTools` i bramkę `canUseTool`, plus odmowa po stronie bramki jako obrona w głąb.
- **Pliki:** `packages/platform-server/src/agent/permissions.ts`
- **Próba zgodności:** `tests/consent.test.ts`, `tests/credential-guard.test.ts`
- **Ograniczenie:** kolejność mechanizmów SDK da się zaobserwować wyłącznie na turze modelu; ta regresja jej nie wydaje (L11.12).
- **Ponowne użycie:** tak.

## Deklaracje widoczne dla użytkownika i ich dowody

Sprawdzane osobno przez `tests/adapters-register.test.ts`: zdanie, które aplikacja albo README mówi
użytkownikowi, musi mieć dowód albo być zapisane jako niepotwierdzone. Przeniesienie do „ograniczeń”
nie zalicza obowiązku — ale i odwrotnie: opis nie może obiecywać więcej, niż wykazano.

| Deklaracja | Gdzie | Dowód | Stan |
|---|---|---|---|
| Przełączenie rozmowy i odświeżenie strony nie przerywa zadania | README | `e2e/background-tasks.spec.ts` | potwierdzone |
| Zamknięcie panelu nie przerywa zadania | README (usunięte) | `packages/platform-ui/src/shell/AppShell.tsx` | **opis nie odpowiadał interfejsowi** — powłoka renderuje `ChatPanel` bezwarunkowo, więc akcji „zamknij panel” nie ma; zdanie poprawione zamiast dorabiania do niego próby |
| Załączniki PNG, JPEG, XLSX, CSV i tekst są odczytane z treści | README | `e2e/sandbox-files.spec.ts` | potwierdzone |
| Sandbox: zapis tylko w workspace uruchomienia | Ustawienia | `tests/runtime.test.ts` | potwierdzone jako konfiguracja |
| Sandbox: sieć i katalog danych odcięte | Ustawienia, README | `tests/runtime.test.ts` | **tylko konfiguracja** — brak próby niedozwolonego odczytu, zapisu i połączenia z uruchomienia (L11.3, L11.4, L11.11) |
| Zgoda jest wymagana przed uruchomieniem kodu | README | `e2e/consent-runs.spec.ts` | potwierdzone |
| Oryginał pliku zostaje bez zmian, wynik jest nową wersją | README | `e2e/sandbox-files.spec.ts` | potwierdzone |

## Wersje kluczowych zależności (przypięte dokładnie)

Sprawdzane przez `tests/adapters-register.test.ts` wprost w manifestach — tabela nie może się
rozjechać z `package.json`. Czy to nadal najnowsze stabilne wersje, sprawdza osobno
`node scripts/check-versions.mjs` i `tests/versions.test.ts` (L1.2).

| Pakiet | Wersja | Rola |
|---|---|---|
| react | 19.3.0 | interfejs |
| react-dom | 19.3.0 | interfejs |
| typescript | 7.0.2 | typy i kontrola typów |
| vite | 8.3.0 | build frontendu |
| @openuidev/react-ui | 0.13.10 | gotowy czat, katalog komponentów, wykresy |
| @openuidev/react-headless | 0.9.13 | reduktor strumienia czatu |
| @openuidev/react-lang | 0.2.15 | parser i renderer opisu OpenUI |
| hono | 4.13.7 | backend HTTP |
| drizzle-orm | 0.45.2 | dostęp do SQLite |
| @mastra/core | 1.66.0 | rejestracja agenta i typy wykonania |
| @mastra/claude | 0.3.1 | most do Claude Agent SDK |
| @anthropic-ai/claude-agent-sdk | 0.3.270 | pętla agentowa, sandbox, uprawnienia, sesje |
| zod | 4.6.5 | kontrakty i schematy MCP |

Wersja CLI **wbudowanej w SDK** (`manifest.json` pakietu SDK) jest inna niż wersja pakietu i inna niż
`claude` na `PATH`; każdy zapisany dowód niesie wszystkie trzy — zob. `tests/support/measurement-evidence.ts`
i kryteria L1.12, L12.10.
