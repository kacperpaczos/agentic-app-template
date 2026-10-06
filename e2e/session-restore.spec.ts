import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * The conversation the user was reading comes back — without them going to
 * fetch it.
 *
 * This is the behaviour two earlier tests worked *around*: after a reload they
 * reopened the conversation from the drawer "as a user would", and the comment
 * explaining that ("after a reload the chat opens on a new conversation, as
 * chats do") turned a missing feature into documented behaviour. A test that
 * accommodates the defect it should catch is worse than no test.
 *
 * Run against the scripted model so a real exchange exists to restore — the
 * history has to be genuine for its restoration to mean anything — and so it
 * costs no subscription turns and always produces the same conversation.
 *
 * Kazdy test jest tu samowystarczalny, wiec pojedynczy case da sie wywolac przez
 * `-g`: beforeEach daje swieza instancje scenariusza, a rozmowe tworzy test
 * we wlasnym zakresie (dwa dodatkowo przez `createExchangedConversation`) —
 * zadny nie dziedziczy stanu po tescie pierwszym. Test, ktory pada samodzielnie
 * i przechodzi w sasiedztwie innych, sprawdza aplikacje — nie uklad kart
 * w pliku ani kolejnosc wykonywania.
 */

const scripted = new ScriptedInstance({ port: 8795, dataDirName: '.e2e-scripted-restore' });
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

async function sendCommand(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
  await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /succeeded|failed/, {
    timeout: 60_000,
  });
}

/** Conversation id currently in the address bar, or null. */
const urlConversation = (page: Page) => new URL(page.url()).searchParams.get('c');

const threadMessages = (page: Page) => page.locator('.openui-agent-thread-messages > *');

/**
 * Rozmowa z jedna prawdziwa wymiana, zbudowana przez API — nie przez interfejs
 * i nie przez cudzy test.
 *
 * Prawdziwa, bo sesje modelu nie powstaja z samego rekordu rozmowy: bez wymiany
 * `claudeSessionId` jest pusty, a przywracanie sesji nie mialoby czego dowodzic.
 * Przez API, bo przygotowanie nie jest tutaj tym, co test sprawdza — i dlatego
 * testy drugi i trzeci przechodza takze w izolacji (`-g`), zamiast dziedziczyc
 * rozmowe po tescie pierwszym. API strony (`page.evaluate`), a nie fixture
 * `request`: `request` celuje w baseURL projektu, czyli instancje wspoldzielona
 * na 8799, podczas gdy caly ten spec rozmawia z wlasna instancja skryptowana —
 * polecenie wyladowaloby na cudzym serwerze, z prawdziwym modelem i w cudzej
 * bazie.
 */
async function createExchangedConversation(
  page: Page,
  command: string,
): Promise<{ id: string; sessionId: string | null }> {
  const result = await page.evaluate(async (cmd) => {
    const res = await fetch('/api/agui/run', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: null,
        messages: [
          { id: `msg-${Math.random().toString(36).slice(2, 10)}`, role: 'user', content: cmd },
        ],
      }),
    });
    const id = res.headers.get('x-conversation-id');
    // Drenowanie strumienia AG-UI: serwer zamyka go razem z runem, wiec po tym
    // oczekiwaniu wymiana jest skonczona i zapisana.
    await res.text();
    const conv = id
      ? ((await (
          await fetch(`/api/conversations/${id}`, { credentials: 'include' })
        ).json()) as { claudeSessionId: string | null })
      : null;
    return { ok: res.ok, id, sessionId: conv?.claudeSessionId ?? null };
  }, command);
  expect(result.ok, 'uruchomienie przez API nie wystartowalo').toBe(true);
  expect(result.id, 'odpowiedz nie wskazala rozmowy (x-conversation-id)').toBeTruthy();
  return { id: result.id!, sessionId: result.sessionId };
}

/** Liczba rozmów bieżącego właściciela — do asercji, że nic nowego nie powstalo. */
const threadCount = (page: Page) =>
  page.evaluate(
    async () =>
      (await (await fetch('/api/threads/get', { credentials: 'include' })).json()).threads
        .length as number,
  );

