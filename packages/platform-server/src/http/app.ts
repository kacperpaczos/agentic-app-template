import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  AGENT_VIEWS_SCOPE_KIND,
  AppError,
  appContextSchema,
  addCardInputSchema,
  canvasViewportSchema,
  cardGeometrySchema,
  cardSpecSchema,
  CHAT_CAPABILITIES,
  EMPTY_APP_CONTEXT,
  runAgentInputSchema,
  updateCardGeometryInputSchema,
  updateCardSpecInputSchema,
  type AppContext,
  type StoredMessage,
  uiCommandResultSchema,
} from '@platform/contracts';
import { probeAuth } from '../agent/auth.ts';
import { AgentRuntime } from '../agent/runtime.ts';
import { SESSION_COOKIE, SessionAuth, ensureUser, requireUser } from '../auth/session.ts';
import type { PlatformServices } from '../services/index.ts';
import { deriveTitle } from '../services/conversations.ts';
import { describeReadOperations, runRead } from '../registry/read-operations.ts';

export const DEFAULT_USER_ID = 'local-user';
export const SECOND_USER_ID = 'other-user';

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

export function createPlatformApp(deps: PlatformAppDeps): Hono<Env> {
  const { services, runtime, auth } = deps;
  const app = new Hono<Env>();

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
      c.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
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
    const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
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
    const body = (await c.req.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string; role?: string; content?: unknown }>;
      spaceId?: string;
      title?: string;
    };
    const first = body.messages?.[0];
    const content = typeof first?.content === 'string' ? first.content : '';
    const conv = services.conversations.create({
      ownerId,
      title: body.title,
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
    return json(c, messages.map(toAguiMessage));
  });

  app.patch('/api/threads/update/:id', async (c) => {
    const ownerId = c.get('ownerId');
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; spaceId?: string | null };
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

    // The frontend's context selects what to look at; it never carries identity.
    const appContext: AppContext = appContextSchema.parse(
      (input.context as unknown) ?? forwarded.appContext ?? EMPTY_APP_CONTEXT,
    );

    const lastUser = [...input.messages]
      .reverse()
      .find((m) => (m as { role?: string }).role === 'user') as
      | { id?: string; content?: unknown }
      | undefined;
    const prompt = typeof lastUser?.content === 'string' ? lastUser.content : '';
    if (!prompt.trim()) throw new AppError('validation_failed', 'Puste polecenie.');

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
    services.conversations.appendMessage(conversationId, ownerId, {
      id: lastUser?.id,
      role: 'user',
      content: prompt,
    });

    const attachFileIds = Array.isArray(forwarded.attachFileIds)
      ? (forwarded.attachFileIds as string[]).slice(0, 10)
      : [];

    const started = await runtime.start({
      ownerId,
      conversationId,
      prompt,
      appContext: { ...appContext, conversationId },
      attachFileIds,
    });

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
    const run = services.runs.get(runId, ownerId);
    const live = runtime.liveStream(runId);

    return streamSSE(c, async (sse) => {
      if (live) {
        for await (const { seq, event } of live.read(from)) {
          await sse.writeSSE({ id: String(seq), data: JSON.stringify(event) });
        }
        return;
      }
      for (const { seq, payload } of services.runs.eventsAfter(runId, ownerId, from)) {
        await sse.writeSSE({ id: String(seq), data: JSON.stringify(payload) });
      }
      /*
       * A resolved run whose log carries no terminal event — killed process, or
       * a restart — would otherwise leave the client waiting for ever. The
       * stored status is the authority on how it ended.
       */
      const terminal = ['succeeded', 'failed', 'cancelled'];
      if (terminal.includes(run.status)) {
        const seen = services.runs
          .eventsAfter(runId, ownerId, 0)
          .some((e) => {
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
    });
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

  app.post('/api/runs/:id/permission', async (c) => {
    const ownerId = c.get('ownerId');
    services.runs.get(c.req.param('id'), ownerId); // ownership check
    const body = (await c.req.json()) as { requestId?: string; allow?: boolean };
    if (!body.requestId) throw new AppError('validation_failed', 'Brak requestId.');
    const answered = runtime.answerPermission(body.requestId, body.allow === true);
    return json(c, { answered });
  });

  /* ------------------------------- canvas ------------------------------- */

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

  app.get('/api/files', (c) => {
    const ownerId = c.get('ownerId');
    const kind = c.req.query('scopeKind');
    const id = c.req.query('scopeId');
    return json(c, { files: services.files.list(ownerId, kind && id ? { kind, id } : undefined) });
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
    return json(c, stored, 201);
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
