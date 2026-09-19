#!/usr/bin/env node
/**
 * Are the pinned versions still the latest stable ones, and does the dependency
 * graph hold together?
 *
 * **What was missing.** The claim "React and TypeScript are the latest stable
 * versions" was established by hand on 2026-09-15 and then written down. Nothing
 * ever asked again, so the claim could stop being true without a single signal —
 * and the day somebody bumps a dependency, the sentence still reads the same.
 * Separately, `.npmrc` carries `strict-peer-dependencies=false`, so an
 * incompatible peer produces a warning during installation and an installation
 * that succeeds; nothing in the regression looked at peers at all.
 *
 * **Two halves, and only one of them can be offline.**
 *
 *  - *Online, deliberate* (`--refresh`): asks the npm registry what the latest
 *    stable version of each tracked package is and records the answer, together
 *    with the sha256 of `pnpm-lock.yaml`.
 *  - *Offline, every regression* (`tests/versions.test.ts`): the recorded answer
 *    must describe **this** dependency set — the lockfile hash is compared — the
 *    pinned versions must match what was recorded as latest, the record must not
 *    be older than {@link MAX_AGE_DAYS} days, and the lockfile itself must have
 *    no unmet peer dependency and no package installed at two versions where one
 *    is required.
 *
 * The lockfile hash is what makes the recording trustworthy: change a
 * dependency and the record stops describing the tree, loudly, instead of
 * quietly describing the tree of a month ago.
 *
 *   node scripts/check-versions.mjs            # offline check, exit 1 on problems
 *   node scripts/check-versions.mjs --refresh  # asks the registry, rewrites the record
 *
 * Kryteria: L1.2.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RECORD = resolve(REPO, 'docs/acceptance/wersje-rejestr.json');
export const LOCKFILE = resolve(REPO, 'pnpm-lock.yaml');

/** How long a "this is the latest stable version" statement stays credible. */
export const MAX_AGE_DAYS = 180;

/**
 * Packages the criterion names: these **must** be the latest stable version,
 * and a difference is a failure.
 */
export const WYMAGANE_NAJNOWSZE = ['react', 'react-dom', 'typescript'];

/**
 * Packages recorded and compared, but not required to be newest.
 *
 * The difference is reported, never hidden — and it is deliberately not a
 * failure: L1.2 is about React and TypeScript, and a regression that goes red
 * on somebody else's patch release would be turned off within a week, taking
 * the part that matters with it.
 */
export const OBSERWOWANE = ['vite', 'zod', 'hono'];

export const TRACKED = [...WYMAGANE_NAJNOWSZE, ...OBSERWOWANE];

/** Workspace manifests that pin versions. */
export const MANIFESTS = [
  'package.json',
  'apps/web/package.json',
  'apps/server/package.json',
  'packages/platform-ui/package.json',
  'packages/platform-server/package.json',
  'packages/platform-contracts/package.json',
];

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/* --------------------------- manifests and pins --------------------------- */

/**
 * Every exact pin of a tracked package, by manifest.
 *
 * Ranges are reported as-is rather than resolved: this repository pins exactly
 * on purpose, and a range appearing here is itself the finding.
 */
export function pinnedVersions(repo = REPO) {
  const pins = {};
  for (const file of MANIFESTS) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(resolve(repo, file), 'utf8'));
    } catch {
      continue;
    }
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (!TRACKED.includes(name)) continue;
        (pins[name] ??= []).push({ plik: file, wersja: range });
      }
    }
  }
  return pins;
}

/** One pinned version per package, or a description of the disagreement. */
export function singlePin(pins) {
  const out = {};
  const problems = [];
  for (const [name, entries] of Object.entries(pins)) {
    const versions = [...new Set(entries.map((e) => e.wersja))];
    if (versions.length > 1) {
      problems.push(
        `${name} jest przypiety w roznych wersjach: ${entries.map((e) => `${e.plik}→${e.wersja}`).join(', ')}`,
      );
    }
    if (!/^\d+\.\d+\.\d+/.test(versions[0] ?? '')) {
      problems.push(`${name}: "${versions[0]}" nie jest dokladna wersja (szablon przypina dokladnie)`);
    }
    out[name] = versions[0] ?? null;
  }
  return { wersje: out, problemy: problems };
}

