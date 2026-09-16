import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import {
  describeVerdict,
  judgeStream,
  readStreamProbe,
  startStreamProbe,
} from './support/streamProbe.ts';
import { type APIRequestContext, type Page } from '@playwright/test';

/**
 * The whole user path, through the interface, against the real model.
 *
 * This is the only suite that spends subscription turns, so it is one run that
 * covers the path end to end rather than several that each pay for one:
 *
 *   typed command → context → MCP tool → domain mutation → canvas updates
 *   without a reload → answer streams in → tool activity is visible → the
 *   exchange and its tool activity survive a reload and a conversation switch.
 *
 * It asserts on rendered DOM *and* backend state, and never on the model's
 * wording. Where it needs the model to cooperate it asks for a unique marker,
 * which is checked for *growth over time* — a marker that only appears at the
 * end proves an answer arrived, not that it streamed.
 */

const AGENT_TIMEOUT = 420_000;

async function openCaseWorkspace(page: Page) {
  await page.goto('/cases');
  await page.locator('[data-testid^="case-tile-"]').first().click();
  await expect(page.getByTestId('case-detail-page')).toBeVisible();
  await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
  await expect(page.getByTestId('card-case-summary').first()).toBeVisible();
}

/**
 * Removes any chart card left by an earlier run.
 *
 * Without this the test proves nothing: the first version of it asserted that a
 * chart card was visible, and one from a previous run already was — so the
 * assertion passed instantly without ever waiting for the model.
 */
async function clearChartCards(request: APIRequestContext, spaceId: string) {
  const state = await (await request.get(`/api/canvas/spaces/${spaceId}`)).json();
  for (const card of state.cards) {
    if (card.spec?.component === 'procurement.costChart') {
      await request.delete(`/api/canvas/cards/${card.id}`);
    }
  }
}

