import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, login, type Harness } from './helpers.ts';

/**
 * Live artifacts.
 *
 * A snapshot is a record of a moment and must never change. A live artifact is
 * a *saved question*: it stores which registered module query to re-run, and the
 * answer is whatever that query returns when the artifact is opened. The two
 * must stay visibly different after the underlying data moves, and both must
 * survive a restart.
 */

let h: Harness;
let cookie: string;
let caseId: string;

const api = async (path: string, init: RequestInit = {}) => {
  const res = await h.platform.app.request(path, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

beforeAll(async () => {
  h = await createHarness();
  cookie = await login(h.platform.app, h.ownerId);
  const cases = h.service.listCases(h.ownerId);
  caseId = cases[0]!.id;
});
afterAll(() => h.dispose());

/** Total computed for one specific offer — the number the tests watch move. */
const totalFor = (offerId: string, result?: any) => {
  const cmp = result ?? h.service.compare(caseId, h.ownerId);
  return cmp.rows.find((r: any) => r.offerId === offerId)?.totalMinor ?? null;
};

/**
 * Changes real domain data through the domain service, exactly as a user edit
 * would, and returns the offer whose total therefore moves. Returning the id
 * matters: the comparison is ranked, so `rows[0]` is not necessarily the offer
 * that was edited.
 */
async function changeSourceData(): Promise<string> {
  const detail = h.service.getCaseDetail(caseId, h.ownerId);
  const first = detail.offers.find((o) =>
    o.items.some((i) => i.unitPriceMinor !== null && i.quantityMilli !== null),
  )!;
  const item = first.items.find((i) => i.unitPriceMinor !== null && i.quantityMilli !== null)!;
  // `quantity` is the decimal the domain service accepts; it stores milli-units
  // itself. Passing `quantityMilli` here silently changes nothing.
  await h.service.updateOfferItem(
    { itemId: item.id, quantity: (item.quantityMilli ?? 1000) / 1000 + 5 },
    h.ownerId,
  );
  return first.offer.id;
}

describe('artefakt live odczytuje zarejestrowana operacje modulu', () => {
  it('deskryptor wskazujacy nieznana operacje jest odrzucany przy zapisie', () => {
    expect(() =>
      h.platform.services.artifacts.assertLiveSourceIsResolvable({
        operation: 'procurement.nie_istnieje',
        input: { caseId },
      }),
    ).toThrowError(/Nieznana operacja odczytu/);
  });

  it('deskryptor z niepoprawnym wejsciem jest odrzucany przy zapisie', () => {
    expect(() =>
      h.platform.services.artifacts.assertLiveSourceIsResolvable({
        operation: 'procurement.comparison',
        input: { caseId: 123 },
      }),
    ).toThrowError(/nie przechodzi walidacji/);
  });

  it('tresc, ktora nie jest deskryptorem, jest odrzucana', () => {
    expect(() =>
      h.platform.services.artifacts.assertLiveSourceIsResolvable({ rows: [{ a: 1 }] }),
    ).toThrowError(/wymaga deskryptora/);
  });

  it('artefakt live nigdy nie przechowuje danych, tylko pytanie', async () => {
    const { meta } = h.platform.services.artifacts.create({
      ownerId: h.ownerId,
      kind: 'table',
      mode: 'live',
      title: 'Porownanie na zywo',
      rendererType: 'procurement.comparison',
      content: { operation: 'procurement.comparison', input: { caseId } },
    });
    const stored = h.platform.services.artifacts.version(meta.id, h.ownerId);
    expect(stored.content).toEqual({ operation: 'procurement.comparison', input: { caseId } });

    const read = await api(`/api/artifacts/${meta.id}`);
    // The descriptor is visible as `source`; `content` is the computed answer.
    expect(read.body.source).toEqual(stored.content);
    expect(read.body.live.state).toBe('fresh');
    expect(read.body.content.rows.length).toBeGreaterThan(0);
  });

  it('snapshot zamraza liczby, live pokazuje biezace — po zmianie zrodla', async () => {
    const snapshotContent = h.service.compare(caseId, h.ownerId);
    const snapshot = h.platform.services.artifacts.create({
      ownerId: h.ownerId,
      kind: 'table',
      mode: 'snapshot',
      title: 'Porownanie z chwili',
      rendererType: 'procurement.comparison',
      content: snapshotContent,
    }).meta;

    const live = h.platform.services.artifacts.create({
      ownerId: h.ownerId,
      kind: 'table',
      mode: 'live',
      title: 'Porownanie na zywo',
      rendererType: 'procurement.comparison',
      content: { operation: 'procurement.comparison', input: { caseId } },
    }).meta;

    const changedOffer = await changeSourceData();
    const before = totalFor(changedOffer, snapshotContent);
    const after = totalFor(changedOffer);
    expect(before).not.toBeNull();
    expect(after, 'zmiana danych nie wplynela na wynik — test nic by nie dowodzil').not.toBe(before);

    const snapRead = await api(`/api/artifacts/${snapshot.id}`);
    const liveRead = await api(`/api/artifacts/${live.id}`);

    // The snapshot still reports the pre-change number...
    expect(snapRead.body.live).toBeNull();
    expect(totalFor(changedOffer, snapRead.body.content)).toBe(before);

    // ...and the live artifact reports the post-change one, from the same data.
    expect(liveRead.body.live.state).toBe('fresh');
    expect(totalFor(changedOffer, liveRead.body.content)).toBe(after);
    expect(liveRead.body.live.resolvedAt).toBeTruthy();
  });

  it('podglad i pelny widok czytaja te sama wersje, wiec nie moga sie roznic', async () => {
    const { meta } = h.platform.services.artifacts.create({
      ownerId: h.ownerId,
      kind: 'table',
      mode: 'live',
      title: 'Spojnosc',
      rendererType: 'procurement.comparison',
      content: { operation: 'procurement.comparison', input: { caseId } },
    });
    const a = await api(`/api/artifacts/${meta.id}`);
    const b = await api(`/api/artifacts/${meta.id}?version=${meta.currentVersion}`);
    // The computed answer must agree. `evaluatedAt` is deliberately excluded:
    // a live artifact is recomputed on every read, so its timestamp moves — what
    // must not differ is the data the two views put in front of the user.
    expect(a.body.content.rows).toEqual(b.body.content.rows);
    expect(a.body.content.excluded).toEqual(b.body.content.excluded);
    expect(a.body.content.bestOfferId).toBe(b.body.content.bestOfferId);
    expect(a.body.live.definitionVersion).toBe(b.body.live.definitionVersion);
    expect(a.body.live.operation).toBe(b.body.live.operation);
  });

  it('brak dostepu nie jest przedstawiany jako swieze dane', async () => {
    const { meta } = h.platform.services.artifacts.create({
      ownerId: h.ownerId,
      kind: 'table',
      mode: 'live',
      title: 'Cudza sprawa',
      rendererType: 'procurement.comparison',
      // A case id that does not belong to this owner.
      content: { operation: 'procurement.comparison', input: { caseId: 'case_nie_istnieje' } },
    });
    const read = await api(`/api/artifacts/${meta.id}`);
    expect(read.body.content).toBeNull();
    expect(['forbidden', 'failed']).toContain(read.body.live.state);
    expect(read.body.live.error).toBeTruthy();
  });

  it('artefakt cudzego wlasciciela nie jest czytelny', async () => {
    const { meta } = h.platform.services.artifacts.create({
      ownerId: h.otherOwnerId,
      kind: 'table',
      mode: 'live',
      title: 'Nie moj',
      rendererType: 'procurement.comparison',
      content: { operation: 'procurement.comparison', input: { caseId } },
    });
    const read = await api(`/api/artifacts/${meta.id}`);
    expect(read.status).toBe(403);
  });
});

describe('trwalosc po restarcie', () => {
  it('snapshot zachowuje liczby, live liczy od nowa po ponownym otwarciu bazy', async () => {
    const snapshotContent = h.service.compare(caseId, h.ownerId);
    const snapshot = h.platform.services.artifacts.create({
      ownerId: h.ownerId,
      kind: 'table',
      mode: 'snapshot',
      title: 'Przed restartem',
      rendererType: 'procurement.comparison',
      content: snapshotContent,
    }).meta;
    const live = h.platform.services.artifacts.create({
      ownerId: h.ownerId,
      kind: 'table',
      mode: 'live',
      title: 'Przed restartem, live',
      rendererType: 'procurement.comparison',
      content: { operation: 'procurement.comparison', input: { caseId } },
    }).meta;

    const changedOffer = await changeSourceData();
    const snapshotBefore = totalFor(changedOffer, snapshotContent);
    const afterChange = totalFor(changedOffer);
    expect(afterChange).not.toBe(snapshotBefore);

    // Reopen the same data directory in a fresh platform instance: this is what
    // a backend restart does.
    const { createPlatform, DEFAULT_USER_ID } = await import('@platform/server');
    const { createProcurementModule } = await import('@module/procurement/server');
    h.platform.close();
    const reopened = createPlatform({
      modules: (services) => [createProcurementModule(services)],
      env: { ...process.env, APP_DATA_DIR: h.dataDir },
    });

    try {
      const snap = reopened.services.artifacts.version(snapshot.id, DEFAULT_USER_ID);
      const row = (c: any) => c.rows.find((r: any) => r.offerId === changedOffer)?.totalMinor ?? null;
      expect(row(snap.content)).toBe(snapshotBefore);

      const resolved = await reopened.services.artifacts.resolveLive(live.id, DEFAULT_USER_ID);
      expect(resolved.live.state).toBe('fresh');
      expect(row(resolved.content)).toBe(afterChange);
    } finally {
      reopened.close();
    }
  });
});
