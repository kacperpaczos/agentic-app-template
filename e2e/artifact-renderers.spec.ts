import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * L5.4 — artifact data reaches the renderer the artifact's **type** names, in
 * the chat and in the artifact view.
 *
 * What existed before: proof that the right cache keys are invalidated when an
 * artifact appears, and a suite comparing the preview and the full view of one
 * artifact. Neither can tell a right renderer from a wrong one — with a single
 * artifact type on screen, "the preview matches the full view" is equally true
 * of a wiring that draws everything the same way.
 *
 * So this run produces **three** artifacts, of three types, through the real
 * handlers: one a module renderer owns, one the platform's file renderer owns,
 * and one whose type nothing registers. Each has to be drawn by its own
 * renderer, and each has to be the one the backend says it is. A mapping by
 * position, by tool name or by order of creation fails all three at once.
 *
 * **Simulation, marked as such**: the model is the scripted stand-in at the
 * adapter boundary; the tools, the artifact service, the registry and the
 * browser are the application's own.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-renderers' });

async function openApp(page: Page) {
  await page.goto(`${scripted.baseUrl}/`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${scripted.baseUrl}/`);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

async function send(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

/** What the backend says each artifact's renderer key is. */
const storedRenderers = (page: Page) =>
  page.evaluate(async () => {
    /* The list names the renderer key `type`; the stored column is `rendererType`. */
    const { artifacts } = (await (
      await fetch('/api/artifacts', { credentials: 'include' })
    ).json()) as { artifacts: Array<{ id: string; title: string; type: string }> };
    return Object.fromEntries(artifacts.map((a) => [a.id, a.type]));
  });

/**
 * Which renderer actually drew a pane, read from what it put in the document.
 *
 * Three disjoint signatures, each belonging to exactly one renderer:
 *  - the module's comparison view has its own test id;
 *  - the platform's file renderer offers the bytes for download;
 *  - a type nothing registers falls back to the pane's own data dump, which is
 *    the honest answer — the artifact exists and is readable — and is *not*
 *    silently rendering nothing.
 */
const rendererOf = (page: Page, testId: 'artifact-preview' | 'artifact-full', artifactId: string) =>
  page.evaluate(
    ([id, kind]) => {
      const pane = document.querySelector(`[data-testid="${kind}"][data-artifact-id="${id}"]`);
      if (!pane) return { found: false, signatures: [] as string[] };
      const signatures: string[] = [];
      if (pane.querySelector('[data-testid="artifact-comparison"]')) signatures.push('modul');
      if (pane.querySelector('a[download]')) signatures.push('plik');
      if (pane.querySelector('[data-testid="artifact-content"]')) signatures.push('surowe-dane');
      return { found: true, signatures, text: (pane as HTMLElement).innerText.slice(0, 600) };
    },
    [artifactId, testId] as const,
  );

test.describe('artefakty trafiaja do wlasciwych rendererow', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    scripted.prepareDatabase();
    await scripted.start('artifact-renderer-routing');
  });
  test.afterAll(() => scripted.stop());

  test('trzy typy artefaktu, trzy rozne renderery — w czacie i w widoku artefaktu', async ({ page }) => {
    await openApp(page);
    await send(page, 'Zapisz zestawienie, notatke i plik.');
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded', {
      timeout: 90_000,
    });

    // Three previews, one per artifact-producing call.
    const previews = page.getByTestId('artifact-preview');
    await expect(previews).toHaveCount(3, { timeout: 30_000 });

    const ids = await previews.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-artifact-id') ?? ''),
    );
    expect(new Set(ids).size, 'dwa podglady pokazuja ten sam artefakt').toBe(3);

    const stored = await storedRenderers(page);
    /* What each renderer key is expected to look like on screen. */
    const expected: Record<string, string> = {
      'procurement.comparison': 'modul',
      'platform.file': 'plik',
      'platform.nie-ma-takiego-renderera': 'surowe-dane',
    };
    expect(
      [...new Set(Object.values(stored))].sort(),
      'scenariusz nie wyprodukowal trzech roznych typow',
    ).toEqual(Object.keys(expected).sort());

    for (const id of ids) {
      const type = stored[id];
      expect(type, `artefakt ${id} nie istnieje w backendzie`).toBeTruthy();
      const drawn = await rendererOf(page, 'artifact-preview', id);
      expect(drawn.found).toBe(true);
      // Exactly one renderer's signature: two would mean a pane drawn twice,
      // none would mean an empty box passed off as a rendering.
      expect(
        drawn.signatures,
        `artefakt typu ${type} narysowany jako [${drawn.signatures.join(',')}]: ${drawn.text}`,
      ).toEqual([expected[type!]]);
    }

    // The marker the unregistered type carries is on screen as data, so the
    // fallback is showing the artifact rather than announcing an error.
    const unknownId = ids.find((id) => stored[id] === 'platform.nie-ma-takiego-renderera')!;
    expect((await rendererOf(page, 'artifact-preview', unknownId)).text).toContain(
      'ZNACZNIK-BEZ-RENDERERA',
    );

    /* ----------------------- the same in the artifact view ----------------- */

    const moduleId = ids.find((id) => stored[id] === 'procurement.comparison')!;
    await page
      .locator(`[data-testid="artifact-preview"][data-artifact-id="${moduleId}"]`)
      .getByRole('button', { name: 'Otworz' })
      .click();
    const full = page.locator(`[data-testid="artifact-full"][data-artifact-id="${moduleId}"]`);
    await expect(full).toBeVisible({ timeout: 30_000 });
    expect((await rendererOf(page, 'artifact-full', moduleId)).signatures).toEqual(['modul']);
    // One rendering of one artifact: the preview and the page agree on the
    // version as well as on the renderer.
    expect(await full.getAttribute('data-artifact-version')).toBe(
      await page
        .locator(`[data-testid="artifact-preview"][data-artifact-id="${moduleId}"]`)
        .getAttribute('data-artifact-version'),
    );
  });
});
