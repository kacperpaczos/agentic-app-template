import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import { type Page } from '@playwright/test';

/**
 * One artifact, two places it is shown, and the difference between a snapshot
 * and a live view.
 *
 * Symulacja: the model is a scripted stand-in at the adapter boundary; the tool
 * handlers, the artifact service, the database and the browser are the real
 * ones. Nothing here asserts anything about a model's judgement — what is under
 * test is that the *same artifact* read from two surfaces of the interface
 * cannot show two different answers, and that changing the data behind it moves
 * the live view and leaves the snapshot alone.
 *
 * Why a browser and not two HTTP reads: two reads of one endpoint agreeing
 * proves the endpoint is deterministic, not that the two surfaces use it. Until
 * this suite existed they did not — the artifact browser fetched on its own, so
 * the preview and the full page were two independent pictures of one artifact.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-artifacts' });
const BASE = scripted.baseUrl;

async function openApp(page: Page) {
  await page.goto(`${BASE}/`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${BASE}/`);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

/** Sends one command and waits for the scripted run to finish. */
async function ask(page: Page, text: string) {
  await page.locator('.openui-agent-thread-composer__input').fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
  await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /succeeded|failed/, {
    timeout: 60_000,
  });
  await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', 'succeeded');
}

/** The three facts a view of an artifact puts on screen. */
async function shownVersion(locator: ReturnType<Page['locator']>) {
  return {
    id: await locator.getAttribute('data-artifact-id'),
    version: await locator.getAttribute('data-artifact-version'),
    definitionVersion: await locator.getAttribute('data-definition-version'),
    sourceFingerprint: await locator.getAttribute('data-source-fingerprint'),
  };
}

