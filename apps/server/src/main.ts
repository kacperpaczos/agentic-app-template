import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { DEFAULT_USER_ID, ensureBaseData, probeAuth } from '@platform/server';
import { composeApp } from './compose.ts';

const platform = composeApp();
const { app, config, versions } = platform;

/*
 * A fresh installation opens on real content, not on an empty canvas.
 *
 * Runs once per module and records it, so data the user deletes stays deleted —
 * a restart must not resurrect it. Set `APP_SKIP_BASE_DATA=1` to start
 * genuinely empty.
 */
if (process.env.APP_SKIP_BASE_DATA !== '1') {
  const base = await ensureBaseData(platform, { ownerId: DEFAULT_USER_ID });
  if (base.seeded.length > 0) {
    console.log(
      `[server] dane bazowe: ${base.seeded.join(', ')}` +
        (base.workspaces ? `, przestrzenie robocze: ${base.workspaces}` : ''),
    );
  }
}

/**
 * Production mode serves the built frontend from the same origin, so running the
 * app does not depend on the Vite dev server.
 */
const distDir = config.webDistDir ?? resolve(process.cwd(), '../web/dist');
if (existsSync(distDir)) {
  app.use('/assets/*', serveStatic({ root: distDir, rewriteRequestPath: (p) => p }));
  app.get('*', serveStatic({ path: 'index.html', root: distDir }));
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  const auth = probeAuth();
  console.log(`[server] http://localhost:${info.port}`);
  console.log(`[server] node=${versions.node} hono=${versions.hono} sdk=${versions.claudeAgentSdk} mastra=${versions.mastraCore}/${versions.mastraClaude}`);
  console.log(`[server] modules: ${platform.registry.modules.map((m) => m.meta.id).join(', ') || '(none)'}`);
  console.log(
    `[server] claude auth: ${auth.method} | credential=${auth.credential.state}` +
      `${auth.credential.subscriptionType ? ` (${auth.credential.subscriptionType})` : ''}` +
      ` | access=${auth.access.state}` +
      `${auth.apiKeyDetected ? ' | ANTHROPIC_API_KEY present and refused by policy' : ''}`,
  );
  console.log(`[server] static: ${existsSync(distDir) ? distDir : '(dev mode, served by Vite)'}`);
});

/** Graceful shutdown: no orphaned agent processes, no half-written database. */
let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`[server] ${signal}: zatrzymywanie...`);
  const aborted = platform.services.runs.abortAll(`server_${signal.toLowerCase()}`);
  if (aborted) console.log(`[server] przerwano ${aborted} uruchomien agenta`);
  server.close(() => {
    platform.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
