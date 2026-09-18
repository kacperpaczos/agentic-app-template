import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Locator, type Page } from '@playwright/test';

/**
 * The shell a user works in: the conversation drawer, the canvas, and reaching
 * both from the keyboard.
 *
 *  - **L2.9** the drawer opens and closes on a wide and on a narrow panel, with
 *    the mouse and from the keyboard, and neither the canvas nor an overflow
 *    takes its clicks;
 *  - **L2.12** pan, zoom, move and resize are the ready-made canvas library's
 *    and are persisted, and none of them interrupts typing in the conversation
 *    or in a form on a card;
 *  - **L2.5** labels, roles, `aria-*` that carries state, a focus ring that is
 *    actually drawn, and a form that can be filled and saved without a mouse.
 *
 * On its own instance with a scripted stand-in for the model: no command is
 * sent here, but the instance is isolated so moving cards and editing a record
 * cannot disturb another suite.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-bl10-shell' });
const BASE = scripted.baseUrl;

async function signIn(page: Page) {
  await page.goto(`${BASE}/`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
}

/** Opens a case's workspace the way a user does, and answers with its space id. */
async function openCaseWorkspace(page: Page): Promise<{ spaceId: string; caseId: string }> {
  await page.goto(`${BASE}/cases`);
  await page.locator('[data-testid^="case-tile-"]').first().click();
  await expect(page.getByTestId('case-detail-page')).toBeVisible();
  await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
  await expect(page.getByTestId('card-case-summary').first()).toBeVisible();
  const url = new URL(page.url());
  const spaceId = url.searchParams.get('s');

  expect(spaceId, 'przestrzen sprawy nie trafila do adresu').toBeTruthy();
  const caseId = await page.evaluate(async () => {
    const { cases } = await (
      await fetch('/api/m/procurement/cases', { credentials: 'include' })
    ).json();
    return (cases as Array<{ id: string }>)[0]!.id;
  });
  return { spaceId: spaceId!, caseId };
}

/**
 * Puts the stored viewport back to something the cards fit in.
 *
 * The workspace's pan and zoom are persistent, and these tests change them on
 * purpose — so a later one would otherwise start with cards off screen or under
 * the navigation. The library's own "Fit View" control is what a user would
 * reach for, and it is the same control either way.
 */
async function fitView(page: Page) {
  await page.getByRole('button', { name: 'Fit View' }).click();
  await page.waitForTimeout(400);
}

/** The canvas transform the library maintains (pan and zoom in one string). */
const viewportTransform = (page: Page) =>
  page.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform);

/** The workspace's stored viewport, as the backend has it. */
const storedViewport = (page: Page, spaceId: string) =>
  page.evaluate(async (id) => {
    const state = await (await fetch(`/api/canvas/spaces/${id}`, { credentials: 'include' })).json();
    return state.space.viewport as { x: number; y: number; zoom: number };
  }, spaceId);

/** One card's stored geometry. */
const storedGeometry = (page: Page, spaceId: string, cardId: string) =>
  page.evaluate(
    async ({ id, cardId }) => {
      const state = await (await fetch(`/api/canvas/spaces/${id}`, { credentials: 'include' })).json();
      const card = (state.cards as Array<{ id: string; geometry: Record<string, number> }>).find(
        (c) => c.id === cardId,
      );
      return card?.geometry ?? null;
    },
    { id: spaceId, cardId },
  );

async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Several steps: the library's drag handlers need movement, not a teleport.
  for (let i = 1; i <= 5; i += 1) {
    await page.mouse.move(from.x + (dx * i) / 5, from.y + (dy * i) / 5);
  }
  await page.mouse.up();
}

const centreOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error('element nie ma pudelka');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test.beforeAll(async () => {
  scripted.prepareDatabase();
  await scripted.start('text-only');
});
test.afterAll(() => scripted.stop());

/* -------------------------------------------------------------------- L2.9 -- */

