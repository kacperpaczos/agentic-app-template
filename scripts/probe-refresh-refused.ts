/**
 * Próba odbiorowa: co naprawdę robi SDK, gdy odświeżenie tokena zostaje odrzucone.
 *
 * ```
 * # próba na zastępniku — nic nie dotyka SDK ani sieci
 * node --experimental-transform-types --no-warnings=ExperimentalWarning scripts/probe-refresh-refused.ts --rehearsal
 * # przebieg rzeczywisty
 * node --experimental-transform-types --no-warnings=ExperimentalWarning scripts/probe-refresh-refused.ts
 * ```
 *
 * ## Po co
 *
 * Klasyfikator `classifyAccessFailure` rozpoznaje odmowę odnowienia po podciągach
 * (`refresh` + `fail`/`invalid`/…). Żaden z nich nie był potwierdzony na komunikacie, który SDK
 * naprawdę produkuje — to był zapisany brak L8.10 i połowa braku L8.11. Ta próba bierze **prawdziwy**
 * komunikat i porównuje go z tym, co aplikacja z nim robi.
 *
 * ## Dlaczego to nie niszczy logowania użytkownika
 *
 * Poświadczenie użyte w próbie jest **kopią z celowo zepsutymi tokenami**: zarówno `accessToken`, jak
 * i `refreshToken` są zastąpione wartościami, które nigdy nie były tokenami. Do serwera idzie żądanie
 * odnowienia z wartością nieistniejącą, więc nie ma czego unieważnić. Prawdziwy plik nie jest
 * czytany po nic poza kształtem i **nigdy nie jest zapisywany**; jego odcisk (rozmiar, czas
 * modyfikacji, skrót obu tokenów) jest brany przed próbą i porównywany po niej.
 *
 * ## Dlaczego NIE robimy wariantu ze **skutecznym** odnowieniem
 *
 * Bo byłby destrukcyjny, i to nie hipotetycznie. W bundlu CLI 2.1.277 widać dwie rzeczy:
 *
 *  1. zapis odświeżonego poświadczenia jest **compare-and-swap po `refreshToken`** — CLI nadpisuje
 *     plik tylko wtedy, gdy leżący tam refresh token jest wciąż tym, od którego zaczynało. Taki
 *     zamek istnieje dlatego, że odświeżenie **wymienia** zestaw tokenów;
 *  2. gdy odnowienie wraca z `invalid_grant`, CLI **kasuje poświadczenie na dysku**
 *     (`refreshToken: ""`, `accessToken: ""`, `expiresAt: 0`) i oznacza token jako martwy
 *     (`tengu_oauth_refresh_token_marked_dead_invalid_grant`, `tengu_oauth_refresh_token_cleared_on_disk`).
 *
 * Z (1) wynika, że użycie **prawdziwego** refresh tokena z kopii zostawiłoby w prawdziwym pliku token
 * poprzedniej generacji. Z (2) wynika, co się wtedy stanie przy najbliższym odświeżeniu użytkownika:
 * CLI wyczyści mu logowanie na dysku. Czyli próba „skutecznego odświeżenia na kopii” kończy się
 * wylogowaniem użytkownika kilka godzin później — dokładnie tym, czego zakazuje warunek zamknięcia
 * tego pakietu. Dlatego L8.10 zostaje otwarte w tej połowie, a powód jest zapisany, nie przemilczany.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_USER_ID,
  classifyAccessFailure,
  claudeConfigDir,
  credentialFilePath,
  probeAuth,
  resetVerification,
  type ModelAgentLike,
} from '@platform/server';
import { composeApp } from '../apps/server/src/compose.ts';

const REHEARSAL = process.argv.includes('--rehearsal');

/*
 * Tryb GLM pomina próbę — i robi to ZANIM cokolwiek dotknie pliku poświadczeń.
 *
 * Ta sonda czyta prawdziwy plik poświadczeń (kształt, nie wartości) i kieruje
 * SDK na jego kopię, licząc na próbę odnowienia OAuth. W jawnym trybie GLM
 * poświadczenia OAuth nie są używane, więc i ta próba nie ma o czym mówić —
 * a czytanie prawdziwego pliku byłoby sprzeczne z tą trybem wprost. Pominięcie
 * jest zapisane, nie przemilczane.
 */
