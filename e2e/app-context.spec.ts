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

/** Title of the conversation deliberately created without a workspace. */
const TITLE_WITHOUT_SPACE = 'Rozmowa bez przestrzeni';
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

/**
 * The command's half of a `get_context` answer — the whole of it except the
 * live block.
 *
 * Needed for every "nothing of the other scope is in here" assertion: the live
 * block is *supposed* to carry what the user has now, including the selection
 * they made after the task started. Searching the whole answer for that id
 * would fail on the very behaviour the tool exists to provide.
 */
const commandHalf = (answer: any) => {
  const { currentContext: _live, ...command } = answer;
  return JSON.stringify(command);
};

/**
 * Puts the editable line of an offer on a space, the way a composition would.
 *
 * The leak this serves is the half-typed form. A draft is the one piece of
 * scoped state that survives navigation on its own — the record is dropped when
 * its screen closes, the selection belongs to the space — so it is what a
 * command sent after a switch of identity could still be carrying. The default
 * composition of a case has no editable card, hence this setup; the typing
 * itself is done on the keyboard, in the browser.
 */
async function addItemFormCard(page: Page, spaceId: string, caseId: string): Promise<void> {
  const offerId = await page.evaluate(async (id) => {
    const detail = await (await fetch(`/api/m/procurement/cases/${id}`, { credentials: 'include' })).json();
    const withItems = detail.offers.find((o: any) => o.items.length > 0);
    return withItems.offer.id as string;
  }, caseId);
  expect(offerId, 'sprawa musi miec oferte z pozycjami').toBeTruthy();
  const added = await postJson(page, '/api/canvas/cards', {
    spaceId,
    title: 'Edycja pozycji',
    spec: { kind: 'component', component: 'procurement.offerItemForm', props: { offerId } },
  });
  expect(added.id, `nie udalo sie dodac karty: ${JSON.stringify(added)}`).toBeTruthy();
}

/**
 * Types into the editable line and returns the id of the item left half-edited.
 *
 * `markDirty` registers the draft in the platform store on every keystroke, so
 * this is a real unsaved form, not a fixture written into state.
 */
