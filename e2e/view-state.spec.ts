import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';
import { recordsOf, type ReadResponse } from '@platform/contracts';

/**
 * The state of a view — narrowing, order, page — as the user and the agent
 * change it, and as the next command carries it (L2.17, T26; L6.17 in part).
 *
 * Symulacja / test GUI bez modelu. The model is the scripted stand-in; its
 * `call` steps run the real `ui_filter`, `ui_sort` and `get_context` handlers
 * through the runtime's real acknowledgement gate. Tests without a command are
 * plain interface tests. Every expected record order and count is read from the
 * backend (`POST /api/read`) and computed here with the test's own comparator —
 * not with the application's sorting function — plus literal fixture names, so
 * the screen cannot pass by agreeing with itself.
 *
 * This instance's database gets twelve more suppliers before it starts (two
 * Polish ones whose names start with Ł and Ź, ten German ones), so the list has
 * two pages of ten, and Polish collation differs from code-point order.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-viewstate' });
const BASE = scripted.baseUrl;

const EXTRA_SUPPLIERS = [
  { name: 'Łódzka Technika Sceniczna', taxId: '7250000001', country: 'PL' },
  { name: 'Źródło Dźwięku', taxId: '6310000002', country: 'PL' },
  ...Array.from({ length: 10 }, (_, i) => ({
    name: `Dostawca DE ${String(i + 1).padStart(2, '0')}`,
    taxId: `DE1000000${String(i + 1).padStart(2, '0')}`,
    country: 'DE',
  })),
];
const TOTAL = 4 + EXTRA_SUPPLIERS.length;

/*
 * `better-sqlite3` belongs to `@platform/server`, so it is resolved from there
 * and typed only as far as used here.
 */
interface SqliteDatabase {
  prepare: (sql: string) => { run: (...p: unknown[]) => unknown; all: (...p: unknown[]) => unknown[] };
  close: () => void;
}
const Database = createRequire(resolve(import.meta.dirname, '../packages/platform-server/package.json'))(
  'better-sqlite3',
) as new (file: string) => SqliteDatabase;

/** Writes the extra suppliers straight into this instance's own database, before it runs. */
function addSuppliers(dataDir: string) {
  const db = new Database(resolve(dataDir, 'app.db'));
  try {
    const owners = db.prepare('SELECT DISTINCT owner_id FROM pc_suppliers').all() as Array<{ owner_id: string }>;
    expect(owners, 'zasiew ma dostawcow jednego wlasciciela').toHaveLength(1);
    const insert = db.prepare(
      'INSERT INTO pc_suppliers (id, owner_id, name, tax_id, country, contact_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    EXTRA_SUPPLIERS.forEach((s, i) =>
      insert.run(`pcs_e2e_viewstate_${i}`, owners[0]!.owner_id, s.name, s.taxId, s.country, `e2e${i}@example.test`, new Date().toISOString()),
    );
  } finally {
    db.close();
  }
}

