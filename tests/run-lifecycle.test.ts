import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRuntime, type ModelAgentLike } from '@platform/server';
import { createHarness, type Harness, testGlmEnv } from './helpers.ts';

/**
 * Run lifecycle, measurement points and persisted tool activity.
 *
 * **These are simulations**, and marked as such: the model is replaced at the
 * adapter boundary by a scripted stand-in that receives the very same
 * `sdkOptions` — hooks included — that the Claude Agent SDK would. Nothing else
 * in the runtime is stubbed, so the queue, the event stream, the projection and
 * the run record are the real ones.
 *
 * The reason to simulate rather than prompt: the orderings that matter here
 * (a tool before the first word, a word before the first tool, an answer with no
 * text at all) are chosen by the model, not by the caller. The defect that lost
 * `first_token_ms` only appeared in one of them, which is exactly why it
 * survived a passing browser test for a day.
 */

type Step =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: unknown; result?: string; error?: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'throw'; message: string };

/**
 * A stand-in agent that replays a script against the runtime's own hooks.
 *
 * Kolejność jest wierna prawdziwemu SDK: kroki są odtwarzane w chwili, w którą
 * runtime je konsumuje, a hooki (`PreToolUse` i pozostale) odpalają sie wtedy,
 * gdy skrypt do nich dochodzi — czyli REALNIE MIEDZY deltami tekstu. Wczesna
 * wersja tej symulacji budowala cala liste chunkow i odpalala wszystkie hooki
 * PRZED zwroceniem strumienia, wiec deklarowany przeplot (tekst, narzedzie,
 * tekst) nie istnial dla runtime'u: zdarzenia narzedzia trafialy do dziennika
 * przed pierwsza delta, odwrotnie niz mialo w opisie skryptu.
 */
function playScript(script: Step[], options: any, sessionId: string) {
  const hooks = options?.sdkOptions?.hooks ?? {};
  const fire = async (event: string, payload: Record<string, unknown>) => {
    for (const group of hooks[event] ?? []) {
      for (const hook of group.hooks ?? []) await hook({ hook_event_name: event, ...payload });
    }
  };

  return {
    async *[Symbol.asyncIterator]() {
      /* not used */
    },
    fullStream: (async function* () {
      await fire('SessionStart', { session_id: sessionId });
      let toolSeq = 0;
      for (const step of script) {
        if (step.kind === 'wait') {
          await new Promise((r) => setTimeout(r, step.ms));
        } else if (step.kind === 'text') {
          yield { type: 'text-delta', payload: { text: step.text } };
        } else if (step.kind === 'throw') {
          yield { type: 'error', payload: { error: new Error(step.message) } };
        } else {
          toolSeq += 1;
          const id = `tu_${toolSeq}`;
          await fire('PreToolUse', { tool_use_id: id, tool_name: step.name, tool_input: step.input });
          if (step.error !== undefined) {
            await fire('PostToolUseFailure', { tool_use_id: id, error: step.error });
          } else {
            await fire('PostToolUse', { tool_use_id: id, tool_response: step.result ?? 'ok' });
          }
        }
      }
      await fire('Stop', { session_id: sessionId });
    })(),
  } as { fullStream: AsyncIterable<unknown> };
}

/** Stand-in o jednym skrypcie, niezależnym od treści polecenia. */
function scriptedAgent(script: Step[], sessionId = 'sess_test'): ModelAgentLike {
  const play = async (options: any) => playScript(script, options, sessionId);
  return {
    stream: (_prompt, options) => play(options),
    resumeStream: (_input, options) => play(options),
  };
}

/**
 * Stand-in dobierający skrypt po treści polecenia.
 *
 * Kolejkowanie per rozmowa siedzi w jednej instancji `AgentRuntime`, więc dwa
 * uruchomienia tej samej rozmowy muszą przejść przez JEDEN runtime — a mają
 * mieć różne tempo, żeby czas oczekiwania w kolejce dało się odróżnić od czasu
 * własnego wykonania.
 */
function scriptedAgentByPrompt(scripts: Record<string, Step[]>, sessionId = 'sess_test'): ModelAgentLike {
  return {
    stream: (prompt, options) =>
      Promise.resolve(playScript(scripts[prompt] ?? [], options, sessionId)),
    resumeStream: (input, options) =>
      Promise.resolve(playScript(scripts[input.message] ?? [], options, sessionId)),
  };
}

let h: Harness;

