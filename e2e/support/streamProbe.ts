import type { Page } from '@playwright/test';

/**
 * Evidence that an answer *streamed*, as opposed to merely arriving.
 *
 * The previous version of this check polled the page from Node and asked the
 * backend for the run status between reads. That made the result depend on
 * timing the test does not control: two round trips per sample, a ~150 ms gap
 * between them, and a race in which the run could resolve between reading the
 * text and reading the status. It passed on one full run of the suite and
 * failed on another with `odpowiedz pojawila sie dopiero po zakonczeniu` —
 * against the same code. A check that reports a different verdict for identical
 * behaviour is not evidence of anything.
 *
 * This observes from inside the page instead. A `MutationObserver` records the
 * answer's text on every change, with `performance.now()` and the run phase at
 * that instant, so no sample can be missed between polls and no sample can be
 * misattributed to the wrong phase. Nothing is sampled: every change is seen.
 *
 * **What counts as the answer.** Only `[data-testid="streaming-answer"]` (the
 * live preview while the turn is open) and `[data-testid="assistant-message"]`
 * (the committed message body). Both are the assistant's prose and nothing
 * else — the composer, the conversation starters, the user's own message and
 * the tool-call timeline are all outside them, which is what stops those from
 * satisfying a streaming assertion. `streaming.spec.ts` proves that exclusion
 * with a run that calls a tool and says nothing: the starters and the user
 * message are on screen throughout, and the probe records no answer at all.
 *
 * **One element, never a sum.** The two overlap for a moment when the turn
 * resolves: the preview is still on screen as the thread commits the message.
 * Concatenating them made the measured length *double* at that instant, which
 * a growth check reads as a jump — and it wrongly passed a reply delivered in
 * one burst at the end (107 → 214 characters of the same 107-character answer).
 * So the preview is the answer while it exists, and the newest committed
 * message afterwards.
 */

const TERMINAL_PHASES = ['succeeded', 'failed', 'cancelled'] as const;

export interface AnswerSample {
  /** `performance.now()` at the moment the text changed. */
  t: number;
  len: number;
  text: string;
  /** Run phase read in the same tick, from the run's own lifecycle events. */
  phase: string | null;
}

export interface StreamRecording {
  samples: AnswerSample[];
  /** When the run reached a terminal phase; null if it never did. */
  terminalAt: number | null;
  finalText: string;
}

export interface StreamVerdict {
  streamed: boolean;
  reason: string;
  /** Samples observed strictly before the run reached a terminal phase. */
  whileRunning: AnswerSample[];
  distinctLengthsWhileRunning: number;
  firstLengthWhileRunning: number | null;
  lastLengthWhileRunning: number | null;
  finalLength: number;
  monotonic: boolean;
  /** True when the user saw an incomplete answer at some point during the run. */
  sawPartialAnswer: boolean;
}

/**
 * Starts recording. Call before sending the command.
 *
 * Safe to call again on the same page: the previous recording is replaced, so a
 * test may measure a second turn without stale samples from the first.
 */
export async function startStreamProbe(page: Page): Promise<void> {
  await page.evaluate((terminal) => {
    const w = window as unknown as {
      __streamProbe?: { samples: unknown[]; terminalAt: number | null; stop: () => void };
    };
    w.__streamProbe?.stop();

    const answerText = () => {
      const live = document.querySelector('[data-testid="streaming-answer"]');
      if (live) return live.textContent ?? '';
      const committed = document.querySelectorAll('[data-testid="assistant-message"]');
      return committed.length ? (committed[committed.length - 1]!.textContent ?? '') : '';
    };

    const state = { samples: [] as Array<Record<string, unknown>>, terminalAt: null as number | null };

    const snapshot = () => {
      const t = performance.now();
      const phase =
        document.querySelector('[data-testid="run-state"]')?.getAttribute('data-phase') ?? null;
      if (state.terminalAt === null && phase && terminal.includes(phase)) state.terminalAt = t;
      const text = answerText();
      const last = state.samples[state.samples.length - 1] as { text?: string } | undefined;
      if (!last || last.text !== text) state.samples.push({ t, len: text.length, text, phase });
    };

    const observer = new MutationObserver(snapshot);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-phase'],
    });
    /*
     * A slow heartbeat alongside the observer. Not a poll — the observer is what
     * catches the changes — but it guarantees the terminal phase is recorded
     * even if the very last DOM change lands in the same tick the observer is
     * disconnected.
     */
    const timer = window.setInterval(snapshot, 50);

    snapshot();
    w.__streamProbe = {
      samples: state.samples,
      get terminalAt() {
        return state.terminalAt;
      },
      stop: () => {
        observer.disconnect();
        window.clearInterval(timer);
      },
    } as never;
  }, TERMINAL_PHASES as unknown as string[]);
}

