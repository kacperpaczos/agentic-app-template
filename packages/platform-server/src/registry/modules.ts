import type {
  ModuleMigration,
  ModuleReadOperation,
  ModuleToolDefinition,
  PlatformRouteHandler,
  RouteRegistrar,
  ServerModule,
  ToolCallContext,
} from '@platform/contracts';
import { AppError , type UiTarget } from '@platform/contracts';
import { buildUiTargetCatalog } from './ui-targets.ts';

export interface RegisteredRoute {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  moduleId: string;
  handler: PlatformRouteHandler;
}

export interface RegisteredReadOperation {
  /** Qualified name used in live artifact descriptors: `<moduleId>.<name>`. */
  qualifiedName: string;
  moduleId: string;
  definition: ModuleReadOperation<never>;
}

export interface RegisteredTool {
  /** Fully qualified name exposed over MCP: `<moduleId>_<toolName>`. */
  qualifiedName: string;
  moduleId: string;
  definition: ModuleToolDefinition<never>;
}

/**
 * Holds every business module the composition root decided to install.
 *
 * The platform depends on this registry, never on a concrete module. Booting
 * with an empty registry is a supported configuration and is exercised by
 * `platform-without-module` in the test suite.
 */
export class ServerModuleRegistry {
  readonly #modules: ServerModule[] = [];
  readonly #routes: RegisteredRoute[] = [];
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #readOperations = new Map<string, RegisteredReadOperation>();

  register(mod: ServerModule): this {
    if (this.#modules.some((m) => m.meta.id === mod.meta.id)) {
      throw new AppError('conflict', `Modul ${mod.meta.id} jest juz zarejestrowany.`);
    }
    this.#modules.push(mod);

    for (const tool of mod.tools) {
      const qualifiedName = `${mod.meta.id}_${tool.name}`;
      if (this.#tools.has(qualifiedName)) {
        throw new AppError('conflict', `Narzedzie ${qualifiedName} juz istnieje.`);
      }
      this.#tools.set(qualifiedName, { qualifiedName, moduleId: mod.meta.id, definition: tool });
    }

    for (const op of mod.readOperations ?? []) {
      const qualifiedName = `${mod.meta.id}.${op.name}`;
      if (this.#readOperations.has(qualifiedName)) {
        throw new AppError('conflict', `Operacja odczytu ${qualifiedName} juz istnieje.`);
      }
      this.#readOperations.set(qualifiedName, {
        qualifiedName,
        moduleId: mod.meta.id,
        definition: op,
      });
    }

    if (mod.routes) {
      const registrar: RouteRegistrar = {
        get: (path, handler) => this.#addRoute('get', mod.meta.id, path, handler),
        post: (path, handler) => this.#addRoute('post', mod.meta.id, path, handler),
        patch: (path, handler) => this.#addRoute('patch', mod.meta.id, path, handler),
        delete: (path, handler) => this.#addRoute('delete', mod.meta.id, path, handler),
      };
      mod.routes(registrar);
    }
    return this;
  }

  #addRoute(
    method: RegisteredRoute['method'],
    moduleId: string,
    path: string,
    handler: PlatformRouteHandler,
  ): void {
    if (!path.startsWith('/')) throw new AppError('internal', `Sciezka modulu musi zaczynac sie od "/": ${path}`);
    this.#routes.push({ method, path: `/api/m/${moduleId}${path}`, moduleId, handler });
  }

  get modules(): readonly ServerModule[] {
    return this.#modules;
  }

  get routes(): readonly RegisteredRoute[] {
    return this.#routes;
  }

  get tools(): readonly RegisteredTool[] {
    return [...this.#tools.values()];
  }

  migrations(): ModuleMigration[] {
    return this.#modules.flatMap((m) => m.migrations);
  }

  tool(qualifiedName: string): RegisteredTool | undefined {
    return this.#tools.get(qualifiedName);
  }

  get readOperations(): readonly RegisteredReadOperation[] {
    return [...this.#readOperations.values()];
  }

  readOperation(qualifiedName: string): RegisteredReadOperation | undefined {
    return this.#readOperations.get(qualifiedName);
  }

  /**
   * Every semantic UI target the agent may name, platform's plus the modules'.
   *
   * Assembled in one place so that the catalog shown to the agent and the one
   * the browser resolves against are the same list.
   */
  uiTargets(): UiTarget[] {
    return buildUiTargetCatalog(this.#modules.map((m) => m.uiTargets ?? []));
  }

  /** Concatenated module briefings for the agent's system prompt. */
  briefings(): string {
    return this.#modules
      .filter((m) => m.agentBriefing)
      .map((m) => `## Modul: ${m.meta.title} (${m.meta.id})\n${m.agentBriefing}`)
      .join('\n\n');
  }

  async describeResource(
    resource: { kind: string; id: string } | null,
    ownerId: string,
  ): Promise<string | null> {
    if (!resource) return null;
    for (const m of this.#modules) {
      if (!m.describeResource) continue;
      try {
        const d = await m.describeResource(resource, ownerId);
        if (d) return d;
      } catch {
        /* a module that cannot describe a resource must not break the run */
      }
    }
    return null;
  }

  defaultComposition(scope: { kind: string; id: string }) {
    for (const m of this.#modules) {
      const comp = m.defaultComposition?.(scope);
      if (comp?.length) return comp;
    }
    return [];
  }

  async callTool(qualifiedName: string, input: unknown, ctx: ToolCallContext): Promise<unknown> {
    const entry = this.#tools.get(qualifiedName);
    if (!entry) throw new AppError('not_found', `Nieznane narzedzie ${qualifiedName}.`);
    const parsed = entry.definition.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError('validation_failed', `Nieprawidlowe wejscie narzedzia ${qualifiedName}.`, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return entry.definition.handler(parsed.data as never, ctx);
  }
}
