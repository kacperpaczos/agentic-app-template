import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import { type Locator, type Page } from '@playwright/test';
import {
  formatFieldValue,
  recordsOf,
  type DataRecord,
  type ReadResponse,
  type ReadResultDescriptor,
} from '@platform/contracts';
import { notShown, resultOf, toolResults, watchHighlights } from './support/show-value-probe.ts';

/**
 * Proby odbiorowe T25, T26 i T27 — z prawdziwym modelem.
 *
 * Rodzaj dowodu: **rzeczywisty model**. Every command below is typed into the
 * chat composer of the real production build, answered by the subscription
 * model through the application's own runtime, and judged on what the run left
 * behind: the DOM, the address bar, the client's acknowledgements of UI
 * commands, the published `ui_state` snapshots, the run's own event log
 * (`GET /api/runs/:id/events`) and the backend (`POST /api/read`). Nothing here
 * asserts on the model's wording — an agent that says the right thing and
 * changes nothing has to fail, and an agent that says nothing and does the
 * right thing has to pass.
 *
 * This is the only suite besides `agent-ui.spec.ts` and `files-agent.spec.ts`
 * that spends subscription turns, so the budget is enforced in code
 * (`MODEL_TURN_BUDGET`) rather than left to care: every command goes through
 * `sendForRun`, which counts it and refuses to send the thirteenth.
 *
 * The negative controls of each proba that are *deterministic* are not repeated
 * here with model turns — they are established without a model in
 * `e2e/show-value.spec.ts` (text-only answer, wrong record, ambiguity,
 * forbidden), `e2e/view-state.spec.ts` (empty narrowing shown as an empty
 * state, restoring the full range, data untouched) and
 * `e2e/agent-views.spec.ts` (unknown component, literal numbers, a background
 * run not hijacking the active screen). What *is* checked on every run here is
 * what only a real run can be wrong about: whether the agent reached for the
 * screen at all, whether it changed business data instead of the presentation,
 * and whether the objects it made are new and carry the backend's values.
 */

const AGENT_TIMEOUT = 420_000;

/** Turns of the subscription this file may spend, retries included (Task 8 budget). */
const MODEL_TURN_BUDGET = 12;
let modelTurns = 0;

const EVIDENCE_DIR = resolve(process.cwd(), 'docs/evidence/bl01-bl02-2026-09-17');
const CODE_COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() }).toString().trim();

/* -------------------------------------------------------------------------- */
/*  Evidence                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One file per proba, written whether it passed or not.
 *
 * Deliberately assembled from named fields rather than from whole API objects:
 * a run record carries `claudeSessionId`, which is nobody's business outside
 * the machine it was made on.
 */
function writeEvidence(name: string, body: Record<string, unknown>): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    resolve(EVIDENCE_DIR, name),
    `${JSON.stringify(
      {
        zapisano: new Date().toISOString(),
        kodCommit: CODE_COMMIT,
        zrodlo: 'prawdziwy model (subskrypcja Claude), instancja testowa suity przegladarkowej',
        spec: 'e2e/bl01-bl02-model.spec.ts',
        ...body,
      },
      null,
      2,
    )}\n`,
  );
}

const shot = async (page: Page, name: string) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: resolve(EVIDENCE_DIR, name), fullPage: false });
};

/* -------------------------------------------------------------------------- */
/*  The interface, as a user drives it                                        */
/* -------------------------------------------------------------------------- */

async function openApp(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(path);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

/**
 * Types a command into the composer and returns the run it started, together
 * with the `AppContext` the browser sent with it.
 *
 * The context is taken from the outgoing request rather than reconstructed:
 * "the command carried the state of the view" is a claim about what left the
 * browser, and the request body is the only place that is true or false.
 */
async function sendForRun(page: Page, text: string): Promise<{ runId: string; context: any }> {
  modelTurns += 1;
  expect(
    modelTurns,
    `budzet Task 8 to ${MODEL_TURN_BUDGET} tur modelu — proba wyslania tury ${modelTurns}`,
  ).toBeLessThanOrEqual(MODEL_TURN_BUDGET);

  const request = page.waitForRequest((r) => r.url().endsWith('/api/agui/run') && r.method() === 'POST');
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
  const sent = await request;
  const runId = (await sent.response())?.headers()['x-run-id'];
  expect(runId, 'naglowek X-Run-Id').toBeTruthy();
  return { runId: runId!, context: sent.postDataJSON().context };
}

/** Waits for *this* run — the strip names the run it is showing. */
async function settled(page: Page, runId: string): Promise<string> {
  const strip = page.getByTestId('run-state');
  await expect.poll(() => strip.getAttribute('data-run-id'), { timeout: AGENT_TIMEOUT }).toBe(runId);
  await expect(strip).toHaveAttribute('data-phase', /succeeded|failed/, { timeout: AGENT_TIMEOUT });
  const phase = (await strip.getAttribute('data-phase'))!;
  // One beat past the terminal phase, so what the run changed has reached the screen.
  await page.waitForTimeout(800);
  return phase;
}

async function getJson<T = any>(page: Page, path: string, body?: unknown): Promise<T> {
  const res =
    body === undefined ? await page.request.get(path) : await page.request.post(path, { data: body });
  expect(res.status(), `${path}`).toBe(200);
  return (await res.json()) as T;
}

const readBackend = (page: Page, operation: string, input?: Record<string, unknown>) =>
  getJson<ReadResponse>(page, '/api/read', { operation, ...(input ? { input } : {}) });

/** Facts about a finished run, without anything that identifies a session. */
async function runFacts(page: Page, conversationId: string, runId: string, polecenie: string) {
  const { runs } = await getJson<{ runs: Array<Record<string, any>> }>(
    page,
    `/api/conversations/${conversationId}/runs`,
  );
  const run = runs.find((r) => r.id === runId);
  const results = await toolResults(page, runId);
  return {
    runId,
    polecenie,
    status: run?.status ?? null,
    czasMs: run?.durationMs ?? null,
    pierwszyTekstMs: run?.firstTokenMs ?? null,
    wKolejceMs: run?.queuedMs ?? null,
    narzedzia: results.map((r) => r.name.replace(/^mcp__app__/, '')),
  };
}

const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);
const viewParams = (page: Page) =>
  [...new URL(page.url()).searchParams].filter(([k]) => k !== 'c' && k !== 's').sort();
