#!/usr/bin/env node
/**
 * DIAGNOSTIC (audit 2026-09-15) — decisive experiment for the suspected
 * mid-stream remount of the chat.
 *
 * Hypothesis: <AgentInterface key={conversationId ?? 'new'}> remounts when
 * chatWiring.send() stores the conversation id returned in the response header.
 * That happens only for the FIRST message of a NEW conversation, so:
 *   - message 1 (new conversation)      → answer should be LOST from the DOM
 *   - message 2 (same conversation)     → answer should APPEAR
 * Backend state must be complete in both cases.
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

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

const send = async (text) => {
  const c = page.locator('.openui-agent-thread-composer__input');
  await c.waitFor({ timeout: 15_000 });
  await c.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
};

const waitRunDone = async () => {
  for (let i = 0; i < 140; i += 1) {
    const threads = (await api('/api/threads/get')).threads ?? [];
    if (threads.length) {
      const runs = (await api(`/api/conversations/${threads[0].id}/runs`)).runs ?? [];
      if (runs.length && runs[0].status !== 'running') return { thread: threads[0], run: runs[0] };
    }
    await page.waitForTimeout(2000);
  }
  return null;
};

/* ------------------- message 1: brand new conversation -------------------- */

const newChat = page.locator('.pf-chat [aria-label="New chat"]').first();
if (await newChat.isVisible().catch(() => false)) { await newChat.click(); await page.waitForTimeout(700); }

const MARK1 = 'ZNACZNIK-PIERWSZY';
await send(`Odpowiedz dokladnie jednym slowem: ${MARK1}`);
const r1 = await waitRunDone();
await page.waitForTimeout(5000);
const dom1 = await page.locator('.pf-chat').innerText();
const msgs1 = await api(`/api/threads/get/${r1.thread.id}`);
await page.screenshot({ path: `${SHOTS}/09-remount-wiadomosc-1.png` });

log(`WIADOMOSC 1 (nowa rozmowa)`);
log(`  backend: run=${r1.run.status}, wiadomosci=${msgs1.length}, odpowiedz zawiera znacznik=${msgs1.some((m) => m.role === 'assistant' && m.content.includes(MARK1))}`);
log(`  DOM czatu zawiera znacznik=${dom1.includes(MARK1)}`);

/* -------------- message 2: same conversation, no key change --------------- */

const MARK2 = 'ZNACZNIK-DRUGI';
await send(`Odpowiedz dokladnie jednym slowem: ${MARK2}`);
for (let i = 0; i < 140; i += 1) {
  const runs = (await api(`/api/conversations/${r1.thread.id}/runs`)).runs ?? [];
  if (runs.length >= 2 && runs[0].status !== 'running') break;
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(5000);
const dom2 = await page.locator('.pf-chat').innerText();
const msgs2 = await api(`/api/threads/get/${r1.thread.id}`);
await page.screenshot({ path: `${SHOTS}/10-remount-wiadomosc-2.png` });

log(`WIADOMOSC 2 (ta sama rozmowa)`);
log(`  backend: wiadomosci=${msgs2.length}, odpowiedz zawiera znacznik=${msgs2.some((m) => m.role === 'assistant' && m.content.includes(MARK2))}`);
log(`  DOM czatu zawiera znacznik=${dom2.includes(MARK2)}`);

/* -------------------------- after a page reload --------------------------- */

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const dom3 = await page.locator('.pf-chat').innerText();
log(`PO PRZELADOWANIU`);
log(`  DOM zawiera znacznik 1=${dom3.includes(MARK1)}  znacznik 2=${dom3.includes(MARK2)}`);

const verdict = !dom1.includes(MARK1) && dom2.includes(MARK2);
log('');
log(`WERDYKT: ${verdict ? 'HIPOTEZA POTWIERDZONA — pierwsza odpowiedz w nowej rozmowie ginie z ekranu' : 'hipoteza niepotwierdzona'}`);

writeFileSync(`${SHOTS}/11-probe-remount.txt`, out.join('\n') + '\n');
await browser.close();
