import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { TEST_PORT_RANGE } from './isolation.ts';

/**
 * A network that can be taken away — the one thing the browser's own offline
 * emulation does not do.
 *
 * `BrowserContext.setOffline(true)` blocks *new* requests and flips
 * `navigator.onLine`, but an **already established** connection keeps
 * delivering: a review measured a run's event stream receiving further chunks
 * and its terminal event after the context had been switched offline. A test
 * built on that alone cannot fail for the reason it claims, because the stream
 * it says was lost was never lost.
 *
 * So the browser talks to the application through this, and the test cuts the
 * wire: {@link cut} destroys every live connection and refuses new ones, which
 * is what a lost network does to an open stream. {@link restore} lets
 * connections through again. The application process is untouched throughout —
 * that is the point: the run has to carry on while nobody can reach it.
 *
 * **The one header it rewrites.** The browser sends `Origin: <proxy>`, and the
 * application refuses an origin it was not configured with — correctly. The
 * proxy therefore presents the application's own origin instead. The check is
 * not disabled and still refuses anything else; the proxy simply speaks for the
 * instance it forwards to. Nothing in a test that uses this asserts anything
 * about CORS.
 */
export class CuttableProxy {
  #server: Server | null = null;
  readonly #sockets = new Set<Socket>();
  #cut = false;
  readonly #targetPort: number;
  readonly #targetOrigin: string;

  constructor(
    readonly port: number,
    /** Base URL of the instance to forward to, e.g. `http://127.0.0.1:8798`. */
    target: string,
  ) {
    if (port < TEST_PORT_RANGE.from || port > TEST_PORT_RANGE.to) {
      throw new Error(
        `port posrednika ${port} jest poza zakresem zarezerwowanym dla testow ` +
          `(${TEST_PORT_RANGE.from}-${TEST_PORT_RANGE.to})`,
      );
    }
    const url = new URL(target);
    this.#targetPort = Number(url.port);
    this.#targetOrigin = `${url.protocol}//${url.host}`;
    if (this.#targetPort === port) throw new Error('posrednik nie moze wskazywac na samego siebie');
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.#server) throw new Error('posrednik juz dziala');
    const server = createServer((req, res) => this.#forward(req, res));
    server.on('connection', (socket) => {
      if (this.#cut) {
        socket.destroy();
        return;
      }
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
    this.#server = server;
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(this.port, '127.0.0.1', () => done());
    });
  }

  #forward(req: IncomingMessage, res: ServerResponse): void {
    if (this.#cut) {
      req.socket.destroy();
      return;
    }
    const headers = { ...req.headers, host: `127.0.0.1:${this.#targetPort}` };
    if (headers.origin) headers.origin = this.#targetOrigin;
    const upstream = httpRequest(
      { host: '127.0.0.1', port: this.#targetPort, path: req.url, method: req.method, headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        // No buffering of our own: an event stream has to arrive chunk by chunk.
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  }

  /** The wire goes away: open connections die, new ones are refused. */
  cut(): void {
    this.#cut = true;
    for (const socket of [...this.#sockets]) socket.destroy();
    this.#sockets.clear();
  }

  /** The wire comes back. */
  restore(): void {
    this.#cut = false;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    for (const socket of [...this.#sockets]) socket.destroy();
    this.#sockets.clear();
    await new Promise<void>((done) => server.close(() => done()));
  }
}
