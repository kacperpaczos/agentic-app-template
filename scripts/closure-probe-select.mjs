/* DIAGNOSTIC (closure) — selecting a conversation from the drawer with several present. */
import { chromium } from '@playwright/test';
const BASE = 'http://127.0.0.1:8798';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1680, height: 1000 } });
p.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto(`${BASE}/`);
await p.evaluate(() => fetch('/api/auth/session', { method: 'POST', credentials: 'include', headers: {'content-type':'application/json'}, body: '{}' }));
await p.goto(`${BASE}/`);
await p.waitForSelector('.openui-agent-thread-composer__input');

const threads = await p.evaluate(async () => (await (await fetch('/api/threads/get', { credentials: 'include' })).json()).threads);
console.log('watki:', threads.map((t) => t.title).join(' | '));

await p.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
await p.waitForTimeout(800);
const rows = await p.evaluate(() =>
  [...document.querySelectorAll('.openui-agent-thread-button')].map((el) => ({
    text: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 60),
    html: el.outerHTML.slice(0, 260),
  })));
console.log('wierszy w szufladzie:', rows.length);
for (const r of rows) console.log('  -', r.text);
if (rows[0]) console.log('HTML pierwszego wiersza:', rows[0].html);

const target = 'Dodaj karte podsumowania, prosze';
const row = p.locator('.openui-agent-thread-button', { hasText: target }).first();
console.log('znaleziono wiersz:', await row.count());
await row.locator('.openui-agent-thread-button-title').first().click({ force: true });
await p.waitForTimeout(3000);
console.log('po kliknieciu, wiadomosci:', await p.evaluate(() => document.querySelector('.openui-agent-thread-messages')?.children.length ?? -1));
console.log('tekst:', await p.evaluate(() => document.querySelector('.openui-agent-thread-messages')?.textContent?.replace(/\s+/g,' ').slice(0,160)));
console.log('kontener ukryty?', await p.evaluate(() => {
  const c = document.querySelector('.openui-agent-thread-container');
  return c ? getComputedStyle(c).visibility : '(brak)';
}));
await b.close();
