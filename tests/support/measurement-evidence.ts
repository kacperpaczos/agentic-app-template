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
  /** True when the working tree differed from the commit while measuring. */
  brudneDrzewo: boolean;
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
  return {
    commit: git(['rev-parse', 'HEAD']) ?? 'nieznany',
    /*
     * `--porcelain` prints one line per changed path; empty output means clean.
     *
     * The evidence directory is excluded, and has to be: these files are
     * rewritten by the very run that reads this flag, so counting them would
     * make every measurement report a dirty tree and the flag would stop
     * meaning anything. Everything else counts.
     */
    brudneDrzewo:
      (git(['status', '--porcelain', '--', '.', `:(exclude)${EVIDENCE_DIR}`]) ?? '') !== '',
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
 * cannot silently drop the other's results.
 */
export function writeMeasurementRecord(
  fileName: string,
  record: Omit<MeasurementRecord, 'wersjaKodu'> & { wersjaKodu?: CodeVersion },
): string {
  const dir = resolve(process.cwd(), EVIDENCE_DIR);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, fileName);
  const wersjaKodu = record.wersjaKodu ?? codeVersion();
  const body = {
    opis: record.opis,
    zrodlo: record.zrodlo,
    zapisano: new Date().toISOString(),
    wersjaKodu,
    uwagaOJednostkach:
      'Wartosci w milisekundach zaleza od maszyny i obciazenia. Powtarzalne jest to, co ' +
      'asertuje regresja: kolejnosc punktow pomiaru, ich rozdzielenie i obecnosc albo brak metryki.',
    pomiary: Object.fromEntries(
      Object.entries(record.pomiary).map(([k, m]) => [k, { ...m, podsumowanie: summarise(m.probkiMs) }]),
    ),
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

/** Writes a non-measurement proof (correlation, error classes, secret scan). */
export function writeEvidence(fileName: string, body: unknown): string {
  const dir = resolve(process.cwd(), EVIDENCE_DIR);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, fileName);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}
