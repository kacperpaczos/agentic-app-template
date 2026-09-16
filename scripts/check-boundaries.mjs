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
 *
 * Nothing here names a particular business module. Platform packages are the
 * `packages/platform-*` directories, business modules are `packages/module-*`,
 * and each module declares the words that must never leak into the platform in
 * its own package.json:
 *
 *   "agenticApp": { "domainVocabulary": ["supplier", "oferta", ...] }
 *
 * Replacing the example module therefore needs no edit to this script — the new
 * module brings its own vocabulary, and the check refuses to pass silently when
 * no module declares any.
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

const packageDirs = readdirSync(join(root, 'packages')).filter((d) =>
  statSync(join(root, 'packages', d)).isDirectory(),
);
const platformPackages = packageDirs.filter((d) => d.startsWith('platform-')).sort();
const modulePackages = packageDirs.filter((d) => d.startsWith('module-')).sort();
const readManifest = (dir) => JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'));

if (platformPackages.length === 0) failures.push('[pakiety] nie znaleziono zadnego packages/platform-*');

for (const pkg of platformPackages) {
  const manifest = readManifest(pkg);
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
 * whole-word prefixes, case-insensitively, against identifiers and string
 * literals. Collected from every module's `agenticApp.domainVocabulary`.
 */
const vocabularyOwners = new Map();
for (const dir of modulePackages) {
  const words = readManifest(dir).agenticApp?.domainVocabulary;
  if (words === undefined) continue;
  if (!Array.isArray(words) || words.some((w) => typeof w !== 'string' || w.trim() === '')) {
    failures.push(`[slownik] packages/${dir}/package.json: agenticApp.domainVocabulary musi byc lista niepustych napisow`);
    continue;
  }
  for (const word of words) vocabularyOwners.set(word, dir);
}
const DOMAIN_WORDS = [...vocabularyOwners.keys()];
if (DOMAIN_WORDS.length === 0) {
  failures.push(
    '[slownik] zaden modul nie deklaruje agenticApp.domainVocabulary — kontrola slownika nie mialaby czego sprawdzac',
  );
}

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

/* ------------------- 3. modules depend on the platform --------------------- */

for (const dir of modulePackages) {
  const manifest = readManifest(dir);
  const moduleDeps = Object.keys(manifest.dependencies ?? {});
  if (!moduleDeps.some((d) => d.startsWith('@platform/'))) {
    failures.push(`[deps] modul ${manifest.name} nie zalezy od zadnego pakietu platformy - to podejrzane`);
  }
}

/* -------------------------------- report ---------------------------------- */

if (failures.length) {
  console.error('GRANICA PLATFORMA-DOMENA NARUSZONA:\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n${failures.length} naruszen.`);
  process.exit(1);
}

console.log('Granica platforma-domena zachowana:');
console.log(`  - pakiety platformy: ${platformPackages.join(', ')}; moduly: ${modulePackages.join(', ') || '(brak)'}`);
console.log('  - zaden pakiet @platform/* nie deklaruje zaleznosci od @module/*');
console.log('  - zaden plik platformy nie importuje z @module/*');
console.log(`  - zaden plik platformy nie uzywa slownika domenowego (${DOMAIN_WORDS.length} pojec z manifestow modulow)`);
console.log('  - kazdy modul zalezy od platformy (kierunek prawidlowy)');
