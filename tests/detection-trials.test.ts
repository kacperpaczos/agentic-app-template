import { execFileSync, spawn } from 'node:child_process';
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
  BLAD_PROBY: string;
  ranTests: (output: string) => number;
  childEnv: () => Record<string, string | undefined>;
  currentMutation: () => { path: string; original: string } | null;
  installRescue: () => void;
  readRegistry: (path?: string) => { proby: Trial[] };
  assertCleanTree: (repo?: string, what?: string) => void;
  applyMutation: (trial: Trial, repo?: string) => { path: string; original: string };
  restore: (applied: { path: string; original: string }) => void;
  runTrials: (input: {
    trials: Trial[];
    repo?: string;
    runner?: (t: Trial, repo: string, phase: 'baseline' | 'mutated') => { code: number | null; output: string };
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
      // Passes on clean code, notices the mutation: that is a trial.
      runner: (_t, _r, phase) =>
        phase === 'baseline'
          ? { code: 0, output: 'Tests  4 passed (4)' }
          : { code: 1, output: 'Tests  1 failed | 3 passed (4)' },
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
      // Passes on clean code and *still* passes on broken code — the finding.
      runner: () => ({ code: 0, output: 'Tests  3 passed (3)' }),
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
      runner: (_t, _r, phase) =>
        phase === 'baseline'
          ? { code: 0, output: 'Tests  4 passed (4)' }
          : { code: 1, output: 'Error: Cannot find module' },
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
        runner: (_t, _r, phase) => {
          if (phase === 'baseline') return { code: 0, output: 'Tests  4 passed (4)' };
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

  it('proba, ktorej filtr nie dopasowal zadnego testu, to BLAD-PROBY, nie zaliczenie', async () => {
    /*
     * The harness's own finding, locked down. A trial named its test with a
     * string vitest reads as a regular expression; nothing matched, eleven
     * tests were skipped, the exit code was 0 — and the harness called it "the
     * test passed on broken code". A run of nothing is not a run.
     */
    const { repo } = repoWithFile('const strzezone = true;\n');
    const results = await harness.runTrials({
      trials: [trial({ nazwaTestu: 'nazwa, ktora nic nie pasuje' })],
      repo,
      runner: () => ({ code: 0, output: 'Tests  11 skipped (11)' }),
    });
    expect(results[0]!.wynik).toBe(harness.BLAD_PROBY);
    expect(results[0]!.powod).toContain('ZADEN test');
    expect(readFileSync(resolve(repo, 'src/plik.ts'), 'utf8')).toBe('const strzezone = true;\n');
  });

  it('test oblewajacy juz na czystym kodzie nie moze niczego wykazac', async () => {
    const { repo } = repoWithFile('const strzezone = true;\n');
    const results = await harness.runTrials({
      trials: [trial()],
      repo,
      runner: () => ({ code: 1, output: 'Tests  1 failed | 2 passed (3)' }),
    });
    expect(results[0]!.wynik).toBe(harness.BLAD_PROBY);
    expect(results[0]!.powod).toContain('oblewa juz na czystym kodzie');
  });

  it('przebieg proby nie oddaje testom przelacznika zapisu dowodow', () => {
    /*
     * Found by running this harness with `APP_WRITE_EVIDENCE=1`: the switch
     * reached every test it spawned, so a trial over an evidence-writing test
     * wrote that test's files into the evidence directory — from mutated code.
     * The trial's evidence is the trial's own report; the tests it runs are
     * instruments and leave nothing behind.
     */
    const before = process.env.APP_WRITE_EVIDENCE;
    process.env.APP_WRITE_EVIDENCE = '1';
    try {
      expect(harness.childEnv().APP_WRITE_EVIDENCE).toBeUndefined();
      // Everything else is passed through: this removes one variable, not the
      // environment.
      expect(harness.childEnv().PATH).toBe(process.env.PATH);
    } finally {
      if (before === undefined) delete process.env.APP_WRITE_EVIDENCE;
      else process.env.APP_WRITE_EVIDENCE = before;
    }
  });

  it('liczba uruchomionych testow czytana jest z podsumowania, nie z kodu wyjscia', () => {
    expect(harness.ranTests('Tests  11 skipped (11)')).toBe(0);
    expect(harness.ranTests('Tests  1 failed | 7 skipped (8)')).toBe(1);
    expect(harness.ranTests('Tests  13 passed (13)')).toBe(13);
    expect(harness.ranTests('nic takiego')).toBe(0);
  });

  it('PRZERWANIE SYGNALEM przywraca plik — proba na samej sciezce sygnalowej', async () => {
    /*
     * Ta sciezka nie miala proby i przez to nie dzialala: CLI trzymalo wlasna
     * zmienna `inFlight`, ktorej **nic nigdy nie przypisywalo**, wiec obsluga
     * sygnalu nie miala czego przywrocic, a `process.exit(130)` omijalo
     * `finally`. Trzy miejsca — naglowek skryptu, raport i opis dowodu L12.12 —
     * gloslily wlasnosc bezpieczenstwa, ktora nie zachodzila.
     *
     * Proba jest prawdziwa: osobny proces, prawdziwa mutacja na dysku,
     * prawdziwy SIGINT. Asercja dotyczy zawartosci pliku po smierci procesu.
     */
    const { repo } = repoWithFile('const strzezone = true;\n');
    const file = resolve(repo, 'src/plik.ts');
    const harnessPath = resolve(REPO, 'scripts/detection-trials.mjs');
    const program = [
      `const m = await import(${JSON.stringify(harnessPath)});`,
      'm.installRescue();',
      `m.applyMutation({ id: 'p', plik: 'src/plik.ts', szukaj: 'const strzezone = true;',`,
      `  zamien: 'const strzezone = false;' }, ${JSON.stringify(repo)});`,
      // The file is broken on disk right now; say so, then die by signal.
      `const fs = await import('node:fs');`,
      `process.stdout.write(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));`,
      'process.kill(process.pid, "SIGINT");',
      'await new Promise((r) => setTimeout(r, 5000));',
    ].join('\n');

    const child = spawn(process.execPath, ['--input-type=module', '-e', program]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    const code = await new Promise<number | null>((done) => child.on('close', done));

    // The mutation really was on disk while the process lived...
    expect(stdout, `mutacja nie zostala nalozona: ${stderr}`).toContain('const strzezone = false;');
    /*
     * O stanie swiadczy PLIK, nie napis. Wczesniej stalo tu
     * `toContain('plik przywrocony')`, a obsluga wypisywala ten napis
     * bezwarunkowo — asercja, ktora nie mogla oblac. Komunikat jest teraz
     * sprawdzany tylko dlatego, ze potrafi powiedziec dwie rozne rzeczy, i
     * razem ze sciezka, ktora pojawia sie wylacznie po przywroceniu.
     */
    expect(stderr).toContain(`przywrocono ${file}`);
    expect(stderr).not.toContain('nie bylo czego przywracac');
    // ...and the signal handler put it back, byte for byte.
    expect(readFileSync(file, 'utf8')).toBe('const strzezone = true;\n');
    expect(code).toBe(130);
  }, 30_000);

  it('po przywroceniu nie ma juz czego przywracac', () => {
    const { repo } = repoWithFile('const strzezone = true;\n');
    expect(harness.currentMutation()).toBeNull();
    const mutation = harness.applyMutation(trial(), repo);
    expect(harness.currentMutation()?.path).toBe(mutation.path);
    harness.restore(mutation);
    expect(harness.currentMutation()).toBeNull();
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

  it('filtr nazwy testu nie zawiera metaznakow wyrazenia regularnego', () => {
    // vitest reads `-t` as a regular expression; `.e2e-*` matched nothing and
    // the trial reported a finding about a fix that was guarded all along.
    for (const t of registry.proby) {
      if (!t.nazwaTestu) continue;
      expect(t.nazwaTestu, `${t.id}: metaznaki w filtrze -t`).not.toMatch(/[.*+?^${}()|[\]\\]/);
    }
  });

  it('rejestr obejmuje naprawy wymienione w kryterium L12.12', () => {
    const ids = registry.proby.map((t) => t.id);
    for (const required of [
      'D-1-szuflada-nad-canvasem',
      'D-2-projekcja-segmentu',
      'N-3-szeregowanie-rozmowy',
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
