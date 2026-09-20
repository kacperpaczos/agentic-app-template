import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import {
  AppError,
  MCP_SERVER_NAME,
  mcpToolName,
  type ModuleToolDefinition,
  type ToolCallContext,
} from '@platform/contracts';
import type { ServerModuleRegistry } from '../registry/modules.ts';
import { executeTool } from '../registry/tool-execution.ts';

export interface McpHostTool {
  /** Name inside the MCP server. */
  localName: string;
  /** Name Claude sees: `mcp__app__<localName>`. */
  exposedName: string;
  effect: 'read' | 'write';
  moduleId: string;
}

/*
 * Re-exported, not re-declared: the exposed name is also what the browser
 * matches an artifact renderer against, so it lives in `@platform/contracts`
 * where both ends read it from one definition.
 */
export { MCP_SERVER_NAME, mcpToolName };

/**
 * The SDK's own server factory and tool builder, passed through.
 *
 * Not for application code — `buildMcpServer` above is the way this platform
 * makes a server. It exists for the regression that reads what the SDK
 * *publishes* (`tests/mcp-published-schema.test.ts`): the agent SDK is a
 * dependency of this package and not of the repository root, so a test living
 * outside it cannot build a probe server of its own to compare against. Without
 * the comparison, everything `assertMcpCompatibleShape` believes about the
 * converter stays a belief.
 */
export { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';

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
 * Runs one tool call for the MCP server: the shared {@link executeTool}, with
 * the outcome turned into an MCP result.
 *
 * The error mapping the model sees is here; the validation and the handler are
 * the ones every other caller uses, so a test that calls a tool exercises what
 * the model gets, not a copy.
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
 * The effect and the access scope, in the tool's own description.
 *
 * L9.16 asks for two things of every read and every mutation: that its
 * *effect* and its *access scope* are stated. They were not — a handful of
 * descriptions said "zapisuje" and most said nothing, so what a tool changed and
 * what it could reach were things the model had to infer from the name.
 *
 * Derived from the declared `effect` rather than written out per tool, and
 * appended here rather than in each definition, for the reason that keeps such
 * statements true: a sentence somebody has to remember to write is a sentence
 * the next tool will not have. The `effect` field is already required, already
 * used to decide idempotency, and already shown in Settings — so the sentence
 * cannot drift from the behaviour without the field being wrong first.
 *
 * The scope half is the same statement the server's `instructions` make, said
 * where the model reads it: a tool is a door into the domain services, and there
 * is no other door. Nothing here *enforces* that — the enforcement is the
 * service layer and the sandbox (`agent/sandbox.ts`) — but a model told which
 * doors exist is a model that does not go looking for the window.
 */
export function toolEffectNote(effect: 'read' | 'write'): string {
  return effect === 'read'
    ? 'Skutek: wylacznie odczyt, niczego nie zmienia. ' +
        'Zakres dostepu: dane wlasciciela tej rozmowy, przez serwis domenowy — ' +
        'narzedzie nie siega do tabel ani do pliku bazy.'
    : 'Skutek: ZAPIS przez serwis domenowy (walidacja, sprawdzenie wlasciciela, wersja, idempotencja). ' +
        'Zakres dostepu: dane wlasciciela tej rozmowy — narzedzie nie siega do tabel ani do pliku bazy. ' +
        'Innej drogi do zmiany danych nie masz; nie probuj powloki ani plikow aplikacji.';
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
      `${def.description} ${toolEffectNote(def.effect)}`,
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
