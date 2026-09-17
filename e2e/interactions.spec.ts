import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Locator, type Page } from '@playwright/test';
import {
  formatFieldValue,
  recordsOf,
  type DataRecord,
  type ReadResponse,
  type RecordField,
} from '@platform/contracts';
import {
  MCP_PRICE,
  MCP_SUPPLIER,
  OFFER_ITEMS,
  PROJECTORS_IN_PLN,
  VIEW_COLUMNS,
  byPriceDesc,
} from './support/interactions-scenario.ts';

/**
 * L3.18: an agent's table and chart read a registered read, refresh after a
 * backend change, and their interactions run the same authorized domain
 * operation as the module's own screen.
 *
 * Symulacja: a scripted model at the adapter boundary (`interactions`
 * scenario) calls the real `agent_view_create` and `procurement_update_offer_item`
 * handlers; everything else is the real application. The agent view is the
 * one this conversation's run created (card id from the run's own tool
 * result). Every value on screen is compared with `POST /api/read`, never with
 * text the scenario wrote. The user's changes start from the table's own
 * button and form, from the keyboard where it matters; no page is reloaded.
 *
 * (a) a price changed by the action on the case screen reaches the agent's
 *     table and chart; (b) a price changed by the tool during a run reaches the
 *     open agent view while the run is still going, and the case screen;
 *     (c) the action in the agent view is the same request, the same change in
 *     the backend and on the case screen.
 *
 * Negative controls: the action sent with another identity's session is
 * refused and changes nothing; a refresh that fails after a change shows the
 * failure, never the values from before.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-interactions' });
const BASE = scripted.baseUrl;
const ACTION = 'change_unit_price';

/* ------------------------------- helpers ---------------------------------- */

async function openApp(page: Page, path = '/') {
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
  // Survives in-app navigation, not a reload: checked at the end of each test.
  await page.evaluate(() => ((window as unknown as { __sameDocument: boolean }).__sameDocument = true));
}

const expectNoReload = async (page: Page) =>
  expect(await page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);

const urlParam = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

/** A request with the page's session, outside the page (so `page.route` never touches it). */
async function backendJson<T = any>(page: Page, path: string, body?: unknown): Promise<T> {
  const res = body === undefined
    ? await page.request.get(`${BASE}${path}`)
    : await page.request.post(`${BASE}${path}`, { data: body });
  expect(res.status(), `${path}: ${await res.text()}`).toBe(200);
  return (await res.json()) as T;
}

const readItems = (page: Page, caseId: string) =>
  backendJson<ReadResponse>(page, '/api/read', { operation: OFFER_ITEMS, input: { caseId } });

const recordOf = (backend: ReadResponse, id: string) =>
  recordsOf(backend.result, backend.descriptor!).find((r) => r.id === id)!;

const priceField = (backend: ReadResponse): RecordField =>
  backend.descriptor!.fields.find((f) => f.field === 'unitPriceMinor')!;

const projectorOf = (backend: ReadResponse, supplier: string): DataRecord =>
  recordsOf(backend.result, backend.descriptor!).find(
    (r) => PROJECTORS_IN_PLN(r) && String(r.supplierName).startsWith(supplier),
  )!;

/** The item's row version, as the module's own route reports it. */
async function itemVersion(page: Page, caseId: string, itemId: string): Promise<number> {
  const detail = await backendJson<{ offers: Array<{ items: Array<{ id: string; version: number }> }> }>(
    page,
    `/api/m/procurement/cases/${caseId}`,
  );
  return detail.offers.flatMap((o) => o.items).find((i) => i.id === itemId)!.version;
}

async function caseIdOf(page: Page, code: string): Promise<string> {
  const { cases } = await backendJson<{ cases: Array<{ id: string; code: string }> }>(page, '/api/m/procurement/cases');
  return cases.find((c) => c.code === code)!.id;
}

async function lastTurnTools(page: Page, conversationId: string) {
  const messages = await backendJson<Array<Record<string, any>>>(page, `/api/threads/get/${conversationId}`);
  const turn = messages.slice(messages.map((m) => m.role).lastIndexOf('user') + 1);
  const names = new Map<string, string>();
  for (const m of turn) for (const call of m.toolCalls ?? []) names.set(call.id, call.function.name);
  return turn
    .filter((m) => m.role === 'tool')
    .map((m) => ({
      name: String(names.get(m.toolCallId)).replace(/^mcp__app__/, ''),
      isError: m.isError === true,
      body: JSON.parse(m.content),
    }));
}

