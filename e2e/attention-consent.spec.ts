import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * L11.19 — decyzja o pracy w tle, gdy nikt nie patrzy na rozmowę źródłową.
 *
 * Run zaparkowany na bramce zgody jest już widoczny w centrum zadań
 * (`pendingPermission`) i sygnalizowany na liście zadań w tle; tego dowodu nie
 * powtarzamy. Czego brakowało, to trzy rzeczy **wokół** tego stanu:
 *
 *  - formularz decyzji **w centrum zadań** — odpowiedź tam, gdzie zadanie jest
 *    obsługiwane, bez wchodzenia do rozmowy źródłowej;
 *  - trwała plakietka liczby zadań czekających na decyzję przy wejściu
 *    „Centrum zadań” — liczona z danych backendu, więc przetrwa reload;
 *  - jednorazowy, nieinwazyjny komunikat o czekającym zadaniu — tylko na
 *    zaobserwowanym przejściu do `awaiting_consent`, tylko dla runu **innej**
 *    rozmowy niż aktywna (w aktywnej swoje robi PermissionPrompt), tylko raz na
 *    run w życiu strony, z przejściem do centrum bez ruszania aktywnej rozmowy.
 *
 * **Symulacja na granicy modelu, jak w `consent-runs.spec.ts`.** Scenariusz
 * `bl13-attention` woła prawdziwą bramkę `canUseTool`, więc prośba, zapis
 * `awaiting_consent`, zdarzenie `platform.permission_request` i skutek decyzji
 * są własnością aplikacji. Żaden test tu nie wydaje tury modelu.
 */

const PORT = 8798;
const attention = new ScriptedInstance({ port: PORT, dataDirName: '.e2e-scripted-attention' });

const POLECENIE = 'Przetworz dane w sandboxie.';

