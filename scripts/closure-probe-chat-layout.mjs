/* DIAGNOSTIC (closure 2026-09-15) — drives the conversation drawer. Not production code. */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BASE = process.env.CLOSURE_BASE ?? 'http://127.0.0.1:8796';
const OUT = process.argv[2] ?? 'docs/evidence/closure-2026-09-15';
const WIDTHS = [
  { name: 'szeroki', width: 1680, height: 1000 },
  { name: 'waski', width: 1120, height: 900 },
];

const report = { base: BASE, at: new Date().toISOString(), viewports: {} };
const browser = await chromium.launch();

for (const vp of WIDTHS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() =>
    fetch('/api/auth/session', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' }));
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.pf-chat', { timeout: 15000 });

  const measure = () => page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const g = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) }; };
    const panel = q('.pf-chat');
    const sb = q('.openui-agent-sidebar-container');
    const pr = panel?.getBoundingClientRect();
    const sr = sb?.getBoundingClientRect();
    return {
      panel: g(panel), sidebar: g(sb),
      sidebarLeft: sb ? getComputedStyle(sb).left : null,
      sidebarInsidePanel: !!(pr && sr) && sr.x >= pr.x - 1 && sr.x + sr.width <= pr.x + pr.width + 1,
      thread: g(q('.openui-agent-thread-chat-panel')),
      composer: g(q('.openui-agent-thread-composer__input')),
      threadListVisible: !!q('.openui-agent-thread-list')?.getBoundingClientRect().width,
      /* Do the drawer and the conversation overlap on screen? */
      overlap: !!(pr && sr) && sr.x < pr.x + pr.width && sr.x + sr.width > pr.x,
    };
  });

  const state = { viewport: vp };
  state.closed = await measure();

  // OPEN via the ready-made control.
  const opener = page.locator('.pf-chat [aria-label="Open sidebar"]');
  state.openerCount = await opener.count();
  state.openerVisible = state.openerCount > 0 && (await opener.first().isVisible());
  await opener.first().click();
  await page.waitForTimeout(600);
  state.open = await measure();
  await page.screenshot({ path: `${OUT}/11-drawer-open-${vp.name}.png` });

  // A close control must exist, be visible, and be focusable.
  const closer = page.locator('.pf-chat [aria-label="Collapse sidebar"]');
  state.closerCount = await closer.count();
  state.closerVisible = state.closerCount > 0 && (await closer.first().isVisible());
  if (state.closerVisible) {
    state.closerFocusable = await closer.first().evaluate((el) => {
      el.focus();
      return document.activeElement === el;
    });
    // Keyboard, not mouse: the control must work for a keyboard user.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    state.afterKeyboardClose = await measure();
  }
  await page.screenshot({ path: `${OUT}/12-drawer-closed-${vp.name}.png` });

  report.viewports[vp.name] = state;
  console.log(`\n=== ${vp.name} (${vp.width}px) ===`);
  console.log('zamknieta  :', JSON.stringify(state.closed));
  console.log('otwieracz  :', state.openerCount, 'widoczny:', state.openerVisible);
  console.log('otwarta    :', JSON.stringify(state.open));
  console.log('zamykacz   :', state.closerCount, 'widoczny:', state.closerVisible, 'fokusowalny:', state.closerFocusable);
  console.log('po klawisz :', JSON.stringify(state.afterKeyboardClose));
  await page.close();
}

writeFileSync(`${OUT}/11-chat-drawer.json`, JSON.stringify(report, null, 2));
await browser.close();
