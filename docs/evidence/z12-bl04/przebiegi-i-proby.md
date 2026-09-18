# Z12 / BL-04 — przebiegi, próby zdolności wykrycia i granice dowodu

Zapis przebiegów, na których oparte są oceny jedenastu kryteriów pakietu BL-04
(L8.2, L8.3, L8.6, L8.7, L8.8, L8.9, L8.10, L8.11, L8.12, L8.13, L8.14).
Plik jest pisany ręcznie i **nie** powstaje z regresji. Regresja zapisuje na żądanie
(`APP_WRITE_EVIDENCE=1`) tylko `skan-sekretow.json`; `sesja-sdk.json` zapisuje świadomie uruchamiany
skrypt `pnpm probe:sdk-session`.

## Tury modelu: 0 — także po fazie 2

Żaden spec modelowy nie był uruchamiany i **żadna tura subskrypcji nie została wydana**, mimo że
faza 2 wykonała trzy **rzeczywiste** przebiegi przez Claude Agent SDK. Powód jest prosty i wart
zapamiętania: przebieg, który nie przechodzi uwierzytelnienia, **nie dociera do modelu**, więc nie ma
czego naliczyć. Przyznany grant (≤ 8 tur, autoryzowane 3) pozostaje nienaruszony w całości.

Trzy rodzaje dowodu występują w tym pakiecie i nie wolno ich mylić:

- **symulacja** — model zastąpiony scenariuszem na granicy adaptera SDK (`ModelAgentLike`).
  Wszystko poza modelem jest prawdziwe: runtime, klasyfikator, rejestr uruchomień, rekord dostępu,
  strumień zdarzeń, czat, pasek stanu, Ustawienia, narzędzia domenowe i baza.
- **test GUI bez modelu** — przeglądarka na produkcyjnym buildzie, bez modelu w ogóle.
- **rzeczywiste wywołanie SDK bez tury modelu** — nowy w tym pakiecie, opisany niżej. To nie jest
  „rzeczywisty model”: model nie dostaje żadnego polecenia.

### Czym jest sonda sesji SDK i dlaczego nic nie kosztuje

`Query` z `@anthropic-ai/claude-agent-sdk` udostępnia **żądania sterujące** — wiadomości, na które
odpowiada samo CLI, bez sięgania do modelu. `scripts/probe-sdk-session.ts` otwiera sesję, której
strumień wejściowy nigdy nie emituje wiadomości, zadaje `accountInfo()` oraz eksperymentalny odczyt
wykorzystania limitów planu i zamyka sesję. Nie wysyła żadnego promptu, więc nie ma tury do wydania.

Obserwacja na `@anthropic-ai/claude-agent-sdk` 0.3.270, Claude CLI 2.1.277, konto Claude Max:

| Przebieg | Warunki | `state` | `apiKeySource` | `subscriptionType` | limity planu |
|---|---|---|---|---|---|
| 1 | środowisko aplikacji (`subscriptionOnlyEnv`) | `subscription` | `null` | `Claude Max` | dostępne (5 h: 5%, 7 dni: 64%) |
| 2 | `ANTHROPIC_API_KEY` w procesie **nadrzędnym**, polityka włączona | `subscription` | `null` | `Claude Max` | dostępne |
| 3 | ten sam klucz, `applyPolicy: false` | `api_key` | `ANTHROPIC_API_KEY` | `null` | `rate_limits_available: false` |

Przebieg 3 jest kontrolą. Bez niego dwie identyczne odpowiedzi z przebiegów 1 i 2 mogłyby równie
dobrze znaczyć, że sonda w ogóle nie widzi różnicy. Klucz użyty w 2 i 3 jest **nieprawdziwy**:
`apiKeySource` opisuje pochodzenie poświadczenia, nie jego ważność.

Pełny zapis: [`sesja-sdk.json`](sesja-sdk.json). Raport nie niesie adresu e-mail ani nazwy
organizacji konta — `classifySdkSession` ich nie kopiuje, a `tests/sdk-session-evidence.test.ts` to
sprawdza.

## Przebiegi

