#!/usr/bin/env node
/**
 * DIAGNOSTIC (audit 2026-09-15) — not production code, not part of `pnpm test`.
 *
 * Observes what the ready-made OpenUI chat actually renders during a real run.
 *
 * Two mistakes in the first version are worth recording, because both produced
 * false GAPs: Playwright's `request` fixture has its own cookie jar (so
 * /api/artifacts answered 401 and looked empty), and the DOM was inspected
 * before the run had finished. Both are fixed here: API calls go through
 * `page.evaluate` with the page's own cookies, and the probe waits for the
 * backend to report a terminal run status.
 */
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:8795';
const SHOTS = 'docs/evidence/audit-2026-09-15';
mkdirSync(SHOTS, { recursive: true });

const out = [];
const probe = (id, ok, note) => {
  const line = `PROBE ${id.padEnd(30)} ${ok ? 'OK ' : 'GAP'} ${note}`;
  out.push(line); console.log(line);
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1680, height: 1000 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

/** Same-origin fetch from inside the page, so it carries the session cookie. */
const api = (path) => page.evaluate(
  (p) => fetch(p, { credentials: 'include' }).then((r) => r.json()),
  path,
);

await page.goto(`${BASE}/cases`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await page.locator('[data-testid^="case-tile-"]').first().click();
await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
await page.getByTestId('card-case-summary').first().waitFor({ timeout: 30_000 });

const artsBefore = (await api('/api/artifacts')).artifacts ?? [];

const newChat = page.locator('.pf-chat [aria-label="New chat"]').first();
if (await newChat.isVisible().catch(() => false)) await newChat.click();
await page.waitForTimeout(800);

const composer = page.locator('.openui-agent-thread-composer__input');
await composer.waitFor({ timeout: 15_000 });
await composer.fill(
  'Porownaj oferty dla tej sprawy narzedziem aplikacji, a potem zapisz zestawienie jako artefakt narzedziem procurement_save_comparison. Odpowiedz jednym zdaniem.',
);
await page.locator('.pf-chat [aria-label="Send message"]').first().click();

/* ---------------- poll the BACKEND for a terminal run status --------------- */

let runRow = null;
let toolSeenInDomDuringRun = false;
const deadline = Date.now() + 280_000;
while (Date.now() < deadline) {
  const threads = (await api('/api/threads/get')).threads ?? [];
  if (threads.length) {
    const runs = (await api(`/api/conversations/${threads[0].id}/runs`)).runs ?? [];
    if (runs.length) {
      runRow = runs[0];
      if (runRow.status !== 'running') break;
    }
  }
  const html = await page.locator('.pf-chat').innerHTML().catch(() => '');
  if (/openui-agent-tool|tool-call|toolcall|tool_call/i.test(html)) toolSeenInDomDuringRun = true;
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(5000);
await page.screenshot({ path: `${SHOTS}/06-chat-po-przebiegu.png` });

probe('RUN-zakonczony', runRow?.status === 'succeeded',
  `status=${runRow?.status} dur=${runRow?.durationMs} ms firstToken=${runRow?.firstTokenMs} ms`);

const chatHtml = await page.locator('.pf-chat').innerHTML();
const chatText = await page.locator('.pf-chat').innerText();

/* -------------- did the run really call an application tool? -------------- */

const events = runRow ? ((await api(`/api/runs/${runRow.id}/events`)).events ?? []) : [];
const toolStarts = events.filter((e) => e.name === 'TOOL_CALL_START')
  .map((e) => e.payload?.toolCallName).filter(Boolean);
probe('STRUMIEN-wywolania-narzedzi', toolStarts.some((n) => n.startsWith('mcp__app__')),
  `TOOL_CALL_START: ${[...new Set(toolStarts)].join(', ') || 'brak'}`);

probe('CHAT-aktywnosc-narzedzi-w-DOM',
  toolSeenInDomDuringRun || /openui-agent-tool|tool-call|toolcall/i.test(chatHtml),
  toolSeenInDomDuringRun
    ? 'element narzedzia byl widoczny w DOM czatu w trakcie przebiegu'
    : 'BRAK elementu narzedzia w DOM czatu mimo wywolan w strumieniu');

probe('CHAT-odpowiedz-koncowa-widoczna',
  /MediaPro|49\s?270|zestawien|porownan/i.test(chatText),
  `${chatText.replace(/\s+/g, ' ').slice(-140)}`);

const stuck = await page.locator('.openui-dot-matrix-loader, .pf-chat [aria-label="Stop"]').count();
probe('CHAT-brak-pozornego-oczekiwania', stuck === 0,
  stuck === 0 ? 'brak wskaznika trwajacego wykonania po zakonczeniu' : `pozostalo ${stuck} wskaznikow`);

/* -------------------------------- artifacts ------------------------------- */

const artsAfter = (await api('/api/artifacts')).artifacts ?? [];
const added = artsAfter.filter((a) => !artsBefore.some((b) => b.id === a.id));
probe('ARTEFAKT-utworzony', added.length > 0,
  `przed=${artsBefore.length} po=${artsAfter.length} nowe=${added.map((a) => `${a.type}/${a.title.slice(0, 26)}`).join('; ') || 'brak'}`);

if (added.length) {
  await page.goto(`${BASE}/files`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const filesText = await page.locator('body').innerText();
  probe('ARTEFAKT-widoczny-na-ekranie', filesText.includes(added[0].title.slice(0, 20)),
    `ekran Pliki i raporty ${filesText.includes(added[0].title.slice(0, 20)) ? 'zawiera' : 'NIE zawiera'} "${added[0].title.slice(0, 30)}"`);
  await page.screenshot({ path: `${SHOTS}/07-artefakty.png` });
} else {
  probe('ARTEFAKT-widoczny-na-ekranie', false, 'pominiete — nie powstal zaden artefakt');
}

probe('UI-brak-bledow-konsoli', errors.length === 0, errors.slice(0, 2).join(' | ') || 'brak');

writeFileSync(`${SHOTS}/08-probes-browser.txt`, out.join('\n') + '\n');
await browser.close();
console.log(`\nzapisano ${out.length} wynikow`);
