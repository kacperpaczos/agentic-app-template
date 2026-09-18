/**
 * Shared machinery for the scripts that handle the local persistent state:
 * `backup-state.mjs`, `migration-rehearsal.mjs`, `restore-state.mjs` and
 * `synthetic-state.mjs`.
 *
 * It exists because those four had drifted into four dialects of the same
 * handful of operations — and the drift was not cosmetic. The argument parser
 * came in two variants, one of which read `--verify` as the *value* of `--out`.
 * `assertNobodyHoldsIt` came in two variants that behaved differently when
 * `fuser` was missing. Worst of all, the "never touch the user's data" check
 * came in three variants, and two of them compared paths for **equality**,
 * which is no protection at all against a path that merely points *inside* the
 * data directory — the case a reviewer reproduced by deleting a directory of
 * user files with a single, exit-0 command.
 *
 * Everything here is written for scripts that **delete and move directories**.
 * That is the reason for the belt and braces: a mistake costs somebody their
 * conversations.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const REPO = resolve(import.meta.dirname, '../..');

/**
 * `better-sqlite3` belongs to `@platform/server`, not to the repository root,
 * and it stays that way: adding it to the root manifest so a script can
 * `import` it would declare a dependency the application does not have.
 */
export const Database = createRequire(
  resolve(REPO, 'packages/platform-server/package.json'),
)('better-sqlite3');

/* ------------------------------ exit contract ----------------------------- */

/**
 * A refusal: the arguments, or the state on disk, mean this script must not do
 * what it was asked to do. Distinct from a crash on purpose — a caller needs to
 * tell "I would not" from "I could not", and a script that reports both the
 * same way cannot be used from another script.
 *
 * Exit codes across all four scripts:
 *   0  done
 *   1  a negative verdict (copy does not verify, rehearsal found problems,
 *      restored state does not match the manifest)
 *   2  refused (unsafe arguments, live data in the way, database in use)
 *   3  refused: the backup is newer than this build (restore only)
 *   4  crashed (a bug here, or the environment broke)
 */
export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'Refusal';
  }
}

export const refuse = (message) => {
  throw new Refusal(message);
};

/**
 * Runs a script body with that contract. Every one of these scripts ends with
 * this, so a thrown `Refusal` can never be reported as a crash, and a crash can
 * never be reported as a verdict.
 */
