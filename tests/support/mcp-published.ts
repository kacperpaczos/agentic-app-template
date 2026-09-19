import type { createSdkMcpServer } from '@platform/server';

/**
 * What the MCP server **publishes** — the JSON Schema the Claude Agent SDK
 * derives from each tool's Zod shape, and the validation it applies to a call.
 *
 * ## Why reach for this at all
 *
 * `assertMcpCompatibleShape` (agent/mcp.ts) is a *static* walk over the Zod
 * shape. It encodes two beliefs about somebody else's converter: that
 * `z.record()` cannot be converted, and that a `.default()` is advertised to the
 * model as required unless it sits under an `.optional()`. Beliefs about another
 * library are exactly what a static check cannot verify — and the second one is
 * what L9.13 names as unverified: the guard *permits* a default nested under an
 * optional without anyone having seen how the SDK announces such a field when
 * the parent object **is** supplied.
 *
 * The conversion happens in the server's `tools/list` handler and the validation
 * in its `tools/call` handler, so asking those two questions means asking the
 * server the way a client would.
 *
 * ## Why not an MCP client
 *
 * `@modelcontextprotocol/sdk` is not a dependency of this repository — it
 * arrives underneath the agent SDK — and adding one to read a schema in a test
 * is a lockfile change with its own regression. So the handlers are invoked
 * directly on the server instance the SDK handed us.
 *
 * That reaches past the public surface, which is a deliberate and narrow
 * exception (`AGENTS.md`: a last resort, described and protected). It is
 * protected here: {@link mcpRequestHandlers} fails with a message naming what
 * moved, so an SDK upgrade that renames the internals produces a readable test
 * failure instead of a silent `undefined` that makes every assertion below
 * vacuous.
 */

type SdkServer = ReturnType<typeof createSdkMcpServer>;

/** One tool as the server announces it to a client. */
export interface PublishedTool {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
  };
}

export interface JsonSchemaNode {
  type?: string | string[];
  default?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode | JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  additionalProperties?: boolean | JsonSchemaNode;
  [k: string]: unknown;
}

type Handler = (
  request: { method: string; params: Record<string, unknown> },
  extra: unknown,
) => Promise<Record<string, unknown>>;

/**
 * The server's request handlers, or a failure that says which assumption broke.
 *
 * Three separate things have to be true, and each is checked by name so the
 * error points at the one that changed rather than at the first `undefined`
 * downstream of it.
 */
export function mcpRequestHandlers(server: SdkServer): Map<string, Handler> {
  const instance = (server as unknown as { instance?: unknown }).instance;
  if (!instance || typeof instance !== 'object') {
    throw new Error(
      'createSdkMcpServer() nie zwraca juz pola "instance" — sonda schematow MCP ' +
        '(tests/support/mcp-published.ts) musi zostac dopasowana do nowej wersji SDK.',
    );
  }
  const inner = (instance as { server?: unknown }).server;
  if (!inner || typeof inner !== 'object') {
    throw new Error(
      'instancja serwera MCP nie ma juz pola "server" — sonda schematow MCP musi zostac dopasowana.',
    );
  }
  const handlers = (inner as { _requestHandlers?: unknown })._requestHandlers;
  if (!(handlers instanceof Map)) {
    throw new Error(
      'serwer MCP nie ma juz mapy "_requestHandlers" — sonda schematow MCP musi zostac dopasowana.',
    );
  }
  for (const method of ['tools/list', 'tools/call']) {
    if (!handlers.has(method)) {
      throw new Error(`serwer MCP nie obsluguje "${method}" — sonda schematow MCP musi zostac dopasowana.`);
    }
  }
  return handlers as Map<string, Handler>;
}

const extra = () => ({
  signal: new AbortController().signal,
  sendNotification: async () => {},
  sendRequest: async () => ({}),
  requestId: 1,
});

/** Every tool the server announces, with the JSON Schema the SDK derived. */
export async function publishedTools(server: SdkServer): Promise<PublishedTool[]> {
  const handler = mcpRequestHandlers(server).get('tools/list')!;
  const result = await handler({ method: 'tools/list', params: {} }, extra());
  return (result.tools ?? []) as PublishedTool[];
}

export interface CallOutcome {
  ok: boolean;
  /** The tool's own answer, or the validation failure's message. */
  text: string;
}

/**
 * Calls a tool the way a client does — through the server's own input
 * validation, which is the half of "runtime semantics" a schema cannot show.
 */
export async function callPublishedTool(
  server: SdkServer,
  name: string,
  args: Record<string, unknown>,
): Promise<CallOutcome> {
  const handler = mcpRequestHandlers(server).get('tools/call')!;
  try {
    const result = (await handler(
      { method: 'tools/call', params: { name, arguments: args } },
      extra(),
    )) as { isError?: boolean; content?: Array<{ text?: string }> };
    return {
      ok: result.isError !== true,
      text: (result.content ?? []).map((c) => c.text ?? '').join(''),
    };
  } catch (err) {
    // A schema violation is refused before the handler runs, and arrives here
    // as a JSON-RPC error rather than as a tool result.
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
}
