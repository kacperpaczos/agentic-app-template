import { expect, test } from './support/fixtures.ts';
import { type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { formatFieldValue, recordsOf, type ReadResponse } from '@platform/contracts';

/**
 * Module screens are OpenUI compositions, and what they show is the backend's.
 *
 * Test GUI bez modelu, on the shared instance. Every test starts from the
 * interface — a navigation link, a workspace picked from the list — and ends on
 * what is visible. The expected values are read from `POST /api/read`, the
 * endpoint the components themselves use, and compared cell by cell through the
 * one formatting function, plus literal values from the fixture so that a
 * formatter agreeing with itself cannot pass on its own.
 *
 * The last two tests put data components in `openui` canvas cards: a table
 * naming an operation nobody registered must say so, not render an empty box.
 */

async function signIn(request: APIRequestContext) {
  await request.post('/api/auth/session', { data: {} });
}

async function readBackend(request: APIRequestContext, operation: string, input?: Record<string, unknown>) {
  const res = await request.post('/api/read', { data: { operation, ...(input ? { input } : {}) } });
  expect(res.status(), `POST /api/read ${operation}`).toBe(200);
  return (await res.json()) as ReadResponse;
}

/**
 * Every row and every shown cell equals the backend record, in the backend's
 * order, addressed by record kind, record id and field — not by position.
 */
async function expectTableMatchesBackend(table: Locator, backend: ReadResponse, columns: string[]) {
  const descriptor = backend.descriptor!;
  const records = recordsOf(backend.result, descriptor);
  expect(records.length).toBeGreaterThan(0);

  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(records.length);
  expect(await rows.evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-record-id')))).toEqual(
    records.map((r) => String(r[descriptor.record.idField])),
  );
  expect(await table.locator('thead th').evaluateAll((ths) => ths.map((th) => th.textContent))).toEqual(
    columns.map((c) => descriptor.fields.find((f) => f.field === c)!.label),
  );

  for (const record of records) {
    const id = String(record[descriptor.record.idField]);
    for (const name of columns) {
      const field = descriptor.fields.find((f) => f.field === name)!;
      const cell = table.locator(
        `td[data-record-kind="${descriptor.record.kind}"][data-record-id="${id}"][data-field="${name}"]`,
      );
      await expect(cell).toHaveCount(1);
      expect(await cell.textContent(), `${descriptor.record.kind}:${id}.${name}`).toBe(
        formatFieldValue(record, field),
      );
    }
  }
}

/** Opens a workspace the way a user does: from the list of saved compositions. */
async function openSpace(page: Page, spaceId: string) {
  await page.goto('/spaces');
  await page.getByTestId(`space-${spaceId}`).click();
  await expect(page.getByTestId('canvas')).toBeVisible();
}

async function addOpenUiCard(
  request: APIRequestContext,
  spaceId: string,
  title: string,
  source: string,
  geometry: { x: number; y: number; width: number; height: number },
) {
  const res = await request.post('/api/canvas/cards', {
    data: { spaceId, title, spec: { kind: 'openui', source }, geometry },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string };
}

test.describe('widoki modulu jako kompozycje OpenUI', () => {
  test('Dostawcy: kompozycja z tabela, ktorej komorki sa rowne odczytowi backendu', async ({ page, request }) => {
    await signIn(request);
    await page.goto('/');
    await page.getByRole('link', { name: 'Dostawcy' }).click();

    const view = page.getByTestId('data-page').getByTestId('composed-view');
    await expect(view).toHaveAttribute('data-view-id', 'procurement.data');
    await expect(view).toHaveAttribute('data-state', 'ready');
    const table = view.locator('[data-component="DataTable"]');
    await expect(table).toHaveAttribute('data-state', 'ready');
    await expect(table).toHaveAttribute('data-operation', 'procurement.suppliers');
    await expect(table).toHaveAttribute('data-ui-instance', /^DataTable-.+/);

    const backend = await readBackend(request, 'procurement.suppliers');
    await expectTableMatchesBackend(table, backend, ['name', 'taxId', 'country', 'contactEmail']);

    // Fixture values, stated literally: the foreign supplier is on screen as such.
    const nordav = recordsOf(backend.result, backend.descriptor!).find((r) => r.name === 'NordAV OY')!;
    await expect(table.locator(`td[data-record-id="${nordav.id}"][data-field="country"]`)).toHaveText('FI');
    await expect(page.getByTestId('data-page').locator('tbody tr')).toHaveCount(4);
  });

  test('Wszystkie sprawy: etykiety kodow z deskryptora i link rekordu otwierajacy sprawe', async ({
    page,
    request,
  }) => {
    await signIn(request);
    await page.goto('/');
    await page.getByRole('link', { name: 'Wszystkie sprawy' }).click();

    const view = page.getByTestId('cases-page').getByTestId('composed-view');
    await expect(view).toHaveAttribute('data-view-id', 'procurement.cases');
    const table = view.locator('[data-component="DataTable"]');
    await expect(table).toHaveAttribute('data-state', 'ready');

    const backend = await readBackend(request, 'procurement.cases');
    const columns = ['code', 'title', 'status', 'currency', 'priceBasis', 'offerCount', 'requirementCount'];
    await expectTableMatchesBackend(table, backend, columns);

    const first = recordsOf(backend.result, backend.descriptor!).find((r) => r.code === 'PC-2026-01')!;
    const cell = (field: string) => table.locator(`td[data-record-id="${first.id}"][data-field="${field}"]`);
    // Codes shown through their labels, not as stored.
    await expect(cell('status')).toHaveText('zbieranie ofert');
    await expect(cell('priceBasis')).toHaveText('netto');
    await expect(cell('offerCount')).toHaveText(String(first.offerCount));

    // The record's title opens its own screen. The session parameters (`c`, `s`)
    // ride along, as they do on every link, so only the path is the record's.
    const link = cell('title').locator('a[data-record-link]');
    const href = await link.getAttribute('href');
    expect(new URL(href ?? '', 'http://x').pathname).toBe(`/cases/${first.id}`);
    await expect(link).toHaveAttribute('data-testid', `case-tile-${first.id}`);
    await link.click();
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(`/cases/${first.id}`);
  });

  test('karta openui z niezarejestrowana operacja pokazuje blad, nie puste pole', async ({ page, request }) => {
    await signIn(request);
    const space = await (
      await request.post('/api/canvas/spaces', { data: { title: `Kompozycje ${Date.now()}` } })
    ).json();
    const broken = await addOpenUiCard(
      request,
      space.id,
      'Nieznana operacja',
      'root = DataTable({operation: "nie.istnieje"})',
      { x: 40, y: 40, width: 520, height: 260 },
    );
    // Same component, a registered read: the failure above is about the source.
    const working = await addOpenUiCard(
      request,
      space.id,
      'Dostawcy w karcie',
      'root = DataTable({operation: "procurement.suppliers"}, ["name", "country"])',
      { x: 600, y: 40, width: 520, height: 320 },
    );

    await openSpace(page, space.id);

    const brokenTable = page.getByTestId(`card-${broken.id}`).locator('[data-component="DataTable"]');
    await expect(brokenTable).toHaveAttribute('data-state', 'error');
    await expect(brokenTable.getByRole('alert')).toContainText('Nieznana operacja odczytu "nie.istnieje"');
    await expect(brokenTable.locator('table')).toHaveCount(0);
    await expect(page.getByTestId(`card-${broken.id}`).locator('[data-state="empty"]')).toHaveCount(0);

    const workingTable = page.getByTestId(`card-${working.id}`).locator('[data-component="DataTable"]');
    await expect(workingTable).toHaveAttribute('data-state', 'ready');
    await expectTableMatchesBackend(workingTable, await readBackend(request, 'procurement.suppliers'), [
      'name',
      'country',
    ]);
  });

  test('wykres i podsumowanie w kartach openui czytaja zarejestrowane odczyty', async ({ page, request }) => {
    await signIn(request);
    const { cases } = await (await request.get('/api/m/procurement/cases')).json();
    const caseId = cases[0].id as string;
    const space = await (
      await request.post('/api/canvas/spaces', { data: { title: `Wykres ${Date.now()}` } })
    ).json();
    const chart = await addOpenUiCard(
      request,
      space.id,
      'Suma ofert',
      `root = DataChart({operation: "procurement.comparison", input: {caseId: "${caseId}"}}, "bar", "supplierName", ["totalMinor"], "Suma ofert w PLN", [{field: "currency", op: "eq", value: "PLN"}])`,
      { x: 40, y: 40, width: 620, height: 420 },
    );
    const summary = await addOpenUiCard(
      request,
      space.id,
      'Pozycje',
      `root = DataSummary({operation: "procurement.case_overview", input: {caseId: "${caseId}"}}, ["name", "quantityMilli"], "Pozycje wymagane")`,
      { x: 700, y: 40, width: 460, height: 520 },
    );

    await openSpace(page, space.id);

    // Chart: drawn by the catalog's chart, and its caption states series, unit and range.
    const figure = page.getByTestId(`card-${chart.id}`).locator('figure[data-component="DataChart"]');
    await expect(figure).toHaveAttribute('data-state', 'ready');
    await expect(figure.locator('svg').first()).toBeVisible();

    const comparison = await readBackend(request, 'procurement.comparison', { caseId });
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
    const caption = await series.textContent();
    expect(caption).toContain('Seria Suma [PLN]');
    expect(caption).toContain(`od ${formatFieldValue(min, totalField)} do ${formatFieldValue(max, totalField)}`);
    await expect(figure.locator('figcaption')).toContainText(`kategorie: Dostawca (${pln.length})`);

    // Summary: one label–value block per record, values formatted from the backend.
    const overview = await readBackend(request, 'procurement.case_overview', { caseId });
    const requirements = recordsOf(overview.result, overview.descriptor!);
    const qtyField = overview.descriptor!.fields.find((f) => f.field === 'quantityMilli')!;
    const box = page.getByTestId(`card-${summary.id}`).locator('[data-component="DataSummary"]');
    await expect(box).toHaveAttribute('data-state', 'ready');
    await expect(box.locator('dl[data-record-kind="requirement"]')).toHaveCount(requirements.length);
    for (const r of requirements) {
      const dd = box.locator(`dd[data-record-id="${r.id}"][data-field="quantityMilli"]`);
      expect(await dd.textContent()).toBe(formatFieldValue(r, qtyField));
    }
    // A literal from the fixture: the projector line is two pieces.
    const projector = requirements.find((r) => r.name === 'Projektor laserowy 4K')!;
    await expect(box.locator(`dd[data-record-id="${projector.id}"][data-field="quantityMilli"]`)).toHaveText('2 szt');
  });
});

test.describe('ekrany szczegolow modulu: sprawa i pochodzenie pozycji', () => {
  test('szczegoly sprawy: naglowek i obie tabele rowne backendowi', async ({ page, request }) => {
    await signIn(request);
    const { cases } = await (await request.get('/api/m/procurement/cases')).json();
    const caseId = cases[0].id as string;
    const overview = await readBackend(request, 'procurement.case_overview', { caseId });
    const c = (overview.result as { procurementCase: { code: string; title: string; description: string } })
      .procurementCase;

    await page.goto(`/cases/${caseId}`);
    const detailPage = page.getByTestId('case-detail-page');
    await expect(detailPage).toBeVisible();
    const view = detailPage.getByTestId('composed-view');
    await expect(view).toHaveAttribute('data-view-id', 'procurement.case.detail');
    await expect(view).toHaveAttribute('data-state', 'ready');

    // The header is its own OpenUI component (CaseHeader), not a table, but
    // still the backend's own record — not a copy typed into the composition.
    const heading = detailPage.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(c.code);
    await expect(heading).toContainText(c.title);
    await expect(detailPage.locator('.pf-page__lead')).toContainText(c.description);

    // Pozycje wymagane: DataTable on the existing procurement.case_overview read.
    const requirementsTable = view.locator(
      '[data-operation="procurement.case_overview"][data-component="DataTable"]',
    );
    await expect(requirementsTable).toHaveAttribute('data-state', 'ready');
    await expectTableMatchesBackend(requirementsTable, overview, ['position', 'name', 'quantityMilli', 'spec']);

    // Oferty: DataTable on the new procurement.case_offer_items read, one row
    // per item across every offer, with the offer's own supplier and currency.
    const items = await readBackend(request, 'procurement.case_offer_items', { caseId });
    const itemsTable = view.locator('[data-operation="procurement.case_offer_items"][data-component="DataTable"]');
    await expect(itemsTable).toHaveAttribute('data-state', 'ready');
    await expectTableMatchesBackend(itemsTable, items, [
      'supplierName',
      'name',
      'unit',
      'quantityMilli',
      'unitPriceMinor',
      'currency',
    ]);

    // The non-tabular part (CaseOfferSources) still carries the exact link text
    // and download links the rest of the suite (e2e/app.spec.ts) depends on.
    await expect(detailPage.getByRole('link', { name: 'pochodzenie' }).first()).toBeVisible();
    await expect(detailPage.getByRole('link', { name: 'zalacznik zrodlowy' }).first()).toBeVisible();
  });

  test('pochodzenie pozycji: wartosci rowne trasie modulu, data-view-id widoku', async ({ page, request }) => {
    await signIn(request);
    const { cases } = await (await request.get('/api/m/procurement/cases')).json();
    const caseId = cases[0].id as string;
    const overview = await readBackend(request, 'procurement.case_overview', { caseId });
    const firstItemId = (
      overview.result as { offers: Array<{ items: Array<{ id: string }> }> }
    ).offers[0]!.items[0]!.id;

    const backendRes = await request.get(`/api/m/procurement/items/${firstItemId}/provenance`);
    expect(backendRes.status()).toBe(200);
    const backend = (await backendRes.json()) as {
      item: { name: string; unitPriceMinor: number | null };
      offer: { reference: string; currency: string };
      supplier: { name: string };
      provenance: Array<{ file: { filename: string } }>;
    };

    const items = await readBackend(request, 'procurement.case_offer_items', { caseId });
    const priceField = items.descriptor!.fields.find((f) => f.field === 'unitPriceMinor')!;
    const expectedPrice = formatFieldValue(
      { unitPriceMinor: backend.item.unitPriceMinor, currency: backend.offer.currency },
      priceField,
    );

    await page.goto(`/items/${firstItemId}`);
    const provenancePage = page.getByTestId('provenance-page');
    await expect(provenancePage).toBeVisible();
    const view = provenancePage.getByTestId('composed-view');
    await expect(view).toHaveAttribute('data-view-id', 'procurement.item.provenance');
    await expect(view).toHaveAttribute('data-state', 'ready');

    const dd = view.locator('dl.pf-kv dd');
    await expect(dd.nth(0)).toHaveText(backend.item.name);
    await expect(dd.nth(1)).toHaveText(expectedPrice);
    await expect(dd.nth(2)).toHaveText(backend.supplier.name);
    await expect(dd.nth(3)).toHaveText(backend.offer.reference);

    expect(backend.provenance.length).toBeGreaterThan(0);
    for (const p of backend.provenance) {
      await expect(view.getByRole('link', { name: p.file.filename })).toBeVisible();
    }
  });

  test('sprawa i pozycja, ktore nie istnieja: stan "nie istnieje", nie pusta ramka ekranu', async ({
    page,
    request,
  }) => {
    await signIn(request);

    await page.goto('/cases/nie-ma-takiej-sprawy');
    const caseDenied = page.getByTestId('access-denied');
    await expect(caseDenied).toBeVisible();
    await expect(caseDenied).toHaveAttribute('data-error-code', 'not_found');
    await expect(page.getByTestId('case-detail-page')).toHaveCount(0);

    await page.goto('/items/nie-ma-takiej-pozycji');
    const itemDenied = page.getByTestId('access-denied');
    await expect(itemDenied).toBeVisible();
    await expect(itemDenied).toHaveAttribute('data-error-code', 'not_found');
    await expect(page.getByTestId('provenance-page')).toHaveCount(0);
  });
});
