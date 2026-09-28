import { expect, test } from './support/fixtures.ts';
import { type APIRequestContext } from '@playwright/test';

/**
 * Conversation management through the ready-made OpenUI chat.
 *
 * No model call is made: conversations are created through the storage API the
 * chat itself uses, then driven in the browser. That keeps this suite free and
 * fast while still exercising the real component.
 */
async function seedThread(request: APIRequestContext, title: string) {
  await request.post('/api/auth/session', { data: {} });
  const created = await (
    await request.post('/api/threads/create', {
      data: { messages: [{ id: crypto.randomUUID(), role: 'user', content: title }] },
    })
  ).json();
  return created as { id: string; title: string };
}

test.describe('rozmowy', () => {
  test('rozmowa dostaje sensowny tytul z pierwszej wiadomosci', async ({ request }) => {
    const t = await seedThread(request, 'Porownaj oferty dla sprawy PC-2026-01. Potem dodaj wykres.');
    // Derived locally — the acceptance criteria forbid using the Anthropic API for titling.
    expect(t.title).toBe('Porownaj oferty dla sprawy PC-2026-01');
  });

  test('lista rozmow, przelaczanie i usuwanie', async ({ page, request }) => {
    const a = await seedThread(request, `Rozmowa alfa ${Date.now()}`);
    const b = await seedThread(request, `Rozmowa beta ${Date.now()}`);

    await page.goto('/');
    // At this panel width the chat uses its drawer arrangement: the conversation
    // list lives behind the "Open sidebar" control in the chat's own header.
    const list = page.locator('.openui-agent-thread-list');
    if (!(await list.isVisible().catch(() => false))) {
      await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
    }
    await expect(list).toBeVisible();

    await expect(page.getByText(a.title).first()).toBeVisible();
    await expect(page.getByText(b.title).first()).toBeVisible();

    // `force`: the thread list re-renders as it loads, and Playwright's
    // stability check never settles on an element inside it. Visibility is
    // asserted above, so forcing the click is safe here.
    await page.getByText(a.title).first().click({ force: true });
    await expect(page.getByText(a.title).first()).toBeVisible();

    // Picking a conversation closes the drawer — correct for a side panel, where
    // the point of choosing one is to get back to it. Reopen it to reach the
    // row's menu, exactly as a user would.
    await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
    await expect(list).toBeVisible();

    // Deletion driven entirely through the interface: the row's own menu, not
    // the REST endpoint. Anything less would not prove the user can do it.
    const row = page.locator('.openui-agent-thread-button', { hasText: a.title }).first();
    await row.locator('[aria-label="Thread actions"]').first().click();
    await page.getByRole('menuitem', { name: /delete|usu/i }).first().click();

    await expect(page.getByText(a.title)).toHaveCount(0);
    await expect(page.getByText(b.title).first()).toBeVisible();

    // The backend agrees with what the screen shows.
    const { threads } = await (await request.get('/api/threads/get')).json();
    expect(threads.map((t: { id: string }) => t.id)).not.toContain(a.id);
    expect(threads.map((t: { id: string }) => t.id)).toContain(b.id);
  });

  test('przelaczenie rozmowy nie miesza wiadomosci', async ({ request }) => {
    const a = await seedThread(request, `Pierwsza ${Date.now()}`);
    const b = await seedThread(request, `Druga ${Date.now()}`);
    const ma = await (await request.get(`/api/threads/get/${a.id}`)).json();
    const mb = await (await request.get(`/api/threads/get/${b.id}`)).json();
    expect(ma).toHaveLength(1);
    expect(mb).toHaveLength(1);
    expect(ma[0].content).not.toBe(mb[0].content);
  });

  test('usuniecie rozmowy odlacza artefakty zamiast je kasowac', async ({ request }) => {
    await request.post('/api/auth/session', { data: {} });
    const before = await (await request.get('/api/artifacts')).json();
    const t = await seedThread(request, `Do usuniecia ${Date.now()}`);
    const del = await (await request.delete(`/api/threads/delete/${t.id}`)).json();
    expect(del.deleted).toBe(t.id);
    const after = await (await request.get('/api/artifacts')).json();
    expect(after.artifacts.length).toBe(before.artifacts.length);
  });

  test('czat pokazuje, do jakiego zasobu odnosi sie rozmowa', async ({ page }) => {
    await page.goto('/cases');
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    await expect(page.getByTestId('chat-context')).toContainText('case:');
  });

  test('zaznaczenie karty trafia do kontekstu rozmowy', async ({ page, request }) => {
    // Isolated space: on the shared demo space cards can overlap, and a covered
    // element is not clickable — which would make this test flaky for a reason
    // that has nothing to do with what it checks.
    await request.post('/api/auth/session', { data: {} });
    const space = await (
      await request.post('/api/canvas/spaces', { data: { title: `Zaznaczenie ${Date.now()}` } })
    ).json();
    const card = await (
      await request.post('/api/canvas/cards', {
        data: {
          spaceId: space.id,
          title: 'Karta do zaznaczenia',
          spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'x' } },
          geometry: { x: 60, y: 60, width: 320, height: 180 },
        },
      })
    ).json();

    await page.goto('/spaces');
    await page.getByTestId(`space-${space.id}`).click();
    const title = page.locator(`[data-testid="card-${card.id}"] .pf-card__title`);
    await expect(title).toBeVisible();
    await title.click();
    await expect(page.getByTestId('chat-selection')).toContainText('card:');
    await page.getByRole('button', { name: 'wyczysc' }).click();
    await expect(page.getByTestId('chat-selection')).toHaveCount(0);
  });
});

test.describe('adaptacja do mniejszych ekranow', () => {
  test('na waskim ekranie menu jest zwiniete, a czat nadal dostepny', async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Rozmowa z agentem' })).toBeVisible();
    // The navigation collapses to its toggle rather than stealing the width.
    await expect(page.getByRole('button', { name: 'Rozwin menu' })).toBeVisible();
    await page.getByRole('button', { name: 'Rozwin menu' }).click();
    await expect(page.getByRole('link', { name: 'Wszystkie sprawy' })).toBeVisible();
  });
});
