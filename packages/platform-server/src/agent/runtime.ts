import { resolve } from 'node:path';
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { ClaudeSDKAgent } from '@mastra/claude';
import {
  AppError,
  PLATFORM_CUSTOM_EVENTS,
  UI_COMMAND_ACK_TIMEOUT_MS,
  UI_COMMAND_FAILURES,
  type AppContext,
  type AppErrorCode,
  type ConsentMode,
  type ModuleEmittedEvent,
  type ToolCallContext,
  type UiCommand,
  type UiCommandResult,
} from '@platform/contracts';
import type { PlatformServices } from '../services/index.ts';
import {
  classifyAccessFailure,
  isAccessRelevantFailure,
  recordVerification,
  subscriptionOnlyEnv,
} from './auth.ts';
import { RunEventStream } from './events.ts';
import { newId } from '../util/id.ts';
import { ConversationProjection, type ProjectedMessage } from './projection.ts';
import { buildMcpServer, mcpToolName } from './mcp.ts';
import { platformTools, stageFileIntoWorkspace } from './tools/index.ts';
import { buildSystemPrompt } from './prompt.ts';
import { createRunWorkspace, sandboxSettings, type RunWorkspace } from './sandbox.ts';
import { analysisToolkit } from './toolkit.ts';
import {
  AUTO_APPROVED_FILE_TOOLS,
  FORBIDDEN_TOOLS,
  decideTool,
  declaresPathArguments,
  directoryWalkRefusal,
  forbiddenToolMessage,
  protectedDirsFor,
  protectedPathRefusal,
  realResolve,
  resolvedPathInput,
  workspaceConfinementRefusal,
} from './permissions.ts';

export interface StartRunInput {
  ownerId: string;
  conversationId: string;
  prompt: string;
  appContext: AppContext;
  /** Uploaded files staged into the run workspace before the model starts. */
  attachFileIds?: string[];
  /**
   * The consent mode this run runs under (L11.12). Absent means `supervised`.
   *
   * Read once, here, and written into the run row; the gate reads the mode
   * from the **record** at every decision, never from a live payload, so there
   * is no way to raise a run's own privileges mid-execution.
   */
  consentMode?: ConsentMode;
  /**
   * The user message this run answers, when the caller knows it.
   *
   * Carried so the attachment link can name the *command*, not just the
   * conversation: "which file did I send with this instruction" is the question
   * the record has to answer later, and a conversation may hold many.
   */
  userMessageId?: string | null;
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
  /**
   * The raw tool input the question is about, kept for the task center's
   * `pendingPermission` view (L11.19): a run parked on a question has to be
   * describable to a client that was not watching when it was asked. Shown,
   * never re-executed — answering goes through `answerPermission` and is bound
   * to the run and owner there.
   */
  input: unknown;
  /**
   * The run that asked, and the owner it belongs to.
   *
   * Carried because the answer arrives on a *separate* HTTP request, and the
   * only thing tying the two together used to be the request id itself. The
   * endpoint checked that the run named in its path belonged to the caller and
   * then handed the id to a process-wide map, so an answer posted to run A's
   * address with run B's request id resolved B — including when B was somebody
   * else's run. Both fields are compared before anything is resolved.
   */
  runId: string;
  ownerId: string;
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
  /**
   * The environment of the process this runtime serves.
   *
   * The child environment is built from *this*, not from whatever
   * `process.env` happens to be at call time: the platform is configured from
   * one env (tests pass their own), and the provider policy applied to the
   * child must be the policy of the configuration that was validated — not of
   * a shell variable that changed afterwards.
   */
  readonly #env: NodeJS.ProcessEnv;
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  /** UI commands emitted and not yet acknowledged by a browser. */
  readonly #pendingUiCommands = new Map<string, (result: UiCommandResult) => void>();
  /** One promise chain per conversation: same session id cannot run twice at once. */
  readonly #conversationQueue = new Map<string, Promise<unknown>>();
  readonly #toolNames: string[];

