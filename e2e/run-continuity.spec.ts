import { expect, test } from './support/fixtures.ts';
import { CuttableProxy } from './support/cuttable-proxy.ts';
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
/** The browser reaches the instance through this, so the wire can be cut. */
const PROXY_PORT = 8796;

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
    await openApp(page, long.baseUrl);
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
    await openApp(reopened, long.baseUrl);
    await reopened.goto(`${long.baseUrl}/?c=${conversation}`);
    await expect(reopened.locator('.openui-agent-thread-messages')).toContainText(MARKER, {
      timeout: 60_000,
    });
    const runs = await runsOf(reopened, conversation);
    expect(runs, 'zadanie uruchomilo sie drugi raz').toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    await reopened.close();
  });

  /**
   * The network really goes away, and the connection really dies.
   *
   * The browser talks to the application through {@link CuttableProxy}, because
   * `setOffline(true)` alone does **not** tear down an established stream: a
   * review measured a run's event stream still receiving chunks and its terminal
   * event after the context had been switched offline, which would have made a
   * test written on it pass for a reason it does not state. Cutting the proxy
   * destroys the live connection; `setOffline` is kept alongside only for what it
   * does do honestly — report the outage to the page and fire the `offline` and
   * `online` events a real outage fires.
   *
   * **What the cut is, precisely.** It severs the browser↔proxy side: the page's
   * connections die and new ones are refused. The proxy's own socket to the
   * application stays open, so this is "the browser lost the network", not "the
   * server lost its client" — the server-side half is the panel-close test
   * above, where the page really goes away.
   *
   * The run finishes **during** the outage, so the client comes back to a run the
   * backend no longer lists as active: the case that had no route back to the
   * answer at all.
   */
  test('utrata sieci zrywa polaczenie przegladarki, zadanie konczy sie bez niej, a klient wraca do wyniku', async ({
    page,
    context,
  }: {
    page: Page;
    context: BrowserContext;
  }) => {
    await long.start('bl09-continuity');
    const proxy = new CuttableProxy(PROXY_PORT, long.baseUrl);
    await proxy.start();
    try {
      await openApp(page, proxy.baseUrl);
      await send(page, 'Dlugie zadanie w tle.');
      await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
        timeout: 30_000,
      });
      const conversation = urlConversation(page)!;
      // Something has arrived on the stream, so there is a live connection to lose.
      await expect(page.getByTestId('streaming-answer')).toContainText('Zaczynam prace', {
        timeout: 30_000,
      });

      /* --------------------------- the wire is cut -------------------------- */

      proxy.cut();
      await context.setOffline(true);

      /*
       * The page cannot reach the application. Worth naming honestly: switching
       * the context offline would satisfy this on its own, so this assertion is
       * a guard on the setup, not the evidence. The weight is carried by the two
       * assertions below it — the run finishes while the page is cut off, and
       * **the marker does not appear on screen** in that time.
       */
      const reachable = await page.evaluate(async () => {
        try {
          return (await fetch('/api/health', { cache: 'no-store' })).ok;
        } catch {
          return false;
        }
      });
      expect(reachable, 'siec nie zostala zerwana — strona nadal siega serwera').toBe(false);

      // Asked of the backend from outside the browser: the work is still the
      // backend's, whatever the tab can or cannot see.
      expect((await backendRuns(long, conversation))[0]?.status).toMatch(/queued|running/);

      // The run finishes while nobody is listening at all.
      await expect
        .poll(async () => (await backendRuns(long, conversation))[0]?.status, { timeout: 30_000 })
        .toBe('succeeded');
      // And its answer never reached the page while it was cut off.
      expect(
        occurrences(await page.locator('.openui-agent-thread-messages').innerText(), MARKER),
        'wynik pojawil sie na ekranie mimo zerwanej sieci',
      ).toBe(0);

      /* -------------------------- and comes back ----------------------------- */

      proxy.restore();
      await context.setOffline(false);

      /*
       * **No reload.** The client recovers by itself: mounting and switching
       * conversation — the other two moments that re-sync — do not happen when a
       * laptop simply wakes up, and the run it was following is no longer in
       * `GET /api/runs/active`, because it has already finished.
       */
      await expect(page.locator('.openui-agent-thread-messages')).toContainText(MARKER, {
        timeout: 60_000,
      });

      const onScreen = await page.locator('.openui-agent-thread-messages').innerText();
      expect(occurrences(onScreen, MARKER), 'odpowiedz pokazana dwa razy').toBe(1);
      expect(occurrences(await answerText(page, conversation), MARKER)).toBe(1);
      expect(await runsOf(page, conversation), 'zadanie uruchomilo sie drugi raz').toHaveLength(1);
    } finally {
      await proxy.stop();
    }
  });

  /**
   * Coming back must bring the **answer**, not the agent's old navigation.
   *
   * The run moves the screen while the client is watching, the client then goes
   * its own way, and the network dies. Three things now stand between the replay
   * and a screen that jumps back minutes later, and this test is about their
   * combined effect rather than any one of them:
   *
   *  - the cursor: a client that consumed the send path knows how far it got, so
   *    what it asks for on return is what it missed (`platformAdapter.ts`);
   *  - `UiCommandRunner` refuses a `commandId` it has already performed, in
   *    memory and across reloads (`sessionStorage`);
   *  - a **resolved** run's replay carries no interface commands at all
   *    (`GET /api/runs/:id/stream`), because nothing is waiting for the answer.
   */
  test('po powrocie przychodzi wynik, a nawigacja agenta nie powtarza sie', async ({
    page,
    context,
  }: {
    page: Page;
    context: BrowserContext;
  }) => {
    await long.start('bl09-continuity');
    const proxy = new CuttableProxy(PROXY_PORT, long.baseUrl);
    await proxy.start();
    try {
      await openApp(page, proxy.baseUrl);
      await send(page, 'Otworz pliki i pracuj dalej — nawigacja.');

      // The agent moves the screen, with the client watching and acknowledging.
      await expect(page.getByTestId('files-page')).toBeVisible({ timeout: 60_000 });
      const conversation = urlConversation(page)!;

      // The user goes somewhere else while the run is still working.
      await page.getByRole('link', { name: 'Ustawienia' }).click();
      await expect(page.getByTestId('settings-page')).toBeVisible();
      const parked = new URL(page.url()).pathname;

      /* --------------------------- the wire is cut -------------------------- */

      const reattach = page.waitForRequest((r) => /\/api\/runs\/[^/]+\/stream\?from=/.test(r.url()));
      proxy.cut();
      await context.setOffline(true);
      await expect
        .poll(async () => (await backendRuns(long, conversation))[0]?.status, { timeout: 30_000 })
        .toBe('succeeded');

      /* -------------------------- and comes back ----------------------------- */

      proxy.restore();
      await context.setOffline(false);

      await expect(page.locator('.openui-agent-thread-messages')).toContainText(MARKER, {
        timeout: 60_000,
      });

      /*
       * The outcome first: the screen the user chose is the screen they still
       * have. Asserted **before** the cursor below on purpose — a detection
       * trial that breaks the cursor must still be able to show whether the
       * screen held, and an assertion that never runs shows nothing.
       */
      expect(new URL(page.url()).pathname, 'nawigacja agenta powtorzyla sie po powrocie').toBe(parked);
      await expect(page.getByTestId('settings-page')).toBeVisible();
      await expect(page.getByTestId('files-page')).toHaveCount(0);

      /*
       * And the mechanism: the cursor is a real one, so the client asked for
       * what it missed rather than for the whole run. (`from=0` would mean the
       * send path never recorded how far it got.)
       */
      const from = Number(new URL((await reattach).url()).searchParams.get('from'));
      expect(from, 'klient poprosil o odtworzenie od poczatku').toBeGreaterThan(0);
      // And it did not ask for more than the run ever produced — a cursor that
      // overshot would skip events, which is the dangerous direction.
      const produced = await page.evaluate(async (id) => {
        const { runs } = await (
          await fetch(`/api/conversations/${id}/runs`, { credentials: 'include' })
        ).json();
        const { events } = await (
          await fetch(`/api/runs/${runs[0].id}/events`, { credentials: 'include' })
        ).json();
        return events.length as number;
      }, conversation);
      expect(from).toBeLessThanOrEqual(produced);
    } finally {
      await proxy.stop();
    }
  });

  test('przeladowanie w trakcie zadania dokancza odpowiedz bez jej podwojenia', async ({ page }) => {
    await long.start('bl09-continuity');
    await openApp(page, long.baseUrl);
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
    await openApp(page, shortLimit.baseUrl);
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
