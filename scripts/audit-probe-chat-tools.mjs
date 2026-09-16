#!/usr/bin/env node
/**
 * DIAGNOSTIC (audit 2026-09-15) — does the ready-made chat render tool activity
 * and the final answer for a run that calls application tools?
 *
 * Deliberately does NOT click "New chat": screenshot 06 showed that opening the
 * conversation drawer leaves the thread area blank, which confounded an earlier
 * observation. Here the thread view stays visible the whole time.
 */
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:8795';
const SHOTS = 'docs/evidence/audit-2026-09-15';
mkdirSync(SHOTS, { recursive: true });
const out = [];
const log = (s) => { out.push(s); console.log(s); };

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1680, height: 1000 });
const api = (p) => page.evaluate((x) => fetch(x, { credentials: 'include' }).then((r) => r.json()), p);

await page.goto(`${BASE}/cases`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.locator('[data-testid^="case-tile-"]').first().click();
await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
await page.getByTestId('card-case-summary').first().waitFor({ timeout: 30_000 });

const drawerOpen = await page.locator('.openui-agent-thread-list').isVisible().catch(() => false);
log(`szuflada rozmow otwarta na starcie: ${drawerOpen}`);
if (drawerOpen) {
  const collapse = page.locator('.pf-chat [aria-label="Collapse sidebar"], .pf-chat [aria-label="Close sidebar"]').first();
  if (await collapse.isVisible().catch(() => false)) { await collapse.click(); await page.waitForTimeout(600); }
}

const MARK = 'ZNACZNIK-NARZEDZIOWY';
const composer = page.locator('.openui-agent-thread-composer__input');
await composer.waitFor({ timeout: 15_000 });
await composer.fill(
  `Uzyj narzedzia procurement_compare_offers dla tej sprawy, a potem odpowiedz jednym zdaniem konczacym sie slowem ${MARK}.`,
);
await page.locator('.pf-chat [aria-label="Send message"]').first().click();

let sawToolDom = false;
let sawToolSelector = '';
const TOOL_SELECTORS = [
  '.openui-agent-tool-call', '[class*="tool-call"]', '[class*="ToolCall"]',
  '[class*="openui-agent-tool"]', '[data-testid*="tool"]',
];
let runRow = null;
const deadline = Date.now() + 280_000;
while (Date.now() < deadline) {
  for (const sel of TOOL_SELECTORS) {
    if (!sawToolDom && (await page.locator(sel).count()) > 0) { sawToolDom = true; sawToolSelector = sel; }
  }
  const threads = (await api('/api/threads/get')).threads ?? [];
  if (threads.length) {
    const runs = (await api(`/api/conversations/${threads[0].id}/runs`)).runs ?? [];
    if (runs.length && runs[0].status !== 'running') { runRow = runs[0]; break; }
  }
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(6000);
await page.screenshot({ path: `${SHOTS}/12-chat-z-narzedziami.png` });

const text = await page.locator('.pf-chat').innerText();
const html = await page.locator('.pf-chat').innerHTML();
const events = runRow ? ((await api(`/api/runs/${runRow.id}/events`)).events ?? []) : [];
const toolNames = events.filter((e) => e.name === 'TOOL_CALL_START').map((e) => e.payload?.toolCallName);

log(`run: ${runRow?.status} dur=${runRow?.durationMs} ms`);
log(`strumien TOOL_CALL_START: ${[...new Set(toolNames)].join(', ') || 'brak'}`);
log(`DOM czatu — element narzedzia: ${sawToolDom ? `TAK (${sawToolSelector})` : 'NIE'}`);
log(`DOM czatu — znacznik odpowiedzi "${MARK}": ${text.includes(MARK) ? 'TAK' : 'NIE'}`);
log(`DOM czatu — dlugosc tekstu: ${text.replace(/\s+/g, ' ').length} znakow`);
log(`DOM czatu — klasy zawierajace "tool": ${[...new Set([...html.matchAll(/class="([^"]*tool[^"]*)"/gi)].map((m) => m[1]))].slice(0, 5).join(' | ') || 'brak'}`);
log(`ostatnie 200 znakow tekstu czatu: ${text.replace(/\s+/g, ' ').slice(-200)}`);

writeFileSync(`${SHOTS}/13-probe-chat-tools.txt`, out.join('\n') + '\n');
await browser.close();
