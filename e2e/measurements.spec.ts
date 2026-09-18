import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import {
  codeVersion,
  writeMeasurementRecord,
  type CodeVersion,
  type Measurement,
} from '../tests/support/measurement-evidence.ts';

/**
 * Timings taken through the interface, with their conditions stated.
 *
 * A number without its conditions is not a measurement, so each result records
 * what was measured, from which instant to which, on what, and at which commit.
 * Two of these cannot be taken from the backend alone:
 *
 *  - **refresh after a mutation** is the time until the *new value is on
 *    screen*, not until a fetch resolves;
 *  - **cancellation** starts at the user's click, and is three instants rather
 *    than one: the backend acknowledging the request, the tab seeing the run
 *    end, and the run's processes actually being gone. Collapsing them into a
 *    single number makes it impossible to say which of the three a result is
 *    about — and it is the third that answers "has the work stopped".
 *
 * The backend counterpart of these measurements, with the samples and the
 * "no text means no metric" case, is `tests/measurements.test.ts`. Results are
 * written to the evidence directory rather than only asserted, so the report
 * quotes measurements instead of restating claims.
 */

const pomiary: Record<string, Measurement> = {};
let wersjaKodu: CodeVersion = codeVersion();

test.afterAll(() => {
  writeMeasurementRecord('pomiary-przegladarka.json', {
    opis:
      'Pomiary przez interfejs: widoczne odswiezenie po mutacji oraz Stop rozdzielony na ' +
      'potwierdzenie zadania, koniec strumienia widziany w karcie i koniec procesow uruchomienia.',
    zrodlo: 'pnpm test:e2e → e2e/measurements.spec.ts (regresja szablonu)',
    wersjaKodu,
    pomiary,
  });
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

    pomiary.widoczneOdswiezeniePoMutacji = {
      co: 'zmiana ilosci pozycji oferty przez formularz na canvasie',
      od: 'klikniecie „Zapisz” w formularzu',
      do: 'zmiana widocznych sum w karcie zestawienia (bez przeladowania strony)',
      warunki:
        'build produkcyjny serwowany przez backend, instancja e2e na wlasnym katalogu danych, ' +
        'Chromium, jeden worker, bez modelu (mutacja idzie przez formularz, nie przez agenta); 1 probka',
      probkiMs: [refreshMs],
    };
    expect(refreshMs).toBeLessThan(20_000);
  });
});

/* ------------------------------- cancellation ----------------------------- */

/**
 * A canary credential in the server's environment.
 *
 * The run below is a whole turn on a production build, so its captured output
 * is the honest place to ask whether a credential reaches the logs. The value
 * is fabricated and never leaves this repository.
 */
const CANARY = 'sk-ant-kanarek-e2e-z3bl05-0123456789abcdef';
const LOG_FILE = 'docs/evidence/z3-bl05/log-serwera-scenariuszowego.txt';

/*
 * Its own instance, on its own reserved port, over its own data directory —
 * resolved and validated by `ScriptedInstance`, which refuses anything that is
 * not demonstrably the tests' own and stops only the process it started.
 */
const slow = new ScriptedInstance({
  port: 8797,
  dataDirName: '.e2e-scripted-slow',
  env: { ANTHROPIC_API_KEY: CANARY, ANTHROPIC_AUTH_TOKEN: CANARY },
  logFile: LOG_FILE,
});
const BASE = slow.baseUrl;

