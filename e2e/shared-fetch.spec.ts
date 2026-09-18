import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * Several components showing one resource, and how many times it is fetched.
 *
 * A cache test that watches a hit follow a miss proves that a cache exists. This
 * criterion is about something else: that components which happen to show the
 * same resource land on **one** entry, so they cannot put two versions of one
 * record on one screen. The only honest way to check that is to count the
 * requests the browser makes while a screen with several such components loads.
 *
 * The overlaps here are real ones, not arranged for the test. The case detail
 * page reads the case overview four times over — the wrapper that decides
 * whether the screen exists at all, the header, the table of required lines and
 * the list of offer sources — and each of those was written without knowing the
 * others. The artifact list is read by the platform's own Files page and,
 * separately, by the ready-made chat's artifact browser, which until this
 * package fetched on its own, outside any cache.
 *
 * On an instance of its own, and the isolation is part of the measurement: on
 * the shared one a run left by an earlier spec can finish at any moment, and the
 * `RUN_FINISHED` invalidation would make the count depend on what somebody else
 * did.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-sharedfetch' });
const BASE = scripted.baseUrl;

async function openApp(page: Page) {
  await page.goto(`${BASE}/`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${BASE}/`);
  await expect(page.locator('.pf-chat')).toBeVisible();
}

test.describe('wspoldzielone pobrania', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    scripted.prepareDatabase();
    // No command is ever sent here; the scenario only has to be a valid one.
    await scripted.start('text-only');
  });
  test.afterAll(() => scripted.stop());

  test('cztery komponenty tego samego odczytu wysylaja jedno zadanie', async ({ page }) => {
    await openApp(page);

    const reads: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/read') {
        reads.push(r.postData() ?? '');
      }
    });

    await page.getByRole('link', { name: 'Wszystkie sprawy' }).click();
    await expect(page.locator('[data-testid^="case-tile-"]').first()).toBeVisible();
    await page.locator('[data-testid^="case-tile-"]').first().click();
    const openedCaseId = new URL(page.url()).pathname.split('/').pop()!;
    expect(openedCaseId).toMatch(/^pcs_/);

    // The screen is fully on: the wrapper's frame, the header, the table of
    // required lines and the offer sources. All four read `case_overview`.
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    await expect(page.locator('[data-testid="case-detail-page"] h1')).toBeVisible();
    await expect(page.locator('[data-testid="case-detail-page"] table').first()).toBeVisible();
    await expect(page.locator('[data-testid="case-detail-page"] h3').first()).toBeVisible();
    // Long enough for a straggler to have been sent before counting.
    await page.waitForTimeout(2000);

    /*
     * Counted per input, because "one request" is a claim about one resource.
     * Four components asking for the same case must produce one request for it;
     * a request for a *different* input is a different resource and is counted
     * separately.
     *
     * That distinction is not academic here. The composition's header component
     * stringifies its `$caseId` parameter before it is bound and sends one read
     * for the literal `"undefined"` — a request that can only fail. It is a
     * defect of the composed view's parameter binding, outside this package, and
     * it is reported rather than asserted away: it does not make two views show
     * two versions of one record, which is what this criterion is about.
     */
    const perInput = new Map<string, number>();
    for (const body of reads) {
      const parsed = JSON.parse(body) as { operation: string; input: { caseId?: string } };
      if (parsed.operation !== 'procurement.case_overview') continue;
      const key = String(parsed.input.caseId);
      perInput.set(key, (perInput.get(key) ?? 0) + 1);
    }
    expect(perInput.get(openedCaseId), `zadania dla otwartej sprawy: ${perInput.get(openedCaseId)}`).toBe(1);
    for (const [input, count] of perInput) {
      expect(count, `zasob ${input} pobrany ${count} razy`).toBe(1);
    }
    // Not "one request in total": a different resource on the same screen is
    // fetched separately, which is what makes the number above meaningful.
    expect(reads.filter((b) => b.includes('procurement.case_offer_items')).length).toBe(1);
  });

  test('lista artefaktow w powloce i w przegladarce gotowego czatu to jedno pobranie', async ({
    page,
  }) => {
    await openApp(page);

    const listed: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/artifacts') listed.push(r.url());
    });

    // The platform's own screen reads the artifact list...
    await page.getByRole('link', { name: 'Pliki i raporty' }).click();
    await expect(page.getByTestId('files-page')).toBeVisible();
    await expect.poll(() => listed.length, { timeout: 10_000 }).toBe(1);

    // ...and so does the ready-made chat's artifact browser, on the same key.
    await page.getByTestId('chat-tab-artifacts').click();
    await expect(page.locator('.openui-agent-artifact-browser')).toBeVisible();
    await page.waitForTimeout(2000);

    expect(listed.length, `zadania /api/artifacts: ${listed.length}`).toBe(1);
  });
});
