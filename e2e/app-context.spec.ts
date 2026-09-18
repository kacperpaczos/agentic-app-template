import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * The context the agent is given, from the user's side of the screen.
 *
 * L6.8 (read when the command is sent, not when the chat mounted), L6.3 and
 * L6.9 (the current context during a long task, distinguishable from the one it
 * started with), L6.12 (a switch of space or identity leaves nothing behind) and
 * L6.14 (a task of one conversation does not adopt a selection or a space the
 * user chose afterwards).
 *
 * **Symulacja**: a scripted model at the adapter boundary. Everything else is
 * real — the built frontend, the browser, the runtime, the MCP handlers, the
 * services and the database. What the agent was told is read back from the
 * conversation's stored tool results; what the user did was done with the mouse,
 * in one tab, without a reload, because a reload would rebuild exactly the state
 * these criteria are about.
 *
 * Every test here is built so the *bad* outcome is what would happen without the
 * mechanism: the context is changed after the chat mounts, the selection is
 * changed while the task runs, the identity is switched with the previous one's
 * record on screen.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-appcontext' });
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

const running = (page: Page) =>
  expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', { timeout: 30_000 });

const settled = (page: Page) =>
  expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', { timeout: 60_000 });

const getJson = (page: Page, path: string) =>
  page.evaluate(async (p) => (await fetch(p, { credentials: 'include' })).json(), path);

/** In-app navigation through the left menu — a click, not a reload. */
async function navigate(page: Page, label: string) {
  await page.locator('.pf-nav__link', { hasText: label }).first().click();
}

async function conversationOnScreen(page: Page): Promise<string> {
  let id: string | null = null;
  await expect
    .poll(() => (id = new URL(page.url()).searchParams.get('c')), { timeout: 20_000 })
    .toBeTruthy();
  return id!;
}

/** Stored results of one tool in a conversation, in call order, parsed. */
async function toolResults(page: Page, conversationId: string, tool: string): Promise<any[]> {
  const messages: Array<Record<string, any>> = await getJson(page, `/api/threads/get/${conversationId}`);
  const calls = new Map<string, string>();
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) calls.set(call.id, call.function.name);
  }
  return messages
    .filter((m) => m.role === 'tool' && calls.get(m.toolCallId) === `mcp__app__${tool}`)
    .map((m) => JSON.parse(m.content as string));
}

/** This tab's latest published description of its screen, once it satisfies `ok`. */
async function published(page: Page, ok: (s: any) => boolean): Promise<any> {
  const clientId = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem('platform.ui-snapshot.client') ?? '{}').clientId as string,
  );
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

/**
 * A second saved space with one card in it.
 *
 * Prepared over HTTP because the base data has one case and therefore one
 * space, and every criterion here needs a *second* scope to move to. Only the
 * setup is API work: the switch itself, and the selection inside it, are done
 * with the mouse, which is what the criteria are about.
 */
async function secondSpace(page: Page, title: string): Promise<string> {
  const space = await postJson(page, '/api/canvas/spaces', { title, scopeKind: 'workspace', scopeId: title });
  await postJson(page, '/api/canvas/cards', {
    spaceId: space.id,
    title: `Karta ${title}`,
    spec: { kind: 'component', component: 'platform.markdown', props: { markdown: title } },
  });
  // Loaded once, before anything under test happens: the list of spaces is a
  // query the application already fetched, and it does not know about a space
  // created behind its back.
  await openApp(page, '/');
  return space.id as string;
}

/** Selects the first card on the canvas by its title button, and returns its id. */
async function selectFirstCard(page: Page): Promise<string> {
  const card = page.locator('[data-testid^="card-"]').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  const id = (await card.getAttribute('data-testid'))!.replace(/^card-/, '');
  await card.locator('.pf-card__title').click();
  await expect(card.locator('.pf-card__title')).toContainText('◉');
  return id;
}

