import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * L1.2 — the pinned versions, checked rather than remembered.
 *
 * Test kontraktu lub logiki, offline.
 *
 * What it can and cannot do is worth stating plainly, because the criterion is
 * about the world outside this repository. The regression cannot ask the npm
 * registry — a suite that needs the network is a suite that fails on a train —
 * so the online answer is **recorded** by `node scripts/check-versions.mjs
 * --refresh`, and what runs here is everything that keeps that recording
 * honest:
 *
 *  - it must describe *this* dependency set (the sha256 of `pnpm-lock.yaml`);
 *  - it must not have expired (180 days);
 *  - the pinned React, React-DOM and TypeScript must equal what it recorded as
 *    the latest stable;
 *  - and the lockfile itself must have no unmet peer dependency and no second
 *    copy of React — the failure `.npmrc`'s `strict-peer-dependencies=false`
 *    turns from an error into a line of output nobody reads.
 *
 * Bump a dependency without re-running the refresh and the hash stops matching:
 * the record says so instead of quietly describing last month's tree.
 */

const REPO = resolve(import.meta.dirname, '..');

interface Lockfile {
  packages: Map<string, { peers: Map<string, string>; optional: Set<string> }>;
  snapshots: Map<string, { key: string; provided: Set<string> }>;
}
interface Checker {
  MAX_AGE_DAYS: number;
  WYMAGANE_NAJNOWSZE: string[];
  OBSERWOWANE: string[];
  RECORD: string;
  LOCKFILE: string;
  sha256: (text: string) => string;
  pinnedVersions: (repo?: string) => Record<string, Array<{ plik: string; wersja: string }>>;
  singlePin: (pins: Record<string, Array<{ plik: string; wersja: string }>>) => {
    wersje: Record<string, string>;
    problemy: string[];
  };
  parseLockfile: (text: string) => Lockfile;
  peerReport: (lock: Lockfile) => { problemy: string[]; sprawdzonychPar: number };
  installedVersionsOf: (name: string, lock: Lockfile) => string[];
  readRecord: (path?: string) => Record<string, never>;
  ageInDays: (record: unknown, now?: number) => number;
  offlineProblems: (input: {
    repo?: string;
    record: unknown;
    lockfileText: string;
    now?: number;
  }) => string[];
}

const checker = (await import(resolve(REPO, 'scripts/check-versions.mjs'))) as unknown as Checker;

const lockfileText = readFileSync(resolve(REPO, 'pnpm-lock.yaml'), 'utf8');
const record = checker.readRecord() as unknown as {
  sprawdzono: string;
  lockfileSha256: string;
  najnowszeStabilne: Record<string, { przypiete: string; wRejestrzeNpm: string; wymaganaNajnowsza: boolean }>;
};

/** A miniature lockfile with the three shapes that matter. */
const FIXTURE = `lockfileVersion: '9.0'

packages:

  ok-pkg@1.0.0:
    resolution: {integrity: sha512-aaa}
    peerDependencies:
      react: ^19.0.0

  bez-peera@2.0.0:
    resolution: {integrity: sha512-bbb}
    peerDependencies:
      react: ^19.0.0

  opcjonalny@3.0.0:
    resolution: {integrity: sha512-ccc}
    peerDependencies:
      typescript: '*'
    peerDependenciesMeta:
      typescript:
        optional: true

  react@19.3.0:
    resolution: {integrity: sha512-ddd}

snapshots:

  ok-pkg@1.0.0(react@19.3.0):
    dependencies:
      react: 19.3.0

  bez-peera@2.0.0: {}

  opcjonalny@3.0.0: {}

  react@19.3.0: {}
`;

describe('parser lockfile', () => {
  const lock = checker.parseLockfile(FIXTURE);

  it('czyta pakiety, peery, peery opcjonalne i snapshoty puste', () => {
    expect([...lock.packages.keys()].sort()).toEqual([
      'bez-peera@2.0.0',
      'ok-pkg@1.0.0',
      'opcjonalny@3.0.0',
      'react@19.3.0',
    ]);
    // `key: {}` is a snapshot too — and it is the interesting one.
    expect(lock.snapshots.has('bez-peera@2.0.0')).toBe(true);
    expect(lock.packages.get('ok-pkg@1.0.0')!.peers.get('react')).toBe('^19.0.0');
    expect(lock.packages.get('opcjonalny@3.0.0')!.optional.has('typescript')).toBe(true);
  });

  it('kontrola pozytywna: brakujacy peer JEST wykrywany, opcjonalny nie', () => {
    /*
     * The assertion that makes the clean result on the real lockfile mean
     * something. "No unmet peers" is equally true of a healthy tree and of a
     * check that looks at nothing.
     */
    const report = checker.peerReport(lock);
    expect(report.problemy).toEqual(['bez-peera@2.0.0: brak peer react (^19.0.0)']);
    // Two pairs examined: the satisfied one and the missing one. The optional
    // peer is deliberately not counted.
    expect(report.sprawdzonychPar).toBe(2);
  });
});

