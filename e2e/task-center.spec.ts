import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * Centrum zadań (L11.6) — dowód w przeglądarce, bez modelu.
 *
 * Warstwa backendu (trwały rejestr, projekcja zadania, ponowienie) jest
 * potwierdzona kontraktem (`tests/task-center.test.ts`); to, co potrafi
 * zepsuć tylko przeglądarka, jest tu: zadanie prowadzone z centrum ma działać
 * niezależnie od otwartej rozmowy i zamkniętego panelu, a jego akcje —
 * otwarcie rozmowy, anulowanie, ponowienie — mają rzeczywiście działać
 * z poziomu centrum, bez wchodzenia najpierw w rozmowę źródłową.
 */

const scripted = new ScriptedInstance({ port: 8795, dataDirName: '.e2e-scripted-taskcenter' });
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

const urlConversation = (page: Page) => new URL(page.url()).searchParams.get('c');

async function startNewConversation(page: Page) {
  await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();
}

async function openTaskCenter(page: Page) {
  // Po wejściu w nawigację, jak użytkownik — nie przez URL, żeby ten sam test
  // potwierdził, że centrum jest osiągalne z powłoki.
  await page.locator('.pf-nav__link', { hasText: 'Centrum zadań' }).click();
  await expect(page.getByTestId('task-center')).toBeVisible();
}

