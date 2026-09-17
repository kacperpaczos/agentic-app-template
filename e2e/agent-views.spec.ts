import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Locator, type Page } from '@playwright/test';
import { formatFieldValue, recordsOf, type DataRecord, type ReadResponse } from '@platform/contracts';
import { BACKGROUND_TITLE } from './support/agent-views-scenario.ts';

/**
 * "Widoki agenta": a conversation's own presentation space.
 *
 * Symulacja: a scripted model at the adapter boundary (`agent-views` scenario),
 * everything else real. Each command is sent from the chat composer; the run
 * calls the real `agent_view_*` handlers with its own context, and the test
 * reads the result where a user would — on the "Widoki agenta" page opened from
 * the navigation. Card ids come from the tool results of the run under test and
 * values are compared with `POST /api/read`, never with text the scenario
 * wrote.
 *
 * Negative controls: a composition with an unknown component, one drawing
 * literal numbers and one naming an unregistered read are refused and the
 * previous version stays on screen; a run in conversation A that creates a view
 * while the user is in B changes neither B's address nor B's screen; a
 * composition streamed into a chat answer never sends a read for a half-written
 * operation name.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-agentviews' });
const BASE = scripted.baseUrl;
const TABLE_COLUMNS = ['supplierName', 'currency', 'priceBasis', 'totalMinor', 'deliveryDays'];

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
}

const urlParam = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

async function getJson<T = any>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    { path, body },
  ).then((r) => {
    expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBe(200);
    return r.body as T;
  });
}

const readBackend = (page: Page, operation: string, input?: Record<string, unknown>) =>
  getJson<ReadResponse>(page, '/api/read', { operation, ...(input ? { input } : {}) });

const agentViewsOf = (page: Page, conversationId: string) =>
  getJson<{ space: { id: string } | null; cards: Array<Record<string, any>> }>(
    page,
    `/api/conversations/${conversationId}/agent-views`,
  );

async function caseIdOf(page: Page, code: string): Promise<string> {
  const { cases } = await getJson<{ cases: Array<{ id: string; code: string }> }>(page, '/api/m/procurement/cases');
  return cases.find((c) => c.code === code)!.id;
}

/** Sends a command and waits for *its* run — not a previous one — to succeed. */
async function sendAndFinish(page: Page, text: string) {
  const strip = page.getByTestId('run-state');
  const runIdNow = async () => ((await strip.count()) ? await strip.getAttribute('data-run-id') : null);
  const before = await runIdNow();
  const composer = page.locator('.openui-agent-thread-composer__input');
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
  await expect.poll(runIdNow, { timeout: 30_000 }).not.toBe(before);
  await expect.poll(runIdNow, { timeout: 30_000 }).toBeTruthy();
  await expect(strip).toHaveAttribute('data-phase', /succeeded|failed/, { timeout: 60_000 });
  await expect(strip).toHaveAttribute('data-phase', 'succeeded');
}

/**
 * The tool calls of the latest turn of a conversation, with their results, as
 * the conversation history stores them: name, whether it failed, parsed answer.
 */