const rows = (page: Page) => page.locator('[data-testid="data-page"] tbody tr');
const rowIds = (page: Page) =>
  rows(page).evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-record-id')));
const dataTable = (page: Page) => page.getByTestId('data-page').locator('[data-component="DataTable"]');
const header = (page: Page, field: string) => dataTable(page).locator(`thead th[data-field="${field}"]`);
const banner = (page: Page) => page.getByTestId('view-filter-banner');
const notice = (page: Page) => page.getByTestId('view-reveal-notice');

type Supplier = DataRecord & { id: string; name: string; country: string; taxId: string };

/** The suppliers as the backend returns them, through the endpoint the view uses. */
async function backendSuppliers(page: Page): Promise<{ raw: ReadResponse; records: Supplier[] }> {
  const raw = await readBackend(page, 'procurement.suppliers');
  return { raw, records: recordsOf(raw.result, raw.descriptor!) as Supplier[] };
}

/** The test's own ordering: Polish collation of the name, as the view must order text. */
const byName = (direction: 'asc' | 'desc') => (a: Supplier, b: Supplier) =>
  a.name.localeCompare(b.name, 'pl') * (direction === 'desc' ? -1 : 1);

const fieldOf = (descriptor: ReadResultDescriptor, name: string) =>
  descriptor.fields.find((f) => f.field === name)!;

/**
 * Business data as the module's own routes return it — the second witness that
 * a narrowing, an ordering or a revealed value changed nothing but the screen.
 */
async function businessData(page: Page) {
  return {
    suppliers: await getJson(page, '/api/m/procurement/suppliers'),
    cases: await getJson(page, '/api/m/procurement/cases'),
  };
}

/* -------------------------------------------------------------------------- */
/*  Widoki agenta                                                             */
/* -------------------------------------------------------------------------- */

const viewsPage = (page: Page) => page.getByTestId('agent-views-page');

async function openAgentViews(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Widoki agenta' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/agent-views');
}

const agentViewsOf = (page: Page, conversationId: string) =>
  getJson<{ space: { id: string } | null; cards: Array<Record<string, any>> }>(
    page,
    `/api/conversations/${conversationId}/agent-views`,
  );

/** This tab's own published description of what is on screen (Task 3). */
async function publishedSnapshot(page: Page): Promise<any> {
  const clientId = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem('platform.ui-snapshot.client') ?? '{}').clientId as string,
  );
  expect(clientId, 'karta przegladarki nie ma tozsamosci opisu ekranu').toBeTruthy();
  return (await getJson<{ snapshot: any }>(page, `/api/ui/snapshot?clientId=${clientId}`)).snapshot;
}

/** The narrowing a description reports, evaluated here rather than by the application. */
function keepsRecord(record: DataRecord, predicates: Array<{ field: string; op: string; value: unknown }>) {
  return predicates.every((p) => {
    const actual = record[p.field];
    if (actual === undefined || actual === null) return false;
    const text = String(actual);
    if (p.op === 'eq') return text === String(p.value);
    if (p.op === 'neq') return text !== String(p.value);
    if (p.op === 'contains') return text.toLowerCase().includes(String(p.value).toLowerCase());
    if (p.op === 'in') return (Array.isArray(p.value) ? p.value : [p.value]).map(String).includes(text);
    throw new Error(`nieobslugiwany operator zawezenia w tescie: ${p.op}`);
  });
}

/**
 * Every cell a data component draws equals the backend's value for that record
 * and field — whatever composition the model happened to write.
 *
 * The component's own description (`ui_state` snapshot) says which read it
 * shows and under which narrowing; the read is then performed here and the
 * expectation computed from *its* records. So the view is never compared with
 * itself, and the check does not depend on the model choosing the operation,
 * the columns or the order the test would have chosen.
 */