const runIdNow = async (page: Page) => {
  const strip = page.getByTestId('run-state');
  return (await strip.count()) ? strip.getAttribute('data-run-id') : null;
};

async function send(page: Page, text: string) {
  const before = await runIdNow(page);
  await page.locator('.openui-agent-thread-composer__input').fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
  await expect.poll(() => runIdNow(page), { timeout: 30_000 }).not.toBe(before);
  await expect.poll(() => runIdNow(page), { timeout: 30_000 }).toBeTruthy();
}

async function sendAndFinish(page: Page, text: string) {
  await send(page, text);
  const strip = page.getByTestId('run-state');
  await expect(strip).toHaveAttribute('data-phase', /succeeded|failed/, { timeout: 60_000 });
  await expect(strip).toHaveAttribute('data-phase', 'succeeded');
}

async function openAgentViews(page: Page) {
  await page.getByRole('link', { name: 'Widoki agenta' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent-views');
}

/** The case screen, reached as a user reaches it: the list in the navigation, then the case. */
async function openCaseScreen(page: Page, caseId: string): Promise<Locator> {
  await page.getByRole('link', { name: 'Wszystkie sprawy' }).click();
  await page.getByTestId(`case-tile-${caseId}`).click();
  const detail = page.getByTestId('case-detail-page');
  await expect(detail).toBeVisible();
  const table = detail.locator(`[data-operation="${OFFER_ITEMS}"][data-component="DataTable"]`);
  await expect(table).toHaveAttribute('data-state', 'ready');
  return table;
}

/** This tab's identity, as it keeps it (Task 3's snapshot session). */
const clientIdOf = (page: Page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('platform.ui-snapshot.client') ?? '{}').clientId as string);

/** This tab's latest published description of its screen. */
async function publishedSnapshot(page: Page): Promise<any> {
  const clientId = await clientIdOf(page);
  expect(clientId).toMatch(/^ui_/);
  return (await backendJson<any>(page, `/api/ui/snapshot?clientId=${clientId}`)).snapshot;
}

/** What the published description says about the view's table, if anything. */
const tableInstance = (snapshot: any) =>
  snapshot?.instances?.find((i: any) => i.component === 'DataTable' && i.source.operation === OFFER_ITEMS) ?? null;

/** Records the view shows, in the order its `sort` puts them. */
const shownRecords = (backend: ReadResponse) =>
  recordsOf(backend.result, backend.descriptor!).filter(PROJECTORS_IN_PLN).sort(byPriceDesc);

const priceCell = (scope: Locator, id: string) => scope.locator(`td[data-record-id="${id}"][data-field="unitPriceMinor"]`);
const actionButton = (table: Locator, id: string) =>
  table.locator(`tr[data-record-id="${id}"] [data-record-action="${ACTION}"]`);

/**
 * Performs the price action on one row from the keyboard: focus its button,
 * Enter opens the form with the field focused, the value is typed, Enter
 * submits; the focus comes back to the button. Returns the request sent.
 */
async function changePriceByKeyboard(page: Page, table: Locator, record: DataRecord, typed: string) {
  const button = actionButton(table, String(record.id));
  await expect(button).toHaveAccessibleName(`Zmien cene: ${record.name}`);
  await button.focus();
  await page.keyboard.press('Enter');
  const form = table.getByTestId('record-action-form');
  await expect(form).toHaveAttribute('data-record-id', String(record.id));
  await expect(form.getByLabel('Nowa cena jednostkowa')).toBeFocused();
  await page.keyboard.type(typed);
  const request = page.waitForRequest((r) => r.url().endsWith('/api/actions') && r.method() === 'POST');
  const response = page.waitForResponse((r) => r.url().endsWith('/api/actions'));
  await page.keyboard.press('Enter');
  const sent = (await request).postDataJSON();
  expect((await response).status()).toBe(200);
  const status = table.getByTestId('record-action-status');
  await expect(status).toContainText('Zmien cene: zapisano.');
  await expect(form).toHaveCount(0);
  await expect(button).toBeFocused();
  // Once the rows are back, nothing claims they are still being read again.
  await expect(table).not.toHaveAttribute('data-refreshing', 'true');
  await expect(status).toHaveText('Zmien cene: zapisano.');
  return { sent, answer: await (await response).json() };
}

/**
 * The agent view's table and chart equal the backend: the rows the view's
 * filter keeps, in order, cell by cell; the chart's series range and unit.
 */
async function expectViewMatchesBackend(card: Locator, backend: ReadResponse) {
  const descriptor = backend.descriptor!;
  // The composition orders by price, so this is the order on screen too.
  const records = shownRecords(backend);
  expect(records.length).toBe(3);

  const table = card.locator('[data-component="DataTable"]');
  await expect(table).toHaveAttribute('data-state', 'ready');
  await expect(table).not.toHaveAttribute('data-refreshing', 'true');
  const rows = table.locator('tbody tr[data-record-id]');
  await expect(rows).toHaveCount(records.length);
  expect(await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-record-id')))).toEqual(
    records.map((r) => String(r.id)),
  );
  for (const record of records) {
    for (const name of VIEW_COLUMNS) {
      const field = descriptor.fields.find((f) => f.field === name)!;
      await expect(table.locator(`td[data-record-id="${record.id}"][data-field="${name}"]`)).toHaveText(
        formatFieldValue(record, field),
      );
    }
    // Every row offers the read's action, as on the case screen.
    await expect(actionButton(table, String(record.id))).toHaveCount(1);
  }

  const figure = card.locator('figure[data-component="DataChart"]');
  await expect(figure).toHaveAttribute('data-state', 'ready');
  await expect(figure).not.toHaveAttribute('data-refreshing', 'true');
  const field = priceField(backend);
  const byPrice = [...records].sort((a, b) => (a.unitPriceMinor as number) - (b.unitPriceMinor as number));
  const min = byPrice[0]!;
  const max = byPrice.at(-1)!;
  const series = figure.locator('figcaption [data-series="unitPriceMinor"]');
  await expect(series).toHaveAttribute('data-unit', 'PLN');
  await expect(series).toHaveAttribute('data-min', String((min.unitPriceMinor as number) / 100));
  await expect(series).toHaveAttribute('data-max', String((max.unitPriceMinor as number) / 100));
  await expect(series).toContainText(`od ${formatFieldValue(min, field)} do ${formatFieldValue(max, field)}`);
  await expect(figure.locator('figcaption')).toContainText(`kategorie: Dostawca (${records.length})`);
}

/**
 * Records every text the agent view's price cell of one record shows from now
 * on, including a value drawn for a single frame before a refetch replaces it.
 */
async function watchAgentViewPrice(page: Page, recordId: string) {
  await page.evaluate((id) => {
    const w = window as unknown as { __seen: string[]; __seenObserver?: MutationObserver };
    w.__seen = [];
    w.__seenObserver?.disconnect();
    const look = () => {
      for (const td of document.querySelectorAll(
        `[data-testid="agent-views-page"] td[data-record-id="${id}"][data-field="unitPriceMinor"]`,
      )) {
        const text = td.textContent ?? '';
        if (w.__seen.at(-1) !== text) w.__seen.push(text);
      }
    };
    w.__seenObserver = new MutationObserver(look);
    w.__seenObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
  }, recordId);
}
const seenPrices = (page: Page) => page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);

