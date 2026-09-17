import { QueryClient } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGUI_EVENTS,
  AppError,
  DATA_COMPONENT_PROPS,
  PLATFORM_CUSTOM_EVENTS,
  SEMANTIC_VISIBLE_RECORDS_LIMIT,
  applyViewFilter,
  dataChartPropsSchema,
  formatFieldValue,
  numericFieldValue,
  readResultDescriptorSchema,
  recordRouteOf,
  recordsOf,
  semanticInstanceSchema,
  sortRecords,
  type ReadResponse,
  type ReadResultDescriptor,
  type RecordField,
  type ServerModule,
} from '@platform/contracts';
import {
  AgentRuntime,
  ServerModuleRegistry,
  assertMcpCompatibleShape,
  buildSystemPrompt,
  collectToolEntries,
  createPlatform,
  platformTools,
} from '@platform/server';
import { createProcurementModule } from '@module/procurement/server';
import {
  applyRunEvent,
  createInstanceDescriber,
  listInstances,
  qk,
  registerInstance,
  setAccessContext,
  unregisterInstance,
  useUiSemantics,
} from '@platform/ui';
import { buildChartModel, buildDataModel, describeDataInstance } from '../packages/platform-ui/src/views/model.ts';
import { scriptedAgent, type Step } from '../e2e/support/scripted-agent.ts';
import { createHarness, login, type Harness } from './helpers.ts';

/**
 * Foundation of composed data views.
 *
 * Views are OpenUI compositions whose data components name a registered read
 * instead of carrying values. What has to hold for that to be safe and truthful
 * is tested here without a browser: the read endpoint answers only with the
 * owner's data and refuses everything it cannot answer; the descriptor is the
 * one authority on fields, formatting and order; a module whose narrowable
 * fields do not exist in its view's read does not start; and a scripted run can
 * call real tool handlers.
 */

let h: Harness;
let cookie: string;
let otherCookie: string;
let caseId: string;