if (process.env.APP_MODEL_PROVIDER === 'glm') {
  const record = {
    zapisano: new Date().toISOString(),
    pominieto: true,
    powod:
      'APP_MODEL_PROVIDER=glm: próba czyta plik poświadczeń OAuth i próbuje odnowienia — ' +
      'w trybie GLM poświadczenia OAuth są nieużywane, a ich czytanie sprzeczne z trybem. ' +
      'Żadna próba nie została wykonana, żaden plik nie został czytany.',
  };
  console.log(`[sonda] POMINIĘTO: ${record.powod}`);
  console.log(JSON.stringify(record, null, 2));
  process.exit(0);
}

/** Tekst zaobserwowany na rzeczywistej awarii SDK 0.3.270. */
const REAL_SDK_AUTH_FAILURE =
  'Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed';
/**
 * Który przypadek graniczny odtwarzamy.
 *
 * `refresh-refused` — termin w przeszłości, więc CLI **musi** spróbować odnowienia i dostaje odmowę.
 * `revoked`         — termin w przyszłości, więc CLI wysyła (martwy) token dostępu i dostaje odmowę
 *                     od API. To jest ten drugi przypadek, który L8.11 każe odróżnić od pierwszego.
 *
 * Oba używają wartości, które nigdy nie były tokenami, więc oba są bezpieczne dla logowania
 * użytkownika i **oba kosztują zero tur**: żądanie nie dociera do modelu, bo nie przechodzi
 * uwierzytelnienia.
 */
const MODE: 'refresh-refused' | 'revoked' =
  process.argv.includes('--revoked') ? 'revoked' : 'refresh-refused';
const EVIDENCE_DIR = 'docs/evidence/z12-bl04';

/** Wartości, które nigdy nie były tokenem. Nie ma czego unieważnić. */
const DEAD_ACCESS = 'PROBA-ODMOWY-ODNOWIENIA-access-nigdy-nie-byl-tokenem';
const DEAD_REFRESH = 'PROBA-ODMOWY-ODNOWIENIA-refresh-nigdy-nie-byl-tokenem';

const sha = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);

/** Odcisk prawdziwego pliku poświadczeń: sam w sobie nie jest sekretem. */
function fingerprintRealCredential(): Record<string, unknown> {
  const file = credentialFilePath({} as NodeJS.ProcessEnv); // bez CLAUDE_CONFIG_DIR = katalog użytkownika
  if (!existsSync(file)) return { plik: file, obecny: false };
  const st = statSync(file);
  const oauth = (JSON.parse(readFileSync(file, 'utf8')) as any)?.claudeAiOauth ?? {};
  return {
    plik: file,
    obecny: true,
    bajtow: st.size,
    mtimeMs: st.mtimeMs,
    accessTokenSha: typeof oauth.accessToken === 'string' ? sha(oauth.accessToken) : null,
    refreshTokenSha: typeof oauth.refreshToken === 'string' ? sha(oauth.refreshToken) : null,
    expiresAt: oauth.expiresAt ?? null,
  };
}

/* ----------------------------- przygotowanie ------------------------------ */

const before = fingerprintRealCredential();

const configDir = mkdtempSync(resolve(tmpdir(), 'proba-odmowy-odnowienia-'));
const dataDir = resolve(process.cwd(), '.e2e-scripted-refresh-refused');

/*
 * Trzy bezpieczniki przed czymkolwiek innym. Katalog konfiguracji próby musi być tymczasowy, musi
 * różnić się od katalogu użytkownika, a katalog danych nie może być katalogiem danych aplikacji.
 */
const realConfig = claudeConfigDir({} as NodeJS.ProcessEnv);
if (!configDir.startsWith(tmpdir())) throw new Error('bezpiecznik: katalog proby nie jest tymczasowy');
if (resolve(configDir) === resolve(realConfig)) throw new Error('bezpiecznik: proba celuje w katalog uzytkownika');
if (dataDir.includes('/data') && !dataDir.includes('.e2e-')) throw new Error('bezpiecznik: katalog danych aplikacji');

