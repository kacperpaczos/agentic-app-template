import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { AppError, type ModuleToolDefinition, type ToolCallContext } from '@platform/contracts';
import type { ServerModuleRegistry } from '../registry/modules.ts';

export interface McpHostTool {
  /** Name inside the MCP server. */
  localName: string;
  /** Name Claude sees: `mcp__app__<localName>`. */
  exposedName: string;
  effect: 'read' | 'write';
  moduleId: string;
}

export const MCP_SERVER_NAME = 'app';
export const mcpToolName = (localName: string): string => `mcp__${MCP_SERVER_NAME}__${localName}`;

interface BuildInput {
  registry: ServerModuleRegistry;
  platformTools: ModuleToolDefinition<never>[];
  /** Resolves the per-call context; called fresh on every tool invocation. */
  contextFor: () => ToolCallContext;
}

/** One tool as the MCP server offers it. */
export interface ToolEntry {
  /** Name inside the MCP server; Claude sees `mcp__app__<localName>`. */
  localName: string;
  moduleId: string;
  def: ModuleToolDefinition<never>;
}

/** Platform tools first, then every module's, in registration order. */
export function collectToolEntries(input: {
  registry: ServerModuleRegistry;
  platformTools: ModuleToolDefinition<never>[];
}): ToolEntry[] {
  return [
    ...input.platformTools.map((def) => ({ localName: def.name, moduleId: 'platform', def })),
    ...input.registry.tools.map((t) => ({
      localName: t.qualifiedName,
      moduleId: t.moduleId,
      def: t.definition,
    })),
  ];
}

/**
 * What a tool call answers, in the MCP result shape. A type alias rather than an
 * interface so it satisfies the SDK's index-signature result type.
 */
export type ToolInvocationResult = {
  isError?: true;
  content: Array<{ type: 'text'; text: string }>;
};

/**
 * Validates a tool call's arguments against the tool's schema and runs its
 * handler with the given context. Throws what the handler throws.
 *
 * The one execution of a tool: the MCP server wraps it into a tool result
 * ({@link invokeTool}), and a record action performed from a table
 * (`POST /api/actions`) calls it directly — so a user's click and the model's
 * call pass the same validation into the same handler.
 */
export async function executeTool(
  entry: Pick<ToolEntry, 'localName' | 'def'>,
  args: unknown,
  ctx: ToolCallContext,
): Promise<unknown> {
  const { localName, def } = entry;
  const parsed = def.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new AppError('validation_failed', `Nieprawidlowe wejscie narzedzia ${localName}.`, {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  return def.handler(parsed.data as never, ctx);
}

/**
 * Runs one tool call: validate the arguments against the tool's schema, call
 * its handler with the run's context, and turn the outcome into an MCP result.
 *
 * The only way a tool is executed, whoever asks — the MCP server the model
 * talks to, or a scripted stand-in in a test — so a test that calls a tool
 * exercises the validation and error mapping the model gets, not a copy.
 */
export async function invokeTool(
  entry: Pick<ToolEntry, 'localName' | 'def'>,
  args: unknown,
  ctx: ToolCallContext,
): Promise<ToolInvocationResult> {
  try {
    const result = await executeTool(entry, args, ctx);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }],
    };
  } catch (err) {
    const appErr = AppError.from(err);
    // Returned as a tool error rather than thrown, so the agent can read
    // the reason and correct itself instead of the whole run dying.
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: appErr.code,
            message: appErr.message,
            details: appErr.details ?? null,
          }),
        },
      ],
    };
  }
}

/**
 * Builds the in-process MCP server exposed to the Claude Agent SDK.
 *
 * Every tool is a thin wrapper over a service method — the *same* method the
 * HTTP layer calls. Validation, ownership and idempotency therefore happen once,
 * in the service, and cannot be bypassed by talking to the model instead of to
 * the API.
 */
