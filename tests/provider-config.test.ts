import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agentEnv,
  createPlatform,
  DEFAULT_USER_ID,
  loadConfig,
  subscriptionOnlyEnv,
} from '@platform/server';
import { login } from './helpers';

/**
 * Mechanizm `APP_PROVIDER_CONFIG`: jedyny wspierany sposob wskazania gatewaya
 * modelu. Polityka pozostaje ta sama — nic dziedziczone z srodowiska procesu
 * nie moze skierowac agenta na platne API; override moze przyjsc tylko z pliku,
 * czytanego raz przy starcie. Bez pliku platforma dziala dokladnie jak wczesniej.
 */

const GATEWAY = {
  baseUrl: 'https://gateway.example/api/anthropic',
  authToken: 'gateway-token-123456',
  model: 'gateway-model',
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const providerFile = (content: unknown): string => {
  const path = join(dir, 'provider.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
};

describe('loadConfig czyta plik providera', () => {
  it('bez APP_PROVIDER_CONFIG provider jest pusty, a model pochodzi z APP_MODEL', () => {
    const cfg = loadConfig({ APP_DATA_DIR: join(dir, 'data'), APP_MODEL: 'claude-sonnet-4-5' });
    expect(cfg.provider).toBeNull();
    expect(cfg.model).toBe('claude-sonnet-4-5');
  });

  it('poprawny plik wczytuje baseUrl, token i model — model z pliku wygrywa z APP_MODEL', () => {
    const path = providerFile(GATEWAY);
    const cfg = loadConfig({
      APP_DATA_DIR: join(dir, 'data'),
      APP_PROVIDER_CONFIG: path,
      APP_MODEL: 'claude-sonnet-4-5',
    });
    expect(cfg.provider).toEqual(GATEWAY);
    expect(cfg.model).toBe('gateway-model');
  });

  it('plik bez pola model przejmuje model z APP_MODEL, a bez niego wartosc domyslna', () => {
    const path = providerFile({ baseUrl: GATEWAY.baseUrl, authToken: GATEWAY.authToken });
    const withOverride = loadConfig({
      APP_DATA_DIR: join(dir, 'data'),
      APP_PROVIDER_CONFIG: path,
      APP_MODEL: 'claude-sonnet-4-5',
    });
    expect(withOverride.model).toBe('claude-sonnet-4-5');
    const plain = loadConfig({ APP_DATA_DIR: join(dir, 'data'), APP_PROVIDER_CONFIG: path });
    expect(plain.model).toBe('claude-sonnet-4-5');
  });

  it('nieistniejacy plik konczy sie czytelnym bledem, nie cichym fallbackiem', () => {
    expect(() =>
      loadConfig({
        APP_DATA_DIR: join(dir, 'data'),
        APP_PROVIDER_CONFIG: join(dir, 'nie-ma.json'),
      }),
    ).toThrow(/nieczytelny plik/);
  });

  it('uszkodzony JSON i zly ksztalt sa fatalne z powodem', () => {
    const broken = providerFile('{ not json');
    expect(() =>
      loadConfig({ APP_DATA_DIR: join(dir, 'data'), APP_PROVIDER_CONFIG: broken }),
    ).toThrow(/nie jest poprawnym JSON/);

    const noHttps = providerFile({ ...GATEWAY, baseUrl: 'http://gateway.example' });
    expect(() =>
      loadConfig({ APP_DATA_DIR: join(dir, 'data'), APP_PROVIDER_CONFIG: noHttps }),
    ).toThrow(/baseUrl/);

    const shortToken = providerFile({ ...GATEWAY, authToken: 'krótki' });
    expect(() =>
      loadConfig({ APP_DATA_DIR: join(dir, 'data'), APP_PROVIDER_CONFIG: shortToken }),
    ).toThrow(/authToken/);
  });
});

describe('agentEnv sklada srodowisko dziecka', () => {
  const inherit = {
    PATH: '/usr/bin',
    HOME: '/home/ktoś',
    // Zmienne, które politika ma wygasić, niezależnie od providera:
    ANTHROPIC_API_KEY: 'z-dziedziczenia-nie-ma-korzystac',
    ANTHROPIC_BASE_URL: 'https://zly-gateway.example',
  };

  it('bez providera jest tozsamo-ciagle z subscriptionOnlyEnv', () => {
    expect(agentEnv(null, inherit)).toEqual(subscriptionOnlyEnv(inherit));
    // Scrubbing dziedziczenia dziala dalej:
    expect(agentEnv(null, inherit)).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(agentEnv(null, inherit)).not.toHaveProperty('ANTHROPIC_BASE_URL');
  });

  it('z providerem jedyny ANTHROPIC_BASE_URL/AUTH_TOKEN pochodzi z pliku, nie z dziedziczenia', () => {
    const env = agentEnv(GATEWAY, inherit);
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY.baseUrl);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(GATEWAY.authToken);
    // Nadal nic z procesu nie przecieka — nadpisane są wyłącznie dwa klucze:
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(Object.keys(env).filter((k) => k === 'ANTHROPIC_BASE_URL')).toHaveLength(1);
  });
});

describe('instancja z plikiem providera', () => {
  it('startuje i nie ujawnia tokenu providera w /api/status', async () => {
    const path = providerFile(GATEWAY);
    const platform = createPlatform({
      modules: () => [],
      env: {
        APP_DATA_DIR: join(dir, 'data'),
        APP_PROVIDER_CONFIG: path,
      },
    });
    try {
      const cookie = await login(platform.app, DEFAULT_USER_ID);
      const res = await platform.app.request('/api/status', { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(GATEWAY.authToken);
      expect(body).not.toContain(GATEWAY.baseUrl);
    } finally {
      platform.close();
    }
  });
});
