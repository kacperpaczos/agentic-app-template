import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { ReadResultDescriptor } from '@platform/contracts';
import { OpenUiServerCatalog } from '@platform/server';
import { createProcurementModule } from '@module/procurement/server';
import { procurementUiModule } from '@module/procurement/ui';
import { buildRegistry, groupRecords, platformCardRenderers, readGate, withGrouping } from '@platform/ui';
import { buildDataModel } from '../packages/platform-ui/src/views/model.ts';
import { createHarness } from './helpers.ts';

/**
 * The browser's OpenUI catalog and the server's are the same catalog.
 *
 * Test kontraktu lub logiki. The server validates compositions against a
 * catalog it assembles without React: a generated copy of the ready-made
 * library's schema, the data components' and the modules' declared props. If
 * that drifted from what the browser renders, a composition could be accepted
 * and not render, or refused and render fine — and a different argument order
 * would put a value into the wrong prop. So the names, and each component's
 * parameters in order, are compared with the library the application builds.
 *
 * Also here: the browser-side rules added with agent views — grouping rows and
 * the gate that keeps half-streamed sources from reaching `POST /api/read`.
 */

describe('zgodnosc katalogu OpenUI przegladarki i serwera', () => {
  it('te same komponenty i te same parametry w tej samej kolejnosci', async () => {
    const h = await createHarness({ seed: false });
    try {
      const browser = buildRegistry({
        modules: [procurementUiModule],
        platformCardRenderers,
        platformMenu: [],
      }).library;
      const server = new OpenUiServerCatalog(createProcurementModule(h.platform.services).openuiComponents);

      const browserDefs = browser.toJSONSchema().$defs ?? {};
      const serverDefs = server.schema.$defs ?? {};
      expect(Object.keys(serverDefs).sort()).toEqual(Object.keys(browserDefs).sort());
      expect(server.root).toBe(browser.root);
      for (const [name, def] of Object.entries(browserDefs)) {
        // Key order is the positional argument order: compared explicitly, since
        // deep equality does not look at it.
        expect(Object.keys(serverDefs[name]!.properties ?? {}), name).toEqual(Object.keys(def.properties ?? {}));
        expect(serverDefs[name], name).toEqual(def);
      }
      // The procurement module's own components are on both sides.
      expect(Object.keys(serverDefs)).toEqual(expect.arrayContaining(['OfferComparison', 'OfferCostChart', 'DataTable']));
      // And the platform's live catalog is built from the same declarations.
      expect(h.platform.services.catalog.openui.names().sort()).toEqual(Object.keys(browserDefs).sort());
    } finally {
      h.dispose();
    }
  });

  it('wygenerowana kopia schematu gotowej biblioteki jest aktualna', async () => {
    const uiRequire = createRequire(new URL('../packages/platform-ui/package.json', import.meta.url));
    const { openuiLibrary } = (await import(uiRequire.resolve('@openuidev/react-ui'))) as {
      openuiLibrary: { root: string; toJSONSchema(): { $defs: Record<string, unknown> } };
    };
    const copy = (await import('../packages/platform-server/src/registry/openui-library.schema.json', { with: { type: 'json' } }))
      .default as { root: string; $defs: Record<string, unknown> };
    expect(copy.root).toBe(openuiLibrary.root);
    // `node scripts/openui-library-schema.mjs` regenerates the copy.
    expect(copy.$defs).toEqual(openuiLibrary.toJSONSchema().$defs);
  });
});

describe('grupowanie wierszy tabeli', () => {
  const descriptor: ReadResultDescriptor = {
    collection: 'rows',
    record: { kind: 'thing', idField: 'id' },
    fields: [
      { field: 'name', label: 'Nazwa', type: 'text' },
      { field: 'basis', label: 'Ceny', type: 'enum', values: [{ value: 'net', label: 'netto' }, { value: 'gross', label: 'brutto' }] },
      { field: 'total', label: 'Suma', type: 'money_minor', unitField: 'currency' },
      { field: 'currency', label: 'Waluta', type: 'text' },
    ],
  };
  const rows = [
    { id: '1', name: 'A', basis: 'net', total: 100, currency: 'PLN' },
    { id: '2', name: 'B', basis: 'gross', total: 100, currency: 'EUR' },
    { id: '3', name: 'C', basis: 'net', total: 100, currency: 'PLN' },
    { id: '4', name: 'D', basis: null, total: 250, currency: 'PLN' },
  ];
  const model = () =>
    buildDataModel({ response: { operation: 'm.rows', result: { rows }, descriptor, resolvedAt: '' } });

  it('grupy w kolejnosci tabeli, z etykieta jak w komorce i liczba rekordow', () => {
    const groups = groupRecords(rows, descriptor.fields[1]!);
    expect(groups.map((g) => [g.label, g.records.map((r) => r.id)])).toEqual([
      ['netto', ['1', '3']],
      ['brutto', ['2']],
      ['—', ['4']],
    ]);
  });

  it('ta sama kwota w roznych walutach to rozne grupy', () => {
    const groups = groupRecords(rows, descriptor.fields[2]!);
    expect(groups.map((g) => [g.key, g.label, g.records.length])).toEqual([
      ['100|PLN', '1,00 PLN', 2],
      ['100|EUR', '1,00 EUR', 1],
      ['250|PLN', '2,50 PLN', 1],
    ]);
  });

  it('pole grupowania spoza deskryptora jest odrzucane z nazwa; brak grupowania to brak grup', () => {
    expect(() => withGrouping(model(), 'kraj')).toThrowError(/Pola kraj nie sa zadeklarowane/);
    expect(withGrouping(model(), null).grouping).toBeNull();
    expect(withGrouping(model(), 'basis').grouping!.groups).toHaveLength(3);
  });
});

describe('bramka odczytu komponentu danych', () => {
  const operations = [{ name: 'procurement.comparison' }, { name: 'procurement.suppliers' }];

  it('zrodlo w trakcie strumieniowania nie wysyla zapytania o niepelna nazwe operacji', () => {
    // What the renderer hands a data component while `DataTable({operation: "procurement.supp` streams in.
    const partial = ['p', 'procurement.', 'procurement.supp'].map((operation) => readGate({ operation }, operations));
    expect(partial.map((g) => g.kind)).toEqual(['refuse', 'refuse', 'refuse']);
    expect(readGate({ operation: 'procurement.suppliers' }, operations).kind).toBe('fetch');
  });

  it('nic nie jest wysylane przed poznaniem listy operacji ani z nierozstrzygnietym parametrem', () => {
    expect(readGate({ operation: 'procurement.suppliers' }, undefined).kind).toBe('wait');
    expect(readGate({ operation: '' }, operations).kind).toBe('wait');
    expect(readGate({ operation: 'procurement.comparison', input: { caseId: undefined } }, operations).kind).toBe('wait');
    // A list that cannot be read leaves the decision to the backend.
    expect(readGate({ operation: 'procurement.suppliers' }, undefined, true).kind).toBe('fetch');
  });

  it('nieznana operacja jest bledem z tresca odmowy backendu, nie wiecznym ladowaniem', () => {
    const gate = readGate({ operation: 'nie.istnieje' }, operations);
    expect(gate.kind).toBe('refuse');
    expect(gate.kind === 'refuse' && gate.error.message).toMatch(/^Nieznana operacja odczytu "nie.istnieje"/);
    expect(gate.kind === 'refuse' && (gate.error.details as { reason: string }).reason).toBe('unknown_operation');
  });
});
