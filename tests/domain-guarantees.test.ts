import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ERROR_CODES, type ToolCallContext } from '@platform/contracts';
import { collectToolEntries, executeTool, platformTools } from '@platform/server';
import { createHarness, caseCode, login, type Harness } from './helpers.ts';

/**
 * The domain's own guarantees under collision: L9.2, L9.3, L9.5, L9.6, L9.7,
 * L9.8, L9.14, L9.15.
 *
 * Contract and logic tests. No model and no browser take part, and none is
 * needed: every property here is a property of the services, the schemas and
 * the two doors in front of them — the HTTP endpoint and the MCP tool — and all
 * three are the real ones, over a real database.
 *
 * What the tests are built around, rather than the happy path:
 *
 *  - **two doors, one rule** — each rule is asked of the tool *and* of the
 *    endpoint, and the two answers are compared (L9.2);
 *  - **two writers** — a conflict is produced by a second writer landing
 *    between a reader's read and its write, not by hand-picking a stale number
 *    (L9.6);
 *  - **simultaneous retries** — repeats are issued with `Promise.all`, so the
 *    guard is tested while the first call is still inside the operation, which
 *    is the only case its old "read, then run, then write" order got wrong
 *    (L9.7, L9.14);
 *  - **a failure forced between two steps** — the second step of a multi-step
 *    write is made to throw, which is the only way to observe whether the first
 *    step survives it (L9.8, L9.15).
 */

let h: Harness;
let cookie: string;
let otherCookie: string;
let caseId: string;
const tempDirs: string[] = [];

const toolCtx = (over: Partial<ToolCallContext> = {}): ToolCallContext => ({
  ownerId: h.ownerId,
  appContext: {
    conversationId: null,
    spaceId: null,
    resource: null,
    selection: [],
    filters: {},
    viewport: null,
    drafts: [],
    ui: null,
  },
  conversationId: null,
  runId: null,
  workspaceDir: null,
  emit: () => {},
  ...over,
});

const callTool = (name: string, input: unknown, ctx: Partial<ToolCallContext> = {}) =>
  h.platform.registry.callTool(name, input, toolCtx(ctx));

/**
 * Runs a *platform* tool the way the MCP server does: the tool's own input
 * validation, then its handler with the caller's context. `registry.callTool`
 * knows the modules' tools only, and the platform's own are not in it.
 */
const callPlatformTool = (name: string, input: unknown, ctx: Partial<ToolCallContext> = {}) => {
  const entry = collectToolEntries({
    registry: h.platform.registry,
    platformTools: platformTools(h.platform.services),
  }).find((t) => t.localName === name);
  if (!entry) throw new Error(`nieznane narzedzie platformy ${name}`);
  return executeTool({ localName: name, def: entry.def as never }, input, toolCtx(ctx));
};

/** The error code a call produced, or `null` when it unexpectedly succeeded. */
async function codeOfTool(name: string, input: unknown): Promise<string | null> {
  try {
    await callTool(name, input);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'nieznany';
  }
}

interface HttpOutcome {
  status: number;
  code: string | null;
  body: any;
}

