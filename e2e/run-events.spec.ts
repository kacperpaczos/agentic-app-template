import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * BL-08b — what the chat surface makes of a run's events: its end, its tool
 * activity, the orderings it can arrive in, and the one place the ready-made
 * component shows the same words twice.
 *
 * **Simulation, marked as such.** The model is the scripted stand-in at the
 * adapter boundary (`e2e/support/scripted-agent.ts`); the runtime, the hook
 * bridge, the event stream, the projection, the built frontend and the browser
 * are the application's own. No model turn is spent.
 *
 * Every assertion here reads either a `data-testid` of this application, a class
 * name of the ready-made component, or a marker the scenario itself put in the
 * conversation. None reads a label: the shell's wording has already changed once
 * during this programme and took somebody's green test with it.
 */

const PORT = 8798;
const scripted = new ScriptedInstance({ port: PORT, dataDirName: '.e2e-scripted-runevents' });

async function openApp(page: Page) {
  await page.goto(`${scripted.baseUrl}/`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${scripted.baseUrl}/`);
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

/** The run's AG-UI events, straight from the backend — for ordering questions. */
const eventsOf = (page: Page, runId: string) =>
  page.evaluate(
    async (id) =>
      (
        await (await fetch(`/api/runs/${id}/events`, { credentials: 'include' })).json()
      ).events as Array<{ seq: number; name: string; payload: Record<string, unknown> }>,
    runId,
  );

/**
 * Opens the ready-made timeline far enough to read a call's arguments and its
 * result.
 *
 * Two controls, both the library's own and both addressed by class: the tray
 * ("Behind the scenes") and the row of each call inside it. Which of them is
 * already open depends on whether the turn is still live, so this asks for the
 * state it needs rather than assuming one — and the assertions that follow are
 * about what is then on screen, not about the clicks.
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
      toolRows: document.querySelectorAll('.openui-tool-call').length,
    };
  }, needles);

/** Samples until the run resolves, returning everything observed on the way. */
async function watch(page: Page, needles: string[], timeoutMs = 60_000) {
  const samples: Array<{ phase: string | null; seen: Record<string, number>; toolRows: number }> = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await sample(page, needles);
    samples.push(s);
    if (s.phase === 'succeeded' || s.phase === 'failed' || s.phase === 'cancelled') break;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(100);
  }
  return samples;
}

test.describe('zdarzenia uruchomienia w czacie', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeEach(() => {
    scripted.prepareDatabase();
  });
  test.afterEach(async () => {
    await scripted.stop();
  });

  /* ====================================================================== */
  /*  L5.2 — the interface recognises a cancellation, not only the backend  */
  /* ====================================================================== */

  test('L5.2: zatrzymanie z kompozytora konczy wykonanie i zakladka to pokazuje', async ({ page }) => {
    await scripted.start('slow');
    await openApp(page);
    await send(page, 'Opowiadaj dlugo, prosze.');

    const runState = page.getByTestId('run-state');
    await expect(runState).toHaveAttribute('data-phase', 'running', { timeout: 30_000 });
    // Something is really being produced, so this cancels work rather than a
    // run that had already stopped by itself.
    await expect(page.getByTestId('streaming-answer')).toBeVisible({ timeout: 30_000 });
    const conversation = urlConversation(page)!;

    /*
     * The composer's own control. While a turn is open the ready-made component
     * swaps its role to "stop", and pressing it ends the stream **locally** — it
     * has no idea there is a backend. `useComposerStop` tells the backend, and
     * the answer to that (`platform.run_cancelled`, then `RUN_ERROR`) arrives on
     * a stream this click has just aborted. Until the send path re-attached from
     * its cursor, the tab therefore sat at `running` while the run was long
     * over: the backend was right and the screen was wrong, indefinitely.
     */
    const started = Date.now();
    await page.locator('.pf-chat .openui-agent-thread-composer__submit-button').first().click();

    await expect(runState, 'zakladka nie pokazala anulowania').toHaveAttribute(
      'data-phase',
      'cancelled',
      { timeout: 25_000 },
    );
    const elapsed = Date.now() - started;

    // The backend agrees, and there is exactly one run: stopping is not sending.
    const runs = await runsOf(page, conversation);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('cancelled');
    // A cancelled run is not an error: the interface must keep the two apart.
    await expect(page.getByTestId('run-error')).toHaveCount(0);
    // And the composer is usable again — nothing is stuck in loading.
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeEnabled();
    expect(elapsed, `anulowanie widoczne po ${elapsed} ms`).toBeLessThan(25_000);
  });

  /* ====================================================================== */
  /*  L5.3 — the call, its arguments and its RESULT, while the run runs     */
  /* ====================================================================== */

  test('L5.3: wywolanie, argumenty i tresc udanego wyniku sa widoczne w trakcie wykonania i po odtworzeniu', async ({
    page,
  }) => {
    await scripted.start('tool-result-visible');
    await openApp(page);
    await send(page, 'Sprawdz karty i powiedz co widzisz.');

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    await expect(page.locator('.openui-tool-call').first()).toBeVisible({ timeout: 30_000 });
    await revealToolDetails(page);

    const ARGS = 'sp_scripted';
    const RESULT = 'WYNIK-NARZEDZIA-A';
    const samples = await watch(page, [ARGS, RESULT]);

    /*
     * The assertion the previous evidence could not make. It waited for the
     * timeline to be *visible* and never read the phase, so a timeline that
     * appeared only after the run ended passed it just as well. Here the phase
     * and the contents are read in the same evaluation, and the requirement is
     * a sample in which the run had **not** finished and the call, its arguments
     * and its result were all on screen.
     */
    const live = samples.filter(
      (s) => (s.phase === 'running' || s.phase === 'queued') && s.seen[ARGS]! > 0 && s.seen[RESULT]! > 0,
    );
    expect(
      live.length,
      `fazy: ${[...new Set(samples.map((s) => s.phase))].join(',')}; ` +
        `probki z trescia: ${samples.filter((s) => s.seen[RESULT]! > 0).length}`,
    ).toBeGreaterThan(0);

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('assistant-message')).toContainText('ODPOWIEDZ-PO-NARZEDZIU');

    /* ----------------------- and after the history is replayed ------------- */

    await page.reload();
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    await expect(page.locator('.openui-tool-call, .openui-behind-the-scenes')).not.toHaveCount(0, {
      timeout: 30_000,
    });
    await revealToolDetails(page);
    const afterReload = await sample(page, [ARGS, RESULT]);
    expect(afterReload.seen[ARGS], 'argumenty narzedzia zniknely po odtworzeniu').toBeGreaterThan(0);
    expect(afterReload.seen[RESULT], 'wynik narzedzia zniknal po odtworzeniu').toBeGreaterThan(0);
    // The call and its result are one pair, from one turn — not two unrelated rows.
    expect(afterReload.toolRows).toBe(1);
  });

  /* ====================================================================== */
  /*  L5.13 — the orderings                                                 */
  /* ====================================================================== */

  test('L5.13: tekst przed narzedziem — kolejnosc w strumieniu i na ekranie', async ({ page }) => {
    await scripted.start('text-then-tool');
    await openApp(page);
    await send(page, 'Powiedz cos, potem uzyj narzedzia.');

    const PROSE = 'PROZA-PRZED-NARZEDZIEM';
    const TOOL = 'canvas_list_cards';

    /*
     * Read inside the ready-made thread, and nowhere else.
     *
     * A detection trial insisted on this. The first version of the assertion
     * looked for a sample of the whole panel in which the prose was present and
     * no call had been drawn — and it stayed green with the ordering broken,
     * because this application's own run strip paints a delta the instant it
     * arrives while the library's timeline paints on its next frame. The panel
     * therefore shows "prose, no tool" for a moment even when the tool call
     * reached the runtime first. What the criterion is about is the ready-made
     * component's presentation, so that is what is measured: the position of the
     * two things inside `.openui-agent-thread-messages`.
     */
    const threadSample = () =>
      page.evaluate(
        ([prose, tool]) => {
          const el = document.querySelector('.openui-agent-thread-messages') as HTMLElement | null;
          const text = el?.innerText ?? '';
          return {
            phase: document.querySelector('[data-testid="run-state"]')?.getAttribute('data-phase') ?? null,
            prose: text.indexOf(prose),
            tool: text.indexOf(tool),
          };
        },
        [PROSE, TOOL] as const,
      );

    const samples: Array<Awaited<ReturnType<typeof threadSample>>> = [];
    const deadline = Date.now() + 60_000;
    for (;;) {
      const s = await threadSample();
      samples.push(s);
      if (s.phase === 'succeeded' || s.phase === 'failed') break;
      if (Date.now() > deadline) break;
      await page.waitForTimeout(100);
    }
    const trace = samples.map((s) => `${s.phase}/${s.prose}/${s.tool}`).join(' ');

    // The prose was in the thread while the call was not yet anywhere in it.
    expect(samples.some((s) => s.prose >= 0 && s.tool === -1), `probki: ${trace}`).toBe(true);
    // The call did arrive afterwards, so this is an ordering rather than a
    // scenario that never called a tool.
    expect(samples.some((s) => s.tool >= 0), `probki: ${trace}`).toBe(true);
    const both = samples.filter((s) => s.prose >= 0 && s.tool >= 0);
    expect(both.length, `probki: ${trace}`).toBeGreaterThan(0);
    /*
     * **What is deliberately not asserted, because it was measured to be
     * false.** Once the call is drawn, the ready-made thread puts it *above* the
     * prose that preceded it (measured: prose at 35 with no call, then the call
     * at 56 with the prose at 88). The component groups a turn's steps its own
     * way rather than laying them out in arrival order, so the arrival order is
     * a fact about the stream and about *when* each piece appears — which is
     * what the two assertions above and the event check below state — and not
     * about where they sit relative to each other.
     */

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('assistant-message')).toContainText('ODPOWIEDZ-PO-NARZEDZIU');

    // In the stream itself: text really did reach the runtime before the call.
    const conversation = urlConversation(page)!;
    const runId = (await runsOf(page, conversation))[0]!.id;
    const names = (await eventsOf(page, runId)).map((e) => e.name);
    expect(names.indexOf('TEXT_MESSAGE_CONTENT')).toBeLessThan(names.indexOf('TOOL_CALL_START'));
    expect(names).toContain('TOOL_CALL_RESULT');
  });

  test('L5.13: wiele narzedzi w jednej turze — obie osie i oba wyniki', async ({ page }) => {
    await scripted.start('many-tools');
    await openApp(page);
    await send(page, 'Uzyj dwoch narzedzi po kolei.');

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });
    await revealToolDetails(page);
    const seen = await sample(page, ['WYNIK-NARZEDZIA-A', 'WYNIK-NARZEDZIA-B']);
    expect(seen.toolRows, 'oba wywolania nie sa pokazane').toBe(2);
    expect(seen.seen['WYNIK-NARZEDZIA-A']).toBeGreaterThan(0);
    expect(seen.seen['WYNIK-NARZEDZIA-B']).toBeGreaterThan(0);
    await expect(page.getByTestId('assistant-message')).toContainText('ODPOWIEDZ-PO-NARZEDZIU');

    const conversation = urlConversation(page)!;
    const runId = (await runsOf(page, conversation))[0]!.id;
    const events = await eventsOf(page, runId);
    const callIds = new Set(
      events.filter((e) => e.name === 'TOOL_CALL_START').map((e) => String(e.payload.toolCallId)),
    );
    const resultIds = new Set(
      events.filter((e) => e.name === 'TOOL_CALL_RESULT').map((e) => String(e.payload.toolCallId)),
    );
    expect(callIds.size, 'dwa wywolania nie maja dwoch identyfikatorow').toBe(2);
    expect([...resultIds].sort()).toEqual([...callIds].sort());
  });

  test('L5.13: tura bez tekstu konczy sie sukcesem i nie udaje odpowiedzi', async ({ page }) => {
    await scripted.start('tool-only-silent');
    await openApp(page);
    await send(page, 'Sprawdz karty, bez komentarza.');

    /*
     * `succeeded`, named exactly. The previous scenario for this case accepted
     * "succeeded or failed", which makes the criterion — "a turn with no text
     * leads to the correct status" — unfalsifiable: both answers passed.
     */
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('run-error')).toHaveCount(0);
    /*
     * Work happened and was shown; an answer was not invented for it.
     *
     * The tray, not the call row: once the turn has ended the ready-made
     * timeline is collapsed and its steps are not in the document at all — the
     * limitation pinned for L4.9 in `e2e/chat-history.spec.ts`. So the tray is
     * asserted first, then opened, and only then does the call exist to assert.
     */
    await expect(page.locator('.openui-behind-the-scenes').first()).toBeVisible();
    await revealToolDetails(page);
    await expect(page.locator('.openui-tool-call').first()).toBeVisible();
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);
    await expect(page.getByTestId('streaming-answer')).toHaveCount(0);

    const conversation = urlConversation(page)!;
    const runId = (await runsOf(page, conversation))[0]!.id;
    const names = (await eventsOf(page, runId)).map((e) => e.name);
    expect(names).toContain('TOOL_CALL_RESULT');
    expect(names).not.toContain('TEXT_MESSAGE_CONTENT');
    expect(names.filter((n) => n === 'RUN_FINISHED' || n === 'RUN_ERROR')).toEqual(['RUN_FINISHED']);
  });

  /* ====================================================================== */
  /*  L5.15 — the library's limitation, measured where it shows             */
  /* ====================================================================== */

  /**
   * Prose spoken during a turn that calls a tool is on screen **twice** while
   * the turn is live, and in neither place afterwards.
   *
   * Measured, not assumed: `InterleavedTurn` (@openuidev/react-ui 0.13.10)
   * treats only the last segment of a turn as the answer and puts everything
   * earlier into its "behind the scenes" steps, which it renders live; the run
   * strip of this application shows the same text at the same time, because for
   * a turn *without* a tool the library shows nothing at all and the strip is
   * the only place a streamed answer appears (L5.1, L5.9). Two surfaces, one
   * sentence.
   *
   * **Not worked around, and the reason is stated rather than implied.** The
   * only two ways to remove it are to stop showing the strip during tool turns —
   * which takes away the sole live view of a streamed answer for those turns,
   * and which other packages' measurements read — or to replace the library's
   * `Messages`, which this repository does not do. So it is pinned here and
   * written down in `docs/NEW-APPLICATION.md` §7 as a limitation of the version
   * in use.
   *
   * **Which colour of red means what.** This test fails in two opposite
   * situations and they call for opposite responses:
   *  - the count drops to one *while the turn is live* — the library, or the
   *    strip, stopped showing live prose. Good news for this defect; check
   *    first that the streaming evidence (L5.1, L5.9) still has something to
   *    observe, then relax this assertion with the version that changed it.
   *  - the last assertion fails — the prose spoken before the tool is now in the
   *    answer bubble after the turn. Also good news (it is the L4.9 limitation
   *    pinned in `e2e/chat-history.spec.ts`), and also a reason to re-read both
   *    pins together rather than to edit one of them.
   */
  test('L5.15: proza w turze z narzedziem jest w trakcie pokazana dwukrotnie, a po turze wcale', async ({
    page,
  }) => {
    await scripted.start('text-then-tool');
    await openApp(page);
    await send(page, 'Powiedz cos, potem uzyj narzedzia.');

    const PROSE = 'PROZA-PRZED-NARZEDZIEM';
    const detailed = async () =>
      page.evaluate((word) => {
        const count = (el: Element | null) => ((el as HTMLElement | null)?.innerText ?? '').split(word).length - 1;
        return {
          phase: document.querySelector('[data-testid="run-state"]')?.getAttribute('data-phase') ?? null,
          strip: count(document.querySelector('[data-testid="streaming-answer"]')),
          thread: count(document.querySelector('.openui-agent-thread-messages')),
          bubbles: [...document.querySelectorAll('[data-testid="assistant-message"]')].reduce(
            (n, el) => n + ((el as HTMLElement).innerText.split(word).length - 1),
            0,
          ),
        };
      }, PROSE);

    const samples: Array<Awaited<ReturnType<typeof detailed>>> = [];
    const deadline = Date.now() + 60_000;
    for (;;) {
      const s = await detailed();
      samples.push(s);
      if (s.phase === 'succeeded' || s.phase === 'failed') break;
      if (Date.now() > deadline) break;
      await page.waitForTimeout(100);
    }

    // While the turn was live: the application's strip had it, and the
    // ready-made thread had it as well, at the same instant.
    const doubled = samples.filter((s) => s.phase === 'running' && s.strip > 0 && s.thread > 0);
    expect(
      doubled.length,
      `probki: ${samples.map((s) => `${s.phase}:${s.strip}/${s.thread}`).join(' ')}`,
    ).toBeGreaterThan(0);

    // After the turn: neither surface shows it. The sentence is in the history
    // (asserted below) and reachable through the tray, but it is not the answer.
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 60_000,
    });
    const after = await detailed();
    expect(after.strip, 'podglad strumienia przetrwal ture').toBe(0);
    expect(after.bubbles, 'proza sprzed narzedzia trafila do banki odpowiedzi').toBe(0);

    // Nothing was lost on the way: the backend has both halves of the turn.
    const conversation = urlConversation(page)!;
    const stored = await page.evaluate(async (id) => {
      const messages = (await (
        await fetch(`/api/threads/get/${id}`, { credentials: 'include' })
      ).json()) as Array<{ role: string; content: string }>;
      return messages.filter((m) => m.role === 'assistant').map((m) => m.content);
    }, conversation);
    expect(stored.join('\n')).toContain(PROSE);
    expect(stored.join('\n')).toContain('ODPOWIEDZ-PO-NARZEDZIU');
  });
});
