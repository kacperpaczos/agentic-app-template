import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * The agent moving the screen, and what has to stay true afterwards.
 *
 *  - **L2.15** the navigation is an ordinary one: Back and Forward keep working,
 *    the screen's description the next turn is given is the *new* screen, and a
 *    replayed event does not perform the jump a second time;
 *  - **L2.14** a target inside a collapsed section is uncovered, scrolled to and
 *    highlighted, the change is reported, and no setting's value moves.
 *
 * Run against a scripted stand-in for the model on its own instance, so the
 * commands are exactly these and cost no subscription turns. Every assertion is
 * about a visible effect or about what the client acknowledged — never about
 * the agent having said something.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-bl10-nav' });
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
  expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /succeeded|failed/, {
    timeout: 60_000,
  });

const answer = (page: Page) => page.locator('.pf-chat');

/** Everything said in the conversation whose title starts with `titlePart`. */
async function conversationText(page: Page, titlePart: string): Promise<string> {
  return page.evaluate(async (part) => {
    const { threads } = await (await fetch('/api/threads/get', { credentials: 'include' })).json();
    const found = (threads as Array<{ id: string; title: string }>).find((t) => t.title.includes(part));
    if (!found) return '';
    const messages = (await (
      await fetch(`/api/threads/get/${found.id}`, { credentials: 'include' })
    ).json()) as Array<{ content: string }>;
    return messages.map((m) => m.content).join(' ');
  }, titlePart);
}
const path = (page: Page) => new URL(page.url()).pathname;