/**
 * Two panel widths that are genuinely different arrangements of the ready-made
 * chat, not two numbers.
 *
 * `AgentInterface` measures its own container and switches at 768px: below it
 * the drawer is off-canvas with an overlay, above it the drawer is part of the
 * panel's layout. The shell produces both — a viewport wider than 1100px gives
 * the chat its own 560px column (narrow panel, off-canvas drawer), a narrower
 * viewport puts the chat across the full width of a second row (wide panel,
 * in-layout drawer). Testing 1680 and 1120, as the earlier suite did, measured
 * the same 560px panel twice.
 */
for (const panel of [
  { name: 'waski panel czatu (kolumna 560 px)', width: 1680, height: 1000, expectWide: false },
  { name: 'szeroki panel czatu (pelna szerokosc)', width: 1000, height: 900, expectWide: true },
]) {
  test.describe(`szuflada rozmow — ${panel.name}`, () => {
    test.use({ viewport: { width: panel.width, height: panel.height } });
    test.describe.configure({ mode: 'serial', timeout: 120_000 });

    const container = (page: Page) => page.locator('.openui-agent-sidebar-container');
    const list = (page: Page) => page.locator('.openui-agent-thread-list');
    /*
     * The library names the same control differently in its two arrangements:
     * "Open sidebar" in the mobile one (a menu button in the panel's header),
     * "Expand sidebar" in the other (the button in the collapsed rail). Both are
     * asked for, and only the visible one is used — which is also the assertion
     * that *some* labelled control exists at this width.
     */
    const opener = (page: Page) =>
      page.locator('.pf-chat [aria-label="Open sidebar"], .pf-chat [aria-label="Expand sidebar"]').filter({
        visible: true,
      });
    const closer = (page: Page) =>
      page.locator('.pf-chat [aria-label="Collapse sidebar"], .pf-chat [aria-label="Close sidebar"]').filter({
        visible: true,
      });

    /** Whether the drawer has settled in the given state, by the library's own signal. */
    const settled = async (page: Page, state: 'collapsed' | 'expanded') =>
      expect(container(page)).toHaveAttribute('data-sidebar-visual-state', state, { timeout: 10_000 });

    /**
     * Open *and* stopped moving.
     *
     * The visual state flips before the slide finishes, and a hit test or a
     * click taken during the slide reads the drawer where it no longer is —
     * which looks exactly like the canvas stealing the interaction. So the
     * geometry is what is polled: the conversation list inside the panel.
     */
    const settledOpen = async (page: Page) => {
      await settled(page, 'expanded');
      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const panel = document.querySelector('.pf-chat')?.getBoundingClientRect();
              const l = document.querySelector('.openui-agent-thread-list')?.getBoundingClientRect();
              if (!panel || !l || l.width === 0) return false;
              const cx = l.x + l.width / 2;
              return cx > panel.left && cx < panel.right;
            }),
          { timeout: 8000, message: 'szuflada nie zatrzymala sie w panelu' },
        )
        .toBe(true);
    };

    /** What a user would actually hit at this point. */
    const ownerAt = (page: Page, x: number, y: number) =>
      page.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return 'nic';
          if (el.closest('.openui-agent-sidebar-container')) return 'szuflada';
          if (el.closest('.react-flow')) return 'canvas';
          if (el.closest('.pf-chat')) return 'czat';
          return 'inne';
        },
        { x, y },
      );

    const start = async (page: Page) => {
      await signIn(page);
      await page.goto(`${BASE}/`);
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
      // The panel really is the width this case is about.
      const width = await page.locator('.pf-chat').evaluate((el) => el.getBoundingClientRect().width);
      expect(width > 768, `panel ma ${Math.round(width)} px`).toBe(panel.expectWide);
      if ((await container(page).getAttribute('data-sidebar-visual-state')) === 'expanded') {
        await closer(page).click();
        await settled(page, 'collapsed');
      }
    };

    test('mysz otwiera i zamyka szuflade, kompozytor pozostaje dostepny', async ({ page }) => {
      await start(page);

      await opener(page).click();
      await settledOpen(page);
      await expect(list(page)).toBeVisible();

      // Reachable by a real click, not merely present: whatever is at the middle
      // of the conversation list belongs to the drawer. The list rather than the
      // container, because the container's box reaches beyond the panel while
      // the drawer is an overlay, and a point outside the panel says nothing.
      const middle = await centreOf(list(page));
      expect(await ownerAt(page, middle.x, middle.y)).toBe('szuflada');

      // Closed with the mouse — the case the earlier suite covered only from the
      // keyboard — and the conversation comes back.
      await closer(page).click();
      await settled(page, 'collapsed');
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
      await page.locator('.openui-agent-thread-composer__input').fill('po zamknieciu szuflady');
      await expect(page.locator('.openui-agent-thread-composer__input')).toHaveValue(
        'po zamknieciu szuflady',
      );
    });

    test('klawiatura otwiera i zamyka szuflade', async ({ page }) => {
      await start(page);

      await opener(page).focus();
      await expect(opener(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await settledOpen(page);
      await expect(list(page)).toBeVisible();

      await closer(page).focus();
      await expect(closer(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await settled(page, 'collapsed');
    });

    test('otwarta szuflada przyjmuje klikniecie wiersza, canvas go nie przechwytuje', async ({
      page,
    }) => {
      await start(page);
      const title = `Rozmowa szufladowa ${Date.now()}`;
      await page.evaluate(
        (t) =>
          fetch('/api/threads/create', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [{ id: crypto.randomUUID(), role: 'user', content: t }] }),
          }),
        title,
      );
      await page.reload();
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
      if ((await container(page).getAttribute('data-sidebar-visual-state')) === 'expanded') {
        await closer(page).click();
        await settled(page, 'collapsed');
      }

      await opener(page).click();
      await settledOpen(page);
      const row = page.getByText(title, { exact: false }).first();
      await expect(row).toBeVisible();

      /*
       * The decisive check: the point the row occupies belongs to the row, and
       * an ordinary click — no `force`, no coordinates — selects the
       * conversation. A drawer whose clicks the canvas or an overflow took
       * would fail here rather than silently do nothing.
       */
      const at = await centreOf(row);
      expect(await ownerAt(page, at.x, at.y)).toBe('szuflada');
      await row.click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('c'), { timeout: 15_000 })
        .not.toBeNull();
      await expect(page.locator('.openui-agent-thread-messages')).toContainText(title, {
        timeout: 15_000,
      });
    });
  });
}