async function expectInstanceMatchesBackend(
  page: Page,
  scope: Page | Locator,
  instance: any,
): Promise<{ operation: string; records: DataRecord[] }> {
  const backend = await readBackend(page, instance.source.operation, instance.source.input);
  const descriptor = backend.descriptor!;
  const kept = recordsOf(backend.result, descriptor).filter((r) => keepsRecord(r, instance.filter ?? []));

  const table = scope.locator(`[data-ui-instance="${instance.instanceId}"]`);
  await expect(table).toHaveAttribute('data-state', 'ready');
  await expect(table).not.toHaveAttribute('data-refreshing', 'true');

  const shown = await table
    .locator('tbody tr[data-record-id]')
    .evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-record-id')));
  expect(shown.length, 'tabela nie pokazuje zadnego wiersza').toBeGreaterThan(0);
  // Every row on screen is a record the backend returned under this narrowing.
  expect(shown.every((id) => kept.some((r) => String(r[descriptor.record.idField]) === id))).toBe(true);
  // The description of the same instance names the same records, in screen order.
  expect(instance.visibleRecordIds).toEqual(shown);

  for (const id of shown) {
    const record = kept.find((r) => String(r[descriptor.record.idField]) === id)!;
    const cells = await table
      .locator(`td[data-record-id="${id}"][data-field]`)
      .evaluateAll((tds) => tds.map((td) => [td.getAttribute('data-field'), (td.textContent ?? '').trim()]));
    expect(cells.length, `wiersz ${id} bez komorek pol`).toBeGreaterThan(0);
    for (const [field, text] of cells as Array<[string, string]>) {
      expect(text, `${id}.${field}`).toBe(formatFieldValue(record, fieldOf(descriptor, field)).trim());
    }
  }
  return { operation: instance.source.operation, records: kept };
}

/** A chart's caption states the range of each series; the range comes from the backend. */
async function expectChartMatchesBackend(page: Page, scope: Page | Locator, instance: any): Promise<void> {
  const backend = await readBackend(page, instance.source.operation, instance.source.input);
  const descriptor = backend.descriptor!;
  const kept = recordsOf(backend.result, descriptor).filter((r) => keepsRecord(r, instance.filter ?? []));

  const figure = scope.locator(`[data-ui-instance="${instance.instanceId}"]`);
  await expect(figure).toHaveAttribute('data-state', 'ready');
  await expect(figure.locator('svg').first()).toBeVisible();

  const series = await figure
    .locator('figcaption [data-series]')
    .evaluateAll((spans) =>
      spans.map((s) => ({
        field: s.getAttribute('data-series'),
        min: s.getAttribute('data-min'),
        max: s.getAttribute('data-max'),
      })),
    );
  expect(series.length, 'wykres bez serii w podpisie').toBeGreaterThan(0);
  for (const s of series) {
    const field = fieldOf(descriptor, s.field!);
    const scale = field.type === 'money_minor' ? 100 : field.type === 'quantity_milli' ? 1000 : 1;
    const values = kept
      .map((r) => r[s.field!])
      .filter((v): v is number => typeof v === 'number')
      .map((v) => v / scale);
    expect(values.length, `seria ${s.field} bez wartosci w backendzie`).toBeGreaterThan(0);
    expect(Number(s.min), `min serii ${s.field}`).toBe(Math.min(...values));
    expect(Number(s.max), `max serii ${s.field}`).toBe(Math.max(...values));
  }
}

/**
 * The described instances that are really mounted inside "Widoki agenta".
 *
 * The description covers every data component on the page, the chat's included;
 * a table streamed into an answer is not part of this proba and must not be
 * able to fail it, nor to stand in for a card.
 */
async function instancesOnAgentViews(page: Page, snapshot: any): Promise<any[]> {
  const out: any[] = [];
  for (const instance of snapshot.instances ?? []) {
    const count = await viewsPage(page).locator(`[data-ui-instance="${instance.instanceId}"]`).count();
    if (count > 0) out.push(instance);
  }
  return out;
}

/** Changes one record's unit price through the record action, from the interface. */
async function changeUnitPrice(page: Page, table: Locator, recordId: string, typed: string) {
  const button = table.locator(
    `tr[data-record-id="${recordId}"] button[data-record-action="change_unit_price"]`,
  );
  await expect(button).toHaveCount(1);
  await button.click();
  const form = table.getByTestId('record-action-form');
  await expect(form).toHaveAttribute('data-record-id', recordId);
  await form.getByLabel('Nowa cena jednostkowa').fill(typed);
  const response = page.waitForResponse((r) => r.url().endsWith('/api/actions'));
  await form.getByRole('button', { name: 'Zapisz' }).click();
  expect((await response).status()).toBe(200);
  await expect(table.getByTestId('record-action-status')).toContainText('Zmien cene: zapisano.');
  await expect(form).toHaveCount(0);
  return (await (await response).json()) as { changed: string[] };
}

/* -------------------------------------------------------------------------- */
/*  T25                                                                       */
/* -------------------------------------------------------------------------- */