const runWith = async (script: Step[]) => {
  const runtime = new AgentRuntime(h.platform.services, scriptedAgent(script));
  const conv = h.platform.services.conversations.create({
    ownerId: h.ownerId,
    firstMessage: { content: 'polecenie testowe' },
  });
  const started = await runtime.start({
    ownerId: h.ownerId,
    conversationId: conv.id,
    prompt: 'polecenie testowe',
    appContext: {
      conversationId: conv.id, spaceId: null, resource: null,
      selection: [], filters: {}, viewport: null, drafts: [], ui: null,
    },
  });
  const events: Array<Record<string, any>> = [];
  const reader = (async () => {
    for await (const e of started.stream.read(0)) events.push(e.event as Record<string, any>);
  })();
  await started.done;
  await reader;
  return {
    conv,
    runId: started.runId,
    streamRef: started.stream,
    events,
    run: () => h.platform.services.runs.get(started.runId, h.ownerId),
    messages: () => h.platform.services.conversations.messages(conv.id, h.ownerId),
  };
};

beforeEach(async () => {
  h = await createHarness({ withModule: false });
});
afterEach(() => h.dispose());

describe('pomiar pierwszego tekstu nie zalezy od kolejnosci narzedzi (symulacja)', () => {
  it('narzedzie przed tekstem — czas pierwszego tekstu jest zapisany', async () => {
    const r = await runWith([
      { kind: 'tool', name: 'canvas_add_card', input: { title: 'x' }, result: '{"cardId":"c1"}' },
      { kind: 'wait', ms: 20 },
      { kind: 'text', text: 'Gotowe.' },
    ]);
    expect(r.run().status).toBe('succeeded');
    // This is the case that used to record nothing.
    expect(r.run().firstTokenMs, 'zgubiony czas pierwszego tekstu').toBeGreaterThan(0);
  });

  it('tekst przed narzedziem — czas pierwszego tekstu jest zapisany', async () => {
    const r = await runWith([
      { kind: 'wait', ms: 20 },
      { kind: 'text', text: 'Sprawdzam. ' },
      { kind: 'tool', name: 'get_context', input: {}, result: 'ok' },
      { kind: 'text', text: 'Gotowe.' },
    ]);
    expect(r.run().firstTokenMs).toBeGreaterThan(0);
    /*
     * Przeplot jest teraz rzeczywisty, więc kolejność w dzienniku zdarzeń mówi
     * to samo co skrypt: pierwsza treść preceduje narzędzie (hook odpala się
     * dopiero, gdy skrypt do niego dochodzi — między deltami), a tekst wraca
     * po narzędziu. Wcześniej wszystkie hooki odpalały się przed konsumpcją
     * strumienia i zdarzenia narzędzia wyprzedzały deklarowany pierwszy tekst.
     */
    const types = r.events.map((e) => String(e.type));
    expect(types.indexOf('TEXT_MESSAGE_START')).toBeGreaterThan(-1);
    expect(
      types.indexOf('TOOL_CALL_START'),
      'narzedzie ma dotrzec do dziennika PO pierwszej delcie tekstu',
    ).toBeGreaterThan(types.indexOf('TEXT_MESSAGE_CONTENT'));
    const contentAfterTool = types.indexOf(
      'TEXT_MESSAGE_CONTENT',
      types.indexOf('TOOL_CALL_START') + 1,
    );
    expect(contentAfterTool, 'tekst ma wrocic po narzedziu').toBeGreaterThan(-1);
  });

  it('odpowiedz bez tekstu — brak czasu pierwszego tekstu jest poprawny, nie podstawiony', async () => {
    const r = await runWith([
      { kind: 'tool', name: 'canvas_add_card', input: {}, result: 'ok' },
    ]);
    expect(r.run().status).toBe('succeeded');
    // Null is the honest answer here; a fabricated number would make the metric
    // meaningless precisely where it is most tempting to fake it.
    expect(r.run().firstTokenMs).toBeNull();
  });

  it('czas pierwszego tekstu liczy sie od startu wykonania, nie od zakolejkowania', async () => {
    const r = await runWith([{ kind: 'wait', ms: 30 }, { kind: 'text', text: 'ok' }]);
    const run = r.run();
    expect(run.queuedMs).toBeGreaterThanOrEqual(0);
    expect(run.firstTokenMs!).toBeLessThanOrEqual(run.durationMs!);
    expect(Date.parse(run.startedAt)).toBeGreaterThanOrEqual(Date.parse(run.enqueuedAt));

    /*
     * Scenariusz, w którym kolejność naprawdę działa: dwa uruchomienia TEJ SAMEJ
     * rozmowy przez jeden runtime. Pierwsze trzyma kolejkę rozmowy (Runtime
     * serializuje je, bo dzielą sesję Claude), więc drugie ma realny, mierzalny
     * czas oczekiwania — i dopiero tu porównanie obu wielkości coś dowodzi.
     */
    const runtime = new AgentRuntime(
      h.platform.services,
      scriptedAgentByPrompt({
        pierwsze: [{ kind: 'wait', ms: 400 }, { kind: 'text', text: 'pierwsze' }],
        drugie: [{ kind: 'wait', ms: 15 }, { kind: 'text', text: 'drugie' }],
      }),
    );
    const conv = h.platform.services.conversations.create({
      ownerId: h.ownerId,
      firstMessage: { content: 'kolejka' },
    });
    const appContext = {
      conversationId: conv.id, spaceId: null, resource: null,
      selection: [], filters: {}, viewport: null, drafts: [], ui: null,
    };
    const first = await runtime.start({
      ownerId: h.ownerId, conversationId: conv.id, prompt: 'pierwsze', appContext,
    });
    const second = await runtime.start({
      ownerId: h.ownerId, conversationId: conv.id, prompt: 'drugie', appContext,
    });

    // Drugie jest przyjęte, ale wykonanie jeszcze nie ruszyło.
    expect(h.platform.services.runs.get(second.runId, h.ownerId).status).toBe('queued');

    await Promise.all([first.done, second.done]);

    const b = h.platform.services.runs.get(second.runId, h.ownerId);
    // Oczekiwanie było realne, nie ułamkiem milisekundy.
    expect(b.queuedMs, 'drugie uruchomienie mialo czekac w kolejce').toBeGreaterThan(100);
    expect(Date.parse(b.startedAt)).toBeGreaterThan(Date.parse(b.enqueuedAt));
    /*
     * Pierwszy token liczony od WŁASNEGO startu wykonania: skrypt „drugie"
     * mówi dopiero po ~15 ms, więc firstTokenMs musi być o rząd wielkości
     * mniejszy od czasu spędzonego w kolejce. Gdyby metryka liczona była od
     * zakolejkowania, wynik byłby >= queuedMs.
     */
    expect(b.firstTokenMs, 'pierwszy token ma byc zarejestrowany').toBeGreaterThan(0);
    expect(b.firstTokenMs!, 'firstTokenMs liczony od zakolejkowania, nie od startu wykonania').toBeLessThan(
      b.queuedMs!,
    );
    // Pierwsze uruchomienie nie dźwiga czasu drugiego.
    const a = h.platform.services.runs.get(first.runId, h.ownerId);
    expect(a.status).toBe('succeeded');
    expect(a.firstTokenMs!).toBeLessThanOrEqual(a.durationMs!);
  }, 20_000);
});

