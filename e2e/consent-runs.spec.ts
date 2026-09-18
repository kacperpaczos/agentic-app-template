import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * A decision waiting for the user, proved in the browser.
 *
 * The success path — a prompt appears, the user clicks Zgoda, the work happens —
 * was already covered by a run on the real model. Everything *around* it was
 * not, and that is where the defects were: a refusal with no proof of absence,
 * a repeated answer, an answer carrying another run's request id, and a question
 * nobody ever sees because the panel is showing a different conversation.
 *
 * **Simulation at the model boundary, marked as such.** The scripted stand-in
 * calls the runtime's real `canUseTool`, so the request, the wait, the HTTP
 * answer, the stored `awaiting_consent` status and the effect of the decision
 * are all the application's own. No model turn is spent.
 */

const PORT = 8798;
const consent = new ScriptedInstance({ port: PORT, dataDirName: '.e2e-scripted-consent' });
/** Same scenario, but a question expires in seconds rather than in two minutes. */
const expiring = new ScriptedInstance({
  port: PORT,
  dataDirName: '.e2e-scripted-consent-expiry',
  env: { APP_CONSENT_TIMEOUT_MS: '4000' },
});

async function openApp(page: Page, instance: ScriptedInstance, path = '/') {
  await page.goto(`${instance.baseUrl}${path}`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${instance.baseUrl}${path}`);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

async function send(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

const urlConversation = (page: Page) => new URL(page.url()).searchParams.get('c');

const startNewConversation = (page: Page) =>
  page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();

/** What the backend says is in flight, asked of the backend. */
const activeRuns = (page: Page) =>
  page.evaluate(
    async () =>
      (
        await (await fetch('/api/runs/active', { credentials: 'include' })).json()
      ).runs as Array<{ id: string; conversationId: string; status: string }>,
  );

const artifactCount = (page: Page) =>
  page.evaluate(
    async () =>
      (
        await (await fetch('/api/artifacts', { credentials: 'include' })).json()
      ).artifacts.length as number,
  );

const runsOf = (page: Page, conversationId: string) =>
  page.evaluate(
    async (id) =>
      (
        await (await fetch(`/api/conversations/${id}/runs`, { credentials: 'include' })).json()
      ).runs as Array<{ id: string; status: string }>,
    conversationId,
  );

/** The permission request one run emitted, read from its own event log. */
const permissionRequestOf = (page: Page, runId: string) =>
  page.evaluate(async (id) => {
    const { events } = (await (
      await fetch(`/api/runs/${id}/events`, { credentials: 'include' })
    ).json()) as { events: Array<{ payload: { name?: string; value?: Record<string, unknown> } }> };
    const found = events.find((e) => e.payload?.name === 'platform.permission_request');
    return (found?.payload.value ?? null) as { requestId: string; toolName: string } | null;
  }, runId);

const answerPermission = (page: Page, runId: string, requestId: string, allow: boolean) =>
  page.evaluate(
    async ([id, request, decision]) => {
      const res = await fetch(`/api/runs/${id}/permission`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: request, allow: decision === '1' }),
      });
      return { status: res.status, body: (await res.json()) as { answered?: boolean } };
    },
    [runId, requestId, allow ? '1' : '0'] as const,
  );

test.describe('zgoda i odmowa w przegladarce', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  /*
   * A fresh database per test, not per file: these tests count artifacts, and
   * "nothing was published" is only an assertion if the previous test's result
   * is not still sitting in the store.
   */
  test.beforeEach(() => {
    consent.prepareDatabase();
  });
  test.afterEach(async () => {
    await consent.stop();
    await expiring.stop();
  });

  test('odmowa nie wykonuje operacji', async ({ page }) => {
    await consent.start('bl09-consent');
    await openApp(page, consent);
    expect(await artifactCount(page)).toBe(0);

    await send(page, 'Przetworz dane w sandboxie.');

    const prompt = page.getByTestId('permission-prompt');
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    // The run says out loud that it is waiting, and for what.
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'awaiting_consent');
    await prompt.getByRole('button', { name: 'Odmowa' }).click();

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 30_000,
    });
    /*
     * The assertion this whole test exists for: a refusal leaves the operation
     * undone. Nothing was published — not in the conversation, not in the store.
     */
    await expect(page.getByTestId('artifact-preview')).toHaveCount(0);
    expect(await artifactCount(page), 'odmowa mimo wszystko wykonala operacje').toBe(0);
  });

  test('zgoda wykonuje operacje raz, a powtorzona odpowiedz nie wykonuje jej drugi raz', async ({
    page,
  }) => {
    await consent.start('bl09-consent');
    await openApp(page, consent);
    await send(page, 'Przetworz dane w sandboxie.');

    const prompt = page.getByTestId('permission-prompt');
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    const runId = await page.getByTestId('run-state').getAttribute('data-run-id');
    expect(runId).toBeTruthy();
    const request = await permissionRequestOf(page, runId!);
    expect(request?.toolName).toBe('Bash');

    await prompt.getByRole('button', { name: 'Zgoda' }).click();
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('artifact-preview')).toHaveCount(1);
    expect(await artifactCount(page)).toBe(1);

    // The answer sent twice — a double click, a retried request, a client
    // reconnecting and re-posting what it still had.
    const repeat = await answerPermission(page, runId!, request!.requestId, true);
    expect(repeat.status).toBe(200);
    expect(repeat.body.answered, 'powtorzona odpowiedz zostala przyjeta').toBe(false);
    await page.reload();
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    expect(await artifactCount(page), 'operacja wykonala sie drugi raz').toBe(1);
  });

  test('odpowiedz z requestId innego uruchomienia nie rozstrzyga prosby', async ({ page }) => {
    await consent.start('bl09-consent');
    await openApp(page, consent);

    await send(page, 'Przetworz dane w sandboxie — rozmowa A.');
    await expect(page.getByTestId('permission-prompt')).toBeVisible({ timeout: 30_000 });
    const conversationA = urlConversation(page)!;
    const runA = (await runsOf(page, conversationA))[0]!.id;

    await startNewConversation(page);
    await send(page, 'Przetworz dane w sandboxie — rozmowa B.');
    await expect(page.getByTestId('permission-prompt')).toBeVisible({ timeout: 30_000 });
    const conversationB = urlConversation(page)!;
    const runB = (await runsOf(page, conversationB))[0]!.id;
    expect(runB).not.toBe(runA);

    const requestA = await permissionRequestOf(page, runA);
    const requestB = await permissionRequestOf(page, runB);
    expect(requestA!.requestId).not.toBe(requestB!.requestId);

    // A's address, B's question: decides nothing, and B keeps waiting.
    const crossed = await answerPermission(page, runA, requestB!.requestId, true);
    expect(crossed.body.answered, 'zgoda przypisala sie do innego uruchomienia').toBe(false);
    await expect
      .poll(async () => (await activeRuns(page)).find((r) => r.id === runB)?.status)
      .toBe('awaiting_consent');
    expect(await artifactCount(page)).toBe(0);

    // Answering each in its own place works, and each decides only its own.
    expect((await answerPermission(page, runA, requestA!.requestId, false)).body.answered).toBe(true);
    expect((await answerPermission(page, runB, requestB!.requestId, true)).body.answered).toBe(true);
    await expect.poll(async () => (await activeRuns(page)).length, { timeout: 30_000 }).toBe(0);
    // Exactly one of the two ran its operation: the one that was allowed.
    expect(await artifactCount(page)).toBe(1);
  });

  test('zadanie z nieogladanej rozmowy sygnalizuje, ze czeka na decyzje', async ({ page }) => {
    await consent.start('bl09-consent');
    await openApp(page, consent);

    await send(page, 'Przetworz dane w sandboxie.');
    await expect(page.getByTestId('permission-prompt')).toBeVisible({ timeout: 30_000 });
    const conversation = urlConversation(page)!;

    // The user walks away to another conversation; the question does not vanish.
    await startNewConversation(page);
    await expect(page.getByTestId('permission-prompt')).toHaveCount(0);

    const tasks = page.getByTestId('background-tasks');
    await expect(tasks).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('background-tasks-toggle').click();
    const item = page.getByTestId('background-tasks-list').locator(`li[data-conversation="${conversation}"]`);
    await expect(item).toBeVisible();
    // The signal itself: a phase, not wording.
    await expect(item.locator('.pf-tasks__phase')).toHaveAttribute('data-phase', 'awaiting_consent');

    /*
     * And the status is the backend's, not this tab's memory: a client that
     * reloads — or one that was never here — asks `/api/runs/active` and is told
     * the same thing.
     */
    await page.reload();
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    await expect
      .poll(async () => (await activeRuns(page)).map((r) => r.status), { timeout: 20_000 })
      .toEqual(['awaiting_consent']);

    // Going back to the conversation shows the question again, and it is answerable.
    await page.getByTestId('background-tasks-toggle').click();
    await page.getByTestId(`background-task-open-${conversation}`).click();
    const prompt = page.getByTestId('permission-prompt');
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await prompt.getByRole('button', { name: 'Odmowa' }).click();
    await expect.poll(async () => (await activeRuns(page)).length, { timeout: 30_000 }).toBe(0);
    expect(await artifactCount(page)).toBe(0);
  });

  test('brak odpowiedzi przy zamknietym panelu konczy sie odmowa, nie zgoda', async ({ page, context }) => {
    expiring.prepareDatabase();
    await expiring.start('bl09-consent');
    await openApp(page, expiring);

    await send(page, 'Przetworz dane w sandboxie.');
    await expect(page.getByTestId('permission-prompt')).toBeVisible({ timeout: 30_000 });
    const conversation = urlConversation(page)!;

    /*
     * The panel is closed — the tab is gone entirely — while a question is open.
     * Nobody can answer it, and the documented termination condition takes over:
     * an unanswered request expires as a **refusal**.
     */
    await page.close();
    const reopened = await context.newPage();
    await openApp(reopened, expiring);

    await expect
      .poll(async () => (await runsOf(reopened, conversation))[0]?.status, { timeout: 30_000 })
      .toMatch(/succeeded|failed/);
    expect(await artifactCount(reopened), 'wygasla prosba zadzialala jak zgoda').toBe(0);
    expect(await activeRuns(reopened)).toHaveLength(0);
    await reopened.close();
  });
});
