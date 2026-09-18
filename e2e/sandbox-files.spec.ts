import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import {
  BLUE,
  GREEN,
  RED,
  WORKBOOK_TOTAL,
  bandsPng,
  loadWorkbook,
  multiSheetWorkbook,
} from './support/fixtures-files.ts';
import { type Page } from '@playwright/test';

/**
 * Attaching files to a command, processing one in the sandbox, and getting the
 * result back as something that is still there afterwards.
 *
 * Five formats go in through the composer's own attachment field; the run reads
 * them **from their bytes** (a sum, a marker word, sheet names, image
 * dimensions), so a pass cannot be produced by the filename, the media type or
 * the size. The workbook is then opened, changed and published, and the result
 * is followed through a conversation switch and a restart of the server.
 *
 * **Simulation at the model boundary, marked as such.** The scenario is
 * scripted; the script it runs in the workspace is a real Node process with the
 * real toolkit, the consent gate is the real one, and the publication, the
 * cleanup and the artifact are the application's own. What a stand-in cannot do
 * is *understand* an image — that claim belongs to the real-model run recorded
 * for L11.21, and nothing here pretends to it.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-sandboxfiles' });
const BASE = scripted.baseUrl;
const XLSX_MEDIA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

async function attach(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByTestId('chat-attach-input').setInputFiles({ name, mimeType, buffer });
  await expect(page.getByTestId('chat-attachment-list')).toContainText(name, { timeout: 30_000 });
}

async function send(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

const urlConversation = (page: Page) => new URL(page.url()).searchParams.get('c');

/** Waits for the run to end, approving anything it asks for on the way. */
async function settled(page: Page): Promise<string[]> {
  const approved: string[] = [];
  const deadline = Date.now() + 120_000;
  const state = page.getByTestId('run-state');
  while (Date.now() < deadline) {
    const phase = await state.getAttribute('data-phase').catch(() => null);
    if (phase === 'succeeded' || phase === 'failed' || phase === 'cancelled') return approved;
    const prompt = page.getByTestId('permission-prompt');
    if (await prompt.isVisible().catch(() => false)) {
      approved.push((await prompt.textContent())?.slice(0, 60) ?? '');
      await prompt.getByRole('button', { name: 'Zgoda' }).click();
    }
    await page.waitForTimeout(300);
  }
  throw new Error('uruchomienie nie zakonczylo sie w czasie');
}

const answerText = (page: Page, conversationId: string) =>
  page.evaluate(async (id) => {
    const messages = (await (
      await fetch(`/api/threads/get/${id}`, { credentials: 'include' })
    ).json()) as Array<{ role: string; content: string }>;
    return messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('\n');
  }, conversationId);

const listFiles = (page: Page) =>
  page.evaluate(
    async () =>
      (
        await (await fetch('/api/files', { credentials: 'include' })).json()
      ).files as Array<{
        id: string;
        filename: string;
        version: number;
        sha256: string;
        derivedFromFileId: string | null;
        attachedTo: Array<{ conversationId: string; prompt: string }>;
      }>,
  );

const download = async (page: Page, fileId: string): Promise<Buffer> =>
  Buffer.from(
    await page.evaluate(async (id) => {
      const res = await fetch(`/api/files/${id}/content`, { credentials: 'include' });
      return Array.from(new Uint8Array(await res.arrayBuffer()));
    }, fileId),
  );

/**
 * A genuine JPEG, encoded by the browser.
 *
 * Hand-built JPEG bytes would be a header with nothing behind it; a canvas
 * export is a real image with real dimensions and real colours, which is what
 * makes "the run read the file" a claim about content rather than about a name.
 */