| Polecenie | Kod wyjścia | Wynik |
|---|---|---|
| `pnpm verify` (drzewo scalone z `domkniecie/integracja` przed Z9, commit `b4332fd`) | 0 | 51 plików / 834 testy; `git status --porcelain` po przebiegu: pusto |
| `pnpm verify` (**po scaleniu z Z9/BL-08b**, merge `714b9b7`) | 0 | **867 testów**; drzewo czyste |
| `pnpm exec playwright test` (**po scaleniu z Z9/BL-08b**, pod blokadą) | 0 | **209 testów** |
| `pnpm typecheck` (pakiety + moduły osobno + `e2e/`) | 0 | bez błędów |
| `pnpm build && pnpm exec playwright test e2e/auth-limits.spec.ts` (pod blokadą) | 0 | 13 testów |
| `pnpm exec playwright test` (cały domyślny przebieg, pod blokadą) — **pierwszy przebieg** | 1 | 196 zielonych, 1 oblany: `e2e/bl10-agent-navigation.spec.ts` „cel w zwinietej sekcji…”. **Nie flake — regresja tej zmiany**, opis niżej |
| `pnpm exec playwright test` (cały domyślny przebieg, po poprawce) | 0 | 198 testów |
| `pnpm probe:sdk-session` | 0 | trzy przebiegi sondy, wniosek rozstrzygający |
| `APP_WRITE_EVIDENCE=1 pnpm exec playwright test e2e/auth-limits.spec.ts` | 0 | zapisany `skan-sekretow.json` |
| `pnpm probe:auth-refusal --rehearsal` (próba generalna, bez SDK) | 0 | wyłapała brak `PORT` z zakresu testowego |
| `pnpm probe:auth-refusal` (**rzeczywisty SDK**, ×2) | 0 | `refresh-refused-*.json`; 0 tur |
| `pnpm probe:auth-refusal --revoked` (**rzeczywisty SDK**) | 0 | `revoked-*.json`; 0 tur |

Nie uruchamiano: `pnpm test:e2e:model`, `e2e/bl01-bl02-model.spec.ts`, `e2e/agent-ui.spec.ts`,
`e2e/files-agent.spec.ts` — wydają tury subskrypcji.

## Próby zdolności wykrycia (G16)

Procedura: commit najpierw, próba na czystym drzewie, wycofanie **jednej** linii, przebieg,
`git checkout -- <plik>`, kontrola czystości. Wszystkie osiem oblało na spodziewanej asercji;
żadna nie wyszła nieoczekiwanie zielona.

| # | Wycofana linia | Test | Jak oblał |
|---|---|---|---|
| A | odmowa `protectedPathRefusal` w hooku `PreToolUse` (`runtime.ts`) | `tests/credential-guard.test.ts` | „wartosc poswiadczenia trafila do odpowiedzi: expected true to be false” oraz to samo dla historii rozmowy; trzeci test: `Glob` przeszedł |
| B | `authIsConfirmed` sprowadzone do `authIsUsable` | `tests/auth.test.ts` | 2 testy: „stan »failed« nie jest potwierdzonym dostepem” i „obecnosc pliku sama w sobie nie jest potwierdzonym dostepem” |
| C | uniewaznienie `['status']` po zakończeniu uruchomienia (`runEvents.ts`) | `e2e/auth-limits.spec.ts` | linia 168: pasek stanu utknął na `data-auth-state="unverified"` przez 63 próby |
| D | `classifySdkSession` ignoruje `apiKeySource` | `tests/auth.test.ts` | 3 testy: `expected 'other' to be 'api_key'` (×2) oraz sesja na kluczu API przestała czynić aplikację niezdatną |
| E | `isAccessRelevantFailure` sprowadzone do `code !== 'session_transcript_lost'` | `tests/auth.test.ts` | 2 testy: odmowa sandboxa i własny limit czasu znów liczone jako błąd dostępu |
| F | `console.log` z treścią pliku poświadczeń w `readCredentialMetadata` | `e2e/auth-limits.spec.ts` | linia 441: „kanarek poswiadczenia znaleziony w powierzchniach” (znalezisko w `logSerwera`) |
| G | test dotyka prawdziwego pliku poświadczeń (zapis tej samej treści) | `tests/credential-guard.test.ts` | hook `afterAll`: „plik logowania uzytkownika zmienil sie w trakcie testow”, kod wyjścia 1 |

### Znalezisko z próby A

