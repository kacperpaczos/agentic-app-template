import type { CallRecord, Step } from './scripted-agent.ts';

/**
 * A conversation about the application context, played by the scripted model.
 *
 * Every step is a real tool call through the real runtime: `get_context` is the
 * handler the MCP server exposes, and `canvas_add_card` writes through the real
 * canvas service. The scenario chooses *when* the agent reads, which is the
 * thing a model cannot be asked for reliably — the user's hands do the rest in
 * the browser.
 *
 * Results obtained with it are simulations and are reported as such.
 */
export const appContextScript = (prompt: string): Step[] => {
  /*
   * A task long enough for the user to change their selection while it runs.
   * It reads the context twice: once at the start, once after waiting for a
   * description *newer* than the one the command carried (`waitForChange`), so
   * the second read is the user's change and not a repeat of the first.
   */
  if (prompt.includes('dlugie')) {
    return [
      { kind: 'text', text: 'Zaczynam dluga prace. ', delayMs: 200 },
      { kind: 'call', name: 'get_context', maxChars: 2000 },
      { kind: 'wait', delayMs: 1200 },
      { kind: 'call', name: 'get_context', input: { waitForChange: true, waitMs: 5000 }, maxChars: 2000 },
      { kind: 'text', text: 'Koniec dlugiej pracy.' },
    ];
  }

  /*
   * The same long task, and then a write into the space the *command* named.
   * If a later change of space were allowed to reach a task already running,
   * the card would land in the other space — which is the failure this exists
   * to make visible.
   */
  if (prompt.includes('w tle')) {
    return [
      { kind: 'text', text: 'Pracuje w tle. ', delayMs: 200 },
      { kind: 'call', name: 'get_context', maxChars: 2000 },
      { kind: 'wait', delayMs: 4000 },
      { kind: 'call', name: 'get_context', input: { waitMs: 1500 }, maxChars: 2000 },
      {
        kind: 'call',
        name: 'canvas_add_card',
        input: () => ({
          title: 'Karta zadania w tle',
          spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'z zadania w tle' } },
          operationId: 'e2e-app-context-karta-w-tle',
        }),
        maxChars: 400,
      },
      { kind: 'text', text: 'Dodalem karte.' },
    ];
  }

  /* An ordinary command: read the context once and say so. */
  return [
    { kind: 'call', name: 'get_context', maxChars: 3000 },
    { kind: 'text', text: 'Odczytalem kontekst.' },
  ];
};

/** Kept explicit so an unused-parameter rule cannot hide a scenario's dependency. */
export type AppContextCalls = CallRecord[];