async function openApp(page: Page, path = '/') {
  await page.goto(`${attention.baseUrl}${path}`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${attention.baseUrl}${path}`);
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

/** The one run this suite keeps parked at the gate, with a fresh database per test. */
const awaitingRunOf = async (page: Page, conversationId: string) => {
  const found = (await activeRuns(page)).find((r) => r.conversationId === conversationId);
  expect(found, 'run tej rozmowy ma czekac na decyzje').toBeTruthy();
  return found!;
};

const artifactCount = (page: Page) =>
  page.evaluate(
    async () =>
      (
        await (await fetch('/api/artifacts', { credentials: 'include' })).json()
      ).artifacts.length as number,
  );

/** Status of one run, asked of the conversation's own registry. */
const statusOfRun = (page: Page, conversationId: string, runId: string) =>
  page.evaluate(
    async ([cid, rid]) => {
      const { runs } = (await (
        await fetch(`/api/conversations/${cid}/runs`, { credentials: 'include' })
      ).json()) as { runs: Array<{ id: string; status: string }> };
      return runs.find((r) => r.id === rid)?.status ?? null;
    },
    [conversationId, runId] as const,
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

test.describe('zadanie czekajace na decyzje: centrum, plakietka, toast (L11.19)', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  /* Czysta baza przed każdym testem: licznik artefaktów jest dowodem "bez
     skutku" tylko wtedy, gdy nic z poprzedniego testu w nim nie leży. */
  test.beforeEach(() => {
    attention.prepareDatabase();
  });
  test.afterEach(async () => {
    await attention.stop();
  });

  test('toast i plakietka po odejsciu od rozmowy, formularz i odmowa w centrum', async ({ page }) => {
    await attention.start('bl13-attention');
    await openApp(page);
    expect(await artifactCount(page)).toBe(0);

    await send(page, POLECENIE);
    await expect(page.getByTestId('permission-prompt')).toBeVisible({ timeout: 30_000 });
    const conversationA = urlConversation(page)!;
    const runA = await awaitingRunOf(page, conversationA);

    /* (a) The user walks away to another conversation. The run's step into
       `awaiting_consent` was observed while it was still the active
       conversation's own — announced only once it belongs to a conversation
       nobody is reading. */
    await startNewConversation(page);
    /* The new conversation starts as a draft: the address carries no `c` yet.
       The run below now belongs to a conversation nobody is reading. */
    const toast = page.getByTestId('attention-toast');
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(toast).toContainText(POLECENIE);

    const badge = page.getByTestId('tasks-attention-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-count', '1');

    /* (b) One notice per run: closing the notice ends it. Two poll-scan
       re-runs follow while the task still waits — sending from the draft
       persists it (the address gains `c`), and the new run parks at the gate
       a few seconds later (the badge counts both). A re-announcing toast
       would be back within seconds of the dismissal, so absence is checked
       continuously across both windows; a single instant check would race
       exactly the transient this criterion forbids. */
    /* From here on, every appearance of the toast is recorded page-side, by
       a mutation observer — even a sub-second re-announcement between two
       checks would leave a mark. The dismissal instant is the boundary. */
    await page.evaluate(() => {
      (window as unknown as { __toastSeen: number[] }).__toastSeen = [];
      const seen = (window as unknown as { __toastSeen: number[] }).__toastSeen;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="attention-toast"]')) seen.push(Date.now());
      }).observe(document.body, { childList: true, subtree: true });
    });
    const zamkniecie = Date.now();
    await toast.getByTestId('attention-toast-close').click();
    await send(page, POLECENIE);
    const conversationB = urlConversation(page)!;
    await expect(badge).toHaveAttribute('data-count', '2', { timeout: 20_000 });

    /* (c) On to the task center, from the navigation entry — the notice has
       already been used up, and the toast's own action is covered in the third
       test. Leaving for the center changes nothing about the active
       conversation. */
    await page.getByRole('link', { name: 'Centrum zadań' }).click();
    await expect(page.getByTestId('task-center')).toBeVisible();
    expect(urlConversation(page), 'przejście do centrum nie zmienia aktywnej rozmowy').toBe(
      conversationB,
    );

    const form = page.getByTestId(`task-consent-form-${runA.id}`);
    await expect(form).toBeVisible();
    await expect(page.getByTestId(`task-consent-tool-${runA.id}`)).toContainText('Bash');
    await expect(page.getByTestId(`task-consent-input-${runA.id}`)).toContainText(
      'node przetworz.mjs',
    );

    await page.getByTestId(`task-consent-deny-${runA.id}`).click();
    /* The first task is resolved by the denial; the second one, asked from the
       conversation the user is reading, is still parked at the gate. */
    await expect.poll(async () => (await activeRuns(page)).length, { timeout: 30_000 }).toBe(1);
    expect(await artifactCount(page), 'odmowa z centrum mimo wszystko wykonala operacje').toBe(0);
    await expect(page.getByTestId(`task-status-${runA.id}`)).toHaveAttribute('data-status', 'succeeded');
    await expect(badge).toHaveAttribute('data-count', '1');
    await expect(page.getByTestId('attention-toast')).toHaveCount(0);
    const poZamknieciu: number[] = await page.evaluate(
      () => (window as unknown as { __toastSeen: number[] }).__toastSeen,
    );
    expect(
      poZamknieciu.filter((t) => t > zamkniecie),
      'toast nie wraca po zamknieciu — zadne ponowne ogloszenie tego samego czekania',
    ).toEqual([]);
  });

  test('przeladowanie w trakcie oczekiwania: plakietka trwa, toast sie nie pojawia, rozmowa zrodlowa ma zdarzenie proby', async ({
    page,
  }) => {
    await attention.start('bl13-attention');
    await openApp(page);
    await send(page, POLECENIE);
    await expect(page.getByTestId('permission-prompt')).toBeVisible({ timeout: 30_000 });
    const conversationA = urlConversation(page)!;
    const runA = await awaitingRunOf(page, conversationA);

    await startNewConversation(page);
    /* A toast may announce the waiting task; the page then goes away entirely. */
    await page.reload();
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

    /* The badge is the backend's fact, so it survives the reload. */
    const badge = page.getByTestId('tasks-attention-badge');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toHaveAttribute('data-count', '1');

    /* A freshly loaded page never saw the run in another status, so there is
       no observed transition and no toast — checked across more than one
       polling interval, not at a single lucky instant. */
    await page.waitForTimeout(7_000);
    await expect(page.getByTestId('attention-toast')).toHaveCount(0);
    await expect(badge).toHaveAttribute('data-count', '1');

    /* Back to the source conversation: the question is still there, and the
       conversation's own log holds the request as an event. */
    await page.getByTestId('background-tasks-toggle').click();
    await page.getByTestId(`background-task-open-${conversationA}`).click();
    await expect(page.getByTestId('permission-prompt')).toBeVisible({ timeout: 20_000 });

    const request = await permissionRequestOf(page, runA.id);
    expect(request?.toolName).toBe('Bash');
    expect(request?.requestId, 'zdarzenie proby zapisane w rozmowie zrodlowej').toBeTruthy();
  });

  test('zgoda z centrum zadan wykonuje operacje dokladnie raz', async ({ page }) => {
    await attention.start('bl13-attention');
    await openApp(page);
    expect(await artifactCount(page)).toBe(0);

    await send(page, POLECENIE);
    await expect(page.getByTestId('permission-prompt')).toBeVisible({ timeout: 30_000 });
    const conversationA = urlConversation(page)!;
    const runA = await awaitingRunOf(page, conversationA);

    await startNewConversation(page);
    const conversationB = urlConversation(page)!;
    await expect(page.getByTestId('attention-toast')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('attention-toast-open').click();
    await expect(page.getByTestId('task-center')).toBeVisible();
    expect(urlConversation(page), 'akcja toastu nie zmienia aktywnej rozmowy').toBe(conversationB);

    await page.getByTestId(`task-consent-allow-${runA.id}`).click();
    await expect.poll(async () => (await activeRuns(page)).length, { timeout: 30_000 }).toBe(0);
    expect(await artifactCount(page), 'zgoda z centrum miala wykonac operacje dokladnie raz').toBe(1);
    await expect(page.getByTestId('tasks-attention-badge')).toHaveCount(0);
    await expect.poll(async () => statusOfRun(page, conversationA, runA.id), { timeout: 30_000 }).toBe(
      'succeeded',
    );
    await expect(page.getByTestId(`task-status-${runA.id}`)).toHaveAttribute('data-status', 'succeeded');
  });
});
