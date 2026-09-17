import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENT_VIEWS_SCOPE_KIND,
  AppError,
  PLATFORM_CUSTOM_EVENTS,
  type ModuleEmittedEvent,
  type ServerModule,
  type ToolCallContext,
} from '@platform/contracts';
import {
  ServerModuleRegistry,
  buildSystemPrompt,
  checkComposition,
  collectToolEntries,
  createPlatform,
  findDataInstances,
  invokeTool,
  platformTools,
  type CompositionMode,
  type CompositionRefusal,
} from '@platform/server';
import { createProcurementModule } from '@module/procurement/server';
import { createHarness, login, type Harness } from './helpers.ts';

/**
 * Agent views: server-side validation of OpenUI compositions, the tools that
 * write a conversation's views, and the space's life cycle.
 *
 * Test kontraktu lub logiki. Compositions are checked by the real parser
 * against the real registry (the example module's reads and descriptors); the
 * tools run through `invokeTool` — the same validation and error mapping the
 * MCP server applies — with a run context built the way the runtime builds it.
 */

let h: Harness;
let cookie: string;
let otherCookie: string;
let caseId: string;

beforeAll(async () => {
  h = await createHarness();
  cookie = await login(h.platform.app, h.ownerId);
  otherCookie = await login(h.platform.app, h.otherOwnerId);
  caseId = h.service.listCases(h.ownerId)[0]!.id;
});
afterAll(() => h.dispose());