export function runScript(label, body) {
  try {
    body();
  } catch (err) {
    if (err instanceof Refusal) {
      console.error(`[${label}] ODMAWIAM: ${err.message}`);
      process.exit(2);
    }
    console.error(`[${label}] AWARIA: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(4);
  }
}

/* -------------------------------- arguments ------------------------------- */

/** The kinds a declared flag can have. Each one is exercised by the regression. */
export const FLAG_KINDS = [
  /** Takes a path and writes to it; must refuse a live data directory. */
  'zapis-chroniony',
  /** Takes a path and only reads it, but refuses a live data directory anyway. */
  'odczyt-chroniony',
  /** Takes a path and writes **into** a data directory on purpose. */
  'zapis-docelowy',
  /** Takes a path and only reads it; a live data directory is allowed. */
  'odczyt',
  /** Takes a value that is not a path. */
  'wartosc',
  /** Takes no value at all. */
  'przelacznik',
];

/**
 * Reads the command line **against the script's own declaration**, and refuses
 * anything that is not in it.
 *
 * This is an inversion, and it is the answer to a defect this package produced
 * three times: a path argument that nobody had protected. Every attempt to
 * close it by *looking* for such arguments — comparing paths, then scanning the
 * source for `flag('...')` — was a guard on the shape of the code, and each was
 * walked around: a double-quoted literal, a computed name, a hand-rolled
 * `args.indexOf('--x')`. The shapes are unbounded; the command line is not.
 *
 * So the script no longer discovers its flags — it declares them, and anything
 * else on the command line is refused before the script does any work. A flag
 * that is not declared cannot be passed, whatever the code that would have read
 * it looks like, and `flag('x')` for an undeclared `x` is a programming error
 * rather than a silent `null`.
 *
 * What this does **not** cover, said plainly: a path arriving through an
 * environment variable, a configuration file, or a hard-coded constant. Those
 * are not command-line flags and nothing here sees them.
 *
 * `flag('out')` on `--out --verify X` still returns the fallback rather than
 * the string `"--verify"`.
 *
 * @param argv     usually `process.argv`
 * @param declared the script's `FLAGS` map: `{ name: { kind, why } }`
 */
export function makeArgs(argv, declared) {
  const args = argv.slice(2);
  const known = new Set(Object.keys(declared ?? {}));

  for (const [name, decl] of Object.entries(declared ?? {})) {
    if (!FLAG_KINDS.includes(decl?.kind)) {
      throw new Error(`flaga --${name}: nieznany rodzaj ${decl?.kind}`);
    }
  }

  /*
   * Positional arguments are refused rather than skipped.
   *
   * They used to be skipped, and that was a way in: `backup-state.mjs <ofiara>
   * --data X --out Y` sailed past a parser that only inspected `--tokens`. These
   * scripts take no positional arguments at all, so one on the command line is a
   * mistake in the invocation — and the one thing never to do with a path
   * nobody expected is to ignore it.
   */
  const wartosciFlag = new Set();
  args.forEach((token, i) => {
    if (!token.startsWith('--')) return;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) wartosciFlag.add(i + 1);
  });
  args.forEach((token, i) => {
    if (token.startsWith('--') || wartosciFlag.has(i)) return;
    refuse(
      `argument pozycyjny „${token}" — te skrypty przyjmuja wylacznie flagi.\n` +
        'Jesli mial to byc katalog, podaj go przy wlasciwej fladze.',
    );
  });

  for (const token of args) {
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    if (!known.has(name)) {
      refuse(
        `nieznana flaga --${name}.\n` +
          `Ten skrypt przyjmuje wylacznie: ${[...known].map((f) => `--${f}`).join(', ')}.\n` +
          'Kazda flaga musi byc zadeklarowana w FLAGS razem z rodzajem — inaczej nic nie wiadomo ' +
          'o tym, czy jej sciezka jest chroniona.',
      );
    }
  }

  const assertDeclared = (name) => {
    if (declared && !known.has(name)) {
      // A bug in the script, not in the invocation: the code reads a flag it
      // never declared, so nothing has decided what protects it.
      throw new Error(`flaga --${name} jest czytana, ale nie ma jej w FLAGS`);
    }
  };

  const flag = (name, fallback = null) => {
    assertDeclared(name);
    const i = args.indexOf(`--${name}`);
    if (i < 0) return fallback;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) return fallback;
    return value;
  };

  const has = (name) => {
    assertDeclared(name);
    return args.includes(`--${name}`);
  };

  return { flag, has };
}

/* ------------------------------ path handling ----------------------------- */

/**
 * Absolute, symlink-resolved path — for paths that do not exist yet, too.
 *
 * Resolving matters because every check below compares paths, and a symlink is
 * precisely how a comparison is fooled: `--out link-to-data/files` and
 * `--out data/files` are the same directory and must get the same answer. The
 * deepest existing ancestor is resolved and the missing tail appended, so a
 * target that is about to be created is still judged by where it will really be.
 */
export function realResolve(path) {
  const absolute = resolve(path);
  const missing = [];
  let cursor = absolute;
  for (;;) {
    if (existsSync(cursor)) {
      return missing.length === 0
        ? realpathSync(cursor)
        : join(realpathSync(cursor), ...missing.reverse());
    }
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    missing.push(basename(cursor));
    cursor = parent;
  }
}

/** Written into every directory these scripts create, so they can recognise it later. */
export const SCRATCH_MARKER = '.katalog-roboczy-agentic';