async function lastTurnTools(page: Page, conversationId: string) {
  const messages = await getJson<Array<Record<string, any>>>(page, `/api/threads/get/${conversationId}`);
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

/** The card id `agent_view_create` returned in the latest turn — read on screen and in history. */
async function lastCreatedCardId(page: Page): Promise<string> {
  const conversationId = urlParam(page, 'c')!;
  const created = (await lastTurnTools(page, conversationId)).filter((t) => t.name === 'agent_view_create');
  expect(created.map((t) => t.isError), 'agent_view_create w tej turze').toEqual([false]);
  const cardId = created[0]!.body.cardId as string;
  // The answer on screen carries the same result the history does.
  await expect(page.locator('.openui-agent-thread-messages')).toContainText(`[call:agent_view_create] {"cardId":"${cardId}"`);
  return cardId;
}

async function openAgentViews(page: Page) {
  await page.getByRole('link', { name: 'Widoki agenta' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent-views');
}

/**
 * Picks a conversation from the chat's drawer, as a user does. The drawer is
 * off-canvas while closed (present, so "visible" to a locator), hence it is
 * opened by its control whenever its state says collapsed, and the row is
 * clicked only once the drawer is expanded.
 */
async function switchConversation(page: Page, title: string) {
  const drawer = page.locator('.openui-agent-sidebar-container');
  if ((await drawer.getAttribute('data-sidebar-visual-state')) !== 'expanded') {
    await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
  }
  await expect(drawer).toHaveAttribute('data-sidebar-visual-state', 'expanded');
  const row = page.locator('.openui-agent-thread-button', { hasText: title }).first();
  await expect(row).toBeVisible();
  // Let the slide finish so the click lands on the row, not where it was.
  await page.waitForTimeout(500);
  // `force`: the list re-renders as it loads and never settles for the stability check.
  await row.click({ force: true });
}

const nodes = (page: Page) => page.getByTestId('agent-views-page').locator('.react-flow__node');

/** Rows of a (possibly grouped) table equal the backend's records, cell by cell, in order. */
async function expectRowsMatchBackend(table: Locator, backend: ReadResponse, columns: string[], records?: DataRecord[]) {
  const descriptor = backend.descriptor!;
  const expected = records ?? recordsOf(backend.result, descriptor);
  expect(expected.length).toBeGreaterThan(0);
  const rows = table.locator('tr[data-record-id]');
  await expect(rows).toHaveCount(expected.length);
  expect(await table.locator('thead th').evaluateAll((ths) => ths.map((th) => th.textContent))).toEqual(
    columns.map((c) => descriptor.fields.find((f) => f.field === c)!.label),
  );
  for (const record of expected) {
    const id = String(record[descriptor.record.idField]);
    for (const name of columns) {
      const field = descriptor.fields.find((f) => f.field === name)!;
      const cell = table.locator(`td[data-record-id="${id}"][data-field="${name}"]`);
      await expect(cell).toHaveCount(1);
      expect(await cell.textContent(), `${id}.${name}`).toBe(formatFieldValue(record, field));
    }
  }
}

/* -------------------------------- tests ----------------------------------- */

let conversationA = '';
let conversationB = '';
let tableCardId = '';
let chartCardId = '';
const TITLE_A = '[zestawienie] Zestawienie ofert w rozmowie alfa';
const TITLE_B = '[zestawienie] Zestawienie ofert w rozmowie beta';

test.describe('widoki agenta', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    scripted.prepareDatabase();
    await scripted.start('agent-views');
  });
  test.afterAll(() => scripted.stop());

  test('zestawienie i wykres z wykonania sa w Widokach agenta z wartosciami i podpisem jak backend', async ({ page }) => {
    await openApp(page);
    // The working space the user is on; agent views must never move it.
    await expect.poll(() => urlParam(page, 's'), { timeout: 15_000 }).toBeTruthy();
    const workingSpace = urlParam(page, 's');

    await openAgentViews(page);
    const viewsPage = page.getByTestId('agent-views-page');
    await expect(viewsPage).toHaveAttribute('data-state', 'no-conversation');

    /* ------------------------------- table -------------------------------- */
    await sendAndFinish(page, TITLE_A);
    conversationA = urlParam(page, 'c')!;
    expect(conversationA).toBeTruthy();
    tableCardId = await lastCreatedCardId(page);

    await expect(viewsPage).toHaveAttribute('data-state', 'ready');
    await expect(viewsPage).toHaveAttribute('data-conversation-id', conversationA);
    const tableCard = page.getByTestId(`card-${tableCardId}`);
    await expect(tableCard).toHaveAttribute('data-component', 'openui');
    const table = tableCard.locator('[data-component="DataTable"]');
    await expect(table).toHaveAttribute('data-state', 'ready');
    await expect(table).toHaveAttribute('data-operation', 'procurement.comparison');

    const caseId = await caseIdOf(page, 'PC-2026-01');
    const comparison = await readBackend(page, 'procurement.comparison', { caseId });
    await expectRowsMatchBackend(table, comparison, TABLE_COLUMNS);

    // The card is the one this run created, in this conversation's space — and only it.
    const afterTable = await agentViewsOf(page, conversationA);
    expect(afterTable.cards.map((c) => c.id)).toEqual([tableCardId]);
    await expect(viewsPage).toHaveAttribute('data-space-id', afterTable.space!.id);
    expect(afterTable.space!.id).not.toBe(workingSpace);

    /* ------------------------------- chart -------------------------------- */
    await sendAndFinish(page, '[wykres] Dodaj wykres sum ofert');
    chartCardId = await lastCreatedCardId(page);
    expect(chartCardId).not.toBe(tableCardId);

    const figure = page.getByTestId(`card-${chartCardId}`).locator('figure[data-component="DataChart"]');
    await expect(figure).toHaveAttribute('data-state', 'ready');
    await expect(figure.locator('svg').first()).toBeVisible();
    const totalField = comparison.descriptor!.fields.find((f) => f.field === 'totalMinor')!;
    const pln = recordsOf(comparison.result, comparison.descriptor!).filter(
      (r) => r.currency === 'PLN' && typeof r.totalMinor === 'number',
    );
    expect(pln.length).toBeGreaterThan(1);
    const min = pln.reduce((a, b) => ((a.totalMinor as number) <= (b.totalMinor as number) ? a : b));
    const max = pln.reduce((a, b) => ((a.totalMinor as number) >= (b.totalMinor as number) ? a : b));
    const series = figure.locator('figcaption [data-series="totalMinor"]');
    await expect(series).toHaveAttribute('data-unit', 'PLN');
    await expect(series).toHaveAttribute('data-min', String((min.totalMinor as number) / 100));
    await expect(series).toHaveAttribute('data-max', String((max.totalMinor as number) / 100));
    expect(await series.textContent()).toContain(
      `Seria Suma [PLN]: od ${formatFieldValue(min, totalField)} do ${formatFieldValue(max, totalField)}`,
    );
    await expect(figure.locator('figcaption')).toContainText(`Wykres slupkowy, kategorie: Dostawca (${pln.length})`);

    await expect(page.getByTestId(`card-${tableCardId}`)).toBeVisible();
    const both = await agentViewsOf(page, conversationA);
    expect(both.cards.map((c) => c.id)).toEqual([tableCardId, chartCardId]);
    // The chart was placed below the table, and rendering both did not move it back onto the table.
    await page.waitForTimeout(1000);
    const placed = (await agentViewsOf(page, conversationA)).cards;
    expect(placed[1]!.geometry.y).toBeGreaterThanOrEqual(placed[0]!.geometry.y + placed[0]!.geometry.height);
    expect(placed.map((c) => c.geometryVersion)).toEqual([1, 1]);
    // Two views later, the user is still on the same screen and working space.
    expect(new URL(page.url()).pathname).toBe('/agent-views');
    expect(urlParam(page, 's')).toBe(workingSpace);
  });

  test('patch zmienia grupowanie i rodzaj wykresu; druga karta i przesuniecie uzytkownika zostaja', async ({ page }) => {
    await openApp(page, `/?c=${conversationA}`);
    await openAgentViews(page);
    await expect(page.getByTestId('agent-views-page')).toHaveAttribute('data-state', 'ready');
    await expect(nodes(page)).toHaveCount(2);

    // The user moves the table.
    const header = page.locator(`[data-testid="card-${tableCardId}"] .pf-card__head`);
    const box = (await header.boundingBox())!;
    const saved = page.waitForResponse(
      (r) => r.url().endsWith(`/api/canvas/cards/${tableCardId}/geometry`) && r.request().method() === 'PATCH',
    );
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 560, box.y + box.height / 2 + 30, { steps: 15 });
    await page.mouse.up();
    expect((await saved).ok()).toBe(true);
    const moved = (await agentViewsOf(page, conversationA)).cards.find((c) => c.id === tableCardId)!;
    expect(moved.geometry.x).toBeGreaterThan(400);
    const movedBox = (await page.getByTestId(`card-${tableCardId}`).boundingBox())!;
    const chartBefore = (await agentViewsOf(page, conversationA)).cards.find((c) => c.id === chartCardId)!;

    /* ----------------------------- grouping ------------------------------- */
    await sendAndFinish(page, '[grupowanie] Pogrupuj zestawienie wedlug waluty');

    const table = page.getByTestId(`card-${tableCardId}`).locator('[data-component="DataTable"]');
    const caseId = await caseIdOf(page, 'PC-2026-01');
    const comparison = await readBackend(page, 'procurement.comparison', { caseId });
    const records = recordsOf(comparison.result, comparison.descriptor!);
    const currencies = [...new Set(records.map((r) => String(r.currency)))];
    expect(currencies.length).toBeGreaterThan(1);
    const groups = table.locator('tbody[data-group-field="currency"]');
    await expect(groups).toHaveCount(currencies.length);
    for (const [i, currency] of currencies.entries()) {
      const inGroup = records.filter((r) => r.currency === currency);
      const group = groups.nth(i);
      await expect(group.locator('th[scope="rowgroup"]')).toContainText(`Waluta: ${currency}`);
      await expect(group.locator('[data-group-count]')).toHaveAttribute('data-group-count', String(inGroup.length));
      expect(await group.locator('tr[data-record-id]').evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-record-id')))).toEqual(
        inGroup.map((r) => String(r.offerId)),
      );
    }
    await expectRowsMatchBackend(
      table,
      comparison,
      TABLE_COLUMNS,
      currencies.flatMap((c) => records.filter((r) => r.currency === c)),
    );

    const afterGrouping = await agentViewsOf(page, conversationA);
    expect(afterGrouping.cards.map((c) => c.id)).toEqual([tableCardId, chartCardId]);
    const tableAfter = afterGrouping.cards.find((c) => c.id === tableCardId)!;
    expect(tableAfter.specVersion).toBe(moved.specVersion + 1);
    expect(tableAfter.geometry).toEqual(moved.geometry);
    expect(afterGrouping.cards.find((c) => c.id === chartCardId)).toEqual(chartBefore);
    const boxAfter = (await page.getByTestId(`card-${tableCardId}`).boundingBox())!;
    expect(Math.abs(boxAfter.x - movedBox.x)).toBeLessThan(2);
    expect(Math.abs(boxAfter.y - movedBox.y)).toBeLessThan(2);

    /* ---------------------------- chart kind ------------------------------ */
    await sendAndFinish(page, '[typ] Zmien wykres na liniowy');
    const figure = page.getByTestId(`card-${chartCardId}`).locator('figure[data-component="DataChart"]');
    await expect(figure.locator('figcaption')).toContainText('Wykres liniowy, kategorie: Dostawca');
    await expect(figure).toHaveAttribute('data-state', 'ready');
    const afterKind = await agentViewsOf(page, conversationA);
    expect(afterKind.cards.find((c) => c.id === chartCardId)!.specVersion).toBe(chartBefore.specVersion + 1);
    expect(afterKind.cards.find((c) => c.id === chartCardId)!.geometry).toEqual(chartBefore.geometry);
    expect(afterKind.cards.find((c) => c.id === tableCardId)).toEqual(tableAfter);
    await expect(groups).toHaveCount(currencies.length);
  });

  test('nieznany komponent, wykres z wpisanymi liczbami i niezarejestrowana operacja sa odrzucane, poprzednia wersja zostaje', async ({
    page,
  }) => {
    await openApp(page, `/?c=${conversationA}`);
    await openAgentViews(page);
    await expect(nodes(page)).toHaveCount(2);
    const before = await agentViewsOf(page, conversationA);

    await sendAndFinish(page, '[odmowy] Sprobuj niedozwolonych widokow');

    // On screen: the turn reports three failed tool calls, the last refusal in words.
    await expect(page.getByRole('button', { name: 'Behind the scenes · 3 failed' })).toBeVisible();
    await expect(page.locator('.openui-agent-thread-messages')).toContainText(
      'Nieznana operacja odczytu "procurement.nie_ma"',
    );
    // In the run's tool results: each refusal with its reason.
    const tools = await lastTurnTools(page, conversationA);
    expect(tools.map((t) => [t.name, t.isError, t.body.details?.reason ?? null])).toEqual([
      ['agent_views_list', false, null],
      ['agent_view_update', true, 'unknown_component'],
      ['agent_view_create', true, 'component_not_allowed'],
      ['agent_view_create', true, 'unknown_operation'],
    ]);
    expect(tools[1]!.body.message).toMatch(/nieznany komponent Wykresik/);
    expect(tools[2]!.body.message).toMatch(/BarChart nie jest dozwolony w widokach agenta/);

    // Nothing was written, and the screen still shows the previous versions.
    expect(await agentViewsOf(page, conversationA)).toEqual(before);
    await expect(nodes(page)).toHaveCount(2);
    const table = page.getByTestId(`card-${tableCardId}`).locator('[data-component="DataTable"]');
    await expect(table).toHaveAttribute('data-state', 'ready');
    await expect(table.locator('tbody[data-group-field="currency"]').first()).toBeVisible();
    await expect(page.getByTestId('agent-views-page')).not.toContainText('Liczby wpisane');
  });

  test('przeladowanie i przelaczanie rozmow odtwarzaja widoki wlasciwej rozmowy', async ({ page }) => {
    await openApp(page, `/?c=${conversationA}`);
    await openAgentViews(page);
    const viewsPage = page.getByTestId('agent-views-page');

    await page.reload();
    await expect(viewsPage).toHaveAttribute('data-conversation-id', conversationA);
    await expect(nodes(page)).toHaveCount(2);
    await expect(page.getByTestId(`card-${tableCardId}`).locator('tbody[data-group-field="currency"]').first()).toBeVisible();
    await expect(page.getByTestId(`card-${chartCardId}`).locator('figcaption')).toContainText('Wykres liniowy');

    // A new conversation has no views of its own.
    await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();
    await expect(viewsPage).toHaveAttribute('data-state', 'no-conversation');
    await sendAndFinish(page, TITLE_B);
    conversationB = urlParam(page, 'c')!;
    expect(conversationB).toBeTruthy();
    expect(conversationB).not.toBe(conversationA);
    const bCard = await lastCreatedCardId(page);
    await expect(viewsPage).toHaveAttribute('data-conversation-id', conversationB);
    await expect(nodes(page)).toHaveCount(1);
    await expect(page.getByTestId(`card-${bCard}`)).toBeVisible();
    await expect(page.getByTestId(`card-${tableCardId}`)).toHaveCount(0);

    // Back to A from the conversation list: A's views, not B's.
    await switchConversation(page, TITLE_A);
    await expect.poll(() => urlParam(page, 'c')).toBe(conversationA);
    await expect(viewsPage).toHaveAttribute('data-conversation-id', conversationA);
    await expect(nodes(page)).toHaveCount(2);
    await expect(page.getByTestId(`card-${bCard}`)).toHaveCount(0);

    await page.reload();
    await expect(viewsPage).toHaveAttribute('data-conversation-id', conversationA);
    await expect(nodes(page)).toHaveCount(2);
    await expect(page.getByTestId(`card-${chartCardId}`)).toBeVisible();
  });

  test('wykonanie rozmowy A tworzy widok, gdy uzytkownik jest w B: adres i ekran B bez zmian', async ({ page }) => {
    await openApp(page, `/?c=${conversationA}`);
    await openAgentViews(page);
    const viewsPage = page.getByTestId('agent-views-page');
    await expect(nodes(page)).toHaveCount(2);
    const bBefore = await agentViewsOf(page, conversationB);

    // A long command in A...
    const composer = page.locator('.openui-agent-thread-composer__input');
    await composer.fill('[w tle] Przygotuj widok w tle');
    await page.locator('.pf-chat [aria-label="Send message"]').first().click();
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', { timeout: 30_000 });

    // ...and the user moves to B while it runs.
    await switchConversation(page, TITLE_B);
    await expect.poll(() => urlParam(page, 'c')).toBe(conversationB);
    await expect(viewsPage).toHaveAttribute('data-conversation-id', conversationB);
    await expect(nodes(page)).toHaveCount(1);
    const addressInB = page.url();

    await expect
      .poll(
        async () =>
          (await getJson<{ runs: Array<{ status: string }> }>(page, `/api/conversations/${conversationA}/runs`)).runs[0]
            ?.status,
        { timeout: 60_000 },
      )
      .toBe('succeeded');
    // Let any refresh the finished run triggers reach the screen before judging it.
    await page.waitForTimeout(1500);

    expect(page.url()).toBe(addressInB);
    await expect(viewsPage).toHaveAttribute('data-conversation-id', conversationB);
    await expect(nodes(page)).toHaveCount(1);
    await expect(viewsPage).not.toContainText(BACKGROUND_TITLE);
    // B's views are exactly as they were (its space's own viewport may have been saved by the page).
    const bAfter = await agentViewsOf(page, conversationB);
    expect(bAfter.space!.id).toBe(bBefore.space!.id);
    expect(bAfter.cards).toEqual(bBefore.cards);

    // The view went to A, where the run belongs.
    const a = await agentViewsOf(page, conversationA);
    const created = a.cards.find((c) => c.title === BACKGROUND_TITLE);
    expect(created, 'widok z tla nie trafil do rozmowy A').toBeTruthy();
    await switchConversation(page, TITLE_A);
    await expect(viewsPage).toHaveAttribute('data-conversation-id', conversationA);
    await expect(page.getByTestId(`card-${created!.id}`)).toBeVisible();
    await expect(nodes(page)).toHaveCount(3);
  });

  test('kompozycja w odpowiedzi czatu nie wysyla odczytu dla niepelnej nazwy operacji', async ({ page }) => {
    await openApp(page);
    const sent: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/read') {
        sent.push(String(JSON.parse(request.postData() ?? '{}').operation));
      }
    });
    // What the data component in the chat is asked to read, as it streams in.
    await page.evaluate(() => {
      const seen = new Set<string>();
      (window as unknown as { __seenOperations: Set<string> }).__seenOperations = seen;
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('.pf-chat [data-component="DataTable"]')) {
          seen.add(el.getAttribute('data-operation') ?? '');
        }
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-operation'] });
    });

    await sendAndFinish(page, '[czat] Pokaz dostawcow w odpowiedzi');
    const answer = page.getByTestId('assistant-message').last();
    const table = answer.locator('[data-component="DataTable"]');
    await expect(table).toHaveAttribute('data-state', 'ready');
    await expectRowsMatchBackend(table, await readBackend(page, 'procurement.suppliers'), ['name', 'country']);

    const { operations } = await getJson<{ operations: Array<{ name: string }> }>(page, '/api/read/operations');
    const registered = operations.map((o) => o.name);
    const seen = await page.evaluate(() => [...(window as unknown as { __seenOperations: Set<string> }).__seenOperations]);
    // The streamed answer did reach the component with a half-written name...
    expect(seen.some((op) => op && !registered.includes(op)), `widziane: ${seen.join(', ')}`).toBe(true);
    // ...and not one read was sent for it.
    expect(sent.filter((op) => !registered.includes(op))).toEqual([]);
    expect(sent).toContain('procurement.suppliers');

    await sendAndFinish(page, '[czat-nieznana] Pokaz nieznana operacje');
    const unknown = page.getByTestId('assistant-message').last().locator('[data-component="DataTable"]');
    await expect(unknown).toHaveAttribute('data-state', 'error');
    await expect(unknown.getByRole('alert')).toContainText('Nieznana operacja odczytu "nie.istnieje"');
    expect(sent).not.toContain('nie.istnieje');
  });
});
