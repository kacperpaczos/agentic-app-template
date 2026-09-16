import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyAccessFailure,
  probeAuth,
  readCredentialMetadata,
  recordVerification,
  resetVerification,
  scrubbedEnvKeys,
  subscriptionOnlyEnv,
} from '@platform/server';
import { authIsUsable } from '@platform/contracts';

/**
 * Authentication states.
 *
 * Every credential in this file is **synthetic** — written into a temporary
 * directory that is deleted at the end of the test. Nothing here reads, writes
 * or invalidates the real login, and no test deliberately consumes quota.
 * `tests/runtime.test.ts` separately checks the real credential for leakage.
 */

const dirs: string[] = [];
const mkCreds = (content: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-state-'));
  dirs.push(dir);
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify(content));
  return dir;
};
const emptyDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-empty-'));
  dirs.push(dir);
  return dir;
};

const SYNTHETIC = { accessToken: 'SYNTETYCZNY-NIE-JEST-TOKENEM', refreshToken: 'SYNTETYCZNY-REFRESH' };
const env = (dir: string) => ({ CLAUDE_CONFIG_DIR: dir }) as NodeJS.ProcessEnv;

afterEach(() => {
  resetVerification();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('metadane lokalnego poswiadczenia', () => {
  it('brak pliku to stan "absent", a nie awaria', () => {
    const s = probeAuth(env(emptyDir()));
    expect(s.credential).toMatchObject({ present: false, state: 'absent' });
    expect(s.method).toBe('subscription');
  });

  it('plik z terminem w przyszlosci jest "valid"', () => {
    const dir = mkCreds({
      claudeAiOauth: { ...SYNTHETIC, subscriptionType: 'max', expiresAt: Date.now() + 3_600_000 },
    });
    const s = probeAuth(env(dir));
    expect(s.credential).toMatchObject({ present: true, state: 'valid', subscriptionType: 'max' });
  });

  /* This is the defect the audit found: an expired credential reported as a
     healthy subscription. */
  it('plik z terminem w przeszlosci jest "stale", a nie zdrowa subskrypcja', () => {
    const expired = Date.now() - 3_600_000;
    const dir = mkCreds({
      claudeAiOauth: { ...SYNTHETIC, subscriptionType: 'max', expiresAt: expired },
    });
    const s = probeAuth(env(dir));
    expect(s.credential.state).toBe('stale');
    expect(s.credential.expiresAt).toBe(new Date(expired).toISOString());
    // Present, but presence is not proof of access.
    expect(s.credential.present).toBe(true);
    expect(s.access.state).toBe('unverified');
  });

  it('wygasniecie lokalnych metadanych samo w sobie nie blokuje uruchomienia', () => {
    const dir = mkCreds({
      claudeAiOauth: { ...SYNTHETIC, subscriptionType: 'max', expiresAt: Date.now() - 1 },
    });
    // The SDK holds a refresh token; a past expiry routinely still works, so the
    // application must not pre-emptively refuse to run.
    expect(authIsUsable(probeAuth(env(dir)))).toBe(true);
  });

  it('nieczytelny plik jest odrozniony od braku pliku', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auth-broken-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.credentials.json'), '{ to nie jest json');
    expect(probeAuth(env(dir)).credential.state).toBe('unreadable');
  });

  it('z pliku kopiowane sa wylacznie plan i termin', () => {
    const dir = mkCreds({
      claudeAiOauth: { ...SYNTHETIC, subscriptionType: 'pro', expiresAt: Date.now() + 1000 },
    });
    const meta = readCredentialMetadata(join(dir, '.credentials.json'));
    expect(Object.keys(meta).sort()).toEqual(['expiresAt', 'present', 'state', 'subscriptionType']);
    const serialized = JSON.stringify(probeAuth(env(dir)));
    expect(serialized).not.toContain(SYNTHETIC.accessToken);
    expect(serialized).not.toContain(SYNTHETIC.refreshToken);
  });
});

describe('ostatni zweryfikowany dostep', () => {
  const dir = () =>
    mkCreds({ claudeAiOauth: { ...SYNTHETIC, subscriptionType: 'max', expiresAt: Date.now() + 1e6 } });

  it('przed pierwszym wywolaniem stan to "unverified", nie "verified"', () => {
    expect(probeAuth(env(dir())).access.state).toBe('unverified');
  });

  it('udane wywolanie ustawia "verified" i znacznik czasu', () => {
    recordVerification(true);
    const s = probeAuth(env(dir()));
    expect(s.access.state).toBe('verified');
    expect(s.access.lastVerifiedAt).toBeTruthy();
    expect(s.access.lastError).toBeNull();
  });

  /*
   * Simulated adapter outcomes. The failure strings are the ones the Claude
   * runtime produces; feeding them through the classifier is a controlled
   * simulation of each failure, marked as such — none of these states is
   * triggered against the live account.
   */
  const cases: Array<[string, string, string]> = [
    ['limit uzycia', 'Claude usage limit reached. Your limit will reset at 3pm.', 'rate_limited'],
    ['limit HTTP', 'Request failed with status 429 Too Many Requests', 'rate_limited'],
    ['odmowa odnowienia', 'OAuth token refresh failed: invalid_grant', 'refresh_refused'],
    ['odwolane logowanie', 'Authentication error: credentials revoked, please run /login', 'revoked'],
    ['brak autoryzacji', 'HTTP 401 Unauthorized', 'revoked'],
    ['inna awaria', 'socket hang up', 'failed'],
  ];

  for (const [name, message, expected] of cases) {
    it(`${name} → stan "${expected}" (symulacja na granicy adaptera)`, () => {
      expect(classifyAccessFailure(message)).toBe(expected);
      recordVerification(false, message);
      const s = probeAuth(env(dir()));
      expect(s.access.state).toBe(expected);
      expect(s.access.lastError).toBe(message);
      expect(s.access.lastErrorAt).toBeTruthy();
    });
  }

  it('limit uzycia nie jest mylony z zepsutym logowaniem', () => {
    recordVerification(false, 'Claude usage limit reached');
    const s = probeAuth(env(dir()));
    expect(s.access.state).toBe('rate_limited');
    // A usage limit is a wait, not a re-login: the app must still call itself usable.
    expect(authIsUsable(s)).toBe(true);
  });

  it('odwolane logowanie czyni aplikacje niezdatna do pracy', () => {
    recordVerification(false, 'credentials revoked, please run /login');
    expect(authIsUsable(probeAuth(env(dir())))).toBe(false);
  });

  it('blad nie kasuje faktu wczesniejszego udanego wywolania', () => {
    recordVerification(true);
    const verifiedAt = probeAuth(env(dir())).access.lastVerifiedAt;
    recordVerification(false, 'Claude usage limit reached');
    const s = probeAuth(env(dir()));
    expect(s.access.lastVerifiedAt).toBe(verifiedAt);
    expect(s.access.state).toBe('rate_limited');
  });
});

describe('polityka wylacznie subskrypcyjna', () => {
  it('kazda zmienna kierujaca na platne API znika ze srodowiska agenta', () => {
    const dirty = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-SYNTETYCZNY',
      ANTHROPIC_AUTH_TOKEN: 'SYNTETYCZNY',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example',
      ANTHROPIC_VERTEX_BASE_URL: 'https://vertex.example',
      ANTHROPIC_MODEL: 'inny-model',
      AWS_BEARER_TOKEN_BEDROCK: 'SYNTETYCZNY',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CONFIG_DIR: '/home/x/.claude',
    } as NodeJS.ProcessEnv;

    const clean = subscriptionOnlyEnv(dirty);
    for (const key of Object.keys(dirty)) {
      if (key === 'PATH' || key === 'CLAUDE_CONFIG_DIR') {
        expect(clean[key], `${key} musi zostac`).toBeDefined();
      } else {
        expect(clean[key], `${key} musi zniknac`).toBeUndefined();
      }
    }
    // Nothing that was scrubbed may reappear anywhere in the serialised env.
    const serialized = JSON.stringify(clean);
    expect(serialized).not.toContain('sk-ant-SYNTETYCZNY');
    expect(serialized).not.toContain('gateway.example');
    expect(scrubbedEnvKeys(dirty).sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_BEDROCK_BASE_URL',
        'ANTHROPIC_MODEL',
        'ANTHROPIC_VERTEX_BASE_URL',
        'AWS_BEARER_TOKEN_BEDROCK',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
      ].sort(),
    );
  });

  it('obecnosc klucza API jest raportowana, a polityka pozostaje "refused"', () => {
    const s = probeAuth({ ...env(emptyDir()), ANTHROPIC_API_KEY: 'sk-ant-SYNTETYCZNY' } as NodeJS.ProcessEnv);
    expect(s.apiKeyDetected).toBe(true);
    expect(s.apiKeyPolicy).toBe('refused');
    // Detecting a key must never change the configured method.
    expect(s.method).toBe('subscription');
    expect(JSON.stringify(s)).not.toContain('sk-ant-SYNTETYCZNY');
  });
});
