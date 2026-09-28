import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './helpers.ts';

/**
 * Tożsamość sesji aplikacji.
 *
 * `POST /api/auth/session` jest wołany przy każdym wczytaniu strony, żeby tylko
 * upewnić się, że sesja istnieje. Bez jawnego `userId` wywołanie to nie może
 * zmieniać tego, kto jest zalogowany — kiedyś resetowało to do tożsamości
 * domyślnej, więc przeładowanie po cichu cofało świadomy przełącz i wracało
 * z danymi poprzedniej tożsamości.
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
  const setCookie = res.headers.get('set-cookie') ?? '';
  return {
    status: res.status,
    userId: ((await res.json()) as { userId: string }).userId,
    cookie: setCookie.split(';')[0] ?? '',
    setCookie,
  };
};

describe('sesja aplikacji', () => {
  it('odpowiada 200 i ciasteczkiem httpOnly z SameSite=Lax i Path=/', async () => {
    const res = await post({});
    /*
     * Produkcja (packages/platform-server/src/http/app.ts) ustawia te atrybuty,
     * a każda z nich jest realną granicą: httpOnly trzyma wartość sesji z dala
     * od skryptów w przeglądarce, SameSite=Lax nie wozi ciasteczka w żądaniu
     * z obcej strony, Path=/ obejmuje całą aplikację. Ciche zgubienie
     * któregokolwiek byłoby osłabieniem powierzchni sesji, którego nikt nie
     * zauważyłby w odpowiedzi JSON — więc jest asercjonowane wprost.
     */
    expect(res.status, 'POST /api/auth/session ma odpowiadac 200').toBe(200);
    expect(res.setCookie, 'ciasteczka brak').toContain('app_session=');
    expect(res.setCookie).toMatch(/httponly/i);
    expect(res.setCookie).toMatch(/samesite=lax/i);
    expect(res.setCookie).toMatch(/path=\//i);
  });

  it('bez sesji i bez wskazania tozsamosci wybiera domyslna', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(res.userId).toBe(h.ownerId);
  });

  it('jawne wskazanie tozsamosci przelacza sesje', async () => {
    const first = await post({});
    const second = await post({ userId: h.otherOwnerId }, first.cookie);
    expect(second.userId).toBe(h.otherOwnerId);
  });

  it('ponowne wywolanie bez wskazania zachowuje biezaca tozsamosc', async () => {
    const switched = await post({ userId: h.otherOwnerId });
    // To jest dokładnie to, co robi przeładowanie strony.
    const reloaded = await post({}, switched.cookie);
    expect(reloaded.userId, 'przeladowanie zresetowalo tozsamosc').toBe(h.otherOwnerId);
  });

  it('nieznana tozsamosc nie jest przyjmowana ani zapisywana', async () => {
    const res = await post({ userId: 'ktos-obcy' });
    // Odrzucenie dzieje się po stronie tożsamości, nie statusu: odpowiedź i tak
    // jest 200, ale wskazuje tożsamość, z którą faktycznie się jest zalogowanym.
    expect(res.status).toBe(200);
    expect(res.userId).toBe(h.ownerId);
    /*
     * I nic po stronie bazy: nie może powstać wiersz obcej tożsamości. Wystarczyłoby,
     * by endpoint zadbał o założenie wiersza dla wskazanego id, a "ktos-obcy"
     * stałby się realnym użytkownikiem — `requireUser` akceptuje to, co istnieje
     * w users, więc tabela jest tu ostatnią granicą.
     */
    const users = h.platform.db.$client
      .prepare('SELECT id FROM users ORDER BY id')
      .all() as Array<{ id: string }>;
    expect(
      users.map((u) => u.id),
      'obca tozsamosc utworzyla wiersz w tabeli users',
    ).toEqual(['local-user', 'other-user']);
  });

  it('powrot do pierwszej tozsamosci dziala jawnie', async () => {
    const a = await post({ userId: h.otherOwnerId });
    const b = await post({ userId: h.ownerId }, a.cookie);
    expect(b.userId).toBe(h.ownerId);
  });
});
