import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * L12.12 — the trial harness, put on trial.
 *
 * Test kontraktu lub logiki.
 *
 * The lesson this file exists for is one this programme paid for: a package
 * built a safety mechanism that patched the wrong binding and did nothing at
 * all, and it surfaced only because somebody ran a trial *on the fuse*. A
 * harness that reports "every fix is guarded" is worth exactly as much as the
 * proof that it can say the opposite.
 *
 * So four things are checked here, on a real temporary git repository with a
 * real file and a stand-in test runner:
 *
 *  1. a mutation that a test catches is reported `wykryte`;
 *  2. a mutation that the test does **not** catch is reported `NIEWYKRYTE` —
 *     the finding, not a pass;
 *  3. a register entry whose pattern no longer matches the code is an error,
 *     not a silent skip that would count the fix as guarded;
 *  4. the file comes back byte for byte, including when the runner throws, and
 *     the harness refuses to start on a dirty tree.
 *
 * And separately: the register itself must match the code it describes — every
 * pattern present, exactly once, in the file it names.
 */

const REPO = resolve(import.meta.dirname, '..');

interface Trial {
  id: string;
  plik: string;
  szukaj: string;
  zamien: string;
  test: string;
  nazwaTestu?: string;
  oczekiwanyKomunikat?: string;
  wRegresji?: boolean;
  powodPominiecia?: string;
  kryterium?: string;
  naprawa?: string;
}
interface TrialResult {
  id: string;
  wynik: string;
  powod?: string;
  kodWyjsciaTestu?: number | null;
}
interface Harness {
  WYKRYTE: string;
  NIEWYKRYTE: string;
  POMINIETE: string;
  readRegistry: (path?: string) => { proby: Trial[] };
  assertCleanTree: (repo?: string, what?: string) => void;
  applyMutation: (trial: Trial, repo?: string) => { path: string; original: string };
  restore: (applied: { path: string; original: string }) => void;
  runTrials: (input: {
    trials: Trial[];
    repo?: string;
    runner?: (t: Trial, repo: string) => { code: number | null; output: string };
    log?: (line: string) => void;
  }) => Promise<TrialResult[]>;
}

const harness = (await import(resolve(REPO, 'scripts/detection-trials.mjs'))) as unknown as Harness;

const made: string[] = [];
afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A miniature repository: one committed source file, one git history. */
function repoWithFile(content: string): { repo: string; file: string } {
  const repo = mkdtempSync(resolve(tmpdir(), 'agentic-proby-'));
  made.push(repo);
  mkdirSync(resolve(repo, 'src'), { recursive: true });
  writeFileSync(resolve(repo, 'src/plik.ts'), content);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 'proba', GIT_AUTHOR_EMAIL: 'proba@example.invalid',
             GIT_COMMITTER_NAME: 'proba', GIT_COMMITTER_EMAIL: 'proba@example.invalid' },
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'baza');
  return { repo, file: 'src/plik.ts' };
}

const trial = (over: Partial<Trial> = {}): Trial => ({
  id: 'proba',
  plik: 'src/plik.ts',
  szukaj: 'const strzezone = true;',
  zamien: 'const strzezone = false;',
  test: 'tests/nic.test.ts',
  ...over,
});

