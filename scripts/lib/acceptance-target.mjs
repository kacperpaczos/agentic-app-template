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
 * **The hole this closure adds on top.** The label answers "is this *a* test
 * instance"; it is the same string for every instance ever started, so it
 * cannot answer "is this the instance *this run* was pointed at". The browser
 * suites solved that with `APP_INSTANCE_RUN_ID` (`e2e/support/isolation.ts`):
 * a value the starter generates, the server echoes on `/api/health`, and the
 * harness compares. An acceptance run used to compare nothing, so a labelled
 * instance orphaned by an interrupted run passed the whole gate on a database
 * the operator had since turned into something else. Now the run requires its
 * environment to carry `APP_INSTANCE_RUN_ID`, compares it with what answered,
 * and requires the instance's data directory to be declared and to *look*
 * test-like (an `.e2e` name or a directory under the system temp) — before the
 * first request that writes.
 *
 * Kryteria: L1.8 (konfiguracja kierująca próbę na instancję użytkownika jest
 * odrzucana przed operacją zapisu).
 */

import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';

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
  /*
   * The run identifier the caller declares, if any. Read here so every caller
   * of `resolveAcceptanceTarget` sees the same expectation; the comparison
   * itself happens when somebody actually answers.
   */
  const expectedRunId =
    typeof env.APP_INSTANCE_RUN_ID === 'string' && env.APP_INSTANCE_RUN_ID.trim() !== ''
      ? env.APP_INSTANCE_RUN_ID
      : undefined;
  return { base: url.origin, port, allowedLabels: [...ACCEPTANCE_LABELS], expectedRunId };
}

/**
 * Asks the target who it is.
 *
 * Returns `null` when the instance may be written through, and a sentence to
 * print otherwise. Unreachable is its own answer and is also a refusal: an
 * acceptance run has no reason to wait for a backend that is not there, and
 * "nothing answered" must never be read as "nothing objected".
 */
export const HEALTH_TIMEOUT_MS = 10_000;

export async function checkAcceptanceInstance(target, fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS) {
  let label;
  let runId;
  try {
    const res = await fetchImpl(`${target.base}/api/health`, {
      /*
       * Two options, both load-bearing.
       *
       * `redirect: 'error'` — without it the label may be read from a
       * *different* server than the one the writes will go to: `/api/health`
       * answers 302 to a second, properly labelled instance, the check passes,
       * and every POST afterwards goes to the first one. Demonstrated by a
       * reviewer, not imagined. A check whose answer can come from elsewhere
       * than the subject is not a check.
       *
       * `signal` — this module's own comment says "nothing answered is an
       * answer", and without a deadline that sentence was false: a target that
       * accepts the connection and never replies hung the run for ever, which
       * is the one outcome that is neither a refusal nor a pass.
       */
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    label = body?.instanceLabel ?? null;
    runId = body?.instanceRunId ?? null;
  } catch (e) {
    return (
      `Instancja pod ${target.base} nie odpowiada na /api/health poprawnie ` +
      `(${(e && e.message) || String(e)}). Przekierowanie i brak odpowiedzi w ${timeoutMs} ms sa tu ` +
      'odmowa, nie zgoda: etykiete trzeba przeczytac z tej samej instancji, ktora przyjmie zapisy. ' +
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
  if (target.expectedRunId !== undefined && runId !== target.expectedRunId) {
    return (
      `Pod ${target.base} odpowiada instancja Z INNEGO PRZEBIEGU ` +
      `(instanceRunId=${JSON.stringify(runId)}, oczekiwano ${JSON.stringify(target.expectedRunId)}). ` +
      'Etykieta jest wspolna dla wszystkich instancji testowych i odbiorczych, wiec sama nie ' +
      'odroznia serwera osieroconego po przerwanym starcie od tego, ktory ta proba wskazala. ' +
      'Uruchom instancje z APP_INSTANCE_RUN_ID o tej samej wartosci, ktora podajesz tutaj, ' +
      'albo zatrzymaj tamten proces po jego pid. Nic nie zostalo zapisane.'
    );
  }
  return null;
}

/**
 * Refuses an acceptance run whose environment does not *declare* what it is
 * talking to.
 *
 * The label gate checks what answers; this checks what the run itself claims.
 * `APP_INSTANCE_RUN_ID` must be carried by the run so it can be compared with
 * the answering instance, and `APP_DATA_DIR` must be carried so the run can
 * refuse a data directory that does not look like a test one (an `.e2e` name,
 * or a directory under the system temp). Both are the same values the instance
 * was started with, so the honest invocation is one `export` away — and the
 * refusal message is that invocation.
 */
export function problemSrodowiskaOdbiorczego(env = {}) {
  const runId = env.APP_INSTANCE_RUN_ID;
  if (typeof runId !== 'string' || runId.trim() === '') {
    return (
      'brak APP_INSTANCE_RUN_ID — ta proba musi wiedziec, z ktora instancja mowi. ' +
      'Uruchom instancje odbiorcza i probe z ta sama wartoscia, np.:\n' +
      '  export APP_INSTANCE_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"\n' +
      '  export APP_DATA_DIR="$(mktemp -d /tmp/.e2e-odbiorcza-XXXXXX)"\n' +
      '  APP_INSTANCE_LABEL=agenticapp-acceptance APP_INSTANCE_RUN_ID="$APP_INSTANCE_RUN_ID" ' +
      `APP_DATA_DIR="$APP_DATA_DIR" PORT=${DEFAULT_ACCEPTANCE_PORT} pnpm start\n` +
      'Bramka porownuje ten identyfikator z instanceRunId na /api/health i odmawia instancji ' +
      'z innego przebiegu, zanim cokolwiek zapisze.'
    );
  }
  const katalog = env.APP_DATA_DIR;
  if (typeof katalog !== 'string' || katalog.trim() === '') {
    return (
      'brak APP_DATA_DIR — proba nie moze sprawdzic, w jakim katalogu danych stoi instancja, ' +
      'ktorej zamierza pisac. Ustaw APP_DATA_DIR na ta sama wartosc, z jaka wystartowala ' +
      'instancja odbiorcza (katalog o nazwie z prefiksem ".e2e" albo katalog w systemowym tmp).'
    );
  }
  const realna = (() => {
    try {
      return realpathSync(resolve(katalog));
    } catch {
      return resolve(katalog);
    }
  })();
  const tmp = (() => {
    try {
      return realpathSync(tmpdir());
    } catch {
      return resolve(tmpdir());
    }
  })();
  const wTmp = realna === tmp || realna.startsWith(tmp + sep);
  const prefiksTestowy = basename(realna).startsWith('.e2e');
  if (!wTmp && !prefiksTestowy) {
    return (
      `APP_DATA_DIR (${katalog}) nie jest katalogiem testowym — proba wykonuje zapisy ` +
      '(zmiana ilosci pozycji, dodanie kart) i wymaga katalogu o nazwie z prefiksem ".e2e" ' +
      'albo katalogu w systemowym tmp, nie miejsca, w ktorym stoia komus dane.'
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
export async function requireAcceptanceInstance(env = {}, fetchImpl = fetch, timeoutMs = HEALTH_TIMEOUT_MS) {
  const target = resolveAcceptanceTarget(env);
  const problem = await checkAcceptanceInstance(target, fetchImpl, timeoutMs);
  if (problem) throw new AcceptanceTargetError(problem);
  const srodowisko = problemSrodowiskaOdbiorczego(env);
  if (srodowisko) throw new AcceptanceTargetError(srodowisko);
  return target;
}
