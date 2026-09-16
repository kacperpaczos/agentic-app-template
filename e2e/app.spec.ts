import { expect, test } from './support/fixtures.ts';
import { type APIRequestContext, type Page } from '@playwright/test';

/**
 * The API fixture keeps its own cookie jar, separate from the browser's, so it
 * must sign in before it can read anything.
 */
async function apiLogin(request: APIRequestContext) {
  await request.post('/api/auth/session', { data: {} });
}

/**
 * Browser acceptance for the shell, the canvas and the persistence of a
 * composition. Agent runs are exercised separately (`e2e/agent.spec.ts`)
 * because they cost a real subscription turn.
 */

async function openFirstCase(page: Page) {
  await page.goto('/cases');
  const tile = page.locator('[data-testid^="case-tile-"]').first();
  await expect(tile).toBeVisible();
  const href = await tile.getAttribute('href');
  await tile.click();
  await expect(page.getByTestId('case-detail-page')).toBeVisible();
  return href ?? '';
}

test.describe('powloka aplikacji', () => {
  test('lewa nawigacja, canvas i czat wspolistnieja', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Nawigacja glowna' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Rozmowa z agentem' })).toBeVisible();
    await expect(page.getByTestId('statusbar')).toBeVisible();
    await expect(page.getByTestId('statusbar')).toContainText('Claude:');
  });

  test('hamburger zwija i rozwija menu', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Zwin menu' });
    await expect(page.getByRole('heading', { name: 'Sprawy zakupowe' })).toBeVisible();
    await toggle.click();
    await expect(page.getByRole('heading', { name: 'Sprawy zakupowe' })).toBeHidden();
    await page.getByRole('button', { name: 'Rozwin menu' }).click();
    await expect(page.getByRole('heading', { name: 'Sprawy zakupowe' })).toBeVisible();
  });

  test('menu jest obslugiwalne z klawiatury i ma widoczny fokus', async ({ page }) => {
    await page.goto('/');
    const link = page.getByRole('link', { name: 'Wszystkie sprawy' });
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('cases-page')).toBeVisible();
  });

  test('nawigacja Wstecz/Dalej przywraca wlasciwy widok', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Wszystkie sprawy' }).click();
    await expect(page.getByTestId('cases-page')).toBeVisible();
    await page.getByRole('link', { name: 'Ustawienia' }).click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('cases-page')).toBeVisible();
    await page.goForward();
    await expect(page.getByTestId('settings-page')).toBeVisible();
  });

  test('ustawienia pokazuja tryb subskrypcji i nie ujawniaja sekretow', async ({ page }) => {
    await page.goto('/settings');
    const auth = page.getByTestId('auth-status');
    await expect(auth).toBeVisible();
    await expect(auth).toContainText(/subskrypcja|brak logowania/);
    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toContain('sk-ant');
    expect(body).not.toContain('accesstoken');
    expect(body).not.toContain('refreshtoken');
    await expect(page.getByText('wylacznie subskrypcja', { exact: false })).toBeVisible();
  });
});

