import { Mastra } from '@mastra/core';
import { ClaudeSDKAgent } from '@mastra/claude';
import {
  PLATFORM_CUSTOM_EVENTS,
  UI_COMMAND_ACK_TIMEOUT_MS,
  UI_COMMAND_FAILURES,
  type AppContext,
  type AppErrorCode,
  type ModuleEmittedEvent,
  type ToolCallContext,
  type UiCommand,
  type UiCommandResult,
} from '@platform/contracts';
import type { PlatformServices } from '../services/index.ts';
import { classifyAccessFailure, recordVerification, subscriptionOnlyEnv } from './auth.ts';
import { RunEventStream } from './events.ts';
import { newId } from '../util/id.ts';
import { ConversationProjection, type ProjectedMessage } from './projection.ts';
import { buildMcpServer, mcpToolName } from './mcp.ts';
import { platformTools, stageFileIntoWorkspace } from './tools/index.ts';
import { buildSystemPrompt } from './prompt.ts';
import { createRunWorkspace, sandboxSettings, type RunWorkspace } from './sandbox.ts';
import { analysisToolkit } from './toolkit.ts';

/**
 * Built-in Claude tools the run may use inside the sandboxed workspace, split by
 * how they are approved.
 *
 * `allowedTools` is an *allow-rule* list: a bare name there auto-approves the
 * tool before `canUseTool` is ever consulted (the SDK emits
 * CLAUDE_SDK_CAN_USE_TOOL_SHADOWED when this happens). Listing `Bash` there
 * would therefore have made the consent gate dead code. Shell access is left
 * out of the list on purpose so it falls through to `canUseTool` and reaches
 * the user as a real question.
 */
const AUTO_APPROVED_FILE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep'] as const;
const CONSENT_REQUIRED_TOOLS = ['Bash'] as const;

export interface StartRunInput {
  ownerId: string;
  conversationId: string;
  prompt: string;
  appContext: AppContext;
  /** Uploaded files staged into the run workspace before the model starts. */
  attachFileIds?: string[];
}

export interface StartedRun {
  runId: string;
  stream: RunEventStream;
  /** Resolves when the run reaches a terminal status. */
  done: Promise<void>;
}

interface PendingPermission {
  resolve: (allow: boolean) => void;
  toolName: string;
}

/**
 * Claude execution runtime.
 *
 * Layering: Mastra owns agent registration and is the object the application
 * calls; `@mastra/claude` owns the Claude Agent SDK loop; this class owns what
 * the adapter does not expose.
 *
 * Two adapter gaps are compensated here (both documented in FEEDBACK.md):
 *   1. `@mastra/claude` 0.3.1 forwards only text deltas into its Mastra stream —
 *      tool calls reach telemetry only. Tool events are therefore recovered from
 *      the Claude SDK's own `hooks` callbacks.
 *   2. The adapter never surfaces `session_id`, which the application needs to
 *      resume a conversation. It is also read from the hook payload.
 *
 * Concurrency: the MCP server is built *per run*, so a tool handler closes over
 * exactly one run's context and parallel runs cannot see each other's. Runs on
 * the same conversation are additionally serialised, because they resume the
 * same Claude session id.
 */
/**
 * The two calls this runtime makes into the model adapter.
 *
 * Declared structurally so tests can substitute a scripted stand-in at exactly
 * this boundary — see the `modelAgent` constructor argument. Production always
 * goes through Mastra.
 */
export interface ModelAgentLike {
  stream(prompt: string, options: unknown): Promise<{ fullStream: AsyncIterable<unknown> }>;
  resumeStream(
    input: { message: string; sessionId: string },
    options: unknown,
  ): Promise<{ fullStream: AsyncIterable<unknown> }>;
}

export class AgentRuntime {
  readonly #mastra: Mastra;
  readonly #agent: ClaudeSDKAgent;
  /**
   * Test seam. When set, model calls go here instead of through Mastra.
   *
   * It sits at the adapter boundary on purpose: a stand-in receives the very
   * same `sdkOptions` the Claude Agent SDK would, hooks included, so a test can
   * reproduce orderings the real model produces only by chance — a tool before
   * the first word, a word before the first tool, an answer with no text at all
   * — and the runtime under test is otherwise unmodified. Simulations built on
   * it are marked as simulations wherever their results are reported.
   */
  readonly #modelAgent: ModelAgentLike | null;
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  /** UI commands emitted and not yet acknowledged by a browser. */
  readonly #pendingUiCommands = new Map<string, (result: UiCommandResult) => void>();
  /** One promise chain per conversation: same session id cannot run twice at once. */
  readonly #conversationQueue = new Map<string, Promise<unknown>>();
  readonly #toolNames: string[];