/** Is `inner` the same directory as `outer`, or inside it? */
export const isWithin = (inner, outer) => inner === outer || inner.startsWith(outer + sep);

/** Data directories this installation is configured to use. */
export function liveDataDirs(repo = REPO) {
  const dirs = [resolve(repo, 'data'), process.env.APP_DATA_DIR]
    .filter(Boolean)
    .map((p) => realResolve(p));
  return [...new Set(dirs)];
}

/**
 * The nearest ancestor of `path` (including itself) that holds a
 * `session.secret`, or null.
 *
 * `session.secret` is the tell that a directory is a live data directory: the
 * application writes one, and `backup-state.mjs` deliberately never copies it.
 * Looking only at the top level — which is what two of these scripts used to do
 * — misses every path *inside* a data directory, which is the dangerous shape:
 * `--out <dane>/files` is not equal to `<dane>` and contains no `session.secret`
 * of its own.
 */
export function dataDirAtOrAbove(path) {
  let cursor = realResolve(path);
  for (;;) {
    if (existsSync(join(cursor, 'session.secret')) && !isOurs(cursor)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/**
 * Did these scripts create this directory?
 *
 * The marker outranks the `session.secret` heuristic **for this one directory**,
 * and it has to: the rehearsal boots the application against its working copy,
 * and booting writes a `session.secret` there. Without this, the second run
 * into the same `--out` was refused — the documented command worked once and
 * then told the user their own scratch directory was application data, leaving
 * them to `rm -rf` it by hand, which is the thing all of this exists to avoid.
 *
 * Scoped deliberately: a marker makes *that* directory ours, and nothing else.
 * An ancestor that holds a secret without a marker still refuses, so a scratch
 * directory created inside somebody's data directory is no more allowed than
 * before.
 */
export function isOurs(dir) {
  const marker = join(dir, SCRATCH_MARKER);
  if (!existsSync(marker)) return false;
  /*
   * The marker names the directory it was written for, and only counts there.
   *
   * Without that, the claim travels: `cp -r` of a scratch directory carries the
   * marker into the copy, and a directory that later became somebody's data
   * directory would keep an exemption it was never given. It was observed
   * exactly that way — an evidence run copied a generated fixture, added a
   * `session.secret`, and the backup happily overwrote it, because the copy
   * still carried the original's marker.
   *
   * Comparing the recorded path with where the file actually is makes the
   * marker worthless the moment it is copied or moved, which is the only
   * honest reading of "these scripts created this directory".
   */
  try {
    const recorded = readFileSync(marker, 'utf8')
      .split('\n')
      .find((line) => line.startsWith(MARKER_PATH_PREFIX));
    if (!recorded) return false;
    return realResolve(recorded.slice(MARKER_PATH_PREFIX.length).trim()) === realResolve(dir);
  } catch {
    return false;
  }
}

/**
 * A data directory hidden *below* `path`, within `depth` levels.
 *
 * The other dangerous shape: pointing a script at the **parent** of the data
 * directory. Deleting that takes the data with it, and no comparison against
 * the data directory's own path would notice. Bounded on purpose — this runs
 * before every destructive step and must not walk a home directory.
 */
export function dataDirBelow(path, depth = 3) {
  const root = realResolve(path);
  if (!existsSync(root) || !statSync(root).isDirectory()) return null;
  let level = [root];
  for (let d = 0; d < depth && level.length > 0; d += 1) {
    const next = [];
    for (const dir of level) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      // A directory with hundreds of entries is not a data directory; not
      // descending into it keeps this check cheap.
      if (entries.length > 200) continue;
      for (const entry of entries) {
        if (entry.name === 'session.secret' && entry.isFile() && !isOurs(dir)) return dir;
        if (entry.isDirectory() && !entry.isSymbolicLink()) next.push(join(dir, entry.name));
      }
    }
    level = next;
  }
  return null;
}

/**
 * Refuses any path related to a live data directory — in **either** direction.
 *
 * Both directions, because both are destructive and only one of them was ever
 * checked: a target inside the data directory deletes part of the user's state,
 * a target containing it deletes all of it.
 */
/**
 * @param sprawdzPonizej also refuse a path that *contains* a data directory.
 *   True for anything that deletes or fills a directory — that is the case
 *   where the data below it goes too. False for writing a single file: a report
 *   dropped into a directory that happens to have a data directory two levels
 *   below harms nothing, and refusing it would make `--json ~/raport.json`
 *   fail on most home directories.
 */
export function assertAwayFromLiveData(path, { what = 'Katalog', repo = REPO, sprawdzPonizej = true } = {}) {
  const target = realResolve(path);

  for (const live of liveDataDirs(repo)) {
    if (isWithin(target, live)) {
      refuse(`${what} ${target} lezy w katalogu danych aplikacji ${live}. Nie tkne go.`);
    }
    if (isWithin(live, target)) {
      refuse(`${what} ${target} zawiera katalog danych aplikacji ${live}. Nie tkne go.`);
    }
  }

  const above = dataDirAtOrAbove(target);
  if (above) {
    refuse(
      `${what} ${target} lezy w katalogu danych aplikacji ${above} ` +
        '(rozpoznany po pliku session.secret, ktorego kopia nigdy nie zawiera). Nie tkne go.',
    );
  }

  const below = sprawdzPonizej ? dataDirBelow(target) : null;
  if (below) {
    refuse(
      `${what} ${target} zawiera katalog danych aplikacji ${below} ` +
        '(rozpoznany po pliku session.secret). Nie tkne go.',
    );
  }

  return target;
}

/**
 * Refuses a destination that exists, holds something, and is not ours.
 *
 * For the writers that **overwrite** rather than delete — `backup-state.mjs`
 * writes `app.db` and the file trees into `--out`. That is not less dangerous
 * than deleting: pointed at a live data directory it replaces the user's
 * database with somebody else's and reports success. A destination is
 * acceptable when it does not exist, is empty, or carries one of `ownMarkers`
 * — for a backup that is its own `manifest.json`, so re-running a backup over
 * the previous one keeps working.
 */
export function assertOwnOrEmptyDir(path, { what = 'Katalog docelowy', ownMarkers = [SCRATCH_MARKER] } = {}) {
  const target = realResolve(path);
  if (!existsSync(target)) return target;
  if (!statSync(target).isDirectory()) refuse(`${what} ${target} istnieje i nie jest katalogiem.`);
  if (readdirSync(target).length === 0) return target;
  /*
   * The scratch marker is checked with `isOurs` (path-bound); any other marker
   * — `manifest.json` for a backup — is a structural fact about the directory,
   * not a claim about who made it, so its mere presence is the right test.
   */
  const ours = ownMarkers.some((m) =>
    m === SCRATCH_MARKER ? isOurs(target) : existsSync(join(target, m)),
  );
  if (ours) return target;
  refuse(
    `${what} ${target} istnieje, nie jest pusty i nie zostal utworzony przez te skrypty ` +
      `(nie ma zadnego z: ${ownMarkers.join(', ')}).\n` +
      'Nie nadpisuje cudzego katalogu. Wskaz katalog nieistniejacy, pusty albo wlasna wczesniejsza kopie.',
  );
  return target;
}

const MARKER_PATH_PREFIX = 'sciezka: ';

const markerText = (dir) =>
  'Katalog roboczy skryptow stanu (scripts/synthetic-state.mjs, scripts/migration-rehearsal.mjs).\n' +
  'Zawiera dane SYNTETYCZNE albo kopie robocza. Skrypty kasuja katalog z tym znacznikiem\n' +
  'bez pytania i odmawiaja skasowania katalogu bez niego.\n' +
  'Znacznik liczy sie WYLACZNIE dla sciezki ponizej — skopiowany gdzie indziej nic nie znaczy.\n' +
  `${MARKER_PATH_PREFIX}${dir}\n`;

/**
 * Empties a directory these scripts are about to fill — and refuses to empty
 * one they did not create.
 *
 * The third protection, and the one that holds when the other two are fooled.
 * `rmSync(target, { recursive: true, force: true })` is the same call whether
 * the target is a scratch directory or somebody's photographs; the only honest
 * way to tell them apart is to require evidence that *these scripts* made it.
 * A directory that does not exist, or exists and is empty, is fine. A directory
 * with contents must carry the marker.
 */
export function prepareScratchDir(path, { what = 'Katalog roboczy', repo = REPO } = {}) {
  const target = approveTarget(path, { what, repo });

  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) {
      refuse(`${what} ${target} istnieje i nie jest katalogiem.`);
    }
    const entries = readdirSync(target);
    /*
     * `isOurs`, not `existsSync(marker)`. The path check landed in `isOurs`
     * when the copied-marker hole was closed, but the two places that let a
     * marker **authorise a deletion** still looked only at whether the file was
     * there — so `cp -r` of a scratch directory still handed the copy the right
     * to be wiped. A reviewer deleted a directory of user files that way, exit
     * 0. The rule now reads the same everywhere: a marker counts only for the
     * path written inside it.
     */
    if (entries.length > 0 && !isOurs(target)) {
      const znacznik = join(target, SCRATCH_MARKER);
      refuse(
        `${what} ${target} istnieje, nie jest pusty i nie zostal utworzony przez te skrypty.\n` +
          (existsSync(znacznik)
            ? `Znacznik ${SCRATCH_MARKER} jest na miejscu, ale zapisano w nim inna sciezke ` +
              '(katalog zostal skopiowany albo przeniesiony), wiec nic nie mowi o TYM katalogu.'
            : `Brak znacznika ${SCRATCH_MARKER}.`) +
          '\nNie kasuje cudzego katalogu. Wskaz katalog nieistniejacy albo pusty.',
      );
    }
    usun(target, { recursive: true, force: true });
  }

  utworzKatalog(target, { recursive: true });
  zapisz(join(target, SCRATCH_MARKER), markerText(target));
  return target;
}

