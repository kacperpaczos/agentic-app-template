import { describe, expect, it } from 'vitest';
import { parseToolContent } from '../e2e/support/show-value-probe.ts';

/**
 * A tool's answer has **two shapes**, and a reader that knows only one passes
 * the rehearsal and fails on the paid run.
 *
 * This is not a hypothetical. It has now cost two model turns in this
 * repository, in two different packages:
 *
 *  - proba T25's first real-model run, which reported a failure while the
 *    application had done everything right;
 *  - BL-03 przebieg E, turn 1 of a 16-turn grant: the agent searched, walked the
 *    relations and answered correctly, and the assertion read `undefined`.
 *
 * The cause both times is the same. A scripted stand-in fires `PostToolUse` with
 * the handler's answer as **text**, so the event log stores the object. The real
 * Claude Agent SDK fires it with the MCP result, so the event log stores the
 * protocol's **content blocks**. Everything between — the runtime, the stream,
 * the projection — is identical, which is why nothing else notices.
 *
 * So the unwrapping has one home (`e2e/support/show-value-probe.ts`) and this
 * test pins both shapes to it. A future reader that reaches for `JSON.parse`
 * will still be wrong, but it will be wrong against a documented, executable
 * statement of what the two paths look like.
 */
describe('wynik narzedzia ma dwa ksztalty i czytamy oba', () => {
  const answer = { cardId: 'crd_1', specVersion: 3, geometry: { x: 0, y: 0 } };

  it('stand-in: wynik zapisany jako sam obiekt', () => {
    expect(parseToolContent(JSON.stringify(answer))).toEqual(answer);
  });

  it('prawdziwy SDK: wynik zapisany jako bloki tresci MCP', () => {
    const asMcp = JSON.stringify([{ type: 'text', text: JSON.stringify(answer) }]);
    expect(parseToolContent(asMcp)).toEqual(answer);
  });

  it('kilka blokow tresci sklada sie w jedna odpowiedz', () => {
    const text = JSON.stringify(answer);
    const split = JSON.stringify([
      { type: 'text', text: text.slice(0, 10) },
      { type: 'text', text: text.slice(10) },
    ]);
    expect(parseToolContent(split)).toEqual(answer);
  });

  it('narzedzie odpowiadajace proza zostaje czytelne, a nie wybucha', () => {
    const prose = JSON.stringify([{ type: 'text', text: 'Nie znalazlem takiej pozycji.' }]);
    expect(parseToolContent(prose)).toEqual({ text: 'Nie znalazlem takiej pozycji.' });
  });

  /**
   * The control that matters: a bare `JSON.parse` — the reader that looks
   * obviously correct — gets the MCP shape wrong **silently**. No exception, no
   * missing key error, just an object whose fields are all `undefined`.
   */
  it('samo JSON.parse myli sie na ksztalcie SDK po cichu', () => {
    const asMcp = JSON.stringify([{ type: 'text', text: JSON.stringify(answer) }]);
    const naive = JSON.parse(asMcp) as { cardId?: string };
    expect(naive.cardId).toBeUndefined();
    expect((parseToolContent(asMcp) as { cardId: string }).cardId).toBe('crd_1');
  });
});
