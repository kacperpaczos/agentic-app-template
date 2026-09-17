import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLATFORM_CUSTOM_EVENTS,
  UI_COMMAND_FAILURES,
  appContextSchema,
  checkSortField,
  pageFromParam,
  pageSlice,
  parseAddressSearch,
  sortFromParam,
  sortToParam,
  stringifyAddressSearch,
  uiCommandResultSchema,
  uiCommandSchema,
  viewAddressKey,
  viewStateContextSchema,
  viewStatePatch,
  type AppContext,
  type ReadResponse,
  type ReadResultDescriptor,
  type ToolCallContext,
  type UiCommand,
  type UiTarget,
} from '@platform/contracts';
import {
  AgentRuntime,
  RunEventStream,
  buildSystemPrompt,
  buildUiTargetCatalog,
  platformTools,
} from '@platform/server';
import { buildDataModel, describeDataInstance } from '../packages/platform-ui/src/views/model.ts';
import { useAppState, type ViewStateReport } from '../packages/platform-ui/src/state/appState.ts';
import { nextSort } from '../packages/platform-ui/src/views/DataTableControls.tsx';
import { cachedLoader, planViewCommand } from '../packages/platform-ui/src/shell/uiCommandPlan.ts';
import { createHarness, type Harness } from './helpers.ts';

/**
 * The state of a view — narrowing, order, page — in the address, in the view,
 * in the agent's hands and in the agent's context.
 *
 * Contract and logic tests (no browser, no model). The browser half, where the
 * same rules are observed on screen, is `e2e/view-state.spec.ts`.
 */

/* -------------------------------------------------------------------------- */
/*  Address                                                                   */
/* -------------------------------------------------------------------------- */

describe('stan widoku w adresie', () => {
  it('sort: pole rosnaco, -pole malejaco; smieci nie sa porzadkiem', () => {
    expect(sortToParam({ field: 'name', direction: 'asc' })).toBe('name');
    expect(sortToParam({ field: 'name', direction: 'desc' })).toBe('-name');
    expect(sortFromParam('name')).toEqual({ field: 'name', direction: 'asc' });
    expect(sortFromParam('-totalMinor')).toEqual({ field: 'totalMinor', direction: 'desc' });
    expect(sortFromParam(' -name ')).toEqual({ field: 'name', direction: 'desc' });
    for (const junk of ['', '-', '  ', undefined, 7, null, 'x'.repeat(81)]) {
      expect(sortFromParam(junk), String(junk)).toBeNull();
    }
    // Round trip.
    for (const s of [{ field: 'a', direction: 'asc' }, { field: 'b', direction: 'desc' }] as const) {
      expect(sortFromParam(sortToParam(s))).toEqual(s);
    }
  });

  it('page: liczba calkowita od 1; zero, ulamek i tekst to brak strony', () => {
    expect(pageFromParam('2')).toBe(2);
    expect(pageFromParam(' 12 ')).toBe(12);
    expect(pageFromParam(3)).toBe(3);
    for (const junk of ['0', '-1', '1.5', 'abc', '', undefined, null, '1e3']) {
      expect(pageFromParam(junk), String(junk)).toBeNull();
    }
  });

  it('parametry adresu to zwykle napisy: page=2 i numer NIP nie staja sie liczbami', () => {
    /*
     * The router's default parser read `?page=2` as the number 2, and the
     * session's validator — which keeps strings — dropped it, so no page could
     * ever be linked. The same happened to a numeric narrowing value.
     */
    const parsed = parseAddressSearch('?page=2&taxId=5213456789&flag=true&name=~av&c=cnv_1');
    expect(parsed).toEqual({ page: '2', taxId: '5213456789', flag: 'true', name: '~av', c: 'cnv_1' });
    const text = stringifyAddressSearch({ page: '2', sort: '-name', country: 'PL,CZ', gone: undefined, n: 3 });
    expect(text).toBe('?page=2&sort=-name&country=PL%2CCZ&n=3');
    expect(parseAddressSearch(text)).toEqual({ page: '2', sort: '-name', country: 'PL,CZ', n: '3' });
    expect(stringifyAddressSearch({})).toBe('');
  });

  it('klucze sort i page sa zarezerwowane: pole zawezania o tej nazwie zatrzymuje start', () => {
    const target = (field: string): UiTarget => ({
      id: 'm.view',
      kind: 'view',
      label: 'Widok',
      description: 'x',
      to: '/v',
      filter: { collection: 'rows', fields: [{ field, label: field }] },
    });
    for (const key of ['c', 's', 'sort', 'page']) {
      expect(() => buildUiTargetCatalog([[target(key)]]), key).toThrowError(new RegExp(`pole filtra "${key}"`));
    }
    expect(() => buildUiTargetCatalog([[target('country')]])).not.toThrow();
  });

  it('zmiana zawezenia albo sortowania wraca na pierwsza strone; sama strona nie rusza reszty', () => {
    const fields = ['country', 'name'];
    expect(viewStatePatch(fields, { predicates: [{ field: 'country', op: 'eq', value: 'PL' }] })).toStrictEqual({
      country: 'PL',
      name: undefined,
      page: undefined,
    });
    expect(viewStatePatch(fields, { sort: { field: 'name', direction: 'desc' } })).toStrictEqual({
      sort: '-name',
      page: undefined,
    });
    expect(viewStatePatch(fields, { page: 3 })).toStrictEqual({ page: '3' });
    expect(viewStatePatch(fields, { page: 1 })).toStrictEqual({ page: undefined });
    // Clearing everything: every declared field, the order and the page.
    expect(viewStatePatch(fields, { predicates: null, sort: null, page: null })).toStrictEqual({
      country: undefined,
      name: undefined,
      sort: undefined,
      page: undefined,
    });
  });

  it('klucz stanu adresu jest znormalizowany: page=1 to brak strony, obce parametry sie nie licza', () => {
    const fields = ['country'];
    const a = viewAddressKey({ country: 'PL', sort: '-name', page: '1', c: 'cnv_1', status: 'x' }, fields);
    const b = viewAddressKey({ country: ' PL ', sort: '-name' }, fields);
    expect(a).toBe(b);
    expect(viewAddressKey({ page: '2' }, fields)).not.toBe(viewAddressKey({}, fields));
    expect(viewAddressKey({ page: '2' }, fields, { page: false })).toBe(viewAddressKey({}, fields));
    expect(viewAddressKey({ sort: 'name' }, fields)).not.toBe(viewAddressKey({ sort: '-name' }, fields));
  });
});

