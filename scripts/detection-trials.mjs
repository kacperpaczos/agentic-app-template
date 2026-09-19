#!/usr/bin/env node
/**
 * Controlled faulty variants of the critical fixes, and the proof that their
 * tests notice.
 *
 * **What this exists for.** A green test says the code passes the test. It does
 * not say the test would fail on broken code, and this programme has found ten
 * cases where it would not have — an assertion that could not fail, a probe
 * that answered from the wrong side, a fuse wired to the wrong binding. The
 * fixes that matter most were verified by reverting a line by hand on a
 * developer's machine, which proves nothing to anyone else and proves nothing
 * twice.
 *
 * So each trial names a line, the way to break it, and the test that must then
 * fail. Running them is one command, the result is a table, and **a trial whose
 * test still passes is a finding** — reported as `NIEWYKRYTE`, with a non-zero
 * exit code, because it means the fix is unguarded.
 *
 *   node scripts/detection-trials.mjs                 # all trials that run here
 *   node scripts/detection-trials.mjs --only <id>…    # chosen ones
 *   node scripts/detection-trials.mjs --list          # the register, unchanged
 *   APP_WRITE_EVIDENCE=1 node scripts/detection-trials.mjs   # + evidence file
 *
 * **Safety.** The repository is mutated, so: it must be clean before the first
 * trial (commit first — a trial run over uncommitted work cannot tell its own
 * change from yours), the original bytes are restored in a `finally` and on
 * every signal, and the tree is checked clean again at the end. Nothing is
 * written outside the files named in the register, and no process is killed.
 *
 * Kryteria: L12.12; the trials themselves carry the criterion each one guards.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY = resolve(REPO, 'docs/acceptance/detection-trials.json');
const EVIDENCE_DIR = 'docs/evidence/z13-bl12';
/** The shared browser lock; one browser run at a time across all worktrees. */
const LOCK = '/home/paczos/Documents/agentic-app-template-wt/.e2e.lock';

/** Outcomes of one trial. `NIEWYKRYTE` is the one that matters. */
export const WYKRYTE = 'wykryte';
export const NIEWYKRYTE = 'NIEWYKRYTE';
export const POMINIETE = 'pominiete';
/** The trial could not be carried out — which is never the same as a pass. */
export const BLAD_PROBY = 'BLAD-PROBY';

/**
 * How many tests actually ran, read off the runner's summary line.
 *
 * This exists because of a finding on the harness itself. A trial named its
 * test with `-t 'nie wstanie na .e2e-* bedacym…'`; vitest reads that as a
 * *regular expression*, `-*` did not match the literal `*`, **eleven tests were
 * skipped, the exit code was 0** — and the harness read the zero as "the test
 * passed on broken code" and reported a finding about a fix that is in fact
 * guarded. A run of nothing must never be read as a run of something, in either
 * direction.
 */
export function ranTests(output) {
  const line = (output.match(/Tests\s+.*$/m) ?? [''])[0];
  let total = 0;
  for (const m of line.matchAll(/(\d+)\s+(passed|failed)/g)) total += Number(m[1]);
  if (total > 0) return total;
  // Playwright prints `3 passed (12.1s)` / `1 failed` on their own lines.
  for (const m of output.matchAll(/^\s*(\d+)\s+(passed|failed)\b/gm)) total += Number(m[1]);
  return total;
}

export function readRegistry(path = REGISTRY) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data.proby)) throw new Error(`${path}: brak listy prob`);
  return data;
}

/** `git status --porcelain` of the whole repository, or null when git cannot answer. */
export function treeStatus(repo = REPO) {
  const out = spawnSync('git', ['status', '--porcelain', '--', ':(top)'], {
    cwd: repo,
    encoding: 'utf8',
  });
  return out.status === 0 ? out.stdout.trim() : null;
}

/**
 * Refuses to run over uncommitted work.
 *
 * Not fussiness: this harness edits source files and puts them back. If the
 * tree already differs from the commit, "restored" has no definition — the
 * check at the end cannot tell the harness's leftovers from the author's work,
 * and a failed restore would be silently blamed on the author.
 */
export function assertCleanTree(repo = REPO, what = 'proby zdolnosci wykrycia') {
  const status = treeStatus(repo);
  if (status === null) throw new Error(`${what}: git nie odpowiada w ${repo} — nie da sie zagwarantowac przywrocenia.`);
  if (status !== '') {
    throw new Error(
      `${what}: drzewo robocze nie jest czyste. Najpierw commit, potem proba.\n${status}`,
    );
  }
}