/**
 * Checks a directory that is about to be **moved aside** (not deleted).
 *
 * `restore-state.mjs` renames whatever `--data` names. Nothing is lost that
 * way, but renaming an arbitrary directory because of a typo is still a mess
 * somebody has to undo, so a non-empty target has to look like a data
 * directory before it is touched.
 */
export function assertLooksLikeDataDir(path, { what = 'Katalog docelowy' } = {}) {
  const target = realResolve(path);
  if (!existsSync(target)) return target;
  if (!statSync(target).isDirectory()) refuse(`${what} ${target} istnieje i nie jest katalogiem.`);
  if (readdirSync(target).length === 0) return target;

  /*
   * The third place that reads the marker, and the third that had to learn the
   * same rule: a marker counts only for the path recorded inside it. Here it is
   * one of several signs that a directory is a data directory, but a copied
   * marker is no sign of anything at all.
   */
  const marks = ['app.db', 'session.secret', 'files', 'workspaces'];
  if (!marks.some((m) => existsSync(join(target, m))) && !isOurs(target)) {
    refuse(
      `${what} ${target} istnieje, nie jest pusty i nie wyglada na katalog danych aplikacji ` +
        `(nie ma zadnego z: ${marks.join(', ')}).\n` +
        'Nie przenosze cudzego katalogu. Sprawdz sciezke --data.',
    );
  }
  return target;
}