/** Fakty o rozmowie czytane z backendu: sesja, liczba wiadomości, liczba uruchomień. */
async function conversationFacts(page: Page, id: string) {
  return page.evaluate(async (cid) => {
    const conv = (await (
      await fetch(`/api/conversations/${cid}`, { credentials: 'include' })
    ).json()) as { claudeSessionId: string | null };
    const messages = (await (
      await fetch(`/api/threads/get/${cid}`, { credentials: 'include' })
    ).json()) as unknown[];
    const { runs } = (await (
      await fetch(`/api/conversations/${cid}/runs`, { credentials: 'include' })
    ).json()) as { runs: unknown[] };
    return {
      sessionId: conv.claudeSessionId,
      messageCount: messages.length,
      runCount: runs.length,
    };
  }, id);
}

/**
 * The messages of the open conversation — not the whole panel.
 *
 * `.pf-chat` also contains the drawer's list of *every* conversation, so
 * asserting on it cannot tell "this conversation's messages are on screen" from
 * "this conversation's title is in the list". Only the thread answers the
 * question these tests ask.
 */
const thread = (page: Page) => page.locator('.openui-agent-thread-messages');

test.describe('przywracanie kontekstu rozmowy', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });
  /*
   * Kazdy test dostaje swieza instancje scenariusza — dokladnie to, co dotad
   * robil `restart` na poczatku kazdego testu, tylko w jednym miejscu.
   */
  test.beforeEach(async () => {
    await scripted.restart('text-only');
  });
  test.afterAll(() => scripted.stop());

  test('po przeladowaniu ta sama rozmowa, jej historia i przestrzen pracy', async ({ page }) => {
    await openApp(page);

    // A conversation with real content in it.
    await sendCommand(page, 'Pierwsza rozmowa o kosztach.');
    await expect(page.getByTestId('assistant-message')).toContainText('Czwarte zdanie odpowiedzi.');

    const conversationId = urlConversation(page);
    expect(conversationId, 'rozmowa nie trafila do adresu').toBeTruthy();
    const messagesBefore = await threadMessages(page).count();
    expect(messagesBefore).toBeGreaterThan(0);

    /* ------------------------------- reload -------------------------------- */

    await page.reload();

    // The same conversation, with no drawer, no click, no second command.
    await expect
      .poll(() => urlConversation(page), { timeout: 15_000 })
      .toBe(conversationId);
    await expect(threadMessages(page).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('assistant-message')).toContainText('Czwarte zdanie odpowiedzi.');
    await expect(thread(page)).toContainText('Pierwsza rozmowa o kosztach');
    expect(await threadMessages(page).count()).toBe(messagesBefore);

    // And no replacement conversation was created behind the scenes.
    const threads = await page.evaluate(
      async () => (await (await fetch('/api/threads/get', { credentials: 'include' })).json()).threads,
    );
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(conversationId);
  });

  test('dalsze polecenie po przeladowaniu kontynuuje te sama sesje', async ({ page }) => {
    await openApp(page);

    // Wlasna rozmowa z jedna wymiana — nie dziedziczona po tescie pierwszym,
    // bez ktorego ten test kiedys padal, uruchomiony przez `-g`.
    const first = await createExchangedConversation(page, 'Pierwsza rozmowa o kosztach.');
    expect(first.sessionId, 'wymiana przez API nie utworzyla sesji modelu').toBeTruthy();

    const before = await conversationFacts(page, first.id);
    expect(before.runCount).toBe(1);
    const threadsBefore = await threadCount(page);

    // Land on the restored conversation and carry on typing.
    await page.goto(`${BASE}/?c=${first.id}`);
    await expect(threadMessages(page).first()).toBeVisible({ timeout: 30_000 });
    await sendCommand(page, 'Drugie polecenie w tej samej rozmowie.');

    const after = await conversationFacts(page, first.id);

    // The follow-up went into the same conversation and resumed its session —
    // not into a new conversation with a fresh one. Liczba rozmów sprawdzona
    // względnie (przed vs po), bo w tym katalogu danych moga byc tez rozmowy
    // innych testów z tego pliku.
    expect(await threadCount(page), 'powstala nowa rozmowa zamiast kontynuacji').toBe(
      threadsBefore,
    );
    expect(after.runCount).toBe(before.runCount + 1);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.messageCount).toBeGreaterThan(before.messageCount);
    expect(urlConversation(page)).toBe(first.id);
  });

  test('Wstecz i Dalej przelaczaja rozmowy bez mieszania historii', async ({ page }) => {
    await openApp(page);

    // Dwie rozmowy z wymiana, stworzone przez API: ten test sprawdza przelaczanie,
    // wiec przygotowanie nie moze zalezec od tescie pierwszego ani od interfejsu.
    const pierwsza = await createExchangedConversation(page, 'Pierwsza rozmowa o kosztach.');
    const druga = await createExchangedConversation(page, 'Druga rozmowa o terminach.');

    // Switch by URL, the way a link or Back/Forward does.
    await page.goto(`${BASE}/?c=${pierwsza.id}`);
    await expect(thread(page)).toContainText('Pierwsza rozmowa o kosztach', { timeout: 30_000 });
    await expect(thread(page)).not.toContainText('Druga rozmowa o terminach');

    await page.goto(`${BASE}/?c=${druga.id}`);
    await expect(thread(page)).toContainText('Druga rozmowa o terminach', { timeout: 30_000 });

    await page.goBack();
    await expect.poll(() => urlConversation(page), { timeout: 15_000 }).toBe(pierwsza.id);
    await expect(thread(page)).toContainText('Pierwsza rozmowa o kosztach', { timeout: 30_000 });
    // The decisive part: going back must not leave the other conversation's
    // messages on screen alongside this one's.
    await expect(thread(page)).not.toContainText('Druga rozmowa o terminach');

    await page.goForward();
    await expect.poll(() => urlConversation(page), { timeout: 15_000 }).toBe(druga.id);
    await expect(thread(page)).toContainText('Druga rozmowa o terminach', { timeout: 30_000 });
    await expect(thread(page)).not.toContainText('Pierwsza rozmowa o kosztach');
  });

  test('przestrzen pracy wraca razem z rozmowa', async ({ page }) => {
    await openApp(page, '/cases');

    // Opening a case creates its canvas space and puts the user in it.
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
    await expect(page.getByTestId('card-case-summary').first()).toBeVisible();

    await sendCommand(page, 'Rozmowa przy przestrzeni sprawy.');
    const conversationId = urlConversation(page);
    const spaceId = new URL(page.url()).searchParams.get('s');
    expect(spaceId, 'przestrzen nie trafila do adresu').toBeTruthy();

    await page.reload();
    await expect.poll(() => new URL(page.url()).searchParams.get('s'), { timeout: 15_000 }).toBe(
      spaceId,
    );
    await expect(page.getByTestId('card-case-summary').first()).toBeVisible();
    expect(urlConversation(page)).toBe(conversationId);

    // The conversation also carries the binding server-side, so opening it from
    // the drawer on a fresh session brings its workspace back.
    const bound = await page.evaluate(
      async (id) =>
        (await (await fetch(`/api/conversations/${id}`, { credentials: 'include' })).json()).spaceId,
      conversationId,
    );
    expect(bound).toBe(spaceId);
  });

  test('usunieta rozmowa daje czytelny stan zastepczy, nie pusty ekran', async ({ page }) => {
    await openApp(page);

    const doomed = await page.evaluate(async () => {
      const res = await fetch('/api/threads/create', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Rozmowa do usuniecia.' }] }),
      });
      const created = await res.json();
      await fetch(`/api/threads/delete/${created.id}`, { method: 'DELETE', credentials: 'include' });
      return created.id as string;
    });

    await page.goto(`${BASE}/?c=${doomed}`);

    const notice = page.getByTestId('conversation-missing');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toHaveAttribute('data-kind', 'gone');
    await expect(notice).toContainText('niedostepna');
    await expect(notice).toContainText(doomed.slice(-8));

    // Not someone else's conversation shown under a "missing" banner, and not a
    // dead end: the composer works and the notice can be dismissed.
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeEnabled();
    await notice.getByRole('button', { name: 'Zacznij nowa rozmowe' }).click();
    await expect(notice).toHaveCount(0);
    expect(urlConversation(page)).toBeNull();
  });

  test('rozmowa innego wlasciciela nie jest pokazywana', async ({ page }) => {
    await openApp(page);

    const mine = await page.evaluate(
      async () =>
        (await (await fetch('/api/threads/get', { credentials: 'include' })).json()).threads[0]
          .id as string,
    );

    // Switch to the other local identity and ask for the first one's URL.
    await page.evaluate(() =>
      fetch('/api/auth/session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'other-user' }),
      }),
    );
    await page.goto(`${BASE}/?c=${mine}`);

    const notice = page.getByTestId('conversation-missing');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toHaveAttribute('data-kind', 'gone');
    // Nothing of the other owner's conversation reaches the screen — neither
    // its messages nor its title in the drawer's list.
    await expect(page.locator('.pf-chat')).not.toContainText('Pierwsza rozmowa o kosztach');
    await expect(page.getByTestId('assistant-message')).toHaveCount(0);
  });
});
