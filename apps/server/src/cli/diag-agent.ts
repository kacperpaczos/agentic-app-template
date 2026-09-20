import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  buildMcpServer,
  createSdkMcpServer,
  platformTools,
  probeAuth,
  sdkTool,
  subscriptionOnlyEnv,
} from '@platform/server';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { composeApp } from '../compose.ts';

/**
 * Integration diagnostic — a real Claude Agent SDK session, and **no model turn**.
 *
 * ## What it answers
 *
 * "The package is installed" and "the tools are registered in a live session"
 * are different claims, and only the second one matters. This opens a real
 * session with the application's own MCP server and asks the CLI three
 * questions it can answer without the model:
 *
 *   1. did the server connect, and does it carry **every** declared tool
 *      (L7.11, L9.13 — the comparison that a static schema guard cannot make);
 *   2. is the session free of MCP servers this application did not pass
 *      (isolation; see `strictMcpConfig` below);
 *   3. how is the runtime authenticated (subscription, never an API key).
 *
 * ## Why it costs nothing
 *
 * The earlier version sent `prompt: 'ok'` and broke out of the message loop at
 * `system/init`. That is a *user message*: whether it reached the model before
 * the interrupt landed was a race, and a diagnostic that might spend a paid turn
 * is one nobody runs. This one passes an input stream that never yields, so the
 * model is never asked anything, and reads the answers through **control
 * requests** (`initializationResult`, `mcpServerStatus`, `accountInfo`) — the
 * CLI answers those itself. The whole run takes a few seconds and spends zero
 * turns, which is what lets it be part of an acceptance script rather than a
 * favour somebody does by hand.
 *
 * The one consequence: the `system/init` message never arrives (it is delivered
 * to the message stream, which only moves once there is something to answer), so
 * the tool list comes from `mcpServerStatus()` instead. It carries more: the
 * per-server connection state, and the tools *that server* published rather than
 * the flat list of everything in the session.
 *
 *   pnpm --filter @app/server diag
 *   pnpm --filter @app/server diag -- --zapis docs/evidence/z11-bl03/diag.json
 *   pnpm --filter @app/server diag -- --proba-niezgodnego-schematu
 */

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
};

/**
 * Detection trial for the comparison below.
 *
 * With this flag the session is given a server carrying one tool the SDK cannot
 * convert (`z.record`), built **without** `assertMcpCompatibleShape` so the
 * startup guard does not stop it. The point is what the CLI then reports: a
 * connected server with an empty tool list and no error. If this mode exits 0,
 * the comparison below has stopped being able to detect the failure it exists
 * for, and the report saying "all tools registered" means nothing.
 */
const brokenSchemaTrial = flag('--proba-niezgodnego-schematu');

/**
 * Detection trial for the isolation check.
 *
 * Drops `strictMcpConfig`, which is the only thing keeping MCP servers attached
 * to the *account* out of the session — `settingSources: []` does not, as this
 * mode demonstrates on any machine that has one. On a machine with no account
 * connector there is nothing to find and the mode exits 0; that is an honest
 * "not reproducible here", not a pass.
 */
const noMcpIsolationTrial = flag('--proba-bez-izolacji-mcp');
const outFile = value('--zapis');

const dataDir = mkdtempSync(join(tmpdir(), 'agentic-diag-'));
const platform = composeApp({ dataDir });

const built = buildMcpServer({
  registry: platform.registry,
  platformTools: platformTools(platform.services),
  contextFor: () => {
    throw new Error('diagnostyka nie wykonuje narzedzi');
  },
});

const trialServer = () =>
  createSdkMcpServer({
    name: 'app',
    version: '0.1.0',
    tools: [
      sdkTool('zdrowe', 'Zwykle narzedzie probne.', { a: z.string() }, async () => ({
        content: [{ type: 'text' as const, text: 'ok' }],
      })),
      sdkTool(
        'niekonwertowalne',
        'Uzywa z.record(), czego SDK nie zamienia na JSON Schema.',
        { m: z.record(z.string(), z.string()) },
        async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      ),
    ],
  });

const server = brokenSchemaTrial ? trialServer() : built.server;
/* In the trial the declared list is the two probe tools, not the application's. */
const declared = brokenSchemaTrial ? ['zdrowe', 'niekonwertowalne'] : built.tools.map((t) => t.localName);

const auth = probeAuth(process.env);
if (auth.method === 'glm') {
  /*
   * Tryb GLM: endpoint tylko jako ORIGIN (pełny URL może nieść poświadczenie w
   * query), token nigdy. Poświadczenie OAuth nie jest tu istotne i nie jest
   * czytane — dlatego wiersz o nim milczy zamiast opisywać plik.
   */
  console.log(
    `[diag] provider modelu: GLM/Z.AI | endpoint: ${platform.config.modelEndpointOrigin} | model: ${platform.config.model}`,
  );
  console.log('[diag] subskrypcja Claude: nieuzywana (tryb GLM); poswiadczenie OAuth nie jest czytane');
  console.log(
    `[diag] poswiadczenie endpointu w srodowisku: ${auth.apiKeyDetected ? 'wykryte' : 'brak'} | ` +
      'ANTHROPIC_API_KEY, Bedrock, Vertex: usuwane ze srodowiska agenta',
  );
} else {
  console.log(
    `[diag] uwierzytelnienie: ${auth.method} | poswiadczenie=${auth.credential.state}` +
      `${auth.credential.subscriptionType ? ` (${auth.credential.subscriptionType})` : ''}` +
      ` | dostep=${auth.access.state}`,
  );
  console.log(`[diag] klucz API w srodowisku: ${auth.apiKeyDetected ? 'wykryty (odrzucany)' : 'brak'}`);
}
console.log(`[diag] zadeklarowanych narzedzi: ${declared.length}${brokenSchemaTrial ? ' (PROBA: serwer z niekonwertowalnym schematem)' : ''}`);