/* ------------------------- the destructive operations ---------------------- */

/**
 * Directories this process has approved, and the only places under which these
 * scripts are allowed to delete, move, overwrite or create anything.
 *
 * **Why the check moved here.** For five rounds the guard stood next to the
 * *argument*: first comparing `--out` with `--data`, then comparing paths for
 * equality, then scanning the source for `flag('...')`, then validating the
 * command line against a declaration. Every round a reviewer found another way
 * to reach the operation from the side — a double-quoted literal, a flag
 * declared under an exempt kind, a **positional** argument that the parser
 * skipped. The shapes an argument can take are unbounded, so a guard on the
 * argument can always be walked around.
 *
 * The operation is not unbounded. `rmSync` deletes whatever path it is given,
 * whether that path arrived as a flag, positionally, from the environment, from
 * a configuration file or from a constant — and if the check happens *at the
 * call*, none of those routes matter. That is the whole idea: a path is not
 * trusted because of how it was read, but because some earlier step looked at
 * it and said so.
 */
const zatwierdzone = new Set();

/**
 * Approves a directory these scripts may work inside.
 *
 * **What approval means, exactly:** this directory is not application data.
 * That is the whole claim. It does **not** mean the directory is empty, is
 * ours, or is safe to overwrite — an ordinary directory of somebody's files
 * passes this check, and a reviewer duly approved one and deleted inside it.
 *
 * The second question — *may I destroy what is in there?* — belongs to the
 * caller, which answers it with `prepareScratchDir` (must be empty or carry our
 * marker) or `assertOwnOrEmptyDir` (must be empty or a previous backup of its
 * own). Keeping the two apart is deliberate: they have different answers for
 * the same directory depending on what is about to happen to it. It is written
 * here because a scope that is only implied is the same thing as a scope nobody
 * decided.
 */
