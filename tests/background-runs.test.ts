import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, type ModelAgentLike } from '@platform/server';
import { createHarness, login, type Harness } from './helpers.ts';

/**
 * A run belongs to the backend, not to the socket that started it.
 *
 * **Simulation, and marked as such:** the model is replaced at the adapter
 * boundary by a stand-in that receives the same `sdkOptions` the Claude Agent
 * SDK would. Everything else — the queue, the event stream, the projection, the
 * run registry and the HTTP app — is the real thing, because what is under test
 * is precisely how those behave when the client goes away.
 *
 * The properties here are the ones the previous build got wrong. The browser's
 * abort was forwarded to the cancel endpoint, so switching conversation or
 * pressing reload silently killed work that was meant to continue. And with no
 * way to re-attach, a run that outlived its request could not be seen again at
 * all.
 */

type Step = { kind: 'text'; text: string } | { kind: 'wait'; ms: number };

function scriptedAgent(script: Step[], sessionId = 'sess_bg'): ModelAgentLike {
  const play = async (options: any) => {
    const hooks = options?.sdkOptions?.hooks ?? {};
    const fire = async (event: string, payload: Record<string, unknown>) => {
      for (const group of hooks[event] ?? []) {
        for (const hook of group.hooks ?? []) await hook({ hook_event_name: event, ...payload });
      }
    };
    await fire('SessionStart', { session_id: sessionId });
    await fire('Stop', { session_id: sessionId });
    const signal: AbortSignal | undefined = options?.signal;
    return {
      fullStream: (async function* () {
        for (const step of script) {
          if (step.kind === 'wait') {
            await new Promise((r) => setTimeout(r, step.ms));
            // Honour cancellation the way the real SDK does, otherwise a
            // cancellation test measures nothing.
            if (signal?.aborted) throw signal.reason ?? new Error('run cancelled');
            continue;
          }
          yield { type: 'text-delta', payload: { text: step.text } };
        }
      })(),
    } as { fullStream: AsyncIterable<unknown> };
  };
  return { stream: (_p, o) => play(o), resumeStream: (_i, o) => play(o) };
}

let h: Harness;
beforeEach(async () => {
  h = await createHarness({ withModule: false });
});
afterEach(() => h.dispose());

const conversation = (title: string) =>
  h.platform.services.conversations.create({ ownerId: h.ownerId, title, firstMessage: { content: title } });

const startRun = (runtime: AgentRuntime, conversationId: string, prompt = 'polecenie') =>
  runtime.start({
    ownerId: h.ownerId,
    conversationId,
    prompt,
    appContext: {
      conversationId, spaceId: null, resource: null,
      selection: [], filters: {}, viewport: null, drafts: [], ui: null,
    },
  });

describe('wykonanie przezywa odejscie klienta', () => {
  it('przerwanie odczytu strumienia nie zatrzymuje pracy', async () => {
    const runtime = new AgentRuntime(
      h.platform.services,
      scriptedAgent([
        { kind: 'text', text: 'Zaczynam. ' },
        { kind: 'wait', ms: 40 },
        { kind: 'text', text: 'Koncze.' },
      ]),
    );
    const conv = conversation('Dluga praca');
    const started = await startRun(runtime, conv.id);

    /*
     * Read one event and walk away — exactly what a reload or a conversation
     * switch does to the response of `POST /api/agui/run`.
     */
    const iterator = started.stream.read(0)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    await started.done;

    const run = h.platform.services.runs.get(started.runId, h.ownerId);
    expect(run.status, 'praca zostala przerwana wraz z odczytem strumienia').toBe('succeeded');
    // And the answer is in the conversation, not only in the abandoned stream.
    const text = h.platform.services.conversations
      .messages(conv.id, h.ownerId)
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('');
    expect(text).toContain('Koncze.');
  });

  it('ponowne podlaczenie od numeru sekwencyjnego nie powtarza zdarzen', async () => {
    const runtime = new AgentRuntime(
      h.platform.services,
      scriptedAgent([{ kind: 'text', text: 'Alfa ' }, { kind: 'wait', ms: 20 }, { kind: 'text', text: 'Beta' }]),
    );
    const conv = conversation('Wznowienie');
    const started = await startRun(runtime, conv.id);
    await started.done;

    const all = h.platform.services.runs.events(started.runId, h.ownerId);
    expect(all.length).toBeGreaterThan(3);

    const cursor = all[2]!.seq;
    const after = h.platform.services.runs.eventsAfter(started.runId, h.ownerId, cursor);

    // Exactly the tail, in order, with nothing repeated and nothing skipped.
    expect(after.map((e) => e.seq)).toEqual(all.filter((e) => e.seq > cursor).map((e) => e.seq));
    expect(after.every((e) => e.seq > cursor)).toBe(true);
    expect(after).toHaveLength(all.length - 3);
  });

  it('cudze uruchomienie nie jest czytelne przez ponowne podlaczenie', async () => {
    const runtime = new AgentRuntime(h.platform.services, scriptedAgent([{ kind: 'text', text: 'x' }]));
    const conv = conversation('Moje');
    const started = await startRun(runtime, conv.id);
    await started.done;

    expect(() =>
      h.platform.services.runs.eventsAfter(started.runId, h.otherOwnerId, 0),
    ).toThrowError(/Cudze uruchomienie/);
  });
});