/**
 * Applies one faulty variant and returns the original bytes.
 *
 * The string to replace must occur **exactly once**. A pattern that matches
 * twice would break two places and a pattern that matches none would leave the
 * code intact — and then the test passes, and the harness would report a
 * finding about a mutation it never made. Both are errors here, not warnings.
 */
/**
 * The mutation currently applied to the tree, or null.
 *
 * Module level, and that is the whole point of this revision. The CLI used to
 * keep its own `inFlight` variable that **nothing ever assigned**: the applied
 * mutation lived in a local inside `runTrials`, so the signal handler had
 * nothing to put back and `process.exit(130)` skipped the `finally`. Three
 * places — the header of this file, the task report and the acceptance matrix —
 * claimed a safety property that did not hold. It holds now because the state
 * the handler needs is where the handler can see it.
 */
let applied = null;

/** What is mutated right now. Exported so a test can watch the signal path. */
export const currentMutation = () => applied;

/**
 * Restores on interruption — the path that had no trial of its own.
 *
 * `tests/detection-trials.test.ts` sends a real SIGINT to a real child process
 * with a real mutation applied, and requires the file to come back and the exit
 * code to be 130.
 */
export function installRescue() {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      /*
       * Sciezka odczytana PRZED przywroceniem: `restore` zeruje stan, wiec
       * komunikat skladany po nim mowil zawsze „brak mutacji" — takze wtedy,
       * gdy wlasnie przywrocil plik. Komunikat, ktory nie potrafi powiedziec
       * dwoch roznych rzeczy, nie jest obserwacja.
       */
      const path = applied?.path ?? null;
      if (applied) restore(applied);
      console.error(
        path ? `\nPrzerwano (${signal}) — przywrocono ${path}` : `\nPrzerwano (${signal}) — nie bylo czego przywracac`,
      );
      process.exit(130);
    });
  }
}

export function applyMutation(trial, repo = REPO) {
  const path = resolve(repo, trial.plik);
  if (!existsSync(path)) throw new Error(`${trial.id}: brak pliku ${trial.plik}`);
  const original = readFileSync(path, 'utf8');
  const occurrences = original.split(trial.szukaj).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${trial.id}: wzorzec wystepuje ${occurrences} razy w ${trial.plik} (wymagany dokladnie 1). ` +
        'Rejestr rozjechal sie z kodem — popraw rejestr, nie wynik proby.',
    );
  }
  if (trial.zamien === trial.szukaj) {
    throw new Error(`${trial.id}: wariant wadliwy jest identyczny z oryginalem — to nie jest proba.`);
  }
  writeFileSync(path, original.replace(trial.szukaj, trial.zamien));
  applied = { path, original };
  return applied;
}

/** Puts the file back, byte for byte. */
export function restore({ path, original }) {
  writeFileSync(path, original);
  if (applied && applied.path === path) applied = null;
}

/** Runs the test a trial names. Replaced in the self-test by a stand-in. */
export function vitestRunner(trial, repo = REPO) {
  if (trial.rodzaj === 'playwright') return playwrightRunner(trial, repo);
  const args = ['exec', 'vitest', 'run', trial.test];
  if (trial.nazwaTestu) args.push('-t', trial.nazwaTestu);
  const out = spawnSync('pnpm', args, { cwd: repo, encoding: 'utf8', timeout: 600_000, env: childEnv() });
  return { code: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}` };
}

/**
 * The environment a trial's test run gets — with `APP_WRITE_EVIDENCE` removed.
 *
 * Found by this harness's own evidence run, which is the only reason it is
 * written down rather than assumed: `APP_WRITE_EVIDENCE=1 node
 * scripts/detection-trials.mjs` passed the switch to every test it spawned, so
 * a trial over an evidence-writing test wrote **its** files into the evidence
 * directory — on mutated code, no less. Evidence of a trial is the trial's
 * report; the tests it runs are instruments and must leave nothing behind.
 */
export function childEnv() {
  const env = { ...process.env };
  delete env.APP_WRITE_EVIDENCE;
  return env;
}

