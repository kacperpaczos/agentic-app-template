import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestIsolationError } from './isolation.ts';

/**
 * Is anything listening on a port this run is about to take over?
 *
 * **The failure this prevents.** Both places that prepare a test database do
 * the same two things: delete the data directory, then start a server on a
 * reserved port. Neither asked whether a process was already there. A scripted
 * server orphaned by an interrupted run is exactly that process — it holds the
 * port *and* has the directory open — so the preparation deleted the database
 * out from under a live process, the new server could not bind, and the
 * suite's own identity check then accepted the survivor, because the label
 * `agenticapp-test` is the same for every test instance ever started. The run
 * looked fine and was measuring a stale instance on a deleted database.
 *
 * The answer is a refusal, never a kill: this repository does not end processes
 * it did not start, and matching them by name is how a previous version of the
 * cleanup killed the user's own instance. The message names the port and what
 * to do.
 *
 * **Why a child process.** The question has to be answered *before* `rmSync`,
 * and that call site is synchronous and shared by two dozen specs;
 * `net.connect` is not. A tiny `node -e` probe answers synchronously without
 * dragging an async signature through every `beforeAll` in the suite, and
 * without depending on `ss`, `lsof` or `/proc`, which differ per system.
 *
 * Kryteria: L1.9.
 */

/** How long the probe waits for a connection before calling the port free. */
const PROBE_TIMEOUT_MS = 700;

/**
 * True when a TCP connection to `port` succeeds.
 *
 * TCP, not `/api/health`: a hung or half-started server answers no HTTP and
 * still owns the port and the directory. What matters here is occupancy, not
 * identity — identity is a separate question, asked by `assertIsolatedInstance`
 * of whatever ends up answering.
 */
export function portInUse(port: number, host = '127.0.0.1'): boolean {
  const probe = [
    "const net=require('node:net');",
    `const s=net.connect({port:${port},host:${JSON.stringify(host)}});`,
    `s.setTimeout(${PROBE_TIMEOUT_MS});`,
    "s.on('connect',()=>{s.destroy();process.exit(10);});",
    "s.on('timeout',()=>{s.destroy();process.exit(0);});",
    "s.on('error',()=>{process.exit(0);});",
  ].join('');
  const result = spawnSync(process.execPath, ['-e', probe], {
    timeout: PROBE_TIMEOUT_MS + 4_000,
    stdio: 'ignore',
  });
  return result.status === 10;
}

/**
 * Is any process of this user holding a file inside `dir`?
 *
 * Three answers, not two: `true` somebody has it open, `false` nobody does,
 * `null` **it could not be established** — on a system without `/proc` this
 * cannot be asked at all, and a check that cannot run must say so rather than
 * report a clean result. The criterion says "no setup deletes the database
 * under a running process", and a process can hold this directory while
 * listening on a different port than the one this run reserved, so the port is
 * not the whole question.
 *
 * Only this user's processes are visible, which is exactly the case that
 * matters: the orphan is one the harness itself started.
 */
export function directoryInUse(dir: string): boolean | null {
  if (!existsSync('/proc')) return null;
  const target = resolve(dir);
  let looked = 0;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let handles: string[];
    try {
      handles = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue; // another user's process, or one that ended mid-scan
    }
    looked += 1;
    for (const handle of handles) {
      try {
        const path = readlinkSync(`/proc/${entry}/fd/${handle}`);
        if (path === target || path.startsWith(`${target}/`)) return true;
      } catch {
        /* the descriptor closed while we were reading it */
      }
    }
  }
  // Nothing found, and nothing could be looked at: that is not "free".
  return looked === 0 ? null : false;
}

/**
 * Refuses to continue when the port a run is about to use is taken.
 *
 * Called before the data directory is deleted, not after: the whole point is
 * that nothing destructive happens while somebody else's process is alive.
 */
export function assertPortFree(port: number, what: string): void {
  if (!portInUse(port)) return;
  throw new TestIsolationError(
    `${what}: port ${port} jest juz zajety przez dzialajacy proces. ` +
      'Najprawdopodobniej to serwer scenariuszowy osierocony po przerwanym przebiegu — ' +
      'trzyma otwarta baze w katalogu, ktory ten przebieg wlasnie mialby skasowac, ' +
      'a jego etykieta jest taka sama jak nowego, wiec kontrola tozsamosci by go przyjela. ' +
      'Zatrzymaj TEN proces samodzielnie (po jego pid, nie po nazwie) i uruchom przebieg ponownie.',
  );
}

/**
 * Refuses to delete a data directory that a live process still has open.
 *
 * The second half of the same question. A refusal only when the answer is a
 * definite `true`: `null` means the check could not run, and a check that
 * cannot run must not block a legitimate run either.
 */
export function assertDirectoryFree(dir: string, what: string): void {
  if (directoryInUse(dir) !== true) return;
  throw new TestIsolationError(
    `${what}: katalog ${dir} jest otwarty przez dzialajacy proces (widoczne w /proc). ` +
      'Skasowanie go teraz wyjeloby baze spod tego procesu. Zatrzymaj go samodzielnie, po jego pid.',
  );
}
