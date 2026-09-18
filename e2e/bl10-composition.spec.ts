import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * What the agent changing a composition does to the work in progress, and what
 * an answer is made of.
 *
 *  - **L3.5** adding, replacing and removing a card keeps the selection, the
 *    card's own view state and a half-typed form — or, when the card holding the
 *    form is gone, says so and lets the user decide, instead of the draft
 *    quietly disappearing;
 *  - **L3.7** the numbers on screen are the backend's. A note the model writes
 *    is a note: it does not become a record, and the comparison keeps showing
 *    what the backend returns;
 *  - **L3.11** prose, a valid composition and a tool's answer in one message are
 *    all visible; a composition naming a component nobody has is a readable
 *    failure and does not take the prose with it.
 *
 * The composition changes run through the real `canvas_*` handlers with the
 * run's own context — a scripted stand-in chooses *which* calls are made,
 * nothing else is replaced.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-bl10-comp' });
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

const fitView = async (page: Page) => {
  await page.getByRole('button', { name: 'Fit View' }).click();
  await page.waitForTimeout(400);
};

/** Opens a case's workspace the way a user does. */
async function openCaseWorkspace(page: Page): Promise<{ spaceId: string; caseId: string }> {
  await page.goto(`${BASE}/cases`);
  await page.locator('[data-testid^="case-tile-"]').first().click();
  await expect(page.getByTestId('case-detail-page')).toBeVisible();
  await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
  /*
   * Any card, not the summary in particular: one of these tests has the agent
   * replace that card, and the workspace is persistent, so a later test would
   * be waiting for something an earlier one deliberately removed.
   */
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  const spaceId = new URL(page.url()).searchParams.get('s')!;
  const caseId = await page.evaluate(async () => {
    const { cases } = await (await fetch('/api/m/procurement/cases', { credentials: 'include' })).json();
    return (cases as Array<{ id: string }>)[0]!.id;
  });
  return { spaceId, caseId };
}

/**
 * Adds a form card to the workspace through the API, as preparation.
 *
 * Any form card left by an earlier test is removed first: the workspace is
 * persistent, and a scenario that asks for "the card with the form on it" must
 * be unambiguous about which one it means.
 */
async function addFormCard(page: Page, spaceId: string, caseId: string) {
  return page.evaluate(
    async ({ spaceId, caseId }) => {
      const state = await (
        await fetch(`/api/canvas/spaces/${spaceId}`, { credentials: 'include' })
      ).json();
      for (const card of state.cards as Array<{ id: string; spec: { component?: string } }>) {
        if (card.spec?.component === 'procurement.offerItemForm') {
          await fetch(`/api/canvas/cards/${card.id}`, { method: 'DELETE', credentials: 'include' });
        }
      }
      const detail = await (
        await fetch(`/api/m/procurement/cases/${caseId}`, { credentials: 'include' })
      ).json();
      const offer = detail.offers[0];
      const card = await (
        await fetch('/api/canvas/cards', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            spaceId,
            title: 'Pozycja oferty',
            spec: {
              kind: 'component',
              component: 'procurement.offerItemForm',
              props: { offerId: offer.offer.id },
            },
            geometry: { x: 1180, y: 0, width: 440, height: 420 },
          }),
        })
      ).json();
      return { cardId: card.id as string, itemId: offer.items[0].id as string };
    },
    { spaceId, caseId },
  );
}