/** Stops recording and returns everything observed. */
export async function readStreamProbe(page: Page): Promise<StreamRecording> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __streamProbe?: { samples: AnswerSampleLike[]; terminalAt: number | null; stop: () => void };
    };
    interface AnswerSampleLike {
      t: number;
      len: number;
      text: string;
      phase: string | null;
    }
    const probe = w.__streamProbe;
    if (!probe) throw new Error('sonda strumienia nie zostala uruchomiona');
    probe.stop();
    const live = document.querySelector('[data-testid="streaming-answer"]');
    const committed = document.querySelectorAll('[data-testid="assistant-message"]');
    const finalText = live
      ? (live.textContent ?? '')
      : committed.length
        ? (committed[committed.length - 1]!.textContent ?? '')
        : '';
    return { samples: probe.samples, terminalAt: probe.terminalAt, finalText };
  }) as Promise<StreamRecording>;
}

/**
 * Turns a recording into a verdict.
 *
 * Pure, and exported on its own so `tests/stream-verdict.test.ts` can drive it
 * with hand-written recordings — including the ones no browser run would
 * reliably produce on demand. The browser tests then prove the recording is
 * faithful; this proves the rule applied to it is right.
 *
 * Streamed means all four of:
 *  - at least two answer samples were observed **before** the run reached a
 *    terminal phase (text after the end is not streaming);
 *  - those samples had at least two different lengths (a repaint is not growth);
 *  - the length never went backwards (otherwise it is a different message);
 *  - the first answer seen while running was **shorter** than the largest answer
 *    observed, which is exactly the condition that fails when the whole reply
 *    lands in one piece at the end.
 *
 * `expectedFragment`, when given, additionally requires the samples to be of
 * *that* answer — the guard against counting some other text that happens to be
 * inside the observed elements.
 */
export function judgeStream(
  recording: StreamRecording,
  opts: { expectedFragment?: string } = {},
): StreamVerdict {
  const cutoff = recording.terminalAt;
  const relevant = recording.samples.filter(
    (s) =>
      s.len > 0 &&
      (opts.expectedFragment ? s.text.includes(opts.expectedFragment) : true) &&
      // A sample carrying a terminal phase is post-completion by definition,
      // even if its timestamp ties with the terminal one.
      !(s.phase !== null && (TERMINAL_PHASES as readonly string[]).includes(s.phase)) &&
      (cutoff === null || s.t < cutoff),
  );

  const lengths = relevant.map((s) => s.len);
  const distinct = new Set(lengths).size;
  const first = lengths.length > 0 ? lengths[0]! : null;
  const last = lengths.length > 0 ? lengths[lengths.length - 1]! : null;
  const monotonic = lengths.every((n, i) => i === 0 || n >= lengths[i - 1]!);
  const finalLength = recording.finalText.length;
  /*
   * "Did the user ever see an incomplete answer?" — compared against the
   * largest answer observed, not only against the committed one.
   *
   * The two differ: the live preview is raw text, the committed message is
   * rendered markdown, and rendering can make it *shorter*. A real run measured
   * 582 characters streaming and 527 committed. Comparing only against the
   * committed length would call a short answer "arrived whole" purely because of
   * that re-render. This does not soften the check — a reply delivered in one
   * piece still has a single sample at full length, which fails the two rules
   * above regardless.
   */
  const largestSeen = Math.max(finalLength, last ?? 0);
  const sawPartialAnswer = first !== null && first < largestSeen;

  const verdict = (streamed: boolean, reason: string): StreamVerdict => ({
    streamed,
    reason,
    whileRunning: relevant,
    distinctLengthsWhileRunning: distinct,
    firstLengthWhileRunning: first,
    lastLengthWhileRunning: last,
    finalLength,
    monotonic,
    sawPartialAnswer,
  });

  if (relevant.length === 0) {
    return verdict(false, 'w trakcie wykonania nie zaobserwowano zadnej tresci odpowiedzi');
  }
  if (relevant.length < 2) {
    return verdict(
      false,
      `w trakcie wykonania odpowiedz pojawila sie tylko raz (dlugosc ${first}) — ` +
        'to nie jest przyrost, tylko pojedyncze wyswietlenie',
    );
  }
  if (distinct < 2) {
    return verdict(
      false,
      `w trakcie wykonania widziano ${relevant.length} probek, ale wszystkie o tej samej dlugosci (${first})`,
    );
  }
  if (!monotonic) {
    return verdict(false, `dlugosc odpowiedzi malala w trakcie wykonania: ${lengths.join(' → ')}`);
  }
  if (!sawPartialAnswer) {
    return verdict(
      false,
      `pierwsza widziana odpowiedz miala juz pelna dlugosc (${first} = ${largestSeen}) — ` +
        'cala tresc pojawila sie naraz, na koncu',
    );
  }
  return verdict(
    true,
    `odpowiedz przyrastala w trakcie wykonania: ${distinct} roznych dlugosci, ${first} → ${last}, ` +
      `koncowa ${finalLength}`,
  );
}

/** One-line summary for an evidence file or a failure message. */
export function describeVerdict(v: StreamVerdict): string {
  return (
    `streamed=${v.streamed} probek=${v.whileRunning.length} roznych=${v.distinctLengthsWhileRunning} ` +
    `${v.firstLengthWhileRunning} → ${v.lastLengthWhileRunning} (koncowa ${v.finalLength}) — ${v.reason}`
  );
}
