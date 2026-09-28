import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';

/**
 * Timings, with their conditions stated.
 *
 * A number without its conditions is not a measurement, so each result records
 * what was measured, from which instant to which, and on what. Two of these
 * cannot be taken from the backend alone:
 *
 *  - **refresh after a mutation** is the time until the *new value is on
 *    screen*, not until a fetch resolves;
 *  - **cancellation** is the time from the user's click to a resolved run,
 *    which involves the browser, the backend and the model process.
 *
 * Results are written to the evidence directory rather than only asserted, so
 * the report quotes measurements instead of restating claims.
 */

const OUT_DIR = resolve(process.cwd(), 'docs/evidence/closure-2026-09-15');
const results: Record<string, unknown> = { at: new Date().toISOString() };

test.afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, '20-pomiary.json'), JSON.stringify(results, null, 2));
});

/* ------------------------- mutation → visible result ---------------------- */

test.describe('czas odswiezenia po mutacji przez interfejs', () => {
  test('zmiana pozycji oferty jest widoczna w zestawieniu bez przeladowania', async ({
    page,
    request,
  }) => {
    await request.post('/api/auth/session', { data: {} });

    await page.goto('/cases');
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
    await expect(page.getByTestId('card-comparison').first()).toBeVisible();

    const spaceId = await page.evaluate(async () => {
      const { spaces } = await (await fetch('/api/canvas/spaces', { credentials: 'include' })).json();
      return spaces.find((s: any) => s.scopeKind === 'case').id;
    });
    const caseId = await page.evaluate(async () => {
      const { cases } = await (await fetch('/api/m/procurement/cases', { credentials: 'include' })).json();
      return cases[0].id;
    });
    // The editing card is bound to an offer, not to the case.
    const offerId = await page.evaluate(async (id) => {
      const detail = await (await fetch(`/api/m/procurement/cases/${id}`, { credentials: 'include' })).json();
      const withItems = detail.offers.find((o: any) =>
        o.items.some((i: any) => i.unitPriceMinor !== null && i.quantityMilli !== null),
      );
      return withItems.offer.id as string;
    }, caseId);

    // Setup only: put the editing card on the canvas the same way a composition
    // would. The measurement itself is entirely through the interface.
    const added = await page.evaluate(
      async ([space, offer]) => {
        const res = await fetch('/api/canvas/cards', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            spaceId: space,
            title: 'Edycja pozycji',
            spec: {
              kind: 'component',
              component: 'procurement.offerItemForm',
              props: { offerId: offer },
            },
          }),
        });
        return { status: res.status, body: await res.text() };
      },
      [spaceId, offerId],
    );
    expect(added.status, `nie udalo sie dodac karty: ${added.body}`).toBeLessThan(300);
    await page.reload();

    const form = page.getByTestId('card-item-form').first();
    await expect(form).toBeVisible();

    // Pick the offer whose total we will watch.
    const before = await page.evaluate(async (id) => {
      const cmp = await (await fetch(`/api/m/procurement/cases/${id}/comparison`, { credentials: 'include' })).json();
      return cmp.rows.map((r: any) => ({ offerId: r.offerId, total: r.totalMinor }));
    }, caseId);

    const itemSelect = form.locator('select').first();
    await expect(itemSelect).toBeVisible();
    const itemId = await itemSelect.inputValue();
    expect(itemId, 'formularz nie wybral pozycji').toBeTruthy();

    const qty = form.locator('input').first();
    await qty.fill('7');

    /* ------------------------------ measurement ---------------------------- */

    const totals = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="total-"]')].map((n) => n.textContent ?? ''),
      );
    const totalsBefore = await totals();

    const t0 = Date.now();
    await form.getByTestId('save-item').click();

    // Time until the *screen* shows a different set of totals — no reload.
    await expect
      .poll(async () => (await totals()).join('|') !== totalsBefore.join('|'), { timeout: 20_000 })
      .toBe(true);
    const refreshMs = Date.now() - t0;

    const after = await page.evaluate(async (id) => {
      const cmp = await (await fetch(`/api/m/procurement/cases/${id}/comparison`, { credentials: 'include' })).json();
      return cmp.rows.map((r: any) => ({ offerId: r.offerId, total: r.totalMinor }));
    }, caseId);
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));

    results.mutationRefresh = {
      co: 'zmiana ilosci pozycji oferty przez formularz na canvasie',
      od: 'klikniecie „Zapisz” w formularzu',
      do: 'zmiana widocznych sum w karcie zestawienia (bez przeladowania strony)',
      warunki: 'build produkcyjny, instancja e2e na wlasnym katalogu danych, Chromium, jeden worker',
      czasMs: refreshMs,
    };
    expect(refreshMs).toBeLessThan(20_000);
  });
});

