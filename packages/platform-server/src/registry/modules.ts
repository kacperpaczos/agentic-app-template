import type {
  ModuleMigration,
  ModuleReadOperation,
  ModuleToolDefinition,
  PlatformRouteHandler,
  RouteRegistrar,
  ServerModule,
  ToolCallContext,
  ViewDefinition,
} from '@platform/contracts';
import { AppError , type UiTarget } from '@platform/contracts';
import { buildUiTargetCatalog } from './ui-targets.ts';
import { OpenUiServerCatalog, validateComposition } from './openui-validation.ts';
import type { ReadOperationLookup } from './read-operations.ts';
import { checkReadDescriptor, checkViewAgainstTarget, checkViewShape } from './views.ts';
import { checkRecordActions } from './record-actions.ts';
import { executeTool } from './tool-execution.ts';

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

export interface RegisteredView {
  moduleId: string;
  definition: ViewDefinition;
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
  readonly #views = new Map<string, RegisteredView>();

  register(mod: ServerModule): this {
    if (this.#modules.some((m) => m.meta.id === mod.meta.id)) {
      throw new AppError('conflict', `Modul ${mod.meta.id} jest juz zarejestrowany.`);
    }

    /*
     * Everything this module declares about reads and views is checked before
     * any of it is recorded, so a refused module leaves the registry exactly as
     * it was rather than half-installed.
     */
    const readOperations = new Map<string, RegisteredReadOperation>();
    for (const op of mod.readOperations ?? []) {
      const qualifiedName = `${mod.meta.id}.${op.name}`;
      if (this.#readOperations.has(qualifiedName) || readOperations.has(qualifiedName)) {
        throw new AppError('conflict', `Operacja odczytu ${qualifiedName} juz istnieje.`);
      }
      const descriptor = checkReadDescriptor(qualifiedName, op);
      if (descriptor) checkRecordActions({ moduleId: mod.meta.id, operation: qualifiedName, descriptor, tools: mod.tools });
      readOperations.set(qualifiedName, { qualifiedName, moduleId: mod.meta.id, definition: op });
    }

    /*
     * The module's OpenUI components join the catalog its views are checked
     * against — refused here, too, when a name is already taken.
     */
    const openui =
      mod.views?.length || mod.openuiComponents?.length
        ? new OpenUiServerCatalog([...this.#modules.flatMap((m) => m.openuiComponents ?? []), ...(mod.openuiComponents ?? [])])
        : null;
    const reads: ReadOperationLookup = {
      readOperation: (name) => readOperations.get(name) ?? this.#readOperations.get(name),
      readOperations: [...this.#readOperations.values(), ...readOperations.values()],
    };

    const views = new Map<string, RegisteredView>();
    for (const raw of mod.views ?? []) {
      const view = checkViewShape(mod.meta.id, raw);
      if (this.#views.has(view.id) || views.has(view.id)) {
        throw new AppError('conflict', `Widok ${view.id} jest juz zarejestrowany.`);
      }
      checkViewAgainstTarget({
        moduleId: mod.meta.id,
        view,
        target: (mod.uiTargets ?? []).find((t) => t.id === view.id),
        readOperation: (name) =>
          (readOperations.get(name) ?? this.#readOperations.get(name))?.definition,
      });
      /*
       * The composition itself, parsed as the browser will parse it: known
       * components with valid props, registered reads with valid input, only
       * declared fields, and a `DataTable` on the primary read the narrowing
       * applies to. A view that fails any of it would render as a quietly
       * broken screen, so the module does not start.
       */
      try {
        validateComposition({
          source: view.composition,
          mode: 'catalog',
          catalog: openui!,
          reads,
          params: view.params,
          primaryOperation: view.primaryOperation,
        });
      } catch (err) {
        throw new Error(
          `Modul ${mod.meta.id}, widok ${view.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      views.set(view.id, { moduleId: mod.meta.id, definition: view });
    }

    this.#modules.push(mod);
    for (const [name, entry] of readOperations) this.#readOperations.set(name, entry);
    for (const [id, entry] of views) this.#views.set(id, entry);

    for (const tool of mod.tools) {
      const qualifiedName = `${mod.meta.id}_${tool.name}`;
      if (this.#tools.has(qualifiedName)) {
        throw new AppError('conflict', `Narzedzie ${qualifiedName} juz istnieje.`);
      }
      this.#tools.set(qualifiedName, { qualifiedName, moduleId: mod.meta.id, definition: tool });
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

  /** Every module view, in registration order. */
  views(): ViewDefinition[] {
    return [...this.#views.values()].map((v) => v.definition);
  }

  view(id: string): RegisteredView | undefined {
    return this.#views.get(id);
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

  /**
   * Runs a module tool by its qualified name, through the same execution as
   * the MCP server and a record action ({@link executeTool}) — validation and
   * handler are not repeated here.
   */
  async callTool(qualifiedName: string, input: unknown, ctx: ToolCallContext): Promise<unknown> {
    const entry = this.#tools.get(qualifiedName);
    if (!entry) throw new AppError('not_found', `Nieznane narzedzie ${qualifiedName}.`);
    return executeTool({ localName: qualifiedName, def: entry.definition }, input, ctx);
  }
}