Pierwsze podejście oblało na **asercji o zapisie kroku narzędzia**, a nie na asercji o wycieku —
bo ta druga stała w teście niżej. Test sprawdzał właściwą rzecz, ale nie w tej kolejności, w jakiej
czyta się jego wynik. Kolejność asercji zmieniono (commit `82c61c9`) tak, żeby asercja o kanarku była
pierwsza, i próbę powtórzono: oblewa teraz na wycieku. To jest przykład próby, która złapała **test**,
nie kod — zgodnie z G16 potraktowany jako znalezisko, nie jako formalność.

### Znalezisko z próby G

Próba przez chwilę **zmieniła czas modyfikacji prawdziwego pliku poświadczeń użytkownika**
(przepisanie tej samej treści; rozmiar i zawartość bez zmian, logowanie sprawne — sprawdzone po
przywróceniu). To jest dokładnie ta klasa zdarzeń, przed którą chroni kontrola L8.14, i powód, dla
którego kontrola została dopisana: własność „testy negatywne nie niszczą logowania użytkownika” była
prawdziwa **z konstrukcji**, a takie własności przestają być prawdziwe, gdy ktoś dopisze test, który
o konstrukcji zapomni. Teraz jest mierzona.

## Faza 2 — rzeczywiste próby graniczne uwierzytelnienia

Trzy przebiegi przez prawdziwy Claude Agent SDK, każdy na **kopii** poświadczenia z celowo zepsutymi
**oboma** tokenami (wartości, które nigdy nie były tokenami — nie ma czego unieważnić).

| Tryb | Warunki | Komunikat SDK | Klasyfikacja aplikacji | Kod uruchomienia |
|---|---|---|---|---|
| `refresh-refused` | `expiresAt` godzinę w przeszłości, martwy refresh token | `Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed` | `refresh_refused` | `unauthenticated` |
| `revoked` | `expiresAt` godzinę w przyszłości, martwy access token | **ten sam tekst** | `refresh_refused` | `unauthenticated` |

Trzy ustalenia, wszystkie zaobserwowane:

1. **Zakładany komunikat był zły.** Symulacja używała `OAuth token refresh failed: invalid_grant`.
   SDK 0.3.270 produkuje coś innego. Werdykt klasyfikatora był mimo to poprawny — ale wychodził
   **przypadkiem**, bo tekst zawiera akurat słowa „refresh" i „expired". Dołożony jawny warunek na
   potwierdzoną frazę; próba wykrycia H: po jego wycofaniu komunikat klasyfikuje się jako `revoked`.
