#!/usr/bin/env node
/**
 * Pre-start guard for the shell scripts that boot a server instance
 * (`scripts/dev-server.sh`, `scripts/audit-server.sh`,
 * `scripts/closure-server.sh`).
 *
 * **The hole this closes.** The server-side isolation guard
 * (`assertTestInstanceIsIsolated`, `packages/platform-server/src/config.ts`)
 * constrains only *labelled* instances: it returns immediately when
 * `APP_INSTANCE_LABEL` is unset, because an unlabelled process is the user's
 * own application and must stay free to run wherever its owner points it.
 * All three scripts above boot exactly such an unlabelled process, and they
 * took `APP_DATA_DIR` on faith — pointed at a directory holding live data,
 * they started a server on it. The ruling for this closure package: the repair
 * belongs to the *script layer*, not to `loadConfig`, which must keep letting
 * the user's own application start.
 *
 * What this helper answers before the first process is spawned:
 *
 * **Whose data is in that directory?** `session.secret` is the tell that a
 * directory belongs to an instance of this application — the same tell
 * `scripts/lib/state-tools.mjs` uses. The file's *existence* is the signal;
 * its contents are never read, hashed or printed, here or anywhere else. The
 * check runs in all three dangerous directions:
 *
 *  - a `session.secret` **at or above** the target — the target sits inside a
 *    data directory (no exemption: pointing a boot into somebody's data
 *    directory is refused even for a labelled test instance);
 *  - a `session.secret` **in** the target — booting a server onto an existing
 *    instance's data;
 *  - a `session.secret` **below** the target, within a bounded depth — the
 *    target contains a data directory.
 *
 * Two exemptions exist for the target's own secret, and only for that:
 *
 *  - the pair the server-side guard already enforces for the label: the
 *    instance carries `agenticapp-test` **and** the directory is named like a
 *    test directory (`.e2e` prefix). A test-labelled boot cannot reach any
 *    other directory anyway (`config.ts` refuses it), so the pair means the
 *    operator declared a test directory;
 *  - this helper's own marker, written after a boot passed the check: booting
 *    *writes* a `session.secret`, so without the marker the second start on
 *    the same directory was refused — the documented command worked once and
 *    then called the operator's own directory live data. The marker is
 *    path-bound (it names the directory it was written for, and counts only
 *    there), exactly the lesson `state-tools.mjs` recorded after a copied
 *    marker authorised a deletion. One directory stays refused even when
 *    marked: the repository's own `data/` — the path where real data lives,
 *    from which the exemption must not grow back.
 *
 * A refusal prints what was detected and never the contents of any file.
 *
 * Usage:
 *
 *   node scripts/lib/server-guard.mjs przed --katalog <dir> [--etykieta <label>] [--repo <root>]
 *
 * Exit codes follow the repo's script contract (`state-tools.mjs`):
 * 0 passed, 2 refused, 4 crashed.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(import.meta.dirname, '../..');

/** Marker written after a boot passed the check; path-bound, like `state-tools`. */
export const ZNACZNIK = '.agentic-serwer-guard';
const PREFIKS_SCIEZKI = 'sciezka: ';

/**
 * The one label that means "a test instance" in the sense of `config.ts`:
 * only `agenticapp-test` is constrained server-side to an `.e2e` directory
 * inside the repository, so only that pair may waive the secret check.
 */
export const ETYKIETY_TESTOWE = ['agenticapp-test'];

/** How deep below the target a data directory is still recognised. */
const GLEBOKIA_PONIZEJ = 3;

const jestDowiazaniem = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** The directory a path really points at, or the path itself when it is missing. */
const realnaSciezka = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

const sekret = (dir) => existsSync(join(dir, 'session.secret'));

/**
 * The nearest ancestor of `dir` that holds a `session.secret` and is not one
 * of ours — the "target sits inside a data directory" direction.
 */
