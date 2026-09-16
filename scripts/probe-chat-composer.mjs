/*
 * DIAGNOSTIC (UX czatu 2026-09-16) — mierzy i fotografuje panel rozmowy.
 *
 * Nie jest kodem produkcyjnym. Powstal, bo zgloszony blad byl wzrokowy:
 * "zalaczniki z boku popsuly uklad". Liczby mowia, co zajmuje ile miejsca;
 * zrzuty pokazuja, jak to wyglada. Jedno bez drugiego nie wystarcza.
 *
 * Dziala na wskazanej instancji (domyslnie testowej), nigdy na instancji
 * uzytkownika — port podaje sie jawnie.
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/*
 * Port 8788: poza zakresem zarezerwowanym dla Playwrighta (8792-8799) i poza
 * portem instancji uzytkownika (8791). Ta sonda zajmowala 8798 i zderzyla sie z
 * suita scenariuszowa, ktora startuje wlasny serwer w tym zakresie — straz
 * izolacji slusznie odmowila pracy.
 */
const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:8788';
const OUT = process.argv[2] ?? 'docs/evidence/chat-ux-2026-09-16';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() =>
  fetch('/api/auth/session', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }),
);
/* Nie `networkidle`: aplikacja trzyma otwarty strumien zdarzen, wiec siec
   nigdy nie cichnie. Czekamy na to, co ma byc widoczne. */
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.openui-agent-thread-composer__input', { timeout: 20000 });

const measure = () =>
  page.evaluate(() => {
    const g = (s) => {
      const r = document.querySelector(s)?.getBoundingClientRect();
      return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
    };
    const container = document.querySelector('.openui-agent-container');
    return {
      panel: g('.pf-chat'),
      thread: g('.openui-agent-thread-container'),
      composer: g('.openui-agent-thread-composer'),
      attachButton: g('[data-testid="chat-attach-open"]'),
      submitButton: g('.openui-agent-thread-composer__submit-button'),
      containerChildren: [...(container?.children ?? [])].map((el) => {
        const r = el.getBoundingClientRect();
        return `${el.tagName.toLowerCase()}.${String(el.className || '').split(' ')[0]} [${Math.round(r.width)}x${Math.round(r.height)}]`;
      }),
      attachInsideActionBar: Boolean(
        document
          .querySelector('.openui-agent-thread-composer__action-bar')
          ?.contains(document.querySelector('[data-testid="chat-attach-open"]')),
      ),
      tabs: [...document.querySelectorAll('[role="tab"]')].map(
        (t) => `${t.textContent?.trim()}${t.getAttribute('aria-selected') === 'true' ? ' (aktywna)' : ''}`,
      ),
    };
  });

const chat = page.locator('.pf-chat');
const report = { base: BASE, at: new Date().toISOString() };

report.spoczynek = await measure();
await chat.screenshot({ path: `${OUT}/01-czat-spoczynek.png` });

// Plik dolaczony przez pole wiadomosci.
await page.setInputFiles('[data-testid="chat-attach-input"]', {
  name: 'oferty.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from('pozycja;ilosc;cena\nkabel;10;12.50\n'),
});
await page.waitForSelector('[data-testid="chat-attachment-list"]', { timeout: 20000 });
await page.fill('.openui-agent-thread-composer__input', 'Policz wartosc pozycji z tego pliku.');
report.zZalacznikiem = await measure();
await chat.screenshot({ path: `${OUT}/02-czat-z-zalacznikiem.png` });

// Menu spinacza.
await page.click('[data-testid="chat-attach-open"]');
await page.waitForSelector('[data-testid="chat-attach-menu"]', { timeout: 10000 });
await chat.screenshot({ path: `${OUT}/03-menu-zalacznika.png` });
await page.keyboard.press('Escape');

// Zakladka artefaktow.
await page.click('[data-testid="chat-tab-artifacts"]');
await page.waitForSelector('.openui-agent-artifact-browser', { timeout: 15000 });
report.zakladkaArtefakty = await measure();
await chat.screenshot({ path: `${OUT}/04-zakladka-artefakty.png` });

await page.click('[data-testid="chat-tab-thread"]');
await page.waitForSelector('.openui-agent-thread-composer__input', { timeout: 15000 });
report.powrotDoRozmowy = await measure();

writeFileSync(`${OUT}/pomiary.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