/**
 * A browser trial: build first, then run the spec under the shared lock.
 *
 * The build is not optional and not an optimisation. The browser suite drives
 * the **production bundle**, so a mutation in a stylesheet or a component that
 * is not rebuilt changes nothing that the browser will ever see — the trial
 * would report `NIEWYKRYTE` about a fix that is perfectly well guarded, which
 * is the same mistake as reading a filter that matched nothing as a pass.
 *
 * Both phases build, so the baseline is the built clean code and the mutated
 * phase is the built mutated code.
 */
export function playwrightRunner(trial, repo = REPO) {
  const build = spawnSync('pnpm', ['build'], { cwd: repo, encoding: 'utf8', timeout: 900_000, env: childEnv() });
  if (build.status !== 0) {
    return { code: build.status, output: `pnpm build oblal:\n${build.stdout ?? ''}${build.stderr ?? ''}` };
  }
  const args = [
    '-w',
    '5400',
    LOCK,
    'pnpm',
    'exec',
    'playwright',
    'test',
    trial.test,
    ...(trial.nazwaTestu ? ['-g', trial.nazwaTestu] : []),
  ];
  const out = spawnSync('flock', args, { cwd: repo, encoding: 'utf8', timeout: 3_600_000, env: childEnv() });
  return { code: out.status, output: `${out.stdout ?? ''}${out.stderr ?? ''}` };
}

/**
 * Runs the trials and reports what each one proved.
 *
 * `runner` is a parameter so the harness can be exercised by a test without
 * running vitest inside vitest — and, more to the point, so the harness's own
 * ability to report a finding can be proved: a stand-in that always reports
 * success must produce `NIEWYKRYTE`. A control mechanism nobody has seen fail
 * is a declaration.
 */
export async function runTrials({ trials, repo = REPO, runner = vitestRunner, log = () => {} }) {
  const results = [];
  for (const trial of trials) {
    if (trial.wRegresji === false) {
      results.push({ id: trial.id, wynik: POMINIETE, powod: trial.powodPominiecia ?? 'poza regresja' });
      log(`${POMINIETE}  ${trial.id} — ${trial.powodPominiecia ?? 'poza regresja'}`);
      continue;
    }
    log(`… ${trial.id}: ${trial.plik} → ${trial.test}`);
    const common = {
      id: trial.id,
      kryterium: trial.kryterium,
      naprawa: trial.naprawa,
      plik: trial.plik,
      test: trial.test,
      nazwaTestu: trial.nazwaTestu ?? null,
    };

    /*
     * The baseline, before anything is broken: the named test has to RUN and
     * PASS on the untouched code. Without it a trial cannot tell "the test does
     * not catch this" from "no test ran at all" — and the second is what a
     * mistyped filter, a renamed test or a missing file produces, all of them
     * with a green exit code.
     */
    const base = await runner(trial, repo, 'baseline');
    const baseCount = ranTests(base.output);
    if (base.code !== 0 || baseCount === 0) {
      const outcome = {
        ...common,
        wynik: BLAD_PROBY,
        kodWyjsciaTestu: base.code,
        powod:
          baseCount === 0
            ? 'na czystym kodzie nie uruchomil sie ZADEN test (zly plik albo filtr -t, ktory nic nie pasuje)'
            : 'test oblewa juz na czystym kodzie — proba nie moze niczego wykazac',
        fragmentWyniku: (base.output.match(/Tests\s+.*$/m) ?? [''])[0].trim() || base.output.trim().slice(-300),
      };
      results.push(outcome);
      log(`${outcome.wynik}  ${outcome.id}  ${outcome.powod}`);
      continue;
    }

    let mutation = null;
    let outcome;
    try {
      mutation = applyMutation(trial, repo);
      const { code, output } = await runner(trial, repo, 'mutated');
      const failed = code !== 0;
      const expected = trial.oczekiwanyKomunikat ? new RegExp(trial.oczekiwanyKomunikat).test(output) : true;
      outcome = {
        ...common,
        wynik: failed && expected ? WYKRYTE : NIEWYKRYTE,
        kodWyjsciaTestu: code,
        testowPrzedMutacja: baseCount,
        ...(failed && !expected
          ? { powod: `test oblal, ale nie z oczekiwanego powodu (${trial.oczekiwanyKomunikat})` }
          : {}),
        ...(failed ? {} : { powod: 'test PRZESZEDL na wadliwym wariancie — naprawa nie jest chroniona' }),
        fragmentWyniku: (output.match(/Tests\s+.*$/m) ?? [''])[0].trim() || output.trim().slice(-300),
      };
    } finally {
      if (mutation) restore(mutation);
    }
    results.push(outcome);
    log(`${outcome.wynik}  ${outcome.id}  ${outcome.fragmentWyniku}`);
  }
  return results;
}