test.describe('podglad i pelny widok artefaktu', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    scripted.prepareDatabase();
    await scripted.start('artifact-snapshot-and-live');
  });
  test.afterAll(() => scripted.stop());

  test('podglad w wiadomosci i pelny widok pokazuja te sama wersje i ten sam stan zrodla', async ({
    page,
  }) => {
    await openApp(page);
    await ask(page, 'Zapisz zestawienie i wersje na zywo.');

    /* ------------------------- the preview in the message ------------------ */

    const preview = page.getByTestId('artifact-preview');
    await expect(preview).toBeVisible();
    const inMessage = await shownVersion(preview);
    expect(inMessage.id, 'podglad nie wskazuje artefaktu').toMatch(/^art_/);
    // A live artifact: the platform re-ran its query, so it reports which
    // definition answered and which state of the source it saw.
    await expect(preview.getByTestId('artifact-live-state')).toHaveAttribute('data-live-state', 'fresh');
    expect(inMessage.definitionVersion).toBe('1');
    expect(inMessage.sourceFingerprint, 'brak odcisku stanu zrodla').toMatch(/^[0-9a-f]{16}$/);
    // The module's own renderer drew it, not a JSON dump.
    await expect(preview.getByTestId('artifact-comparison')).toBeVisible();
    // Read while the conversation is on screen: the artifact browser is the
    // other tab of this panel and the thread is unmounted while it is open.
    const previewRows = await preview.locator('[data-testid^="comparison-row-"]').allInnerTexts();
    expect(previewRows.length).toBeGreaterThan(0);

    /* --------------------- the full view in the browser -------------------- */

    await page.getByTestId('chat-tab-artifacts').click();
    const browser = page.locator('.openui-agent-artifact-browser');
    await expect(browser).toBeVisible();
    // Both artifacts of the run are listed; the live one is the one to open.
    await expect(browser).toContainText('Zestawienie z chwili');
    await browser.getByRole('button', { name: /Zestawienie na zywo/ }).click();

    const full = page.getByTestId('artifact-full');
    await expect(full).toBeVisible();
    const inBrowser = await shownVersion(full);

    expect(inBrowser.id, 'pelny widok otworzyl inny artefakt').toBe(inMessage.id);
    expect(inBrowser.version).toBe(inMessage.version);
    expect(inBrowser.definitionVersion).toBe(inMessage.definitionVersion);
    // The load-bearing one: the two views read the same state of the source.
    // Same definition and two different fingerprints would be two answers.
    expect(inBrowser.sourceFingerprint).toBe(inMessage.sourceFingerprint);
    await expect(full.getByTestId('artifact-comparison')).toBeVisible();

    // And what they draw is the same table, row for row.
    const fullRows = await full.locator('[data-testid^="comparison-row-"]').allInnerTexts();
    expect(fullRows).toEqual(previewRows);
  });

  test('snapshot i live po zmianie zrodla z interfejsu: otwarty widok live sie odswieza', async ({
    page,
  }) => {
    /*
     * Data preparation, before the interface is opened.
     *
     * The form that edits an offer item is a card of the case's workspace and
     * no screen adds a card of that kind, so the API puts it there — before the
     * browser has ever read that workspace, so nothing here depends on how a
     * cache reacts to a change made behind its back. Everything the test then
     * *does* — opening the case, opening its workspace, typing the new quantity,
     * saving — happens in the browser.
     */
    await page.request.post(`${BASE}/api/auth/session`, { data: {} });
    const caseId: string = await page.request
      .get(`${BASE}/api/m/procurement/cases`)
      .then((r) => r.json())
      .then((b) => b.cases.find((c: { code: string }) => c.code === 'PC-2026-01').id);
    const offerId: string = await page.request
      .get(`${BASE}/api/m/procurement/cases/${caseId}`)
      .then((r) => r.json())
      .then((b) => b.offers[0].offer.id);
    const spaceId: string = await page.request
      .post(`${BASE}/api/canvas/spaces/for-scope`, {
        data: { kind: 'case', id: caseId, title: 'Sprawa' },
      })
      .then((r) => r.json())
      .then((b) => b.space.id);
    const added = await page.request.post(`${BASE}/api/canvas/cards`, {
      data: {
        spaceId,
        title: 'Pozycja oferty',
        spec: { kind: 'component', component: 'procurement.offerItemForm', props: { offerId } },
        geometry: { x: 1160, y: 0, width: 460, height: 360 },
      },
    });
    expect(added.status(), `karta formularza nie powstala: ${await added.text()}`).toBeLessThan(300);

    await openApp(page);
    await ask(page, 'Zapisz zestawienie i wersje na zywo.');

    const preview = page.getByTestId('artifact-preview');
    await expect(preview).toBeVisible();
    const before = await shownVersion(preview);
    const totalsBefore = await preview.locator('[data-testid^="total-"]').allInnerTexts();
    expect(totalsBefore.length).toBeGreaterThan(0);

    /*
     * The snapshot saved by the same run, read through HTTP so its content can
     * be compared byte for byte before and after the change. The browser is
     * still the thing under test — this only records what the frozen artifact
     * said at this moment.
     */
    const snapshotBefore = await page.evaluate(async () => {
      const { artifacts } = await (await fetch('/api/artifacts', { credentials: 'include' })).json();
      const snap = artifacts.find((a: { title: string }) => a.title === 'Zestawienie z chwili');
      const body = await (await fetch(`/api/artifacts/${snap.id}`, { credentials: 'include' })).json();
      return { id: snap.id as string, content: JSON.stringify(body.content), live: body.live };
    });
    expect(snapshotBefore.live, 'snapshot nie moze miec rozstrzygniecia live').toBeNull();

    /* -------------------- change the source, from the interface ------------ */

    /*
     * Navigated by clicking, not by `page.goto`.
     *
     * A reload would rebuild the chat from the conversation's history and the
     * question under test — does an open live view notice that its source
     * moved — would answer itself trivially: everything is re-read after a
     * reload. The preview has to be the same mounted element before and after
     * the edit, which is what in-application navigation gives.
     */
    await page.getByRole('link', { name: 'Wszystkie sprawy' }).click();
    await page.locator('[data-testid^="case-tile-"]').first().click();
    await expect(page.getByTestId('case-detail-page')).toBeVisible();
    await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();

    const form = page.getByTestId('card-item-form');
    await expect(form).toBeVisible();
    // The chat panel — and the live preview in it — never unmounted.
    await expect(preview).toBeVisible();

    const quantity = form.locator('input[type="number"]').first();
    await quantity.fill('41');
    await form.getByTestId('save-item').click();

    /* ------------------------------ what moved ----------------------------- */

    // The open live view re-read its source: same saved question, different
    // state of the data behind it.
    await expect(preview).toHaveAttribute('data-definition-version', before.definitionVersion!);
    await expect(preview).not.toHaveAttribute('data-source-fingerprint', before.sourceFingerprint!, {
      timeout: 20_000,
    });
    await expect(preview.getByTestId('artifact-live-state')).toHaveAttribute('data-live-state', 'fresh');
    const totalsAfter = await preview.locator('[data-testid^="total-"]').allInnerTexts();
    expect(totalsAfter, 'zmiana danych nie ruszyla wyniku live — proba nic by nie dowodzila').not.toEqual(
      totalsBefore,
    );

    // The snapshot kept every number it was saved with.
    const snapshotAfter = await page.evaluate(async (id) => {
      const body = await (await fetch(`/api/artifacts/${id}`, { credentials: 'include' })).json();
      return JSON.stringify(body.content);
    }, snapshotBefore.id);
    expect(snapshotAfter).toBe(snapshotBefore.content);
  });

  test('po restarcie backendu snapshot nadal zamrozony, live nadal biezacy, plik do pobrania', async ({
    page,
  }) => {
    await openApp(page);

    /* ----------------------- a file uploaded from the interface ------------- */

    await page.goto(`${BASE}/files`);
    await expect(page.getByTestId('files-page')).toBeVisible();
    const bytes = `dowod-trwalosci-${Date.now()}`;
    await page.locator('[data-testid="files-page"] input[type="file"]').setInputFiles({
      name: 'trwalosc.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(bytes, 'utf8'),
    });
    const fileId = await page.evaluate(async () => {
      const { files } = await (await fetch('/api/files', { credentials: 'include' })).json();
      return files.find((f: { filename: string }) => f.filename === 'trwalosc.txt').id as string;
    });

    /* -------------------- the two artifacts, before the restart ------------- */

    const ids = await page.evaluate(async () => {
      const { artifacts } = await (await fetch('/api/artifacts', { credentials: 'include' })).json();
      const by = (title: string) => artifacts.find((a: { title: string }) => a.title === title).id as string;
      return { snapshot: by('Zestawienie z chwili'), live: by('Zestawienie na zywo') };
    });
    const before = await page.evaluate(async (a) => {
      const read = async (id: string) =>
        (await fetch(`/api/artifacts/${id}`, { credentials: 'include' })).json();
      const [snap, live] = await Promise.all([read(a.snapshot), read(a.live)]);
      return { snapshot: JSON.stringify(snap.content), live: live.live.sourceFingerprint as string };
    }, ids);

    /* ------------------------------ real restart --------------------------- */

    // The process is stopped and started again on the same data directory —
    // not a second connection to the same database.
    await scripted.restart('artifact-snapshot-and-live');
    await page.goto(`${BASE}/files`);
    await expect(page.getByTestId('files-page')).toBeVisible();

    const after = await page.evaluate(async (a) => {
      const read = async (id: string) =>
        (await fetch(`/api/artifacts/${id}`, { credentials: 'include' })).json();
      const [snap, live] = await Promise.all([read(a.snapshot), read(a.live)]);
      return {
        snapshot: JSON.stringify(snap.content),
        liveState: live.live.state as string,
        liveFingerprint: live.live.sourceFingerprint as string,
        liveRows: live.content.rows.length as number,
      };
    }, ids);

    expect(after.snapshot, 'snapshot zmienil sie po restarcie').toBe(before.snapshot);
    expect(after.liveState).toBe('fresh');
    expect(after.liveRows).toBeGreaterThan(0);
    /*
     * The source has not moved since the last read, so the live answer is the
     * same state of it.
     *
     * Deliberately not read as "recomputed rather than remembered": an equal
     * fingerprint is consistent with both, and this test cannot tell them
     * apart. What shows that a live artifact stores no data is
     * `tests/live-artifacts.test.ts` ("artefakt live nigdy nie przechowuje
     * danych, tylko pytanie": the stored version *is* the descriptor), and what
     * shows the answer follows the source is the fingerprint moving when the
     * source moves. Here the point is narrower and still worth having: a
     * restart changed neither.
     */
    expect(after.liveFingerprint).toBe(before.live);

    /* ---------------------- the file, downloaded after the restart ---------- */

    const download = await page.evaluate(async (id) => {
      const res = await fetch(`/api/files/${id}/content`, { credentials: 'include' });
      return { status: res.status, text: await res.text() };
    }, fileId);
    expect(download.status).toBe(200);
    expect(download.text).toBe(bytes);
  });
});
