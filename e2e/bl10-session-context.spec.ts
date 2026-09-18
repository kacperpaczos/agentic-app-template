import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * The context the user is in — which conversation, which workspace — across
 * links, Back/Forward and a slow network.
 *
 * Three criteria meet here, and they are the same story from three sides:
 *
 *  - **L2.3** navigation, reload and Back/Forward restore the right conversation
 *    *and* the right workspace, without hunting for the conversation in a list;
 *  - **L2.8** selection, workspace change, links and Back/Forward keep one
 *    consistent context, and an answer that arrives late for a choice the user
 *    has left must not undo the newer one;
 *  - **L2.11** a conversation that is gone, and a history that fails to load,
 *    have readable fallback states — and another owner's titles and messages
 *    never reach the screen.
 *
 * Driven against an isolated instance with a scripted stand-in for the model:
 * conversations and spaces are prepared through the same HTTP API the interface
 * uses, and every assertion is about what is on screen afterwards.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-bl10-context' });
const BASE = scripted.baseUrl;

async function signIn(page: Page, userId?: string) {
  await page.goto(`${BASE}/`);
  await page.evaluate(
    (id) =>
      fetch('/api/auth/session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(id ? { userId: id } : {}),
      }),
    userId ?? null,
  );
}

async function openAt(page: Page, path: string) {
  await page.goto(`${BASE}${path}`);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);

/** A workspace with one recognisable card in it, created through the API. */
async function makeSpace(page: Page, title: string, note: string): Promise<string> {
  return page.evaluate(
    async ({ title, note }) => {
      const space = await (
        await fetch('/api/canvas/spaces', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title }),
        })
      ).json();
      await fetch('/api/canvas/cards', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          spaceId: space.id,
          title: note,
          spec: { kind: 'component', component: 'platform.markdown', props: { markdown: note } },
          geometry: { x: 40, y: 40, width: 320, height: 160 },
        }),
      });
      return space.id as string;
    },
    { title, note },
  );
}

/** A conversation with one message, optionally bound to a workspace. */
async function makeConversation(page: Page, title: string, spaceId?: string): Promise<string> {
  return page.evaluate(
    async ({ title, spaceId }) => {
      const conv = await (
        await fetch('/api/threads/create', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages: [{ id: crypto.randomUUID(), role: 'user', content: title }],
            ...(spaceId ? { spaceId } : {}),
          }),
        })
      ).json();
      return conv.id as string;
    },
    { title, spaceId: spaceId ?? null },
  );
}

const drawer = (page: Page) => page.locator('.openui-agent-thread-list');
const thread = (page: Page) => page.locator('.openui-agent-thread-messages');

/**
 * Opens the conversation drawer, by the library's own state rather than by
 * visibility.
 *
 * The drawer slides off-canvas when closed, and an off-canvas element still has
 * a box — so `isVisible()` answers "yes" for a drawer nobody can reach, and a
 * click on a row in it lands nowhere. `data-sidebar-visual-state` is the
 * library's own signal and is what this asks.
 */
async function openDrawer(page: Page) {
  const container = page.locator('.openui-agent-sidebar-container');
  if ((await container.getAttribute('data-sidebar-visual-state')) !== 'expanded') {
    await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
  }
  await expect(container).toHaveAttribute('data-sidebar-visual-state', 'expanded');
  /*
   * And then wait for it to stop moving. The visual state flips before the
   * slide finishes, and a click on a row that is still travelling lands where
   * the row *was* — which looks exactly like a click that did nothing.
   */
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const panel = document.querySelector('.pf-chat')?.getBoundingClientRect();
          const el = document.querySelector('.openui-agent-sidebar-container')?.getBoundingClientRect();
          if (!panel || !el) return 0;
          return Math.max(0, Math.min(panel.right, el.right) - Math.max(panel.left, el.left));
        }),
      { timeout: 5000, message: 'szuflada nie zatrzymala sie w panelu' },
    )
    .toBeGreaterThan(100);
  await expect(drawer(page)).toBeVisible();
}