2. **SDK nie odróżnia odwołanego logowania od odmowy odnowienia.** Oba przypadki graniczne dają
   identyczny tekst, więc aplikacja dostaje jeden stan dla dwóch przyczyn — i żaden klasyfikator tego
   nie naprawi. Skutek dla użytkownika jest poprawny (obie porady mówią „zaloguj się ponownie"), ale
   rozróżnienie, którego żąda L8.11, jest w tej parze nieosiągalne po stronie aplikacji.
3. **CLI kasuje poświadczenie na dysku przy odmowie** (`accessToken` i `refreshToken` puste,
   `expiresAt` wyzerowane) — potwierdzone w obu przebiegach polem `skasowanePrzezCli`. To jest powód,
   dla którego próba wycelowana w `~/.claude` wylogowałaby użytkownika **natychmiast**.

Odcisk prawdziwego pliku poświadczeń (rozmiar, czas modyfikacji, skróty obu tokenów) wzięty przed i po
każdym przebiegu: **bez zmian**. Skrypt kończy się kodem 3, gdyby się zmienił.

### Dlaczego nie ma próby ze *skutecznym* odświeżeniem

Bo byłaby destrukcyjna, i to nie hipotetycznie. W bundlu CLI 2.1.277 zapis odświeżonego poświadczenia
jest **compare-and-swap po `refreshToken`** — CLI nadpisuje plik tylko wtedy, gdy leżący tam refresh
token jest wciąż tym, od którego zaczynało. Taki zamek istnieje dlatego, że odświeżenie **wymienia**
zestaw tokenów. Użycie prawdziwego refresh tokena z kopii zostawiłoby więc w pliku użytkownika token
poprzedniej generacji — a punkt 3 wyżej mówi, co się stanie przy jego najbliższym użyciu: CLI
wyczyści użytkownikowi logowanie na dysku, kilka godzin później, bez ostrzeżenia.

To jest dokładnie to, czego zakazuje warunek zamknięcia tego pakietu, więc próba **nie została
wykonana**, a L8.10 zostaje w tej połowie otwarte. Domknięcie wymaga konta testowego odrębnego od
konta użytkownika.

## Regresja, którą ten pakiet wywołał i naprawił

Pierwszy pełny przebieg przeglądarkowy oblał na cudzym teście:
`e2e/bl10-agent-navigation.spec.ts` → „cel w zwinietej sekcji zostaje odslonniety, podswietlony i
zgloszony” (L2.14), asercja „element nie zostal przewiniety do widoku”. Powtórzył się na spokojnej
maszynie, więc **nie był flakiem**.

Pomiar (`window.innerHeight` 720, cel `settings-tools`):

```
targetHeight = 1244, top po scrollIntoView({block:'center'}) = -235.25,
surfaceScrollHeight = 4131, surfaceClientHeight = 667, surfaceScrollTop = 1470
```

Przyczyna: `UiCommandRunner.reveal` przewijał cel z `block: 'center'`. Dla celu **wyższego niż okno**
wyśrodkowanie kładzie jego początek nad krawędzią ekranu. Test asertował właściwą rzecz („góra
elementu, do którego wysłano użytkownika, jest w widoku”) i przechodził dotąd **przypadkiem**:
tabela narzędzi siedziała na tyle nisko, że kontener nie miał się gdzie przewinąć, żeby ją naprawdę
wyśrodkować. Dołożenie sekcji „Sesja SDK” w Ustawieniach wydłużyło stronę o tyle, że mógł.

Poprawka (commit `7d1c18d`): `block: 'start'` dla celu wyższego od okna, `'center'` w pozostałych
przypadkach. Po niej `e2e/bl10-agent-navigation.spec.ts` i `e2e/auth-limits.spec.ts` przechodzą razem
(17 testów). To jest defekt cudzego pakietu (BL-10), ale ujawniony przez tę zmianę, więc naprawiony
tutaj, a nie zgłoszony do naprawy komuś innemu.

## Co ten pakiet dowodzi, a czego nie

**Dowodzi.** Że sesja SDK w środowisku aplikacji idzie przez OAuth subskrypcji i że ten sam klucz API
przy wyłączonej polityce byłby widoczny (a więc jego brak jest obserwacją). Że cztery kontrolowane
awarie dają cztery różne stany w czacie, na pasku stanu i w Ustawieniach. Że miniony termin w pliku
nie blokuje uruchomienia i nie jest werdyktem o dostępie. Że mutacja przed limitem daje dokładnie
jeden skutek i nie jest powtarzana samoczynnie. Że agent nie odczyta pliku poświadczeń, a kanarek nie
pojawia się w żadnej z dwunastu przeszukanych powierzchni.

**Nie dowodzi.**

1. **Rzeczywistego wyczerpania limitu.** Cztery awarie w suicie przeglądarkowej są symulacjami
   (dwie z nich mają teraz odpowiednik potwierdzony rzeczywistym przebiegiem). Odczyt wykorzystania
   okien planu z sondy (5 h, 7 dni) jest **odczytem prawdziwego limitu**, nie jego wyczerpaniem, i
   kryterium nie zamyka. L8.11 i L8.12 zostają otwarte.
2. **Że komunikat limitu i błędu sieci to te, które SDK naprawdę wypisuje.** Komunikat odmowy
   uwierzytelnienia jest już potwierdzony (faza 2). `usage limit`, `429` i `socket hang up` — nie.
   To jest pozostały brak L8.11.
3. **Skutecznego odświeżenia tokena przez SDK.** Powód jest teraz bezpieczeństwem, nie kosztem:
   próba na kopii wylogowałaby użytkownika (wyżej). To jest pozostały brak L8.10.
4. **Kolejności, w jakiej SDK stosuje swoje trzy mechanizmy uprawnień.** Odmowa w hooku `PreToolUse`
   jest sprawdzona na stand-inie, który honoruje decyzję hooka tak, jak opisuje to kontrakt SDK.
   Że prawdziwy SDK też ją uhonoruje, jest wypowiedzią o cudzym kodzie — dlatego ochrona katalogu
   poświadczeń ma **trzy** niezależne warstwy (sandbox `denyRead`/`denyWrite`, hook, bramka).