describe('rownolegle zadania w roznych rozmowach', () => {
  it('zadanie w A trwa, gdy uzytkownik pracuje w B, i wyniki sie nie mieszaja', async () => {
    const slow = new AgentRuntime(
      h.platform.services,
      scriptedAgent([{ kind: 'wait', ms: 60 }, { kind: 'text', text: 'WYNIK-A' }]),
    );
    const fast = new AgentRuntime(h.platform.services, scriptedAgent([{ kind: 'text', text: 'WYNIK-B' }]));

    const a = conversation('Rozmowa A');
    const b = conversation('Rozmowa B');

    const startedA = await startRun(slow, a.id, 'dlugie zadanie');
    // While A is still going, the user does something else entirely.
    const startedB = await startRun(fast, b.id, 'szybkie zadanie');
    await startedB.done;

    // B finished; A is still the backend's problem, untouched by B.
    expect(h.platform.services.runs.get(startedB.runId, h.ownerId).status).toBe('succeeded');
    const duringA = h.platform.services.runs.get(startedA.runId, h.ownerId).status;
    expect(['queued', 'running'], `A mialo status ${duringA}`).toContain(duringA);

    await startedA.done;

    const textOf = (id: string) =>
      h.platform.services.conversations
        .messages(id, h.ownerId)
        .filter((m) => m.role === 'assistant')
        .map((m) => m.content)
        .join('');

    expect(textOf(a.id)).toContain('WYNIK-A');
    expect(textOf(a.id)).not.toContain('WYNIK-B');
    expect(textOf(b.id)).toContain('WYNIK-B');
    expect(textOf(b.id)).not.toContain('WYNIK-A');
  });

  it('lista aktywnych zadan obejmuje wszystkie rozmowy wlasciciela i tylko jego', async () => {
    const slow = new AgentRuntime(
      h.platform.services,
      scriptedAgent([{ kind: 'wait', ms: 80 }, { kind: 'text', text: 'ok' }]),
    );
    const a = conversation('A');
    const b = conversation('B');
    const startedA = await startRun(slow, a.id);
    const startedB = await startRun(slow, b.id);

    const active = h.platform.services.runs.listActive(h.ownerId);
    expect(active.map((r) => r.conversationId).sort()).toEqual([a.id, b.id].sort());
    // Not visible to anyone else.
    expect(h.platform.services.runs.listActive(h.otherOwnerId)).toHaveLength(0);

    await Promise.all([startedA.done, startedB.done]);
    expect(h.platform.services.runs.listActive(h.ownerId)).toHaveLength(0);
  });
});