/* -------------------------------------------------------------------------- */
/*  Pages and order                                                           */
/* -------------------------------------------------------------------------- */

describe('strony', () => {
  it('16 rekordow po 10: dwie strony, druga ma 6', () => {
    expect(pageSlice(16, 10, null)).toEqual({ index: 1, size: 10, count: 2, start: 0, end: 10, requested: null, clamped: false });
    expect(pageSlice(16, 10, 2)).toMatchObject({ index: 2, count: 2, start: 10, end: 16, clamped: false });
    expect(pageSlice(20, 10, 2)).toMatchObject({ count: 2, start: 10, end: 20 });
    expect(pageSlice(21, 10, 3)).toMatchObject({ count: 3, start: 20, end: 21 });
  });

  it('strona spoza zakresu jest przycinana do ostatniej i oznaczona jako przycieta', () => {
    expect(pageSlice(16, 10, 9)).toMatchObject({ index: 2, requested: 9, clamped: true, start: 10, end: 16 });
    // No records: one empty page, not page 0 — and a later page is clamped to it.
    expect(pageSlice(0, 10, null)).toMatchObject({ index: 1, count: 1, start: 0, end: 0, clamped: false });
    expect(pageSlice(0, 10, 4)).toMatchObject({ index: 1, count: 1, clamped: true });
  });
});

const descriptor: ReadResultDescriptor = {
  collection: 'rows',
  record: { kind: 'row', idField: 'id', titleField: 'name' },
  fields: [
    { field: 'name', label: 'Nazwa', type: 'text' },
    { field: 'amount', label: 'Kwota', type: 'money_minor', unit: 'PLN' },
    { field: 'qty', label: 'Ilosc', type: 'number' },
    { field: 'when', label: 'Data', type: 'date' },
    { field: 'country', label: 'Kraj', type: 'text' },
    { field: 'note', label: 'Uwagi', type: 'text', sortable: false },
  ],
};

const rows = [
  { id: 'a', name: 'Zenit', amount: 900, qty: 9, when: '2026-03-01', country: 'PL', note: 'x' },
  { id: 'b', name: 'Łódź AV', amount: 10_000, qty: 10, when: '2025-12-31', country: 'PL', note: 'y' },
  { id: 'c', name: 'alfa', amount: null, qty: 100, when: null, country: 'FI', note: 'z' },
  { id: 'd', name: 'Mazur', amount: 5_000, qty: null, when: '2026-01-15', country: 'PL', note: '' },
];

const response = (records: unknown[] = rows): ReadResponse => ({
  operation: 'm.rows',
  result: { rows: records },
  descriptor,
  resolvedAt: new Date(0).toISOString(),
});

const ids = (records: Array<Record<string, unknown>>) => records.map((r) => r.id);