describe('harness prob zdolnosci wykrycia', () => {
  it('mutacja wykryta przez test jest raportowana jako wykryta', async () => {
    const { repo } = repoWithFile('const strzezone = true;\n');
    const results = await harness.runTrials({
      trials: [trial()],
      repo,
      // The test noticed: non-zero exit.
      runner: () => ({ code: 1, output: 'Tests  1 failed | 0 passed' }),
    });
    expect(results[0]!.wynik).toBe(harness.WYKRYTE);
    // Restored byte for byte.
    expect(readFileSync(resolve(repo, 'src/plik.ts'), 'utf8')).toBe('const strzezone = true;\n');
  });

  it('mutacja, ktorej test NIE wykryl, jest znaleziskiem, nie zaliczeniem', async () => {
    const { repo } = repoWithFile('const strzezone = true;\n');
    const results = await harness.runTrials({
      trials: [trial()],
      repo,
      // The test passed on broken code — the whole point of the harness.
      runner: () => ({ code: 0, output: 'Tests  3 passed' }),
    });
    expect(results[0]!.wynik).toBe(harness.NIEWYKRYTE);
    expect(results[0]!.powod).toContain('test PRZESZEDL na wadliwym wariancie');
    expect(readFileSync(resolve(repo, 'src/plik.ts'), 'utf8')).toBe('const strzezone = true;\n');
  });

  it('test, ktory oblal z innego powodu niz oczekiwany, tez jest znaleziskiem', async () => {
    const { repo } = repoWithFile('const strzezone = true;\n');
    const results = await harness.runTrials({
      trials: [trial({ oczekiwanyKomunikat: 'Tests.*failed' })],
      repo,
      // A crash before the assertions ran is not the test catching the defect.
      runner: () => ({ code: 1, output: 'Error: Cannot find module' }),
    });
    expect(results[0]!.wynik).toBe(harness.NIEWYKRYTE);
    expect(results[0]!.powod).toContain('nie z oczekiwanego powodu');
  });

  it('wzorzec, ktory nie pasuje albo pasuje dwa razy, jest bledem — nie cichym zaliczeniem', () => {
    const { repo } = repoWithFile('const strzezone = true;\nconst strzezone2 = true;\n');
    expect(() => harness.applyMutation(trial({ szukaj: 'const czegoNieMa = 1;' }), repo)).toThrow(
      /wystepuje 0 razy/,
    );
    expect(() => harness.applyMutation(trial({ szukaj: 'const strzezone' }), repo)).toThrow(
      /wystepuje 2 razy/,
    );
    expect(() => harness.applyMutation(trial({ zamien: 'const strzezone = true;' }), repo)).toThrow(
      /identyczny z oryginalem/,
    );
    // Nothing was written in any of the three refusals.
    expect(readFileSync(resolve(repo, 'src/plik.ts'), 'utf8')).toBe(
      'const strzezone = true;\nconst strzezone2 = true;\n',
    );
  });

  it('plik wraca takze wtedy, gdy przebieg testu wybuchnie', async () => {
    const { repo } = repoWithFile('const strzezone = true;\n');
    await expect(
      harness.runTrials({
        trials: [trial()],
        repo,
        runner: () => {
          throw new Error('runner padl');
        },
      }),
    ).rejects.toThrow(/runner padl/);
    expect(readFileSync(resolve(repo, 'src/plik.ts'), 'utf8')).toBe('const strzezone = true;\n');
  });

  it('proba oznaczona jako poza regresja jest pomijana z podaniem powodu', async () => {
    const { repo } = repoWithFile('const strzezone = true;\n');
    const results = await harness.runTrials({
      trials: [trial({ wRegresji: false, powodPominiecia: 'wymaga przegladarki' })],
      repo,
      runner: () => {
        throw new Error('nie powinno sie uruchomic');
      },
    });
    expect(results[0]!.wynik).toBe(harness.POMINIETE);
    expect(results[0]!.powod).toBe('wymaga przegladarki');
  });

  it('brudne drzewo zatrzymuje proby, zanim cokolwiek zostanie zmienione', () => {
    const { repo } = repoWithFile('const strzezone = true;\n');
    expect(() => harness.assertCleanTree(repo)).not.toThrow();
    writeFileSync(resolve(repo, 'src/plik.ts'), 'praca w toku\n');
    expect(() => harness.assertCleanTree(repo)).toThrow(/drzewo robocze nie jest czyste/);
  });
});

describe('rejestr prob zgadza sie z kodem', () => {
  const registry = harness.readRegistry();

  it('kazdy wzorzec wystepuje dokladnie raz w pliku, ktory nazywa', () => {
    const problems: string[] = [];
    for (const t of registry.proby) {
      const path = resolve(REPO, t.plik);
      if (!existsSync(path)) {
        problems.push(`${t.id}: brak pliku ${t.plik}`);
        continue;
      }
      const occurrences = readFileSync(path, 'utf8').split(t.szukaj).length - 1;
      if (occurrences !== 1) problems.push(`${t.id}: wzorzec wystepuje ${occurrences} razy w ${t.plik}`);
      if (!existsSync(resolve(REPO, t.test))) problems.push(`${t.id}: brak testu ${t.test}`);
    }
    /*
     * This is the guard that keeps the register honest between runs: a fix
     * rewritten elsewhere silently turns its trial into "pattern not found",
     * and a harness that skipped it would keep reporting the fix as guarded.
     */
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('rejestr obejmuje naprawy wymienione w kryterium L12.12', () => {
    const ids = registry.proby.map((t) => t.id);
    for (const required of [
      'D-1-szuflada-nad-canvasem',
      'D-2-projekcja-segmentu',
      'N-3-kolejka-rozmowy',
      'abort-na-cancel-w-tle',
      'detektor-strumienia',
      'guard-izolacji-dowiazanie',
    ]) {
      expect(ids, `brak proby ${required}`).toContain(required);
    }
    // Each trial says which criterion it guards and what the fix is.
    for (const t of registry.proby) {
      expect(t.kryterium, t.id).toMatch(/^L\d+\.\d+$/);
      expect((t.naprawa ?? '').length, t.id).toBeGreaterThan(30);
    }
  });
});
