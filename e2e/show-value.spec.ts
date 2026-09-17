import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';
import { recordsOf, type ReadResponse } from '@platform/contracts';

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

/** What each tool call of a run returned, from the run's own persisted event log. */
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

const resultOf = (results: Array<{ name: string; result: any }>, tool: string) =>
  results.find((r) => r.name === `mcp__app__${tool}`)?.result;

type Supplier = { id: string; name: string; country: string; taxId: string };

/** The suppliers as the backend returns them, in its order, through the endpoint the view uses. */
async function backendSuppliers(page: Page): Promise<{ raw: ReadResponse; records: Supplier[] }> {
  const res = await page.request.post(`${BASE}/api/read`, { data: { operation: 'procurement.suppliers' } });
  expect(res.status()).toBe(200);
  const raw = (await res.json()) as ReadResponse;
  return { raw, records: recordsOf(raw.result, raw.descriptor!) as unknown as Supplier[] };
}

/* -------------------------------------------------------------------------- */
/*  What counts as "the value was shown" — the probe's detector               */
/* -------------------------------------------------------------------------- */

interface Highlight {
  recordKind: string | null;
  recordId: string | null;
  field: string | null;
  text: string;
  inViewport: boolean;
  instanceId: string | null;
  cardId: string | null;
}

/**
 * Records every cell the application highlights, as it happens.
 *
 * The highlight is deliberately short-lived, so it is observed rather than
 * polled for: an assertion that looked afterwards could miss a real one, and a
 * test that waited for it to still be there would be testing the timer.
 */
async function watchHighlights(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __highlights?: unknown[]; __highlightObserver?: MutationObserver };
    if (w.__highlightObserver) return;
    w.__highlights = [];
    const observer = new MutationObserver((records) => {
      for (const m of records) {
        const el = m.target as HTMLElement;
        if (m.attributeName !== 'data-ui-highlight' || el.getAttribute('data-ui-highlight') !== 'true') continue;
        const rect = el.getBoundingClientRect();
        w.__highlights!.push({
          recordKind: el.getAttribute('data-record-kind'),
          recordId: el.getAttribute('data-record-id'),
          field: el.getAttribute('data-field'),
          text: (el.textContent ?? '').trim(),
          inViewport:
            rect.width > 0 &&
            rect.height > 0 &&
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= window.innerHeight &&
            rect.right <= window.innerWidth,
          instanceId: el.closest('[data-ui-instance]')?.getAttribute('data-ui-instance') ?? null,
          cardId:
            el.closest('[data-testid^="card-"]')?.getAttribute('data-testid')?.replace(/^card-/, '') ?? null,
        });
      }
    });
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-ui-highlight'] });
    w.__highlightObserver = observer;
  });
}

const highlights = (page: Page): Promise<Highlight[]> =>
  page.evaluate(() => ((window as unknown as { __highlights?: Highlight[] }).__highlights ?? []) as Highlight[]);

/**
 * The probe's verdict, as a list of what is missing — so a run that only talks
 * about the value fails it, and the test can show *that* it fails and why.
 *
 * Deliberately not a set of assertions: the negative control has to run the
 * same detector and get a non-empty list.
 */
async function notShown(
  page: Page,
  runId: string,
  expected: { recordKind: string; recordId: string; field: string; rawValue: unknown; displayedText: string },
): Promise<string[]> {
  const problems: string[] = [];
  const result = resultOf(await toolResults(page, runId), 'ui_show_value');
  if (!result) problems.push('wykonanie nie wywolalo ui_show_value');
  else {
    if (result.found !== true) problems.push('narzedzie nie znalazlo wartosci w backendzie');
    if (result.shown !== true) problems.push(`klient nie potwierdzil pokazania (reason=${result.reason ?? '-'})`);
    if (result.matchesBackend !== true) problems.push('wartosc na ekranie nie zgadza sie z backendem');
    if (result.revealed?.recordId !== expected.recordId || result.revealed?.field !== expected.field) {
      problems.push('potwierdzenie nie wskazuje tego rekordu i pola');
    }
    if (result.revealed?.rawValue !== expected.rawValue) problems.push('potwierdzona wartosc to nie wartosc backendu');
  }
  const marked = (await highlights(page)).filter(
    (hl) =>
      hl.recordKind === expected.recordKind && hl.recordId === expected.recordId && hl.field === expected.field,
  );
  if (marked.length === 0) problems.push('zadna komorka tego rekordu i pola nie zostala podswietlona');
  else {
    if (!marked.some((hl) => hl.inViewport)) problems.push('podswietlona komorka nie byla w widocznym obszarze');
    if (!marked.some((hl) => hl.text === expected.displayedText)) {
      problems.push(`podswietlona komorka nie pokazuje "${expected.displayedText}"`);
    }
  }
  return problems;
}

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
    const url = page.url();

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
    // Nothing had to be adjusted, and the screen is the one the user opened.
    expect(shown.adjustments).toEqual([]);
    expect(page.url()).toBe(url);

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
