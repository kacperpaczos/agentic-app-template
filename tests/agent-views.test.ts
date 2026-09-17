import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_VIEWS_SCOPE_KIND,
  AGUI_EVENTS,
  type ModuleEmittedEvent,
  type ServerModule,
  type ToolCallContext,
} from '@platform/contracts';
import {
  AGENT_VIEW_LAYOUT_COMPONENTS,
  AgentRuntime,
  ServerModuleRegistry,
  assertMcpCompatibleShape,
  buildMcpServer,
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
import { scriptedAgent } from '../e2e/support/scripted-agent.ts';
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

  it('null pomija opcjonalny argument pozycyjny, a zly typ i null wymaganego argumentu sa nadal odrzucane', () => {
    const suppliers = '{operation: "procurement.suppliers"}';
    // `null` before a present argument, as the renderer reads it: not given.
    for (const mode of ['catalog', 'agent-views'] as const) {
      const ok = check(`root = DataTable(${suppliers}, ["name", "country"], null, 10)`, mode);
      expect(ok.problems, mode).toEqual([]);
      expect(ok.instances[0]!.props).toEqual({ source: { operation: 'procurement.suppliers' }, columns: ['name', 'country'], pageSize: 10 });
      expect(check(`root = DataTable(${suppliers}, null, null, null, null, {field: "name", direction: "asc"}, "country")`, mode).problems).toEqual([]);
    }
    // The same positions with a value of the wrong type are refused.
    expect(reasons(`root = DataTable(${suppliers}, ["name"], null, "dziesiec")`, 'catalog')).toContain('invalid_props');
    expect(reasons(`root = DataTable(${suppliers}, ["name"], null, 0)`, 'catalog')).toContain('invalid_props');
    expect(reasons(`root = DataTable(${suppliers}, null, 5)`, 'catalog')).toContain('invalid_props');
    // A required argument cannot be skipped.
    expect(reasons('root = DataTable(null, ["name"])', 'catalog')).toContain('invalid_props');
    expect(reasons(`root = DataChart({operation: "procurement.comparison", input: {caseId: "${caseId}"}}, null, "supplierName", ["totalMinor"])`, 'catalog')).toContain('invalid_props');

    // And a module view written that way starts.
    const mod = createProcurementModule(h.platform.services);
    const view = mod.views![0]!;
    expect(() =>
      new ServerModuleRegistry().register({
        ...mod,
        views: [{ ...view, composition: `root = Stack([t])\nt = DataTable(${suppliers}, ["name", "country"], null, 10, null, {field: "name", direction: "asc"})` }, mod.views![1]!],
      }),
    ).not.toThrow();
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

  it('porzadek kompozycji tylko po polu sortowalnym — ta sama regula co komponent', () => {
    expectRefused(
      'root = DataTable({operation: "procurement.suppliers"}, null, null, null, null, {field: "contactEmail", direction: "asc"})',
      'unsortable_field',
      /sort: pole contactEmail jest oznaczone jako niesortowalne/,
      'catalog',
    );
    expect(reasons('root = DataTable({operation: "procurement.suppliers"}, null, null, null, null, {field: "name", direction: "asc"})')).toEqual([]);
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
    // No component whose text can carry lists of values or load outside resources.
    expectRefused(
      'root = MarkDownRenderer("- Dostawca A: 12 345,00 PLN\\n- Dostawca B: 9 870,00 PLN\\n![x](https://example.com/p.png)")',
      'component_not_allowed',
      /MarkDownRenderer nie jest dozwolony w widokach agenta/,
    );
    expect(Object.keys(AGENT_VIEW_LAYOUT_COMPONENTS).sort()).toEqual(
      ['Accordion', 'AccordionItem', 'Card', 'CardHeader', 'Separator', 'Stack', 'TabItem', 'Tabs', 'TextCallout', 'TextContent'].sort(),
    );
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
        ui: null,
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

  /*
   * From `run_96c52b19607e4a21a589`: the tool answered success for a chart the
   * component then refused to draw ("laczy rozne jednostki (PLN, EUR)"), and
   * the model told the user the chart was in the view. The answer now says what
   * it is an answer about — the composition was stored, not drawn — and warns
   * where drawing is the only place the question can be settled.
   */
  it('wynik mowi, ze kompozycja jest ZAPISANA a nie narysowana, i ostrzega o serii z jednostka z rekordu', async () => {
    const conv = newConversation();
    const ctx = context(conv.id);

    // A money series whose unit is a property of each record: uniformity is a
    // fact about the rows at drawing time, so it is warned about, not refused.
    const money = await call(
      'agent_view_create',
      { title: 'Sumy', source: `root = DataChart(${comparison()}, "bar", "supplierName", ["totalMinor"])` },
      ctx,
    );
    expect(money.ok, JSON.stringify(money.body)).toBe(true);
    expect(money.body.rendered).toBe(false);
    expect(money.body.readBack).toContain('ZAPISANA, ale nie narysowana');
    expect(money.body.readBack).toContain('mcp__app__ui_state');
    expect(money.body.warnings).toHaveLength(1);
    expect(money.body.warnings[0]).toMatchObject({ code: 'unit_from_record', statementId: 'root' });
    expect(money.body.warnings[0].message).toContain('Suma (jednostka z pola currency)');
    // A warning, never a refusal: the card is stored and shows the composition.
    expect((h.platform.services.canvas.getCard(money.body.cardId, h.ownerId).spec as { source: string }).source).toContain(
      'DataChart',
    );

    // A numeric series carrying no unit of its own: nothing that could surprise.
    const score = await call(
      'agent_view_create',
      { title: 'Wyniki', source: `root = DataChart(${comparison()}, "bar", "supplierName", ["score"])` },
      ctx,
    );
    expect(score.body).toMatchObject({ rendered: false, warnings: [] });

    // The same on a change — and on a change that changes nothing, where the
    // model is just as far from having looked at the screen.
    const patch = `root = DataChart(${comparison()}, "bar", "supplierName", ["totalMinor"])`;
    const changed = await call('agent_view_update', { cardId: score.body.cardId, patch }, ctx);
    expect(changed.body).toMatchObject({ unchanged: false, rendered: false });
    expect(changed.body.warnings.map((w: { code: string }) => w.code)).toEqual(['unit_from_record']);
    const again = await call('agent_view_update', { cardId: score.body.cardId, patch }, ctx);
    expect(again.body).toMatchObject({ unchanged: true, rendered: false });
    expect(again.body.warnings.map((w: { code: string }) => w.code)).toEqual(['unit_from_record']);
    expect(again.body.readBack).toContain('mcp__app__ui_state');

    // A table over the same read is not a chart: no unit warning.
    const table = await call(
      'agent_view_create',
      { title: 'Tabela', source: `root = DataTable(${comparison()}, ["supplierName", "totalMinor"])` },
      ctx,
    );
    expect(table.body).toMatchObject({ rendered: false, warnings: [] });

    // The composition from the turn itself: unit prices of a case's offer items,
    // which are quoted in PLN and in EUR, so the chart never drew.
    const items = `{operation: "procurement.case_offer_items", input: {caseId: "${caseId}"}}`;
    const asInTurn = await call(
      'agent_view_update',
      {
        cardId: table.body.cardId,
        patch: `root = Stack([tabela, wykres])\ntabela = DataTable(${items}, ["name", "unitPriceMinor"])\nwykres = DataChart(${items}, "bar", "name", ["unitPriceMinor"], "Ceny jednostkowe pozycji ofert")`,
      },
      ctx,
    );
    expect(asInTurn.ok, JSON.stringify(asInTurn.body)).toBe(true);
    expect(asInTurn.body.warnings).toHaveLength(1);
    expect(asInTurn.body.warnings[0]).toMatchObject({ code: 'unit_from_record', statementId: 'wykres' });
    expect(asInTurn.body.warnings[0].message).toContain('Cena jednostkowa (jednostka z pola currency)');
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

  it('patch nie gubi niczego po cichu: nieosiagalna nowa instrukcja, znikajaca instrukcja, nierozpoznana linia, powtorzona nazwa', async () => {
    const conv = newConversation();
    const ctx = context(conv.id);
    const source = [
      'root = Stack([opis, tabela])',
      'opis = TextContent("Oferty w sprawie")',
      `tabela = DataTable(${comparison()}, ["supplierName", "totalMinor"])`,
    ].join('\n');
    const created = await call('agent_view_create', { title: 'T', source }, ctx);
    const chart = `DataChart(${comparison()}, "bar", "supplierName", ["totalMinor"])`;
    const cases: Array<{ patch: string; reason: CompositionRefusal; text: RegExp }> = [
      // (a) a new statement nothing refers to: the merge would drop it and report success.
      { patch: `wykres2 = ${chart}`, reason: 'orphaned_statement', text: /Instrukcja wykres2 z patcha nie jest osiagalna z root/ },
      // (b) a new root that no longer lists `opis`: the merge would delete it.
      { patch: 'root = Stack([tabela])', reason: 'orphaned_statement', text: /Instrukcja opis zniknelaby z widoku.*opis = null/ },
      // (c) a line that is not a statement: the merge would skip it.
      { patch: 'opis = TextContent("Nowy opis")\nto nie jest instrukcja', reason: 'syntax', text: /Nie rozpoznano instrukcji "to nie jest instrukcja"/ },
      // (d) one name twice: the merge would keep the last.
      { patch: 'opis = TextContent("Pierwszy")\nopis = TextContent("Drugi")', reason: 'duplicate_statement', text: /Instrukcja opis jest zdefiniowana 2 razy/ },
    ];
    for (const c of cases) {
      const out = await call('agent_view_update', { cardId: created.body.cardId, patch: c.patch }, ctx);
      expect(out.ok, c.patch).toBe(false);
      expect(out.body.details.reason, c.patch).toBe(c.reason);
      expect(out.body.message, c.patch).toMatch(c.text);
    }
    // A patch deleting a statement that does not exist is refused too.
    const ghost = await call('agent_view_update', { cardId: created.body.cardId, patch: 'duch = null' }, ctx);
    expect(ghost.body.details.reason).toBe('unresolved_reference');
    let card = h.platform.services.canvas.getCard(created.body.cardId, h.ownerId);
    expect(card.spec).toEqual({ kind: 'openui', source });
    expect(card.specVersion).toBe(1);

    // A patch that changes nothing: no new version, and the answer says so.
    const same = await call('agent_view_update', { cardId: created.body.cardId, patch: 'opis = TextContent("Oferty w sprawie")' }, ctx);
    expect(same.ok).toBe(true);
    expect(same.body).toMatchObject({ unchanged: true, specVersion: 1 });
    expect(h.platform.services.canvas.getCard(created.body.cardId, h.ownerId).specVersion).toBe(1);

    // The same intentions written correctly are applied: a new chart listed in root, a deletion by name.
    const added = await call(
      'agent_view_update',
      { cardId: created.body.cardId, patch: `root = Stack([tabela, wykres2])\nwykres2 = ${chart}\nopis = null` },
      ctx,
    );
    expect(added.ok, JSON.stringify(added.body)).toBe(true);
    expect(added.body).toMatchObject({ unchanged: false, specVersion: 2 });
    card = h.platform.services.canvas.getCard(created.body.cardId, h.ownerId);
    expect((card.spec as { source: string }).source.split('\n')).toEqual([
      'root = Stack([tabela, wykres2])',
      `tabela = DataTable(${comparison()}, ["supplierName", "totalMinor"])`,
      `wykres2 = ${chart}`,
    ]);
  });

  it('patch: linia, ktorej nie da sie odczytac, zmiana tylko ukladu i nieaktualna wersja przy braku zmian', async () => {
    const conv = newConversation();
    const ctx = context(conv.id);
    // Stored with a blank line and a comment: layout the merge does not keep.
    const source = [
      'root = Stack([opis, tabela])',
      '',
      '// opis nad tabela',
      'opis = TextContent("Oferty w sprawie")',
      `tabela = DataTable(${comparison()}, ["supplierName", "totalMinor"])`,
    ].join('\n');
    const created = await call('agent_view_create', { title: 'T', source }, ctx);
    expect(created.ok, JSON.stringify(created.body)).toBe(true);
    const cardId = created.body.cardId as string;

    // M1: a statement-shaped line lang-core cannot read, for a name that exists, is not "applied".
    for (const unreadable of [
      `opis = TextContent("Nowy")\ntabela == DataTable(${comparison()}, ["supplierName"])`,
      'tabela = @@@ ###',
    ]) {
      const out = await call('agent_view_update', { cardId, patch: unreadable }, ctx);
      expect(out.ok, unreadable).toBe(false);
      expect(out.body.details.reason, unreadable).toBe('syntax');
      expect(out.body.message, unreadable).toMatch(/Instrukcji tabela z patcha nie da sie odczytac/);
    }
    expect(h.platform.services.canvas.getCard(cardId, h.ownerId)).toMatchObject({ spec: { kind: 'openui', source }, specVersion: 1 });

    // M2: the same statements, re-sent — as a patch or as a whole source laid out differently — change nothing.
    const samePatch = await call('agent_view_update', { cardId, patch: 'opis   =   TextContent( "Oferty w sprawie" )' }, ctx);
    expect(samePatch.body).toMatchObject({ unchanged: true, specVersion: 1 });
    const sameSource = await call(
      'agent_view_update',
      { cardId, source: `root = Stack([opis, tabela])\nopis = TextContent("Oferty w sprawie")\ntabela = DataTable(${comparison()}, ["supplierName", "totalMinor"])` },
      ctx,
    );
    expect(sameSource.body).toMatchObject({ unchanged: true, specVersion: 1 });
    // ...while a change inside a string is a change.
    const inString = await call('agent_view_update', { cardId, patch: 'opis = TextContent("Oferty  w sprawie")' }, ctx);
    expect(inString.body).toMatchObject({ unchanged: false, specVersion: 2 });

    // M4: a stale expected version is a conflict even when nothing would change.
    const stale = await call(
      'agent_view_update',
      { cardId, patch: 'opis = TextContent("Oferty  w sprawie")', expectedSpecVersion: 1 },
      ctx,
    );
    expect(stale.body.error).toBe('conflict');
    expect(stale.body.details.currentSpecVersion).toBe(2);
    const current = await call('agent_view_update', { cardId, patch: 'opis = TextContent("Oferty  w sprawie")', expectedSpecVersion: 2 }, ctx);
    expect(current.body).toMatchObject({ unchanged: true, specVersion: 2 });
  });

  it('pelne zrodlo z nierozpoznana linia lub powtorzona nazwa jest odrzucane, nie uznane za brak zmian — z tytulem i bez', async () => {
    const conv = newConversation();
    const ctx = context(conv.id);
    const source = ['root = Stack([opis, tabela])', 'opis = TextContent("Oferty w sprawie")', `tabela = DataTable(${comparison()})`].join('\n');
    const created = await call('agent_view_create', { title: 'Przed', source }, ctx);
    const cardId = created.body.cardId as string;
    const cases: Array<{ source: string; reason: CompositionRefusal; text: RegExp }> = [
      { source: `${source}\n@@@ smieci`, reason: 'syntax', text: /Nie rozpoznano instrukcji "@@@ smieci"/ },
      { source: `${source}\nopis = TextContent("Drugi opis")`, reason: 'duplicate_statement', text: /Instrukcja opis jest zdefiniowana 2 razy/ },
    ];
    for (const c of cases) {
      for (const title of [undefined, 'Po']) {
        const out = await call('agent_view_update', { cardId, source: c.source, ...(title ? { title } : {}) }, ctx);
        expect(out.ok, `${c.reason} title=${title}`).toBe(false);
        expect(out.body.details?.reason, `${c.reason} title=${title}`).toBe(c.reason);
        expect(out.body.message).toMatch(c.text);
      }
    }
    expect(h.platform.services.canvas.getCard(cardId, h.ownerId)).toMatchObject({
      title: 'Przed',
      specVersion: 1,
      spec: { kind: 'openui', source },
    });
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

  it('ogolne narzedzia canvasu i interfejsu nie siegaja do widokow agenta innej rozmowy', async () => {
    const a = newConversation();
    const b = newConversation();
    const inB = await call('agent_view_create', { title: 'B', source: `root = DataTable(${comparison()})` }, context(b.id));
    const bSpace = inB.body.spaceId as string;
    const bCard = inB.body.cardId as string;
    const before = h.platform.services.canvas.getState(bSpace, h.ownerId);
    const fromA = context(a.id);
    fromA.requestUi = async () => ({ commandId: 'x', executed: true });

    const attempts: Array<[string, unknown]> = [
      ['canvas_list_cards', { spaceId: bSpace }],
      ['canvas_add_card', { spaceId: bSpace, title: 'x', spec: { kind: 'openui', source: `root = DataTable(${comparison()})` } }],
      ['canvas_update_card', { cardId: bCard, spec: { kind: 'openui', source: `root = DataTable(${comparison()}, ["supplierName"])` } }],
      ['canvas_move_card', { cardId: bCard, geometry: { x: 700 } }],
      ['canvas_remove_card', { cardId: bCard }],
      ['ui_navigate', { targetId: 'platform.canvas', spaceId: bSpace }],
    ];
    for (const [name, input] of attempts) {
      const out = await call(name, input, fromA);
      expect(out.body.error, name).toBe('forbidden');
      expect(out.body.details?.reason, name).toBe('other_conversation_views');
    }
    // Also when the run's context points at B's space (a stale or foreign screen).
    const stale = { ...context(a.id), appContext: { ...fromA.appContext, spaceId: bSpace } };
    expect((await call('canvas_list_cards', {}, stale)).body.error).toBe('forbidden');
    expect(h.platform.services.canvas.getState(bSpace, h.ownerId)).toEqual(before);

    // B's views are not in A's catalog; A's own are.
    const inA = await call('agent_view_create', { title: 'A', source: `root = DataTable(${comparison()})` }, fromA);
    const catalog = await call('ui_catalog', {}, fromA);
    const listed = (catalog.body.spaces as Array<{ spaceId: string }>).map((sp) => sp.spaceId);
    expect(listed).not.toContain(bSpace);
    expect(listed).toContain(inA.body.spaceId);
    // The run's own views stay reachable through the generic tools (with the agent-views rule).
    expect((await call('canvas_list_cards', { spaceId: inA.body.spaceId }, fromA)).body.cards).toHaveLength(1);
  });

  it('wykonanie w tle w rozmowie A nie zmieni widokow rozmowy B ogolnym narzedziem', async () => {
    const a = newConversation();
    const b = newConversation();
    const inB = await call('agent_view_create', { title: 'B', source: `root = DataTable(${comparison()})` }, context(b.id));
    const before = h.platform.services.canvas.getState(inB.body.spaceId, h.ownerId);
    const runtime = new AgentRuntime(
      h.platform.services,
      scriptedAgent(
        [
          { kind: 'call', name: 'canvas_remove_card', input: { cardId: inB.body.cardId } },
          { kind: 'call', name: 'canvas_move_card', input: { cardId: inB.body.cardId, geometry: { x: 900 } } },
        ],
        { tools },
      ),
    );
    // The user is looking at B while A's run works: B's space is the context's space.
    const started = await runtime.start({
      ownerId: h.ownerId,
      conversationId: a.id,
      prompt: 'w tle',
      appContext: { ...context(a.id).appContext, conversationId: b.id, spaceId: inB.body.spaceId },
    });
    const events: Array<Record<string, any>> = [];
    for await (const { event } of started.stream.read(0)) events.push(event as Record<string, any>);
    await started.done;
    const results = events.filter((e) => e.type === AGUI_EVENTS.TOOL_CALL_RESULT);
    expect(results.map((r) => [r.isError, JSON.parse(r.content).details?.reason])).toEqual([
      [true, 'other_conversation_views'],
      [true, 'other_conversation_views'],
    ]);
    expect(h.platform.services.canvas.getState(inB.body.spaceId, h.ownerId)).toEqual(before);
  });

  it('zakres rozmowy jest zarezerwowany: API nie tworzy przestrzeni widokow agenta dla dowolnego identyfikatora', async () => {
    const conv = newConversation();
    for (const [path, body] of [
      ['/api/canvas/spaces', { title: 'podrobka', scopeKind: AGENT_VIEWS_SCOPE_KIND, scopeId: conv.id }],
      ['/api/canvas/spaces', { title: 'sierota', scopeKind: AGENT_VIEWS_SCOPE_KIND, scopeId: 'cnv_nie_istnieje' }],
      ['/api/canvas/spaces/for-scope', { kind: AGENT_VIEWS_SCOPE_KIND, id: conv.id, title: 'podrobka' }],
    ] as const) {
      const res = await api(path, { method: 'POST', body: JSON.stringify(body) });
      expect(res.status, path).toBe(400);
      expect(res.body.error.details.reason, path).toBe('reserved_scope');
    }
    expect(h.platform.services.canvas.findScopedSpace(h.ownerId, AGENT_VIEWS_SCOPE_KIND, conv.id)).toBeNull();
    expect(h.platform.services.canvas.findScopedSpace(h.ownerId, AGENT_VIEWS_SCOPE_KIND, 'cnv_nie_istnieje')).toBeNull();
    // Other scopes are unaffected.
    expect((await api('/api/canvas/spaces', { method: 'POST', body: JSON.stringify({ title: 'zwykla', scopeKind: 'inny', scopeId: 'x1' }) })).status).toBe(201);
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

  it('schematy wejscia narzedzi agent_view_* przechodza kontrole MCP i tak sa wystawiane modelowi', () => {
    const ours = platformTools(h.platform.services).filter((t) => t.name.startsWith('agent_view'));
    expect(ours.map((t) => t.name)).toEqual(['agent_views_list', 'agent_view_create', 'agent_view_update', 'agent_view_remove']);
    const required: Record<string, string[]> = {
      agent_views_list: [],
      agent_view_create: ['title', 'source'],
      agent_view_update: ['cardId'],
      agent_view_remove: ['cardId'],
    };
    for (const tool of ours) {
      expect(() => assertMcpCompatibleShape(tool.name, tool.inputSchema.shape as Record<string, unknown>)).not.toThrow();
      // What the model is told is required: optional fields must not be (a `.default()` would be).
      const json = z.toJSONSchema(tool.inputSchema) as { required?: string[] };
      expect((json.required ?? []).sort(), tool.name).toEqual([...required[tool.name]!].sort());
    }
    // The SDK server is built with them, under their exposed names.
    const built = buildMcpServer({
      registry: h.platform.registry,
      platformTools: platformTools(h.platform.services),
      contextFor: () => {
        throw new Error('nie wolane w tescie');
      },
    });
    expect(built.tools.map((t) => t.exposedName)).toEqual(
      expect.arrayContaining(Object.keys(required).map((n) => `mcp__app__${n}`)),
    );
  });

  it('prompt opisuje widoki agenta sygnaturami z katalogu', () => {
    const prompt = buildSystemPrompt({
      registry: h.platform.registry,
      catalog: h.platform.services.catalog,
      appContext: { conversationId: null, spaceId: null, resource: null, selection: [], filters: {}, viewport: null, drafts: [], ui: null },
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
    // The whitelist is the prompt's list: no Markdown renderer offered.
    expect(prompt).not.toContain('MarkDownRenderer');
    // The grouping example keeps the table's order: a patch repeats unchanged arguments.
    expect(prompt).toContain(
      'tabela = DataTable({operation: "modul.operacja", input: {}}, ["poleA", "poleB"], "Tytul", null, null, {field: "poleB", direction: "desc"}, "poleA")',
    );

    /*
     * The two rules real turns showed missing. Asserted on the prompt because
     * that is where they live; whether the model then obeys them is what
     * `e2e/bl01-bl02-model.spec.ts` spends a turn on.
     */
    // A business code the user typed is not a record id (`run_39bc79cc133d4bce8fcc`).
    expect(prompt).toContain('Identyfikatory w source.input musza pochodzic z ODCZYTU');
    expect(prompt).toContain('kodu biznesowego, ktory uzytkownik wpisal w rozmowie (np. "PC-2026-01")');
    expect(prompt).toContain('Walidator sprawdza schemat kompozycji, a NIE istnienie rekordu');
    // What a refused read looks like, so a refusal is recognised instead of assumed away.
    expect(prompt).toMatch(/instancja ma state = forbidden/);
    expect(prompt).toMatch(/error\.code not_found lub forbidden/);
    // Stored is not drawn (`run_96c52b19607e4a21a589`).
    expect(prompt).toContain('## Po utworzeniu albo zmianie widoku');
    expect(prompt).toContain('mowi tylko, ze kompozycja zostala ZAPISANA');
    expect(prompt).toMatch(/NIGDY nie twierdz, ze wykres, tabela albo podsumowanie cos pokazuje, jesli tego nie odczytales/);
    expect(prompt).toContain('mcp__app__ui_state');
  });
});