test.describe('czas anulowania', () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    slow.prepareDatabase();
    if (slow.logPath) rmSync(slow.logPath, { force: true });
    await slow.start('stop-measurement');
  });
  test.afterAll(() => slow.stop());

  test('zatrzymanie z interfejsu: potwierdzenie, koniec strumienia i koniec procesow to trzy momenty', async ({
    page,
  }) => {
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

    wersjaKodu = codeVersion(
      await page.evaluate(async () => {
        const status = await (await fetch('/api/status', { credentials: 'include' })).json();
        // Only the versions: this record must not carry credential metadata.
        return status.versions as Record<string, string>;
      }),
    );

    const criteriaBefore = await page.evaluate(async () => {
      const { cases } = await (await fetch('/api/m/procurement/cases', { credentials: 'include' })).json();
      const detail = await (
        await fetch(`/api/m/procurement/cases/${cases[0].id}`, { credentials: 'include' })
      ).json();
      return JSON.stringify(detail.criteria);
    });

    const composer = page.locator('.openui-agent-thread-composer__input');
    await expect(composer).toBeVisible();
    await composer.fill('Opowiadaj dlugo, prosze.');
    const button = page.locator('.pf-chat .openui-agent-thread-composer__submit-button').first();
    await button.click();

    const runState = page.getByTestId('run-state');
    await expect(runState).toHaveAttribute('data-phase', 'running', { timeout: 30_000 });
    // Let it produce something first, so cancelling is cancelling real work.
    await expect(page.getByTestId('streaming-answer')).toBeVisible({ timeout: 30_000 });

    const runId = await runState.getAttribute('data-run-id');
    expect(runId, 'karta nie pokazuje identyfikatora uruchomienia').toBeTruthy();
    const workspaceDir = resolve(slow.config.dataDir, 'workspaces', runId!);
    expect(existsSync(workspaceDir), 'workspace uruchomienia nie istnieje przed Stop').toBe(true);

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
    expect(eventsBefore.runId).toBe(runId);

    /* ------------------------------ measurement ---------------------------- */

    // Waited for before the click, so the response cannot be missed.
    const cancelResponse = page.waitForResponse(
      (r) => /\/api\/runs\/[^/]+\/cancel$/.test(r.url()),
      { timeout: 30_000 },
    );

    /*
     * The platform's own Stop, against this named run — not the composer's.
     *
     * The composer's control ends the stream *locally* as part of its own
     * behaviour, so a tab that stopped that way stops receiving events and can
     * never see the run end. Measuring "the stream ended" through it would
     * measure the library closing a socket, not the run finishing.
     */
    const stop = page.getByTestId('run-stop');
    await expect(stop).toBeVisible();
    const t0 = Date.now();
    await stop.click();

    const acknowledged = await cancelResponse;
    const acknowledgedAt = Date.now();
    expect(acknowledged.status()).toBe(200);
    expect((await acknowledged.json()).cancelled).toBe(true);
    /*
     * The first separation, asserted rather than assumed: the backend has heard
     * the request and the run's processes are still there. A single number
     * would have to mean either this instant or the one below, and they are not
     * the same event.
     */
    expect(existsSync(workspaceDir), 'workspace zniknal juz przy potwierdzeniu Stop').toBe(true);

    // Second instant: the tab sees the run end — the terminal event reached the
    // browser over the AG-UI stream.
    await expect(runState).toHaveAttribute('data-phase', /cancelled|failed/, { timeout: 30_000 });
    const streamEndedAt = Date.now();

    // Third instant: the run's processes are gone — its workspace has been
    // removed from disk and the backend no longer lists it as in flight.
    await expect
      .poll(
        async () => {
          if (existsSync(workspaceDir)) return false;
          const active = await page.evaluate(async () => {
            const { runs } = await (await fetch('/api/runs/active', { credentials: 'include' })).json();
            return (runs as Array<{ id: string }>).map((r) => r.id);
          });
          return !active.includes(runId!);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    const processesEndedAt = Date.now();

    const runStatus = () =>
      page.evaluate(
        async ({ conversationId, runId: id }) => {
          const { runs } = await (
            await fetch(`/api/conversations/${conversationId}/runs`, { credentials: 'include' })
          ).json();
          return (runs.find((r: any) => r.id === id)?.status ?? 'unknown') as string;
        },
        { conversationId: eventsBefore.conversationId, runId: runId! },
      );
    await expect.poll(runStatus).toMatch(/cancelled|failed/);
    const settled = await runStatus();

    const warunki =
      'build produkcyjny serwowany przez backend, instancja scenariuszowa na wlasnym porcie ' +
      `${slow.config.port} i wlasnym katalogu danych, Chromium, jeden worker; model zastapiony ` +
      'scenariuszem na granicy adaptera (proces Claude Agent SDK nie jest uruchamiany); 1 probka';

    pomiary.stopPotwierdzenieZadania = {
      co: 'potwierdzenie zadania Stop przez backend',
      od: 'klikniecie przycisku zatrzymania w przegladarce',
      do: 'odpowiedz HTTP 200 z POST /api/runs/:id/cancel',
      warunki: `${warunki}; w tym momencie workspace uruchomienia jeszcze istnieje — asertowane`,
      probkiMs: [acknowledgedAt - t0],
    };
    pomiary.stopKoniecStrumieniaWKarcie = {
      co: 'zakonczenie strumienia uruchomienia widziane przez karte uzytkownika',
      od: 'klikniecie przycisku zatrzymania w przegladarce',
      do: 'pasek stanu w stronie pokazuje faze koncowa (zdarzenie konca doszlo strumieniem AG-UI)',
      warunki,
      probkiMs: [streamEndedAt - t0],
    };
    pomiary.stopKoniecProcesow = {
      co: 'zakonczenie procesow uruchomienia',
      od: 'klikniecie przycisku zatrzymania w przegladarce',
      do: 'workspace uruchomienia zniknal z dysku i uruchomienie nie wystepuje w /api/runs/active',
      warunki,
      probkiMs: [processesEndedAt - t0],
      uwagi:
        'Mierzone z zewnatrz procesu serwera: katalog na dysku i lista zadan w locie. ' +
        'Zakonczenia procesu potomnego Claude Agent SDK ten przebieg nie obejmuje, bo SDK nie jest uruchamiany.',
    };

    expect(acknowledgedAt).toBeLessThanOrEqual(streamEndedAt);
    expect(streamEndedAt).toBeLessThanOrEqual(processesEndedAt);
    expect(settled).toMatch(/cancelled|failed/);

    /* ------------------------ no further mutations ------------------------- */

    await page.waitForTimeout(3000);
    const eventsAfter = await page.evaluate(
      async (id) =>
        ((await (await fetch(`/api/runs/${id}/events`, { credentials: 'include' })).json())
          .events as unknown[]).length,
      runId!,
    );
    const finalCount = await page.evaluate(
      async (id) =>
        ((await (await fetch(`/api/runs/${id}/events`, { credentials: 'include' })).json())
          .events as unknown[]).length,
      runId!,
    );
    // The work stopped: the event log does not keep growing after the terminal state.
    expect(finalCount).toBe(eventsAfter);

    /*
     * The domain is the real test. The cancelled scenario's next step was a
     * write through the module's own handler, so this assertion can fail.
     */
    const criteriaAfter = await page.evaluate(async () => {
      const { cases } = await (await fetch('/api/m/procurement/cases', { credentials: 'include' })).json();
      const detail = await (
        await fetch(`/api/m/procurement/cases/${cases[0].id}`, { credentials: 'include' })
      ).json();
      return JSON.stringify(detail.criteria);
    });
    expect(criteriaAfter, 'domena zmieniona po anulowaniu').toBe(criteriaBefore);
    const changedEvents = await page.evaluate(async (id) => {
      const { events } = await (
        await fetch(`/api/runs/${id}/events`, { credentials: 'include' })
      ).json();
      return (events as Array<{ payload: any }>).filter(
        (e) => e.payload?.name === 'platform.data_changed',
      ).length;
    }, runId!);
    expect(changedEvents, 'anulowane uruchomienie zglosilo zmiane danych').toBe(0);

    /* ------------------------- the queue still works ----------------------- */

    await composer.fill('Odpowiedz krotko po zatrzymaniu.');
    await button.click();
    await expect(runState).toHaveAttribute('data-phase', 'running', { timeout: 30_000 });
    const nextRunId = await runState.getAttribute('data-run-id');
    expect(nextRunId).not.toBe(runId);
    await expect(runState).toHaveAttribute('data-phase', 'succeeded', { timeout: 60_000 });
    await expect(page.getByText('Krotka odpowiedz')).toBeVisible({ timeout: 30_000 });

    const runsAfter = await page.evaluate(async (conversationId) => {
      const { runs } = await (
        await fetch(`/api/conversations/${conversationId}/runs`, { credentials: 'include' })
      ).json();
      return (runs as Array<{ id: string; status: string }>).map((r) => ({ id: r.id, status: r.status }));
    }, eventsBefore.conversationId);
    expect(runsAfter.find((r) => r.id === nextRunId)?.status).toBe('succeeded');
    expect(runsAfter.find((r) => r.id === runId)?.status).toMatch(/cancelled|failed/);
  });
});

