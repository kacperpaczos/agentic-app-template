import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * L1.8 — a probe run from a shell may not write through the user's instance.
 *
 * Test kontraktu lub logiki, plus an end-to-end check of the script itself.
 *
 * The defect was real and documented in the README: `pnpm acceptance` and
 * `scripts/run-agent.mjs` defaulted to `http://127.0.0.1:8791`, the port an
 * installed instance listens on, and asked nobody who answered there. Their
 * scenarios change the quantity of an offer item and add canvas cards, so a
 * real-model probe started outside the browser harness wrote through whatever
 * was listening.
 *
 * Two things are checked, and the second is the one that matters: not only that
 * the guard function returns a refusal, but that **the script sends nothing**.
 * A guard that refuses while the request is already in flight refuses nothing.
 *
 * The counter-case is what makes that assertion mean something. "No POST
 * arrived" is also true of a script that failed to start, so the same stand-in
 * answers with an allowed label in the last test and the POST has to arrive.
 */

const REPO = resolve(import.meta.dirname, '..');
const RUN_AGENT = resolve(REPO, 'scripts/run-agent.mjs');
const MODULE = resolve(REPO, 'scripts/lib/acceptance-target.mjs');

interface AcceptanceTargetModule {
  DEFAULT_ACCEPTANCE_BASE: string;
  DEFAULT_ACCEPTANCE_PORT: number;
  USER_APP_PORT: number;
  ACCEPTANCE_LABELS: string[];
  AcceptanceTargetError: new (m: string) => Error;
  resolveAcceptanceTarget: (env?: Record<string, string | undefined>) => {
    base: string;
    port: number;
    allowedLabels: string[];
  };
  checkAcceptanceInstance: (target: { base: string; allowedLabels: string[] }) => Promise<string | null>;
  requireAcceptanceInstance: (env?: Record<string, string | undefined>) => Promise<{ base: string }>;
}

const mod = (await import(MODULE)) as AcceptanceTargetModule;

let running: Server | null = null;

/** Every request the stand-in received, in order: `POST /api/agui/run`. */
let seen: string[] = [];

/**
 * A stand-in instance answering `/api/health` with the given label.
 *
 * `null` is the interesting one: that is exactly what an installed instance
 * answers, because `APP_INSTANCE_LABEL` is set only by this repository's own
 * commands.
 */
async function instanceAnswering(label: string | null): Promise<string> {
  seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/api/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, instanceLabel: label }));
      return;
    }
    if (req.url === '/api/auth/session') {
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', 'sid=test; Path=/');
      res.end('{}');
      return;
    }
    // Anything else: refuse, so the script stops without a stream to read.
    res.statusCode = 503;
    res.end('stand-in');
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

/**
 * Runs the script and collects what it printed.
 *
 * Asynchronous on purpose. `spawnSync` blocks this process's event loop, and
 * the stand-in instance lives *in* this process — the child's `/api/health`
 * would then never be answered and every run would look like "the instance did
 * not reply", which is the wrong refusal for the right reason. That mistake
 * made the first version of this file pass its main assertion by accident.
 */
