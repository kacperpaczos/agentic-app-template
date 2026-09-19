import { lstatSync, realpathSync } from 'node:fs';
import { cwd } from 'node:process';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

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
  return realResolveFrom(cwd(), path);
}

/**
 * To samo, ale względem podanego katalogu bazowego.
 *
 * Istnieje, bo strażnik narzędzi plikowych agenta pyta zawsze „gdzie wypadnie
 * ta ścieżka **względem katalogu roboczego uruchomienia**", a nie względem
 * `process.cwd()`. Przez jakiś czas miał własną kopię tego przejścia; jedna
 * kopia mniej to jedno miejsce, w którym można naprawić wadę raz.
 *
 * ## Dlaczego komponent po komponencie, a nie `resolve()` na początku
 *
 * Bo `path.resolve()` zwija `..` **leksykalnie**, a jądro rozwiązuje ścieżkę w
 * odwrotnej kolejności: najpierw podąża za dowiązaniem, potem cofa się o `..`.
 * Dla `/a/link/../b`, gdzie `link` wskazuje poza drzewo, odpowiedź leksykalna
 * brzmi `/a/b`, a `open()` trafia gdzie indziej. Poprzednia wersja tej funkcji
 * zaczynała od `resolve(path)` i właśnie dlatego odpowiadała o **tekście**,
 * mimo że cały jej sens to odpowiadać o **systemie plików**.
 *
 * Wada przeżyła trzy recenzje przez czytanie i dwie poprawki w sąsiednim
 * module; znalazła ją dopiero próba. Stąd `tests/isolation-paths.test.ts`
 * atakuje ten kształt wprost, a nie tylko porównuje dwie implementacje.
 *
 * Kontrakt zachowany: ścieżka, której jeszcze nie ma, jest oceniana przez
 * najbliższego istniejącego przodka — po to ta funkcja powstała.
 */
export function realResolveFrom(base: string, candidate: string): string {
  const absolute = isAbsolute(candidate);
  const root = absolute ? parse(candidate).root : '';
  let current = (() => {
    const start = absolute ? root : resolve(base);
    try {
      return realpathSync(start);
    } catch {
      return start;
    }
  })();

  const rest = absolute ? candidate.slice(root.length) : candidate;
  let existsSoFar = true;

  for (const part of rest.split(/[/\\]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      // Cofnięcie od ścieżki JUŻ ROZWIĄZANEJ — w tym jednym miejscu mieści się
      // cała różnica między tą funkcją a jej poprzedniczką.
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    if (!existsSoFar) {
      current = next;
      continue;
    }
    try {
      current = realpathSync(next);
    } catch {
      // Nie istnieje albo nie da się przejść: dalej nie ma czego rozwijać.
      existsSoFar = false;
      current = next;
    }
  }
  return current;
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
