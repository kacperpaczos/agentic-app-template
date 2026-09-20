/**
 * Asks the installed Claude Agent SDK how it is authenticated, for the record.
 *
 * ```
 * node --experimental-transform-types --no-warnings=ExperimentalWarning scripts/probe-sdk-session.ts
 * ```
 *
 * **This spends no subscription turn.** It opens an SDK session whose input
 * stream never yields a message and asks two *control requests* — messages the
 * CLI answers itself, without reaching a model — and then closes it. Nothing is
 * prompted and nothing is generated.
 *
 * It runs the probe three times, and the third run is what makes the first two
 * worth reading:
 *
 *  1. the environment the application hands the agent, as it stands;
 *  2. the same, with `ANTHROPIC_API_KEY` present **in the parent process** —
 *     the case L8.3 asks about: does a key someone exported into their shell
 *     change the path a run takes? It must not, because the policy removes it;
 *  3. the same key with the policy **switched off**, so the key really is on
 *     the path.
 *
 * Runs 1 and 2 answer "the active path is the subscription". Run 3 answers "and
 * this probe would have said otherwise if it were not" — without it, two
 * identical answers could equally mean the probe is blind to the difference.
 * A policy that only deletes environment variables can be believed; a policy
 * whose configurations produce different, observable answers has been checked.
 *
 * The key used in runs 2 and 3 is a **fake**. `apiKeySource` reports where a
 * credential came from, not whether it works, so an invalid key is enough to
 * observe the path — and an invalid key cannot spend anything.
 *
 * Nothing personal is recorded. `accountInfo()` also returns the account's
 * e-mail and organisation; `classifySdkSession` copies neither, and this script
 * writes only what that function returns.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { probeSdkSession } from '@platform/server';

const EVIDENCE_DIR = 'docs/evidence/z12-bl04';
/*
 * Plik dowodowy zalezy od trybu: probe w trybie glm pisze do WLASNEGO pliku,
 * nigdy do `sesja-sdk.json` z BL-04 — nadpisanie istniejacego dowodu proba
 * glm wydarzylo sie 2026-09-20 i zostalo odkrecone (dowod oryginalny przywrocony
 * z gita, wynik glm zachowany jako `sesja-sdk-glm.json`).
 */
const FILE = process.env.APP_MODEL_PROVIDER === 'glm' ? 'sesja-sdk-glm.json' : 'sesja-sdk.json';

/** A key that is syntactically a key and cannot buy anything. */
const FAKE_KEY = 'sk-ant-api03-PROBA-NIEPRAWDZIWY-KLUCZ-BEZ-WARTOSCI';

const require = createRequire(resolve(process.cwd(), 'packages/platform-server/src/index.ts'));
const packageVersion = (name: string): string => {
  try {
    let dir = dirname(require.resolve(name));
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
    return 'nieznana';
  } catch {
    return 'nieznana';
  }
};

/** Wersja CLI **wbudowanej w zainstalowany SDK** — tej, ktora wykonuje prace. */
function sdkBundledCli(): { wersja: string; commit: string } | null {
  let dir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
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

const shell = (cmd: string, args: string[]): string => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'nieznana';
  }
};

/*
 * Wariant oczekiwań zależy od trybu, nigdy od wartości tokena: w subskrypcji
 * środowisko aplikacji ma prowadzić do sesji `subscription`; w jawnym trybie
 * GLM środowisko aplikacji celowo niesie poświadczenie endpointu, więc sesja
 * `subscription` byłaby tu NIESPÓJNA z trybem. Wartość tokena nie trafia do
 * rekordu w żadnym wariancie — zapis mówi o źródle poświadczenia, nie o jego
 * treści.
 */
const GLM_MODE = process.env.APP_MODEL_PROVIDER === 'glm';
const PROVIDER = GLM_MODE ? 'glm' : 'subscription';

