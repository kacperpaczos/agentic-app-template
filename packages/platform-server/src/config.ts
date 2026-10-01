import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { isSymlink, isWithin, realResolve } from './util/real-path.ts';

const int = (v: string | undefined, d: number) => {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : d;
};

/**
 * Who provides the model the harness executes.
 *
 * GLM is the only active provider in v0.4 (decyzja właściciela 2026-10-01).
 * The historical subscription policy remains in helpers for audit tests, but
 * `loadConfig` refuses to start an application with it. The Claude Agent SDK
 * remains the harness, and the model calls go to a GLM/Z.AI endpoint that
 * speaks the Anthropic wire protocol, configured with `ANTHROPIC_BASE_URL` and
 * `ANTHROPIC_AUTH_TOKEN`. Anything else is refused — an unknown value of
 * `APP_MODEL_PROVIDER` fails the start rather than falling back to the default,
 * because a typo silently selecting the paid-API policy would be worse than a
 * server that does not start.
 */
export type ModelProvider = 'subscription' | 'glm';

export const MODEL_PROVIDERS: readonly ModelProvider[] = ['glm'];

const isModelProvider = (v: string | undefined): v is ModelProvider => v === 'glm';

/**
 * Tolerant read of the provider from an environment.
 *
 * This helper preserves explicit subscription reporting for historical probes.
 * The strict active-provider decision lives in {@link loadConfig}.
 */
export function modelProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  return env.APP_MODEL_PROVIDER === 'subscription' ? 'subscription' : 'glm';
}

export interface PlatformConfig {
  dataDir: string;
  dbFile: string;
  filesDir: string;
  workspacesDir: string;
  port: number;
  /** Origins allowed to call the API with credentials. */
  allowedOrigins: string[];
  /** Static bundle served in production; absent in dev. */
  webDistDir: string | null;
  model: string;
  /** How the model is reached: GLM/Z.AI in active v0.4. */
  modelProvider: ModelProvider;
  /**
   * Origin of the Anthropic-compatible endpoint, **glm mode only**.
   *
   * The origin alone — never the full URL, whose query could carry a
   * credential, and never the token itself, which this configuration does not
   * hold anywhere. Diagnostics print it; nothing else reads it.
   */
  modelEndpointOrigin: string | null;
  /** Hard ceiling for a single agent run. */
  runTimeoutMs: number;
  /**
   * How long a permission request waits for the user before it is **refused**.
   *
   * A documented termination condition, not an implementation detail: together
   * with `runTimeoutMs` it is the complete list of ways a run ends without an
   * explicit Stop (see README, "Co konczy wykonanie bez Stop"). Configurable so
   * the regression can reach the expiry branch without waiting two minutes —
   * the branch that must deny, never allow.
   */
  consentTimeoutMs: number;
  maxUploadBytes: number;
  /**
   * Set by automated tests (`APP_INSTANCE_LABEL`), never in production.
   *
   * Two things depend on it. `/api/health` echoes it, so a test can prove it is
   * talking to an instance the test suite started rather than to one the user
   * has open; and `assertTestInstanceIsIsolated` below refuses to start a
   * labelled process anywhere near real data.
   */
  instanceLabel: string | null;
  /**
   * Identifies the *run* that started this process (`APP_INSTANCE_RUN_ID`).
   *
   * Set alongside `instanceLabel` by the test harness and echoed on
   * `/api/health` for the same reason the label is — with one difference that
   * matters: the label is identical for every test instance ever started, so it
   * proves "a test instance" and not "the instance this run just started". A
   * server orphaned by an interrupted run answers with the right label on a
   * database the new run has already deleted.
   */
  instanceRunId: string | null;
}

/** Label every server started by this repository's test suites carries. */
export const TEST_INSTANCE_LABEL = 'agenticapp-test';

/**
 * Ports reserved for automated tests.
 *
 * Starts above the application's default port (8791) so that a labelled test
 * instance cannot bind the port a user's instance listens on — the range is the
 * check, rather than a special case somewhere that could be forgotten.
 */
export const TEST_PORT_RANGE = { from: 8792, to: 8799 } as const;

/**
 * Refuses to run a test-labelled instance against anything that could be real.
 *
 * The guard lives here — in the product, at the point where the data directory
 * and the port are decided — and not only in the test harness, because the
 * failure it prevents is a *configuration* failure: an `APP_DATA_DIR` inherited
 * from the shell, a stale `PORT`, a config that resolved its relative path from
 * the wrong working directory. A harness that guards its own inputs still
 * misses every one of those the moment something else spawns the server.
 *
 * Deliberately fatal rather than corrective: silently redirecting a misconfigured
 * test to a safe directory would hide the misconfiguration and let the next
 * caller inherit it.
 */
