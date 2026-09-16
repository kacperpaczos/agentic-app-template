#!/usr/bin/env node
/**
 * DIAGNOSTIC (audit 2026-09-15) — characterises the chat panel layout with the
 * conversation drawer open vs closed. Needs no model turn.
 */
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
const BASE = process.env.AUDIT_BASE ?? 'http://127.0.0.1:8795';
const SHOTS = 'docs/evidence/audit-2026-09-15';
mkdirSync(SHOTS, { recursive: true });
const out = []; const log = (s) => { out.push(s); console.log(s); };

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1680, height: 1000 });

const box = async (sel) => page.locator(sel).first().evaluate((e) => {
  const b = e.getBoundingClientRect();
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
}).catch(() => null);

const snapshot = async (label) => {
  const drawer = await page.locator('.openui-agent-thread-list').isVisible().catch(() => false);
  const b = {
    panel: await box('.pf-chat'),
    body: await box('.pf-chat__body'),
    container: await box('.openui-agent-container'),
    sidebar: await box('.openui-agent-sidebar-container'),
    thread: await box('.openui-agent-thread-container'),
    composer: await box('.openui-agent-thread-composer__input'),
  };
  const buttons = await page.locator('.pf-chat button').evaluateAll((els) => els
    .filter((e) => e.offsetWidth || e.offsetHeight)
    .map((e) => e.getAttribute('aria-label') || (e.textContent || '').trim().slice(0, 18))
    .filter(Boolean));
  log(`\n--- ${label} (szuflada widoczna: ${drawer}) ---`);
  for (const [k, v] of Object.entries(b)) log(`  ${k.padEnd(10)} ${v ? `x=${v.x} y=${v.y} w=${v.w} h=${v.h}` : 'BRAK'}`);
  log(`  widoczne przyciski: ${buttons.join(' | ')}`);
  return { drawer, ...b };
};

await page.goto(`${BASE}/cases`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
await page.locator('[data-testid^="case-tile-"]').first().click();
await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
await page.getByTestId('card-case-summary').first().waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);

const opened = await snapshot('stan po wejsciu przez /cases');
await page.screenshot({ path: `${SHOTS}/14-chat-szuflada-otwarta.png` });

// try every plausible control to close the drawer
const candidates = ['Collapse sidebar', 'Close sidebar', 'Hide sidebar', 'Toggle sidebar', 'Expand sidebar', 'Open sidebar'];
let closedBy = null;
for (const label of candidates) {
  const btn = page.locator(`.pf-chat [aria-label="${label}"]`).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(800);
    const vis = await page.locator('.openui-agent-thread-list').isVisible().catch(() => false);
    if (!vis) { closedBy = label; break; }
  }
}
log(`\nkontrolka zamykajaca szuflade: ${closedBy ?? 'NIE ZNALEZIONA'}`);
const closed = await snapshot('po probie zamkniecia');
await page.screenshot({ path: `${SHOTS}/15-chat-po-probie-zamkniecia.png` });

const threadVisibleWhenOpen = opened.thread && opened.thread.w > 100
  && opened.panel && opened.thread.x >= opened.panel.x - 5;
log(`\nWNIOSEK: watek ${threadVisibleWhenOpen ? 'miesci sie' : 'NIE miesci sie'} w panelu czatu przy otwartej szufladzie`);
if (opened.composer && opened.panel) {
  const overflow = opened.composer.x + opened.composer.w - (opened.panel.x + opened.panel.w);
  log(`kompozytor wystaje poza panel o ${overflow} px`);
}

writeFileSync(`${SHOTS}/16-probe-chat-layout.txt`, out.join('\n') + '\n');
await browser.close();
