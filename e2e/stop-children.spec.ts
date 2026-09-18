import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import {
  codeVersion,
  evidenceWritingRequested,
  writeMeasurementRecord,
  type Measurement,
} from '../tests/support/measurement-evidence.ts';
import { type Page } from '@playwright/test';

/**
 * Stop, counted in processes rather than in statuses.
 *
 * The existing cancellation measurement ends at the run's status in the database
 * and at its workspace disappearing. Neither would notice a process the run left
 * running, and "the work stopped" is a claim about processes. So this one counts
 * the server's **descendants** at three instants: before the command, while it
 * is working, and after the run has ended.
 *
 * **What the child process is and is not.** It is a real OS process, started by
 * the run and bound to the run's abort signal at the same boundary the Claude
 * Agent SDK sits at — so the plumbing under test (a Stop reaching something the
 * run started) is the application's own. It is **not** the SDK's own subprocess:
 * this repository spends no model turns, so whether the SDK kills *its* children
 * on abort is not shown here and stays open in docs/ACCEPTANCE.md, L11.7.
 *
 * The numbers are written to the task's evidence directory on request
 * (`APP_WRITE_EVIDENCE=1`); an ordinary run asserts everything and writes
 * nothing.
 */

const EVIDENCE_DIR = 'docs/evidence/z10-bl09';
const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-stopchildren' });
const BASE = scripted.baseUrl;

/**
 * Every process descended from `root`, from `/proc`.
 *
 * Reads the parent of each process and walks down, so a grandchild counts too.
 * The comm field is parenthesised and may contain spaces, hence the split on the
 * last `)` rather than on whitespace.
 */
function descendants(root: number): number[] {
  const parents = new Map<number, number>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(after[1]);
      if (Number.isFinite(ppid)) parents.set(Number(entry), ppid);
    } catch {
      // The process ended between the listing and the read; it is not a
      // descendant that is still running, which is all this counts.
    }
  }
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [pid, ppid] of parents) {
      if (ppid === current && !found.includes(pid)) {
        found.push(pid);
        queue.push(pid);
      }
    }
  }
  return found;
}