const api = async (path: string, init: RequestInit & { as?: string | null } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const who = init.as === undefined ? cookie : init.as;
  if (who) headers.cookie = who;
  const res = await h.platform.app.request(path, { ...init, headers });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const read = (body: unknown, as?: string | null) =>
  api('/api/read', { method: 'POST', body: JSON.stringify(body), as });

beforeAll(async () => {
  h = await createHarness();
  cookie = await login(h.platform.app, h.ownerId);
  otherCookie = await login(h.platform.app, h.otherOwnerId);
  caseId = h.service.listCases(h.ownerId)[0]!.id;
});
afterAll(() => h.dispose());

/* -------------------------------------------------------------------------- */

describe('POST /api/read', () => {
  it('zwraca wynik zarejestrowanego odczytu razem z deskryptorem', async () => {
    const res = await read({ operation: 'procurement.suppliers' });
    expect(res.status).toBe(200);
    expect(res.body.operation).toBe('procurement.suppliers');
    expect(Number.isNaN(Date.parse(res.body.resolvedAt))).toBe(false);
    expect(res.body.descriptor.collection).toBe('suppliers');
    expect(res.body.descriptor.record).toEqual({ kind: 'supplier', idField: 'id', titleField: 'name' });
    // The rows are the service's, for the session's owner — not a copy of anything.
    expect(res.body.result.suppliers).toEqual(JSON.parse(JSON.stringify(h.service.listSuppliers(h.ownerId))));
    expect(res.body.result.suppliers).toHaveLength(4);
  });

  it('odczyt z wejsciem uruchamia operacje dla wskazanego rekordu', async () => {
    const res = await read({ operation: 'procurement.comparison', input: { caseId } });
    expect(res.status).toBe(200);
    const rows = recordsOf(res.body.result, res.body.descriptor);
    expect(rows.map((r) => r.offerId)).toEqual(h.service.compare(caseId, h.ownerId).rows.map((r) => r.offerId));
  });

  it('nieznana operacja jest odrzucana z lista dostepnych', async () => {
    const res = await read({ operation: 'procurement.nie_istnieje' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.message).toMatch(/Nieznana operacja odczytu "procurement.nie_istnieje"/);
    expect(res.body.error.details.reason).toBe('unknown_operation');
    expect(res.body.error.details.available).toEqual(
      expect.arrayContaining(['procurement.suppliers', 'procurement.cases', 'procurement.comparison']),
    );
    expect(res.body.result).toBeUndefined();
  });

  it('wejscie niezgodne ze schematem operacji jest odrzucane', async () => {
    const res = await read({ operation: 'procurement.case_overview', input: { caseId: 123 } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.reason).toBe('invalid_input');
    expect(res.body.error.details.issues[0].path).toBe('caseId');

    const missing = await read({ operation: 'procurement.case_overview' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.reason).toBe('invalid_input');

    const notADescriptor = await read({ rows: [{ a: 1 }] });
    expect(notADescriptor.status).toBe(400);
    expect(notADescriptor.body.error.details.reason).toBe('invalid_source');
  });

  it('zasob innego wlasciciela jest odrzucony, a nie zwrocony pusty', async () => {
    const foreign = await read({ operation: 'procurement.case_overview', input: { caseId } }, otherCookie);
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('forbidden');
    expect(JSON.stringify(foreign.body)).not.toContain('Wyposazenie');

    // A list read is scoped to the session's owner: the same operation shows the
    // other identity its own (empty) data, never the first owner's rows.
    const list = await read({ operation: 'procurement.suppliers' }, otherCookie);
    expect(list.status).toBe(200);
    expect(list.body.result.suppliers).toEqual([]);
  });

  it('bez sesji nie ma odczytu', async () => {
    const res = await read({ operation: 'procurement.suppliers' }, null);
    expect(res.status).toBe(401);
  });

  it('GET /api/read/operations podaje nazwe, opis, klucze wejscia i deskryptor', async () => {
    const res = await api('/api/read/operations');
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.operations.map((o: any) => [o.name, o]));
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining(['procurement.suppliers', 'procurement.cases', 'procurement.comparison', 'procurement.case_overview']),
    );
    expect(byName['procurement.comparison'].inputKeys).toEqual(['caseId']);
    expect(byName['procurement.suppliers'].inputKeys).toEqual([]);
    expect(byName['procurement.cases'].descriptor.record.route).toBe('/cases/{id}');
    for (const op of res.body.operations) {
      if (op.descriptor) expect(readResultDescriptorSchema.safeParse(op.descriptor).success).toBe(true);
    }
  });
});

describe('GET /api/ui/views', () => {
  it('zwraca widoki modulow jako kompozycje z odczytem glownej instancji', async () => {
    const res = await api('/api/ui/views');
    expect(res.status).toBe(200);
    const ids = res.body.views.map((v: any) => v.id);
    expect(ids).toEqual(['procurement.data', 'procurement.cases']);
    const data = res.body.views[0];
    expect(data.primaryOperation).toBe('procurement.suppliers');
    expect(data.composition).toMatch(/DataTable\(\{operation: "procurement.suppliers"\}/);
    // Each view has the id of a UI target the agent can open.
    const targets = (await api('/api/ui/targets')).body.targets.map((t: any) => t.id);
    for (const id of ids) expect(targets).toContain(id);
  });

  it('bez sesji nie ma listy widokow', async () => {
    expect((await api('/api/ui/views', { as: null })).status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */

describe('zgodnosc zawezania UiTarget z deskryptorem widoku przy starcie', () => {
  /** The real module with one declaration changed. */
  const variant = (change: (mod: ServerModule) => ServerModule): ServerModule =>
    change(createProcurementModule(h.platform.services));

  const withDataFilter = (mod: ServerModule, fields: Array<{ field: string; label: string; values?: string[] }>) => ({
    ...mod,
    uiTargets: mod.uiTargets!.map((t) =>
      t.id === 'procurement.data' ? { ...t, filter: { ...t.filter!, fields } } : t,
    ),
  });

  it('modul przykladowy przechodzi kontrole', () => {
    const registry = new ServerModuleRegistry();
    expect(() => registry.register(createProcurementModule(h.platform.services))).not.toThrow();
    expect(registry.views().map((v) => v.id)).toEqual(['procurement.data', 'procurement.cases']);
  });

  it('pole zawezania spoza deskryptora zatrzymuje start z nazwa pola', () => {
    const registry = new ServerModuleRegistry();
    const mod = variant((m) =>
      withDataFilter(m, [
        { field: 'country', label: 'Kraj' },
        { field: 'wojewodztwo', label: 'Wojewodztwo' },
      ]),
    );
    expect(() => registry.register(mod)).toThrowError(
      /widok procurement\.data: pola zawezania wojewodztwo nie sa zadeklarowane w deskryptorze procurement\.suppliers/,
    );
    // Refused whole, not half-installed.
    expect(registry.modules).toHaveLength(0);
    expect(registry.readOperations).toHaveLength(0);
    expect(registry.views()).toHaveLength(0);
  });

  it('ta sama odmowa zatrzymuje createPlatform', () => {
    const dataDir = `${h.dataDir}/start-odmowa`;
    expect(() =>
      createPlatform({
        modules: (services) => [
          withDataFilter(createProcurementModule(services), [{ field: 'wojewodztwo', label: 'Wojewodztwo' }]),
        ],
        env: { ...process.env, APP_DATA_DIR: dataDir },
      }),
    ).toThrowError(/wojewodztwo nie sa zadeklarowane/);
  });

  it('cel z zawezaniem wymaga primaryOperation widoku', () => {
    const mod = variant((m) => ({
      ...m,
      views: m.views!.map((v) => (v.id === 'procurement.data' ? { ...v, primaryOperation: undefined } : v)),
    }));
    expect(() => new ServerModuleRegistry().register(mod)).toThrowError(/musi wskazac primaryOperation/);
  });

  it('kolekcja celu musi byc kolekcja deskryptora', () => {
    const mod = variant((m) => ({
      ...m,
      uiTargets: m.uiTargets!.map((t) =>
        t.id === 'procurement.data' ? { ...t, filter: { ...t.filter!, collection: 'rows' } } : t,
      ),
    }));
    expect(() => new ServerModuleRegistry().register(mod)).toThrowError(/zaweza kolekcje "rows"/);
  });

  it('podpowiadane wartosci pola enum musza byc kodami deskryptora', () => {
    // The values the cases target used to suggest: two of them no case can have.
    const mod = variant((m) => ({
      ...m,
      uiTargets: m.uiTargets!.map((t) =>
        t.id === 'procurement.cases'
          ? {
              ...t,
              filter: {
                ...t.filter!,
                fields: t.filter!.fields.map((f) =>
                  f.field === 'status' ? { ...f, values: ['collecting', 'comparing', 'closed'] } : f,
                ),
              },
            }
          : t,
      ),
    }));
    expect(() => new ServerModuleRegistry().register(mod)).toThrowError(/\(comparing, closed\) nie sa kodami/);
  });

  it('niezarejestrowana primaryOperation i odczyt bez deskryptora sa odrzucane', () => {
    const unknownOp = variant((m) => ({
      ...m,
      views: m.views!.map((v) => (v.id === 'procurement.data' ? { ...v, primaryOperation: 'procurement.brak' } : v)),
    }));
    expect(() => new ServerModuleRegistry().register(unknownOp)).toThrowError(/procurement\.brak nie jest zarejestrowana/);

    const noDescriptor = variant((m) => ({
      ...m,
      readOperations: m.readOperations!.map((op) => (op.name === 'suppliers' ? { ...op, result: undefined } : op)),
    }));
    expect(() => new ServerModuleRegistry().register(noDescriptor)).toThrowError(/nie deklaruje deskryptora wyniku/);
  });

  it('unitField i pola trasy rekordu musza byc zadeklarowane — odmowa z nazwa pola', () => {
    const base: ReadResultDescriptor = {
      collection: 'rows',
      record: { kind: 'thing', idField: 'id', route: '/things/{id}/{code}' },
      fields: [
        { field: 'code', label: 'Kod', type: 'text' },
        { field: 'total', label: 'Suma', type: 'money_minor', unitField: 'currency' },
        { field: 'currency', label: 'Waluta', type: 'text' },
      ],
    };
    // idField and a declared field may both appear in the route.
    expect(readResultDescriptorSchema.safeParse(base).success).toBe(true);

    const typo = readResultDescriptorSchema.safeParse({
      ...base,
      fields: base.fields.map((f) => (f.field === 'total' ? { ...f, unitField: 'currencyy' } : f)),
    });
    expect(typo.success).toBe(false);
    expect(typo.error!.issues.map((i) => i.message)).toContain(
      'Pole total: unitField currencyy nie jest zadeklarowanym polem.',
    );
    expect(typo.error!.issues[0]!.path).toEqual(['fields', 1, 'unitField']);

    const route = readResultDescriptorSchema.safeParse({ ...base, record: { ...base.record, route: '/things/{slug}' } });
    expect(route.success).toBe(false);
    expect(route.error!.issues.map((i) => i.message)).toContain(
      'record.route: {slug} nie jest zadeklarowanym polem ani idField.',
    );

    // And the same refusal stops the module at startup, naming the field.
    const mod = variant((m) => ({
      ...m,
      readOperations: m.readOperations!.map((op) =>
        op.name === 'comparison'
          ? {
              ...op,
              result: {
                ...op.result!,
                fields: op.result!.fields.map((f) => (f.field === 'totalMinor' ? { ...f, unitField: 'currencyy' } : f)),
              },
            }
          : op,
      ),
    }));
    expect(() => new ServerModuleRegistry().register(mod)).toThrowError(
      /procurement\.comparison: niepoprawny deskryptor wyniku — fields\.4\.unitField: Pole totalMinor: unitField currencyy/,
    );
  });

  it('niepoprawny deskryptor i powtorzony widok sa odrzucane przy rejestracji', () => {
    const badDescriptor = variant((m) => ({
      ...m,
      readOperations: m.readOperations!.map((op) =>
        op.name === 'suppliers'
          ? { ...op, result: { ...op.result!, record: { ...op.result!.record, titleField: 'brak' } } }
          : op,
      ),
    }));
    expect(() => new ServerModuleRegistry().register(badDescriptor)).toThrowError(/titleField brak/);

    const registry = new ServerModuleRegistry().register(createProcurementModule(h.platform.services));
    const second: ServerModule = {
      meta: { id: 'drugi', title: 'Drugi', version: '0.0.1', description: 'x' },
      migrations: [],
      tools: [],
      views: [{ id: 'procurement.data', title: 'Kopia', composition: 'root = Stack([])' }],
    };
    expect(() => registry.register(second)).toThrowError(/Widok procurement\.data jest juz zarejestrowany/);
  });
});

/* -------------------------------------------------------------------------- */

describe('formatowanie i porzadek wedlug typu pola', () => {
  const f = (field: Partial<RecordField> & { field: string; type: RecordField['type'] }): RecordField => ({
    label: field.field,
    ...field,
  });
  const NBSP = ' ';

  it('kwoty w groszach z waluta z unitField, bez bledu zmiennoprzecinkowego', () => {
    const money = f({ field: 'total', type: 'money_minor', unitField: 'currency' });
    expect(formatFieldValue({ total: 123456, currency: 'PLN' }, money)).toBe('1234,56 PLN');
    expect(formatFieldValue({ total: 1234567, currency: 'EUR' }, money)).toBe(`12${NBSP}345,67 EUR`);
    expect(formatFieldValue({ total: 5, currency: 'PLN' }, money)).toBe('0,05 PLN');
    expect(formatFieldValue({ total: -250, currency: 'PLN' }, money)).toBe('-2,50 PLN');
    // 0.1 + 0.2 style drift would show here: 29 grosze are 29 grosze.
    expect(formatFieldValue({ total: 29, currency: 'PLN' }, money)).toBe('0,29 PLN');
    expect(formatFieldValue({ total: null, currency: 'PLN' }, money)).toBe('—');
    expect(numericFieldValue({ total: 123456 }, money)).toBe(1234.56);
  });

  it('ilosci w tysiecznych z jednostka rekordu, liczby z jednostka stala', () => {
    const qty = f({ field: 'q', type: 'quantity_milli', unitField: 'unit' });
    expect(formatFieldValue({ q: 12500, unit: 'szt' }, qty)).toBe('12,5 szt');
    expect(formatFieldValue({ q: 2000, unit: 'kpl' }, qty)).toBe('2 kpl');
    expect(formatFieldValue({ q: 1, unit: 'kg' }, qty)).toBe('0,001 kg');
    expect(numericFieldValue({ q: 12500 }, qty)).toBe(12.5);
    const pct = f({ field: 'p', type: 'number', unit: '%' });
    expect(formatFieldValue({ p: 75 }, pct)).toBe('75 %');
    // A missing number is not zero.
    expect(numericFieldValue({ p: null }, pct)).toBeNull();
  });

  it('daty, wartosci logiczne, enum i puste pole', () => {
    expect(formatFieldValue({ d: '2026-10-01' }, f({ field: 'd', type: 'date' }))).toBe('01.10.2026');
    expect(formatFieldValue({ b: true }, f({ field: 'b', type: 'boolean' }))).toBe('tak');
    expect(formatFieldValue({ b: false }, f({ field: 'b', type: 'boolean' }))).toBe('nie');
    const status = f({ field: 's', type: 'enum', values: [{ value: 'net', label: 'netto' }] });
    expect(formatFieldValue({ s: 'net' }, status)).toBe('netto');
    expect(formatFieldValue({ s: 'inne' }, status)).toBe('inne');
    expect(formatFieldValue({}, f({ field: 't', type: 'text' }))).toBe('—');
  });

  const descriptor: ReadResultDescriptor = {
    collection: 'rows',
    record: { kind: 'thing', idField: 'id', titleField: 'name', route: '/things/{id}' },
    fields: [
      { field: 'name', label: 'Nazwa', type: 'text' },
      { field: 'total', label: 'Suma', type: 'money_minor', unitField: 'currency' },
      { field: 'currency', label: 'Waluta', type: 'text' },
      { field: 'when', label: 'Kiedy', type: 'date' },
    ],
  };

  it('porzadek: liczby liczbowo, tekst polska kolacja, daty chronologicznie, puste na koncu', () => {
    const rows = [
      { id: '1', name: 'Zeta', total: 900, when: '2026-01-02' },
      { id: '2', name: 'Łoś', total: null, when: null },
      { id: '3', name: 'Lampa', total: 10000, when: '2025-12-31' },
      { id: '4', name: 'Ala', total: 95, when: '2026-01-01' },
    ];
    const ids = (sorted: Array<Record<string, unknown>>) => sorted.map((r) => r.id);
    expect(ids(sortRecords(rows, { field: 'total', direction: 'asc' }, descriptor))).toEqual(['4', '1', '3', '2']);
    expect(ids(sortRecords(rows, { field: 'total', direction: 'desc' }, descriptor))).toEqual(['3', '1', '4', '2']);
    expect(ids(sortRecords(rows, { field: 'name', direction: 'asc' }, descriptor))).toEqual(['4', '3', '2', '1']);
    expect(ids(sortRecords(rows, { field: 'when', direction: 'asc' }, descriptor))).toEqual(['3', '4', '1', '2']);
    expect(() => sortRecords(rows, { field: 'nieznane', direction: 'asc' }, descriptor)).toThrowError(
      /Pola nieznane nie sa zadeklarowane/,
    );
    // Enums by label: code `b` reads "alfa", code `a` reads "zeta".
    const coded: ReadResultDescriptor = {
      record: { kind: 'x', idField: 'id' },
      fields: [{ field: 's', label: 'S', type: 'enum', values: [{ value: 'a', label: 'zeta' }, { value: 'b', label: 'alfa' }] }],
    };
    expect(ids(sortRecords([{ id: '1', s: 'a' }, { id: '2', s: 'b' }], { field: 's', direction: 'asc' }, coded))).toEqual(['2', '1']);
  });

  it('rekordy wg deskryptora: brak kolekcji to blad, nie pusta lista; trasa rekordu', () => {
    expect(() => recordsOf({ inne: [] }, descriptor)).toThrowError(AppError);
    expect(() => recordsOf({ inne: [] }, descriptor)).toThrowError(/nie zawiera kolekcji "rows"/);
    expect(recordsOf({ rows: [{ id: 'a' }, 7] }, descriptor)).toEqual([{ id: 'a' }]);
    const single = { ...descriptor, collection: undefined };
    expect(recordsOf({ id: 'x' }, single)).toEqual([{ id: 'x' }]);
    expect(recordRouteOf({ id: 'a b' }, descriptor)).toBe('/things/a%20b');
    expect(recordRouteOf({ id: null }, descriptor)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('model komponentow danych', () => {
  let suppliers: ReadResponse;
  let comparison: ReadResponse;
  beforeAll(async () => {
    suppliers = (await read({ operation: 'procurement.suppliers' })).body;
    comparison = (await read({ operation: 'procurement.comparison', input: { caseId } })).body;
  });

  it('kolumna spoza deskryptora jest odrzucana z nazwa', () => {
    expect(() => buildDataModel({ response: suppliers, fieldNames: ['name', 'wojewodztwo'] })).toThrowError(
      /Pola wojewodztwo nie sa zadeklarowane w deskryptorze rekordu supplier/,
    );
    expect(() =>
      buildDataModel({ response: suppliers, filter: [{ field: 'wojewodztwo', op: 'eq', value: 'x' }] }),
    ).toThrowError(/wojewodztwo/);
  });

  it('zawezenie z adresu liczy tak samo jak widok modulu (applyViewFilter)', () => {
    const narrowing = { targetId: 'procurement.data', predicates: [{ field: 'country', op: 'eq' as const, value: 'PL' }] };
    const model = buildDataModel({ response: suppliers, narrowing });
    const rows = (suppliers.result as { suppliers: unknown[] }).suppliers;
    expect(model.outcome).toEqual(applyViewFilter(rows, narrowing).outcome);
    expect(model.outcome).toEqual({ targetId: 'procurement.data', matched: 3, total: 4 });
    expect(model.records.map((r) => r.name)).not.toContain('NordAV OY');
    // No narrowing in force: nothing is reported, so the banner cannot claim one.
    expect(buildDataModel({ response: suppliers }).outcome).toBeNull();
  });

  it('opis instancji spelnia kontrakt i nie wymienia rekordow spoza ekranu', () => {
    const model = buildDataModel({
      response: suppliers,
      fieldNames: ['name', 'country'],
      narrowing: { targetId: 'procurement.data', predicates: [{ field: 'country', op: 'eq', value: 'FI' }] },
    });
    const description = describeDataInstance({
      instanceId: 'DataTable-r1',
      component: 'DataTable',
      viewId: 'procurement.data',
      source: { operation: 'procurement.suppliers' },
      state: 'ready',
      model,
      actions: ['filter'],
    });
    expect(semanticInstanceSchema.parse(description)).toEqual(description);
    expect(description.visibleRecordIds).toHaveLength(1);
    expect(description.matched).toBe(1);
    expect(description.total).toBe(4);
    expect(description.fields.map((x) => x.label)).toEqual(['Nazwa', 'Kraj']);

    // Many records: identifiers are capped, counts are not.
    const many = { ...suppliers, result: { suppliers: Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, name: `n${i}`, country: 'PL' })) } };
    const big = describeDataInstance({
      instanceId: 'x',
      component: 'DataTable',
      viewId: null,
      source: { operation: 'procurement.suppliers' },
      state: 'ready',
      model: buildDataModel({ response: many }),
      actions: [],
    });
    expect(big.visibleRecordIds).toHaveLength(SEMANTIC_VISIBLE_RECORDS_LIMIT);
    expect(big.matched).toBe(120);
    expect(semanticInstanceSchema.safeParse(big).success).toBe(true);
  });

  it('podsumowanie rysujace czesc rekordow podaje wszystkie dopasowane, a wymienia tylko narysowane', () => {
    // 30 records, no predicate, a component that draws the first 20 (DataSummary).
    const thirty = {
      ...suppliers,
      result: { suppliers: Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `n${i}`, country: 'PL' })) },
    };
    const summary = describeDataInstance({
      instanceId: 'DataSummary-r1',
      component: 'DataSummary',
      viewId: null,
      source: { operation: 'procurement.suppliers' },
      state: 'ready',
      model: buildDataModel({ response: thirty, fieldNames: ['name'] }),
      visibleLimit: 20,
      actions: [],
    });
    expect(summary.matched).toBe(30);
    expect(summary.total).toBe(30);
    expect(summary.filter).toEqual([]);
    expect(summary.visibleRecordIds).toEqual(Array.from({ length: 20 }, (_, i) => `s${i}`));
    expect(semanticInstanceSchema.safeParse(summary).success).toBe(true);
  });

  it('opis w kazdym stanie: ladowanie, pusty, blad, brak dostepu', () => {
    const common = {
      instanceId: 'DataTable-stany',
      component: 'DataTable',
      viewId: 'procurement.data',
      source: { operation: 'procurement.suppliers' },
      fieldNames: ['name', 'country'],
      filter: [{ field: 'country', op: 'eq' as const, value: 'PL' }],
      actions: [],
    };

    const loading = describeDataInstance({ ...common, state: 'loading' });
    expect(loading).toMatchObject({ state: 'loading', error: null, record: null, fields: [], matched: null, total: null });
    expect(loading.visibleRecordIds).toEqual([]);

    // The read failed before any descriptor was known.
    const unknownOp = describeDataInstance({
      ...common,
      source: { operation: 'nie.istnieje' },
      state: 'error',
      error: new AppError('validation_failed', 'Nieznana operacja odczytu "nie.istnieje". ' + 'x'.repeat(400)),
    });
    expect(unknownOp.state).toBe('error');
    expect(unknownOp.error!.code).toBe('validation_failed');
    expect(unknownOp.error!.message).toMatch(/^Nieznana operacja odczytu "nie.istnieje"/);
    expect(unknownOp.error!.message.length).toBeLessThanOrEqual(300);
    expect(unknownOp).toMatchObject({ record: null, matched: null, total: null });

    const forbidden = describeDataInstance({
      ...common,
      state: 'forbidden',
      error: new AppError('forbidden', 'Sprawa nalezy do innego wlasciciela.'),
    });
    expect(forbidden.error).toEqual({ code: 'forbidden', message: 'Sprawa nalezy do innego wlasciciela.' });

    // The read answered but the composition was refused: the descriptor is known.
    const refused = describeDataInstance({
      ...common,
      fieldNames: ['name', 'wojewodztwo'],
      state: 'error',
      descriptor: suppliers.descriptor,
      error: new AppError('validation_failed', 'Pola wojewodztwo nie sa zadeklarowane'),
    });
    expect(refused.record).toEqual({ kind: 'supplier', idField: 'id' });
    expect(refused.fields.map((f) => f.field)).toEqual(['name']);

    const empty = describeDataInstance({
      ...common,
      state: 'empty',
      model: buildDataModel({ response: suppliers, filter: [{ field: 'country', op: 'eq', value: 'SE' }] }),
    });
    expect(empty).toMatchObject({ state: 'empty', matched: 0, total: 4, error: null, visibleRecordIds: [] });

    for (const d of [loading, unknownOp, forbidden, refused, empty]) {
      expect(semanticInstanceSchema.safeParse(d).success, d.state).toBe(true);
    }
    // The contract refuses descriptions whose state and counts disagree.
    expect(semanticInstanceSchema.safeParse({ ...empty, state: 'ready', matched: null }).success).toBe(false);
    expect(semanticInstanceSchema.safeParse({ ...forbidden, error: null }).success).toBe(false);
    expect(semanticInstanceSchema.safeParse({ ...loading, visibleRecordIds: ['s1'] }).success).toBe(false);
  });

  it('rejestr uiSemantics przyjmuje poprawny opis i odrzuca niepoprawny', () => {
    const model = buildDataModel({ response: suppliers });
    const good = describeDataInstance({
      instanceId: 'DataTable-rejestr',
      component: 'DataTable',
      viewId: null,
      source: { operation: 'procurement.suppliers' },
      state: 'ready',
      model,
      actions: [],
    });
    expect(registerInstance(good)).toBe(true);
    expect(listInstances().map((i) => i.instanceId)).toContain('DataTable-rejestr');
    unregisterInstance('DataTable-rejestr');
    expect(listInstances().map((i) => i.instanceId)).not.toContain('DataTable-rejestr');

    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      expect(registerInstance({ ...good, instanceId: 'zly', visibleRecordIds: Array(51).fill('x') })).toBe(false);
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
    expect(listInstances().map((i) => i.instanceId)).not.toContain('zly');
  });

  it('zmiana opisu aktualizuje wpis w miejscu: bez znikania, z ta sama kolejnoscia', () => {
    const describe = (instanceId: string, state: 'loading' | 'ready', model = buildDataModel({ response: suppliers })) =>
      describeDataInstance({
        instanceId,
        component: 'DataTable',
        viewId: null,
        source: { operation: 'procurement.suppliers' },
        state,
        model: state === 'ready' ? model : null,
        actions: [],
      });
    const a = createInstanceDescriber();
    const b = createInstanceDescriber();
    a.update(describe('DataTable-A', 'loading'));
    b.update(describe('DataTable-B', 'loading'));

    // Every state the store passes through while A changes content.
    const snapshots: string[][] = [];
    const stop = useUiSemantics.subscribe((st) => snapshots.push(st.order.filter((id) => id.startsWith('DataTable-'))));
    try {
      a.update(describe('DataTable-A', 'ready'));
      a.update(describe('DataTable-A', 'ready')); // same content: no change at all
      a.update(
        describe(
          'DataTable-A',
          'ready',
          buildDataModel({ response: suppliers, filter: [{ field: 'country', op: 'eq', value: 'FI' }] }),
        ),
      );
    } finally {
      stop();
    }
    expect(snapshots).toEqual([
      ['DataTable-A', 'DataTable-B'],
      ['DataTable-A', 'DataTable-B'],
    ]);
    const ids = () => listInstances().map((i) => i.instanceId).filter((id) => id.startsWith('DataTable-'));
    expect(ids()).toEqual(['DataTable-A', 'DataTable-B']);
    expect(listInstances().find((i) => i.instanceId === 'DataTable-A')!.matched).toBe(1);

    // A new identity replaces the old entry; unmounting removes it.
    a.update(describe('DataTable-A2', 'loading'));
    expect(ids()).toEqual(['DataTable-B', 'DataTable-A2']);
    a.dispose();
    b.dispose();
    expect(ids()).toEqual([]);

    // A refused description does not leave the previous, now untrue one behind.
    const c = createInstanceDescriber();
    c.update(describe('DataTable-C', 'loading'));
    const original = console.error;
    console.error = () => {};
    try {
      c.update({ ...describe('DataTable-C', 'loading'), matched: 5 });
    } finally {
      console.error = original;
    }
    expect(ids()).toEqual([]);
    c.dispose();
  });

  it('wykres: serie liczbowe w jednej jednostce, zakres jak w komorce tabeli', () => {
    const pln = [{ field: 'currency', op: 'eq' as const, value: 'PLN' }];
    const data = buildDataModel({ response: comparison, fieldNames: ['supplierName', 'totalMinor'], filter: pln });
    const chart = buildChartModel(data, 'supplierName', ['totalMinor']);
    const totals = data.records.map((r) => r.totalMinor as number | null).filter((v): v is number => v !== null);
    expect(totals.length).toBeGreaterThan(1);
    const [series] = chart.series;
    expect(series!.unit).toBe('PLN');
    expect(series!.range!.min).toBe(Math.min(...totals) / 100);
    expect(series!.range!.max).toBe(Math.max(...totals) / 100);
    const totalField = data.descriptor.fields.find((x) => x.field === 'totalMinor')!;
    expect(series!.range!.maxText).toBe(
      formatFieldValue({ totalMinor: Math.max(...totals), currency: 'PLN' }, totalField),
    );
    expect(chart.labels).toEqual(data.records.map((r) => r.supplierName));

    // The fixture has an offer in EUR: one axis cannot hold both.
    const mixed = buildDataModel({ response: comparison, fieldNames: ['supplierName', 'totalMinor'] });
    expect(() => buildChartModel(mixed, 'supplierName', ['totalMinor'])).toThrowError(/laczy rozne jednostki/);
    expect(() => buildChartModel(mixed, 'totalMinor', ['supplierName'])).toThrowError(/nie jest liczbowe/);
    expect(
      dataChartPropsSchema.safeParse({ source: { operation: 'x.y' }, kind: 'pie', x: 'a', series: ['b', 'c'] }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('artefakty live i odczyt danych maja jedna sciezke', () => {
  it('ta sama odmowa przy zapisie artefaktu i w POST /api/read', async () => {
    const descriptor = { operation: 'procurement.case_overview', input: { caseId: 42 } };
    let artifactError: AppError | null = null;
    try {
      h.platform.services.artifacts.assertLiveSourceIsResolvable(descriptor);
    } catch (e) {
      artifactError = e as AppError;
    }
    const res = await read(descriptor);
    expect(artifactError?.message).toBe(res.body.error.message);
    expect((artifactError?.details as any).reason).toBe('invalid_input');
  });

  it('artefakt ze zdjeta operacja jest niedostepny, a ze zlym wejsciem nieudany', async () => {
    const make = (content: unknown) =>
      h.platform.services.artifacts.create({
        ownerId: h.ownerId,
        kind: 'table',
        mode: 'live',
        title: 't',
        rendererType: 'x',
        content,
      }).meta.id;
    const gone = await h.platform.services.artifacts.resolveLive(make({ operation: 'procurement.usunieta' }), h.ownerId);
    expect(gone.live.state).toBe('unavailable');
    expect(gone.live.operation).toBe('procurement.usunieta');
    const stale = await h.platform.services.artifacts.resolveLive(
      make({ operation: 'procurement.comparison', input: { caseId: 1 } }),
      h.ownerId,
    );
    expect(stale.live.state).toBe('failed');
    expect(stale.content).toBeNull();
  });
});

describe('szew narzedzi i prompt', () => {
  it('podzial narzedzi platformy zachowuje nazwy i kolejnosc', () => {
    expect(platformTools(h.platform.services).map((t) => t.name)).toEqual([
      'get_context',
      'canvas_list_cards',
      'canvas_catalog',
      'canvas_add_card',
      'canvas_update_card',
      'canvas_move_card',
      'canvas_remove_card',
      'ui_catalog',
      'ui_navigate',
      'ui_filter',
      'ui_state',
      'files_list',
      'files_stage',
      'files_publish_version',
      'files_versions',
      'workspace_outputs',
      'artifact_create',
      'artifact_publish_file',
    ]);
  });

  it('schematy propsow komponentow danych mozna wystawic modelowi przez MCP', () => {
    // No z.record(), no .default(): the same guard every tool input passes.
    for (const [name, schema] of Object.entries(DATA_COMPONENT_PROPS)) {
      expect(() => assertMcpCompatibleShape(name, schema.shape as Record<string, unknown>)).not.toThrow();
    }
  });

  it('prompt wypisuje pola deskryptora operacji odczytu', () => {
    const prompt = buildSystemPrompt({
      registry: h.platform.registry,
      catalog: h.platform.services.catalog,
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
      resourceSummary: null,
      workspaceDir: null,
      stagedFiles: [],
      toolkit: [],
    });
    const line = prompt.split('\n').findIndex((l) => l.startsWith('- procurement.suppliers:'));
    expect(line).toBeGreaterThan(-1);
    const fieldsLine = prompt.split('\n')[line + 1]!;
    expect(fieldsLine).toContain('rekordy kolekcji suppliers (rodzaj supplier, id: id) maja pola:');
    expect(fieldsLine).toContain('country: Kraj, text');
    expect(fieldsLine).toContain('tylko te pola wskazujesz w komponentach danych');
    expect(prompt).toContain('totalMinor: Suma, money_minor');
    // The comparison result carries more than its rows (criteria, excluded, notes):
    // the prompt must not claim the listed fields are all the result has.
    expect(prompt).not.toMatch(/innych pol wynik nie ma/);
    expect(prompt).toContain('Wynik moze zawierac takze inne dane poza ta kolekcja');
  });
});

describe('pamiec podreczna odczytow', () => {
  it('klucz odczytu zawiera tozsamosc, operacje i wejscie niezalezne od kolejnosci kluczy', () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    const a = qk.read('m.op', { b: 1, a: { d: 2, c: 3 } });
    expect(a[0]).toBe('read');
    expect(a).toEqual(qk.read('m.op', { a: { c: 3, d: 2 }, b: 1 }));
    expect(a).not.toEqual(qk.read('m.op', { a: 1 }));
    setAccessContext(qc, 'other-user');
    expect(qk.read('m.op', { b: 1, a: { d: 2, c: 3 } })).not.toEqual(a);
  });

  it('zmiana danych i koniec wykonania uniewazniaja odczyty komponentow danych', async () => {
    for (const trigger of [
      { type: AGUI_EVENTS.CUSTOM, name: PLATFORM_CUSTOM_EVENTS.dataChanged, value: { resources: ['x'] } },
      { type: AGUI_EVENTS.RUN_FINISHED, runId: 'run_1' },
    ]) {
      const qc = new QueryClient();
      setAccessContext(qc, 'local-user');
      qc.setQueryData(qk.read('m.op', {}), { result: [] });
      applyRunEvent('cnv_1', { type: AGUI_EVENTS.RUN_STARTED, runId: 'run_1' }, { qc, isActive: () => true });
      applyRunEvent('cnv_1', trigger, { qc, isActive: () => true });
      const stale = qc.getQueryCache().getAll().filter((q) => q.state.isInvalidated).map((q) => q.queryKey[0]);
      expect(stale).toContain('read');
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('krok skryptowany call wywoluje prawdziwy handler', () => {
  /** Plays steps through the real runtime and returns what the run emitted. */
  async function play(steps: Step[]) {
    const runtime = new AgentRuntime(
      h.platform.services,
      scriptedAgent(steps, {
        tools: () => collectToolEntries({ registry: h.platform.registry, platformTools: platformTools(h.platform.services) }),
      }),
    );
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, firstMessage: { content: 'test' } });
    const space = h.platform.services.canvas.createSpace({ ownerId: h.ownerId, title: `call ${Date.now()}` });
    const started = await runtime.start({
      ownerId: h.ownerId,
      conversationId: conv.id,
      prompt: 'test',
      appContext: {
        conversationId: conv.id,
        spaceId: space.id,
        resource: null,
        selection: [],
        filters: {},
        viewport: null,
        drafts: [],
        ui: null,
      },
    });
    const events: Array<Record<string, any>> = [];
    for await (const { event } of started.stream.read(0)) events.push(event as Record<string, any>);
    await started.done;
    const text = events.filter((e) => e.type === AGUI_EVENTS.TEXT_MESSAGE_CONTENT).map((e) => e.delta).join('');
    return { events, text, spaceId: space.id };
  }

  it('narzedzie zapisu dziala naprawde: karta istnieje w bazie z identyfikatorem z wyniku', async () => {
    const { events, text, spaceId } = await play([
      {
        kind: 'call',
        name: 'mcp__app__canvas_add_card',
        input: { title: 'Z kroku call', spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'x' } } },
      },
    ]);
    const start = events.find((e) => e.type === AGUI_EVENTS.TOOL_CALL_START);
    expect(start?.toolCallName).toBe('mcp__app__canvas_add_card');
    const result = events.find((e) => e.type === AGUI_EVENTS.TOOL_CALL_RESULT && e.toolCallId === start!.toolCallId);
    expect(result?.isError).toBeUndefined();
    const { cardId } = JSON.parse(result!.content);
    // The handler ran with the run's context: the card is in the run's space.
    const cards = h.platform.services.canvas.getState(spaceId, h.ownerId).cards;
    expect(cards.map((c) => c.id)).toContain(cardId);
    expect(text).toContain(`[call:canvas_add_card] {"cardId":"${cardId}"`);
    // Its event went onto the run's stream like any tool's.
    expect(events.some((e) => e.type === AGUI_EVENTS.CUSTOM && e.name === PLATFORM_CUSTOM_EVENTS.canvasChanged)).toBe(true);
  });

  it('odczyt modulu zwraca dane z bazy, a bledne wejscie i nieznane narzedzie sa bledem narzedzia', async () => {
    const { events, text } = await play([
      { kind: 'call', name: 'procurement_list_cases' },
      { kind: 'call', name: 'procurement_get_case', input: { caseId: 7 } },
      { kind: 'call', name: 'nie_ma_takiego' },
    ]);
    const results = events.filter((e) => e.type === AGUI_EVENTS.TOOL_CALL_RESULT);
    expect(results).toHaveLength(3);
    expect(JSON.parse(results[0]!.content).cases[0].code).toBe('PC-2026-01');
    expect(results[1]!.isError).toBe(true);
    expect(JSON.parse(results[1]!.content).error).toBe('validation_failed');
    expect(results[2]!.isError).toBe(true);
    expect(text).toContain('[call:procurement_list_cases] {"cases":[');
    expect(text).toContain('[call:nie_ma_takiego] {"error":"not_found"');
  });
});
