import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext, ToolCallContext } from '@platform/contracts';
import { createHarness, caseCode, login, type Harness } from './helpers.ts';

const emptyContext: AppContext = {
  conversationId: null,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
};

const toolCtx = (h: Harness, over: Partial<ToolCallContext> = {}): ToolCallContext => ({
  ownerId: h.ownerId,
  appContext: emptyContext,
  conversationId: null,
  runId: null,
  workspaceDir: null,
  emit: () => {},
  ...over,
});

describe('kontrakty: walidacja, uprawnienia, konflikty, powtorzenia', () => {
  let h: Harness;
  let caseId: string;
  let cookie: string;
  let otherCookie: string;

  beforeAll(async () => {
    h = await createHarness();
    caseId = h.service.repo.findCaseByCode(caseCode, h.ownerId)!.id;
    cookie = await login(h.platform.app, h.ownerId);
    otherCookie = await login(h.platform.app, h.otherOwnerId);
  });
  afterAll(() => h.dispose());

  const firstItem = () => {
    const detail = h.service.getCaseDetail(caseId, h.ownerId);
    const offer = detail.offers.find((o) => o.supplierName.startsWith('AV Technika'))!;
    return { offer: offer.offer, item: offer.items[0]! };
  };

  /* ------------------------------ validation ----------------------------- */

  it('odrzuca wejscie narzedzia niezgodne ze schematem', async () => {
    await expect(
      h.platform.registry.callTool('procurement_get_case', { caseId: 123 }, toolCtx(h)),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('odrzuca ujemna cene regula domenowa, nie schematem', async () => {
    const { item } = firstItem();
    await expect(
      h.service.updateOfferItem({ itemId: item.id, unitPrice: -1 }, h.ownerId),
    ).rejects.toMatchObject({ code: 'domain_rule_violated' });
  });

  it('odrzuca nieznany komponent karty', () => {
    expect(() =>
      h.platform.services.catalog.validate({ kind: 'component', component: 'nie.istnieje', props: {} }),
    ).toThrowError(/Nieznany komponent/);
  });

  it('odrzuca nieprawidlowe wlasciwosci znanego komponentu', () => {
    expect(() =>
      h.platform.services.catalog.validate({
        kind: 'component',
        component: 'procurement.comparisonTable',
        props: { caseId: 42 },
      }),
    ).toThrowError(/Nieprawidlowe wlasciwosci/);
  });

  /* ------------------------------- access -------------------------------- */

  it('drugi uzytkownik nie widzi cudzej sprawy — mimo poprawnego identyfikatora', () => {
    expect(() => h.service.getCaseDetail(caseId, h.otherOwnerId)).toThrowError(/innego wlasciciela/);
  });

  it('identyfikator wlasciciela z ciala zadania nie daje dostepu', async () => {
    // The body claims to be the owner; the cookie says otherwise. The cookie wins.
    const res = await h.platform.app.request(`/api/m/procurement/cases/${caseId}`, {
      headers: { cookie: otherCookie, 'content-type': 'application/json' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  });

  it('bez sesji aplikacji zwraca 401', async () => {
    const res = await h.platform.app.request('/api/canvas/spaces');
    expect(res.status).toBe(401);
  });

  it('odrzuca zadanie z niedozwolonego origin', async () => {
    const res = await h.platform.app.request('/api/status', {
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('nie ujawnia sekretow w statusie', async () => {
    const res = await h.platform.app.request('/api/status', { headers: { cookie } });
    const text = await res.text();
    expect(text).not.toMatch(/sk-ant|accessToken|refreshToken|Bearer /i);
    const body = JSON.parse(text);
    expect(body.auth.apiKeyPolicy).toBe('refused');
    expect(Object.keys(body.auth)).not.toContain('token');
  });

  /* ------------------------------ conflicts ------------------------------ */

  it('nie nadpisuje nowszych danych przy nieaktualnej wersji', async () => {
    const { item } = firstItem();
    const stale = item.version;
    await h.service.updateOfferItem({ itemId: item.id, quantity: 3, expectedVersion: stale }, h.ownerId);
    await expect(
      h.service.updateOfferItem({ itemId: item.id, quantity: 9, expectedVersion: stale }, h.ownerId),
    ).rejects.toMatchObject({ code: 'conflict' });

    const after = h.service.repo.getItem(item.id, h.ownerId).item;
    expect(after.quantityMilli).toBe(3000); // the first write survived
  });

  it('konflikt kompozycji karty nie niszczy ostatniego poprawnego ukladu', async () => {
    const space = h.platform.services.canvas.createSpace({ ownerId: h.ownerId, title: 'T' });
    const card = await h.platform.services.canvas.addCard(
      {
        spaceId: space.id,
        title: 'Karta',
        spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'v1' } },
      },
      h.ownerId,
    );
    await h.platform.services.canvas.updateSpec(
      {
        cardId: card.id,
        spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'v2' } },
        expectedSpecVersion: card.specVersion,
      },
      h.ownerId,
    );
    await expect(
      h.platform.services.canvas.updateSpec(
        {
          cardId: card.id,
          spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'v3' } },
          expectedSpecVersion: card.specVersion,
        },
        h.ownerId,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });

    const state = h.platform.services.canvas.getState(space.id, h.ownerId);
    expect((state.cards[0]!.spec as any).props.markdown).toBe('v2');
  });

  it('zapis pozycji karty nie konkuruje z zapisem jej tresci', async () => {
    const space = h.platform.services.canvas.createSpace({ ownerId: h.ownerId, title: 'T2' });
    const card = await h.platform.services.canvas.addCard(
      {
        spaceId: space.id,
        title: 'Karta',
        spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'tresc' } },
      },
      h.ownerId,
    );
    // User drags the card...
    const moved = h.platform.services.canvas.updateGeometry(
      { cardId: card.id, geometry: { x: 400, y: 200 } },
      h.ownerId,
    );
    // ...while the agent, holding the spec version from before the drag, edits content.
    const edited = await h.platform.services.canvas.updateSpec(
      {
        cardId: card.id,
        spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'nowa tresc' } },
        expectedSpecVersion: card.specVersion,
      },
      h.ownerId,
    );
    expect(moved.geometry.x).toBe(400);
    expect(edited.geometry.x).toBe(400); // the drag survived the content edit
    expect((edited.spec as any).props.markdown).toBe('nowa tresc');
    expect(edited.specVersion).toBe(card.specVersion + 1);
    expect(edited.geometryVersion).toBe(card.geometryVersion + 1);
  });

  /* ----------------------------- idempotency ----------------------------- */

  it('powtorzona operacja z tym samym operationId nie dubluje skutku', async () => {
    const { item } = firstItem();
    const before = h.service.repo.getItem(item.id, h.ownerId).item;
    const op = `op-test-${Date.now()}`;

    const first = await h.service.updateOfferItem(
      { itemId: item.id, quantity: 7, operationId: op },
      h.ownerId,
    );
    const second = await h.service.updateOfferItem(
      { itemId: item.id, quantity: 7, operationId: op },
      h.ownerId,
    );

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    const after = h.service.repo.getItem(item.id, h.ownerId).item;
    // Exactly one version bump, not two.
    expect(after.version).toBe(before.version + 1);
    expect(after.quantityMilli).toBe(7000);
  });

  it('powtorzona wiadomosc o tym samym id nie tworzy drugiego wpisu', () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, title: 'T' });
    h.platform.services.conversations.appendMessage(conv.id, h.ownerId, {
      id: 'msg-1',
      role: 'user',
      content: 'czesc',
    });
    h.platform.services.conversations.appendMessage(conv.id, h.ownerId, {
      id: 'msg-1',
      role: 'user',
      content: 'czesc',
    });
    expect(h.platform.services.conversations.messages(conv.id, h.ownerId)).toHaveLength(1);
  });

  it('dodanie karty z tym samym operationId nie tworzy dwoch kart', async () => {
    const space = h.platform.services.canvas.createSpace({ ownerId: h.ownerId, title: 'T3' });
    const op = `op-card-${Date.now()}`;
    const spec = { kind: 'component' as const, component: 'platform.markdown', props: { markdown: 'x' } };
    const a = await h.platform.services.canvas.addCard(
      { spaceId: space.id, title: 'K', spec, operationId: op },
      h.ownerId,
    );
    const b = await h.platform.services.canvas.addCard(
      { spaceId: space.id, title: 'K', spec, operationId: op },
      h.ownerId,
    );
    expect(a.id).toBe(b.id);
    expect(h.platform.services.canvas.getState(space.id, h.ownerId).cards).toHaveLength(1);
  });

  /* ------------------ same rules through HTTP and through MCP ------------- */

  it('narzedzie MCP i endpoint HTTP prowadza do tej samej reguly', async () => {
    const { item } = firstItem();

    // MCP path
    await expect(
      h.platform.registry.callTool(
        'procurement_update_offer_item',
        { itemId: item.id, unitPrice: -5 },
        toolCtx(h),
      ),
    ).rejects.toMatchObject({ code: 'domain_rule_violated' });

    // HTTP path
    const res = await h.platform.app.request(`/api/m/procurement/items/${item.id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ unitPrice: -5 }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('domain_rule_violated');
  });

  it('porownanie z HTTP i z MCP daje identyczne sumy', async () => {
    const viaHttp = await (
      await h.platform.app.request(`/api/m/procurement/cases/${caseId}/comparison`, {
        headers: { cookie },
      })
    ).json();
    const viaMcp = (await h.platform.registry.callTool(
      'procurement_compare_offers',
      { caseId },
      toolCtx(h),
    )) as any;

    const totals = (r: any) => r.rows.map((x: any) => [x.supplierName, x.totalMinor]).sort();
    expect(totals(viaMcp)).toEqual(totals(viaHttp));
  });

  /* -------------------------- relation traversal ------------------------- */

  it('agent przechodzi po relacjach do zrodla ceny', async () => {
    const detail = h.service.getCaseDetail(caseId, h.ownerId);
    const mediapro = detail.offers.find((o) => o.supplierName.startsWith('MediaPro'))!;
    const projector = mediapro.items.find((i) => i.name.includes('Projektor'))!;

    const result = (await h.platform.registry.callTool(
      'procurement_find_price_provenance',
      { itemId: projector.id },
      toolCtx(h),
    )) as any;

    expect(result.supplier.name).toContain('MediaPro');
    expect(result.offer.reference).toBe('MP-2026-0442');
    expect(result.provenance).toHaveLength(1);
    expect(result.provenance[0].locator).toMatch(/wiersz \d+/);
    expect(result.provenance[0].file.filename).toMatch(/\.csv$/);

    // The referenced file really exists in the managed store and contains the price.
    const csv = h.platform.services.files.read(result.provenance[0].file.id, h.ownerId);
    expect(csv.bytes.toString('utf8')).toContain('13100.00');
  });

  it('wyszukiwanie znajduje rekordy po fragmencie nazwy', async () => {
    const res = (await h.platform.registry.callTool(
      'procurement_search',
      { query: 'projektor', limit: 10 },
      toolCtx(h),
    )) as any;
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.every((r: any) => r.label.toLowerCase().includes('projektor'))).toBe(true);
  });

  /* ------------------------------ persistence ---------------------------- */

  it('artefakt-snapshot zachowuje tresc mimo pozniejszej zmiany danych', async () => {
    const saved = (await h.platform.registry.callTool(
      'procurement_save_comparison',
      { caseId },
      toolCtx(h),
    )) as any;

    const before = h.platform.services.artifacts.version(saved.artifactId, h.ownerId);
    const frozenTotals = (before.content as any).rows.map((r: any) => r.totalMinor);

    // Change the underlying data.
    const { item } = firstItem();
    await h.service.updateOfferItem({ itemId: item.id, unitPrice: 1 }, h.ownerId);

    const after = h.platform.services.artifacts.version(saved.artifactId, h.ownerId);
    expect((after.content as any).rows.map((r: any) => r.totalMinor)).toEqual(frozenTotals);

    // A live read reflects the change.
    const fresh = h.service.compare(caseId, h.ownerId);
    expect(fresh.rows.map((r) => r.totalMinor)).not.toEqual(frozenTotals);
  });

  it('plik przetrwa restart procesu backendu', async () => {
    const files = h.platform.services.files.list(h.ownerId);
    expect(files.length).toBeGreaterThan(0);
    const target = files[0]!;
    const contentBefore = h.platform.services.files.read(target.id, h.ownerId).bytes.toString('utf8');

    // Re-open the same database and file store, as a restart would.
    const { createPlatform } = await import('@platform/server');
    const { createProcurementModule } = await import('@module/procurement/server');
    const restarted = createPlatform({
      modules: (s) => [createProcurementModule(s)],
      env: { ...process.env, APP_DATA_DIR: h.dataDir },
    });
    const contentAfter = restarted.services.files.read(target.id, h.ownerId).bytes.toString('utf8');
    expect(contentAfter).toBe(contentBefore);
    expect(restarted.services.artifacts.list(h.ownerId).length).toBeGreaterThan(0);
    restarted.close();
  });
});