/* --------------------------------- CLI ------------------------------------ */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  const registry = readRegistry();
  if (argv.includes('--list')) {
    for (const t of registry.proby) {
      console.log(
        `${t.id.padEnd(28)} ${t.kryterium.padEnd(8)} ${t.wRegresji === false ? '(poza regresja) ' : ''}${t.plik} → ${t.test}`,
      );
    }
    process.exit(0);
  }
  /*
   * Identifiers after `--only`, and only those: `--only X --browser` used to
   * read `--browser` as the name of a trial, which then matched nothing and
   * silently narrowed the run to X alone.
   */
  const only = argv.includes('--only')
    ? (() => {
        const rest = argv.slice(argv.indexOf('--only') + 1);
        const end = rest.findIndex((a) => a.startsWith('--'));
        return end === -1 ? rest : rest.slice(0, end);
      })()
    : null;
  /*
   * A browser trial builds the bundle and takes the shared lock, so it never
   * runs by accident: `--browser` (or naming it with `--only`) is the consent.
   */
  const browser = argv.includes('--browser');
  const chosen = (only ? registry.proby.filter((t) => only.includes(t.id)) : registry.proby).map((t) =>
    t.rodzaj === 'playwright' && !browser && !only ? { ...t, wRegresji: false } : t,
  );
  if (chosen.length === 0) {
    console.error('Brak prob do uruchomienia (sprawdz --only).');
    process.exit(2);
  }

  assertCleanTree();

  /*
   * Restoring on the way out, including the ways out nobody plans: a signal
   * leaves a broken source file in the tree otherwise, and the next reader
   * finds a repository that does not build with no idea why.
   */
  installRescue();

  const results = await runTrials({
    trials: chosen,
    log: (line) => console.log(line),
  });

  const status = treeStatus();
  const dirty = status !== '';
  console.log('\n================ PROBY ZDOLNOSCI WYKRYCIA ================');
  for (const r of results) console.log(`${String(r.wynik).padEnd(11)} ${r.id.padEnd(28)} ${r.powod ?? ''}`);
  const missed = results.filter((r) => r.wynik === NIEWYKRYTE);
  const broken = results.filter((r) => r.wynik === BLAD_PROBY);
  const skipped = results.filter((r) => r.wynik === POMINIETE);
  console.log(
    `\n${results.filter((r) => r.wynik === WYKRYTE).length}/${results.length - skipped.length} napraw ma test, ktory oblewa na wadliwym wariancie` +
      (skipped.length ? `; pominietych: ${skipped.length}` : '') +
      (broken.length ? `; prob niewykonanych: ${broken.length}` : ''),
  );
  console.log(`drzewo po probach: ${dirty ? `BRUDNE\n${status}` : 'czyste'}`);

  if (process.env.APP_WRITE_EVIDENCE === '1') {
    const dir = resolve(REPO, EVIDENCE_DIR);
    mkdirSync(dir, { recursive: true });
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
    const body = {
      opis: registry.opis,
      zrodlo: 'node scripts/detection-trials.mjs (APP_WRITE_EVIDENCE=1)',
      rodzajWykonania: 'test kontraktu lub logiki',
      zapisano: new Date().toISOString(),
      wersjaKodu: { commit, brudneDrzewoPrzedProbami: false, node: process.versions.node },
      srodowisko: {
        system: `${platform()} ${release()} ${arch()}`,
        node: process.versions.node,
        pnpm: (spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout ?? '').trim() || null,
      },
      drzewoPoProbach: dirty ? 'BRUDNE' : 'czyste',
      wyniki: results,
    };
    /*
     * A narrowed run writes beside the full one, never over it: a recorded
     * result is a fact about the run that produced it, and `--only D-1` is a
     * different run from "all of them".
     */
    const name = only ? `proby-wykrycia-${only.join('-').slice(0, 60)}.json` : 'proby-wykrycia.json';
    const path = resolve(dir, name);
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    console.log(`dowod: ${relative(REPO, path)}`);
  }

  process.exit(missed.length > 0 || broken.length > 0 || dirty ? 1 : 0);
}
