import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * BL-08a — the chat surface, driven the way a user drives it.
 *
 * **Symulacja**: the model is a scripted stand-in at the adapter boundary. The
 * browser, the built frontend, the runtime, the MCP handlers, the services and
 * the database are the real ones, and every claim below starts with a click or a
 * keystroke and ends with something on screen.
 *
 * What is here rather than in `tests/chat-history.test.ts`: the parts a browser
 * has to answer — a title changed from the interface, a declaration that matches
 * what the interface offers, formatting and a composition actually rendered,
 * a tool call with its arguments and its result still readable after a reload
 * and a restart, work in one conversation while another one is running, and the
 * conversation deleted from its own row menu while it still owns a task.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-chathistory' });
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
  expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', { timeout: 90_000 });

const getJson = (page: Page, path: string) =>
  page.evaluate(async (p) => (await fetch(p, { credentials: 'include' })).json(), path);

async function conversationOnScreen(page: Page): Promise<string> {
  let id: string | null = null;
  await expect
    .poll(() => (id = new URL(page.url()).searchParams.get('c')), { timeout: 20_000 })
    .toBeTruthy();
  return id!;
}

/** Opens the chat's conversation drawer, idempotently. */
async function openDrawer(page: Page) {
  const expanded = page.locator('.openui-agent-sidebar-container[data-sidebar-visual-state="expanded"]');
  if ((await expanded.count()) === 0) {
    await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
  }
  await expect(expanded).toHaveCount(1);
  return expanded;
}

/**
 * Starts a new conversation from the chat's own control.
 *
 * The icon button in the header, deliberately not the floating one: on the
 * canvas the floating button sits under a card, so a click on it is intercepted
 * by the card and the test waits for something that can never happen.
 */
async function newChat(page: Page) {
  await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();
}

