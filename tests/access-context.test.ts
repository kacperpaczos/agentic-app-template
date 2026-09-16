import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AccessContextChanged,
  accessEpoch,
  accessScope,
  api,
  qk,
  resetAccessContext,
  setAccessContext,
} from '@platform/ui';

/**
 * Cache isolation when the access context changes.
 *
 * The scenario that matters is a single browser and a single cache: the user
 * changes which identity the application acts as, and nothing belonging to the
 * previous one may survive — not a cached row, and not a reply to a request that
 * was already on the wire. Two separate browser contexts would prove nothing
 * about this, because they never share a cache to leak through.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAccessContext();
  vi.restoreAllMocks();
});

/** A fetch that resolves only when the test says so. */
function deferredFetch(payload: unknown) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const calls: Array<{ signal?: AbortSignal | null }> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit = {}) => {
    calls.push({ signal: init.signal });
    await gate;
    if (init.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { release, calls };
}

describe('klucze cache uwzgledniaja kontekst dostepu', () => {
  it('ten sam zasob u dwoch tozsamosci ma rozne klucze', () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    const a = [qk.space('sp_1'), qk.artifact('art_1'), qk.files('case:1'), qk.module('/cases')];

    setAccessContext(qc, 'other-user');
    const b = [qk.space('sp_1'), qk.artifact('art_1'), qk.files('case:1'), qk.module('/cases')];

    for (let i = 0; i < a.length; i += 1) {
      expect(a[i], 'klucz nie zmienil sie po zmianie tozsamosci').not.toEqual(b[i]);
    }
    // The coarse prefixes the stream adapter invalidates must still match.
    expect(qk.space('sp_1')[0]).toBe('canvas');
    expect(qk.artifact('art_1')[0]).toBe('artifact');
    expect(qk.module('/cases')[0]).toBe('module');
  });

  it('klucz rozroznia zasob i filtry w obrebie jednej tozsamosci', () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    expect(qk.artifacts('cnv_1')).not.toEqual(qk.artifacts('cnv_2'));
    expect(qk.files('case:1')).not.toEqual(qk.files('case:2'));
    expect(qk.space('sp_1')).not.toEqual(qk.space('sp_2'));
  });
});

describe('zmiana tozsamosci usuwa dane poprzedniej', () => {
  it('pamiec podreczna jest pusta po przelaczeniu', () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    qc.setQueryData(qk.space('sp_1'), { cards: [{ id: 'poufne' }] });
    expect(qc.getQueryData(qk.space('sp_1'))).toBeTruthy();

    const switched = setAccessContext(qc, 'other-user');
    expect(switched).toBe(true);
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });

  it('pierwsze ustawienie tozsamosci nie jest przelaczeniem i niczego nie kasuje', () => {
    const qc = new QueryClient();
    const switched = setAccessContext(qc, 'local-user');
    expect(switched).toBe(false);
    // Calling again with the same identity (the boot path) must be a no-op.
    expect(setAccessContext(qc, 'local-user')).toBe(false);
  });

  it('epoka rosnie tylko przy rzeczywistej zmianie', () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    const first = accessEpoch();
    setAccessContext(qc, 'local-user');
    expect(accessEpoch()).toBe(first);
    setAccessContext(qc, 'other-user');
    expect(accessEpoch()).toBe(first + 1);
  });
});

describe('opozniona odpowiedz nie przywraca cudzych danych', () => {
  it('zadanie w locie jest przerywane w momencie przelaczenia', async () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    const { release, calls } = deferredFetch({ cards: [{ id: 'poufne-dla-local-user' }] });

    const inFlight = api<{ cards: unknown[] }>('/api/canvas/spaces/sp_1');
    const settled = inFlight.then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    );

    // The switch happens while the request is still open.
    setAccessContext(qc, 'other-user');
    expect(calls[0]?.signal?.aborted, 'zadanie nie zostalo przerwane').toBe(true);

    release();
    const result = await settled;
    expect(result.ok, 'odpowiedz dla poprzedniej tozsamosci zostala przyjeta').toBe(false);

    // And nothing was written into the cache under any key.
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });

  it('odpowiedz, ktora mimo wszystko dobiegnie, jest odrzucana po epoce', async () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');

    /* A fetch that ignores the abort signal entirely — the worst case, and the
       reason the epoch check exists alongside the signal. */
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    globalThis.fetch = (async () => {
      await gate;
      return new Response(JSON.stringify({ secret: 'dane-local-user' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const settled = api<{ secret: string }>('/api/status').then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    );
    setAccessContext(qc, 'other-user');
    release();

    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.e).toBeInstanceOf(AccessContextChanged);
  });

  it('bez zmiany kontekstu odpowiedz dociera normalnie', async () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    const { release } = deferredFetch({ ok: 1 });
    const settled = api<{ ok: number }>('/api/status');
    release();
    await expect(settled).resolves.toEqual({ ok: 1 });
    expect(accessScope()).toBe('local-user');
  });
});