export function approveTarget(path, { what = 'Katalog', repo = REPO, sprawdzPonizej = true } = {}) {
  const target = assertAwayFromLiveData(path, { what, repo, sprawdzPonizej });
  zatwierdzone.add(target);
  return target;
}

/**
 * Approves the target of a **restore**, which is a data directory on purpose.
 *
 * The one case where writing into application data is the point, so it gets the
 * opposite check — a non-empty target has to look like a data directory — and
 * then the same approval as everything else.
 */
export function approveRestoreTarget(path, { what = 'Katalog docelowy' } = {}) {
  const target = assertLooksLikeDataDir(path, { what });
  zatwierdzone.add(target);
  return target;
}

/**
 * For a directory these scripts have just created for themselves — in practice
 * the result of `mkdtempSync`.
 *
 * It used to approve whatever it was handed, which made it a door straight into
 * the gate: `approveOwnTemp(<katalog danych>)` followed by `usun(<plik>)` and
 * the file was gone. Being the narrowest of the three approvals is no reason to
 * be the only unchecked one, so it now demands what is true of a directory
 * created a moment ago and of nothing else: it exists, it is a directory, it is
 * **empty**, and it is not application data.
 */
export function approveOwnTemp(path, { what = 'Katalog tymczasowy' } = {}) {
  const target = realResolve(path);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    refuse(`${what} ${target} nie istnieje albo nie jest katalogiem.`);
  }
  if (readdirSync(target).length > 0) {
    refuse(
      `${what} ${target} nie jest pusty, wiec nie zostal przed chwila utworzony przez ten skrypt.\n` +
        'Ta furtka jest wylacznie dla katalogow z mkdtemp; do reszty sluzy approveTarget.',
    );
  }
  assertAwayFromLiveData(target, { what });
  zatwierdzone.add(target);
  return target;
}

/** Is this path inside something approved in this run? */
function jestZatwierdzona(path) {
  const target = realResolve(path);
  for (const root of zatwierdzone) if (isWithin(target, root)) return true;
  return false;
}

function assertApproved(path, operacja) {
  if (jestZatwierdzona(path)) return realResolve(path);
  const target = realResolve(path);
  refuse(
    `${operacja}: ${target} lezy poza katalogami zatwierdzonymi w tym przebiegu.\n` +
      'Kazda operacja kasujaca, przenoszaca i nadpisujaca w tych skryptach przechodzi przez to ' +
      'sprawdzenie w chwili wykonania — niezaleznie od tego, skad wziela sie sciezka.',
  );
}

