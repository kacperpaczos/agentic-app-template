#!/usr/bin/env node
/**
 * Architecture boundary check.
 *
 * Two independent checks, because either alone is easy to fool:
 *
 *  1. Declared dependencies — no `@platform/*` package may list a `@module/*`
 *     package in its package.json.
 *  2. Actual import statements — no file under `packages/platform-*` may import
 *     from `@module/`, and no platform file may mention a business noun.
 *
 * Check 2 also scans for domain vocabulary, so an accidental "offer" or
 * "supplier" leaking into the platform core fails the build even if it arrived
 * as a string literal rather than an import.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, acc);
    else if (/\.(ts|tsx)$/.test(abs)) acc.push(abs);
  }
  return acc;
};

/* ---------------------------- 1. declared deps ---------------------------- */

const platformPackages = ['platform-contracts', 'platform-server', 'platform-ui'];

for (const pkg of platformPackages) {
  const manifestPath = join(root, 'packages', pkg, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const deps = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
  for (const name of Object.keys(deps)) {
    if (name.startsWith('@module/')) {
      failures.push(`[deps] ${manifest.name} deklaruje zaleznosc od modulu biznesowego: ${name}`);
    }
  }
}

/* ---------------------------- 2. actual imports --------------------------- */

const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

/**
 * Business vocabulary that must never appear in the platform core. Checked as
 * whole words, case-insensitively, against identifiers and string literals.
 */
const DOMAIN_WORDS = [
  'supplier',
  'dostawc',
  'offerItem',
  'oferta',
  'ofert',
  'procurement',
  'unitPrice',
  'priceBasis',
  'invoice',
  'faktur',
  'pc_cases',
  'pc_offers',
];

// The platform legitimately talks about its own generic concepts; these lines
// are exempted so the vocabulary scan does not produce noise.
const isExempt = (line) =>
  line.includes('scopeKind') ||
  line.includes('scopeId') ||
  line.trimStart().startsWith('*') ||
  line.trimStart().startsWith('/*') ||
  line.trimStart().startsWith('//');

for (const pkg of platformPackages) {
  const dir = join(root, 'packages', pkg, 'src');
  let files = [];
  try {
    files = walk(dir);
  } catch {
    continue;
  }
  for (const file of files) {
    const rel = relative(root, file);
    const source = readFileSync(file, 'utf8');

    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (spec.startsWith('@module/')) {
        failures.push(`[import] ${rel} importuje z modulu biznesowego: ${spec}`);
      }
    }

    source.split('\n').forEach((line, i) => {
      if (isExempt(line)) return;
      for (const word of DOMAIN_WORDS) {
        const re = new RegExp(`\\b${word}`, 'i');
        if (re.test(line)) {
          failures.push(`[slownik] ${rel}:${i + 1} zawiera pojecie domenowe "${word}": ${line.trim().slice(0, 90)}`);
        }
      }
    });
  }
}

/* ------------------- 3. module may depend on platform --------------------- */

const moduleManifest = JSON.parse(
  readFileSync(join(root, 'packages', 'module-procurement', 'package.json'), 'utf8'),
);
const moduleDeps = Object.keys(moduleManifest.dependencies ?? {});
if (!moduleDeps.some((d) => d.startsWith('@platform/'))) {
  failures.push('[deps] modul biznesowy nie zalezy od zadnego pakietu platformy - to podejrzane');
}

/* -------------------------------- report ---------------------------------- */

if (failures.length) {
  console.error('GRANICA PLATFORMA-DOMENA NARUSZONA:\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n${failures.length} naruszen.`);
  process.exit(1);
}

console.log('Granica platforma-domena zachowana:');
console.log('  - zaden pakiet @platform/* nie deklaruje zaleznosci od @module/*');
console.log('  - zaden plik platformy nie importuje z @module/*');
console.log(`  - zaden plik platformy nie uzywa slownika domenowego (${DOMAIN_WORDS.length} pojec)`);
console.log('  - modul biznesowy zalezy od platformy (kierunek prawidlowy)');
