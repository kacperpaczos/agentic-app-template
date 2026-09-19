/**
 * Where `pnpm acceptance` and `scripts/run-agent.mjs` are allowed to write, and
 * the check that is made before the first request leaves the process.
 *
 * **The defect this removes.** Both scripts defaulted to
 * `http://127.0.0.1:8791` — the port an *installed* instance of this
 * application listens on — and asked nobody who was answering there. They are
 * not read-only: the documented scenarios change the quantity of an offer item
 * and add cards to a canvas space. On a machine where the user's own instance
 * was running, a probe with a real model started from a shell therefore wrote
 * through the user's data, and nothing in the output said which instance had
 * answered. README warned about it; a warning is not a control.
 *
 * **Two changes, both needed, and the same pair the development proxy uses**
 * (`apps/web/src/dev-proxy.ts`). The target is configurable and its default is
 * deliberately *not* the installed application's port, so reaching it takes a
 * deliberate setting rather than a default. And before anything is sent, the
 * instance is asked who it is on `/api/health`: an answer without one of the
 * labels below means something else is listening — most likely the user's own
 * instance, which carries no label at all — and the run stops with a readable
 * message instead of writing.
 *
 * The identity mechanism is the one the suites already use (the label on
 * `/api/health`), not a second one invented here. Only the policy differs: the
 * development proxy answers 502 and keeps retrying because its backend may
 * still be starting; an acceptance run has nothing to wait for and stops.
 *
 * Kryteria: L1.8 (konfiguracja kierująca próbę na instancję użytkownika jest
 * odrzucana przed operacją zapisu).
 */

/** Port an installed instance listens on when nobody configures one. */
export const USER_APP_PORT = 8791;

/** Ports reserved for the automated suites (`e2e/support/isolation.ts`). */
export const TEST_PORT_RANGE = { from: 8792, to: 8799 };

/**
 * Where an acceptance run goes when nobody says otherwise.
 *
 * Deliberately the development backend's port, not {@link USER_APP_PORT}: the
 * accident this module exists to prevent must not be the default behaviour.
 */
export const DEFAULT_ACCEPTANCE_PORT = 8790;
export const DEFAULT_ACCEPTANCE_BASE = `http://127.0.0.1:${DEFAULT_ACCEPTANCE_PORT}`;

/**
 * Labels an acceptance run may write through.
 *
 * Every one of them is set by something in this repository: `pnpm dev` sets
 * `agenticapp-dev`, the suites set `agenticapp-test`, and an instance started
 * by hand for an acceptance run is expected to set `agenticapp-acceptance`. An
 * installed instance sets none — `instanceLabel` is `null` there — so the
 * absence of a label is exactly the case that must be refused, and it is the
 * default case.
 */
export const ACCEPTANCE_LABELS = ['agenticapp-dev', 'agenticapp-test', 'agenticapp-acceptance'];

export class AcceptanceTargetError extends Error {
  constructor(message) {
    super(`[proba odbiorowa] ${message}\nZadne zadanie nie zostalo wyslane.`);
    this.name = 'AcceptanceTargetError';
  }
}

/**
 * Resolves the target from `APP_BASE`, refusing the addresses that would mean
 * somebody else's instance.
 *
 * `APP_BASE` is honoured but not trusted: the installed application's port and
 * any address that is not loopback are refused with the reason, rather than
 * silently used.
 */
export function resolveAcceptanceTarget(env = {}) {
  const raw = env.APP_BASE ?? DEFAULT_ACCEPTANCE_BASE;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AcceptanceTargetError(`APP_BASE: "${raw}" nie jest poprawnym adresem URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AcceptanceTargetError(`APP_BASE: ${url.protocol} nie jest adresem HTTP.`);
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') {
    throw new AcceptanceTargetError(
      `APP_BASE: ${url.origin} nie jest adresem petli zwrotnej — proba odbiorowa nie wychodzi poza localhost.`,
    );
  }
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (port === USER_APP_PORT) {
    throw new AcceptanceTargetError(
      `APP_BASE: ${url.origin} to domyslny port zainstalowanej aplikacji (${USER_APP_PORT}) — ` +
        'tam moze dzialac instancja uzytkownika z jego danymi, a ta proba wykonuje zapisy ' +
        '(zmiana ilosci pozycji, dodanie kart). ' +
        `Uruchom osobna instancje z osobnym katalogiem danych (domyslnie ${DEFAULT_ACCEPTANCE_BASE}).`,
    );
  }
  return { base: url.origin, port, allowedLabels: [...ACCEPTANCE_LABELS] };
}

/**
 * Asks the target who it is.
 *
 * Returns `null` when the instance may be written through, and a sentence to
 * print otherwise. Unreachable is its own answer and is also a refusal: an
 * acceptance run has no reason to wait for a backend that is not there, and
 * "nothing answered" must never be read as "nothing objected".
 */
export async function checkAcceptanceInstance(target, fetchImpl = fetch) {
  let label;
  try {
    const res = await fetchImpl(`${target.base}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    label = body?.instanceLabel ?? null;
  } catch (e) {
    return (
      `Instancja pod ${target.base} nie odpowiada na /api/health (${(e && e.message) || String(e)}). ` +
      `Uruchom instancje odbiorowa z osobnym katalogiem danych i etykieta, np. ` +
      `APP_INSTANCE_LABEL=agenticapp-acceptance APP_DATA_DIR=<katalog> PORT=${DEFAULT_ACCEPTANCE_PORT} pnpm start.`
    );
  }
  if (!target.allowedLabels.includes(label)) {
    return (
      `Pod ${target.base} odpowiada instancja z etykieta ${JSON.stringify(label)}, ` +
      `a proba odbiorowa wykonuje zapisy i wymaga jednej z: ${target.allowedLabels.join(', ')}. ` +
      'Instancja uzytkownika nie ma zadnej etykiety, wiec tak wyglada wlasnie ona — ' +
      'nic nie zostalo zapisane. Ustaw APP_INSTANCE_LABEL na wlasnej instancji albo wskaz APP_BASE.'
    );
  }
  return null;
}

/**
 * The whole gate: resolve, ask, and stop before the first write.
 *
 * Both scripts call this as their first statement, before the session cookie is
 * fetched — `/api/auth/session` is itself a POST, and a POST to the user's
 * instance is already the thing this prevents.
 */
export async function requireAcceptanceInstance(env = {}, fetchImpl = fetch) {
  const target = resolveAcceptanceTarget(env);
  const problem = await checkAcceptanceInstance(target, fetchImpl);
  if (problem) throw new AcceptanceTargetError(problem);
  return target;
}
