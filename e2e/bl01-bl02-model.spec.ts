import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import {
  allResultsOf,
  lastResultOf,
  notShown,
  toolResults,
  watchHighlights,
} from './support/show-value-probe.ts';

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

/**
 * Turns of the subscription this file may spend, retries included.
 *
 * 12 for Task 8 (T25, T26 and the first reading of T27) and 6 more granted for
 * finishing T27 once Task 9 had fixed the two findings the first reading
 * produced. The ledger on disk carries both, turn by turn, so the second number
 * cannot quietly become a fresh start.
 */
const MODEL_TURN_BUDGET = 18;

const EVIDENCE_DIR = resolve(process.cwd(), 'docs/evidence/bl01-bl02-2026-09-17');
const CODE_COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() }).toString().trim();

/**
 * The turn ledger, kept on disk.
 *
 * The budget is for the whole task, not for one process: running T25 again
 * after fixing the test still costs a turn, and a counter that starts at zero
 * every invocation would hide exactly the spending the budget exists to
 * bound. So each command is written down before it is sent, with what it was
 * and which run it started, and the ledger is part of the evidence.
 */
const LEDGER = resolve(EVIDENCE_DIR, 'tury-modelu.json');

interface TurnLedger {
  budzet: number;
  wydane: number;
  tury: Array<{ nr: number; o: string; proba: string; polecenie: string; runId?: string; etap?: string }>;
}

/** Which grant a turn is spent from; written next to every turn in the ledger. */
const TURN_STAGE = process.env.APP_T8_STAGE ?? 'dokonczenie-T27-po-Task-9';

function readLedger(): TurnLedger {
  if (!existsSync(LEDGER)) return { budzet: MODEL_TURN_BUDGET, wydane: 0, tury: [] };
  return JSON.parse(readFileSync(LEDGER, 'utf8')) as TurnLedger;
}