// Kopia kształtu, nigdy wartości: prawdziwe tokeny nie trafiają do pliku próby.
const shape = before.obecny
  ? (JSON.parse(readFileSync(credentialFilePath({} as NodeJS.ProcessEnv), 'utf8')) as any).claudeAiOauth
  : { subscriptionType: 'max', scopes: ['user:inference'] };
writeFileSync(
  resolve(configDir, '.credentials.json'),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: DEAD_ACCESS,
      refreshToken: DEAD_REFRESH,
      /*
       * W trybie `refresh-refused` termin jest w przeszłości, więc CLI musi spróbować odnowienia.
       * W trybie `revoked` jest w przyszłości, więc CLI użyje martwego tokena dostępu i dostanie
       * odmowę od API — czyli inną ścieżkę i inny komunikat.
       */
      expiresAt: MODE === 'revoked' ? Date.now() + 3600_000 : Date.now() - 3600_000,
      refreshTokenExpiresAt: shape.refreshTokenExpiresAt ?? Date.now() + 30 * 86400_000,
      scopes: shape.scopes ?? ['user:inference'],
      subscriptionType: shape.subscriptionType ?? 'max',
    },
  }),
);

process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.APP_DATA_DIR = dataDir;
process.env.APP_SKIP_BASE_DATA = '1';
process.env.APP_INSTANCE_LABEL = 'agenticapp-test';
/*
 * Port z zakresu zarezerwowanego dla testow. Ta proba nie serwuje HTTP, ale `loadConfig` sprawdza
 * konfiguracje instancji oznaczonej jako testowa **zanim** cokolwiek wystartuje — i slusznie: to ta
 * sama kontrola, ktora nie pozwala probie trafic w instancje uzytkownika na 8791. Wyszlo na probie
 * generalnej, czyli tam, gdzie mialo wyjsc.
 */
process.env.PORT = process.env.PORT ?? '8797';
if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

/* ------------------------------- przebieg -------------------------------- */

/**
 * Zastępnik do próby generalnej: rzuca **tym komunikatem, który SDK naprawdę
 * produkuje** (potwierdzonym w `docs/evidence/z12-bl04/refresh-refused-*.json`).
 *
 * Wcześniej rzucał zakładanym `OAuth token refresh failed: invalid_grant`, więc
 * próba generalna ćwiczyła inny tekst niż przebieg rzeczywisty — czyli
 * sprawdzała trochę nie to.
 */
const rehearsalAgent: ModelAgentLike = {
  stream: async () => ({
    fullStream: (async function* () {
      yield { type: 'error', payload: { error: new Error(REAL_SDK_AUTH_FAILURE) } };
    })(),
  }),
  resumeStream: async () => ({
    fullStream: (async function* () {
      yield { type: 'error', payload: { error: new Error(REAL_SDK_AUTH_FAILURE) } };
    })(),
  }),
};

resetVerification();
const platform = composeApp({ modules: 'none', dataDir, modelAgent: REHEARSAL ? rehearsalAgent : null });

const conversation = platform.services.conversations.create({
  ownerId: DEFAULT_USER_ID,
  firstMessage: { content: 'Odpowiedz jednym slowem: test.' },
});

const started = await platform.runtime.start({
  ownerId: DEFAULT_USER_ID,
  conversationId: conversation.id,
  prompt: 'Odpowiedz jednym slowem: test.',
  appContext: {
    conversationId: conversation.id,
    spaceId: null,
    resource: null,
    selection: [],
    filters: {},
    viewport: null,
    drafts: [],
    ui: null,
  } as never,
});

const events: Array<Record<string, any>> = [];
const reader = (async () => {
  for await (const e of started.stream.read(0)) events.push(e.event as Record<string, any>);
})();
await started.done;
await reader;