  constructor(
    private readonly services: PlatformServices,
    modelAgent: ModelAgentLike | null = null,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.#modelAgent = modelAgent;
    this.#env = env;
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
        // The model comes from the configuration: the subscription default, or
        // APP_MODEL in the explicit glm mode. Never from ANTHROPIC_MODEL,
        // which the environment policy removes in both modes.
        model: services.config.model,
        // SDK isolation: the developer's own ~/.claude settings, MCP servers and
        // CLAUDE.md files must not leak into the application's agent.
        settingSources: [],
        // Provider-aware scrubbing: in the glm mode exactly the two endpoint
        // variables pass; every paid-API and cloud variable is removed in
        // both modes. See `subscriptionOnlyEnv`.
        env: subscriptionOnlyEnv(this.#env, services.config.modelProvider),
        // Required for incremental text. `@mastra/claude`'s `getTextDelta` reads
        // only `stream_event` messages; without this flag the SDK sends whole
        // assistant messages and the adapter emits the entire answer as a single
        // chunk at the end of the run.
        includePartialMessages: true,
      },
    });

    this.#mastra = new Mastra({
      agents: { appAgent: this.#agent },
      // Storage Mastry jest ustawiony jawnie (InMemoryStore z publicznego eksportu
      // `@mastra/core/storage`), żeby @mastra/core 1.66.0 nie ostrzegał przy każdym
      // boocie: „No `storage` configured on Mastra — falling back to an in-memory
      // store". To świadome ograniczenie, nie zaniedbanie: magazyn Mastry jest w tej
      // aplikacji martwy — korzysta z niego wyłącznie rejestracja agenta
      // (`getAgent('appAgent')` poniżej), a trwałość rozmów, przebiegów i artefaktów
      // realizuje własna baza SQLite (`app.db`, warstwa `services`). Żadne kryterium
      // restartu nie opiera się o pamięć Mastry. Prawdziwy adapter (@mastra/libsql
      // itd.) byłby nową zależnością — decyzja właściciela; decyzja opisana w
      // `docs/observability.md` (sekcja o storage Mastry) i `FEEDBACK.md` (T10).
      // Test strażnika: `tests/runtime.test.ts` (ostrzeżenie nie może wrócić).
      storage: new InMemoryStore(),
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

  /**
   * Answers one pending permission request of one run.
   *
   * Returns `false` — and changes nothing — when the request id is unknown,
   * when it belongs to a different run, or when it belongs to a different
   * owner. That is three separate ways of saying the same thing: a decision is
   * an answer to *this* question in *this* execution, and anything else is not
   * an answer at all.
   *
   * A repeat of an answer already given also returns `false`, because the entry
   * is removed when it is resolved. That is what stops a retried request (a
   * double click, a replayed POST, a client reconnecting and re-sending) from
   * letting the operation run a second time: the gate resolves once, the tool
   * executes once, and the second answer has nothing left to decide.
   *
   * The fields are required, not optional — the point made when the orchestration
   * package bound this to the run as well. An optional argument would make the
   * binding a convention every caller has to remember, and a caller that forgot
   * would get the old, unbound behaviour back without a word from the compiler.
   * Required, there is no way to answer a request without saying which execution,
   * and whose, is being answered. A mismatch leaves the pending request pending,
   * so the run that asked still waits for its own answer — and still times out
   * into a denial if none comes.
   */
  answerPermission(input: {
    runId: string;
    ownerId: string;
    requestId: string;
    allow: boolean;
  }): boolean {
    const pending = this.#pendingPermissions.get(input.requestId);
    if (!pending) return false;
    if (pending.runId !== input.runId || pending.ownerId !== input.ownerId) return false;
    this.#pendingPermissions.delete(input.requestId);
    pending.resolve(input.allow);
    return true;
  }

  /** Request ids still awaiting a decision. Exposed for assertions and diagnostics. */
  pendingPermissionIds(): string[] {
    return [...this.#pendingPermissions.keys()];
  }

  /**
   * The question one run is parked on, in the shape the task center publishes
   * (L11.19).
   *
   * Read from the same in-process map the gate and `answerPermission` use, so
   * the view cannot say a question is open after the map has lost it — the
   * entry is removed exactly when the question is resolved, whichever way it
   * resolved. A run reaches the gate one call at a time, so the first (and
   * normally only) entry of that run is the answer; if two were ever pending,
   * reporting the first is honest about there being an open question.
   */
  pendingPermissionFor(runId: string): { requestId: string; toolName: string; input: unknown } | undefined {
    for (const [requestId, pending] of this.#pendingPermissions) {
      if (pending.runId !== runId) continue;
      return { requestId, toolName: pending.toolName, input: pending.input };
    }
    return undefined;
  }

  /**
   * Refuses everything this run was still waiting to be told, and says why.
   *
   * Called when the run is aborted — Stop, the hard timeout, a shutdown. Without
   * it a cancelled run stayed alive inside the gate: the abort signal reaches
   * the model's stream, but a run parked on `canUseTool` is not *in* the stream,
   * it is awaiting a promise nobody is going to settle, so Stop took effect only
   * when the consent timeout expired — up to two minutes later, with the
   * workspace still on disk. Refusal rather than allowance, for the same reason
   * expiry is a refusal: an operation nobody approved must not run because the
   * run was being stopped.
   */
  #refusePendingPermissions(runId: string): void {
    for (const [requestId, pending] of [...this.#pendingPermissions]) {
      if (pending.runId !== runId) continue;
      this.#pendingPermissions.delete(requestId);
      pending.resolve(false);
    }
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
      // Wejście zadania utrwalone od startu: centrum zadań pokazuje, co
      // wykonanie dostało, także gdy pliki już znikną z rozmowy.
      inputFileIds: input.attachFileIds ?? [],
      userMessageId: input.userMessageId ?? null,
      // Tryb zgód zapisywany raz, na wierszu wykonania; bramka czyta go
      // z rekordu, nie z payloadu — patrz `#consentModeOfRun`.
      consentMode: input.consentMode ?? 'supervised',
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
    /*
     * Written after staging, not before: the link states which files this
     * execution actually received. A file the owner check refused never gets
     * here, so it never appears as an attachment of the command either.
     */
    if (input.userMessageId && staged.length > 0) {
      this.services.conversations.linkAttachments({
        conversationId: conversation.id,
        ownerId: input.ownerId,
        messageId: input.userMessageId,
        runId: run.id,
        fileIds: staged.map((s) => s.fileId),
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
    /*
     * Stopped while it was still waiting: it never executes.
     *
     * Cancelling a queued run used to abort a signal that nothing was reading
     * yet, so when the run reached the head of the queue it started anyway —
     * it was marked `running`, it opened a stream, it built its MCP server and
     * described its resource, and only the model call then noticed the abort.
     * The user pressed stop before any of that was asked for. It is refused
     * here instead, with the one terminal event every other path guarantees.
     */
    if (abort.signal.aborted) {
      this.services.runs.finish(runId, 'cancelled', {
        errorCode: 'cancelled',
        errorMessage: 'Zatrzymane przed rozpoczeciem wykonania.',
        durationMs: 0,
      });
      stream.custom(PLATFORM_CUSTOM_EVENTS.runCancelled, { runId });
      stream.runError('Zatrzymane przed rozpoczeciem wykonania.', 'cancelled');
      stream.close();
      this.services.uiSnapshots.forgetRun(runId);
      return;
    }

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

    /* The session this run asked the SDK to continue, or null for a new one. */
    const requestedResume = conversation.claudeSessionId;
    let resumeMismatchReported = false;

    const bindSession = (sessionId: string) => {
      if (!sessionId) return;
      /*
       * The second way a transcript can be gone — and the quiet one.
       *
       * `#resumeOrReportLostTranscript` covers the case where the SDK refuses
       * the resume. It may instead accept it and answer from a *different*
       * session, in which case nothing fails and the conversation's earlier
       * history is on screen above an answer produced without it. Whatever the
       * reason, a session id other than the one we asked to resume means this
       * run is not continuing that transcript, so the memory was not restored
       * and the application says so rather than implying otherwise.
       *
       * The run is **not** aborted here, deliberately. Which of the two
       * behaviours the SDK actually exhibits when a transcript is missing has
       * not been observed on a real session (see docs/ACCEPTANCE.md, L7.13), and
       * if a future SDK version were to hand out a fresh id on every ordinary
       * resume, failing the run would break every follow-up message in every
       * conversation. Reporting is safe under both readings; refusing is not.
       */
      if (requestedResume && sessionId !== requestedResume && !resumeMismatchReported) {
        resumeMismatchReported = true;
        this.services.conversations.forgetClaudeSession(args.conversationId, requestedResume);
        stream.custom(PLATFORM_CUSTOM_EVENTS.sessionTranscriptLost, {
          conversationId: args.conversationId,
          lostSessionId: requestedResume,
          newSessionId: sessionId,
          memoryRestored: false,
          bindingCleared: true,
          detectedBy: 'session_id_mismatch',
        });
        console.warn(
          `[run ${runId}] wznowienie sesji ${requestedResume} odpowiedzialo z sesji ${sessionId}: ` +
            'pamiec wczesniejszej rozmowy NIE zostala odtworzona',
        );
      }
      if (sessionBound) return;
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

    const resourceDescription = await this.services.modules.describeResource(
      args.appContext.resource,
      args.ownerId,
    );

    const systemPrompt = buildSystemPrompt({
      registry: this.services.modules,
      catalog: this.services.catalog,
      appContext: args.appContext,
      resourceSummary: resourceDescription.summary,
      resourceDescription,
      workspaceDir: args.workspace.dir,
      stagedFiles: args.staged,
      toolkit: args.workspace.toolkit,
    });

    /**
     * A tool call id that cannot be confused with another run's.
     *
     * The ready-made chat pairs an assistant message's `toolCalls[]` with the
     * `role: "tool"` messages of the *whole* conversation by `toolCallId`
     * (`pairToolActivity`), so uniqueness has to hold across every run of a
     * conversation — not only within one. The provider's id does not promise
     * that: `tool_use_id` is unique inside a session, a resumed session may
     * restart it, and the fallback used when a hook carries none
     * (`tu_<Date.now()>`) promises even less. Two runs reusing one id made the
     * second run's result attach to the first run's call: a successful call
     * shown as failed, an argument list shown under the wrong step.
     *
     * The run id is the one thing that is unique per execution by construction,
     * so it is the namespace. Applied here, at the single point where the SDK's
     * id enters the platform, so the live stream and the stored history carry
     * the identical id and cannot drift.
     */
    const scopeToolId = (raw: unknown): string => `${runId}~${String(raw)}`;

    /**
     * Directories no tool of a run may open, whatever the model asks for.
     *
     * Built per run because one of them is configuration (`CLAUDE_CONFIG_DIR`)
     * and reading it once at import time would guard the wrong directory in a
     * test that redirects it — which is exactly the shape of the defect in the
     * secret scan this package also repairs.
     */
    const protectedDirs = protectedDirsFor(this.services.config.dataDir);

    /* -------------------- SDK hook bridge (see class doc) ------------------ */
    const hookCallback = async (raw: unknown) => {
      const input = raw as Record<string, any>;
      if (typeof input.session_id === 'string') bindSession(input.session_id);
      /*
       * A call made by a **subagent**, not by the main thread.
       *
       * It used to return here, before anything else, because subagent traffic
       * would double-report the main thread's work in the chat. That was right
       * about the stream and catastrophic about the refusal below: every one of
       * the three protections for the credential directory came off at once for
       * a subagent. The hook (layer 2) left before deciding; the gate (layer 3)
       * is shadowed for `Read` by `allowedTools`; and the sandbox (layer 1)
       * does not constrain the SDK's own file tools at all. The tool that
       * starts a subagent is neither allowed nor forbidden, so it goes to the
       * consent prompt — one "yes" and the credential was readable again.
       *
       * The exact shape of the hole this package was written to close: a
       * category that bypasses the gate meeting a mechanism that does not cover
       * it. So the flag is now carried, not acted on immediately: the refusal is
       * decided for subagents too, and only the *reporting* of ordinary tool
       * activity stays silent.
       */
      const fromSubagent = Boolean(input.agent_id);

      if (input.hook_event_name === 'Stop') return { continue: true };

      if (input.hook_event_name === 'PreToolUse') {
        const id = scopeToolId(input.tool_use_id ?? `tu_${Date.now()}`);
        /*
         * The one decision taken *before* the step is announced.
         *
         * `Read` and its siblings are pre-approved, which means `canUseTool` is
         * never consulted for them — the SDK's own documentation says a bare
         * name in `allowedTools` shadows the gate. So the protection for the
         * login and the database cannot live in the gate; it lives here, in a
         * hook, which fires for every call whatever the allow list says.
         *
         * Announced as a failed step rather than silently dropped: the user is
         * told the agent reached for the credential file and was refused, which
         * is the visible half of L8.7.
         */
        /*
         * Dwie reguły, w tej kolejności, i kolejność jest celowa.
         *
         * Najpierw **pozytywna**: czy to w ogóle mieści się w katalogu roboczym
         * uruchomienia. Ona domyka dopełnienie — wszystko, czego nikt nie
         * wymienił. Potem **lista zakazów**, która pilnuje katalogów
         * nietykalnych nawet wewnątrz dozwolonego obszaru (gdyby kiedyś któryś
         * z nich znalazł się w zasięgu, np. przez dowiązanie rozwiązane do
         * wnętrza workspace).
         *
         * Pozytywna jest pierwsza, bo daje uczciwszy komunikat: „to jest poza
         * twoim katalogiem roboczym" mówi modelowi, co ma zrobić inaczej,
         * a „to jest katalog poświadczeń" zdradza, czego szukać.
         */
        const toolName = String(input.tool_name ?? '');
        const refusal =
          workspaceConfinementRefusal(toolName, input.tool_input, args.workspace.dir) ??
          directoryWalkRefusal(toolName, input.tool_input, args.workspace.dir) ??
          protectedPathRefusal(
            toolName,
            input.tool_input,
            protectedDirs,
            (p) => realResolve(args.workspace.dir, p),
            /* Workspace uruchomienia lezy w katalogu danych — i ma byc uzywalne. */
            [realResolve(args.workspace.dir, '.')],
          );
        if (refusal) {
          /*
           * Announced even when it came from a subagent. The silence above
           * exists so the chat is not told the same *work* twice; a blocked
           * credential read is not work and is not duplicated — it is the only
           * report there will be, and L8.7's visible half is precisely that the
           * user learns the agent reached for the login and was refused.
           */
          stream.toolStart(id, String(input.tool_name ?? 'tool'), messageId);
          stream.toolArgs(id, JSON.stringify(input.tool_input ?? {}));
          stream.toolEnd(id);
          stream.toolResult(id, refusal, true);
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: refusal,
            },
          };
        }
        /*
         * Nic nie odmówiono — więc narzędzie dostaje ścieżkę **rozwiązaną**,
         * tę samą, którą przed chwilą sprawdzono. Bez tego strażnik i narzędzie
         * rozwiązują napis niezależnie, a dwa rozwiązania tego samego napisu
         * potrafią wskazać różne pliki (patrz `resolvePhysically`).
         */
        const rewritten = resolvedPathInput(toolName, input.tool_input, (p) =>
          realResolve(args.workspace.dir, p),
        );
        /*
         * Granica wyciszenia podwykonawcy (próba `most-granica-podwykonawcy`):
         * zwykła aktywność podwykonawcy milczy, ale z przepisanym wejściem —
         * narzędzie ma otworzyć ścieżkę sprawdzoną także tutaj.
         */
        if (fromSubagent) {
          return rewritten
            ? { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: rewritten } }
            : { continue: true };
        }
        if (rewritten) {
          stream.toolStart(id, String(input.tool_name ?? 'tool'), messageId);
          stream.toolArgs(id, JSON.stringify(rewritten));
          stream.toolEnd(id);
          return {
            continue: true,
            hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: rewritten },
          };
        }
        // Nothing was refused: ordinary subagent activity stays out of the chat.
        if (fromSubagent) return { continue: true };
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
        if (fromSubagent) return { continue: true };
        const raw = String(input.tool_use_id ?? '');
        if (raw) stream.toolResult(scopeToolId(raw), summariseToolResponse(input.tool_response));
      } else if (input.hook_event_name === 'PostToolUseFailure') {
        if (fromSubagent) return { continue: true };
        // This hook carries `error`, not `tool_response` — reporting the latter
        // produced a literal "null" in the chat instead of the reason.
        const raw = String(input.tool_use_id ?? '');
        if (raw) {
          stream.toolResult(
            scopeToolId(raw),
            summariseToolResponse(input.error ?? input.tool_response ?? 'Narzedzie zakonczylo sie bledem.'),
            true,
          );
        }
      }
      return { continue: true };
    };

    /*
     * Tryb czytany z rekordu także przy budowie `sdkOptions`, z tej samej
     * przyczyny co w bramce: lista dozwolonych zależy od trybu, a tryb jest
     * własnością wiersza wykonania — nie payloadu. Zapisuje go wyłącznie
     * `runs.start`.
     */
    const consentMode = this.#consentModeOfRun(runId, args.ownerId);

    const sdkOptions: Record<string, unknown> = {
      cwd: args.workspace.dir,
      mcpServers: { app: server },
      /*
       * Only the server on the line above, and nothing the machine happens to
       * have configured.
       *
       * `settingSources: []` was believed to cover this and does not: it keeps
       * out project `.mcp.json`, user settings and plugins, but an MCP server
       * attached to the *account* on claude.ai is registered by the CLI anyway.
       * Observed on this codebase with SDK 0.3.270 — a session built with
       * `settingSources: []` reported two servers, `app` and a connector from
       * the account, the second of which reaches the network from inside the
       * SDK process where the shell sandbox does not apply. Its tools are not in
       * `#toolNames`, so `decideTool` sends them to the consent prompt rather
       * than running them unannounced — but a platform whose isolation story is
       * "the run has the application's tools and no others" must not leave that
       * to the user's answer, for the same reason `WebFetch` is forbidden rather
       * than asked about (`permissions.ts`).
       *
       * Checked without spending a model turn: `mcpServerStatus()` is a control
       * request, so `pnpm diag` can list the servers a real session actually has.
       */
      strictMcpConfig: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      /*
       * Lista dozwolonych zależnie od trybu zgody (L11.12).
       *
       * Reguła allow w SDK jest starsza od bramki: nazwa na tej liście
       * autozatwierdza wywołanie, zanim `canUseTool` cokolwiek zobaczy
       * (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). Dlatego:
       *  - `manual` — lista jest PUSTA. „Prosi o zgodę przed każdą akcją"
       *    (D-06) nie może zostawić pre-zatwierdzonej furtki: każde wywołanie
       *    inicjowane przez agenta — także narzędzie aplikacji i odczyt pliku —
       *    musi dotrzeć do bramki i zostać tam zadecydowane;
       *  - `supervised` i `auto` — lista jak dotychczas: narzędzia aplikacji
       *    plus narzędzia plikowe z deklaracją ścieżki. `Bash` jest świadomie
       *    nieobecny w obu: w `supervised` to właśnie brak wpisu kieruje go do
       *    pytania, a w `auto` bramka sam go zatwierdza — bramka pozostaje
       *    jedynym mechanizmem zgody.
       */
      /*
       * Z8 — wyprowadzone z TEJ SAMEJ reguły, która decyduje o auto/zgoda.
       *
       * Poprzednio była to osobna, ręcznie trzymana lista: narzędzie dopisane do
       * `AUTO_APPROVED_FILE_TOOLS` bez wpisu w `PATH_ARGUMENTS` dostawało
       * `decideTool → 'consent'`, a jednocześnie trafiało tutaj — czyli
       * auto-zatwierdzało się na starszeństwie listy dozwolonych i bramka
       * nigdy go nie widziała (próba M4 recenzji). Filtr czyni rozjazd
       * niemożliwym: strażnik ścieżek sprawdzi tylko narzędzia, które
       * zadeklarowały, jak podają ścieżkę.
       */
      allowedTools:
        consentMode === 'manual'
          ? []
          : [...this.#toolNames, ...AUTO_APPROVED_FILE_TOOLS.filter(declaresPathArguments)],
      /*
       * The forbidden category. These reach the network from inside the SDK
       * process, where the shell sandbox's empty domain allowlist does not
       * apply, so they are removed from the model's context rather than left to
       * a prompt the user could answer with "yes".
       */
      disallowedTools: [...FORBIDDEN_TOOLS],
      permissionMode: 'default',
      /*
       * Reguła pozytywna po stronie SDK — **wyłącznie dla odczytów**.
       *
       * `blockReadsOutsideWorkingDirectories` istnieje w zainstalowanej wersji
       * 0.3.270 (sprawdzone w `sdk.d.ts`, nie przyjęte na słowo) i jej własny
       * opis wyznacza jej zasięg: „Refuse **file-tool reads** (Read, Grep, Glob,
       * LSP) outside the working directories in every permission mode".
       *
       * **Zapisów ta opcja NIE obejmuje.** `Write`, `Edit` i `NotebookEdit`
       * zamyka `workspaceConfinementRefusal` w hooku `PreToolUse` i w bramce —
       * to one są regułą dla zapisu, nie ta linia. Ktokolwiek uzna kiedyś tę
       * opcję za komplet, zostawi otwartą nogę, którą prawdziwy model już raz
       * przeszedł: `Write` utworzył plik na ścieżce odmówionej powłoce sekundę
       * wcześniej.
       *
       * Że to nie jest deklaracja: dowód dla zapisu stoi na teście, który biegnie
       * przeciwko **zastępnikowi modelu**. Zastępnik nie czyta `sdkOptions.settings`
       * w ogóle, więc test „zapis poza workspace nie tworzy pliku" nie ma jak
       * przejść dzięki tej opcji — przechodzi wyłącznie dzięki regule powyżej.
       *
       * Katalogiem roboczym jest `cwd`, czyli workspace uruchomienia, i celowo
       * **nie** podajemy `additionalDirectories`: każdy dopisany katalog
       * poszerza obszar, w którym odczyt jest dozwolony.
       *
       * Czy SDK naprawdę honoruje tę opcję, jest wypowiedzią o cudzym kodzie i
       * należy do prób modelowych (L11.4, L11.11) — dlatego odczyt też ma
       * odmowę po naszej stronie i nie zależy od niej wyłącznie.
       */
      settings: {
        permissions: { blockReadsOutsideWorkingDirectories: true },
      },
      sandbox: sandboxSettings({
        workspaceDir: args.workspace.dir,
        dataDir: this.services.config.dataDir,
        /*
         * Ta sama lista, co w hooku i w bramce — bez katalogu danych, który
         * `sandboxSettings` dokłada osobno. Jedna lista w jednym miejscu:
         * kopia, która się rozjedzie, otwiera dziurę w tej warstwie, która
         * została przy starej.
         */
        credentialDirs: protectedDirs
          .filter((d) => d.dir !== this.services.config.dataDir)
          .map((d) => d.dir),
      }),
      maxTurns: 40,
      canUseTool: this.#makeCanUseTool(stream, {
        runId,
        ownerId: args.ownerId,
        workspaceDir: args.workspace.dir,
      }),
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
    // A stopped run must not stay parked on a question nobody will answer.
    const releaseGate = () => this.#refusePendingPermissions(runId);
    abort.signal.addEventListener('abort', releaseGate, { once: true });

    /**
     * Writes the run's terminal status, and tolerates the run no longer having
     * a row.
     *
     * Deleting a conversation cancels its runs and then removes them
     * (`agent_runs` cascades). The cancellation is delivered through the abort
     * signal, so the run reaches this line a moment *after* its row is gone and
     * `RunRegistry.finish` — which re-reads what it wrote — answers `not_found`.
     * Thrown from here that ends the run through the wrong path and prints a
     * stack for the orderly outcome the user asked for. There is nothing left to
     * record, and saying so is the honest handling.
     */
    const settle = (
      status: 'succeeded' | 'failed' | 'cancelled',
      opts: { errorCode?: string; errorMessage?: string; durationMs?: number },
    ): void => {
      try {
        this.services.runs.finish(runId, status, opts);
      } catch (err) {
        console.warn(
          `[run ${runId}] status koncowy ${status} nie zostal zapisany (rozmowa usunieta?)`,
          err,
        );
      }
    };

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
        ? await this.#resumeOrReportLostTranscript(agent, resume, args, callOptions, stream)
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
          // Wrapped, not rethrown bare: the classifier below has to be able to
          // tell "the model answered with a failure" from "we never got to the
          // model", and the message alone cannot say which happened.
          throw new ModelStreamError(chunk.payload?.error ?? new Error('Blad strumienia modelu.'));
        }
      }

      if (textOpened) stream.textEnd(messageId);

      // The answer is already stored: the projection wired into `stream` wrote
      // every assistant segment and every tool result as they were emitted.
      // Writing the text again here would produce a second copy of the turn
      // without any of its tool activity.

      const durationMs = Date.now() - executionStartedAt;
      settle('succeeded', { durationMs });
      recordVerification(true);
      stream.runFinished(args.conversationId, runId, { durationMs });
    } catch (err) {
      const message = errorMessage(err);
      const cancelled = abort.signal.aborted && !message.includes('run_timeout');
      const code = cancelled ? 'cancelled' : classifyRunFailure(err, message);
      if (textOpened) stream.textEnd(messageId);
      // Partial text is already persisted by the projection, so a failed or
      // cancelled run keeps whatever the model managed to say.
      settle(cancelled ? 'cancelled' : 'failed', {
        errorCode: code,
        errorMessage: message,
        durationMs: Date.now() - executionStartedAt,
      });
      /*
       * Every failure that was not a cancellation is a statement about access,
       * and is recorded as one. Filtering by error code — as this used to —
       * meant a rate limit or a refused refresh left the reported access state
       * showing the last success, long after it stopped being true.
       *
       * A lost transcript is the one failure that says nothing about access: the
       * subscription and the login are fine, the SDK simply no longer has the
       * conversation. Reporting it as an access failure would put "połączenie z
       * modelem nie działa" in Settings for a problem that is not there.
       *
       * It turned out not to be the only one. A sandbox refusal and a timeout
       * this application imposed on itself are equally silent about the
       * subscription, and the record is process-global, so one of them painted
       * every conversation's status bar with a broken login. The whole class
       * now lives in `isAccessRelevantFailure`, next to the classifier.
       */
      if (!cancelled && isAccessRelevantFailure(code, message)) {
        recordVerification(false, message);
      }
      if (cancelled) stream.custom(PLATFORM_CUSTOM_EVENTS.runCancelled, { runId });
      // Exactly one resolving terminal event, so the UI never hangs on loading.
      stream.runError(message, code);
    } finally {
      clearTimeout(timeout);
      abort.signal.removeEventListener('abort', releaseGate);
      // Also on an ordinary end: a question left open by a stream that stopped
      // for any other reason would keep this run in the pending map for ever.
      this.#refusePendingPermissions(runId);
      this.services.uiSnapshots.forgetRun(runId);
      stream.close();
    }
  }

  /**
   * Resumes the conversation's Claude session, or says plainly that it is gone.
   *
   * The application keeps conversations for as long as the user wants them; the
   * Claude Agent SDK keeps its transcripts where and for as long as *it* wants.
   * The two therefore come apart — a pruned transcript, a restored backup (the
   * copy carries the database, never the SDK's own files), a different machine,
   * a cleaned home directory. What must not happen when they do is the thing
   * this method exists to prevent: the run quietly starting a **new** session
   * while the chat still shows the whole earlier history, so the interface says
   * the model remembers a conversation it has never seen.
   *
   * What happens instead, in this order:
   *   1. the stale binding is dropped, so the next attempt is honestly a fresh
   *      conversation and does not fail the same way for ever;
   *   2. an explicit event names the session that was lost and states that the
   *      memory was **not** restored;
   *   3. the run fails with its own error code, which the chat shows.
   *
   * Deliberately not "retry silently in a new session": the user asked a
   * question in a conversation with a history behind it, and an answer produced
   * without that history is a different answer. They are told, and they decide
   * whether to ask again — the next run starts clean because of step 1.
   *
   * Only the resume *call* is guarded. A failure after the stream has opened is
   * an ordinary run failure and is left to the normal path; re-classifying it
   * here would mean re-reading a message the model wrote.
   */
  async #resumeOrReportLostTranscript(
    agent: ModelAgentLike,
    sessionId: string,
    args: { conversationId: string; prompt: string },
    callOptions: unknown,
    stream: RunEventStream,
  ): Promise<{ fullStream: AsyncIterable<unknown> }> {
    try {
      return await agent.resumeStream(
        { message: args.prompt, sessionId },
        callOptions as never,
      );
    } catch (err) {
      const message = errorMessage(err);
      if (!isMissingSessionTranscript(message)) throw err;

      const forgotten = this.services.conversations.forgetClaudeSession(
        args.conversationId,
        sessionId,
      );
      stream.custom(PLATFORM_CUSTOM_EVENTS.sessionTranscriptLost, {
        conversationId: args.conversationId,
        lostSessionId: sessionId,
        /* Stated, not implied: nothing of the model's memory came back. */
        memoryRestored: false,
        bindingCleared: forgotten,
        sdkMessage: truncate(message, 300),
      });
      throw new AppError(
        'session_transcript_lost',
        `Transkrypt sesji Claude (${sessionId}) jest niedostepny, wiec pamiec wczesniejszej rozmowy NIE zostala odtworzona. ` +
          'Historia rozmowy w aplikacji pozostaje nietknieta. Powiazanie z ta sesja zostalo usuniete — ' +
          'wyslij polecenie ponownie, aby kontynuowac w nowej sesji, bez wczesniejszego kontekstu modelu.',
        { conversationId: args.conversationId, lostSessionId: sessionId },
      );
    }
  }

  /**
   * The consent mode of a run, read from its **row** — the single place the
   * mode is stored after `runs.start` writes it.
   *
   * Reading per decision, rather than capturing the value once, is what makes
   * "no mid-run escalation" a property of the mechanism and not of caller
   * discipline: whatever a payload carries, the next gate decision of this run
   * still consults the record. A row that has disappeared (its conversation
   * deleted while a question was open) reads as `supervised` — the
   * conservative answer, a question instead of an unannounced execution.
   */
  #consentModeOfRun(runId: string, ownerId: string): ConsentMode {
    try {
      return this.services.runs.get(runId, ownerId).consentMode;
    } catch {
      return 'supervised';
    }
  }

  /**
   * Permission gate — the third of the three SDK mechanisms described in
   * `permissions.ts`, and the only one this application implements itself.
   *
   * Read tools and the app's own write tools run unattended; a forbidden tool is
   * refused here **without asking**, so the policy holds even if the deny rule
   * passed to the SDK ever stopped being honoured; anything else asks the user
   * through the chat. An unanswered request is a denial, never a silent allow.
   *
   * While the question is open the run's stored status is `awaiting_consent`.
   * It used to live only in the event log and in this process's memory, so a
   * client that was not watching — the panel closed, another conversation on
   * screen, a tab reopened after a while — had no way to learn that something
   * was waiting for it. The status is what `GET /api/runs/active` reports and
   * what the background-task list shows as "czeka na zgode".
   */
  #makeCanUseTool(
    stream: RunEventStream,
    run: { runId: string; ownerId: string; workspaceDir: string },
  ) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<
      | { behavior: 'allow'; updatedInput: Record<string, unknown> }
      | { behavior: 'deny'; message: string }
    > => {
      /*
       * Same rule as the `PreToolUse` deny, applied again at the gate.
       *
       * Not redundant: the hook is the mechanism that works for pre-approved
       * tools, and the gate is the mechanism that works if a future SDK version
       * stopped calling hooks before a tool, or if `allowedTools` changes and
       * `Read` starts arriving here. Either one alone leaves the credential
       * directory reachable through the other path. Defence in depth, the way
       * `FORBIDDEN_TOOLS` is refused here as well as removed from the model's
       * context.
       */
      const guarded =
        workspaceConfinementRefusal(toolName, input, run.workspaceDir) ??
        directoryWalkRefusal(toolName, input, run.workspaceDir) ??
        protectedPathRefusal(
        toolName,
        input,
        protectedDirsFor(this.services.config.dataDir),
        /*
         * The same resolver as the hook. Without it a relative path reached the
         * gate unresolved and was compared as written, so `../../.claude/...`
         * only ever got caught one layer up — which makes "defence in depth"
         * one layer, not two, for exactly the input an attacker controls.
         */
        (p) => realResolve(run.workspaceDir, p),
        [realResolve(run.workspaceDir, '.')],
      );
      if (guarded) return { behavior: 'deny', message: guarded };

      /* Ta sama zasada co w hooku: narzędzie dostaje ścieżkę sprawdzoną. */
      const resolvedInput =
        resolvedPathInput(toolName, input, (p) => realResolve(run.workspaceDir, p)) ?? input;

      /*
       * Tryb czytany z rekordu przy KAŻDEJ decyzji bramki — nigdy z payloadu.
       * Zapisuje go wyłącznie `runs.start` w chwili utworzenia wiersza, więc
       * żadne żądanie HTTP wysłane w trakcie wykonania nie ma jak podnieść
       * uprawnień tego uruchomienia. Rekord, który zniknął (rozmowa usunięta w
       * trakcie pytania), zachowawczo oznacza `supervised`: pytamy, zamiast
       * przepuszczać.
       */
      const consentMode = this.#consentModeOfRun(run.runId, run.ownerId);
      const decision = decideTool(toolName, this.#toolNames, consentMode);
      if (decision === 'auto') return { behavior: 'allow', updatedInput: resolvedInput };
      if (decision === 'forbidden') {
        return { behavior: 'deny', message: forbiddenToolMessage(toolName) };
      }

      const requestId = newId('perm');
      this.services.runs.markAwaitingConsent(run.runId);
      const allowed = await new Promise<boolean>((resolve) => {
        this.#pendingPermissions.set(requestId, {
          resolve,
          toolName,
          input,
          runId: run.runId,
          ownerId: run.ownerId,
        });
        stream.custom(PLATFORM_CUSTOM_EVENTS.permissionRequest, {
          requestId,
          toolName,
          input: truncate(JSON.stringify(input ?? {}), 600),
          runId: stream.runId,
        });
        setTimeout(() => {
          // Expiry is a refusal. The branch is deliberately the same `resolve`
          // path as a user's "Odmowa", so an unattended request can never end
          // up on the permissive side by omission.
          if (this.#pendingPermissions.delete(requestId)) resolve(false);
        }, this.services.config.consentTimeoutMs);
      });
      this.services.runs.markConsentAnswered(run.runId);
      /*
       * The answer, in the log, next to the question.
       *
       * Every way out of the await above reaches this line — the user's
       * decision, the expiry, and the refusal issued when the run is stopped —
       * so there is no path that leaves a question looking open for ever. A
       * client replaying this run's events therefore ends up where the run is,
       * instead of showing a prompt that was settled minutes ago and that
       * `answerPermission` would refuse without telling anyone (L5.6, L5.14).
       */
      stream.custom(PLATFORM_CUSTOM_EVENTS.permissionResolved, {
        requestId,
        runId: stream.runId,
        allowed,
      });

      /* Zasada „sprawdzone = otwarte" w obu rozgałęzieniach: zgoda też zwraca
         ścieżkę rozwiązaną, nie surowy napis modelu (resztka rundy 4). */
      return allowed
        ? { behavior: 'allow', updatedInput: resolvedInput }
        : { behavior: 'deny', message: `Uzytkownik nie zgodzil sie na wykonanie ${toolName}.` };
    };
  }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

