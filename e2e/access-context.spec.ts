import { expect, test } from './support/fixtures.ts';
import { type Page } from '@playwright/test';

/**
 * Changing who the application acts as.
 *
 * The rule under test is cache isolation, and it can only be shown inside **one**
 * browser and **one** cache: two browser contexts never share a cache, so they
 * prove nothing about a leak through it. The switch happens in the running
 * application, with rows for the previous identity already loaded.
 *
 * This is not a user-management feature and is not meant to become one — two
 * local identities are exactly enough to exercise the rule.
 */

const openApp = async (page: Page) => {
  await page.goto('/');
  await expect(page.locator('.pf-chat')).toBeVisible();
};

const owner = (page: Page) => page.getByTestId('access-owner');

async function gotoSettings(page: Page) {
  await page.goto('/settings');
  await expect(page.getByTestId('settings-page')).toBeVisible();
}

test.describe('kontekst dostepu', () => {
  test('po przelaczeniu zaden wiersz poprzedniej tozsamosci nie jest widoczny', async ({ page }) => {
    await openApp(page);

    // Load data belonging to the first identity, so there is something to leak.
    await page.goto('/cases');
    const tiles = page.locator('[data-testid^="case-tile-"]');
    await expect(tiles.first()).toBeVisible();
    const caseLabel = (await tiles.first().textContent())?.trim() ?? '';
    expect(caseLabel.length).toBeGreaterThan(0);

    await page.locator('[data-testid^="case-tile-"]').first().click();
    await expect(page.getByTestId('case-detail-page')).toBeVisible();

    // The resource address we will come back to as the other identity.
    const caseUrl = page.url();
    expect(caseUrl).toMatch(/\/cases\/.+/);

    /* ----------------------------- the switch ------------------------------ */

    await gotoSettings(page);
    const before = (await owner(page).textContent())?.trim();
    await page.getByTestId('switch-access-context').click();
    await expect(owner(page)).not.toHaveText(before ?? '');
    const after = (await owner(page).textContent())?.trim();
    expect(after).not.toBe(before);

    // The cache key scope moved with it.
    await expect(page.getByTestId('access-scope')).toHaveText(after!);

    /* -------------------- nothing from before survives --------------------- */

    await page.goto('/cases');
    // The second identity owns no cases, so any tile on screen would be a leak.
    await expect(page.locator('[data-testid^="case-tile-"]')).toHaveCount(0);
    if (caseLabel) await expect(page.locator('body')).not.toContainText(caseLabel);

    /* ------------- the other identity's resource is visibly denied --------- */

    await page.goto(caseUrl);
    const denied = page.getByTestId('access-denied');
    await expect(denied, 'brak widocznego stanu braku dostepu').toBeVisible();
    await expect(denied).toHaveAttribute('data-error-code', /forbidden|not_found/);
    // And no fragment of the resource was rendered alongside the refusal.
    await expect(page.getByTestId('case-detail-page')).toHaveCount(0);
  });

  test('zawezony link nie pokazuje odbiorcy cudzych danych', async ({ page }) => {
    /*
     * A filter in the address is shareable by design, so the obvious worry is
     * whether the link carries data with it. It cannot: the parameters only
     * *remove* rows from a response the backend already scoped to its owner —
     * nothing in the address reaches the database.
     *
     * Shown rather than argued. The same narrowed address, opened as the second
     * identity, is still narrowed and still shows that identity's own data,
     * which here is none of it.
     */
    await openApp(page);
    await page.goto('/data?country=PL');
    const rows = page.locator('[data-testid="data-page"] tbody tr');
    await expect(rows.first()).toBeVisible();
    const mine = await rows.count();
    expect(mine).toBeGreaterThan(0);
    const firstName = (await rows.first().textContent())?.trim() ?? '';
    // The narrowing is in force, not merely present in the address.
    await expect(page.getByTestId('view-filter-banner')).toBeVisible();

    await gotoSettings(page);
    const before = (await owner(page).textContent())?.trim();
    await page.getByTestId('switch-access-context').click();
    await expect(owner(page)).not.toHaveText(before ?? '');

    await page.goto('/data?country=PL');
    await expect(page.getByTestId('data-page')).toBeVisible();
    // The second identity owns no suppliers, so any row here would be a leak
    // carried by the link.
    await expect(rows).toHaveCount(0);
    if (firstName) await expect(page.locator('body')).not.toContainText(firstName);

    // Put the identity back, so the suite's shared instance is left as found.
    await gotoSettings(page);
    await page.getByTestId('switch-access-context').click();
    await expect(owner(page)).toHaveText(before ?? '');
  });

  test('powrot do pierwszej tozsamosci przywraca jej dane', async ({ page }) => {
    await gotoSettings(page);
    const first = (await owner(page).textContent())?.trim();

    await page.getByTestId('switch-access-context').click();
    await expect(owner(page)).not.toHaveText(first ?? '');

    await page.getByTestId('switch-access-context').click();
    await expect(owner(page)).toHaveText(first ?? '');

    await page.goto('/cases');
    await expect(page.locator('[data-testid^="case-tile-"]').first()).toBeVisible();
  });

  test('zmiana tozsamosci bez przeladowania: opozniona odpowiedz poprzedniej nie renderuje wierszy', async ({
    page,
  }) => {
    /*
     * T12 — the other half of the first test above. `page.goto` between the
     * identities is a **full page load**: it throws the client away, so it can
     * never show a leak that lives *in the client* — a request issued for the
     * previous owner, still in flight across the switch, writing its rows into
     * the new owner's screen. Only one running client instance can show that,
     * so every move after the first load is a client-side navigation and the
     * switch happens under it.
     *
     * The late answer is manufactured, not assumed: the data read is held at
     * the network for identity A, the switch happens while it is still in
     * flight, and the assertion is what the screen shows *after* the held
     * response has long since landed.
     */
    await openApp(page);
    await page.goto('/data');
    const rows = page.locator('[data-testid="data-page"] tbody tr');
    await expect(rows.first()).toBeVisible();
    const firstName = (await rows.first().textContent())?.trim() ?? '';
    expect(firstName.length).toBeGreaterThan(0);

    // A client-liveness mark: any full page load would wipe it, so its
    // presence at the end is the proof the whole trial ran in one instance.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__t12bezPrzeladowania = Date.now();
    });

    /* --------- identity A issues a read that will be held in flight -------- */

    let held = true;
    await page.route('**/api/read', async (route) => {
      if (held) await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });

    // Out and back through the platform's own navigation: the view remounts and
    // re-reads, and *that* read — A's — is the one being held.
    await page.getByRole('link', { name: 'Ustawienia' }).click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await page.getByRole('link', { name: 'Dostawcy' }).click();
    await expect(page.getByTestId('data-page')).toBeVisible();
    // A's cached rows are still on screen while the fresh read is in flight —
    // the positive control for the assertions below: this locator does see rows.
    await expect(rows.first()).toBeVisible();

    /* ------------------- the switch, in the same client -------------------- */

    await page.getByRole('link', { name: 'Ustawienia' }).click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    const before = (await owner(page).textContent())?.trim();
    await page.getByTestId('switch-access-context').click();
    await expect(owner(page)).not.toHaveText(before ?? '');
    // B's own requests must not be held.
    held = false;

    /* -------------- the late answer lands and must show nothing ------------ */

    await page.getByRole('link', { name: 'Dostawcy' }).click();
    await expect(page.getByTestId('data-page')).toBeVisible();
    // The second identity owns no suppliers; once its own (unheld) read
    // resolves, any row would already be a leak.
    await expect(rows).toHaveCount(0, { timeout: 15_000 });

    // Now past the hold: A's response reached the network long ago. It was
    // aborted and epoch-discarded, so the screen must not change.
    await page.waitForTimeout(3500);
    await expect(rows, 'opozniona odpowiedz poprzedniej tozsamosci dorzucila wiersze').toHaveCount(
      0,
    );
    if (firstName) {
      await expect(page.locator('body')).not.toContainText(firstName);
    }
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).__t12bezPrzeladowania),
      'strona przeladowala sie w trakcie proby — proba niczego nie dowodzi',
    ).toBeTruthy();

    /* ------------------- put the identity back, as found ------------------- */

    await page.getByRole('link', { name: 'Ustawienia' }).click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await page.getByTestId('switch-access-context').click();
    await expect(owner(page)).toHaveText(before ?? '');
    await page.unroute('**/api/read');
  });
});
