import type { ReadResultDescriptor, ViewDefinition } from '@platform/contracts';
import { MODULE_ID, PRICE_BASIS_LABELS } from '../shared/index.ts';

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
    // An address is a way to reach somebody, not a thing to put suppliers in order by.
    { field: 'contactEmail', label: 'Kontakt', type: 'text', sortable: false },
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
      values: PRICE_BASIS_LABELS,
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
      values: PRICE_BASIS_LABELS,
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
    { field: 'spec', label: 'Specyfikacja', type: 'text', sortable: false },
  ],
};

/**
 * One offer item, flattened across every offer of a case, with the supplier
 * and currency that would otherwise only be known from its parent offer.
 *
 * `idField` is the item's own id ("idField pozycji" from the brief): a case
 * has several offers and each offer several items, so nothing shorter than the
 * item itself identifies a row of this table uniquely.
 */
export const caseOfferItemRecords: ReadResultDescriptor = {
  collection: 'items',
  // `titleField` names the item in each row's action button for a screen reader.
  record: { kind: 'offer_item', idField: 'id', titleField: 'name' },
  fields: [
    { field: 'supplierName', label: 'Dostawca', type: 'text', sortable: true },
    { field: 'name', label: 'Nazwa', type: 'text', sortable: true },
    { field: 'unit', label: 'Jednostka', type: 'text' },
    { field: 'quantityMilli', label: 'Ilosc', type: 'quantity_milli', unitField: 'unit' },
    { field: 'unitPriceMinor', label: 'Cena jednostkowa', type: 'money_minor', unitField: 'currency' },
    { field: 'currency', label: 'Waluta', type: 'text', sortable: true },
  ],
  /*
   * Changing an item's unit price from any table over this read — the case
   * screen's and every agent view's — through `update_offer_item`, the tool the
   * agent calls. The tool takes the price in whole currency units (`unitPrice`,
   * converted to grosze by the service), so the form field is a `number`, typed
   * the way the table prints it (`12 400,50`).
   */
  actions: [
    {
      id: 'change_unit_price',
      label: 'Zmien cene',
      tool: 'update_offer_item',
      input: [
        { key: 'itemId', from: '$record.id' },
        { key: 'unitPrice', from: '$form.unitPrice' },
      ],
      form: [{ key: 'unitPrice', label: 'Nowa cena jednostkowa', type: 'number' }],
    },
  ],
};

const op = (name: string) => `${MODULE_ID}.${name}`;

/*
 * The screens. Each is an OpenUI Lang program over the shared catalog: the
 * table is the platform's `DataTable`, bound to a registered read, so it holds
 * no data of its own and shows exactly what `POST /api/read` returns for the
 * signed-in owner. Positional arguments follow `dataTablePropsSchema`:
 * `DataTable(source, columns, title, pageSize, filter, sort, groupBy)`; `null` skips an
 * optional one (here the title — the page has its own heading).
 *
 * The two detail screens below are reached from a record's own `route` (the
 * case's title link, the "pochodzenie" link of an item), never from the left
 * navigation, so — unlike `procurement.data` and `procurement.cases` — they
 * name no `primaryOperation` and have no matching `UiTarget`: there is nothing
 * to narrow on a screen that already names one record.
 */

/** Rows per page of a list screen; its narrowing, order and page live in the address. */
const LIST_PAGE_SIZE = 10;
export const procurementViews: ViewDefinition[] = [
  {
    id: 'procurement.data',
    title: 'Dostawcy',
    primaryOperation: op('suppliers'),
    composition: [
      'root = Stack([lead, suppliers])',
      'lead = TextContent("Dostawcy zarejestrowani w aplikacji.")',
      `suppliers = DataTable({operation: "${op('suppliers')}"}, ["name", "taxId", "country", "contactEmail"], null, ${LIST_PAGE_SIZE})`,
    ].join('\n'),
  },
  {
    id: 'procurement.cases',
    title: 'Wszystkie sprawy',
    primaryOperation: op('cases'),
    composition: [
      'root = Stack([lead, cases])',
      'lead = TextContent("Kazda sprawa ustala podstawe porownania: walute i to, czy ceny sa netto czy brutto.")',
      `cases = DataTable({operation: "${op('cases')}"}, ["code", "title", "status", "currency", "priceBasis", "offerCount", "requirementCount"], null, ${LIST_PAGE_SIZE})`,
    ].join('\n'),
  },
  {
    id: 'procurement.case.detail',
    title: 'Szczegoly sprawy',
    params: ['caseId'],
    composition: [
      'root = Stack([header, reqHeading, requirements, offersHeading, offerItems, offerSources])',
      'header = CaseHeader($caseId)',
      'reqHeading = SectionHeading("Pozycje wymagane")',
      `requirements = DataTable({operation: "${op('case_overview')}", input: {caseId: $caseId}}, ["position", "name", "quantityMilli", "spec"])`,
      'offersHeading = SectionHeading("Oferty")',
      `offerItems = DataTable({operation: "${op('case_offer_items')}", input: {caseId: $caseId}}, ["supplierName", "name", "unit", "quantityMilli", "unitPriceMinor", "currency"])`,
      'offerSources = CaseOfferSources($caseId)',
    ].join('\n'),
  },
  {
    id: 'procurement.item.provenance',
    title: 'Pochodzenie wartosci',
    params: ['itemId'],
    composition: 'root = ItemProvenance($itemId)',
  },
];