async function runScript(base: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [RUN_AGENT, 'cokolwiek', '--space', 's1'], {
    env: { ...process.env, APP_BASE: base },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
  child.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
  const status = await new Promise<number | null>((done) => child.on('close', done));
  return { status, stdout, stderr };
}

describe('cel proby odbiorowej', () => {
  it('domyslny cel nie jest portem zainstalowanej aplikacji', () => {
    const target = mod.resolveAcceptanceTarget({});
    expect(target.port).toBe(mod.DEFAULT_ACCEPTANCE_PORT);
    // The whole point: reaching the user's instance must take a deliberate act.
    expect(target.port).not.toBe(mod.USER_APP_PORT);
    expect(target.base).toBe(mod.DEFAULT_ACCEPTANCE_BASE);
  });

  it('APP_BASE wskazujacy port zainstalowanej aplikacji jest odrzucony z powodem', () => {
    expect(() => mod.resolveAcceptanceTarget({ APP_BASE: 'http://127.0.0.1:8791' })).toThrowError(
      /domyslny port zainstalowanej aplikacji/,
    );
    expect(() => mod.resolveAcceptanceTarget({ APP_BASE: 'http://localhost:8791/' })).toThrowError(
      /domyslny port zainstalowanej aplikacji/,
    );
  });

  it('adres spoza petli zwrotnej i adres niepoprawny sa odrzucone', () => {
    expect(() => mod.resolveAcceptanceTarget({ APP_BASE: 'http://example.com:8790' })).toThrowError(
      /petli zwrotnej/,
    );
    expect(() => mod.resolveAcceptanceTarget({ APP_BASE: 'nie-adres' })).toThrowError(/poprawnym adresem/);
    // A different loopback port is fine — the rule is specific, not blanket.
    expect(mod.resolveAcceptanceTarget({ APP_BASE: 'http://127.0.0.1:8765' }).port).toBe(8765);
  });

  it('instancja bez etykiety — czyli instancja uzytkownika — jest odrzucona', async () => {
    const base = await instanceAnswering(null);
    const problem = await mod.checkAcceptanceInstance({ base, allowedLabels: mod.ACCEPTANCE_LABELS });
    expect(problem, 'instancja bez etykiety zostala przyjeta').not.toBeNull();
    expect(problem).toContain('null');
    expect(problem).toContain('nic nie zostalo zapisane');
  });

  it('instancja z cudza etykieta jest odrzucona, z wlasciwa — przyjeta', async () => {
    const foreign = await instanceAnswering('cudza-aplikacja');
    expect(await mod.checkAcceptanceInstance({ base: foreign, allowedLabels: mod.ACCEPTANCE_LABELS }))
      .toContain('cudza-aplikacja');

    await new Promise<void>((done) => running!.close(() => done()));
    running = null;

    const ours = await instanceAnswering('agenticapp-dev');
    expect(await mod.checkAcceptanceInstance({ base: ours, allowedLabels: mod.ACCEPTANCE_LABELS })).toBeNull();
  });

  it('instancja, ktora nie odpowiada, jest odmowa — nie milczaca zgoda', async () => {
    const problem = await mod.checkAcceptanceInstance({
      // Nothing listens here.
      base: 'http://127.0.0.1:1',
      allowedLabels: mod.ACCEPTANCE_LABELS,
    });
    expect(problem).toContain('nie odpowiada na /api/health');
  });
});

describe('run-agent.mjs wobec instancji uzytkownika', () => {
  it('nie wysyla ZADNEGO zapisu do instancji bez etykiety i konczy sie bledem', async () => {
    const base = await instanceAnswering(null);
    const out = await runScript(base);

    expect(out.status, `stderr: ${out.stderr}`).toBe(3);
    expect(out.stderr).toContain('proba odbiorowa');
    expect(out.stderr).toContain('Zadne zadanie nie zostalo wyslane');

    /*
     * The assertion the criterion is about: the refusal happened *before* the
     * write, not next to it. `/api/auth/session` is already a POST, so the list
     * has to contain the health probe and nothing else.
     */
    expect(seen).toEqual(['GET /api/health']);
    expect(seen.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('kontrola przeciwna: przy dozwolonej etykiecie skrypt naprawde pisze', async () => {
    /*
     * Without this, the test above could pass for the wrong reason — a script
     * that crashes on startup also sends no POST. Here the same stand-in says
     * `agenticapp-dev`, and the POST has to arrive.
     */
    const base = await instanceAnswering('agenticapp-dev');
    const out = await runScript(base);

    expect(out.stdout).toContain(`# instancja: ${base}`);
    expect(seen).toContain('GET /api/health');
    expect(seen).toContain('POST /api/auth/session');
    expect(seen).toContain('POST /api/agui/run');
    // The stand-in refuses the run itself, so the script reports the HTTP error.
    expect(out.status).toBe(1);
  });
});
