import { describe, expect, it } from 'vitest';
import { judgeStream, type StreamRecording } from '../e2e/support/streamProbe.ts';

/**
 * The rule that turns observations into a verdict, driven directly.
 *
 * The browser tests in `e2e/streaming.spec.ts` prove the *recording* is
 * faithful — that the probe sees what the page does. These prove the *rule* is
 * right, including for recordings a browser cannot be asked to produce on
 * demand: text that only appears after the run resolved, a length that goes
 * backwards, a repaint that changes nothing.
 *
 * Splitting it this way is what makes the browser suite small enough to run
 * every time and the rule complete enough to trust.
 */

const rec = (
  samples: Array<[t: number, len: number, phase: string | null]>,
  terminalAt: number | null,
  finalText: string,
): StreamRecording => ({
  samples: samples.map(([t, len, phase]) => ({ t, len, phase, text: 'x'.repeat(len) })),
  terminalAt,
  finalText,
});

describe('judgeStream', () => {
  it('przyrost w trakcie wykonania to strumieniowanie', () => {
    const v = judgeStream(
      rec([[10, 5, 'running'], [20, 12, 'running'], [30, 30, 'running']], 40, 'x'.repeat(30)),
    );
    expect(v.streamed).toBe(true);
    expect(v.distinctLengthsWhileRunning).toBe(3);
    expect(v.sawPartialAnswer).toBe(true);
  });

  it('cala tresc naraz przed koncem to nie strumieniowanie', () => {
    // One sample, already the full answer: the user never saw it incomplete.
    const v = judgeStream(rec([[10, 30, 'running']], 20, 'x'.repeat(30)));
    expect(v.streamed).toBe(false);
    expect(v.reason).toMatch(/tylko raz/);
  });

  it('dwie probki o pelnej dlugosci to nadal nie strumieniowanie', () => {
    // A repaint is not growth — this is the case a length-change-blind check
    // would wave through.
    const v = judgeStream(rec([[10, 30, 'running'], [15, 30, 'running']], 20, 'x'.repeat(30)));
    expect(v.streamed).toBe(false);
    expect(v.reason).toMatch(/tej samej dlugosci/);
  });

  it('tresc widziana tylko po zakonczeniu nie zalicza asercji', () => {
    const v = judgeStream(rec([[30, 10, 'succeeded'], [40, 30, 'succeeded']], 25, 'x'.repeat(30)));
    expect(v.streamed).toBe(false);
    expect(v.whileRunning).toHaveLength(0);
    expect(v.reason).toMatch(/nie zaobserwowano/);
  });

  it('probka z faza koncowa nie liczy sie nawet przy rownym czasie', () => {
    // Timestamp ties do happen when the terminal attribute and the committed
    // message land in the same tick; the phase decides, not the clock.
    const v = judgeStream(rec([[10, 4, 'running'], [25, 30, 'succeeded']], 25, 'x'.repeat(30)));
    expect(v.whileRunning).toHaveLength(1);
    expect(v.streamed).toBe(false);
  });

  it('malejaca dlugosc jest odrzucona jako inna wiadomosc', () => {
    const v = judgeStream(rec([[10, 20, 'running'], [20, 8, 'running'], [30, 25, 'running']], 40, 'x'.repeat(25)));
    expect(v.streamed).toBe(false);
    expect(v.monotonic).toBe(false);
    expect(v.reason).toMatch(/malala/);
  });

  it('brak jakiejkolwiek tresci to brak strumieniowania', () => {
    const v = judgeStream(rec([], 20, ''));
    expect(v.streamed).toBe(false);
    expect(v.finalLength).toBe(0);
  });

  it('puste probki nie sa liczone jako tresc', () => {
    const v = judgeStream(rec([[5, 0, 'running'], [10, 0, 'running'], [20, 9, 'running']], 30, 'x'.repeat(9)));
    expect(v.whileRunning).toHaveLength(1);
    expect(v.streamed).toBe(false);
  });

  it('expectedFragment odrzuca tresc innej odpowiedzi', () => {
    const recording: StreamRecording = {
      samples: [
        { t: 10, len: 8, text: 'poprzedni', phase: 'running' },
        { t: 20, len: 16, text: 'poprzedni + coś', phase: 'running' },
      ],
      terminalAt: 30,
      finalText: 'ZNACZNIK pelna odpowiedz',
    };
    const v = judgeStream(recording, { expectedFragment: 'ZNACZNIK' });
    expect(v.whileRunning).toHaveLength(0);
    expect(v.streamed).toBe(false);
  });

  it('expectedFragment przyjmuje tresc wlasciwej odpowiedzi', () => {
    const recording: StreamRecording = {
      samples: [
        { t: 10, len: 10, text: 'ZNACZNIK a', phase: 'running' },
        { t: 20, len: 14, text: 'ZNACZNIK abcde', phase: 'running' },
      ],
      terminalAt: 30,
      finalText: 'ZNACZNIK abcde fghij',
    };
    const v = judgeStream(recording, { expectedFragment: 'ZNACZNIK' });
    expect(v.streamed).toBe(true);
  });

  it('krotszy tekst po zlozeniu nie unieważnia zaobserwowanego przyrostu', () => {
    /*
     * Measured on a real run: 582 characters streaming, 527 once committed —
     * the live preview is raw text and the committed message is rendered
     * markdown, which can be shorter. The growth happened; comparing only
     * against the committed length would deny it.
     */
    const v = judgeStream(rec([[10, 70, 'running'], [20, 300, 'running'], [30, 582, 'running']], 40, 'x'.repeat(527)));
    expect(v.streamed).toBe(true);
    expect(v.sawPartialAnswer).toBe(true);
  });

  it('pojedyncza pelna probka nadal przepada, choc tekst po zlozeniu jest krotszy', () => {
    // The relaxation above must not let the burst-at-end case through.
    const v = judgeStream(rec([[10, 582, 'running']], 20, 'x'.repeat(527)));
    expect(v.streamed).toBe(false);
    expect(v.reason).toMatch(/tylko raz/);
  });

  it('brak fazy koncowej nie unieważnia obserwacji w trakcie', () => {
    // A run still open when the recording was read: everything observed counts.
    const v = judgeStream(rec([[10, 5, 'running'], [20, 11, 'running']], null, 'x'.repeat(20)));
    expect(v.streamed).toBe(true);
  });
});
