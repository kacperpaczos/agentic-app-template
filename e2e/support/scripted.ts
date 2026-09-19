import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, type WriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveTestInstance, type TestInstanceConfig } from './isolation.ts';
import { verifyIsolatedInstance } from './fixtures.ts';

/**
 * Lifecycle of a scripted-model instance, shared by the suites that need one.
 *
 * Two specs used to carry their own copy of this: the same spawn, the same
 * health poll, the same kill. Duplicating it meant a fix to the isolation rules
 * had to be applied twice and could be applied once — which is the shape of the
 * defect this whole area is about. It lives in one place now, and that place
 * validates its configuration through `resolveTestInstance` before it starts
 * anything.
 *
 * Shutdown deliberately tracks the child it started and kills only that. An
 * earlier cleanup matched running servers by command line (`pkill -f
 * apps/server/dist/server.js`) and killed the user's own instance along with
 * the test's.
 */
export class ScriptedInstance {
  readonly config: TestInstanceConfig;
  #process: ChildProcess | null = null;
  /** Extra environment for the server process, e.g. a canary a test looks for. */
  readonly #extraEnv: Record<string, string>;
  /** When set, everything the server writes to stdout and stderr lands here. */
  readonly #logFile: string | null;
  #log: WriteStream | null = null;

  /**
   * Which server this instance starts.
   *
   * `scripted` (the default) is the stand-in host used by every suite that
   * drives a run without spending a turn. `production` is the built bundle —
   * the very one `pnpm start` runs, with the **real** model behind it — started
   * here rather than by Playwright's `webServer` for one reason: a test about
   * what a stop signal leaves behind has to own the process it signals, and
   * Playwright's is not the test's to kill or to start again on the same data.
   *
   * Everything else is identical, isolation checks included: the same port
   * guard, the same `.e2e*` data directory, the same instance label, and the
   * same rule that only the child this object started is ever signalled.
   */
  readonly #entry: 'scripted' | 'production';

  constructor(opts: {
    port: number;
    dataDirName: string;
    entry?: 'scripted' | 'production';
    /** Added to the server process's environment. Never used to redirect it. */
    env?: Record<string, string>;
    /**
     * Captures the server's stdout and stderr to this path.
     *
     * The default is `stdio: 'ignore'`, which is fine for a test that only
     * drives the interface — and useless for one that has to state what the
     * server did or did not print. A claim about logs needs the logs.
     */
    logFile?: string;
  }) {
    this.config = resolveTestInstance({
      repoRoot: resolve(import.meta.dirname, '../..'),
      dataDirName: opts.dataDirName,
      defaultPort: opts.port,
      // The shared suite's `APP_E2E_PORT` / `APP_BASE_URL` must not redirect a
      // scripted instance that runs on its own port.
      env: {},
    });
    this.#entry = opts.entry ?? 'scripted';
    this.#extraEnv = opts.env ?? {};
    this.#logFile = opts.logFile ? resolve(this.config.repoRoot, opts.logFile) : null;
  }

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * The pid of the server this object started, or null when nothing is running.
   *
   * Exposed for one purpose: counting the server's **descendant processes**.
   * "Stop ended the work" is otherwise answered from the database, which cannot
   * see a process the run left behind.
   */
  get pid(): number | null {
    return this.#process?.pid ?? null;
  }

  /** Rebuilds this instance's database from scratch. Nothing is running yet. */
  prepareDatabase(): void {
    if (existsSync(this.config.dataDir)) {
      rmSync(this.config.dataDir, { recursive: true, force: true });
    }
    for (const script of ['migrate', 'seed']) {
      execFileSync('pnpm', [script], {
        cwd: this.config.repoRoot,
        stdio: 'ignore',
        env: { ...process.env, ...this.config.env },
      });
    }
  }

