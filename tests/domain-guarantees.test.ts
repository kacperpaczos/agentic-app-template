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
    ['watek z cialem, ktore nie jest JSON-em', '/api/threads/create', { method: 'POST', body: 'to nie jest json' }],
    ['watek z tytulem liczba', '/api/threads/create', { method: 'POST', body: JSON.stringify({ title: 7 }) }],
    ['zmiana watku z cialem, ktore nie jest JSON-em', '/api/threads/update/PLACEHOLDER_CONV', { method: 'PATCH', body: '{' }],
    ['sesja z cialem, ktore nie jest JSON-em', '/api/auth/session', { method: 'POST', body: 'userId=inny' }],
    ['sesja z userId liczba', '/api/auth/session', { method: 'POST', body: JSON.stringify({ userId: 7 }) }],
  ];

  /*
   * The assertion is a **refusal**, not merely "not internal".
   *
   * It used to be the weaker pair (status ≠ 500, code ≠ `internal`), and on a
   * route that swallows a broken body and answers 200 both halves pass while
   * touching nothing: `/api/threads/create` parsed `'to nie jest json'` with
   * `.catch(() => ({}))`, created a conversation and returned 200, and the row
   * reported success. A row that cannot fail is not a row. Every entry above is
   * now required to be refused, with a code from the taxonomy that is not the
   * catch-all.
   */
  it.each(malformed)('%s jest odrzucone z rozpoznawalna przyczyna', async (_name, path, init) => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, title: 'Do zmiany' });
    const url = path.replace('PLACEHOLDER_CONV', conv.id).replace('PLACEHOLDER', caseId);
    const out = await http(url, init);
    expect(out.status, `${url} → ${out.status} ${JSON.stringify(out.body)?.slice(0, 160)}`).toBeGreaterThanOrEqual(400);
    expect(out.status).not.toBe(500);
    expect(out.code, `${url} → ${JSON.stringify(out.body)?.slice(0, 200)}`).not.toBe('internal');
    expect(APP_ERROR_CODES).toContain(out.code);
  });

  it('cialo, ktorego nie da sie sparsowac, nie tworzy rozmowy i nie zmienia istniejacej', async () => {
    /*
     * The half the battery cannot see: that the refusal happened *before* the
     * write. A 400 returned after the conversation was created would satisfy
     * every row above and still be the defect.
     */
    const before = h.platform.services.conversations.list(h.ownerId);
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, title: 'Nazwa poczatkowa' });

    const created = await http('/api/threads/create', { method: 'POST', body: 'to nie jest json' });
    expect(created.code).toBe('validation_failed');
    expect(created.body.error.details.reason).toBe('malformed_json');

    const updated = await http(`/api/threads/update/${conv.id}`, { method: 'PATCH', body: 'rowniez nie' });
    expect(updated.code).toBe('validation_failed');

    // One conversation more than before — the one this test made itself.
    expect(h.platform.services.conversations.list(h.ownerId)).toHaveLength(before.length + 1);
    expect(h.platform.services.conversations.get(conv.id, h.ownerId).title).toBe('Nazwa poczatkowa');
  });

  it('pusty brak ciala nadal zaklada watek — odmowa dotyczy tresci zepsutej, nie nieobecnej', async () => {
    // The distinction the fix rests on: "said nothing" and "said something
    // unparseable" are different requests, and only the second is an error.
    const before = h.platform.services.conversations.list(h.ownerId).length;
    const out = await http('/api/threads/create', { method: 'POST' });
    expect(out.status).toBe(200);
    expect(h.platform.services.conversations.list(h.ownerId)).toHaveLength(before + 1);
  });

  it('watek nie da sie zwiazac z cudza przestrzenia canvas', async () => {
    const foreign = h.platform.services.canvas.createSpace({
      ownerId: h.otherOwnerId,
      title: 'Cudza przestrzen',
    });
    const before = h.platform.services.conversations.list(h.ownerId).length;
    const out = await http('/api/threads/create', {
      method: 'POST',
      body: JSON.stringify({ spaceId: foreign.id }),
    });
    expect(out.status).toBe(403);
    expect(out.code).toBe('forbidden');
    expect(h.platform.services.conversations.list(h.ownerId)).toHaveLength(before);
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

  it('L9.7 domkniecie: operationId jest teraz wymagany w trzech narzedziach, a repeat z kluczem daje jeden skutek', async () => {
    /*
     * Was: "powtorzenie BEZ operationId: trzy narzedzia dubluja skutek, cztery
     * sa chronione inaczej" — a test that proved the gap by reproducing it.
     * `canvas_add_card`, `agent_view_create` and `files_publish_version` now
     * require `operationId` in their schema (the same contract as
     * `artifact_create` / `artifact_publish_file`), so the call this test used
     * to make no longer parses — the repeat is refused before the handler ever
     * runs, not after it ran twice. Two things are proved instead, for each of
     * the three: the schema refuses the call without a key (`validation_failed`,
     * naming `operationId`), and a repeat *with* a key produces exactly one row
     * — checked in the database, not in what the tool answers. The four tools
     * that were already protected another way are unchanged and stay below, so
     * the distinction the old test made is not lost, only re-based on a fix
     * instead of on a gap.
     */
    const conversationId = h.platform.services.conversations.create({
      ownerId: h.ownerId,
      title: 'Powtorzenia z i bez klucza',
    }).id;
    const ctx = { conversationId };
    const space = h.platform.services.canvas.createSpace({ ownerId: h.ownerId, title: 'Z kluczem' });
    const spec = { kind: 'component' as const, component: 'platform.markdown', props: { markdown: 'x' } };
    const cardsIn = (spaceId: string) =>
      h.platform.services.canvas.getState(spaceId, h.ownerId).cards.length;

    /* --- canvas_add_card: bez klucza odrzucone, z kluczem jeden skutek --- */
    await expect(
      callPlatformTool('canvas_add_card', { spaceId: space.id, title: 'K', spec }, ctx),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      details: { issues: [expect.objectContaining({ path: 'operationId' })] },
    });
    expect(cardsIn(space.id), 'wywolanie bez operationId nie powinno bylo nic zapisac').toBe(0);
    const addCardOp = 'op-canvas-add-card-1';
    await callPlatformTool('canvas_add_card', { spaceId: space.id, title: 'K', spec, operationId: addCardOp }, ctx);
    await callPlatformTool('canvas_add_card', { spaceId: space.id, title: 'K', spec, operationId: addCardOp }, ctx);
    expect(cardsIn(space.id), 'canvas_add_card zdublowal mimo tego samego operationId').toBe(1);

    /* --- chronione: canvas_update_card (wersja) --------------------------- */
    const card = h.platform.services.canvas.getState(space.id, h.ownerId).cards[0]!;
    const patch = { cardId: card.id, spec: { ...spec, props: { markdown: 'y' } }, expectedSpecVersion: card.specVersion };
    await callPlatformTool('canvas_update_card', patch, ctx);
    await expect(callPlatformTool('canvas_update_card', patch, ctx)).rejects.toMatchObject({
      code: 'conflict',
    });

    /* --- chronione: canvas_remove_card (brak wiersza) --------------------- */
    await callPlatformTool('canvas_remove_card', { cardId: card.id }, ctx);
    await expect(callPlatformTool('canvas_remove_card', { cardId: card.id }, ctx)).rejects.toMatchObject({
      code: 'not_found',
    });

    /* --- agent_view_create: bez klucza odrzucone, z kluczem jeden skutek - */
    const source = 'root = TextContent("widok")';
    await expect(callPlatformTool('agent_view_create', { title: 'W', source }, ctx)).rejects.toMatchObject({
      code: 'validation_failed',
      details: { issues: [expect.objectContaining({ path: 'operationId' })] },
    });
    const createViewOp = 'op-agent-view-create-1';
    const firstView = (await callPlatformTool(
      'agent_view_create',
      { title: 'W', source, operationId: createViewOp },
      ctx,
    )) as { cardId: string; spaceId: string };
    await callPlatformTool('agent_view_create', { title: 'W', source, operationId: createViewOp }, ctx);
    expect(cardsIn(firstView.spaceId), 'agent_view_create zdublowal mimo tego samego operationId').toBe(1);

    /* --- chronione: agent_view_update (scalenie bez zmiany) --------------- */
    const edit = { cardId: firstView.cardId, patch: 'root = TextContent("inny")' };
    const changed = (await callPlatformTool('agent_view_update', edit, ctx)) as { unchanged: boolean; specVersion: number };
    const again = (await callPlatformTool('agent_view_update', edit, ctx)) as { unchanged: boolean; specVersion: number };
    expect(changed.unchanged).toBe(false);
    expect(again.unchanged, 'powtorzony agent_view_update zapisal drugi raz').toBe(true);
    expect(again.specVersion).toBe(changed.specVersion);

    /* --- chronione: agent_view_remove (brak wiersza) ---------------------- */
    await callPlatformTool('agent_view_remove', { cardId: firstView.cardId }, ctx);
    await expect(
      callPlatformTool('agent_view_remove', { cardId: firstView.cardId }, ctx),
    ).rejects.toMatchObject({ code: 'not_found' });

    /* --- files_publish_version: bez klucza odrzucone, z kluczem jeden skutek */
    const workspaceDir = mkdtempSync(join(tmpdir(), 'agentic-workspace-'));
    tempDirs.push(workspaceDir);
    mkdirSync(join(workspaceDir, 'output'), { recursive: true });
    writeFileSync(join(workspaceDir, 'output', 'wersja.csv'), 'a,b\n1,2\n');
    const original = h.platform.services.files.list(h.ownerId)[0]!;
    const filesBefore = h.platform.services.files.list(h.ownerId).length;
    const publishNoKey = { path: 'wersja.csv', originalFileId: original.id };
    await expect(
      callPlatformTool('files_publish_version', publishNoKey, { ...ctx, workspaceDir }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      details: { issues: [expect.objectContaining({ path: 'operationId' })] },
    });
    expect(
      h.platform.services.files.list(h.ownerId).length,
      'wywolanie bez operationId nie powinno bylo nic zapisac',
    ).toBe(filesBefore);
    const publish = { ...publishNoKey, operationId: 'op-files-publish-version-1' };
    await callPlatformTool('files_publish_version', publish, { ...ctx, workspaceDir });
    await callPlatformTool('files_publish_version', publish, { ...ctx, workspaceDir });
    expect(
      h.platform.services.files.list(h.ownerId).length,
      'files_publish_version zdublowal mimo tego samego operationId',
    ).toBe(filesBefore + 1);
  });

  /*
   * The rule behind the three tools above, derived from code instead of typed
   * by hand.
   *
   * A hand-written list of tool names goes stale the moment a ninth tool is
   * added: whoever writes it either has to remember this describe block exists
   * or the new tool passes with nothing checking it at all — which is exactly
   * how `canvas_add_card`, `agent_view_create` and `files_publish_version` got
   * here in the first place. This test instead walks every *registered* write
   * tool (platform tools and every installed module's, the same list the MCP
   * server offers the model) and asks each one, structurally, whether it has
   * declared its idempotency:
   *
   *  - an `operationId` field that is REQUIRED passes outright — the schema
   *    itself refuses a keyless repeat before any handler runs;
   *  - an `operationId` field that is optional, or no such field at all, only
   *    passes if the tool is named in `OPTIONAL_OPERATION_ID_REASON` below,
   *    with a one-line reason.
   *
   * That map is the only hand-written list left, and it is an *exemption*
   * list, not an enumeration: it fails closed. A new write tool that creates a
   * row and ships without `operationId` is not in the map, so the test fails
   * loudly on it — it does not need the map to be kept in sync to be caught,
   * the way the old test needed its hand-written call sites kept in sync. The
   * only way to make this test pass for such a tool is to either give it a
   * required `operationId` (the default) or add it here with a reason a
   * reviewer can check against the handler — the same discipline the comments
   * on `canvas_update_card` and `saveComparisonInput` already write out.
   */
  describe('narzedzie zapisu deklaruje idempotencje (wyliczone z kodu, nie z listy)', () => {
    const OPTIONAL_OPERATION_ID_REASON: Record<string, string> = {
      // expectedSpecVersion required: a repeat is a conflict, not a second write.
      canvas_update_card: 'wersja wymagana (expectedSpecVersion) — powtorzenie konczy sie conflict',
      // Absolute geometry set: two identical calls converge to the same row, no card is created.
      canvas_move_card: 'ustawienie bezwzgledne geometrii — powtorzenie zbiega do tego samego stanu, bez nowego wiersza',
      // Delete by id: nothing left to delete twice.
      canvas_remove_card: 'usuniecie po id — powtorzenie konczy sie not_found, nie drugim usunieciem',
      // Merge detects a no-op: see `agent_view_update`'s own handler ("unchanged: true").
      agent_view_update: 'scalenie wykrywa brak zmiany — powtorzenie zwraca unchanged=true bez zapisu',
      // Delete by id: same as canvas_remove_card.
      agent_view_remove: 'usuniecie po id — powtorzenie konczy sie not_found, nie drugim usunieciem',
      // expectedVersion required (module-procurement/src/server/inputs.ts): same shape as canvas_update_card.
      procurement_update_offer_item: 'wersja wymagana (expectedVersion) — powtorzenie konczy sie conflict',
      // Absolute upsert of criteria weights: no row is created, repeat writes the same values.
      procurement_set_criteria_weights: 'ustawienie bezwzgledne wag (upsert) — powtorzenie zapisuje te sama wartosc',
    };

    it('kazde effect: "write" ma operationId wymagane albo udokumentowany powod, ze nie musi', () => {
      const entries = collectToolEntries({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
      });
      const writeTools = entries.filter((e) => e.def.effect === 'write');
      // A change to the registry that silently drops every write tool would
      // make every assertion below vacuously true; this keeps that honest.
      expect(writeTools.length).toBeGreaterThanOrEqual(10);

      const undeclared: string[] = [];
      for (const { localName, def } of writeTools) {
        const shape = def.inputSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
        const operationIdSchema = shape.operationId;
        const isRequired = operationIdSchema ? !operationIdSchema.safeParse(undefined).success : false;
        if (isRequired) continue; // Compliant by construction: the schema itself refuses a keyless call.
        if (!(localName in OPTIONAL_OPERATION_ID_REASON)) undeclared.push(localName);
      }
      expect(
        undeclared,
        'narzedzia zapisu bez wymaganego operationId i bez wpisu w OPTIONAL_OPERATION_ID_REASON — ' +
          'kazde z nich albo potrzebuje operationId: OPERATION_ID (wymagane), albo wpisu z powodem powyzej',
      ).toEqual([]);
    });
  });

  it('publikacja z workspace: ten sam klucz z inna sciezka LUB inna trescia jest odrzucany', async () => {
    /*
     * The write path that was missed when the guard was rebuilt. Without a
     * fingerprint the second call — a *different* source file under the same
     * key — was answered with the first publication's id, version and download
     * link, and reported success: the caller would be told its file was
     * published while nothing of it was written.
     */
    const workspaceDir = mkdtempSync(join(tmpdir(), 'agentic-workspace-'));
    tempDirs.push(workspaceDir);
    mkdirSync(join(workspaceDir, 'output'), { recursive: true });
    writeFileSync(join(workspaceDir, 'output', 'pierwszy.csv'), 'a,b\n1,2\n');
    writeFileSync(join(workspaceDir, 'output', 'drugi.csv'), 'a,b\n9,9\n');

    const original = h.platform.services.files.list(h.ownerId)[0]!;
    const operationId = 'op-wersja-pliku-1';

    const first = (await callPlatformTool(
      'files_publish_version',
      { path: 'pierwszy.csv', originalFileId: original.id, operationId },
      { workspaceDir },
    )) as { fileId: string; version: number };
    expect(first.fileId).toBeTruthy();
    const afterFirst = h.platform.services.files.list(h.ownerId).length;

    await expect(
      callPlatformTool(
        'files_publish_version',
        { path: 'drugi.csv', originalFileId: original.id, operationId },
        { workspaceDir },
      ),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'operation_id_reused' } });

    // Nothing was written for the refused call, and nothing was invented for it.
    expect(h.platform.services.files.list(h.ownerId)).toHaveLength(afterFirst);

    // The identical call under the same key still replays, as it must.
    const replay = (await callPlatformTool(
      'files_publish_version',
      { path: 'pierwszy.csv', originalFileId: original.id, operationId },
      { workspaceDir },
    )) as { fileId: string };
    expect(replay.fileId).toBe(first.fileId);
    expect(h.platform.services.files.list(h.ownerId)).toHaveLength(afterFirst);

    /*
     * The same path, different bytes — the case the fields of the call cannot
     * see. A run that regenerates `output/pierwszy.csv` and republishes it is
     * the ordinary case, and a fingerprint over `path` and `originalFileId`
     * alone would answer it with the first version and call it a success.
     */
    writeFileSync(join(workspaceDir, 'output', 'pierwszy.csv'), 'a,b\n7,7\n');
    await expect(
      callPlatformTool(
        'files_publish_version',
        { path: 'pierwszy.csv', originalFileId: original.id, operationId },
        { workspaceDir },
      ),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'operation_id_reused' } });
    expect(h.platform.services.files.list(h.ownerId)).toHaveLength(afterFirst);

    // And the same, for the twin tool that publishes a workspace file as an artifact.
    const artifactOp = 'op-artefakt-z-pliku-1';
    writeFileSync(join(workspaceDir, 'output', 'zalacznik.csv'), 'x\n1\n');
    await callPlatformTool(
      'artifact_publish_file',
      { path: 'zalacznik.csv', title: 'Zalacznik', operationId: artifactOp },
      { workspaceDir },
    );
    writeFileSync(join(workspaceDir, 'output', 'zalacznik.csv'), 'x\n2\n');
    await expect(
      callPlatformTool(
        'artifact_publish_file',
        { path: 'zalacznik.csv', title: 'Zalacznik', operationId: artifactOp },
        { workspaceDir },
      ),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'operation_id_reused' } });
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

  it('awaria przy pierwszej wiadomosci nie zostawia rozmowy bez tej wiadomosci', () => {
    const before = h.platform.services.conversations.list(h.ownerId).length;
    vi.spyOn(h.platform.services.conversations, 'appendMessage').mockImplementation(() => {
      throw new Error('awaria zapisu pierwszej wiadomosci');
    });

    expect(() =>
      h.platform.services.conversations.create({
        ownerId: h.ownerId,
        firstMessage: { content: 'pierwsza wiadomosc' },
      }),
    ).toThrowError(/awaria zapisu pierwszej wiadomosci/);

    vi.restoreAllMocks();
    // A conversation titled after a message the history does not hold would be
    // a turn the user can see in the list and cannot open.
    expect(h.platform.services.conversations.list(h.ownerId)).toHaveLength(before);
  });

  it('awaria przy dotknieciu przestrzeni nie zostawia karty bez zmiany swiezosci przestrzeni', async () => {
    const space = h.platform.services.canvas.createSpace({ ownerId: h.ownerId, title: 'Atomowosc' });
    const spec = { kind: 'component' as const, component: 'platform.markdown', props: { markdown: 'a' } };
    const cardsBefore = h.platform.services.canvas.getState(space.id, h.ownerId).cards.length;

    // The failure lands between the card insert and the space touch, both of
    // which belong to one write.
    const prepare = h.platform.services.db.$client.prepare.bind(h.platform.services.db.$client);
    vi.spyOn(h.platform.services.db.$client, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('UPDATE canvas_spaces SET updated_at')) {
        throw new Error('awaria po zapisie karty');
      }
      return prepare(sql);
    }) as never);

    await expect(
      h.platform.services.canvas.addCard({ spaceId: space.id, title: 'K', spec }, h.ownerId),
    ).rejects.toThrowError(/awaria po zapisie karty/);

    vi.restoreAllMocks();
    expect(
      h.platform.services.canvas.getState(space.id, h.ownerId).cards.length,
      'karta przetrwala awarie w polowie zapisu',
    ).toBe(cardsBefore);
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
