import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * Work continues while the user does something else — proved in the browser,
 * because the defect was in the browser.
 *
 * The backend was already resilient: a run is a promise chain, not a request
 * handler, and dropping the response never stopped it (`tests/background-runs.test.ts`
 * covers that). What killed tasks was the client. The chat's abort signal was
 * forwarded to the cancel endpoint, and the library fires that signal from
 * `selectThread` — so **switching conversation cancelled the run**, and so did
 * pressing reload. A backend test cannot catch that; only this can.
 */

const scripted = new ScriptedInstance({ port: 8794, dataDirName: '.e2e-scripted-tasks' });
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

/** Backend truth about what is running, asked of the backend. */
const activeRuns = (page: Page) =>
  page.evaluate(
    async () =>
      (await (await fetch('/api/runs/active', { credentials: 'include' })).json()) as {
        runs: Array<{ id: string; conversationId: string; status: string }>;
      },
  );

const runsOf = (page: Page, conversationId: string) =>
  page.evaluate(
    async (id) =>
      (await (await fetch(`/api/conversations/${id}/runs`, { credentials: 'include' })).json()) as {
        runs: Array<{ id: string; status: string }>;
      },
    conversationId,
  );

const urlConversation = (page: Page) => new URL(page.url()).searchParams.get('c');

async function startNewConversation(page: Page) {
  await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();
}

test.describe('zadania w tle', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });
  test.afterEach(() => scripted.stop());

  test('przelaczenie rozmowy i przeladowanie nie anuluja zadania', async ({ page }) => {
    await scripted.start('slow');
    await openApp(page);

    await send(page, 'Dlugie zadanie w rozmowie A.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    const conversationA = urlConversation(page);
    expect(conversationA).toBeTruthy();

    /* ---------------- switching conversation must not cancel ---------------- */

    await startNewConversation(page);
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);

    // The decisive assertion of this file: A is still the backend's work.
    await expect
      .poll(async () => (await runsOf(page, conversationA!)).runs[0]?.status, { timeout: 10_000 })
      .toMatch(/queued|running/);

    // And the strip of the conversation now on screen shows nothing of A's run.
    await expect(page.getByTestId('run-state')).toHaveCount(0);

    /* ------------------------- reload must not cancel ----------------------- */

    await page.reload();
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    await expect
      .poll(async () => (await runsOf(page, conversationA!)).runs[0]?.status, { timeout: 10_000 })
      .toMatch(/queued|running/);

    /* ----------- the task is announced without taking over the view --------- */

    const tasks = page.getByTestId('background-tasks');
    await expect(tasks).toBeVisible({ timeout: 15_000 });
    // Still not dragged into A.
    expect(urlConversation(page)).not.toBe(conversationA);
  });

  test('praca w rozmowie B nie miesza sie z zadaniem w A', async ({ page }) => {
    await scripted.restart('slow');
    await openApp(page);

    const before = await page.evaluate(
      async () =>
        (await (await fetch('/api/threads/get', { credentials: 'include' })).json()) as {
          threads: Array<{ id: string; title: string }>;
        },
    );
    const conversationA = before.threads[0]!.id;

    // A is still running from the previous test's scenario? Start a fresh one.
    await page.goto(`${BASE}/?c=${conversationA}`);
    await expect(page.locator('.openui-agent-thread-messages > *').first()).toBeVisible({
      timeout: 30_000,
    });

    await startNewConversation(page);
    await send(page, 'Niezalezne polecenie w rozmowie B.');
    const conversationB = await page.evaluate(async () => {
      for (let i = 0; i < 40; i += 1) {
        const c = new URL(location.href).searchParams.get('c');
        if (c) return c;
        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    });
    expect(conversationB).toBeTruthy();
    expect(conversationB).not.toBe(conversationA);

    // Each conversation keeps its own messages — nothing leaks between them.
    const thread = page.locator('.openui-agent-thread-messages');
    await expect(thread).toContainText('Niezalezne polecenie w rozmowie B', { timeout: 30_000 });
    await expect(thread).not.toContainText('Dlugie zadanie w rozmowie A');
  });

  test('powrot do rozmowy pokazuje wynik bez ponownego uruchamiania', async ({ page }) => {
    await scripted.restart('text-only');
    await openApp(page);
    await send(page, 'Zadanie ktore skonczy sie samo.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });
    const conversation = urlConversation(page)!;
    const runsAfterFirst = (await runsOf(page, conversation)).runs.length;
    expect(runsAfterFirst).toBe(1);

    // Leave, come back, reload — none of it may start the work again.
    await startNewConversation(page);
    await page.goto(`${BASE}/?c=${conversation}`);
    await expect(page.getByTestId('assistant-message')).toContainText('Czwarte zdanie odpowiedzi.', {
      timeout: 30_000,
    });
    await page.reload();
    await expect(page.getByTestId('assistant-message')).toContainText('Czwarte zdanie odpowiedzi.', {
      timeout: 30_000,
    });

    expect((await runsOf(page, conversation)).runs.length, 'zadanie uruchomiono ponownie').toBe(
      runsAfterFirst,
    );
  });

  test('jawne Stop konczy wskazane wykonanie', async ({ page }) => {
    await scripted.restart('slow');
    await openApp(page);
    await send(page, 'Zadanie do zatrzymania.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    const conversation = urlConversation(page)!;

    // The platform's own Stop, against this named run.
    const stop = page.getByTestId('run-stop');
    await expect(stop).toBeVisible();
    await stop.click();

    await expect
      .poll(async () => (await runsOf(page, conversation)).runs[0]?.status, { timeout: 30_000 })
      .toBe('cancelled');

    // And nothing is left in flight.
    await expect.poll(async () => (await activeRuns(page)).runs.length, { timeout: 15_000 }).toBe(0);
  });

  test('zadanie z innej rozmowy da sie zatrzymac z listy zadan', async ({ page }) => {
    await scripted.restart('slow');
    await openApp(page);
    await send(page, 'Dlugie zadanie do zatrzymania z listy.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    const conversation = urlConversation(page)!;

    // Walk away from it, then stop it from the background-task list.
    await startNewConversation(page);
    await page.getByTestId('background-tasks-toggle').click();
    const stop = page.getByTestId(`background-task-stop-${conversation}`);
    await expect(stop).toBeVisible({ timeout: 15_000 });
    await stop.click();

    await expect
      .poll(async () => (await runsOf(page, conversation)).runs[0]?.status, { timeout: 30_000 })
      .toBe('cancelled');
  });
});
