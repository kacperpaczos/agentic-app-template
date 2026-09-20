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
 * **Whose process is answering on that port?** The second hole this closes:
 * a script that polls `/api/health` and reports "started" on the first answer
 * reports success about *somebody else's* instance whenever that instance
 * already held the port. So the port is probed **before** anything is spawned
 * (`przed --port`), and after the health poll succeeds the answering process
 * is verified against the script's own pidfile — alive, running this
 * repository's server, and the process `/proc` shows holding the LISTEN
 * socket (`po`). An unconfirmed "ours" is refused, not assumed.
 *
 * Usage:
 *
 *   node scripts/lib/server-guard.mjs przed --katalog <dir> [--port <port>] [--etykieta <label>] [--repo <root>]
 *   node scripts/lib/server-guard.mjs po --pid <pid> --port <port> [--cmd <fragment>]
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
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
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

/**
 * Does something accept a TCP connection on this port?
 *
 * TCP, not `/api/health` — the same reasoning as `e2e/support/port-probe.ts`:
 * a hung or half-started server answers no HTTP and still owns the port. What
 * matters before a boot is occupancy, not identity.
 */
export function portZajety(port, host = '127.0.0.1', terminMs = 700) {
  return new Promise((rozstrzygnij) => {
    const s = net.connect({ port, host });
    let odezwal = false;
    s.setTimeout(terminMs);
    s.on('connect', () => {
      odezwal = true;
      s.destroy();
    });
    s.on('timeout', () => s.destroy());
    s.on('error', () => {});
    s.on('close', () => rozstrzygnij(odezwal));
  });
}

/**
 * The pid holding a LISTEN socket on `port`, read from `/proc` — the answer
 * "which of the live processes is it?" that a curl to the port cannot give.
 *
 * `null` means it could not be established (no `/proc`, nothing matching).
 * A caller that needs the owner treats `null` as a refusal, not as a clean
 * result — a check that cannot run must not report success.
 */
export function pidNasluchujacyNaPorcie(port) {
  if (!existsSync('/proc')) return null;
  const inody = [];
  for (const plik of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let tresc;
    try {
      tresc = readFileSync(plik, 'utf8');
    } catch {
      continue;
    }
    for (const wiersz of tresc.split('\n').slice(1)) {
      const kolumny = wiersz.trim().split(/\s+/);
      // local_address, state (0A = LISTEN), inode — the columns /proc documents.
      if (kolumny.length < 10 || kolumny[3] !== '0A') continue;
      if (parseInt(kolumny[1].split(':')[1], 16) === port) inody.push(kolumny[9]);
    }
  }
  if (inody.length === 0) return null;
  for (const wpis of readdirSync('/proc')) {
    if (!/^\d+$/.test(wpis)) continue;
    let uchwyty;
    try {
      uchwyty = readdirSync(`/proc/${wpis}/fd`);
    } catch {
      continue; // another user's process, or one that ended mid-scan
    }
    for (const uchwyt of uchwyty) {
      let cel;
      try {
        cel = readlinkSync(`/proc/${wpis}/fd/${uchwyt}`);
      } catch {
        continue; // the descriptor closed while reading
      }
      const dopasowanie = /^socket:\[(\d+)\]$/.exec(cel);
      if (dopasowanie && inody.includes(dopasowanie[1])) return Number(wpis);
    }
  }
  return null;
}

/** The one command line fragment every one of these scripts boots. */
export const DOMYSLNY_FRAGMENT_CMDLINE = 'apps/server/dist/server.js';

const zywy = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

const cmdline = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    return null;
  }
};

/**
 * Confirms that the process answering on `port` is *ours* — the pid from the
 * script's own pidfile, running the expected command — not somebody else's
 * instance that happened to hold the port.
 *
 * **The failure this prevents.** `dev-server.sh` used to poll `/api/health`
 * and report "started" on the first answer. When somebody else's instance
 * already held the port, the answer was theirs; the script reported success,
 * wrote a pidfile for a dead process, and the operator believed a backend was
 * running that did not exist.
 *
 * Every condition is checked, not assumed: the pid must be alive, its command
 * line must name the server this repository boots, and `/proc` must show that
 * this very pid holds the LISTEN socket on the port. `null` from the owner
 * question is a refusal — an unconfirmed "ours" is exactly the old defect.
 */
export function problemWlasnegoProcesu({ pid, port, fragment = DOMYSLNY_FRAGMENT_CMDLINE }) {
  const pidN = Number(pid);
  if (!Number.isInteger(pidN) || pidN <= 0) {
    return `pidfile zawiera "${pid}", co nie jest numerem procesu.`;
  }
  if (!zywy(pidN)) {
    return `proces ${pidN} z pidfile nie zyje, a port ${port} odpowiada — to nie jest proces ` +
      'tego skryptu. Zadnego "started" nie bedzie; pidfile nie wskazuje wlasciciela portu.';
  }
  const linia = cmdline(pidN);
  if (linia === null || !linia.includes(fragment)) {
    return `proces ${pidN} z pidfile nie uruchamia ${fragment} — to nie start tego skryptu.`;
  }
  const wlasciciel = pidNasluchujacyNaPorcie(Number(port));
  if (wlasciciel === null) {
    return `nie udalo sie potwierdzic w /proc, ze port ${port} trzyma proces ${pidN}. ` +
      'Potwierdzenie wlasnego procesu musi byc czytelne, nie domniemane.';
  }
  if (wlasciciel !== pidN) {
    return `port ${port} trzyma proces ${wlasciciel}, a pidfile wskazuje ${pidN} — ` +
      'odpowiada cudza instancja, nie proces uruchomiony przez ten skrypt.';
  }
  return null;
}

const uzycie = () => {
  console.error(
    'usage: server-guard.mjs przed --katalog <dir> [--port <port>] [--etykieta <label>] [--repo <root>]\n' +
      '       server-guard.mjs po --pid <pid> --port <port> [--cmd <fragment>]',
  );
};

export async function run(argv) {
  const polecenie = argv[0];
  if (polecenie !== 'przed' && polecenie !== 'po') {
    uzycie();
    return 2;
  }
  const wartosc = (nazwa) => {
    const i = argv.indexOf(`--${nazwa}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (polecenie === 'po') {
    const pid = wartosc('pid');
    const port = wartosc('port');
    if (!pid || !port || String(pid).startsWith('--') || String(port).startsWith('--')) {
      uzycie();
      return 2;
    }
    const problem = problemWlasnegoProcesu({
      pid,
      port,
      fragment: wartosc('cmd') ?? DOMYSLNY_FRAGMENT_CMDLINE,
    });
    if (problem) {
      console.error(`[server-guard] ODMAWIAM: ${problem}`);
      return 2;
    }
    console.log(`[server-guard] ok: port ${port} trzyma wlasny proces ${pid}`);
    return 0;
  }

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

  const surowyPort = wartosc('port');
  if (surowyPort !== undefined) {
    const port = Number(surowyPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`[server-guard] ODMAWIAM: port "${surowyPort}" nie jest numerem portu 1-65535.`);
      return 2;
    }
    if (await portZajety(port)) {
      const wlasciciel = pidNasluchujacyNaPorcie(port);
      console.error(
        `[server-guard] ODMAWIAM: port ${port} jest juz zajety` +
          (wlasciciel ? ` (pid ${wlasciciel})` : '') +
          '. Start wbrew temu skonczylby sie podlaczeniem pod cudzy proces i falszywym ' +
          '"started", jak dawniej. Zatrzymaj TEN proces po jego pid albo wskaz inny port.',
      );
      return 2;
    }
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
