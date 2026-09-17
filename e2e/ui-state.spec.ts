import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * The agent reads what the user's screen shows — versioned, and only its own
 * conversation's screen (BL-01: L6.15, L6.17).
 *
 * Symulacja: a scripted model at the adapter boundary; the browser, the built
 * frontend, the runtime, the UI command gate and every tool handler (`ui_state`,
 * `ui_filter`, `get_context`) are the real ones. What the agent was told is read
 * back from the conversation's stored tool results; what the screen shows is
 * read from the screen; the data is compared with `POST /api/read` — never with
 * a value written into this file, except the fixture facts named where used.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-uistate' });
const BASE = scripted.baseUrl;

async function openApp(page: Page, path = '/') {
  await page.goto(`${BASE}${path}`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${BASE}${path}`);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

async function send(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

const settled = (page: Page) =>
  expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', { timeout: 60_000 });

const rows = (page: Page) => page.locator('[data-testid="data-page"] tbody tr');
const answer = (page: Page) => page.locator('.pf-chat');

const getJson = (page: Page, path: string) =>
  page.evaluate(async (p) => (await fetch(p, { credentials: 'include' })).json(), path);

const postJson = (page: Page, path: string, body: unknown) =>
  page.evaluate(
    async ([p, b]) =>
      (
        await fetch(p as string, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(b),
        })
      ).json(),
    [path, body] as const,
  );

/** The tab's identity, as the tab keeps it. */
const clientIdOf = (page: Page) =>
  page.evaluate(() => JSON.parse(sessionStorage.getItem('platform.ui-snapshot.client') ?? '{}').clientId as string);

/** This tab's latest published description, once it satisfies `ok`. */
async function published(page: Page, ok: (s: any) => boolean): Promise<any> {
  const clientId = await clientIdOf(page);
  expect(clientId).toMatch(/^ui_/);
  let last: any = null;
  await expect
    .poll(
      async () => {
        last = (await getJson(page, `/api/ui/snapshot?clientId=${clientId}`)).snapshot;
        return Boolean(last && ok(last));
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return last;
}

const tableReady = (s: any) => s.instances.some((i: any) => i.component === 'DataTable' && i.state === 'ready');

async function conversationOnScreen(page: Page): Promise<string> {
  let id: string | null = null;
  await expect
    .poll(() => (id = new URL(page.url()).searchParams.get('c')), { timeout: 20_000 })
    .toBeTruthy();
  return id!;
}

/** Stored results of one tool in a conversation, in call order, as text (shortened by the runtime past 4000 characters). */
async function rawToolResults(page: Page, conversationId: string, tool: string): Promise<string[]> {
  const messages: Array<Record<string, any>> = await getJson(page, `/api/threads/get/${conversationId}`);
  const calls = new Map<string, string>();
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) calls.set(call.id, call.function.name);
  }
  return messages
    .filter((m) => m.role === 'tool' && calls.get(m.toolCallId) === `mcp__app__${tool}`)
    .map((m) => m.content as string);
}

/** Results of one tool in a conversation, in call order, parsed. */
async function toolResults(page: Page, conversationId: string, tool: string): Promise<any[]> {
  return (await rawToolResults(page, conversationId, tool)).map((text) => JSON.parse(text));
}

/** Suppliers the backend returns for this owner, and those from one country. */
async function suppliers(page: Page, country?: string) {
  const read = await postJson(page, '/api/read', { operation: 'procurement.suppliers' });
  const all = read.result.suppliers as Array<{ id: string; name: string; country: string }>;
  return { read, ids: all.filter((s) => !country || s.country === country).map((s) => s.id), all };
}

/**
 * Independent oracle for the composition version: FNV-1a 32 over UTF-16 code
 * units with the length prefix, as the contract states it. Written out here
 * rather than imported, so a change of the shared function is caught.
 */
function fnvVersion(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${source.length.toString(36)}-${hash.toString(16).padStart(8, '0')}`;
}

test.describe('agent odczytuje wersjonowany opis ekranu', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });
  test.afterEach(() => scripted.stop());

  test('wejscie na zawezony link: opis ma widok, DataTable, pola z etykietami, predykat i widoczne rekordy z backendu', async ({ page }) => {
    await scripted.start('ui-state-read');
    await openApp(page, '/data?country=PL');
    await expect(rows(page)).toHaveCount(3);

    const { read, ids: polish, all } = await suppliers(page, 'PL');
    const onScreen = await rows(page).evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-record-id')));
    expect(onScreen).toEqual(polish);

    const snap = await published(page, (s) => s.url.includes('country=PL') && tableReady(s));
    const { views } = await getJson(page, '/api/ui/views');
    const definition = views.find((v: any) => v.id === 'procurement.data');

    expect(snap.target).toEqual({ id: 'procurement.data', kind: 'view', label: 'Dostawcy' });
    expect(snap.view).toEqual({
      id: 'procurement.data',
      title: definition.title,
      compositionVersion: fnvVersion(definition.composition),
    });
    expect(snap.actions).toEqual(['navigate', 'filter', 'sort']);
    expect(snap.instances).toHaveLength(1);

    const table = snap.instances[0];
    expect(table).toMatchObject({
      component: 'DataTable',
      viewId: 'procurement.data',
      source: { operation: 'procurement.suppliers' },
      state: 'ready',
      record: { kind: 'supplier', idField: 'id' },
      error: null,
      matched: polish.length,
      total: all.length,
    });
    // Fields in the composition's order, labelled as the read's descriptor labels them.
    const labelOf = (f: string) => read.descriptor.fields.find((d: any) => d.field === f).label;
    expect(table.fields.map((f: any) => [f.field, f.label])).toEqual(
      ['name', 'taxId', 'country', 'contactEmail'].map((f) => [f, labelOf(f)]),
    );
    expect(table.fields.find((f: any) => f.field === 'country').label).toBe('Kraj'); // fixture literal
    expect(table.filter).toEqual([{ field: 'country', op: 'eq', value: 'PL' }]);
    expect(table.visibleRecordIds).toEqual(polish);
    const foreign = all.find((s) => s.name.startsWith('NordAV'))!; // the fixture's one Finnish supplier
    expect(table.visibleRecordIds).not.toContain(foreign.id);

    /* The agent reads the same description, for the conversation it runs in. */
    await send(page, 'Co mam teraz na ekranie?');
    await settled(page);
    await expect(answer(page)).toContainText('[call:ui_state] {"stale":false,"version":');
    const conversationId = await conversationOnScreen(page);
    const [result] = await toolResults(page, conversationId, 'ui_state');
    expect(result.stale).toBe(false);
    expect(result.snapshot.clientId).toBe(snap.clientId);
    expect(result.snapshot.conversationId).toBe(conversationId);
    expect(result.version).toBeGreaterThanOrEqual(snap.version);
    expect(result.snapshot.view).toEqual(snap.view);
    expect(result.snapshot.instances[0].filter).toEqual(table.filter);
    expect(result.snapshot.instances[0].visibleRecordIds).toEqual(polish);
  });

  test('po ui_filter agent czyta potwierdzony nowy stan, a kolejne polecenie niesie wersje z chwili wyslania', async ({ page }) => {
    await scripted.restart('ui-state-after-filter');
    await openApp(page, '/data');
    await expect(rows(page)).toHaveCount(4);
    const { ids: polish, all } = await suppliers(page, 'PL');
    const clientId = await clientIdOf(page);

    await send(page, 'Pokaz tylko polskich dostawcow i opisz ekran.');
    // The visible effect of the command…
    await expect(rows(page)).toHaveCount(polish.length, { timeout: 60_000 });
    await settled(page);
    const conversationId = await conversationOnScreen(page);

    const [before, after] = await toolResults(page, conversationId, 'ui_state');
    const [filtered] = await toolResults(page, conversationId, 'ui_filter');
    const [context] = await toolResults(page, conversationId, 'get_context');

    // Before the command: the full list, no predicate.
    expect(before.stale).toBe(false);
    expect(before.snapshot.instances[0].filter).toEqual([]);
    expect(before.snapshot.instances[0].matched).toBe(all.length);

    // The acknowledgement carries the version published after the narrowing, and whose version it is…
    expect(filtered).toMatchObject({ executed: true, filtered: { matched: polish.length, total: all.length } });
    expect(filtered).toMatchObject({ uiClientId: clientId, uiPublication: 'published' });
    expect(filtered.uiVersion).toBeGreaterThan(before.version);
    // What the user sees of it: the narrowed view says so, with the view's own count.
    await expect(page.getByTestId('view-filter-count')).toContainText(`${polish.length} z ${all.length}`);
    await expect(answer(page)).toContainText('Opisalem ekran po zawezeniu.');

    // …and ui_state asked for at least that version gets the new state.
    expect(after.stale).toBe(false);
    expect(after.reason).toBeUndefined();
    expect(after.version).toBeGreaterThanOrEqual(filtered.uiVersion);
    expect(after.snapshot.clientId).toBe(clientId);
    expect(after.snapshot.url).toContain('country=PL');
    expect(after.snapshot.instances[0].filter).toEqual([{ field: 'country', op: 'eq', value: 'PL' }]);
    expect(after.snapshot.instances[0].visibleRecordIds).toEqual(polish);
    const onScreen = await rows(page).evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-record-id')));
    expect(after.snapshot.instances[0].visibleRecordIds).toEqual(onScreen);

    // The command's own context: the tab's marker at send time, older than the narrowed screen.
    expect(context.ui.clientId).toBe(clientId);
    expect(context.ui.viewId).toBe('procurement.data');
    expect(context.ui.version).toBeLessThanOrEqual(before.version);
    expect(context.ui.version).toBeLessThan(filtered.uiVersion);

    /* The next command carries the version on screen when it is sent. */
    let atSend = 0;
    await expect
      .poll(
        async () => {
          const first = (await getJson(page, `/api/ui/snapshot?clientId=${clientId}`)).snapshot.version;
          await page.waitForTimeout(800);
          atSend = (await getJson(page, `/api/ui/snapshot?clientId=${clientId}`)).snapshot.version;
          return atSend === first;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(atSend).toBeGreaterThanOrEqual(filtered.uiVersion);

    await send(page, 'A teraz jeszcze raz opisz ekran.');
    await expect.poll(async () => (await toolResults(page, conversationId, 'get_context')).length, { timeout: 60_000 }).toBe(2);
    await settled(page);
    const [, nextContext] = await toolResults(page, conversationId, 'get_context');
    expect(nextContext.ui).toMatchObject({ version: atSend, clientId, viewId: 'procurement.data' });
    expect(nextContext.ui.url).toContain('country=PL');
  });

  test('minVersion wyzsze niz jakakolwiek publikacja daje stale=true po oczekiwaniu', async ({ page }) => {
    await scripted.restart('ui-state-future-version');
    await openApp(page, '/data');
    await expect(rows(page)).toHaveCount(4);

    await send(page, 'Opisz ekran w wersji, ktorej jeszcze nie ma.');
    await settled(page);
    await expect(answer(page)).toContainText('[call:ui_state] {"stale":true,"reason":"older_than_requested"');

    const conversationId = await conversationOnScreen(page);
    const [result] = await toolResults(page, conversationId, 'ui_state');
    const clientId = await clientIdOf(page);
    const server = (await getJson(page, `/api/ui/snapshot?clientId=${clientId}`)).snapshot;
    expect(result).toMatchObject({ stale: true, reason: 'older_than_requested' });
    // The older description is still handed over, marked — never passed off as the requested one.
    expect(result.snapshot.clientId).toBe(clientId);
    expect(result.version).toBeLessThan(1_000_000);
    expect(server.version).toBeLessThan(1_000_000);

    // It did wait for the requested version before answering.
    const { runs } = await getJson(page, `/api/conversations/${conversationId}/runs`);
    expect(runs[0].durationMs).toBeGreaterThanOrEqual(1500);
  });

  test('bardzo dlugi zawezony adres: polecenie nadal sie wysyla, a opis niesie adres skrocony z flaga', async ({ page }) => {
    await scripted.restart('ui-state-read');
    // A narrowing the agent itself may apply: one field, forty 200-character values.
    const values = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(2, '0')}${'Q'.repeat(198)}`);
    await openApp(page, `/data?country=${values.join(',')}`);
    expect(page.url().length).toBeGreaterThan(2000);
    // What the screen shows: nothing matches, and it says so.
    await expect(page.locator('[data-testid="data-page"] [data-ui-instance]')).toHaveAttribute('data-state', 'empty');

    await send(page, 'Co mam teraz na ekranie?');
    await settled(page);
    await expect(answer(page)).toContainText('[call:ui_state] {"stale":false,"version":');

    const conversationId = await conversationOnScreen(page);
    // The agent's answer is longer than the runtime stores; its verdict is at the start.
    const [raw] = await rawToolResults(page, conversationId, 'ui_state');
    const told = /^\{"stale":false,"version":(\d+),/.exec(raw!);
    expect(told, raw!.slice(0, 120)).not.toBeNull();
    // The same evaluation, in full, from the backend.
    const current = await getJson(page, `/api/ui/snapshot?conversationId=${conversationId}`);
    expect(current.stale).toBe(false);
    expect(current.version).toBeGreaterThanOrEqual(Number(told![1]));
    expect(current.snapshot.clientId).toBe(await clientIdOf(page));
    expect(current.snapshot.urlTruncated).toBe(true);
    expect(current.snapshot.url).toHaveLength(2000);
    expect(current.snapshot.url.startsWith('/data?')).toBe(true);
    // The narrowing itself is not cut: the component describes all forty values.
    expect(current.snapshot.instances[0]).toMatchObject({ state: 'empty', matched: 0 });
    expect(current.snapshot.instances[0].filter).toEqual([{ field: 'country', op: 'in', value: values }]);
  });

  test('karta otwarta wprost na ekranie bez komponentow danych opisuje go; karty przestrzeni znane poza canvasem', async ({ page }) => {
    await scripted.restart('ui-state-read');
    await openApp(page, '/settings');
    await expect(page.getByTestId('settings-page')).toBeVisible();
    const settings = await published(page, (s) => s.url.startsWith('/settings') && s.target?.id === 'platform.settings');
    expect(settings).toMatchObject({
      target: { id: 'platform.settings', kind: 'view', label: 'Ustawienia' },
      view: null,
      instances: [],
      actions: ['navigate'],
    });

    // The active space's cards, on a screen that is not the canvas and without ever opening it.
    const { spaces } = await getJson(page, '/api/canvas/spaces');
    const space = await getJson(page, `/api/canvas/spaces/${spaces[0].id}`);
    await page.goto(`${BASE}/data?s=${spaces[0].id}`);
    await expect(rows(page)).toHaveCount(4);
    const onData = await published(page, (s) => s.url.startsWith('/data') && s.spaceId === spaces[0].id && tableReady(s));
    expect(onData.cards).toEqual(
      space.cards.map((c: any) => ({
        cardId: c.id,
        title: c.title,
        kind: c.spec.kind,
        component: c.spec.kind === 'component' ? c.spec.component : 'openui',
        specVersion: c.specVersion,
      })),
    );
  });

  test('zamknieta karta nie jest juz ekranem rozmowy: zadanie w tle nie dostaje jej ostatniego opisu', async ({ page, context }) => {
    await scripted.restart('ui-state-late');
    await openApp(page, '/data');
    await send(page, 'Popracuj w tle i na koniec opisz moj ekran.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', { timeout: 30_000 });
    const conversationA = await conversationOnScreen(page);

    // The sending tab moves to a new conversation…
    await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();
    await published(page, (s) => s.conversationId === null);

    // …while a second tab shows conversation A, and is then closed.
    const second = await context.newPage();
    await second.goto(`${BASE}/data?c=${conversationA}`);
    await expect(second.locator('.openui-agent-thread-composer__input')).toBeVisible();
    const secondId = await clientIdOf(second);
    expect(secondId).not.toBe(await clientIdOf(page));
    await published(second, (s) => s.conversationId === conversationA);
    await second.close();
    await expect
      .poll(async () => (await getJson(page, `/api/ui/snapshot?clientId=${secondId}`)).snapshot, { timeout: 10_000 })
      .toBeNull();

    await expect
      .poll(async () => (await getJson(page, `/api/conversations/${conversationA}/runs`)).runs[0]?.status, {
        timeout: 60_000,
      })
      .toBe('succeeded');
    const [result] = await toolResults(page, conversationA, 'ui_state');
    expect(result).toEqual({ stale: true, reason: 'other_conversation', version: null, capturedAt: null, ageMs: null, snapshot: null });
  });

  test('przelaczenie tozsamosci na Ustawieniach: nowy wlasciciel nie dostaje tabeli z czatu ani rozmowy poprzedniego', async ({ page }) => {
    await scripted.restart('chat-data-table');
    await openApp(page, '/settings');
    await send(page, 'Pokaz dostawcow tutaj w rozmowie.');
    await settled(page);
    const table = page.locator('.pf-chat [data-ui-instance][data-component="DataTable"]');
    await expect(table).toHaveAttribute('data-state', 'ready');
    const { ids: mine } = await suppliers(page);
    const conversationId = await conversationOnScreen(page);
    const clientId = await clientIdOf(page);

    // As the first owner: the chat's table and the conversation are described.
    const before = await published(
      page,
      (s) => s.conversationId === conversationId && s.instances.some((i: any) => i.component === 'DataTable' && i.state === 'ready'),
    );
    expect(before.instances.find((i: any) => i.component === 'DataTable').visibleRecordIds).toEqual(mine);

    // The switch, on Settings, with the table still on screen in the chat.
    const owner = page.getByTestId('access-owner');
    const was = (await owner.textContent())?.trim() ?? '';
    await page.getByTestId('switch-access-context').click();
    await expect(owner).not.toHaveText(was);
    await expect(table).toHaveAttribute('data-state', 'ready'); // not re-rendered: still the first owner's rows

    // What the new owner's backend holds for this tab (the page's session is now the new owner's).
    const after = await published(page, (s) => s.target?.id === 'platform.settings');
    expect(after.clientId).toBe(clientId);
    expect(after.conversationId).not.toBe(conversationId);
    expect(after.conversationId).toBeNull();
    const text = JSON.stringify(after);
    for (const id of mine) expect(text).not.toContain(id);
    expect(after.instances.some((i: any) => i.state === 'ready' && i.matched === mine.length)).toBe(false);
  });

  test('wykonanie rozmowy A, gdy przegladarka pokazuje B, dostaje other_conversation', async ({ page }) => {
    await scripted.restart('ui-state-late');
    await openApp(page, '/data');
    const other = await postJson(page, '/api/threads/create', {
      messages: [{ role: 'user', content: 'Rozmowa B' }],
    });

    await send(page, 'Popracuj w tle i na koniec opisz moj ekran.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', { timeout: 30_000 });
    const conversationA = await conversationOnScreen(page);

    // The user moves to conversation B before the task reads the screen.
    await page.goto(`${BASE}/data?c=${other.id}`);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    await published(page, (s) => s.conversationId === other.id);

    await expect
      .poll(async () => (await getJson(page, `/api/conversations/${conversationA}/runs`)).runs[0]?.status, {
        timeout: 60_000,
      })
      .toBe('succeeded');
    const [result] = await toolResults(page, conversationA, 'ui_state');
    // Nothing of B's screen is handed to A's task.
    expect(result).toEqual({ stale: true, reason: 'other_conversation', version: null, capturedAt: null, ageMs: null, snapshot: null });

    // And the answer says so where the user finds it: back in A.
    await page.goto(`${BASE}/data?c=${conversationA}`);
    await expect(answer(page)).toContainText('[call:ui_state] {"stale":true,"reason":"other_conversation"', {
      timeout: 30_000,
    });
  });
});
