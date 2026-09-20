#!/usr/bin/env node
/**
 * Frontend smoke diagnostic.
 *
 * Loads the production bundle in a headless browser and prints what actually
 * rendered plus every console/page error. Faster than reading a failing
 * Playwright report when the whole app fails to boot.
 *
 *   node scripts/diag-frontend.mjs [url]
 *
 * **Wczytanie strony jest zapisem.** `apps/web/src/main.tsx` wola przy starcie
 * `switchAccessContext`, czyli `POST /api/auth/session` — wiec ta diagnostyka
 * zapisuje sesje w instancji, ktora wskaze, a zrzut ekranu utrwala jej dane.
 * Domyslny cel `http://127.0.0.1:8791/` kierowal ja wprost na port instancji
 * uzytkownika. Idzie teraz przez te sama bramke, co `pnpm acceptance`: domyslnie
 * 8790, etykieta instancji sprawdzana przed otwarciem przegladarki (L1.8).
 */
import { chromium } from '@playwright/test';
import { requireAcceptanceInstance } from './lib/acceptance-target.mjs';

let url;
try {
  const target = await requireAcceptanceInstance({
    // Środowisko w całości: bramka czyta APP_INSTANCE_RUN_ID i APP_DATA_DIR —
    // te same wartości, z jakimi wystartowała instancja odbiorcza.
    ...process.env,
    APP_BASE: process.argv[2] ?? process.env.APP_BASE_URL,
  });
  url = `${target.base}/`;
} catch (e) {
  console.error(e.message);
  process.exit(3);
}
console.log(`# instancja: ${url}`);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];

page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`CONSOLE: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('requestfailed', (r) => errors.push(`REQFAIL: ${r.url()} ${r.failure()?.errorText ?? ''}`));

await page
  .goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  .catch((e) => errors.push(`GOTO: ${e.message}`));
await page.waitForTimeout(3500);

const shot = process.env.DIAG_SCREENSHOT;
if (shot) {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: shot });
  console.log(`zrzut: ${shot}`);
}

const bodyText = await page.locator('body').innerText().catch(() => '(brak body)');
console.log('--- widoczny tekst (600 znakow) ---');
console.log(bodyText.slice(0, 600));

console.log('\n--- selektory testowe ---');
for (const id of ['statusbar', 'canvas', 'chat-context', 'cases-page']) {
  const count = await page.locator(`[data-testid="${id}"]`).count();
  console.log(`  ${id}: ${count}`);
}

console.log('\n--- bledy ---');
if (errors.length === 0) console.log('  (brak)');
for (const e of errors.slice(0, 15)) console.log(`  ${e.slice(0, 400)}`);

await browser.close();
process.exit(errors.length ? 1 : 0);