export function sekretPowyzej(dir) {
  let cursor = dirname(realnaSciezka(dir));
  for (;;) {
    if (sekret(cursor) && !czyNasz(cursor)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/**
 * The directory holding a `session.secret` at `dir` itself or within `depth`
 * levels below it — the "target contains a data directory" direction.
 *
 * Bounded on purpose (the same bound `state-tools.mjs` uses): this runs before
 * every boot and must not walk a home directory.
 */
export function sekretWKataloguLubPonizej(dir, depth = GLEBOKIA_PONIZEJ) {
  if (sekret(dir)) return dir;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  let level = [dir];
  for (let d = 0; d < depth && level.length > 0; d += 1) {
    const next = [];
    for (const katalog of level) {
      let entries;
      try {
        entries = readdirSync(katalog, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name === 'session.secret' && entry.isFile()) return katalog;
        if (entry.isDirectory() && !entry.isSymbolicLink()) next.push(join(katalog, entry.name));
      }
    }
    level = next;
  }
  return null;
}

/**
 * Did a previous boot of these scripts create this directory?
 *
 * The marker names the directory it was written for and counts only there: a
 * copied or moved marker is worthless, because the claim must never travel
 * (`state-tools.mjs` observed exactly that failure with a copied marker).
 */
export function czyNasz(dir) {
  const marker = join(dir, ZNACZNIK);
  if (!existsSync(marker)) return false;
  try {
    const zapisana = readFileSync(marker, 'utf8')
      .split('\n')
      .find((line) => line.startsWith(PREFIKS_SCIEZKI));
    if (!zapisana) return false;
    return realnaSciezka(zapisana.slice(PREFIKS_SCIEZKI.length).trim()) === realnaSciezka(dir);
  } catch {
    return false;
  }
}

const trescZnacznika = (dir) =>
  'Katalog startu instancji skryptow weryfikacyjnych (scripts/dev-server.sh, audit-server.sh,\n' +
  'closure-server.sh). Te skrypty uruchomily tu serwer, wiec wlasny session.secret tej instancji\n' +
  'nie oznacza cudzych danych. Jesli wskazales tu dane swojej wlasnej aplikacji, usun ten plik.\n' +
  'Znacznik liczy sie WYLACZNIE dla sciezki ponizej — skopiowany gdzie indziej nic nie znaczy.\n' +
  `${PREFIKS_SCIEZKI}${realnaSciezka(dir)}\n`;

/** Records the boot so the next start on the same directory is not refused. */
export function zapiszZnacznik(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ZNACZNIK), trescZnacznika(dir));
}

/**
 * The refusal message for booting into `sciezka`, or `null` when the boot may
 * proceed. Never reads or prints the contents of any file it looks at.
 */
export function problemKatalogu(sciezka, { etykieta = null, repo = REPO } = {}) {
  const abs = resolve(sciezka);

  /*
   * A symbolic link is refused outright, not followed: the harness boots and
   * the scripts *write* into this directory, and no guard should rest on where
   * a link happens to resolve today (the same rule `isolation.ts` applies to
   * directories the tests delete).
   */
  if (jestDowiazaniem(abs)) {
    return (
      `katalog danych ${abs} jest dowiazaniem symbolicznym (wskazuje ${realnaSciezka(abs)}). ` +
      'Skrypt uruchamia serwer w prawdziwym katalogu — wskaz katalog, a nie dowiazanie.'
    );
  }

  const real = realnaSciezka(abs);

  // Direction one: the target sits inside somebody's data directory.
  const powyzej = sekretPowyzej(real);
  if (powyzej) {
    return (
      `katalog danych ${abs} lezy wewnatrz katalogu danych aplikacji ${powyzej} ` +
      '(rozpoznany po pliku session.secret; tresc plikow nie byla czytana ani drukowana). ' +
      'Start w srodku cudzych danych nie jest dozwolony nawet dla instancji z etykieta testowa. ' +
      'Wskaz osobny katalog poza katalogiem danych aplikacji.'
    );
  }

  if (!existsSync(real)) return null; // a fresh start: nothing to recognise
  if (!statSync(real).isDirectory()) {
    return `katalog danych ${abs} istnieje i nie jest katalogiem.`;
  }

  // Direction two and three: the target is, or contains, a data directory.
  const sekretDir = sekretWKataloguLubPonizej(real);
  if (!sekretDir) return null;

  const wyjatekTestowy =
    ETYKIETY_TESTOWE.includes(etykieta) && basename(real).startsWith('.e2e');
  if (wyjatekTestowy) return null;

  /*
   * Our own previous boot. The marker exempts the directory it names — except
   * the repository's default `data/`, where the user's real data lives and
   * where a marker from an old verification boot must not keep the guard open.
   */
  const domyslnyKatalogAplikacji = real === realnaSciezka(resolve(repo, 'data'));
  if (czyNasz(real) && !domyslnyKatalogAplikacji) return null;

  if (domyslnyKatalogAplikacji) {
    return (
      `katalog danych ${real} to domyslny katalog aplikacji i zawiera dane istniejacej instancji ` +
      `(plik session.secret w ${sekretDir}; tresc plikow nie byla czytana ani drukowana). ` +
      'Ten skrypt uruchamia instancje weryfikacyjna bez etykiety, a taka omija straz `config.ts` — ' +
      'wiec warstwa skryptowa odmawia startu na zywych danych. Wlasna aplikacje uruchamiaj przez ' +
      '`pnpm start`; ten skrypt skieruj na swiezy katalog (DEV_DATA=<katalog>).'
    );
  }

  return (
    `katalog danych ${abs} zawiera dane istniejacej instancji aplikacji ` +
    `(plik session.secret w ${sekretDir}; tresc plikow nie byla czytana ani drukowana). ` +
    'To moze byc katalog danych uzytkownika — start serwera na zywych danych jest odmawiany, ' +
    'zanim cokolwiek zostanie uruchomione. Wskaz katalog nieistniejacy, pusty, albo testowy ' +
    '(etykieta agenticapp-test i nazwa z prefiksem .e2e).'
  );
}

/* ------------------------------- command line ----------------------------- */

const uzycie = () => {
  console.error(
    'usage: server-guard.mjs przed --katalog <dir> [--etykieta <label>] [--repo <root>]',
  );
};

export async function run(argv) {
  const polecenie = argv[0];
  if (polecenie !== 'przed') {
    uzycie();
    return 2;
  }
  const wartosc = (nazwa) => {
    const i = argv.indexOf(`--${nazwa}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const katalog = wartosc('katalog');
  if (!katalog || katalog.startsWith('--')) {
    uzycie();
    return 2;
  }
  const problem = problemKatalogu(katalog, {
    etykieta: wartosc('etykieta') ?? null,
    repo: wartosc('repo') ?? REPO,
  });
  if (problem) {
    console.error(`[server-guard] ODMAWIAM: ${problem}`);
    return 2;
  }
  zapiszZnacznik(katalog);
  console.log(`[server-guard] ok: ${realnaSciezka(resolve(katalog))} bez cech zywych danych`);
  return 0;
}

/* Run only when invoked directly, not when imported by the regression. */
const wywolanyBezposrednio =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (wywolanyBezposrednio) {
  try {
    process.exit(await run(process.argv.slice(2)));
  } catch (err) {
    console.error(`[server-guard] AWARIA: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(4);
  }
}
