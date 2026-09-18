/**
 * Writer for the measurement evidence of this repository's own regression.
 *
 * Shared by the backend regression (`tests/measurements.test.ts`) and the
 * browser regression (`e2e/measurements.spec.ts`), because a number is only a
 * measurement when it arrives with the same four things every time:
 *
 *  1. **what** was measured, as a sentence;
 *  2. **from which event to which event** the clock ran — not "how long it
 *     took", which hides where the interval starts;
 *  3. the **conditions**, stated so they hold on any machine: what ran, what
 *     was substituted for the model, how the instant was observed;
 *  4. the **code version** the numbers came from, so a result cannot outlive
 *     the code that produced it.
 *
 * Milliseconds are machine-dependent and are reported as such; the assertions
 * that guard them are about ordering and presence, never about a threshold that
 * would only mean something on one laptop.
 *
 * **A missing metric stays missing.** `null` in `probkiMs` means the event this
 * measurement waits for never happened — an answer with no text has no
 * time-to-first-text. It is written as `null`, counted as `brakMetryki`, and
 * never coerced to `0`, which would read as "instantly".
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Evidence directory of this task. Named after the task, not after older work. */
export const EVIDENCE_DIR = 'docs/evidence/z3-bl05';

/** The switch that lets a run write evidence files. */
export const EVIDENCE_ENV = 'APP_WRITE_EVIDENCE';

/**
 * The commit this code was copied from, for a run outside a git repository.
 *
 * `codeVersion()` asks git, because inside the repository git is the truth and
 * nothing passed in could be trusted over it. But the regression is also run on
 * a *copy* of the repository that deliberately has no `.git`
 * (`scripts/check-module-swap.mjs` builds one to prove the domain module can be
 * swapped). There `git rev-parse` has nothing to read, the record used to say
 * `commit: "nieznany"`, and the assertion that a measurement carries a real
 * commit failed — correctly, because the record was not carrying one.
 *
 * So whoever creates such a copy passes the commit it was made from. It is a
 * *fallback*, never an override: git wins whenever git can answer, and the
 * value is accepted only if it looks like a commit, so an environment variable
 * cannot put a different kind of lie into the record. Nothing is weakened: the
 * assertion stays exactly as sharp, and the record from the copy now says
 * truthfully which commit it came from.
 */
export const CODE_COMMIT_ENV = 'APP_CODE_COMMIT';

/**
 * Whether the copied tree differed from that commit — again, only for a run
 * that has no git to ask. A copy made for the swap trial is the commit *plus*
 * the composition swap, so its creator passes `1`.
 */
export const CODE_TREE_DIRTY_ENV = 'APP_CODE_TREE_DIRTY';

/** What a commit looks like, wherever the value came from. */
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/**
 * Whether this run may write into the evidence directory.
 *
 * Off by default, and the default is the point. These tests belong to
 * `pnpm verify`, whose acceptance condition is "exit 0 **and** a repository
 * without litter" — and a regression that rewrites files inside the tree it is
 * being judged on cannot satisfy both at once. Worse, a committed and reviewed
 * measurement would stop being the record of one examined run and become a
 * trace of whoever last ran the tests, including someone who ran them out of
 * curiosity.
 *
 * So an ordinary run performs **every assertion** — nothing is skipped, nothing
 * is weakened — and only the write to disk waits for `APP_WRITE_EVIDENCE=1`
 * (`pnpm evidence`). Named like the repository's other deliberate switch,
 * `APP_E2E_MODEL`.
 */
export const evidenceWritingRequested = (): boolean => process.env[EVIDENCE_ENV] === '1';

/** What a write would produce, and whether it happened. */
export interface EvidenceResult {
  /** Where the file belongs, whether or not it was written. */
  path: string;
  /** Exactly the bytes a write would put there — asserted on either way. */
  body: string;
  written: boolean;
}

function emit(fileName: string, body: string): EvidenceResult {
  const dir = resolve(process.cwd(), EVIDENCE_DIR);
  const path = resolve(dir, fileName);
  if (!evidenceWritingRequested()) return { path, body, written: false };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, body);
  return { path, body, written: true };
}

export interface Measurement {
  /** What was measured, in one sentence. */
  co: string;
  /** The event the clock starts on. */
  od: string;
  /** The event the clock stops on. */
  do: string;
  /** Conditions that hold independently of the machine. */
  warunki: string;
  /**
   * Samples in milliseconds, in the order they were taken. `null` is a metric
   * that does not exist for that sample, and is never a zero.
   */
  probkiMs: Array<number | null>;
  /** Anything the numbers alone would misrepresent. */
  uwagi?: string;
}

export interface CodeVersion {
  commit: string;
  /**
   * Three answers, not two: `true` the tree differed from the commit, `false`
   * it did not, `null` **nobody could tell**.
   *
   * The third one exists because the second used to be given in its place. With
   * no git and no statement from the caller there is nothing to check, and a
   * `boolean` has to say something anyway — it said `false`, so the record
   * asserted a clean tree that had never been examined. That is a false
   * condition of measurement, which is worse than a missing one: a reader
   * cannot tell it from a checked result. A condition is true or explicitly
   * unknown, never favourable by default.
   */
  brudneDrzewo: boolean | null;
  node: string;
  pakiety: Record<string, string>;
}

