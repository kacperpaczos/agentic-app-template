import type { ReadResultDescriptor, ViewDefinition } from '@platform/contracts';
import { MODULE_ID } from '../shared/index.ts';

/**
 * What this module's reads return and how its screens are composed from them.
 *
 * The descriptors are the only place the platform learns what a supplier or a
 * case record holds: which property identifies it, what each column is called,
 * that a total is stored in grosze with its currency beside it. The data
 * components, the startup checks and the agent's prompt all read them from
 * here, so a column name is written once.
 */

export const supplierRecords: ReadResultDescriptor = {
  collection: 'suppliers',
  record: { kind: 'supplier', idField: 'id', titleField: 'name' },
  fields: [
    { field: 'name', label: 'Nazwa', type: 'text', sortable: true },
    { field: 'taxId', label: 'NIP', type: 'text' },
    { field: 'country', label: 'Kraj', type: 'text', sortable: true },
    { field: 'contactEmail', label: 'Kontakt', type: 'text' },
  ],
};

export const caseRecords: ReadResultDescriptor = {
  collection: 'cases',
  record: { kind: 'case', idField: 'id', titleField: 'title', route: '/cases/{id}' },
  fields: [
    { field: 'code', label: 'Kod', type: 'text', sortable: true },
    { field: 'title', label: 'Tytul', type: 'text', sortable: true },
    {
      field: 'status',
      label: 'Status',
      type: 'enum',
      values: [
        { value: 'draft', label: 'szkic' },
        { value: 'collecting', label: 'zbieranie ofert' },
        { value: 'decided', label: 'rozstrzygnieta' },
      ],
      sortable: true,
    },
    { field: 'currency', label: 'Waluta', type: 'text' },
    {
      field: 'priceBasis',
      label: 'Ceny',
      type: 'enum',
      values: [
        { value: 'net', label: 'netto' },
        { value: 'gross', label: 'brutto' },
      ],
    },
    { field: 'offerCount', label: 'Oferty', type: 'number', sortable: true },
    { field: 'requirementCount', label: 'Pozycje', type: 'number', sortable: true },
  ],
};

/** Rows of the comparison: one per offer, with the backend's totals and ranking. */
export const comparisonRecords: ReadResultDescriptor = {
  collection: 'rows',
  record: { kind: 'offer', idField: 'offerId', titleField: 'supplierName' },
  fields: [
    { field: 'supplierName', label: 'Dostawca', type: 'text', sortable: true },
    { field: 'reference', label: 'Referencja', type: 'text' },
    { field: 'currency', label: 'Waluta', type: 'text' },
    {
      field: 'priceBasis',
      label: 'Ceny',
      type: 'enum',
      values: [
        { value: 'net', label: 'netto' },
        { value: 'gross', label: 'brutto' },
      ],
    },
    { field: 'totalMinor', label: 'Suma', type: 'money_minor', unitField: 'currency', sortable: true },
    { field: 'completenessPct', label: 'Kompletnosc', type: 'number', unit: '%', sortable: true },
    { field: 'deliveryDays', label: 'Dostawa', type: 'number', unit: 'dni', sortable: true },
    { field: 'validUntil', label: 'Wazna do', type: 'date', sortable: true },
    { field: 'comparable', label: 'Porownywalna', type: 'boolean' },
    { field: 'score', label: 'Wynik', type: 'number', sortable: true },
    { field: 'rank', label: 'Miejsce', type: 'number', sortable: true },
  ],
};

/** The case's required lines — the part of the overview that is a list of records. */
export const requirementRecords: ReadResultDescriptor = {
  collection: 'requirements',
  record: { kind: 'requirement', idField: 'id', titleField: 'name' },
  fields: [
    { field: 'position', label: 'Lp.', type: 'number', sortable: true },
    { field: 'name', label: 'Nazwa', type: 'text', sortable: true },
    { field: 'quantityMilli', label: 'Ilosc', type: 'quantity_milli', unitField: 'unit' },
    { field: 'unit', label: 'Jednostka', type: 'text' },
    { field: 'sku', label: 'Indeks', type: 'text' },
    { field: 'spec', label: 'Specyfikacja', type: 'text' },
  ],
};

const op = (name: string) => `${MODULE_ID}.${name}`;

/*
 * The screens. Each is an OpenUI Lang program over the shared catalog: the
 * table is the platform's `DataTable`, bound to a registered read, so it holds
 * no data of its own and shows exactly what `POST /api/read` returns for the
 * signed-in owner. Positional arguments follow `dataTablePropsSchema`:
 * `DataTable(source, columns, title, pageSize, filter, sort)`.
 */
export const procurementViews: ViewDefinition[] = [
  {
    id: 'procurement.data',
    title: 'Dostawcy',
    primaryOperation: op('suppliers'),
    composition: [
      'root = Stack([lead, suppliers])',
      'lead = TextContent("Dostawcy zarejestrowani w aplikacji.")',
      `suppliers = DataTable({operation: "${op('suppliers')}"}, ["name", "taxId", "country", "contactEmail"])`,
    ].join('\n'),
  },
  {
    id: 'procurement.cases',
    title: 'Wszystkie sprawy',
    primaryOperation: op('cases'),
    composition: [
      'root = Stack([lead, cases])',
      'lead = TextContent("Kazda sprawa ustala podstawe porownania: walute i to, czy ceny sa netto czy brutto.")',
      `cases = DataTable({operation: "${op('cases')}"}, ["code", "title", "status", "currency", "priceBasis", "offerCount", "requirementCount"])`,
    ].join('\n'),
  },
];