export function assertTestInstanceIsIsolated(cfg: PlatformConfig, defaultDataDir: string): void {
  if (cfg.instanceLabel !== TEST_INSTANCE_LABEL) return;
  const problems: string[] = [];

  if (cfg.port < TEST_PORT_RANGE.from || cfg.port > TEST_PORT_RANGE.to) {
    problems.push(
      `port ${cfg.port} jest poza zakresem zarezerwowanym dla testow ` +
        `(${TEST_PORT_RANGE.from}-${TEST_PORT_RANGE.to})`,
    );
  }

  /*
   * The same directory, asked about twice: as written and as the filesystem
   * would reach it. A lexical comparison alone answers a question about text,
   * and a `.e2e-data` that is a symbolic link to the application's `data/`
   * passes every one of these conditions while the database it opens is the
   * user's. `realResolve` also follows links in the *ancestors*, so an
   * `APP_DATA_DIR` under a linked parent is judged by where it lands.
   */
  const realData = realResolve(cfg.dataDir);
  const realDefault = realResolve(defaultDataDir);

  if (isSymlink(cfg.dataDir)) {
    problems.push(
      `katalog danych ${cfg.dataDir} jest dowiazaniem symbolicznym i wskazuje ${realData}`,
    );
  }
  if (cfg.dataDir === defaultDataDir || realData === realDefault) {
    problems.push(
      `katalog danych ${cfg.dataDir} to domyslny katalog aplikacji` +
        (realData !== cfg.dataDir ? ` (rzeczywiscie ${realData})` : ''),
    );
  }
  for (const candidate of new Set([cfg.dataDir, realData])) {
    if (!basename(candidate).startsWith('.e2e')) {
      problems.push(
        `katalog danych ${candidate} nie nazywa sie jak katalog testowy ` +
          '(wymagany prefiks ".e2e" w nazwie katalogu)' +
          (candidate === realData && realData !== cfg.dataDir ? ` — to rzeczywisty cel ${cfg.dataDir}` : ''),
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `[izolacja testow] Instancja oznaczona jako testowa (APP_INSTANCE_LABEL=${TEST_INSTANCE_LABEL}) ` +
        `nie moze wystartowac z ta konfiguracja:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\nUstaw PORT w zakresie ${TEST_PORT_RANGE.from}-${TEST_PORT_RANGE.to} oraz APP_DATA_DIR na katalog ` +
        'o nazwie zaczynajacej sie od ".e2e". Zadna operacja nie zostala wykonana.',
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  /*
   * Provider first, and fail-closed: an unknown value of `APP_MODEL_PROVIDER`
   * refuses the start before anything else is resolved. The default — no
   * variable at all — selects GLM. An explicit subscription is refused.
   */
  if (env.APP_MODEL_PROVIDER !== undefined && !isModelProvider(env.APP_MODEL_PROVIDER)) {
    throw new Error(
      `[konfiguracja] APP_MODEL_PROVIDER="${env.APP_MODEL_PROVIDER}" jest wyłączony lub nieznany. ` +
        `Dozwolone wartości: ${MODEL_PROVIDERS.join(', ')}. Start odmówiony — ` +
        'inny provider modelu nigdy nie jest obsługiwany po cichu.',
    );
  }
  const modelProvider: ModelProvider = 'glm';

  /*
   * GLM mode has hard requirements, and a start without any one of them is
   * refused with the **complete** list of what is missing — not with the first
   * missing item, which would turn one misconfiguration into several failed
   * starts.
   */
  let modelEndpointOrigin: string | null = null;
  if (modelProvider === 'glm') {
    const missing: string[] = [];
    if (!env.APP_MODEL?.trim()) missing.push('APP_MODEL (model GLM, np. nazwa udostępniona przez Z.AI)');
    if (!env.ANTHROPIC_BASE_URL?.trim()) {
      missing.push('ANTHROPIC_BASE_URL (endpoint GLM/Z.AI kompatybilny z Anthropic)');
    }
    if (!env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      missing.push('ANTHROPIC_AUTH_TOKEN (token Z.AI podany wyłącznie w środowisku procesu)');
    }
    if (!env.CLAUDE_CONFIG_DIR?.trim()) {
      missing.push('CLAUDE_CONFIG_DIR (izolowany katalog konfiguracji; domyślny ~/.claude jest zakazany)');
    }

    const defaultClaudeDir = resolve(homedir(), '.claude');
    if (env.CLAUDE_CONFIG_DIR?.trim()) {
      const rawConfigDir = env.CLAUDE_CONFIG_DIR.trim();
      /*
       * Tylda nie jest rozwijana ani przez Node, ani przez ten plik: `~/.claude`
       * trafiłoby tu jako katalog o **nazwie** „~" obok bieżącego katalogu, czyli
       * zupełnie obok katalogu użytkownika — a miał być nim albo miał być
       * odrzucony. Obie te możliwości są złe, więc każdy człon ścieżki zaczynający
       * się od `~` odmawia startu zamiast go cicho utworzyć.
       */
      if (rawConfigDir.split(/[/\\]+/).some((segment) => segment.startsWith('~'))) {
        missing.push(
          `CLAUDE_CONFIG_DIR="${rawConfigDir}" zawiera „~" — tylda nie jest rozwijana, więc ` +
            'zamiast katalogu użytkownika powstałby katalog o nazwie „~"; podaj pełną ścieżkę bez tyldy',
        );
      } else {
        const given = resolve(rawConfigDir);
        const real = realResolve(given);
        if (given === defaultClaudeDir || real === defaultClaudeDir) {
          missing.push(
            `CLAUDE_CONFIG_DIR wskazuje domyślny katalog poświadczeń OAuth (${defaultClaudeDir}` +
              (real !== given ? `, rzeczywiście ${real}` : '') +
              ') — w trybie GLM poświadczenia OAuth nie są używane ani czytane; wskaż pusty, izolowany katalog',
          );
        } else if (isWithin(given, defaultClaudeDir) || isWithin(real, defaultClaudeDir)) {
          /*
           * Katalog WEWNĄTRZ `~/.claude` to wciąż drzewo poświadczeń OAuth: izolacja,
           * która siedzi obok pliku `.credentials.json`, nie jest izolacją od niego.
           * Porównanie po rozwiązaniu łapie też dowiązanie wchodzące do drzewa.
           */
          missing.push(
            `CLAUDE_CONFIG_DIR wchodzi w drzewo domyślnego katalogu poświadczeń OAuth ` +
              `(${defaultClaudeDir}${isWithin(real, defaultClaudeDir) && real !== given ? `; rzeczywiście ${real}` : ''}) ` +
              '— wskaż pusty, izolowany katalog poza nim',
          );
        }
      }
    }

    if (env.ANTHROPIC_BASE_URL?.trim()) {
      try {
        modelEndpointOrigin = new URL(env.ANTHROPIC_BASE_URL).origin;
      } catch {
        missing.push(`ANTHROPIC_BASE_URL="${env.ANTHROPIC_BASE_URL}" nie jest poprawnym adresem URL`);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `[konfiguracja] Tryb APP_MODEL_PROVIDER=glm wymaga zmiennych środowiskowych, których brakuje:\n` +
          missing.map((m) => `  - ${m}`).join('\n') +
          '\nStart odmówiony. Żadna operacja nie została wykonana.',
      );
    }
  }

  const defaultDataDir = resolve(process.cwd(), 'data');
  const dataDir = resolve(env.APP_DATA_DIR ?? defaultDataDir);
  const cfg: PlatformConfig = {
    dataDir,
    dbFile: resolve(dataDir, 'app.db'),
    filesDir: resolve(dataDir, 'files'),
    workspacesDir: resolve(dataDir, 'workspaces'),
    port: int(env.PORT, 8791),
    allowedOrigins: (env.APP_ALLOWED_ORIGINS ??
      'http://localhost:5173,http://127.0.0.1:5173,http://localhost:8791,http://127.0.0.1:8791')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    webDistDir: env.APP_WEB_DIST ? resolve(env.APP_WEB_DIST) : null,
    model: env.APP_MODEL!.trim(),
    modelProvider,
    modelEndpointOrigin,
    runTimeoutMs: int(env.APP_RUN_TIMEOUT_MS, 300_000),
    consentTimeoutMs: int(env.APP_CONSENT_TIMEOUT_MS, 120_000),
    maxUploadBytes: int(env.APP_MAX_UPLOAD_BYTES, 8 * 1024 * 1024),
    instanceLabel: env.APP_INSTANCE_LABEL ?? null,
    instanceRunId: env.APP_INSTANCE_RUN_ID ?? null,
  };
  // Before `mkdirSync`: a misconfigured test instance must not even create a
  // directory next to real data, let alone open the database there.
  assertTestInstanceIsIsolated(cfg, defaultDataDir);
  for (const d of [cfg.dataDir, cfg.filesDir, cfg.workspacesDir]) {
    mkdirSync(d, { recursive: true });
  }
  return cfg;
}
