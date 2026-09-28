import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * Narrowing happens in the view, and the view says so.
 *
 * Observed in the running application: asked to show only the Polish suppliers,
 * the agent typed the matching rows into the chat. The screen kept showing all
 * four, so the user had the full list in front of them and a hand-copied subset
 * beside it — and was told to read the copy.
 *
 * Every assertion here is about the screen. The fixture has four suppliers,
 * three of them Polish, so "3 of 4" is a number the view has to produce; a
 * scenario that claimed it would still fail.
 *
 * The second half matters as much as the first. A view that quietly shows three
 * of four rows is worse than one showing four, so the banner saying what was
 * taken away, and the button putting it back, are under test too.
 */

const scripted = new ScriptedInstance({ port: 8792, dataDirName: '.e2e-scripted-filter' });
const BASE = scripted.baseUrl;

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

async function send(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

const settled = (page: Page) =>
  expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /succeeded|failed/, {
    timeout: 60_000,
  });

/** Rows actually on the screen. */
const rows = (page: Page) => page.locator('[data-testid="data-page"] tbody tr');
/* The table as a whole, for asking whether a name is on the screen at all. */
const table = (page: Page) => page.locator('[data-testid="data-page"]');
const banner = (page: Page) => page.getByTestId('view-filter-banner');
const answer = (page: Page) => page.locator('.pf-chat');

test.describe('agent zawęza widok, a nie rozmowe', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });
  test.afterEach(() => scripted.stop());

  test('zawezenie widac w widoku, z informacja kto je zrobil i iloma wierszami', async ({ page }) => {
    await scripted.start('ui-filter-suppliers');
    await openApp(page, '/data');
    // The full list first, so the narrowing is a change and not a coincidence.
    await expect(rows(page)).toHaveCount(4);
    await expect(banner(page)).toHaveCount(0);

    await send(page, 'Pokaz tylko polskich dostawcow.');

    // The visible effect: the screen itself is narrowed.
    await expect(rows(page)).toHaveCount(3, { timeout: 60_000 });
    await expect(table(page)).not.toContainText('NordAV');

    // The narrowing is in the address bar, where a filter belongs: it decides
    // which records are on screen, so a link, a reload and Back must keep it.
    await expect.poll(() => new URL(page.url()).searchParams.get('country')).toBe('PL');

    // And the user is told what happened to their screen, and by whom.
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText('Widok zawezony przez agenta');
    // Generated from what is actually applied, through the view's own field
    // label — not quoted from whatever the agent said it did.
    await expect(banner(page)).toContainText('Kraj (kod ISO): PL');
    await expect(page.getByTestId('view-filter-count')).toContainText('3 z 4');

    await settled(page);
    /*
     * The numbers in the answer come from the acknowledgement, which the view
     * produced. An agent reporting a count it worked out itself could be right
     * about the data and wrong about the screen.
     */
    await expect(answer(page)).toContainText('executed=true');
    await expect(answer(page)).toContainText('pokazane=3/4');

    // Kept as evidence: the report describes a banner, and this is the banner.
    await page.screenshot({
      path: 'docs/evidence/chat-ux-2026-09-16/05-zawezony-widok.png',
      clip: { x: 0, y: 0, width: 1120, height: 420 },
    });
  });

  test('zawezony widok przezywa odswiezenie i wraca przyciskiem Wstecz', async ({ page }) => {
    await scripted.restart('ui-filter-suppliers');
    await openApp(page, '/data');
    await send(page, 'Pokaz tylko polskich dostawcow.');
    await expect(rows(page)).toHaveCount(3, { timeout: 60_000 });
    await settled(page);

    /* A reload keeps it — the whole reason a filter belongs in the address. */
    await page.reload();
    await expect(page.getByTestId('data-page')).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
    await expect(banner(page)).toBeVisible();
    /*
     * After a reload nothing in this session narrowed anything: the view is
     * narrowed by the address, and the banner must not credit an agent that did
     * not act here. It still says the view is narrowed and still offers the way
     * out.
     */
    await expect(banner(page)).not.toContainText('przez agenta');

    /* Leaving drops the filter, and Back brings the narrowed view back. */
    await page.goto(`${BASE}/cases`);
    await expect(page.getByTestId('cases-page')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('data-page')).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
  });

  test('wklejony link otwiera zawezony widok bez udzialu agenta', async ({ page }) => {
    await scripted.restart('ui-filter-suppliers');
    // Nothing is sent to the agent here: this is somebody opening a link.
    await openApp(page, '/data?country=PL');

    await expect(rows(page)).toHaveCount(3);
    await expect(table(page)).not.toContainText('NordAV');
    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText('Kraj (kod ISO): PL');
    await expect(banner(page)).not.toContainText('przez agenta');
  });

  test('przycisk przywraca pelny widok', async ({ page }) => {
    await scripted.restart('ui-filter-suppliers');
    await openApp(page, '/data');
    await send(page, 'Pokaz tylko polskich dostawcow.');
    await expect(rows(page)).toHaveCount(3, { timeout: 60_000 });

    await page.getByTestId('view-filter-clear').click();

    await expect(rows(page)).toHaveCount(4);
    await expect(table(page)).toContainText('NordAV');
    await expect(banner(page)).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('country')).toBeNull();

    // Undoing a filter is a navigation like any other, so it is undoable too.
    await page.goBack();
    await expect(rows(page)).toHaveCount(3);
  });

  test('nieznane pole daje odmowe, a widok zostaje nietkniety', async ({ page }) => {
    await scripted.restart('ui-filter-unknown-field');
    await openApp(page, '/data');
    await expect(rows(page)).toHaveCount(4);

    await send(page, 'Pokaz tylko mazowieckich dostawcow.');
    await settled(page);

    // The refusal is stated, and nothing on screen pretends otherwise.
    await expect(answer(page)).toContainText('executed=false');
    await expect(answer(page)).toContainText('unknown_field');
    await expect(rows(page)).toHaveCount(4);
    await expect(banner(page)).toHaveCount(0);
  });

  test('agent potrafi sam przywrocic pelny widok', async ({ page }) => {
    await scripted.restart('ui-filter-then-clear');
    await openApp(page, '/data');

    await send(page, 'Pokaz zagranicznych, a potem wszystkich.');

    // Narrowed to the single foreign supplier on the way through...
    await expect(rows(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(banner(page)).toBeVisible();

    // ...and back to everything, with the banner gone rather than stale.
    await expect(rows(page)).toHaveCount(4, { timeout: 60_000 });
    await expect(banner(page)).toHaveCount(0);
    await settled(page);
  });

  test('zawezenie nie przenosi sie na inny widok', async ({ page }) => {
    await scripted.restart('ui-filter-suppliers');
    await openApp(page, '/data');
    await send(page, 'Pokaz tylko polskich dostawcow.');
    await expect(banner(page)).toBeVisible({ timeout: 60_000 });
    await settled(page);

    await page.goto(`${BASE}/cases`);
    await expect(page.getByTestId('cases-page')).toBeVisible();

    /*
     * A narrowing that followed the user to another screen would hide rows
     * nobody asked to hide — and under a banner describing a different view.
     */
    await expect(banner(page)).toHaveCount(0);
  });
});
