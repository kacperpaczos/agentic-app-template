import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DEV_API_PORT,
  DEV_INSTANCE_LABEL,
  checkDevInstance,
  devInstanceGate,
  resolveDevApi,
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

/** A stand-in backend answering `/api/health` with the given label. */
async function instanceAnswering(label: string | null | 'broken'): Promise<string> {
  const server = createServer((req, res) => {
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
    expect(await warm()).toBeNull();
    const closing = running;
    running = null;
    await new Promise<void>((done) => closing!.close(() => done()));
    // The instance is gone, but this gate already verified it: no second ask.
    expect(await warm()).toBeNull();
  });
});