const api = async (path: string, init: RequestInit & { as?: string } = {}) => {
  const res = await h.platform.app.request(path, {
    ...init,
    headers: { 'content-type': 'application/json', cookie: init.as ?? cookie },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

const comparison = () => `{operation: "procurement.comparison", input: {caseId: "${caseId}"}}`;

function check(source: string, mode: CompositionMode = 'agent-views', extra: { params?: string[]; primaryOperation?: string } = {}) {
  return checkComposition({
    source,
    mode,
    catalog: h.platform.services.catalog.openui,
    reads: h.platform.registry,
    ...extra,
  });
}

const reasons = (source: string, mode: CompositionMode = 'agent-views') =>
  check(source, mode).problems.map((p) => p.reason);

function expectRefused(source: string, reason: CompositionRefusal, text: RegExp, mode: CompositionMode = 'agent-views') {
  const { problems } = check(source, mode);
  expect(problems.map((p) => p.reason), JSON.stringify(problems)).toContain(reason);
  expect(problems.find((p) => p.reason === reason)!.message).toMatch(text);
}

/* -------------------------------------------------------------------------- */

describe('walidator kompozycji OpenUI', () => {
  it('przyjmuje tabele i wykres na zarejestrowanych odczytach, w ukladzie z tekstem', () => {
    const source = [
      'root = Stack([opis, tabela, wykres])',
      'opis = TextContent("Oferty w sprawie")',
      `tabela = DataTable(${comparison()}, ["supplierName", "totalMinor", "currency"], "Oferty", null, [{field: "currency", op: "eq", value: "PLN"}], {field: "totalMinor", direction: "asc"}, "priceBasis")`,
      `wykres = DataChart(${comparison()}, "bar", "supplierName", ["totalMinor"], "Suma")`,
    ].join('\n');
    const result = check(source);
    expect(result.problems).toEqual([]);
    expect(result.instances.map((i) => [i.component, i.statementId])).toEqual([
      ['DataTable', 'tabela'],
      ['DataChart', 'wykres'],
    ]);
    const table = result.instances[0]!;
    expect(table.component === 'DataTable' && table.props.groupBy).toBe('priceBasis');
    // `null` skips a positional argument: it is "not given", not a value.
    expect(table.component === 'DataTable' && 'pageSize' in table.props).toBe(false);
  });

  it('nieznany komponent jest zawsze odrzucany z nazwa', () => {
    for (const mode of ['catalog', 'agent-views'] as const) {
      expectRefused('root = Stack([x])\nx = Wykresik("a")', 'unknown_component', /nieznany komponent Wykresik/, mode);
    }
  });

  it('blad skladni, zrodlo czesciowe, brak root, powtorzona instrukcja, odwolanie bez definicji i instrukcja osierocona', () => {
    expectRefused('root = Stack([t])\nt = TextContent("a")\nto nie jest instrukcja', 'syntax', /Nie rozpoznano instrukcji "to nie jest instrukcja"/);
    expectRefused(`root = Stack([t])\nt = DataTable(${comparison()}, ["supplierName"`, 'partial', /niekompletna/);
    expectRefused('t = TextContent("a")', 'missing_root', /root = /);
    expectRefused('root = Stack([t])\nt = TextContent("a")\nt = TextContent("b")', 'duplicate_statement', /t jest zdefiniowana 2 razy/);
    expectRefused('root = Stack([t, brak])\nt = TextContent("a")', 'unresolved_reference', /brak/);
    expectRefused('root = Stack([t])\nt = TextContent("a")\nzbedna = TextContent("b")', 'orphaned_statement', /zbedna nie jest osiagalna/);
    expect(reasons('   ')).toEqual(['empty']);
  });

  it('nieprawidlowe wlasciwosci komponentu sa odrzucane', () => {
    expectRefused('root = Stack([t])\nt = TextContent(5)', 'invalid_props', /expects string/);
    expectRefused(`root = DataChart(${comparison()}, "pie", "supplierName", ["totalMinor", "score"])`, 'invalid_props', /dokladnie jedna serie/);
  });

  it('niezarejestrowana operacja i wejscie niezgodne ze schematem sa odrzucane', () => {
    expectRefused('root = DataTable({operation: "procurement.nie_ma"})', 'unknown_operation', /Nieznana operacja odczytu "procurement.nie_ma"/);
    expectRefused('root = DataTable({operation: "procurement.comparison", input: {caseId: 7}})', 'invalid_input', /caseId/);
    expectRefused('root = DataTable({operation: "procurement.comparison"})', 'invalid_input', /caseId/);
  });

  it('kazde pole spoza deskryptora jest odrzucane z nazwa — kolumny, x, series, fields, filtr, porzadek, grupowanie', () => {
    const t = (args: string) => `root = DataTable(${comparison()}, ${args})`;
    expectRefused(t('["supplierName", "cena"]'), 'undeclared_field', /columns: Pola cena nie sa zadeklarowane/);
    expectRefused(t('null, null, null, [{field: "kraj", op: "eq", value: "PL"}]'), 'undeclared_field', /filter: Pola kraj/);
    expectRefused(t('null, null, null, null, {field: "wartosc", direction: "asc"}'), 'undeclared_field', /sort: Pola wartosc/);
    expectRefused(t('null, null, null, null, null, "grupa"'), 'undeclared_field', /groupBy: Pola grupa/);
    expectRefused(`root = DataChart(${comparison()}, "bar", "dostawca", ["totalMinor"])`, 'undeclared_field', /x: Pola dostawca/);
    expectRefused(`root = DataChart(${comparison()}, "bar", "supplierName", ["suma"])`, 'undeclared_field', /series: Pola suma/);
    expectRefused(
      `root = DataSummary({operation: "procurement.case_overview", input: {caseId: "${caseId}"}}, ["name", "ilosc"])`,
      'undeclared_field',
      /fields: Pola ilosc/,
    );
  });

  it('seria wykresu musi byc polem liczbowym', () => {
    expectRefused(`root = DataChart(${comparison()}, "bar", "supplierName", ["reference"])`, 'non_numeric_series', /reference \(text\)/);
  });

  it('tryb widokow agenta: tylko komponenty danych, modulow i jawna lista ukladu/tekstu', () => {
    // Literal numbers in a ready-made chart or table: fine on an ordinary card, never in an agent's view.
    const literalChart = 'root = BarChart(["A", "B"], [Series("Suma", [100, 200])])';
    expect(reasons(literalChart, 'catalog')).toEqual([]);
    expectRefused(literalChart, 'component_not_allowed', /BarChart nie jest dozwolony w widokach agenta/);
    expectRefused('root = Table([Col("Suma", [1, 2])])', 'component_not_allowed', /Table/);
    // A module component reading its own data is allowed; so is layout and text.
    expect(reasons(`root = Stack([h, OfferCostChart("${caseId}")])\nh = CardHeader("Koszty")`)).toEqual([]);
    // Expressions, state and Query/Mutation are not.
    expectRefused('root = Stack([t])\nt = TextContent("" + @Count([1, 2]))', 'dynamic_expression', /wyrazen/);
    expectRefused('$wybor = "a"\nroot = Stack([t])\nt = TextContent("x")', 'dynamic_expression', /stanu/);
    expectRefused('root = Stack([t])\nq = Query("narzedzie", {})\nt = TextContent("x")', 'forbidden_reference', /Query\/Mutation/, 'catalog');
  });

  it('parametr widoku w wejsciu zrodla jest dozwolony tylko w widoku, ktory go deklaruje', () => {
    const source = 'root = DataSummary({operation: "procurement.case_overview", input: {caseId: $caseId}}, ["name"])';
    expect(check(source, 'catalog', { params: ['caseId'] }).problems).toEqual([]);
    expect(check(source, 'catalog').problems.map((p) => p.reason)).toEqual(['dynamic_expression']);
    expect(check(source, 'agent-views', { params: ['caseId'] }).problems.map((p) => p.reason)).toContain('dynamic_expression');
    // A parameter the operation does not take is refused like any other input.
    expect(
      check('root = DataSummary({operation: "procurement.case_overview", input: {caseId: "x", sprawa: $caseId}}, ["name"])', 'catalog', {
        params: ['caseId'],
      }).problems.map((p) => p.reason),
    ).toEqual(['invalid_input']);
  });

  it('findDataInstances zwraca instancje komponentow danych z ich wlasciwosciami', () => {
    const found = findDataInstances(
      [
        'root = Tabs([TabItem("a", "Tabela", [tabela]), TabItem("b", "Wykres", [wykres])])',
        `tabela = DataTable(${comparison()}, ["supplierName", "totalMinor"])`,
        `wykres = DataChart(${comparison()}, "line", "supplierName", ["score"])`,
      ].join('\n'),
    );
    expect(found.map((f) => [f.component, f.statementId])).toEqual([
      ['DataTable', 'tabela'],
      ['DataChart', 'wykres'],
    ]);
    expect(found[1]!.props.source).toEqual({ operation: 'procurement.comparison', input: { caseId } });
  });
});

/* -------------------------------------------------------------------------- */

describe('walidacja przy zapisie kart i przy starcie', () => {
  it('karta openui z nieznanym komponentem nie jest zapisana, a poprzednia tresc zostaje', async () => {
    const space = h.platform.services.canvas.createSpace({ ownerId: h.ownerId, title: 'walidacja kart' });
    const created = await api('/api/canvas/cards', {
      method: 'POST',
      body: JSON.stringify({ spaceId: space.id, title: 'ok', spec: { kind: 'openui', source: 'root = TextContent("a")' } }),
    });
    expect(created.status).toBe(201);

    const refused = await api(`/api/canvas/cards/${created.body.id}/spec`, {
      method: 'PATCH',
      body: JSON.stringify({ spec: { kind: 'openui', source: 'root = Nieznany("a")' } }),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.reason).toBe('unknown_component');
    const card = h.platform.services.canvas.getCard(created.body.id, h.ownerId);
    expect(card.spec).toEqual({ kind: 'openui', source: 'root = TextContent("a")' });
    expect(card.specVersion).toBe(1);

    const unknownRead = await api('/api/canvas/cards', {
      method: 'POST',
      body: JSON.stringify({
        spaceId: space.id,
        title: 'zla operacja',
        spec: { kind: 'openui', source: 'root = DataTable({operation: "nie.istnieje"})' },
      }),
    });
    expect(unknownRead.status).toBe(400);
    expect(unknownRead.body.error.details.reason).toBe('unknown_operation');
  });

  const withView = (composition: string, extra: Partial<ServerModule> = {}) => (services: any) => {
    const mod = createProcurementModule(services);
    return [
      {
        ...mod,
        views: [{ ...mod.views![0]!, composition }, mod.views![1]!],
        ...extra,
      },
    ];
  };

  it('widok modulu z nieznanym komponentem zatrzymuje start z nazwa modulu, widoku i komponentu', () => {
    expect(() =>
      createPlatform({
        modules: withView('root = Stack([x])\nx = Tabelka("a")'),
        env: { ...process.env, APP_DATA_DIR: h.dataDir },
      }),
    ).toThrowError(/Modul procurement, widok procurement\.data: Kompozycja OpenUI odrzucona: Instrukcja x: nieznany komponent Tabelka/);
  });

  it('widok modulu musi zawierac DataTable na swojej primaryOperation i tylko zadeklarowane pola', () => {
    const registry = () => new ServerModuleRegistry();
    const mod = createProcurementModule(h.platform.services);
    const view = mod.views![0]!;
    expect(() =>
      registry().register({ ...mod, views: [{ ...view, composition: 'root = TextContent("bez tabeli")' }] }),
    ).toThrowError(/widok procurement\.data: .*zaden DataTable w kompozycji jej nie czyta/);
    expect(() =>
      registry().register({
        ...mod,
        views: [{ ...view, composition: 'root = DataTable({operation: "procurement.suppliers"}, ["name", "miasto"])' }],
      }),
    ).toThrowError(/widok procurement\.data: .*Pola miasto nie sa zadeklarowane/);
    // The example module itself starts.
    expect(() => registry().register(mod)).not.toThrow();
  });

  it('komponent modulu o zajetej nazwie jest odrzucany przy rejestracji', () => {
    const mod = createProcurementModule(h.platform.services);
    expect(() =>
      new ServerModuleRegistry().register({
        ...mod,
        openuiComponents: [{ name: 'DataTable', description: 'x', propsSchema: mod.openuiComponents![0]!.propsSchema }],
      }),
    ).toThrowError(/Konflikt katalogu: komponent OpenUI "DataTable"/);
  });
});

/* -------------------------------------------------------------------------- */

describe('narzedzia widokow agenta', () => {
  const tools = () =>
    collectToolEntries({ registry: h.platform.registry, platformTools: platformTools(h.platform.services) });

  function context(conversationId: string | null, ownerId = h.ownerId, emitted: ModuleEmittedEvent[] = []): ToolCallContext {
    return {
      ownerId,
      conversationId,
      runId: 'run_test',
      workspaceDir: null,
      emit: (e) => emitted.push(e),
      appContext: {
        conversationId,
        // Deliberately a different, working space: the tools must not use it.
        spaceId: h.platform.services.canvas.createSpace({ ownerId, title: 'robocza' }).id,
        resource: null,
        selection: [],
        filters: {},
        viewport: null,
        drafts: [],
      },
    };
  }

  async function call(name: string, input: unknown, ctx: ToolCallContext) {
    const entry = tools().find((t) => t.localName === name)!;
    expect(entry, name).toBeTruthy();
    const out = await invokeTool(entry, input, ctx);
    const body = JSON.parse(out.content[0]!.text);
    return { ok: !out.isError, body };
  }

  const newConversation = (ownerId = h.ownerId) =>
    h.platform.services.conversations.create({ ownerId, firstMessage: { content: 'widoki' } });

  it('tworzenie widoku zapisuje karte openui w przestrzeni rozmowy wykonania i emituje canvas_changed', async () => {
    const conv = newConversation();
    const emitted: ModuleEmittedEvent[] = [];
    const ctx = context(conv.id, h.ownerId, emitted);
    const before = await call('agent_views_list', {}, ctx);
    expect(before.body).toEqual({ conversationId: conv.id, spaceId: null, views: [] });

    const created = await call(
      'agent_view_create',
      { title: 'Oferty', source: `root = DataTable(${comparison()}, ["supplierName", "totalMinor"])` },
      ctx,
    );
    expect(created.ok, JSON.stringify(created.body)).toBe(true);
    const space = h.platform.services.canvas.findScopedSpace(h.ownerId, AGENT_VIEWS_SCOPE_KIND, conv.id)!;
    expect(space.id).toBe(created.body.spaceId);
    expect(space.id).not.toBe(ctx.appContext.spaceId);
    expect(h.platform.services.canvas.getState(space.id, h.ownerId).cards.map((c) => c.id)).toEqual([created.body.cardId]);
    expect(emitted).toEqual([{ type: 'canvas_changed', spaceId: space.id }]);
    expect(h.platform.services.canvas.getState(ctx.appContext.spaceId!, h.ownerId).cards).toEqual([]);

    const list = await call('agent_views_list', {}, ctx);
    expect(list.body.views).toEqual([
      expect.objectContaining({ cardId: created.body.cardId, title: 'Oferty', specVersion: 1 }),
    ]);
  });

  it('patch zmienia tylko wskazana instrukcje, a pozostale instrukcje, geometria i inne widoki zostaja', async () => {
    const conv = newConversation();
    const ctx = context(conv.id);
    const source = [
      'root = Stack([opis, tabela])',
      'opis = TextContent("Oferty w sprawie")',
      `tabela = DataTable(${comparison()}, ["supplierName", "totalMinor", "priceBasis"])`,
    ].join('\n');
    const first = await call('agent_view_create', { title: 'Tabela', source }, ctx);
    const second = await call(
      'agent_view_create',
      { title: 'Wykres', source: `root = DataChart(${comparison()}, "bar", "supplierName", ["totalMinor"])` },
      ctx,
    );
    // The user moves the first card.
    h.platform.services.canvas.updateGeometry({ cardId: first.body.cardId, geometry: { x: 900, y: 40 } }, h.ownerId);
    const otherBefore = h.platform.services.canvas.getCard(second.body.cardId, h.ownerId);

    const patched = await call(
      'agent_view_update',
      {
        cardId: first.body.cardId,
        patch: `tabela = DataTable(${comparison()}, ["supplierName", "totalMinor", "priceBasis"], null, null, null, null, "priceBasis")`,
        expectedSpecVersion: 1,
      },
      ctx,
    );
    expect(patched.ok, JSON.stringify(patched.body)).toBe(true);
    expect(patched.body.specVersion).toBe(2);

    const after = h.platform.services.canvas.getCard(first.body.cardId, h.ownerId);
    const lines = (after.spec as { source: string }).source.split('\n');
    expect(lines[0]).toBe('root = Stack([opis, tabela])');
    expect(lines[1]).toBe('opis = TextContent("Oferty w sprawie")');
    expect(lines[2]).toContain('"priceBasis")');
    expect(after.geometry).toMatchObject({ x: 900, y: 40 });
    expect(h.platform.services.canvas.getCard(second.body.cardId, h.ownerId)).toEqual(otherBefore);

    // Chart kind switched by a patch of the root statement.
    const kind = await call(
      'agent_view_update',
      { cardId: second.body.cardId, patch: `root = DataChart(${comparison()}, "line", "supplierName", ["totalMinor"])` },
      ctx,
    );
    expect(kind.ok).toBe(true);
    expect(findDataInstances(kind.body.source)[0]!.props).toMatchObject({ kind: 'line' });

    // A stale version is a conflict, not an overwrite.
    const stale = await call('agent_view_update', { cardId: first.body.cardId, title: 'x', expectedSpecVersion: 1 }, ctx);
    expect(stale.body.error).toBe('conflict');
  });

  it('niepoprawny patch lub zrodlo jest odrzucane, a widok zostaje w poprzedniej wersji', async () => {
    const conv = newConversation();
    const ctx = context(conv.id);
    const source = `root = Stack([tabela])\ntabela = DataTable(${comparison()}, ["supplierName"])`;
    const created = await call('agent_view_create', { title: 'T', source }, ctx);
    const attempts = [
      { patch: 'tabela = Nieznany("x")', reason: 'unknown_component' },
      { patch: 'tabela = BarChart(["A"], [Series("S", [1])])', reason: 'component_not_allowed' },
      { patch: 'tabela = DataTable({operation: "procurement.brak"})', reason: 'unknown_operation' },
      { patch: `tabela = DataTable(${comparison()}, ["supplierName"`, reason: 'partial' },
      { source: 'root = Table([Col("Suma", [100, 200])])', reason: 'component_not_allowed' },
    ];
    for (const attempt of attempts) {
      const { reason, ...input } = attempt;
      const out = await call('agent_view_update', { cardId: created.body.cardId, ...input }, ctx);
      expect(out.ok, reason).toBe(false);
      expect(out.body.error).toBe('validation_failed');
      expect(out.body.details.reason).toBe(reason);
    }
    const card = h.platform.services.canvas.getCard(created.body.cardId, h.ownerId);
    expect(card.spec).toEqual({ kind: 'openui', source });
    expect(card.specVersion).toBe(1);

    const literal = await call('agent_view_create', { title: 'Liczby', source: 'root = BarChart(["A"], [Series("S", [1])])' }, ctx);
    expect(literal.body.details.reason).toBe('component_not_allowed');
    expect(h.platform.services.canvas.getState(created.body.spaceId, h.ownerId).cards).toHaveLength(1);
  });

  it('widok innej rozmowy lub innego wlasciciela jest odrzucany; bez rozmowy nie ma widokow', async () => {
    const a = newConversation();
    const b = newConversation();
    const created = await call('agent_view_create', { title: 'A', source: `root = DataTable(${comparison()})` }, context(a.id));
    const fromB = context(b.id);
    for (const [name, input] of [
      ['agent_view_update', { cardId: created.body.cardId, title: 'przejete' }],
      ['agent_view_remove', { cardId: created.body.cardId }],
    ] as const) {
      const out = await call(name, input, fromB);
      expect(out.body.error, name).toBe('forbidden');
      expect(out.body.message).toMatch(/nie jest widokiem agenta tej rozmowy/);
    }
    expect((await call('agent_views_list', {}, fromB)).body.views).toEqual([]);

    const otherOwner = await call('agent_view_update', { cardId: created.body.cardId, title: 'obcy' }, context(newConversation(h.otherOwnerId).id, h.otherOwnerId));
    expect(otherOwner.body.error).toBe('forbidden');
    // Someone else's conversation id does not help either.
    expect((await call('agent_views_list', {}, context(a.id, h.otherOwnerId))).body.error).toBe('forbidden');

    expect((await call('agent_view_create', { title: 'x', source: 'root = TextContent("a")' }, context(null))).body.error).toBe(
      'precondition_failed',
    );
    expect(h.platform.services.canvas.getCard(created.body.cardId, h.ownerId).title).toBe('A');
  });

  it('ogolne narzedzia canvasu i API nie omijaja reguly widokow agenta', async () => {
    const conv = newConversation();
    const ctx = context(conv.id);
    const created = await call('agent_view_create', { title: 'T', source: `root = DataTable(${comparison()})` }, ctx);
    const literal = { kind: 'openui', source: 'root = Table([Col("Suma", [1, 2])])' };

    const viaTool = await call('canvas_update_card', { cardId: created.body.cardId, spec: literal }, ctx);
    expect(viaTool.body.details.reason).toBe('component_not_allowed');
    const viaAdd = await call('canvas_add_card', { spaceId: created.body.spaceId, title: 'x', spec: literal }, ctx);
    expect(viaAdd.body.details.reason).toBe('component_not_allowed');
    const viaHttp = await api(`/api/canvas/cards/${created.body.cardId}/spec`, {
      method: 'PATCH',
      body: JSON.stringify({ spec: literal }),
    });
    expect(viaHttp.status).toBe(400);
    expect(viaHttp.body.error.details.reason).toBe('component_not_allowed');
  });

  it('usuniecie rozmowy usuwa jej przestrzen widokow i karty, bez osieroconych rekordow', async () => {
    const conv = newConversation();
    const ctx = context(conv.id);
    const one = await call('agent_view_create', { title: '1', source: `root = DataTable(${comparison()})` }, ctx);
    await call('agent_view_create', { title: '2', source: `root = DataChart(${comparison()}, "bar", "supplierName", ["score"])` }, ctx);
    const count = (sql: string, ...args: unknown[]) =>
      (h.platform.db.$client.prepare(sql).get(...args) as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM canvas_cards WHERE space_id = ?', one.body.spaceId)).toBe(2);

    const res = await api(`/api/threads/delete/${conv.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body.removedViewSpaces).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM canvas_spaces WHERE id = ?', one.body.spaceId)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM canvas_cards WHERE space_id = ?', one.body.spaceId)).toBe(0);
    expect(
      count(
        'SELECT COUNT(*) AS n FROM canvas_spaces s WHERE s.scope_kind = ? AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = s.scope_id)',
        AGENT_VIEWS_SCOPE_KIND,
      ),
    ).toBe(0);
  });

  it('GET /api/conversations/:id/agent-views: brak przestrzeni, karty po utworzeniu, obcy wlasciciel odrzucony', async () => {
    const conv = newConversation();
    const empty = await api(`/api/conversations/${conv.id}/agent-views`);
    expect(empty.body).toEqual({ conversationId: conv.id, space: null, cards: [] });
    // Reading never creates the space.
    expect(h.platform.services.canvas.findScopedSpace(h.ownerId, AGENT_VIEWS_SCOPE_KIND, conv.id)).toBeNull();

    const created = await call('agent_view_create', { title: 'T', source: `root = DataTable(${comparison()})` }, context(conv.id));
    const full = await api(`/api/conversations/${conv.id}/agent-views`);
    expect(full.body.space.id).toBe(created.body.spaceId);
    expect(full.body.cards.map((c: { id: string }) => c.id)).toEqual([created.body.cardId]);

    const foreign = await api(`/api/conversations/${conv.id}/agent-views`, { as: otherCookie });
    expect(foreign.status).toBe(403);
    expect(JSON.stringify(foreign.body)).not.toContain(created.body.cardId);
  });

  it('schematy wejscia narzedzi sa zgodne z MCP, a prompt opisuje widoki agenta sygnaturami z katalogu', () => {
    const prompt = buildSystemPrompt({
      registry: h.platform.registry,
      catalog: h.platform.services.catalog,
      appContext: { conversationId: null, spaceId: null, resource: null, selection: [], filters: {}, viewport: null, drafts: [] },
      resourceSummary: null,
      workspaceDir: null,
      stagedFiles: [],
      toolkit: [],
    });
    expect(prompt).toContain('# Widoki agenta');
    expect(prompt).toContain('- DataTable(source, columns?, title?, pageSize?, filter?, sort?, groupBy?)');
    expect(prompt).toContain('- DataChart(source, kind, x, series, title?, filter?, sort?)');
    expect(prompt).toContain('- OfferCostChart(caseId)');
    expect(prompt).toContain('mcp__app__agent_view_update');
    expect(prompt).toMatch(/NIGDY nie wpisuj do kompozycji liczb/);
    expect(prompt).toMatch(/Nie przelaczaj ekranu uzytkownika do Widokow agenta z wlasnej inicjatywy/);
    expect(prompt).toMatch(/powiedz to wprost/);
    expect(PLATFORM_CUSTOM_EVENTS.canvasChanged).toBeTruthy();
    expect(AppError).toBeTruthy();
  });
});
