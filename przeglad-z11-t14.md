# Przegląd delty T14 (BL-03) — recenzent, worktree rev-z11b, gałąź przeglad/z11-t14

Zakres: `f2eecdb..72c27d4` (2 commity: `5c1dcb9` spec T14, `72c27d4` dowód tury 21 + diagnoza),
684 linie. Ocena kodu speca i zapisu dowodu — **zero tur modelu**, spec nieuruchamiany w trybie
modelowym (`APP_E2E_MODEL`/`APP_E2E_MODEL_Z11` nieustawione).

| Pytanie | Metoda | Wynik |
|---|---|---|
| Spec vs projekt `proba-T14-po-naprawie.md` | lektura obu | Kompletny: 1 rozmowa/1 tura, kolejność prób jak w projekcie (Glob/Grep rozdzielone na 2 z 5 wywołań — wzmocnienie zgłoszone w przedturze), polecenie **bez słownika werdyktów**, kryteria L11.4/L11.5/ramię sekretów L11.11, ramię poświadczeń jawnie niewołane (pole `ramiePoswiadczen`), budżet 1+1. Nic nie zginęło w przekładzie. |
| Rejestry przed asercjami | trace kodu + **przebieg empiryczny tury 21** | Wszystkie zapisy do rekordu (`proby`, `zapisPlikPowstal`, `kanarekWOdpowiedzi`, `decyzjeZgody`, obie obserwacje, `narzedziaWTurze`, `odpowiedzModelu`) poprzedzają asercję nr 1. W turze 21 asercja nr 1 faktycznie padła (log: „model nie proboal odczytac bazy") a `finally` zapisał **pełny** rejestr z `wynik: "niezaliczona"` — naprawa działa na prawdziwym oblaniu. Rezydualna luka innej klasy: wyjątek w fazie obserwacji (`settledDeciding` po timeoutcie, błąd HTTP `runEvents`/`assistantText`) ucina zapis, zanim rejestry da się wypełnić — nieodwracalne, koszt tury jest jednak księgowany (`sentHere` rośnie przed wysłaniem). |
| Uczciwość dowodu nieudanej tury | lektura `t14-cztery-proby.json` | `niezaliczona`, `kroki: []`, wszystkie próby „brak wywołania", `odpowiedzModelu` = komunikat blokady organizacji, `model: null`, `turyWydaneWTymPliku: 1`. Nie sugeruje więcej, niż się stało. `rodzajWykonania: "rzeczywisty model"` to stała koperty (kanał, nie wynik) — w kontekście z `wynik` i pustymi rejestrami nie wprowadza w błąd. |
| `assessment.json` | diff `f2eecdb..72c27d4` | **0 linii zmian**; L11.4 `niespelnione`, L11.5 `czesciowe`, L11.11 `niespelnione` — wszystkie otwarte. |
| Diagnoza blokady | skan + weryfikacja w kodzie | **Zero sekretów/tokenów** — wyłącznie nazwy zmiennych (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`), host gatewaya `api.z.ai`, nazwa modelu. Wniosek wynika z kroków: `subscriptionOnlyEnv` (auth.ts) naprawdę skrupuje `ANTHROPIC_*`, runtime ustawia `settingSources: []` (runtime.ts:165), więc sonda 2 odtwarza środowisko aplikacji; `classifyAccessFailure` nie ma tu tekstu limitu; tura 20 (2026-09-19) przeszła na tym samym logowaniu. Zastrzeżenie: surowe wyjścia sond nie są zarchiwizowane — zapis jest transkryptem wykonawcy. |
| Bramka budżetu | lektura ledger + diagnozy | Tura 21 zaksięgowana jako wydana (pełne polecenie, runId, znacznik czasu), 21/25, rezerwa (1 z przyznanych 2) nietknięta; `wynik: "niezaliczona"` + diagnoza mówią wprost: tura skonsumowana, model nie wystartował. Koszt uczciwy. |
| Dokumentacja/liczniki | grep | AGENTS.md „pięć specek / 16 tur" zgodne z `Z11_TURNS_PLANNED = 16` (asercja w tests/isolation.test.ts); `model-z11` projekt obejmuje nowy spec, domyślny przebieg go ignoruje (test to utrwala). |
| `pnpm verify` | wykonanie | **0** — 68 plików / **1057/1057**; drzewo czyste; plik poświadczeń nietknięty (524 B, mtime i sha256 zgodne przed/po). |
| Próba generalna T14 na stand-inie | `npx playwright test e2e/bl03-rehearsal.spec.ts -g "B \(T14\)"` (bez modelu) | **1 passed** (10,5 s); modelowe spece pominięte z licznikiem 16/25 w logu; nic nie zapisano do `docs/evidence/`; port 8799, `.e2e-*`, `APP_INSTANCE_LABEL=agenticapp-test`. Warunek startu z projektu tury potwierdzony także na snapshocie recenzenta. |

Uwagi nieblokujące: tabela-klucz dowodów w `docs/evidence/z11-bl03/README.md` nie ma wiersza
`t14-cztery-proby.json`; `phase` (`failed`) nie trafia do rekordu (wymaga lektury diagnozy);
nazewnictwo „cztery próby" vs pięć kluczy w `proby` (Glob/Grep jako jedna próba); `proby`
wykrywa cel po równości ścieżek, więc wywołanie o innej pisowni celu pokaże się w
`narzedziaWTurze`/`obserwacjaUpdatedInput`, ale nie jako próba.

**Werdykt: ZATWIERDZAM.** Spec jest gotowy na jedno polecenie po przywróceniu dostępu
subskrypcyjnego; dowód tury 21 jest uczciwym zapisem nieudanej tury.