/* ------------------------------------------------------------------- L2.12 -- */

test.describe('canvas: pan, zoom, przesuniecie i zmiana rozmiaru', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.use({ viewport: { width: 1680, height: 1000 } });

  test('zoom i pan zmieniaja widok i sa zapamietane', async ({ page }) => {
    await signIn(page);
    const { spaceId } = await openCaseWorkspace(page);

    await fitView(page);
    const before = await viewportTransform(page);
    const zoomBefore = (await storedViewport(page, spaceId)).zoom;
    // The library's own control, by its label.
    await page.getByRole('button', { name: 'Zoom In' }).click();
    await expect.poll(() => viewportTransform(page), { timeout: 10_000 }).not.toBe(before);
    const zoomed = await storedViewport(page, spaceId);

    // Pan: drag the empty canvas, not a card.
    const pane = page.locator('.react-flow__pane');
    const box = (await pane.boundingBox())!;
    await dragBy(page, { x: box.x + box.width * 0.7, y: box.y + box.height * 0.8 }, -160, -120);
    await expect.poll(() => viewportTransform(page), { timeout: 10_000 }).not.toBe(
      `matrix(${zoomed.zoom}, 0, 0, ${zoomed.zoom}, ${zoomed.x}, ${zoomed.y})`,
    );

    // Both are persisted with the space, so they come back on a reload.
    await expect
      .poll(async () => (await storedViewport(page, spaceId)).zoom, { timeout: 10_000 })
      .toBeGreaterThan(zoomBefore);
    const panned = await storedViewport(page, spaceId);
    await page.reload();
    await expect(page.getByTestId('card-case-summary').first()).toBeVisible();
    const after = await storedViewport(page, spaceId);
    expect(after).toEqual(panned);
  });

  test('zmiana rozmiaru karty kontrolka biblioteki jest widoczna i trwala', async ({ page }) => {
    await signIn(page);
    const { spaceId } = await openCaseWorkspace(page);

    await fitView(page);
    const card = page.locator('.react-flow__node').first();
    const cardId = (await card.getAttribute('data-id'))!;
    const geometryBefore = (await storedGeometry(page, spaceId, cardId))!;

    // Selecting the card is what shows the library's resize control. Clicked on
    // its header, which is also its drag handle — a click without movement
    // selects and does not move it.
    await card.locator('.pf-card__head').click({ position: { x: 4, y: 4 } });
    const handle = page.locator(`.react-flow__node[data-id="${cardId}"] .pf-card__resize-handle.bottom.right`);
    await expect(handle).toBeVisible();

    const boxBefore = (await card.boundingBox())!;
    const at = await centreOf(handle);
    await dragBy(page, at, 140, 90);

    /*
     * On screen first: the card is wider and taller than it was. Compared with
     * its own box, not with the stored width — the canvas is zoomed, so the two
     * are in different units and comparing them would measure the zoom.
     */
    await expect
      .poll(async () => (await card.boundingBox())!.width, { timeout: 10_000 })
      .toBeGreaterThan(boxBefore.width + 60);
    expect((await card.boundingBox())!.height).toBeGreaterThan(boxBefore.height + 30);

    // And stored, so a reload shows the size the user left it at.
    await expect
      .poll(async () => (await storedGeometry(page, spaceId, cardId))!.width, { timeout: 10_000 })
      .toBeGreaterThan(geometryBefore.width! + 60);
    const geometryAfter = (await storedGeometry(page, spaceId, cardId))!;
    expect(geometryAfter.height).toBeGreaterThan(geometryBefore.height! + 40);

    await page.reload();
    await expect(page.getByTestId('card-case-summary').first()).toBeVisible();
    expect((await storedGeometry(page, spaceId, cardId))!.width).toBe(geometryAfter.width);
  });

  test('przeciaganie i pan nie przerywaja pisania w czacie ani w formularzu karty', async ({
    page,
  }) => {
    await signIn(page);
    const { spaceId, caseId } = await openCaseWorkspace(page);

    // A card with a form on it, prepared through the same API the agent uses.
    await page.evaluate(
      async ({ spaceId, caseId }) => {
        const detail = await (
          await fetch(`/api/m/procurement/cases/${caseId}`, { credentials: 'include' })
        ).json();
        const offerId = detail.offers[0].offer.id as string;
        await fetch('/api/canvas/cards', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            spaceId,
            title: 'Pozycja oferty',
            spec: { kind: 'component', component: 'procurement.offerItemForm', props: { offerId } },
            geometry: { x: 1180, y: 0, width: 420, height: 360 },
          }),
        });
      },
      { spaceId, caseId },
    );
    await page.reload();
    await expect(page.getByTestId('card-item-form')).toBeVisible();
    await fitView(page);

    // Half a sentence in the conversation and half a value in the form.
    const composer = page.locator('.openui-agent-thread-composer__input');
    await composer.fill('polecenie w trakcie pisania');
    const quantity = page.getByTestId('card-item-form').locator('input[type="number"]').first();
    await quantity.fill('12.5');

    // Move a card by its header — the drag handle the canvas declares.
    const summaryCard = page.locator('.react-flow__node').first();
    const head = summaryCard.locator('.pf-card__head');
    await dragBy(page, await centreOf(head), 120, 60);

    // Pan the canvas under everything.
    const pane = page.locator('.react-flow__pane');
    const box = (await pane.boundingBox())!;
    await dragBy(page, { x: box.x + box.width * 0.5, y: box.y + box.height * 0.85 }, -90, -70);

    // Nothing that was being typed was lost, in either place.
    await expect(composer).toHaveValue('polecenie w trakcie pisania');
    await expect(quantity).toHaveValue('12.5');

    // And typing still works afterwards — the interaction was not left in a
    // half-finished drag state.
    await quantity.fill('13.5');
    await expect(quantity).toHaveValue('13.5');
    await composer.fill('polecenie dokonczone');
    await expect(composer).toHaveValue('polecenie dokonczone');
  });
});