test.describe('kontekst rozmowy i przestrzeni', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(async () => {
    scripted.prepareDatabase();
    await scripted.start('text-only');
  });
  test.afterAll(() => scripted.stop());

  /* ----------------------------------------------------------------- L2.3 -- */

  test('przejscie przez link zachowuje rozmowe i przestrzen', async ({ page }) => {
    await signIn(page);
    const space = await makeSpace(page, 'Przestrzen linkowa', 'Karta linkowa');
    const conversation = await makeConversation(page, 'Rozmowa linkowa', space);

    await openAt(page, `/?c=${conversation}&s=${space}`);
    await expect(page.locator('.pf-card', { hasText: 'Karta linkowa' }).first()).toBeVisible();

    // An ordinary link in the platform's navigation — nothing about the session
    // is passed at the call site; the router is what keeps it.
    await page.getByRole('link', { name: 'Pliki i raporty' }).click();
    await expect(page.getByTestId('files-page')).toBeVisible();
    expect(param(page, 'c'), 'link zgubil rozmowe').toBe(conversation);
    expect(param(page, 's'), 'link zgubil przestrzen').toBe(space);

    // A module's own link, added by a module that knows nothing of the session.
    await page.getByRole('link', { name: 'Dostawcy' }).click();
    await expect(page).toHaveURL(/\/data/);
    expect(param(page, 'c')).toBe(conversation);
    expect(param(page, 's')).toBe(space);

    // And the conversation on screen is still that conversation, with no drawer.
    await expect(thread(page)).toContainText('Rozmowa linkowa');
  });

  test('Wstecz i Dalej przywracaja przestrzen razem z rozmowa', async ({ page }) => {
    await signIn(page);
    const first = await makeSpace(page, 'Przestrzen pierwsza', 'Karta pierwsza');
    const second = await makeSpace(page, 'Przestrzen druga', 'Karta druga');
    const conversation = await makeConversation(page, 'Rozmowa przy przestrzeniach');

    await openAt(page, `/spaces?c=${conversation}`);
    await page.getByTestId(`space-${first}`).click();
    await expect(page.locator('.pf-card', { hasText: 'Karta pierwsza' }).first()).toBeVisible();
    expect(param(page, 's')).toBe(first);

    await page.getByRole('link', { name: 'Zapisane kompozycje' }).click();
    await expect(page.getByTestId('workspace-page')).toBeVisible();
    await page.getByTestId(`space-${second}`).click();
    await expect(page.locator('.pf-card', { hasText: 'Karta druga' }).first()).toBeVisible();
    expect(param(page, 's')).toBe(second);

    /*
     * One Back for one choice. The workspace used to be written into the
     * address by replacement, which overwrote the entry the user came from:
     * Back landed on the list with the *new* workspace already in force, and
     * undoing one click took two.
     */
    await page.goBack();
    await expect(page.getByTestId('workspace-page')).toBeVisible();
    await expect.poll(() => param(page, 's'), { timeout: 15_000 }).toBe(first);
    // The application followed the address back, not only the address bar: the
    // list marks the workspace it considers open.
    await expect(page.getByTestId(`space-${first}`)).toContainText('otwarta', { timeout: 15_000 });
    await expect(page.getByTestId(`space-${second}`)).not.toContainText('otwarta');
    expect(param(page, 'c'), 'Wstecz zgubil rozmowe').toBe(conversation);

    await page.goBack();
    await expect.poll(() => param(page, 's'), { timeout: 15_000 }).toBe(first);
    await expect(page.locator('.pf-card', { hasText: 'Karta pierwsza' }).first()).toBeVisible();
    await expect(page.locator('.pf-card', { hasText: 'Karta druga' })).toHaveCount(0);
    expect(param(page, 'c')).toBe(conversation);

    await page.goForward();
    await page.goForward();
    await expect.poll(() => param(page, 's'), { timeout: 15_000 }).toBe(second);
    await expect(page.locator('.pf-card', { hasText: 'Karta druga' }).first()).toBeVisible();
    expect(param(page, 'c')).toBe(conversation);
  });

  /* ----------------------------------------------------------------- L2.8 -- */

  test('stara odpowiedz sieciowa nie cofa nowszego wyboru rozmowy', async ({ page }) => {
    await signIn(page);
    const spaceA = await makeSpace(page, 'Przestrzen A', 'Karta A');
    const spaceB = await makeSpace(page, 'Przestrzen B', 'Karta B');
    const titleA = `Rozmowa A ${Date.now()}`;
    const titleB = `Rozmowa B ${Date.now() + 1}`;
    const convA = await makeConversation(page, titleA, spaceA);
    const convB = await makeConversation(page, titleB, spaceB);

    /*
     * The lookup that follows a conversation to its workspace is one request
     * behind the click. Held back for A only, so the answer for the choice the
     * user has already left lands well after the choice they made instead.
     */
    await page.route('**/api/conversations/**', async (route) => {
      if (route.request().url().includes(convA)) await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });

    await openAt(page, '/');
    await openDrawer(page);

    /*
     * `force`: the thread list re-renders while it loads and Playwright's
     * stability check never settles on a row inside it. The row is asserted
     * visible by the drawer check above.
     */
    await page.getByText(titleA, { exact: false }).first().click({ force: true });
    await expect.poll(() => param(page, 'c'), { timeout: 10_000 }).toBe(convA);

    // Change of mind, before A's workspace lookup has answered.
    await openDrawer(page);
    await page.getByText(titleB, { exact: false }).first().click({ force: true });
    await expect.poll(() => param(page, 'c'), { timeout: 10_000 }).toBe(convB);

    // B's workspace arrives and is adopted…
    await expect.poll(() => param(page, 's'), { timeout: 10_000 }).toBe(spaceB);
    await expect(page.locator('.pf-card', { hasText: 'Karta B' }).first()).toBeVisible();

    // …and then A's late answer arrives. It must change nothing.
    await page.waitForTimeout(3500);
    expect(param(page, 'c'), 'spozniona odpowiedz cofnela wybor rozmowy').toBe(convB);
    expect(param(page, 's'), 'spozniona odpowiedz cofnela przestrzen').toBe(spaceB);
    await expect(page.locator('.pf-card', { hasText: 'Karta B' }).first()).toBeVisible();
    await expect(page.locator('.pf-card', { hasText: 'Karta A' })).toHaveCount(0);
    await page.unroute('**/api/conversations/**');
  });

  /* ---------------------------------------------------------------- L2.11 -- */

  test('nieudane wczytanie historii daje czytelny stan zastepczy i ponowienie', async ({ page }) => {
    await signIn(page);
    const conversation = await makeConversation(page, `Rozmowa z awaria ${Date.now()}`);

    // The history request for this conversation, and only it, fails.
    let failing = true;
    await page.route(`**/api/threads/get/${conversation}`, async (route) => {
      if (failing) await route.abort('failed');
      else await route.continue();
    });

    await page.goto(`${BASE}/?c=${conversation}`);

    const notice = page.getByTestId('conversation-missing');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    // Distinguished from a deleted conversation: this one exists and is worth retrying.
    await expect(notice).toHaveAttribute('data-kind', 'failed');
    await expect(notice).toContainText('Nie udalo sie wczytac rozmowy');
    await expect(notice).toContainText('Nic nie zostalo utracone');
    await expect(notice).toContainText(conversation.slice(-8));
    // Not an empty thread pretending to be a conversation with nothing in it.
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeEnabled();

    failing = false;
    await notice.getByRole('button', { name: 'Sprobuj ponownie' }).click();
    await expect(notice).toHaveCount(0, { timeout: 30_000 });
    await expect(thread(page)).toContainText('Rozmowa z awaria', { timeout: 30_000 });
    await page.unroute(`**/api/threads/get/${conversation}`);
  });

  test('rozmowa innego wlasciciela: zastepczy stan, zadnego tytulu ani wiadomosci', async ({ page }) => {
    await signIn(page);
    const secret = `Tajny tytul ${Date.now()}`;
    const mine = await makeConversation(page, secret);

    // The second local identity asks for the first one's conversation by URL.
    await signIn(page, 'other-user');
    await page.goto(`${BASE}/?c=${mine}`);

    const notice = page.getByTestId('conversation-missing');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toHaveAttribute('data-kind', 'gone');
    await expect(notice).toContainText('niedostepna');

    // The negative control: nothing of the other owner reaches this screen —
    // not the messages, not the title in the drawer's list.
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);
    await expect(page.locator('.pf-chat')).not.toContainText(secret);
    await openDrawer(page);
    await expect(drawer(page)).not.toContainText(secret);
    await expect(page.locator('body')).not.toContainText(secret);

    // And the API says the same thing, so the screen is not merely hiding it.
    const visible = await page.evaluate(async () => {
      const { threads } = await (await fetch('/api/threads/get', { credentials: 'include' })).json();
      return (threads as Array<{ title: string }>).map((t) => t.title);
    });
    expect(visible).not.toContain(secret);
  });
});
