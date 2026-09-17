import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';
import { formatFieldValue, recordsOf, type ReadResponse } from '@platform/contracts';
import {
  highlights,
  notShown as notShownAt,
  resultOf,
  toolResults as toolResultsAt,
  watchHighlights,
  type ExpectedValue,
} from './support/show-value-probe.ts';

/**
 * Showing the value of one record's field on screen (L2.16, L6.16; proba T25).
 *
 * Symulacja: the model is the scripted stand-in, and its `call` steps run the
 * real `procurement_search`, `ui_show_value`, `agent_view_create` and
 * `ui_state` handlers through the runtime's real acknowledgement gate; the
 * browser is the real build. Every expected value, order and page is read from
 * the backend (`POST /api/read`) — the screen is never compared with itself,
 * and never with the model's text.
 *
 * The instance's database gets twelve more suppliers before it starts, so the
 * list has two pages of ten and the record the tests ask for is both hidden by
 * the narrowing the user set and on the second page.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-showvalue' });
const BASE = scripted.baseUrl;

const EXTRA_SUPPLIERS = [
  { name: 'Źródło Dźwięku', taxId: '6310000002', country: 'PL' },
  { name: 'Łódzka Technika Sceniczna', taxId: '7250000001', country: 'PL' },
  ...Array.from({ length: 10 }, (_, i) => ({
    name: `Dostawca DE ${String(i + 1).padStart(2, '0')}`,
    taxId: `DE1000000${String(i + 1).padStart(2, '0')}`,
    country: 'DE',
  })),
];
const TOTAL = 4 + EXTRA_SUPPLIERS.length;
/** The record every test asks about: German (so `country=PL` hides it) and far down the list. */
const SHOWN_SUPPLIER = 'Dostawca DE 10';

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
      insert.run(
        `pcs_e2e_showvalue_${i}`,
        owners[0]!.owner_id,
        s.name,
        s.taxId,
        s.country,
        `e2e${i}@example.test`,
        new Date().toISOString(),
      ),
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

const composer = (page: Page) => page.locator('.openui-agent-thread-composer__input');

/** Sends a command from the interface and returns the run it started. */
async function sendForRun(page: Page, text: string): Promise<{ runId: string }> {
  const request = page.waitForRequest((r) => r.url().endsWith('/api/agui/run') && r.method() === 'POST');
  await expect(composer(page)).toBeVisible();
  await composer(page).fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
  const response = await (await request).response();
  const runId = response?.headers()['x-run-id'];
  expect(runId, 'naglowek X-Run-Id').toBeTruthy();
  return { runId: runId! };
}

const settled = (page: Page) =>
  expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /succeeded|failed/, { timeout: 90_000 });

type Supplier = { id: string; name: string; country: string; taxId: string };

/** The suppliers as the backend returns them, in its order, through the endpoint the view uses. */
async function backendSuppliers(page: Page): Promise<{ raw: ReadResponse; records: Supplier[] }> {
  const res = await page.request.post(`${BASE}/api/read`, { data: { operation: 'procurement.suppliers' } });
  expect(res.status()).toBe(200);
  const raw = (await res.json()) as ReadResponse;
  return { raw, records: recordsOf(raw.result, raw.descriptor!) as unknown as Supplier[] };
}

/*
 * The probe's detector, bound to this suite's own instance.
 *
 * The verdict itself lives in `support/show-value-probe.ts`, shared with the
 * real-model probe (`e2e/bl01-bl02-model.spec.ts`): one definition of what
 * counts as "the value was shown", used here both as the pass condition of (a)
 * and as the thing the text-only run of (b) has to fail.
 */
const toolResults = (page: Page, runId: string) => toolResultsAt(page, runId, BASE);
const notShown = (page: Page, runId: string, expected: ExpectedValue) => notShownAt(page, runId, expected, BASE);