const subscription = await probeSdkSession({ timeoutMs: 45_000, provider: PROVIDER });
const keyInParent = await probeSdkSession({
  env: { ...process.env, ANTHROPIC_API_KEY: FAKE_KEY },
  timeoutMs: 45_000,
  provider: PROVIDER,
});
const keyOnPath = await probeSdkSession({
  env: { ...process.env, ANTHROPIC_API_KEY: FAKE_KEY },
  applyPolicy: false,
  timeoutMs: 45_000,
});

const record = {
  opis: GLM_MODE
    ? 'Sposob uwierzytelnienia sesji Claude Agent SDK w JAWNYM TRYBIE GLM, odczytany zadaniem ' +
      'sterujacym accountInfo() oraz odczytem limitow planu. Zadanie sterujace nie wydaje tury ' +
      'modelu: sesja nie dostaje zadnego polecenia, a strumien wejsciowy nie emituje wiadomosci. ' +
      'Subskrypcja Claude jest w tym trybie nieuzywana.'
    : 'Sposob uwierzytelnienia sesji Claude Agent SDK, odczytany zadaniem sterujacym accountInfo() ' +
      'oraz odczytem limitow planu. Zadanie sterujace nie wydaje tury modelu: sesja nie dostaje ' +
      'zadnego polecenia, a strumien wejsciowy nie emituje wiadomosci.',
  zrodlo:
    'node --experimental-transform-types --no-warnings=ExperimentalWarning scripts/probe-sdk-session.ts',
  rodzajDowodu: 'rzeczywiste wywolanie SDK (zadanie sterujace, bez tury modelu)',
  zapisano: new Date().toISOString(),
  provider: GLM_MODE
    ? {
        nazwa: 'GLM/Z.AI',
        endpoint: (() => {
          try {
            return new URL(process.env.ANTHROPIC_BASE_URL ?? '').origin;
          } catch {
            return 'nieustalony';
          }
        })(),
        model: process.env.APP_MODEL ?? 'nieustalony',
        subskrypcjaClaude: 'nieuzywana (tryb GLM)',
      }
    : 'subskrypcja Claude (domyslny tryb)',
  wersje: {
    node: process.versions.node,
    /*
     * Dwa CLI, nie jedno. `claude` z PATH jest srodowiskiem — sonda idzie przez SDK,
     * a SDK uruchamia wlasne CLI z pakietu (obserwacja: scripts/probe-which-cli.mjs,
     * docs/evidence/z13-bl12/ktore-cli-uruchamia-sdk.json). Aktualnosc zapisu
     * rozstrzyga `claudeCliWSdk`, bo tylko ono bralo udzial w przebiegu.
     */
    claudeCli: shell('claude', ['--version']).split('\n')[0] ?? 'nieznana',
    claudeCliWSdk: sdkBundledCli()?.wersja ?? 'nieznana',
    claudeCliWSdkCommit: sdkBundledCli()?.commit ?? 'nieznany',
    claudeAgentSdk: packageVersion('@anthropic-ai/claude-agent-sdk'),
    mastraClaude: packageVersion('@mastra/claude'),
    mastraCore: packageVersion('@mastra/core'),
    commit: shell('git', ['rev-parse', 'HEAD']),
  },
  przebiegi: {
    /* The path the application actually takes. */
    srodowiskoAplikacji: {
      warunki: GLM_MODE
        ? 'env = subscriptionOnlyEnv(process.env, "glm"): przepuszczone wylacznie ANTHROPIC_BASE_URL ' +
          'i ANTHROPIC_AUTH_TOKEN (endpoint GLM); usuniete ANTHROPIC_API_KEY, Bedrock, Vertex, ' +
          'ANTHROPIC_MODEL i zmienne mostka CLAUDE_CODE_* poza CLAUDE_CONFIG_DIR. Spodziewany wynik: ' +
          'sesja NIE jest subskrypcja OAuth — poświadczeniem jest token endpointu.'
        : 'env = subscriptionOnlyEnv(process.env): usuniete ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ' +
          'ANTHROPIC_BASE_URL, Bedrock, Vertex i zmienne mostka CLAUDE_CODE_* poza CLAUDE_CONFIG_DIR.',
      wynik: subscription,
    },
    /* The case the criterion asks about: a key in the operator's own shell. */
    kluczApiWProcesieNadrzednym: {
      warunki:
        'ANTHROPIC_API_KEY ustawiony w srodowisku procesu nadrzednego, polityka wlaczona. Klucz jest ' +
        'nieprawdziwy — apiKeySource opisuje pochodzenie poswiadczenia, nie jego waznosc, wiec do ' +
        'obserwacji sciezki wystarczy, a kupic nic nie moze.' +
        (GLM_MODE
          ? ' W trybie GLM token endpointu (AUTH_TOKEN) i tak przechodzi polityki; ten przebieg pokazuje, ' +
            'co widzi sonda, gdy w procesie nadrzednym jest DRUGIE poswiadczenie.'
          : ''),
      wynik: keyInParent,
    },
    /* The control: the same key, with the policy switched off. */
    kluczApiPrzyWylaczonejPolityce: {
      warunki:
        'ten sam klucz, applyPolicy: false — srodowisko przekazane bez czyszczenia. Przebieg istnieje ' +
        'wylacznie po to, zeby pokazac, ze sonda widzi roznice; aplikacja nigdy tak nie uruchamia agenta.',
      wynik: keyOnPath,
    },
  },
  wniosek: GLM_MODE
    ? subscription.state !== 'subscription' && keyOnPath.state !== 'subscription'
      ? 'Tryb GLM potwierdzony: sesja w srodowisku aplikacji NIE jest subskrypcja OAuth — korzysta z ' +
        'poswiadczenia endpointu (stan "' +
        subscription.state +
        '"), a kontrola przy wylaczonej polityce pokazuje, ze sonda rozroznia stany. Subskrypcja ' +
        'Claude pozostaje nieuzywana.'
      : `Kontrola nie wypadla spojnie z trybem GLM: srodowisko aplikacji => "${subscription.state}", ` +
        `klucz przy wylaczonej polityce => "${keyOnPath.state}". Sesja nie powinna raportowac ` +
        'subskrypcji OAuth w trybie, ktory jej nie uzywa. Zobacz pole error kazdego przebiegu.'
    : subscription.state === 'subscription' &&
        keyInParent.state === 'subscription' &&
        keyOnPath.state === 'api_key'
      ? 'Aktywna sciezka to subskrypcja OAuth. Klucz API obecny w procesie nadrzednym nie zmienia ' +
        'sciezki, a ten sam klucz przy wylaczonej polityce jest przez sonde widziany — wiec jego brak ' +
        'w przebiegu aplikacji jest obserwacja, a nie zalozeniem.'
      : `Kontrola nie wypadla rozstrzygajaco: srodowisko aplikacji => "${subscription.state}", ` +
        `klucz w procesie nadrzednym => "${keyInParent.state}", ` +
        `klucz przy wylaczonej polityce => "${keyOnPath.state}". Zobacz pole error kazdego przebiegu.`,
  czegoToNieDowodzi: [
    'To nie jest dowod wyczerpania limitu. Pole planLimits to ODCZYT rzeczywistego wykorzystania okien ' +
      'planu, nie jego wyczerpanie; kryteria L8.11 i L8.12 pozostaja otwarte w tej czesci.',
    'Zadanie sterujace potwierdza sposob logowania sesji, nie przebieg pelnej tury modelu z narzedziami.',
  ],
};

const dir = resolve(process.cwd(), EVIDENCE_DIR);
mkdirSync(dir, { recursive: true });
const body = `${JSON.stringify(record, null, 2)}\n`;
writeFileSync(resolve(dir, FILE), body);
console.log(body);
console.log(`[sonda] zapisano ${EVIDENCE_DIR}/${FILE}`);