test.describe('centrum zadan', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  /*
   * Czysta baza przed każdym testem: testy nie mają sobie niczego przekazywać,
   * a pusty stan centrum też jest przypadkiem, który trzeba pokazać.
   */
  test.beforeEach(() => {
    scripted.prepareDatabase();
  });
  test.afterEach(() => scripted.stop());

  test('zadanie z rozmowy A jest widoczne i obslugiwane z centrum, podczas gdy uzytkownik jest w B', async ({
    page,
  }) => {
    await scripted.start('task-center');
    await openApp(page);

    await send(page, 'Zadanie dlugie centrum.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    const conversationA = urlConversation(page);
    expect(conversationA).toBeTruthy();

    /* Uciekamy do rozmowy B i wchodzimy do centrum z nawigacji. */
    await startNewConversation(page);
    await openTaskCenter(page);

    /* Zadanie A jest w centrum i nadal wykonuje się — przełączenie rozmowy
       ani otwarcie centrum nie zatrzymało pracy. */
    const running = page.locator('.pf-tasklist__item[data-status="running"], .pf-tasklist__item[data-status="queued"]');
    await expect(running).toHaveCount(1, { timeout: 15_000 });
    const taskRow = page.locator('[data-testid^="task-intent-"]').filter({ hasText: 'Zadanie dlugie centrum.' });
    await expect(taskRow).toHaveCount(1);
    const runId = (await taskRow.getAttribute('data-testid'))!.replace('task-intent-', '');

    /* Postęp jest widoczny: polecenie, rozmowa, status, liczniki, narzędzie. */
    await expect(page.getByTestId(`task-status-${runId}`)).toHaveAttribute('data-status', 'running');
    await expect(page.getByTestId(`task-conversation-${runId}`)).not.toContainText('undefined');
    const progress = page.getByTestId(`task-progress-${runId}`);
    await expect(progress).toContainText('narzędzia: 2/2');
    await expect(page.getByTestId(`task-tools-${runId}`)).toContainText('canvas_list_cards');
    await expect(progress).toContainText('czas:');

    /* Artefakt opublikowany przez zadanie jest wymieniony w centrum. */
    await expect(page.getByTestId(`task-artifacts-${runId}`)).toContainText('Raport centrum zadan');

    /* Przeładowanie nie gubi listy ani stanu: zadanie dalej trwa i dalej
       należy do rozmowy A. */
    await page.reload();
    await expect(page.getByTestId('task-center')).toBeVisible();
    await expect(page.getByTestId(`task-status-${runId}`)).toHaveAttribute('data-status', 'running', {
      timeout: 15_000,
    });

    /* „Otwórz wynik" prowadzi do rozmowy z widocznym rezultatem zadania. */
    await page.getByTestId(`task-result-${runId}`).click();
    await expect.poll(() => urlConversation(page), { timeout: 15_000 }).toBe(conversationA);
    await expect(page.locator('.openui-agent-thread-messages')).toContainText('Raport centrum zadan', {
      timeout: 15_000,
    });

    /* Z powrotem do centrum: anulowanie dociera do wykonania w rozmowie A. */
    await openTaskCenter(page);
    await page.getByTestId(`task-cancel-${runId}`).click();
    await expect(page.getByTestId(`task-status-${runId}`)).toHaveAttribute('data-status', 'cancelled', {
      timeout: 30_000,
    });

    /* Otwarcie rozmowy z centrum prowadzi do właściwego wątku. */
    await page.getByTestId(`task-open-${runId}`).click();
    await expect.poll(() => urlConversation(page), { timeout: 15_000 }).toBe(conversationA);
  });

  test('nieudane zadanie pokazuje blad w centrum, a anulowane da sie ponowic', async ({
    page,
  }) => {
    await scripted.restart('task-center');
    await openApp(page);

    await send(page, 'To jest proba AWARIA centrum.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'failed', {
      timeout: 30_000,
    });

    await openTaskCenter(page);

    const failedIntent = page
      .locator('[data-testid^="task-intent-"]')
      .filter({ hasText: 'To jest proba AWARIA centrum.' });
    await expect(failedIntent).toHaveCount(1);
    const failedRunId = (await failedIntent.getAttribute('data-testid'))!.replace('task-intent-', '');

    /* Błąd jest czytelny w centrum, nie tylko w rozmowie. */
    await expect(page.locator('.pf-tasklist__item[data-status="failed"]')).toHaveCount(1);
    await expect(page.getByTestId(`task-error-${failedRunId}`)).toContainText(
      'Symulowana awaria narzedzia centrum zadan.',
    );

    /*
     * Ponowienie: przedmiotem jest **anulowane** długie zadanie, bo scenariusz
     * jest deterministyczny — polecenie „AWARIA" padłoby znowu. Anulujemy
     * najpierw długą pracę prowadzoną z innego wątku.
     */
    await startNewConversation(page);
    await send(page, 'Zadanie dlugie do ponowienia.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'running', {
      timeout: 30_000,
    });
    await openTaskCenter(page);
    const longIntent = page
      .locator('[data-testid^="task-intent-"]')
      .filter({ hasText: 'Zadanie dlugie do ponowienia.' });
    await expect(longIntent).toHaveCount(1);
    const longRunId = (await longIntent.getAttribute('data-testid'))!.replace('task-intent-', '');
    await page.getByTestId(`task-cancel-${longRunId}`).click();
    await expect(page.getByTestId(`task-status-${longRunId}`)).toHaveAttribute('data-status', 'cancelled', {
      timeout: 30_000,
    });

    /* Ponowienie z centrum: nowe wykonanie, anulowane zostaje anulowanym. */
    await page.getByTestId(`task-retry-${longRunId}`).click();
    await expect(
      page.locator('.pf-tasklist__item[data-status="running"], .pf-tasklist__item[data-status="queued"]'),
    ).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.pf-tasklist__item[data-status="cancelled"]')).toHaveCount(1);
    await expect(page.locator('[data-testid^="task-intent-"]').filter({ hasText: 'Zadanie dlugie do ponowienia.' })).toHaveCount(2);

    /* Sprzątanie: zatrzymujemy ponowione wykonanie z centrum. */
    const retryRow = page.locator('.pf-tasklist__item[data-status="running"], .pf-tasklist__item[data-status="queued"]');
    const retryRunId = (await retryRow.locator('[data-testid^="task-status-"]').getAttribute('data-testid'))!.replace(
      'task-status-',
      '',
    );
    await page.getByTestId(`task-cancel-${retryRunId}`).click();
    await expect(page.getByTestId(`task-status-${retryRunId}`)).toHaveAttribute('data-status', 'cancelled', {
      timeout: 30_000,
    });
  });

  test('puste centrum ma czytelny stan, a po wejsciu z nawigacji lista jest obecna w DOM', async ({
    page,
  }) => {
    await scripted.restart('task-center');
    await openApp(page);
    await openTaskCenter(page);
    /* Instancja świeża: baza przygotowana od zera, brak zadań. */
    await expect(page.getByTestId('task-center-empty')).toBeVisible();
    await expect(page.getByTestId('task-center-list')).toHaveCount(0);
  });
});