const run = platform.services.runs.get(started.runId, DEFAULT_USER_ID);
const runError = events.find((e) => e.type === 'RUN_ERROR');
const message = String(run?.errorMessage ?? runError?.message ?? '');
const status = probeAuth();

/** Czy CLI skasowało poświadczenie próby na dysku (obserwacja, nie założenie). */
const afterProbeCredential = (() => {
  const file = resolve(configDir, '.credentials.json');
  if (!existsSync(file)) return { obecny: false, skasowanePrzezCli: true };
  const oauth = (JSON.parse(readFileSync(file, 'utf8')) as any)?.claudeAiOauth ?? {};
  return {
    obecny: true,
    refreshTokenPusty: oauth.refreshToken === '',
    accessTokenPusty: oauth.accessToken === '',
    expiresAtZerowane: oauth.expiresAt === 0,
    /* true = CLI wyczyściło plik próby, dokładnie tak, jak zrobiłoby z plikiem użytkownika */
    skasowanePrzezCli: oauth.refreshToken === '' && oauth.accessToken === '',
  };
})();

const after = fingerprintRealCredential();
const untouched =
  JSON.stringify({ ...before, mtimeMs: undefined }) === JSON.stringify({ ...after, mtimeMs: undefined }) &&
  before.mtimeMs === after.mtimeMs;