describe('aktywnosc narzedzi trafia do historii rozmowy', () => {
  it('wywolanie, argumenty i wynik sa zapisane w wiadomosciach', async () => {
    const r = await runWith([
      { kind: 'tool', name: 'canvas_add_card', input: { title: 'Wykres' }, result: '{"cardId":"c1"}' },
      { kind: 'text', text: 'Dodalem karte.' },
    ]);

    const msgs = r.messages();
    const assistant = msgs.find((m) => m.role === 'assistant' && (m.meta as any)?.toolCalls?.length);
    expect(assistant, 'brak wiadomosci asystenta z wywolaniem narzedzia').toBeTruthy();
    const call = (assistant!.meta as any).toolCalls[0];
    expect(call.function.name).toBe('canvas_add_card');
    expect(JSON.parse(call.function.arguments)).toEqual({ title: 'Wykres' });

    const tool = msgs.find((m) => m.role === 'tool');
    expect(tool).toBeTruthy();
    expect((tool!.meta as any).toolCallId).toBe(call.id);
    expect(tool!.content).toContain('cardId');

    // The answer is one message, not a duplicate of the whole turn.
    const texts = msgs.filter((m) => m.role === 'assistant' && m.content.includes('Dodalem karte.'));
    expect(texts).toHaveLength(1);
  });

  it('blad narzedzia jest zapisany jako blad, nie jako wynik', async () => {
    const r = await runWith([
      { kind: 'tool', name: 'canvas_add_card', input: {}, error: 'Nieznany komponent.' },
      { kind: 'text', text: 'Nie udalo sie.' },
    ]);
    const tool = r.messages().find((m) => m.role === 'tool');
    expect((tool!.meta as any).isError).toBe(true);
    expect(tool!.content).toContain('Nieznany komponent');
  });

  it('historia przezywa restart backendu', async () => {
    const r = await runWith([
      { kind: 'tool', name: 'canvas_add_card', input: { title: 'Wykres' }, result: 'ok' },
      { kind: 'text', text: 'Zrobione.' },
    ]);
    const before = r.messages();

    const { createPlatform, DEFAULT_USER_ID } = await import('@platform/server');
    h.platform.close();
    const reopened = createPlatform({ modules: [], env: testGlmEnv(h.dataDir) });
    try {
      const after = reopened.services.conversations.messages(r.conv.id, DEFAULT_USER_ID);
      expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
      expect(after.find((m) => m.role === 'tool')).toBeTruthy();
      expect((after.find((m) => m.role === 'assistant' && (m.meta as any)?.toolCalls?.length)!.meta as any)
        .toolCalls[0].function.name).toBe('canvas_add_card');
    } finally {
      reopened.close();
    }
  });

  it('odtworzenie historii nie uruchamia narzedzi ponownie ani nie dubluje wiadomosci', async () => {
    const r = await runWith([
      { kind: 'tool', name: 'canvas_add_card', input: {}, result: 'ok' },
      { kind: 'text', text: 'Raz.' },
    ]);
    const first = r.messages();

    // Reading the thread is a read: no run is started, nothing is appended.
    const reread = h.platform.services.conversations.messages(r.conv.id, h.ownerId);
    expect(reread).toEqual(first);
    expect(h.platform.services.runs.listForConversation(r.conv.id, h.ownerId)).toHaveLength(1);
  });
});