/** An input stream that never yields: the model is never handed a message. */
const noPrompt = (async function* (): AsyncGenerator<SDKUserMessage> {
  await new Promise(() => {});
})();

const started = Date.now();
let exitCode = 0;

const record: Record<string, unknown> = {
  zapisano: new Date().toISOString(),
  zrodlo: 'prawdziwa sesja Claude Agent SDK, wylacznie zadania sterujace (zero tur modelu)',
  proba: brokenSchemaTrial
    ? 'niezgodny schemat'
    : noMcpIsolationTrial
      ? 'bez strictMcpConfig'
      : 'konfiguracja aplikacji',
  /* Provider i endpoint jako ORIGIN; wartość tokena nigdy nie trafia do zapisu. */
  provider:
    auth.method === 'glm'
      ? {
          nazwa: 'GLM/Z.AI',
          endpoint: platform.config.modelEndpointOrigin,
          model: platform.config.model,
          subskrypcjaClaude: 'nieuzywana (tryb GLM)',
        }
      : 'subskrypcja Claude (domyslny tryb)',
  zadeklarowane: declared.length,
};

const q = query({
  prompt: noPrompt,
  options: {
    model: platform.config.model,
    settingSources: [],
    /* Ta sama polityka co w runtime: glm przepuszcza wyłącznie BASE_URL + AUTH_TOKEN. */
    env: subscriptionOnlyEnv(process.env, platform.config.modelProvider),
    mcpServers: { app: server },
    /* The same isolation the runtime applies; see the note in agent/runtime.ts. */
    ...(noMcpIsolationTrial ? {} : { strictMcpConfig: true }),
    maxTurns: 1,
  },
});

try {
  const init = await q.initializationResult();
  /*
   * Deliberately not the account's e-mail or organisation: this output is meant
   * to be pasted into a report, and neither is anybody's business there. The
   * plan and the backend are what the subscription-only policy is about.
   */
  const account = init.account ?? {};
  console.log(
    `[diag] konto: plan=${account.subscriptionType ?? '?'} backend=${account.apiProvider ?? '?'}` +
      `${account.apiKeySource && account.apiKeySource !== 'none' ? ` zrodloKlucza=${account.apiKeySource}` : ''}`,
  );
  record.plan = account.subscriptionType ?? null;
  record.backend = account.apiProvider ?? null;

  /*
   * An in-process MCP server connects a moment after the CLI starts, so the
   * first answer is routinely `pending`. Asking once and reporting "no tools"
   * would be a diagnostic that fails on a fast machine and passes on a slow one.
   */
  let status = await q.mcpServerStatus();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const app = status.find((s) => s.name === 'app');
    if (app && app.status !== 'pending') break;
    await new Promise((r) => setTimeout(r, 400));
    status = await q.mcpServerStatus();
  }

  const app = status.find((s) => s.name === 'app');
  console.log(`[diag] serwer "app": ${app ? app.status : 'NIEOBECNY'}${app?.error ? ` (${app.error})` : ''}`);
  record.statusSerwera = app?.status ?? 'nieobecny';
  record.bladSerwera = app?.error ?? null;

  const seen = (app?.tools ?? []).map((t) => t.name);
  const missing = declared.filter((n) => !seen.includes(n));
  const extra = seen.filter((n) => !declared.includes(n));
  console.log(`[diag] narzedzia serwera "app" w sesji: ${seen.length}`);
  record.widoczne = seen.length;
  record.brakujace = missing;
  record.nadmiarowe = extra;

  if (missing.length) {
    console.error(
      `[diag] BRAKUJACE narzedzia (${missing.length}): ${missing.join(', ')}. ` +
        'Serwer MCP moze byc zarejestrowany, a jego narzedzia mimo to nieobecne — ' +
        'tak wyglada niekonwertowalny schemat (patrz assertMcpCompatibleShape).',
    );
    exitCode = 1;
  } else {
    console.log('[diag] wszystkie zadeklarowane narzedzia sa zarejestrowane w sesji');
  }
  if (extra.length) console.log(`[diag] nadmiarowe: ${extra.join(', ')}`);

  const foreign = status.filter((s) => s.name !== 'app');
  record.obceSerwery = foreign.map((s) => s.name);
  if (foreign.length) {
    console.error(
      `[diag] UWAGA: obce serwery MCP w sesji: ${foreign.map((s) => `${s.name}[${s.scope ?? '?'}]`).join(', ')}. ` +
        'Ich narzedzia nie sa narzedziami tej aplikacji i nie podlegaja jej sandboxowi.',
    );
    exitCode = 1;
  } else {
    console.log('[diag] izolacja konfiguracji OK: brak obcych serwerow MCP');
  }
} catch (err) {
  console.error(`[diag] blad: ${err instanceof Error ? err.message : String(err)}`);
  record.blad = err instanceof Error ? err.message : String(err);
  exitCode = 2;
} finally {
  q.close();
}

record.czasMs = Date.now() - started;
record.kodWyjscia = exitCode;
console.log(`[diag] czas: ${record.czasMs} ms | kod wyjscia: ${exitCode}`);

if (outFile) {
  const path = resolve(process.cwd(), outFile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`[diag] zapis: ${path}`);
}

platform.close();
rmSync(dataDir, { recursive: true, force: true });
process.exit(exitCode);
