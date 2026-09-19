import { expect, type Page } from '@playwright/test';
import {
  Z11_SPEC_TURNS,
  Z11_TURN_BUDGET,
  readZ11Ledger,
  writeZ11Ledger,
  writeZ11Evidence,
  z11Preflight,
  z11RunEvidenceDir,
  type Z11ModelSpecFile,
} from './model-turns.ts';
import { typeCommand, type SentCommand } from './bl03-checks.ts';

/**
 * What a paid BL-03 spec needs beyond the checks: the budget, the ledger and
 * the evidence file.
 *
 * Separate from `bl03-checks.ts` on purpose. Those helpers are shared with the
 * rehearsal and must stay free of anything that spends or records a turn — a
 * rehearsal that wrote to the ledger would make the grant's own accounting
 * fiction. Everything in *this* file is only ever reached from a spec that has
 * both switches set.
 */

export interface PaidRun {
  /** Sends a command, after writing the turn down and refusing to overspend. */
  command: (page: Page, text: string) => Promise<SentCommand>;
  /** Turns this spec has sent so far, for the evidence record. */
  spent: () => number;
  /** Everything recorded about this run so far, appended as it goes. */
  log: Array<Record<string, unknown>>;
  /** Writes the run's evidence file. Safe to call from a `finally`. */
  save: (name: string, body: Record<string, unknown>) => void;
  evidenceDir: string;
}

/**
 * Pre-flight for a whole spec, asked once at load.
 *
 * Per-command guarding is not enough on its own, and the reason is recorded in
 * `model-turns.ts`: with one turn left of the grant it lets the first command
 * through, the first command spends a real turn, and the second trips the
 * guard. A paid turn is gone and nothing is proved. This refuses the spec
 * instead, as a **skip** — nothing sent, nothing claimed, no evidence touched.
 */
export function paidSpecPreflight(file: Z11ModelSpecFile) {
  const needed = Z11_SPEC_TURNS[file];
  const answer = z11Preflight(needed);
  return {
    ...answer,
    needed,
    skipReason: answer.ok
      ? null
      : `[BL-03] ${file}: ${'message' in answer ? answer.message : 'brak budzetu'}`,
  };
}

/**
 * The commander a paid spec uses.
 *
 * Writes the turn down **before** sending, and refuses over the ceiling. The
 * other order books a turn that never left the browser, which then has to be
 * unpicked by hand — observed on the BL-01/BL-02 grant, turn 19.
 */
export function paidRun(input: {
  file: Z11ModelSpecFile;
  /** Which run of the plan this is (A, B, C/D, E), written into the ledger. */
  przebieg: string;
}): PaidRun {
  const log: Array<Record<string, unknown>> = [];
  let sentHere = 0;

  const command = async (page: Page, text: string): Promise<SentCommand> => {
    const ledger = readZ11Ledger();
    const nr = ledger.wydane + 1;
    expect(
      nr,
      `grant BL-03 to ${Z11_TURN_BUDGET} tur modelu — proba wyslania tury ${nr}`,
    ).toBeLessThanOrEqual(Z11_TURN_BUDGET);
    ledger.wydane = nr;
    ledger.budzet = Z11_TURN_BUDGET;
    ledger.tury.push({
      nr,
      o: new Date().toISOString(),
      proba: input.przebieg,
      polecenie: text,
      etap: input.file,
    });
    writeZ11Ledger(ledger);
    sentHere += 1;

    const sent = await typeCommand(page, text);

    const updated = readZ11Ledger();
    const entry = updated.tury.find((t) => t.nr === nr);
    if (entry) entry.runId = sent.runId;
    writeZ11Ledger(updated);
    return sent;
  };

  return {
    command,
    spent: () => sentHere,
    log,
    evidenceDir: z11RunEvidenceDir(),
    save: (name, body) =>
      writeZ11Evidence(name, {
        spec: `e2e/${input.file}`,
        przebiegPlanu: input.przebieg,
        turyWydaneWTymPliku: sentHere,
        turyWydaneLacznie: readZ11Ledger().wydane,
        budzet: Z11_TURN_BUDGET,
        kroki: log,
        ...body,
      }),
  };
}
