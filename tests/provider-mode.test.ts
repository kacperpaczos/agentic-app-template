import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatform, loadConfig, probeAuth, scrubbedEnvKeys, subscriptionOnlyEnv } from '@platform/server';
import { authIsConfirmed, authIsUsable, UNPROBED_SDK_SESSION } from '@platform/contracts';

/**
 * The explicit GLM provider mode (decyzja właściciela 2026-09-20).
 *
 * The harness stays the Claude Agent SDK; the model calls go to a GLM/Z.AI
 * endpoint that speaks the Anthropic protocol. Everything in this file is a
 * **contract or logic test**: no model is called, no network is touched, and
 * the endpoint below is a name that cannot be reached (`.invalid` TLD). The
 * token values here are fakes — they exist so the tests can prove where they
 * travel and, more importantly, where they never appear.
 *
 * The default subscription mode must keep behaving exactly as before; the
 * assertions for it live with the existing suites and are repeated here only
 * as the negative control for the pass-through below.
 */

const FAKE_TOKEN = 'FAKE-GLM-TOKEN-nigdy-nie-byl-tokenem';
const FAKE_ENDPOINT = 'https://glm.endpoint.invalid';
const FAKE_MODEL = 'glm-fake-model';

const dirs: string[] = [];
const isoDir = (prefix = 'glm-config-'): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const glmEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  APP_DATA_DIR: isoDir('glm-data-'),
  APP_MODEL_PROVIDER: 'glm',
  APP_MODEL: FAKE_MODEL,
  ANTHROPIC_BASE_URL: FAKE_ENDPOINT,
  ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN,
  CLAUDE_CONFIG_DIR: isoDir(),
  ...over,
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('konfiguracja: fail-closed wokol APP_MODEL_PROVIDER', () => {
  it('brak zmiennej to tryb subskrypcji — zachowanie domyslne bez zmian', () => {
    const cfg = loadConfig({ APP_DATA_DIR: isoDir() });
    expect(cfg.modelProvider).toBe('subscription');
    expect(cfg.modelEndpointOrigin).toBeNull();
  });

  it('nieznana wartosc odmawia startu, zamiast cicho wybrac subskrypcje', () => {
    expect(() => loadConfig({ APP_DATA_DIR: isoDir(), APP_MODEL_PROVIDER: 'openai' })).toThrow(
      /APP_MODEL_PROVIDER.*nieznany/i,
    );
  });

  it('tryb glm bez czegokolwiek wymienia WSZYSTKIE braki naraz, nie tylko pierwszy', () => {
    try {
      loadConfig({ APP_DATA_DIR: isoDir(), APP_MODEL_PROVIDER: 'glm' });
      expect.unreachable('start bez wymaganych zmiennych ma byc odmowiony');
    } catch (err) {
      const message = String((err as Error).message);
      for (const required of ['APP_MODEL', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR']) {
        expect(message, `komunikat ma wymieniac ${required}`).toContain(required);
      }
    }
  });

  it('kazdy pojedynczy brak jest wykrywany osobno', () => {
    for (const [key, value] of [
      ['APP_MODEL', undefined],
      ['ANTHROPIC_BASE_URL', undefined],
      ['ANTHROPIC_AUTH_TOKEN', undefined],
      ['CLAUDE_CONFIG_DIR', undefined],
      // An empty value is as good as none at all.
      ['ANTHROPIC_AUTH_TOKEN', '   '],
    ] as const) {
      const env = glmEnv({ [key]: value });
      expect(() => loadConfig(env), `brak ${key} ma odmowic start`).toThrow(new RegExp(key));
    }
  });

  it('CLAUDE_CONFIG_DIR wskazujacy domyslny ~/.claude jest odrzucony', () => {
    const env = glmEnv({ CLAUDE_CONFIG_DIR: resolve(homedir(), '.claude') });
    expect(() => loadConfig(env)).toThrow(/domyślny katalog poświadczeń OAuth|domyslny katalog/i);
  });

  it('CLAUDE_CONFIG_DIR bedacy dowiazaniem do ~/.claude jest odrzucony takze po rozwiazaniu', () => {
    const outside = isoDir('glm-link-host-');
    const link = resolve(outside, 'claude-link');
    symlinkSync(resolve(homedir(), '.claude'), link, 'dir');
    expect(() => loadConfig(glmEnv({ CLAUDE_CONFIG_DIR: link }))).toThrow(
      /domyślny katalog poświadczeń OAuth|domyslny katalog/i,
    );
  });

  it('poprawny tryb glm podaje model i wylacznie ORIGIN endpointu', () => {
    const cfg = loadConfig(
      glmEnv({ ANTHROPIC_BASE_URL: 'https://glm.endpoint.invalid/v1/some/path?token=NIE' }),
    );
    expect(cfg.modelProvider).toBe('glm');
    expect(cfg.model).toBe(FAKE_MODEL);
    // The origin only: a query string can carry a credential and never travels
    // in the configuration.
    expect(cfg.modelEndpointOrigin).toBe('https://glm.endpoint.invalid');
    expect(JSON.stringify(cfg)).not.toContain('NIE='); // sanity: no query kept
    expect(JSON.stringify(cfg)).not.toContain(FAKE_TOKEN);
  });

  it('niepoprawny adres endpointu odmawia startu', () => {
    expect(() => loadConfig(glmEnv({ ANTHROPIC_BASE_URL: 'nie-jest-adresem' }))).toThrow(
      /nie jest poprawnym adresem URL/,
    );
  });
});

describe('srodowisko procesu agenta: polityka per provider', () => {
  const dirty = {
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'sk-ant-SYNTETYCZNY',
    ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN,
    ANTHROPIC_BASE_URL: FAKE_ENDPOINT,
    ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example',
    ANTHROPIC_VERTEX_BASE_URL: 'https://vertex.example',
    ANTHROPIC_MODEL: 'inny-model',
    AWS_BEARER_TOKEN_BEDROCK: 'SYNTETYCZNY',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_SESSION_ID: 'x',
    CLAUDE_CONFIG_DIR: '/gdzies/izolowany',
    HOME: '/home/u',
  } as NodeJS.ProcessEnv;

  it('subskrypcja: zachowanie bez zmian — wszystkie zmienne providera znikaja', () => {
    const clean = subscriptionOnlyEnv(dirty, 'subscription');
    for (const key of Object.keys(dirty)) {
      if (key === 'PATH' || key === 'HOME' || key === 'CLAUDE_CONFIG_DIR') {
        expect(clean[key], `${key} ma zostac`).toBeDefined();
      } else {
        expect(clean[key], `${key} ma zniknac`).toBeUndefined();
      }
    }
  });

  it('glm: przepuszcza wylacznie BASE_URL i AUTH_TOKEN', () => {
    const clean = subscriptionOnlyEnv(dirty, 'glm');
    expect(clean.ANTHROPIC_BASE_URL).toBe(FAKE_ENDPOINT);
    expect(clean.ANTHROPIC_AUTH_TOKEN).toBe(FAKE_TOKEN);
    expect(clean.CLAUDE_CONFIG_DIR).toBe('/gdzies/izolowany');
    expect(clean.PATH).toBe('/usr/bin');
  });

  it('glm: ANTHROPIC_API_KEY, Bedrock, Vertex i MODEL sa skrubowane BEZWARUNKOWO', () => {
    const clean = subscriptionOnlyEnv(dirty, 'glm');
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined();
    expect(clean.ANTHROPIC_VERTEX_BASE_URL).toBeUndefined();
    expect(clean.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(clean.ANTHROPIC_MODEL).toBeUndefined();
    expect(clean.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(clean.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(clean.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    // The canary key value survives nowhere in the serialised child env.
    expect(JSON.stringify(clean).includes('sk-ant-SYNTETYCZNY'), 'klucz API przetrwal').toBe(false);
  });

  it('scrubbedEnvKeys jest spojne z polityka: w glm przepuszczone nie sa "skrubowane"', () => {
    const scrubbedGlm = scrubbedEnvKeys(dirty, 'glm');
    expect(scrubbedGlm).toContain('ANTHROPIC_API_KEY');
    expect(scrubbedGlm).toContain('AWS_BEARER_TOKEN_BEDROCK');
    expect(scrubbedGlm).not.toContain('ANTHROPIC_BASE_URL');
    expect(scrubbedGlm).not.toContain('ANTHROPIC_AUTH_TOKEN');

    const scrubbedSub = scrubbedEnvKeys(dirty, 'subscription');
    expect(scrubbedSub).toContain('ANTHROPIC_BASE_URL');
    expect(scrubbedSub).toContain('ANTHROPIC_AUTH_TOKEN');
  });

  it('domyslny parametr (bez providera) pozostaje subskrypcja — istniejace wolania bez zmian', () => {
    const clean = subscriptionOnlyEnv(dirty);
    expect(clean.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(scrubbedEnvKeys(dirty)).toContain('ANTHROPIC_AUTH_TOKEN');
  });
});

describe('probeAuth w trybie glm: plik poswiadczen nie jest czytany', () => {
  it('istniejacy, czytelny plik z tokenami NIE zmienia odpowiedzi na "present"', () => {
    // Sentinel: a *parseable* credential. If the probe opened the file at all,
    // it would answer present/valid — so `absent` here is proof of no read.
    const dir = isoDir('glm-no-read-');
    writeFileSync(
      join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'SYNTETYCZNY-NIE-JEST-TOKENEM',
          refreshToken: 'SYNTETYCZNY-REFRESH',
          subscriptionType: 'max',
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    );
    const s = probeAuth({ APP_MODEL_PROVIDER: 'glm', CLAUDE_CONFIG_DIR: dir });
    expect(s.method).toBe('glm');
    expect(s.apiKeyPolicy).toBe('glm_explicit');
    expect(s.credential).toMatchObject({ present: false, state: 'absent' });
    const text = JSON.stringify(s);
    expect(text.includes('SYNTETYCZNY-NIE-JEST-TOKENEM'), 'wartosc pliku w statusie').toBe(false);
  });

  it('plik nieczytelny tez jest raportowany jako nieistotny (absent), nie jako awaria odczytu', () => {
    // A *directory* named like the credential file: any open() would throw
    // EISDIR and the reader would answer `unreadable`. `absent` proves the
    // probe never tried.
    const dir = isoDir('glm-dir-sentinel-');
    mkdirSync(join(dir, '.credentials.json'));
    const s = probeAuth({ APP_MODEL_PROVIDER: 'glm', CLAUDE_CONFIG_DIR: dir });
    expect(s.credential.state).toBe('absent');
    // The subscription path, for contrast, does read and would report the breakage.
    const sub = probeAuth({ CLAUDE_CONFIG_DIR: dir });
    expect(sub.credential.state).toBe('unreadable');
  });

  it('wykrycie poswiadczenia endpointu jest raportowane, ale jako polityka glm_explicit', () => {
    const s = probeAuth({
      APP_MODEL_PROVIDER: 'glm',
      CLAUDE_CONFIG_DIR: isoDir(),
      ANTHROPIC_AUTH_TOKEN: FAKE_TOKEN,
      ANTHROPIC_API_KEY: 'sk-ant-SYNTETYCZNY',
    });
    expect(s.apiKeyDetected).toBe(true);
    expect(s.apiKeyPolicy).toBe('glm_explicit');
    expect(JSON.stringify(s)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(s)).not.toContain('sk-ant-SYNTETYCZNY');
  });
});

describe('authIsUsable / authIsConfirmed w trybie glm', () => {
  const glmStatus = (over: Record<string, unknown> = {}) => ({
    method: 'glm' as const,
    credential: { present: false, subscriptionType: null, expiresAt: null, state: 'absent' as const },
    access: {
      state: 'unverified' as const,
      lastVerifiedAt: null,
      lastError: null,
      lastErrorAt: null,
    },
    apiKeyDetected: true,
    apiKeyPolicy: 'glm_explicit' as const,
    cliVersion: null,
    sdkSession: { ...UNPROBED_SDK_SESSION },
    ...over,
  });

  it('brak pliku poswiadczen NIE dyskwalifikuje — poświadczeniem jest token endpointu', () => {
    expect(authIsUsable(glmStatus())).toBe(true);
  });

  it('sesja SDK na kluczu API jest w GLM oczekiwana i nie dyskwalifikuje', () => {
    const s = glmStatus({
      sdkSession: {
        ...UNPROBED_SDK_SESSION,
        state: 'api_key',
        apiKeySource: 'ANTHROPIC_AUTH_TOKEN',
      },
    });
    expect(authIsUsable(s)).toBe(true);
    // The same report in the subscription mode is the policy violation it always was.
    expect(
      authIsUsable({ ...s, method: 'subscription', credential: { present: true, subscriptionType: 'max', expiresAt: null, state: 'valid' }, apiKeyPolicy: 'refused' }),
    ).toBe(false);
  });

  it('odwołany dostęp i odmowa odnowienia odmawiają zdatności jak dotychczas', () => {
    for (const state of ['revoked', 'refresh_refused'] as const) {
      expect(authIsUsable(glmStatus({ access: { state, lastVerifiedAt: null, lastError: 'x', lastErrorAt: null } })), state).toBe(false);
    }
  });

  it('potwierdzenie wymaga udanego wywołania, nie samej konfiguracji', () => {
    expect(authIsConfirmed(glmStatus())).toBe(false);
    expect(authIsConfirmed(glmStatus({ access: { state: 'verified', lastVerifiedAt: 't', lastError: null, lastErrorAt: 't' } }))).toBe(true);
  });
});

describe('/api/status w trybie glm', () => {
  it('raportuje method glm, polityke glm_explicit i model z konfiguracji', async () => {
    const dataDir = isoDir('glm-status-data-');
    const platform = createPlatform({
      modules: [],
      env: glmEnv({ APP_DATA_DIR: dataDir }),
    });
    try {
      const login = await platform.app.request('/api/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'local-user' }),
      });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const res = await platform.app.request('/api/status', { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { auth: Record<string, unknown>; model: string };
      expect(body.auth.method).toBe('glm');
      expect(body.auth.apiKeyPolicy).toBe('glm_explicit');
      expect(body.model).toBe(FAKE_MODEL);
      // The token value never reaches the answer, whatever the mode.
      const text = JSON.stringify(body);
      expect(text.includes(FAKE_TOKEN), 'wartosc tokena w /api/status').toBe(false);
    } finally {
      platform.close();
    }
  });
});

describe('/api/sdk-session: sonda dostaje provider z zadanania (recenzja F1)', () => {
  /** Stand-in that records what provider the endpoint dispatched. */
  const captureProbe = (seen: Array<string | undefined>) => async (provider?: string) => {
    seen.push(provider);
    return {
      state: 'other' as const,
      apiKeySource: provider === 'glm' ? 'ANTHROPIC_AUTH_TOKEN' : null,
      apiProvider: provider === 'glm' ? 'GLM/Z.AI (kompatybilny endpoint Anthropic)' : null,
      subscriptionType: null,
      planLimits: null,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  };

  const boot = async (env: NodeJS.ProcessEnv, seen: Array<string | undefined>) => {
    const platform = createPlatform({ modules: [], env, sessionProbe: captureProbe(seen) });
    const login = await platform.app.request('/api/auth/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'local-user' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    return { platform, cookie };
  };

  it('w trybie glm kontrolka „Sesja SDK" probuje polityke GLM, nie subskrypcji', async () => {
    const seen: Array<string | undefined> = [];
    const { platform, cookie } = await boot(glmEnv(), seen);
    try {
      const res = await platform.app.request('/api/sdk-session', {
        method: 'POST',
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      expect(seen, 'sonda ma dostac provider glm z zadania').toEqual(['glm']);
      const body = (await res.json()) as { sdkSession: { apiKeySource: string | null } };
      expect(body.sdkSession.apiKeySource).toBe('ANTHROPIC_AUTH_TOKEN');
    } finally {
      platform.close();
    }
  });

  it('w trybie subskrypcji sonda dostaje wprost subscription (kontrola pozytywna)', async () => {
    const seen: Array<string | undefined> = [];
    const { platform, cookie } = await boot({ APP_DATA_DIR: isoDir() }, seen);
    try {
      const res = await platform.app.request('/api/sdk-session', {
        method: 'POST',
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      expect(seen).toEqual(['subscription']);
      const body = (await res.json()) as { sdkSession: { apiKeySource: string | null } };
      expect(body.sdkSession.apiKeySource).toBeNull();
    } finally {
      platform.close();
    }
  });
});

describe('CLAUDE_CONFIG_DIR: tylda i drzewo ~/.claude odmowione (recenzja F2/F3)', () => {
  it('doslowne ~/.claude (tylda nierozwijana) jest odrzucone', () => {
    expect(() => loadConfig(glmEnv({ CLAUDE_CONFIG_DIR: '~/.claude' }))).toThrow(/~"/);
    expect(() => loadConfig(glmEnv({ CLAUDE_CONFIG_DIR: '~/glm-izolowany' }))).toThrow(/~"/);
    // `~` as any path member, not only at the start.
    expect(() => loadConfig(glmEnv({ CLAUDE_CONFIG_DIR: '/home/u/katalogi/~.claude' }))).toThrow(/~"/);
  });

  it('katalog WEWNATRZ drzewa ~/.claude jest odrzucony (tez po rozwiazaniu dowiazania)', () => {
    const inside = resolve(homedir(), '.claude', 'glm-podkatalog');
    expect(() => loadConfig(glmEnv({ CLAUDE_CONFIG_DIR: inside }))).toThrow(
      /drzewo domyślnego katalogu poświadczeń OAuth/,
    );

    // A link placed OUTSIDE the home directory but resolving INTO ~/.claude
    // is refused for the same reason.
    const host = isoDir('glm-inside-link-');
    const link = resolve(host, 'wskazujacy-w-drzewo');
    symlinkSync(resolve(homedir(), '.claude'), link, 'dir');
    expect(() => loadConfig(glmEnv({ CLAUDE_CONFIG_DIR: resolve(link, 'podkatalog') }))).toThrow(
      /drzewo domyślnego katalogu poświadczeń OAuth/,
    );
  });

  it('kontrola pozytywna: izolowany katalog poza ~/.claude nadal przechodzi', () => {
    const cfg = loadConfig(glmEnv());
    expect(cfg.modelProvider).toBe('glm');
  });
});
