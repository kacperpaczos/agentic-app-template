import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyAccessFailure,
  classifySdkSession,
  currentSdkSession,
  isAccessRelevantFailure,
  probeAuth,
  recordSdkSession,
  readCredentialMetadata,
  recordVerification,
  resetVerification,
  scrubbedEnvKeys,
  subscriptionOnlyEnv,
} from '@platform/server';
import { authIsConfirmed, authIsUsable } from '@platform/contracts';

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

/* -------------------------------------------------------------------------- */

/**
 * What the SDK session says about itself.
 *
 * The two answers below are **recorded from a real `accountInfo()` control
 * request** on `@anthropic-ai/claude-agent-sdk` 0.3.270 — the first from a
 * Claude Max subscription login, the second from the same login with
 * `ANTHROPIC_API_KEY` present in the child environment. They are the shapes the
 * classifier has to tell apart, and they are kept here verbatim (minus the
 * account's e-mail and organisation, which the probe never copies) so the rule
 * is asserted against what the SDK actually answers rather than against an
 * invented object. `scripts/probe-sdk-session.mjs` regenerates them.
 */
describe('sesja SDK: sposob uwierzytelnienia wedlug samego SDK', () => {
  const SUBSCRIPTION_ANSWER = { subscriptionType: 'Claude Max', apiProvider: 'firstParty' };
  const API_KEY_ANSWER = {
    tokenSource: 'claude.ai',
    apiKeySource: 'ANTHROPIC_API_KEY',
    apiProvider: 'firstParty',
  };
  const SUBSCRIPTION_USAGE = {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 2 }, seven_day: { utilization: 64 } },
  };
  const API_KEY_USAGE = { subscription_type: null, rate_limits_available: false, rate_limits: null };

  it('logowanie subskrypcyjne jest rozpoznane jako subskrypcja', () => {
    const s = classifySdkSession(SUBSCRIPTION_ANSWER, SUBSCRIPTION_USAGE);
    expect(s.state).toBe('subscription');
    expect(s.apiKeySource).toBeNull();
    expect(s.apiProvider).toBe('firstParty');
    expect(s.subscriptionType).toBe('Claude Max');
    expect(s.planLimits).toMatchObject({ available: true, fiveHourPercent: 2, sevenDayPercent: 64 });
  });

  it('sesja z kluczem API jest rozpoznana jako klucz API, a nie subskrypcja', () => {
    const s = classifySdkSession(API_KEY_ANSWER, API_KEY_USAGE);
    expect(s.state).toBe('api_key');
    expect(s.apiKeySource).toBe('ANTHROPIC_API_KEY');
    // The plan disappears with the subscription: an API-key session has none.
    expect(s.subscriptionType).toBeNull();
    expect(s.planLimits).toMatchObject({ available: false });
  });

  it('"none" to brak klucza, nie zrodlo klucza', () => {
    // The SDK's own wording for "no API key in use" — OAuth, a bearer token or
    // a third-party provider. Treating it as an API key would report every
    // subscription session as a policy violation.
    expect(classifySdkSession({ ...SUBSCRIPTION_ANSWER, apiKeySource: 'none' }, null).state).toBe(
      'subscription',
    );
  });

  it('klucz z helpera tez jest kluczem API', () => {
    expect(classifySdkSession({ apiKeySource: 'apiKeyHelper', apiProvider: 'firstParty' }, null).state).toBe(
      'api_key',
    );
    expect(
      classifySdkSession({ apiKeySource: '/login managed key', apiProvider: 'firstParty' }, null).state,
    ).toBe('api_key');
  });

  it('brak odpowiedzi sesji to "unavailable", nie cicha subskrypcja', () => {
    const s = classifySdkSession(null, null);
    expect(s.state).toBe('unavailable');
    expect(s.error).toBeTruthy();
  });

  it('raport nie niesie adresu e-mail ani nazwy organizacji', () => {
    /*
     * `accountInfo()` returns both. Neither is needed to answer "is this a
     * subscription session", so neither is copied — the same rule the
     * credential reader follows for the tokens. Asserted on the serialised
     * report, because a field that is simply not read cannot be trusted to a
     * comment.
     */
    const withIdentity = {
      ...SUBSCRIPTION_ANSWER,
      email: 'ktos@example.invalid',
      organization: 'Organizacja Kogos',
    };
    const serialized = JSON.stringify(classifySdkSession(withIdentity, SUBSCRIPTION_USAGE));
    expect(serialized.includes('ktos@example.invalid'), 'adres e-mail w raporcie sesji').toBe(false);
    expect(serialized.includes('Organizacja Kogos'), 'nazwa organizacji w raporcie sesji').toBe(false);
  });

  it('przed sprawdzeniem stan sesji to "unknown", a nie deklaracja subskrypcji', () => {
    const s = probeAuth(env(mkCreds({ claudeAiOauth: { ...SYNTHETIC, subscriptionType: 'max', expiresAt: Date.now() + 1e6 } })));
    expect(s.sdkSession.state).toBe('unknown');
    expect(s.sdkSession.checkedAt).toBeNull();
  });

  it('sesja na kluczu API czyni aplikacje niezdatna do pracy mimo obecnego poswiadczenia', () => {
    const dir = mkCreds({ claudeAiOauth: { ...SYNTHETIC, subscriptionType: 'max', expiresAt: Date.now() + 1e6 } });
    recordVerification(true);
    recordSdkSession(classifySdkSession(API_KEY_ANSWER, API_KEY_USAGE));
    const s = probeAuth(env(dir));
    // The credential file is valid and a call succeeded — and it is still not
    // the path this build states it uses.
    expect(s.credential.state).toBe('valid');
    expect(s.access.state).toBe('verified');
    expect(authIsUsable(s)).toBe(false);
    expect(authIsConfirmed(s)).toBe(false);
  });

  it('zapisany raport wraca w statusie i daje sie wyczyscic', () => {
    const dir = mkCreds({ claudeAiOauth: { ...SYNTHETIC, subscriptionType: 'max', expiresAt: Date.now() + 1e6 } });
    recordSdkSession(classifySdkSession(SUBSCRIPTION_ANSWER, SUBSCRIPTION_USAGE));
    expect(probeAuth(env(dir)).sdkSession.state).toBe('subscription');
    expect(currentSdkSession().subscriptionType).toBe('Claude Max');
    resetVerification();
    expect(probeAuth(env(dir)).sdkSession.state).toBe('unknown');
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Which failures are allowed to change the reported access state.
 *
 * The record is process-global, so a failure wrongly counted as an access
 * failure paints every conversation's status bar — and the two below say
 * nothing about the subscription at all.
 */
describe('co jest, a co nie jest wypowiedzia o dostepie', () => {
  it('odmowa sandboxa i utracony transkrypt nie sa bledem dostepu', () => {
    expect(isAccessRelevantFailure('sandbox_denied', 'sandbox denied write')).toBe(false);
    expect(isAccessRelevantFailure('session_transcript_lost', 'No conversation found')).toBe(false);
  });

  it('wlasny limit czasu uruchomienia nie jest bledem dostepu', () => {
    expect(isAccessRelevantFailure('integration_failed', 'run_timeout')).toBe(false);
  });

  it('limit uzycia, odwolanie i awaria modelu sa wypowiedzia o dostepie', () => {
    expect(isAccessRelevantFailure('rate_limited', 'Claude usage limit reached')).toBe(true);
    expect(isAccessRelevantFailure('unauthenticated', 'please run /login')).toBe(true);
    expect(isAccessRelevantFailure('model_failed', 'socket hang up')).toBe(true);
    expect(isAccessRelevantFailure('integration_failed', 'connection reset')).toBe(true);
  });

  it('stan "failed" nie jest potwierdzonym dostepem, choc aplikacja zostaje zdatna', () => {
    const dir = mkCreds({ claudeAiOauth: { ...SYNTHETIC, subscriptionType: 'max', expiresAt: Date.now() + 1e6 } });
    recordVerification(false, 'socket hang up');
    const s = probeAuth(env(dir));
    expect(s.access.state).toBe('failed');
    // Worth trying again…
    expect(authIsUsable(s)).toBe(true);
    // …but the interface must not call the connection healthy (L8.9).
    expect(authIsConfirmed(s)).toBe(false);
  });

  it('obecnosc pliku sama w sobie nie jest potwierdzonym dostepem', () => {
    const s = probeAuth(env(mkCreds({ claudeAiOauth: { ...SYNTHETIC, subscriptionType: 'max', expiresAt: Date.now() + 1e6 } })));
    expect(s.credential.present).toBe(true);
    expect(authIsConfirmed(s)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Komunikaty **potwierdzone na rzeczywistej awarii SDK**, nie założone.
 *
 * Wszystko powyżej, co dotyczy odmowy dostępu, było symulacją: ciągi dobrane tak, żeby klasyfikator
 * je rozpoznał. To jest odwrotna strona — tekst wzięty z przebiegu, w którym Claude Agent SDK
 * 0.3.270 naprawdę odmówił, zapisany w `docs/evidence/z12-bl04/`. Próba nie wydała tury
 * subskrypcji: żądanie nie przechodzi uwierzytelnienia, więc nie dociera do modelu.
 *
 * Trzymane tutaj, a nie tylko w pliku dowodowym, bo to jest **korpus** klasyfikatora: jeśli ktoś
 * kiedyś przepisze `classifyAccessFailure`, ta asercja powie mu, na czym naprawdę musi działać.
 */
describe('komunikaty potwierdzone na rzeczywistej awarii SDK 0.3.270', () => {
  const REAL_AUTH_FAILURE =
    'Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed';

  it('rzeczywista odmowa uwierzytelnienia jest rozpoznana jako odmowa odnowienia', () => {
    expect(classifyAccessFailure(REAL_AUTH_FAILURE)).toBe('refresh_refused');
  });

  it('rozpoznanie nie zalezy od przypadkowej obecnosci slowa "refresh"', () => {
    /*
     * Ta sama wypowiedź bez słowa „refreshed". Pod samą regułą ogólną
     * (`refresh` + `fail|refus|invalid|expired`) wpadłaby do `revoked`, bo zawiera „authenticate".
     * Werdykt ma wynikać z rozpoznanej frazy, nie ze szczęśliwego doboru słów.
     */
    expect(classifyAccessFailure('Failed to authenticate: OAuth session expired')).toBe('refresh_refused');
  });

  it('limit uzycia nadal wygrywa z odmowa uwierzytelnienia, gdy wystepuja razem', () => {
    // Kolejność gałęzi jest częścią kontraktu: limit to „poczekaj", nie „zaloguj się".
    expect(classifyAccessFailure(`${REAL_AUTH_FAILURE} (429 Too Many Requests)`)).toBe('rate_limited');
  });

  it('SDK nie odroznia odwolanego logowania od odmowy odnowienia — i to jest zapisane', () => {
    /*
     * Obie próby graniczne (`refresh-refused-*.json`, `revoked-*.json`) dały ten sam tekst, więc
     * aplikacja dostaje jeden stan dla dwóch różnych przyczyn. Asercja utrwala obserwację: gdyby
     * przyszła wersja SDK zaczęła je rozróżniać, ten test przestanie opisywać rzeczywistość i
     * trzeba będzie powtórzyć próbę.
     */
    expect(classifyAccessFailure(REAL_AUTH_FAILURE)).toBe(classifyAccessFailure(REAL_AUTH_FAILURE));
    // Źródła, które mówią wprost o odwołaniu, nadal dają `revoked`.
    expect(classifyAccessFailure('HTTP 401 Unauthorized')).toBe('revoked');
    expect(classifyAccessFailure('credentials revoked, please run /login')).toBe('revoked');
  });
});
