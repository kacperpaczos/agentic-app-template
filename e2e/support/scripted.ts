import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
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

  constructor(opts: { port: number; dataDirName: string }) {
    this.config = resolveTestInstance({
      repoRoot: resolve(import.meta.dirname, '../..'),
      dataDirName: opts.dataDirName,
      defaultPort: opts.port,
      // The shared suite's `APP_E2E_PORT` / `APP_BASE_URL` must not redirect a
      // scripted instance that runs on its own port.
      env: {},
    });
  }

  get baseUrl(): string {
    return this.config.baseUrl;
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

  async start(scenario: string): Promise<void> {
    if (this.#process) throw new Error('instancja scenariuszowa juz dziala');
    this.#process = spawn(
      'node',
      [
        '--experimental-transform-types',
        '--no-warnings=ExperimentalWarning',
        'e2e/support/scripted-server.ts',
      ],
      {
        cwd: this.config.repoRoot,
        env: { ...process.env, ...this.config.env, SCRIPT: scenario },
        stdio: 'ignore',
      },
    );
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
  }

  async restart(scenario: string): Promise<void> {
    await this.stop();
    await this.start(scenario);
  }
}
