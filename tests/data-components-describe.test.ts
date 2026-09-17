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

vi.mock('../packages/platform-ui/src/state/uiSemantics.ts', () => ({
  useDescribeInstance: (d: SemanticInstance | null) => {
    if (d) recorded.push(d);
  },
}));
vi.mock('../packages/platform-ui/src/state/viewFilter.ts', () => ({
  useActiveViewFilter: () => null,
}));

const { DataSummaryView } = await import('../packages/platform-ui/src/views/DataSummary.tsx');
const { DataTableView } = await import('../packages/platform-ui/src/views/DataTable.tsx');
const { DataChartView } = await import('../packages/platform-ui/src/views/DataChart.tsx');
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
function render(component: unknown, props: Record<string, unknown>, cache: CacheState) {
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
  const html = renderToString(createElement(QueryClientProvider, { client: qc }, createElement(component, props)));
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
