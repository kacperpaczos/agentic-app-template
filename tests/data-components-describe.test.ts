import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  semanticInstanceSchema,
  type ReadResponse,
  type ReadResultDescriptor,
  type SemanticInstance,
} from '@platform/contracts';

/**
 * What the data components themselves register, in each state they can be in.
 *
 * The description builder is tested on its own elsewhere; this checks the
 * components' wiring — which model, which state and which limit each passes —
 * because that is where a wrong count was introduced once (a summary handing a
 * truncated model to the builder and so reporting 20 matched of 30).
 *
 * No DOM: the components are rendered to a string, with the read already in
 * (or deliberately absent from, or failed in) the query cache. `useDescribeInstance`
 * is replaced by a recorder, so the description the component computes during
 * render is captured as it would be registered; the address-bar narrowing hook
 * is replaced by "none", since there is no router here.
 */

const recorded = vi.hoisted(() => [] as SemanticInstance[]);
/** The address state `useViewAddress` hands the table; null outside a view's own screen. */
const address = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../packages/platform-ui/src/state/uiSemantics.ts', () => ({
  useDescribeInstance: (d: SemanticInstance | null) => {
    if (d) recorded.push(d);
  },
}));
vi.mock('../packages/platform-ui/src/state/viewFilter.ts', () => ({
  useActiveViewFilter: () => null,
  useViewAddress: (viewId: string | null) => (viewId ? address.current : null),
}));

const { DataSummaryView } = await import('../packages/platform-ui/src/views/DataSummary.tsx');
const { DataTableView } = await import('../packages/platform-ui/src/views/DataTable.tsx');
const { DataChartView } = await import('../packages/platform-ui/src/views/DataChart.tsx');
const { ComposedViewContext } = await import('../packages/platform-ui/src/views/viewContext.ts');
const { setAccessContext } = await import('../packages/platform-ui/src/api/accessContext.ts');
const { qk } = await import('../packages/platform-ui/src/api/queries.ts');

const uiRequire = createRequire(new URL('../packages/platform-ui/package.json', import.meta.url));
const { createElement } = uiRequire('react') as { createElement: (...args: unknown[]) => unknown };
const { renderToString } = uiRequire('react-dom/server') as { renderToString: (el: unknown) => string };

const descriptor: ReadResultDescriptor = {
  collection: 'things',
  record: { kind: 'thing', idField: 'id', titleField: 'name' },
  fields: [
    { field: 'name', label: 'Nazwa', type: 'text' },
    { field: 'total', label: 'Suma', type: 'money_minor', unitField: 'currency' },
    { field: 'currency', label: 'Waluta', type: 'text' },
  ],
};

const response = (count: number): ReadResponse => ({
  operation: 'm.things',
  resolvedAt: new Date(0).toISOString(),
  descriptor,
  result: {
    things: Array.from({ length: count }, (_, i) => ({ id: `t${i}`, name: `n${i}`, total: 100 * (i + 1), currency: 'PLN' })),
  },
});

type CacheState = { data: ReadResponse } | { error: AppError } | null;

/** Renders one component over a prepared cache and returns its last description and markup. */
function render(
  component: unknown,
  props: Record<string, unknown>,
  cache: CacheState,
  view: { viewId: string; primaryOperation: string | null } | null = null,
) {
  // `retryOnMount: false` keeps a failed query failed during a render with no
  // effects; otherwise the observer optimistically reports a refetch (pending).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  setAccessContext(qc, 'local-user');
  const source = props.source as { operation: string; input?: Record<string, unknown> };
  const key = qk.read(source.operation, source.input ?? {});
  if (cache && 'data' in cache) qc.setQueryData(key, cache.data);
  if (cache && 'error' in cache) {
    const query = qc.getQueryCache().build(qc, { queryKey: key });
    query.setState({ ...query.state, status: 'error', error: cache.error, errorUpdatedAt: Date.now(), fetchStatus: 'idle' });
  }
  recorded.length = 0;
  const inner = createElement(component, props);
  const html = renderToString(
    createElement(
      QueryClientProvider,
      { client: qc },
      view ? createElement(ComposedViewContext.Provider, { value: view }, inner) : inner,
    ),
  );
  const description = recorded.at(-1)!;
  expect(description, 'komponent nie zglosil opisu').toBeTruthy();
  expect(semanticInstanceSchema.safeParse(description).success, JSON.stringify(description)).toBe(true);
  const frameState = /data-state="([a-z]+)"/.exec(html)?.[1];
  // What the component says about itself is what its frame shows.
  expect(description.state).toBe(frameState);
  return { description, html };
}

