#!/usr/bin/env node
/**
 * Architecture boundary check.
 *
 * Independent checks, because any one alone is easy to fool:
 *
 *  1. Declared dependencies — no `@platform/*` package may list a `@module/*`
 *     package in its package.json.
 *  2. Actual import statements — no file under `packages/platform-*` may import
 *     from `@module/`, and no platform file may mention a business noun.
 *  3. Configuration, not only code — the same two scans over every *non-source*
 *     file a platform package ships (package.json, tsconfig, JSON data, CSS,
 *     build scripts). A path alias in a tsconfig, a CSS class named after a
 *     business record or a generated JSON catalog carrying a module's component
 *     is a dependency just as real as an `import`, and none of them is a `.ts`
 *     file. The criterion asks for exactly this: "test zależności obejmuje kod
 *     i konfigurację, nie tylko nazwy pakietów".
 *  4. Module tables — no platform file, of any kind, may name a table created by
 *     a module's migrations. Without this, "the absence of a module causes no
 *     reference to its tables" would rest on nobody having written one down.
 *  5. Modules and the application's router — a module may neither declare nor
 *     import the router library. Its registration is global
 *     (`interface Register`), so a module that reaches for it types its own
 *     screens against the route table of whichever application composes it, and
 *     stops compiling for an application that composes something else.
 *
 * Nothing here names a particular business module. Platform packages are the
 * `packages/platform-*` directories, business modules are `packages/module-*`,
 * and each module declares the words that must never leak into the platform in
 * its own package.json:
 *
 *   "agenticApp": {
 *     "domainVocabulary": ["supplier", "oferta", "pc_cases"],
 *     "domainLabels": ["sprawy zakupowe", "sprawe"]
 *   }
 *
 * Two lists, because identifiers and user-visible copy need different matching
 * and one list could not do both:
 *
 *  - `domainVocabulary` matches as a **prefix** at a word boundary. That is what
 *    identifiers and table prefixes need (`dostawc` catches `dostawcy`,
 *    `dostawcow`, `supplierName`), and it is far too greedy for ordinary prose.
 *  - `domainLabels` matches as a **whole word or phrase**. That is what the text
 *    on screen needs: a heading, a button, an empty state. Prefix matching could
 *    not express it — the leak this list was added for was the shell's menu
 *    heading "Sprawy zakupowe", and a `spraw` prefix would have condemned
 *    "sprawdza", "sprawne" and "Sprawdz" in every platform file.
 *
 * Replacing the example module therefore needs no edit to this script — the new
 * module brings its own vocabulary, and the check refuses to pass silently when
 * no module declares either list.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

/**
 * Packages only the application composition root may use.
 *
 * The router is registered globally, so any file that imports it is typed
 * against the routes of the application it happens to be compiled with. For a
 * module that is a dependency on the composition root — see `useScreenParams`
 * and `AppLink` in `@platform/ui`, which is how a module navigates instead.
 */
const APP_ONLY_DEPENDENCIES = ['@tanstack/react-router'];

const SOURCE_RE = /\.(ts|tsx)$/;
/** Configuration and data a package ships next to its source. */
const CONFIG_RE = /\.(json|jsonc|css|mjs|cjs|js|yaml|yml)$/;

const walk = (dir, acc = [], test = SOURCE_RE) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, acc, test);
    else if (test.test(abs)) acc.push(abs);
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

/** Regex-safe: a label is prose, so it may contain `.`, `(`, `-` and the rest. */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Business vocabulary that must never appear in the platform core, collected
 * from every module's manifest. See the header for why there are two lists:
 * `domainVocabulary` matches as a word-boundary **prefix** (identifiers, table
 * prefixes), `domainLabels` as a whole **word or phrase** (text on screen).
 */
const readWordList = (dir, field) => {
  const words = readManifest(dir).agenticApp?.[field];
  if (words === undefined) return [];
  if (!Array.isArray(words) || words.some((w) => typeof w !== 'string' || w.trim() === '')) {
    failures.push(`[slownik] packages/${dir}/package.json: agenticApp.${field} musi byc lista niepustych napisow`);
    return [];
  }
  return words;
};

const vocabularyOwners = new Map();
const labelOwners = new Map();
for (const dir of modulePackages) {
  for (const word of readWordList(dir, 'domainVocabulary')) vocabularyOwners.set(word, dir);
  for (const word of readWordList(dir, 'domainLabels')) labelOwners.set(word, dir);
}
if (vocabularyOwners.size === 0) {
  failures.push(
    '[slownik] zaden modul nie deklaruje agenticApp.domainVocabulary — kontrola slownika nie mialaby czego sprawdzac',
  );
}
if (labelOwners.size === 0) {
  failures.push(
    '[slownik] zaden modul nie deklaruje agenticApp.domainLabels — kontrola etykiet widocznych w interfejsie nie mialaby czego sprawdzac',
  );
}

/**
 * Every term to look for, with the regular expression that decides a hit and
 * the module that owns it. One list downstream, so the code and the
 * configuration scans cannot drift apart.
 */