async function typeIntoItemForm(page: Page): Promise<string> {
  const form = page.getByTestId('card-item-form').first();
  await expect(form).toBeVisible({ timeout: 30_000 });
  const itemId = await form.locator('select').first().inputValue();
  expect(itemId, 'formularz nie wybral pozycji').toBeTruthy();
  const qty = form.locator('input').first();
  await qty.click();
  await qty.pressSequentially('7');
  return itemId;
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
    expect(commandHalf(context)).not.toContain(cardId);
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
    /*
     * The half-typed form is put within reach before the canvas is opened.
     *
     * What the first owner leaves behind has to be state that is *still there*
     * when they hand the tab over, or the assertions below hold no matter what
     * the switch does. The record is not such state any more — leaving its
     * screen drops it, which is its own test — so the leak vectors here are the
     * three that do survive walking around the application: the workspace, the
     * selection inside it, and an unsaved draft.
     */
    const spaceOfCase = await page.evaluate(async () => {
      const { spaces } = await (await fetch('/api/canvas/spaces', { credentials: 'include' })).json();
      return spaces.find((s: any) => s.scopeKind === 'case')?.id as string;
    });
    expect(spaceOfCase, 'ekran sprawy zaklada jej przestrzen').toBeTruthy();
    await navigate(page, 'Canvas');
    await expect
      .poll(() => page.evaluate(() => new URL(location.href).searchParams.get('s')), { timeout: 20_000 })
      .toBe(spaceOfCase);
    await addItemFormCard(page, spaceOfCase, caseId);
    /*
     * The only reload in this test, and it is setup: the canvas has already
     * fetched this space's cards, and a card put there behind its back does not
     * appear until it asks again. The address still names the space, so the
     * reload opens the same canvas. Everything the test is about — the command
     * as the first owner, the switch, the command as the second — happens after
     * this line, in this one page instance.
     */
    await page.reload();
    const cardId = await selectFirstCard(page);
    const itemId = await typeIntoItemForm(page);
    /*
     * One command as the first owner, so there *is* a conversation of theirs to
     * leak. Without it the address never carries `?c=`, `firstConversation`
     * stays null, and every later assertion about it degenerates into "not
     * null" — which holds no matter what the next command carries.
     */
    await send(page, 'Zapamietaj, na czym pracuje.');
    await settled(page);
    const firstConversation = await conversationOnScreen(page);
    const spaceId = await page.evaluate(() => new URL(location.href).searchParams.get('s'));
    expect(spaceId).toBe(spaceOfCase);

    // The precondition: the first owner's command really did carry all three.
    const [asFirstOwner] = await toolResults(page, firstConversation, 'get_context');
    expect(asFirstOwner.spaceId).toBe(spaceId);
    expect(asFirstOwner.selection).toEqual([{ kind: 'card', id: cardId }]);
    expect(asFirstOwner.unsavedDrafts.map((d: any) => d.entityId)).toContain(itemId);

    /* ----------------------------- the switch ------------------------------ */

    await navigate(page, 'Ustawienia');
    await expect(page.getByTestId('settings-page')).toBeVisible();
    const before = (await page.getByTestId('access-owner').textContent())?.trim();
    await page.getByTestId('switch-access-context').click();
    await expect(page.getByTestId('access-owner')).not.toHaveText(before ?? '');

    /*
     * The chat panel still has the previous owner's conversation selected: it is
     * not rebuilt on a switch, which is a separate, reported defect and the
     * sibling package's fix, not this one's. Sending straight away would post to
     * a conversation the new owner may not open, and the run would never leave
     * `queued` — which is what this test hit the first time it sent a command as
     * the first owner. So the user does what the interface offers them, and what
     * they would have to do anyway: start a new conversation. Everything this
     * test is about happens after that, still in the same tab and without a
     * reload.
     */
    await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();

    // The next command, in the same tab, without a reload.
    await send(page, 'Co mam w kontekscie?');
    await settled(page);
    const conversationId = await conversationOnScreen(page);
    const [context] = await toolResults(page, conversationId, 'get_context');

    const text = commandHalf(context);
    /*
     * Every one of these is a non-empty id of the first owner's *and* was in
     * that owner's last command a moment ago — the precondition above says so
     * for each. The second owner's command must carry none of them.
     *
     * The case id is deliberately not on the list: it left the context when its
     * screen closed, before the switch, so its absence here would prove nothing
     * about the switch. That it leaves at all is proven in "wyjscie z ekranu
     * rekordu…", and the item id below is the piece of the same case's data
     * that a draft keeps alive across the whole walk to the settings screen.
     */
    for (const leaked of [cardId, spaceId!, itemId, firstConversation]) {
      expect(leaked, 'kazdy identyfikator poprzedniego wlasciciela musi istniec').toBeTruthy();
      expect(text, `wyciek ${leaked}`).not.toContain(leaked);
    }
    expect(context.resource).toBeNull();
    expect(context.selection).toEqual([]);
    expect(context.unsavedDrafts).toEqual([]);
    expect(context.conversationId).toBe(conversationId);
    expect(conversationId).not.toBe(firstConversation);
  });

  test('L6.12: wyjscie z ekranu rekordu zdejmuje rekord z kontekstu nastepnego polecenia', async ({ page }) => {
    await scripted.restart('app-context');
    /*
     * The same conversation, the same owner, no reload — only the user walking
     * away from the record. "The record the user is looking at" has to stop
     * being true when they stop looking at it, or every later command in that
     * conversation names a screen that has been closed for minutes.
     */
    await openApp(page, '/');
    await navigate(page, 'Wszystkie sprawy');
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    const caseId = new URL(page.url()).pathname.split('/').pop()!;

    await send(page, 'Co mam teraz w kontekscie?');
    await settled(page);
    const conversationId = await conversationOnScreen(page);
    const [onTheRecord] = await toolResults(page, conversationId, 'get_context');
    expect(onTheRecord.resource).toEqual({ kind: 'case', id: caseId });

    // The user walks away — by clicking, in the same conversation.
    await navigate(page, 'Dostawcy');
    await expect(page.getByTestId('data-page')).toBeVisible();
    await published(page, (s) => s.url.startsWith('/data'));

    await send(page, 'A teraz?');
    /*
     * Waited on by the second reading appearing in the conversation, not by the
     * run phase: the first command left the phase at `succeeded`, so waiting for
     * that would return before the second command had done anything at all.
     */
    let answers: any[] = [];
    await expect
      .poll(async () => (answers = await toolResults(page, conversationId, 'get_context')).length, {
        timeout: 60_000,
      })
      .toBe(2);
    await settled(page);
    const after = answers[1];
    expect(after.resource, 'rekord opuszczonego ekranu').toBeNull();
    expect(after.resourceState).toBe('none');
    expect(commandHalf(after), `wyciek ${caseId}`).not.toContain(caseId);
    // The workspace is not part of this: the case's space stays open on purpose,
    // and the address bar still carries it.
    expect(after.spaceId, 'przestrzen sprawy zostaje').toBeTruthy();
  });

  test('L6.12: przejscie do rozmowy bez przestrzeni nie zabiera ze soba przestrzeni ani zaznaczenia poprzedniej', async ({
    page,
  }) => {
    await scripted.restart('app-context');
    await openApp(page, '/');
    /*
     * A conversation with no workspace of its own — the case the shell used to
     * skip. Created over HTTP and then the app is loaded once, so it is in the
     * drawer for the user to pick with the mouse.
     */
    const empty = await postJson(page, '/api/threads/create', { title: TITLE_WITHOUT_SPACE });
    await openApp(page, '/');

    // Conversation A: a workspace, a card selected in it, and a command sent.
    await navigate(page, 'Wszystkie sprawy');
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    await navigate(page, 'Canvas');
    const cardId = await selectFirstCard(page);
    const spaceA = await page.evaluate(() => new URL(location.href).searchParams.get('s'));
    expect(spaceA).toBeTruthy();
    await send(page, 'Co mam teraz w kontekscie?');
    await settled(page);
    const conversationA = await conversationOnScreen(page);

    // The precondition, so the assertions below are about a change: A's command
    // did carry A's workspace and A's selected card.
    const [inA] = await toolResults(page, conversationA, 'get_context');
    expect(inA.spaceId).toBe(spaceA);
    expect(inA.selection).toEqual([{ kind: 'card', id: cardId }]);

    /*
     * Off the canvas before switching, and that matters.
     *
     * The canvas has a deliberate fallback: with no space selected it opens the
     * most recent one. On that screen a cleared space is therefore put back
     * immediately — not as a leak but because the canvas really is showing it.
     * The user here walks to a module screen first (still conversation A), so
     * what the next command carries is the scope of the conversation they moved
     * to, with nothing standing in for it.
     */
    await navigate(page, 'Dostawcy');
    await expect(page.getByTestId('data-page')).toBeVisible();

    /* The user picks the other conversation from the drawer — with the mouse. */
    await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
    // The drawer lists each conversation as a button titled after its first message.
    await page.locator('.pf-chat').getByRole('button', { name: TITLE_WITHOUT_SPACE, exact: true }).first().click();
    await expect
      .poll(() => page.evaluate(() => new URL(location.href).searchParams.get('c')), { timeout: 20_000 })
      .toBe(empty.id);

    await send(page, 'A teraz co mam w kontekscie?');
    await settled(page);
    const [inEmpty] = await toolResults(page, empty.id, 'get_context');

    expect(inEmpty.conversationId).toBe(empty.id);
    // Neither the workspace of the conversation left behind …
    expect(inEmpty.spaceId).toBeNull();
    // … nor what was selected inside it.
    expect(inEmpty.selection).toEqual([]);
    expect(commandHalf(inEmpty)).not.toContain(cardId);
    expect(commandHalf(inEmpty)).not.toContain(spaceA);
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
    expect(commandHalf(last)).not.toContain(cardInB);
    expect(commandHalf(last)).not.toContain(spaceB);
    // The live block, by contrast, is where that selection legitimately appears:
    // the agent may see what the user is doing now, and must not act on it.
    expect(last.currentContext.selection).toEqual([{ kind: 'card', id: cardInB }]);
    expect(last.currentContext.changedSinceCommand).toEqual(
      expect.arrayContaining(['selection', 'spaceId']),
    );

    /* The visible consequence: the card it added is in A's space, not in B's. */
    const stateA = await getJson(page, `/api/canvas/spaces/${spaceA}`);
    const stateB = await getJson(page, `/api/canvas/spaces/${spaceB}`);
    const titlesA = stateA.cards.map((c: any) => c.title);
    expect(titlesA).toContain('Karta zadania w tle');
    expect(stateA.cards).toHaveLength(cardsInABefore + 1);
    expect(stateB.cards.map((c: any) => c.title)).not.toContain('Karta zadania w tle');
  });
});