async function bandsJpeg(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 120;
    const ctx = canvas.getContext('2d')!;
    const colours = ['#dc1e1e', '#1eaa3c', '#2850d2'];
    colours.forEach((colour, i) => {
      ctx.fillStyle = colour;
      ctx.fillRect(i * 80, 0, 80, 120);
    });
    return canvas.toDataURL('image/jpeg', 0.9);
  });
  return Buffer.from(dataUrl.split(',')[1]!, 'base64');
}

test.describe('pliki w sandboxie', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    scripted.prepareDatabase();
    await scripted.start('bl09-files');
  });
  test.afterAll(() => scripted.stop());

  test('PNG, JPEG, XLSX, CSV i tekst dolaczone do polecenia sa odczytane z tresci', async ({
    page,
  }) => {
    await openApp(page);

    await attach(page, 'pasy.png', 'image/png', bandsPng([RED, GREEN, BLUE]));
    await attach(page, 'pasy.jpg', 'image/jpeg', await bandsJpeg(page));
    await attach(page, 'oferty.xlsx', XLSX_MEDIA, await multiSheetWorkbook());
    await attach(
      page,
      'pozycje.csv',
      'text/csv',
      Buffer.from('nazwa;ilosc\nkrzeslo;10\nstol;2\nlampa;5\n', 'utf8'),
    );
    await attach(
      page,
      'notatka.txt',
      'text/plain',
      Buffer.from('Notatka robocza. Kod dostepu HASLO-Z10BL09 do kontroli.\n', 'utf8'),
    );

    await send(page, 'Przeczytaj zalaczniki i powiedz, co w nich jest.');
    await settled(page);
    const conversation = urlConversation(page)!;
    const said = await answerText(page, conversation);

    /*
     * Each fact below had to come out of the bytes. None of them is derivable
     * from the filename, the media type or the size, which is the whole point of
     * the criterion.
     */
    expect(said, `odpowiedz: ${said}`).toContain('suma=17'); // 10 + 2 + 5
    expect(said).toContain('haslo=HASLO-Z10BL09');
    expect(said).toContain('arkusze=Pozycje|Metryka|Pusty');
    expect(said).toMatch(/pasy\.png[^;]*wymiary=360x160/);
    expect(said).toMatch(/pasy\.jpg[^;]*wymiary=240x120/);

    /* ------------- the attachment is tied to the command afterwards -------- */

    // The message itself carries what it was sent with, so the link travels
    // with the conversation and not only with the files screen.
    const userMessage = await page.evaluate(async (id) => {
      const messages = (await (
        await fetch(`/api/threads/get/${id}`, { credentials: 'include' })
      ).json()) as Array<{ role: string; attachments?: Array<{ fileId: string; filename: string }> }>;
      return messages.find((m) => m.role === 'user' && m.attachments?.length) ?? null;
    }, conversation);
    expect(userMessage?.attachments?.map((a) => a.filename).sort()).toEqual([
      'notatka.txt',
      'oferty.xlsx',
      'pasy.jpg',
      'pasy.png',
      'pozycje.csv',
    ]);

    await page.goto(`${BASE}/files`);
    await expect(page.getByTestId('files-page')).toBeVisible();
    const files = await listFiles(page);
    const csv = files.find((f) => f.filename === 'pozycje.csv')!;
    expect(csv.attachedTo.map((a) => a.conversationId)).toEqual([conversation]);
    expect(csv.attachedTo[0]!.prompt).toContain('Przeczytaj zalaczniki');
    // And it is on screen, not only in the API — after a full page load, which
    // is when the in-flight link used to be gone.
    await expect(page.getByTestId(`file-attached-${csv.id}`)).toContainText('Przeczytaj zalaczniki');
  });

  test('nieobslugiwany format jest odrzucony w polu zalacznika', async ({ page }) => {
    await openApp(page);
    await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();

    const before = (await listFiles(page)).length;
    await page
      .getByTestId('chat-attach-input')
      .setInputFiles({ name: 'program.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') });

    // The refusal is shown where the user is, and it names the reason.
    const error = page.getByTestId('chat-attach-error');
    await expect(error).toBeVisible({ timeout: 15_000 });
    await expect(error).toContainText('application/x-msdownload');
    // Nothing was attached and nothing was stored.
    await expect(page.getByTestId('chat-attachment-list')).toHaveCount(0);
    expect((await listFiles(page)).length, 'odrzucony plik mimo wszystko trafil do magazynu').toBe(before);
  });

  test('skoroszyt: wiele arkuszy i typow komorek, wynik z zachowanymi typami, oryginal nietkniety', async ({
    page,
  }) => {
    await openApp(page);
    await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();

    const originalBytes = await multiSheetWorkbook();
    await attach(page, 'skoroszyt.xlsx', XLSX_MEDIA, originalBytes);
    await send(page, 'Policz wartosci i opublikuj nowa wersje skoroszytu.');
    const approvals = await settled(page);
    const conversation = urlConversation(page)!;

    // Running code went through the consent gate — it is not auto-approved.
    expect(approvals.join(' '), 'kod nie przeszedl przez bramke zgody').toMatch(/Bash/);

    const said = await answerText(page, conversation);
    // Read: every sheet, and every cell type the workbook contains.
    expect(said).toContain('arkusze=Pozycje|Metryka|Pusty|Podsumowanie');
    for (const type of ['data', 'formula', 'liczba', 'logiczna', 'pusta', 'tekst']) {
      expect(said, `typ komorki ${type} nie zostal odczytany`).toContain(type);
    }
    expect(said).toContain(`suma=${WORKBOOK_TOTAL}`);

    /* ------------------------ the produced workbook ------------------------ */

    const files = await listFiles(page);
    const original = files.find((f) => f.filename === 'skoroszyt.xlsx' && f.version === 1)!;
    const produced = files.find((f) => f.derivedFromFileId === original.id)!;
    expect(produced.version).toBe(2);

    const producedBytes = await download(page, produced.id);
    const wb = await loadWorkbook(producedBytes);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Pozycje',
      'Metryka',
      'Pusty',
      'Podsumowanie',
    ]);

    // The types the source had are still types in the result …
    const meta = wb.getWorksheet('Metryka')!;
    expect(meta.getCell('B1').value).toBeInstanceOf(Date);
    expect(meta.getCell('B2').value).toBe(true);
    // … and so are the ones the run wrote.
    const summary = wb.getWorksheet('Podsumowanie')!;
    expect(summary.getCell('B1').value).toBe(WORKBOOK_TOTAL);
    expect(summary.getCell('B2').value).toBeInstanceOf(Date);
    expect(summary.getCell('B3').value).toBe(false);

    /*
     * The formula the run wrote carries **no value**: there is nothing in the
     * file that could be read back and presented as a calculated result. A
     * number here would mean something had claimed to compute it.
     */
    const formula = summary.getCell('B4').value as { formula: string; result?: unknown };
    expect(formula.formula).toBe('B1*2');
    expect(formula.result ?? null, 'zapisana formula ma wartosc, ktorej nikt nie policzyl').toBeNull();

    // The original is exactly what was uploaded.
    const originalNow = await download(page, original.id);
    expect(Buffer.compare(originalNow, originalBytes), 'oryginal zostal zmieniony').toBe(0);
    expect(original.sha256).toBe(files.find((f) => f.id === original.id)!.sha256);

    /*
     * And the run's scratch directory is gone, so the download above came from
     * the managed store rather than from the workspace.
     */
    const runId = await page.getByTestId('run-state').getAttribute('data-run-id');
    expect(existsSync(resolve(scripted.config.dataDir, 'workspaces', runId!))).toBe(false);
  });

  test('uszkodzony skoroszyt konczy sie bledem, a nic nie zostaje opublikowane', async ({ page }) => {
    await openApp(page);
    await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();

    const before = (await listFiles(page)).length;
    await attach(
      page,
      'uszkodzony.xlsx',
      XLSX_MEDIA,
      Buffer.from('to nie jest skoroszyt, tylko tekst', 'utf8'),
    );
    await send(page, 'To jest uszkodzony skoroszyt — sprobuj go otworzyc.');
    await settled(page);
    const conversation = urlConversation(page)!;

    const said = await answerText(page, conversation);
    // The failure is reported as a failure — not as an empty workbook.
    expect(said).toContain('blad=');
    expect(said).not.toContain('arkusze=');
    // Nothing new was published out of a file that could not be read: the store
    // grew by the upload alone, and nothing derives from the broken workbook.
    const after = await listFiles(page);
    expect(after.length).toBe(before + 1);
    const corrupt = after.find((f) => f.filename === 'uszkodzony.xlsx')!;
    expect(corrupt).toBeTruthy();
    expect(after.filter((f) => f.derivedFromFileId === corrupt.id)).toHaveLength(0);
  });

  test('wynik jest artefaktem z podgladem i pobraniem, takze po zmianie rozmowy i restarcie', async ({
    page,
  }) => {
    await openApp(page);

    // The conversation that produced the workbook, found by its own artifact.
    const artifacts = await page.evaluate(
      async () =>
        (
          await (await fetch('/api/artifacts', { credentials: 'include' })).json()
        ).artifacts as Array<{ id: string; title: string; type: string; threadId: string }>,
    );
    const artifact = artifacts.find((a) => a.title.includes('oferty-poprawione'))!;
    expect(artifact, 'opublikowana wersja pliku nie jest artefaktem rozmowy').toBeTruthy();
    expect(artifact.type).toBe('platform.file');

    /* ------------------- preview under the message ------------------------- */

    await page.goto(`${BASE}/?c=${artifact.threadId}`);
    await expect(page.locator('.openui-agent-thread-messages')).toBeVisible();
    const preview = page.getByTestId('artifact-preview');
    await expect(preview.first()).toBeVisible({ timeout: 30_000 });
    await expect(preview.first()).toHaveAttribute('data-artifact-id', artifact.id);

    /* ------- a different conversation, then back, then a restart ----------- */

    await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();
    await expect(page.getByTestId('artifact-preview')).toHaveCount(0);

    await scripted.restart('bl09-files');
    await page.goto(`${BASE}/?c=${artifact.threadId}`);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

    // The artifact browser — the tab a user opens to find what a run produced.
    await page.getByTestId('chat-tab-artifacts').click();
    const browser = page.locator('.openui-agent-artifact-browser');
    await expect(browser).toBeVisible();
    await browser.getByRole('button', { name: /oferty-poprawione/ }).click();
    const full = page.getByTestId('artifact-full');
    await expect(full).toBeVisible();
    await expect(full).toHaveAttribute('data-artifact-id', artifact.id);

    // A download link, and bytes behind it that still open as a workbook.
    const link = full.getByRole('link', { name: /Pobierz/ });
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/api\/files\/fil_[a-z0-9]+\/content$/);
    const fileId = href!.split('/')[3]!;
    const bytes = await download(page, fileId);
    const wb = await loadWorkbook(bytes);
    expect(wb.worksheets.map((w) => w.name)).toContain('Podsumowanie');

    /* ---------------------- access control, both ends ---------------------- */

    const asOther = await page.evaluate(async (id) => {
      await fetch('/api/auth/session', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'other-user' }),
      });
      const file = await fetch(`/api/files/${id}/content`, { credentials: 'include' });
      const list = await (await fetch('/api/artifacts', { credentials: 'include' })).json();
      return { fileStatus: file.status, artifacts: list.artifacts.length as number };
    }, fileId);
    expect(asOther.fileStatus, 'cudzy plik wynikowy jest do pobrania').toBe(403);
    expect(asOther.artifacts, 'cudzy artefakt jest widoczny').toBe(0);
  });
});
