import { expect, test } from './support/fixtures.ts';
import { type APIRequestContext, type Page } from '@playwright/test';

/**
 * The conversation drawer.
 *
 * The audit found the drawer pinned open on top of the conversation with no way
 * to close it. The cause was ours: `AgentInterface` picks its own layout from
 * the width it measures, chooses its mobile arrangement at this panel width, and
 * slides the drawer off-canvas when closed — and a `left: 0 !important` override
 * in our stylesheet cancelled exactly that, in a layout whose close button the
 * library hides.
 *
 * These tests therefore check the behaviour rather than the CSS: with the drawer
 * closed the conversation must own the panel, and a keyboard user must be able
 * to open it and close it again.
 */

/**
 * The drawer animates between states, so every assertion waits for it to settle
 * rather than sampling mid-transition. `data-sidebar-visual-state` is the
 * library's own signal that the animation has finished.
 */
/**
 * Waits for the drawer to finish moving.
 *
 * `data-sidebar-visual-state` flips before the 400ms slide completes, so the
 * geometry itself is what is polled: closed means it covers none of the panel,
 * open means it covers a real part of it.
 */
const settled = async (page: Page, state: 'collapsed' | 'expanded') => {
  await expect(
    page.locator(`.openui-agent-sidebar-container[data-sidebar-visual-state="${state}"]`),
  ).toHaveCount(1);
  await expect
    .poll(async () => (await coverage(page)) <= 2, {
      message: `szuflada nie osiagnela stanu "${state}"`,
      timeout: 5000,
    })
    .toBe(state === 'collapsed');
};

const openChat = async (page: Page, request: APIRequestContext) => {
  await request.post('/api/auth/session', { data: {} });
  await page.goto('/');
  await expect(page.locator('.pf-chat')).toBeVisible();
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
  // The panel starts with the drawer closed; wait for that to be true rather
  // than measuring while it is still sliding away.
  await settled(page, 'collapsed');
};

/** How much of the chat panel the drawer covers, in pixels. */
async function coverage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const panel = document.querySelector('.pf-chat')?.getBoundingClientRect();
    const drawer = document.querySelector('.openui-agent-sidebar-container')?.getBoundingClientRect();
    if (!panel || !drawer) return 0;
    return Math.max(0, Math.min(panel.right, drawer.right) - Math.max(panel.left, drawer.left));
  });
}

const opener = (page: Page) => page.locator('.pf-chat [aria-label="Open sidebar"]');
const closer = (page: Page) => page.locator('.pf-chat [aria-label="Collapse sidebar"]');

for (const vp of [
  { name: 'szeroki', width: 1680, height: 1000 },
  { name: 'waski', width: 1120, height: 900 },
]) {
  test.describe(`szuflada rozmow — uklad ${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('zamknieta szuflada nie zaslania rozmowy', async ({ page, request }) => {
      await openChat(page, request);
      expect(await coverage(page), 'szuflada zaslania panel mimo zamkniecia').toBeLessThanOrEqual(2);

      // The conversation and its composer own the panel.
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
      // The drawer sits fully off-canvas, to the left of the panel.
      const left = await page
        .locator('.openui-agent-sidebar-container')
        .evaluate((el) => getComputedStyle(el).left);
      expect(left).not.toBe('0px');
    });

    test('otwarcie i zamkniecie dziala z klawiatury, kompozytor pozostaje dostepny', async ({
      page,
      request,
    }) => {
      await openChat(page, request);

      // Open with a visible, labelled control.
      await expect(opener(page)).toBeVisible();
      await opener(page).focus();
      await page.keyboard.press('Enter');
      await settled(page, 'expanded');
      await expect(page.locator('.openui-agent-thread-list')).toBeVisible();
      expect(await coverage(page), 'otwarta szuflada nie weszla w panel').toBeGreaterThan(100);

      // A close control must exist, be visible, and take focus.
      await expect(closer(page)).toBeVisible();
      const focused = await closer(page).evaluate((el) => {
        el.focus();
        return document.activeElement === el;
      });
      expect(focused, 'kontrolka zamykania nie przyjmuje fokusu').toBe(true);

      await page.keyboard.press('Enter');
      await settled(page, 'collapsed');
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    });

    test('canvas pod spodem pozostaje klikalny przy zamknietej szufladzie', async ({
      page,
      request,
    }) => {
      await openChat(page, request);
      // Whatever sits at the panel's left edge must belong to the chat, not be a
      // drawer hovering over the application.
      const owner = await page.evaluate(() => {
        const panel = document.querySelector('.pf-chat')!.getBoundingClientRect();
        const el = document.elementFromPoint(panel.left + 8, panel.top + panel.height / 2);
        return el?.closest('.pf-chat') ? 'chat' : 'poza czatem';
      });
      expect(owner).toBe('chat');
    });
  });
}