/**
 * How much of a tool's answer is kept in the conversation.
 *
 * Exported because it is a real limit on what a tool may return, not an
 * implementation detail: past it the stored text is cut mid-value, so a reader
 * of the conversation (the chat, a test, a diagnostic) gets something that no
 * longer parses. A listing tool that can grow with the user's data therefore
 * has to be windowed, and the window has to be small enough to fit here.
 */
export const TOOL_RESULT_STORED_CHARS = 4000;

function summariseToolResponse(response: unknown): string {
  if (response == null) return 'null';
  if (typeof response === 'string') return truncate(response, TOOL_RESULT_STORED_CHARS);
  try {
    return truncate(JSON.stringify(response), TOOL_RESULT_STORED_CHARS);
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

/**
 * Does this failure mean the SDK no longer holds the session we asked it to
 * resume?
 *
 * The Claude Agent SDK reports this as a message, not as a code, and the
 * wording has changed between versions — so the recogniser matches a *shape*
 * (something about a session, transcript or conversation, plus something about
 * it not being there) rather than one sentence. Both halves are required: a
 * bare "not found" from a tool, a module or the network must not be read as a
 * lost transcript, because the consequence of a false positive is dropping a
 * session binding that was perfectly good.
 *
 * Exported so the patterns can be tested against the wordings that have been
 * observed, and so a new one can be added with a failing test first.
 */
const MISSING_TRANSCRIPT_PATTERNS: RegExp[] = [
  /no conversation found with session id/i,
  /(session|transcript|conversation)[^.\n]{0,60}\b(not found|no longer exists?|does ?n[o']t exist|is missing|has expired)/i,
  // Adjacent on purpose: "unknown error while starting session" is a failure
  // *during* a session, not a missing one, and a looser gap matched it.
  /\b(no such|unknown|missing|expired)\s+(session|transcript|conversation)\b/i,
  /\bENOENT\b[^\n]*\.jsonl/i,
];

export function isMissingSessionTranscript(message: string): boolean {
  return MISSING_TRANSCRIPT_PATTERNS.some((re) => re.test(message));
}

/** Distinguishes auth / limit problems from generic integration failures. */
/**
 * A failure the **model's own stream** reported.
 *
 * The distinction it carries cannot be recovered from the message: "connection
 * reset" reads the same whether the adapter never produced a stream or the
 * model produced one and then failed inside it. The first is an integration
 * failure — something between this application and the SDK broke; the second is
 * a model failure, and the operator's next step differs.
 */
export class ModelStreamError extends Error {
  constructor(readonly reason: unknown) {
    super(errorMessage(reason));
    this.name = 'ModelStreamError';
  }
}

/**
 * Maps a run failure onto the application's error taxonomy.
 *
 * Four classes have to stay apart in the stored run record, because each means
 * a different next step:
 *
 *  - **sandbox** (`sandbox_denied`) — the isolation refused, or was unavailable
 *    and the run was failed rather than silently downgraded;
 *  - **access** (`rate_limited` / `unauthenticated`) — classified once, in
 *    `classifyAccessFailure`, so the chat, the run record and Settings can
 *    never disagree about whether the subscription ran out or the login broke;
 *  - **model** (`model_failed`) — a stream existed and reported a failure;
 *  - **integration** (`integration_failed`) — everything else, including a
 *    timeout and a call that never produced a stream at all.
 *
 * The four above are what this function *decides*. Before deciding anything it
 * defers: an error the application already classified — any `AppError` whose
 * code is not the catch-all `internal` — is passed through with the code it
 * arrived with. That is deliberately wider than the four classes, because the
 * layer that raised it knew more than a wording match ever can: the sandbox
 * refuses by code, a domain rule refuses by code, and so do access, validation
 * and conflict. Re-deriving any of those from the message would lose them.
 *
 * Exported because the classes are a contract, not an implementation detail —
 * the taxonomy is asserted directly over realistic failure texts.
 */
export function classifyRunFailure(err: unknown, message: string = errorMessage(err)): AppErrorCode {
  const fromStream = err instanceof ModelStreamError;
  const raw = fromStream ? err.reason : err;
  if (raw instanceof AppError && raw.code !== 'internal') return raw.code;

  const m = message.toLowerCase();
  if (m.includes('sandbox')) return 'sandbox_denied';
  // A run this application timed out is its own decision, not the model's.
  if (m.includes('run_timeout')) return 'integration_failed';

  switch (classifyAccessFailure(message)) {
    case 'rate_limited':
      return 'rate_limited';
    case 'revoked':
    case 'refresh_refused':
      return 'unauthenticated';
    default:
      return fromStream ? 'model_failed' : 'integration_failed';
  }
}

export { mcpToolName };