/* -------------------------------- tests ----------------------------------- */

let conversationId = '';
let cardId = '';
let caseId = '';

test.describe('interakcje widokow agenta', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(async () => {
    scripted.prepareDatabase();
    await scripted.start('interactions');
  });
  test.afterAll(() => scripted.stop());

  test('(a) widok agenta z tabela i wykresem; zmiana ceny akcja na ekranie sprawy jest w widoku agenta bez przeladowania', async ({ page }) => {
    await openApp(page);
    await openAgentViews(page);
    await sendAndFinish(page, '[widok] Pokaz ceny projektorow w PLN jako tabele i wykres');
    conversationId = urlParam(page, 'c')!;
    const created = (await lastTurnTools(page, conversationId)).filter((t) => t.name === 'agent_view_create');
    expect(created.map((t) => t.isError)).toEqual([false]);
    cardId = created[0]!.body.cardId as string;

    const viewsPage = page.getByTestId('agent-views-page');
    await expect(viewsPage).toHaveAttribute('data-state', 'ready');
    const card = page.getByTestId(`card-${cardId}`);
    caseId = await caseIdOf(page, 'PC-2026-01');
    let backend = await readItems(page, caseId);
    await expectViewMatchesBackend(card, backend);

    const target = projectorOf(backend, 'AV Technika');
    const before = formatFieldValue(target, priceField(backend));
    const version = await itemVersion(page, caseId, String(target.id));

    /* ------------------- the action on the case screen -------------------- */
    const itemsTable = await openCaseScreen(page, caseId);
    await expect(priceCell(itemsTable, String(target.id))).toHaveText(before);
    const rowCount = await itemsTable.locator('tbody tr').count();

    const { sent, answer } = await changePriceByKeyboard(page, itemsTable, target, '9 999,50');
    expect(sent).toMatchObject({ operation: OFFER_ITEMS, input: { caseId }, action: ACTION, recordId: target.id, values: { unitPrice: '9 999,50' } });
    expect(answer.changed).toContain(`case:${caseId}`);

    backend = await readItems(page, caseId);
    const after = recordOf(backend, String(target.id));
    expect(after.unitPriceMinor).toBe(999950);
    expect(await itemVersion(page, caseId, String(target.id))).toBe(version + 1);
    const afterText = formatFieldValue(after, priceField(backend));
    // A literal too, so the formatter cannot only agree with itself (Polish groups from five digits).
    expect(afterText).toBe('9999,50 PLN');
    // The screen the action was taken on shows it in place.
    await expect(priceCell(itemsTable, String(target.id))).toHaveText(afterText);
    await expect(itemsTable.locator('tbody tr')).toHaveCount(rowCount);

    /* ----------------- the agent view, without a reload ------------------- */
    await watchAgentViewPrice(page, String(target.id));
    await openAgentViews(page);
    await expect(priceCell(card, String(target.id))).toHaveText(afterText);
    await expectViewMatchesBackend(card, backend);
    // It never showed the price from before the change, not even for a frame.
    expect(await seenPrices(page)).not.toContain(before);
    expect(await seenPrices(page)).toContain(afterText);
    await expectNoReload(page);
  });

  test('(b) zmiana narzedziem MCP w wykonaniu odswieza tabele i wykres widoku agenta jeszcze w trakcie wykonania, potem ekran sprawy', async ({ page }) => {
    await openApp(page, `/?c=${conversationId}`);
    await openAgentViews(page);
    const card = page.getByTestId(`card-${cardId}`);
    let backend = await readItems(page, caseId);
    await expectViewMatchesBackend(card, backend);
    const target = projectorOf(backend, MCP_SUPPLIER);
    const version = await itemVersion(page, caseId, String(target.id));
    const expected = formatFieldValue({ ...target, unitPriceMinor: MCP_PRICE * 100 }, priceField(backend));
    await expect(priceCell(card, String(target.id))).not.toHaveText(expected);

    // A form the user has open in this view while the run changes data: the
    // refresh must not take it, nor what they have typed into it, with it.
    const table = card.locator('[data-component="DataTable"]');
    const editedRow = projectorOf(backend, 'AV Technika');
    await actionButton(table, String(editedRow.id)).click();
    const openForm = table.getByTestId('record-action-form');
    await expect
      .poll(async () => tableInstance(await publishedSnapshot(page))?.state, { timeout: 20_000 })
      .toBe('ready');
    const described = tableInstance(await publishedSnapshot(page));
    await openForm.getByLabel('Nowa cena jednostkowa').fill('111');
    // The description Task 3 publishes is about the records, not about the
    // form: opening one changes neither the state, the page nor the rows.
    await page.waitForTimeout(1500);
    expect(tableInstance(await publishedSnapshot(page))).toEqual(described);

    await send(page, '[mcp] Zmien cene projektora MediaPro na 14 250 PLN');
    const strip = page.getByTestId('run-state');
    await expect(strip).toHaveAttribute('data-phase', 'running');

    // The open view shows the change while the run is still going: through the
    // run's `data_changed`, not the refresh every run gets when it ends.
    await expect(priceCell(card, String(target.id))).toHaveText(expected, { timeout: 5_000 });
    await expect(strip).toHaveAttribute('data-phase', 'running');
    await expect(openForm).toHaveCount(1);
    await expect(openForm.getByLabel('Nowa cena jednostkowa')).toHaveValue('111');
    await openForm.getByRole('button', { name: 'Anuluj' }).click();
    await expect(openForm).toHaveCount(0);
    backend = await readItems(page, caseId);
    expect(recordOf(backend, String(target.id)).unitPriceMinor).toBe(MCP_PRICE * 100);
    await expectViewMatchesBackend(card, backend);
    await expect(strip).toHaveAttribute('data-phase', 'running');

    await expect(strip).toHaveAttribute('data-phase', 'succeeded', { timeout: 30_000 });
    const update = (await lastTurnTools(page, conversationId)).filter((t) => t.name === 'procurement_update_offer_item');
    expect(update.map((t) => t.isError)).toEqual([false]);
    expect(update[0]!.body.item).toMatchObject({ id: target.id, unitPriceMinor: MCP_PRICE * 100, version: version + 1 });

    const itemsTable = await openCaseScreen(page, caseId);
    await expect(priceCell(itemsTable, String(target.id))).toHaveText(expected);
    await expectNoReload(page);
  });

  test('(c) akcja w widoku agenta: ten sam request, zmiana w backendzie, w tabeli i wykresie widoku oraz na ekranie sprawy', async ({ page }) => {
    await openApp(page, `/?c=${conversationId}`);
    await openAgentViews(page);
    const card = page.getByTestId(`card-${cardId}`);
    let backend = await readItems(page, caseId);
    await expectViewMatchesBackend(card, backend);
    const target = projectorOf(backend, 'Konferencje24');
    const version = await itemVersion(page, caseId, String(target.id));

    const table = card.locator('[data-component="DataTable"]');
    await expect
      .poll(async () => tableInstance(await publishedSnapshot(page))?.state, { timeout: 20_000 })
      .toBe('ready');
    const describedBefore = await publishedSnapshot(page);

    const { sent, answer } = await changePriceByKeyboard(page, table, target, '8 750,25');
    // The request the case screen sends for the same change: same read, same action.
    expect(sent).toMatchObject({ operation: OFFER_ITEMS, input: { caseId }, action: ACTION, recordId: target.id, values: { unitPrice: '8 750,25' } });
    expect(answer.changed).toContain(`case:${caseId}`);

    backend = await readItems(page, caseId);
    const after = recordOf(backend, String(target.id));
    expect(after.unitPriceMinor).toBe(875025);
    expect(await itemVersion(page, caseId, String(target.id))).toBe(version + 1);
    const afterText = formatFieldValue(after, priceField(backend));
    // Table and chart of the view the action was taken in, in place.
    await expect(priceCell(card, String(target.id))).toHaveText(afterText);
    await expect(card.locator('figcaption [data-series="unitPriceMinor"]')).toHaveAttribute('data-min', '8750.25');
    await expectViewMatchesBackend(card, backend);

    /*
     * What `ui_state` would hand the agent now. The description carries no
     * values (the agent reads those through `POST /api/read`), but the price
     * orders the rows — so the change shows up as a new version describing the
     * new order, and the screen from before the action is not the current one.
     */
    const order = shownRecords(backend).map((r) => String(r.id));
    await expect
      .poll(async () => tableInstance(await publishedSnapshot(page))?.visibleRecordIds.join(','), { timeout: 20_000 })
      .toBe(order.join(','));
    const describedAfter = await publishedSnapshot(page);
    expect(describedAfter.version).toBeGreaterThan(describedBefore.version);
    const instance = tableInstance(describedAfter);
    expect(instance.state).toBe('ready');
    expect(instance.matched).toBe(order.length);
    expect(instance.actions).toContain(`action:${ACTION}`);
    expect(tableInstance(describedBefore).visibleRecordIds).not.toEqual(order);
    // The rows on screen are in that order too.
    expect(
      await table.locator('tbody tr[data-record-id]').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-record-id'))),
    ).toEqual(order);

    const itemsTable = await openCaseScreen(page, caseId);
    await expect(priceCell(itemsTable, String(target.id))).toHaveText(afterText);
    await expectNoReload(page);
  });

  test('kontrola negatywna: akcja wyslana z sesja drugiego wlasciciela jest odrzucona i nic nie zmienia', async ({ page }) => {
    await openApp(page, `/?c=${conversationId}`);
    await openAgentViews(page);
    const card = page.getByTestId(`card-${cardId}`);
    const backend = await readItems(page, caseId);
    await expectViewMatchesBackend(card, backend);
    const target = projectorOf(backend, 'AV Technika');
    const before = recordOf(backend, String(target.id)).unitPriceMinor;
    const version = await itemVersion(page, caseId, String(target.id));

    const table = card.locator('[data-component="DataTable"]');
    await actionButton(table, String(target.id)).click();
    const form = table.getByTestId('record-action-form');
    await form.getByLabel('Nowa cena jednostkowa').fill('1');

    // In another tab of the same browser, the application now acts as the other identity.
    const other = await page.context().newPage();
    await other.goto(`${BASE}/settings`);
    const owner = other.getByTestId('access-owner');
    await expect(owner).not.toHaveText('—');
    const firstOwner = (await owner.textContent())!.trim();
    await other.getByTestId('switch-access-context').click();
    await expect(owner).not.toHaveText(firstOwner);

    // The form still open in the first tab is submitted — with the other identity's session.
    await page.bringToFront();
    const response = page.waitForResponse((r) => r.url().endsWith('/api/actions'));
    await form.getByRole('button', { name: 'Zapisz' }).click();
    expect((await response).status()).toBe(403);
    const refusal = card.getByTestId('record-action-error');
    await expect(refusal).toHaveAttribute('data-error-code', 'forbidden');
    // The view re-reads as that session's owner: no access, not the rows the action was refused on.
    await expect(table).toHaveAttribute('data-state', 'forbidden');
    await expect(card.locator('figure[data-component="DataChart"]')).toHaveAttribute('data-state', 'forbidden');
    await expect(refusal).toBeVisible();
    await expect(card.locator('td[data-field="unitPriceMinor"]')).toHaveCount(0);
    await expect(card).not.toContainText('1,00 PLN');

    await other.getByTestId('switch-access-context').click();
    await expect(owner).toHaveText(firstOwner);
    const unchanged = await readItems(other, caseId);
    expect(recordOf(unchanged, String(target.id)).unitPriceMinor).toBe(before);
    expect(await itemVersion(other, caseId, String(target.id))).toBe(version);
    await other.close();

    // Back as the first owner, the view reads the unchanged price.
    await page.getByRole('link', { name: 'Wszystkie sprawy' }).click();
    await openAgentViews(page);
    await expectViewMatchesBackend(card, unchanged);
    await expectNoReload(page);
  });

  test('kontrola negatywna: nieudane odswiezenie po zmianie pokazuje blad, nie wartosci sprzed zmiany', async ({ page }) => {
    await openApp(page, `/?c=${conversationId}`);
    await openAgentViews(page);
    const card = page.getByTestId(`card-${cardId}`);
    let backend = await readItems(page, caseId);
    await expectViewMatchesBackend(card, backend);
    const target = projectorOf(backend, 'Konferencje24');
    const beforeText = formatFieldValue(target, priceField(backend));
    const table = card.locator('[data-component="DataTable"]');
    const figure = card.locator('figure[data-component="DataChart"]');

    // From now on every read in this tab fails, slowly enough to see the refresh under way.
    let failing = true;
    await page.route('**/api/read', async (route) => {
      if (!failing) return route.continue();
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'internal', message: 'Awaria odczytu (test)' } }),
      });
    });

    await actionButton(table, String(target.id)).click();
    const form = table.getByTestId('record-action-form');
    await form.getByLabel('Nowa cena jednostkowa').fill('7 000');
    await form.getByRole('button', { name: 'Zapisz' }).click();
    const status = table.getByTestId('record-action-status');
    await expect(status).toContainText('Zmien cene: zapisano.');

    // While the rows are read again they say so; the previous values are not presented as current.
    await expect(table).toHaveAttribute('data-refreshing', 'true');
    await expect(status).toContainText('Dane sa ponownie wczytywane z backendu.');
    await expect(figure).toHaveAttribute('data-refreshing', 'true');
    await expect(table.getByTestId('data-refreshing')).toHaveText('Odswiezanie danych…');

    // The refresh fails: the failure in place of the rows and of the chart, no value from before.
    await expect(table).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
    await expect(figure).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
    await expect(table.getByTestId('query-error')).toContainText('Awaria odczytu (test)');
    // The read is over (it failed): the note about re-reading is gone, the save stands.
    await expect(status).toHaveText('Zmien cene: zapisano.');
    await expect(figure.getByTestId('query-error')).toBeVisible();
    await expect(card.locator('td[data-field="unitPriceMinor"]')).toHaveCount(0);
    await expect(card.locator('figcaption')).toHaveCount(0);
    await expect(card).not.toContainText(beforeText);

    // The change itself was made.
    backend = await readItems(page, caseId);
    expect(recordOf(backend, String(target.id)).unitPriceMinor).toBe(700000);

    // Once reads work again, the view shows the backend's value.
    failing = false;
    await page.getByRole('link', { name: 'Wszystkie sprawy' }).click();
    await openAgentViews(page);
    await expect(priceCell(card, String(target.id))).toHaveText(
      formatFieldValue(recordOf(backend, String(target.id)), priceField(backend)),
    );
    await expectViewMatchesBackend(card, backend);
    await expectNoReload(page);
  });

  test('zgubiona odpowiedz, a potem poprawiona wartosc: druga proba ma wlasny operationId, nie konflikt', async ({ page }) => {
    await openApp(page, `/?c=${conversationId}`);
    await openAgentViews(page);
    const card = page.getByTestId(`card-${cardId}`);
    let backend = await readItems(page, caseId);
    await expectViewMatchesBackend(card, backend);
    const target = projectorOf(backend, 'Konferencje24');
    const table = card.locator('[data-component="DataTable"]');
    const field = priceField(backend);

    const sent: any[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/api/actions')) sent.push(r.postDataJSON());
    });
    /*
     * The first save reaches the backend and its answer never comes back — the
     * case the replay guard exists for, and the one in which a user naturally
     * tries again with a different number.
     */
    let dropAnswer = true;
    await page.route('**/api/actions', async (route) => {
      if (!dropAnswer) return route.continue();
      dropAnswer = false;
      await route.fetch();
      await route.abort('failed');
    });

    await actionButton(table, String(target.id)).click();
    const form = table.getByTestId('record-action-form');
    await form.getByLabel('Nowa cena jednostkowa').fill('5 000');
    await form.getByRole('button', { name: 'Zapisz' }).click();
    await expect(form.getByTestId('record-action-error')).toBeVisible();

    // The change did happen, and the re-read after the failure shows it.
    backend = await readItems(page, caseId);
    expect(recordOf(backend, String(target.id)).unitPriceMinor).toBe(500000);
    await expect(priceCell(card, String(target.id))).toHaveText(
      formatFieldValue(recordOf(backend, String(target.id)), field),
    );

    // The user corrects the value and saves again: a different change, so a
    // different operationId — not a refusal about their own earlier attempt.
    await form.getByLabel('Nowa cena jednostkowa').fill('5 100');
    await form.getByRole('button', { name: 'Zapisz' }).click();
    await expect(table.getByTestId('record-action-status')).toContainText('Zmien cene: zapisano.');
    await expect(form).toHaveCount(0);
    await expect(table.getByTestId('record-action-error')).toHaveCount(0);

    backend = await readItems(page, caseId);
    expect(recordOf(backend, String(target.id)).unitPriceMinor).toBe(510000);
    await expect(priceCell(card, String(target.id))).toHaveText(
      formatFieldValue(recordOf(backend, String(target.id)), field),
    );
    expect(sent).toHaveLength(2);
    expect(sent[0].values).toEqual({ unitPrice: '5 000' });
    expect(sent[1].values).toEqual({ unitPrice: '5 100' });
    expect(sent[0].operationId).not.toBe(sent[1].operationId);
    await expectViewMatchesBackend(card, backend);
    await expectNoReload(page);
  });
});
