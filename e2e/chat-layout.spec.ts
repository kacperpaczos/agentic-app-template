import { expect, test } from './support/fixtures.ts';
import { type Page } from '@playwright/test';

/**
 * The chat panel's layout, and the rule that was broken to lose it.
 *
 * `AgentInterface` renders any child it does not recognise as a slot into
 * `slots.rest` — the last child of its own container, laid out beside the
 * thread. An attachment strip added as an ordinary child therefore became a
 * panel of its own: measured in the browser, 393px of a 559px panel, with the
 * conversation squeezed into the remaining 166px and wrapping one word per line.
 * That is what the user reported, and no test noticed, because every test asked
 * whether an element was visible — which it was.
 *
 * So these assertions are about geometry and ownership, not visibility:
 *
 *  1. nothing of ours is an element child of the library's container;
 *  2. the conversation keeps the panel;
 *  3. attaching a file is a control *inside* the composer, on the send button's
 *     row — the ChatGPT-like arrangement that was asked for;
 *  4. artifacts are a tab of their own, reachable without opening the drawer.
 *
 * (1) is the general rule and (2) its consequence; (1) alone would pass if the
 * library changed how it lays out, and (2) alone would not say what went wrong.
 */

const openChat = async (page: Page) => {
  await page.goto('/');
  await expect(page.locator('.pf-chat')).toBeVisible();
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
};

const box = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom } : null;
  }, selector);

test.beforeEach(async ({ request }) => {
  await request.post('/api/auth/session', { data: {} });
});

test('nic naszego nie jest dzieckiem kontenera czatu', async ({ page }) => {
  await openChat(page);

  const foreign = await page.evaluate(() =>
    [...(document.querySelector('.openui-agent-container')?.children ?? [])]
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]}`)
      .filter((name) => !name.includes('.openui-')),
  );

  expect(
    foreign,
    'element spoza biblioteki trafil do kontenera AgentInterface i stal sie panelem obok watku',
  ).toEqual([]);
});

test('watek zajmuje panel, a nie ulamek jego szerokosci', async ({ page }) => {
  await openChat(page);

  const panel = await box(page, '.pf-chat');
  const thread = await box(page, '.openui-agent-thread-container');
  expect(panel).not.toBeNull();
  expect(thread).not.toBeNull();

  /*
   * Threshold, not equality: the drawer is off-canvas and the library may keep
   * its own padding. What this rules out is a second panel taking a share —
   * the broken layout measured 166/559, i.e. 30%.
   */
  const share = thread!.width / panel!.width;
  expect(share, `watek zajmuje ${Math.round(share * 100)}% panelu`).toBeGreaterThan(0.9);
});

test('zalacznik dolacza sie w polu wiadomosci, obok przycisku wyslania', async ({ page }) => {
  await openChat(page);

  // Inside the composer's own action bar — not merely somewhere on the page.
  const inActionBar = await page.evaluate(() =>
    Boolean(
      document
        .querySelector('.openui-agent-thread-composer__action-bar')
        ?.contains(document.querySelector('[data-testid="chat-attach-open"]')),
    ),
  );
  expect(inActionBar, 'przycisk zalacznika nie jest w pasku akcji kompozytora').toBe(true);

  // One row: the clip on the left, send on the right, centres aligned.
  const clip = (await box(page, '[data-testid="chat-attach-open"]'))!;
  const send = (await box(page, '.openui-agent-thread-composer__submit-button'))!;
  expect(Math.abs(clip.y + clip.height / 2 - (send.y + send.height / 2))).toBeLessThan(4);
  expect(clip.x, 'spinacz powinien byc po lewej, przycisk wyslania po prawej').toBeLessThan(send.x);

  // And the menu opens over the conversation rather than pushing it aside.
  await page.getByTestId('chat-attach-open').click();
  await expect(page.getByTestId('chat-attach-menu')).toBeVisible();
  const menu = (await box(page, '[data-testid="chat-attach-menu"]'))!;
  expect(menu.bottom, 'menu powinno otwierac sie w gore, nad kompozytorem').toBeLessThanOrEqual(
    clip.y + 1,
  );

  /*
   * The menu must not be inside the composer, and must actually be painted.
   *
   * Both halves are needed. The library's `__input-wrapper` is `overflow: clip`,
   * so a menu rendered inside it is cut off at the composer's edge — and a cut
   * off element still has its full box and still passes `toBeVisible()`. The
   * first version of this menu lost its upload button exactly that way, with
   * only the file list below it on screen. Hit-testing is what notices:
   * `elementFromPoint` respects clipping, so it answers what a user can click.
   */
  const insideComposer = await page.evaluate(() =>
    Boolean(
      document
        .querySelector('.openui-agent-thread-composer')
        ?.contains(document.querySelector('[data-testid="chat-attach-menu"]')),
    ),
  );
  expect(insideComposer, 'menu w kompozytorze zostanie przyciete przez overflow: clip').toBe(false);

  const uploadHit = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-attach-upload"]');
    const r = el?.getBoundingClientRect();
    if (!el || !r || r.width === 0) return 'brak';
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    if (hit === el || el.contains(hit)) return 'trafiony';
    return hit ? `zaslonily go ${hit.tagName.toLowerCase()}` : 'nic tam nie ma — przyciete';
  });
  expect(uploadHit, '"Wgraj z dysku" nie jest klikalne — menu jest przyciete').toBe('trafiony');

  const after = (await box(page, '.openui-agent-thread-container'))!;
  const panel = (await box(page, '.pf-chat'))!;
  expect(after.width / panel.width).toBeGreaterThan(0.9);
});

test('artefakty sa osobna zakladka panelu', async ({ page }) => {
  await openChat(page);

  const thread = page.getByTestId('chat-tab-thread');
  const artifacts = page.getByTestId('chat-tab-artifacts');

  // Visible without opening the drawer — that was the whole complaint.
  await expect(artifacts).toBeVisible();
  await expect(thread).toHaveAttribute('aria-selected', 'true');
  await expect(artifacts).toHaveAttribute('aria-selected', 'false');

  await artifacts.click();
  await expect(artifacts).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.openui-agent-artifact-browser')).toBeVisible();
  // The composer belongs to the conversation, so it is not on this tab.
  await expect(page.locator('.openui-agent-thread-composer__input')).toHaveCount(0);

  await thread.click();
  await expect(thread).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
  // Returning must restore the composer's attachment control, not leave a gap.
  await expect(page.getByTestId('chat-attach-open')).toBeVisible();
});