  /**
   * Starts the server.
   *
   * `scenario` names the stand-in script; a `production` instance has no script
   * and ignores it (pass `'-'` to say so at the call site).
   */
  async start(scenario: string): Promise<void> {
    if (this.#process) throw new Error('instancja scenariuszowa juz dziala');
    if (this.#logFile) {
      mkdirSync(dirname(this.#logFile), { recursive: true });
      this.#log = createWriteStream(this.#logFile, { flags: 'a' });
      this.#log.write(`--- start ${this.#entry === 'production' ? 'buildu produkcyjnego' : `scenariusza ${scenario}`} ---\n`);
    }
    const args =
      this.#entry === 'production'
        ? ['apps/server/dist/server.js']
        : [
            '--experimental-transform-types',
            '--no-warnings=ExperimentalWarning',
            'e2e/support/scripted-server.ts',
          ];
    this.#process = spawn('node', args, {
      cwd: this.config.repoRoot,
      // `config.env` last: a canary must never be able to redirect the
      // instance's port or data directory.
      env: { ...process.env, ...this.#extraEnv, ...this.config.env, SCRIPT: scenario },
      stdio: this.#log ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    });
    if (this.#log) {
      this.#process.stdout?.pipe(this.#log, { end: false });
      this.#process.stderr?.pipe(this.#log, { end: false });
    }
    await this.#waitForHealth();
    // Same gate as the shared instance: proceed only against a server that
    // identifies itself as one the tests started.
    await verifyIsolatedInstance(this.baseUrl, this.config.port);
  }

  async #waitForHealth(): Promise<void> {
    for (let i = 0; i < 120; i += 1) {
      try {
        if ((await fetch(`${this.baseUrl}/api/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`serwer scenariuszowy nie wystartowal na ${this.baseUrl}`);
  }

  /** Stops the process this object started, and only that process. */
  async stop(): Promise<void> {
    const proc = this.#process;
    if (!proc) return;
    this.#process = null;
    await new Promise<void>((done) => {
      proc.once('exit', () => done());
      proc.kill('SIGTERM');
      setTimeout(() => {
        proc.kill('SIGKILL');
        done();
      }, 5000);
    });
    // Closed after the process is gone, so nothing it printed on the way out is
    // lost — which is exactly what a log scan would miss.
    await new Promise<void>((done) => {
      const log = this.#log;
      this.#log = null;
      if (!log) return done();
      log.end(() => done());
    });
  }

  /**
   * Sends one signal and waits for the process to leave on its own.
   *
   * Separate from {@link stop}, which escalates to `SIGKILL` after five seconds
   * because a test that only wants the port back does not care how it got there.
   * Here the *how* is the measurement: "SIGTERM leaves no unmanaged worker
   * process" is a claim about an orderly shutdown, and a `SIGKILL` behind it
   * would both hide a shutdown that hung and orphan the very children the test
   * is about to count. So nothing is escalated; a process that does not leave
   * within `graceMs` is reported as still running, which is a finding.
   */
  async stopWith(
    signal: 'SIGTERM' | 'SIGINT',
    graceMs = 20_000,
  ): Promise<{ exited: boolean; code: number | null; signal: NodeJS.Signals | null; ms: number }> {
    const proc = this.#process;
    if (!proc) return { exited: true, code: null, signal: null, ms: 0 };
    this.#process = null;
    const started = Date.now();
    const outcome = await new Promise<{ exited: boolean; code: number | null; signal: NodeJS.Signals | null }>(
      (done) => {
        const timer = setTimeout(() => done({ exited: false, code: null, signal: null }), graceMs);
        proc.once('exit', (code, sig) => {
          clearTimeout(timer);
          done({ exited: true, code, signal: sig });
        });
        proc.kill(signal);
      },
    );
    await new Promise<void>((done) => {
      const log = this.#log;
      this.#log = null;
      if (!log) return done();
      log.end(() => done());
    });
    // A process that ignored the signal is still this object's to clean up.
    if (!outcome.exited) this.#process = proc;
    return { ...outcome, ms: Date.now() - started };
  }

  /** Everything the server printed since it started. Empty when not captured. */
  readLog(): string {
    if (!this.#logFile || !existsSync(this.#logFile)) return '';
    return readFileSync(this.#logFile, 'utf8');
  }

  /** Path of the captured log, for an evidence file to point at. */
  get logPath(): string | null {
    return this.#logFile;
  }

  async restart(scenario: string): Promise<void> {
    await this.stop();
    await this.start(scenario);
  }
}
