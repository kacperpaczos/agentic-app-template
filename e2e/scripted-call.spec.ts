import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * The scripted stand-in can perform a tool call, not only announce one.
 *
 * Symulacja: a scripted model at the adapter boundary, everything else real. A
 * `call` step runs the actual handler of a platform tool with the run's context
 * inside the scripted server process; the answer then carries the handler's
 * real result. Later browser suites build their agent scenarios on this step,
 * so it is checked here once, end to end, from the composer to the chat.
 *
 * The expected content is read from the backend (`GET /api/ui/targets`), not
 * written into the test: the handler of `ui_catalog` returns the same catalog.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-call' });
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
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

test.describe('krok call skryptowanego modelu', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });
  test.afterAll(() => scripted.stop());

  test('wykonanie wywoluje prawdziwy handler narzedzia i pokazuje jego wynik', async ({ page }) => {
    await scripted.start('call-ui-catalog');
    await openApp(page);

    const composer = page.locator('.openui-agent-thread-composer__input');
    await composer.fill('Co mozesz otworzyc?');
    await page.locator('.pf-chat [aria-label="Send message"]').first().click();

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /succeeded|failed/, {
      timeout: 60_000,
    });
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded');

    const answer = page.locator('.pf-chat');
    await expect(answer).toContainText('[call:ui_catalog] {"targets":[');
    await expect(answer).toContainText('Odczytalem katalog.');

    // What the handler returned is the backend's catalog, target by target.
    const { targets } = await page.evaluate(async () =>
      (await fetch('/api/ui/targets', { credentials: 'include' })).json(),
    );
    const text = (await answer.textContent()) ?? '';
    for (const id of ['platform.files', 'procurement.data', 'procurement.cases']) {
      expect(targets.map((t: { id: string }) => t.id)).toContain(id);
      expect(text).toContain(`"id":"${id}"`);
    }
    // Module targets carry their narrowable fields — only a real handler call has them.
    expect(text).toContain('"filterableFields":[{"field":"country"');
  });
});
