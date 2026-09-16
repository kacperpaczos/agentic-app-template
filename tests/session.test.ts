import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers.ts';

/**
 * Application session identity.
 *
 * `POST /api/auth/session` is called on every page load to make sure a session
 * exists. Without an explicit `userId` that call must not change who is signed
 * in — it used to reset to the default identity, so a reload silently discarded
 * a deliberate switch and put the previous identity's data back on screen.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness({ withModule: false });
});
afterAll(() => h.dispose());

const post = async (body: unknown, cookie?: string) => {
  const res = await h.platform.app.request('/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const setCookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  return { userId: ((await res.json()) as { userId: string }).userId, cookie: setCookie };
};

describe('sesja aplikacji', () => {
  it('bez sesji i bez wskazania tozsamosci wybiera domyslna', async () => {
    expect((await post({})).userId).toBe(h.ownerId);
  });

  it('jawne wskazanie tozsamosci przelacza sesje', async () => {
    const first = await post({});
    const second = await post({ userId: h.otherOwnerId }, first.cookie);
    expect(second.userId).toBe(h.otherOwnerId);
  });

  it('ponowne wywolanie bez wskazania zachowuje biezaca tozsamosc', async () => {
    const switched = await post({ userId: h.otherOwnerId });
    // This is what a page reload does.
    const reloaded = await post({}, switched.cookie);
    expect(reloaded.userId, 'przeladowanie zresetowalo tozsamosc').toBe(h.otherOwnerId);
  });

  it('nieznana tozsamosc nie jest przyjmowana', async () => {
    const res = await post({ userId: 'ktos-obcy' });
    expect(res.userId).toBe(h.ownerId);
  });

  it('powrot do pierwszej tozsamosci dziala jawnie', async () => {
    const a = await post({ userId: h.otherOwnerId });
    const b = await post({ userId: h.ownerId }, a.cookie);
    expect(b.userId).toBe(h.ownerId);
  });
});
