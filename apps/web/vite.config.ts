import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { devInstanceGate, resolveDevApi } from './src/dev-proxy.ts';

/**
 * Dev server proxies the API to the backend so the browser sees one origin and
 * the session cookie works without cross-site rules. The production build is a
 * plain static bundle served by the backend itself.
 *
 * Which backend is not a constant. It used to be `http://localhost:8791` —
 * the port an installed instance of this application listens on — so running
 * `pnpm dev` beside one silently developed against its real data. The target
 * now comes from `APP_DEV_API_PORT` with a default that is deliberately *not*
 * that port, and the instance answering it has to identify itself before a
 * single request is forwarded (`src/dev-proxy.ts`).
 */
const api = resolveDevApi(process.env);

/**
 * Refuses to proxy to an instance that is not this mode's backend.
 *
 * Installed as a plugin middleware rather than inside the proxy's `configure`,
 * because it has to answer *instead of* forwarding: `configureServer` runs
 * before Vite's internal middlewares, so this sees the request first and the
 * proxy never sees it at all when the check fails.
 */
function devApiGuard(): Plugin {
  const gate = devInstanceGate(api);
  return {
    name: 'app-dev-api-guard',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api', (_req, res, next) => {
        void gate().then((problem) => {
          if (!problem) return next();
          server.config.logger.error(problem, { timestamp: true });
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: { code: 'dev_proxy_refused', message: problem } }));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devApiGuard()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: api.target,
        changeOrigin: false,
        // Server-sent events must not be buffered by the proxy.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