async function openConversation(page: Page, title: string) {
  await openDrawer(page);
  const row = page.locator('.openui-agent-thread-button', { hasText: title }).first();
  await expect(row).toBeVisible();
  await row.locator('.openui-agent-thread-button-title').first().click();
  await expect(page.locator('.openui-agent-thread-messages > *').first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Opens the ready-made steps tray and the tool card inside it, the way a user
 * reaches a call's arguments and its result.
 *
 * Two controls, because there are two: the turn's "Behind the scenes" toggle,
 * and the row of the call itself. Kept in one helper so every assertion about
 * arguments and results goes through the same clicks.
 */
async function openToolCard(page: Page) {
  const tray = page.locator('.openui-behind-the-scenes').first();
  await expect(tray).toBeVisible({ timeout: 60_000 });
  if ((await tray.locator('.openui-behind-the-scenes__items').count()) === 0) {
    await tray.locator('.openui-behind-the-scenes__toggle').click();
  }
  const items = tray.locator('.openui-behind-the-scenes__items');
  await expect(items).toHaveCount(1);
  const row = items.locator('.openui-tool-call__title-row').first();
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  const block = items.locator('.openui-tool-call__block').first();
  await expect(block).toBeVisible();
  /*
   * Request and result are two `code` elements inside one block, and they have
   * to be read separately.
   *
   * Read as one string they cannot tell each other apart — and that is not
   * hypothetical: the first version of the argument assertions searched the
   * whole block for `limit: 3`, which the ui_catalog *answer* also contains (in
   * its window descriptor). A detection trial that emptied the arguments
   * entirely still passed. The trial caught the test, not the code.
   */
  const request = block.locator('code').first();
  const result = block.locator('code').nth(1);
  return { tray, items, block, request, result };
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

test.describe('czat i historia rozmowy', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(async () => {
    scripted.prepareDatabase();
    await scripted.start('chat-history');
  });
  test.afterAll(() => scripted.stop());

  /* ---------------------------------------------------------------- L4.3 -- */

  test('L4.3: tytul z pierwszej wiadomosci, a uzytkownik moze go zmienic', async ({ page }) => {
    await openApp(page);
    await send(page, 'Podsumuj krotko stan sprawy zakupowej.');
    await settled(page);
    const conversationId = await conversationOnScreen(page);

    // Derived from what the user typed, by the backend, before any answer: a
    // title nobody asked a model for.
    const strip = page.getByTestId('conversation-title');
    await expect(strip).toHaveText('Podsumuj krotko stan sprawy zakupowej');

    /* --------------------------- the rename itself ------------------------- */

    await page.getByTestId('conversation-rename').click();
    const field = page.getByTestId('conversation-title-input');
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('Podsumuj krotko stan sprawy zakupowej');
    const renamed = `Analiza zakupow ${Date.now()}`;
    await field.fill(renamed);
    await page.getByTestId('conversation-title-save').click();

    await expect(strip).toHaveText(renamed);
    // The drawer shows it too — a rename only the strip knew about would be a
    // rename the user cannot find again.
    await openDrawer(page);
    await expect(page.locator('.openui-agent-thread-button', { hasText: renamed })).toHaveCount(1);
    // And the backend agrees.
    await expect
      .poll(async () => (await getJson(page, `/api/conversations/${conversationId}`)).title)
      .toBe(renamed);

    /* ---------------------- and it survives a reload ----------------------- */

    await page.reload();
    await expect(page.getByTestId('conversation-title')).toHaveText(renamed, { timeout: 30_000 });

    // Cancelling changes nothing — the control is not a one-way door.
    await page.getByTestId('conversation-rename').click();
    await page.getByTestId('conversation-title-input').fill('Nazwa, ktorej nie zapisuje');
    await page.getByTestId('conversation-title-cancel').click();
    await expect(page.getByTestId('conversation-title')).toHaveText(renamed);
    await expect
      .poll(async () => (await getJson(page, `/api/conversations/${conversationId}`)).title)
      .toBe(renamed);
  });

  /* ---------------------------------------------------------------- L4.8 -- */

  test('L4.8: zadeklarowany zakres obslugi rozmow zgadza sie z tym, co interfejs oferuje', async ({ page }) => {
    await openApp(page);
    await page.locator('.pf-nav__link', { hasText: 'Ustawienia' }).first().click();
    await expect(page.getByTestId('settings-page')).toBeVisible();

    /*
     * The declaration is read from the screen as data, not as a sentence: the
     * wording of "dostepne" has changed once in this repository already, and an
     * assertion over it would be about the label rather than about the claim.
     */
    const declared: Record<string, boolean> = await page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('[data-testid^="chat-capability-"]')].map((el) => [
          el.getAttribute('data-testid')!.replace('chat-capability-', ''),
          el.getAttribute('data-available') === 'true',
        ]),
      ),
    );
    // Every capability the contract has is on screen; a new one cannot be
    // declared in the backend and quietly left out of the page.
    const fromApi = (await getJson(page, '/api/status')).chatCapabilities as Record<string, boolean>;
    expect(declared).toEqual(fromApi);
    expect(Object.keys(declared).length).toBeGreaterThan(3);

    // The three this criterion is about are declared unavailable.
    expect(declared.editMessage).toBe(false);
    expect(declared.branchConversation).toBe(false);
    expect(declared.restoreDeletedConversation).toBe(false);

    /* ------------------- and the interface offers none of them -------------- */

    await page.locator('.pf-nav__link', { hasText: 'Canvas' }).first().click();
    await send(page, 'Podsumuj krotko, co widac.');
    await settled(page);

    /*
     * A message the user could edit, a turn they could branch from and a bin
     * they could restore from would all be controls. There are none — asserted
     * over the chat panel as a whole, so a control added anywhere in it fails
     * this.
     */
    const chat = page.locator('.pf-chat');
    for (const label of [/edytuj|edit/i, /rozgalez|branch/i, /przywroc|restore|kosz/i]) {
      await expect(chat.getByRole('button', { name: label })).toHaveCount(0);
    }

    // The row menu has exactly the actions the library ships: one, Delete. A
    // second item appearing here means the declaration above needs revisiting.
    await openDrawer(page);
    const row = page.locator('.openui-agent-thread-button').first();
    await row.locator('[aria-label="Thread actions"]').first().click();
    await expect(page.getByRole('menuitem')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // The one capability declared available *is* offered, in the same panel.
    expect(declared.renameConversation).toBe(true);
    await expect(page.getByTestId('conversation-rename')).toHaveCount(1);
    expect(declared.cancelRun).toBe(true);
  });

  /* ---------------------------------------------------------------- L4.9 -- */

  test('L4.9: proza z formatowaniem, kompozycja OpenUI i odpowiedz po narzedziu sa widoczne', async ({ page }) => {
    await openApp(page);

    /* ------------------------ formatting, as formatting -------------------- */

    await send(page, 'Napisz proza, co wynika ze sprawy.');
    await settled(page);
    const prose = page.getByTestId('assistant-prose').last();
    await expect(prose).toBeVisible();
    // Rendered markdown, not the characters: emphasis is an element and the
    // list is list items. A renderer that printed the source would show
    // `**podsumowanie**` and have neither.
    await expect(prose.locator('strong')).toHaveText('podsumowanie');
    await expect(prose.locator('li')).toHaveCount(2);
    await expect(prose.locator('li').first()).toHaveText('pierwszy wniosek');
    await expect(prose).not.toContainText('**');

    /* ------------- words and a composition in the same answer -------------- */

    await newChat(page);
    await send(page, 'Pokaz opis interfejsu z zestawieniem dostawcow.');
    await settled(page);

    // The sentence before the composition is still there — this is the part
    // that disappeared when one fence took the whole message over to the
    // GenUI renderer.
    const message = page.getByTestId('assistant-message').last();
    await expect(message.getByTestId('assistant-prose').first()).toContainText(
      'Ponizej zestawienie dostawcow',
    );
    await expect(message.getByTestId('assistant-prose').last()).toContainText(
      'Tyle po stronie zestawienia',
    );

    // And the composition is a rendered component with rows in it, not an
    // empty box and not the source text.
    const composition = message.getByTestId('assistant-openui');
    await expect(composition).toHaveAttribute('data-empty', 'false');
    const table = composition.locator('[data-ui-instance][data-component="DataTable"]');
    await expect(table).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    const expected = (await page.evaluate(async () =>
      (
        await (
          await fetch('/api/read', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ operation: 'procurement.suppliers' }),
          })
        ).json()
      ).result.suppliers.map((s: { name: string }) => s.name),
    )) as string[];
    expect(expected.length).toBeGreaterThan(0);
    for (const name of expected) await expect(table).toContainText(name);
    await expect(composition).not.toContainText('openui-lang');

    /* ---------------------- the answer after a tool call ------------------- */

    await newChat(page);
    await send(page, 'Zanim odpowiesz, sprawdz katalog.');
    await settled(page);
    await expect(page.getByTestId('assistant-message').last()).toContainText(
      'to jest koncowa odpowiedz',
    );
  });

  /* ------------------------------------------------------- L4.9 / L5.13 --- */

  test('L4.9: tekst wypowiedziany PRZED wywolaniem narzedzia nie ginie — jest krokiem osi', async ({ page }) => {
    await openApp(page);
    await send(page, 'Zanim odpowiesz, sprawdz katalog komponentow.');
    await settled(page);
    const conversationId = await conversationOnScreen(page);

    /*
     * The history holds both halves of the turn, in order: what was said before
     * the call, the call's result, and the answer after it.
     */
    const history: Array<Record<string, any>> = await getJson(page, `/api/threads/get/${conversationId}`);
    const assistant = history.filter((m) => m.role === 'assistant');
    expect(assistant.length).toBeGreaterThan(1);
    expect(assistant[0]!.content).toContain('Zanim odpowiem, sprawdzam katalog');
    expect(assistant[0]!.toolCalls).toHaveLength(1);
    expect(assistant.at(-1)!.content).toContain('to jest koncowa odpowiedz');

    /*
     * On screen, the ready-made component puts the two halves in two different
     * places, and this is the behaviour the defect report was about:
     *
     *  - the *answer* is the bubble (`assistant-message`);
     *  - everything said alongside the tool calls is a step of the turn's
     *    timeline, and that timeline collapses once the turn settles.
     *
     * So the words spoken before the call are not lost and they are not in the
     * bubble: they are one click away, under the turn's own toggle. Asserted in
     * that order — absent from the bubble, the tray closed, then present once
     * it is opened — so a library version that stops rendering them at all
     * fails here rather than passing quietly.
     *
     * **The pin points both ways, and the next reader should know which red is
     * which.** A library version that *fixes* this — one that puts the earlier
     * segment's prose into the bubble, or leaves the tray open once the turn
     * settles — will fail these same lines. That failure is good news and the
     * right response is to relax the assertion and note the version that
     * changed, not to work around it. A failure on the last line (the text is
     * nowhere, even expanded) is the regression.
     */
    const bubble = page.getByTestId('assistant-message').last();
    await expect(bubble).toContainText('to jest koncowa odpowiedz');
    await expect(bubble).not.toContainText('Zanim odpowiem');

    const tray = page.locator('.openui-behind-the-scenes').first();
    await expect(tray).toBeVisible();
    // Settled: the steps are not rendered until the toggle is pressed.
    await expect(tray.locator('.openui-behind-the-scenes__items')).toHaveCount(0);
    await expect(page.locator('.pf-chat')).not.toContainText('Zanim odpowiem');

    await tray.locator('.openui-behind-the-scenes__toggle').click();
    const step = tray.locator('.openui-tool-call-timeline__text-step');
    await expect(step).toHaveCount(1);
    await expect(step).toContainText('Zanim odpowiem, sprawdzam katalog komponentow');
  });

  /* --------------------------------------------------------- L4.11 -------- */

  test('L4.11: wywolanie, argumenty i wynik widoczne w trakcie, po przeladowaniu i po restarcie', async ({ page }) => {
    await openApp(page);
    await send(page, 'Zanim odpowiesz, sprawdz katalog komponentow jeszcze raz.');

    /*
     * While the run is open, not merely "eventually": the phase is read in the
     * same breath as the timeline's visibility. An assertion that only waited
     * for the timeline would also pass if it appeared after the run ended,
     * which is the gap this replaces.
     */
    const tray = page.locator('.openui-behind-the-scenes').first();
    let sawWhileRunning = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const phase = await page.getByTestId('run-state').getAttribute('data-phase');
      if ((phase === 'running' || phase === 'queued') && (await tray.count()) > 0 && (await tray.isVisible())) {
        sawWhileRunning = true;
        break;
      }
      if (phase === 'succeeded' || phase === 'failed') break;
      await page.waitForTimeout(25);
    }
    expect(sawWhileRunning, 'os narzedzi pojawila sie dopiero po zakonczeniu wykonania').toBe(true);

    await settled(page);
    const conversationId = await conversationOnScreen(page);

    /* -------- the call, its arguments and its result, on screen ------------ */

    const readCard = async () => {
      const { items, request, result } = await openToolCard(page);
      await expect(items).toContainText('ui_catalog');
      return {
        request: (await request.textContent()) ?? '',
        result: (await result.textContent()) ?? '',
      };
    };

    /*
     * Arguments: the `limit` the agent actually sent, read from the request
     * panel alone — and demonstrably the one that was used, because the answer
     * beside it carries exactly that many targets and says the window was cut
     * short.
     */
    const live = await readCard();
    expect(live.request, 'argumenty wywolania nie sa widoczne').toContain('limit');
    expect(live.request, 'wartosc argumentu nie jest widoczna').toMatch(/limit"?\s*:\s*3/);
    // The successful result's content, not only the fact that it succeeded.
    expect(live.result, 'tresc udanego wyniku nie jest widoczna').toContain('platform.canvas');
    expect(live.result, 'skutek argumentu nie jest widoczny w wyniku').toContain('truncated');

    const [catalog] = await toolResults(page, conversationId, 'ui_catalog');
    expect(catalog.targets).toHaveLength(3);
    expect(catalog.targetsWindow.truncated).toBe(true);

    /* ------------------------------ reload --------------------------------- */

    await page.reload();
    await expect(page.locator('.openui-behind-the-scenes').first()).toBeVisible({ timeout: 30_000 });
    const afterReload = await readCard();
    expect(afterReload.request).toMatch(/limit"?\s*:\s*3/);
    expect(afterReload.result).toContain('platform.canvas');

    /* ----------------------------- restart --------------------------------- */

    await scripted.restart('chat-history');
    await page.reload();
    await expect(page.locator('.openui-behind-the-scenes').first()).toBeVisible({ timeout: 30_000 });
    const afterRestart = await readCard();
    expect(afterRestart.request).toMatch(/limit"?\s*:\s*3/);
    expect(afterRestart.result).toContain('platform.canvas');

    // The identifiers did not move either — the same rows, not a rebuilt turn.
    const history: Array<Record<string, any>> = await getJson(page, `/api/threads/get/${conversationId}`);
    expect(history.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  test('L4.11: blad narzedzia pozostaje bledem po przeladowaniu i po restarcie', async ({ page }) => {
    await openApp(page);
    await newChat(page);
    await send(page, 'Wywolaj blad narzedzia na karcie.');
    await settled(page);
    const conversationId = await conversationOnScreen(page);

    const failureVisible = async () => {
      const tray = page.locator('.openui-behind-the-scenes').first();
      await expect(tray).toBeVisible({ timeout: 60_000 });
      // A failure count on the settled toggle: marked as a failure before
      // anything is expanded.
      await expect(tray.locator('.openui-behind-the-scenes__toggle')).toContainText(/failed/i);
      if ((await tray.locator('.openui-behind-the-scenes__items').count()) === 0) {
        await tray.locator('.openui-behind-the-scenes__toggle').click();
      }
      // And the reason, which is the part a user needs.
      await expect(tray.locator('.openui-behind-the-scenes__items')).toContainText('Nieznany komponent');
    };

    await failureVisible();
    await page.reload();
    await failureVisible();
    await scripted.restart('chat-history');
    await page.reload();
    await failureVisible();

    // The run itself succeeded: a failing tool is not a failing run, and the
    // stored history still says which of the two it was.
    const runs = (await getJson(page, `/api/conversations/${conversationId}/runs`)).runs;
    expect(runs[0].status).toBe('succeeded');
    const history: Array<Record<string, any>> = await getJson(page, `/api/threads/get/${conversationId}`);
    expect(history.find((m) => m.role === 'tool')!.isError).toBe(true);
  });

  /* --------------------------------------------------------- L4.15 -------- */

  test('L4.15: artefakt ma podglad w wiadomosci i pelny widok, a os narzedzi i odpowiedz zostaja', async ({ page }) => {
    await openApp(page);
    await newChat(page);
    await send(page, 'Zapisz artefakt z zestawieniem tej sprawy.');
    await settled(page);

    /*
     * Three things in one turn, which is what "the renderer extension keeps the
     * presentation of tools and artifacts" means: the timeline of the calls,
     * the artifact drawn under the call that produced it, and the answer
     * rendered by the application's own message body.
     */
    const preview = page.getByTestId('artifact-preview');
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview).toHaveAttribute('data-artifact-id', /^art_/);
    // Drawn by the module's renderer, with rows — not a JSON dump and not an
    // empty frame.
    await expect(preview.getByTestId('artifact-comparison')).toBeVisible();
    const previewRows = await preview.locator('[data-testid^="comparison-row-"]').allInnerTexts();
    expect(previewRows.length).toBeGreaterThan(0);
    const artifactId = await preview.getAttribute('data-artifact-id');

    // The tool timeline of the same turn is still the library's.
    await expect(page.locator('.openui-behind-the-scenes').first()).toBeVisible();
    // And the answer is ours, rendered as prose.
    await expect(page.getByTestId('assistant-prose').last()).toContainText(
      'Zapisalem zestawienie jako artefakt',
    );

    /* -------------------- the same artifact, the other tab ----------------- */

    await page.getByTestId('chat-tab-artifacts').click();
    const browser = page.locator('.openui-agent-artifact-browser');
    await expect(browser).toBeVisible();
    await browser.getByRole('button', { name: /Zestawienie z rozmowy/ }).click();
    const full = page.getByTestId('artifact-full');
    await expect(full).toBeVisible();
    expect(await full.getAttribute('data-artifact-id')).toBe(artifactId);
    expect(await full.locator('[data-testid^="comparison-row-"]').allInnerTexts()).toEqual(previewRows);

    // Back to the conversation: nothing of the turn was lost by going away.
    await page.getByTestId('chat-tab-thread').click();
    await expect(page.getByTestId('artifact-preview')).toBeVisible();
    await expect(page.locator('.openui-behind-the-scenes').first()).toBeVisible();
  });

  /* ---------------------------------------------------------- L4.5 -------- */

  test('L4.5: praca w drugiej rozmowie w trakcie zadania pierwszej nie miesza niczego', async ({ page }) => {
    await openApp(page);

    /* --------------- conversation B exists first, and is empty of A -------- */

    await newChat(page);
    await send(page, 'Krotko: powiedz, co masz w kontekscie.');
    await settled(page);
    const conversationB = await conversationOnScreen(page);
    await page.getByTestId('conversation-rename').click();
    await page.getByTestId('conversation-title-input').fill('Rozmowa BETA');
    await page.getByTestId('conversation-title-save').click();
    await expect(page.getByTestId('conversation-title')).toHaveText('Rozmowa BETA');

    /* ------------- conversation A starts a long task and keeps it ---------- */

    await newChat(page);
    await send(page, 'Popracuj dlugo nad tym zestawieniem.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    const conversationA = await conversationOnScreen(page);
    expect(conversationA).not.toBe(conversationB);
    await expect(page.locator('.pf-chat')).toContainText('Zaczynam dluga prace', { timeout: 30_000 });

    /* ------------------- the switch, with A still running ------------------ */

    await openConversation(page, 'Rozmowa BETA');
    expect(await conversationOnScreen(page)).toBe(conversationB);

    // A's answer is not in B's thread, and A's run does not colour B's strip.
    const chat = page.locator('.pf-chat');
    await expect(chat).not.toContainText('Zaczynam dluga prace');
    await expect(chat).not.toContainText('fragment');
    /*
     * Asserted as the absence of a *specific* element, not as a branch over
     * whether a strip happens to be on screen: `if (count > 0)` passes when
     * there is no strip at all, which is one of the two outcomes this is
     * supposed to tell apart. The run of A is named; a strip carrying its id
     * must not exist in this conversation, whatever else is showing.
     */
    const runOfA = (await getJson(page, `/api/conversations/${conversationA}/runs`)).runs[0].id;
    expect(runOfA).toMatch(/^run_/);
    await expect(page.locator(`[data-testid="run-state"][data-run-id="${runOfA}"]`)).toHaveCount(0);

    // A is genuinely still working — the switch did not stop it, which is what
    // makes the rest of this test about two live conversations.
    const active = (await getJson(page, '/api/runs/active')).runs;
    expect(active.map((r: any) => r.conversationId)).toContain(conversationA);

    /* ------------- the next command belongs to the conversation it is in ---- */

    await send(page, 'Krotko: powiedz, co masz w kontekscie teraz.');
    await settled(page);
    const contexts = await toolResults(page, conversationB, 'get_context');
    const latest = contexts.at(-1);
    expect(latest.conversationId).toBe(conversationB);
    // Nothing of A is carried into it — asserted over the command's own half of
    // the answer, as the whole of it is serialised text.
    const { currentContext: _live, ...command } = latest;
    expect(JSON.stringify(command)).not.toContain(conversationA);

    /* -------------------------- back to A, unchanged ----------------------- */

    await openConversation(page, 'Popracuj dlugo');
    expect(await conversationOnScreen(page)).toBe(conversationA);
    await expect
      .poll(async () => (await getJson(page, `/api/conversations/${conversationA}/runs`)).runs[0].status, {
        timeout: 90_000,
      })
      .toBe('succeeded');
    await page.reload();
    await expect(page.locator('.pf-chat')).toContainText('Koniec dlugiej pracy', { timeout: 30_000 });
    // B's words never appear in A either.
    await expect(page.locator('.pf-chat')).not.toContainText('Krotka odpowiedz');

    // And the two histories stayed separate on the server as well.
    const inA: Array<Record<string, any>> = await getJson(page, `/api/threads/get/${conversationA}`);
    const inB: Array<Record<string, any>> = await getJson(page, `/api/threads/get/${conversationB}`);
    expect(inA.map((m) => m.content).join('')).not.toContain('Krotka odpowiedz');
    expect(inB.map((m) => m.content).join('')).not.toContain('Koniec dlugiej pracy');
  });

  /* ------------------- objaw zgloszonego defektu (L4.5) ------------------- */

  test('L4.5: polecenie wyslane zaraz po zmianie tozsamosci wykonuje sie, nie zostaje w kolejce', async ({ page }) => {
    /*
     * The reported defect, asserted as the symptom rather than as its cause.
     *
     * The cause — the chat keeping the previous owner's conversation, and the
     * address keeping its id — is removed in two places and other suites assert
     * both. This asserts the thing a user would notice: switch identity, type
     * immediately, and the command runs. It fails if that behaviour comes back
     * by *any* route, including one nobody has thought of yet, which is the
     * point: this defect already returned once through another package.
     *
     * Nothing between the switch and the command: no reload, no "New chat", no
     * picking a conversation. That is what the sibling package had to do as a
     * workaround, and doing it here would test the workaround instead.
     */
    await openApp(page);
    await send(page, 'Krotko: powiedz, co masz w kontekscie.');
    await settled(page);
    const before = await conversationOnScreen(page);

    await page.locator('.pf-nav__link', { hasText: 'Ustawienia' }).first().click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    const owner = page.getByTestId('access-owner');
    const was = (await owner.textContent())?.trim() ?? '';
    await page.getByTestId('switch-access-context').click();
    await expect(owner).not.toHaveText(was);

    // Straight to the composer. `settled` waits for `succeeded`, so a command
    // stuck in `queued` fails here by timing out on the phase it never reaches.
    await send(page, 'Krotko: powiedz, co masz w kontekscie teraz.');
    await settled(page);

    // It ran as the new identity, in a conversation of its own.
    const after = await conversationOnScreen(page);
    expect(after).not.toBe(before);
    const [context] = await toolResults(page, after, 'get_context');
    expect(context.conversationId).toBe(after);
    // And the previous identity's conversation is not what answered.
    expect(JSON.stringify(context)).not.toContain(before);
  });

  /* ---------------------------------------------------------- L4.7 -------- */

  test('L4.7: usuniecie rozmowy z trwajacym zadaniem zatrzymuje to zadanie', async ({ page }) => {
    await openApp(page);
    await newChat(page);

    /*
     * First a command that publishes an artifact **into this conversation**.
     *
     * Without it the delete has nothing to detach, the count of artifacts
     * cannot move, and the assertion at the end of this test would hold
     * whatever deletion did — the exact shape of the assertion this package was
     * sent to replace (`e2e/chat.spec.ts` deleted a conversation that owned
     * none). The artifact is made by the real platform tool, in the real run.
     */
    /*
     * Wording distinct from the artifact test above: the title is derived from
     * the first message, the suite is serial over one database, and two
     * conversations with the same title make the drawer row this test deletes
     * ambiguous — which is how the first version of this deleted the other
     * test's conversation instead.
     */
    await send(page, 'Zapisz artefakt rozmowy przeznaczonej do usuniecia.');
    await settled(page);
    const conversationId = await conversationOnScreen(page);
    const artifactsBefore = (await getJson(page, '/api/artifacts')).artifacts as Array<Record<string, any>>;
    const owned = artifactsBefore.filter((a) => a.threadId === conversationId);
    expect(owned.length, 'rozmowa nie ma artefaktu, wiec odlaczenie nie ma czego dotyczyc').toBeGreaterThan(0);
    const ownedId = owned[0]!.id as string;

    // Now the long task, in the same conversation, still running when it goes.
    await send(page, 'Popracuj dlugo nad czyms do usuniecia.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    await expect
      .poll(async () => (await getJson(page, '/api/runs/active')).runs.map((r: any) => r.conversationId))
      .toContain(conversationId);
    /*
     * The count of runs actually executing in the backend process, from
     * `/api/status`. It is the only signal here that survives the delete:
     * `/api/runs/active` reads `agent_runs`, and those rows cascade away with
     * the conversation — so "the task is no longer listed" is true whether it
     * was stopped or is still running against a conversation that no longer
     * exists. A detection trial that removed the cancellation passed on that
     * assertion alone; this is the assertion it now has to get past.
     */
    expect((await getJson(page, '/api/status')).activeRuns).toBe(1);

    /*
     * Deleted from the row's own menu, as a user would — not over the API. The
     * row is named after the conversation's *first* message (the artifact
     * command), because that is what the title is derived from.
     */
    const rowTitle = 'Zapisz artefakt rozmowy przeznaczonej do usuniecia';
    await openDrawer(page);
    const row = page.locator('.openui-agent-thread-button', { hasText: rowTitle }).first();
    await expect(row).toBeVisible();
    await row.locator('[aria-label="Thread actions"]').first().click();
    await page.getByRole('menuitem').first().click();

    // Gone from the list…
    await expect(page.locator('.openui-agent-thread-button', { hasText: rowTitle })).toHaveCount(0);
    // …and the work it owned stopped, rather than carrying on against a
    // conversation that no longer exists.
    await expect
      .poll(async () => (await getJson(page, '/api/runs/active')).runs.map((r: any) => r.conversationId), {
        timeout: 30_000,
      })
      .not.toContain(conversationId);
    /*
     * And it really stopped. The scripted task had over ten seconds of work
     * left when the row was removed, so a run that was merely orphaned would
     * still be counted here well past this deadline.
     */
    await expect
      .poll(async () => (await getJson(page, '/api/status')).activeRuns, { timeout: 8_000 })
      .toBe(0);
    expect((await getJson(page, `/api/threads/get/${conversationId}`)).error?.code).toBe('not_found');

    /*
     * Published work is untouched — and detached rather than deleted: the
     * artifact this conversation produced is still listed, still openable with
     * its content, and no longer names a conversation that is gone.
     */
    const artifactsAfter = (await getJson(page, '/api/artifacts')).artifacts as Array<Record<string, any>>;
    expect(artifactsAfter.length).toBe(artifactsBefore.length);
    expect(artifactsAfter.map((a) => a.id)).toContain(ownedId);
    expect(artifactsAfter.filter((a) => a.threadId === conversationId)).toEqual([]);
    const detached = await getJson(page, `/api/artifacts/${ownedId}`);
    expect(detached.threadId).toBe('');
    expect(detached.content, 'odlaczony artefakt stracil tresc').toBeTruthy();
    await expect(page.getByTestId('conversation-missing')).toHaveCount(0);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeEnabled();
  });
});
