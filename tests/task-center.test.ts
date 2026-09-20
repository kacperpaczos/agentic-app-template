import { afterEach, describe, expect, it } from 'vitest';
import { taskRetryResultSchema, taskViewSchema } from '@platform/contracts';
import type { ModelAgentLike } from '@platform/server';
import { createHarness, login, type Harness } from './helpers.ts';

/**
 * The global task center (L11.6): the contract of the task view.
 *
 * A task is the backend's work, not the panel that started it — `background-runs`
 * already proved that. What that regression does not prove is the **operational
 * view**: one place listing tasks from every conversation, with progress, tools
 * used, input files, output artifacts and the error, and with the actions
 * (open, cancel, retry) reachable without entering the source conversation.
 *
 * **Simulation, and marked as such:** the model is replaced at the adapter
 * boundary by a stand-in receiving the same `sdkOptions` (including the hooks
 * the bridge turns into tool events). The queue, run registry, event log, HTTP
 * app and the task projection are the real thing — they are what is under test.
 */

type Cmd =
  | { kind: 'text'; text: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'tool'; name: string; toolUseId: string }
  | { kind: 'toolResult'; toolUseId: string; response?: string }
  | { kind: 'fail'; message: string };

function scriptedModel(script: Cmd[]): ModelAgentLike {
  const play = async (options: unknown) => {
    const hooks = (options as { sdkOptions?: { hooks?: Record<string, Array<{ hooks?: Array<(i: unknown) => Promise<void>> }>> } })
      ?.sdkOptions?.hooks ?? {};
    const fire = async (event: string, payload: Record<string, unknown>) => {
      for (const group of hooks[event] ?? []) {
        for (const hook of group.hooks ?? []) await hook({ hook_event_name: event, ...payload });
      }
    };
    await fire('SessionStart', { session_id: 'sess_task' });
    for (const step of script) {
      if (step.kind === 'wait') await new Promise((r) => setTimeout(r, step.ms));
      else if (step.kind === 'tool')
        await fire('PreToolUse', { tool_name: step.name, tool_use_id: step.toolUseId, tool_input: {} });
      else if (step.kind === 'toolResult')
        await fire('PostToolUse', { tool_use_id: step.toolUseId, tool_response: step.response ?? 'ok' });
      else if (step.kind === 'fail') throw new Error(step.message);
      else if (step.kind === 'text') {
        /* Text travels in the model stream, not through a hook — see below. */
      }
    }
    await fire('Stop', { session_id: 'sess_task' });
    const texts = script.filter((s): s is Extract<Cmd, { kind: 'text' }> => s.kind === 'text');
    return {
      fullStream: (async function* () {
        for (const t of texts) yield { type: 'text-delta', payload: { text: t.text } };
      })(),
    };
  };
  return {
    stream: (_p: unknown, o: unknown) => play(o),
    resumeStream: (_i: unknown, o: unknown) => play(o),
  } as unknown as ModelAgentLike;
}

let h: Harness;
afterEach(() => h?.dispose());

const cookieOf = async (userId = h.ownerId) => login(h.platform.app, userId);