export function buildMcpServer(input: BuildInput): {
  server: ReturnType<typeof createSdkMcpServer>;
  tools: McpHostTool[];
} {
  const entries = collectToolEntries(input);

  const sdkTools = entries.map((entry) => {
    const { localName, def } = entry;
    assertMcpCompatibleShape(localName, def.inputSchema.shape as Record<string, unknown>);
    return tool(
      localName,
      def.description,
      def.inputSchema.shape,
      async (args: unknown) => invokeTool(entry, args, input.contextFor()),
      /*
       * `alwaysLoad` keeps a tool in the prompt instead of behind tool search.
       * See `ModuleToolDefinition.alwaysLoad` for the turn that made this
       * necessary: the model could not navigate because the navigation tool was
       * deferred, and no amount of instruction fixes a tool that is not there.
       */
      def.alwaysLoad ? { alwaysLoad: true } : undefined,
    );
  });

  return {
    server: createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: '0.1.0',
      instructions:
        'Narzedzia aplikacji. Dane biznesowe i kompozycja interfejsu zmieniaj wylacznie przez te narzedzia; nie modyfikuj bazy ani plikow aplikacji bezposrednio.',
      tools: sdkTools,
    }),
    tools: entries.map((e) => ({
      localName: e.localName,
      exposedName: mcpToolName(e.localName),
      effect: e.def.effect,
      moduleId: e.moduleId,
    })),
  };
}

/**
 * Guard against a silent MCP registration failure.
 *
 * The Claude Agent SDK converts each tool's Zod shape into JSON Schema for the
 * MCP `tools/list` response. `z.record(...)` has no conversion, and the failure
 * is not reported: the tool is dropped, and with it *every other tool on the
 * same server*, leaving the model with no application tools at all and no error
 * to explain it. (Reproduced with SDK 0.3.270; `z.looseObject({})`,
 * `z.object({}).catchall(...)`, `z.any()` and `z.unknown()` all convert fine.)
 *
 * This walk turns that into a startup error naming the tool and the field.
 */
export function assertMcpCompatibleShape(toolName: string, shape: Record<string, unknown>): void {
  const seen = new Set<unknown>();

  const walk = (node: unknown, path: string, optionalDepth = 0): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    const def = (node as { _zod?: { def?: Record<string, unknown> }; _def?: Record<string, unknown> });
    const zdef = def._zod?.def ?? def._def;
    if (!zdef) return;

    const type = zdef.type ?? zdef.typeName;
    if (type === 'record' || type === 'ZodRecord' || type === 'map' || type === 'ZodMap') {
      throw new AppError(
        'unsupported_operation',
        `Narzedzie ${toolName}: pole "${path}" uzywa z.record()/z.map(), czego Claude Agent SDK nie potrafi ` +
          'zamienic na JSON Schema. Skutkiem jest ciche usuniecie calego serwera MCP z sesji. ' +
          'Uzyj z.looseObject({}) lub z.unknown().',
      );
    }
    // A defaulted field is advertised to the model as REQUIRED: omitting it
    // fails MCP input validation with `expected "nonoptional", received undefined`.
    // (Reproduced with SDK 0.3.270 + zod 4.6.5.) Use `.optional()` and apply the
    // default inside the handler instead.
    if (
      (type === 'default' || type === 'ZodDefault' || type === 'prefault') &&
      !optionalDepth
    ) {
      throw new AppError(
        'unsupported_operation',
        `Narzedzie ${toolName}: pole "${path}" uzywa .default(). Claude Agent SDK zglasza takie pole modelowi ` +
          'jako WYMAGANE, wiec wywolanie bez niego konczy sie bledem walidacji. ' +
          'Uzyj .optional() i ustaw wartosc domyslna w uchwycie narzedzia.',
      );
    }

    // Entering an optional/nullable wrapper means a nested default can never be
    // the thing the model is asked to supply.
    const nextDepth =
      type === 'optional' || type === 'ZodOptional' || type === 'nullable' || type === 'ZodNullable'
        ? optionalDepth + 1
        : optionalDepth;

    for (const key of ['innerType', 'element', 'valueType', 'in', 'out']) {
      if (zdef[key]) walk(zdef[key], path, nextDepth);
    }
    if (Array.isArray(zdef.options)) {
      zdef.options.forEach((o, i) => walk(o, `${path}[${i}]`, nextDepth));
    }
    const nested = zdef.shape as Record<string, unknown> | undefined;
    if (nested && typeof nested === 'object') {
      for (const [k, v] of Object.entries(nested)) walk(v, path ? `${path}.${k}` : k, nextDepth);
    }
    if (zdef.catchall) walk(zdef.catchall, path, nextDepth);
  };

  for (const [key, value] of Object.entries(shape)) walk(value, key);
}
