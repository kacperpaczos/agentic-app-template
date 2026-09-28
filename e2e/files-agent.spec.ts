import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
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
 * Attaching a file through the interface and having the agent work on its real
 * contents — on the real model, because that is the claim.
 *
 * Both inputs are built so that the filename and the metadata cannot produce
 * the answer:
 *
 *  - the image is three wide colour bands, and the question is which colours, in
 *    what order. Nothing outside the pixels says;
 *  - the workbook's total has to come from multiplying quantities by prices
 *    across a sheet. Nothing outside the cells says it either.
 *
 * The workbook half also checks the part that matters most once an agent can
 * write files: the produced version is a **new** file, and the original is
 * byte-for-byte what was uploaded.
 *
 * Costs subscription turns. Kept to two commands for that reason.
 */

const AGENT_TIMEOUT = 420_000;
const DOWNLOADS = resolve(tmpdir(), 'agenticapp-e2e-downloads');

async function attach(page: Page, filename: string, mimeType: string, buffer: Buffer) {
  await page.getByTestId('chat-attach-input').setInputFiles({ name: filename, mimeType, buffer });
  await expect(page.getByTestId('chat-attachment-list')).toContainText(filename, {
    timeout: 30_000,
  });
}

async function send(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

/**
 * Waits for the run, approving any consent the agent asks for on the way.
 *
 * Processing a file means running code, and running code means `Bash` — which
 * this platform deliberately does **not** auto-approve, even inside the sandbox
 * (`autoAllowBashIfSandboxed: false`). So the honest path for "analyse this
 * spreadsheet" includes the user saying yes, and the test says yes the same way
 * a user would: by clicking the button.
 *
 * Observed directly rather than assumed: without this the run parks at
 * `awaiting_consent` after writing its script, with `Bash: node
 * process_oferty.js` pending.
 */
async function settled(page: Page): Promise<string[]> {
  const approved: string[] = [];
  const deadline = Date.now() + 300_000;
  const state = page.getByTestId('run-state');
  while (Date.now() < deadline) {
    const phase = await state.getAttribute('data-phase').catch(() => null);
    if (phase === 'succeeded' || phase === 'failed' || phase === 'cancelled') return approved;

    const prompt = page.getByTestId('permission-prompt');
    if (await prompt.isVisible().catch(() => false)) {
      approved.push((await prompt.textContent())?.slice(0, 80) ?? '');
      await prompt.getByRole('button', { name: 'Zgoda' }).click();
    }
    await page.waitForTimeout(400);
  }
  throw new Error('uruchomienie nie zakonczylo sie w czasie');
}

/** Everything the assistant produced in this conversation, from the backend. */
async function conversationText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const c = new URL(location.href).searchParams.get('c');
    const messages = (await (
      await fetch(`/api/threads/get/${c}`, { credentials: 'include' })
    ).json()) as Array<{ role: string; content: string }>;
    return messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('\n');
  });
}

