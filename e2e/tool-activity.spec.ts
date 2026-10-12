import { expect, test } from './support/fixtures.ts';
import { CuttableProxy } from './support/cuttable-proxy.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type BrowserContext, type Page } from '@playwright/test';

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

async function openApp(page: Page, base: string = BASE) {
  await page.goto(`${base}/`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${base}/`);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

const urlConversation = (page: Page) => new URL(page.url()).searchParams.get('c');

const runsOf = (page: Page, conversationId: string) =>
  page.evaluate(
    async (id) =>
      (await (await fetch(`/api/conversations/${id}/runs`, { credentials: 'include' })).json()) as {
        runs: Array<{ id: string; status: string }>;
      },
    conversationId,
  );

/**
 * Asks the backend from the test process.
 *
 * Needed while the browser has no network: anything the page could answer then
 * is a statement about the page, not about the run.
 */
async function backendRuns(conversationId: string): Promise<Array<{ id: string; status: string }>> {
  const login = await fetch(`${BASE}/api/auth/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const res = await fetch(`${BASE}/api/conversations/${conversationId}/runs`, {
    headers: { cookie },
  });
  return ((await res.json()) as { runs: Array<{ id: string; status: string }> }).runs;
}

/**
 * Opens the ready-made timeline far enough to read a call's arguments and its
 * result.
 *
 * Two controls, both the library's own: the tray ("Behind the scenes") and the
 * row of each call inside it. Which of them is already open depends on whether
 * the turn is still live, so this asks for the state it needs rather than
 * assuming one. (Same helper `run-events.spec.ts` carries; kept here because
 * this file is where the tool-activity evidence lives.)
 */
async function revealToolDetails(page: Page): Promise<void> {
  const rows = page.locator('.openui-tool-call__title-row');
  if ((await rows.count()) === 0) {
    const toggle = page.locator('.openui-behind-the-scenes__toggle').first();
    if ((await toggle.count()) > 0) await toggle.click();
  }
  const count = await rows.count();
  for (let i = 0; i < count; i += 1) await rows.nth(i).click();
}

/** One atomic reading of the phase and of what the chat currently shows. */
const sample = (page: Page, needles: string[]) =>
  page.evaluate((words) => {
    const text = (document.querySelector('.pf-chat') as HTMLElement | null)?.innerText ?? '';
    return {
      phase: document.querySelector('[data-testid="run-state"]')?.getAttribute('data-phase') ?? null,
      seen: Object.fromEntries(words.map((w) => [w, text.split(w).length - 1])) as Record<string, number>,
    };
  }, needles);

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

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
   * Streamingu nie sprawdza tu osobny test, chociaz kiedyś był: „tekst
   * odpowiedzi przyrasta w wiadomosci asystenta przed koncem wykonania”
   * pollował stronę z Node — odczyt fazy wykonania i odczyt tekstu to dwa
   * osobne round-tripy, a run mógł się zamknąć między nimi. Sondujący wzorzec
   * streamProbe.ts nazywa ten wyścig po imieniu: ta sama odpowiedź dostała dwa
   * przeciwne werdykty w dwóch uruchomieniach. Pokrycie i tak było zdublowane —
   * „tekst dociera fragmentami i jest widoczny przed koncem wykonania” w
   * streaming.spec.ts biegnie po tym samym scenariuszu `text-only`, tej samej
   * komendzie i tych samych elementach (`streaming-answer` /
   * `assistant-message`), tylko obserwowanych z wnętrza strony
   * (MutationObserver), a do tego z kontrolami ujemnymi, które dowodzą, że
   * asercja potrafi paść. Ten plik zostawia strumieniowanie tam, a u siebie
   * sprawdza to, czego streaming.spec nie widzi: narzędzia, ich wyniki i
   * błędy — na żywo i po restarcie.
   *
   * Dla porządku: przyrost tekstu asertuje się w turze BEZ wywołania narzędzia,
   * bo tam gotowy czat strumieniuje odpowiedź do wiadomości asystenta. W turze
   * z narzędziem `InterleavedTurn` wstrzymuje bąbel odpowiedzi do zamknięcia
   * tury i prowadzi prozę w osi czasu narzędzi — to zachowanie biblioteki, nie
   * defekt, i przyczyna, dla której dawniejsza asercja strumieniowania w turze
   * narzędziowej mogła zobaczyć wyłącznie gotową odpowiedź.
   */

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

  /* ---------------------------------------------------------------- T06(a) -- */

  test('argumenty narzedzia i jego wynik sa widoczne, dopoki wykonanie trwa', async ({ page }) => {
    await scripted.start('tool-result-visible');
    await openApp(page);
    await sendCommand(page, 'Sprawdz karty i pracuj dalej.');

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    await expect(timeline(page)).toBeVisible({ timeout: 30_000 });
    await revealToolDetails(page);

    /*
     * The matrix gap this closes: arguments were never read *in the browser*,
     * and never tied to the phase. Phase and contents are read in one evaluation
     * (a single `sample`), and the requirement is a moment where the run had not
     * finished and the call's input JSON — `sp_scripted`, the scenario's own
     * argument — and its result were both on screen. The scenario holds the run
     * open for four seconds after the call, so this can fail: a chat that only
     * showed the arguments once the run had ended would find no running sample.
     */
    const ARGS = 'sp_scripted';
    const RESULT = 'WYNIK-NARZEDZIA-A';
    await expect
      .poll(
        async () => {
          const s = await sample(page, [ARGS, RESULT]);
          return (
            (s.phase === 'running' || s.phase === 'queued') &&
            s.seen[ARGS]! > 0 &&
            s.seen[RESULT]! > 0
          );
        },
        { timeout: 30_000, message: 'brak probki: running + argumenty + wynik jednoczesnie' },
      )
      .toBe(true);

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });
  });

  /* ---------------------------------------------------------------- T06(b) -- */

  test('wynik z cudzym toolCallId nie przykleja sie do cudzego wywolania', async ({ page }) => {
    await scripted.start('wrong-tool-call-id');
    await openApp(page);
    await sendCommand(page, 'Wywolaj narzedzie z cudzym wynikiem.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('assistant-message')).toContainText('ODPOWIEDZ-PO-NARZEDZIU');

    /*
     * What the criterion forbids is *misattribution*: WYNIK-CUDZY arrived with a
     * toolCallId no PreToolUse ever declared, and pinning it to the only
     * announced call in sight would turn that call's answer into somebody
     * else's. What the library in fact does (observed, and asserted below) is
     * render the orphan as its own entry — one it cannot name — while the
     * announced call keeps its own panel. Once the turn closes the tray
     * collapses, so it is opened first and the rows are asked of the expanded
     * tray.
     */
    await revealToolDetails(page);
    const calls = page.locator('.openui-tool-call');
    const announced = calls.filter({ hasText: 'canvas_list_cards' });
    await expect(announced, 'wlasciwe wywolanie zniknelo z osi czasu').toHaveCount(1);
    const announcedText = await announced.first().innerText();
    expect(announcedText).toContain('WYNIK-DOBRZE');
    expect(announcedText, 'cudzy wynik dotarl do obcego wywolania').not.toContain('WYNIK-CUDZY');

    // Wherever the stray landed, it never took the announced call's name.
    const stray = calls.filter({ hasText: 'WYNIK-CUDZY' });
    if ((await stray.count()) > 0) {
      expect(await stray.first().innerText(), 'osierocony wynik przejal nazwe obcego wywolania').not.toContain(
        'canvas_list_cards',
      );
    }

    // The stored history pairs the same way: the tool message bound to the
    // assistant's call carries that call's own result.
    const history = await page.evaluate(async (needle) => {
      const { threads } = await (await fetch('/api/threads/get', { credentials: 'include' })).json();
      const thread = threads.find((t: any) => String(t.title).includes(needle));
      if (!thread) throw new Error(`nie znaleziono watku "${needle}"`);
      return (await (
        await fetch(`/api/threads/get/${thread.id}`, { credentials: 'include' })
      ).json()) as Array<{
        id: string;
        role: string;
        content?: string;
        toolCallId?: string;
        toolCalls?: Array<{ id: string }>;
      }>;
    }, 'Wywolaj narzedzie z cudzym wynikiem');
    const assistant = history.find((m) => Array.isArray(m.toolCalls) && m.toolCalls.length > 0);
    expect(assistant, 'historia nie niesie wywolania narzedzia').toBeTruthy();
    const paired = history.find(
      (m) => m.role === 'tool' && m.toolCallId === assistant!.toolCalls![0]!.id,
    );
    expect(String(paired?.content)).toContain('WYNIK-DOBRZE');

    // After a reload the same pairing comes back from the projection: the
    // announced call still owns its result, and the orphan — however the
    // library chooses to show it — still owns nothing of that call.
    await page.reload();
    await expect(page.getByTestId('assistant-message')).toContainText('ODPOWIEDZ-PO-NARZEDZIU', {
      timeout: 30_000,
    });
    await revealToolDetails(page);
    const reloaded = page.locator('.openui-tool-call');
    const announcedAfterReload = reloaded.filter({ hasText: 'canvas_list_cards' });
    await expect(announcedAfterReload, 'wlasciwe wywolanie zniknelo po przeladowaniu').toHaveCount(1);
    const reloadedText = await announcedAfterReload.first().innerText();
    expect(reloadedText).toContain('WYNIK-DOBRZE');
    expect(reloadedText, 'cudzy wynik dotarl do obcego wywolania po przeladowaniu').not.toContain(
      'WYNIK-CUDZY',
    );
    const strayAfterReload = reloaded.filter({ hasText: 'WYNIK-CUDZY' });
    if ((await strayAfterReload.count()) > 0) {
      expect(
        await strayAfterReload.first().innerText(),
        'osierocony wynik przejal nazwe obcego wywolania po przeladowaniu',
      ).not.toContain('canvas_list_cards');
    }
  });

  /* ---------------------------------------------------------------- T06(c) -- */

  test('reconnect trwajacego wykonania odtwarza zdarzenia bez podwojnego renderowania', async ({
    page,
    context,
  }: {
    page: Page;
    context: BrowserContext;
  }) => {
    await scripted.start('tool-then-long-text');
    const proxy = new CuttableProxy(8797, scripted.baseUrl);
    await proxy.start();
    try {
      await openApp(page, proxy.baseUrl);
      await sendCommand(page, 'Pracuj dlugo z narzedziem.');
      await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
        timeout: 30_000,
      });

      // The call and its result are on screen before the wire goes away.
      await expect(page.locator('.openui-tool-call')).toBeVisible({ timeout: 30_000 });
      await revealToolDetails(page);
      await expect(page.locator('.pf-chat')).toContainText('WYNIK-NARZEDZIA-RECONNECT', {
        timeout: 30_000,
      });
      const conversation = urlConversation(page)!;

      /* --------------------------- the wire is cut ------------------------- */

      proxy.cut();
      await context.setOffline(true);
      await page.waitForTimeout(2500);
      // The run is still going, from the backend's own mouth.
      expect(
        (await backendRuns(conversation))[0]!.status,
        'wykonanie zakonczylo sie, zanim klient wrocil',
      ).toMatch(/queued|running/);

      /* ------------------------- and comes back, mid-run ------------------- */

      proxy.restore();
      await context.setOffline(false);

      // No reload: the client recovers on its own, and the log replay — which
      // starts from the beginning — must not double what was already shown.
      await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
        timeout: 60_000,
      });
      await revealToolDetails(page);
      const text = await page.locator('.pf-chat').innerText();
      expect(
        occurrences(text, 'WYNIK-NARZEDZIA-RECONNECT'),
        'wynik narzedzia pokazany dwa razy po reconnect',
      ).toBe(1);
      expect(occurrences(text, 'KONIEC-PO-POWROCIE'), 'koniec odpowiedzi pokazany dwa razy').toBe(1);
      await expect(page.locator('.openui-tool-call')).toHaveCount(1);
      expect((await runsOf(page, conversation)).runs, 'zadanie uruchomilo sie drugi raz').toHaveLength(
        1,
      );
    } finally {
      await proxy.stop();
    }
  });
});
