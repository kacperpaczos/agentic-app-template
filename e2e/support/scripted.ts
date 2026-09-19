import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, type WriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TEST_RUN_ID, resolveTestInstance, type TestInstanceConfig } from './isolation.ts';
import { assertPortFree } from './port-probe.ts';
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

  constructor(opts: {
    port: number;
    dataDirName: string;
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

  /**
   * Rebuilds this instance's database from scratch. Nothing is running yet —
   * and that is now checked rather than assumed.
   *
   * "Nothing is running" used to be a sentence in a comment. A scripted server
   * orphaned by an interrupted run holds this port and has this database open;
   * the delete then happened underneath it, the new server could not bind, and
   * the identity check accepted the survivor because every test instance
   * carries the same label. The port is asked first, and an occupied one stops
   * the run before anything is removed (L1.9).
   */
  prepareDatabase(): void {
    assertPortFree(this.config.port, `przygotowanie instancji scenariuszowej (${this.config.dataDir})`);
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
   * Starts the instance on one scenario.
   *
   * `extraEnv` is for settings that belong to a single test rather than to the
   * instance — the scripted answer of the SDK session probe, say. It is applied
   * with the constructor's environment and, like it, cannot override the port
   * or the data directory: `config.env` is still written last.
   */
  async start(scenario: string, extraEnv: Record<string, string> = {}): Promise<void> {
    if (this.#process) throw new Error('instancja scenariuszowa juz dziala');
    if (this.#logFile) {
      mkdirSync(dirname(this.#logFile), { recursive: true });
      this.#log = createWriteStream(this.#logFile, { flags: 'a' });
      this.#log.write(`--- start scenariusza ${scenario} ---\n`);
    }
    this.#process = spawn(
      'node',
      [
        '--experimental-transform-types',
        '--no-warnings=ExperimentalWarning',
        'e2e/support/scripted-server.ts',
      ],
      {
        cwd: this.config.repoRoot,
        // `config.env` last: a canary must never be able to redirect the
        // instance's port or data directory.
        env: { ...process.env, ...this.#extraEnv, ...extraEnv, ...this.config.env, SCRIPT: scenario },
        stdio: this.#log ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      },
    );
    if (this.#log) {
      this.#process.stdout?.pipe(this.#log, { end: false });
      this.#process.stderr?.pipe(this.#log, { end: false });
    }
    await this.#waitForHealth();
    /*
     * Same gate as the shared instance, plus the one thing the label cannot
     * say: this object spawned the process itself, so it knows which run the
     * answering server must belong to. A survivor of an earlier run answers
     * with the right label and the wrong run id, and is refused.
     */
    await verifyIsolatedInstance(this.baseUrl, this.config.port, TEST_RUN_ID);
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

  /** Everything the server printed since it started. Empty when not captured. */
  readLog(): string {
    if (!this.#logFile || !existsSync(this.#logFile)) return '';
    return readFileSync(this.#logFile, 'utf8');
  }

  /** Path of the captured log, for an evidence file to point at. */
  get logPath(): string | null {
    return this.#logFile;
  }

  async restart(scenario: string, extraEnv: Record<string, string> = {}): Promise<void> {
    await this.stop();
    await this.start(scenario, extraEnv);
  }
}
