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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';

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

/* ------------------------- how a proof was executed ----------------------- */

/**
 * The five kinds of execution this repository recognises, spelled exactly as
 * `AGENTS.md` and the acceptance matrix spell them.
 *
 * Stated on every evidence file, and required by the type, because the kind is
 * the first thing a reader needs and the easiest thing to leave out. "The test
 * passed" means something different when a real model answered, when a
 * stand-in did, and when nothing ran at all and somebody read the code.
 */
export const EXECUTION_KINDS = [
  'rzeczywisty model',
  'test GUI bez modelu',
  'test kontraktu lub logiki',
  'symulacja',
  'analiza kodu',
  /*
   * A recorded run of an acceptance command — `pnpm verify` on a clean copy,
   * `pnpm check:module-swap`, a probe script — with its log kept. G17 allows
   * exactly this ("skrypt odbiorowy z logiem"), and none of the five above fits
   * it: it was executed, so "analiza kodu" would be false, and no test file
   * carries it.
   */
  'przebieg odbiorowy z logiem',
] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

/* ----------------------------- resolved versions -------------------------- */

/**
 * Packages whose version decides what a result means.
 *
 * Deliberately a list and not "everything in the lockfile": a file naming two
 * thousand transitive versions is not a record anybody reads, and the lockfile
 * is in the repository at the commit the envelope already names. These are the
 * ones a reader compares across two runs — the runtime, the UI library, the
 * agent SDK and the test tooling.
 */
const TRACKED_PACKAGES = [
  'react',
  'react-dom',
  'typescript',
  'vite',
  'vitest',
  '@playwright/test',
  '@openuidev/react-ui',
  '@openuidev/react-headless',
  'hono',
  'drizzle-orm',
  '@mastra/core',
  '@mastra/claude',
  '@anthropic-ai/claude-agent-sdk',
  'zod',
] as const;

/** Where to look from: a pnpm workspace hides a dependency from the root. */
const RESOLUTION_BASES = [
  'package.json',
  'apps/web/package.json',
  'apps/server/package.json',
  'packages/platform-server/package.json',
  'packages/platform-ui/package.json',
];

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/**
 * The version actually installed, read from the manifest that was resolved.
 *
 * Not from `package.json`'s range and not from the lockfile: both say what was
 * *asked for*. Under pnpm the answer also depends on which workspace package
 * asks, so several bases are tried — a dependency of `apps/web` is invisible
 * from the repository root.
 */
function installedVersion(name: string): string | null {
  for (const base of RESOLUTION_BASES) {
    const from = resolve(REPO_ROOT, base);
    if (!existsSync(from)) continue;
    try {
      const require = createRequire(from);
      let dir = dirname(require.resolve(name));
      for (let i = 0; i < 8; i += 1) {
        const manifest = resolve(dir, 'package.json');
        if (existsSync(manifest)) {
          const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
          if (json.name === name && json.version) return json.version;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      /* not resolvable from this base — try the next */
    }
  }
  return null;
}

/**
 * Resolved versions of the packages that decide what a result means.
 *
 * `null` is kept rather than dropped: a package that could not be resolved is a
 * fact about the environment, and a silently shorter list reads as "this run
 * did not depend on it".
 */
export function resolvedPackages(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of TRACKED_PACKAGES) out[name] = installedVersion(name) ?? 'nieustalona';
  return { ...out, ...extra };
}

/** Result of asking a command for its version; never throws. */
function commandVersion(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')[0]!;
  } catch {
    return null;
  }
}

/** Memoised: both answers cost a process and neither changes during a run. */
let cachedPnpm: string | null | undefined;
let cachedExternalCli: string | null | undefined;

/**
 * The CLI **inside** the SDK, which is not the CLI on the PATH.
 *
 * The SDK ships its own `claude` binary and a `manifest.json` naming its
 * version, commit and build date. That version and the one `claude --version`
 * prints drift apart — on the machine this was written they were 2.1.270 and
 * 2.1.277 — and a run goes through the SDK's copy. A record that names only the
 * SDK package version (0.3.x) or only the external CLI therefore does not say
 * which agent produced the result. Kryterium L1.12 says this in as many words:
 * the lockfile is not the only source of the CLI version.
 */