describe('odczyt strumienia zdarzen', () => {
  /**
   * Regression for a deadlock found while writing these tests: a reader that
   * attached after the stream had closed, or fell behind a burst of events,
   * waited for a wake-up that could no longer come. A client reconnecting and
   * replaying from a sequence number is precisely that reader.
   */
  it('czytelnik podlaczony po zamknieciu strumienia dostaje wszystko i konczy', async () => {
    const r = await runWith([
      { kind: 'tool', name: 'canvas_add_card', input: {}, result: 'ok' },
    ]);
    // The stream is closed by now; a late reader must still drain it.
    const late: string[] = [];
    await Promise.race([
      (async () => {
        const runtimeStream = r.streamRef;
        for await (const e of runtimeStream.read(0)) late.push((e.event as any).type);
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('czytelnik zawisl')), 2000)),
    ]);
    expect(late).toContain('RUN_STARTED');
    expect(late.at(-1)).toBe('RUN_FINISHED');
  });

  it('odtworzenie od numeru sekwencji zwraca tylko nowsze zdarzenia', async () => {
    const r = await runWith([{ kind: 'text', text: 'ok' }]);
    const all: number[] = [];
    for await (const e of r.streamRef.read(0)) all.push(e.seq);
    const tail: number[] = [];
    for await (const e of r.streamRef.read(all[1]!)) tail.push(e.seq);
    expect(tail).toEqual(all.slice(2));
  });
});

describe('stany koncowe', () => {
  it('blad modelu konczy sie dokladnie jednym stanem koncowym i zapisuje przyczyne', async () => {
    const r = await runWith([
      { kind: 'text', text: 'Zaczynam. ' },
      { kind: 'throw', message: 'Claude usage limit reached' },
    ]);
    const run = r.run();
    expect(run.status).toBe('failed');
    expect(run.errorCode).toBe('rate_limited');

    const terminal = r.events.filter((e) => e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR');
    expect(terminal, 'wiecej niz jedno zdarzenie koncowe').toHaveLength(1);
    // Text produced before the failure is not thrown away.
    expect(r.messages().some((m) => m.content.includes('Zaczynam.'))).toBe(true);
  });

  it('sukces konczy sie dokladnie jednym stanem koncowym', async () => {
    const r = await runWith([{ kind: 'text', text: 'ok' }]);
    const terminal = r.events.filter((e) => e.type === 'RUN_FINISHED' || e.type === 'RUN_ERROR');
    expect(terminal).toHaveLength(1);
    expect(r.run().status).toBe('succeeded');
  });

  it('sesja Claude zostaje powiazana nawet gdy uruchomienie nie uzywa narzedzi', async () => {
    const r = await runWith([{ kind: 'text', text: 'ok' }]);
    expect(r.run().claudeSessionId).toBe('sess_test');
  });
});