test.describe('kontekst aplikacji dla agenta', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });
  test.afterEach(() => scripted.stop());

  /* ---------------------------------------------------------------- L6.8 -- */

  test('L6.8: kontekst polecenia jest odczytany w chwili wyslania, nie przy montowaniu czatu', async ({ page }) => {
    await scripted.start('app-context');
    // The chat mounts here, on a screen with no record and no space.
    await openApp(page, '/spaces');
    const atMount = await published(page, (s) => s.url.startsWith('/spaces'));
    expect(atMount.context.resource, 'przy montowaniu czatu nie ma wskazanego rekordu').toBeNull();

    /*
     * The user now walks to a record — clicking, without reloading, so the chat
     * panel is the very instance that mounted a moment ago. If the context were
     * captured at mount, the command below would carry `resource: null`.
     */
    await navigate(page, 'Wszystkie sprawy');
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    const caseId = new URL(page.url()).pathname.split('/').pop()!;
    expect(caseId).toMatch(/^pc_|^.+/);
    await published(page, (s) => s.context.resource?.id === caseId);

    await send(page, 'Na czym pracuje?');
    await settled(page);

    const conversationId = await conversationOnScreen(page);
    const [context] = await toolResults(page, conversationId, 'get_context');
    expect(context.resource).toEqual({ kind: 'case', id: caseId });
    expect(context.resourceState).toBe('described');
    // The screen marker sent with the command is the one from the record screen.
    expect(context.ui.url).toContain(caseId);
  });

  /* --------------------------------------------------------- L6.3, L6.9 -- */

  test('L6.3 i L6.9: zaznaczenie zmienione w trakcie dlugiego zadania jest widoczne i odroznione od startowego', async ({
    page,
  }) => {
    await scripted.restart('app-context');
    await openApp(page, '/');
    // A space with cards: opening a case gives its workspace.
    await navigate(page, 'Wszystkie sprawy');
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    await navigate(page, 'Canvas');
    await expect(page.locator('[data-testid^="card-"]').first()).toBeVisible({ timeout: 30_000 });

    await send(page, 'Zrob cos dlugie i powiedz, co mam zaznaczone.');
    await running(page);
    const conversationId = await conversationOnScreen(page);

    // The user selects a card with the mouse while the task is running.
    const cardId = await selectFirstCard(page);
    await published(page, (s) => s.context.selection.some((x: any) => x.id === cardId));

    await settled(page);
    const reads = await toolResults(page, conversationId, 'get_context');
    expect(reads).toHaveLength(2);
    const [first, second] = reads;

    // At the start: nothing selected — so the later reading cannot be an echo.
    expect(first.selection).toEqual([]);
    expect(first.currentContext.selection ?? []).toEqual([]);

    // During the task the agent reads the newer context …
    expect(second.currentContext.known).toBe(true);
    expect(second.currentContext.stale).toBe(false);
    expect(second.currentContext.selection).toEqual([{ kind: 'card', id: cardId }]);
    expect(second.currentContext.version).toBeGreaterThan(first.currentContext.version);
    // … and it is distinguishable from the context the command started with.
    expect(second.selection).toEqual([]);
    expect(second.currentContext.changedSinceCommand).toContain('selection');
  });

  /* --------------------------------------------------------------- L6.12 -- */

  test('L6.12: zmiana przestrzeni nie przenosi zaznaczonych kart do nastepnego polecenia', async ({ page }) => {
    await scripted.restart('app-context');
    await openApp(page, '/');
    const otherSpace = await secondSpace(page, 'Druga przestrzen');
    // The case's own workspace, reached by opening the case.
    await navigate(page, 'Wszystkie sprawy');
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    await navigate(page, 'Canvas');
    const cardId = await selectFirstCard(page);
    const spaceOfCase = await page.evaluate(() => new URL(location.href).searchParams.get('s'));
    expect(spaceOfCase).toBeTruthy();
    expect(spaceOfCase).not.toBe(otherSpace);

    // The user moves to another saved space, with the card still selected.
    await navigate(page, 'Zapisane kompozycje');
    await page.getByTestId(`space-${otherSpace}`).click();
    await expect
      .poll(() => page.evaluate(() => new URL(location.href).searchParams.get('s')), { timeout: 20_000 })
      .toBe(otherSpace);

    await send(page, 'Co mam teraz w kontekscie?');
    await settled(page);
    const conversationId = await conversationOnScreen(page);
    const [context] = await toolResults(page, conversationId, 'get_context');
    // The card of the space the user left is not in the next command's context.
    expect(context.selection).toEqual([]);
    expect(JSON.stringify(context)).not.toContain(cardId);
    expect(context.spaceId).toBe(otherSpace);
  });

  test('L6.12: po zmianie wlasciciela bez przeladowania kolejne polecenie nie niesie niczego poprzedniego', async ({
    page,
  }) => {
    await scripted.restart('app-context');
    await openApp(page, '/');
    await navigate(page, 'Wszystkie sprawy');
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    const caseId = new URL(page.url()).pathname.split('/').pop()!;
    await navigate(page, 'Canvas');
    const cardId = await selectFirstCard(page);
    const firstConversation = await conversationOnScreen(page).catch(() => null);
    const spaceId = await page.evaluate(() => new URL(location.href).searchParams.get('s'));
    expect(spaceId).toBeTruthy();

    /* ----------------------------- the switch ------------------------------ */

    await navigate(page, 'Ustawienia');
    await expect(page.getByTestId('settings-page')).toBeVisible();
    const before = (await page.getByTestId('access-owner').textContent())?.trim();
    await page.getByTestId('switch-access-context').click();
    await expect(page.getByTestId('access-owner')).not.toHaveText(before ?? '');

    // The next command, in the same tab, without a reload.
    await send(page, 'Co mam w kontekscie?');
    await settled(page);
    const conversationId = await conversationOnScreen(page);
    const [context] = await toolResults(page, conversationId, 'get_context');

    const text = JSON.stringify(context);
    for (const leaked of [caseId, cardId, spaceId!, firstConversation].filter(Boolean) as string[]) {
      expect(text, `wyciek ${leaked}`).not.toContain(leaked);
    }
    expect(context.resource).toBeNull();
    expect(context.selection).toEqual([]);
    expect(context.unsavedDrafts).toEqual([]);
    expect(context.conversationId).toBe(conversationId);
    expect(conversationId).not.toBe(firstConversation);
  });

  /* --------------------------------------------------------------- L6.14 -- */

  test('L6.14: zadanie rozmowy A nie przejmuje przestrzeni ani zaznaczenia wybranego pozniej', async ({ page }) => {
    await scripted.restart('app-context');
    await openApp(page, '/');
    const spaceB = await secondSpace(page, 'Przestrzen B');
    await navigate(page, 'Wszystkie sprawy');
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    await navigate(page, 'Canvas');
    await expect(page.locator('[data-testid^="card-"]').first()).toBeVisible({ timeout: 30_000 });
    const spaceA = await page.evaluate(() => new URL(location.href).searchParams.get('s'));
    expect(spaceA).toBeTruthy();
    // Counted from the backend, which is where the claim "exactly one card was
    // added, and to this space" has to hold.
    const cardsInABefore = (await getJson(page, `/api/canvas/spaces/${spaceA}`)).cards.length as number;

    await send(page, 'Popracuj w tle i dodaj karte.');
    await running(page);
    const conversationA = await conversationOnScreen(page);

    /* The user moves on: another space, and a card selected in it. */
    await navigate(page, 'Zapisane kompozycje');
    await page.getByTestId(`space-${spaceB}`).click();
    await expect
      .poll(() => page.evaluate(() => new URL(location.href).searchParams.get('s')), { timeout: 20_000 })
      .toBe(spaceB);
    const cardInB = await selectFirstCard(page);
    await published(page, (s) => s.context.selection.some((x: any) => x.id === cardInB));

    await expect
      .poll(async () => (await getJson(page, `/api/conversations/${conversationA}/runs`)).runs[0]?.status, {
        timeout: 90_000,
      })
      .toBe('succeeded');

    const reads = await toolResults(page, conversationA, 'get_context');
    const last = reads.at(-1)!;
    // The task keeps the space it was started in …
    expect(last.spaceId).toBe(spaceA);
    expect(last.selection).toEqual([]);
    // … and the selection made afterwards is nowhere in its context.
    expect(JSON.stringify(last)).not.toContain(cardInB);
    expect(JSON.stringify(last)).not.toContain(spaceB);

    /* The visible consequence: the card it added is in A's space, not in B's. */
    const stateA = await getJson(page, `/api/canvas/spaces/${spaceA}`);
    const stateB = await getJson(page, `/api/canvas/spaces/${spaceB}`);
    const titlesA = stateA.cards.map((c: any) => c.title);
    expect(titlesA).toContain('Karta zadania w tle');
    expect(stateA.cards).toHaveLength(cardsInABefore + 1);
    expect(stateB.cards.map((c: any) => c.title)).not.toContain('Karta zadania w tle');
  });
});
