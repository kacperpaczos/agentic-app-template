import type { z } from 'zod';
import type { DataSort, UiCommandResult, UiTarget, ViewFilter } from './ui.ts';
import type { AppContext } from './agent.ts';
import type { CardSpec } from './canvas.ts';
import type { ReadResultDescriptor, ViewDefinition } from './views.ts';

/* -------------------------------------------------------------------------- */
/*  Module identity + navigation                                              */
/* -------------------------------------------------------------------------- */

export interface ModuleMeta {
  /** Stable module id, used as a namespace for tools, tables and menu ids. */
  id: string;
  title: string;
  version: string;
  description: string;
}

export const MENU_SECTIONS = [
  'workspace',
  'records',
  'data',
  'files',
  'settings',
] as const;
export type MenuSection = (typeof MENU_SECTIONS)[number];

export interface MenuItemContribution {
  id: string;
  section: MenuSection;
  label: string;
  /** Router path, relative to the app root. */
  to: string;
  order?: number;
}

/**
 * A suggested opening command for the chat.
 *
 * Contributed by the module, never written into the platform: a starter that
 * says "compare the offers" is business vocabulary, and the platform shell must
 * not contain any.
 */
export interface ConversationStarterContribution {
  displayText: string;
  prompt: string;
}

/* -------------------------------------------------------------------------- */
/*  Framework-neutral HTTP contract                                           */
/* -------------------------------------------------------------------------- */

export interface PlatformRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  /** Parsed JSON body, or `undefined`. */
  body: unknown;
  /** Authenticated owner. Never taken from the body or from the model. */
  ownerId: string;
  headers: Record<string, string | undefined>;
}

export interface PlatformResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type PlatformRouteHandler = (
  req: PlatformRequest,
) => Promise<PlatformResponse> | PlatformResponse;

export interface RouteRegistrar {
  get(path: string, handler: PlatformRouteHandler): void;
  post(path: string, handler: PlatformRouteHandler): void;
  patch(path: string, handler: PlatformRouteHandler): void;
  delete(path: string, handler: PlatformRouteHandler): void;
}

/* -------------------------------------------------------------------------- */
/*  Tools                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A module tool. The very same handler backs the MCP tool exposed to Claude and
 * (where a matching route is registered) the plain HTTP endpoint, so there is
 * exactly one implementation of every business operation.
 */
export type ToolInputShape = Record<string, z.ZodTypeAny>;

export interface ModuleToolDefinition<TInput = unknown> {
  /** Unqualified name; the platform prefixes it with the module id. */
  name: string;
  description: string;
  /**
   * Must be a `z.object({...})`. The MCP host needs the raw shape (the Claude
   * SDK's `tool()` helper takes a ZodRawShape, not a schema), and the HTTP layer
   * needs the schema — so both are derived from this one declaration.
   */
  inputSchema: z.ZodObject<ToolInputShape>;
  /** `read` tools are always allowed; `write` tools go through idempotency. */
  effect: 'read' | 'write';
  /**
   * Keep this tool in the model's context instead of behind tool search.
   *
   * The SDK defers tools once there are many of them: they are not in the
   * prompt, and the model has to go looking with `ToolSearch` before it can
   * call one. Observed consequence, on a real turn: asked what was in a view's
   * data, the model searched for the two tools it thought it needed, answered
   * from them, and never moved the screen — because the tool that moves the
   * screen was not in front of it. The system prompt told it to navigate and
   * named a tool it did not have.
   *
   * So this is for the few tools a model has to *know exist* to behave
   * correctly, rather than the ones it goes looking for once it knows what it
   * wants. Use it sparingly: every always-loaded tool is in every prompt.
   */
  alwaysLoad?: boolean;
  handler: (input: TInput, ctx: ToolCallContext) => Promise<unknown>;
}

/* -------------------------------------------------------------------------- */
/*  Read operations (live artifacts)                                          */
/* -------------------------------------------------------------------------- */

/**
 * A named, typed, read-only query a module publishes for the platform to call
 * on its behalf.
 *
 * This is what makes a live artifact safe. A live artifact stores a *descriptor*
 * — an operation name plus its input — not code and not SQL. When the artifact
 * is opened, the platform looks the name up in this registry, validates the
 * input against the declared schema, and runs the module's own function with the
 * authenticated owner. The model can therefore choose *which registered query*
 * an artifact re-runs, and nothing else; it cannot describe a query of its own.
 *
 * Read-only by contract: the platform calls these on plain reads, so an
 * implementation that mutates would turn opening a report into a write.
 */
export interface ReadOperationContext {
  /** Authenticated owner. Never taken from the descriptor or from the model. */
  ownerId: string;
}

export interface ModuleReadOperation<TInput = unknown> {
  /** Unqualified name; the platform prefixes it with the module id. */
  name: string;
  description: string;
  /** Must be a `z.object({...})`; the platform validates descriptors against it. */
  inputSchema: z.ZodObject<ToolInputShape>;
  run: (input: TInput, ctx: ReadOperationContext) => Promise<unknown>;
  /**
   * What the result holds: where its records are, what identifies one, and
   * every field a view may show, with its label, type and unit.
   *
   * Required for a read that data components (`DataTable`, `DataChart`,
   * `DataSummary`) render. Validated when the module registers, and checked
   * against the result on every read: a result without the declared collection
   * is reported as a failure, never shown as an empty list.
   */
  result?: ReadResultDescriptor;
}