test.describe('nawigacja zlecona przez agenta', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });
  test.afterEach(() => scripted.stop());

  /* ---------------------------------------------------------------- L2.15 -- */

  test('po nawigacji agenta Wstecz i Dalej dzialaja, a kontekst opisuje nowy ekran', async ({
    page,
  }) => {
    await scripted.start('ui-navigate-then-context');
    await openApp(page);
    // Somewhere that is not the destination, so arriving means something.
    await page.goto(`${BASE}/cases`);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    await expect(page.locator('[data-testid^="case-tile-"]').first()).toBeVisible();

    await send(page, 'Przelacz na pliki i opisz, co widac.');

    // The screen moved.
    await expect(page.getByTestId('files-page')).toBeVisible({ timeout: 60_000 });
    expect(path(page)).toBe('/files');
    await settled(page);

    /*
     * And the description the agent then read is of the screen it had just
     * opened — the same run, no second command. A description of where the user
     * *was* would be a context that lags one step behind every jump.
     */
    await expect(answer(page)).toContainText('[call:ui_state]');
    await expect(answer(page)).toContainText('platform.files');
    await expect(answer(page)).toContainText('/files?c=');

    /*
     * The acknowledgement itself is read from the conversation the backend
     * stored, not from the panel.
     *
     * Not a convenience: the ready-made chat renders only the assistant message
     * that *follows* the turn's tool call, so the text emitted before it — here,
     * the client's acknowledgement of the navigation — is on record and not on
     * screen. That is a defect of the chat's turn assembly, outside this
     * package (see the report); asserting it here from the record keeps this
     * test about navigation rather than about that.
     */
    const history = await conversationText(page, 'Przelacz na pliki');
    expect(history).toContain('[ui:pliki] executed=true');

    // An ordinary history entry: Back returns, Forward comes back.
    await page.goBack();
    await expect.poll(() => path(page), { timeout: 15_000 }).toBe('/cases');
    await page.goForward();
    await expect.poll(() => path(page), { timeout: 15_000 }).toBe('/files');
    await expect(page.getByTestId('files-page')).toBeVisible();
  });

  test('powtorzone zdarzenie nie nawiguje drugi raz', async ({ page }) => {
    await scripted.restart('ui-navigate-then-wait');
    await openApp(page);
    await page.goto(`${BASE}/cases`);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

    await send(page, 'Otworz pliki i pracuj dalej.');
    await expect(page.getByTestId('files-page')).toBeVisible({ timeout: 60_000 });
    expect(path(page)).toBe('/files');

    // The user moves on while the run is still going.
    await page.getByRole('link', { name: 'Ustawienia' }).click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    const parked = page.url();

    /*
     * A reload re-attaches to the run and the backend replays its events from
     * the start — the cursor this tab held is gone with the page. The
     * navigation is in that replay. Performing it again would drag the user
     * off the screen they chose, minutes after the agent asked for it.
     */
    await page.reload();
    await expect(page.getByTestId('settings-page')).toBeVisible({ timeout: 30_000 });
    // The run is genuinely still running, so the replay really did happen.
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /running|queued/, {
      timeout: 30_000,
    });
    await page.waitForTimeout(4000);
    expect(page.url(), 'powtorzone zdarzenie nawigowalo drugi raz').toBe(parked);
    await expect(page.getByTestId('files-page')).toHaveCount(0);

    await settled(page);
    expect(path(page)).toBe('/settings');
  });

  /* ---------------------------------------------------------------- L2.14 -- */

  test('cel w zwinietej sekcji zostaje odslonniety, podswietlony i zgloszony', async ({ page }) => {
    await scripted.restart('ui-open-tools');
    await openApp(page);

    const before = await page.evaluate(
      async () =>
        (await (await fetch('/api/status', { credentials: 'include' })).json()) as {
          auth: { method: string; credential: { state: string } };
          model: string;
        },
    );

    await page.goto(`${BASE}/settings`);
    await expect(page.getByTestId('settings-page')).toBeVisible();

    // The section starts closed: the anchor is in the document and nothing of
    // it is on screen. That is the case a "found it" answer used to get wrong.
    const section = page.getByTestId('settings-tools-section');
    await expect(section).not.toHaveAttribute('open', '');
    await expect(page.getByTestId('settings-tools')).toBeHidden();

    await send(page, 'Pokaz liste narzedzi agenta.');

    const target = page.getByTestId('settings-tools');
    await expect(target).toBeVisible({ timeout: 60_000 });
    await expect(section).toHaveAttribute('open', '');
    // Highlighted, and the highlight is markup rather than a claim.
    await expect(target).toHaveAttribute('data-ui-highlight', 'true', { timeout: 10_000 });
    /*
     * Scrolled to: the top of the element the user was sent to is inside the
     * viewport. Not "entirely inside" — the list is taller than the window, and
     * a criterion that no real target could meet would be a test that measures
     * the window rather than the behaviour. Polled because the scroll is
     * smooth, so it is still moving when the highlight appears.
     */
    await expect
      .poll(
        async () =>
          target.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.height > 0 && r.top >= 0 && r.top < window.innerHeight;
          }),
        { timeout: 10_000, message: 'element nie zostal przewiniety do widoku' },
      )
      .toBe(true);

    await settled(page);
    await expect(answer(page)).toContainText('executed=true');

    // Showing it changed the presentation and nothing else: no setting's value
    // moved, and the change of presentation is itself reported.
    const after = await page.evaluate(
      async () =>
        (await (await fetch('/api/status', { credentials: 'include' })).json()) as {
          auth: { method: string; credential: { state: string } };
          model: string;
        },
    );
    expect(after.auth.method).toBe(before.auth.method);
    expect(after.auth.credential.state).toBe(before.auth.credential.state);
    expect(after.model).toBe(before.model);

    const acknowledged = await conversationText(page, 'Pokaz liste narzedzi');
    expect(acknowledged).toContain('executed=true');

    // The highlight is temporary, not a permanent mark on the control.
    await expect(target).not.toHaveAttribute('data-ui-highlight', 'true', { timeout: 15_000 });
  });

  test('brak celu daje czytelna odmowe, ekran i ustawienia bez zmian', async ({ page }) => {
    await scripted.restart('ui-unknown');
    await openApp(page);
    await page.goto(`${BASE}/settings`);
    await expect(page.getByTestId('settings-page')).toBeVisible();

    await send(page, 'Pokaz cos, czego nie ma.');
    await settled(page);

    await expect(answer(page)).toContainText('executed=false');
    await expect(answer(page)).toContainText('unknown_target');
    expect(path(page)).toBe('/settings');
    // The refusal changed nothing on screen either: the section stays closed.
    await expect(page.getByTestId('settings-tools-section')).not.toHaveAttribute('open', '');
  });
});
