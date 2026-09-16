import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * The agent moving the interface, observed in the interface.
 *
 * This is the case the user hit in the running application: asked to "switch to
 * files", the agent called two unrelated read tools and then said they had to
 * create a purchase case first to see a screen that is in the navigation
 * unconditionally. It had no navigation tool and no catalog, so it improvised —
 * and the improvisation was false.
 *
 * Every assertion here is about a **visible effect**. The answer text carries
 * what the client acknowledged (`executed=true/false`), so a scenario cannot
 * pass by describing a route: the screen has to have moved, or the refusal has
 * to be stated.
 */

const scripted = new ScriptedInstance({ port: 8793, dataDirName: '.e2e-scripted-uinav' });
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

/** Everything the assistant said, including the acknowledged outcome. */
const answer = (page: Page) => page.locator('.pf-chat');

test.describe('agent porusza sie po aplikacji', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });
  test.afterEach(() => scripted.stop());

  test('polecenie otwiera wskazany widok, a nie opisuje do niego drogi', async ({ page }) => {
    await scripted.start('ui-open-files');
    await openApp(page);
    // Start somewhere that is not the destination, so arriving means something.
    await page.goto(`${BASE}/cases`);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

    await send(page, 'Przelacz na pliki.');

    // The visible effect: the screen actually moved.
    await expect(page.getByTestId('files-page')).toBeVisible({ timeout: 60_000 });
    expect(new URL(page.url()).pathname).toBe('/files');

    await settled(page);
    // And the client's acknowledgement is what the answer reports.
    await expect(answer(page)).toContainText('executed=true');
  });

  test('otwarcie ustawienia podswietla kontrolke i niczego nie zmienia', async ({ page }) => {
    await scripted.restart('ui-open-setting');
    await openApp(page);

    const before = await page.evaluate(
      async () =>
        (await (await fetch('/api/status', { credentials: 'include' })).json()) as {
          auth: { method: string; credential: { state: string } };
        },
    );

    await send(page, 'Pokaz ustawienie logowania.');

    const target = page.getByTestId('settings-auth');
    await expect(target).toBeVisible({ timeout: 60_000 });
    // Highlighted, and the highlight is real markup rather than a claim.
    await expect(target).toHaveAttribute('data-ui-highlight', 'true', { timeout: 10_000 });

    await settled(page);
    await expect(answer(page)).toContainText('executed=true');

    // Showing a setting must not change it.
    const after = await page.evaluate(
      async () =>
        (await (await fetch('/api/status', { credentials: 'include' })).json()) as {
          auth: { method: string; credential: { state: string } };
        },
    );
    expect(after.auth.method).toBe(before.auth.method);
    expect(after.auth.credential.state).toBe(before.auth.credential.state);

    // And the highlight is temporary, not a permanent mark on the control.
    await expect(target).not.toHaveAttribute('data-ui-highlight', 'true', { timeout: 15_000 });
  });

  test('Wstecz i Dalej dzialaja po nawigacji wykonanej przez agenta', async ({ page }) => {
    await scripted.restart('ui-open-files');
    await openApp(page);
    await page.goto(`${BASE}/cases`);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

    await send(page, 'Przelacz na pliki.');
    await expect(page.getByTestId('files-page')).toBeVisible({ timeout: 60_000 });
    await settled(page);

    await page.goBack();
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
      .toBe('/cases');

    await page.goForward();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 15_000 }).toBe('/files');
    await expect(page.getByTestId('files-page')).toBeVisible();
  });

  test('niedostepny cel daje czytelna odmowe, a widok sie nie zmienia', async ({ page }) => {
    await scripted.restart('ui-unknown');
    await openApp(page);
    await page.goto(`${BASE}/cases`);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

    await send(page, 'Otworz cos, czego nie ma.');
    await settled(page);

    // Refused, and said so — not a claimed success.
    await expect(answer(page)).toContainText('executed=false');
    await expect(answer(page)).toContainText('unknown_target');
    // The user is left exactly where they were.
    expect(new URL(page.url()).pathname).toBe('/cases');
    await expect(page.getByTestId('files-page')).toHaveCount(0);
  });

  test('zadanie w tle nie przejmuje widoku innej rozmowy', async ({ page }) => {
    await scripted.restart('ui-late-navigate');
    await openApp(page);
    await page.goto(`${BASE}/cases`);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

    await send(page, 'Popracuj w tle i na koniec otworz ustawienia.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });

    // Walk away before the navigation happens.
    await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();
    await page.goto(`${BASE}/data`);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    const parked = new URL(page.url()).pathname;
    expect(parked).toBe('/data');

    /*
     * The background task now issues its navigation. It must be refused: a task
     * the user has left may not drag their screen away from what they are doing.
     */
    await page.waitForTimeout(6000);
    expect(new URL(page.url()).pathname, 'zadanie w tle przejelo widok').toBe(parked);
    await expect(page.getByTestId('settings-page')).toHaveCount(0);

    // And the refusal is recorded honestly against the conversation that asked.
    const history = await page.evaluate(async () => {
      const { threads } = await (await fetch('/api/threads/get', { credentials: 'include' })).json();
      const first = threads.find((t: { title: string }) => t.title.includes('Popracuj w tle'));
      return (await (
        await fetch(`/api/threads/get/${first.id}`, { credentials: 'include' })
      ).json()) as Array<{ role: string; content: string }>;
    });
    const text = history.map((m) => m.content).join(' ');
    expect(text).toContain('executed=false');
    expect(text).toContain('inactive_conversation');
  });
});
