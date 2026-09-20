# Diagnoza nieudanej tury T14 (tura 21) — blokada subskrypcji po stronie organizacji

Przebieg: `2026-09-20T02-26-53-975Z`, spec `e2e/bl03-model-t14.spec.ts`, commit `5c1dcb9`.
Tura wydana (rejestr: 21/25), wykonanie zakonczone statusem `failed`; **model nie wystartowal** —
zero wywolan narzedzi, zero pytan o zgode, kanarek bezpieczny, plik proby nie powstal
(`t14-cztery-proby.json` w tym katalogu).

## Odpowiedz, ktora wróciła zamiast modelu

> Your organization has disabled Claude subscription access for Claude Code · Use an
> Anthropic API key instead, or ask your admin to enable access

## Rozstrzygniecie chwilowosci — dwie sondy sterujace (bez tury, poza aplikacja)

Srodowisko powloki wykonawcy trzyma `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` (gateway
`api.z.ai`), wiec naiwna sonda przechodzi przez gateway i nic o subskrypcji nie mowi.
Runtime aplikacji skrubuje te zmienne (`subscriptionOnlyEnv`) i wylacza zrodla ustawien
(`settingSources: []`), wiec wiarygodna jest wylacznie sonda druga:

1. `claude -p` w czystej powloce → **przeszlo przez gateway api.z.ai** (model `glm-5.3-flash`)
   — sonda bezwartosciowa dla pytania o subskrypcje; zapisana tu tylko jako wyjasnienie metody.
2. `env -u ANTHROPIC_* claude -p --setting-sources ""` → **dokladnie ten sam komunikat blokady
   organizacji**, jak w wykonaniu T14.

Wniosek: blokada jest **rzeczywista i trwala w chwili proby** — polityka po stronie konta
(„organization has disabled"), nie bled scenariusza, nie fluktuacja limitu (klasyfikator
`classifyAccessFailure` nie mial tekstu limitu), nie wada aplikacji. Tury 1–20 dzialaly na tej
samej maszynie i tym samym logowaniu (ostatnia udana: tura 20, `2026-09-19T11-19-18-655Z`).

## Decyzja wykonawcy

**Rezerwa NIE zostala wydana** — powtorka odtworzylaby ten sam wynik i skonczyla grant bez
dowodu. Spec T14 jest jednoturkowy; po przywroceniu dostepu subskrypcyjnego (dzialanie
wlasciciela konta/administratora organizacji — poza zasiegiem tego programu) caly przebieg
to **jedno polecenie**: `APP_E2E_MODEL=1 APP_E2E_MODEL_Z11=1 npx playwright test e2e/bl03-model-t14.spec.ts`.
Kryteria L11.4 / L11.5 / ramie sekretow L11.11 pozostaja otwarte — nic nie zostalo domkniete
z rozumowania.

Stan rejestru po turze: **21/25, rezerwa (1 tura z przyznanych 2) nietknieta.**