/* The guarded operations. Nothing in these scripts calls the raw ones. */
export const usun = (path, options) => (assertApproved(path, 'usuniecie'), rmSync(path, options));
export const utworzKatalog = (path, options) => (
  assertApproved(path, 'utworzenie katalogu'), mkdirSync(path, options)
);
export const zapisz = (path, data) => (assertApproved(path, 'zapis'), writeFileSync(path, data));
export const kopiujPlik = (from, to) => (assertApproved(to, 'kopiowanie do'), copyFileSync(from, to));
export const kopiujDrzewo = (from, to, options) => (
  assertApproved(to, 'kopiowanie drzewa do'), cpSync(from, to, options)
);
export const przenies = (from, to) => {
  assertApproved(from, 'przeniesienie');
  assertApproved(to, 'przeniesienie do');
  renameSync(from, to);
};

/* --------------------------------- sqlite --------------------------------- */

export const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const DB_PARTS = ['app.db', 'app.db-wal', 'app.db-shm'];
/** Recreated by SQLite on any connection, read-only included. */
const SIDE_FILES = ['app.db-wal', 'app.db-shm'];

/**
 * Row census of every table: counts, a content digest, and the column list.
 *
 * Counts alone would miss content that changed without changing shape, so each
 * table also gets a digest over its rows. The column list comes from the schema
 * rather than from the rows, because an empty table still has columns — and
 * "which columns existed before the migration" is exactly what the rehearsal
 * needs to tell an added column from changed data.
 *
 * @param restrict `{ table: [column, ...] }`. Where given, a second digest is
 *   computed over only those columns, which is how a widened table can be
 *   judged on its old values.
 * @param identity also collect the rows a user would notice missing, by id.
 */
export function census(dbFile, { restrict = {}, identity = false } = {}) {
  const db = new Database(dbFile, { readonly: true });
  try {
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((r) => r.name);

    const digestOf = (rows, keep) =>
      createHash('sha256')
        .update(
          rows
            .map((r) =>
              JSON.stringify(
                Object.keys(r)
                  .filter((k) => !keep || keep.includes(k))
                  .sort()
                  .map((k) => [k, r[k]]),
              ),
            )
            .sort()
            .join('\n'),
        )
        .digest('hex');

    const counts = {};
    const digests = {};
    const columns = {};
    const restrictedDigests = {};
    for (const t of tables) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
      columns[t] = db
        .prepare(`PRAGMA table_info("${t}")`)
        .all()
        .map((c) => c.name)
        .sort();
      const rows = db.prepare(`SELECT * FROM "${t}"`).all();
      digests[t] = digestOf(rows, null);
      if (restrict[t]) restrictedDigests[t] = digestOf(rows, restrict[t]);
    }

    const result = {
      tables,
      counts,
      digests,
      columns,
      restrictedDigests,
      migrations: tables.includes('schema_migrations')
        ? db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((r) => r.id)
        : [],
      integrity: db.pragma('integrity_check', { simple: true }),
    };

    if (identity) {
      result.conversationIds = tables.includes('conversations')
        ? db.prepare('SELECT id FROM conversations ORDER BY id').all().map((r) => r.id)
        : [];
      result.userMessages = tables.includes('messages')
        ? db
            .prepare(`SELECT id, conversation_id, content, seq FROM messages WHERE role='user' ORDER BY id`)
            .all()
        : [];
      result.cardIds = tables.includes('canvas_cards')
        ? db.prepare('SELECT id, space_id, spec FROM canvas_cards ORDER BY id').all()
        : [];
      result.fileIds = tables.includes('files')
        ? db.prepare('SELECT id FROM files ORDER BY id').all().map((r) => r.id)
        : [];
      result.artifactIds = tables.includes('artifacts')
        ? db.prepare('SELECT id FROM artifacts ORDER BY id').all().map((r) => r.id)
        : [];
    }
    return result;
  } finally {
    db.close();
  }
}

