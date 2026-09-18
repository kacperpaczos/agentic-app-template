import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type BrowserContext, type Page } from '@playwright/test';

/**
 * What happens to work in progress when the observer goes away.
 *
 * Three ways of going away, each with a different expected consequence, and none
 * of them cancellation:
 *
 *  - **the panel is closed** (the tab is gone) — the run carries on and a tab
 *    opened later shows the finished answer;
 *  - **the network drops** — the stream dies, the run does not, and when the
 *    network comes back the client re-attaches and shows the result **once**;
 *  - **the page is reloaded mid-run** — the client re-attaches from its cursor,
 *    and the answer is not doubled. That doubling is not hypothetical: the send
 *    path and the background re-attachment both fed the reducer, and a 107
 *    character answer was measured as 214.
 *
 * The one thing that *does* end a run without a Stop is a documented condition,
 * and the last test exercises it: the hard `APP_RUN_TIMEOUT_MS` ceiling.
 *
 * **Simulation at the model boundary, marked as such**: the scenario is scripted,
 * everything else — the run registry, the stream, the re-attachment, the
 * projection — is the application's own.
 */

const PORT = 8798;
const long = new ScriptedInstance({ port: PORT, dataDirName: '.e2e-scripted-continuity' });
/** Same scenario, with a ceiling low enough to be reached inside a test. */
const shortLimit = new ScriptedInstance({
  port: PORT,
  dataDirName: '.e2e-scripted-continuity-limit',
  env: { APP_RUN_TIMEOUT_MS: '5000' },
});

const MARKER = 'WYNIK-KONCOWY-A';

async function openApp(page: Page, instance: ScriptedInstance) {
  await page.goto(`${instance.baseUrl}/`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${instance.baseUrl}/`);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

async function send(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

const urlConversation = (page: Page) => new URL(page.url()).searchParams.get('c');

const runsOf = (page: Page, conversationId: string) =>
  page.evaluate(
    async (id) =>
      (
        await (await fetch(`/api/conversations/${id}/runs`, { credentials: 'include' })).json()
      ).runs as Array<{ id: string; status: string }>,
    conversationId,
  );

/** Everything the assistant said in this conversation, from the backend. */
const answerText = (page: Page, conversationId: string) =>
  page.evaluate(async (id) => {
    const messages = (await (
      await fetch(`/api/threads/get/${id}`, { credentials: 'include' })
    ).json()) as Array<{ role: string; content: string }>;
    return messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('\n');
  }, conversationId);

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/**
 * Asks the backend directly, from the test process.
 *
 * Needed by the offline test: while the browser context has no network, nothing
 * the page does can answer "is the run still going", and asking the page would
 * only prove that the page cannot ask.
 */
async function backendRuns(
  instance: ScriptedInstance,
  conversationId: string,
): Promise<Array<{ id: string; status: string }>> {
  const login = await fetch(`${instance.baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const res = await fetch(`${instance.baseUrl}/api/conversations/${conversationId}/runs`, {
    headers: { cookie },
  });
  const body = (await res.json()) as { runs: Array<{ id: string; status: string }> };
  return body.runs;
}

test.describe('zadanie w tle przezywa odejscie obserwatora', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeEach(() => {
    long.prepareDatabase();
  });
  test.afterEach(async () => {
    await long.stop();
    await shortLimit.stop();
  });

  test('zamkniecie panelu nie przerywa zadania, a nowa karta pokazuje wynik', async ({
    page,
    context,
  }: {
    page: Page;
    context: BrowserContext;
  }) => {
    await long.start('bl09-continuity');
    await openApp(page, long);
    await send(page, 'Dlugie zadanie w tle.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    const conversation = urlConversation(page)!;

    // The panel is closed the only way a user really closes it: the tab goes.
    await page.close();
    expect(
      (await backendRuns(long, conversation))[0]?.status,
      'zamkniecie panelu zatrzymalo zadanie',
    ).toMatch(/queued|running/);

    const reopened = await context.newPage();
    await openApp(reopened, long);
    await reopened.goto(`${long.baseUrl}/?c=${conversation}`);
    await expect(reopened.locator('.openui-agent-thread-messages')).toContainText(MARKER, {
      timeout: 60_000,
    });
    const runs = await runsOf(reopened, conversation);
    expect(runs, 'zadanie uruchomilo sie drugi raz').toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    await reopened.close();
  });

  test('utrata sieci odlacza obserwacje, a zadanie trwa i wraca bez podwojenia', async ({
    page,
    context,
  }: {
    page: Page;
    context: BrowserContext;
  }) => {
    await long.start('bl09-continuity');
    await openApp(page, long);
    await send(page, 'Dlugie zadanie w tle.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    const conversation = urlConversation(page)!;

    /* --------------------------- the network goes -------------------------- */

    await context.setOffline(true);
    // Asked of the backend from outside the browser: the work is still the
    // backend's, whatever the tab can or cannot see.
    expect((await backendRuns(long, conversation))[0]?.status).toMatch(/queued|running/);

    // Long enough for the run to finish while nobody is listening.
    await new Promise((r) => setTimeout(r, 8000));
    expect((await backendRuns(long, conversation))[0]?.status).toBe('succeeded');

    /* -------------------------- and comes back ----------------------------- */

    await context.setOffline(false);
    await page.reload();
    await expect(page.locator('.openui-agent-thread-messages')).toContainText(MARKER, {
      timeout: 60_000,
    });

    const onScreen = (await page.locator('.openui-agent-thread-messages').innerText()) ?? '';
    expect(occurrences(onScreen, MARKER), 'odpowiedz pokazana dwa razy').toBe(1);
    expect(occurrences(await answerText(page, conversation), MARKER)).toBe(1);
    expect(await runsOf(page, conversation), 'zadanie uruchomilo sie drugi raz').toHaveLength(1);
  });

  test('przeladowanie w trakcie zadania dokancza odpowiedz bez jej podwojenia', async ({ page }) => {
    await long.start('bl09-continuity');
    await openApp(page, long);
    await send(page, 'Dlugie zadanie w tle.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    const conversation = urlConversation(page)!;

    // Reload while the run is mid-flight: the send path's stream dies with the
    // page and the re-attachment becomes the only consumer.
    await page.reload();
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });
    await expect(page.locator('.openui-agent-thread-messages')).toContainText(MARKER, {
      timeout: 30_000,
    });

    const onScreen = await page.locator('.openui-agent-thread-messages').innerText();
    expect(occurrences(onScreen, MARKER), 'tekst odpowiedzi zostal podwojony').toBe(1);
    expect(occurrences(await answerText(page, conversation), MARKER)).toBe(1);
    expect(await runsOf(page, conversation)).toHaveLength(1);
  });

  test('twardy limit czasu konczy zadanie bez Stop i mowi o tym w rozmowie', async ({ page }) => {
    shortLimit.prepareDatabase();
    await shortLimit.start('bl09-timeout');
    await openApp(page, shortLimit);
    await send(page, 'Zadanie bez konca.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    const conversation = urlConversation(page)!;

    /*
     * Nobody presses Stop. The run ends anyway, because the platform has a
     * documented ceiling — which is exactly why it is documented: "only an
     * explicit cancellation stops a run" would otherwise be false in a way a
     * user could not find out.
     */
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'failed', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('run-error')).toBeVisible();

    const runs = await runsOf(page, conversation);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
    // Not a cancellation: the taxonomy has to keep the two apart.
    expect(await answerText(page, conversation)).not.toContain('NIE-POWINNO-DOJSC');
  });
});