async function http(path: string, init: RequestInit = {}, as = cookie): Promise<HttpOutcome> {
  const res = await h.platform.app.request(path, {
    ...init,
    headers: { cookie: as, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, code: body?.error?.code ?? null, body };
}

const firstItem = () => {
  const detail = h.service.getCaseDetail(caseId, h.ownerId);
  const offer = detail.offers.find((o) => o.items.length > 0)!;
  return { offer: offer.offer, item: offer.items[0]! };
};

const weightOf = (key: string) =>
  h.service.repo.listCriteria(caseId).find((c) => c.key === key)?.weight ?? null;

beforeEach(async () => {
  h = await createHarness();
  cookie = await login(h.platform.app, h.ownerId);
  otherCookie = await login(h.platform.app, h.otherOwnerId);
  caseId = h.service.repo.findCaseByCode(caseCode, h.ownerId)!.id;
});

afterEach(() => {
  vi.restoreAllMocks();
  h.dispose();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/* ========================================================================== */
/*  L9.2 — one rule, both doors                                               */
/* ========================================================================== */

describe('L9.2 — endpoint i narzedzie MCP egzekwuja te sama regule', () => {
  /**
   * Each row is one rule, asked of both doors.
   *
   * The table is the test: a rule that only the tool enforces shows up as two
   * different codes on the same row, which is exactly the shape of the defect
   * this replaces — `set_criteria_weights` refused a weight of 900 while
   * `POST /cases/:id/criteria` wrote it, because the column has no constraint
   * and the route had no schema.
   */
  const rules: Array<{
    rule: string;
    tool: { name: string; input: (ctx: { itemId: string; version: number }) => unknown };
    request: (ctx: { itemId: string; version: number }) => [string, RequestInit];
    expected: string;
  }> = [
    {
      rule: 'waga kryterium poza 0-100',
      tool: { name: 'procurement_set_criteria_weights', input: () => ({ caseId, weights: [{ key: 'total_cost', weight: 900 }] }) },
      request: () => [
        `/api/m/procurement/cases/${caseId}/criteria`,
        { method: 'POST', body: JSON.stringify({ weights: [{ key: 'total_cost', weight: 900 }] }) },
      ],
      expected: 'validation_failed',
    },
    {
      rule: 'waga kryterium nie jest liczba',
      tool: { name: 'procurement_set_criteria_weights', input: () => ({ caseId, weights: [{ key: 'total_cost', weight: 'duzo' }] }) },
      request: () => [
        `/api/m/procurement/cases/${caseId}/criteria`,
        { method: 'POST', body: JSON.stringify({ weights: [{ key: 'total_cost', weight: 'duzo' }] }) },
      ],
      expected: 'validation_failed',
    },
    {
      rule: 'nieznany klucz kryterium',
      tool: { name: 'procurement_set_criteria_weights', input: () => ({ caseId, weights: [{ key: 'cokolwiek', weight: 10 }] }) },
      request: () => [
        `/api/m/procurement/cases/${caseId}/criteria`,
        { method: 'POST', body: JSON.stringify({ weights: [{ key: 'cokolwiek', weight: 10 }] }) },
      ],
      expected: 'validation_failed',
    },
    {
      rule: 'brak listy wag',
      tool: { name: 'procurement_set_criteria_weights', input: () => ({ caseId }) },
      request: () => [
        `/api/m/procurement/cases/${caseId}/criteria`,
        { method: 'POST', body: JSON.stringify({}) },
      ],
      expected: 'validation_failed',
    },
    {
      rule: 'ujemny limit wyszukiwania',
      tool: { name: 'procurement_search', input: () => ({ query: 'projektor', limit: -1 }) },
      request: () => ['/api/m/procurement/search?q=projektor&limit=-1', {}],
      expected: 'validation_failed',
    },
    {
      rule: 'limit wyszukiwania ponad maksimum',
      tool: { name: 'procurement_search', input: () => ({ query: 'projektor', limit: 5000 }) },
      request: () => ['/api/m/procurement/search?q=projektor&limit=5000', {}],
      expected: 'validation_failed',
    },
    {
      rule: 'puste zapytanie wyszukiwania',
      tool: { name: 'procurement_search', input: () => ({ query: '' }) },
      request: () => ['/api/m/procurement/search?q=', {}],
      expected: 'validation_failed',
    },
    {
      rule: 'ujemna cena jednostkowa',
      tool: {
        name: 'procurement_update_offer_item',
        input: ({ itemId, version }) => ({ itemId, unitPrice: -5, expectedVersion: version }),
      },
      request: ({ itemId, version }) => [
        `/api/m/procurement/items/${itemId}`,
        { method: 'PATCH', body: JSON.stringify({ unitPrice: -5, expectedVersion: version }) },
      ],
      expected: 'domain_rule_violated',
    },
    {
      rule: 'zapis pozycji bez wersji',
      tool: { name: 'procurement_update_offer_item', input: ({ itemId }) => ({ itemId, quantity: 4 }) },
      request: ({ itemId }) => [
        `/api/m/procurement/items/${itemId}`,
        { method: 'PATCH', body: JSON.stringify({ quantity: 4 }) },
      ],
      expected: 'validation_failed',
    },
    {
      rule: 'zapis pozycji z nieaktualna wersja',
      tool: {
        name: 'procurement_update_offer_item',
        input: ({ itemId, version }) => ({ itemId, quantity: 4, expectedVersion: version + 7 }),
      },
      request: ({ itemId, version }) => [
        `/api/m/procurement/items/${itemId}`,
        { method: 'PATCH', body: JSON.stringify({ quantity: 4, expectedVersion: version + 7 }) },
      ],
      expected: 'conflict',
    },
  ];

  it.each(rules)('$rule — ta sama odmowa przez MCP i przez HTTP', async (row) => {
    const { item } = firstItem();
    const ctx = { itemId: item.id, version: item.version };
    const weightsBefore = h.service.repo.listCriteria(caseId).map((c) => [c.key, c.weight]);

    const viaTool = await codeOfTool(row.tool.name, row.tool.input(ctx));
    const [path, init] = row.request(ctx);
    const viaHttp = await http(path, init);

    expect(viaTool, `narzedzie przyjelo: ${row.rule}`).toBe(row.expected);
    expect(viaHttp.code, `endpoint przyjal: ${row.rule}`).toBe(row.expected);
    expect(viaHttp.status).not.toBe(500);

    // Neither door changed anything on the way to refusing.
    expect(h.service.repo.listCriteria(caseId).map((c) => [c.key, c.weight])).toEqual(weightsBefore);
    const after = h.service.repo.getItem(item.id, h.ownerId).item;
    expect(after.version).toBe(item.version);
    expect(after.quantityMilli).toBe(item.quantityMilli);
  });

  it('obie drogi przyjmuja to samo poprawne wejscie i daja ten sam skutek', async () => {
    await callTool('procurement_set_criteria_weights', {
      caseId,
      weights: [{ key: 'total_cost', weight: 41 }],
    });
    expect(weightOf('total_cost')).toBe(41);

    const viaHttp = await http(`/api/m/procurement/cases/${caseId}/criteria`, {
      method: 'POST',
      body: JSON.stringify({ weights: [{ key: 'total_cost', weight: 42 }] }),
    });
    expect(viaHttp.status).toBe(200);
    expect(weightOf('total_cost')).toBe(42);

    // And the read window is the same size through both doors.
    const toolSearch = (await callTool('procurement_search', { query: '*', limit: 2 })) as {
      results: unknown[];
    };
    const httpSearch = await http('/api/m/procurement/search?q=*&limit=2');
    expect(httpSearch.status).toBe(200);
    expect(httpSearch.body.results).toHaveLength(toolSearch.results.length);
    expect(toolSearch.results.length).toBeLessThanOrEqual(2);
  });
});

/* ========================================================================== */
/*  L9.3 — validated at runtime, with a recognisable cause                    */
/* ========================================================================== */

describe('L9.3 — kazde wejscie walidowane w runtime, z rozpoznawalna przyczyna', () => {
  /**
   * Malformed input, at every door that takes a body or a query.
   *
   * The assertion is deliberately not "the right code" but "**not** `internal`":
   * `internal` is the code the error shaper produces when nobody recognised the
   * failure, so a 500 here means an unguarded `parse` somewhere — which is
   * exactly what `POST /api/canvas/spaces`, `POST /api/runs/:id/permission` and
   * the two module routes used to be.
   */
  const malformed: Array<[string, string, RequestInit]> = [
    ['przestrzen canvas bez tytulu', '/api/canvas/spaces', { method: 'POST', body: JSON.stringify({}) }],
    ['przestrzen canvas z tytulem liczba', '/api/canvas/spaces', { method: 'POST', body: JSON.stringify({ title: 7 }) }],
    ['karta canvas bez specyfikacji', '/api/canvas/cards', { method: 'POST', body: JSON.stringify({ title: 'x' }) }],
    ['odczyt bez nazwy operacji', '/api/read', { method: 'POST', body: JSON.stringify({}) }],
    ['akcja rekordu bez pol', '/api/actions', { method: 'POST', body: JSON.stringify({}) }],
    ['polecenie agenta z zepsutym kontekstem', '/api/agui/run', { method: 'POST', body: JSON.stringify({ messages: [], context: { resource: 'tekst' } }) }],
    ['wagi kryteriow bez listy', `/api/m/procurement/cases/PLACEHOLDER/criteria`, { method: 'POST', body: JSON.stringify({}) }],
    ['wyszukiwanie z limitem tekstowym', '/api/m/procurement/search?q=abc&limit=duzo', {}],
    ['opis ekranu bez wersji', '/api/ui/snapshot', { method: 'PUT', body: JSON.stringify({ clientId: 'c1' }) }],
    ['watek bez tresci', '/api/threads/create', { method: 'POST', body: 'to nie jest json' }],
  ];

  it.each(malformed)('%s nie konczy sie kodem internal', async (_name, path, init) => {
    const out = await http(path.replace('PLACEHOLDER', caseId), init);
    expect(out.status, `${path} → ${out.status}`).not.toBe(500);
    expect(out.code, `${path} → ${JSON.stringify(out.body)?.slice(0, 200)}`).not.toBe('internal');
    if (out.code !== null) expect(APP_ERROR_CODES).toContain(out.code);
  });

  it('odmowa niesie liste problemow, nie sam komunikat', async () => {
    const out = await http(`/api/m/procurement/cases/${caseId}/criteria`, {
      method: 'POST',
      body: JSON.stringify({ weights: [{ key: 'total_cost', weight: 900 }] }),
    });
    expect(out.code).toBe('validation_failed');
    const issues = out.body.error.details.issues as Array<{ path: string; message: string }>;
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path.includes('weight'))).toBe(true);
  });

  it('odpowiedz na prosbe o zgode bez requestId to validation_failed, nie internal', async () => {
    const conversationId = h.platform.services.conversations.create({
      ownerId: h.ownerId,
      title: 'Zgoda',
    }).id;
    const run = h.platform.services.runs.start({
      conversationId,
      ownerId: h.ownerId,
      prompt: 'p',
      appContext: { ...toolCtx().appContext, conversationId },
      workspaceDir: null,
      abort: new AbortController(),
    });

    for (const body of ['{}', 'nie-json', JSON.stringify({ requestId: 7 })]) {
      const out = await http(`/api/runs/${run.id}/permission`, { method: 'POST', body });
      expect(out.code, `cialo: ${body}`).toBe('validation_failed');
      expect(out.status).toBe(400);
    }
  });

  it('kazdy kod bledu ma swoj status HTTP i zaden nie jest zgadywany', async () => {
    const seen = new Map<string, number>();
    const { item } = firstItem();
    seen.set('validation_failed', (await http(`/api/m/procurement/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ quantity: 1 }) })).status);
    seen.set('conflict', (await http(`/api/m/procurement/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ quantity: 1, expectedVersion: item.version + 9 }) })).status);
    seen.set('domain_rule_violated', (await http(`/api/m/procurement/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ quantity: -1, expectedVersion: item.version }) })).status);
    seen.set('forbidden', (await http(`/api/m/procurement/cases/${caseId}`, {}, otherCookie)).status);
    seen.set('not_found', (await http('/api/m/procurement/cases/nie-ma-takiej', {})).status);
    seen.set('unauthenticated', (await http('/api/m/procurement/cases', {}, '')).status);

    expect(Object.fromEntries(seen)).toEqual({
      validation_failed: 400,
      conflict: 409,
      domain_rule_violated: 422,
      forbidden: 403,
      not_found: 404,
      unauthenticated: 401,
    });
  });
});

/* ========================================================================== */
/*  L9.5 — the backend decides who you are                                    */
/* ========================================================================== */

describe('L9.5 — identyfikator wlasciciela od modelu lub przegladarki nic nie daje', () => {
  it('ownerId w ciele zadania jest ignorowany — decyduje sesja', async () => {
    const { item } = firstItem();

    /*
     * The body names the *other* owner, and the write is made with this
     * owner's cookie. If the body counted for anything, the change would land
     * as somebody else — so the test asserts both halves: it succeeded, and it
     * succeeded as the session's owner.
     */
    const out = await http(`/api/m/procurement/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        quantity: 6,
        expectedVersion: item.version,
        ownerId: h.otherOwnerId,
        owner_id: h.otherOwnerId,
      }),
    });
    expect(out.status).toBe(200);
    expect(h.service.repo.getItem(item.id, h.ownerId).item.quantityMilli).toBe(6000);
    // The other owner still cannot see or touch it, body or no body.
    expect(() => h.service.repo.getItem(item.id, h.otherOwnerId)).toThrowError();
  });

  it('ta sama zmiana z ciasteczkiem drugiego wlasciciela to 403, mimo poprawnego ownerId w ciele', async () => {
    const { item } = firstItem();
    const before = h.service.repo.getItem(item.id, h.ownerId).item;

    const out = await http(
      `/api/m/procurement/items/${item.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ quantity: 9, expectedVersion: before.version, ownerId: h.ownerId }),
      },
      otherCookie,
    );
    expect(out.status).toBe(403);
    expect(out.code).toBe('forbidden');
    const after = h.service.repo.getItem(item.id, h.ownerId).item;
    expect(after.version).toBe(before.version);
    expect(after.quantityMilli).toBe(before.quantityMilli);
  });

  it('ownerId w wejsciu narzedzia MCP nie zmienia wlasciciela wykonania', async () => {
    // The tool call is made *as the second owner* while naming the first one.
    await expect(
      callTool('procurement_get_case', { caseId, ownerId: h.ownerId }, { ownerId: h.otherOwnerId }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // And a write tool, likewise: the context owns the call.
    const { item } = firstItem();
    await expect(
      callTool(
        'procurement_update_offer_item',
        { itemId: item.id, quantity: 3, expectedVersion: item.version, ownerId: h.ownerId },
        { ownerId: h.otherOwnerId },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.service.repo.getItem(item.id, h.ownerId).item.version).toBe(item.version);
  });

  it('zaden schemat narzedzia nie ma pola wlasciciela do podstawienia', () => {
    const entries = collectToolEntries({
      registry: h.platform.registry,
      platformTools: platformTools(h.platform.services),
    });
    expect(entries.length).toBeGreaterThan(15);
    const offenders: string[] = [];
    for (const entry of entries) {
      const shape = (entry.def.inputSchema as { shape?: Record<string, unknown> }).shape ?? {};
      for (const field of Object.keys(shape)) {
        if (/owner|user(id)?$/i.test(field)) offenders.push(`${entry.localName}.${field}`);
      }
    }
    expect(offenders, 'narzedzie przyjmuje identyfikator wlasciciela w wejsciu').toEqual([]);
  });
});

/* ========================================================================== */
/*  L9.6 — a conflict is resolved, never overwritten                          */
/* ========================================================================== */

describe('L9.6 — konflikt aktualnosci nie nadpisuje nowszych danych', () => {
  it('dwoch piszacych: ten, kto czytal wczesniej, dostaje conflict, a zmiana drugiego zostaje', async () => {
    const { item } = firstItem();
    // Both read the same version. This is the race, written out.
    const readByA = item.version;
    const readByB = item.version;

    await callTool('procurement_update_offer_item', {
      itemId: item.id,
      quantity: 12,
      expectedVersion: readByB,
    });

    await expect(
      callTool('procurement_update_offer_item', {
        itemId: item.id,
        quantity: 99,
        expectedVersion: readByA,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // B's value survived; A's never landed.
    expect(h.service.repo.getItem(item.id, h.ownerId).item.quantityMilli).toBe(12000);
  });

  it('zapis pozycji bez wersji jest odrzucany takze w serwisie, nie tylko w schemacie', async () => {
    const { item } = firstItem();
    await expect(
      // The schemas of both doors demand the field; this goes straight to the
      // service, which is where the check used to be absent.
      h.service.updateOfferItem({ itemId: item.id, quantity: 8 } as never, h.ownerId),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(h.service.repo.getItem(item.id, h.ownerId).item.version).toBe(item.version);
  });

  it('zmiana tresci karty bez wersji jest odrzucana w serwisie i przez HTTP', async () => {
    const space = h.platform.services.canvas.createSpace({ ownerId: h.ownerId, title: 'Wersje' });
    const spec = { kind: 'component' as const, component: 'platform.markdown', props: { markdown: 'a' } };
    const card = await h.platform.services.canvas.addCard(
      { spaceId: space.id, title: 'K', spec },
      h.ownerId,
    );

    await expect(
      h.platform.services.canvas.updateSpec(
        { cardId: card.id, spec: { ...spec, props: { markdown: 'b' } } } as never,
        h.ownerId,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    const viaHttp = await http(`/api/canvas/cards/${card.id}/spec`, {
      method: 'PATCH',
      body: JSON.stringify({ spec: { ...spec, props: { markdown: 'b' } } }),
    });
    expect(viaHttp.code).toBe('validation_failed');

    // Neither attempt touched the card.
    const after = h.platform.services.canvas.getCard(card.id, h.ownerId);
    expect((after.spec as any).props.markdown).toBe('a');
    expect(after.specVersion).toBe(card.specVersion);
  });

  it('karta: nieaktualna wersja to conflict, a tresc nowszego zapisu zostaje', async () => {
    const space = h.platform.services.canvas.createSpace({ ownerId: h.ownerId, title: 'Wersje 2' });
    const spec = { kind: 'component' as const, component: 'platform.markdown', props: { markdown: 'a' } };
    const card = await h.platform.services.canvas.addCard(
      { spaceId: space.id, title: 'K', spec },
      h.ownerId,
    );
    const readByBoth = card.specVersion;

    await h.platform.services.canvas.updateSpec(
      { cardId: card.id, spec: { ...spec, props: { markdown: 'nowsze' } }, expectedSpecVersion: readByBoth },
      h.ownerId,
    );
    await expect(
      h.platform.services.canvas.updateSpec(
        { cardId: card.id, spec: { ...spec, props: { markdown: 'starsze' } }, expectedSpecVersion: readByBoth },
        h.ownerId,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect((h.platform.services.canvas.getCard(card.id, h.ownerId).spec as any).props.markdown).toBe(
      'nowsze',
    );
  });
});

/* ========================================================================== */
/*  L9.7 / L9.14 — one effect, however many retries                           */
/* ========================================================================== */

describe('L9.7, L9.14 — powtorzenie i jednoczesne ponowienia daja jeden skutek', () => {
  it('osiem jednoczesnych ponowien zmiany pozycji: jeden przyrost wersji, jeden wynik', async () => {
    const { item } = firstItem();
    const operationId = 'op-rownolegle-pozycja';

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.service.updateOfferItem(
          { itemId: item.id, quantity: 7, expectedVersion: item.version, operationId },
          h.ownerId,
        ),
      ),
    );

    const after = h.service.repo.getItem(item.id, h.ownerId).item;
    expect(after.version, 'ponowienia zdublowaly skutek').toBe(item.version + 1);
    expect(after.quantityMilli).toBe(7000);
    // Exactly one of them performed the work; the rest received its result.
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.item.version))).toEqual(new Set([item.version + 1]));
  });

  it('osiem jednoczesnych zapisow zestawienia tworzy jeden artefakt', async () => {
    const before = h.platform.services.artifacts.list(h.ownerId).length;
    const operationId = 'op-rownolegle-zestawienie';

    const results = (await Promise.all(
      Array.from({ length: 8 }, () =>
        callTool('procurement_save_comparison', { caseId, operationId }),
      ),
    )) as Array<{ artifactId: string; replayed: boolean }>;

    expect(h.platform.services.artifacts.list(h.ownerId).length).toBe(before + 1);
    expect(new Set(results.map((r) => r.artifactId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it('powtorzony zapis zestawienia po zakonczeniu pierwszego tez nie tworzy drugiego artefaktu', async () => {
    const operationId = 'op-zestawienie-sekwencyjnie';
    const first = (await callTool('procurement_save_comparison', { caseId, operationId })) as any;
    const second = (await callTool('procurement_save_comparison', { caseId, operationId })) as any;
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.replayed).toBe(true);
    expect(
      h.platform.services.artifacts.list(h.ownerId).filter((a) => a.id === first.artifactId),
    ).toHaveLength(1);
  });

  it('ten sam klucz z inna trescia jest odrzucany, a nie odpowiadany wynikiem pierwszego', async () => {
    const { item } = firstItem();
    const operationId = 'op-ten-sam-klucz-inna-tresc';

    const first = await h.service.updateOfferItem(
      { itemId: item.id, quantity: 3, expectedVersion: item.version, operationId },
      h.ownerId,
    );
    expect(first.replayed).toBe(false);

    await expect(
      h.service.updateOfferItem(
        { itemId: item.id, quantity: 500, expectedVersion: item.version, operationId },
        h.ownerId,
      ),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'operation_id_reused' } });

    // The caller is told; the value from the first request is what is stored.
    expect(h.service.repo.getItem(item.id, h.ownerId).item.quantityMilli).toBe(3000);
  });

  it('klucz jest zarezerwowany, zanim operacja cokolwiek zapisze', async () => {
    const scope = 'test.kolejnosc';
    const operationId = 'op-rezerwacja-przed-praca';
    let statusInside: string | undefined;

    await h.platform.services.idempotency.once(operationId, h.ownerId, scope, async () => {
      statusInside = h.platform.services.idempotency.status(operationId, h.ownerId, scope);
      return { ok: true };
    });

    expect(statusInside, 'klucz powstal dopiero po operacji').toBe('pending');
    expect(h.platform.services.idempotency.status(operationId, h.ownerId, scope)).toBe('done');
  });

  it('nieudana operacja zwalnia klucz, wiec szczera ponowna proba moze sie udac', async () => {
    const { item } = firstItem();
    const operationId = 'op-po-nieudanej-probie';

    await expect(
      h.service.updateOfferItem(
        { itemId: item.id, quantity: -1, expectedVersion: item.version, operationId },
        h.ownerId,
      ),
    ).rejects.toMatchObject({ code: 'domain_rule_violated' });
    // A failure is not a stored outcome.
    expect(
      h.platform.services.idempotency.status(operationId, h.ownerId, 'procurement.updateOfferItem'),
    ).toBeUndefined();

    const retry = await h.service.updateOfferItem(
      { itemId: item.id, quantity: 2, expectedVersion: item.version, operationId },
      h.ownerId,
    );
    expect(retry.replayed).toBe(false);
    expect(h.service.repo.getItem(item.id, h.ownerId).item.quantityMilli).toBe(2000);
  });

  it('operacja przerwana przez smierc procesu nie jest po cichu powtarzana', async () => {
    const { item } = firstItem();
    const operationId = 'op-przerwana-restartem';
    const scope = 'procurement.updateOfferItem';

    /*
     * A process that died between reserving the key and storing the result
     * leaves the row `pending`; the next boot names it. What must not happen
     * afterwards is a silent re-run of a mutation whose effect nobody knows.
     */
    h.platform.services.db.$client
      .prepare(
        `INSERT INTO idempotency_keys (operation_id, owner_id, scope, result, created_at, status, fingerprint)
         VALUES (?, ?, ?, '', ?, 'pending', NULL)`,
      )
      .run(operationId, h.ownerId, scope, new Date().toISOString());
    expect(h.platform.services.idempotency.reconcileOnBoot()).toBe(1);
    expect(h.platform.services.idempotency.status(operationId, h.ownerId, scope)).toBe('interrupted');

    await expect(
      h.service.updateOfferItem(
        { itemId: item.id, quantity: 4, expectedVersion: item.version, operationId },
        h.ownerId,
      ),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'operation_interrupted' } });
    expect(h.service.repo.getItem(item.id, h.ownerId).item.version).toBe(item.version);
  });
});

/* ========================================================================== */
/*  L9.8 / L9.15 — a failure forced between two steps                         */
/* ========================================================================== */

describe('L9.8, L9.15 — wymuszona awaria w polowie wieloetapowego zapisu', () => {
  it('awaria miedzy zapisem pozycji a dotknieciem oferty nie zostawia zmienionej pozycji', async () => {
    const { offer, item } = firstItem();
    const offerBefore = h.service.repo.getOffer(offer.id, h.ownerId);

    // The failure is forced *between* the two writes of one transaction: the
    // item row has already been updated when this throws.
    vi.spyOn(h.service.repo, 'touchOffer').mockImplementation(() => {
      throw new Error('awaria po zapisie pozycji');
    });

    await expect(
      h.service.updateOfferItem(
        { itemId: item.id, quantity: 44, expectedVersion: item.version },
        h.ownerId,
      ),
    ).rejects.toThrowError(/awaria po zapisie pozycji/);

    vi.restoreAllMocks();
    const after = h.service.repo.getItem(item.id, h.ownerId).item;
    expect(after.quantityMilli, 'polowa zapisu przetrwala awarie').toBe(item.quantityMilli);
    expect(after.version).toBe(item.version);
    expect(h.service.repo.getOffer(offer.id, h.ownerId).updatedAt).toBe(offerBefore.updatedAt);
  });

  it('awaria w polowie ustawiania wag nie zostawia czesci wag zmienionych', async () => {
    const before = h.service.repo.listCriteria(caseId).map((c) => [c.key, c.weight]);
    expect(before.length).toBeGreaterThan(2);

    const original = h.service.repo.upsertCriterion.bind(h.service.repo);
    let calls = 0;
    vi.spyOn(h.service.repo, 'upsertCriterion').mockImplementation((criterion) => {
      calls += 1;
      if (calls === 3) throw new Error('awaria w polowie zapisu wag');
      original(criterion);
    });

    expect(() =>
      h.service.setCriterionWeights(caseId, h.ownerId, [
        { key: 'total_cost', weight: 5 },
        { key: 'delivery_days', weight: 6 },
        { key: 'validity_days', weight: 7 },
        { key: 'completeness', weight: 8 },
      ]),
    ).toThrowError(/awaria w polowie zapisu wag/);

    vi.restoreAllMocks();
    expect(calls, 'awaria nie wypadla w srodku listy').toBeGreaterThan(1);
    expect(
      h.service.repo.listCriteria(caseId).map((c) => [c.key, c.weight]),
      'czesc wag zostala zmieniona mimo przerwanej operacji',
    ).toEqual(before);
  });

  it('nieudane utworzenie artefaktu z pliku nie zostawia osieroconego pliku', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'agentic-workspace-'));
    tempDirs.push(workspaceDir);
    mkdirSync(join(workspaceDir, 'output'), { recursive: true });
    writeFileSync(join(workspaceDir, 'output', 'raport.md'), '# raport\n');

    const filesBefore = h.platform.services.files.list(h.ownerId).length;
    const artifactsBefore = h.platform.services.artifacts.list(h.ownerId).length;

    vi.spyOn(h.platform.services.artifacts, 'create').mockImplementation(() => {
      throw new Error('awaria zapisu artefaktu');
    });

    await expect(
      callPlatformTool(
        'artifact_publish_file',
        { path: 'raport.md', title: 'Raport', operationId: 'op-publikacja-awaria' },
        { workspaceDir, runId: null },
      ),
    ).rejects.toThrowError(/awaria zapisu artefaktu/);

    vi.restoreAllMocks();
    expect(
      h.platform.services.files.list(h.ownerId).length,
      'plik zostal na liscie mimo nieudanej publikacji',
    ).toBe(filesBefore);
    expect(h.platform.services.artifacts.list(h.ownerId).length).toBe(artifactsBefore);

    // And the same call, unobstructed, does publish — so the test above failed
    // for the injected reason and not because the call never worked.
    const ok = (await callPlatformTool(
      'artifact_publish_file',
      { path: 'raport.md', title: 'Raport', operationId: 'op-publikacja-udana' },
      { workspaceDir, runId: null },
    )) as { artifactId: string; fileId: string };
    expect(ok.artifactId).toBeTruthy();
    expect(h.platform.services.files.list(h.ownerId).length).toBe(filesBefore + 1);
  });
});
