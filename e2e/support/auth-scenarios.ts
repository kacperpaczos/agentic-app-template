import { resolve } from 'node:path';
import type { CallRecord, Step } from './scripted-agent.ts';

/**
 * Authentication and limit scenarios, played at the adapter boundary (BL-04).
 *
 * **Every one of these is a simulation, and is reported as one.** The failure a
 * scenario raises is a string this file chose; it is not a limit the
 * subscription reached, a login the provider revoked or a refresh Anthropic
 * declined. What is real is everything the string then travels through: the
 * runtime's classifier, the run record, the access record, the event stream,
 * the chat, the status bar and the Settings screen. That path is what L8.6 and
 * L8.12 are about — a controlled failure at the adapter boundary has to become
 * a *distinguishable state in the interface*, and the only way to know it does
 * is to drive the failure and look at the screen.
 *
 * What the simulation cannot show is that these are the strings the SDK really
 * produces when the account runs out. Nothing here claims it does: the strings
 * below are the ones the classifier is written against, and the gap is recorded
 * against L8.11 rather than papered over.
 *
 * **The user's own login is never touched.** The scripted instance runs with
 * `CLAUDE_CONFIG_DIR` pointed at a throw-away directory holding a canary
 * credential, so an expiry these tests need is an expiry in a temporary file.
 */

/** The failure texts, named so a scenario reads as the case it stands for. */
export const SIMULATED_FAILURES = {
  usageLimit: 'Claude usage limit reached. Your limit will reset at 3pm.',
  revoked: 'Authentication error: OAuth token revoked, please run /login',
  refreshRefused: 'OAuth token refresh failed: invalid_grant',
  /* Neither a limit nor a login: the third thing L8.11 says must stay apart. */
  network: 'socket hang up',
} as const;

/** A run that says something and then hits the usage limit. */
export const limitScript: Step[] = [
  { kind: 'text', text: 'Zaczynam prace nad zestawieniem. ', delayMs: 150 },
  { kind: 'fail', message: SIMULATED_FAILURES.usageLimit },
];

/** A run whose login has been revoked. */
export const revokedScript: Step[] = [
  { kind: 'text', text: 'Zaczynam. ', delayMs: 150 },
  { kind: 'fail', message: SIMULATED_FAILURES.revoked },
];

/** A run whose expired token the SDK could not renew. */
export const refreshRefusedScript: Step[] = [
  { kind: 'text', text: 'Zaczynam. ', delayMs: 150 },
  { kind: 'fail', message: SIMULATED_FAILURES.refreshRefused },
];

/** A run that loses the connection — not a limit and not a login. */
export const networkScript: Step[] = [
  { kind: 'text', text: 'Zaczynam. ', delayMs: 150 },
  { kind: 'fail', message: SIMULATED_FAILURES.network },
];

/**
 * A run that succeeds while the local credential's recorded expiry is in the
 * past.
 *
 * The case L8.10 is about: an expired `expiresAt` is a statement about a file,
 * not a verdict on access, because the SDK holds a refresh token and renews on
 * its own. The application must therefore not refuse to start, and after a
 * successful call it must report access as confirmed **while still showing the
 * expiry as passed** — two different facts on two different rows.
 */
export const expiredButWorkingScript: Step[] = [
  { kind: 'wait', delayMs: 150 },
  { kind: 'call', name: 'procurement_list_cases', maxChars: 200 },
  { kind: 'text', text: 'Odczytalem sprawy mimo minionego terminu w pliku.' },
];

/**
 * A mutation, and then the limit.
 *
 * The ordering is the whole point of L8.11: the run changes durable state
 * through a real tool handler and *then* fails. Three things have to hold
 * afterwards and none of them holds by itself — the effect happened exactly
 * once, the conversation still shows the step and the text that preceded the
 * failure, and nothing retries the mutation on its own.
 *
 * `operationId` is minted per invocation rather than fixed, deliberately. A
 * constant key would make a repeat *replay* instead of creating a second
 * artifact, so the test would pass even if something did retry — the harness
 * would be hiding the very thing the criterion asks about.
 */
export const mutationThenLimitScript = (prompt: string): Step[] =>
  prompt.includes('ponow')
    ? [
        { kind: 'text', text: 'Powtarzam na prosbe uzytkownika. ', delayMs: 120 },
        { kind: 'text', text: 'Koniec.' },
      ]
    : [
        { kind: 'call', name: 'procurement_list_cases', maxChars: 200 },
        {
          kind: 'call',
          name: 'procurement_save_comparison',
          input: (calls: CallRecord[]) => {
            const listed = calls.find((c) => c.name === 'procurement_list_cases');
            const found = listed?.result?.cases?.find((c: { code: string }) => c.code === 'PC-2026-01');
            if (!found) throw new Error('scenariusz: brak sprawy PC-2026-01');
            return {
              caseId: found.id,
              title: 'Zestawienie sprzed limitu',
              operationId: `e2e-limit-${Date.now()}`,
            };
          },
          maxChars: 200,
        },
        { kind: 'text', text: 'Zapisalem zestawienie. ', delayMs: 150 },
        { kind: 'fail', message: SIMULATED_FAILURES.usageLimit },
      ];

/**
 * A run that reaches for the login file.
 *
 * `CLAUDE_CONFIG_DIR` is where the scripted instance was pointed, so the file
 * this opens is the canary one — and if the application's protection were
 * missing, its contents would appear in the chat, which is exactly what the
 * browser test looks for.
 */
export const credentialReadScript = (): Step[] => {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? '';
  return [
    { kind: 'text', text: 'Sprawdzam plik logowania. ', delayMs: 120 },
    { kind: 'fileTool', name: 'Read', input: { file_path: resolve(dir, '.credentials.json') } },
    { kind: 'text', text: 'Koniec proby.' },
  ];
};
