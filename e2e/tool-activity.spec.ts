import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * Tool activity in the chat — visible while it happens, and still there
 * afterwards.
 *
 * The audit found that a reloaded conversation showed the agent's conclusion
 * with no trace of the steps that produced it. The cause was not the chat: the
 * ready-made component renders tool activity from the message list, pairing an
 * assistant message's `toolCalls` with the `role: "tool"` messages that carry
 * the results. The backend simply never stored either.
 *
 * These tests run against the real application with a scripted stand-in where
 * the model would be, so the ordering, the tool result and the failure are the
 * test's choice rather than the model's. Nothing else is stubbed — same HTTP
 * app, same database, same frontend — which is what makes a backend restart a
 * meaningful thing to check here.
 */

/*
 * Its own instance, on its own reserved port, over its own data directory.
 * `ScriptedInstance` validates all three before starting anything and stops
 * only the process it started — an earlier cleanup matched by command line and
 * killed the user's own server with it.
 */
const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted' });
const BASE = scripted.baseUrl;

const timeline = (page: Page) => page.locator('.openui-behind-the-scenes, .openui-tool-call-timeline, .openui-tool-call').first();

async function sendCommand(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

/**
 * Opens a conversation from the drawer, as a user would, and waits for it to
 * finish loading.
 *
 * The chat hides the thread container while it fetches messages, so asserting
 * on its contents immediately after the click races the fetch.
 */
async function openConversation(page: Page, title?: string) {
  const expanded = page.locator(
    '.openui-agent-sidebar-container[data-sidebar-visual-state="expanded"]',
  );
  // Idempotent: the drawer may already be open, and pressing the opener again
  // would only be swallowed by the drawer itself.
  if ((await expanded.count()) === 0) {
    await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
  }
  // Wait for the drawer to finish sliding in. Clicking during the 400 ms
  // transition lands where the row *was*, and the conversation never opens.
  await expect(expanded).toHaveCount(1);

  const row = title
    ? page.locator('.openui-agent-thread-button', { hasText: title }).first()
    : page.locator('.openui-agent-thread-button').first();
  await expect(row).toBeVisible();
  // The row is a container; the clickable control is the title button inside it.
  await row.locator('.openui-agent-thread-button-title').first().click();

  await expect(page.locator('.openui-agent-thread-messages > *').first()).toBeVisible({
    timeout: 30_000,
  });
}

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

test.describe('aktywnosc narzedzi w czacie (scenariusz zamiast modelu)', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });

  test.afterEach(async () => {
    await scripted.stop();
  });

  test('wywolanie, jego wynik i odpowiedz sa widoczne w czacie', async ({ page }) => {
    await scripted.start('tool-then-text');
    await openApp(page);
    await sendCommand(page, 'Dodaj karte podsumowania.');

    // The steps appear while the turn is still open — before any answer bubble.
    await expect(timeline(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('run-state')).toBeVisible();
    // The tool is named on screen, for a screen reader as well as visually.
    await expect(page.locator('.pf-chat')).toContainText(/canvas_add_card/);

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('assistant-message')).toContainText(
      'Widac na niej podsumowanie sprawy.',
    );
  });

  /*
   * Incremental text is asserted on a turn with no tool call, because that is
   * where the ready-made chat streams it into the assistant message.
   *
   * When a turn *does* call a tool, `InterleavedTurn` withholds the answer
   * bubble until the turn resolves (`answer = !turnLive || hasLangSyntax(...)`)
   * and streams the prose into the tool timeline instead. That is the library's
   * behaviour, not a defect, and it is why the previous streaming assertion —
   * which waited for text in a tool turn — could only ever see the finished
   * answer, and passed on a starter chip label instead.
   */
  test('tekst odpowiedzi przyrasta w wiadomosci asystenta przed koncem wykonania', async ({ page }) => {
    await scripted.start('text-only');
    await openApp(page);
    await sendCommand(page, 'Opowiedz cos w czterech zdaniach.');

    /*
     * While the turn is open the answer lives in the chat's live preview; when
     * the turn resolves the ready-made thread commits it as an assistant
     * message. Both are read, so the test follows the text across that handover
     * instead of assuming which element holds it at a given instant.
     */
    const answerText = () =>
      page.evaluate(() =>
        [
          ...document.querySelectorAll('[data-testid="streaming-answer"]'),
          ...document.querySelectorAll('[data-testid="assistant-message"]'),
        ]
          .map((n) => n.textContent ?? '')
          .join(''),
      );

    const samples: number[] = [];
    let sawWhileRunning = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const phase = await page.getByTestId('run-state').getAttribute('data-phase');
      const text = await answerText();
      if (text.includes('Pierwsze zdanie')) {
        samples.push(text.length);
        if (phase === 'queued' || phase === 'running') sawWhileRunning = true;
      }
      if (phase === 'succeeded' || phase === 'failed') break;
      await page.waitForTimeout(25);
    }

    expect(sawWhileRunning, 'tresc pojawila sie dopiero po zakonczeniu — to nie jest streaming').toBe(true);
    expect(samples.length, 'nie zaobserwowano odpowiedzi w trakcie wykonania').toBeGreaterThan(1);
    expect(Math.max(...samples), 'tresc nie przyrastala').toBeGreaterThan(Math.min(...samples));
    await expect(page.getByTestId('assistant-message')).toContainText('Czwarte zdanie odpowiedzi.');
  });

  test('aktywnosc przezywa przeladowanie, przelaczenie rozmowy i restart backendu', async ({ page }) => {
    await scripted.start('tool-then-text');
    await openApp(page);
    await sendCommand(page, 'Dodaj karte podsumowania, prosze.');
    await expect(timeline(page)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });

    /*
     * Identify the thread by the command this test sent, not by position. The
     * suite is serial and shares a database, so "the newest thread" is not a
     * reliable way to find the one under test.
     */
    const historyBefore = await page.evaluate(async (needle) => {
      const { threads } = await (await fetch('/api/threads/get', { credentials: 'include' })).json();
      const thread = threads.find((t: any) => String(t.title).includes(needle));
      if (!thread) throw new Error(`nie znaleziono watku "${needle}" wsrod: ${threads.map((t: any) => t.title).join(' | ')}`);
      return {
        id: thread.id,
        title: thread.title,
        messages: await (await fetch(`/api/threads/get/${thread.id}`, { credentials: 'include' })).json(),
      };
    }, 'Dodaj karte podsumowania, prosze');
    expect(historyBefore.title).toContain('Dodaj karte podsumowania');
    expect(
      historyBefore.messages.some((m: any) => Array.isArray(m.toolCalls) && m.toolCalls.length > 0),
      'historia nie niesie wywolan narzedzi',
    ).toBe(true);
    expect(historyBefore.messages.some((m: any) => m.role === 'tool')).toBe(true);

    /* ---------------------------- reload ---------------------------------- */
    /*
     * Straight reload, nothing else.
     *
     * This used to reopen the conversation from the drawer first, with a comment
     * saying the chat opens on a new conversation "as chats do" — accommodating
     * the very defect a reload test exists to catch. The conversation is now
     * restored from the address bar, so the assertion is simply that the
     * activity is still there.
     */
    await page.reload();
    await expect(timeline(page), 'aktywnosc narzedzi znikla po przeladowaniu').toBeVisible({
      timeout: 30_000,
    });

    /* ------------------- switch away and back ------------------------------ */
    await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
    await expect(
      page.locator('.openui-agent-sidebar-container[data-sidebar-visual-state="expanded"]'),
    ).toHaveCount(1);
    await page.locator('.pf-chat [aria-label="New chat"]').first().click();
    await expect(
      page.locator('.openui-behind-the-scenes, .openui-tool-call-timeline, .openui-tool-call'),
    ).toHaveCount(0);

    await openConversation(page, 'Dodaj karte podsumowania, prosze');
    await expect(timeline(page), 'aktywnosc narzedzi znikla po przelaczeniu rozmowy').toBeVisible();

    /* --------------------------- restart ----------------------------------- */
    // A reload, because that is what the user's browser does after the backend
    // comes back: same address, same conversation.
    await scripted.restart('tool-then-text');
    await page.reload();
    await expect(timeline(page), 'aktywnosc narzedzi znikla po restarcie backendu').toBeVisible({
      timeout: 30_000,
    });

    // And the stored history is byte-identical: the restart neither lost the
    // turn nor replayed it into a duplicate.
    const historyAfter = await page.evaluate(
      async (id) => (await fetch(`/api/threads/get/${id}`, { credentials: 'include' })).json(),
      historyBefore.id,
    );
    expect(historyAfter.map((m: any) => m.id)).toEqual(historyBefore.messages.map((m: any) => m.id));
  });

  test('blad narzedzia jest pokazany jako blad, nie jako wynik', async ({ page }) => {
    await scripted.start('tool-error');
    await openApp(page);
    await sendCommand(page, 'Dodaj karte nieznanego typu.');
    await expect(timeline(page)).toBeVisible({ timeout: 60_000 });

    // Marked as a failure at a glance, before anything is expanded.
    await expect(page.locator('.pf-chat')).toContainText(/failed/i, { timeout: 60_000 });

    // And the reason is reachable: the steps panel opens and names it.
    await page.locator('.openui-behind-the-scenes__toggle').first().click();
    await expect(page.locator('.pf-chat')).toContainText('Nieznany komponent', { timeout: 30_000 });
    // The run itself still completes: a failing tool is not a failing run.
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });
  });

  test('blad wykonania jest widoczny w aplikacji wraz z kodem, a praca nie znika', async ({ page }) => {
    await scripted.start('run-failure');
    await openApp(page);
    await sendCommand(page, 'Zrob cos, co sie nie uda.');

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'failed', {
      timeout: 60_000,
    });
    const error = page.getByTestId('run-error');
    await expect(error).toBeVisible();
    // Usage limit is reported as a limit, not as a broken login.
    await expect(error).toContainText('rate_limited');

    // The composer is usable again — the task does not hang in loading.
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeEnabled();
    // Text produced before the failure is kept.
    await expect(page.locator('.pf-chat')).toContainText('Zaczynam');
  });
});
