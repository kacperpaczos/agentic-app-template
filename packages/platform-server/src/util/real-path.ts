import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * Path comparison that answers a question about the filesystem, not about text.
 *
 * **The class of defect.** Every guard in this repository that decides "may
 * this be deleted / written / used as a test directory" ends in a comparison of
 * two paths. `path.resolve` flattens `..` and makes a path absolute, and that
 * is *all* it does — a symlink is invisible to it. So a directory named
 * `.e2e-data` that is a link to the user's `data/`, or an `APP_DATA_DIR`
 * pointing at such a link, passes a lexical check word for word while the
 * `open()` that follows lands somewhere else entirely. The check says one place
 * and the operation goes to another.
 *
 * Four places in this repository resolve a path before deciding, which is why
 * the resolution lives in one module now: the file tools of the agent
 * (`agent/permissions.ts`), the test-isolation guard of the harness
 * (`e2e/support/isolation.ts`), the same guard inside the server
 * (`config.ts`) and the server's own destructive operations
 * (`util/managed-fs.ts`). The maintenance scripts
 * (`scripts/lib/state-tools.mjs`) keep a fifth copy only because they are plain
 * `.mjs` run by node without the TypeScript pipeline;
 * `tests/isolation-paths.test.ts` asserts the two implementations answer
 * identically on the same inputs, so they cannot drift.
 *
 * Kryteria: L1.11.
 */

/**
 * Absolute, symlink-resolved path — including for a path that does not exist
 * yet.
 *
 * `realpathSync` throws on a missing path, which is the normal case for a
 * directory about to be created, so the nearest existing ancestor is resolved
 * and the missing tail appended. An existing link anywhere along the way is
 * followed, and a not-yet-created leaf is judged by where it would really land.
 */
export function realResolve(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    if (existsSync(cursor)) {
      try {
        return missing.length === 0
          ? realpathSync(cursor)
          : join(realpathSync(cursor), ...[...missing].reverse());
      } catch {
        // A broken link or a directory we may not traverse: fall back to the
        // lexical answer rather than crash. The caller's other checks still run.
        return absolute;
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) return absolute;
    missing.push(basename(cursor));
    cursor = parent;
  }
}

/** True when `inner` is `outer` itself or sits inside it. Both must be real paths. */
export function isWithin(inner: string, outer: string): boolean {
  return inner === outer || inner.startsWith(outer.replace(/[/\\]+$/, '') + sep);
}

/**
 * Whether the path itself is a symbolic link.
 *
 * Asked separately from {@link realResolve} because the two answer different
 * questions and both matter: *where does this really point* and *is this a link
 * at all*. A test directory that is a link is refused outright even when its
 * target happens to be harmless — the harness deletes that directory, and
 * "delete follows the link or removes it" is a detail no guard should depend
 * on.
 */
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
