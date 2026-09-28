/* DIAGNOSTIC (closure) — what the chat renders after reloading a stored conversation. */
import { chromium } from '@playwright/test';
const BASE = 'http://127.0.0.1:8798';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1680, height: 1000 } });
p.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await p.goto(`${BASE}/`);
await p.evaluate(() => fetch('/api/auth/session', { method: 'POST', credentials: 'include', headers: {'content-type':'application/json'}, body: '{}' }));
await p.goto(`${BASE}/`);
await p.waitForSelector('.openui-agent-thread-composer__input');
await p.locator('.openui-agent-thread-composer__input').fill('Dodaj karte podsumowania.');
await p.locator('.pf-chat [aria-label="Send message"]').first().click();
await p.waitForTimeout(4000);
console.log('PO PRZEBIEGU:', await p.evaluate(() => document.querySelector('.openui-agent-thread-messages')?.textContent?.replace(/\s+/g,' ').slice(0,200)));

await p.reload();
await p.waitForSelector('.openui-agent-thread-composer__input');
await p.locator('.pf-chat [aria-label="Open sidebar"]').first().click();
await p.waitForTimeout(500);
await p.locator('.openui-agent-thread-button').first().click({ force: true });
await p.waitForTimeout(2500);
const after = await p.evaluate(() => ({
  html: document.querySelector('.openui-agent-thread-messages')?.outerHTML?.slice(0, 1200) ?? '(brak)',
  text: document.querySelector('.openui-agent-thread-messages')?.textContent?.replace(/\s+/g,' ').slice(0,200),
}));
console.log('PO PRZELADOWANIU tekst:', after.text);
console.log('PO PRZELADOWANIU html:', after.html);
const api = await p.evaluate(async () => {
  const { threads } = await (await fetch('/api/threads/get', { credentials: 'include' })).json();
  return await (await fetch(`/api/threads/get/${threads[0].id}`, { credentials: 'include' })).json();
});
console.log('API zwraca:', JSON.stringify(api).slice(0, 600));
await b.close();
