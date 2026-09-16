#!/usr/bin/env node
/**
 * Derives the acceptance-matrix summary from the matrix itself.
 *
 * Exists because the hand-written summary in FEEDBACK.md drifted from the tables
 * (reported 91 criteria against 95 actual, and every per-status count was wrong).
 * A report whose own totals are unreliable undermines every other number in it,
 * so the totals are now computed, and `--check` fails the build on drift.
 *
 *   node scripts/matrix-summary.mjs           # print the summary
 *   node scripts/matrix-summary.mjs --check   # verify docs/archive/agenticapp-2026-09/FEEDBACK.md agrees
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Historyczna macierz AgenticApp (95 kryteriów) — zarchiwizowany dziennik, nie dziennik szablonu.
const file = resolve(root, 'docs/archive/agenticapp-2026-09/FEEDBACK.md');
const source = readFileSync(file, 'utf8');

const ROW = /^\|\s*(L(\d+)\.\d+)\s*\|.*?\|\s*\*\*([A-ZĄĆĘŁŃÓŚŹŻ-]+)\*\*\s*\|/gm;
const OPEN = new Set(['CZĘŚĆ', 'KOD', 'NIE', 'BLK']);

const rows = [...source.matchAll(ROW)].map((m) => ({
  id: m[1],
  layer: Number(m[2]),
  status: m[3],
}));

if (rows.length === 0) {
  console.error('Nie znaleziono zadnego wiersza macierzy — zmienil sie format tabel?');
  process.exit(2);
}

const duplicates = rows.map((r) => r.id).filter((id, i, all) => all.indexOf(id) !== i);
const counts = new Map();
for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);

const layers = new Map();
for (const r of rows) {
  if (!layers.has(r.layer)) layers.set(r.layer, []);
  layers.get(r.layer).push(r);
}
const closed = [...layers.entries()]
  .filter(([, items]) => items.every((i) => !OPEN.has(i.status)))
  .map(([layer]) => layer)
  .sort((a, b) => a - b);
const open = [...layers.entries()]
  .filter(([, items]) => items.some((i) => OPEN.has(i.status)))
  .map(([layer, items]) => ({
    layer,
    blocking: items.filter((i) => OPEN.has(i.status)).map((i) => `${i.id} ${i.status}`),
  }))
  .sort((a, b) => a.layer - b.layer);

const order = ['ZAL-R', 'ZAL-T', 'CZĘŚĆ', 'KOD', 'NIE', 'BLK'];
const summaryRows = order
  .filter((s) => counts.has(s))
  .map((s) => `| ${s} | ${counts.get(s)} |`);

const report = [
  `kryteriow: ${rows.length}`,
  ...order.filter((s) => counts.has(s)).map((s) => `  ${s.padEnd(7)} ${counts.get(s)}`),
  `warstwy zamkniete (${closed.length}/12): ${closed.join(', ') || '-'}`,
  `warstwy otwarte  (${open.length}/12):`,
  ...open.map((o) => `  L${o.layer}: ${o.blocking.join(', ')}`),
];

if (duplicates.length) report.push(`UWAGA duplikaty identyfikatorow: ${duplicates.join(', ')}`);

console.log(report.join('\n'));

if (!process.argv.includes('--check')) {
  console.log('\n--- tabela do wklejenia ---');
  console.log('| Status | Liczba |\n|---|---|');
  console.log(summaryRows.join('\n'));
  console.log(`| **Razem** | **${rows.length}** |`);
  process.exit(0);
}

/* ------------------------------- drift check ------------------------------ */

const problems = [];
const stated = source.match(/\|\s*\*\*Razem\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/);
if (!stated) problems.push('brak wiersza "Razem" w podsumowaniu macierzy');
else if (Number(stated[1]) !== rows.length) {
  problems.push(`podsumowanie mowi "Razem ${stated[1]}", a w tabelach jest ${rows.length}`);
}

for (const status of order) {
  if (!counts.has(status)) continue;
  const re = new RegExp(`\\|\\s*${status.replace('-', '\\-')}[^|]*\\|\\s*(\\d+)\\s*\\|`);
  const m = source.match(re);
  if (!m) problems.push(`brak wiersza podsumowania dla statusu ${status}`);
  else if (Number(m[1]) !== counts.get(status)) {
    problems.push(`${status}: podsumowanie mowi ${m[1]}, a w tabelach jest ${counts.get(status)}`);
  }
}

if (duplicates.length) problems.push(`duplikaty identyfikatorow: ${duplicates.join(', ')}`);

if (problems.length) {
  console.error('\nPODSUMOWANIE MACIERZY ROZJECHALO SIE Z TABELAMI:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('\nPodsumowanie macierzy zgodne z tabelami.');
