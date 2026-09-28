import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * The conversation the user was reading comes back — without them going to
 * fetch it.
 *
 * This is the behaviour two earlier tests worked *around*: after a reload they
 * reopened the conversation from the drawer "as a user would", and the comment
 * explaining that ("after a reload the chat opens on a new conversation, as
 * chats do") turned a missing feature into documented behaviour. A test that
 * accommodates the defect it should catch is worse than no test.
 *
 * Run against the scripted model so a real exchange exists to restore — the
 * history has to be genuine for its restoration to mean anything — and so it
 * costs no subscription turns and always produces the same conversation.
 */

const scripted = new ScriptedInstance({ port: 8795, dataDirName: '.e2e-scripted-restore' });
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

async function sendCommand(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
  await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /succeeded|failed/, {
    timeout: 60_000,
  });
}

/** Conversation id currently in the address bar, or null. */
const urlConversation = (page: Page) => new URL(page.url()).searchParams.get('c');

/**
 * Starts a new conversation from the chat's header control.
 *
 * There are two "New chat" buttons: an icon in the header, always on screen,
 * and a large one inside the conversation drawer — which is off-canvas while the
 * drawer is closed (measured at x=443 for a panel starting at x=720, so a click
 * lands on the canvas instead). The header one is what a user reaches without
 * opening the drawer, so it is what the test uses.
 */
async function startNewConversation(page: Page) {
  await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();
  await expect(page.getByTestId('assistant-message')).toHaveCount(0);
}

const threadMessages = (page: Page) => page.locator('.openui-agent-thread-messages > *');

/**
 * The messages of the open conversation — not the whole panel.
 *
 * `.pf-chat` also contains the drawer's list of *every* conversation, so
 * asserting on it cannot tell "this conversation's messages are on screen" from
 * "this conversation's title is in the list". Only the thread answers the
 * question these tests ask.
 */
const thread = (page: Page) => page.locator('.openui-agent-thread-messages');