async function openApp(page: Page) {
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
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

const pomiary: Record<string, Measurement> = {};
/**
 * Filled from `/api/status` during the run.
 *
 * Passed to `codeVersion` **with this task's evidence directory**, which is the
 * part that is easy to get wrong: the default exclusion covers another task's
 * directory, so a record written after its own file exists would report a dirty
 * tree that is dirty only because of the file being written.
 */
let pakiety: Record<string, string> = {};

test.describe('Stop dociera do procesow uruchomienia', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    scripted.prepareDatabase();
    await scripted.start('bl09-child');
  });
  test.afterAll(async () => {
    await scripted.stop();
    writeMeasurementRecord(
      'pomiary-stop-procesy.json',
      {
        opis:
          'Stop z interfejsu mierzony w procesach: liczba procesow potomnych serwera przed ' +
          'poleceniem, w trakcie wykonania i po zakonczeniu, oraz czasy trzech momentow ' +
          '(potwierdzenie zadania, koniec strumienia w karcie, zniknniecie procesu i workspace).',
        zrodlo: 'pnpm evidence:z10 → e2e/stop-children.spec.ts (regresja szablonu)',
        wersjaKodu: codeVersion(pakiety, [EVIDENCE_DIR]),
        pomiary,
      },
      EVIDENCE_DIR,
    );
  });

  test('proces potomny uruchomienia konczy sie razem z zatrzymanym zadaniem', async ({ page }) => {
    await openApp(page);
    const serverPid = scripted.pid!;
    expect(serverPid, 'nie znam pid serwera scenariuszowego').toBeTruthy();

    pakiety = await page.evaluate(async () => {
      const status = await (await fetch('/api/status', { credentials: 'include' })).json();
      // Only the versions: a measurement record must not carry credential metadata.
      return status.versions as Record<string, string>;
    });

    const before = descendants(serverPid);

    const composer = page.locator('.openui-agent-thread-composer__input');
    await composer.fill('Uruchom dlugie obliczenia w tle.');
    await page.locator('.pf-chat [aria-label="Send message"]').first().click();

    const runState = page.getByTestId('run-state');
    await expect(runState).toHaveAttribute('data-phase', 'running', { timeout: 30_000 });
    // The run reports the process it started, so the count below is about a
    // process this run owns rather than about whatever else the box is doing.
    await expect(page.getByTestId('streaming-answer')).toContainText('[proces] pid=', {
      timeout: 30_000,
    });
    const runId = await runState.getAttribute('data-run-id');
    const workspaceDir = resolve(scripted.config.dataDir, 'workspaces', runId!);
    expect(existsSync(workspaceDir)).toBe(true);

    const during = descendants(serverPid);
    expect(
      during.length,
      `liczba procesow potomnych nie wzrosla: przed ${before.length}, w trakcie ${during.length}`,
    ).toBe(before.length + 1);
    const started = during.filter((pid) => !before.includes(pid));
    expect(started).toHaveLength(1);

    /* -------------------------------- Stop -------------------------------- */

    const cancelResponse = page.waitForResponse(
      (r) => /\/api\/runs\/[^/]+\/cancel$/.test(r.url()),
      { timeout: 30_000 },
    );
    const stop = page.getByTestId('run-stop');
    await expect(stop).toBeVisible();
    const t0 = Date.now();
    await stop.click();

    const acknowledged = await cancelResponse;
    const acknowledgedAt = Date.now();
    expect(acknowledged.status()).toBe(200);
    expect((await acknowledged.json()).cancelled).toBe(true);

    await expect(runState).toHaveAttribute('data-phase', /cancelled|failed/, { timeout: 30_000 });
    const streamEndedAt = Date.now();

    /*
     * The instant this file exists for: the process the run started is **gone**.
     * A status in the database would have been recorded either way.
     */
    await expect
      .poll(() => descendants(serverPid).filter((pid) => started.includes(pid)).length, {
        timeout: 60_000,
      })
      .toBe(0);
    const processesEndedAt = Date.now();

    const after = descendants(serverPid);
    expect(after.filter((pid) => started.includes(pid)), 'osierocony proces po Stop').toEqual([]);
    expect(after.length).toBe(before.length);
    await expect.poll(() => existsSync(workspaceDir), { timeout: 30_000 }).toBe(false);

    const warunki =
      `build produkcyjny serwowany przez backend, instancja scenariuszowa na porcie ${scripted.config.port} ` +
      'i wlasnym katalogu danych, Chromium, jeden worker; model zastapiony scenariuszem na granicy ' +
      'adaptera — proces potomny jest prawdziwym procesem systemowym zwiazanym z sygnalem przerwania ' +
      'uruchomienia, ale NIE jest procesem Claude Agent SDK (bez grantu tur modelu); 1 probka; ' +
      'procesy liczone z /proc jako potomkowie procesu serwera';

    pomiary.potwierdzenieZadania = {
      co: 'Od klikniecia Stop do odpowiedzi backendu na POST /api/runs/:id/cancel.',
      od: 'klikniecie przycisku Zatrzymaj w przegladarce',
      do: 'odpowiedz HTTP na zadanie anulowania',
      warunki,
      probkiMs: [acknowledgedAt - t0],
    };
    pomiary.koniecStrumienia = {
      co: 'Od klikniecia Stop do stanu koncowego pokazanego w karcie uruchomienia.',
      od: 'klikniecie przycisku Zatrzymaj w przegladarce',
      do: 'zdarzenie konca uruchomienia widoczne w interfejsie',
      warunki,
      probkiMs: [streamEndedAt - t0],
    };
    pomiary.koniecProcesow = {
      co: 'Od klikniecia Stop do zakonczenia procesu potomnego uruchomienia.',
      od: 'klikniecie przycisku Zatrzymaj w przegladarce',
      do: 'proces potomny zniknal z listy potomkow serwera (/proc)',
      warunki,
      probkiMs: [processesEndedAt - t0],
      uwagi:
        `Potomkowie serwera: przed ${before.length}, w trakcie ${during.length}, po ${after.length}. ` +
        'Trzy momenty sa rozdzielone: w chwili potwierdzenia workspace jeszcze istnial.',
    };

    // Ordering, not thresholds: the three instants are distinct and in this order.
    expect(acknowledgedAt - t0).toBeLessThanOrEqual(streamEndedAt - t0);
    expect(streamEndedAt - t0).toBeLessThanOrEqual(processesEndedAt - t0);
    // The record is complete whether or not it is written to disk.
    const record = writeMeasurementRecord(
      'pomiary-stop-procesy.json',
      { opis: 'kontrola kompletnosci', zrodlo: 'assercja w tescie', pomiary, wersjaKodu: codeVersion({}, [EVIDENCE_DIR]) },
      EVIDENCE_DIR,
    );
    expect(record.body).toContain('koniecProcesow');
    expect(record.written).toBe(evidenceWritingRequested());
  });
});