/* -------------------------------------------------------------------- L2.5 -- */

test.describe('dostepnosc: etykiety, role, stan i fokus', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.use({ viewport: { width: 1680, height: 1000 } });

  /** The focus ring as the browser computes it for the element that has focus. */
  const focusRing = (page: Page) =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const s = getComputedStyle(el);
      const wrapper = el.closest('.openui-agent-thread-composer__input-wrapper');
      const ws = wrapper ? getComputedStyle(wrapper) : null;
      const widthOf = (v: string) => Number.parseFloat(v) || 0;
      return {
        tag: el.tagName.toLowerCase(),
        outlineStyle: s.outlineStyle,
        outlineWidth: widthOf(s.outlineWidth),
        // A control may move its ring to a wrapper it shares with a label.
        wrapperOutlineStyle: ws?.outlineStyle ?? 'none',
        wrapperOutlineWidth: ws ? widthOf(ws.outlineWidth) : 0,
        shadow: s.boxShadow,
      };
    });

  /** True when something visible marks the focused element. */
  const ringIsDrawn = (ring: Awaited<ReturnType<typeof focusRing>>) =>
    Boolean(
      ring &&
        ((ring.outlineStyle !== 'none' && ring.outlineWidth >= 1) ||
          (ring.wrapperOutlineStyle !== 'none' && ring.wrapperOutlineWidth >= 1) ||
          (ring.shadow !== 'none' && ring.shadow !== '')),
    );

  test('nawigacja i sekcje maja role, etykiety i stan w aria', async ({ page }) => {
    await signIn(page);
    await page.goto(`${BASE}/settings`);
    await expect(page.getByTestId('settings-page')).toBeVisible();

    // The navigation is a landmark with a name, not a div with links in it.
    const nav = page.getByRole('navigation', { name: 'Nawigacja glowna' });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Ustawienia' })).toBeVisible();

    // The collapse control carries its state, and the state follows the screen.
    const toggle = page.getByRole('button', { name: 'Zwin menu' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.focus();
    expect(ringIsDrawn(await focusRing(page)), 'brak widocznego obrysu na kontrolce menu').toBe(true);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Rozwin menu' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await page.getByRole('button', { name: 'Rozwin menu' }).press('Enter');
    await expect(page.getByRole('button', { name: 'Zwin menu' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    // The panel's two views are tabs, and the selected one says so.
    await expect(page.getByRole('tab', { name: 'Rozmowa' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Artefakty' })).toHaveAttribute(
      'aria-selected',
      'false',
    );

    /*
     * A collapsed section is a `<details>`: the browser gives it a focusable
     * control that opens on Enter and reports its own state, so there is no
     * `aria-expanded` of ours to drift from what is on screen.
     */
    const section = page.getByTestId('settings-tools-section');
    await expect(section).not.toHaveAttribute('open', '');
    const summary = section.locator('summary');
    await summary.focus();
    expect(ringIsDrawn(await focusRing(page)), 'brak widocznego obrysu na naglowku sekcji').toBe(true);
    await page.keyboard.press('Enter');
    await expect(section).toHaveAttribute('open', '');
    await expect(page.getByTestId('settings-tools')).toBeVisible();
  });

  test('fokus jest widoczny przy przechodzeniu tabulatorem', async ({ page }) => {
    await signIn(page);
    await page.goto(`${BASE}/files`);
    await expect(page.getByTestId('files-page')).toBeVisible();

    /*
     * Tab, and look at what the browser actually draws.
     *
     * The earlier test's name promised "visible focus" and its assertion was
     * `toBeFocused()` — which is true for a control with `outline: none` as
     * readily as for one with a ring. So this walks the first controls of the
     * page with the keyboard and requires a ring, an offset ring on the
     * wrapper, or a shadow on every one of them.
     */
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    const seen: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      const ring = await focusRing(page);
      if (!ring) continue;
      seen.push(ring.tag);
      expect(ringIsDrawn(ring), `brak widocznego obrysu na ${ring.tag} (krok ${i + 1})`).toBe(true);
    }
    expect(seen.length, 'tabulator nie dotarl do zadnej kontrolki').toBeGreaterThan(3);
  });

  test('wgrywanie pliku i pola formularza karty maja etykiety i dzialaja z klawiatury', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${BASE}/files`);
    await expect(page.getByTestId('files-page')).toBeVisible();

    // The upload control is reachable by its label, not by its id.
    const upload = page.getByLabel(/Wgraj plik/);
    await expect(upload).toBeVisible();
    await upload.focus();
    await expect(upload).toBeFocused();
    expect(ringIsDrawn(await focusRing(page)), 'brak widocznego obrysu na polu pliku').toBe(true);

    /* --- the form on a card: labels, keyboard, and a result from the backend -- */

    const { spaceId, caseId } = await openCaseWorkspace(page);
    const prepared = await page.evaluate(
      async ({ spaceId, caseId }) => {
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
              geometry: { x: 1180, y: 520, width: 440, height: 420 },
            }),
          })
        ).json();
        return {
          itemId: offer.items[0].id as string,
          offerId: offer.offer.id as string,
          cardId: card.id as string,
        };
      },
      { spaceId, caseId },
    );
    await page.reload();
    await expect(page.getByTestId('card-case-summary').first()).toBeVisible();
    await fitView(page);
    // This test's own card: the space may already hold another form from an
    // earlier test in this file, and asserting on "a form" would then be
    // asserting on somebody else's offer.
    const form = page.locator(`[data-card="${prepared.cardId}"]`);
    await expect(form).toBeVisible();

    // Every control of the form has a label that names it.
    const itemSelect = form.getByLabel('Pozycja');
    await expect(itemSelect).toBeVisible();
    const quantity = form.getByLabel(/Nowa ilosc/);
    await expect(quantity).toBeVisible();
    const price = form.getByLabel(/Nowa cena jednostkowa/);
    await expect(price).toBeVisible();

    // Filled and saved without a mouse: focus the field, type, Tab on, Enter.
    await quantity.focus();
    expect(ringIsDrawn(await focusRing(page)), 'brak widocznego obrysu na polu ilosci').toBe(true);
    await page.keyboard.type('7.25');
    await expect(quantity).toHaveValue('7.25');

    const save = form.getByTestId('save-item');
    await save.focus();
    await expect(save).toBeFocused();
    expect(ringIsDrawn(await focusRing(page)), 'brak widocznego obrysu na przycisku zapisu').toBe(
      true,
    );
    await page.keyboard.press('Enter');

    // The result is the backend's, not the field's.
    const savedQuantity = () =>
      page.evaluate(async ({ offerId, itemId }) => {
        const detail = await (
          await fetch(`/api/m/procurement/offers/${offerId}`, { credentials: 'include' })
        ).json();
        const item = (detail.items as Array<{ id: string; quantityMilli: number }>).find(
          (i) => i.id === itemId,
        );
        return item?.quantityMilli ?? null;
      }, prepared);

    await expect.poll(savedQuantity, { timeout: 20_000 }).toBe(7250);
    const saved = await savedQuantity();
    expect(saved, 'zapis z klawiatury nie dotarl do backendu').toBe(7250);
  });
});
