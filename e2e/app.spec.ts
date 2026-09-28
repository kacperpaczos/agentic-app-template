import { statSync } from 'node:fs';
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
    // Subscription mode names "Claude"; the explicit GLM mode names the agent
    // and its harness instead. Both are the one line about auth.
    await expect(page.getByTestId('statusbar')).toContainText(/Claude:|Agent \(Claude Code\):/);
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
    await expect(link).toBeVisible();

    /*
     * Prawdziwa sciezka klawiszowa: Tab od poczatku dokumentu, nie
     * programistyczny el.focus(), ktory omija kolejnosc tabulacji — a wlascie
     * o nia tu chodzi. Petla z limitem, zeby przy regeneracji menu test konczyl
     * sie czytelnym niepowodzeniem, a nie zawieszeniem.
     */
    for (let i = 0; i < 30 && !(await link.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(link).toBeFocused();

    /*
     * Widoczny wskaznik fokusu mierzony tak, jak produkt go rysuje: globalna
     * regula `:focus-visible` w platform-ui/src/styles.css rysuje obwodke
     * `outline: 2px solid var(--pf-accent)` — schowana obwodka (outline-style:
     * none albo szerokosc 0) oznacza fokus, ktorego uzytkownik klawiatury nie
     * widzi.
     */
    const wskaznik = await link.evaluate((el) => {
      const s = getComputedStyle(el);
      return { styl: s.outlineStyle, szerokosc: s.outlineWidth };
    });
    expect(wskaznik.styl, 'fokus nie ma zadnej obwodki').not.toBe('none');
    expect(parseFloat(wskaznik.szerokosc), 'obwodka fokusu jest zerowej szerokosci').toBeGreaterThan(
      0,
    );

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

  /*
   * Provider-aware by reading the mode the page itself reports, not by
   * knowing the environment the run started with. The default run is the
   * subscription mode and keeps every assertion it ever had; a GLM-mode run
   * (when somebody starts one) gets its own honest labels asserted instead —
   * and must NOT be shown the subscription-only policy line.
   */
  test('ustawienia i pasek stanu nazywaja skonfigurowany provider i nie ujawniaja sekretow', async ({
    page,
  }) => {
    await page.goto('/settings');
    const method = (await page.getByTestId('auth-method').getAttribute('data-method')) ?? 'subscription';
    const policy = page.getByTestId('auth-policy');
    await expect(policy).toBeVisible();

    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toContain('sk-ant');
    expect(body).not.toContain('accesstoken');
    expect(body).not.toContain('refreshtoken');

    if (method === 'glm') {
      await expect(page.getByTestId('auth-method')).toContainText(/GLM\/Z\.AI/);
      await expect(policy).toContainText(/tryb GLM/i);
      await expect(page.getByTestId('statusbar')).toContainText(/GLM\/Z\.AI/);
      await expect(page.getByText('wylacznie subskrypcja', { exact: false })).toHaveCount(0);
    } else {
      await expect(page.getByTestId('auth-status')).toContainText(/subskrypcja|brak logowania/);
      await expect(policy).toContainText(/wylacznie subskrypcja/i);
      await expect(page.getByTestId('statusbar')).toContainText('Claude:');
    }
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
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 110, { steps: 15 });
    await page.mouse.up();

    // Zapis geometrii jest asynchroniczny: czekamy na warunek (backend potwierdza
    // nowa wersje geometrii), a nie na zdany czas.
    await expect
      .poll(
        async () => {
          const stan = await (await request.get(`/api/canvas/spaces/${space.id}`)).json();
          return stan.cards.find((c: { id: string }) => c.id === card.id)?.geometryVersion ?? 0;
        },
        { message: 'przeciagniecie karty nie zostalo zapisane w backendzie' },
      )
      .toBeGreaterThan(card.geometryVersion);

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
    // Pierwsza tabela to pliki zrodlowe (druga to artefakty).
    const wiersz = page.locator('.pf-table').first().locator('tbody tr').first();
    await expect(wiersz).toBeVisible();
    const nazwa = (await wiersz.locator('td').first().innerText()).trim();

    // Prawdziwe pobranie, nie sama obecnosc linku: przeglarka dostaje plik o
    // nazwie z wiersza i o niezerowej tresci.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      wiersz.getByRole('link', { name: 'pobierz' }).click(),
    ]);
    expect(download.suggestedFilename(), 'pobrana nazwa nie zgadza sie z wierszem').toBe(nazwa);
    const sciezka = await download.path();
    expect(sciezka, 'pobranie nie wyprodukowalo pliku').toBeTruthy();
    expect(statSync(sciezka!).size, 'pobrany plik jest pusty').toBeGreaterThan(0);
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