export function sdkCliVersion(): { wersja: string; commit: string; dataBudowy: string } | null {
  for (const base of ['packages/platform-server/package.json', 'apps/server/package.json', 'package.json']) {
    const from = resolve(REPO_ROOT, base);
    if (!existsSync(from)) continue;
    try {
      const require = createRequire(from);
      const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
      let dir = dirname(entry);
      for (let i = 0; i < 6; i += 1) {
        const manifest = resolve(dir, 'manifest.json');
        if (existsSync(manifest)) {
          const json = JSON.parse(readFileSync(manifest, 'utf8')) as {
            version?: string;
            commit?: string;
            buildDate?: string;
          };
          if (json.version) {
            return {
              wersja: json.version,
              commit: json.commit ?? 'nieznany',
              dataBudowy: json.buildDate ?? 'nieznana',
            };
          }
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      /* try the next base */
    }
  }
  return null;
}

export interface Environment {
  /** Operating system and architecture, without any local path. */
  system: string;
  node: string;
  pnpm: string | null;
  /** CLI found on PATH — may differ from the one the SDK runs. */
  cliZewnetrzne: string | null;
  /** CLI shipped inside the SDK: the one an agent run actually executes. */
  cliWSdk: { wersja: string; commit: string; dataBudowy: string } | null;
  /** Model the instance is configured with, when the run set one. */
  model: string | null;
  pakiety: Record<string, string>;
}

/**
 * Where the result was produced — the half of provenance the commit does not
 * cover.
 *
 * No absolute path, user name or home directory is recorded: an evidence file
 * is published with the repository, and the acceptance conditions forbid local
 * paths and secrets in it.
 */
export function environment(extraPackages: Record<string, string> = {}): Environment {
  cachedPnpm = cachedPnpm === undefined ? commandVersion('pnpm', ['--version']) : cachedPnpm;
  cachedExternalCli =
    cachedExternalCli === undefined ? commandVersion('claude', ['--version']) : cachedExternalCli;
  return {
    system: `${platform()} ${release()} ${arch()}`,
    node: process.versions.node,
    pnpm: cachedPnpm,
    cliZewnetrzne: cachedExternalCli,
    cliWSdk: sdkCliVersion(),
    model: process.env.APP_MODEL ?? null,
    pakiety: resolvedPackages(extraPackages),
  };
}

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

/**
 * `dir` defaults to this file's own task directory. A later task passes its
 * own: the switch, the "assert always, write on request" rule and the file
 * format are the mechanism worth sharing — the directory is not, and a second
 * copy of this module for the sake of one constant would be exactly the
 * duplication that makes a fix apply to one of the copies.
 */
function emit(fileName: string, body: string, dir: string = EVIDENCE_DIR): EvidenceResult {
  const directory = resolve(process.cwd(), dir);
  const path = resolve(directory, fileName);
  if (!evidenceWritingRequested()) return { path, body, written: false };
  mkdirSync(directory, { recursive: true });
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

/**
 * The commit the measurement was taken on, and whether the tree was clean.
 *
 * `evidenceDirs` are the directories this regeneration is itself rewriting; a
 * task writing into its own directory passes it, for the reason below.
 */
export function codeVersion(
  pakiety: Record<string, string> = {},
  evidenceDirs: readonly string[] = [EVIDENCE_DIR],
): CodeVersion {
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
  const status = git([
    'status',
    '--porcelain',
    '--',
    ':(top)',
    ...evidenceDirs.map((dir) => `:(exclude,top)${dir}`),
  ]);
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
  /**
   * How it was executed, in the repository's own vocabulary.
   *
   * Required by the type, not by a convention: a reader's first question about
   * any number here is whether a real model produced it, a stand-in did, or
   * nobody ran anything. Leaving it out was possible, and it was left out.
   */
  rodzajWykonania: ExecutionKind;
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
  /** The task's own evidence directory; defaults to this module's. */
  dir: string = EVIDENCE_DIR,
): EvidenceResult {
  const wersjaKodu = record.wersjaKodu ?? codeVersion();
  const body = {
    opis: record.opis,
    zrodlo: record.zrodlo,
    rodzajWykonania: record.rodzajWykonania,
    zapisano: new Date().toISOString(),
    wersjaKodu,
    srodowisko: environment(),
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
  return emit(fileName, `${JSON.stringify(body, null, 2)}\n`, dir);
}

/**
 * Anything a proof file carries, plus the three things every one of them must.
 *
 * `rodzajWykonania` is required; the rest of the shape is the caller's. The
 * index signature is what lets a caller keep its own vocabulary — this module
 * has no business naming the fields of somebody else's proof.
 */
export interface EvidenceBody {
  rodzajWykonania: ExecutionKind;
  /** Overrides the automatic one, e.g. to exclude the task's own directory. */
  wersjaKodu?: CodeVersion;
  [key: string]: unknown;
}

/**
 * Writes a non-measurement proof (correlation, error classes, secret scan).
 *
 * Every file gets the same envelope: when it was written, from which commit and
 * whether the tree was clean, in which environment, and how it was executed.
 * Kryterium L12.10 asks exactly that of *each* proof — until this envelope
 * existed, a result from the template was indistinguishable from one carried
 * over from another application, and a stale result could keep confirming an
 * integration that had since changed.
 */
export function writeEvidence(
  fileName: string,
  body: EvidenceBody,
  dir: string = EVIDENCE_DIR,
): EvidenceResult {
  const { rodzajWykonania, wersjaKodu, ...rest } = body;
  const envelope = {
    zapisano: new Date().toISOString(),
    rodzajWykonania,
    wersjaKodu: wersjaKodu ?? codeVersion(undefined, [dir]),
    srodowisko: environment(),
    ...rest,
  };
  return emit(fileName, `${JSON.stringify(envelope, null, 2)}\n`, dir);
}