/** Wersja CLI **wbudowanej w zainstalowany SDK** — tej, ktora wykonala ten przebieg. */
function sdkBundledCli(): { wersja: string; commit: string } | null {
  const req = createRequire(resolve(process.cwd(), 'packages/platform-server/package.json'));
  let dir = dirname(req.resolve('@anthropic-ai/claude-agent-sdk'));
  for (let i = 0; i < 6; i += 1) {
    const manifest = resolve(dir, 'manifest.json');
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string; commit?: string };
      if (json.version) return { wersja: json.version, commit: json.commit ?? 'nieznany' };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Wersja zainstalowanego pakietu, czytana z jego manifestu. */
function packageVersion(name: string): string {
  const req = createRequire(resolve(process.cwd(), 'packages/platform-server/package.json'));
  try {
    let dir = dirname(req.resolve(name));
    for (let i = 0; i < 8; i += 1) {
      const manifest = resolve(dir, 'package.json');
      if (existsSync(manifest)) {
        const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
        if (json.name === name && json.version) return json.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* nieustalona */
  }
  return 'nieustalona';
}

const git = (args: string[]): string => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'nieznany';
  }
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const record = {
  przypadek: MODE,
  opis:
    (MODE === 'revoked'
      ? 'Odwolane (martwe) logowanie: komunikat, ktory naprawde produkuje Claude Agent SDK, gdy token '
        + 'dostepu jest nieprawidlowy, a termin jeszcze nie minal, i to, co robi z nim aplikacja. '
      : 'Odmowa odnowienia tokena: komunikat, ktory naprawde produkuje Claude Agent SDK, i to, co robi '
        + 'z nim aplikacja. ') +
    'Poswiadczenie proby ma CELOWO ZEPSUTE oba tokeny, wiec zadna prawdziwa wartosc nie jest uzywana ' +
    'ani uniewazniana. Przebieg nie przechodzi uwierzytelnienia, wiec nie dociera do modelu i NIE ' +
    'WYDAJE TURY SUBSKRYPCJI.',
  rodzajDowodu: REHEARSAL
    ? 'proba generalna na zastepniku (bez SDK, bez sieci) — NIE jest dowodem'
    : 'rzeczywisty przebieg przez Claude Agent SDK',
  zrodlo:
    `node --experimental-transform-types scripts/probe-refresh-refused.ts` +
    `${MODE === 'revoked' ? ' --revoked' : ''}${REHEARSAL ? ' --rehearsal' : ''}`,
  turySubskrypcji: 0,
  zapisano: new Date().toISOString(),
  wersje: {
    node: process.versions.node,
    /*
     * `claude` z PATH jest **srodowiskiem**, nie mechanizmem: przebieg idzie przez SDK, a SDK
     * uruchamia wlasne CLI z pakietu. Zapisane sa obie wartosci, ale aktualnosc zapisu rozstrzyga
     * ta ponizej — zob. docs/evidence/z13-bl12/ktore-cli-uruchamia-sdk.json.
     */
    claudeCli: (() => {
      try {
        return execFileSync('claude', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
          .trim()
          .split('\n')[0];
      } catch {
        return 'nieznana';
      }
    })(),
    claudeCliWSdk: sdkBundledCli()?.wersja ?? 'nieznana',
    claudeCliWSdkCommit: sdkBundledCli()?.commit ?? 'nieznany',
    claudeAgentSdk: packageVersion('@anthropic-ai/claude-agent-sdk'),
    mastraClaude: packageVersion('@mastra/claude'),
    commit: git(['rev-parse', 'HEAD']),
    brudneDrzewo: git(['status', '--porcelain']) !== '',
  },
  warunki: {
    katalogKonfiguracji: configDir,
    accessToken: 'zastapiony wartoscia, ktora nigdy nie byla tokenem',
    refreshToken: 'zastapiony wartoscia, ktora nigdy nie byla tokenem',
    expiresAt:
      MODE === 'revoked'
        ? 'godzine w PRZYSZLOSCI, wiec CLI nie ma powodu odnawiac z wlasnej inicjatywy'
        : 'godzine w PRZESZLOSCI, wiec CLI musi sprobowac odnowienia',
    czegoTenTrybNIEodtwarza:
      MODE === 'revoked'
        ? 'To NIE jest odwolane logowanie. Refresh token jest tu tak samo nieprawidlowy jak w trybie ' +
          'refresh-refused — oba tryby roznia sie WYLACZNIE wartoscia expiresAt. Prawdziwe odwolanie ' +
          '(poprawny refresh token odrzucony po stronie serwera) nie zostalo wytworzone i nie da sie ' +
          'go wytworzyc bez konta testowego.'
        : 'Nie odtwarza wyczerpania limitu ani bledu sieci.',
  },
  wynik: {
    statusUruchomienia: run?.status ?? null,
    kodBledu: run?.errorCode ?? null,
    komunikatSdk: message.slice(0, 1200),
    klasyfikacjaAplikacji: classifyAccessFailure(message),
    stanDostepuPoPrzebiegu: status.access.state,
    zdarzenRunError: events.filter((e) => e.type === 'RUN_ERROR').length,
  },
  poswiadczenieProbyPoPrzebiegu: afterProbeCredential,
  logowanieUzytkownika: {
    nietkniete: untouched,
    przed: before,
    po: after,
    uwaga:
      'Skroty tokenow sa po to, zeby dalo sie stwierdzic ZMIANE bez zapisywania wartosci. ' +
      'Rozny skrot po przebiegu znaczylby, ze proba dotknela logowania uzytkownika.',
  },
  czegoToNieDowodzi: [
    'To nie jest dowod SKUTECZNEGO odnowienia — tamten wariant wymagalby uzycia prawdziwego refresh ' +
      'tokena z kopii, co przy wymianie tokenow zostawiloby w pliku uzytkownika token poprzedniej ' +
      'generacji, a CLI kasuje poswiadczenie na dysku, gdy odnowienie wraca z invalid_grant. L8.10 ' +
      'zostaje w tej polowie otwarte swiadomie.',
    'To nie jest dowod wyczerpania limitu (L8.11).',
  ],
};

mkdirSync(resolve(process.cwd(), EVIDENCE_DIR), { recursive: true });
const name = REHEARSAL
  ? `proba-generalna-${MODE}.json`
  : `${MODE}-${stamp}.json`;
writeFileSync(resolve(process.cwd(), EVIDENCE_DIR, name), `${JSON.stringify(record, null, 2)}\n`);

console.log(JSON.stringify(record, null, 2));
console.log(`\n[proba] zapisano ${EVIDENCE_DIR}/${name}`);
if (!untouched) console.error('[proba] UWAGA: odcisk prawdziwego poswiadczenia zmienil sie w trakcie proby!');

platform.close();
rmSync(configDir, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });
process.exit(untouched ? 0 : 3);