function writeLedger(ledger: TurnLedger): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
}

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
async function sendForRun(page: Page, text: string, proba = ''): Promise<{ runId: string; context: any }> {
  const ledger = readLedger();
  const nr = ledger.wydane + 1;
  ledger.wydane = nr;
  ledger.tury.push({ nr, o: new Date().toISOString(), proba, polecenie: text, etap: TURN_STAGE });
  ledger.budzet = MODEL_TURN_BUDGET;
  writeLedger(ledger);
  expect(nr, `budzet Task 8 to ${MODEL_TURN_BUDGET} tur modelu — proba wyslania tury ${nr}`).toBeLessThanOrEqual(
    MODEL_TURN_BUDGET,
  );

  const request = page.waitForRequest((r) => r.url().endsWith('/api/agui/run') && r.method() === 'POST');
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
  const sent = await request;
  const runId = (await sent.response())?.headers()['x-run-id'];
  expect(runId, 'naglowek X-Run-Id').toBeTruthy();
  const updated = readLedger();
  const entry = updated.tury.find((t) => t.nr === nr);
  if (entry) entry.runId = runId!;
  writeLedger(updated);
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

/**
 * Did the run read the screen back after storing a composition?
 *
 * A fact from the run's own event log, not from anything it wrote. Task 9 made
 * `agent_view_create` / `agent_view_update` answer `rendered: false` with a
 * sentence telling the agent to read `ui_state` before describing the view;
 * whether that changed behaviour is visible here and nowhere else.
 */
const readBackAfterViewTool = (results: Array<{ name: string }>): boolean => {
  const stored = results.findIndex(
    (r) => r.name === 'mcp__app__agent_view_create' || r.name === 'mcp__app__agent_view_update',
  );
  return stored >= 0 && results.slice(stored + 1).some((r) => r.name === 'mcp__app__ui_state');
};

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
async function publishedSnapshot(page: Page): Promise<any | null> {
  const clientId = await page
    .evaluate(() => JSON.parse(sessionStorage.getItem('platform.ui-snapshot.client') ?? '{}').clientId as string)
    .catch(() => null);
  if (!clientId) return null;
  const res = await page.request.get(`/api/ui/snapshot?clientId=${clientId}`);
  if (res.status() !== 200) return null;
  return ((await res.json()) as { snapshot: any }).snapshot ?? null;
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
): Promise<{ operation: string; records: DataRecord[]; descriptor: ReadResultDescriptor }> {
  /*
   * What the instance says about itself comes first. A component whose read
   * failed has nothing to compare with the backend, and the reason it failed —
   * an operation that does not exist, an input that names no record — is the
   * finding, not a 404 from a helper.
   */
  expect(
    instance.state,
    `komponent danych nie pokazuje rekordow: ${JSON.stringify({
      error: instance.error,
      source: instance.source,
    })}`,
  ).toBe('ready');

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
  return { operation: instance.source.operation, records: kept, descriptor };
}

/** A chart's caption states the range of each series; the range comes from the backend. */
async function expectChartMatchesBackend(page: Page, scope: Page | Locator, instance: any): Promise<void> {
  expect(
    instance.state,
    `wykres nie pokazuje wartosci: ${JSON.stringify({
      error: instance.error,
      source: instance.source,
    })}`,
  ).toBe('ready');

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
  for (const instance of snapshot?.instances ?? []) {
    const count = await viewsPage(page).locator(`[data-ui-instance="${instance.instanceId}"]`).count();
    if (count > 0) out.push(instance);
  }
  return out;
}

/**
 * The instances described on "Widoki agenta", once the description has caught up.
 *
 * The description is published with a debounce and always describes the screen
 * as it was: opening the page and reading it in the same breath yields the
 * *previous* screen's instances. One run of this proba failed on exactly that
 * while the card, the composition and the data were all correct.
 */
async function describedOnAgentViews(
  page: Page,
  what: string,
  want: (all: any[]) => boolean = () => true,
): Promise<any[]> {
  let latest: any[] = [];
  await expect
    .poll(
      async () => {
        latest = await instancesOnAgentViews(page, await publishedSnapshot(page));
        return latest.length > 0 && latest.every((i) => i.state !== 'loading') && want(latest);
      },
      { timeout: 30_000, message: what },
    )
    .toBe(true);
  return latest;
}

const has = (component: string) => (all: any[]) => all.some((i) => i.component === component);

/** Changes one record's unit price through the record action, from the interface. */
async function changeUnitPrice(page: Page, table: Locator, recordId: string, typed: string) {
  const button = table.locator(
    `tr[data-record-id="${recordId}"] button[data-record-action="change_unit_price"]`,
  );
  await expect(button).toHaveCount(1);
  await button.scrollIntoViewIfNeeded();
  await button.focus();
  await page.keyboard.press('Enter');
  const form = table.getByTestId('record-action-form');
  await expect(form).toHaveAttribute('data-record-id', recordId);
  await expect(form.getByLabel('Nowa cena jednostkowa')).toBeFocused();
  await page.keyboard.type(typed);
  const response = page.waitForResponse((r) => r.url().endsWith('/api/actions'));
  await page.keyboard.press('Enter');
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
      const { runId, context } = await sendForRun(page, polecenie, 'T25');
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
      const shownResult = lastResultOf(results, 'ui_show_value');
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
      expect(snapshot, 'karta nie ma opublikowanego opisu ekranu').toBeTruthy();
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
      evidence.turyModeluWydaneLacznie = readLedger().wydane;
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
      const run1 = await sendForRun(page, first, evidence.proba as string);
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

      /*
       * The *last* narrowing and ordering of the run are what the screen shows.
       * A real model finds the value of a field by trying it: the first run of
       * this proba narrowed to "Polska", then to "Poland", each answered
       * `executed: true, matched: 0` — the platform applied exactly what it was
       * asked for and said how much was left, and the agent corrected itself.
       * Every attempt is written into the evidence below.
       */
      const results1 = await toolResults(page, run1.runId);
      expect(lastResultOf(results1, 'ui_filter')).toMatchObject({
        executed: true,
        targetId: 'procurement.data',
        filtered: { matched: polish.length, total: before.records.length },
      });
      expect(lastResultOf(results1, 'ui_sort')).toMatchObject({
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
        proByZawezenia: allResultsOf(results1, 'ui_filter').map((r: any) => ({
          url: r.url ?? null,
          cleared: r.cleared ?? null,
          filtered: r.filtered ?? null,
        })),
        proByPorzadku: allResultsOf(results1, 'ui_sort').map((r: any) => ({
          sorted: r.sorted ?? null,
          cleared: r.cleared ?? null,
        })),
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
      const run2 = await sendForRun(page, second, evidence.proba as string);
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
      expect(lastResultOf(await toolResults(page, run2.runId), 'ui_show_value').adjustments).toEqual([]);
      expect((await backendSuppliers(page)).raw.result).toEqual(before.raw.result);

      /* ---------------------- 3. remove the narrowing ------------------------ */
      const third = 'Usun zawezenie i pokaz z powrotem wszystkich dostawcow.';
      const run3 = await sendForRun(page, third, evidence.proba as string);
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
      evidence.turyModeluWydaneLacznie = readLedger().wydane;
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

      /*
       * The case is named the way a user names it: by its business code, from
       * the agent's own space, with nothing of it on screen.
       *
       * This is deliberately the scenario that failed twice before Task 9
       * (`run_39bc79cc133d4bce8fcc`, `run_24132e16b1cf49a9a624`): the agent put
       * `input: {caseId: "PC-2026-01"}` — the code where the record's id belongs
       * — without a single read first, and the card showed the refused read
       * instead of values. The fix is a rule in the prompt and in the tool's own
       * description, so it is tested where it broke.
       */
      evidence.scenariusz =
        'T27 — uzytkownik nazywa sprawe jej kodem; polecenie wyslane z przestrzeni „Widoki agenta” ' +
        '(scenariusz, ktory przed Task 9 oblal dwukrotnie)';

      /* --------------------------- 1. the listing ---------------------------- */
      // The working space as it is at the moment of the command; agent views must not move it.
      const workspaceAtCommand = param(page, 's');
      const first =
        'Zestaw mi w widokach agenta pozycje ofert ze sprawy PC-2026-01: dostawca, nazwa pozycji i cena jednostkowa.';
      const run1 = await sendForRun(page, first, evidence.proba as string);
      const phase1 = await settled(page, run1.runId);
      const conversationId = param(page, 'c')!;
      evidence.rozmowa = conversationId;
      evidence.przebiegi.push(await runFacts(page, conversationId, run1.runId, first));
      expect(phase1).toBe('succeeded');

      // The cards on screen are the ones *this run* created — ids from its own tool results.
      const results1 = await toolResults(page, run1.runId);
      const created1 = results1
        .filter((r) => r.name === 'mcp__app__agent_view_create')
        .map((r) => r.result.cardId as string);
      evidence.odpowiedziNarzedzia = {
        zestawienie: allResultsOf(results1, 'agent_view_create').map((r: any) => ({
          rendered: r.rendered ?? null,
          maZdanieReadBack: typeof r.readBack === 'string' && r.readBack.length > 0,
          warnings: (r.warnings ?? []).map((w: any) => w.code),
        })),
        odczytalEkranPoZapisie: readBackAfterViewTool(results1),
      };
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
      expect(state1.space!.id).not.toBe(workspaceAtCommand);
      expect(param(page, 's')).toBe(workspaceAtCommand);

      const withTable = state1.cards.find((c) => JSON.stringify(c.spec ?? {}).includes('DataTable'));
      expect(withTable, 'zestawienie nie jest tabela danych').toBeTruthy();
      const tableCardId = withTable!.id;
      const tableCard = page.getByTestId(`card-${tableCardId}`);
      await expect(tableCard).toBeVisible();

      let onPage = await describedOnAgentViews(
        page,
        'opis ekranu Widokow agenta po zestawieniu',
        has('DataTable'),
      );
      let tableInstance = onPage.find((i: any) => i.component === 'DataTable');
      expect(tableInstance, 'karta nie zamontowala tabeli danych').toBeTruthy();
      // The described table really is inside the card this run created.
      await expect(tableCard.locator(`[data-ui-instance="${tableInstance.instanceId}"]`)).toHaveCount(1);
      // Written down before it is judged, so a refused or failing composition is
      // in the evidence with what the run composed rather than only as a stack.
      evidence.zestawienie = {
        kartyZTegoWykonania: created1,
        kompozycja: state1.cards.map((c) => ({ id: c.id, title: c.title, spec: c.spec })),
        zrodloInstancji: tableInstance.source,
        stanInstancji: tableInstance.state,
        bladInstancji: tableInstance.error,
        wierszy: tableInstance.visibleRecordIds.length,
        wersjaKompozycji: state1.cards[0]!.specVersion,
      };
      const table = await expectInstanceMatchesBackend(page, viewsPage(page), tableInstance);
      evidence.zestawienie.operacja = table.operation;
      await shot(page, 't27-zestawienie.png');

      /* ---------------------------- 2. the chart ----------------------------- */
      /*
       * The step that produced finding F2 (`run_96c52b19607e4a21a589`, before
       * Task 9). The agent patched its card with a money series over items
       * priced in PLN *and* EUR; the server stored it, the component refused to
       * draw — „Seria Cena jednostkowa laczy rozne jednostki (PLN, EUR)" — and
       * the agent told the user the chart was there, because nothing in the
       * tool's answer said otherwise.
       *
       * Task 9's answer now carries `rendered: false`, a `readBack` sentence and
       * a `unit_from_record` warning for exactly this shape of series, and the
       * "## Stan ekranu" rule covers `agent_view_*`. The step is unchanged, so
       * what it measures is whether that reaches the model's behaviour: the
       * chart on screen has to be `ready` with a range equal to the backend's,
       * and `evidence.odpowiedziNarzedzia.wykres` records the warning and
       * whether the run read the screen back.
       */
      const second = 'Dodaj do tego wykres cen jednostkowych tych pozycji.';
      const run2 = await sendForRun(page, second, evidence.proba as string);
      const phase2 = await settled(page, run2.runId);
      evidence.przebiegi.push(await runFacts(page, conversationId, run2.runId, second));
      expect(phase2).toBe('succeeded');

      const results2 = await toolResults(page, run2.runId);
      evidence.odpowiedziNarzedzia.wykres = {
        zapisy: [
          ...allResultsOf(results2, 'agent_view_create'),
          ...allResultsOf(results2, 'agent_view_update'),
        ].map((r: any) => ({
          rendered: r.rendered ?? null,
          unchanged: r.unchanged ?? null,
          warnings: (r.warnings ?? []).map((w: any) => w.code),
        })),
        odczytalEkranPoZapisie: readBackAfterViewTool(results2),
      };
      const state2 = await agentViewsOf(page, conversationId);
      // Nothing the first run made was lost.
      for (const id of created1) expect(state2.cards.some((c) => c.id === id)).toBe(true);
      await expect(tableCard).toBeVisible();

      onPage = await describedOnAgentViews(
        page,
        'opis ekranu Widokow agenta po dodaniu wykresu',
        (all) => has('DataChart')(all) && has('DataTable')(all),
      );
      const chartInstance = onPage.find((i: any) => i.component === 'DataChart');
      expect(chartInstance, 'wykonanie nie dodalo wykresu').toBeTruthy();
      const chartCardId = state2.cards.find((c) =>
        JSON.stringify(c.spec ?? {}).includes('DataChart'),
      )?.id;
      expect(chartCardId, 'zadna karta nie niesie wykresu').toBeTruthy();
      await expect(
        page.getByTestId(`card-${chartCardId}`).locator(`[data-ui-instance="${chartInstance.instanceId}"]`),
      ).toHaveCount(1);
      /*
       * A chart that draws, or a refusal that says why — and nothing in between.
       *
       * The case's sixteen items are priced in PLN and in EUR. A money series
       * carries the record's own currency, so `buildChartModel` will not put two
       * units on one axis; whether the agent hits that depends on whether it
       * narrows the series itself, and both outcomes are honest. What must never
       * happen is the third thing: an empty card, invented numbers, or a stored
       * composition reported as a drawn chart.
       *
       * So both arms are asserted, and the assertions are the same strength:
       *
       *   ready  → the series range equals `POST /api/read` for its own source;
       *   error  → the component states the refusal on screen, draws no series
       *            and no chart body, the tool's answer said `rendered: false`
       *            with the `unit_from_record` warning that predicted it, and
       *            the run read the screen back before answering.
       *
       * Step 3 then requires that after the scope is settled by conversation,
       * this same card is `ready` with the backend's range — so the refusal path
       * cannot be an end state either.
       */
      const chartFigure = viewsPage(page).locator(`[data-ui-instance="${chartInstance.instanceId}"]`);
      const storedChart = [
        ...allResultsOf(results2, 'agent_view_create'),
        ...allResultsOf(results2, 'agent_view_update'),
      ];
      expect(storedChart.length, 'wykonanie nie zapisalo kompozycji z wykresem').toBeGreaterThan(0);
      // Storing a composition is not drawing it, and every answer has to say so.
      for (const stored of storedChart) {
        expect(stored.rendered, 'wynik narzedzia twierdzi, ze karta narysowala kompozycje').toBe(false);
        expect(typeof stored.readBack === 'string' && stored.readBack.length > 0).toBe(true);
      }

      evidence.wykres = {
        kartaWykresu: chartCardId,
        nowaKarta: !created1.includes(chartCardId!),
        operacja: chartInstance.source.operation,
        serie: chartInstance.fields.slice(1).map((f: any) => f.field),
        stanPoDodaniu: chartInstance.state,
        bladPoDodaniu: chartInstance.error,
        odczytalEkranPoZapisie: readBackAfterViewTool(results2),
      };

      if (chartInstance.state === 'ready') {
        await expectChartMatchesBackend(page, viewsPage(page), chartInstance);
        evidence.wykres.sciezka = 'narysowany od razu (model sam zawezil serie do jednej jednostki)';
      } else {
        expect(
          chartInstance.state,
          `wykres ani nie rysuje, ani nie odmawia: ${JSON.stringify(chartInstance.error)}`,
        ).toBe('error');
        expect(chartInstance.error?.code).toBe('validation_failed');
        expect(chartInstance.error?.message, 'odmowa nie mowi o jednostkach').toMatch(/jednostk/);

        // On screen: the refusal is stated where the chart would have been...
        await expect(chartFigure).toHaveAttribute('data-state', 'error');
        const alert = chartFigure.locator('[role="alert"][data-testid="query-error"]');
        await expect(alert).toHaveAttribute('data-error-code', 'validation_failed');
        await expect(alert).toContainText(chartInstance.error.message);
        // ...and nothing is drawn, summarised or invented in its place.
        await expect(chartFigure.locator('figcaption [data-series]')).toHaveCount(0);
        await expect(chartFigure.locator('.pf-data__chart')).toHaveCount(0);
        expect(chartInstance.visibleRecordIds).toEqual([]);

        // The warning that predicted it travelled with the tool's own answer...
        expect(
          storedChart.some((r: any) => (r.warnings ?? []).some((w: any) => w.code === 'unit_from_record')),
          'zapis serii z jednostka z rekordu nie zostal ostrzezony',
        ).toBe(true);
        // ...and the run read the screen back instead of reporting a drawn chart.
        expect(
          readBackAfterViewTool(results2),
          'wykonanie nie odczytalo ekranu po zapisaniu kompozycji',
        ).toBe(true);
        evidence.wykres.sciezka = 'odmowa rysowania, opisana na ekranie i odczytana przez wykonanie';
      }

      await shot(page, 't27-wykres.png');

      /* ----------------------- 3. the scope, by talking ---------------------- */
      const third = 'Zawez zestawienie i wykres do pozycji w PLN.';
      const run3 = await sendForRun(page, third, evidence.proba as string);
      const phase3 = await settled(page, run3.runId);
      evidence.przebiegi.push(await runFacts(page, conversationId, run3.runId, third));
      expect(phase3).toBe('succeeded');

      const results3 = await toolResults(page, run3.runId);
      evidence.odpowiedziNarzedzia.zmianaZakresu = {
        zapisy: allResultsOf(results3, 'agent_view_update').map((r: any) => ({
          rendered: r.rendered ?? null,
          unchanged: r.unchanged ?? null,
          warnings: (r.warnings ?? []).map((w: any) => w.code),
        })),
        odczytalEkranPoZapisie: readBackAfterViewTool(results3),
      };
      const state3 = await agentViewsOf(page, conversationId);
      for (const id of [...created1, chartCardId!]) {
        expect(state3.cards.some((c) => c.id === id), `karta ${id} zniknela`).toBe(true);
      }
      onPage = await describedOnAgentViews(
        page,
        'opis ekranu Widokow agenta po zmianie zakresu',
        (all) => has('DataTable')(all) && has('DataChart')(all),
      );
      tableInstance =
        onPage.find((i: any) => i.component === 'DataTable' && i.instanceId === tableInstance.instanceId) ??
        onPage.find((i: any) => i.component === 'DataTable');
      const narrowed = await expectInstanceMatchesBackend(page, viewsPage(page), tableInstance);
      const idField = narrowed.descriptor.record.idField;
      const currencies = new Set(
        tableInstance.visibleRecordIds.map(
          (id: string) => narrowed.records.find((r) => String(r[idField]) === id)?.currency ?? '?',
        ),
      );
      expect([...currencies], 'zakres zestawienia nie zostal ograniczony do jednej waluty').toEqual(['PLN']);
      expect(tableInstance.visibleRecordIds.length).toBeLessThan(
        Number(evidence.zestawienie.wierszy),
      );

      /*
       * Now the chart has a single unit, so it has to draw — and what it draws
       * has to be the backend's range for its own narrowed source. This is the
       * assertion that step 2 could not make honestly.
       */
      const chartAfter =
        onPage.find((i: any) => i.component === 'DataChart' && i.instanceId === chartInstance.instanceId) ??
        onPage.find((i: any) => i.component === 'DataChart');
      expect(chartAfter, 'wykres zniknal przy zmianie zakresu').toBeTruthy();
      // The same card, not a new one put in its place.
      await expect(
        page.getByTestId(`card-${chartCardId}`).locator(`[data-ui-instance="${chartAfter.instanceId}"]`),
      ).toHaveCount(1);
      await expectChartMatchesBackend(page, viewsPage(page), chartAfter);
      evidence.wykres.stanPoZmianieZakresu = chartAfter.state;

      evidence.zmianaZakresu = {
        waluty: [...currencies],
        wierszy: tableInstance.visibleRecordIds.length,
        wersjaKompozycji: state3.cards.find((c) => c.id === tableCardId)!.specVersion,
      };

      /* ------- 4. a mutation from the interface, and the views after it ------- */
      const itemsBefore = await readBackend(page, 'procurement.case_offer_items', {
        caseId: procurementCase.id,
      });
      const priceField = fieldOf(itemsBefore.descriptor!, 'unitPriceMinor');
      const items = recordsOf(itemsBefore.result, itemsBefore.descriptor!);
      /*
       * The record action belongs to the offer-items read. If the agent composed
       * its view over that read, the change is made inside the agent's own view;
       * if it composed it over another one (the comparison, say), the same
       * action is taken on the case screen and the view has to follow anyway.
       */
      const showsItems = tableInstance.source.operation === 'procurement.case_offer_items';
      const targetId = showsItems
        ? tableInstance.visibleRecordIds[0]!
        : String(
            items.find(
              (r) => r.supplierName === 'MediaPro Systemy' && typeof r.unitPriceMinor === 'number',
            )!.id,
          );
      const targetBefore = items.find((r) => String(r.id) === targetId)!;
      expect(targetBefore, 'rekord do zmiany nie jest pozycja oferty').toBeTruthy();
      const originalTyped = String((targetBefore.unitPriceMinor as number) / 100).replace('.', ',');

      /*
       * A witness that the page was never reloaded between the change and the
       * view showing it: a reload would drop this marker with the whole
       * JavaScript context.
       */
      await page.evaluate(() => {
        (window as unknown as { __t8NoReload?: boolean }).__t8NoReload = true;
      });

      const liveTable = tableCard.locator(`[data-ui-instance="${tableInstance.instanceId}"]`);
      const hasActionHere =
        showsItems &&
        (await liveTable.locator(`tr[data-record-id="${targetId}"] button[data-record-action="change_unit_price"]`).count()) > 0;
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
      // A literal too, so the formatter cannot only agree with itself.
      if (targetAfter.currency === 'PLN') expect(newText).toBe('7777,50 PLN');

      if (!hasActionHere) await openAgentViews(page);
      await expect(viewsPage(page)).toHaveAttribute('data-state', 'ready');
      // The agent's own view shows the changed value, and no reload happened.
      if (showsItems) {
        await expect(
          tableCard.locator(`td[data-record-id="${targetId}"][data-field="unitPriceMinor"]`),
        ).toHaveText(newText);
      }
      for (const instance of await describedOnAgentViews(page, 'opis ekranu Widokow agenta po zmianie danych')) {
        if (instance.component === 'DataTable') await expectInstanceMatchesBackend(page, viewsPage(page), instance);
        if (instance.component === 'DataChart') await expectChartMatchesBackend(page, viewsPage(page), instance);
      }
      const withoutReload = await page.evaluate(
        () => (window as unknown as { __t8NoReload?: boolean }).__t8NoReload === true,
      );
      expect(withoutReload, 'strona zostala przeladowana miedzy zmiana a odczytem widoku').toBe(true);
      evidence.mutacja.rekord = targetId;
      evidence.mutacja.nowaWartosc = newText;
      evidence.mutacja.widokOdswiezonyBezPrzeladowania = withoutReload;

      /* --------------------------- 5. the reload ----------------------------- */
      await page.reload();
      await expect(viewsPage(page)).toHaveAttribute('data-conversation-id', conversationId);
      await expect(viewsPage(page)).toHaveAttribute('data-state', 'ready');
      await page.evaluate(() => {
        (window as unknown as { __t8SinceReload?: boolean }).__t8SinceReload = true;
      });
      const afterReload = await agentViewsOf(page, conversationId);
      expect(afterReload.cards.map((c) => c.id).sort()).toEqual(state3.cards.map((c) => c.id).sort());
      for (const card of afterReload.cards) await expect(page.getByTestId(`card-${card.id}`)).toBeVisible();
      const restored = await describedOnAgentViews(page, 'opis ekranu Widokow agenta po przeladowaniu');
      expect(restored.length, 'po przeladowaniu zadna karta nie zamontowala komponentu danych').toBeGreaterThan(0);
      for (const instance of restored) {
        if (instance.component === 'DataTable') await expectInstanceMatchesBackend(page, viewsPage(page), instance);
        if (instance.component === 'DataChart') await expectChartMatchesBackend(page, viewsPage(page), instance);
      }
      if (showsItems) {
        await expect(
          tableCard.locator(`td[data-record-id="${targetId}"][data-field="unitPriceMinor"]`),
        ).toHaveText(newText);
      }
      evidence.poPrzeladowaniu = {
        karty: afterReload.cards.map((c) => c.id),
        wartosciZgodneZBackendem: true,
      };
      await shot(page, 't27-po-przeladowaniu.png');

      /* ------------- 6. away to another conversation, and back --------------- */
      /*
       * The space belongs to the conversation, not to the screen. Leaving for a
       * new chat has to empty the page, and coming back — the way a user comes
       * back, from the conversation drawer — has to bring the same cards with
       * the same values, without a reload.
       */
      const { threads } = await getJson<{ threads: Array<{ id: string; title: string }> }>(
        page,
        '/api/threads/get',
      );
      const title = threads.find((t) => t.id === conversationId)!.title;

      /*
       * The header icon, not the large button in the drawer.
       *
       * Both carry `aria-label="New chat"`. The large one lives inside the
       * conversation drawer, off-canvas while it is closed, so a click on it
       * lands on whatever is underneath — on "Widoki agenta" that is the React
       * Flow pane, which is what happened on `run_9411a0c692a04d8f822c`: the
       * click retried until the test timed out and step 6 was never reached.
       * `e2e/session-restore.spec.ts` documents the same trap.
       */
      await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();
      await expect(viewsPage(page)).toHaveAttribute('data-state', 'no-conversation');
      await expect(page.getByTestId(`card-${tableCardId}`)).toHaveCount(0);

      const drawer = page.locator('.openui-agent-sidebar-container');
      if ((await drawer.getAttribute('data-sidebar-visual-state')) !== 'expanded') {
        await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
      }
      await expect(drawer).toHaveAttribute('data-sidebar-visual-state', 'expanded');
      // Let the drawer finish sliding, so the click lands on the row and not where it was.
      await page.waitForTimeout(500);
      const row = page.locator('.openui-agent-thread-button', { hasText: title }).first();
      await expect(row).toBeVisible();
      // `force`: the list re-renders while it loads and never settles for the stability check.
      await row.click({ force: true });
      await expect.poll(() => param(page, 'c'), { timeout: 30_000 }).toBe(conversationId);

      await expect(viewsPage(page)).toHaveAttribute('data-conversation-id', conversationId);
      await expect(viewsPage(page)).toHaveAttribute('data-state', 'ready');
      const afterSwitch = await agentViewsOf(page, conversationId);
      expect(afterSwitch.cards.map((c) => c.id).sort()).toEqual(state3.cards.map((c) => c.id).sort());
      for (const card of afterSwitch.cards) await expect(page.getByTestId(`card-${card.id}`)).toBeVisible();
      for (const instance of await describedOnAgentViews(page, 'opis ekranu po powrocie do rozmowy')) {
        if (instance.component === 'DataTable') await expectInstanceMatchesBackend(page, viewsPage(page), instance);
        if (instance.component === 'DataChart') await expectChartMatchesBackend(page, viewsPage(page), instance);
      }
      const stillWithoutReload = await page.evaluate(
        () => (window as unknown as { __t8SinceReload?: boolean }).__t8SinceReload === true,
      );
      evidence.poPowrocieDoRozmowy = {
        karty: afterSwitch.cards.map((c) => c.id),
        bezPrzeladowaniaOdOstatniego: stillWithoutReload,
        wartosciZgodneZBackendem: true,
      };

      evidence.werdykt = 'zaliczona';
    } finally {
      evidence.turyModeluWydaneLacznie = readLedger().wydane;
      writeEvidence('t27-widoki-agenta.json', evidence);
      // The shared instance's seed is other suites' fixture; put the price back.
      if (restore) await restore().catch(() => undefined);
    }
  });

  /* ------------------------------------------------------------------------ */
  /*  T27, kroki 5-6 — trwalosc przestrzeni rozmowy                           */
  /* ------------------------------------------------------------------------ */

  /**
   * Reload and a change of conversation, on compositions a model really wrote.
   *
   * The probe above reached these two steps on `run_893c41ea783949bdbb7a` — the
   * cards came back after the reload with their ids and were all on screen —
   * and then this file's own poll threw on a description the reload had just
   * retired, before the values could be compared. That was a fault of the test,
   * and the turns for a third full pass of the probe were gone, so the last turn
   * of the budget buys exactly the part that was never checked: one command,
   * then a mutation, a reload and a walk out of the conversation and back, all
   * driven from the interface and none of it costing a turn.
   *
   * The command asks for items in PLN so that the summary is unambiguous
   * without a second turn; whether a chart appears is recorded rather than
   * required — what is required is that whatever the agent composed comes back,
   * with the backend's values, after the reload and after the conversation
   * switch.
   */
  test('T27 (kroki 5-6) — przeladowanie i powrot do rozmowy odtwarzaja kompozycje modelu z wartosciami backendu', async ({
    page,
  }) => {
    test.setTimeout(AGENT_TIMEOUT + 240_000);
    const evidence: Record<string, any> = {
      proba: 'T27 — kroki 5 i 6',
      kryteria: ['L3.14', 'L3.16', 'L3.17', 'L3.18'],
      werdykt: 'niezaliczona',
      przebiegi: [],
    };
    let restore: (() => Promise<void>) | null = null;

    try {
      await openApp(page, '/');
      await expect.poll(() => param(page, 's'), { timeout: 15_000 }).toBeTruthy();
      const workspace = param(page, 's');
      await openAgentViews(page);
      await expect(viewsPage(page)).toHaveAttribute('data-state', 'no-conversation');

      const { cases } = await getJson<{ cases: Array<{ id: string; code: string }> }>(
        page,
        '/api/m/procurement/cases',
      );
      const procurementCase = cases.find((c) => c.code === 'PC-2026-01')!;

      /* ------------------------- the agent's view ---------------------------- */
      const command =
        'Zestaw mi w widokach agenta pozycje ofert w PLN ze sprawy PC-2026-01: dostawca, ' +
        'nazwa pozycji i cena jednostkowa, a pod spodem wykres tych cen.';
      const run = await sendForRun(page, command, evidence.proba as string);
      const phase = await settled(page, run.runId);
      const conversationId = param(page, 'c')!;
      evidence.rozmowa = conversationId;
      evidence.przebiegi.push(await runFacts(page, conversationId, run.runId, command));
      expect(phase).toBe('succeeded');

      const results = await toolResults(page, run.runId);
      const created = results
        .filter((r) => r.name === 'mcp__app__agent_view_create')
        .map((r) => r.result.cardId as string);
      expect(created.length, 'wykonanie nie utworzylo zadnego widoku agenta').toBeGreaterThan(0);
      const before = await agentViewsOf(page, conversationId);
      expect(before.cards.length).toBeGreaterThan(0);
      for (const card of before.cards) expect(created, 'zastana karta').toContain(card.id);
      expect(before.space!.id).not.toBe(workspace);
      evidence.kartyZTegoWykonania = created;
      evidence.odczytalEkranPoZapisie = readBackAfterViewTool(results);

      const settle = async (what: string) => {
        const mounted = await describedOnAgentViews(page, what, has('DataTable'));
        for (const instance of mounted) {
          if (instance.component === 'DataTable') {
            await expectInstanceMatchesBackend(page, viewsPage(page), instance);
          }
          if (instance.component === 'DataChart' && instance.state === 'ready') {
            await expectChartMatchesBackend(page, viewsPage(page), instance);
          }
        }
        return mounted;
      };
      const mountedFirst = await settle('opis ekranu Widokow agenta po zlozeniu widoku');
      evidence.komponenty = mountedFirst.map((i: any) => ({
        component: i.component,
        state: i.state,
        operation: i.source.operation,
        rekordow: i.visibleRecordIds.length,
      }));

      /* ------------------ a mutation, from the interface --------------------- */
      const itemsTable = mountedFirst.find(
        (i: any) => i.component === 'DataTable' && i.source.operation === 'procurement.case_offer_items',
      );
      let targetId: string | null = null;
      let newText: string | null = null;

      if (itemsTable && itemsTable.visibleRecordIds.length > 0) {
        const itemsBefore = await readBackend(page, 'procurement.case_offer_items', {
          caseId: procurementCase.id,
        });
        const priceField = fieldOf(itemsBefore.descriptor!, 'unitPriceMinor');
        const items = recordsOf(itemsBefore.result, itemsBefore.descriptor!);
        const recordId: string = itemsTable.visibleRecordIds[0]!;
        targetId = recordId;
        const targetBefore = items.find((r) => String(r.id) === recordId)!;
        const originalTyped = String((targetBefore.unitPriceMinor as number) / 100).replace('.', ',');

        const live = viewsPage(page).locator(`[data-ui-instance="${itemsTable.instanceId}"]`);
        const hasAction =
          (await live
            .locator(`tr[data-record-id="${recordId}"] button[data-record-action="change_unit_price"]`)
            .count()) > 0;
        expect(hasAction, 'tabela widoku agenta nie daje akcji rekordu tego odczytu').toBe(true);

        await changeUnitPrice(page, live, recordId, '7 777,50');
        restore = async () => {
          const res = await page.request.post('/api/actions', {
            data: {
              operation: 'procurement.case_offer_items',
              input: { caseId: procurementCase.id },
              action: 'change_unit_price',
              recordId,
              values: { unitPrice: originalTyped },
              operationId: `t8-restore-${Date.now()}`,
            },
          });
          expect(res.status(), 'przywrocenie ceny z zasiewu').toBe(200);
        };

        const itemsAfter = await readBackend(page, 'procurement.case_offer_items', {
          caseId: procurementCase.id,
        });
        const targetAfter = recordsOf(itemsAfter.result, itemsAfter.descriptor!).find(
          (r) => String(r.id) === recordId,
        )!;
        expect(targetAfter.unitPriceMinor).toBe(777750);
        newText = formatFieldValue(targetAfter, priceField);
        if (targetAfter.currency === 'PLN') expect(newText).toBe('7777,50 PLN');
        await expect(
          viewsPage(page).locator(`td[data-record-id="${recordId}"][data-field="unitPriceMinor"]`),
        ).toHaveText(newText);
        evidence.mutacja = { rekord: recordId, nowaWartosc: newText, gdzie: 'akcja rekordu w widoku agenta' };
      } else {
        evidence.mutacja = { pominieta: 'widok nie czyta operacji z akcja rekordu' };
      }

      /* ----------------------------- the reload ------------------------------ */
      await page.reload();
      await expect(viewsPage(page)).toHaveAttribute('data-conversation-id', conversationId);
      await expect(viewsPage(page)).toHaveAttribute('data-state', 'ready');
      const afterReload = await agentViewsOf(page, conversationId);
      expect(afterReload.cards.map((c) => c.id).sort()).toEqual(before.cards.map((c) => c.id).sort());
      for (const card of afterReload.cards) await expect(page.getByTestId(`card-${card.id}`)).toBeVisible();
      await settle('opis ekranu Widokow agenta po przeladowaniu');
      if (targetId && newText) {
        await expect(
          viewsPage(page).locator(`td[data-record-id="${targetId}"][data-field="unitPriceMinor"]`),
        ).toHaveText(newText);
      }
      evidence.poPrzeladowaniu = { karty: afterReload.cards.map((c) => c.id), wartosciZgodneZBackendem: true };
      await shot(page, 't27-kroki-5-6-po-przeladowaniu.png');

      /* ------------------ out of the conversation, and back ------------------ */
      const { threads } = await getJson<{ threads: Array<{ id: string; title: string }> }>(
        page,
        '/api/threads/get',
      );
      const title = threads.find((t) => t.id === conversationId)!.title;

      /*
       * The header icon, not the large button in the drawer.
       *
       * Both carry `aria-label="New chat"`. The large one lives inside the
       * conversation drawer, off-canvas while it is closed, so a click on it
       * lands on whatever is underneath — on "Widoki agenta" that is the React
       * Flow pane, which is what happened on `run_9411a0c692a04d8f822c`: the
       * click retried until the test timed out and step 6 was never reached.
       * `e2e/session-restore.spec.ts` documents the same trap.
       */
      await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();
      await expect(viewsPage(page)).toHaveAttribute('data-state', 'no-conversation');
      for (const card of afterReload.cards) {
        await expect(page.getByTestId(`card-${card.id}`)).toHaveCount(0);
      }

      const drawer = page.locator('.openui-agent-sidebar-container');
      if ((await drawer.getAttribute('data-sidebar-visual-state')) !== 'expanded') {
        await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
      }
      await expect(drawer).toHaveAttribute('data-sidebar-visual-state', 'expanded');
      // Let the drawer finish sliding, so the click lands on the row and not where it was.
      await page.waitForTimeout(500);
      const row = page.locator('.openui-agent-thread-button', { hasText: title }).first();
      await expect(row).toBeVisible();
      // `force`: the list re-renders while it loads and never settles for the stability check.
      await row.click({ force: true });
      await expect.poll(() => param(page, 'c'), { timeout: 30_000 }).toBe(conversationId);

      await expect(viewsPage(page)).toHaveAttribute('data-conversation-id', conversationId);
      await expect(viewsPage(page)).toHaveAttribute('data-state', 'ready');
      const afterSwitch = await agentViewsOf(page, conversationId);
      expect(afterSwitch.cards.map((c) => c.id).sort()).toEqual(before.cards.map((c) => c.id).sort());
      for (const card of afterSwitch.cards) await expect(page.getByTestId(`card-${card.id}`)).toBeVisible();
      await settle('opis ekranu Widokow agenta po powrocie do rozmowy');
      if (targetId && newText) {
        await expect(
          viewsPage(page).locator(`td[data-record-id="${targetId}"][data-field="unitPriceMinor"]`),
        ).toHaveText(newText);
      }
      evidence.poPowrocieDoRozmowy = {
        karty: afterSwitch.cards.map((c) => c.id),
        wartosciZgodneZBackendem: true,
      };
      await shot(page, 't27-kroki-5-6-po-powrocie.png');

      evidence.werdykt = 'zaliczona';
    } finally {
      evidence.turyModeluWydaneLacznie = readLedger().wydane;
      writeEvidence('t27-kroki-5-6.json', evidence);
      if (restore) await restore().catch(() => undefined);
    }
  });
});
