import { expect, test } from './support/fixtures.ts';

/**
 * Several components showing one resource, and how many times it is fetched.
 *
 * A cache test that watches a hit follow a miss proves that a cache exists. What
 * this criterion is about is different: that components which happen to show the
 * same resource actually land on **one** entry, so they cannot put two versions
 * of one record on one screen. The only honest way to check that is to count the
 * requests the browser makes while a screen with several such components loads.
 *
 * The screens here are the ones where the overlap is real. The case detail page
 * reads the case overview four times over — the wrapper that decides whether the
 * screen exists at all, the header, the table of required lines and the list of
 * offer sources — and each of those was written without knowing the others. The
 * artifact list is read by the platform's own Files page and, separately, by the
 * ready-made chat's artifact browser, which until recently fetched on its own.
 *
 * No identity is switched here: this suite shares its instance with the others.
 */

test.describe('wspoldzielone pobrania', () => {
  test('trzy komponenty tego samego odczytu wysylaja jedno zadanie', async ({ page }) => {
    const reads: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/read') {
        reads.push(r.postData() ?? '');
      }
    });

    await page.goto('/cases');
    await expect(page.locator('[data-testid^="case-tile-"]').first()).toBeVisible();
    await page.locator('[data-testid^="case-tile-"]').first().click();

    // The screen is fully on: the wrapper that decides the frame, the header,
    // the table of required lines and the list of offer sources are all
    // mounted, and every one of them reads `case_overview`.
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    await expect(page.locator('[data-testid="case-detail-page"] h1')).toBeVisible();
    await expect(page.locator('[data-testid="case-detail-page"] table').first()).toBeVisible();
    await expect(page.locator('[data-testid="case-detail-page"] h3').first()).toBeVisible();
    // Give any straggler request time to be made before counting.
    await page.waitForTimeout(1500);

    const overview = reads.filter((body) => body.includes('procurement.case_overview'));
    expect(overview.length, `zadania case_overview: ${JSON.stringify(overview)}`).toBe(1);
    // The other reads of the screen are separate resources and are fetched
    // separately — the count is not "one request in total".
    expect(reads.filter((b) => b.includes('procurement.case_offer_items')).length).toBe(1);
  });

  test('lista artefaktow w powloce i w przegladarce gotowego czatu to jedno pobranie', async ({
    page,
  }) => {
    const listed: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/artifacts') listed.push(r.url());
    });

    // The platform's own screen reads the artifact list...
    await page.goto('/files');
    await expect(page.getByTestId('files-page')).toBeVisible();
    await expect.poll(() => listed.length, { timeout: 10_000 }).toBe(1);

    // ...and so does the ready-made chat's artifact browser, on the same key.
    await page.getByTestId('chat-tab-artifacts').click();
    await expect(page.locator('.openui-agent-artifact-browser')).toBeVisible();
    await page.waitForTimeout(1500);

    expect(listed.length, `zadania /api/artifacts: ${listed.length}`).toBe(1);

    // Leave the panel as it was found — the suite shares this instance.
    await page.getByTestId('chat-tab-thread').click();
  });
});
