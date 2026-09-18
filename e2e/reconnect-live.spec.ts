import { expect, test } from './support/fixtures.ts';
import { CuttableProxy } from './support/cuttable-proxy.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { CONSENT_ARTIFACT_TITLE, EARLY_MARKER, LATE_MARKER } from './support/bl08b-scenarios.ts';
import { type BrowserContext, type Page } from '@playwright/test';

/**
 * L5.6 / L5.14 — coming back to a run that is **still going**.
 *
 * `e2e/run-continuity.spec.ts` (BL-09) proved the neighbouring case: the run
 * ends while nobody is connected, and the client re-attaches to a resolved run
 * whose replay comes from the persisted log. This file is the other half, and
 * it is a different code path with different hazards — the client re-attaches
 * to a **live** stream (`runtime.liveStream`), which is where a command may
 * still be waiting for an answer and a question may already have been answered.
 *
 * Three things must hold when the client returns, and each used to be unproven
 * in a browser:
 *
 *  1. the rest of the answer arrives, and the part already seen is not repeated;
 *  2. an interface command performed before the interruption is not performed
 *     a second time;
 *  3. a consent question already answered does not come back on screen — and
 *     that one needed an event that did not exist (`platform.permission_resolved`),
 *     because nothing in the log said the question had been settled.
 *
 * The network is cut with {@link CuttableProxy}, not with `setOffline` alone:
 * an offline context does not tear down an already-established stream, so a
 * test built on it would pass without ever losing what it claims to lose.
 *
 * **Simulation, marked as such**: the model is scripted at the adapter
 * boundary; the run registry, the stream, the cursor, the consent gate and the
 * re-attachment are the application's own.
 */

const PORT = 8798;
const PROXY_PORT = 8797;
const scripted = new ScriptedInstance({ port: PORT, dataDirName: '.e2e-scripted-reconnect' });

async function openApp(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${baseUrl}/`);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

async function send(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

const urlConversation = (page: Page) => new URL(page.url()).searchParams.get('c');

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const onScreen = (page: Page) => page.locator('.openui-agent-thread-messages').innerText();

const runsOf = (page: Page, conversationId: string) =>
  page.evaluate(
    async (id) =>
      (
        await (await fetch(`/api/conversations/${id}/runs`, { credentials: 'include' })).json()
      ).runs as Array<{ id: string; status: string }>,
    conversationId,
  );

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

const artifactTitles = (page: Page) =>
  page.evaluate(
    async () =>
      (
        await (await fetch('/api/artifacts', { credentials: 'include' })).json()
      ).artifacts.map((a: { title: string }) => a.title) as string[],
  );

/**
 * Asks the backend from the test process.
 *
 * Needed while the browser has no network: anything the page could answer then
 * is a statement about the page, not about the run.
 */
async function backendRuns(conversationId: string): Promise<Array<{ id: string; status: string }>> {
  const login = await fetch(`${scripted.baseUrl}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const res = await fetch(`${scripted.baseUrl}/api/conversations/${conversationId}/runs`, {
    headers: { cookie },
  });
  return ((await res.json()) as { runs: Array<{ id: string; status: string }> }).runs;
}

