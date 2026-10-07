# Brief: Recenzja bezpieczeństwa pakietu GLM-provider

Jesteś niezależnym recenzentem bezpieczeństwa (NIE autorem). Pakiet przełączenia providera
w worktree `worktree z16-glm` (HEAD `eb6a0b8`, BASE `2d59906`,
7 commitów, 34 pliki, +1443/−186). Diff (czytaj sekcjami):
`z16-glm/.superpowers/sdd/zlecenie/review-2d59906..eb6a0b8.diff`
Specyfikacja właściciela: `zewnętrzny prompt właściciela PROMPT-CLAUDE-CODE-GLM.md`
Brief: `.sdd-zlecenie/glm-b-brief.md`; raport implementatora: `.sdd-zlecenie/glm-b-report.md`
(ścieżki względem lokalny katalog worktree szablonu/).

## Twój priorytet: granica poświadczeń i prawdziwość trybów

1. **Token Z.AI nigdzie nie wycieka**: grep diffu i nowych plików po wzorcach tokenu (brak
   wartości, tylko atrapy FAKE); sprawdź, czy token może trafić do: logów serwera (main.ts,
   diag-agent.ts — co dokładnie printują; czy URL do statusu tylko jako ORIGIN), /api/status,
   dowodów (model-turns.ts — pola koperty), komunikatów błędów, rejestru tur.
2. **Bezwarunkowe skruby nietknięte**: w OBU trybach ANTHROPIC_API_KEY, BEDROCK/VERTEX,
   AWS_BEARER, CLAUDE_CODE_* (poza CLAUDE_CONFIG_DIR) są skrubowane; w subscription trybie
   ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL dalej skrubowane (stare testy podzielone, nie osłabione —
   porównaj tests/auth.test.ts przed/po: czy każda stara asercja ma odpowiednik).
3. **Fail-closed konfiguracji**: nieznany provider → odmowa; glm bez BASE_URL/TOKEN/MODEL/
   CLAUDE_CONFIG_DIR → odmowa; CLAUDE_CONFIG_DIR=~/.claude (lub homedir/.claude) → odmowa.
   Czy walidacja jest w loadConfig (jedno miejsce) czy rozproszona? Czy da się ją obejść
   (np. provider ustawiony po starcie, wielkość liter, spacje)?
4. **Brak odczytu poświadczeń w glm**: probeAuth glm ścieżka nie czyta .credentials.json
   (wartownik w tests/provider-mode.test.ts — czy Atakowo-solidny: czy pilnuje readFileSync
   ORAZ existsSync/stat? czy da się czytać innym API?); skutki uboczne: nic innego nie czyta
   pliku (credentialFilePath wywołania w glm).
5. **authIsUsable/Confirmed**: gałąź glm — czy w glm aplikacja nie pokaże „zdrowy" przy
   revoked/refresh_refused? czy stan `api_key` sesji w glm jest oczekiwany a NIE jest polutowany
   w subscription?
6. **Prawdziwość UI/dowodów**: etykiety GLM nie kłamią (AppShell/SettingsPage); koperta dowodowa
   glm NIE może oznaczać się jako „subskrypcja Claude"; pole model wypełnione (koniec z null);
   rejestr glm ODRĘBNY od z11 (budżety nie mieszają się — sprawdz readZ11Ledger vs glm ledger);
   statusy „informacyjne / poza bramką" w macierzy: acceptance-matrix.mjs — czy „informacyjne"
   NIE liczy się do OPEN (nie zamyka warstwy fałszywie? czy NIE blokuje?), czy sumy dalej
   spójne (200), czy L11.11 pozostał otwarty z podzielonym gapem (ramię plikowe otwarte — to
   funkcja bezpieczeństwa!), czy 4 przeniesione kryteria mają zachowane uzasadnienia gap.
7. **Zakazy procesowe**: żadnej próby modelowej (grep po dowodach runs/ — czy powstał nowy przebieg?),
   lockfile nietknięty, ARCHITECTURE.md nietknięty, 8791 nieobecne w diffie (poza komentarzami?),
   dane użytkownika nietknięte.
8. **Verify/e2e**: uruchom `pnpm verify` w worktree (twierdzenie: 72/1158). e2e przyjmij z raportu
   (228; 17 min) — chyba że coś budzi wątpliwość w diffie testów.

## Werdykty

- Zgodność ze specyfikacją PROMPT (pkt po pkt: nienaruszalne rozdzielenie; konfiguracja;
  zachowanie funkcjonalne — potwierdzone testami; testy i dowody; raport/macierz).
- Jakość: zatwierdzony/odrzucony.
- Findings Critical/Important/Minor z plik:linia.
- Explicit: CZY WOLISZ uruchomienie prób modelowych na GLM po ewentualnych poprawkach — i jakie
  warunki wstępne (np. najpierw pnpm probe:sdk-session w glm).

## Wynik

Recenzja: `docs/versions/v0.4/archive/domkniecie-2026-09/glm-c-review.md`.
Zwróć TYLKO: werdykt zgodności, werdykt jakości, liczby findings, warunki startu prób (1 zdanie).

## Zakazy

Nie commituj, nie mutuj repo, nie uruchamiaj e2e ponownie, NIE uruchamiaj żadnych wywołań modelu
ani sond z prawdziwym tokenem. Próby negatywne tylko na atrapach/kopiach.
