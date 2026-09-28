/* DIAGNOSTIC (closure) — dumps the chat DOM after a scripted run. */
import { chromium } from '@playwright/test';
const BASE = process.env.BASE ?? 'http://127.0.0.1:8798';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1680, height: 1000 } });
const logs = [];
p.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
p.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 400)}`));
await p.goto(`${BASE}/`);
await p.evaluate(() => fetch('/api/auth/session', { method: 'POST', credentials: 'include', headers: {'content-type':'application/json'}, body: '{}' }));
await p.goto(`${BASE}/`);
await p.waitForSelector('.openui-agent-thread-composer__input');
await p.locator('.openui-agent-thread-composer__input').fill('Dodaj karte podsumowania.');
await p.locator('.pf-chat [aria-label="Send message"]').first().click();
await p.waitForTimeout(6000);

const info = await p.evaluate(() => {
  const chat = document.querySelector('.pf-chat');
  const classes = new Set();
  chat?.querySelectorAll('*').forEach((el) => String(el.className || '').split(/\s+/).forEach((c) => c && classes.add(c)));
  return {
    toolish: [...classes].filter((c) => /tool|timeline|step/i.test(c)),
    messageClasses: [...classes].filter((c) => /message|thread-message/i.test(c)),
    text: (chat?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 500),
  };
});
const html = await p.evaluate(() => document.querySelector('.openui-agent-thread-messages')?.outerHTML ?? '(brak kontenera)');
console.log('HTML wiadomosci:', html.slice(0, 2500));
console.log('klasy z "tool":', JSON.stringify(info.toolish));
console.log('klasy wiadomosci:', JSON.stringify(info.messageClasses));
console.log('tekst czatu:', info.text);

const hist = await p.evaluate(async () => {
  const t = await (await fetch('/api/threads/get', { credentials: 'include' })).json();
  const id = t.threads[0].id;
  return await (await fetch(`/api/threads/get/${id}`, { credentials: 'include' })).json();
});
console.log('historia z backendu:', JSON.stringify(hist, null, 1).slice(0, 900));
console.log('\n--- konsola ---');
for (const l of logs.slice(-25)) console.log(l);
await b.close();
