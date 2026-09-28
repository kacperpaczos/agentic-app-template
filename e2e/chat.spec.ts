import { expect, test } from './support/fixtures.ts';
import { type APIRequestContext } from '@playwright/test';

/**
 * Conversation management through the ready-made OpenUI chat.
 *
 * Most of this suite makes no model call: conversations are created through the
 * storage API the chat itself uses, then driven in the browser. The one
 * exception is the artifact test — an artifact comes into being only through
 * the agent's own `artifact_create` tool during a run (the HTTP API can list,
 * read and patch one, but never create one), so that test spends a single real
 * model turn, exactly like `agent-ui.spec.ts`.
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

/**
 * Rozmowa z jawnie roznymi tresciami tytulu i pierwszej wiadomosci.
 *
 * Rozdzielone celowo: asercja na tresc wiadomosci nie moze sie "odsieczyc"
 * tekstem tytulu, ktory pojawia sie takze w liscie rozmow i w naglowku watku.
 */
async function seedThreadZTrescia(request: APIRequestContext, tytul: string, tresc: string) {
  await request.post('/api/auth/session', { data: {} });
  const created = await (
    await request.post('/api/threads/create', {
      data: { title: tytul, messages: [{ id: crypto.randomUUID(), role: 'user', content: tresc }] },
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

  test('przelaczenie rozmowy w interfejsie nie miesza wiadomosci', async ({ page, request }) => {
    /*
     * Poprzednia wersja tego testu nigdy nie przelaczyla rozmowy: porownywal
     * dwa zasoby po API i stwierdzal, ze maja rozne tresci — co nie mowi nic o
     * tym, co uzytkownik zobaczy po kliknieciu innej rozmowy w szufladzie.
     * Tutaj przelaczenie jest prawdziwe (klik w wiersz szuflady), a asercje
     * patrza na renderowana historie, wzmacniane prawda z API.
     */
    const trescA = `Znacznik alfa ${Date.now()} - to zdanie nalezalo do rozmowy pierwszej.`;
    const trescB = `Znacznik beta ${Date.now()} - to zdanie nalezalo do rozmowy drugiej.`;
    const a = await seedThreadZTrescia(request, 'Rozmowa pierwsza alfa', trescA);
    const b = await seedThreadZTrescia(request, 'Rozmowa druga beta', trescB);

    // Prawda z API: to dwa rozne zasoby, kazdy z dokladnie jedna wiadomoscia.
    const ma = await (await request.get(`/api/threads/get/${a.id}`)).json();
    const mb = await (await request.get(`/api/threads/get/${b.id}`)).json();
    expect(ma).toHaveLength(1);
    expect(mb).toHaveLength(1);
    expect(ma[0].content).toBe(trescA);
    expect(mb[0].content).toBe(trescB);

    await page.goto('/');
    const wiadomosci = page.locator('.openui-agent-thread-messages').first();
    const szuflada = page.locator(
      '.openui-agent-sidebar-container[data-sidebar-visual-state="expanded"]',
    );

    const otworz = async (tytul: string) => {
      // Wybranie rozmowy zamyka szuflade — otwieramy ja z powrotem, tak jak
      // uzytkownik wracajacy do listy. Czekamy na koniec animacji (stan
      // "expanded" nadaje biblioteka po dojechaniu na miejsce): klik zlapany
      // w trakcie ruchu trafial obok wiersza i zamykal szuflade bez wyboru
      // rozmowy — transkrypt pozostawal pusty.
      if ((await szuflada.count()) === 0) {
        await page.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
      }
      await expect(szuflada).toHaveCount(1);
      await expect(page.locator('.openui-agent-thread-list')).toBeVisible();
      await page
        .locator('.openui-agent-thread-button', { hasText: tytul })
        .first()
        .locator('.openui-agent-thread-button-title')
        .first()
        .click();
    };

    await otworz('Rozmowa pierwsza alfa');
    // Najpierw pozytywna asercja (tresc A sie pokazala), dopiero potem brak B —
    // kolejnosc wolna od wyscigu z doladowaniem historii po kliknieciu.
    await expect(wiadomosci).toContainText(trescA);
    await expect(wiadomosci, 'w historii pierwszej rozmowy pojawila sie tresc drugiej').not.toContainText(
      trescB,
    );

    await otworz('Rozmowa druga beta');
    await expect(wiadomosci).toContainText(trescB);
    await expect(wiadomosci, 'w historii drugiej rozmowy pojawila sie tresc pierwszej').not.toContainText(
      trescA,
    );

    await otworz('Rozmowa pierwsza alfa');
    await expect(wiadomosci).toContainText(trescA);
    await expect(wiadomosci).not.toContainText(trescB);
  });

  test('usuniecie rozmowy odlacza artefakty zamiast je kasowac', async ({ request }) => {
    test.setTimeout(300_000);

    /*
     * Realny incydent: klucz obcy artifacts.conversation_id zachowywal sie jak
     * ON DELETE CASCADE — usuniecie rozmowy niszczylo artefakty, trwale wyniki
     * pracy agenta, zamiast je odpiac. Poprzednia wersja tego testu tego nie
     * widziala: w seedowanej bazie nie bylo zadnego artefaktu, wiec
     * porownywala 0 z 0 i przeszla z aktywnym bledem kasujacym dane.
     *
     * Artefakt powstaje wylacznie przez narzedzie agenta `artifact_create` w
     * trakcie runu (HTTP potrafi artefakt wypisac, odczytac i zmienic, ale nie
     * utworzyc), wiec ten test wydaje jedna realna ture modelu przez wejscie
     * `/api/agui/run` — ten sam, ktorego uzywa gotowy czat.
     */
    await request.post('/api/auth/session', { data: {} });
    const t = await seedThread(request, `Do usuniecia ${Date.now()}`);

    const polecenie =
      'Utworz teraz dokladnie jeden artefakt narzedziem artifact_create, z tymi parametrami: ' +
      'title="Artefakt kontrolny", kind="report", mode="snapshot", ' +
      'rendererType="platform.markdown", ' +
      'content={"markdown":"## Artefakt kontrolny\\n\\nTresc kontrolna testu E2E."}. ' +
      'Nie uzywaj zadnych innych narzedzi. Na koniec potwierdz jednym zdaniem, co utworzyles.';
    const uruchom = await request.post('/api/agui/run', {
      data: {
        threadId: t.id,
        messages: [{ id: crypto.randomUUID(), role: 'user', content: polecenie }],
      },
      timeout: 240_000,
    });
    expect(uruchom.ok(), `run nie wystartowal: HTTP ${uruchom.status()}`).toBe(true);
    // Odpowiedzia jest strumien SSE, ktory serwer zamyka w momencie zakonczenia
    // runu — przeczytanie ciala jest wiec oczekiwaniem na koniec pracy agenta.
    await uruchom.text();

    const { runs } = await (await request.get(`/api/conversations/${t.id}/runs`)).json();
    expect(runs.length, 'run nie zostal zarejestrowany dla tej rozmowy').toBeGreaterThan(0);
    expect(
      runs[0].status,
      `run zakonczyl sie bledem: ${runs[0].errorMessage ?? '(bez komunikatu)'}`,
    ).toBe('succeeded');

    const przed = await (await request.get('/api/artifacts')).json();
    const moje = przed.artifacts.filter((a: { threadId: string }) => a.threadId === t.id);
    expect(
      moje.length,
      'rozmowa nie ma powiazanego artefaktu — test nie sprawdzalby nic',
    ).toBeGreaterThanOrEqual(1);

    const del = await (await request.delete(`/api/threads/delete/${t.id}`)).json();
    expect(del.deleted).toBe(t.id);

    // Artefakt przezywa usuniecie rozmowy: odpiety (threadId puste), nie skasowany.
    const po = await (await request.get('/api/artifacts')).json();
    expect(po.artifacts.length, 'usuniecie rozmowy skasowalo artefakty').toBe(
      przed.artifacts.length,
    );
    const odlaczony = po.artifacts.find((a: { id: string }) => a.id === moje[0].id);
    expect(odlaczony, 'artefakt zniknal razem z rozmowa, a mial zostac odpiety').toBeTruthy();
    expect(odlaczony.threadId, 'artefakt mial zostac odpiety od rozmowy (threadId puste)').toBe('');
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
