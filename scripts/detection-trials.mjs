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
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY = resolve(REPO, 'docs/acceptance/detection-trials.json');
const EVIDENCE_DIR = 'docs/evidence/z13-bl12';

/** Outcomes of one trial. `NIEWYKRYTE` is the one that matters. */
export const WYKRYTE = 'wykryte';
export const NIEWYKRYTE = 'NIEWYKRYTE';
export const POMINIETE = 'pominiete';

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
  return { path, original };
}

/** Puts the file back, byte for byte. */
export function restore({ path, original }) {
  writeFileSync(path, original);
}

/** Runs the test a trial names. Replaced in the self-test by a stand-in. */
export function vitestRunner(trial, repo = REPO) {
  const args = ['exec', 'vitest', 'run', trial.test];
  if (trial.nazwaTestu) args.push('-t', trial.nazwaTestu);
  const out = spawnSync('pnpm', args, { cwd: repo, encoding: 'utf8', timeout: 600_000 });
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
    let applied = null;
    let outcome;
    try {
      applied = applyMutation(trial, repo);
      const { code, output } = await runner(trial, repo);
      const failed = code !== 0;
      const expected = trial.oczekiwanyKomunikat ? new RegExp(trial.oczekiwanyKomunikat).test(output) : true;
      outcome = {
        id: trial.id,
        kryterium: trial.kryterium,
        naprawa: trial.naprawa,
        plik: trial.plik,
        test: trial.test,
        nazwaTestu: trial.nazwaTestu ?? null,
        wynik: failed && expected ? WYKRYTE : NIEWYKRYTE,
        kodWyjsciaTestu: code,
        ...(failed && !expected
          ? { powod: `test oblal, ale nie z oczekiwanego powodu (${trial.oczekiwanyKomunikat})` }
          : {}),
        ...(failed ? {} : { powod: 'test PRZESZEDL na wadliwym wariancie — naprawa nie jest chroniona' }),
        fragmentWyniku: (output.match(/Tests\s+.*$/m) ?? [''])[0].trim() || output.trim().slice(-300),
      };
    } finally {
      if (applied) restore(applied);
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
  const only = argv.includes('--only') ? argv.slice(argv.indexOf('--only') + 1) : null;
  const chosen = only ? registry.proby.filter((t) => only.includes(t.id)) : registry.proby;
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
  let inFlight = null;
  const rescue = (signal) => {
    if (inFlight) restore(inFlight);
    console.error(`\nPrzerwano (${signal}) — plik przywrocony.`);
    process.exit(130);
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => rescue(signal));

  const results = await runTrials({
    trials: chosen,
    log: (line) => console.log(line),
    runner: (trial, repo) => {
      inFlight = null;
      const out = vitestRunner(trial, repo);
      return out;
    },
  });

  const status = treeStatus();
  const dirty = status !== '';
  console.log('\n================ PROBY ZDOLNOSCI WYKRYCIA ================');
  for (const r of results) console.log(`${String(r.wynik).padEnd(11)} ${r.id.padEnd(28)} ${r.powod ?? ''}`);
  const missed = results.filter((r) => r.wynik === NIEWYKRYTE);
  const skipped = results.filter((r) => r.wynik === POMINIETE);
  console.log(
    `\n${results.length - missed.length - skipped.length}/${results.length - skipped.length} napraw ma test, ktory oblewa na wadliwym wariancie` +
      (skipped.length ? `; pominietych: ${skipped.length}` : ''),
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
      drzewoPoProbach: dirty ? 'BRUDNE' : 'czyste',
      wyniki: results,
    };
    const path = resolve(dir, 'proby-wykrycia.json');
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    console.log(`dowod: ${relative(REPO, path)}`);
  }

  process.exit(missed.length > 0 || dirty ? 1 : 0);
}