/* ------------------------------- cancellation ----------------------------- */

/*
 * Its own instance, on its own reserved port, over its own data directory —
 * resolved and validated by `ScriptedInstance`, which refuses anything that is
 * not demonstrably the tests' own and stops only the process it started.
 */
const slow = new ScriptedInstance({ port: 8797, dataDirName: '.e2e-scripted-slow' });
const BASE = slow.baseUrl;

test.describe('czas anulowania', () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    slow.prepareDatabase();
    await slow.start('slow');
  });
  test.afterAll(() => slow.stop());

  test('zatrzymanie z interfejsu konczy wykonanie i nie zostawia zapisow', async ({ page }) => {
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
    const composer = page.locator('.openui-agent-thread-composer__input');
    await expect(composer).toBeVisible();
    await composer.fill('Opowiadaj dlugo, prosze.');
    const button = page.locator('.pf-chat .openui-agent-thread-composer__submit-button').first();
    await button.click();

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    // Let it produce something first, so cancelling is cancelling real work.
    await expect(page.getByTestId('streaming-answer')).toBeVisible({ timeout: 30_000 });

    const eventsBefore = await page.evaluate(async () => {
      const { threads } = await (await fetch('/api/threads/get', { credentials: 'include' })).json();
      const { runs } = await (
        await fetch(`/api/conversations/${threads[0].id}/runs`, { credentials: 'include' })
      ).json();
      const { events } = await (
        await fetch(`/api/runs/${runs[0].id}/events`, { credentials: 'include' })
      ).json();
      return { runId: runs[0].id, conversationId: threads[0].id, count: events.length };
    });

    /* ------------------------------ measurement ---------------------------- */

    const t0 = Date.now();
    // The composer's own button becomes the stop control while a run is open.
    await button.click();

    const runStatus = () =>
      page.evaluate(
        async ({ conversationId, runId }) => {
          const { runs } = await (
            await fetch(`/api/conversations/${conversationId}/runs`, { credentials: 'include' })
          ).json();
          return (runs.find((r: any) => r.id === runId)?.status ?? 'unknown') as string;
        },
        { conversationId: eventsBefore.conversationId, runId: eventsBefore.runId },
      );

    await expect.poll(runStatus, { timeout: 30_000 }).toMatch(/cancelled|failed/);
    const cancelMs = Date.now() - t0;

    // Nothing was written after the run resolved.
    await page.waitForTimeout(2000);
    const eventsAfter = await page.evaluate(
      async (runId) =>
        ((await (await fetch(`/api/runs/${runId}/events`, { credentials: 'include' })).json())
          .events as unknown[]).length,
      eventsBefore.runId,
    );
    const settled = await runStatus();

    results.cancellation = {
      co: 'zatrzymanie trwajacego wykonania przyciskiem kompozytora',
      od: 'klikniecie przycisku zatrzymania w przegladarce',
      do: 'status uruchomienia w backendzie osiaga stan koncowy',
      warunki:
        `scenariusz zamiast modelu (deterministyczna dlugosc odpowiedzi), instancja na wlasnym katalogu danych i porcie ${slow.config.port}`,
      czasMs: cancelMs,
      statusKoncowy: settled,
      zdarzenPrzed: eventsBefore.count,
      zdarzenPo: eventsAfter,
    };

    expect(cancelMs).toBeLessThan(30_000);
    // The work stopped: the event log does not keep growing after the terminal state.
    const finalCount = await page.evaluate(
      async (runId) =>
        ((await (await fetch(`/api/runs/${runId}/events`, { credentials: 'include' })).json())
          .events as unknown[]).length,
      eventsBefore.runId,
    );
    expect(finalCount).toBe(eventsAfter);
  });
});