describe('porzadek wedlug typu pola, z adresu', () => {
  it('liczby i kwoty liczbowo, daty chronologicznie, tekst po polsku, puste na koncu w obu kierunkach', () => {
    const order = (field: string, direction: 'asc' | 'desc') =>
      ids(buildDataModel({ response: response(), addressSort: { field, direction } }).records);

    // 9 before 10 numerically (as text "10" < "9").
    expect(order('qty', 'asc')).toEqual(['a', 'b', 'c', 'd']);
    expect(order('qty', 'desc')).toEqual(['c', 'b', 'a', 'd']);
    expect(order('amount', 'asc')).toEqual(['a', 'd', 'b', 'c']);
    expect(order('amount', 'desc')).toEqual(['b', 'd', 'a', 'c']);
    expect(order('when', 'asc')).toEqual(['b', 'd', 'a', 'c']);
    expect(order('when', 'desc')).toEqual(['a', 'd', 'b', 'c']);
    // Polish collation: Ł between L and M, case-insensitive-ish; code points would put Ł after Z.
    expect(order('name', 'asc')).toEqual(['c', 'b', 'd', 'a']);
    expect(order('name', 'desc')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('porzadek z adresu zastepuje porzadek kompozycji; bez niego obowiazuje kompozycja', () => {
    const composed = { field: 'qty', direction: 'desc' } as const;
    const withAddress = buildDataModel({ response: response(), sort: composed, addressSort: { field: 'name', direction: 'asc' } });
    expect(withAddress.sort).toEqual({ field: 'name', direction: 'asc' });
    expect(withAddress.sortFromAddress).toBe(true);
    const without = buildDataModel({ response: response(), sort: composed, addressSort: null });
    expect(without.sort).toEqual(composed);
    expect(without.sortFromAddress).toBe(false);
    expect(ids(without.records)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('niedozwolony porzadek z adresu jest pominiety i zgloszony, a nie bledem ekranu', () => {
    const unknown = buildDataModel({ response: response(), addressSort: { field: 'wojewodztwo', direction: 'asc' } });
    expect(unknown.sort).toBeNull();
    expect(unknown.rejectedSort).toEqual({ field: 'wojewodztwo', direction: 'asc', reason: 'unknown_field' });
    expect(ids(unknown.records)).toEqual(['a', 'b', 'c', 'd']);
    const unsortable = buildDataModel({ response: response(), addressSort: { field: 'note', direction: 'desc' } });
    expect(unsortable.rejectedSort?.reason).toBe('not_sortable');
  });

  it('kompozycja sortujaca po polu niesortowalnym jest odrzucona z nazwa i lista dozwolonych', () => {
    expect(() => buildDataModel({ response: response(), sort: { field: 'note', direction: 'asc' } })).toThrowError(
      /note .*niesortowalne.*name, amount, qty, when, country/,
    );
    expect(() => buildDataModel({ response: response(), sort: { field: 'nie_ma', direction: 'asc' } })).toThrowError(
      /nie_ma/,
    );
  });

  it('pole jest sortowalne, chyba ze deskryptor mowi sortable: false', () => {
    expect(checkSortField(descriptor, 'name')).toMatchObject({ ok: true });
    const refused = checkSortField(descriptor, 'note');
    expect(refused).toMatchObject({ ok: false, reason: 'not_sortable' });
    expect(checkSortField(descriptor, 'x')).toMatchObject({ ok: false, reason: 'unknown_field' });
    if (!refused.ok) expect(refused.available.map((f) => f.field)).not.toContain('note');
  });

  it('naglowek: rosnaco, malejaco, potem porzadek widoku', () => {
    expect(nextSort(null, false, 'name')).toEqual({ field: 'name', direction: 'asc' });
    expect(nextSort({ field: 'name', direction: 'asc' }, true, 'name')).toEqual({ field: 'name', direction: 'desc' });
    expect(nextSort({ field: 'name', direction: 'desc' }, true, 'name')).toBeNull();
    expect(nextSort({ field: 'name', direction: 'desc' }, true, 'qty')).toEqual({ field: 'qty', direction: 'asc' });
    // The composition's own order cannot be cleared into itself.
    expect(nextSort({ field: 'name', direction: 'desc' }, false, 'name')).toEqual({ field: 'name', direction: 'asc' });
  });
});

describe('strona w modelu i w opisie instancji', () => {
  const many = Array.from({ length: 16 }, (_, i) => ({
    id: `r${String(i + 1).padStart(2, '0')}`,
    name: `N${String(16 - i).padStart(2, '0')}`,
    amount: i,
    qty: i,
    when: null,
    country: i % 2 ? 'PL' : 'FI',
    note: '',
  }));

  it('druga strona po zawezeniu i sortowaniu: rysuje tylko ja, liczy wszystkie', () => {
    const model = buildDataModel({
      response: response(many),
      narrowing: { targetId: 'm.view', predicates: [{ field: 'country', op: 'eq', value: 'PL' }] },
      addressSort: { field: 'name', direction: 'asc' },
      pageSize: 5,
      page: 2,
    });
    expect(model.records).toHaveLength(8);
    expect(model.baseCount).toBe(16);
    expect(model.page).toMatchObject({ index: 2, size: 5, count: 2, clamped: false });
    // PL rows are r02, r04 … r16 with names N15, N13 … N01; ascending by name the
    // second page holds the last three.
    expect(ids(model.shown)).toEqual(['r06', 'r04', 'r02']);

    const described = describeDataInstance({
      instanceId: 'DataTable-x',
      component: 'DataTable',
      viewId: 'm.view',
      source: { operation: 'm.rows' },
      state: 'ready',
      model,
      actions: [],
    });
    expect(described.sort).toEqual({ field: 'name', direction: 'asc' });
    expect(described.page).toEqual({ index: 2, size: 5, count: 2 });
    expect(described.visibleRecordIds).toEqual(['r06', 'r04', 'r02']);
    expect(described.matched).toBe(8);
    expect(described.total).toBe(16);
  });

  it('strona spoza zakresu: pokazana ostatnia, zgloszone przyciecie; bez pageSize nie ma stron', () => {
    const clamped = buildDataModel({ response: response(many), pageSize: 10, page: 7 });
    expect(clamped.page).toMatchObject({ index: 2, count: 2, requested: 7, clamped: true });
    expect(clamped.shown).toHaveLength(6);
    const unpaged = buildDataModel({ response: response(many), page: 7 });
    expect(unpaged.page).toBeNull();
    expect(unpaged.shown).toHaveLength(16);
  });
});

/* -------------------------------------------------------------------------- */
/*  Context                                                                   */
/* -------------------------------------------------------------------------- */

describe('stan widoku w AppContext.filters', () => {
  const report = (over: Partial<ViewStateReport> = {}): ViewStateReport => ({
    targetId: 'procurement.data',
    instanceId: 'DataTable-r1',
    address: 'k',
    predicates: [{ field: 'country', op: 'eq', value: 'PL' }],
    sort: { field: 'name', direction: 'desc' },
    sortLabel: 'Nazwa',
    sortFromAddress: true,
    rejectedSort: null,
    page: { index: 1, size: 10, count: 1 },
    clampedFrom: null,
    matched: 3,
    total: 4,
    ...over,
  });

  beforeEach(() => useAppState.setState({ viewStates: {}, filters: {} }));

  it('w chwili wyslania: zawezenie, sortowanie, strona i liczby widoku na ekranie', () => {
    useAppState.getState().reportViewState(report());
    const ctx = useAppState.getState().toAppContext();
    expect(ctx.filters).toEqual({
      'procurement.data': {
        predicates: [{ field: 'country', op: 'eq', value: 'PL' }],
        sort: { field: 'name', direction: 'desc' },
        page: { index: 1, size: 10, count: 1 },
        matched: 3,
        total: 4,
      },
    });
    // The shape is the contract, and the backend accepts it as sent.
    expect(viewStateContextSchema.safeParse(ctx.filters['procurement.data']).success).toBe(true);
    expect(appContextSchema.parse(ctx).filters).toEqual(ctx.filters);
  });

  it('kontekst jest liczony przy kazdym wyslaniu, nie przy montowaniu', () => {
    const store = useAppState.getState();
    store.reportViewState(report());
    const first = store.toAppContext();
    store.reportViewState(report({ sort: null, sortFromAddress: false, predicates: [], matched: 4 }));
    const second = useAppState.getState().toAppContext();
    expect((first.filters['procurement.data'] as { sort: unknown }).sort).toEqual({ field: 'name', direction: 'desc' });
    expect(second.filters['procurement.data']).toMatchObject({ sort: null, predicates: [], matched: 4 });
  });

  it('widok zdjety z ekranu znika z kontekstu; cudza instancja nie zdejmuje raportu', () => {
    const store = useAppState.getState();
    store.reportViewState(report());
    store.dropViewState('procurement.data', 'DataTable-inna');
    expect(useAppState.getState().toAppContext().filters).toHaveProperty(['procurement.data']);
    store.dropViewState('procurement.data', 'DataTable-r1');
    expect(useAppState.getState().toAppContext().filters).toEqual({});
  });

  it('filtry modulu ustawione przez setFilter zostaja obok stanu widoku', () => {
    const store = useAppState.getState();
    store.setFilter('m.custom', { any: true });
    store.reportViewState(report());
    expect(Object.keys(useAppState.getState().toAppContext().filters).sort()).toEqual(['m.custom', 'procurement.data']);
  });
});

/* -------------------------------------------------------------------------- */
/*  The agent's tools                                                         */
/* -------------------------------------------------------------------------- */

let h: Harness;

const EMPTY_CONTEXT = (conversationId: string): AppContext => ({
  conversationId,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
  ui: null,
});

/**
 * Calls a platform tool the way a run does — over the runtime's real
 * acknowledgement gate and a real event stream — and records the commands the
 * browser would have received.
 */
async function callTool(
  name: string,
  input: Record<string, unknown>,
  ack: (command: UiCommand, runtime: AgentRuntime) => void | Promise<void>,
): Promise<{ result?: any; error?: unknown; emitted: UiCommand[] }> {
  const runtime = new AgentRuntime(h.platform.services);
  const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, firstMessage: { content: 'posortuj' } });
  const run = h.platform.services.runs.start({
    conversationId: conv.id,
    ownerId: h.ownerId,
    prompt: 'posortuj',
    appContext: EMPTY_CONTEXT(conv.id),
    workspaceDir: null,
    abort: new AbortController(),
  });
  const stream = new RunEventStream(run.id, h.platform.services.runs);
  const emitted: UiCommand[] = [];
  const watcher = (async () => {
    for await (const { event } of stream.read(0)) {
      const e = event as Record<string, unknown>;
      if (e.type === 'CUSTOM' && e.name === PLATFORM_CUSTOM_EVENTS.uiCommand) {
        const parsed = uiCommandSchema.parse(e.value);
        emitted.push(parsed);
        await ack(parsed, runtime);
      }
    }
  })();
  const ctx: ToolCallContext = {
    ownerId: h.ownerId,
    appContext: EMPTY_CONTEXT(conv.id),
    conversationId: conv.id,
    runId: run.id,
    workspaceDir: null,
    emit: () => {},
    requestUi: (command) =>
      runtime.requestUiCommand(
        {
          commandId: `uic_${Math.random().toString(36).slice(2, 12)}`,
          runId: run.id,
          conversationId: conv.id,
          targetId: command.targetId,
          spaceId: command.spaceId ?? null,
          ...(command.filter !== undefined ? { filter: command.filter } : {}),
          ...(command.sort !== undefined ? { sort: command.sort } : {}),
          reason: command.reason,
        },
        stream,
        400,
      ),
  };
  const tool = platformTools(h.platform.services).find((t) => t.name === name)!;
  const out: { result?: any; error?: unknown; emitted: UiCommand[] } = { emitted };
  try {
    out.result = await tool.handler(input as never, ctx);
  } catch (e) {
    out.error = e;
  }
  stream.close();
  await watcher;
  return out;
}

/** A client that applies the order and reports what a view would. */
const sortedBy = (page = { index: 1, size: 10, count: 1 }) =>
  async (command: UiCommand, runtime: AgentRuntime) => {
    runtime.acknowledgeUiCommand(
      uiCommandResultSchema.parse({
        commandId: command.commandId,
        targetId: command.targetId,
        executed: true,
        sorted: command.sort ?? null,
        page,
        url: '/data?sort=-name',
      }),
    );
  };

describe('ui_sort', () => {
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.dispose());

  it('przekazuje porzadek do klienta i zwraca porzadek i strone, ktore zglosil WIDOK', async () => {
    const { result, emitted } = await callTool(
      'ui_sort',
      { targetId: 'procurement.data', field: 'name', direction: 'desc' },
      sortedBy({ index: 1, size: 10, count: 2 }),
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.sort).toEqual({ field: 'name', direction: 'desc' });
    expect(emitted[0]!.filter).toBeUndefined();
    expect(result).toMatchObject({
      executed: true,
      sorted: { field: 'name', direction: 'desc' },
      page: { index: 1, size: 10, count: 2 },
      cleared: false,
    });
  });

  it('brak kierunku to rosnaco', async () => {
    const { emitted } = await callTool('ui_sort', { targetId: 'procurement.data', field: 'country' }, sortedBy());
    expect(emitted[0]!.sort).toEqual({ field: 'country', direction: 'asc' });
  });

  it('pole spoza deskryptora: unknown_field z lista dozwolonych, NIC nie trafia do przegladarki', async () => {
    const { result, emitted } = await callTool(
      'ui_sort',
      { targetId: 'procurement.data', field: 'wojewodztwo', direction: 'asc' },
      sortedBy(),
    );
    expect(result.executed).toBe(false);
    expect(result.reason).toBe(UI_COMMAND_FAILURES.unknownField);
    expect(result.requested).toBe('wojewodztwo');
    expect(result.available.map((f: any) => f.field)).toEqual(['name', 'taxId', 'country']);
    expect(emitted).toHaveLength(0);
  });

  it('pole zadeklarowane jako niesortowalne: not_sortable z lista dozwolonych, bez komendy', async () => {
    const { result, emitted } = await callTool(
      'ui_sort',
      { targetId: 'procurement.data', field: 'contactEmail', direction: 'asc' },
      sortedBy(),
    );
    expect(result.reason).toBe(UI_COMMAND_FAILURES.notSortable);
    expect(result.requested).toBe('contactEmail');
    expect(result.available.map((f: any) => f.field)).not.toContain('contactEmail');
    expect(emitted).toHaveLength(0);
  });

  it('cel bez widoku z rekordami: not_sortable; nieznany cel: lista celow', async () => {
    const settings = await callTool('ui_sort', { targetId: 'platform.settings', field: 'x' }, sortedBy());
    expect(settings.result).toMatchObject({ executed: false, reason: UI_COMMAND_FAILURES.notSortable, available: [] });
    expect(settings.emitted).toHaveLength(0);
    const unknown = await callTool('ui_sort', { targetId: 'procurement.nie-ma', field: 'x' }, sortedBy());
    expect(unknown.result.reason).toBe(UI_COMMAND_FAILURES.unknownTarget);
    expect(unknown.result.available).toContain('procurement.data');
  });

  it('bez pola i bez clear to blad, nie ciche pozostawienie widoku', async () => {
    const { error, emitted } = await callTool('ui_sort', { targetId: 'procurement.data' }, sortedBy());
    expect(String((error as Error).message)).toContain('clear=true');
    expect(emitted).toHaveLength(0);
  });

  it('clear=true na widoku z rekordami wysyla sort: null (nie brak)', async () => {
    const { result, emitted } = await callTool('ui_sort', { targetId: 'procurement.data', clear: true }, sortedBy());
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.sort).toBeNull();
    expect(result).toMatchObject({ executed: true, cleared: true, sorted: null });
  });

  it('clear=true na celu bez widoku z rekordami: not_sortable, bez komendy i bez przeniesienia uzytkownika', async () => {
    /*
     * There is no order to clear there. "cleared" would be a success nothing
     * applied — and performing it moved the user to that target's screen.
     */
    const { result, emitted } = await callTool('ui_sort', { targetId: 'platform.settings', clear: true }, sortedBy());
    expect(result).toEqual({
      executed: false,
      reason: UI_COMMAND_FAILURES.notSortable,
      targetId: 'platform.settings',
      label: 'Ustawienia',
      available: [],
    });
    expect(emitted).toHaveLength(0);
  });

  it('odmowa klienta (not_applied) jest raportowana, nie nadpisywana', async () => {
    const { result } = await callTool(
      'ui_sort',
      { targetId: 'procurement.data', field: 'name' },
      async (command, runtime) => {
        runtime.acknowledgeUiCommand({
          commandId: command.commandId,
          targetId: command.targetId,
          executed: false,
          reason: UI_COMMAND_FAILURES.notApplied,
        });
      },
    );
    expect(result).toMatchObject({ executed: false, reason: UI_COMMAND_FAILURES.notApplied });
    expect(result.sorted).toBeUndefined();
  });

  it('ui_filter niesie informacje o stronie z potwierdzenia', async () => {
    const { result } = await callTool(
      'ui_filter',
      { targetId: 'procurement.data', predicates: [{ field: 'country', op: 'eq', value: 'PL' }], label: 'PL' },
      async (command, runtime) => {
        runtime.acknowledgeUiCommand({
          commandId: command.commandId,
          targetId: command.targetId,
          executed: true,
          filtered: { matched: 3, total: 4 },
          page: { index: 1, size: 10, count: 1 },
        });
      },
    );
    expect(result).toMatchObject({ executed: true, filtered: { matched: 3, total: 4 }, page: { index: 1, size: 10, count: 1 } });
  });

  it('ui_catalog podaje sortableFields z deskryptora widoku, bez pol niesortowalnych', async () => {
    const catalog = platformTools(h.platform.services).find((t) => t.name === 'ui_catalog')!;
    const out: any = await catalog.handler({} as never, {
      ownerId: h.ownerId,
      appContext: EMPTY_CONTEXT('c'),
      conversationId: 'c',
      runId: 'r',
      workspaceDir: null,
      emit: () => {},
    } as never);
    const data = out.targets.find((t: any) => t.id === 'procurement.data');
    expect(data.sortableFields).toEqual([
      { field: 'name', label: 'Nazwa', type: 'text' },
      { field: 'taxId', label: 'NIP', type: 'text' },
      { field: 'country', label: 'Kraj', type: 'text' },
    ]);
    expect(out.targets.find((t: any) => t.id === 'procurement.cases').sortableFields.map((f: any) => f.field)).toContain(
      'offerCount',
    );
    expect(out.targets.find((t: any) => t.id === 'platform.settings').sortableFields).toBeUndefined();
  });

  it('get_context zwraca stan widoku wyslany przez klienta, z uwaga, ze to prezentacja', async () => {
    const tool = platformTools(h.platform.services).find((t) => t.name === 'get_context')!;
    const filters = {
      'procurement.data': {
        predicates: [{ field: 'country', op: 'eq', value: 'PL' }],
        sort: { field: 'name', direction: 'desc' },
        page: { index: 1, size: 10, count: 1 },
        matched: 3,
        total: 4,
      },
    };
    const out: any = await tool.handler({} as never, {
      ownerId: h.ownerId,
      appContext: { ...EMPTY_CONTEXT('c'), filters },
      conversationId: 'c',
      runId: 'r',
      workspaceDir: null,
      emit: () => {},
    } as never);
    expect(out.filters).toEqual(filters);
    expect(out.filtersNote).toMatch(/Dane w bazie sa bez zmian/);
  });

  it('prompt uczy ui_sort, mowi, ze zawezenie i sortowanie to prezentacja, i opisuje stan widoku z kontekstu', () => {
    const prompt = buildSystemPrompt({
      registry: h.platform.registry,
      catalog: h.platform.services.catalog,
      appContext: {
        ...EMPTY_CONTEXT('c'),
        filters: {
          'procurement.data': {
            predicates: [{ field: 'country', op: 'in', value: ['PL', 'CZ'] }],
            sort: { field: 'name', direction: 'desc' },
            page: { index: 2, size: 10, count: 3 },
            matched: 23,
            total: 30,
          },
        },
      },
      resourceSummary: null,
      workspaceDir: null,
      stagedFiles: [],
      toolkit: [],
    });
    expect(prompt).toContain('mcp__app__ui_sort');
    expect(prompt).toContain('ZAWEZENIE I SORTOWANIE ZMIENIAJA TYLKO PREZENTACJE');
    expect(prompt).toMatch(/procurement\.data \[view\].*sortowanie po: name, taxId, country/);
    expect(prompt).not.toMatch(/sortowanie po: [^\n]*contactEmail/);
    // The target list sits where "ponizsza lista" points: under interface control,
    // before the narrowing and ordering sections, which stay self-contained.
    const control = prompt.indexOf('# Sterowanie interfejsem');
    const list = prompt.indexOf('- procurement.data [view]');
    const narrowing = prompt.indexOf('## Zawezanie widoku');
    const ordering = prompt.indexOf('## Sortowanie i strony widoku');
    expect(control).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(control);
    expect(narrowing).toBeGreaterThan(list);
    expect(ordering).toBeGreaterThan(narrowing);
    expect(prompt.slice(ordering)).not.toMatch(/^- (platform|procurement)\./m);
    expect(prompt).toContain(
      '- stan widoku procurement.data (tylko prezentacja, dane bez zmian): zawezenie country in PL|CZ; ' +
        'sortowanie name malejaco; strona 2 z 3 (po 10); pokazane 23 z 30',
    );
  });
});

describe('plan polecenia UI w przegladarce (UiCommandRunner)', () => {
  const dataTarget: UiTarget = {
    id: 'm.data',
    kind: 'view',
    label: 'Dane',
    description: 'x',
    to: '/data',
    filter: { collection: 'rows', fields: [{ field: 'country', label: 'Kraj' }, { field: 'name', label: 'Nazwa' }] },
  };
  const settingsTarget: UiTarget = { id: 'p.settings', kind: 'view', label: 'Ustawienia', description: 'x', to: '/settings' };
  const views = [{ id: 'm.data', title: 'Dane', composition: 'root = Stack([])', primaryOperation: 'm.rows' }];
  const onData = { pathname: '/data', search: '?country=PL&sort=-name&page=2&c=cnv_1' };

  it('nieudane wczytanie widokow nie jest zapamietywane: kolejne polecenie probuje ponownie', async () => {
    let calls = 0;
    const load = cachedLoader(async () => {
      calls += 1;
      if (calls === 1) throw new Error('siec');
      return ['widok'];
    });
    expect(await load()).toBeNull();
    expect(await load()).toEqual(['widok']);
    expect(await load()).toEqual(['widok']);
    // Loaded once, then kept.
    expect(calls).toBe(2);
  });

  it('bez definicji widokow zmiana stanu widoku to views_unavailable — nie not_sortable i nie niesprawdzony sukces', () => {
    const plan = (command: Parameters<typeof planViewCommand>[0]['command'], target = dataTarget) =>
      planViewCommand({ command, target, views: null, location: onData });
    expect(plan({ sort: { field: 'name', direction: 'asc' } })).toEqual({ kind: 'refuse', reason: 'views_unavailable' });
    expect(plan({ sort: null })).toEqual({ kind: 'refuse', reason: 'views_unavailable' });
    expect(plan({ filter: null })).toEqual({ kind: 'refuse', reason: 'views_unavailable' });
    expect(plan({ filter: { targetId: 'm.data', predicates: [{ field: 'country', op: 'eq', value: 'FI' }], label: 'x' } })).toEqual({
      kind: 'refuse',
      reason: 'views_unavailable',
    });
    // Refusals that do not depend on views keep their own reason.
    expect(plan({ filter: { targetId: 'm.data', predicates: [{ field: 'x', op: 'eq', value: 'y' }], label: 'x' } })).toEqual({
      kind: 'refuse',
      reason: 'unknown_field',
    });
    // A plain navigation needs no views.
    expect(planViewCommand({ command: {}, target: settingsTarget, views: [], location: onData })).toMatchObject({
      kind: 'apply',
      changesView: false,
      awaitsView: false,
      patch: {},
    });
  });

  it('z definicjami widokow: sortowanie i czyszczenie na widoku czekaja na raport widoku', () => {
    const sorted = planViewCommand({ command: { sort: { field: 'name', direction: 'asc' } }, target: dataTarget, views, location: onData });
    expect(sorted).toMatchObject({ kind: 'apply', reportingView: true, samePath: true, awaitsView: true, unchanged: false });
    if (sorted.kind === 'apply') {
      expect(sorted.patch).toStrictEqual({ sort: 'name', page: undefined });
      expect(sorted.expected).toEqual({ country: 'PL', sort: 'name', c: 'cnv_1' });
    }
    expect(planViewCommand({ command: { filter: null }, target: dataTarget, views, location: onData })).toMatchObject({
      kind: 'apply',
      awaitsView: true,
    });
    expect(planViewCommand({ command: { sort: null }, target: dataTarget, views, location: onData })).toMatchObject({
      kind: 'apply',
      awaitsView: true,
    });
    // The same order again: nothing in the address changes.
    expect(
      planViewCommand({ command: { sort: { field: 'name', direction: 'desc' } }, target: dataTarget, views, location: { pathname: '/data', search: '?country=PL&sort=-name' } }),
    ).toMatchObject({ kind: 'apply', unchanged: true, awaitsView: true });
    // From another screen the view's parameters start clean.
    const fromCases = planViewCommand({ command: { sort: { field: 'name', direction: 'asc' } }, target: dataTarget, views, location: { pathname: '/cases', search: '?sort=-code&page=3' } });
    expect(fromCases).toMatchObject({ kind: 'apply', samePath: false, expected: { sort: 'name' } });
  });

  it('czyszczenie zawezenia celu bez zawezenia: not_filterable, bez nawigacji, niezaleznie od widokow i adresu', () => {
    for (const views_ of [views, null]) {
      expect(planViewCommand({ command: { filter: null }, target: settingsTarget, views: views_, location: onData })).toEqual({
        kind: 'refuse',
        reason: 'not_filterable',
      });
    }
    // A target that declares a narrowing is cleared whatever its address holds — even nothing.
    const clean = planViewCommand({ command: { filter: null }, target: dataTarget, views, location: { pathname: '/data', search: '' } });
    expect(clean).toMatchObject({ kind: 'apply', awaitsView: true });
    if (clean.kind === 'apply') expect(clean.patch).toStrictEqual({ country: undefined, name: undefined, page: undefined });
  });

  it('przestrzen pracy przelacza tylko polecenie wykonywane, nigdy odrzucone', () => {
    const refused = planViewCommand({ command: { sort: null, spaceId: 'sp_inna' }, target: settingsTarget, views, location: onData });
    // A refusal carries nothing to switch to.
    expect(refused).toEqual({ kind: 'refuse', reason: 'not_sortable' });
    expect(
      planViewCommand({ command: { filter: null, spaceId: 'sp_inna' }, target: dataTarget, views: null, location: onData }),
    ).toEqual({ kind: 'refuse', reason: 'views_unavailable' });
    expect(planViewCommand({ command: { spaceId: 'sp_inna' }, target: settingsTarget, views: [], location: onData })).toMatchObject({
      kind: 'apply',
      switchSpace: 'sp_inna',
    });
    expect(planViewCommand({ command: {}, target: settingsTarget, views: [], location: onData })).toMatchObject({
      kind: 'apply',
      switchSpace: null,
    });
  });

  it('czyszczenie porzadku celu bez widoku z rekordami: not_sortable, bez nawigacji', () => {
    expect(planViewCommand({ command: { sort: null }, target: settingsTarget, views, location: onData })).toEqual({
      kind: 'refuse',
      reason: 'not_sortable',
    });
    expect(
      planViewCommand({ command: { sort: { field: 'x', direction: 'asc' } }, target: settingsTarget, views, location: onData }),
    ).toEqual({ kind: 'refuse', reason: 'not_sortable' });
  });
});

describe('kontrakt polecenia UI', () => {
  it('sort: obiekt ustawia, null czysci, brak nie zmienia; wynik niesie sorted i page', () => {
    const base = { commandId: 'uic_12345678', runId: 'r', conversationId: 'c', targetId: 't' };
    expect(uiCommandSchema.parse({ ...base, sort: { field: 'name', direction: 'desc' } }).sort).toEqual({
      field: 'name',
      direction: 'desc',
    });
    expect(uiCommandSchema.parse({ ...base, sort: null }).sort).toBeNull();
    expect('sort' in uiCommandSchema.parse(base)).toBe(false);
    expect(uiCommandSchema.safeParse({ ...base, sort: { field: 'name', direction: 'down' } }).success).toBe(false);
    expect(
      uiCommandResultSchema.parse({ commandId: 'x', executed: true, sorted: null, page: { index: 1, size: 10, count: 2 } }),
    ).toMatchObject({ sorted: null, page: { index: 1, size: 10, count: 2 } });
    expect(UI_COMMAND_FAILURES.notSortable).toBe('not_sortable');
    expect(UI_COMMAND_FAILURES.viewsUnavailable).toBe('views_unavailable');
  });
});
