import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realResolveFrom } from '../packages/platform-server/src/util/real-path.ts';
import { realResolve as mjsRealResolve } from '../scripts/lib/state-tools.mjs';

/**
 * DRYF PIĄTEJ KOPII: `packages/platform-server/src/util/real-path.ts` ma
 * walkera rundy 6 (fail-closed: `UnresolvablePathError` przy `..` po członie
 * nieistniejącym i przy członach za istniejącym plikiem; `readlink` dla
 * zerwanych dowiązań), a jego bliźniak w `scripts/lib/state-tools.mjs` —
 * algorytm RUNDY 4 (flaga `existsSoFar`, ogon składany leksykalnie).
 *
 * `tests/isolation-paths.test.ts` ("zgadza sie z kopia w scripts/lib/") nie
 * podaje obu implementacjom żadnego z tych kształtów, więc równoważność
 * potwierdza tylko tam, gdzie oba się zgadzają.
 */
const katalogi: string[] = [];
afterEach(() => {
  for (const d of katalogi.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('dryf: real-path.ts kontra scripts/lib/state-tools.mjs', () => {
  it('.. po członie nieistniejącym: TS rzuca, mjs składa leksykalnie', () => {
    const base = mkdtempSync(join(tmpdir(), 'dryf-'));
    katalogi.push(base);
    let tsRzut: unknown = null;
    let tsWynik: string | null = null;
    try {
      tsWynik = realResolveFrom(base, 'nie-ma/../cel.txt');
    } catch (err) {
      tsRzut = err;
    }
    expect((tsRzut as Error)?.name, 'TS ma rzucać UnresolvablePathError').toBe('UnresolvablePathError');
    expect(tsWynik).toBeNull();

    // mjs: bez rzutu, wynik leksykalny — INNA odpowiedź na to samo wejście.
    const surowa = resolve(base, 'nie-ma/../cel.txt');
    expect(mjsRealResolve(surowa), 'mjs złożył leksykalnie (dryf względem TS)').toBe(
      join(base, 'cel.txt'),
    );
  });

  it('zerwane dowiązanie + "..": TS rzuca, mjs odpowiada ścieżką wewnątrz bez rzutu', () => {
    const base = mkdtempSync(join(tmpdir(), 'dryf2-'));
    katalogi.push(base);
    mkdirSync(join(base, 'wewnatrz'), { recursive: true });
    symlinkSync('brak-dir', join(base, 'wewnatrz', 'link')); // cel NIE istnieje

    let tsRzut: unknown = null;
    try {
      realResolveFrom(base, 'wewnatrz/link/../x.txt');
    } catch (err) {
      tsRzut = err;
    }
    expect((tsRzut as Error)?.name).toBe('UnresolvablePathError');

    const surowa = resolve(base, 'wewnatrz/link/../x.txt');
    expect(mjsRealResolve(surowa), 'mjs bez rzutu, ścieżka wewnątrz').toBe(join(base, 'wewnatrz', 'x.txt'));
  });
});
