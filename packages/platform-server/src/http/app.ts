import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { z } from 'zod';
import {
  AGENT_VIEWS_SCOPE_KIND,
  AppError,
  parseRunAppContext,
  addCardInputSchema,
  canvasViewportSchema,
  cardGeometrySchema,
  cardSpecSchema,
  CHAT_CAPABILITIES,
  EMPTY_APP_CONTEXT,
  PLATFORM_CUSTOM_EVENTS,
  runAgentInputSchema,
  updateCardGeometryInputSchema,
  updateCardSpecInputSchema,
  type AppContext,
  type StoredMessage,
  uiCommandResultSchema,
  UI_SNAPSHOT_MAX_BYTES,
} from '@platform/contracts';
import { probeAuth } from '../agent/auth.ts';
import { AgentRuntime } from '../agent/runtime.ts';
import { SESSION_COOKIE, SessionAuth, ensureUser, requireUser } from '../auth/session.ts';
import type { PlatformServices } from '../services/index.ts';
import { deriveTitle } from '../services/conversations.ts';
import { describeReadOperations, runRead } from '../registry/read-operations.ts';
import { performRecordAction } from '../services/record-actions.ts';

export const DEFAULT_USER_ID = 'local-user';
export const SECOND_USER_ID = 'other-user';

/**
 * Body of a request whose body is optional.
 *
 * `await c.req.json().catch(() => ({}))` — which is what these routes used —
 * makes three different situations one: no body, an empty body, and a body that
 * is not JSON. The first two are "the caller said nothing", which the thread
 * routes allow. The third is a client error, and swallowing it meant a request
 * nobody could parse still created a conversation and answered 200: a route
 * that cannot fail validation is a route that does not validate (L9.3).
 */
async function optionalJsonBody(c: Context): Promise<unknown> {
  const raw = await c.req.text().catch(() => '');
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError('validation_failed', 'Cialo zadania nie jest poprawnym JSON-em.', {
      reason: 'malformed_json',
    });
  }
}

/**
 * What the chat's `restStorage` sends to `/api/threads/create` and
 * `/api/threads/update/:id`.
 *
 * Create carries `{ messages: [...] }`; update carries the whole thread object,
 * so it also brings `id` and `createdAt` — read from nowhere here, and stripped
 * rather than refused, because a library may add a field without asking us.
 * What is *not* stripped is a wrong type on a field this route acts on.
 */
const threadWriteSchema = z.object({
  title: z.string().max(200).nullish(),
  spaceId: z.string().max(128).nullish(),
  messages: z
    .array(
      z.object({
        id: z.string().max(128).optional(),
        role: z.string().max(40).optional(),
        content: z.unknown().optional(),
      }),
    )
    .max(200)
    .optional(),
});

/**
 * A space named by the client is checked before it is bound.
 *
 * The same check `/api/agui/run` makes, for the same reason: an id travelling
 * from a browser is a request to use it, not a right to. Without it a
 * conversation could be left pointing at a space its owner cannot open — which
 * leaks nothing (every read of the space checks the owner again) but stores a
 * binding that is a lie.
 */
function assertOwnSpace(
  services: PlatformServices,
  spaceId: string | null | undefined,
  ownerId: string,
): void {
  if (spaceId) services.canvas.getSpace(spaceId, ownerId);
}

export interface PlatformAppDeps {
  services: PlatformServices;
  runtime: AgentRuntime;
  auth: SessionAuth;
  versions: Record<string, string>;
}

type Env = { Variables: { ownerId: string } };

const json = (c: Context, body: unknown, status = 200) =>
  c.json(body as Record<string, unknown>, status as 200);

/**
 * Platform HTTP surface.
 *
 * The conversation endpoints deliberately follow the OpenUI `restStorage()`
 * conventions so the ready-made chat talks to this backend with configuration
 * only. Everything else is plain REST consumed by TanStack Query.
 */
/**
 * Projects a stored row onto the wire shape of an AG-UI message.
 *
 * Tool activity lives in `meta` in the database (the column predates it) but has
 * to appear as first-class `toolCalls` / `toolCallId` fields here, because that
 * is what `pairToolActivity` in the chat reads.
 */
