import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * Trzy tryby zgody (L11.12) — dowód w przeglądarce, bez modelu.
 *
 * Decyzje bramki (macierz `decideTool`, status `awaiting_consent`, skutek
 * odpowiedzi) są potwierdzone w warstwie backendu; to, co potrafi zepsuć tylko
 * przeglądarka, jest tu: wybór trybu przy kompozytorze musi **dotrzeć** do
 * `POST /api/agui/run` (każde polecenie niesie tryb z bieżącego stanu klienta),
 * a centrum zadań musi pokazywać tryb, z którym zadanie naprawdę wystartowało —
 * czytany z rekordu wykonania, nie z pamięci tego okna.
 *
 * **Symulacja na granicy modelu, oznaczona jak w `consent-runs.spec.ts`.**
 * Kroki `ask` scenariusza wołają prawdziwą bramkę `canUseTool`, więc prośba,
 * oczekiwanie, zapis `awaiting_consent` i skutek decyzji są własnością
 * aplikacji. Tryb jest częścią tej układanki: ta sama prośba o `Bash` kończy
 * się pytaniem w trybie nadzorowanym, a cichym zatwierdzeniem w pełnej
 * automatyzacji — różnicę robi wyłącznie wartość posłana z kompozytora.
 */

const PORT = 8798;
const modes = new ScriptedInstance({ port: PORT, dataDirName: '.e2e-scripted-consent-modes' });