test.describe('przywracanie kontekstu rozmowy', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });
  test.afterAll(() => scripted.stop());

  test('po przeladowaniu ta sama rozmowa, jej historia i przestrzen pracy', async ({ page }) => {
    await scripted.start('text-only');
    await openApp(page);

    // A conversation with real content in it.
    await sendCommand(page, 'Pierwsza rozmowa o kosztach.');
    await expect(page.getByTestId('assistant-message')).toContainText('Czwarte zdanie odpowiedzi.');

    const conversationId = urlConversation(page);
    expect(conversationId, 'rozmowa nie trafila do adresu').toBeTruthy();
    const messagesBefore = await threadMessages(page).count();
    expect(messagesBefore).toBeGreaterThan(0);

    /* ------------------------------- reload -------------------------------- */

    await page.reload();

    // The same conversation, with no drawer, no click, no second command.
    await expect
      .poll(() => urlConversation(page), { timeout: 15_000 })
      .toBe(conversationId);
    await expect(threadMessages(page).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('assistant-message')).toContainText('Czwarte zdanie odpowiedzi.');
    await expect(thread(page)).toContainText('Pierwsza rozmowa o kosztach');
    expect(await threadMessages(page).count()).toBe(messagesBefore);

    // And no replacement conversation was created behind the scenes.
    const threads = await page.evaluate(
      async () => (await (await fetch('/api/threads/get', { credentials: 'include' })).json()).threads,
    );
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(conversationId);
  });

  test('dalsze polecenie po przeladowaniu kontynuuje te sama sesje', async ({ page }) => {
    await scripted.restart('text-only');
    await openApp(page);

    const before = await page.evaluate(async () => {
      const { threads } = await (await fetch('/api/threads/get', { credentials: 'include' })).json();
      const conv = await (
        await fetch(`/api/conversations/${threads[0].id}`, { credentials: 'include' })
      ).json();
      const messages = await (
        await fetch(`/api/threads/get/${threads[0].id}`, { credentials: 'include' })
      ).json();
      return { id: conv.id, sessionId: conv.claudeSessionId, messageCount: messages.length };
    });
    expect(before.sessionId, 'rozmowa z poprzedniego testu nie ma sesji').toBeTruthy();

    // Land on the restored conversation and carry on typing.
    await page.goto(`${BASE}/?c=${before.id}`);
    await expect(threadMessages(page).first()).toBeVisible({ timeout: 30_000 });
    await sendCommand(page, 'Drugie polecenie w tej samej rozmowie.');

    const after = await page.evaluate(async (id) => {
      const conv = await (await fetch(`/api/conversations/${id}`, { credentials: 'include' })).json();
      const messages = await (
        await fetch(`/api/threads/get/${id}`, { credentials: 'include' })
      ).json();
      const { threads } = await (await fetch('/api/threads/get', { credentials: 'include' })).json();
      const { runs } = await (
        await fetch(`/api/conversations/${id}/runs`, { credentials: 'include' })
      ).json();
      return {
        sessionId: conv.claudeSessionId,
        messageCount: messages.length,
        threadCount: threads.length,
        runCount: runs.length,
      };
    }, before.id);

    // The follow-up went into the same conversation and resumed its session —
    // not into a new conversation with a fresh one.
    expect(after.threadCount, 'powstala nowa rozmowa zamiast kontynuacji').toBe(1);
    expect(after.runCount).toBe(2);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.messageCount).toBeGreaterThan(before.messageCount);
    expect(urlConversation(page)).toBe(before.id);
  });

  test('Wstecz i Dalej przelaczaja rozmowy bez mieszania historii', async ({ page }) => {
    await scripted.restart('text-only');
    await openApp(page);

    // A second conversation, so there is something to go back from.
    await startNewConversation(page);
    await sendCommand(page, 'Druga rozmowa o terminach.');
    const second = urlConversation(page);
    expect(second).toBeTruthy();

    const first = await page.evaluate(async (other) => {
      const { threads } = await (await fetch('/api/threads/get', { credentials: 'include' })).json();
      return threads.find((t: { id: string }) => t.id !== other).id as string;
    }, second);

    // Switch by URL, the way a link or Back/Forward does.
    await page.goto(`${BASE}/?c=${first}`);
    await expect(thread(page)).toContainText('Pierwsza rozmowa o kosztach', { timeout: 30_000 });
    await expect(thread(page)).not.toContainText('Druga rozmowa o terminach');

    await page.goBack();
    await expect.poll(() => urlConversation(page), { timeout: 15_000 }).toBe(second);
    await expect(thread(page)).toContainText('Druga rozmowa o terminach', { timeout: 30_000 });
    // The decisive part: going back must not leave the other conversation's
    // messages on screen alongside this one's.
    await expect(thread(page)).not.toContainText('Pierwsza rozmowa o kosztach');

    await page.goForward();
    await expect.poll(() => urlConversation(page), { timeout: 15_000 }).toBe(first);
    await expect(thread(page)).toContainText('Pierwsza rozmowa o kosztach', { timeout: 30_000 });
    await expect(thread(page)).not.toContainText('Druga rozmowa o terminach');
  });

  test('przestrzen pracy wraca razem z rozmowa', async ({ page }) => {
    await scripted.restart('text-only');
    await openApp(page, '/cases');

    // Opening a case creates its canvas space and puts the user in it.
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
    await expect(page.getByTestId('card-case-summary').first()).toBeVisible();

    await sendCommand(page, 'Rozmowa przy przestrzeni sprawy.');
    const conversationId = urlConversation(page);
    const spaceId = new URL(page.url()).searchParams.get('s');
    expect(spaceId, 'przestrzen nie trafila do adresu').toBeTruthy();

    await page.reload();
    await expect.poll(() => new URL(page.url()).searchParams.get('s'), { timeout: 15_000 }).toBe(
      spaceId,
    );
    await expect(page.getByTestId('card-case-summary').first()).toBeVisible();
    expect(urlConversation(page)).toBe(conversationId);

    // The conversation also carries the binding server-side, so opening it from
    // the drawer on a fresh session brings its workspace back.
    const bound = await page.evaluate(
      async (id) =>
        (await (await fetch(`/api/conversations/${id}`, { credentials: 'include' })).json()).spaceId,
      conversationId,
    );
    expect(bound).toBe(spaceId);
  });

  test('usunieta rozmowa daje czytelny stan zastepczy, nie pusty ekran', async ({ page }) => {
    await scripted.restart('text-only');
    await openApp(page);

    const doomed = await page.evaluate(async () => {
      const res = await fetch('/api/threads/create', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Rozmowa do usuniecia.' }] }),
      });
      const created = await res.json();
      await fetch(`/api/threads/delete/${created.id}`, { method: 'DELETE', credentials: 'include' });
      return created.id as string;
    });

    await page.goto(`${BASE}/?c=${doomed}`);

    const notice = page.getByTestId('conversation-missing');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toHaveAttribute('data-kind', 'gone');
    await expect(notice).toContainText('niedostepna');
    await expect(notice).toContainText(doomed.slice(-8));

    // Not someone else's conversation shown under a "missing" banner, and not a
    // dead end: the composer works and the notice can be dismissed.
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeEnabled();
    await notice.getByRole('button', { name: 'Zacznij nowa rozmowe' }).click();
    await expect(notice).toHaveCount(0);
    expect(urlConversation(page)).toBeNull();
  });

  test('rozmowa innego wlasciciela nie jest pokazywana', async ({ page }) => {
    await scripted.restart('text-only');
    await openApp(page);

    const mine = await page.evaluate(
      async () =>
        (await (await fetch('/api/threads/get', { credentials: 'include' })).json()).threads[0]
          .id as string,
    );

    // Switch to the other local identity and ask for the first one's URL.
    await page.evaluate(() =>
      fetch('/api/auth/session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'other-user' }),
      }),
    );
    await page.goto(`${BASE}/?c=${mine}`);

    const notice = page.getByTestId('conversation-missing');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toHaveAttribute('data-kind', 'gone');
    // Nothing of the other owner's conversation reaches the screen — neither
    // its messages nor its title in the drawer's list.
    await expect(page.locator('.pf-chat')).not.toContainText('Pierwsza rozmowa o kosztach');
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);
  });
});