test.describe('proby odbiorowe z prawdziwym modelem', () => {
  test.describe.configure({ timeout: AGENT_TIMEOUT });

  test('T25 — pytanie o wartosc pola rekordu ukrytego zawezeniem konczy sie wskazaniem tego pola na ekranie', async ({
    page,
  }) => {
    test.setTimeout(AGENT_TIMEOUT + 120_000);
    const evidence: Record<string, any> = {
      proba: 'T25',
      kryteria: ['L2.16', 'L6.16'],
      werdykt: 'niezaliczona',
      przebiegi: [],
    };

    try {
      await openApp(page, '/data');
      await watchHighlights(page);

      const before = await backendSuppliers(page);
      const beforeBusiness = await businessData(page);
      const hidden = before.records.find((s) => s.name === 'NordAV OY');
      expect(hidden, 'zasiew nie ma dostawcy NordAV OY').toBeTruthy();
      expect(hidden!.country, 'rekord ma byc ukryty przez zawezenie do PL').not.toBe('PL');

      /* The precondition, set by the user with the controls on the screen. */
      await expect(rows(page)).toHaveCount(before.records.length);
      await dataTable(page).locator('select[data-filter-field="country"]').selectOption('PL');
      await page.getByRole('button', { name: 'Zastosuj' }).click();
      await expect.poll(() => param(page, 'country')).toBe('PL');
      await expect(page.locator(`tbody tr[data-record-id="${hidden!.id}"]`)).toHaveCount(0);
      evidence.warunekWstepny = {
        zawezenie: 'country=PL (ustawione kontrolka przez uzytkownika)',
        rekordPoszukiwany: hidden!.name,
        widocznyPrzedPoleceniem: false,
      };

      /* ------------------------ the question, as asked ----------------------- */
      const polecenie = 'Jaki NIP ma dostawca NordAV OY?';
      const { runId, context } = await sendForRun(page, polecenie);
      expect(context.ui, 'polecenie nie nioslo znacznika ekranu').toBeTruthy();
      const phase = await settled(page, runId);
      const conversationId = param(page, 'c')!;
      evidence.przebiegi.push({
        ...(await runFacts(page, conversationId, runId, polecenie)),
        wersjaEkranuPrzyWyslaniu: context.ui?.version ?? null,
      });
      expect(phase).toBe('succeeded');

      /* ------------------- the probe's detector, unchanged ------------------- */
      const taxField = fieldOf(before.raw.descriptor!, 'taxId');
      const problems = await notShown(page, runId, {
        recordKind: 'supplier',
        recordId: hidden!.id,
        field: 'taxId',
        rawValue: hidden!.taxId,
        displayedText: formatFieldValue(hidden!, taxField),
      });
      evidence.detektorT25 = problems;
      expect(problems, 'detektor proby T25 (ten sam co w e2e/show-value.spec.ts)').toEqual([]);

      /* ---------------------------- the screen ------------------------------- */
      const cell = page.locator(
        `[data-testid="data-page"] td[data-record-kind="supplier"][data-record-id="${hidden!.id}"][data-field="taxId"]`,
      );
      await expect(cell).toHaveText(hidden!.taxId);
      await expect(cell).toBeInViewport();
      // The narrowing that hid the record is gone.
      expect(param(page, 'country'), 'zawezenie, ktore ukrywalo rekord, zostalo w adresie').toBeNull();
      evidence.adresPo = viewParams(page);
      await expect(notice(page)).toHaveAttribute('data-shown', 'true');
      await expect(notice(page)).toContainText('Pole „NIP”');
      await expect(notice(page)).toContainText('NordAV OY');
      await expect(notice(page)).toContainText('dane sa bez zmian');
      const adjustments = await page
        .getByTestId('view-reveal-adjustment')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
      expect(adjustments, 'zdjecie zawezenia nie zostalo pokazane uzytkownikowi').toContain('filter_cleared');
      evidence.zmianyPrezentacji = adjustments;

      /* --------------- the tool's own answer, and the new context ------------ */
      const results = await toolResults(page, runId);
      const shownResult = resultOf(results, 'ui_show_value');
      expect(shownResult).toMatchObject({
        executed: true,
        found: true,
        shown: true,
        matchesBackend: true,
        recordKind: 'supplier',
        recordId: hidden!.id,
        field: 'taxId',
      });
      expect(shownResult.backend.rawValue).toBe(hidden!.taxId);
      expect(shownResult.revealed.rawValue).toBe(hidden!.taxId);
      evidence.wynikNarzedzia = {
        target: shownResult.target,
        found: shownResult.found,
        shown: shownResult.shown,
        matchesBackend: shownResult.matchesBackend,
        uiVersion: shownResult.uiVersion ?? null,
        url: shownResult.url ?? null,
      };

      // A new description of the screen, newer than the one the command carried.
      expect(shownResult.uiVersion, 'potwierdzenie bez wersji opisu ekranu').toBeGreaterThan(
        context.ui.version,
      );
      const snapshot = await publishedSnapshot(page);
      expect(snapshot.version).toBeGreaterThanOrEqual(shownResult.uiVersion);
      const instance = snapshot.instances.find(
        (i: any) => i.component === 'DataTable' && i.source.operation === 'procurement.suppliers',
      );
      expect(instance, 'opis ekranu bez tabeli dostawcow').toBeTruthy();
      expect(instance.filter, 'opis ekranu wciaz niesie zdjete zawezenie').toEqual([]);
      expect(instance.visibleRecordIds).toContain(hidden!.id);
      evidence.opisEkranuPo = {
        wersja: snapshot.version,
        filtr: instance.filter,
        widoczneRekordy: instance.visibleRecordIds.length,
      };

      /* ------------------------- data, untouched ----------------------------- */
      const after = await backendSuppliers(page);
      expect(after.raw.result).toEqual(before.raw.result);
      expect(await businessData(page)).toEqual(beforeBusiness);
      evidence.daneBackendu = 'identyczne przed i po';

      await shot(page, 't25-wskazana-wartosc.png');
      evidence.werdykt = 'zaliczona';
    } finally {
      evidence.turyModeluLacznie = modelTurns;
      writeEvidence('t25-wskazanie-wartosci.json', evidence);
    }
  });

  /* ------------------------------------------------------------------------ */
  /*  T26                                                                     */
  /* ------------------------------------------------------------------------ */

  test('T26 — zawezenie i sortowanie rozmowa, kolejne pytanie korzysta z zawezenia, usuniecie przywraca pelny zakres', async ({
    page,
  }) => {
    test.setTimeout(3 * AGENT_TIMEOUT);
    const evidence: Record<string, any> = {
      proba: 'T26',
      kryteria: ['L2.17', 'L6.17'],
      werdykt: 'niezaliczona',
      przebiegi: [],
    };

    try {
      await openApp(page, '/data');
      await watchHighlights(page);

      const before = await backendSuppliers(page);
      const beforeBusiness = await businessData(page);
      const polish = before.records.filter((s) => s.country === 'PL').sort(byName('desc'));
      expect(polish.length, 'zasiew nie ma kilku polskich dostawcow').toBeGreaterThan(1);
      expect(polish.length).toBeLessThan(before.records.length);

      /* ------------------------ 1. narrow and order -------------------------- */
      const first = 'Pokaz tylko polskich dostawcow, posortowanych po nazwie od Z do A.';
      const run1 = await sendForRun(page, first);
      // The first command left the view as the user had it: nothing narrowed.
      expect(run1.context.filters['procurement.data']).toMatchObject({ predicates: [], sort: null });
      const phase1 = await settled(page, run1.runId);
      const conversationId = param(page, 'c')!;
      evidence.przebiegi.push(await runFacts(page, conversationId, run1.runId, first));
      expect(phase1).toBe('succeeded');

      await expect.poll(() => rowIds(page), { timeout: 60_000 }).toEqual(polish.map((s) => s.id));
      expect(param(page, 'country')).toBe('PL');
      expect(param(page, 'sort')).toBe('-name');
      // The controls show the same state the address does.
      await expect(dataTable(page).locator('select[data-filter-field="country"]')).toHaveValue('PL');
      await expect(header(page, 'name')).toHaveAttribute('aria-sort', 'descending');
      await expect(banner(page)).toContainText('Widok zawezony przez agenta.');
      await expect(banner(page)).toContainText('Kraj (kod ISO): PL');
      await expect(page.getByTestId('view-filter-count')).toContainText(
        `pokazane ${polish.length} z ${before.records.length}`,
      );
      await expect(page.getByTestId('view-sort-state')).toHaveText('Sortowanie: Nazwa, malejaco.');

      const results1 = await toolResults(page, run1.runId);
      expect(resultOf(results1, 'ui_filter')).toMatchObject({
        executed: true,
        targetId: 'procurement.data',
        filtered: { matched: polish.length, total: before.records.length },
      });
      expect(resultOf(results1, 'ui_sort')).toMatchObject({
        executed: true,
        sorted: { field: 'name', direction: 'desc' },
      });
      // Presentation only — the model must not have "filtered" by deleting anything.
      expect((await backendSuppliers(page)).raw.result).toEqual(before.raw.result);
      expect(await businessData(page)).toEqual(beforeBusiness);
      evidence.zawezenieISortowanie = {
        adres: viewParams(page),
        wiersze: polish.map((s) => s.name),
        daneBackendu: 'identyczne przed i po',
      };
      await shot(page, 't26-zawezenie-i-sortowanie.png');

      /* ------------- 2. the next question, on the narrowed screen ------------ */
      /*
       * The follow-up is judged on the screen, not on the words: the record it
       * has to point at is the first row *of the narrowed and reordered view*.
       * An agent that ignored the narrowing would reach for a different record
       * — the unnarrowed list starts with another supplier — so the highlighted
       * cell is what proves the second turn used the state of the first.
       */
      const firstOnScreen = (await rowIds(page))[0]!;
      const expectedRecord = before.records.find((s) => s.id === firstOnScreen)!;
      expect(expectedRecord.id).toBe(polish[0]!.id);
      expect(expectedRecord.id).not.toBe(before.records[0]!.id);

      const second = 'Ktory dostawca jest teraz na pierwszym miejscu tej listy i jaki ma NIP?';
      const run2 = await sendForRun(page, second);
      // (d) The command carried the view exactly as the screen had it.
      expect(run2.context.filters['procurement.data']).toEqual({
        predicates: [{ field: 'country', op: 'eq', value: 'PL' }],
        sort: { field: 'name', direction: 'desc' },
        page: { index: 1, size: 10, count: 1 },
        matched: polish.length,
        total: before.records.length,
      });
      evidence.kontekstDrugiegoPolecenia = run2.context.filters['procurement.data'];
      const phase2 = await settled(page, run2.runId);
      evidence.przebiegi.push(await runFacts(page, conversationId, run2.runId, second));
      expect(phase2).toBe('succeeded');

      const taxField = fieldOf(before.raw.descriptor!, 'taxId');
      const problems = await notShown(page, run2.runId, {
        recordKind: 'supplier',
        recordId: expectedRecord.id,
        field: 'taxId',
        rawValue: expectedRecord.taxId,
        displayedText: formatFieldValue(expectedRecord, taxField),
      });
      evidence.detektorT25wDrugiejTurze = problems;
      expect(problems, 'druga tura nie wskazala pierwszego rekordu zawezonego widoku').toEqual([]);
      // The narrowing survived the second turn: nothing had to be cleared for it.
      expect(param(page, 'country')).toBe('PL');
      expect(param(page, 'sort')).toBe('-name');
      expect(await rowIds(page)).toEqual(polish.map((s) => s.id));
      expect(resultOf(await toolResults(page, run2.runId), 'ui_show_value').adjustments).toEqual([]);
      expect((await backendSuppliers(page)).raw.result).toEqual(before.raw.result);

      /* ---------------------- 3. remove the narrowing ------------------------ */
      const third = 'Usun zawezenie i pokaz z powrotem wszystkich dostawcow.';
      const run3 = await sendForRun(page, third);
      const phase3 = await settled(page, run3.runId);
      evidence.przebiegi.push(await runFacts(page, conversationId, run3.runId, third));
      expect(phase3).toBe('succeeded');

      await expect.poll(() => rows(page).count(), { timeout: 60_000 }).toBe(before.records.length);
      expect(param(page, 'country'), 'zawezenie zostalo w adresie').toBeNull();
      expect((await rowIds(page)).slice().sort()).toEqual(before.records.map((s) => s.id).slice().sort());
      await expect(dataTable(page).locator('select[data-filter-field="country"]')).toHaveValue('');
      await expect(page.getByTestId('view-filter-count')).toHaveCount(0);
      expect((await backendSuppliers(page)).raw.result).toEqual(before.raw.result);
      expect(await businessData(page)).toEqual(beforeBusiness);
      evidence.pelnyZakres = { adres: viewParams(page), wiersze: before.records.length };
      await shot(page, 't26-pelny-zakres.png');

      evidence.werdykt = 'zaliczona';
    } finally {
      evidence.turyModeluLacznie = modelTurns;
      writeEvidence('t26-zawezenie-rozmowa.json', evidence);
    }
  });

  /* ------------------------------------------------------------------------ */
  /*  T27                                                                     */
  /* ------------------------------------------------------------------------ */

  test('T27 — widoki agenta: zestawienie, wykres, zmiana zakresu rozmowa, mutacja danych i przeladowanie', async ({
    page,
  }) => {
    test.setTimeout(3 * AGENT_TIMEOUT);
    const evidence: Record<string, any> = {
      proba: 'T27',
      kryteria: ['L3.14', 'L3.15', 'L3.16', 'L3.17', 'L3.18'],
      werdykt: 'niezaliczona',
      przebiegi: [],
    };
    let restore: (() => Promise<void>) | null = null;

    try {
      await openApp(page, '/');
      // The working space the user is in; the conversation's own space must differ.
      await expect.poll(() => param(page, 's'), { timeout: 15_000 }).toBeTruthy();
      const workspace = param(page, 's');
      await openAgentViews(page);
      // A conversation that has no views at all, so nothing found later is a leftover.
      await expect(viewsPage(page)).toHaveAttribute('data-state', 'no-conversation');

      const { cases } = await getJson<{ cases: Array<{ id: string; code: string }> }>(
        page,
        '/api/m/procurement/cases',
      );
      const procurementCase = cases.find((c) => c.code === 'PC-2026-01')!;

      /* --------------------------- 1. the listing ---------------------------- */
      const first =
        'Zestaw mi w widokach agenta pozycje ofert ze sprawy PC-2026-01: dostawca, nazwa pozycji i cena jednostkowa.';
      const run1 = await sendForRun(page, first);
      const phase1 = await settled(page, run1.runId);
      const conversationId = param(page, 'c')!;
      evidence.rozmowa = conversationId;
      evidence.przebiegi.push(await runFacts(page, conversationId, run1.runId, first));
      expect(phase1).toBe('succeeded');

      // The cards on screen are the ones *this run* created — ids from its own tool results.
      const created1 = (await toolResults(page, run1.runId))
        .filter((r) => r.name === 'mcp__app__agent_view_create')
        .map((r) => r.result.cardId as string);
      expect(created1.length, 'wykonanie nie utworzylo zadnego widoku agenta').toBeGreaterThan(0);
      const state1 = await agentViewsOf(page, conversationId);
      expect(state1.cards.length, 'przestrzen rozmowy jest pusta').toBeGreaterThan(0);
      // Every card in this conversation's space was made by the run under test —
      // a card that was already there would not prove anything (G6).
      for (const card of state1.cards) expect(created1, 'zastana karta').toContain(card.id);
      await expect(viewsPage(page)).toHaveAttribute('data-state', 'ready');
      await expect(viewsPage(page)).toHaveAttribute('data-conversation-id', conversationId);
      // The conversation's space is its own, not the working space the user is in.
      expect(state1.space!.id).not.toBe(workspace);
      expect(param(page, 's')).toBe(workspace);

      const tableCardId = state1.cards.find((c) => JSON.stringify(c.spec ?? {}).includes('DataTable'))!.id;
      const tableCard = page.getByTestId(`card-${tableCardId}`);
      await expect(tableCard).toBeVisible();

      let snapshot = await publishedSnapshot(page);
      let onPage = await instancesOnAgentViews(page, snapshot);
      let tableInstance = onPage.find((i: any) => i.component === 'DataTable');
      expect(tableInstance, 'karta nie zamontowala tabeli danych').toBeTruthy();
      const table = await expectInstanceMatchesBackend(page, tableCard, tableInstance);
      evidence.zestawienie = {
        kartyZTegoWykonania: created1,
        operacja: table.operation,
        wierszy: tableInstance.visibleRecordIds.length,
        wersjaKompozycji: state1.cards[0]!.specVersion,
      };
      await shot(page, 't27-zestawienie.png');

      /* ---------------------------- 2. the chart ----------------------------- */
      const second = 'Dodaj do tego wykres cen jednostkowych tych pozycji.';
      const run2 = await sendForRun(page, second);
      const phase2 = await settled(page, run2.runId);
      evidence.przebiegi.push(await runFacts(page, conversationId, run2.runId, second));
      expect(phase2).toBe('succeeded');

      const state2 = await agentViewsOf(page, conversationId);
      // Nothing the first run made was lost.
      for (const id of created1) expect(state2.cards.some((c) => c.id === id)).toBe(true);
      await expect(tableCard).toBeVisible();

      snapshot = await publishedSnapshot(page);
      onPage = await instancesOnAgentViews(page, snapshot);
      const chartInstance = onPage.find((i: any) => i.component === 'DataChart');
      expect(chartInstance, 'wykonanie nie dodalo wykresu').toBeTruthy();
      const chartCardId = state2.cards.find((c) =>
        JSON.stringify(c.spec ?? {}).includes('DataChart'),
      )?.id;
      expect(chartCardId, 'zadna karta nie niesie wykresu').toBeTruthy();
      await expectChartMatchesBackend(page, page.getByTestId(`card-${chartCardId}`), chartInstance);
      evidence.wykres = {
        kartaWykresu: chartCardId,
        nowaKarta: !created1.includes(chartCardId!),
        operacja: chartInstance.source.operation,
        serie: chartInstance.fields.slice(1).map((f: any) => f.field),
      };
      await shot(page, 't27-wykres.png');

      /* ----------------------- 3. the scope, by talking ---------------------- */
      const third = 'Ogranicz zestawienie do pozycji dostawcy MediaPro Systemy.';
      const run3 = await sendForRun(page, third);
      const phase3 = await settled(page, run3.runId);
      evidence.przebiegi.push(await runFacts(page, conversationId, run3.runId, third));
      expect(phase3).toBe('succeeded');

      const state3 = await agentViewsOf(page, conversationId);
      for (const id of [...created1, chartCardId!]) {
        expect(state3.cards.some((c) => c.id === id), `karta ${id} zniknela`).toBe(true);
      }
      snapshot = await publishedSnapshot(page);
      onPage = await instancesOnAgentViews(page, snapshot);
      tableInstance =
        onPage.find((i: any) => i.component === 'DataTable' && i.instanceId === tableInstance.instanceId) ??
        onPage.find((i: any) => i.component === 'DataTable');
      const narrowed = await expectInstanceMatchesBackend(page, tableCard, tableInstance);
      const supplierNames = new Set(
        tableInstance.visibleRecordIds.map(
          (id: string) => narrowed.records.find((r) => String(r.id) === id)!.supplierName,
        ),
      );
      expect([...supplierNames], 'zakres zestawienia nie zostal ograniczony do jednego dostawcy').toEqual([
        'MediaPro Systemy',
      ]);
      expect(tableInstance.visibleRecordIds.length).toBeLessThan(
        Number(evidence.zestawienie.wierszy),
      );
      evidence.zmianaZakresu = {
        wierszy: tableInstance.visibleRecordIds.length,
        dostawcy: [...supplierNames],
        wersjaKompozycji: state3.cards.find((c) => c.id === tableCardId)!.specVersion,
      };

      /* ------- 4. a mutation from the interface, and the views after it ------- */
      const itemsBefore = await readBackend(page, 'procurement.case_offer_items', {
        caseId: procurementCase.id,
      });
      const priceField = fieldOf(itemsBefore.descriptor!, 'unitPriceMinor');
      const targetId = tableInstance.visibleRecordIds[0]!;
      const targetBefore = recordsOf(itemsBefore.result, itemsBefore.descriptor!).find(
        (r) => String(r.id) === targetId,
      )!;
      const originalTyped = String((targetBefore.unitPriceMinor as number) / 100).replace('.', ',');

      const liveTable = tableCard.locator(`[data-ui-instance="${tableInstance.instanceId}"]`);
      const hasActionHere =
        (await liveTable.locator('button[data-record-action="change_unit_price"]').count()) > 0;
      evidence.mutacja = { gdzie: hasActionHere ? 'akcja rekordu w widoku agenta' : 'akcja rekordu na ekranie sprawy' };

      let mutationTable = liveTable;
      if (!hasActionHere) {
        await page.getByRole('link', { name: 'Wszystkie sprawy' }).click();
        await page.getByTestId(`case-tile-${procurementCase.id}`).click();
        mutationTable = page
          .getByTestId('case-detail-page')
          .locator('[data-operation="procurement.case_offer_items"][data-component="DataTable"]');
        await expect(mutationTable).toHaveAttribute('data-state', 'ready');
      }

      const changed = await changeUnitPrice(page, mutationTable, targetId, '7 777,50');
      /*
       * Cleanup, not evidence: the shared instance's seed is other suites'
       * fixture, and by the time this runs the screen the action was taken on
       * may be gone. It goes through the same endpoint the button uses, with
       * its own operationId.
       */
      restore = async () => {
        const res = await page.request.post('/api/actions', {
          data: {
            operation: 'procurement.case_offer_items',
            input: { caseId: procurementCase.id },
            action: 'change_unit_price',
            recordId: targetId,
            values: { unitPrice: originalTyped },
            operationId: `t8-restore-${Date.now()}`,
          },
        });
        expect(res.status(), 'przywrocenie ceny z zasiewu').toBe(200);
      };
      expect(changed.changed.join(' ')).toContain(procurementCase.id);

      const itemsAfter = await readBackend(page, 'procurement.case_offer_items', {
        caseId: procurementCase.id,
      });
      const targetAfter = recordsOf(itemsAfter.result, itemsAfter.descriptor!).find(
        (r) => String(r.id) === targetId,
      )!;
      expect(targetAfter.unitPriceMinor).toBe(777750);
      const newText = formatFieldValue(targetAfter, priceField);
      expect(newText).toBe('7777,50 PLN');

      if (!hasActionHere) await openAgentViews(page);
      await expect(viewsPage(page)).toHaveAttribute('data-state', 'ready');
      // The agent's own view shows the changed value — no reload in between.
      await expect(
        tableCard.locator(`td[data-record-id="${targetId}"][data-field="unitPriceMinor"]`),
      ).toHaveText(newText);
      // The published description is debounced; let it catch up before reading it.
      await page.waitForTimeout(1200);
      snapshot = await publishedSnapshot(page);
      for (const instance of await instancesOnAgentViews(page, snapshot)) {
        if (instance.component === 'DataTable') await expectInstanceMatchesBackend(page, viewsPage(page), instance);
        if (instance.component === 'DataChart') await expectChartMatchesBackend(page, viewsPage(page), instance);
      }
      evidence.mutacja.rekord = targetId;
      evidence.mutacja.nowaWartosc = newText;
      evidence.mutacja.widokOdswiezonyBezPrzeladowania = true;

      /* --------------------------- 5. the reload ----------------------------- */
      await page.reload();
      await expect(viewsPage(page)).toHaveAttribute('data-conversation-id', conversationId);
      await expect(viewsPage(page)).toHaveAttribute('data-state', 'ready');
      const afterReload = await agentViewsOf(page, conversationId);
      expect(afterReload.cards.map((c) => c.id).sort()).toEqual(state3.cards.map((c) => c.id).sort());
      for (const card of afterReload.cards) await expect(page.getByTestId(`card-${card.id}`)).toBeVisible();
      await page.waitForTimeout(1200);
      snapshot = await publishedSnapshot(page);
      const restored = await instancesOnAgentViews(page, snapshot);
      expect(restored.length, 'po przeladowaniu zadna karta nie zamontowala komponentu danych').toBeGreaterThan(0);
      for (const instance of restored) {
        if (instance.component === 'DataTable') await expectInstanceMatchesBackend(page, viewsPage(page), instance);
        if (instance.component === 'DataChart') await expectChartMatchesBackend(page, viewsPage(page), instance);
      }
      await expect(
        tableCard.locator(`td[data-record-id="${targetId}"][data-field="unitPriceMinor"]`),
      ).toHaveText(newText);
      evidence.poPrzeladowaniu = {
        karty: afterReload.cards.map((c) => c.id),
        wartosciZgodneZBackendem: true,
      };
      await shot(page, 't27-po-przeladowaniu.png');

      evidence.werdykt = 'zaliczona';
    } finally {
      evidence.turyModeluLacznie = modelTurns;
      writeEvidence('t27-widoki-agenta.json', evidence);
      // The shared instance's seed is other suites' fixture; put the price back.
      if (restore) await restore().catch(() => undefined);
    }
  });
});