describe('lockfile repozytorium', () => {
  const lock = checker.parseLockfile(lockfileText);

  it('parser widzi caly plik, a nie jego kawalek', () => {
    expect(lock.packages.size).toBeGreaterThan(200);
    // Every package has a snapshot; a shortfall means the parser skipped a form.
    expect(lock.snapshots.size).toBe(lock.packages.size);
    expect(lock.packages.get('react-dom@19.3.0')?.peers.get('react')).toBe('^19.3.0');
  });

  it('kazdy zadeklarowany peer jest dostarczony', () => {
    const report = checker.peerReport(lock);
    expect(report.sprawdzonychPar, 'sprawdzono podejrzanie malo par peer').toBeGreaterThan(100);
    expect(report.problemy, report.problemy.join('\n')).toEqual([]);
  });

  it('react i react-dom sa zainstalowane w jednej wersji', () => {
    expect(checker.installedVersionsOf('react', lock)).toEqual(['19.3.0']);
    expect(checker.installedVersionsOf('react-dom', lock)).toEqual(['19.3.0']);
  });
});

describe('rejestr wersji', () => {
  it('opisuje ten lockfile, nie wczorajszy', () => {
    expect(record.lockfileSha256).toBe(checker.sha256(lockfileText));
  });

  it('nie wygasl', () => {
    const age = checker.ageInDays(record);
    expect(age, `rejestr ma ${Math.round(age)} dni`).toBeLessThan(checker.MAX_AGE_DAYS);
  });

  it('React i TypeScript sa najnowszymi stabilnymi wedlug zapisanego sprawdzenia', () => {
    /*
     * Zapis musi obejmowac DOKLADNIE sledzony zbior. Wczesniej stalo tu
     * `expect(entry.wymaganaNajnowsza).toBe(true)` dla nazw branych z tej samej
     * listy, ktora to pole wypelnia — asercja, ktora nie mogla oblac. Ta moze:
     * pakiet usuniety z zapisu albo dopisany do niego bez odswiezenia oblewa.
     */
    expect(Object.keys(record.najnowszeStabilne).sort()).toEqual(
      [...checker.WYMAGANE_NAJNOWSZE, ...checker.OBSERWOWANE].sort(),
    );
    for (const name of checker.WYMAGANE_NAJNOWSZE) {
      const entry = record.najnowszeStabilne[name]!;
      expect(entry.przypiete, `${name} przypieta`).toBe(entry.wRejestrzeNpm);
    }
    // Pinned identically in every manifest that names them.
    const { wersje, problemy } = checker.singlePin(checker.pinnedVersions());
    expect(problemy, problemy.join('\n')).toEqual([]);
    expect(wersje.react).toBe(record.najnowszeStabilne.react!.przypiete);
  });

  it('roznica na pakiecie obserwowanym jest zapisana, ale nie jest awaria', () => {
    /*
     * Honest by construction: at the time of writing `hono` is 4.13.7 here and
     * 4.13.8 in the registry. The criterion is about React and TypeScript, so
     * this is recorded and reported, not turned into a red regression that
     * somebody would switch off along with the part that matters.
     */
    for (const name of checker.OBSERWOWANE) {
      expect(record.najnowszeStabilne[name]!.wymaganaNajnowsza).toBe(false);
    }
    expect(checker.offlineProblems({ record, lockfileText })).toEqual([]);
  });
});

describe('kontrola: sprawdzenie potrafi oblac', () => {
  it('zmieniony lockfile uniewaznia rejestr', () => {
    const problems = checker.offlineProblems({
      record,
      lockfileText: `${lockfileText}\n# inna zawartosc\n`,
    });
    expect(problems.join('\n')).toContain('opisuje inny pnpm-lock.yaml');
  });

  it('przeterminowany rejestr jest wykryty', () => {
    const problems = checker.offlineProblems({
      record,
      lockfileText,
      now: Date.parse(record.sprawdzono) + (checker.MAX_AGE_DAYS + 1) * 86_400_000,
    });
    expect(problems.join('\n')).toContain('wygaslo');
  });

  it('przypieta wersja rozna od najnowszej stabilnej jest wykryta', () => {
    const stale = {
      ...record,
      najnowszeStabilne: {
        ...record.najnowszeStabilne,
        react: { przypiete: '19.3.0', wRejestrzeNpm: '20.0.0', wymaganaNajnowsza: true },
      },
    };
    const problems = checker.offlineProblems({ record: stale, lockfileText });
    expect(problems.join('\n')).toContain('najnowsza stabilna w rejestrze npm to 20.0.0');
  });
});
