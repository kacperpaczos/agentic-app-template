import { AppError, type ModuleToolDefinition, type ToolCallContext } from '@platform/contracts';

/**
 * The one execution of a tool: validate the arguments against the tool's own
 * schema, then run its handler with the caller's context. Throws what the
 * handler throws.
 *
 * Every caller goes through here — the MCP server the model talks to
 * (`invokeTool`, which only wraps the outcome into an MCP result), the
 * registry's `callTool`, a record action performed from a table
 * (`POST /api/actions`) and the scripted stand-in in the browser tests — so a
 * user's click, a test's call and the model's call pass the same validation
 * into the same handler, and none of them is a copy of it.
 *
 * It lives in the registry rather than next to the MCP server because the
 * registry must not depend on the agent's half of the platform to run a tool.
 */
export async function executeTool(
  entry: { localName: string; def: ModuleToolDefinition<never> },
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