/* ------------------------------ secrets in logs --------------------------- */

test.describe('diagnostyka serwera po przebiegu', () => {
  test('log serwera z pelnego przebiegu nie zawiera wartosci poswiadczenia', async () => {
    // Read after the instance has been stopped by the previous block's
    // `afterAll`, so everything it printed on the way out is in the file too.
    const log = slow.readLog();
    expect(log.length, 'nie przechwycono zadnego wyjscia serwera').toBeGreaterThan(0);
    // The run above happened on this server, with the canary in its environment.
    expect(log).toContain('[scripted] scenariusz=stop-measurement');
    expect(log, 'wartosc poswiadczenia w logu serwera').not.toContain(CANARY);
    expect(log, 'fragment poswiadczenia w logu serwera').not.toContain(CANARY.slice(0, 20));
    // The scan can fail: the same check over text that does contain the value finds it.
    expect(`ANTHROPIC_API_KEY=${CANARY}`).toContain(CANARY);

    /*
     * The scan above ran on the file as written. What is kept as evidence has
     * the machine's own paths replaced: this is a template meant to be
     * published, and an absolute home directory is not part of the finding.
     */
    writeFileSync(
      slow.logPath!,
      [
        '# Wyjscie serwera scenariuszowego (stdout + stderr) z pelnej tury, przechwycone przez',
        '# e2e/measurements.spec.ts. Skan na obecnosc wartosci poswiadczenia wykonano na tresci',
        '# sprzed podmiany sciezek; ponizej katalogi maszyny zastapione znacznikami.',
        '',
        log.split(slow.config.repoRoot).join('<repo>').split(homedir()).join('<home>'),
      ].join('\n'),
    );
  });
});
