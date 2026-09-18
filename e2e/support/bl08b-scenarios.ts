import type { Step } from './scripted-agent.ts';

/**
 * Scenarios for the events-and-stream package (BL-08b).
 *
 * All of them exist for one shape of question: what a client sees when it comes
 * back to a run that is **still going**. The continuity scenarios of BL-09 end
 * during the outage, which exercises the replay of a resolved run; these keep
 * working long enough that the client re-attaches to a live stream instead, and
 * that is a different code path (`runtime.liveStream` rather than the persisted
 * log) with different hazards — a command still waiting for an answer, a
 * question already answered, text that has not been said yet.
 *
 * Each is a whole conversation: the steps are chosen from the user's message,
 * so one instance answers several commands of one test differently.
 */

/** Said before the interruption; must not be doubled when the client returns. */
export const EARLY_MARKER = 'WYNIK-WCZESNY-B';
/** Said after it; the proof that the run went on without anybody watching. */
export const LATE_MARKER = 'WYNIK-POZNY-B';

/**
 * Long work that outlives the outage.
 *
 * The wait is deliberately longer than the cut the test performs, so the client
 * comes back to a run the backend still lists as active. A scenario that
 * finished during the outage would be answering BL-09's question again.
 */
export const liveReconnectScript = (prompt: string): Step[] =>
  prompt.includes('nawigacja')
    ? [
        /*
         * Moves the screen **before** the wire is cut, and keeps working for a
         * long time afterwards. The interface command is acknowledged while the
         * client is watching, so what matters on its return is that the command
         * is not performed a second time — from a live stream this time, not
         * from a replayed log.
         */
        { kind: 'text', text: `${EARLY_MARKER} ` , delayMs: 150 },
        { kind: 'ui', targetId: 'platform.files', label: 'pliki' },
        { kind: 'wait', delayMs: 14_000 },
        { kind: 'text', text: LATE_MARKER },
      ]
    : [
        { kind: 'text', text: `${EARLY_MARKER} `, delayMs: 150 },
        { kind: 'wait', delayMs: 14_000 },
        { kind: 'text', text: LATE_MARKER },
      ];

/** The artifact title the consent scenario publishes, once, after an approval. */
export const CONSENT_ARTIFACT_TITLE = 'Wynik po zgodzie i dlugiej pracy';

/**
 * A question, and then real work that is still running minutes later.
 *
 * Written for the reload case: BL-09's consent scenario finishes moments after
 * the decision, so a page reloaded afterwards replays a **resolved** run. Here
 * the run is still open when the page comes back, which is the case in which a
 * replayed `platform.permission_request` used to put an already-answered prompt
 * back on screen — answerable, and answering it did nothing at all.
 */
export const consentThenWorkScript = (): Step[] => [
  { kind: 'text', text: 'Przygotowalem skrypt. ', delayMs: 120 },
  {
    kind: 'ask',
    toolName: 'Bash',
    input: { command: 'node przetworz.mjs' },
    then: [
      { kind: 'wait', delayMs: 9000 },
      {
        kind: 'call',
        name: 'artifact_create',
        input: {
          title: CONSENT_ARTIFACT_TITLE,
          kind: 'report',
          rendererType: 'platform.markdown',
          content: { text: 'Operacja wykonana po zgodzie uzytkownika.' },
          /*
           * Fixed for this scenario on purpose: the test reloads the page in the
           * middle of the run, and a retry of the same operation must publish
           * the same artifact rather than a second one.
           */
          operationId: 'bl08b-zgoda-po-przeladowaniu',
        },
        maxChars: 200,
      },
    ],
  },
  { kind: 'text', text: 'KONIEC-PO-ZGODZIE' },
];
