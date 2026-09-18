import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pairToolActivity } from '@openuidev/react-headless';
import { AGENT_VIEWS_SCOPE_KIND } from '@platform/contracts';
import type { ModelAgentLike } from '@platform/server';
import { createHarness, login, type Harness } from './helpers.ts';

/**
 * BL-08a — the chat's history: titles, a repeated command, deletion, and
 * identifiers that must not collide.
 *
 * **These are simulations**, and marked as such: the model is replaced at the
 * `ModelAgentLike` boundary by a stand-in that receives the very `sdkOptions`
 * the Claude Agent SDK would, hooks included. Everything on this side of that
 * boundary is the real application — the HTTP app, the conversation queue, the
 * run registry, the event stream, the projection and the database — because
 * every claim below is about what the application does, not about what a model
 * says.
 *
 * The browser half of these criteria is in `e2e/chat-history.spec.ts`. What is
 * here is what a browser cannot see: that a repeated POST starts no second run,
 * that deleting a conversation stops the work it owns, and that the pairing the
 * ready-made chat performs (`pairToolActivity`, executed here, not restated)
 * cannot attach one run's result to another run's call.
 */

/* -------------------------------------------------------------------------- */
/*  The stand-in                                                              */
/* -------------------------------------------------------------------------- */

type Step =
  | { kind: 'text'; text: string }
  /**
   * An announced tool call: the hooks fire with this exact `tool_use_id` and no
   * handler runs. The id is the test's on purpose — reproducing a provider that
   * reuses one across runs is the whole point of the collision case.
   */
  | { kind: 'tool'; id: string; name: string; input: unknown; result: string }
  /** Blocks until the test releases it, or until the run is cancelled. */
  | { kind: 'hold'; until: Promise<void> };

interface StandIn {
  agent: ModelAgentLike;
  /** How many times the adapter boundary was entered — one per model turn. */
  turns: number;
  /** Prompts, in order, exactly as the adapter received them. */
  prompts: string[];
}