test.describe('powrot do trwajacego wykonania', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeEach(() => {
    scripted.prepareDatabase();
  });
  test.afterEach(async () => {
    await scripted.stop();
  });

  /* ====================================================================== */
  /*  L5.6 — the rest of the answer, once, on a run that never stopped      */
  /* ====================================================================== */

  test('L5.6: klient wraca do wykonania, ktore wciaz trwa, i dostaje reszte odpowiedzi bez podwojenia', async ({
    page,
    context,
  }: {
    page: Page;
    context: BrowserContext;
  }) => {
    await scripted.start('bl08b-live-reconnect');
    const proxy = new CuttableProxy(PROXY_PORT, scripted.baseUrl);
    await proxy.start();
    try {
      await openApp(page, proxy.baseUrl);
      await send(page, 'Dlugie zadanie w tle.');
      await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
        timeout: 30_000,
      });
      const conversation = urlConversation(page)!;
      // Part of the answer has arrived, so there is something that could be
      // repeated when the client comes back.
      await expect(page.getByTestId('streaming-answer')).toContainText(EARLY_MARKER, {
        timeout: 30_000,
      });

      /* --------------------------- the wire is cut ------------------------- */

      proxy.cut();
      await context.setOffline(true);
      const reachable = await page.evaluate(async () => {
        try {
          return (await fetch('/api/health', { cache: 'no-store' })).ok;
        } catch {
          return false;
        }
      });
      expect(reachable, 'siec nie zostala zerwana').toBe(false);
      await page.waitForTimeout(2500);

      /* ------------------------- and comes back, mid-run ------------------- */

      /*
       * The distinguishing fact of this file: the run is **still active** when
       * the client returns. BL-09's test covers the resolved case; this one
       * re-attaches to a live stream, and a stale or overshooting cursor shows
       * up here as a repeated or missing sentence rather than as an error.
       */
      const atReturn = (await backendRuns(conversation))[0]!;
      expect(atReturn.status, 'wykonanie zakonczylo sie, zanim klient wrocil').toMatch(
        /queued|running/,
      );
      expect(occurrences(await onScreen(page), LATE_MARKER), 'koniec dotarl mimo zerwanej sieci').toBe(0);

      proxy.restore();
      await context.setOffline(false);

      // No reload: the client recovers on its own.
      await expect(page.locator('.openui-agent-thread-messages')).toContainText(LATE_MARKER, {
        timeout: 60_000,
      });

      const text = await onScreen(page);
      expect(occurrences(text, LATE_MARKER), 'koniec odpowiedzi pokazany dwa razy').toBe(1);
      expect(occurrences(text, EARLY_MARKER), 'poczatek odpowiedzi pokazany dwa razy').toBe(1);
      const stored = await answerText(page, conversation);
      expect(occurrences(stored, EARLY_MARKER)).toBe(1);
      expect(occurrences(stored, LATE_MARKER)).toBe(1);
      const runs = await runsOf(page, conversation);
      expect(runs, 'zadanie uruchomilo sie drugi raz').toHaveLength(1);
      expect(runs[0]!.status).toBe('succeeded');
    } finally {
      await proxy.stop();
    }
  });

  /* ====================================================================== */
  /*  L5.6 — an interface command is not performed twice                    */
  /* ====================================================================== */

  test('L5.6: polecenie interfejsu wykonane przed zerwaniem nie powtarza sie po powrocie', async ({
    page,
    context,
  }: {
    page: Page;
    context: BrowserContext;
  }) => {
    await scripted.start('bl08b-live-reconnect');
    const proxy = new CuttableProxy(PROXY_PORT, scripted.baseUrl);
    await proxy.start();
    try {
      await openApp(page, proxy.baseUrl);
      await send(page, 'Otworz pliki i pracuj dalej — nawigacja.');

      // The agent moves the screen while the client is watching and acknowledges.
      await expect(page.getByTestId('files-page')).toBeVisible({ timeout: 60_000 });
      const conversation = urlConversation(page)!;

      // The user goes somewhere else, still inside the run.
      await page.getByRole('link', { name: 'Ustawienia' }).click();
      await expect(page.getByTestId('settings-page')).toBeVisible();
      const parked = new URL(page.url()).pathname;

      proxy.cut();
      await context.setOffline(true);
      await page.waitForTimeout(2500);
      expect((await backendRuns(conversation))[0]!.status).toMatch(/queued|running/);

      proxy.restore();
      await context.setOffline(false);

      await expect(page.locator('.openui-agent-thread-messages')).toContainText(LATE_MARKER, {
        timeout: 60_000,
      });

      // The outcome first: the screen the user chose is the screen they kept.
      expect(new URL(page.url()).pathname, 'nawigacja agenta powtorzyla sie po powrocie').toBe(parked);
      await expect(page.getByTestId('settings-page')).toBeVisible();
      await expect(page.getByTestId('files-page')).toHaveCount(0);
      // And the command really was performed once, by this client.
      const runId = (await runsOf(page, conversation))[0]!.id;
      const commands = await page.evaluate(async (id) => {
        const { events } = (await (
          await fetch(`/api/runs/${id}/events`, { credentials: 'include' })
        ).json()) as { events: Array<{ payload: { name?: string } }> };
        return events.filter((e) => e.payload?.name === 'platform.ui_command').length;
      }, runId);
      expect(commands, 'agent poprosil o nawigacje wiecej niz raz').toBe(1);
    } finally {
      await proxy.stop();
    }
  });

  /* ====================================================================== */
  /*  L5.6 / L5.14 — a settled question does not come back                  */
  /* ====================================================================== */

  test('L5.14: prosba o zgode rozstrzygnieta przed przeladowaniem nie wraca na ekran', async ({ page }) => {
    await scripted.start('bl08b-consent-then-work');
    await openApp(page, scripted.baseUrl);
    await send(page, 'Przetworz dane w sandboxie.');

    const prompt = page.getByTestId('permission-prompt');
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'awaiting_consent');
    await prompt.getByRole('button', { name: 'Zgoda' }).click();

    // Approved, and the run carries on working for a while — which is what makes
    // the reload land on a run that is still open.
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    const conversation = urlConversation(page)!;

    await page.reload();
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

    /*
     * The page re-attaches from zero — a reload loses the cursor — so the whole
     * log is replayed, question included. Without `platform.permission_resolved`
     * the replay put the prompt back on screen and left the phase at
     * `awaiting_consent` for the rest of the run: a question already answered,
     * offered again, and answering it did nothing at all because the gate had
     * long since resolved.
     *
     * The phase is the assertion that carries the weight. The prompt's absence
     * could be a race with the replay; a phase that is `running` while the run
     * is working cannot be, because nothing but the resolution event moves it
     * back from `awaiting_consent`.
     */
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    const watched: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      watched.push(
        `${await page.getByTestId('run-state').getAttribute('data-phase')}:${await prompt.count()}`,
      );
      await page.waitForTimeout(120);
    }
    expect(
      watched.filter((s) => s.startsWith('awaiting_consent') || s.endsWith(':1')),
      `obserwacje po przeladowaniu: ${watched.join(' ')}`,
    ).toEqual([]);

    // The run finishes, and the approved operation ran exactly once.
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });
    expect(await answerText(page, conversation)).toContain('KONIEC-PO-ZGODZIE');
    const titles = await artifactTitles(page);
    expect(titles.filter((t) => t === CONSENT_ARTIFACT_TITLE), 'operacja wykonala sie dwa razy').toHaveLength(1);
    expect(await runsOf(page, conversation)).toHaveLength(1);
  });

  /* ====================================================================== */
  /*  L5.14 — a run interrupted by a restart has one ending, not none       */
  /* ====================================================================== */

  test('L5.14: wykonanie przerwane restartem backendu konczy sie jednoznacznie, bez utkniecia w ladowaniu', async ({
    page,
  }) => {
    await scripted.start('bl08b-live-reconnect');
    await openApp(page, scripted.baseUrl);
    await send(page, 'Dlugie zadanie w tle.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('streaming-answer')).toContainText(EARLY_MARKER, { timeout: 30_000 });
    const conversation = urlConversation(page)!;

    // The process that owned the run goes away and comes back. Nothing resumes:
    // `reconcileOnBoot` closes what it cannot continue, with a reason.
    await scripted.restart('bl08b-live-reconnect');
    await page.reload();
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

    const runs = await runsOf(page, conversation);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status, 'restart udawal kontynuacje').toBe('failed');

    /*
     * And the interface does not sit in a state the backend has left. Asserted
     * as the absence of *that* state over a window rather than as the presence
     * of a particular wording, which is the shell's and has changed before.
     */
    for (let i = 0; i < 15; i += 1) {
      await expect(page.locator('[data-testid="run-state"][data-phase="running"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="run-state"][data-phase="queued"]')).toHaveCount(0);
      await page.waitForTimeout(120);
    }
    // What the run managed to say is still there — an interrupted run keeps its
    // partial answer rather than losing it with the process.
    expect(await answerText(page, conversation)).toContain(EARLY_MARKER);
    expect(await answerText(page, conversation)).not.toContain(LATE_MARKER);
    // The composer works again: the conversation is usable, not blocked.
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeEnabled();
  });
});
