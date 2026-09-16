#!/usr/bin/env node
/**
 * DIAGNOSTIC (audit 2026-09-15) — not production code.
 *
 * Reports the versions actually installed in node_modules, resolved the same way
 * Node resolves them at runtime. package.json ranges and the lockfile can both
 * disagree with what is really loaded, so this walks from the resolved entry
 * point up to the owning manifest.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const require = createRequire(resolve(process.cwd(), 'packages/platform-server/src/index.ts'));
const requireUi = createRequire(resolve(process.cwd(), 'packages/platform-ui/src/index.ts'));

const pick = (name, req = require) => {
  try {
    let dir = dirname(req.resolve(name));
    for (let i = 0; i < 10; i += 1) {
      const m = resolve(dir, 'package.json');
      if (existsSync(m)) {
        const j = JSON.parse(readFileSync(m, 'utf8'));
        if (j.name === name && j.version) return j.version;
      }
      const p = dirname(dir);
      if (p === dir) break;
      dir = p;
    }
  } catch { /* not resolvable from this entry point */ }
  return 'NIEROZWIAZANE';
};

const server = ['hono', '@hono/node-server', 'drizzle-orm', 'better-sqlite3', 'zod',
  '@mastra/core', '@mastra/claude', '@anthropic-ai/claude-agent-sdk'];
const ui = ['react', 'react-dom', '@openuidev/react-ui', '@openuidev/react-lang',
  '@openuidev/lang-core', '@openuidev/react-headless', '@ag-ui/core', '@xyflow/react',
  '@tanstack/react-query', '@tanstack/react-router', 'zustand'];

console.log('node        ', process.versions.node);
for (const n of server) console.log(n.padEnd(36), pick(n));
for (const n of ui) console.log(n.padEnd(36), pick(n, requireUi));