test.describe('pliki dolaczone przez interfejs, prawdziwy model', () => {
  test.describe.configure({ mode: 'serial', timeout: AGENT_TIMEOUT });

  test.beforeAll(() => {
    mkdirSync(DOWNLOADS, { recursive: true });
  });

  test('agent odnosi sie do tresci obrazu, nie do jego nazwy', async ({ page, request }) => {
    await request.post('/api/auth/session', { data: {} });
    await page.goto('/');
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

    /*
     * A filename that would mislead anyone reading it instead of the pixels.
     * If the answer matches the name rather than the bands, the model did not
     * look at the image.
     */
    await attach(page, 'dokument-tekstowy.png', 'image/png', bandsPng([RED, GREEN, BLUE]));

    await send(
      page,
      'Na zalaczonym obrazie sa trzy pionowe pasy w jednolitych kolorach. ' +
        'Wymien ich kolory po polsku, od lewej do prawej, w jednej linii, oddzielone przecinkami. ' +
        'Nie opisuj niczego wiecej.',
    );
    await settled(page);

    /*
     * Jedna linia, nie cala wypowiedź. Polecenie wprost kazalo wymienic kolory
     * w jednej linii, oddzielone przecinkami — wiec odpowiedzia jest ta linia,
     * a nie caly tekst modelu. Aserty kolejnosci przez indexOf na calej
     * wypowiedzi bywaly flaky: model mowiacy o pliku „dokument-tekstowy” albo
     * komentujacy obraz w innym zdaniu wplatal kolory poza lista, a pierwsze
     * wystapienia slow zalezialy od przypadku, nie od odpowiedzi.
     */
    const said = (await conversationText(page)).toLowerCase();
    const answerLine = said
      .split('\n')
      .map((line) => line.trim())
      .find((line) => [/czerwon/, /zielon/, /niebiesk/].every((re) => re.test(line)));
    expect(
      answerLine,
      `zadna linia odpowiedzi nie wymienia trzech kolorow w kolejnosci; odpowiedz modelu: ${JSON.stringify(said)}`,
    ).toBeTruthy();

    // The content, in order, within that one line. None of this is derivable
    // from the filename.
    expect(answerLine!.indexOf('czerwon')).toBeGreaterThanOrEqual(0);
    expect(answerLine!.indexOf('zielon'), `linia odpowiedzi: ${answerLine}`).toBeGreaterThan(
      answerLine!.indexOf('czerwon'),
    );
    expect(answerLine!.indexOf('niebiesk'), `linia odpowiedzi: ${answerLine}`).toBeGreaterThan(
      answerLine!.indexOf('zielon'),
    );
  });

  test('agent zmienia skoroszyt w sandboxie, a oryginal zostaje nietkniety', async ({
    page,
    request,
  }) => {
    await request.post('/api/auth/session', { data: {} });
    await page.goto('/');
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    await page.locator('.pf-chat .openui-icon-button[aria-label="New chat"]').first().click();

    const originalBytes = await multiSheetWorkbook();
    await attach(
      page,
      'oferty.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      originalBytes,
    );

    await send(
      page,
      'Zalaczony skoroszyt ma kilka arkuszy. W arkuszu "Pozycje" policz wartosc kazdej pozycji ' +
        'jako ilosc razy cena i zsumuj je. Nastepnie dodaj do skoroszytu nowy arkusz o nazwie ' +
        '"Podsumowanie" z jednym wierszem: w komorce A1 tekst "Razem", w komorce B1 policzona sume ' +
        'jako liczba. Zapisz zmieniony plik i opublikuj go jako NOWA WERSJE pliku wejsciowego ' +
        '(narzedzie files_publish_version, podaj fileId oryginalu). Nie zmieniaj oryginalu.',
    );
    const approvals = await settled(page);

    /*
     * The consent gate is part of this path, not an obstacle to it: the agent
     * had to write a script and ask before running it. Recording that here
     * stops the test from silently passing if shell execution ever became
     * auto-approved.
     */
    expect(approvals.join(' '), 'kod nie przeszedl przez bramke zgody').toMatch(/Bash/);

    /* ---------------------------- backend truth ---------------------------- */

    const files = await page.evaluate(
      async () =>
        (await (await fetch('/api/files', { credentials: 'include' })).json()) as {
          files: Array<{
            id: string;
            filename: string;
            version: number;
            derivedFromFileId: string | null;
            sha256: string;
            byteSize: number;
          }>;
        },
    );

    const original = files.files.find((f) => f.filename === 'oferty.xlsx' && f.version === 1);
    expect(original, 'nie znaleziono oryginalu').toBeTruthy();

    const produced = files.files.find((f) => f.derivedFromFileId === original!.id);
    expect(produced, `agent nie opublikowal nowej wersji; pliki: ${files.files.map((f) => `${f.filename}@${f.version}`).join(', ')}`).toBeTruthy();
    expect(produced!.version).toBe(2);

    /* ------------------- the original is exactly what was sent -------------- */

    const originalNow = await page.evaluate(async (id) => {
      const res = await fetch(`/api/files/${id}/content`, { credentials: 'include' });
      const buf = new Uint8Array(await res.arrayBuffer());
      return Array.from(buf);
    }, original!.id);
    expect(Buffer.compare(Buffer.from(originalNow), originalBytes), 'oryginal zostal zmieniony').toBe(0);

    /* ------------------ the produced file opens and has the change ---------- */

    const producedBytes = Buffer.from(
      await page.evaluate(async (id) => {
        const res = await fetch(`/api/files/${id}/content`, { credentials: 'include' });
        return Array.from(new Uint8Array(await res.arrayBuffer()));
      }, produced!.id),
    );
    writeFileSync(resolve(DOWNLOADS, 'wynik.xlsx'), producedBytes);

    const wb = await loadWorkbook(readFileSync(resolve(DOWNLOADS, 'wynik.xlsx')));
    const names = wb.worksheets.map((w) => w.name);
    // The sheets that were there before survived the round trip …
    expect(names).toEqual(expect.arrayContaining(['Pozycje', 'Metryka', 'Pusty']));
    // … and the requested one was added.
    expect(names).toContain('Podsumowanie');

    const summary = wb.getWorksheet('Podsumowanie')!;
    expect(String(summary.getCell('A1').value ?? '').toLowerCase()).toContain('razem');
    const total = summary.getCell('B1').value;
    const numeric = typeof total === 'number' ? total : Number((total as { result?: number })?.result);
    expect(numeric, `B1 zawiera ${JSON.stringify(total)}`).toBe(WORKBOOK_TOTAL);
  });

  test('wynik jest dostepny po powrocie do rozmowy', async ({ page }) => {
    await page.goto('/files');
    await expect(page.getByTestId('files-page')).toBeVisible();
    // Both files are listed and downloadable after leaving and coming back.
    await expect(page.getByTestId('files-page')).toContainText('oferty', { timeout: 30_000 });

    const files = await page.evaluate(
      async () =>
        (await (await fetch('/api/files', { credentials: 'include' })).json()) as {
          files: Array<{
            id: string;
            filename: string;
            version: number;
            byteSize: number;
            derivedFromFileId: string | null;
          }>;
        },
    );
    const original = files.files.find((f) => f.filename === 'oferty.xlsx' && f.version === 1);
    expect(original, 'nie znaleziono oryginalu na liscie plikow').toBeTruthy();
    const produced = files.files.find((f) => f.derivedFromFileId === original!.id);
    expect(produced, 'nie znaleziono wynikowej wersji pliku').toBeTruthy();

    /*
     * Prawdziwe pobranie przez API, a nie samo „status 200": dostepny znaczy,
     * ze leci pelny skoroszyt — z dodanym arkuszem i policzona suma (5300, jak
     * w tescie poprzednim). Sprostowanie samego kodu odpowiedzi przeszloby
     * rowniez z pusta trescia albo strona bledu.
     */
    const download = await page.evaluate(async (id) => {
      const res = await fetch(`/api/files/${id}/content`, { credentials: 'include' });
      return { status: res.status, bytes: Array.from(new Uint8Array(await res.arrayBuffer())) };
    }, produced!.id);
    expect(download.status).toBe(200);

    const bytes = Buffer.from(download.bytes);
    expect(bytes.length, 'pobrany plik jest pusty').toBeGreaterThan(0);
    expect(bytes.length, 'rozmiar pobrany rozni sie od metadanych pliku').toBe(produced!.byteSize);

    // And the bytes are the produced workbook: added sheet, derived total.
    const wb = await loadWorkbook(bytes);
    const summary = wb.getWorksheet('Podsumowanie');
    expect(summary, 'arkusz "Podsumowanie" zniknal z wynikowego pliku').toBeTruthy();
    expect(String(summary!.getCell('A1').value ?? '').toLowerCase()).toContain('razem');
    const total = summary!.getCell('B1').value;
    const numeric = typeof total === 'number' ? total : Number((total as { result?: number })?.result);
    expect(numeric, `B1 zawiera ${JSON.stringify(total)}`).toBe(WORKBOOK_TOTAL);
  });
});