test.describe('zmiana kompozycji przez agenta', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  test.use({ viewport: { width: 1680, height: 1000 } });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });
  test.afterEach(() => scripted.stop());

  /* ----------------------------------------------------------------- L3.5 -- */

  test('dodanie karty zachowuje zaznaczenie, stan widoku karty i niezapisany szkic', async ({
    page,
  }) => {
    await scripted.start('bl10-composition');
    await openApp(page);
    const { spaceId, caseId } = await openCaseWorkspace(page);
    const form = await addFormCard(page, spaceId, caseId);
    await page.reload();
    await expect(page.locator(`[data-card="${form.cardId}"]`)).toBeVisible();
    await fitView(page);

    // Three pieces of work in progress: a card marked for the agent, a card's
    // own view state, and a half-typed value.
    const summaryTitle = page
      .locator('.react-flow__node')
      .filter({ hasText: 'Podsumowanie sprawy' })
      .locator('.pf-card__title');
    await summaryTitle.click();
    await expect(summaryTitle).toHaveAttribute('aria-pressed', 'true');

    const excluded = page.getByTestId('card-comparison').locator('input[type="checkbox"]').first();
    await expect(excluded).toBeChecked();
    await excluded.uncheck();

    const quantity = page.locator(`[data-card="${form.cardId}"] input[type="number"]`).first();
    await quantity.fill('42.5');

    // The agent adds a card. Every client showing this space re-reads it.
    await send(page, 'Dodaj notatke do przestrzeni.');
    await expect(page.locator('.pf-card', { hasText: 'Notatka agenta' }).first()).toBeVisible({
      timeout: 60_000,
    });
    await settled(page);

    // None of the three was lost by the composition changing under them.
    await expect(summaryTitle).toHaveAttribute('aria-pressed', 'true');
    await expect(excluded).not.toBeChecked();
    await expect(quantity).toHaveValue('42.5');
    // And no conflict is claimed, because nothing was in conflict.
    await expect(page.getByTestId('draft-conflict')).toHaveCount(0);
  });

  test('podmiana karty zachowuje niezapisany szkic, ktory wraca do formularza', async ({ page }) => {
    await scripted.restart('bl10-composition');
    await openApp(page);
    const { spaceId, caseId } = await openCaseWorkspace(page);
    const form = await addFormCard(page, spaceId, caseId);
    await page.reload();
    await expect(page.locator(`[data-card="${form.cardId}"]`)).toBeVisible();
    await fitView(page);

    const quantity = page.locator(`[data-card="${form.cardId}"] input[type="number"]`).first();
    await quantity.fill('33.25');

    // The agent replaces a *different* card's content. The form is re-rendered
    // with everything else on the canvas.
    await send(page, 'Podmien podsumowanie na warunki dostawy.');
    await expect(page.locator('.pf-card', { hasText: 'Warunki dostawy' }).first()).toBeVisible({
      timeout: 60_000,
    });
    await settled(page);

    // The half-typed value is still there — the draft outlives the render.
    await expect(quantity).toHaveValue('33.25');
    await expect(page.getByTestId('draft-conflict')).toHaveCount(0);
  });

  test('niezapisany szkic wraca do formularza zbudowanego od nowa', async ({ page }) => {
    await scripted.restart('bl10-composition');
    await openApp(page);
    const { spaceId, caseId } = await openCaseWorkspace(page);
    const form = await addFormCard(page, spaceId, caseId);
    await page.reload();
    await expect(page.locator(`[data-card="${form.cardId}"]`)).toBeVisible();
    await fitView(page);

    const quantity = page.locator(`[data-card="${form.cardId}"] input[type="number"]`).first();
    await quantity.fill('55.5');

    /*
     * Leaving the canvas unmounts the card and everything in it — the strongest
     * available way to build the form *again* rather than re-render it. The
     * other tests in this file change the composition, which re-renders the
     * card in place (React keeps the node), so they cannot tell a draft that
     * survived from a component that was never taken apart. This one can: the
     * card is gone from the document in between.
     */
    await page.getByRole('link', { name: 'Ustawienia' }).click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(page.locator(`[data-card="${form.cardId}"]`)).toHaveCount(0);

    await page.getByRole('link', { name: 'Canvas' }).click();
    await expect(page.locator(`[data-card="${form.cardId}"]`)).toBeVisible();
    await expect(quantity, 'szkic nie wrocil do odtworzonego formularza').toHaveValue('55.5');
    // Still a draft, not a save: the record keeps the value the backend has.
    await expect(page.locator(`[data-card="${form.cardId}"] .pf-field--dirty`).first()).toBeVisible();
    const stored = await page.evaluate(async (itemId) => {
      const { cases } = await (await fetch('/api/m/procurement/cases', { credentials: 'include' })).json();
      const detail = await (
        await fetch(`/api/m/procurement/cases/${(cases as Array<{ id: string }>)[0]!.id}`, {
          credentials: 'include',
        })
      ).json();
      for (const offer of detail.offers) {
        const item = offer.items.find((i: { id: string }) => i.id === itemId);
        if (item) return item.quantityMilli as number;
      }
      return null;
    }, form.itemId);
    expect(stored).not.toBe(55_500);
  });

  test('usuniecie karty ze szkicem nie gubi go po cichu — konflikt jest rozstrzygany jawnie', async ({
    page,
  }) => {
    await scripted.restart('bl10-composition');
    await openApp(page);
    const { spaceId, caseId } = await openCaseWorkspace(page);
    const form = await addFormCard(page, spaceId, caseId);
    await page.reload();
    await expect(page.locator(`[data-card="${form.cardId}"]`)).toBeVisible();
    await fitView(page);

    const quantity = page.locator(`[data-card="${form.cardId}"] input[type="number"]`).first();
    await quantity.fill('17.75');
    // The draft is registered, which is what the platform can notice.
    await expect(page.locator(`[data-card="${form.cardId}"] .pf-field--dirty`).first()).toBeVisible();

    await send(page, 'Usun formularz z przestrzeni.');
    await expect(page.locator(`[data-card="${form.cardId}"]`)).toHaveCount(0, { timeout: 60_000 });
    await settled(page);

    /*
     * The card is gone and the work in it is not: the conflict is on screen,
     * names the record and the fields, and nothing is discarded until the user
     * says so.
     */
    const conflict = page.getByTestId('draft-conflict');
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText('niezapisanymi zmianami');
    await expect(conflict).toContainText('quantity');
    await expect(conflict).toContainText('offer_item');

    // The stored record is untouched by any of this.
    const stored = await page.evaluate(async (itemId) => {
      const { cases } = await (await fetch('/api/m/procurement/cases', { credentials: 'include' })).json();
      const detail = await (
        await fetch(`/api/m/procurement/cases/${(cases as Array<{ id: string }>)[0]!.id}`, {
          credentials: 'include',
        })
      ).json();
      for (const offer of detail.offers) {
        const item = offer.items.find((i: { id: string }) => i.id === itemId);
        if (item) return item.quantityMilli as number;
      }
      return null;
    }, form.itemId);
    expect(stored).not.toBe(17_750);

    // Discarding is the user's decision, and it is what clears the notice.
    await page.getByTestId(`draft-discard-item-${form.itemId}`).click();
    await expect(conflict).toHaveCount(0);
  });

  /* ----------------------------------------------------------------- L3.7 -- */

  test('notatka agenta nie zastepuje wartosci z backendu', async ({ page }) => {
    await scripted.restart('bl10-composition');
    await openApp(page);
    const { spaceId, caseId } = await openCaseWorkspace(page);
    void spaceId;
    await fitView(page);

    /**
     * The ranking's first total, as the backend computes it, formatted the way
     * the card formats it — minor units, grouped, with the case's currency.
     * Formatted here rather than read from the screen: a value read off the
     * screen and then found on the screen proves nothing.
     */
    const backendTotal = await page.evaluate(async (caseId) => {
      const comparison = await (
        await fetch(`/api/m/procurement/cases/${caseId}/comparison`, { credentials: 'include' })
      ).json();
      const rows = (comparison.rows as Array<{ comparable: boolean; rank: number | null; totalMinor: number | null }>)
        .filter((r) => r.comparable && r.totalMinor !== null)
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
      const minor = rows[0]!.totalMinor!;
      const major = Math.floor(Math.abs(minor) / 100).toLocaleString('pl-PL');
      const rest = String(Math.abs(minor) % 100).padStart(2, '0');
      return `${major},${rest} ${comparison.caseCurrency}`;
    }, caseId);

    // What the card shows is what the backend returned.
    const table = page.getByTestId('card-comparison');
    await expect(table).toContainText(backendTotal);

    // Now the agent writes its own number into a note.
    await send(page, 'Dodaj notatke z podsumowaniem.');
    const note = page.locator('.pf-card', { hasText: 'Notatka agenta' }).first();
    await expect(note).toBeVisible({ timeout: 60_000 });
    await expect(note).toContainText('999 999,99');
    await settled(page);

    // The note is a note. The comparison still shows the backend's figure, and
    // the backend's figure has not changed.
    await expect(table).toContainText(backendTotal);
    const after = await page.evaluate(async (caseId) => {
      const comparison = await (
        await fetch(`/api/m/procurement/cases/${caseId}/comparison`, { credentials: 'include' })
      ).json();
      const rows = (comparison.rows as Array<{ comparable: boolean; rank: number | null; totalMinor: number | null }>)
        .filter((r) => r.comparable && r.totalMinor !== null)
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
      const minor = rows[0]!.totalMinor!;
      const major = Math.floor(Math.abs(minor) / 100).toLocaleString('pl-PL');
      const rest = String(Math.abs(minor) % 100).padStart(2, '0');
      return {
        top: `${major},${rest} ${comparison.caseCurrency}`,
        any999: JSON.stringify(comparison).includes('99999999'),
      };
    }, caseId);
    expect(after.top).toBe(backendTotal);
    expect(after.any999, 'wygenerowana liczba trafila do danych').toBe(false);
  });

  test('widok agenta z wpisanymi liczbami jest odrzucony, nic nie zostaje zapisane', async ({
    page,
  }) => {
    await scripted.restart('bl10-composition');
    await openApp(page);

    await send(page, 'Zrob widok i wpisz liczby recznie.');
    await settled(page);

    // Refused, by name, in the answer the agent received.
    const answer = page.locator('.pf-chat');
    await expect(answer).toContainText('validation_failed');

    // And the conversation's agent views hold nothing.
    const cards = await page.evaluate(async () => {
      const { threads } = await (await fetch('/api/threads/get', { credentials: 'include' })).json();
      const id = (threads as Array<{ id: string }>)[0]!.id;
      const views = await (
        await fetch(`/api/conversations/${id}/agent-views`, { credentials: 'include' })
      ).json();
      return (views.cards ?? []) as unknown[];
    });
    expect(cards).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ L3.11 -- */

test.describe('rodzaje odpowiedzi w czacie', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  test.use({ viewport: { width: 1680, height: 1000 } });

  const messages = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-bl10-msg' });
  const MSG_BASE = messages.baseUrl;

  const openMsgApp = async (page: Page) => {
    await page.goto(`${MSG_BASE}/`);
    await page.evaluate(() =>
      fetch('/api/auth/session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    await page.goto(`${MSG_BASE}/`);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
  };

  test.beforeAll(async () => {
    messages.prepareDatabase();
    await messages.start('bl10-messages');
  });
  test.afterAll(() => messages.stop());

  test('proza, poprawny OpenUI i wynik narzedzia widoczne obok siebie w jednej wiadomosci', async ({
    page,
  }) => {
    await openMsgApp(page);
    await send(page, 'Pokaz tabele i wyjasnienie.');
    await settled(page);

    const message = page.getByTestId('assistant-message').last();

    /*
     * The prose. This is the assertion the criterion is about: registering a
     * component catalog turned every answer over to the GenUI renderer, which
     * draws a composition and nothing else — so a sentence next to a table was
     * dropped without an error, and the answer looked complete.
     */
    await expect(message.getByTestId('assistant-prose').first()).toBeVisible();
    await expect(message).toContainText('Ponizej dostawcy z backendu');
    await expect(message).toContainText('Tabela pobiera dane sama');

    // The composition, rendered from the catalog, with values from a read.
    const composed = message.getByTestId('assistant-openui').first();
    await expect(composed).toBeVisible();
    await expect(composed).toContainText('Dostawcy');
    const supplier = await page.evaluate(async () => {
      const { suppliers } = await (
        await fetch('/api/m/procurement/suppliers', { credentials: 'include' })
      ).json();
      return (suppliers as Array<{ name: string }>)[0]!.name;
    });
    await expect(composed).toContainText(supplier);

    // The tool's own answer is in the same turn.
    await expect(page.locator('.pf-chat')).toContainText('procurement_list_cases');
  });

  test('sama proza pozostaje proza', async ({ page }) => {
    await openMsgApp(page);
    await send(page, 'Odpowiedz sama proza.');
    await settled(page);

    const message = page.getByTestId('assistant-message').last();
    await expect(message).toContainText('to jest zwykla odpowiedz tekstowa');
    // Nothing was interpreted as a composition.
    await expect(message.getByTestId('assistant-openui')).toHaveCount(0);
  });

  test('bledny opis jest czytelna awaria, a proza obok niego zostaje', async ({ page }) => {
    await openMsgApp(page);
    await send(page, 'Pokaz bledny opis interfejsu.');
    await settled(page);

    const message = page.getByTestId('assistant-message').last();
    // The words are still there…
    await expect(message).toContainText('Sprobuje pokazac to komponentem');
    await expect(message).toContainText('powinno to byc widac');
    /*
     * …and the composition that could not be rendered says so, in place, with
     * the description itself. Nothing throws on this path — the renderer skips
     * what it does not recognise — so an empty box was the whole of the answer's
     * second half, and it read as a finished reply.
     */
    const composed = message.getByTestId('assistant-openui').first();
    await expect(composed).toHaveAttribute('data-empty', 'true');
    await expect(message.getByTestId('assistant-openui-empty')).toBeVisible();
    await expect(message.getByTestId('assistant-openui-empty')).toContainText(
      'NieMaTakiegoKomponentu',
    );
    await expect(message.getByTestId('assistant-prose').first()).toBeVisible();
  });

  test('czesciowy opis nie kasuje tego, co juz powiedziano', async ({ page }) => {
    await openMsgApp(page);
    await send(page, 'Pokaz czesciowy opis interfejsu.');
    await settled(page);

    const message = page.getByTestId('assistant-message').last();
    await expect(message).toContainText('Zaczynam opis interfejsu');
    /*
     * And it is *told apart* from the other three kinds, which is what the
     * criterion asks for and what the prose assertion alone cannot show.
     *
     * A half-written description parses into a component over a read that does
     * not exist — the fence was cut mid-identifier — so the data component says
     * exactly that, by name, and lists the reads there are. Distinct from the
     * valid case (a table with rows from the backend), from prose (no
     * composition at all) and from a description naming an unknown component
     * (nothing drawn, reported with its own source, `data-empty="true"`).
     */
    const composed = message.getByTestId('assistant-openui').first();
    await expect(composed).toHaveAttribute('data-empty', 'false');
    const failure = composed.getByRole('alert');
    await expect(failure).toBeVisible();
    await expect(failure).toContainText('Nie udalo sie wczytac danych');
    await expect(failure).toContainText('procurement.suppl');
    // Not a table of made-up rows standing in for the one that was asked for.
    await expect(composed.locator('table')).toHaveCount(0);
    await expect(message.getByTestId('assistant-openui-empty')).toHaveCount(0);
  });
});