const DOMAIN_TERMS = [
  ...[...vocabularyOwners].map(([word, owner]) => ({ word, owner, kind: 'slownik', re: new RegExp(`\\b${escapeRe(word)}`, 'i') })),
  ...[...labelOwners].map(([word, owner]) => ({ word, owner, kind: 'etykieta', re: new RegExp(`\\b${escapeRe(word)}\\b`, 'i') })),
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
      for (const term of DOMAIN_TERMS) {
        if (term.re.test(line)) {
          failures.push(`[${term.kind}] ${rel}:${i + 1} zawiera pojecie domenowe modulu ${term.owner} "${term.word}": ${line.trim().slice(0, 90)}`);
        }
      }
    });
  }
}

/* ------------------------- 3. configuration, not code ---------------------- */

/*
 * The same two questions asked of everything a platform package ships that is
 * not TypeScript. A `paths` alias to a module in a tsconfig, a module's
 * component in a generated JSON catalog or a CSS rule written for a business
 * record would each be a dependency the two scans above cannot see, because
 * neither is an `import` and neither is in a `.ts` file.
 */
let configFilesScanned = 0;
for (const pkg of platformPackages) {
  const dir = join(root, 'packages', pkg);
  let files = [];
  try {
    files = walk(dir, [], CONFIG_RE);
  } catch {
    continue;
  }
  for (const file of files) {
    const rel = relative(root, file);
    configFilesScanned += 1;
    const source = readFileSync(file, 'utf8');

    source.split('\n').forEach((line, i) => {
      if (line.includes('@module/')) {
        failures.push(`[konfiguracja] ${rel}:${i + 1} odwoluje sie do modulu biznesowego: ${line.trim().slice(0, 90)}`);
      }
      if (isExempt(line)) return;
      for (const term of DOMAIN_TERMS) {
        if (term.re.test(line)) {
          failures.push(`[konfiguracja/${term.kind}] ${rel}:${i + 1} zawiera pojecie domenowe modulu ${term.owner} "${term.word}": ${line.trim().slice(0, 90)}`);
        }
      }
    });
  }
}

/* --------------------------- 4. tables of a module ------------------------- */

/*
 * Table names are taken from the modules' own migrations, so the check needs no
 * list to keep up to date and covers a module nobody has written yet.
 */
const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)/gi;
const moduleTables = new Map();
for (const dir of modulePackages) {
  for (const file of walk(join(root, 'packages', dir, 'src'), [])) {
    for (const m of readFileSync(file, 'utf8').matchAll(CREATE_TABLE_RE)) moduleTables.set(m[1], dir);
  }
}
if (moduleTables.size === 0) {
  failures.push('[tabele] zaden modul nie tworzy tabel — kontrola odwolan do tabel modulu nie mialaby czego sprawdzac');
}
for (const pkg of platformPackages) {
  const dir = join(root, 'packages', pkg);
  let files = [];
  try {
    files = [...walk(join(dir, 'src'), []), ...walk(dir, [], CONFIG_RE)];
  } catch {
    continue;
  }
  for (const file of files) {
    const rel = relative(root, file);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (isExempt(line)) return;
        for (const [table, owner] of moduleTables) {
          if (new RegExp(`\\b${table}\\b`).test(line)) {
            failures.push(`[tabele] ${rel}:${i + 1} odwoluje sie do tabeli modulu ${owner}: ${table}`);
          }
        }
      });
  }
}

/* ------------------- 5. modules depend on the platform --------------------- */

for (const dir of modulePackages) {
  const manifest = readManifest(dir);
  const deps = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
  if (!Object.keys(manifest.dependencies ?? {}).some((d) => d.startsWith('@platform/'))) {
    failures.push(`[deps] modul ${manifest.name} nie zalezy od zadnego pakietu platformy - to podejrzane`);
  }
  for (const forbidden of APP_ONLY_DEPENDENCIES) {
    if (deps[forbidden]) {
      failures.push(
        `[deps] modul ${manifest.name} deklaruje zaleznosc zarezerwowana dla warstwy skladania: ${forbidden}`,
      );
    }
  }
  for (const file of walk(join(root, 'packages', dir, 'src'), [])) {
    const rel = relative(root, file);
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      if (APP_ONLY_DEPENDENCIES.includes(match[1])) {
        failures.push(
          `[import] ${rel} importuje pakiet warstwy skladania: ${match[1]} — ekran modulu czyta parametry przez useScreenParams(), a linkuje przez AppLink`,
        );
      }
    }
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
console.log(
  `  - zaden plik platformy nie uzywa slownika domenowego (${vocabularyOwners.size} przedrostkow) ani etykiety domenowej (${labelOwners.size} calych slow i fraz) z manifestow modulow`,
);
console.log(
  `  - konfiguracja platformy tez czysta (${configFilesScanned} plikow json/css/js/yaml bez @module/* i bez slownika)`,
);
console.log(
  `  - zaden plik platformy nie nazywa tabeli modulu (${moduleTables.size}: ${[...moduleTables.keys()].join(', ')})`,
);
console.log('  - kazdy modul zalezy od platformy (kierunek prawidlowy)');
console.log(`  - zaden modul nie deklaruje ani nie importuje ${APP_ONLY_DEPENDENCIES.join(', ')}`);