/** Waits for `p`, but rejects the moment the run is aborted — as a real await does. */
function until(p: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('cancelled_by_user'));
    const onAbort = () => reject(signal?.reason ?? new Error('cancelled_by_user'));
    signal?.addEventListener('abort', onAbort, { once: true });
    void p.then(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/**
 * A stand-in choosing its script from the user's message, playing every step
 * *inside* the stream — so a `text` step before a `tool` step really does reach
 * the runtime before it, which a script that fires all its hooks up front
 * cannot reproduce.
 */
function standIn(scriptFor: (prompt: string) => Step[]): StandIn {
  const state: StandIn = { agent: null as never, turns: 0, prompts: [] };
  const promptOf = (input: unknown): string =>
    typeof input === 'string' ? input : String((input as { message?: unknown })?.message ?? '');

  const play = async (prompt: string, options: any) => {
    state.turns += 1;
    state.prompts.push(prompt);
    const steps = scriptFor(prompt);
    const hooks = options?.sdkOptions?.hooks ?? {};
    const signal: AbortSignal | undefined = options?.signal;
    const fire = async (event: string, payload: Record<string, unknown>) => {
      for (const group of hooks[event] ?? []) {
        for (const hook of group.hooks ?? []) await hook({ hook_event_name: event, ...payload });
      }
    };
    await fire('SessionStart', { session_id: 'sess_bl08a' });
    return {
      fullStream: (async function* () {
        for (const step of steps) {
          if (signal?.aborted) throw signal.reason ?? new Error('cancelled_by_user');
          if (step.kind === 'hold') {
            await until(step.until, signal);
            continue;
          }
          if (step.kind === 'tool') {
            await fire('PreToolUse', {
              tool_use_id: step.id,
              tool_name: step.name,
              tool_input: step.input,
            });
            await fire('PostToolUse', { tool_use_id: step.id, tool_response: step.result });
            continue;
          }
          yield { type: 'text-delta', payload: { text: step.text } };
        }
        await fire('Stop', { session_id: 'sess_bl08a' });
      })(),
    };
  };

  state.agent = {
    stream: (p, o) => play(promptOf(p), o),
    resumeStream: (i, o) => play(promptOf(i), o),
  };
  return state;
}

/* -------------------------------------------------------------------------- */

let h: Harness;
let cookie: string;
let model: StandIn;

/** Script used by every test that does not need a special one. */
let script: (prompt: string) => Step[] = () => [{ kind: 'text', text: 'Gotowe.' }];

const api = async (path: string, init: RequestInit = {}) =>
  h.platform.app.request(path, {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

const asJson = async (path: string, init: RequestInit = {}) => {
  const res = await api(path, init);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

/**
 * Posts one command and waits for its stream to end.
 *
 * The SSE body stays open for as long as the run does, so reading it to the end
 * is the same wait as the browser's — and the headers say which run and which
 * conversation answered.
 */
const command = async (
  body: Record<string, unknown>,
): Promise<{ status: number; runId: string | null; conversationId: string | null; replayed: boolean; events: any[] }> => {
  const res = await api('/api/agui/run', { method: 'POST', body: JSON.stringify(body) });
  const text = await res.text();
  const events = text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
  return {
    status: res.status,
    runId: res.headers.get('X-Run-Id'),
    conversationId: res.headers.get('X-Conversation-Id'),
    replayed: res.headers.get('X-Run-Replayed') === '1',
    events,
  };
};

const emptyContext = {
  conversationId: null,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
  ui: null,
};

const userMessage = (content: string) => ({ id: `msg_${content.length}_${content.slice(0, 6)}`, role: 'user', content });

beforeEach(async () => {
  model = standIn((p) => script(p));
  h = await createHarness({ withModule: false, modelAgent: model.agent });
  cookie = await login(h.platform.app, h.ownerId);
});
afterEach(() => {
  script = () => [{ kind: 'text', text: 'Gotowe.' }];
  h.dispose();
});

/* ========================================================================== */
/*  L4.3 — a sensible title, changeable, produced without the Anthropic API   */
/* ========================================================================== */

describe('L4.3 — tytul rozmowy: nadany lokalnie i zmienialny', () => {
  it('tytul pierwszej rozmowy powstaje bez ani jednej tury modelu', async () => {
    const prompt = 'Porownaj oferty dla sprawy PC-2026-01. Potem dodaj wykres.';
    const created = await asJson('/api/threads/create', {
      method: 'POST',
      body: JSON.stringify({ messages: [userMessage(prompt)] }),
    });
    expect(created.status).toBe(200);
    expect(created.body.title).toBe('Porownaj oferty dla sprawy PC-2026-01');
    /*
     * The load-bearing assertion, and the one that could not be made by reading
     * the code: creating a conversation and naming it entered the model adapter
     * zero times. A titling call — to Anthropic or to anything else behind that
     * boundary — would be counted here.
     */
    expect(model.turns, 'nadanie tytulu weszlo do adaptera modelu').toBe(0);

    /*
     * And a whole run, which does reach the model, still spends exactly one
     * turn: the answer. A second entry would be the title being asked for.
     */
    const run = await command({
      threadId: null,
      runId: crypto.randomUUID(),
      messages: [userMessage('Opisz, co widzisz na ekranie.')],
      context: emptyContext,
    });
    expect(run.status).toBe(200);
    expect(model.turns).toBe(1);
    const conv = await asJson(`/api/conversations/${run.conversationId}`);
    expect(conv.body.title).toBe('Opisz, co widzisz na ekranie');
    // Nothing the stand-in was asked resembles a request for a name.
    expect(model.prompts).toEqual(['Opisz, co widzisz na ekranie.']);
  });

  it('PATCH zmienia tytul, przycina go i nie przyjmuje pustego', async () => {
    const created = await asJson('/api/threads/create', {
      method: 'POST',
      body: JSON.stringify({ messages: [userMessage('Pierwsza wiadomosc rozmowy')] }),
    });
    const id = created.body.id as string;

    const renamed = await asJson(`/api/threads/update/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: '  Zestawienie ofert — marzec  ' }),
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe('Zestawienie ofert — marzec');
    // The list the chat reads agrees; a rename that only the response knew
    // about would be a rename nobody can see.
    const list = await asJson('/api/threads/get');
    expect(list.body.threads.find((t: any) => t.id === id).title).toBe('Zestawienie ofert — marzec');

    // Blank is not a name: the derived one is kept rather than replaced by it.
    const blank = await asJson(`/api/threads/update/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: '   ' }),
    });
    expect(blank.body.title).toBe('Zestawienie ofert — marzec');

    // Bounded, so a pasted document cannot become a title.
    const long = await asJson(`/api/threads/update/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'x'.repeat(400) }),
    });
    expect(long.body.title).toHaveLength(120);
  });

  it('cudzej rozmowy nie da sie przemianowac', async () => {
    const created = await asJson('/api/threads/create', {
      method: 'POST',
      body: JSON.stringify({ messages: [userMessage('Rozmowa wlasciciela pierwszego')] }),
    });
    const id = created.body.id as string;
    const otherCookie = await login(h.platform.app, h.otherOwnerId);
    const res = await h.platform.app.request(`/api/threads/update/${id}`, {
      method: 'PATCH',
      headers: { cookie: otherCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Przejete' }),
    });
    expect(res.status).toBe(403);
    const still = await asJson(`/api/conversations/${id}`);
    expect(still.body.title).toBe('Rozmowa wlasciciela pierwszego');
  });
});

/* ========================================================================== */
/*  L4.6 — one request, however many times it arrives, is one run             */
/* ========================================================================== */

describe('L4.6 — powtorzone zadanie nie tworzy drugiej odpowiedzi', () => {
  it('ten sam runId: jedno uruchomienie, jedna odpowiedz, jedna rozmowa', async () => {
    script = () => [
      { kind: 'text', text: 'Zanim sprawdze, ' },
      { kind: 'tool', id: 'tu_1', name: 'mcp__app__ui_catalog', input: {}, result: '{"ok":true}' },
      { kind: 'text', text: 'gotowe.' },
    ];
    const runId = crypto.randomUUID();
    const body = {
      threadId: null,
      runId,
      messages: [userMessage('Zrob to raz.')],
      context: emptyContext,
    };

    const first = await command(body);
    expect(first.status).toBe(200);
    expect(first.replayed).toBe(false);

    // The identical request again — a retried POST, not a second command.
    const second = await command(body);
    expect(second.status).toBe(200);
    expect(second.replayed, 'drugie zadanie nie zostalo rozpoznane jako powtorzenie').toBe(true);
    expect(second.runId).toBe(first.runId);
    expect(second.conversationId).toBe(first.conversationId);

    // One turn at the model. Two would be the work done twice.
    expect(model.turns, 'powtorzenie weszlo do modelu drugi raz').toBe(1);

    // One run for the conversation, and no second conversation.
    const runs = await asJson(`/api/conversations/${first.conversationId}/runs`);
    expect(runs.body.runs).toHaveLength(1);
    const threads = await asJson('/api/threads/get');
    expect(threads.body.threads).toHaveLength(1);

    /*
     * And one answer in the thread. This is the assertion the criterion is
     * about: the user's message was always deduplicated by id, the assistant's
     * was not.
     */
    const messages = await asJson(`/api/threads/get/${first.conversationId}`);
    const roles = messages.body.map((m: any) => m.role);
    expect(roles.filter((r: string) => r === 'user')).toHaveLength(1);
    expect(roles.filter((r: string) => r === 'assistant')).toHaveLength(2); // text, tool call + answer
    expect(
      messages.body.filter((m: any) => m.role === 'assistant').map((m: any) => m.content).join(''),
    ).toBe('Zanim sprawdze, gotowe.');

    // The replay delivered the same events, not a fresh empty stream.
    expect(second.events.map((e) => e.type)).toEqual(first.events.map((e) => e.type));
    expect(second.events.filter((e) => e.type === 'RUN_FINISHED')).toHaveLength(1);
  });

  it('inny runId to inne polecenie — powtorzenie nie zjada drugiej proby', async () => {
    const conv = await asJson('/api/threads/create', {
      method: 'POST',
      body: JSON.stringify({ messages: [userMessage('Rozmowa robocza')] }),
    });
    const threadId = conv.body.id as string;

    const a = await command({
      threadId,
      runId: crypto.randomUUID(),
      messages: [userMessage('Polecenie pierwsze.')],
      context: { ...emptyContext, conversationId: threadId },
    });
    const b = await command({
      threadId,
      runId: crypto.randomUUID(),
      messages: [userMessage('Polecenie drugie.')],
      context: { ...emptyContext, conversationId: threadId },
    });
    expect(b.replayed).toBe(false);
    expect(b.runId).not.toBe(a.runId);
    expect(model.turns).toBe(2);
    const runs = await asJson(`/api/conversations/${threadId}/runs`);
    expect(runs.body.runs).toHaveLength(2);
  });

  it('powtorzenie nalezy do wlasciciela, ktory je wyslal', async () => {
    const runId = crypto.randomUUID();
    const body = { threadId: null, runId, messages: [userMessage('Moje polecenie.')], context: emptyContext };
    const mine = await command(body);

    // The same key from the other identity is not a repeat of anything: it
    // starts that identity's own run, in that identity's own conversation.
    const otherCookie = await login(h.platform.app, h.otherOwnerId);
    const res = await h.platform.app.request('/api/agui/run', {
      method: 'POST',
      headers: { cookie: otherCookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await res.text();
    expect(res.headers.get('X-Run-Replayed')).toBe(null);
    expect(res.headers.get('X-Run-Id')).not.toBe(mine.runId);
    expect(res.headers.get('X-Conversation-Id')).not.toBe(mine.conversationId);
  });
});

/* ========================================================================== */
/*  L4.7 — what deleting a conversation actually does                         */
/* ========================================================================== */

describe('L4.7 — usuniecie rozmowy ma okreslony skutek', () => {
  it('zatrzymuje trwajace zadanie, odlacza artefakt, kasuje historie i przestrzen widokow', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    script = (prompt) =>
      prompt.includes('dlugo')
        ? [
            { kind: 'text', text: 'Zaczynam. ' },
            { kind: 'hold', until: held },
            { kind: 'text', text: 'Koniec, ktorego nie powinno byc.' },
          ]
        : [{ kind: 'text', text: 'Gotowe.' }];

    const conv = await asJson('/api/threads/create', {
      method: 'POST',
      body: JSON.stringify({ messages: [userMessage('Rozmowa do usuniecia')] }),
    });
    const threadId = conv.body.id as string;

    // An artifact that belongs to this conversation, with content — the case
    // the previous test could not fail on, because it deleted a conversation
    // that had none.
    const artifact = h.platform.services.artifacts.create({
      ownerId: h.ownerId,
      conversationId: threadId,
      kind: 'table',
      mode: 'snapshot',
      title: 'Zestawienie z rozmowy',
      rendererType: 'platform.json',
      content: { rows: [{ a: 1 }] },
    });

    // Its own agent-views space, bound by scope rather than by a foreign key.
    const space = h.platform.services.canvas.createSpace({
      ownerId: h.ownerId,
      title: 'Widoki agenta',
      scopeKind: AGENT_VIEWS_SCOPE_KIND,
      scopeId: threadId,
    });

    // A run that is genuinely still in flight when the delete lands.
    const streaming = command({
      threadId,
      runId: crypto.randomUUID(),
      messages: [userMessage('Popracuj dlugo nad tym.')],
      context: { ...emptyContext, conversationId: threadId },
    });
    await expect
      .poll(() => h.platform.services.runs.listActive(h.ownerId).length, { timeout: 5_000 })
      .toBe(1);
    const activeRunId = h.platform.services.runs.listActive(h.ownerId)[0]!.id;

    const deleted = await asJson(`/api/threads/delete/${threadId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({
      deleted: threadId,
      detachedArtifacts: 1,
      removedViewSpaces: 1,
      // Stated, not implied: the work the conversation owned was stopped.
      cancelledRuns: 1,
    });

    // The stream ends; it does not hang and it does not go on producing.
    const result = await streaming;
    expect(result.events.some((e) => e.type === 'RUN_ERROR')).toBe(true);
    expect(
      result.events.some((e) => e.type === 'TEXT_MESSAGE_CONTENT' && String(e.delta).includes('nie powinno')),
      'wykonanie mowilo dalej po usunieciu rozmowy',
    ).toBe(false);

    // Nothing is left in flight, and nothing dangles: the run went with the
    // conversation, its event log went with the run, and the artifact — the one
    // thing that outlives both — no longer names a conversation that is gone.
    expect(h.platform.services.runs.listActive(h.ownerId)).toEqual([]);
    expect(() => h.platform.services.runs.get(activeRunId, h.ownerId)).toThrow();
    expect(
      h.platform.db.$client.prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?').get(activeRunId),
    ).toEqual({ n: 0 });
    expect(h.platform.services.artifacts.meta(artifact.meta.id, h.ownerId).conversationId).toBe(null);
    expect(h.platform.services.canvas.findScopedSpace(h.ownerId, AGENT_VIEWS_SCOPE_KIND, threadId)).toBe(null);
    // Released so the promise cannot outlive the test even if the run survived.
    release();
  });

  it('artefakt rozmowy zostaje, odlaczony i czytelny; wiadomosci i uruchomienia znikaja', async () => {
    const conv = await asJson('/api/threads/create', {
      method: 'POST',
      body: JSON.stringify({ messages: [userMessage('Rozmowa z artefaktem')] }),
    });
    const threadId = conv.body.id as string;
    const run = await command({
      threadId,
      runId: crypto.randomUUID(),
      messages: [userMessage('Zrob cos krotkiego.')],
      context: { ...emptyContext, conversationId: threadId },
    });
    const artifact = h.platform.services.artifacts.create({
      ownerId: h.ownerId,
      conversationId: threadId,
      runId: run.runId,
      kind: 'table',
      mode: 'snapshot',
      title: 'Zestawienie do zachowania',
      rendererType: 'platform.json',
      content: { rows: [{ a: 1 }] },
    });

    const before = await asJson('/api/artifacts');
    expect(before.body.artifacts).toHaveLength(1);

    const deleted = await asJson(`/api/threads/delete/${threadId}`, { method: 'DELETE' });
    expect(deleted.body.detachedArtifacts).toBe(1);

    // Still listed, still openable, still carrying its content — detached, not
    // deleted, and no longer naming a conversation that does not exist.
    const after = await asJson('/api/artifacts');
    expect(after.body.artifacts.map((a: any) => a.id)).toEqual([artifact.meta.id]);
    const opened = await asJson(`/api/artifacts/${artifact.meta.id}`);
    expect(opened.status).toBe(200);
    // Detached: the chat's own field for "which conversation produced this" is
    // empty, and the stored link is null rather than a dangling id.
    expect(opened.body.threadId).toBe('');
    expect(opened.body.content).toEqual({ rows: [{ a: 1 }] });
    expect(h.platform.services.artifacts.meta(artifact.meta.id, h.ownerId).conversationId).toBe(null);

    // Messages and runs went with the conversation.
    expect((await asJson(`/api/threads/get/${threadId}`)).status).toBe(404);
    expect(
      h.platform.db.$client
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
        .get(threadId),
    ).toEqual({ n: 0 });
    expect(
      h.platform.db.$client
        .prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE conversation_id = ?')
        .get(threadId),
    ).toEqual({ n: 0 });
    // And the run's own event log went with the run, rather than being orphaned.
    expect(
      h.platform.db.$client
        .prepare('SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?')
        .get(run.runId),
    ).toEqual({ n: 0 });
  });
});

/* ========================================================================== */
/*  L4.13 — identifiers that cannot collide between runs                     */
/* ========================================================================== */

describe('L4.13 — identyfikatory narzedzi nie koliduja miedzy wykonaniami', () => {
  it('dwa wykonania z tym samym tool_use_id: kazdy wynik zostaje przy swoim wywolaniu', async () => {
    /*
     * The provider reuses `tu_1` in both runs — which is what a restarted
     * session, a resumed transcript and the runtime's own fallback all do. The
     * two calls are deliberately *different*, so a mispairing is visible in the
     * result rather than being hidden behind identical content.
     */
    script = (prompt) =>
      prompt.includes('pierwsze')
        ? [
            { kind: 'tool', id: 'tu_1', name: 'mcp__app__ui_catalog', input: { krok: 1 }, result: '{"wynik":"PIERWSZY"}' },
            { kind: 'text', text: 'Zrobione raz.' },
          ]
        : [
            { kind: 'tool', id: 'tu_1', name: 'mcp__app__ui_targets', input: { krok: 2 }, result: '{"wynik":"DRUGI"}' },
            { kind: 'text', text: 'Zrobione dwa.' },
          ];

    const conv = await asJson('/api/threads/create', {
      method: 'POST',
      body: JSON.stringify({ messages: [userMessage('Rozmowa z dwoma wykonaniami')] }),
    });
    const threadId = conv.body.id as string;
    const context = { ...emptyContext, conversationId: threadId };

    const first = await command({
      threadId,
      runId: crypto.randomUUID(),
      messages: [userMessage('Zrob pierwsze.')],
      context,
    });
    const second = await command({
      threadId,
      runId: crypto.randomUUID(),
      messages: [userMessage('Zrob drugie.')],
      context,
    });
    expect(first.runId).not.toBe(second.runId);

    const history = (await asJson(`/api/threads/get/${threadId}`)).body as any[];

    // Two tool messages, not one: a shared id used to mean the second result
    // updated the first row instead of being added.
    const toolMessages = history.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(new Set(toolMessages.map((m) => m.id)).size).toBe(2);
    // The ids the chat pairs on differ too — this is the fix, not a side effect.
    expect(new Set(toolMessages.map((m) => m.toolCallId)).size).toBe(2);
    expect(toolMessages.map((m) => m.toolCallId).every((id: string) => id.includes('tu_1'))).toBe(true);

    /*
     * And now the claim that matters, made by running the chat's own pairing
     * over the stored history rather than by asserting what it is believed to
     * do. `pairToolActivity` searches *all* messages for a result with the
     * call's id, so a shared id is exactly how one turn's card came to show
     * another turn's answer.
     */
    const assistants = history.filter((m) => m.role === 'assistant' && (m.toolCalls ?? []).length > 0);
    expect(assistants).toHaveLength(2);
    const paired = assistants.map((m) => pairToolActivity(m as never, history as never));
    expect(paired[0]).toHaveLength(1);
    expect(paired[1]).toHaveLength(1);
    expect(paired[0]![0]!.toolName).toContain('ui_catalog');
    expect(String(paired[0]![0]!.result)).toContain('PIERWSZY');
    expect(paired[1]![0]!.toolName).toContain('ui_targets');
    expect(String(paired[1]![0]!.result)).toContain('DRUGI');

    // The run each call belongs to is recoverable from the id, which is what
    // makes "whose result is this" answerable at all.
    expect(toolMessages[0]!.toolCallId.startsWith(`${first.runId}~`)).toBe(true);
    expect(toolMessages[1]!.toolCallId.startsWith(`${second.runId}~`)).toBe(true);
  });

  it('projekcja zachowuje kolejnosc i jest idempotentna po ponownym odczycie', async () => {
    script = () => [
      { kind: 'text', text: 'Najpierw mowie. ' },
      { kind: 'tool', id: 'tu_1', name: 'mcp__app__ui_catalog', input: {}, result: '{"ok":1}' },
      { kind: 'text', text: 'Potem odpowiadam.' },
    ];
    const run = await command({
      threadId: null,
      runId: crypto.randomUUID(),
      messages: [userMessage('Powiedz, zawolaj, odpowiedz.')],
      context: emptyContext,
    });
    const first = (await asJson(`/api/threads/get/${run.conversationId}`)).body as any[];
    expect(first.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(first[1].content).toBe('Najpierw mowie. ');
    expect(first[3].content).toBe('Potem odpowiadam.');

    // Reading it again changes nothing: same rows, same order, same ids.
    const again = (await asJson(`/api/threads/get/${run.conversationId}`)).body as any[];
    expect(again).toEqual(first);
  });
});
