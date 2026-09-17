import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The three specs that answer with the **real model**, and everything that
 * protects what they leave behind.
 *
 * **Why they are opt-in.** Every other spec costs time; these cost turns of a
 * paid subscription, and a turn spent is gone. `pnpm test:e2e` used to run them
 * with everything else, so anybody checking a change paid for it — and, worse,
 * the acceptance run walked straight into the budget guard and then overwrote
 * the recorded verdicts with failures from its own `finally` blocks. So the
 * default run has no project that matches them at all (`playwright.config.ts`),
 * and running them is an explicit `APP_E2E_MODEL=1` (`pnpm test:e2e:model`).
 *
 * **Why the tally is not in the evidence.** The budget has to survive one
 * process ending and another starting, so it lives on disk — but a counter is a
 * working file that every run writes, and the committed ledger is evidence of a
 * closed grant that nothing may write. They are two files: this one, ignored by
 * git, seeded once from the ledger so a fresh checkout cannot quietly start
 * spending from zero.
 *
 * **Why evidence is written under a run stamp.** A recorded verdict is a fact
 * about a run that happened. A later run has its own facts and writes them
 * beside it, never over it: `writeEvidence` can only write inside this run's
 * own directory, and refuses anything else.
 */

/** Spec files that spend subscription turns, by file name. */
export const MODEL_SPEC_FILES = ['bl01-bl02-model.spec.ts', 'agent-ui.spec.ts', 'files-agent.spec.ts'] as const;
export type ModelSpecFile = (typeof MODEL_SPEC_FILES)[number];

/** The same three as Playwright matches them (`testIgnore` / `testMatch`). */
export const MODEL_SPEC_PATTERNS: string[] = MODEL_SPEC_FILES.map((file) => `**/${file}`);

/** Turns one clean run of each spends — what the opt-in actually costs. */
export const MODEL_SPEC_TURNS: Record<ModelSpecFile, number> = {
  'bl01-bl02-model.spec.ts': 7,
  'agent-ui.spec.ts': 2,
  'files-agent.spec.ts': 2,
};

export const MODEL_TURNS_PER_RUN = Object.values(MODEL_SPEC_TURNS).reduce((a, b) => a + b, 0);

/** The one switch that lets a run reach them. */
export const MODEL_OPT_IN_ENV = 'APP_E2E_MODEL';

export const modelSpecsRequested = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[MODEL_OPT_IN_ENV] === '1';

/** What the run prints about the specs it did not run, so the skip is never silent. */
export function modelSpecsNotice(env: NodeJS.ProcessEnv = process.env): string {
  const listed = MODEL_SPEC_FILES.map((f) => `${f} (${MODEL_SPEC_TURNS[f]})`).join(', ');
  return modelSpecsRequested(env)
    ? `[e2e] ${MODEL_OPT_IN_ENV}=1 — projekt „model”: ${listed}. ` +
        `Ten przebieg wyda do ${MODEL_TURNS_PER_RUN} tur subskrypcji.`
    : `[e2e] pominieto spece z prawdziwym modelem: ${listed}. ` +
        `Kosztuja ${MODEL_TURNS_PER_RUN} tur subskrypcji na przebieg — uruchamia sie je swiadomie: pnpm test:e2e:model.`;
}

/* -------------------------------------------------------------------------- */
/*  Evidence and the turn ledger                                              */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** Where the acceptance evidence of BL-01/BL-02 lives. Its files are committed. */
export const EVIDENCE_ROOT = resolve(REPO_ROOT, 'docs/evidence/bl01-bl02-2026-09-17');

/** The ledger of the closed grant. Read to seed the tally, never written. */
export const RECORDED_LEDGER = resolve(EVIDENCE_ROOT, 'tury-modelu.json');

/** The running tally, in the working copy (gitignored). */
export const WORKING_LEDGER = resolve(REPO_ROOT, '.e2e-model-turns/tury-modelu.json');

/**
 * This run's stamp, shared by every process of the run: the config sets it
 * before the workers are forked, so one invocation writes into one directory.
 */
export const RUN_STAMP: string =
  process.env.APP_E2E_RUN_STAMP ??
  (process.env.APP_E2E_RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-'));

/** This run's own evidence directory — beside the recorded evidence, never over it. */
export const runEvidenceDir = (): string => resolve(EVIDENCE_ROOT, 'runs', RUN_STAMP);

/**
 * Where one evidence file of this run goes.
 *
 * A bare file name only: a name that could climb out of the run's directory is
 * refused, which is what keeps `t25-*`, `t26-*`, `t27-*` and the ledger exactly
 * as the run that produced them left them.
 */
export function evidencePath(name: string): string {
  if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) {
    throw new Error(`nazwa dowodu „${name}” nie jest zwykla nazwa pliku`);
  }
  return resolve(runEvidenceDir(), name);
}

/** The commit the evidence was produced on; read once, when something is written. */
let commit: string | null = null;
export function codeCommit(): string {
  commit ??= execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }).toString().trim();
  return commit;
}

export interface TurnLedger {
  budzet: number;
  wydane: number;
  tury: Array<{ nr: number; o: string; proba: string; polecenie: string; runId?: string; etap?: string }>;
  /** Present on the working tally: where its starting count came from. */
  zrodlo?: string;
}

/**
 * The tally so far.
 *
 * Seeded once from the recorded ledger, because the budget is for the plan and
 * not for one checkout: the grant recorded there is closed, and a counter
 * starting at zero would hand out its turns a second time.
 */
export function readLedger(budget: number): TurnLedger {
  if (existsSync(WORKING_LEDGER)) return JSON.parse(readFileSync(WORKING_LEDGER, 'utf8')) as TurnLedger;
  if (existsSync(RECORDED_LEDGER)) {
    const recorded = JSON.parse(readFileSync(RECORDED_LEDGER, 'utf8')) as TurnLedger;
    return {
      budzet: budget,
      wydane: recorded.wydane,
      tury: recorded.tury,
      zrodlo: `zaczete od zamknietego rejestru ${RECORDED_LEDGER}`,
    };
  }
  return { budzet: budget, wydane: 0, tury: [] };
}

/** Writes the tally — to the working copy, and nowhere else. */
export function writeLedger(ledger: TurnLedger): void {
  mkdirSync(resolve(WORKING_LEDGER, '..'), { recursive: true });
  writeFileSync(WORKING_LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * One evidence file of this run, written whether the proba passed or not.
 *
 * Deliberately assembled from named fields rather than from whole API objects:
 * a run record carries `claudeSessionId`, which is nobody's business outside
 * the machine it was made on.
 */
export function writeEvidence(name: string, body: Record<string, unknown>): void {
  const path = evidencePath(name);
  mkdirSync(runEvidenceDir(), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        zapisano: new Date().toISOString(),
        kodCommit: codeCommit(),
        zrodlo: 'prawdziwy model (subskrypcja Claude), instancja testowa suity przegladarkowej',
        spec: 'e2e/bl01-bl02-model.spec.ts',
        przebieg: RUN_STAMP,
        ...body,
      },
      null,
      2,
    )}\n`,
  );
}