  constructor(
    private readonly services: PlatformServices,
    modelAgent: ModelAgentLike | null = null,
  ) {
    this.#modelAgent = modelAgent;
    // Built once with a throw-away context purely to enumerate the tool names
    // that go into `allowedTools`; the servers actually used are per-run.
    const probe = buildMcpServer({
      registry: services.modules,
      platformTools: platformTools(services),
      contextFor: () => {
        throw new Error('probe server is not callable');
      },
    });
    this.#toolNames = probe.tools.map((t) => t.exposedName);

    this.#agent = new ClaudeSDKAgent({
      id: 'app-agent',
      name: 'Agent aplikacji',
      description: 'Agent pracujacy na danych aplikacji przez narzedzia MCP.',
      sdkOptions: {
        model: services.config.model,
        // SDK isolation: the developer's own ~/.claude settings, MCP servers and
        // CLAUDE.md files must not leak into the application's agent.
        settingSources: [],
        env: subscriptionOnlyEnv(),
        // Required for incremental text. `@mastra/claude`'s `getTextDelta` reads
        // only `stream_event` messages; without this flag the SDK sends whole
        // assistant messages and the adapter emits the entire answer as a single
        // chunk at the end of the run.
        includePartialMessages: true,
      },
    });

    this.#mastra = new Mastra({
      agents: { appAgent: this.#agent },
    });
  }

  /** The Mastra-registered agent; going through Mastra is the supported path. */
  get agent(): ModelAgentLike {
    return (this.#modelAgent ??
      (this.#mastra.getAgent('appAgent') as unknown)) as ModelAgentLike;
  }

  get toolNames(): string[] {
    return [...this.#toolNames];
  }

  answerPermission(requestId: string, allow: boolean): boolean {
    const pending = this.#pendingPermissions.get(requestId);
    if (!pending) return false;
    this.#pendingPermissions.delete(requestId);
    pending.resolve(allow);
    return true;
  }

  /**
   * Asks the browser to move the interface, and waits to be told what happened.
   *
   * The waiting is the point. Emitting an event and returning "done" would let
   * the agent report a navigation that never occurred — the client may not be
   * connected, the target may not exist on this screen, or the command may come
   * from a conversation the user is no longer looking at. Each of those is a
   * different answer, and the model gets the real one.
   *
   * Times out rather than hanging: no acknowledgement means nothing is known to
   * have happened, which is reported as `no_client` and not as success.
   */
  requestUiCommand(
    command: UiCommand,
    stream: RunEventStream,
    // The budget the tab plans its acknowledgement against, too.
    timeoutMs = UI_COMMAND_ACK_TIMEOUT_MS,
  ): Promise<UiCommandResult> {
    stream.custom(PLATFORM_CUSTOM_EVENTS.uiCommand, command);
    return new Promise<UiCommandResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pendingUiCommands.delete(command.commandId)) {
          resolve({
            commandId: command.commandId,
            executed: false,
            reason: UI_COMMAND_FAILURES.noClient,
          });
        }
      }, timeoutMs);
      this.#pendingUiCommands.set(command.commandId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /** Called by the client's acknowledgement endpoint. */
  acknowledgeUiCommand(result: UiCommandResult): boolean {
    const pending = this.#pendingUiCommands.get(result.commandId);
    if (!pending) return false;
    this.#pendingUiCommands.delete(result.commandId);
    pending(result);
    return true;
  }

  /**
   * Live event streams of runs still executing in this process.
   *
   * A run is not the HTTP request that started it. The browser can close,
   * reload or switch to another conversation, and the work carries on — so a
   * client coming back needs somewhere to re-attach. This registry is what
   * `GET /api/runs/:id/stream` hands out; once a run resolves its entry is
   * dropped and re-attachment falls back to the persisted event log, which is
   * the same sequence.
   */
  readonly #liveStreams = new Map<string, RunEventStream>();

  /** Live stream of a run still executing here, or null if it has resolved. */
  liveStream(runId: string): RunEventStream | null {
    return this.#liveStreams.get(runId) ?? null;
  }

  async start(input: StartRunInput): Promise<StartedRun> {
    const conversation = this.services.conversations.get(input.conversationId, input.ownerId);
    const abort = new AbortController();

    const run = this.services.runs.start({
      conversationId: conversation.id,
      ownerId: input.ownerId,
      prompt: input.prompt,
      appContext: input.appContext,
      workspaceDir: null,
      abort,
    });

    const workspace = createRunWorkspace(
      this.services.config.workspacesDir,
      run.id,
      analysisToolkit(),
    );
    this.services.db.$client
      .prepare('UPDATE agent_runs SET workspace_dir = ? WHERE id = ?')
      .run(workspace.dir, run.id);

    /*
     * Conversation projection.
     *
     * Tool activity has to outlive the stream: the chat renders it from the
     * message list, so a reload or a restart must find the tool calls and their
     * results in the database, not only in the run's event log.
     *
     * Assistant text is written through a small time throttle — a row update per
     * streamed delta would be hundreds of writes per answer for no gain. The row
     * is inserted on the first delta (so a reader always sees the turn) and the
     * final state is forced out when the stream closes. Tool messages are never
     * throttled: they are few, and they are the record of what actually happened.
     */
    let pendingText: ProjectedMessage | null = null;
    let lastTextWrite = 0;
    const TEXT_WRITE_INTERVAL_MS = 250;

    const persist = (message: ProjectedMessage) => {
      this.services.conversations.upsertMessage(conversation.id, input.ownerId, {
        id: message.id,
        role: message.role,
        content: message.content,
        meta:
          message.role === 'assistant'
            ? { runId: run.id, toolCalls: message.toolCalls }
            : {
                runId: run.id,
                toolCallId: message.toolCallId,
                isError: message.isError,
                ...(message.error ? { error: message.error } : {}),
              },
      });
    };

    const flushPendingText = () => {
      if (!pendingText) return;
      persist(pendingText);
      pendingText = null;
    };

    const projection = new ConversationProjection(run.id, (message) => {
      if (message.role === 'tool') {
        flushPendingText();
        persist(message);
        return;
      }
      // First write of a segment goes straight through; later growth is throttled.
      const isNew = pendingText?.id !== message.id;
      pendingText = message;
      const now = Date.now();
      if (isNew || now - lastTextWrite >= TEXT_WRITE_INTERVAL_MS) {
        lastTextWrite = now;
        flushPendingText();
      }
    });

    const stream = new RunEventStream(run.id, this.services.runs, (event) => {
      projection.apply(event);
      if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
        projection.finish();
        flushPendingText();
      }
    });

    const staged: Array<{ fileId: string; path: string; filename: string; mediaType: string }> = [];
    for (const fileId of input.attachFileIds ?? []) {
      const meta = this.services.files.meta(fileId, input.ownerId);
      stageFileIntoWorkspace(this.services, input.ownerId, fileId, workspace.dir);
      staged.push({
        fileId,
        path: `input/${meta.filename}`,
        filename: meta.filename,
        mediaType: meta.mediaType,
      });
    }

    this.#liveStreams.set(run.id, stream);

    // Serialise per conversation; the tail of the chain is what we await.
    const previous = this.#conversationQueue.get(conversation.id) ?? Promise.resolve();
    const done = previous
      .catch(() => undefined)
      .then(() =>
        this.#execute({
          runId: run.id,
          ownerId: input.ownerId,
          conversationId: conversation.id,
          prompt: input.prompt,
          appContext: input.appContext,
          stream,
          workspace,
          abort,
          staged,
        }),
      )
      .finally(() => {
        workspace.dispose();
        this.#liveStreams.delete(run.id);
        if (this.#conversationQueue.get(conversation.id) === done) {
          this.#conversationQueue.delete(conversation.id);
        }
      });
    this.#conversationQueue.set(conversation.id, done);

    return { runId: run.id, stream, done };
  }

  #forwardModuleEvent(stream: RunEventStream, event: ModuleEmittedEvent): void {
    if (event.type === 'canvas_changed') stream.canvasChanged(event.spaceId);
    else if (event.type === 'data_changed') stream.dataChanged(event.resources);
    else if (event.type === 'artifact_created') stream.artifactCreated(event.artifactId);
  }

  async #execute(args: {
    runId: string;
    ownerId: string;
    conversationId: string;
    prompt: string;
    appContext: AppContext;
    stream: RunEventStream;
    workspace: RunWorkspace;
    abort: AbortController;
    staged: Array<{ fileId: string; path: string; filename: string; mediaType: string }>;
  }): Promise<void> {
    const { runId, stream, abort } = args;
    /*
     * Measurement points, kept distinct on purpose (see `AgentRun`):
     *   enqueuedAt  — the run row was created and the request acknowledged;
     *   startedAt   — this run reached the head of its conversation queue and
     *                 execution actually began (recorded on the next line);
     *   firstTokenMs, durationMs — both relative to execution start, so a run
     *                 that waited behind another is not charged for the wait.
     */
    const executionStartedAt = Date.now();
    this.services.runs.markExecutionStart(runId);
    const messageId = `am_${runId}`;
    let textOpened = false;
    let firstTokenSeen = false;
    let sessionBound = false;

    // Re-read the conversation now that it is our turn: an earlier queued run
    // may have just bound the Claude session we must resume.
    const conversation = this.services.conversations.get(args.conversationId, args.ownerId);

    stream.runStarted(args.conversationId, runId);

    // A resumed run already knows its session; bind it immediately so a run that
    // makes no tool call is still traceable to a Claude session. `SessionStart`
    // fires only for a *new* session, and the tool hooks never fire at all when
    // the model answers from memory.
    if (conversation.claudeSessionId) {
      this.services.runs.bindSession(runId, conversation.claudeSessionId);
    }

    const bindSession = (sessionId: string) => {
      if (sessionBound || !sessionId) return;
      sessionBound = true;
      this.services.runs.bindSession(runId, sessionId);
      this.services.conversations.bindClaudeSession(args.conversationId, sessionId);
      stream.sessionBound(sessionId, args.conversationId);
    };

    const openText = () => {
      if (textOpened) return;
      textOpened = true;
      stream.textStart(messageId);
    };

    const toolCtx: ToolCallContext = {
      ownerId: args.ownerId,
      appContext: args.appContext,
      conversationId: args.conversationId,
      runId,
      workspaceDir: args.workspace.dir,
      emit: (event) => this.#forwardModuleEvent(stream, event),
      requestUi: (command) =>
        this.requestUiCommand(
          {
            commandId: newId('uic'),
            runId,
            // Carried so the client can refuse a command from a conversation
            // the user is not looking at, instead of hijacking their screen.
            conversationId: args.conversationId,
            targetId: command.targetId,
            spaceId: command.spaceId ?? null,
            // `undefined` and `null` differ here: the first leaves any narrowing
            // in place, the second is an explicit "show everything again".
            ...(command.filter !== undefined ? { filter: command.filter } : {}),
            ...(command.sort !== undefined ? { sort: command.sort } : {}),
            reason: command.reason,
            ...(command.reveal ? { reveal: command.reveal } : {}),
          },
          stream,
        ).then((result) => {
          /*
           * Which tab answered, with which version of its screen. `ui_state`
           * binds a version asked for without a tab to this one: versions count
           * per tab, and the tab that acknowledged is the one the number means.
           */
          if (result.uiClientId && result.uiVersion !== undefined) {
            this.services.uiSnapshots.recordAcknowledgement(args.ownerId, runId, {
              clientId: result.uiClientId,
              version: result.uiVersion,
            });
          }
          return result;
        }),
    };

    // Per-run MCP server: the handler closes over this run's context only.
    const { server } = buildMcpServer({
      registry: this.services.modules,
      platformTools: platformTools(this.services),
      contextFor: () => toolCtx,
    });

    const resourceSummary = await this.services.modules.describeResource(
      args.appContext.resource,
      args.ownerId,
    );

    const systemPrompt = buildSystemPrompt({
      registry: this.services.modules,
      catalog: this.services.catalog,
      appContext: args.appContext,
      resourceSummary,
      workspaceDir: args.workspace.dir,
      stagedFiles: args.staged,
      toolkit: args.workspace.toolkit,
    });

    /* -------------------- SDK hook bridge (see class doc) ------------------ */
    const hookCallback = async (raw: unknown) => {
      const input = raw as Record<string, any>;
      if (typeof input.session_id === 'string') bindSession(input.session_id);
      // Subagent traffic would double-report the main thread's work.
      if (input.agent_id) return { continue: true };

      if (input.hook_event_name === 'Stop') return { continue: true };

      if (input.hook_event_name === 'PreToolUse') {
        const id = String(input.tool_use_id ?? `tu_${Date.now()}`);
        /*
         * Deliberately does *not* open a text message.
         *
         * It used to. That single call was the cause of the lost first-token
         * metric: it set `textOpened` before a single token had arrived, so the
         * branch that records `first_token_ms` never ran on any run where the
         * model reached for a tool before it spoke — which is most of them.
         *
         * Nothing needs an open text message here. The AG-UI reducer attaches a
         * tool call to the current assistant segment whether or not a
         * TEXT_MESSAGE_START preceded it, and text arriving after a tool call
         * opens a fresh segment on its own.
         */
        stream.toolStart(id, String(input.tool_name ?? 'tool'), messageId);
        stream.toolArgs(id, JSON.stringify(input.tool_input ?? {}));
        stream.toolEnd(id);
      } else if (input.hook_event_name === 'PostToolUse') {
        const id = String(input.tool_use_id ?? '');
        if (id) stream.toolResult(id, summariseToolResponse(input.tool_response));
      } else if (input.hook_event_name === 'PostToolUseFailure') {
        // This hook carries `error`, not `tool_response` — reporting the latter
        // produced a literal "null" in the chat instead of the reason.
        const id = String(input.tool_use_id ?? '');
        if (id) {
          stream.toolResult(
            id,
            summariseToolResponse(input.error ?? input.tool_response ?? 'Narzedzie zakonczylo sie bledem.'),
            true,
          );
        }
      }
      return { continue: true };
    };

    const sdkOptions: Record<string, unknown> = {
      cwd: args.workspace.dir,
      mcpServers: { app: server },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      // Only the application's own tools and the workspace file tools are
      // pre-approved; Bash is deliberately absent (see the constant above).
      allowedTools: [...this.#toolNames, ...AUTO_APPROVED_FILE_TOOLS],
      permissionMode: 'default',
      sandbox: sandboxSettings({
        workspaceDir: args.workspace.dir,
        dataDir: this.services.config.dataDir,
      }),
      maxTurns: 40,
      canUseTool: this.#makeCanUseTool(stream),
      hooks: {
        SessionStart: [{ hooks: [hookCallback] }],
        PreToolUse: [{ hooks: [hookCallback] }],
        PostToolUse: [{ hooks: [hookCallback] }],
        PostToolUseFailure: [{ hooks: [hookCallback] }],
        // Last resort for the session id: `Stop` fires at the end of every turn,
        // including turns that used no tools at all.
        Stop: [{ hooks: [hookCallback] }],
      },
    };

    const timeout = setTimeout(
      () => abort.abort(new Error('run_timeout')),
      this.services.config.runTimeoutMs,
    );

    try {
      const agent = this.agent;
      const resume = conversation.claudeSessionId;
      /*
       * `toolContext` is a test seam, present only when a stand-in model is
       * installed at the adapter boundary.
       *
       * A scripted model reaches the application's tools the way the real one
       * does — through the MCP server — and driving that server's in-process
       * transport from a test harness would mean testing the SDK rather than
       * this application. Handing the stand-in the very context the MCP handler
       * would receive lets a scenario exercise a tool (a UI command, say) end to
       * end, with the runtime, the gate and the stream all real.
       *
       * Deliberately not added when going through Mastra: production must not
       * carry a field that exists for tests.
       */
      const callOptions = {
        sdkOptions,
        signal: abort.signal,
        ...(this.#modelAgent ? { toolContext: toolCtx } : {}),
      };
      const modelStream = resume
        ? await agent.resumeStream({ message: args.prompt, sessionId: resume }, callOptions as never)
        : await agent.stream(args.prompt, callOptions as never);

      for await (const chunk of modelStream.fullStream as AsyncIterable<Record<string, any>>) {
        if (chunk.type === 'text-delta' || chunk.type === 'text') {
          const delta: string = chunk.payload?.text ?? chunk.text ?? '';
          if (!delta) continue;
          // Measured on the first actual token, never on a stream lifecycle
          // call — a tool call before the first word must not consume it.
          if (!firstTokenSeen) {
            firstTokenSeen = true;
            this.services.runs.markFirstToken(runId, Date.now() - executionStartedAt);
          }
          openText();
          stream.textDelta(messageId, delta);
        } else if (chunk.type === 'error') {
          throw chunk.payload?.error ?? new Error('Blad strumienia modelu.');
        }
      }

      if (textOpened) stream.textEnd(messageId);

      // The answer is already stored: the projection wired into `stream` wrote
      // every assistant segment and every tool result as they were emitted.
      // Writing the text again here would produce a second copy of the turn
      // without any of its tool activity.

      const durationMs = Date.now() - executionStartedAt;
      this.services.runs.finish(runId, 'succeeded', { durationMs });
      recordVerification(true);
      stream.runFinished(args.conversationId, runId, { durationMs });
    } catch (err) {
      const message = errorMessage(err);
      const cancelled = abort.signal.aborted && !message.includes('run_timeout');
      const code = cancelled ? 'cancelled' : classifyModelError(message);
      if (textOpened) stream.textEnd(messageId);
      // Partial text is already persisted by the projection, so a failed or
      // cancelled run keeps whatever the model managed to say.
      this.services.runs.finish(runId, cancelled ? 'cancelled' : 'failed', {
        errorCode: code,
        errorMessage: message,
        durationMs: Date.now() - executionStartedAt,
      });
      /*
       * Every failure that was not a cancellation is a statement about access,
       * and is recorded as one. Filtering by error code — as this used to —
       * meant a rate limit or a refused refresh left the reported access state
       * showing the last success, long after it stopped being true.
       */
      if (!cancelled) recordVerification(false, message);
      if (cancelled) stream.custom(PLATFORM_CUSTOM_EVENTS.runCancelled, { runId });
      // Exactly one resolving terminal event, so the UI never hangs on loading.
      stream.runError(message, code);
    } finally {
      clearTimeout(timeout);
      this.services.uiSnapshots.forgetRun(runId);
      stream.close();
    }
  }

  /**
   * Permission gate. Read tools and the app's own write tools run unattended;
   * anything that reaches the shell asks the user through the chat, and an
   * unanswered request is a denial, never a silent allow.
   */
  #makeCanUseTool(stream: RunEventStream) {
    const alwaysAllow = new Set<string>([...this.#toolNames, ...AUTO_APPROVED_FILE_TOOLS]);
    return async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string }
    > => {
      if (alwaysAllow.has(toolName)) return { behavior: 'allow', updatedInput: input };

      const requestId = `perm_${Math.random().toString(36).slice(2, 12)}`;
      const allowed = await new Promise<boolean>((resolve) => {
        this.#pendingPermissions.set(requestId, { resolve, toolName });
        stream.custom(PLATFORM_CUSTOM_EVENTS.permissionRequest, {
          requestId,
          toolName,
          input: truncate(JSON.stringify(input ?? {}), 600),
          runId: stream.runId,
        });
        setTimeout(() => {
          if (this.#pendingPermissions.delete(requestId)) resolve(false);
        }, 120_000);
      });

      return allowed
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `Uzytkownik nie zgodzil sie na wykonanie ${toolName}.` };
    };
  }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

function summariseToolResponse(response: unknown): string {
  if (response == null) return 'null';
  if (typeof response === 'string') return truncate(response, 4000);
  try {
    return truncate(JSON.stringify(response), 4000);
  } catch {
    return String(response);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Distinguishes auth / limit problems from generic integration failures. */
/**
 * Maps a runtime failure onto the application's error taxonomy.
 *
 * Access failures are classified once, in `classifyAccessFailure`, and mapped
 * here — so what the chat shows, what the run record stores and what Settings
 * reports can never disagree about whether the subscription ran out or the
 * login broke.
 */
function classifyModelError(message: string): AppErrorCode {
  const m = message.toLowerCase();
  if (m.includes('sandbox')) return 'sandbox_denied';
  if (m.includes('run_timeout')) return 'integration_failed';

  switch (classifyAccessFailure(message)) {
    case 'rate_limited':
      return 'rate_limited';
    case 'revoked':
    case 'refresh_refused':
      return 'unauthenticated';
    default:
      return 'integration_failed';
  }
}

export { mcpToolName };
