import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import {
  describeVerdict,
  judgeStream,
  readStreamProbe,
  startStreamProbe,
  type StreamVerdict,
} from './support/streamProbe.ts';
import { type Page } from '@playwright/test';

/**
 * Proof that the answer streams — and proof that this check could tell if it
 * did not.
 *
 * A streaming assertion is only worth as much as its ability to fail. The
 * previous one could not: it waited for text in a turn that had called a tool,
 * where the ready-made chat withholds the answer until the turn resolves, so it
 * matched a conversation-starter label instead and passed instantly. Its
 * replacement was better but polled from Node, and reported two different
 * verdicts for the same behaviour on two runs of the suite.
 *
 * So this file runs the same detector over three scripted runs:
 *
 *  1. **text in pieces** — it must say the answer streamed;
 *  2. **the whole answer in one delta at the end** — it must say it did not;
 *  3. **a run that calls a tool and says nothing** — it must report no answer,
 *     although the user's message and the conversation starters are on screen
 *     the entire time.
 *
 * Cases 2 and 3 are what make case 1 mean something: together they show the
 * check distinguishes streaming from arrival, and that it is reading the
 * assistant's answer rather than any other text on the page.
 */

const scripted = new ScriptedInstance({ port: 8796, dataDirName: '.e2e-scripted-stream' });
const BASE = scripted.baseUrl;
const OUT_DIR = resolve(process.cwd(), 'docs/evidence/closure-2026-09-15');
const verdicts: Record<string, unknown> = {};

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

async function sendCommand(page: Page, text: string) {
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
}

/** Runs one scenario end to end and returns what the probe made of it. */
async function observeRun(page: Page, scenario: string, command: string): Promise<StreamVerdict> {
  await scripted.start(scenario);
  await openApp(page);
  await startStreamProbe(page);
  await sendCommand(page, command);

  await expect(page.getByTestId('run-state')).toBeVisible();
  await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /succeeded|failed/, {
    timeout: 60_000,
  });
  // One beat past the terminal phase, so the committed answer is on screen and
  // `finalText` is the complete one.
  await page.waitForTimeout(400);

  const verdict = judgeStream(await readStreamProbe(page));
  verdicts[scenario] = {
    streamed: verdict.streamed,
    powod: verdict.reason,
    probekWTrakcie: verdict.whileRunning.length,
    roznychDlugosci: verdict.distinctLengthsWhileRunning,
    pierwszaDlugosc: verdict.firstLengthWhileRunning,
    ostatniaDlugosc: verdict.lastLengthWhileRunning,
    koncowaDlugosc: verdict.finalLength,
  };
  return verdict;
}

test.describe('strumieniowanie odpowiedzi (scenariusz zamiast modelu)', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });
  test.afterEach(() => scripted.stop());
  test.afterAll(() => {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      resolve(OUT_DIR, '21-strumien.json'),
      JSON.stringify({ at: new Date().toISOString(), scenariusze: verdicts }, null, 2),
    );
  });

  test('tekst dociera fragmentami i jest widoczny przed koncem wykonania', async ({ page }) => {
    const verdict = await observeRun(page, 'text-only', 'Opowiedz cos w czterech zdaniach.');

    expect(verdict.streamed, describeVerdict(verdict)).toBe(true);

    /*
     * The acceptance criterion, restated as assertions rather than trusted to
     * the verdict alone: at least two *different* lengths of the *new* answer,
     * both seen while the run had not finished.
     */
    const lengths = verdict.whileRunning.map((s) => s.len);
    expect(new Set(lengths).size, `dlugosci w trakcie: ${lengths.join(', ')}`).toBeGreaterThanOrEqual(2);
    expect(verdict.whileRunning.every((s) => s.phase === 'queued' || s.phase === 'running')).toBe(true);
    expect(verdict.monotonic).toBe(true);
    // Something incomplete was on screen during the run — the difference between
    // an answer that streamed and an answer that merely arrived.
    expect(verdict.sawPartialAnswer).toBe(true);
    expect(verdict.firstLengthWhileRunning!).toBeLessThan(verdict.finalLength);

    await expect(page.getByTestId('assistant-message')).toContainText('Czwarte zdanie odpowiedzi.');
  });

  test('cala odpowiedz naraz na koncu jest rozpoznana jako brak strumieniowania', async ({ page }) => {
    const verdict = await observeRun(page, 'burst-at-end', 'Odpowiedz jednym kawalkiem.');

    // The detector must fail here. If this ever passes, the check above proves
    // only that an answer arrived.
    expect(verdict.streamed, describeVerdict(verdict)).toBe(false);
    expect(verdict.reason).toMatch(/naraz, na koncu|tylko raz|nie zaobserwowano/);
    // The answer itself did arrive — it is the *streaming* that is absent, and
    // the difference is exactly what the check has to see.
    await expect(page.getByTestId('assistant-message')).toContainText('Czwarte zdanie odpowiedzi.');
    expect(verdict.finalLength).toBeGreaterThan(0);
  });

  test('wiadomosc uzytkownika i podpowiedzi nie zaliczaja asercji strumieniowania', async ({
    page,
  }) => {
    const command = 'Sprawdz karty na canvasie, bez komentarza.';
    const verdict = await observeRun(page, 'tool-only-silent', command);

    // The user's own message is on screen, and so is the tool activity.
    await expect(page.locator('.pf-chat')).toContainText(command);
    await expect(
      page.locator('.openui-behind-the-scenes, .openui-tool-call-timeline, .openui-tool-call').first(),
    ).toBeVisible();

    // And still: no answer was observed, so nothing streamed.
    expect(verdict.streamed, describeVerdict(verdict)).toBe(false);
    expect(verdict.whileRunning.length, 'sonda policzyla tekst, ktory nie jest odpowiedzia').toBe(0);
    expect(verdict.finalLength).toBe(0);
  });
});