async function sendCommand(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

/** Text of the answer carrying the marker, or null. */
const markerText = (page: Page, marker: string) =>
  page.evaluate((m) => {
    const nodes = [
      ...document.querySelectorAll('[data-testid="streaming-answer"]'),
      ...document.querySelectorAll('[data-testid="assistant-message"]'),
    ];
    const hit = nodes.map((n) => n.textContent ?? '').find((t) => t.includes(m));
    return hit ?? null;
  }, marker);

/** Opens a conversation from the drawer, as a user would, and waits for it. */
async function openConversation(page: Page) {
  const expanded = page.locator(
    '.openui-agent-sidebar-container[data-sidebar-visual-state="expanded"]',
  );
  if ((await expanded.count()) === 0) {
    await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
  }
  await expect(expanded).toHaveCount(1);
  const row = page.locator('.openui-agent-thread-button').first();
  await expect(row).toBeVisible();
  await row.locator('.openui-agent-thread-button-title').first().click();
  await expect(page.locator('.openui-agent-thread-messages > *').first()).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('pelna sciezka uzytkownika z prawdziwym modelem', () => {
  test.describe.configure({ timeout: AGENT_TIMEOUT });

  test('polecenie → narzedzie → mutacja → canvas → strumien → trwalosc', async ({
    page,
    request,
  }) => {
    await request.post('/api/auth/session', { data: {} });

    // Opening the workspace is what creates the case's canvas space, so it has
    // to happen before anything looks the space up.
    await openCaseWorkspace(page);

    const { spaces } = await (await request.get('/api/canvas/spaces')).json();
    const scoped = spaces.find((s: { scopeKind: string | null }) => s.scopeKind === 'case');
    expect(scoped, 'otwarcie sprawy nie utworzylo przestrzeni canvas').toBeTruthy();

    await clearChartCards(request, scoped.id);
    await page.reload();
    await expect(page.getByTestId('card-case-summary').first()).toBeVisible();
    await expect(page.getByTestId('card-cost-chart')).toHaveCount(0);

    const before = await (await request.get(`/api/canvas/spaces/${scoped.id}`)).json();
    const idsBefore = new Set(before.cards.map((c: { id: string }) => c.id));

    /* ------------------------- the actual user action ---------------------- */

    const marker = `ZNACZNIK${Date.now().toString(36).toUpperCase()}`;
    // Recording starts before the command, so nothing can be missed between
    // the first token and the first poll.
    await startStreamProbe(page);
    await sendCommand(
      page,
      `Dodaj na canvasie karte z wykresem kosztow dla tej sprawy. ` +
        `Nastepnie napisz odpowiedz zaczynajaca sie doslownie od ${marker} ` +
        `i opisz w czterech pelnych zdaniach, co zrobiles i co widac na wykresie.`,
    );

    // Queued or running the moment the command is sent — from the run's own
    // lifecycle, not from whether any text has appeared.
    await expect(page.getByTestId('run-state')).toBeVisible();

    /* --------------------- tool activity, while it happens ----------------- */

    // The ready-made chat renders this from the message list: an assistant
    // message carrying `toolCalls`, paired with the `role: "tool"` result.
    const timeline = page.locator('.openui-behind-the-scenes, .openui-tool-call-timeline, .openui-tool-call');
    await expect(timeline.first()).toBeVisible({ timeout: 300_000 });

    /* --------------------------- effect on screen -------------------------- */

    await expect(page.getByTestId('card-cost-chart').first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 120_000,
    });
    // One beat past the terminal phase, so the committed answer is on screen.
    await page.waitForTimeout(500);

    /* ------------------------ streaming, honestly measured ----------------- */

    /*
     * Read from the in-page recording started before the command was sent.
     *
     * The previous version of this polled the DOM and the run status from Node,
     * 150 ms apart, and decided streaming from whichever samples it happened to
     * catch. It passed on one run of the suite and failed on another against the
     * same code — the failure text was `odpowiedz pojawila sie dopiero po
     * zakonczeniu`. The recording sees every change and reads the phase in the
     * same tick, so the verdict is a property of the run rather than of the
     * polling interval. `expectedFragment` ties the samples to *this* answer:
     * the marker is unique per run, and the model was asked to open with it.
     *
     * The detector's ability to fail is established separately and
     * deterministically in `streaming.spec.ts`, which runs it against a reply
     * delivered in a single burst at the end and against a run that says
     * nothing at all.
     */
    const verdict = judgeStream(await readStreamProbe(page), { expectedFragment: marker });
    mkdirSync(resolve(process.cwd(), 'docs/evidence/closure-2026-09-15'), { recursive: true });
    writeFileSync(
      resolve(process.cwd(), 'docs/evidence/closure-2026-09-15/22-strumien-model.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          zrodlo: 'prawdziwy model, jedna tura',
          znacznik: marker,
          streamed: verdict.streamed,
          powod: verdict.reason,
          dlugosciWTrakcie: verdict.whileRunning.map((x) => x.len),
          koncowaDlugosc: verdict.finalLength,
        },
        null,
        2,
      ),
    );

    expect(verdict.streamed, describeVerdict(verdict)).toBe(true);
    expect(verdict.distinctLengthsWhileRunning).toBeGreaterThanOrEqual(2);
    expect(verdict.whileRunning.every((x) => x.phase === 'queued' || x.phase === 'running')).toBe(
      true,
    );
    expect(verdict.sawPartialAnswer, 'cala odpowiedz pojawila sie naraz na koncu').toBe(true);

    /* ----------------------------- backend truth --------------------------- */

    const after = await (await request.get(`/api/canvas/spaces/${scoped.id}`)).json();
    const added = after.cards.filter((c: { id: string }) => !idsBefore.has(c.id));
    expect(added.length, 'agent nie utworzyl nowej karty').toBeGreaterThan(0);
    expect(added.map((c: { spec: { component?: string } }) => c.spec.component)).toContain(
      'procurement.costChart',
    );
    for (const id of idsBefore) {
      expect(after.cards.some((c: { id: string }) => c.id === id)).toBe(true);
    }

    /* ------------------------- run, session, metrics ----------------------- */

    const { threads } = await (await request.get('/api/threads/get')).json();
    const conv = await (await request.get(`/api/conversations/${threads[0].id}`)).json();
    expect(conv.claudeSessionId, 'rozmowa nie zostala powiazana z sesja Claude').toBeTruthy();

    const { runs } = await (await request.get(`/api/conversations/${conv.id}/runs`)).json();
    const run = runs[0];
    expect(run.status).toBe('succeeded');
    expect(run.claudeSessionId).toBeTruthy();
    // Recorded even though a tool ran before the first word — the ordering that
    // used to lose this metric entirely.
    expect(run.firstTokenMs, 'zgubiony czas pierwszego tekstu').toBeGreaterThan(0);
    expect(run.firstTokenMs).toBeLessThanOrEqual(run.durationMs);
    expect(run.queuedMs).toBeGreaterThanOrEqual(0);

    const { events } = await (await request.get(`/api/runs/${run.id}/events`)).json();
    const names = events.map((e: { name: string }) => e.name);
    expect(names).toContain('TOOL_CALL_START');
    expect(names).toContain('TOOL_CALL_RESULT');
    expect(names).toContain('RUN_FINISHED');
    expect(names.filter((n: string) => n === 'TEXT_MESSAGE_CONTENT').length).toBeGreaterThan(3);
    const toolNames = events
      .filter((e: { name: string }) => e.name === 'TOOL_CALL_START')
      .map((e: { payload: { toolCallName: string } }) => e.payload.toolCallName);
    expect(toolNames.some((n: string) => n.startsWith('mcp__app__'))).toBe(true);

    /* ---------------- history carries the tool activity, not just text ------ */

    const historyBefore = await (await request.get(`/api/threads/get/${conv.id}`)).json();
    const assistantWithCalls = historyBefore.find(
      (m: any) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0,
    );
    expect(assistantWithCalls, 'historia nie niesie wywolan narzedzi').toBeTruthy();
    const toolMessage = historyBefore.find((m: any) => m.role === 'tool');
    expect(toolMessage, 'historia nie niesie wynikow narzedzi').toBeTruthy();
    expect(toolMessage.toolCallId).toBe(assistantWithCalls.toolCalls[0].id);

    /* ------------------------------- reload -------------------------------- */

    await page.reload();
    await expect(page.getByTestId('card-cost-chart').first()).toBeVisible();
    /*
     * No drawer, no click: the conversation is restored from the address bar.
     * This step used to reopen it by hand and call that "exactly as a user
     * would", which turned the missing restore into expected behaviour.
     */
    await expect(page.locator('.openui-agent-thread-messages > *').first()).toBeVisible({
      timeout: 30_000,
    });
    // The steps are still on screen, not only the conclusion.
    await expect(timeline.first()).toBeVisible();
    expect(await markerText(page, marker)).toContain(marker);

    const historyAfter = await (await request.get(`/api/threads/get/${conv.id}`)).json();
    // Neither lost nor duplicated by the reload.
    expect(historyAfter.length).toBe(historyBefore.length);
    expect(historyAfter.map((m: any) => m.id)).toEqual(historyBefore.map((m: any) => m.id));

    /* -------------------- switching away and back keeps it ----------------- */

    await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
    await expect(
      page.locator('.openui-agent-sidebar-container[data-sidebar-visual-state="expanded"]'),
    ).toHaveCount(1);
    await page.locator('.pf-chat [aria-label="New chat"]').first().click();
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);

    await openConversation(page);
    await expect(timeline.first()).toBeVisible();
    expect(await markerText(page, marker)).toContain(marker);
  });
});