async function openApp(page: Page, path = '/') {
  await page.goto(`${modes.baseUrl}${path}`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${modes.baseUrl}${path}`);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

async function send(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

const modeSelect = (page: Page) => page.getByTestId('consent-mode-select');

const artifactCount = (page: Page) =>
  page.evaluate(
    async () =>
      (
        await (await fetch('/api/artifacts', { credentials: 'include' })).json()
      ).artifacts.length as number,
  );

/** Pełny dziennik zdarzeń wykonania: nazwy i wartości payloadów. */
const eventsOf = (page: Page, runId: string) =>
  page.evaluate(async (id) => {
    const { events } = (await (
      await fetch(`/api/runs/${id}/events`, { credentials: 'include' })
    ).json()) as {
      events: Array<{ payload: { name?: string; value?: Record<string, unknown> } }>;
    };
    return events.map((e) => ({ name: e.payload?.name ?? '', value: (e.payload?.value ?? null) as Record<string, unknown> | null }));
  }, runId);

const permissionRequestsOf = async (page: Page, runId: string) =>
  (await eventsOf(page, runId)).filter((e) => e.name === 'platform.permission_request');

const openTaskCenter = async (page: Page) => {
  await page.locator('.pf-nav__link', { hasText: 'Centrum zadań' }).click();
  await expect(page.getByTestId('task-center')).toBeVisible();
};

test.describe('tryby zgody przy kompozytorze', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  /* Czysta baza przed każdym testem: licznik artefaktów jest dowodem "bez
     skutku" tylko wtedy, gdy nic z poprzedniego testu w nim nie leży. */
  test.beforeEach(() => {
    modes.prepareDatabase();
  });
  test.afterEach(async () => {
    await modes.stop();
  });

  test('selektor trybu przy kompozytorze: trzy opcje, domyślnie Nadzorowany', async ({ page }) => {
    await modes.start('bl13-modes');
    await openApp(page);

    const select = modeSelect(page);
    await expect(select).toBeVisible();
    await expect(select.locator('option')).toHaveCount(3);
    expect(await select.locator('option').allTextContents()).toEqual([
      'Ręczny',
      'Nadzorowany',
      'Pełna automatyzacja',
    ]);
    // Domyślnie dotychczasowe zachowanie: nadzorowane wykonanie.
    await expect(select).toHaveValue('supervised');
    // Krótki opis zachowania pod kursorem, na każdej z opcji.
    await expect(select).toHaveAttribute('title', /zgody/);
    await expect(select.locator('option[value="manual"]')).toHaveAttribute('title', /każd/);
    await expect(select.locator('option[value="auto"]')).toHaveAttribute('title', /zabronione/);
  });

  test('pelna automatyzacja: bramka zatwierdza sama, bez prosby i bez pytania', async ({ page }) => {
    await modes.start('bl13-modes');
    await openApp(page);
    expect(await artifactCount(page)).toBe(0);

    await modeSelect(page).selectOption({ label: 'Pełna automatyzacja' });
    await send(page, 'Wykonaj to w pelnej automatyzacji.');

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('permission-prompt')).toHaveCount(0);

    /* Dowód z dziennika wykonania: żadnej prośby o zgodę nie było wcale —
       nie "pytanie zniknęło szybko", tylko brak zdarzenia w logu. */
    const runId = await page.getByTestId('run-state').getAttribute('data-run-id');
    expect(runId).toBeTruthy();
    const requests = await permissionRequestsOf(page, runId!);
    expect(requests, 'tryb auto nie moze zadawac o pojedyncze akcje').toHaveLength(0);

    /* Praca się wykonała: zatwierdzenie przez bramkę doszło do skutku. */
    expect(await artifactCount(page)).toBe(1);

    /* Centrum zadań czyta tryb z rekordu wykonania. */
    await openTaskCenter(page);
    await expect(page.getByTestId(`task-consent-mode-${runId}`)).toHaveText('Automatyczny');
  });

  test('reczny: narzedzie aplikacji pyta, zgoda wykonuje operacje', async ({ page }) => {
    await modes.start('bl13-modes');
    await openApp(page);
    expect(await artifactCount(page)).toBe(0);

    await modeSelect(page).selectOption({ label: 'Ręczny' });
    await send(page, 'Przeczytaj kanwe narzedziem aplikacji.');

    /* Narzędzie aplikacji, które w trybie nadzorowanym działa samo, tu pyta. */
    const prompt = page.getByTestId('permission-prompt');
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'awaiting_consent');
    const runId = await page.getByTestId('run-state').getAttribute('data-run-id');
    expect(runId).toBeTruthy();
    const requests = await permissionRequestsOf(page, runId!);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.value?.toolName).toBe('mcp__app__canvas_list_cards');

    await prompt.getByRole('button', { name: 'Zgoda' }).click();
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 30_000,
    });
    expect(await artifactCount(page)).toBe(1);

    await openTaskCenter(page);
    await expect(page.getByTestId(`task-consent-mode-${runId}`)).toHaveText('Ręczny');
  });

  test('reczny: odmowa pozostawia operacje bez skutku', async ({ page }) => {
    await modes.start('bl13-modes');
    await openApp(page);
    expect(await artifactCount(page)).toBe(0);

    await modeSelect(page).selectOption({ label: 'Ręczny' });
    await send(page, 'Przeczytaj kanwe narzedziem aplikacji, jesli dostaniesz zgode.');

    const prompt = page.getByTestId('permission-prompt');
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    await prompt.getByRole('button', { name: 'Odmowa' }).click();

    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 30_000,
    });
    /* Kontrola jak w consent-runs: odmowa nie może zostawić śladu po operacji. */
    await expect(page.getByTestId('artifact-preview')).toHaveCount(0);
    expect(await artifactCount(page), 'odmowa mimo wszystko wykonala operacje').toBe(0);

    const runId = await page.getByTestId('run-state').getAttribute('data-run-id');
    expect(runId).toBeTruthy();
    const resolved = (await eventsOf(page, runId!)).find(
      (e) => e.name === 'platform.permission_resolved',
    );
    expect(resolved?.value?.allowed).toBe(false);
  });

  test('domyslnie: polecenie o Bash pyta o zgode, jak zawsze w trybie nadzorowanym', async ({ page }) => {
    await modes.start('bl13-modes');
    await openApp(page);
    /* Selektora nikt nie dotyka — dowód, że bez wyboru dostajemy dotychczasowe
       zachowanie, a wybór nie rozjeżdża się z tym, co pokazuje kontrolka. */
    await expect(modeSelect(page)).toHaveValue('supervised');
    expect(await artifactCount(page)).toBe(0);

    await send(page, 'Przetworz dane w sandboxie.');

    const prompt = page.getByTestId('permission-prompt');
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    const runId = await page.getByTestId('run-state').getAttribute('data-run-id');
    expect(runId).toBeTruthy();
    const requests = await permissionRequestsOf(page, runId!);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.value?.toolName).toBe('Bash');

    await prompt.getByRole('button', { name: 'Zgoda' }).click();
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 30_000,
    });
    expect(await artifactCount(page)).toBe(1);

    await openTaskCenter(page);
    await expect(page.getByTestId(`task-consent-mode-${runId}`)).toHaveText('Nadzorowany');
  });
});
