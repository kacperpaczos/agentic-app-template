import { renameSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { AppError } from '@platform/contracts';

/**
 * The destructive filesystem operations of the server, and the check they all
 * pass through.
 *
 * **Why the check is here and not next to each caller.** Every path these
 * functions are given arrives from somewhere else: a workspace directory read
 * back out of `agent_runs`, a `rel_path` read out of `files`, a temporary name
 * built from a filename the user chose. A guard placed next to one caller
 * inspects *that argument*, and the shapes an argument can take are unbounded —
 * a row written by an older version, a path that looks relative, a name with a
 * separator in it. The operation is not unbounded: `rmSync` deletes whatever it
 * is handed, so the question "is this path inside a directory this server owns"
 * is asked **at the call**, whatever route the path took to get there.
 *
 * The same reasoning closed a sister package's scripts (`scripts/lib/state-tools.mjs`).
 * This is the server-side counterpart, deliberately smaller: the roots are the
 * two directories the platform creates for itself, the files store and the run
 * workspaces, and nothing else is ever a legal target.
 */

/** The one thing a caller has to state: which directory the path must be inside. */
export interface ManagedRoot {
  /** Absolute path of the directory this operation is confined to. */
  root: string;
  /** What it is, for the refusal message. */
  what: string;
}

/**
 * Resolves `path` and refuses it unless it is strictly inside `root`.
 *
 * Strictly: the root itself is not a legal target either. Deleting the files
 * directory is not a smaller version of deleting a file in it.
 */
export function assertInsideManagedRoot(path: string, { root, what }: ManagedRoot): string {
  const target = resolve(path);
  const base = resolve(root);
  if (target === base || !target.startsWith(base + sep)) {
    throw new AppError(
      'internal',
      `Odmowa operacji na ${target}: sciezka lezy poza katalogiem ${what} (${base}). ` +
        'Kazda operacja kasujaca w serwerze sprawdza to w chwili wykonania, niezaleznie od tego, ' +
        'skad wziela sie sciezka.',
      { target, root: base },
    );
  }
  return target;
}

/** Deletes one file the server manages. */
export function removeManagedFile(path: string, root: ManagedRoot): void {
  rmSync(assertInsideManagedRoot(path, root), { force: true });
}

/** Deletes one directory tree the server manages (a run workspace). */
export function removeManagedTree(path: string, root: ManagedRoot): void {
  rmSync(assertInsideManagedRoot(path, root), { recursive: true, force: true });
}

/**
 * Renames inside one managed root — the publication step of an atomic write.
 *
 * Both ends are checked: a rename is a delete of whatever sat at the target.
 */
export function renameWithinManagedRoot(from: string, to: string, root: ManagedRoot): void {
  renameSync(assertInsideManagedRoot(from, root), assertInsideManagedRoot(to, root));
}
