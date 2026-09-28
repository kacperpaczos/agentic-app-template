import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildMcpServer, platformTools, probeAuth, subscriptionOnlyEnv } from '@platform/server';
import { composeApp } from '../compose.ts';

/**
 * Integration diagnostic.
 *
 * Starts one real Claude Agent SDK session with the application's own MCP server
 * and reports what the model can actually see. This is the check that turns
 * "the package is installed" into "the tools are registered in a live session".
 *
 *   pnpm --filter @app/server diag
 */
const dataDir = mkdtempSync(join(tmpdir(), 'agentic-diag-'));
const platform = composeApp({ dataDir });

const { server, tools } = buildMcpServer({
  registry: platform.registry,
  platformTools: platformTools(platform.services),
  contextFor: () => {
    throw new Error('diagnostyka nie wykonuje narzedzi');
  },
});

const auth = probeAuth();
console.log(
  `[diag] uwierzytelnienie: ${auth.method} | poswiadczenie=${auth.credential.state}` +
    `${auth.credential.subscriptionType ? ` (${auth.credential.subscriptionType})` : ''}` +
    ` | dostep=${auth.access.state}`,
);
console.log(`[diag] klucz API w srodowisku: ${auth.apiKeyDetected ? 'wykryty (odrzucany)' : 'brak'}`);
console.log(`[diag] zadeklarowanych narzedzi: ${tools.length}`);

const started = Date.now();
let exitCode = 0;

try {
  const q = query({
    prompt: 'ok',
    options: {
      model: platform.config.model,
      settingSources: [],
      env: subscriptionOnlyEnv(),
      mcpServers: { app: server },
      maxTurns: 1,
    },
  });

  for await (const message of q) {
    if (message.type === 'system' && message.subtype === 'init') {
      const all = message.tools ?? [];
      const mcp = all.filter((t) => t.startsWith('mcp__app__'));
      console.log(`[diag] sesja: ${message.session_id}`);
      console.log(`[diag] model: ${message.model}`);
      console.log(`[diag] narzedzia widoczne w sesji: ${all.length}, w tym z serwera "app": ${mcp.length}`);

      const declared = new Set(tools.map((t) => t.exposedName));
      const missing = [...declared].filter((n) => !all.includes(n));
      const extra = mcp.filter((n) => !declared.has(n));
      if (missing.length) {
        console.error(`[diag] BRAKUJACE narzedzia (${missing.length}): ${missing.join(', ')}`);
        exitCode = 1;
      }
      if (extra.length) console.log(`[diag] nadmiarowe: ${extra.join(', ')}`);
      if (!missing.length) console.log('[diag] wszystkie zadeklarowane narzedzia sa zarejestrowane w sesji');

      const otherMcp = all.filter((t) => t.startsWith('mcp__') && !t.startsWith('mcp__app__'));
      console.log(
        otherMcp.length
          ? `[diag] UWAGA: obce serwery MCP w sesji: ${otherMcp.join(', ')}`
          : '[diag] izolacja konfiguracji OK: brak obcych serwerow MCP',
      );
      break;
    }
  }
  await q.interrupt?.().catch(() => undefined);
} catch (err) {
  console.error(`[diag] blad: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 2;
}

console.log(`[diag] czas: ${Date.now() - started} ms`);
platform.close();
rmSync(dataDir, { recursive: true, force: true });
process.exit(exitCode);