const source = { operation: 'm.things' };

describe('DataSummary', () => {
  it('rysuje 20 z 30 rekordow, ale podaje 30 dopasowanych i 30 wszystkich', () => {
    const { description, html } = render(DataSummaryView, { source, fields: ['name', 'total'] }, { data: response(30) });
    expect(description.state).toBe('ready');
    expect(description.matched).toBe(30);
    expect(description.total).toBe(30);
    expect(description.filter).toEqual([]);
    expect(description.visibleRecordIds).toHaveLength(20);
    expect((html.match(/<dl /g) ?? []).length).toBe(20);
  });

  it('blad odczytu opisuje jako blad z kodem, bez liczb', () => {
    const { description } = render(
      DataSummaryView,
      { source, fields: ['name'] },
      { error: new AppError('validation_failed', 'Nieznana operacja odczytu "m.things".') },
    );
    expect(description).toMatchObject({
      state: 'error',
      error: { code: 'validation_failed', message: 'Nieznana operacja odczytu "m.things".' },
      record: null,
      matched: null,
      total: null,
    });
  });
});

describe('DataTable', () => {
  it('ladowanie: stan loading, nic nie policzone', () => {
    const { description } = render(DataTableView, { source, columns: ['name'] }, null);
    expect(description).toMatchObject({ state: 'loading', error: null, record: null, matched: null, total: null });
  });

  it('gotowa: wszystkie rekordy policzone i wymienione (do limitu)', () => {
    const { description } = render(DataTableView, { source, columns: ['name', 'total'] }, { data: response(3) });
    expect(description).toMatchObject({ state: 'ready', matched: 3, total: 3, record: { kind: 'thing', idField: 'id' } });
    expect(description.visibleRecordIds).toEqual(['t0', 't1', 't2']);
    expect(description.fields).toEqual([
      { field: 'name', label: 'Nazwa', type: 'text' },
      { field: 'total', label: 'Suma', type: 'money_minor', unit: 'PLN' },
    ]);
  });

  it('pusta po zawezeniu kompozycji: stan empty, 0 z N', () => {
    const { description } = render(
      DataTableView,
      { source, filter: [{ field: 'currency', op: 'eq', value: 'EUR' }] },
      { data: response(3) },
    );
    expect(description).toMatchObject({ state: 'empty', matched: 0, total: 3, visibleRecordIds: [] });
    expect(description.filter).toEqual([{ field: 'currency', op: 'eq', value: 'EUR' }]);
  });

  it('brak dostepu: stan forbidden z kodem', () => {
    const { description } = render(
      DataTableView,
      { source },
      { error: new AppError('forbidden', 'Zasob nalezy do innego wlasciciela.') },
    );
    expect(description).toMatchObject({ state: 'forbidden', error: { code: 'forbidden' }, matched: null });
  });

  it('kompozycja odrzucona po odpowiedzi: blad, a rekord i znane pola z deskryptora', () => {
    const { description } = render(
      DataTableView,
      { source, columns: ['name', 'wojewodztwo'] },
      { data: response(3) },
    );
    expect(description.state).toBe('error');
    expect(description.error!.message).toMatch(/wojewodztwo/);
    expect(description.record).toEqual({ kind: 'thing', idField: 'id' });
    expect(description.fields.map((f) => f.field)).toEqual(['name']);
  });
});