/** The commit the measurement was taken on, and whether the tree was clean. */
export function codeVersion(pakiety: Record<string, string> = {}): CodeVersion {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const fromGit = git(['rev-parse', 'HEAD']);
  const passedIn = (process.env[CODE_COMMIT_ENV] ?? '').trim();
  /*
   * `--porcelain` prints one line per changed path; empty output means clean.
   *
   * The evidence directory is excluded, and has to be: these files are
   * rewritten by the very run that reads this flag, so counting them would
   * make every measurement report a dirty tree and the flag would stop
   * meaning anything. Everything else counts.
   */
  // `:(top)` so the answer is about the whole repository whatever the
  // working directory of the runner happens to be.
  const status = git(['status', '--porcelain', '--', ':(top)', `:(exclude,top)${EVIDENCE_DIR}`]);
  /*
   * Same precedence as the commit: git decides wherever it can answer, and only
   * where it cannot does the caller's statement count. Anything other than an
   * explicit "1" or "0" is not a statement, so it leaves the question open
   * instead of closing it in the convenient direction.
   */
  const declared = process.env[CODE_TREE_DIRTY_ENV];
  const dirty: boolean | null =
    status !== null
      ? status !== ''
      : declared === '1'
        ? true
        : declared === '0'
          ? false
          : null;
  return {
    // git first: where it can answer, nothing passed in may contradict it.
    commit: fromGit ?? (COMMIT_RE.test(passedIn) ? passedIn : 'nieznany'),
    brudneDrzewo: dirty,
    node: process.versions.node,
    pakiety,
  };
}

const summarise = (samples: Array<number | null>) => {
  const present = samples.filter((s): s is number => s !== null).sort((a, b) => a - b);
  return {
    probek: samples.length,
    zMetryka: present.length,
    // Deliberately reported, not hidden: "no metric" is a result.
    brakMetryki: samples.length - present.length,
    minMs: present[0] ?? null,
    medianaMs: present.length ? present[Math.floor((present.length - 1) / 2)]! : null,
    maxMs: present.at(-1) ?? null,
  };
};

export interface MeasurementRecord {
  /** What this file is, and which regression produced it. */
  opis: string;
  /** How the numbers were produced: which command, run by whom. */
  zrodlo: string;
  wersjaKodu: CodeVersion;
  pomiary: Record<string, Measurement>;
}

/**
 * Writes one measurement record into the task's evidence directory.
 *
 * Each producer owns its own file; nothing merges, so a run of one regression
 * cannot silently drop the other's results. A round of corrections writes under
 * a new name rather than over the old one — a recorded measurement is a fact
 * about the code that produced it, and replacing it in place would quietly
 * rewrite history that a report already cites.
 */
export function writeMeasurementRecord(
  fileName: string,
  record: Omit<MeasurementRecord, 'wersjaKodu'> & { wersjaKodu?: CodeVersion },
): EvidenceResult {
  const wersjaKodu = record.wersjaKodu ?? codeVersion();
  const body = {
    opis: record.opis,
    zrodlo: record.zrodlo,
    zapisano: new Date().toISOString(),
    wersjaKodu,
    uwagaOJednostkach:
      'Wartosci w milisekundach zaleza od maszyny i obciazenia. Powtarzalne jest to, co ' +
      'asertuje regresja: kolejnosc punktow pomiaru, ich rozdzielenie i obecnosc albo brak metryki.',
    uwagaOWersjiKodu:
      `Ten plik powstaje na zadanie (${EVIDENCE_ENV}=1, czyli pnpm evidence), nie przy zwyklym ` +
      'pnpm verify. Pole brudneDrzewo ma trzy stany: true — drzewo robocze roznilo sie od commita, ' +
      'false — nie roznilo sie, null — nie dalo sie tego ustalic (przebieg bez gita i bez ' +
      `deklaracji ${CODE_TREE_DIRTY_ENV}; tak dzieje sie np. w kopii repozytorium). Null znaczy ` +
      '„nie wiadomo”, nie „czysto”. Odpowiedz dotyczy chwili tej regeneracji i pomija sam katalog ' +
      'dowodow, ktory regeneracja wlasnie przepisuje — nie mowi nic o stanie drzewa w chwili ' +
      'czytania pliku. Pole commit ma wartownika „nieznany” w tej samej sytuacji. Puste pakiety ' +
      'znacza, ze wersji zaleznosci w tym przebiegu nie zbierano — nie ze ich nie ma.',
    pomiary: Object.fromEntries(
      Object.entries(record.pomiary).map(([k, m]) => [k, { ...m, podsumowanie: summarise(m.probkiMs) }]),
    ),
  };
  return emit(fileName, `${JSON.stringify(body, null, 2)}\n`);
}

/** Writes a non-measurement proof (correlation, error classes, secret scan). */
export function writeEvidence(fileName: string, body: unknown): EvidenceResult {
  return emit(fileName, `${JSON.stringify(body, null, 2)}\n`);
}