function toAguiMessage(m: StoredMessage): Record<string, unknown> {
  const meta = (m.meta ?? {}) as Record<string, unknown>;
  if (m.role === 'tool') {
    return {
      id: m.id,
      role: 'tool',
      content: m.content,
      toolCallId: String(meta.toolCallId ?? ''),
      ...(meta.isError === true ? { isError: true } : {}),
      ...(typeof meta.error === 'string' ? { error: meta.error } : {}),
    };
  }
  const toolCalls = Array.isArray(meta.toolCalls) ? meta.toolCalls : [];
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

/** What a replayed `POST /api/agui/run` has to answer with, stored on first use. */
interface RecordedRun {
  runId: string;
  conversationId: string;
}

/** Scope of the run idempotency keys, kept out of every other caller's namespace. */
const AGUI_RUN_SCOPE = 'agui.run';

/**
 * Runs whose start is under way, per `${owner}\0${clientRunId}`.
 *
 * The recorded key closes the window *after* a run exists; this closes the one
 * *while* it is being created. `runtime.start` is awaited, so a second copy of
 * the same request can run its lookup in that gap, find nothing recorded yet and
 * start a second execution — the very thing the key exists to prevent. The entry
 * is registered in the same tick the start is invoked, so there is no instant at
 * which a run is being created and nothing says so; a repeat that arrives then
 * waits for it and is answered as the replay it is.
 *
 * In memory on purpose: it describes work happening in *this* process, and a
 * restart leaves no such work behind. The durable answer stays in
 * `idempotency_keys`.
 */
const startingRuns = new Map<string, Promise<RecordedRun>>();

export function createPlatformApp(deps: PlatformAppDeps): Hono<Env> {
  const { services, runtime, auth } = deps;
  const app = new Hono<Env>();

  /**
   * Writes one run's events to an SSE stream, from `from` onwards.
   *
   * Two sources and one sequence, as `GET /api/runs/:id/stream` describes: the
   * live stream while the run executes here, the persisted log otherwise. Shared
   * with the replay branch of `POST /api/agui/run` so a repeated command is
   * answered with the *same* events as the original rather than with a second
   * execution — and so the two cannot drift apart.
   */
  const writeRunStream = async (
    sse: SSEStreamingApi,
    runId: string,
    ownerId: string,
    from: number,
  ): Promise<void> => {
    const run = services.runs.get(runId, ownerId);
    const live = runtime.liveStream(runId);
    if (live) {
      for await (const { seq, event } of live.read(from)) {
        await sse.writeSSE({ id: String(seq), data: JSON.stringify(event) });
      }
      return;
    }
    /*
     * A **resolved** run's replay carries no interface commands.
     *
     * An interface command is a question the run is waiting on: it asks the
     * browser to move the screen and does not resolve until the browser answers
     * or the runtime times it out. Once the run has ended nothing is waiting for
     * that answer — the agent was already told `no_client` — so performing it
     * now would move the user's screen for a question settled minutes ago, and
     * answer it to nobody. A client that *did* see it live refuses the repeat by
     * `commandId` (`UiCommandRunner`); this covers the other case, where the
     * client never saw it because it was away while the run was ending.
     *
     * Only this path filters. A run still executing is served from its live
     * stream above, where a command may genuinely still be waiting.
     */
    for (const { seq, payload } of services.runs.eventsAfter(runId, ownerId, from)) {
      const event = payload as { type?: string; name?: string } | null;
      if (event?.type === 'CUSTOM' && event.name === PLATFORM_CUSTOM_EVENTS.uiCommand) continue;
      await sse.writeSSE({ id: String(seq), data: JSON.stringify(payload) });
    }
    /*
     * A resolved run whose log carries no terminal event — killed process, or
     * a restart — would otherwise leave the client waiting for ever. The
     * stored status is the authority on how it ended.
     */
    const terminal = ['succeeded', 'failed', 'cancelled'];
    if (terminal.includes(run.status)) {
      const seen = services.runs.eventsAfter(runId, ownerId, 0).some((e) => {
        const name = (e.payload as { type?: string } | null)?.type;
        return name === 'RUN_FINISHED' || name === 'RUN_ERROR';
      });
      if (!seen) {
        await sse.writeSSE({
          data: JSON.stringify({
            type: run.status === 'succeeded' ? 'RUN_FINISHED' : 'RUN_ERROR',
            runId,
            threadId: run.conversationId,
            code: run.errorCode ?? run.status,
            message: run.errorMessage ?? `Uruchomienie zakonczylo sie jako ${run.status}.`,
          }),
        });
      }
    }
  };

  /* ------------------------------- CORS -------------------------------- */

  app.use('*', async (c, next) => {
    const origin = c.req.header('Origin');
    if (origin) {
      if (!services.config.allowedOrigins.includes(origin)) {
        return json(c, { error: { code: 'forbidden', message: `Origin ${origin} niedozwolony.` } }, 403);
      }
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Headers', 'content-type, x-app-user');
      c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    return next();
  });

  /* ----------------------------- error shape ---------------------------- */

  app.onError((err, c) => {
    const appErr = AppError.from(err);
    // Never leak a stack or an environment value to the client.
    return json(c, { error: appErr.toJSON() }, appErr.status);
  });

  /* ------------------------------- auth --------------------------------- */

  /**
   * Local sign-in. This is the application's own identity, entirely separate
   * from the Claude subscription credential, which is never accepted here and
   * never leaves the server.
   */
  /*
   * Establishes or keeps the application session.
   *
   * With an explicit `userId` this is a deliberate switch. Without one it means
   * "make sure I have a session" — which is what the frontend calls on every
   * load — and must therefore *preserve* the identity already signed in. It used
   * to reset to the default instead, so any full page reload silently threw the
   * user back to the first identity.
   */
  app.post('/api/auth/session', async (c) => {
    /*
     * The third route that swallowed a broken body, and the last one.
     *
     * A session request with no body is the frontend's "make sure I have a
     * session" and must keep working — so the distinction is the same one the
     * thread routes make: nothing said is allowed, something unparseable is a
     * client error. Left as `.catch(() => ({}))` this route would silently sign
     * a caller in as the default identity after failing to read what they
     * asked for, which is the one place where guessing is least acceptable.
     */
    const body = z
      .object({ userId: z.string().max(128).nullish() })
      .parse(await optionalJsonBody(c));
    const current = auth.verify(getCookie(c, SESSION_COOKIE));
    const requested = body.userId;
    const userId =
      requested === SECOND_USER_ID || requested === DEFAULT_USER_ID
        ? requested
        : (current ?? DEFAULT_USER_ID);
    ensureUser(services.db, userId, userId === DEFAULT_USER_ID ? 'Uzytkownik lokalny' : 'Inny uzytkownik');
    setCookie(c, SESSION_COOKIE, auth.sign(userId), {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return json(c, { userId });
  });

  app.get('/api/auth/me', (c) => {
    const userId = auth.verify(getCookie(c, SESSION_COOKIE));
    return json(c, { userId, authenticated: Boolean(userId) });
  });

  /** Everything below requires an application session. */
  app.use('/api/*', async (c, next) => {
    const p = c.req.path;
    if (p.startsWith('/api/auth/') || p === '/api/health') return next();
    const userId = auth.verify(getCookie(c, SESSION_COOKIE));
    c.set('ownerId', requireUser(services.db, userId));
    return next();
  });

  /*
   * Health, plus the one fact an automated test needs before it writes
   * anything: *which* instance answered.
   *
   * A test harness can guard its own configuration and still send its requests
   * to a server someone else started on the same port. `instanceLabel` is set
   * only by servers the test suites launch (`APP_INSTANCE_LABEL`), so a suite
   * can refuse to proceed against an unlabelled instance instead of quietly
   * mutating the user's database. Nothing else is exposed here: the endpoint is
   * unauthenticated, so it says who answered, never where their data lives.
   */
  app.get('/api/health', (c) =>
    json(c, { ok: true, instanceLabel: services.config.instanceLabel }),
  );

  /* ------------------------------ status -------------------------------- */

  app.get('/api/status', (c) => {
    const authStatus = probeAuth();
    return json(c, {
      auth: authStatus,
      versions: deps.versions,
      model: services.config.model,
      chatCapabilities: CHAT_CAPABILITIES,
      modules: services.modules.modules.map((m) => m.meta),
      tools: services.modules.tools.map((t) => ({
        name: t.qualifiedName,
        module: t.moduleId,
        effect: t.definition.effect,
        description: t.definition.description,
      })),
      platformTools: runtime.toolNames,
      components: services.catalog.describe(),
      activeRuns: services.runs.activeCount(),
    });
  });

  /* --------------------------- conversations ---------------------------- */
  /* OpenUI restStorage conventions: /get, /create, /get/:id, /update/:id,
     /delete/:id  — implemented directly so the ready-made chat needs no
     adapter of ours. */

  app.get('/api/threads/get', (c) => {
    const ownerId = c.get('ownerId');
    return json(c, {
      threads: services.conversations.list(ownerId).map((t) => ({
        id: t.id,
        title: t.title,
        createdAt: t.createdAt,
      })),
    });
  });

  app.post('/api/threads/create', async (c) => {
    const ownerId = c.get('ownerId');
    const body = threadWriteSchema.parse(await optionalJsonBody(c));
    assertOwnSpace(services, body.spaceId, ownerId);
    const first = body.messages?.[0];
    const content = typeof first?.content === 'string' ? first.content : '';
    const conv = services.conversations.create({
      ownerId,
      title: body.title ?? undefined,
      spaceId: body.spaceId ?? null,
      firstMessage: content ? { id: first?.id, content } : undefined,
    });
    return json(c, { id: conv.id, title: conv.title, createdAt: conv.createdAt });
  });

  /*
   * Thread history in the AG-UI message shape the chat expects.
   *
   * `restStorage` passes this array straight into the store (its default
   * `identityMessageFormat` transforms nothing), and the chat pairs an assistant
   * message's `toolCalls` with the `role: "tool"` messages carrying the results.
   * Returning only `{id, role, content}` — as this endpoint used to — is what
   * made a reloaded conversation lose every trace of what the agent did, while
   * the live stream had shown all of it.
   */
  app.get('/api/threads/get/:id', (c) => {
    const ownerId = c.get('ownerId');
    const messages = services.conversations.messages(c.req.param('id'), ownerId);
    return json(
      c,
      messages.map((m) => {
        const base = toAguiMessage(m);
        if (m.role !== 'user') return base;
        /*
         * The files this command was sent with, added to the message itself.
         *
         * `restStorage` passes the array straight into the chat's store, so an
         * extra field travels with the message and is available wherever the
         * message is — including after a reload, which is precisely when the
         * in-flight `attachFileIds` were gone.
         */
        const attachments = services.conversations.attachmentsOfMessage(m.id, ownerId);
        return attachments.length > 0 ? { ...base, attachments } : base;
      }),
    );
  });

  app.patch('/api/threads/update/:id', async (c) => {
    const ownerId = c.get('ownerId');
    const body = threadWriteSchema.parse(await optionalJsonBody(c));
    assertOwnSpace(services, body.spaceId, ownerId);
    const id = c.req.param('id');
    let conv = services.conversations.get(id, ownerId);
    if (typeof body.title === 'string' && body.title.trim()) {
      conv = services.conversations.rename(id, ownerId, body.title.trim().slice(0, 120));
    }
    if (body.spaceId !== undefined) conv = services.conversations.bindSpace(id, ownerId, body.spaceId);
    return json(c, { id: conv.id, title: conv.title, createdAt: conv.createdAt });
  });

  app.delete('/api/threads/delete/:id', (c) => {
    const ownerId = c.get('ownerId');
    return json(c, services.conversations.delete(c.req.param('id'), ownerId));
  });

  /** Full conversation record (adds the platform fields the chat type lacks). */
  app.get('/api/conversations/:id', (c) =>
    json(c, services.conversations.get(c.req.param('id'), c.get('ownerId'))),
  );

  /**
   * The conversation's agent views: its space and cards, or no space yet.
   *
   * Read-only on purpose — opening the page must not create a space; the agent
   * creates it with its first view. Under the conversation, so the owner check
   * is the conversation's and a view is never looked up by a space id the
   * client could have picked.
   */
  app.get('/api/conversations/:id/agent-views', (c) => {
    const ownerId = c.get('ownerId');
    const conversation = services.conversations.get(c.req.param('id'), ownerId);
    const space = services.canvas.findScopedSpace(ownerId, AGENT_VIEWS_SCOPE_KIND, conversation.id);
    return json(c, {
      conversationId: conversation.id,
      space,
      cards: space ? services.canvas.getState(space.id, ownerId).cards : [],
    });
  });

  app.get('/api/conversations/:id/runs', (c) =>
    json(c, { runs: services.runs.listForConversation(c.req.param('id'), c.get('ownerId')) }),
  );

  /* -------------------------------- AG-UI ------------------------------- */

  /**
   * The single agent entry point. Accepts an AG-UI `RunAgentInput` (what
   * OpenUI's `fetchLLM` posts) and answers with an AG-UI SSE stream.
   */
  app.post('/api/agui/run', async (c) => {
    const ownerId = c.get('ownerId');
    const raw = await c.req.json().catch(() => ({}));
    const parsed = runAgentInputSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('validation_failed', 'Nieprawidlowe RunAgentInput.');

    const input = parsed.data;
    const forwarded = (input.forwardedProps ?? {}) as Record<string, unknown>;

    /*
     * The same command sent twice is one command.
     *
     * The client names its run (`runId` in `RunAgentInput`, a UUID minted per
     * send in `chatWiring.ts`). That name used to be read and thrown away, so a
     * repeat of one POST — a proxy retry, a resent request, a double submit of
     * the identical body — started a *second* execution: a second assistant
     * answer in the thread, the tool work done twice, and with no `threadId` a
     * second conversation as well. The user's own message was the only part
     * that was safe, because `appendMessage` deduplicates by id.
     *
     * So the run is recorded under that name the first time and every later
     * request carrying it is answered from the run it already started — the
     * same headers, the same event sequence, from the beginning. Nothing is
     * created, nothing is appended, no model is asked. Placed before the
     * conversation is created and before the message is appended, because a
     * replay must have no side effect at all.
     *
     * It does **not** turn two *different* commands into one: the client mints
     * a fresh id per send, so pressing send twice is two commands and is meant
     * to be. What it guarantees is that one request, however many times it
     * arrives, produces one run.
     */
    const clientRunId = input.runId?.trim() || null;
    const runKey = clientRunId ? `${ownerId}\u0000${clientRunId}` : null;
    if (clientRunId) {
      const recorded =
        services.idempotency.get<RecordedRun>(clientRunId, ownerId, AGUI_RUN_SCOPE) ??
        /*
         * Not recorded yet, but possibly being created right now. Awaiting the
         * first request's start is what makes two *simultaneous* copies of one
         * request produce one run rather than racing the durable key. A start
         * that fails resolves to nothing here, so this request goes on to make
         * its own attempt instead of inheriting the failure.
         */
        (runKey && startingRuns.has(runKey)
          ? await startingRuns.get(runKey)!.catch(() => null)
          : null);
      if (recorded) {
        /*
         * Checked here, before a stream is opened: a run whose conversation has
         * since been deleted cannot be replayed, and the caller gets
         * `not_found` rather than an empty stream. Re-running the command
         * instead would recreate work the user removed.
         */
        services.runs.get(recorded.runId, ownerId);
        c.header('X-Run-Id', recorded.runId);
        c.header('X-Conversation-Id', recorded.conversationId);
        // Says which branch answered, so a test — and a client — can tell a
        // replay from a fresh run without inferring it from the events.
        c.header('X-Run-Replayed', '1');
        return streamSSE(c, (sse) => writeRunStream(sse, recorded.runId, ownerId, 0));
      }
    }

    /*
     * The frontend's context selects what to look at; it never carries identity.
     *
     * A context the contract refuses is a *client* error and is reported as one.
     * It used to leave `parseRunAppContext` as a bare `ZodError`, which the error
     * shaper could only classify as `internal` — a 500 saying "something broke
     * here" for a request that was simply malformed, and one that told whoever
     * sent it nothing about which field was wrong.
     */
    let parsedContext: ReturnType<typeof parseRunAppContext>;
    try {
      parsedContext = parseRunAppContext(
        (input.context as unknown) ?? forwarded.appContext ?? EMPTY_APP_CONTEXT,
      );
    } catch (err) {
      const issues =
        err instanceof z.ZodError
          ? err.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }))
          : undefined;
      if (!issues) throw err;
      throw new AppError('validation_failed', 'Nieprawidlowy kontekst aplikacji (appContext).', {
        reason: 'invalid_app_context',
        issues,
      });
    }
    const { context: appContext, uiRejected } = parsedContext;
    if (uiRejected) {
      /*
       * A malformed screen marker must not refuse the command: the run starts
       * without it (the agent is told there is no description) and the reason
       * is reported here, where whoever breaks the client will look.
       */
      console.warn(`[agui/run] pominiety znacznik ekranu AppContext.ui: ${uiRejected.join('; ')}`);
      c.header('X-Ui-Context-Rejected', '1');
    }

    const lastUser = [...input.messages]
      .reverse()
      .find((m) => (m as { role?: string }).role === 'user') as
      | { id?: string; content?: unknown }
      | undefined;
    const prompt = typeof lastUser?.content === 'string' ? lastUser.content : '';
    if (!prompt.trim()) throw new AppError('validation_failed', 'Puste polecenie.');

    /*
     * A space named by the context has to be this owner's before anything is
     * written that refers to it.
     *
     * The context grants nothing — reads and writes are checked against the
     * session everywhere else — but an unchecked `spaceId` still did damage of
     * its own: it was stored on the conversation (at creation and by
     * `bindSpace`), so a forged one left the owner's conversation permanently
     * pointing at a space they cannot open. `getSpace` refuses another owner's
     * with `forbidden` and a missing one with `not_found`, which is exactly the
     * answer the caller should get.
     */
    if (appContext.spaceId) {
      services.canvas.getSpace(appContext.spaceId, ownerId);
    }

    let conversationId = input.threadId ?? appContext.conversationId ?? null;
    if (!conversationId) {
      conversationId = services.conversations.create({
        ownerId,
        title: deriveTitle(prompt),
        spaceId: appContext.spaceId,
      }).id;
    } else if (appContext.spaceId) {
      /*
       * Keep the conversation pointed at the workspace it is actually being
       * used in.
       *
       * The binding is what lets picking a conversation from the drawer bring
       * its canvas space back with it. Set only at creation, it went stale as
       * soon as the user moved to another space and carried on in the same
       * conversation — so reopening it later restored the wrong workspace.
       * A run is the moment the two are demonstrably connected.
       */
      const existing = services.conversations.get(conversationId, ownerId);
      if (existing.spaceId !== appContext.spaceId) {
        services.conversations.bindSpace(conversationId, ownerId, appContext.spaceId);
      }
    }
    // Idempotent by message id: a reconnect replaying the same turn is a no-op.
    const userMessage = services.conversations.appendMessage(conversationId, ownerId, {
      id: lastUser?.id,
      role: 'user',
      content: prompt,
    });

    const attachFileIds = Array.isArray(forwarded.attachFileIds)
      ? (forwarded.attachFileIds as string[]).slice(0, 10)
      : [];

    /*
     * Invoked and announced in the same tick: `startingRuns` is set immediately
     * after the call, with no `await` in between, so from the instant the run
     * begins there is something for a concurrent repeat to wait on.
     */
    const starting = runtime.start({
      ownerId,
      conversationId,
      prompt,
      appContext: { ...appContext, conversationId },
      attachFileIds,
      // The command the files were attached to, so the link survives the run.
      userMessageId: userMessage.id,
    });
    if (runKey) {
      startingRuns.set(
        runKey,
        starting.then((s) => ({ runId: s.runId, conversationId }) satisfies RecordedRun),
      );
    }

    let started: Awaited<typeof starting>;
    try {
      started = await starting;
      /*
       * Recorded before the stream opens, not after it closes: the window a
       * retry arrives in is precisely while the first run is still going.
       */
      if (clientRunId) {
        services.idempotency.put(clientRunId, ownerId, AGUI_RUN_SCOPE, {
          runId: started.runId,
          conversationId,
        } satisfies RecordedRun);
      }
    } finally {
      // The durable key has taken over by now (or the start failed and there is
      // nothing to hand anyone).
      if (runKey) startingRuns.delete(runKey);
    }

    c.header('X-Run-Id', started.runId);
    c.header('X-Conversation-Id', conversationId);
    return streamSSE(c, async (sse) => {
      for await (const { event } of started.stream.read(0)) {
        await sse.writeSSE({ data: JSON.stringify(event) });
      }
      await started.done.catch(() => undefined);
    });
  });

  app.post('/api/runs/:id/cancel', (c) =>
    json(c, services.runs.cancel(c.req.param('id'), c.get('ownerId'))),
  );

  /** Everything this owner still has in flight, across all conversations. */
  app.get('/api/runs/active', (c) => {
    const ownerId = c.get('ownerId');
    const runs = services.runs.listActive(ownerId);
    return json(c, {
      runs: runs.map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        status: r.status,
        enqueuedAt: r.enqueuedAt,
        startedAt: r.startedAt,
        // The title is what makes a background task nameable in the interface;
        // without it a task list is a list of identifiers.
        conversationTitle: services.conversations.get(r.conversationId, ownerId).title,
      })),
    });
  });

  /**
   * Re-attach to a run's event stream from a sequence number.
   *
   * The counterpart of `POST /api/agui/run`, and the reason a run survives the
   * browser. The POST's stream ends when its socket does — on a reload, a
   * conversation switch, or a closed laptop — while the run itself carries on in
   * the backend. This endpoint replays what was missed and then continues live,
   * so coming back shows the current state instead of re-running the work.
   *
   * Two sources, one sequence: a run still executing here is served from its
   * live stream (which replays its own buffer from the cursor); a run that has
   * resolved — or one from before a restart — is served from `run_events`, which
   * holds the identical events because every emit persists before it is
   * readable. `from` is the last sequence number the client already has, so
   * nothing is delivered twice.
   */
  app.get('/api/runs/:id/stream', (c) => {
    const ownerId = c.get('ownerId');
    const runId = c.req.param('id');
    const from = Number(c.req.query('from') ?? 0) || 0;
    // Ownership first: this must not become a way to read someone else's run.
    services.runs.get(runId, ownerId);
    return streamSSE(c, (sse) => writeRunStream(sse, runId, ownerId, from));
  });

  app.get('/api/runs/:id/events', (c) =>
    json(c, { events: services.runs.events(c.req.param('id'), c.get('ownerId')) }),
  );

  /** The catalog the browser resolves a UI command against. Same list the agent sees. */
  app.get('/api/ui/targets', (c) => {
    c.get('ownerId');
    return json(c, { targets: services.modules.uiTargets() });
  });

  /**
   * Module screens as OpenUI Lang compositions.
   *
   * The list the registry checked at startup against the targets and the read
   * descriptors; the browser renders each through `ComposedView`. Compositions
   * carry no data, so the list is the same for every owner.
   */
  app.get('/api/ui/views', (c) => {
    c.get('ownerId');
    return json(c, { views: services.modules.views() });
  });

  /**
   * A tab publishing what it shows (`uiSnapshotSchema`).
   *
   * The owner is the session's; the description names only what is on screen.
   * The body is read as text so its size is checked before it is parsed.
   * Refused with `validation_failed` (too large, malformed) or `conflict` (a
   * version that does not advance the tab's counter — the tab takes a new
   * identity and publishes again).
   */
  app.put('/api/ui/snapshot', async (c) => {
    const ownerId = c.get('ownerId');
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > UI_SNAPSHOT_MAX_BYTES) {
      throw new AppError('validation_failed', `Opis interfejsu przekracza ${UI_SNAPSHOT_MAX_BYTES} bajtow.`, {
        reason: 'too_large',
        limit: UI_SNAPSHOT_MAX_BYTES,
      });
    }
    return json(c, { accepted: true, ...services.uiSnapshots.publishRaw(ownerId, await c.req.text()) });
  });

  /**
   * A tab that is closing (`pagehide`) retires its description, so it is no
   * longer handed out as the screen of a conversation nobody is looking at.
   * Only a description no newer than `version` is retired: the same tab
   * reloading may already have published its next one.
   */
  app.delete('/api/ui/snapshot', (c) => {
    const ownerId = c.get('ownerId');
    const clientId = c.req.query('clientId');
    const version = Number(c.req.query('version'));
    if (!clientId || !Number.isInteger(version)) {
      throw new AppError('validation_failed', 'Podaj clientId i version.');
    }
    return json(c, { retired: services.uiSnapshots.retire(ownerId, clientId, version) });
  });

  /**
   * An open tab saying it is still there (every `UI_CLIENT_HEARTBEAT_MS`).
   * `known: false` — the backend has no such description (restarted, or it was
   * retired): the tab publishes it again.
   */
  app.post('/api/ui/snapshot/alive', async (c) => {
    const ownerId = c.get('ownerId');
    const body = (await c.req.json().catch(() => ({}))) as { clientId?: unknown; version?: unknown };
    if (typeof body.clientId !== 'string' || !Number.isInteger(body.version)) {
      throw new AppError('validation_failed', 'Podaj clientId i version.');
    }
    return json(c, { known: services.uiSnapshots.touch(ownerId, body.clientId, body.version as number) });
  });

  /**
   * The description the agent would be given for a conversation — the same
   * evaluation as `ui_state`, without waiting — or one tab's latest. Only the
   * signed-in owner's own tabs are ever visible. For diagnostics and tests.
   */
  app.get('/api/ui/snapshot', (c) => {
    const ownerId = c.get('ownerId');
    const clientId = c.req.query('clientId');
    if (clientId) return json(c, { snapshot: services.uiSnapshots.forClient(ownerId, clientId) });
    const conversationId = c.req.query('conversationId');
    if (!conversationId) {
      throw new AppError('validation_failed', 'Podaj conversationId albo clientId.');
    }
    const minVersion = Number(c.req.query('minVersion'));
    return json(
      c,
      services.uiSnapshots.evaluate(ownerId, conversationId, {
        ...(Number.isInteger(minVersion) && minVersion > 0 ? { minVersion } : {}),
      }),
    );
  });

  /* -------------------------------- reads ------------------------------- */

  /**
   * Runs one registered read for the signed-in owner.
   *
   * What data components fetch through: the body names an operation and its
   * input, the owner comes from the session, and the answer carries the result
   * with the descriptor that says how to read it. An unknown operation, input
   * its schema rejects, or a record the owner may not see are refused with
   * `validation_failed` / `forbidden` / `not_found` — never answered with an
   * empty result.
   */
  app.post('/api/read', async (c) => {
    const ownerId = c.get('ownerId');
    const body = await c.req.json().catch(() => undefined);
    return json(c, await runRead(services.modules, body, ownerId));
  });

  /**
   * Performs a record action declared by a read's descriptor, for the
   * signed-in owner: the record is re-read through the named read, and the
   * module's write tool runs through the same execution as over MCP
   * (`performRecordAction`). The answer names what changed; the browser
   * refreshes its reads.
   */
  app.post('/api/actions', async (c) => {
    const ownerId = c.get('ownerId');
    const body = await c.req.json().catch(() => undefined);
    return json(
      c,
      await performRecordAction({ registry: services.modules, idempotency: services.idempotency }, body, ownerId),
    );
  });

  /** Every registered read with its input keys and result descriptor. */
  app.get('/api/read/operations', (c) => {
    c.get('ownerId');
    return json(c, { operations: describeReadOperations(services.modules) });
  });

  /**
   * The client reporting what it actually did with a UI command.
   *
   * This is what makes `ui_navigate` honest: the tool does not resolve until
   * this arrives, so the model is told the observed outcome instead of the fact
   * that a request was sent.
   */
  app.post('/api/runs/:id/ui-ack', async (c) => {
    const ownerId = c.get('ownerId');
    services.runs.get(c.req.param('id'), ownerId); // ownership check
    const parsed = uiCommandResultSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new AppError('validation_failed', 'Nieprawidlowe potwierdzenie.');
    return json(c, { accepted: runtime.acknowledgeUiCommand(parsed.data) });
  });

  /**
   * A decision about one pending question of one run.
   *
   * Two halves, and neither used to be complete. The **body** was read with a
   * bare `c.req.json()`, so a malformed or absent one became an unhandled
   * exception and a 500 `internal` instead of a validation failure. The
   * **binding** was missing: the request id went on without the run, so the
   * ownership check on the address and the consent actually granted could be
   * about different runs — an answer posted to a run of one's own, carrying the
   * request id of somebody else's, decided theirs. The run in the path is
   * therefore not decoration: `answerPermission` compares it, and the owner,
   * with the run that actually asked.
   *
   * `answered: false` is the honest answer to every case where nothing was
   * decided: an unknown id, an id belonging to another run, an expired request,
   * and a repeat of an answer already given. The operation runs at most once
   * because the gate resolves at most once.
   */
  app.post('/api/runs/:id/permission', async (c) => {
    const ownerId = c.get('ownerId');
    const runId = c.req.param('id');
    services.runs.get(runId, ownerId); // ownership check
    const parsed = z
      .object({ requestId: z.string().min(1), allow: z.boolean().optional() })
      .safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      throw new AppError('validation_failed', 'Nieprawidlowa odpowiedz na prosbe o zgode.', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const answered = runtime.answerPermission({
      runId,
      ownerId,
      requestId: parsed.data.requestId,
      allow: parsed.data.allow === true,
    });
    return json(c, { answered });
  });

  /* ------------------------------- canvas ------------------------------- */

  /*
   * A conversation's agent views space is created with its first view and
   * deleted with the conversation. One created through these routes could name
   * any id — a conversation that never existed or belongs to someone else — and
   * would outlive every deletion, so the scope is refused on them.
   */
  const refuseReservedScope = (scopeKind: string | null | undefined) => {
    if (scopeKind !== AGENT_VIEWS_SCOPE_KIND) return;
    throw new AppError(
      'validation_failed',
      `Zakres "${AGENT_VIEWS_SCOPE_KIND}" jest zarezerwowany: przestrzen widokow agenta powstaje z pierwszym widokiem rozmowy.`,
      { reason: 'reserved_scope' },
    );
  };

  app.get('/api/canvas/spaces', (c) =>
    json(c, { spaces: services.canvas.listSpaces(c.get('ownerId')) }),
  );

  app.post('/api/canvas/spaces', async (c) => {
    const ownerId = c.get('ownerId');
    const body = z
      .object({
        title: z.string().max(200),
        scopeKind: z.string().max(80).nullable().optional(),
        scopeId: z.string().max(128).nullable().optional(),
      })
      .parse(await c.req.json());
    refuseReservedScope(body.scopeKind);
    return json(c, services.canvas.createSpace({ ownerId, ...body }), 201);
  });

  /**
   * Resolves (and on first use builds) the space for a module scope. The default
   * composition comes from the module, is validated against the catalog, and is
   * only written when the space is new — reopening never overwrites user work.
   */
  app.post('/api/canvas/spaces/for-scope', async (c) => {
    const ownerId = c.get('ownerId');
    const body = z
      .object({ kind: z.string().max(80), id: z.string().max(128), title: z.string().max(200) })
      .parse(await c.req.json());
    refuseReservedScope(body.kind);
    const { space, created } = services.canvas.ensureScopedSpace({
      ownerId,
      title: body.title,
      scopeKind: body.kind,
      scopeId: body.id,
    });
    if (created) {
      for (const card of services.modules.defaultComposition({ kind: body.kind, id: body.id })) {
        await services.canvas.addCard(
          {
            spaceId: space.id,
            title: card.title,
            spec: services.catalog.validate(card.spec),
            geometry: card.geometry,
          },
          ownerId,
        );
      }
    }
    return json(c, { ...services.canvas.getState(space.id, ownerId), created });
  });

  app.get('/api/canvas/spaces/:id', (c) =>
    json(c, services.canvas.getState(c.req.param('id'), c.get('ownerId'))),
  );

  app.patch('/api/canvas/spaces/:id/viewport', async (c) => {
    const viewport = canvasViewportSchema.parse(await c.req.json());
    return json(c, services.canvas.setViewport(c.req.param('id'), c.get('ownerId'), viewport));
  });

  app.post('/api/canvas/cards', async (c) => {
    const ownerId = c.get('ownerId');
    const body = addCardInputSchema.parse(await c.req.json());
    const spec = services.catalog.validate(body.spec, {
      mode: services.canvas.compositionModeOfSpace(body.spaceId, ownerId),
    });
    return json(c, await services.canvas.addCard({ ...body, spec }, ownerId), 201);
  });

  /** Content channel. Separate from geometry on purpose. */
  app.patch('/api/canvas/cards/:id/spec', async (c) => {
    const ownerId = c.get('ownerId');
    const body = updateCardSpecInputSchema.parse({
      ...(await c.req.json()),
      cardId: c.req.param('id'),
    });
    const spec = services.catalog.validate(body.spec, {
      mode: services.canvas.compositionModeOfCard(body.cardId, ownerId),
    });
    return json(c, await services.canvas.updateSpec({ ...body, spec }, ownerId));
  });

  /** Geometry channel. Never bumps the content version. */
  app.patch('/api/canvas/cards/:id/geometry', async (c) => {
    const body = updateCardGeometryInputSchema.parse({
      ...(await c.req.json()),
      cardId: c.req.param('id'),
    });
    return json(c, services.canvas.updateGeometry(body, c.get('ownerId')));
  });

  app.delete('/api/canvas/cards/:id', async (c) =>
    json(c, await services.canvas.removeCard({ cardId: c.req.param('id') }, c.get('ownerId'))),
  );

  /* ------------------------------ artifacts ----------------------------- */

  app.get('/api/artifacts', (c) => {
    const ownerId = c.get('ownerId');
    const typeParam = c.req.query('type');
    const artifacts = services.artifacts.list(ownerId, {
      conversationId: c.req.query('conversationId'),
      type: typeParam ? typeParam.split(',') : undefined,
    });
    return json(c, {
      artifacts: artifacts.map((a) => ({
        id: a.id,
        title: a.title,
        type: a.rendererType,
        threadId: a.conversationId ?? '',
        updatedAt: a.updatedAt,
        kind: a.kind,
        mode: a.mode,
        currentVersion: a.currentVersion,
      })),
    });
  });

  /*
   * Reading an artifact.
   *
   * `snapshot` returns the payload frozen at that version — a historical report
   * keeps its numbers forever. `live` re-runs the registered module query its
   * descriptor names and returns *that* result, with an explicit `live` block
   * saying whether the refresh actually happened. A failed or unresolvable live
   * artifact returns `content: null` and an error; it never serves the stored
   * descriptor, or an older result, as though it were current data.
   *
   * Preview and full view call this same endpoint with the same version, so the
   * two cannot disagree.
   */
  app.get('/api/artifacts/:id', async (c) => {
    const ownerId = c.get('ownerId');
    const id = c.req.param('id');
    const meta = services.artifacts.meta(id, ownerId);
    const requested = c.req.query('version');
    const versionNumber = requested ? Number(requested) : undefined;
    const version = services.artifacts.version(id, ownerId, versionNumber);

    const base = {
      id: meta.id,
      title: meta.title,
      type: meta.rendererType,
      threadId: meta.conversationId ?? '',
      updatedAt: meta.updatedAt,
      kind: meta.kind,
      mode: meta.mode,
      version: version.version,
      currentVersion: meta.currentVersion,
      fileId: version.fileId,
    };

    if (meta.mode !== 'live') return json(c, { ...base, content: version.content, live: null });

    const resolved = await services.artifacts.resolveLive(id, ownerId, versionNumber);
    return json(c, {
      ...base,
      content: resolved.content,
      /** The descriptor itself, so a reader can see what is being re-run. */
      source: version.content,
      live: resolved.live,
    });
  });

  app.patch('/api/artifacts/:id', async (c) => {
    const ownerId = c.get('ownerId');
    const body = (await c.req.json()) as { content?: unknown; title?: string };
    const id = c.req.param('id');
    if (typeof body.title === 'string') services.artifacts.rename(id, ownerId, body.title);
    if (body.content !== undefined) services.artifacts.addVersion(id, ownerId, { content: body.content });
    const meta = services.artifacts.meta(id, ownerId);
    return json(c, { id: meta.id, title: meta.title, type: meta.rendererType, updatedAt: meta.updatedAt });
  });

  /* -------------------------------- files ------------------------------- */

  /**
   * The owner's files, each with the commands it was attached to.
   *
   * `attachedTo` is what makes an attachment traceable after the run: the link
   * used to exist only while the request was in flight, so a file on this screen
   * could not say which instruction it had been sent with.
   */
  app.get('/api/files', (c) => {
    const ownerId = c.get('ownerId');
    const kind = c.req.query('scopeKind');
    const id = c.req.query('scopeId');
    const attachments = services.conversations.attachmentsByFile(ownerId);
    return json(c, {
      files: services.files
        .list(ownerId, kind && id ? { kind, id } : undefined)
        .map((f) => ({ ...f, attachedTo: attachments[f.id] ?? [] })),
    });
  });

  app.post('/api/files', async (c) => {
    const ownerId = c.get('ownerId');
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new AppError('validation_failed', 'Brak pola "file".');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const stored = services.files.store({
      ownerId,
      filename: file.name,
      mediaType: file.type || 'application/octet-stream',
      bytes,
      scopeKind: (form.get('scopeKind') as string | null) ?? null,
      scopeId: (form.get('scopeId') as string | null) ?? null,
    });
    // `attachedTo` is empty and stated rather than absent: a file just uploaded
    // has been sent with no command yet, which is a fact, not missing data.
    return json(c, { ...stored, attachedTo: [] }, 201);
  });

  app.get('/api/files/:id/content', (c) => {
    const { meta, bytes } = services.files.read(c.req.param('id'), c.get('ownerId'));
    c.header('Content-Type', meta.mediaType);
    c.header('Content-Disposition', `attachment; filename="${meta.filename}"`);
    c.header('Content-Length', String(meta.byteSize));
    return c.body(new Uint8Array(bytes) as unknown as ArrayBuffer);
  });

  app.delete('/api/files/:id', (c) => {
    services.files.delete(c.req.param('id'), c.get('ownerId'));
    return json(c, { deleted: c.req.param('id') });
  });

  /* --------------------------- module routes ---------------------------- */

  for (const route of services.modules.routes) {
    app[route.method](route.path, async (c) => {
      const body = ['post', 'patch'].includes(route.method)
        ? await c.req.json().catch(() => undefined)
        : undefined;
      const res = await route.handler({
        method: route.method.toUpperCase(),
        path: route.path,
        params: c.req.param() as Record<string, string>,
        query: c.req.query() as Record<string, string>,
        body,
        ownerId: c.get('ownerId'),
        headers: { 'content-type': c.req.header('content-type') },
      });
      for (const [k, v] of Object.entries(res.headers ?? {})) c.header(k, v);
      return json(c, res.body, res.status ?? 200);
    });
  }

  return app;
}

export { cardSpecSchema, cardGeometrySchema };