async function openApp(page: Page, path = '/data') {
  await page.goto(`${BASE}${path}`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${BASE}${path}`);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

async function send(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

const settled = (page: Page) =>
  expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /succeeded|failed/, { timeout: 60_000 });

type Supplier = { id: string; name: string; country: string };

/** The suppliers as the backend returns them, in its order, through the endpoint the view uses. */
async function backendSuppliers(page: Page): Promise<{ raw: ReadResponse; records: Supplier[] }> {
  const res = await page.request.post(`${BASE}/api/read`, { data: { operation: 'procurement.suppliers' } });
  expect(res.status()).toBe(200);
  const raw = (await res.json()) as ReadResponse;
  return { raw, records: recordsOf(raw.result, raw.descriptor!) as unknown as Supplier[] };
}

/** The test's own ordering: Polish collation of the name, as the view must order text. */
const byName = (direction: 'asc' | 'desc') => (a: Supplier, b: Supplier) =>
  a.name.localeCompare(b.name, 'pl') * (direction === 'desc' ? -1 : 1);

/**
 * What each tool call of a run returned, read from the run's own persisted
 * event log (`GET /api/runs/:id/events`) — the results the real handlers
 * produced, in order. The chat shows only the text after a run's last tool
 * call, so earlier results are read here rather than from the screen.
 */
async function toolResults(page: Page, runId: string): Promise<Array<{ name: string; result: any }>> {
  const res = await page.request.get(`${BASE}/api/runs/${runId}/events`);
  expect(res.status()).toBe(200);
  const { events } = (await res.json()) as { events: Array<{ name: string; payload: Record<string, any> }> };
  const names = new Map<string, string>();
  const out: Array<{ name: string; result: any }> = [];
  for (const e of events) {
    if (e.name === 'TOOL_CALL_START') names.set(e.payload.toolCallId, e.payload.toolCallName);
    if (e.name === 'TOOL_CALL_RESULT') {
      out.push({ name: names.get(e.payload.toolCallId) ?? '?', result: JSON.parse(e.payload.content) });
    }
  }
  return out;
}

/** Sends a command and returns the id of the run it started. */
async function sendForRun(page: Page, text: string): Promise<{ runId: string; context: any }> {
  const request = page.waitForRequest((r) => r.url().endsWith('/api/agui/run') && r.method() === 'POST');
  await send(page, text);
  const sent = await request;
  const response = await sent.response();
  const runId = response?.headers()['x-run-id'];
  expect(runId, 'naglowek X-Run-Id').toBeTruthy();
  return { runId: runId!, context: sent.postDataJSON().context };
}

const view = (page: Page) => page.getByTestId('data-page').locator('[data-component="DataTable"]');
const rowIds = (page: Page) =>
  page.locator('[data-testid="data-page"] tbody tr').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-record-id')));
const rows = (page: Page) => page.locator('[data-testid="data-page"] tbody tr');
const header = (page: Page, field: string) => view(page).locator(`thead th[data-field="${field}"]`);
const banner = (page: Page) => page.getByTestId('view-filter-banner');
const answer = (page: Page) => page.locator('.pf-chat');
const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);
/** The address's view parameters — everything but the session's `c` and `s`. */
const viewParams = (page: Page) =>
  [...new URL(page.url()).searchParams].filter(([k]) => k !== 'c' && k !== 's').sort();

test.describe('stan widoku: zawezenie, sortowanie, strony', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
    addSuppliers(scripted.config.dataDir);
  });
  test.afterEach(() => scripted.stop());

  test('(a)+(d) agent zaweza i sortuje: kolejnosc z backendu, kontrolki, adres, dane bez zmian, stan w kolejnym poleceniu', async ({ page }) => {
    await scripted.start('viewstate-filter-sort');
    await openApp(page);
    await expect(rows(page)).toHaveCount(10);
    await expect(page.getByTestId('data-page-status')).toHaveText('Strona 1 z 2');

    const before = await backendSuppliers(page);
    expect(before.records).toHaveLength(TOTAL);
    const beforeModule = await (await page.request.get(`${BASE}/api/m/procurement/suppliers`)).json();

    const first = await sendForRun(page, 'Pokaz tylko polskich dostawcow, od Z do A.');
    // What the first command carried: the view as the user saw it, unnarrowed, two pages.
    expect(first.context.filters).toEqual({
      'procurement.data': { predicates: [], sort: null, page: { index: 1, size: 10, count: 2 }, matched: TOTAL, total: TOTAL },
    });

    // The rows: Polish suppliers only, in descending Polish order, computed from the backend here.
    const expected = before.records.filter((s) => s.country === 'PL').sort(byName('desc'));
    expect(expected.map((s) => s.name)).toEqual([
      'Źródło Dźwięku',
      'MediaPro Systemy',
      'Łódzka Technika Sceniczna',
      'Konferencje24',
      'AV Technika Sp. z o.o.',
    ]);
    await expect.poll(() => rowIds(page), { timeout: 60_000 }).toEqual(expected.map((s) => s.id));

    // The address carries it.
    await expect.poll(() => param(page, 'country')).toBe('PL');
    expect(param(page, 'sort')).toBe('-name');
    expect(param(page, 'page')).toBeNull();

    // The controls show it.
    await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'descending');
    await expect(header(page, 'country')).toHaveAttribute('aria-sort', 'none');
    await expect(header(page, 'contactEmail')).not.toHaveAttribute('aria-sort', /.*/);
    await expect(view(page).locator('select[data-filter-field="country"]')).toHaveValue('PL');
    await expect(page.getByTestId('data-pager')).toHaveCount(0);

    // The banner says what was done, by whom, and to how many.
    await expect(banner(page)).toContainText('Widok zawezony przez agenta.');
    await expect(banner(page)).toContainText('Kraj (kod ISO): PL');
    await expect(page.getByTestId('view-filter-count')).toContainText(`pokazane 5 z ${TOTAL}`);
    await expect(page.getByTestId('view-sort-state')).toHaveText('Sortowanie: Nazwa, malejaco.');

    await settled(page);
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded');
    await expect(answer(page)).toContainText('Zawezilem i posortowalem widok.');
    // The tools' answers are the view's acknowledgement, returned by the real handlers.
    const results = await toolResults(page, first.runId);
    expect(results.map((r) => r.name)).toEqual(['mcp__app__get_context', 'mcp__app__ui_filter', 'mcp__app__ui_sort']);
    expect(results[0]!.result.filters).toEqual(first.context.filters);
    expect(results[1]!.result).toMatchObject({
      executed: true,
      targetId: 'procurement.data',
      filtered: { matched: 5, total: TOTAL },
      page: { index: 1, size: 10, count: 1 },
    });
    expect(results[2]!.result).toMatchObject({
      executed: true,
      cleared: false,
      sorted: { field: 'name', direction: 'desc' },
      page: { index: 1, size: 10, count: 1 },
    });
    expect(new URL(results[2]!.result.url, BASE).searchParams.get('sort')).toBe('-name');

    // Presentation only: the backend's data is exactly what it was.
    const after = await backendSuppliers(page);
    expect(after.raw.result).toEqual(before.raw.result);
    expect(await (await page.request.get(`${BASE}/api/m/procurement/suppliers`)).json()).toEqual(beforeModule);

    // (d) The next command, typed in the chat, carries the narrowing and the order it left.
    const second = await sendForRun(page, 'Ilu ich jest?');
    const carried = {
      predicates: [{ field: 'country', op: 'eq', value: 'PL' }],
      sort: { field: 'name', direction: 'desc' },
      page: { index: 1, size: 10, count: 1 },
      matched: 5,
      total: TOTAL,
    };
    expect(second.context.filters).toEqual({ 'procurement.data': carried });
    // …and the run received it: its `get_context` handler returns the run's stored context.
    await expect(answer(page)).toContainText('Zawezilem i posortowalem widok.');
    await expect
      .poll(async () => (await toolResults(page, second.runId))[0]?.result.filters, { timeout: 60_000 })
      .toEqual({ 'procurement.data': carried });
    await settled(page);
  });

  test('(a) to samo zawezenie i sortowanie drugi raz: wykonane, z liczbami i strona, nie not_applied', async ({ page }) => {
    await scripted.start('viewstate-repeat');
    await openApp(page);
    const { runId } = await sendForRun(page, 'Polscy od Z do A. I jeszcze raz to samo.');
    await settled(page);
    await expect(answer(page)).toContainText('Powtorzylem zawezenie i sortowanie.');

    const results = (await toolResults(page, runId)).map((r) => r.result);
    expect(results).toHaveLength(4);
    const filtered = { executed: true, filtered: { matched: 5, total: TOTAL }, page: { index: 1, size: 10, count: 1 } };
    const sorted = { executed: true, sorted: { field: 'name', direction: 'desc' }, page: { index: 1, size: 10, count: 1 } };
    // First time and again — the repeat is answered from the state already on screen.
    expect(results[0]).toMatchObject(filtered);
    expect(results[1]).toMatchObject(sorted);
    expect(results[2]).toMatchObject(filtered);
    expect(results[3]).toMatchObject(sorted);
    expect(results.map((r) => r.reason)).toEqual([undefined, undefined, undefined, undefined]);
    await expect(page.getByTestId('view-filter-count')).toContainText(`pokazane 5 z ${TOTAL}`);
    await expect(banner(page)).toContainText('Widok zawezony przez agenta.');
  });

  test('(b) uzytkownik zmienia zawezenie w kontrolce: wiersze, adres, pasek; Wstecz przywraca kontrolke', async ({ page }) => {
    await scripted.start('viewstate-filter-sort');
    await openApp(page);
    const { records } = await backendSuppliers(page);
    const controls = view(page).getByTestId('view-filter-controls');

    await controls.getByLabel('Kraj (kod ISO)').selectOption('FI');
    await controls.getByRole('button', { name: 'Zastosuj' }).click();

    const finnish = records.filter((s) => s.country === 'FI');
    expect(finnish.map((s) => s.name)).toEqual(['NordAV OY']);
    await expect.poll(() => rowIds(page)).toEqual(finnish.map((s) => s.id));
    expect(param(page, 'country')).toBe('FI');
    await expect(banner(page)).toContainText('Widok zawezony.');
    await expect(banner(page)).not.toContainText('przez agenta');
    await expect(banner(page)).toContainText('Kraj (kod ISO): FI');
    await expect(page.getByTestId('view-filter-count')).toContainText(`pokazane 1 z ${TOTAL}`);

    // A text field narrows by "contains"; a new narrowing replaces the old one.
    await controls.getByLabel('Kraj (kod ISO)').selectOption('');
    await controls.getByLabel('Nazwa dostawcy').fill('techn');
    await controls.getByLabel('Nazwa dostawcy').press('Enter');
    const technical = records.filter((s) => s.name.toLowerCase().includes('techn'));
    expect(technical.map((s) => s.name).sort()).toEqual(['AV Technika Sp. z o.o.', 'Łódzka Technika Sceniczna']);
    await expect.poll(() => rowIds(page)).toEqual(technical.map((s) => s.id));
    expect(param(page, 'name')).toBe('~techn');
    expect(param(page, 'country')).toBeNull();
    await expect(banner(page)).toContainText('Nazwa dostawcy zawiera „techn”');

    // Back undoes the change, and the controls follow the address.
    await page.goBack();
    await expect.poll(() => rowIds(page)).toEqual(finnish.map((s) => s.id));
    await expect(controls.getByLabel('Kraj (kod ISO)')).toHaveValue('FI');
    await expect(controls.getByLabel('Nazwa dostawcy')).toHaveValue('');

    // A narrowing made with the controls is in the next command's context, like one made by the agent.
    const { context } = await sendForRun(page, 'Co widze?');
    expect(context.filters).toEqual({
      'procurement.data': {
        predicates: [{ field: 'country', op: 'eq', value: 'FI' }],
        sort: null,
        page: { index: 1, size: 10, count: 1 },
        matched: 1,
        total: TOTAL,
      },
    });
    await settled(page);
  });

  test('(c) strony: Nastepna, Wstecz, klawiatura na naglowku wraca na strone 1, strona spoza zakresu', async ({ page }) => {
    await scripted.start('viewstate-filter-sort');
    await openApp(page);
    const { records } = await backendSuppliers(page);
    const status = page.getByTestId('data-page-status');

    // Page 1 of 2: the first ten records in the backend's own order.
    await expect(status).toHaveText('Strona 1 z 2');
    await expect.poll(() => rowIds(page)).toEqual(records.slice(0, 10).map((s) => s.id));
    await expect(page.getByTestId('data-page-prev')).toBeDisabled();

    await page.getByTestId('data-page-next').click();
    await expect(status).toHaveText('Strona 2 z 2');
    await expect.poll(() => rowIds(page)).toEqual(records.slice(10).map((s) => s.id));
    expect(param(page, 'page')).toBe('2');
    await expect(page.getByTestId('data-page-next')).toBeDisabled();
    await expect(page.getByTestId('view-page-state')).toHaveText('Strona 2 z 2.');

    // Back is the previous page; Forward the next again.
    await page.goBack();
    await expect(status).toHaveText('Strona 1 z 2');
    await expect.poll(() => rowIds(page)).toEqual(records.slice(0, 10).map((s) => s.id));
    expect(param(page, 'page')).toBeNull();
    await expect(banner(page)).toHaveCount(0);
    await page.goForward();
    await expect(status).toHaveText('Strona 2 z 2');

    // From the keyboard: the header is a button; ordering returns to page 1 and keeps focus.
    const nameButton = header(page, 'name').getByRole('button', { name: 'Nazwa' });
    await nameButton.focus();
    await page.keyboard.press('Enter');
    await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'ascending');
    expect(param(page, 'sort')).toBe('name');
    expect(param(page, 'page')).toBeNull();
    await expect(status).toHaveText('Strona 1 z 2');
    await expect.poll(() => rowIds(page)).toEqual([...records].sort(byName('asc')).slice(0, 10).map((s) => s.id));
    await expect(nameButton).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'descending');
    await expect.poll(() => rowIds(page)).toEqual([...records].sort(byName('desc')).slice(0, 10).map((s) => s.id));

    // A page that does not exist shows the last one and says so.
    await page.goto(`${BASE}/data?page=9`);
    await expect(status).toHaveText('Strona 2 z 2');
    await expect.poll(() => rowIds(page)).toEqual(records.slice(10).map((s) => s.id));
    await expect(page.getByTestId('view-page-state')).toHaveText('Strona 2 z 2 (strony 9 nie ma).');
  });

  test('(e) odmowa sortowania po nazwie: nieznane i niesortowalne pole, widok nietkniety', async ({ page }) => {
    await scripted.start('viewstate-sort-refused');
    await openApp(page, '/data?country=PL');
    await expect(rows(page)).toHaveCount(5);
    const idsBefore = await rowIds(page);
    const paramsBefore = viewParams(page);
    expect(paramsBefore).toEqual([['country', 'PL']]);

    const { runId } = await sendForRun(page, 'Posortuj po wojewodztwie, a potem po mailu.');
    await settled(page);
    await expect(answer(page)).toContainText('"reason":"not_sortable"');

    const allowed = [
      { field: 'name', label: 'Nazwa', type: 'text' },
      { field: 'taxId', label: 'NIP', type: 'text' },
      { field: 'country', label: 'Kraj', type: 'text' },
    ];
    expect((await toolResults(page, runId)).map((r) => r.result)).toEqual([
      { executed: false, reason: 'unknown_field', targetId: 'procurement.data', label: 'Dostawcy', requested: 'wojewodztwo', available: allowed },
      { executed: false, reason: 'not_sortable', targetId: 'procurement.data', label: 'Dostawcy', requested: 'contactEmail', available: allowed },
    ]);
    // Nothing on screen moved.
    expect(await rowIds(page)).toEqual(idsBefore);
    expect(viewParams(page)).toEqual(paramsBefore);
    await expect(view(page).locator('thead th[aria-sort="ascending"], thead th[aria-sort="descending"]')).toHaveCount(0);
    await expect(page.getByTestId('view-sort-state')).toHaveCount(0);
  });

  test('(e) zawezenie do zera to stan pusty „0 z N”, a wyczyszczenie przywraca pelny zakres i strone 1', async ({ page }) => {
    await scripted.start('viewstate-filter-sort');
    await openApp(page, '/data?page=2');
    await expect(page.getByTestId('data-page-status')).toHaveText('Strona 2 z 2');
    const controls = view(page).getByTestId('view-filter-controls');

    await controls.getByLabel('Nazwa dostawcy').fill('zzz-nie-ma-takiego');
    await controls.getByRole('button', { name: 'Zastosuj' }).click();

    await expect(view(page)).toHaveAttribute('data-state', 'empty');
    await expect(view(page).getByTestId('data-empty')).toHaveText(`Zaden rekord nie spelnia zawezenia — pokazane 0 z ${TOTAL}.`);
    await expect(page.getByTestId('query-error')).toHaveCount(0);
    await expect(page.getByTestId('view-filter-count')).toContainText(`pokazane 0 z ${TOTAL}`);
    // The narrowing returned to the first page, and the fields to change it are still there.
    expect(param(page, 'page')).toBeNull();
    await expect(controls.getByLabel('Nazwa dostawcy')).toHaveValue('zzz-nie-ma-takiego');

    await controls.getByRole('button', { name: 'Wyczysc' }).click();
    await expect(view(page)).toHaveAttribute('data-state', 'ready');
    await expect(rows(page)).toHaveCount(10);
    await expect(page.getByTestId('data-page-status')).toHaveText('Strona 1 z 2');
    expect(param(page, 'name')).toBeNull();
    expect(param(page, 'page')).toBeNull();
    await expect(banner(page)).toHaveCount(0);
  });

  test('(e) agent przywraca domyslny widok: bez zawezenia, porzadek widoku, strona 1', async ({ page }) => {
    await scripted.start('viewstate-clear');
    await openApp(page, '/data?country=DE&sort=-name&page=2');
    const { records } = await backendSuppliers(page);
    // Ten German suppliers, descending: one page — the address's page 2 is clamped to it.
    await expect(page.getByTestId('view-page-state')).toHaveText('Strona 1 z 1 (strony 2 nie ma).');
    await expect(rows(page)).toHaveCount(10);
    await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'descending');

    const { runId } = await sendForRun(page, 'Pokaz wszystko jak bylo.');
    await expect.poll(() => rowIds(page), { timeout: 60_000 }).toEqual(records.slice(0, 10).map((s) => s.id));
    await settled(page);
    await expect(page.getByTestId('data-page-status')).toHaveText('Strona 1 z 2');
    await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'none');
    expect(param(page, 'country')).toBeNull();
    expect(param(page, 'sort')).toBeNull();
    expect(param(page, 'page')).toBeNull();
    await expect(banner(page)).toHaveCount(0);
    // The agent's changes are navigations too: Back undoes the last one (the narrowing's removal).
    await page.goBack();
    await expect.poll(() => viewParams(page)).toEqual([['country', 'DE']]);
    await expect(rows(page)).toHaveCount(10);
    await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'none');
    await expect(banner(page)).toContainText('Kraj (kod ISO): DE');

    const [sortCleared, filterCleared] = (await toolResults(page, runId)).map((r) => r.result);
    // After clearing the order the German narrowing is still on: one page of ten.
    expect(sortCleared).toMatchObject({ executed: true, cleared: true, sorted: null, page: { index: 1, size: 10, count: 1 } });
    expect(filterCleared).toMatchObject({ executed: true, cleared: true, page: { index: 1, size: 10, count: 2 } });
  });
});
