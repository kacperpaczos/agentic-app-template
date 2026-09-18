import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DEV_API_PORT,
  DEV_INSTANCE_LABEL,
  checkDevInstance,
  devInstanceGate,
  resolveDevApi,
  type DevApiTarget,
} from '../apps/web/src/dev-proxy.ts';

/**
 * The development proxy may not reach an instance that is not its own.
 *
 * Test kontraktu lub logiki. The defect it locks down was real and current: the
 * Vite proxy named `http://localhost:8791`, the port an *installed* instance of
 * this application listens on, so `pnpm dev` on such a machine developed
 * against somebody's live data — session, conversations, canvas and every
 * mutation — with nothing on screen saying which instance answered.
 *
 * Two independent guards, and both are checked here: the port cannot default
 * to (or be set to) the installed application's, and the instance that answers
 * has to carry the development label before anything is forwarded.
 */

let running: Server | null = null;

/**
 * How many times `/api/health` was actually asked.
 *
 * Counted, rather than inferred from the answers, because the question "is the
 * probe shared?" cannot be answered by what the callers got back: a stand-in
 * that answers correctly answers three concurrent requests just as correctly as
 * one. Only the count can fail.
 */
let probes = 0;

/** A stand-in backend answering `/api/health` with the given label. */
async function instanceAnswering(label: string | null | 'broken'): Promise<string> {
  probes = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/health') probes += 1;
    if (req.url !== '/api/health') {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (label === 'broken') {
      res.statusCode = 500;
      res.end('nope');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, instanceLabel: label }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  running = server;
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('brak portu');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  const server = running;
  running = null;
  if (server) await new Promise<void>((done) => server.close(() => done()));
});

describe('proxy trybu deweloperskiego', () => {
  it('domyslny cel nie jest portem zainstalowanej aplikacji', () => {
    const api = resolveDevApi({});
    expect(api.port).toBe(DEFAULT_DEV_API_PORT);
    // The whole point: the accident has to require a deliberate setting.
    expect(api.port).not.toBe(8791);
    expect(api.target).toBe(`http://127.0.0.1:${DEFAULT_DEV_API_PORT}`);
    expect(api.expectedLabel).toBe(DEV_INSTANCE_LABEL);
  });

  it('odmawia portu zainstalowanej aplikacji i portow testowych, podajac powod', () => {
    expect(() => resolveDevApi({ APP_DEV_API_PORT: '8791' })).toThrowError(
      /domyslny port zainstalowanej aplikacji/,
    );
    expect(() => resolveDevApi({ APP_DEV_API_PORT: '8799' })).toThrowError(/zarezerwowanego dla testow/);
    expect(() => resolveDevApi({ APP_DEV_API_PORT: 'osiem' })).toThrowError(/nie jest numerem portu/);
    // A port that is neither is accepted — the rule is specific, not blanket.
    expect(resolveDevApi({ APP_DEV_API_PORT: '8765' }).port).toBe(8765);
  });

  it('cel bez etykiety deweloperskiej jest odrzucony, nic nie jest przekazywane', async () => {
    const target = await instanceAnswering(null);
    const problem = await checkDevInstance({
      port: 0,
      target,
      expectedLabel: DEV_INSTANCE_LABEL,
    });
    expect(problem, 'instancja bez etykiety zostala przyjeta').not.toBeNull();
    expect(problem).toContain('instancja z etykieta null');
    expect(problem).toContain('zadanie nie zostalo przekazane');
  });

  it('cel z cudza etykieta jest odrzucony', async () => {
    const target = await instanceAnswering('agenticapp-test');
    const problem = await checkDevInstance({ port: 0, target, expectedLabel: DEV_INSTANCE_LABEL });
    expect(problem).toContain('agenticapp-test');
  });

  it('cel, ktory nie odpowiada, jest odrzucony — i sprawdzany ponownie', async () => {
    const problem = await checkDevInstance({
      port: 0,
      // Nothing is listening here; the port is closed, not merely unlabelled.
      target: 'http://127.0.0.1:1',
      expectedLabel: DEV_INSTANCE_LABEL,
    });
    expect(problem).toContain('nie odpowiada na /api/health');
  });

  it('odrzucona obietnica sprawdzenia konczy sie odmowa, nie zawieszonym zadaniem', async () => {
    /*
     * `readInstanceLabel` catches what it can reach, so this guards against its
     * contract changing rather than against a path we know of — and the cost of
     * being wrong is the worst kind: every `/api` request waiting for ever with
     * no answer.
     */
    const exploding = {
      port: 0,
      get target(): string {
        throw new Error('sprawdzenie wybuchlo');
      },
      expectedLabel: DEV_INSTANCE_LABEL,
    } as unknown as DevApiTarget;
    const gate = devInstanceGate(exploding);
    await expect(gate()).resolves.toContain('nie powiodlo sie');
  });

  it('cel z wlasciwa etykieta przechodzi, a sprawdzenie zapamietuje tylko sukces', async () => {
    const target = await instanceAnswering(DEV_INSTANCE_LABEL);
    const api = { port: 0, target, expectedLabel: DEV_INSTANCE_LABEL };
    expect(await checkDevInstance(api)).toBeNull();

    /*
     * The gate remembers a success and does not re-ask; a failure is not
     * remembered, because "the backend has not finished starting" is the normal
     * first answer after `pnpm dev` and must not require restarting Vite.
     */
    const cold = devInstanceGate({ ...api, target: 'http://127.0.0.1:1' });
    expect(await cold()).toContain('nie odpowiada');
    expect(await cold()).toContain('nie odpowiada');

    const warm = devInstanceGate(api);
    /*
     * Concurrent first requests share one probe rather than each sending their
     * own: the first page load opens several `/api` requests at once.
     *
     * Measured by counting what reached the stand-in, not by what the callers
     * got back. Three `null`s are true whether the probe is shared or not, so
     * that assertion could never fail — which is worse than no assertion,
     * because a reader takes it for a guard.
     */
    const before = probes;
    expect(await Promise.all([warm(), warm(), warm()])).toEqual([null, null, null]);
    expect(probes - before, 'trzy rownolegle wywolania wyslaly wiecej niz jedna sonde').toBe(1);
    const closing = running;
    running = null;
    await new Promise<void>((done) => closing!.close(() => done()));
    // The instance is gone, but this gate already verified it: no second ask.
    expect(await warm()).toBeNull();
  });
});