/** Sends a command through the client's real path; returns the header ids. */
async function postRun(cookie: string, body: Record<string, unknown>) {
  const res = await h.platform.app.request('/api/agui/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  /* The stream is deliberately not read to the end: the run is the backend's
     work, not the HTTP response, and the test asks about it through the center. */
  await res.body?.cancel().catch(() => undefined);
  return { runId: res.headers.get('X-Run-Id')!, conversationId: res.headers.get('X-Conversation-Id')! };
}

const getTasks = async (cookie: string, query = '') => {
  const res = await h.platform.app.request(`/api/tasks${query}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as { tasks: unknown[] };
};

const getTask = async (cookie: string, id: string) =>
  h.platform.app.request(`/api/tasks/${id}`, { headers: { cookie } });

const runsStatus = async (conversationId: string, cookie: string) => {
  const res = await h.platform.app.request(`/api/conversations/${conversationId}/runs`, {
    headers: { cookie },
  });
  return ((await res.json()) as { runs: Array<{ id: string; status: string }> }).runs;
};

const waitStatus = async (conversationId: string, runId: string, cookie: string, status: string) =>
  expect
    .poll(
      async () => (await runsStatus(conversationId, cookie)).find((r) => r.id === runId)?.status,
      { timeout: 10_000 },
    )
    .toBe(status);

const taskOf = async (cookie: string, runId: string) => {
  const { tasks } = await getTasks(cookie);
  const raw = tasks.find((t) => (t as { run: { id: string } }).run.id === runId);
  expect(raw, 'zadanie ma byc widoczne w centrum').toBeTruthy();
  return taskViewSchema.parse(raw);
};

describe('centrum zadan', () => {
  it('pokazuje zadanie w trakcie: intencje, rozmowe, narzedzia i postep', async () => {
    h = await createHarness({
      withModule: false,
      modelAgent: scriptedModel([
        { kind: 'tool', name: 'Szukaj', toolUseId: 'tu_1' },
        { kind: 'wait', ms: 30 },
        { kind: 'toolResult', toolUseId: 'tu_1' },
        { kind: 'text', text: 'Skonczylem szukanie.' },
      ]),
    });
    const cookie = await cookieOf();
    const { runId, conversationId } = await postRun(cookie, {
      runId: 'task-center-1',
      messages: [{ id: 'm-tc-1', role: 'user', content: 'Znajdz oferty z vatem 23' }],
    });

    /* Tools and text arrive as the run — started in parallel to this HTTP
       response — produces them, so the center is asked until it shows them. */
    let task!: ReturnType<typeof taskViewSchema.parse>;
    await expect
      .poll(
        async () => {
          const found = await taskOf(cookie, runId);
          if (found.progress.toolCallsFinished === 0) return 0;
          task = found;
          return found.progress.toolCallsFinished;
        },
        { timeout: 10_000 },
      )
      .toBe(1);

    expect(task.intent).toBe('Znajdz oferty z vatem 23');
    expect(task.conversationId).toBe(conversationId);
    expect(task.conversationTitle, 'zadanie ma byc nazywalne tytulem rozmowy').toBeTruthy();
    expect(['queued', 'running']).toContain(task.run.status);
    expect(task.tools).toEqual([{ name: 'Szukaj', calls: 1 }]);
    expect(task.progress.lastEventAt).toBeTruthy();
    expect(task.inputFiles).toEqual([]);
    expect(task.artifacts).toEqual([]);

    /* After finishing, the task stays in the center with status and timing —
       an operational view, not an "unread" list. */
    await waitStatus(conversationId, runId, cookie, 'succeeded');
    const after = await taskOf(cookie, runId);
    expect(after.run.status).toBe('succeeded');
    expect(after.run.durationMs).not.toBeNull();
    expect(after.progress.textParts).toBeGreaterThan(0);
  });

  it('jedna odpowiedz zawiera zadania z roznych rozmow: aktywne przed zakonczonymi', async () => {
    /* One harness, one database: call 1 finishes at once, call 2 hangs — which
       is exactly the mix the listing has to keep apart. */
    let calls = 0;
    const model = (): ModelAgentLike => ({
      stream: () => {
        calls += 1;
        const hangs = calls > 1;
        return Promise.resolve({
          fullStream: (async function* () {
            if (hangs) await new Promise((r) => setTimeout(r, 60_000));
            yield { type: 'text-delta', payload: { text: hangs ? 'nigdy' : 'skonczone' } };
          })(),
        }) as never;
      },
      resumeStream: () => Promise.resolve({ fullStream: (async function* () {})() }) as never,
    });
    h = await createHarness({ withModule: false, modelAgent: model() });
    const cookie = await cookieOf();
    const finished = await postRun(cookie, {
      runId: 'task-center-g1',
      messages: [{ id: 'm-tc-g1', role: 'user', content: 'Zadanie ktore zaraz skonczy' }],
    });
    await waitStatus(finished.conversationId, finished.runId, cookie, 'succeeded');

    /* The second conversation's run is still in flight while the listing is read. */
    const active = await postRun(cookie, {
      runId: 'task-center-g2',
      messages: [{ id: 'm-tc-g2', role: 'user', content: 'Zadanie dlugie w innej rozmowie' }],
    });

    const { tasks } = await getTasks(cookie);
    const ids = tasks.map((t) => (t as { run: { id: string } }).run.id);
    expect(ids, 'oba zadania widoczne w jednym liscingu').toContain(finished.runId);
    expect(ids).toContain(active.runId);
    /* Ordering is the contract: work in flight first, then the latest finished. */
    expect(ids.indexOf(active.runId)).toBeLessThan(ids.indexOf(finished.runId));
    const activeView = taskViewSchema.parse(tasks.find((t) => (t as { run: { id: string } }).run.id === active.runId));
    expect(activeView.conversationId).not.toBe(finished.conversationId);
    expect(['queued', 'running']).toContain(activeView.run.status);

    /* Cleanup: the stand-in never finishes this run on its own. */
    await h.platform.app.request(`/api/runs/${active.runId}/cancel`, {
      method: 'POST',
      headers: { cookie },
    });
  });

  it('limit zapytania ogranicza liste, zatrzymujac najpierw aktywne, potem najnowsze zakonczone', async () => {
    h = await createHarness({
      withModule: false,
      modelAgent: scriptedModel([{ kind: 'text', text: 'Szybkie.' }]),
    });
    const cookie = await cookieOf();
    const made: Array<{ runId: string }> = [];
    for (const [i, runId] of ['task-center-l1', 'task-center-l2', 'task-center-l3'].entries()) {
      const r = await postRun(cookie, {
        runId,
        messages: [{ id: `m-tc-l${i}`, role: 'user', content: `Zadanie numer ${i}` }],
      });
      made.push({ runId: r.runId });
      await waitStatus(r.conversationId, r.runId, cookie, 'succeeded');
    }

    const { tasks } = await getTasks(cookie, '?limit=2');
    expect(tasks).toHaveLength(2);
    /* No active run: the two newest finished ones are what limit=2 keeps. */
    expect(tasks.map((t) => (t as { run: { id: string } }).run.id)).toEqual([
      made[2]!.runId,
      made[1]!.runId,
    ]);
  });

  it('pokazuje pliki wejsciowe polecenia', async () => {
    h = await createHarness({
      withModule: false,
      modelAgent: scriptedModel([{ kind: 'text', text: 'Przeczytalem.' }]),
    });
    const cookie = await cookieOf();
    const stored = h.platform.services.files.store({
      ownerId: h.ownerId,
      filename: 'oferty-wejscie.csv',
      mediaType: 'text/csv',
      bytes: new TextEncoder().encode('a,b\n1,2\n'),
    });
    await postRun(cookie, {
      runId: 'task-center-2',
      messages: [{ id: 'm-tc-2', role: 'user', content: 'Porownaj kolumny' }],
      forwardedProps: { attachFileIds: [stored.id] },
    });

    const { tasks } = await getTasks(cookie);
    const task = taskViewSchema.parse(tasks[0]);
    expect(task.inputFiles).toEqual([{ id: stored.id, filename: 'oferty-wejscie.csv' }]);
  });

  it('pokazuje artefakty wynikowe zadania', async () => {
    h = await createHarness({
      withModule: false,
      modelAgent: scriptedModel([{ kind: 'text', text: 'Publikuje.' }]),
    });
    const cookie = await cookieOf();
    const { runId } = await postRun(cookie, {
      runId: 'task-center-3',
      messages: [{ id: 'm-tc-3', role: 'user', content: 'Zrob raport' }],
    });
    h.platform.services.artifacts.create({
      ownerId: h.ownerId,
      conversationId: null,
      runId,
      kind: 'table',
      mode: 'snapshot',
      title: 'Raport porownania',
      rendererType: 'data-table',
      content: { columns: [], rows: [] },
    });

    const task = taskViewSchema.parse((await getTasks(cookie)).tasks[0]);
    expect(task.artifacts.map((a) => a.title)).toEqual(['Raport porownania']);
    expect(task.progress.artifactsPublished).toBe(1);
  });

  it('ukrywa zadania innego wlasciciela', async () => {
    h = await createHarness({
      withModule: false,
      modelAgent: scriptedModel([{ kind: 'text', text: 'Moje zadanie.' }]),
    });
    const cookie = await cookieOf();
    const { runId } = await postRun(cookie, {
      runId: 'task-center-4',
      messages: [{ id: 'm-tc-4', role: 'user', content: 'Tylko moje' }],
    });

    const other = await cookieOf(h.otherOwnerId);
    const { tasks } = await getTasks(other);
    expect(tasks.map((t) => (t as { run: { id: string } }).run.id)).not.toContain(runId);
    const res = await getTask(other, runId);
    expect(res.status).toBe(403);
  });

  it('nieudane zadanie pokazuje blad, a ponowienie tworzy nowe wykonanie w tej samej rozmowie', async () => {
    let calls = 0;
    const model = (): ModelAgentLike => ({
      stream: (_p: unknown, o: unknown) => {
        calls += 1;
        const signal = (o as { signal?: AbortSignal })?.signal;
        if (calls === 1) return Promise.reject(new Error('wybuch modelu')) as never;
        const text = calls === 2 ? 'Udalo sie za drugim razem.' : 'Dluga praca nadal trwa.';
        return Promise.resolve({
          fullStream: (async function* () {
            if (calls > 2) {
              await new Promise((r) => setTimeout(r, 2_500));
              if (signal?.aborted) throw signal.reason ?? new Error('run cancelled');
            }
            yield { type: 'text-delta', payload: { text } };
          })(),
        }) as never;
      },
      resumeStream: () => Promise.resolve({ fullStream: (async function* () {})() }) as never,
    });
    h = await createHarness({ withModule: false, modelAgent: model() });
    const cookie = await cookieOf();
    const { runId, conversationId } = await postRun(cookie, {
      runId: 'task-center-5',
      messages: [{ id: 'm-tc-5', role: 'user', content: 'Zadanie ktore pada' }],
    });

    await waitStatus(conversationId, runId, cookie, 'failed');
    const failed = await taskOf(cookie, runId);
    expect(failed.run.status).toBe('failed');
    expect(failed.run.errorCode).toBeTruthy();
    expect(failed.run.errorMessage).toContain('wybuch modelu');

    /* Retry: a new run, the same conversation, the same command. The response
       is checked against its own contract, the way the center consumes it. */
    const res = await h.platform.app.request(`/api/runs/${runId}/retry`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const retried = taskRetryResultSchema.parse(await res.json());
    expect(retried.run.id).not.toBe(runId);
    expect(retried.conversationId).toBe(conversationId);

    await waitStatus(conversationId, retried.run.id, cookie, 'succeeded');

    const messages = h.platform.services.conversations.messages(conversationId, h.ownerId);
    const userTexts = messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(userTexts.filter((t) => t === 'Zadanie ktore pada').length).toBe(2);
    // The source run stays failed — a retry does not rewrite it.
    expect((await runsStatus(conversationId, cookie)).find((r) => r.id === runId)?.status).toBe(
      'failed',
    );

    /* Retrying a run in flight is refused, not doubled. */
    const active = await postRun(cookie, {
      runId: 'task-center-5b',
      messages: [{ id: 'm-tc-6', role: 'user', content: 'Zadanie dlugie' }],
    });
    const again = await h.platform.app.request(`/api/runs/${active.runId}/retry`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(again.status).toBe(409);
    await h.platform.app.request(`/api/runs/${active.runId}/cancel`, {
      method: 'POST',
      headers: { cookie },
    });
  });

  it('zwraca 404 dla obcego identyfikatora', async () => {
    h = await createHarness({ withModule: false, modelAgent: scriptedModel([{ kind: 'text', text: 'ok' }]) });
    const cookie = await cookieOf();
    const res = await h.platform.app.request('/api/tasks/nie.ma.takiego', { headers: { cookie } });
    expect(res.status).toBe(404);
  });
});
