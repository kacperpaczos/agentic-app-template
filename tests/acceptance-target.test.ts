import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
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
  TEST_PORT_RANGE: { from: number; to: number };
  DEFAULT_ACCEPTANCE_PORT: number;
  USER_APP_PORT: number;
  ACCEPTANCE_LABELS: string[];
  AcceptanceTargetError: new (m: string) => Error;
  resolveAcceptanceTarget: (env?: Record<string, string | undefined>) => {
    base: string;
    port: number;
    allowedLabels: string[];
  };
  checkAcceptanceInstance: (
    target: { base: string; allowedLabels: string[] },
    fetchImpl?: typeof fetch,
    timeoutMs?: number,
  ) => Promise<string | null>;
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

/** Second stand-in, for the cases that need two servers or none answering. */
let second: Server | null = null;

/** Answers `/api/health` with a redirect to `to` — and nothing else. */
async function instanceRedirectingTo(to: string): Promise<string> {
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.statusCode = 302;
    res.setHeader('location', `${to}/api/health`);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  second = server;
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('brak portu');
  return `http://127.0.0.1:${address.port}`;
}

/** Accepts the connection and never replies. */
async function instanceThatNeverAnswers(): Promise<string> {
  const server = createServer(() => {
    /* deliberately no response */
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  second = server;
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('brak portu');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const ref of ['running', 'second'] as const) {
    const server = ref === 'running' ? running : second;
    if (ref === 'running') running = null;
    else second = null;
    if (server) await new Promise<void>((done) => server.close(() => done()));
  }
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

describe('sprawdzenie etykiety nie daje sie obejsc', () => {
  it('przekierowanie na inna instancje jest odmowa, a nie zgoda', async () => {
    /*
     * Pokazane przez recenzenta, nie wymyslone: `/api/health` odpowiada 302 na
     * drugi, poprawnie oznaczony serwer, sprawdzenie przechodzi — a kazdy zapis
     * idzie do pierwszego. Etykiete trzeba przeczytac z tej samej instancji,
     * ktora przyjmie zapisy.
     */
    const labelled = await instanceAnswering('agenticapp-dev');
    const redirector = await instanceRedirectingTo(labelled);
    const problem = await mod.checkAcceptanceInstance({
      base: redirector,
      allowedLabels: mod.ACCEPTANCE_LABELS,
    });
    expect(problem, 'przekierowanie zostalo przyjete').not.toBeNull();
    expect(problem).toContain('Przekierowanie i brak odpowiedzi');
  });

  it('cel, ktory przyjmuje polaczenie i nie odpowiada, jest odrzucony w terminie', async () => {
    // Bez terminu ten przypadek wiesza przebieg — ani odmowa, ani zgoda.
    const silent = await instanceThatNeverAnswers();
    const started = Date.now();
    const problem = await mod.checkAcceptanceInstance(
      { base: silent, allowedLabels: mod.ACCEPTANCE_LABELS },
      fetch,
      400,
    );
    expect(problem).toContain('nie odpowiada na /api/health');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('klasa: skrypty celujace w dzialajaca instancje', () => {
  /*
   * Reguła, nie lista. Przy L1.8 naprawione zostały dwa skrypty, które zlecenie
   * nazwało po imieniu; recenzent znalazł trzeci (`diag-frontend.mjs`, domyślnie
   * 8791, a samo wczytanie strony wykonuje POST /api/auth/session przez
   * `switchAccessContext`). Przeszukanie klasy znalazło czwarty
   * (`probe-chat-composer.mjs`, 8788, też POST). Ten test jest tym, czego
   * brakowało: nowy skrypt z adresem instancji albo przechodzi przez bramkę,
   * albo celuje w port zarezerwowany dla testów — trzeciej drogi nie ma.
   */
  const SCRIPTS = resolve(REPO, 'scripts');
  const files = readdirSync(SCRIPTS).filter((f) => /\.(mjs|ts)$/.test(f));

  it('kazdy skrypt z adresem petli zwrotnej ma bramke albo port testowy', () => {
    expect(files.length).toBeGreaterThan(10);
    const problems: string[] = [];
    let scanned = 0;
    for (const file of files) {
      const text = readFileSync(resolve(SCRIPTS, file), 'utf8');
      const ports = [...text.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})/g)].map((m) =>
        Number(m[1]),
      );
      if (ports.length === 0) continue;
      scanned += 1;
      if (text.includes('lib/acceptance-target.mjs')) continue;
      const outside = [...new Set(ports)].filter(
        (port) => port < mod.TEST_PORT_RANGE.from || port > mod.TEST_PORT_RANGE.to,
      );
      if (outside.length > 0) {
        problems.push(
          `${file}: adresy na portach ${outside.join(', ')} poza zakresem testowym ` +
            `${mod.TEST_PORT_RANGE.from}-${mod.TEST_PORT_RANGE.to} i bez requireAcceptanceInstance`,
        );
      }
    }
    // A scan that examined nothing would report no problems just as loudly.
    expect(scanned, 'skan nie znalazl zadnego skryptu z adresem instancji').toBeGreaterThan(5);
    expect(problems, problems.join('\n')).toEqual([]);
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