/**
 * Refuses to copy or overwrite a database some process may be writing to.
 *
 * One behaviour, in one place. There were two versions of this, and they
 * disagreed about the case that matters most: when `fuser` is missing, the
 * check cannot run at all. Silence there is the worst option, because the
 * output then reads exactly like a checked copy — so it says so, loudly, once.
 */
export function assertNobodyHoldsIt(dataDir, { label } = { label: 'stan' }) {
  const dir = resolve(dataDir);
  for (const part of DB_PARTS) {
    const path = join(dir, part);
    if (!existsSync(path)) continue;
    try {
      const holders = execFileSync('fuser', [path], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      if (holders) {
        refuse(
          `Plik ${path} jest otwarty przez proces(y): ${holders}.\n` +
            'Zatrzymaj aplikacje — praca na bazie zapisywanej w tle daje niespojny wynik.',
        );
      }
    } catch (err) {
      if (err instanceof Refusal) throw err;
      // `fuser` exits non-zero when nothing holds the file: that is the good case.
      if (err && err.code === 'ENOENT') {
        console.warn(
          `[${label}] UWAGA: nie znaleziono narzedzia \`fuser\` — NIE sprawdzono, czy baza jest ` +
            'otwarta przez jakis proces. Upewnij sie sam, ze aplikacja jest zatrzymana.',
        );
        return;
      }
    }
  }
}

/**
 * Drops the empty log and the shared-memory index.
 *
 * Every `census` connection recreates them, so this belongs after the last
 * read. It leaves a backup as a single `app.db`, which is what makes a restore
 * one copy instead of three — and removes the chance of someone restoring the
 * main file without its log.
 */
/**
 * The SQLite side files present in a directory right now.
 *
 * Taken **before** opening a database there, so that whatever appears
 * afterwards can be told apart from whatever was already there. Reading a
 * database — even read-only — makes SQLite create `app.db-shm` and an empty
 * `app.db-wal`, which is how these scripts came to leave litter in directories
 * they had promised not to touch.
 */
export function sideFilesPresent(dir) {
  return new Set(SIDE_FILES.filter((f) => existsSync(resolve(dir, f))));
}

/**
 * Removes the side files **this process created** in `dir`, and only those.
 *
 * Deliberately outside the approval gate, and this is the one place where that
 * is defensible: a file that did not exist when we arrived and exists now was
 * made by our own read, so deleting it cannot lose anybody's data. A log that
 * was already there is left alone — it may hold committed transactions, and
 * that is exactly the thing never to delete on a hunch.
 *
 * The alternative was to leave everything and weaken the message instead. That
 * would mean `--verify` telling the user their copy is untouched while having
 * added files to it, which is the failure this whole package is about.
 */
export function removeSideFilesWeCreated(dir, before) {
  for (const f of SIDE_FILES) {
    const path = resolve(dir, f);
    if (existsSync(path) && !before.has(f)) rmSync(path);
  }
}

export function tidy(dir) {
  for (const stray of SIDE_FILES) {
    const path = resolve(dir, stray);
    /*
     * Only inside a directory this run approved. A write-ahead log holds
     * committed transactions that are not yet in the main file, so deleting one
     * somewhere unexpected is data loss — exactly the thing this module exists
     * to prevent. Where the directory was not approved, the stray files are
     * left alone: an extra file is a nuisance, a missing log is not.
     */
    if (existsSync(path) && jestZatwierdzona(path)) usun(path);
  }
}

/** SHA-256 of every file in a tree, keyed by path relative to it. */
export function fingerprint(dir) {
  const root = resolve(dir);
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[full.slice(root.length + 1)] = sha256File(full);
    }
  };
  walk(root);
  return out;
}