/* ------------------------------- lockfile --------------------------------- */

/**
 * The parts of `pnpm-lock.yaml` this check needs, read line by line.
 *
 * Deliberately not a YAML library: the two sections used here have a fixed,
 * simple shape, and adding a dependency in order to check dependencies is a
 * poor trade. The parser is not trusted blindly — `tests/versions.test.ts`
 * drives it over a fixture whose answers are known, and asserts the real
 * lockfile parses into a plausible shape, so a parser that silently read
 * nothing could not pass as a clean result.
 */
export function parseLockfile(text) {
  const packages = new Map(); // name@version -> { peers: Map<name, range>, optional: Set<name> }
  const snapshots = new Map(); // full key -> { key, provided: Set<string> }
  let section = null;
  let current = null;
  let sub = null;

  for (const raw of text.split('\n')) {
    if (/^packages:\s*$/.test(raw)) {
      section = 'packages';
      current = null;
      continue;
    }
    if (/^snapshots:\s*$/.test(raw)) {
      section = 'snapshots';
      current = null;
      continue;
    }
    if (/^\S/.test(raw)) {
      section = null;
      current = null;
      continue;
    }
    if (section === null || raw.trim() === '') continue;

    /*
     * `key:` and `key: {}` both. The empty form is 274 of the 717 snapshots
     * here, and skipping it would have skipped exactly the interesting case:
     * a package that declares a peer and provides nothing at all.
     */
    const entry = raw.match(/^ {2}'?([^':]+(?:@[^':]+)?)'?:\s*(?:\{\})?\s*$/);
    if (entry && !raw.startsWith('    ')) {
      const id = entry[1];
      current = id;
      sub = null;
      if (section === 'packages') packages.set(id, { peers: new Map(), optional: new Set() });
      else snapshots.set(id, { key: id, provided: new Set() });
      continue;
    }
    if (!current) continue;

    const heading = raw.match(/^ {4}([A-Za-z]+):\s*$/);
    if (heading) {
      sub = heading[1];
      continue;
    }
    const pair = raw.match(/^ {6}'?([^':]+)'?:\s*(.*)$/);
    if (!pair) continue;
    const [, name, value] = pair;
    if (section === 'packages' && sub === 'peerDependencies') {
      packages.get(current).peers.set(name, value.replace(/^['"]|['"]$/g, ''));
    } else if (section === 'packages' && sub === 'peerDependenciesMeta') {
      // `name:` followed by `optional: true` on the next line, indented deeper.
      packages.get(current).pendingOptional = name;
    } else if (section === 'snapshots' && (sub === 'dependencies' || sub === 'optionalDependencies')) {
      snapshots.get(current).provided.add(name);
    }
    if (section === 'packages' && sub === 'peerDependenciesMeta' && /^ {8}optional: true/.test(raw)) {
      packages.get(current).optional.add(packages.get(current).pendingOptional);
    }
  }
  // The `optional: true` line is deeper than the pair matcher above; sweep once.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^ {8}optional: true\s*$/.test(lines[i])) continue;
    const nameLine = lines[i - 1]?.match(/^ {6}'?([^':]+)'?:\s*$/);
    if (!nameLine) continue;
    for (let j = i - 2; j >= 0; j -= 1) {
      const owner = lines[j].match(/^ {2}'?([^':]+(?:@[^':]+)?)'?:\s*$/);
      if (owner && packages.has(owner[1])) {
        packages.get(owner[1]).optional.add(nameLine[1]);
        break;
      }
    }
  }
  return { packages, snapshots };
}

/** `react-dom@19.3.0(react@19.3.0)` → the names inside the parentheses. */
export function peersInKey(key) {
  const start = key.indexOf('(');
  if (start === -1) return new Set();
  const inner = key.slice(start + 1, key.lastIndexOf(')'));
  const names = new Set();
  for (const m of inner.matchAll(/(@?[^()@,]+(?:\/[^()@,]+)?)@/g)) names.add(m[1].replace(/^\(+/, ''));
  return names;
}

/** `react-dom@19.3.0(react@19.3.0)` → `react-dom@19.3.0`. */
export const baseId = (key) => (key.includes('(') ? key.slice(0, key.indexOf('(')) : key);

/**
 * Peer dependencies that nothing provides.
 *
 * A declared, non-optional peer must be reachable from the snapshot that
 * installs the package: either recorded in the key pnpm built for the peer
 * context, or present among its dependencies. An unmet peer is precisely what
 * `strict-peer-dependencies=false` turns from an error into a line of output
 * nobody reads.
 */
export function unmetPeers({ packages, snapshots }) {
  return peerReport({ packages, snapshots }).problemy;
}

/**
 * The same walk, with the number of pairs it actually examined.
 *
 * The count is not decoration: "no unmet peers" is equally true of a lockfile
 * that has none and of a parser that found no peers to look at. The regression
 * asserts a floor on this number, so the second case cannot pass for the first.
 */
export function peerReport({ packages, snapshots }) {
  const problemy = [];
  let sprawdzonychPar = 0;
  for (const [key, snapshot] of snapshots) {
    const pkg = packages.get(baseId(key));
    if (!pkg || pkg.peers.size === 0) continue;
    const inKey = peersInKey(key);
    for (const [peer] of pkg.peers) {
      if (pkg.optional.has(peer)) continue;
      sprawdzonychPar += 1;
      if (inKey.has(peer) || snapshot.provided.has(peer)) continue;
      problemy.push(`${key}: brak peer ${peer} (${pkg.peers.get(peer)})`);
    }
  }
  return { problemy, sprawdzonychPar };
}

/** Installed versions of one package name, from the `packages:` section. */
export function installedVersionsOf(name, { packages }) {
  const versions = new Set();
  for (const id of packages.keys()) {
    const at = id.lastIndexOf('@');
    if (at <= 0) continue;
    if (id.slice(0, at) === name) versions.add(id.slice(at + 1));
  }
  return [...versions].sort();
}

/* ------------------------------- registry --------------------------------- */

/** Latest stable version of a package, from the npm registry. */
export async function latestFromRegistry(name) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`rejestr npm: ${name} → HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body.version !== 'string') throw new Error(`rejestr npm: ${name} bez pola version`);
  return body.version;
}

export function readRecord(path = RECORD) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function ageInDays(record, now = Date.now()) {
  return (now - Date.parse(record.sprawdzono)) / 86_400_000;
}

/**
 * Everything the offline check asserts, as a list of problems.
 *
 * Shared by the script and by `tests/versions.test.ts` so the regression and the
 * acceptance command cannot disagree about what "checked" means.
 */
export function offlineProblems({ repo = REPO, record, lockfileText, now = Date.now() } = {}) {
  const problems = [];
  const { wersje, problemy } = singlePin(pinnedVersions(repo));
  problems.push(...problemy);

  if (sha256(lockfileText) !== record.lockfileSha256) {
    problems.push(
      'rejestr wersji opisuje inny pnpm-lock.yaml niz ten w repozytorium — zaleznosci zmienily sie ' +
        'po ostatnim sprawdzeniu. Uruchom: node scripts/check-versions.mjs --refresh',
    );
  }
  const age = ageInDays(record, now);
  if (age > MAX_AGE_DAYS) {
    problems.push(
      `docs/acceptance/wersje-rejestr.json ma ${Math.round(age)} dni (limit ${MAX_AGE_DAYS}), ` +
        `bo sprawdzono go ${record.sprawdzono?.slice(0, 10)} — twierdzenie „React i TypeScript sa ` +
        'najnowszymi stabilnymi" wygaslo i nikt go od tamtej pory nie potwierdzil. ' +
        'Odswiez: `pnpm check:versions:refresh` (wymaga sieci; pyta rejestr npm i przepisuje ten plik). ' +
        'UWAGA: samo odswiezenie moze NIE wystarczyc — jesli React albo TypeScript zdazyly sie ruszyc, ' +
        'odswiezony zapis pokaze roznice i trzeba bedzie naprawde podniesc wersje w manifestach i ' +
        'lockfile, a potem przejsc regresje. To jest cel tej kontroli, nie jej usterka.',
    );
  }
  for (const name of TRACKED) {
    const recorded = record.najnowszeStabilne?.[name];
    if (!recorded) {
      problems.push(`${name}: brak wpisu w rejestrze wersji`);
      continue;
    }
    if (wersje[name] && recorded.przypiete !== wersje[name]) {
      problems.push(
        `${name}: przypieta ${wersje[name]}, a rejestr opisuje ${recorded.przypiete} — rejestr jest nieaktualny`,
      );
    }
    if (recorded.przypiete !== recorded.wRejestrzeNpm && WYMAGANE_NAJNOWSZE.includes(name)) {
      problems.push(
        `${name}: przypieta ${recorded.przypiete}, a najnowsza stabilna w rejestrze npm to ` +
          `${recorded.wRejestrzeNpm} (sprawdzono ${record.sprawdzono})`,
      );
    }
  }

  const lock = parseLockfile(lockfileText);
  if (lock.packages.size < 200) {
    problems.push(`parser lockfile odczytal tylko ${lock.packages.size} pakietow — to nie jest wynik, to awaria`);
  }
  problems.push(...unmetPeers(lock));
  for (const name of ['react', 'react-dom']) {
    const versions = installedVersionsOf(name, lock);
    if (versions.length > 1) {
      problems.push(`${name} zainstalowany w kilku wersjach naraz: ${versions.join(', ')}`);
    }
  }
  return problems;
}

/* --------------------------------- CLI ------------------------------------ */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const lockfileText = readFileSync(LOCKFILE, 'utf8');
  if (process.argv.includes('--refresh')) {
    const { wersje, problemy } = singlePin(pinnedVersions());
    if (problemy.length) {
      console.error(problemy.map((p) => `  - ${p}`).join('\n'));
      process.exit(1);
    }
    const najnowszeStabilne = {};
    for (const name of TRACKED) {
      const latest = await latestFromRegistry(name);
      najnowszeStabilne[name] = {
        przypiete: wersje[name] ?? null,
        wRejestrzeNpm: latest,
        wymaganaNajnowsza: WYMAGANE_NAJNOWSZE.includes(name),
      };
      console.log(`${name.padEnd(12)} przypieta ${String(wersje[name]).padEnd(10)} rejestr ${latest}`);
    }
    const record = {
      opis:
        'Zapis sprawdzenia w rejestrze npm: czy przypiete wersje sa nadal najnowszymi stabilnymi. ' +
        'Powstaje na zadanie (--refresh), bo wymaga sieci; regresja sprawdza go offline i oblewa, ' +
        'gdy opisuje inny lockfile albo gdy sie zestarzal.',
      sprawdzono: new Date().toISOString(),
      czym: `node scripts/check-versions.mjs --refresh (node ${process.versions.node})`,
      lockfileSha256: sha256(lockfileText),
      maksymalnyWiekDni: MAX_AGE_DAYS,
      najnowszeStabilne,
      uwagaOPeer:
        '.npmrc ma strict-peer-dependencies=false i auto-install-peers=true, wiec instalacja nie ' +
        'przerywa sie na niezgodnosci peer. Dlatego peer sprawdzany jest na lockfile: kazdy ' +
        'zadeklarowany, nieopcjonalny peer musi byc dostarczony w snapshocie, a react i react-dom ' +
        'nie moga byc zainstalowane w dwoch wersjach naraz. Ograniczenie: to sprawdza DOSTARCZENIE ' +
        'peera, nie spelnienie zakresu semver — tego bez biblioteki semver nie da sie uczciwie orzec.',
    };
    writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`\nzapisano ${RECORD}`);
  }

  const record = readRecord();
  const problems = offlineProblems({ record, lockfileText });
  console.log('\n================ WERSJE I ZALEZNOSCI ================');
  console.log(`rejestr sprawdzono: ${record.sprawdzono} (${Math.round(ageInDays(record))} dni temu)`);
  for (const [name, entry] of Object.entries(record.najnowszeStabilne)) {
    console.log(
      `${name.padEnd(12)} przypieta ${String(entry.przypiete).padEnd(10)} rejestr ${entry.wRejestrzeNpm}` +
        (entry.przypiete === entry.wRejestrzeNpm ? '' : '   ← ROZNE'),
    );
  }
  const lock = parseLockfile(lockfileText);
  console.log(`pakietow w lockfile: ${lock.packages.size}, snapshotow: ${lock.snapshots.size}`);
  console.log(problems.length === 0 ? 'bez zastrzezen' : problems.map((p) => `PROBLEM: ${p}`).join('\n'));
  process.exit(problems.length === 0 ? 0 : 1);
}