describe('DataTable ze stronami i stanem widoku', () => {
  it('tabela poza widokiem z pageSize: pierwsza strona, opis z page i tylko narysowanymi rekordami', () => {
    const { description, html } = render(DataTableView, { source, columns: ['name'], pageSize: 10 }, { data: response(23) });
    expect(description).toMatchObject({ state: 'ready', matched: 23, total: 23, page: { index: 1, size: 10, count: 3 } });
    expect(description.visibleRecordIds).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']);
    expect((html.match(/<tr data-record-kind/g) ?? []).length).toBe(10);
    expect(html).toContain('Strona <!-- -->1<!-- --> z <!-- -->3');
    // Outside a view's own screen there is nothing to narrow or order from the address.
    expect(html).not.toContain('data-testid="view-filter-controls"');
    expect(html).not.toContain('data-sort-field');
  });

  it('instancja glowna: kontrolki pokazuja stan z adresu — aria-sort, wartosc pola, strona', () => {
    address.current = {
      targetId: 'm.view',
      filterFields: [
        { field: 'currency', label: 'Waluta', values: ['PLN', 'EUR'] },
        { field: 'name', label: 'Nazwa rekordu' },
      ],
      predicates: [
        { field: 'currency', op: 'eq', value: 'PLN' },
        { field: 'name', op: 'contains', value: 'n1' },
      ],
      sort: { field: 'name', direction: 'desc' },
      page: 2,
      key: 'k',
      change: () => {},
    };
    try {
      const { description, html } = render(
        DataTableView,
        { source, columns: ['name', 'total'], pageSize: 5 },
        { data: response(30) },
        { viewId: 'm.view', primaryOperation: 'm.things' },
      );
      // n1, n10…n19: eleven records; descending by name n19…n10, n1 — the second page of three is n14…n10.
      expect(description).toMatchObject({
        state: 'ready',
        matched: 11,
        total: 30,
        sort: { field: 'name', direction: 'desc' },
        page: { index: 2, size: 5, count: 3 },
      });
      expect(description.visibleRecordIds).toEqual(['t14', 't13', 't12', 't11', 't10']);
      expect(description.actions).toEqual(expect.arrayContaining(['filter', 'sort', 'page']));
      expect(html).toMatch(/<th scope="col" data-field="name" aria-sort="descending"><button type="button" class="pf-sort" data-sort-field="name">Nazwa<\/button><\/th>/);
      expect(html).toMatch(/<th scope="col" data-field="total" aria-sort="none">/);
      expect(html).toMatch(/<option value="PLN" selected="">PLN<\/option>/);
      expect(html).toMatch(/<input[^>]*name="name"[^>]*value="n1"/);
      expect(html).toContain('Strona <!-- -->2<!-- --> z <!-- -->3');
    } finally {
      address.current = null;
    }
  });
});

describe('DataTable z akcjami rekordu', () => {
  const withActions: ReadResponse = {
    ...response(2),
    descriptor: {
      ...descriptor,
      actions: [
        {
          id: 'set_total',
          label: 'Zmien sume',
          tool: 'save',
          input: [
            { key: 'id', from: '$record.id' },
            { key: 'total', from: '$form.total' },
          ],
          form: [{ key: 'total', label: 'Nowa suma', type: 'money_minor' }],
        },
      ],
    },
  };

  it('kazdy wiersz ma przycisk akcji nazwany rekordem, opis wymienia action:<id>', () => {
    const { description, html } = render(DataTableView, { source, columns: ['name', 'total'] }, { data: withActions });
    expect(description.state).toBe('ready');
    expect(description.actions).toContain('action:set_total');
    expect(html).toContain('<th scope="col" class="pf-table__actions">Akcje</th>');
    for (const [id, name] of [['t0', 'n0'], ['t1', 'n1']]) {
      expect(html).toMatch(
        new RegExp(
          `<tr data-record-kind="thing" data-record-id="${id}">.*?<td class="pf-table__actions"><div class="pf-record-action__buttons">` +
            `<button type="button" class="pf-btn pf-btn--tiny" data-record-action="set_total" aria-label="Zmien sume: ${name}">Zmien sume</button>`,
        ),
      );
    }
    // Value cells keep their attributes; the actions cell is not a field.
    expect((html.match(/data-field=/g) ?? []).length).toBe(2 * 2 + 2);
    // Not refreshing: nothing claims the rows are being re-read.
    expect(html).not.toContain('data-refreshing');

    // Grouped, the group heading spans the actions column too.
    const grouped = render(DataTableView, { source, columns: ['name', 'total'], groupBy: 'currency' }, { data: withActions });
    expect(grouped.html).toContain('<th colSpan="3" scope="rowgroup">');
  });

  it('tabela odczytu bez akcji nie ma kolumny akcji ani action:* w opisie', () => {
    const { description, html } = render(DataTableView, { source, columns: ['name'] }, { data: response(2) });
    expect(html).not.toContain('Akcje');
    expect(html).not.toContain('data-record-action');
    expect(description.actions.filter((a) => a.startsWith('action:'))).toEqual([]);
  });
});

describe('DataChart', () => {
  it('odrzucona seria nieliczbowa: blad z przyczyna', () => {
    const { description } = render(
      DataChartView,
      { source, kind: 'bar', x: 'name', series: ['currency'] },
      { data: response(3) },
    );
    expect(description).toMatchObject({ state: 'error', error: { code: 'validation_failed' }, matched: null });
    expect(description.error!.message).toMatch(/nie jest liczbowe/);
  });

  it('ladowanie wykresu: stan loading', () => {
    const { description } = render(DataChartView, { source, kind: 'bar', x: 'name', series: ['total'] }, null);
    expect(description.state).toBe('loading');
  });
});