test.describe('canvas i kompozycja', () => {
  test('otwarcie sprawy tworzy uzyteczna przestrzen domyslna', async ({ page }) => {
    await openFirstCase(page);
    await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();

    // `.first()` throughout: the agent may have added further cards of the same
    // kind to this space in an earlier run, which is expected, not a failure.
    await expect(page.getByTestId('card-case-summary').first()).toBeVisible();
    await expect(page.getByTestId('card-offer-list').first()).toBeVisible();
    await expect(page.getByTestId('card-comparison').first()).toBeVisible();
  });

  test('tabela porownawcza pokazuje wartosci z backendu i przyczyny wykluczen', async ({ page }) => {
    await openFirstCase(page);
    await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();

    const comparison = page.getByTestId('card-comparison').first();
    await expect(comparison).toContainText('MediaPro');
    await expect(comparison).toContainText('49 270,00 PLN');
    await expect(comparison).toContainText('49 830,00 PLN');
    await expect(comparison).toContainText('najlepsza');

    // Excluded offers are shown with an explicit reason, not silently dropped.
    await expect(comparison).toContainText('Konferencje24');
    await expect(comparison).toContainText('brak wymaganych pozycji');
    await expect(comparison).toContainText('NordAV');
    await expect(comparison).toContainText('inna waluta');
  });

  test('brakujace dane sa oznaczone jako brakujace', async ({ page }) => {
    await openFirstCase(page);
    await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
    const comparison = page.getByTestId('card-comparison').first();
    // Opened directly rather than clicked: the <summary> sits inside a scrolled
    // card body within React Flow's transformed layer, where Playwright's
    // actionability scroll cannot reach it.
    await comparison.locator('details').first().evaluate((d) => {
      (d as HTMLDetailsElement).open = true;
    });
    await expect(comparison.locator('.pf-missing').first()).toBeVisible();
    await expect(comparison).toContainText('brak pozycji');
  });

  test('przesuniecie karty jest trwale i nie zmienia jej tresci', async ({ page, request }) => {
    await apiLogin(request);

    // A dedicated space with exactly one card: dragging a card on the shared
    // demo space is unreliable because later cards can overlap its header.
    const space = await (
      await request.post('/api/canvas/spaces', { data: { title: `Test drag ${Date.now()}` } })
    ).json();
    const card = await (
      await request.post('/api/canvas/cards', {
        data: {
          spaceId: space.id,
          title: 'Karta testowa',
          spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'tresc' } },
          geometry: { x: 40, y: 40, width: 320, height: 200 },
        },
      })
    ).json();

    await page.goto('/spaces');
    await page.getByTestId(`space-${space.id}`).click();
    const header = page.locator(`[data-testid="card-${card.id}"] .pf-card__head`);
    await expect(header).toBeVisible();

    const box = await header.boundingBox();
    if (!box) throw new Error('brak karty na canvasie');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 110, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(1200);

    const after = await (await request.get(`/api/canvas/spaces/${space.id}`)).json();
    const moved = after.cards.find((c: { id: string }) => c.id === card.id);
    expect(moved.geometry.x).not.toBe(card.geometry.x);
    expect(moved.geometry.y).not.toBe(card.geometry.y);
    // The drag bumped geometry only: content and its version are untouched.
    expect(moved.specVersion).toBe(card.specVersion);
    expect(moved.geometryVersion).toBeGreaterThan(card.geometryVersion);
    expect(JSON.stringify(moved.spec)).toBe(JSON.stringify(card.spec));

    // ...and it survives a reload.
    await page.reload();
    await expect(page.locator(`[data-testid="card-${card.id}"]`)).toBeVisible();
    const reloaded = await (await request.get(`/api/canvas/spaces/${space.id}`)).json();
    expect(reloaded.cards.find((c: { id: string }) => c.id === card.id).geometry.x).toBe(
      moved.geometry.x,
    );
  });

  test('zmiana widoku karty przezywa przejscie miedzy ekranami', async ({ page, request }) => {
    // Isolated space with a single comparison card: on the shared demo space the
    // cards can overlap and a covered checkbox is not clickable.
    await apiLogin(request);
    const { cases } = await (await request.get('/api/m/procurement/cases')).json();
    const space = await (
      await request.post('/api/canvas/spaces', { data: { title: `Filtr ${Date.now()}` } })
    ).json();
    await request.post('/api/canvas/cards', {
      data: {
        spaceId: space.id,
        title: 'Zestawienie',
        spec: {
          kind: 'component',
          component: 'procurement.comparisonTable',
          props: { caseId: cases[0].id, showExcluded: true },
        },
        geometry: { x: 40, y: 40, width: 900, height: 520 },
      },
    });

    await page.goto('/spaces');
    await page.getByTestId(`space-${space.id}`).click();
    const comparison = page.getByTestId('card-comparison').first();
    await expect(comparison).toBeVisible();
    const checkbox = comparison.getByRole('checkbox');
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(comparison).not.toContainText('inna waluta');

    await page.getByRole('link', { name: 'Ustawienia' }).click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await page.getByRole('link', { name: 'Canvas' }).click();

    // The filter is remembered: the layout change did not reset it.
    await expect(page.getByTestId('card-comparison').first().getByRole('checkbox')).not.toBeChecked();
  });
});

test.describe('dane i pliki', () => {
  test('pochodzenie ceny prowadzi do pliku zrodlowego', async ({ page }) => {
    await openFirstCase(page);
    await page.getByRole('link', { name: 'pochodzenie' }).first().click();
    await expect(page.getByTestId('provenance-page')).toBeVisible();
    await expect(page.getByText(/wiersz \d+/)).toBeVisible();
    await expect(page.getByRole('link', { name: /\.csv$/ })).toBeVisible();
  });

  test('pliki zrodlowe sa do pobrania', async ({ page }) => {
    await page.goto('/files');
    await expect(page.getByTestId('files-page')).toBeVisible();
    await expect(page.getByRole('link', { name: 'pobierz' }).first()).toBeVisible();
  });

  test('odrzucony typ pliku daje czytelny blad', async ({ page }) => {
    await page.goto('/files');
    await page.setInputFiles('#file-upload', {
      name: 'zly.exe',
      mimeType: 'application/x-msdownload',
      buffer: Buffer.from('MZ'),
    });
    await expect(page.getByRole('alert')).toContainText('Niedozwolony typ pliku');
  });

  test('wgranie poprawnego pliku dziala', async ({ page }) => {
    await page.goto('/files');
    // Count only after the list has actually rendered.
    const rows = page.locator('table').first().locator('tbody tr');
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    await page.setInputFiles('#file-upload', {
      name: 'test-upload.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('a;b\n1;2\n'),
    });
    await expect(rows).toHaveCount(before + 1);
    await expect(page.getByText('test-upload.csv').first()).toBeVisible();
  });
});