export interface ToolCallContext {
  ownerId: string;
  /** Live application context for the run that called the tool. */
  appContext: AppContext;
  conversationId: string | null;
  runId: string | null;
  /** Per-run scratch directory the sandbox can read and write. */
  workspaceDir: string | null;
  /** Emits a platform event onto the run's AG-UI stream. */
  emit: (event: ModuleEmittedEvent) => void;
  /**
   * Asks the browser to move the interface and **waits for its answer**.
   *
   * Returns what the client reports actually happened, including the ways it
   * can fail: no such target, element not on screen, the user is looking at a
   * different conversation, or no client acknowledged at all. A tool that
   * reported success on the strength of having sent the request would be
   * claiming an effect nobody observed.
   *
   * Absent outside a run (there is no interface to move).
   */
  requestUi?: (command: {
    targetId: string;
    spaceId?: string | null;
    /** Narrowing to apply; `null` clears one. Omitted leaves the view alone. */
    filter?: ViewFilter | null;
    /** Order to apply; `null` returns the view to its own. Omitted leaves it alone. */
    sort?: DataSort | null;
    reason?: string;
  }) => Promise<UiCommandResult>;
}

export type ModuleEmittedEvent =
  | { type: 'data_changed'; resources: string[] }
  | { type: 'canvas_changed'; spaceId: string }
  | { type: 'artifact_created'; artifactId: string };

/* -------------------------------------------------------------------------- */
/*  Server-side module contract                                               */
/* -------------------------------------------------------------------------- */

export interface ModuleMigration {
  id: string;
  sql: string;
}

export interface ModuleSeedContext {
  ownerId: string;
  /** Copies a local file into the managed file store and returns its id. */
  storeFile: (input: {
    filename: string;
    mediaType: string;
    bytes: Uint8Array;
    scopeKind?: string;
    scopeId?: string;
  }) => Promise<{ id: string }>;
}

/**
 * Server-side half of the component catalog.
 *
 * The browser renders these components; the server validates every composition
 * an agent proposes against the same list. Without this, "unknown component /
 * bad props are never committed" could only be enforced client-side, i.e. not
 * enforced at all.
 */
export interface CardComponentDescriptor {
  /** Component id used in `CardSpec.component`. */
  id: string;
  description: string;
  propsSchema: z.ZodObject<ToolInputShape>;
  /** One-line usage hint injected into the agent's system prompt. */
  usage: string;
}

export interface ServerModule {
  meta: ModuleMeta;
  migrations: ModuleMigration[];
  tools: ModuleToolDefinition<never>[];
  /**
   * Semantic places in this module's screens the agent may be asked to open.
   *
   * Declared here — on the server half — although the selectors describe browser
   * markup, because the agent runs on the server and needs to know what exists
   * before it can name one. The browser reads the same list back from the API,
   * so there is exactly one catalog and the agent cannot be told about a target
   * the client could not perform.
   *
   * Contributed rather than discovered: only the module knows which of its
   * elements are meaningful destinations. The platform holds the list and
   * refuses anything not on it.
   */
  uiTargets?: UiTarget[];
  /**
   * Queries the platform may re-run on this module's behalf when a live
   * artifact is opened. See {@link ModuleReadOperation}.
   */
  readOperations?: ModuleReadOperation<never>[];
  /**
   * This module's screens as OpenUI Lang compositions over the shared catalog.
   *
   * A view with its own screen has the `id` of its `UiTarget`. When that target
   * declares `filter`, the view must name its `primaryOperation`, and every
   * narrowable field must be a field of that read's descriptor — refused at
   * startup otherwise. Served to the browser by `GET /api/ui/views`.
   */
  views?: ViewDefinition[];
  cardComponents?: CardComponentDescriptor[];
  routes?: (register: RouteRegistrar) => void;
  /**
   * Extra system-prompt text describing this module's domain to the agent.
   * Business *rules* live in the services; this only explains vocabulary.
   */
  agentBriefing?: string;
  /**
   * Resolves the opaque `resource` of an AppContext into a short, human readable
   * summary the agent can use without loading the database.
   */
  describeResource?: (
    resource: { kind: string; id: string },
    ownerId: string,
  ) => Promise<string | null>;
  /** Default canvas composition for a freshly created space in this scope. */
  /**
   * Records this module created as base data that deserve a ready workspace.
   *
   * Declared by the module because only it knows which of its records a user
   * would open first. The platform turns each into a canvas space filled from
   * `defaultComposition`, so a fresh installation opens on real content instead
   * of an empty canvas.
   */
  baseDataScopes?: (ownerId: string) => Array<{ kind: string; id: string; title: string }>;

  defaultComposition?: (scope: {
    kind: string;
    id: string;
  }) => Array<{ title: string; spec: CardSpec; geometry?: Partial<{ x: number; y: number; width: number; height: number }> }>;
  seed?: (ctx: ModuleSeedContext) => Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*  Client-side module contract                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everything the browser half of a module contributes. Kept structural (no React
 * types here) so this package stays framework-neutral; `@platform/ui` narrows it.
 */
export interface ClientModule<TComponentDef = unknown, TElement = unknown, TRoute = unknown> {
  meta: ModuleMeta;
  /** OpenUI component definitions added to the shared catalog. */
  components: Record<string, TComponentDef>;
  /** Card renderers for `kind: 'component'` specs, keyed by component id. */
  cardRenderers: Record<string, TElement>;
  /** Artifact renderers, keyed by `rendererType`. */
  artifactRenderers?: Record<string, TElement>;
  menu: MenuItemContribution[];
  routes: TRoute[];
}
