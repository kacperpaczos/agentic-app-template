import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * Changing who the application acts as, **without reloading the page**.
 *
 * Symulacja: a scripted stand-in at the adapter boundary supplies a long,
 * slowly streaming answer; everything else — the run, the queue, the stream, the
 * session, the browser — is real.
 *
 * The existing suite (`access-context.spec.ts`) switches identity and then calls
 * `page.goto`, so what it proves is that the backend refuses the other owner's
 * data to a fresh page. That is worth proving and it is not this: a reload
 * throws away every cache, every store and every open stream by itself, which is
 * precisely the work under test here. Everything below happens in one page, one
 * cache and one chat.
 *
 * The case that matters is the racy one. A run started by the first identity is
 * still streaming when the switch happens; its later events are addressed to a
 * tab that is now somebody else's. Proving that a cache is empty after a switch
 * proves nothing about them — they arrive afterwards and write into it.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-accessswitch' });
const BASE = scripted.baseUrl;

const owner = (page: Page) => page.getByTestId('access-owner');

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

/** Goes to Settings the way a user does — through the menu, with no reload. */
async function gotoSettingsInApp(page: Page) {
  await page.getByRole('link', { name: 'Ustawienia' }).click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
}

test.describe('zmiana wlasciciela w jednej karcie przegladarki', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    scripted.prepareDatabase();
    await scripted.start('slow');
  });
  test.afterAll(() => scripted.stop());

  test('opozniony strumien poprzedniego wlasciciela nie dociera do nastepnego', async ({ page }) => {
    await openApp(page);

    /* --------- something of the first identity's is on screen and running --- */

    await page.getByRole('link', { name: 'Wszystkie sprawy' }).click();
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await expect(page.getByTestId('case-detail-page')).toBeVisible();

    /*
     * The title the thread list shows, and the command that produces it.
     *
     * They are not the same string: the ready-made chat drops the trailing
     * period when it names a thread. Asserting the command text against the
     * panel therefore *always* passes in the negative form — which is how the
     * first version of this test reported success with the previous owner's
     * conversation plainly on screen. Every assertion below uses the title.
     */
    const threadTitle = 'Opowiedz dlugo o tej sprawie';
    const command = `${threadTitle}.`;
    await page.locator('.openui-agent-thread-composer__input').fill(command);
    await page.locator('.pf-chat [aria-label="Send message"]').first().click();

    // Running, and the answer is arriving in pieces — the state a switch has to
    // interrupt. A run that had already finished would prove nothing.
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 60_000,
    });
    const streaming = page.getByTestId('streaming-answer');
    await expect(streaming).toBeVisible();
    const partial = (await streaming.textContent())?.trim() ?? '';
    expect(partial.length, 'odpowiedz jeszcze nie zaczela naplywac').toBeGreaterThan(0);
    // The answer is still growing: what follows is genuinely in flight.
    await expect
      .poll(async () => ((await streaming.textContent()) ?? '').length, { timeout: 15_000 })
      .toBeGreaterThan(partial.length);

    // The context the next command would carry belongs to this identity.
    await expect(page.getByTestId('chat-context')).toContainText('case:');

    /* ------------------------------ the switch ----------------------------- */

    await gotoSettingsInApp(page);
    const before = (await owner(page).textContent())?.trim();
    await page.getByTestId('switch-access-context').click();
    await expect(owner(page)).not.toHaveText(before ?? '');
    const after = (await owner(page).textContent())?.trim();
    await expect(page.getByTestId('access-scope')).toHaveText(after!);

    /* ---------------- nothing of the previous identity survives ------------- */

    // The run record is gone: the strip described work that is not this
    // identity's, and the interface must not claim it.
    await expect(page.getByTestId('run-state')).toHaveCount(0);
    await expect(page.getByTestId('streaming-answer')).toHaveCount(0);
    /*
     * The command context went with it.
     *
     * Asserted as the negation of what was checked before the switch
     * (`toContainText('case:')`) and not only as the empty-state wording: the
     * wording is the shell's and has already changed once ("brak wybranej
     * sprawy" became "brak wybranego rekordu" when the platform stopped naming
     * a business noun). What must be true is that the strip no longer names the
     * previous owner's record; the empty state is checked too, because "names
     * nothing" and "is empty" are not the same claim.
     */
    const context = page.getByTestId('chat-context');
    await expect(context).not.toContainText('case:');
    await expect(context).toContainText('brak wybranego rekordu');
    await expect(page.getByTestId('chat-selection')).toHaveCount(0);
    // And the address no longer points at the previous identity's conversation
    // or workspace.
    // Polled: clearing them is a router navigation, so it lands a tick later.
    await expect.poll(() => new URL(page.url()).search).not.toMatch(/[?&][cs]=/);
    // The conversation itself is not in the ready-made chat's list any more.
    await expect(page.locator('.pf-chat')).not.toContainText(threadTitle);

    /* --------- the part that only a still-running stream can show ----------- */

    /*
     * The run goes on in the backend — it was not cancelled, and cancelling it
     * would be a different test. Its events keep arriving for as long as the
     * scenario has pieces left. None of them may reach this page now.
     */
    await page.waitForTimeout(4000);
    await expect(page.getByTestId('run-state')).toHaveCount(0);
    await expect(page.getByTestId('streaming-answer')).toHaveCount(0);
    await expect(page.locator('.pf-chat')).not.toContainText(threadTitle);
    await expect(page.locator('.pf-chat')).not.toContainText('fragment');
    // Nothing of the previous identity's answer anywhere on the page.
    await expect(page.locator('body')).not.toContainText(partial.slice(0, 20));

    /* ------------------- hidden, not destroyed ----------------------------- */

    /*
     * In the same tab, still without a reload: switching back must bring the
     * first identity's conversation back. Kept in this test rather than in one
     * of its own because a new test gets a new browser context, and a fresh
     * page proves nothing about a cache that was never populated.
     */
    await page.getByTestId('switch-access-context').click();
    await expect(owner(page)).toHaveText(before ?? '');
    await expect(page.locator('.pf-chat')).toContainText(threadTitle, { timeout: 20_000 });
  });
});
