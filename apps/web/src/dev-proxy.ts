import { readInstanceLabel, DEFAULT_APP_PORT, TEST_PORT_RANGE } from '../../../e2e/support/isolation.ts';

/**
 * Where `pnpm dev` sends `/api`, and the check that it is the right place.
 *
 * **The defect this removes.** The development proxy named
 * `http://localhost:8791` literally, and 8791 is the port an *installed*
 * instance of this application listens on. Running `pnpm dev` on a machine that
 * already had one therefore pointed the development frontend at somebody's real
 * data: the session, the conversations, the canvas and every mutation went
 * through it, and nothing on screen said which instance answered. The README
 * warned about it, which is not the same as preventing it.
 *
 * **Two changes, both needed.** The target is configurable and its default is
 * *not* the installed application's port — so the accident needs a deliberate
 * setting rather than a default. And before the proxy forwards anything, the
 * instance is asked who it is: `pnpm dev` starts the backend with
 * `APP_INSTANCE_LABEL=agenticapp-dev`, and an answer without that label means
 * something else is listening, so the request is refused with a readable
 * message instead of being sent.
 *
 * The identity mechanism is the one the test suites already use — the label on
 * `/api/health`, read by `readInstanceLabel` — rather than a second one
 * invented here. Only the policy differs: a test run stops, the development
 * proxy answers 502 and keeps retrying, because the backend may simply not have
 * finished starting.
 */

/** Label `pnpm dev` gives its backend; anything else is not our dev instance. */
export const DEV_INSTANCE_LABEL = 'agenticapp-dev';

/**
 * Port the development backend uses when nobody configures one.
 *
 * Deliberately not {@link DEFAULT_APP_PORT}: that is where an installed
 * instance listens, and the whole point is that the development mode cannot
 * land on it by default.
 */
export const DEFAULT_DEV_API_PORT = 8790;

export interface DevApiTarget {
  port: number;
  /** Origin the proxy forwards to, e.g. `http://127.0.0.1:8790`. */
  target: string;
  expectedLabel: string;
}

export class DevProxyError extends Error {
  constructor(message: string) {
    super(`[tryb deweloperski] ${message}`);
    this.name = 'DevProxyError';
  }
}

/**
 * Resolves the development API target from the environment, refusing the two
 * ports that would mean somebody else's instance.
 *
 * `APP_DEV_API_PORT` is honoured but not trusted — the installed application's
 * port and the range reserved for automated tests are both refused, with the
 * reason, rather than silently used.
 */
export function resolveDevApi(env: Record<string, string | undefined> = {}): DevApiTarget {
  const raw = env.APP_DEV_API_PORT ?? String(DEFAULT_DEV_API_PORT);
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new DevProxyError(`APP_DEV_API_PORT: "${raw}" nie jest numerem portu.`);
  }
  if (port === DEFAULT_APP_PORT) {
    throw new DevProxyError(
      `APP_DEV_API_PORT: ${port} to domyslny port zainstalowanej aplikacji — ` +
        'tam moze dzialac instancja uzytkownika z jego danymi. ' +
        `Uruchom backend deweloperski na innym porcie (domyslnie ${DEFAULT_DEV_API_PORT}).`,
    );
  }
  if (port >= TEST_PORT_RANGE.from && port <= TEST_PORT_RANGE.to) {
    throw new DevProxyError(
      `APP_DEV_API_PORT: ${port} nalezy do zakresu zarezerwowanego dla testow ` +
        `(${TEST_PORT_RANGE.from}-${TEST_PORT_RANGE.to}).`,
    );
  }
  return { port, target: `http://127.0.0.1:${port}`, expectedLabel: DEV_INSTANCE_LABEL };
}

/**
 * Asks the target who it is.
 *
 * Returns `null` when it is the development instance this mode belongs to, and
 * a sentence to show the developer otherwise — unreachable is its own answer,
 * because a backend that has not finished starting is a normal state a moment
 * after `pnpm dev`, not a reason to give up.
 */
export async function checkDevInstance(api: DevApiTarget): Promise<string | null> {
  const answer = await readInstanceLabel(api.target);
  if ('unreachable' in answer) {
    return (
      `Backend deweloperski pod ${api.target} nie odpowiada na /api/health (${answer.unreachable}). ` +
      'Nic nie zostalo wyslane. Uruchom `pnpm dev` w calosci albo popraw APP_DEV_API_PORT.'
    );
  }
  if (answer.label !== api.expectedLabel) {
    return (
      `Pod ${api.target} odpowiada instancja z etykieta ${JSON.stringify(answer.label)}, ` +
      `a tryb deweloperski wymaga ${JSON.stringify(api.expectedLabel)}. ` +
      'To moze byc instancja uzytkownika — zadanie nie zostalo przekazane. ' +
      'Uruchom backend przez `pnpm dev` (ustawia APP_INSTANCE_LABEL) albo wskaz inny port.'
    );
  }
  return null;
}

/**
 * The check, remembered once it succeeds.
 *
 * A failure is not remembered on purpose: the usual failure is "the backend is
 * still starting", and a developer should not have to restart Vite because it
 * won the race.
 */
export function devInstanceGate(api: DevApiTarget): () => Promise<string | null> {
  let verified = false;
  return async () => {
    if (verified) return null;
    const problem = await checkDevInstance(api);
    if (!problem) verified = true;
    return problem;
  };
}