describe('jawne zatrzymanie', () => {
  it('konczy wskazane wykonanie i nie rusza pozostalych', async () => {
    const slow = new AgentRuntime(
      h.platform.services,
      scriptedAgent([{ kind: 'wait', ms: 200 }, { kind: 'text', text: 'nie powinno dojsc' }]),
    );
    const quick = new AgentRuntime(h.platform.services, scriptedAgent([{ kind: 'text', text: 'zostaje' }]));
    const a = conversation('Do zatrzymania');
    const b = conversation('Ma przetrwac');

    const startedA = await startRun(slow, a.id);
    const startedB = await startRun(quick, b.id);

    const result = h.platform.services.runs.cancel(startedA.runId, h.ownerId);
    expect(result.cancelled).toBe(true);

    await Promise.allSettled([startedA.done, startedB.done]);

    expect(h.platform.services.runs.get(startedA.runId, h.ownerId).status).toBe('cancelled');
    expect(h.platform.services.runs.get(startedB.runId, h.ownerId).status).toBe('succeeded');

    // The cancelled run produced no answer text; the other one did.
    const textA = h.platform.services.conversations
      .messages(a.id, h.ownerId)
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('');
    expect(textA).not.toContain('nie powinno dojsc');
  });

  it('nie mozna zatrzymac cudzego wykonania', async () => {
    const slow = new AgentRuntime(
      h.platform.services,
      scriptedAgent([{ kind: 'wait', ms: 60 }, { kind: 'text', text: 'ok' }]),
    );
    const conv = conversation('Moje');
    const started = await startRun(slow, conv.id);
    expect(() => h.platform.services.runs.cancel(started.runId, h.otherOwnerId)).toThrowError(
      /Cudze uruchomienie/,
    );
    await started.done;
  });
});

describe('punkty HTTP zadan w tle', () => {
  it('/api/runs/active zwraca tytul rozmowy, zeby zadanie dalo sie nazwac', async () => {
    const slow = new AgentRuntime(
      h.platform.services,
      scriptedAgent([{ kind: 'wait', ms: 80 }, { kind: 'text', text: 'ok' }]),
    );
    const conv = conversation('Analiza cennika');
    const started = await startRun(slow, conv.id);

    const cookie = await login(h.platform.app, h.ownerId);
    const res = await h.platform.app.request('/api/runs/active', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<Record<string, unknown>> };
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      conversationId: conv.id,
      conversationTitle: 'Analiza cennika',
    });

    await started.done;
  });

  it('/api/runs/:id/stream odtwarza zakonczone uruchomienie od kursora', async () => {
    const runtime = new AgentRuntime(
      h.platform.services,
      scriptedAgent([{ kind: 'text', text: 'Alfa ' }, { kind: 'text', text: 'Beta' }]),
    );
    const conv = conversation('Odtworzenie');
    const started = await startRun(runtime, conv.id);
    await started.done;

    const cookie = await login(h.platform.app, h.ownerId);
    const all = h.platform.services.runs.events(started.runId, h.ownerId);
    const cursor = all[1]!.seq;

    const res = await h.platform.app.request(`/api/runs/${started.runId}/stream?from=${cursor}`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const frames = text
      .split('\n\n')
      .filter((f) => f.includes('data:'))
      .map((f) => JSON.parse(f.split('data: ')[1]!.split('\n')[0]!) as { type: string });

    expect(frames.length).toBe(all.length - cursor);
    expect(frames.at(-1)!.type).toBe('RUN_FINISHED');
    // The cursor is exclusive: nothing already delivered comes back.
    expect(frames.map((f) => f.type)).not.toContain('RUN_STARTED');
  });

  it('/api/runs/:id/stream odmawia dostepu do cudzego uruchomienia', async () => {
    const runtime = new AgentRuntime(h.platform.services, scriptedAgent([{ kind: 'text', text: 'x' }]));
    const conv = conversation('Moje');
    const started = await startRun(runtime, conv.id);
    await started.done;

    const cookie = await login(h.platform.app, h.otherOwnerId);
    const res = await h.platform.app.request(`/api/runs/${started.runId}/stream`, { headers: { cookie } });
    expect(res.status).toBe(403);
  });
});