const rows = (page: Page) => page.locator('[data-testid="data-page"] tbody tr');
const notice = (page: Page) => page.getByTestId('view-reveal-notice');
const viewParams = (page: Page) =>
  [...new URL(page.url()).searchParams].filter(([k]) => k !== 'c' && k !== 's').sort();

test.describe('wskazanie wartosci pola rekordu', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
    addSuppliers(scripted.config.dataDir);
  });
  test.afterEach(() => scripted.stop());

  test('(a) rekord ukryty zawezeniem i na drugiej stronie: widok otwarty, zawezenie zdjete, strona zmieniona, komorka wskazana', async ({
    page,
  }) => {
    await scripted.start('show-value');
    await openApp(page, '/data');
    await watchHighlights(page);

    /* What the backend says — the only source of every expectation below. */
    const before = await backendSuppliers(page);
    expect(before.records).toHaveLength(TOTAL);
    const wanted = before.records.find((s) => s.name === SHOWN_SUPPLIER)!;
    const position = before.records.findIndex((s) => s.id === wanted.id);
    // The preconditions of the probe: the record is not Polish and not on the first page.
    expect(wanted.country, 'rekord ma byc ukryty przez zawezenie do PL').not.toBe('PL');
    expect(Math.floor(position / 10) + 1, 'rekord ma byc na dalszej stronie').toBe(2);

    /* The user narrows the view themselves, with the controls. */
    await expect(rows(page)).toHaveCount(10);
    await page.locator('[data-testid="data-page"] select[data-filter-field="country"]').selectOption('PL');
    await page.getByRole('button', { name: 'Zastosuj' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('country')).toBe('PL');
    const polish = before.records.filter((s) => s.country === 'PL');
    await expect(rows(page)).toHaveCount(polish.length);
    await expect(page.locator(`tbody tr[data-record-id="${wanted.id}"]`)).toHaveCount(0);

    /* The command, typed in the chat. */
    const { runId } = await sendForRun(page, `Pokaz NIP dostawcy [pokaz-pole] nazwa=${SHOWN_SUPPLIER.replace(/ /g, '_')} pole=taxId`);
    await settled(page);

    /* The screen: the narrowing that hid the record is gone, the page is its page. */
    await expect.poll(() => viewParams(page)).toEqual([['page', '2']]);
    const cell = page.locator(
      `[data-testid="data-page"] td[data-record-kind="supplier"][data-record-id="${wanted.id}"][data-field="taxId"]`,
    );
    await expect(cell).toHaveText(wanted.taxId);
    await expect(cell).toBeInViewport();
    await expect(page.getByTestId('data-page-status')).toHaveText('Strona 2 z 2');

    /* The banner says who changed what, and that the data did not change. */
    await expect(notice(page)).toHaveAttribute('data-shown', 'true');
    await expect(notice(page)).toContainText('Agent wskazal wartosc.');
    await expect(notice(page)).toContainText('Pole „NIP”');
    await expect(notice(page)).toContainText(SHOWN_SUPPLIER);
    const adjustments = page.getByTestId('view-reveal-adjustment');
    await expect(adjustments).toHaveCount(2);
    await expect(adjustments.nth(0)).toHaveAttribute('data-kind', 'filter_cleared');
    await expect(adjustments.nth(0)).toContainText('Kraj (kod ISO): PL');
    await expect(adjustments.nth(1)).toHaveAttribute('data-kind', 'page_changed');
    await expect(notice(page)).toContainText('dane sa bez zmian');

    /* The probe's detector: everything it requires is there. */
    const expectedValue = {
      recordKind: 'supplier',
      recordId: wanted.id,
      field: 'taxId',
      rawValue: wanted.taxId,
      displayedText: wanted.taxId,
    };
    expect(await notShown(page, runId, expectedValue)).toEqual([]);

    /* The tool's own answer, from the run's event log. */
    const results = await toolResults(page, runId);
    expect(results.map((r) => r.name)).toEqual([
      'mcp__app__procurement_search',
      'mcp__app__ui_show_value',
      'mcp__app__ui_state',
    ]);
    const shown = resultOf(results, 'ui_show_value');
    expect(shown).toMatchObject({
      executed: true,
      found: true,
      shown: true,
      matchesBackend: true,
      highlighted: true,
      fieldLabel: 'NIP',
      target: { targetId: 'procurement.data', place: 'view', operation: 'procurement.suppliers' },
      backend: { rawValue: wanted.taxId, displayedText: wanted.taxId },
      revealed: { page: { index: 2, size: 10, count: 2 } },
    });
    expect(shown.adjustments.map((a: any) => a.kind)).toEqual(['filter_cleared', 'page_changed']);
    expect(shown.adjustments[0].predicates).toEqual([{ field: 'country', op: 'eq', value: 'PL' }]);
    expect(shown.adjustments[1]).toMatchObject({ from: 1, to: 2 });
    expect(new URL(shown.url, BASE).searchParams.get('page')).toBe('2');

    /* The description of the screen after it, asked for with the version of this acknowledgement. */
    const state = resultOf(results, 'ui_state');
    expect(state.stale).toBe(false);
    expect(state.version).toBeGreaterThanOrEqual(shown.uiVersion);
    expect(state.snapshot.clientId).toBe(shown.uiClientId);
    const instance = state.snapshot.instances.find((i: any) => i.viewId === 'procurement.data');
    expect(instance.filter).toEqual([]);
    expect(instance.page).toEqual({ index: 2, size: 10, count: 2 });
    expect(instance.visibleRecordIds).toContain(wanted.id);
    expect(instance.visibleRecordIds).toEqual(before.records.slice(10).map((s) => s.id));

    /* Presentation only: the backend's data is exactly what it was. */
    const after = await backendSuppliers(page);
    expect(after.raw.result).toEqual(before.raw.result);
  });

  test('(b) kontrola detektora T25: wykonanie, ktore tylko odpowiada tekstem, nie zalicza proby', async ({ page }) => {
    await scripted.start('show-value');
    await openApp(page, '/data?country=PL');
    await watchHighlights(page);
    const before = await backendSuppliers(page);
    const wanted = before.records.find((s) => s.name === SHOWN_SUPPLIER)!;
    await expect(rows(page)).toHaveCount(before.records.filter((s) => s.country === 'PL').length);

    const { runId } = await sendForRun(
      page,
      `Jaki NIP ma ten dostawca? [tylko-tekst] nazwa=${SHOWN_SUPPLIER.replace(/ /g, '_')} nip=${wanted.taxId}`,
    );
    await settled(page);

    // The answer carries the right value — and that is exactly not enough.
    await expect(page.locator('.pf-chat')).toContainText(`NIP dostawcy ${SHOWN_SUPPLIER} to ${wanted.taxId}.`);
    const problems = await notShown(page, runId, {
      recordKind: 'supplier',
      recordId: wanted.id,
      field: 'taxId',
      rawValue: wanted.taxId,
      displayedText: wanted.taxId,
    });
    expect(problems).toContain('wykonanie nie wywolalo ui_show_value');
    expect(problems).toContain('zadna komorka tego rekordu i pola nie zostala podswietlona');

    // And the screen is untouched: still narrowed by the user, nothing highlighted, no notice.
    expect(viewParams(page)).toEqual([['country', 'PL']]);
    await expect(page.locator(`tbody tr[data-record-id="${wanted.id}"]`)).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);
    expect(await highlights(page)).toEqual([]);
  });

  test('(c) bledny identyfikator: record_not_found, ekran bez zmian', async ({ page }) => {
    await scripted.start('show-value');
    await openApp(page, '/data?country=PL');
    await watchHighlights(page);
    const before = await backendSuppliers(page);

    const { runId } = await sendForRun(page, 'Pokaz NIP tego dostawcy [zly-rekord]');
    await settled(page);

    const shown = resultOf(await toolResults(page, runId), 'ui_show_value');
    expect(shown).toMatchObject({ found: false, shown: false, reason: 'record_not_found', matchesBackend: null });
    expect(shown.checked.map((c: any) => c.targetId)).toEqual(['procurement.data']);
    expect(viewParams(page)).toEqual([['country', 'PL']]);
    await expect(rows(page)).toHaveCount(before.records.filter((s) => s.country === 'PL').length);
    await expect(notice(page)).toHaveCount(0);
    expect(await highlights(page)).toEqual([]);
  });

  test('(d) rekord w dwoch miejscach: ambiguous bez zmiany ekranu, potem wskazany w wybranym widoku agenta', async ({
    page,
  }) => {
    await scripted.start('show-value');
    await openApp(page, '/data');
    await watchHighlights(page);
    const before = await backendSuppliers(page);
    const wanted = before.records.find((s) => s.name === SHOWN_SUPPLIER)!;
    const name = SHOWN_SUPPLIER.replace(/ /g, '_');

    /* First command: the record is in the list view and in a new agent view. */
    const first = await sendForRun(page, `Pokaz NIP [niejednoznacznie] nazwa=${name}`);
    await settled(page);
    const ambiguous = resultOf(await toolResults(page, first.runId), 'ui_show_value');
    expect(ambiguous).toMatchObject({ found: true, shown: false, reason: 'ambiguous' });
    expect(ambiguous.candidates).toHaveLength(2);
    expect(ambiguous.candidates.map((c: any) => c.place).sort()).toEqual(['agent_view', 'view']);
    // Nothing moved: the user is where they were, with nothing highlighted.
    expect(new URL(page.url()).pathname).toBe('/data');
    expect(viewParams(page)).toEqual([]);
    expect(await highlights(page)).toEqual([]);

    /* Second command: the same value, in the agent view named this time. */
    const second = await sendForRun(page, `To pokaz je w widoku agenta [w-widoku-agenta] nazwa=${name}`);
    await settled(page);
    const results = await toolResults(page, second.runId);
    const shown = resultOf(results, 'ui_show_value');
    const cardId = ambiguous.candidates.find((c: any) => c.place === 'agent_view').cardId;
    expect(shown).toMatchObject({
      executed: true,
      found: true,
      shown: true,
      matchesBackend: true,
      highlighted: true,
      target: { targetId: cardId, place: 'agent_view' },
      backend: { rawValue: wanted.taxId, displayedText: wanted.taxId },
    });
    // The table in the card pages in memory (five rows a page) — turning its page is reported.
    expect(shown.revealed.page.size).toBe(5);
    expect(shown.adjustments.map((a: any) => a.kind)).toContain('page_changed');

    // The screen is the agent views page, and the highlighted cell is inside that card.
    expect(new URL(page.url()).pathname).toBe('/agent-views');
    const marked = (await highlights(page)).filter((hl) => hl.recordId === wanted.id && hl.field === 'taxId');
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.some((hl) => hl.cardId === cardId && hl.inViewport && hl.text === wanted.taxId)).toBe(true);
    expect(await notShown(page, second.runId, {
      recordKind: 'supplier',
      recordId: wanted.id,
      field: 'taxId',
      rawValue: wanted.taxId,
      displayedText: wanted.taxId,
    })).toEqual([]);

    // The description of that screen names the card's space and its table.
    const state = resultOf(results, 'ui_state');
    expect(state.stale).toBe(false);
    expect(state.snapshot.cards.map((c: any) => c.cardId)).toContain(cardId);
  });

  test('(e) rekord innego wlasciciela: forbidden, ekran bez zmian', async ({ page }) => {
    await scripted.start('show-value');
    await openApp(page, '/data');

    /* The first identity's case and one of its offers, read through the API. */
    const cases = await page.request.post(`${BASE}/api/read`, { data: { operation: 'procurement.cases' } });
    const caseId = ((await cases.json()) as any).result.cases[0].id as string;
    const comparison = await page.request.post(`${BASE}/api/read`, {
      data: { operation: 'procurement.comparison', input: { caseId } },
    });
    const offerId = ((await comparison.json()) as any).result.rows[0].offerId as string;

    /* Become somebody else, in the running application. */
    await page.goto(`${BASE}/settings`);
    const owner = page.getByTestId('access-owner');
    const beforeOwner = (await owner.textContent())?.trim();
    await page.getByTestId('switch-access-context').click();
    await expect(owner).not.toHaveText(beforeOwner ?? '');

    // A fresh conversation of the second identity, on the second identity's (empty) list.
    await page.goto(`${BASE}/data`);
    await expect(page.getByTestId('data-page')).toBeVisible();
    await watchHighlights(page);
    await expect(rows(page)).toHaveCount(0);

    const { runId } = await sendForRun(page, `Pokaz sume tej oferty [brak-dostepu] sprawa=${caseId} oferta=${offerId}`);
    await settled(page);

    const shown = resultOf(await toolResults(page, runId), 'ui_show_value');
    expect(shown).toMatchObject({ found: false, shown: false, reason: 'forbidden', matchesBackend: null });
    expect(shown.refused[0].place).toBe('agent_view');
    // Nothing of the other owner's record reached the screen: no row, no cell, no highlight.
    // (The refusal itself names the id the run asked about, and it is echoed in the chat.)
    expect(new URL(page.url()).pathname).toBe('/data');
    expect(await highlights(page)).toEqual([]);
    await expect(page.locator(`[data-record-id="${offerId}"]`)).toHaveCount(0);
    await expect(notice(page)).toHaveCount(0);
  });

  test('(f) pole rekordu na ekranie jednego rekordu: wskazane bez nawigacji i bez zmian prezentacji', async ({ page }) => {
    await scripted.start('show-value');
    await openApp(page, '/data');

    const cases = await page.request.post(`${BASE}/api/read`, { data: { operation: 'procurement.cases' } });
    const caseId = ((await cases.json()) as any).result.cases[0].id as string;
    const items = await page.request.post(`${BASE}/api/read`, {
      data: { operation: 'procurement.case_offer_items', input: { caseId } },
    });
    const itemsBody = (await items.json()) as ReadResponse;
    const item = recordsOf(itemsBody.result, itemsBody.descriptor!)[0] as any;

    /* The user opens the record's own screen — the parameters are theirs, not the agent's. */
    await page.goto(`${BASE}/cases/${caseId}`);
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    await watchHighlights(page);
    const opened = { pathname: new URL(page.url()).pathname, params: viewParams(page) };

    const { runId } = await sendForRun(page, `Pokaz cene tej pozycji [pozycja-sprawy] pozycja=${item.id}`);
    await settled(page);

    const results = await toolResults(page, runId);
    const shown = resultOf(results, 'ui_show_value');
    expect(shown).toMatchObject({
      executed: true,
      found: true,
      shown: true,
      matchesBackend: true,
      fieldLabel: 'Cena jednostkowa',
      target: { targetId: 'procurement.case.detail', place: 'view', operation: 'procurement.case_offer_items' },
    });
    /*
     * Nothing had to be adjusted, and the screen is the one the user opened —
     * compared without the session's own parameters, which the command itself
     * adds to the address when it names the conversation.
     */
    expect(shown.adjustments).toEqual([]);
    expect(new URL(page.url()).pathname).toBe(opened.pathname);
    expect(viewParams(page)).toEqual(opened.params);

    const cell = page.locator(
      `td[data-record-kind="offer_item"][data-record-id="${item.id}"][data-field="unitPriceMinor"]`,
    );
    await expect(cell).toHaveText(shown.backend.displayedText);
    await expect(cell).toBeInViewport();
    expect(await notShown(page, runId, {
      recordKind: 'offer_item',
      recordId: item.id,
      field: 'unitPriceMinor',
      rawValue: item.unitPriceMinor,
      displayedText: shown.backend.displayedText,
    })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  With record actions in the table (Task 7)                                  */
/* -------------------------------------------------------------------------- */

const ACTION = 'change_unit_price';
const OFFER_ITEMS = 'procurement.case_offer_items';

/** The case's offer items as the backend returns them, in its order. */
async function backendItems(page: Page, caseId: string): Promise<{ raw: ReadResponse; records: any[] }> {
  const res = await page.request.post(`${BASE}/api/read`, {
    data: { operation: OFFER_ITEMS, input: { caseId } },
  });
  expect(res.status()).toBe(200);
  const raw = (await res.json()) as ReadResponse;
  return { raw, records: recordsOf(raw.result, raw.descriptor!) as any[] };
}

const firstCaseId = async (page: Page): Promise<string> => {
  const res = await page.request.post(`${BASE}/api/read`, { data: { operation: 'procurement.cases' } });
  return ((await res.json()) as any).result.cases[0].id as string;
};

test.describe('wskazanie wartosci w tabeli z akcjami rekordu', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
    addSuppliers(scripted.config.dataDir);
  });
  test.afterEach(() => scripted.stop());

  test('(g) kolumna akcji i otwarty formularz nie mylą wskazania; zmiana strony zamyka formularz jawnie', async ({
    page,
  }) => {
    await scripted.start('show-value');
    await openApp(page, '/data');
    const caseId = await firstCaseId(page);
    const { records } = await backendItems(page, caseId);
    // The table in the card shows two rows a page, so the third record is on the second page.
    const onFirstPage = records[0]!;
    const wanted = records[2]!;
    expect(wanted, 'sprawa ma co najmniej trzy pozycje').toBeTruthy();

    await sendForRun(page, `Zrob widok pozycji [karta-pozycji] sprawa=${caseId}`);
    await settled(page);

    await page.getByRole('link', { name: 'Widoki agenta' }).click();
    const table = page.locator('[data-testid="agent-views-page"] [data-component="DataTable"]');
    await expect(table).toHaveAttribute('data-state', 'ready');
    await watchHighlights(page);

    /* The user opens the price form on a row of the first page, types into it and leaves it open. */
    await table.locator(`tr[data-record-id="${onFirstPage.id}"] [data-record-action="${ACTION}"]`).click();
    const form = table.getByTestId('record-action-form');
    await expect(form).toHaveAttribute('data-record-id', String(onFirstPage.id));
    await form.getByLabel('Nowa cena jednostkowa').fill('1 234,50');

    const { runId } = await sendForRun(page, `Pokaz cene tej pozycji [pozycja-sprawy] pozycja=${wanted.id}`);
    await settled(page);

    const results = await toolResults(page, runId);
    const shown = resultOf(results, 'ui_show_value');
    expect(shown).toMatchObject({ executed: true, found: true, shown: true, matchesBackend: true });
    // The page had to be turned: the record was not on the page the user was looking at.
    expect(shown.adjustments.map((a: any) => a.kind)).toContain('page_changed');

    /*
     * The cell pointed at is the record's *value* cell. The actions column
     * carries no record or field of its own, so it cannot be mistaken for one —
     * and the open form of another row does not make the lookup find its row.
     */
    const marked = (await highlights(page)).filter((hl) => hl.field === 'unitPriceMinor');
    expect(marked.map((hl) => hl.recordId)).toEqual([String(wanted.id)]);
    expect(marked[0]!.text).toBe(shown.backend.displayedText);
    expect(marked[0]!.inViewport).toBe(true);
    await expect(
      table.locator(`td[data-record-id="${wanted.id}"][data-field="unitPriceMinor"][data-ui-highlight="true"]`),
    ).toHaveCount(1);

    /*
     * The form went off screen with its row — and the banner says the page was
     * changed and by whom, so the change is not silent. What the turn does cost
     * is the text typed into that form: the row unmounts, the action stays
     * open, and the field comes back empty (the same as when the user pages
     * themselves — see the report).
     */
    await expect(form).toHaveCount(0);
    await expect(notice(page)).toContainText('Zmieniono strone');
    await expect(notice(page)).toHaveAttribute('data-shown', 'true');
    await table.getByTestId('data-page-prev').click();
    await expect(table.locator(`tr[data-record-id="${onFirstPage.id}"]`)).toHaveCount(1);
    const reopened = table.getByTestId('record-action-form');
    await expect(reopened).toHaveAttribute('data-record-id', String(onFirstPage.id));
    await expect(reopened.getByLabel('Nowa cena jednostkowa')).toHaveValue('');
  });

  test('(h) po akcji rekordu wskazana jest NOWA wartosc, zgodna ze swiezym odczytem backendu', async ({ page }) => {
    await scripted.start('show-value');
    await openApp(page, '/data');
    const caseId = await firstCaseId(page);
    const before = await backendItems(page, caseId);
    const target = before.records[0]!;

    await page.goto(`${BASE}/cases/${caseId}`);
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    const table = page.locator(`[data-component="DataTable"][data-operation="${OFFER_ITEMS}"]`);
    await expect(table).toHaveAttribute('data-state', 'ready');
    await watchHighlights(page);

    /* The user changes the price in the table, with the record action. */
    const typed = '9 999,50';
    await table.locator(`tr[data-record-id="${target.id}"] [data-record-action="${ACTION}"]`).click();
    const form = table.getByTestId('record-action-form');
    await form.getByLabel('Nowa cena jednostkowa').fill(typed);
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/actions'));
    await form.getByRole('button', { name: 'Zapisz' }).click();
    expect((await saved).status()).toBe(200);
    await expect(table.getByTestId('record-action-status')).toContainText('zapisano');

    /* The backend really holds the new value; the screen is asked for that one. */
    const after = await backendItems(page, caseId);
    const changed = after.records.find((r) => r.id === target.id)!;
    expect(changed.unitPriceMinor).toBe(999950);
    expect(changed.unitPriceMinor).not.toBe(target.unitPriceMinor);

    const { runId } = await sendForRun(page, `Pokaz cene tej pozycji [pozycja-sprawy] pozycja=${target.id}`);
    await settled(page);

    const results = await toolResults(page, runId);
    const shown = resultOf(results, 'ui_show_value');
    // The backend read happens when the command runs — after the action — so the
    // value compared with the screen is the new one, and they agree.
    expect(shown).toMatchObject({ executed: true, shown: true, matchesBackend: true });
    expect(shown.backend.rawValue).toBe(999950);
    expect(shown.revealed.rawValue).toBe(999950);
    // The text is the descriptor's own formatting of the new value, not a literal.
    expect(shown.backend.displayedText).toBe(
      formatFieldValue(changed, after.raw.descriptor!.fields.find((f) => f.field === 'unitPriceMinor')!),
    );
    expect(shown.backend.displayedText).not.toBe(
      formatFieldValue(target, after.raw.descriptor!.fields.find((f) => f.field === 'unitPriceMinor')!),
    );
    expect(await notShown(page, runId, {
      recordKind: 'offer_item',
      recordId: String(target.id),
      field: 'unitPriceMinor',
      rawValue: 999950,
      displayedText: shown.backend.displayedText,
    })).toEqual([]);

    /* The screen's description keeps both contributions: the record actions and the page. */
    const state = resultOf(results, 'ui_state');
    expect(state.stale).toBe(false);
    const instance = state.snapshot.instances.find((i: any) => i.source.operation === OFFER_ITEMS);
    expect(instance.actions).toContain(`action:${ACTION}`);
    expect(instance.visibleRecordIds).toContain(String(target.id));
  });
});
