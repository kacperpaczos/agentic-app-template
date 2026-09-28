import { describe, expect, it } from 'vitest';
import { processStreamedMessage } from '@openuidev/react-headless';
import { ConversationProjection, projectEvents, type AguiEvent } from '@platform/server';

/**
 * Conformance tests for the run projection.
 *
 * The chat reduces the live AG-UI stream with `processStreamedMessage` from
 * `@openuidev/react-headless`; the backend reduces the *same* event sequence
 * into the rows a reload will read. Two reducers over one sequence is a standing
 * invitation to drift — so these tests run the real library reducer over the
 * real event bytes and require the persisted projection to agree with it.
 *
 * This is why the library is a dev dependency of the root workspace: the test
 * executes it rather than restating what it is believed to do.
 */

/** Builds the SSE body the browser would receive for a sequence of events. */
function sseResponse(events: AguiEvent[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(new TextEncoder().encode(body));
}

interface LibMessage {
  id: string;
  role: string;
  content?: string;
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  toolCallId?: string;
}

/** Runs the library reducer and returns the messages it produced, in order. */
async function reduceWithLibrary(events: AguiEvent[]): Promise<LibMessage[]> {
  const out: LibMessage[] = [];
  const index = new Map<string, number>();
  const put = (m: LibMessage) => {
    const at = index.get(m.id);
    if (at === undefined) {
      index.set(m.id, out.length);
      out.push({ ...m });
    } else {
      out[at] = { ...m };
    }
  };
  // The reducer batches content updates through requestAnimationFrame; in Node
  // there is none, so run the callback immediately and keep ordering exact.
  const g = globalThis as Record<string, unknown>;
  const hadRaf = 'requestAnimationFrame' in g;
  if (!hadRaf) {
    g.requestAnimationFrame = (cb: () => void) => {
      cb();
      return 0;
    };
    g.cancelAnimationFrame = () => {};
  }
  try {
    await processStreamedMessage({
      response: sseResponse(events),
      createMessage: put as never,
      updateMessage: put as never,
    } as never);
  } finally {
    if (!hadRaf) {
      delete g.requestAnimationFrame;
      delete g.cancelAnimationFrame;
    }
  }
  return out;
}

/** Comparable shape: identity of ids differs (ours are derived, theirs random). */
const shapeOf = (messages: Array<Record<string, any>>) =>
  messages.map((m) =>
    m.role === 'tool'
      ? { role: 'tool', toolCallId: m.toolCallId, content: m.content }
      : {
          role: m.role,
          content: m.content ?? '',
          toolCalls: (m.toolCalls ?? []).map((t: any) => ({
            name: t.function.name,
            arguments: t.function.arguments,
          })),
        },
  );

const textStart = (id: string): AguiEvent => ({ type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' });
const textDelta = (id: string, delta: string): AguiEvent => ({ type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta });
const textEnd = (id: string): AguiEvent => ({ type: 'TEXT_MESSAGE_END', messageId: id });
const toolStart = (id: string, name: string, parent: string): AguiEvent => ({
  type: 'TOOL_CALL_START', toolCallId: id, toolCallName: name, parentMessageId: parent,
});
const toolArgs = (id: string, args: string): AguiEvent => ({ type: 'TOOL_CALL_ARGS', toolCallId: id, delta: args });
const toolEnd = (id: string): AguiEvent => ({ type: 'TOOL_CALL_END', toolCallId: id });
const toolResult = (id: string, content: string, isError = false): AguiEvent => ({
  type: 'TOOL_CALL_RESULT', messageId: `tr_${id}`, toolCallId: id, content, role: 'tool',
  ...(isError ? { isError: true, error: content } : {}),
});

/* -------------------------------------------------------------------------- */

describe('projekcja przebiegu zgadza sie z reduktorem biblioteki', () => {
  const M = 'am_run_1';

  const scenarios: Array<{ name: string; events: AguiEvent[] }> = [
    {
      name: 'narzedzie przed tekstem (najczestszy przypadek)',
      events: [
        toolStart('t1', 'mcp__app__canvas_add_card', M),
        toolArgs('t1', '{"title":"Wykres"}'),
        toolEnd('t1'),
        toolResult('t1', '{"cardId":"c1"}'),
        textStart(M),
        textDelta(M, 'Dodalem '),
        textDelta(M, 'karte.'),
        textEnd(M),
      ],
    },
    {
      name: 'tekst przed narzedziem',
      events: [
        textStart(M),
        textDelta(M, 'Sprawdzam. '),
        toolStart('t1', 'mcp__app__get_context', M),
        toolArgs('t1', '{}'),
        toolEnd('t1'),
        toolResult('t1', 'ok'),
        textDelta(M, 'Gotowe.'),
        textEnd(M),
      ],
    },
    {
      name: 'samo narzedzie, bez tekstu',
      events: [
        toolStart('t1', 'mcp__app__data_read', M),
        toolArgs('t1', '{"q":1}'),
        toolEnd('t1'),
        toolResult('t1', '[]'),
      ],
    },
    {
      name: 'blad narzedzia',
      events: [
        toolStart('t1', 'mcp__app__canvas_add_card', M),
        toolArgs('t1', '{"bad":true}'),
        toolEnd('t1'),
        toolResult('t1', 'Nieznany komponent.', true),
      ],
    },
    {
      name: 'wiele narzedzi w jednej turze',
      events: [
        toolStart('t1', 'a', M), toolArgs('t1', '{}'), toolEnd('t1'), toolResult('t1', '1'),
        toolStart('t2', 'b', M), toolArgs('t2', '{}'), toolEnd('t2'), toolResult('t2', '2'),
        textStart(M), textDelta(M, 'Dwa kroki.'), textEnd(M),
      ],
    },
    {
      name: 'argumenty przychodza we fragmentach',
      events: [
        toolStart('t1', 'a', M),
        toolArgs('t1', '{"ti'), toolArgs('t1', 'tle":"x'), toolArgs('t1', '"}'),
        toolEnd('t1'),
        toolResult('t1', 'ok'),
      ],
    },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.name}`, async () => {
      const mine = projectEvents('run_1', scenario.events);
      const theirs = await reduceWithLibrary(scenario.events);

      /*
       * Guard against a vacuous comparison. Two empty lists are equal, and an
       * equality assertion that can pass on nothing proves nothing — so require
       * the library reduction to actually contain the tool activity the
       * scenario describes before comparing against it.
       */
      const expectedCalls = scenario.events.filter((e) => e.type === 'TOOL_CALL_START').length;
      const expectedResults = scenario.events.filter((e) => e.type === 'TOOL_CALL_RESULT').length;
      expect(theirs.length, 'reduktor biblioteki nie wyprodukowal zadnej wiadomosci').toBeGreaterThan(0);
      expect(
        theirs.flatMap((m) => m.toolCalls ?? []).length,
        'reduktor biblioteki nie zbudowal wywolan narzedzi',
      ).toBe(expectedCalls);
      expect(theirs.filter((m) => m.role === 'tool').length).toBe(expectedResults);

      expect(shapeOf(mine)).toEqual(shapeOf(theirs));
    });
  }

  it('argumenty narzedzia sa zlozone w calosc, nie zgubione we fragmentach', () => {
    const [assistant] = projectEvents('run_1', [
      toolStart('t1', 'a', M),
      toolArgs('t1', '{"ti'), toolArgs('t1', 'tle":"x"}'),
      toolEnd('t1'),
    ]);
    expect(assistant).toMatchObject({
      role: 'assistant',
      toolCalls: [{ function: { name: 'a', arguments: '{"title":"x"}' } }],
    });
  });

  it('identyfikator wiadomosci narzedzia jest zwiazany z uruchomieniem, nie tylko z wywolaniem', () => {
    // `messages.id` is a primary key table-wide; two runs reusing one tool call
    // id must not collide.
    const a = projectEvents('run_a', [toolStart('t1', 'x', M), toolEnd('t1'), toolResult('t1', 'ok')]);
    const b = projectEvents('run_b', [toolStart('t1', 'x', M), toolEnd('t1'), toolResult('t1', 'ok')]);
    const idOf = (ms: any[]) => ms.find((m) => m.role === 'tool')!.id;
    expect(idOf(a)).not.toBe(idOf(b));
    expect(idOf(a)).toContain('run_a');
  });

  it('wynik narzedzia trafia do wiadomosci powiazanej identyfikatorem wywolania', () => {
    const messages = projectEvents('run_1', [
      toolStart('t1', 'a', M), toolArgs('t1', '{}'), toolEnd('t1'), toolResult('t1', 'WYNIK'),
    ]);
    const tool = messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ role: 'tool', toolCallId: 't1', content: 'WYNIK' });
    const assistant = messages.find((m) => m.role === 'assistant');
    expect((assistant as any).toolCalls[0].id).toBe('t1');
  });

  it('blad narzedzia jest oznaczony, a nie udawany sukcesem', () => {
    const messages = projectEvents('run_1', [
      toolStart('t1', 'a', M), toolEnd('t1'), toolResult('t1', 'Odmowa dostepu.', true),
    ]);
    expect(messages.find((m) => m.role === 'tool')).toMatchObject({
      isError: true,
      error: 'Odmowa dostepu.',
    });
  });

  it('identyfikatory sa wyprowadzone, wiec powtorzenie zdarzen nie duplikuje tury', () => {
    const events = [
      toolStart('t1', 'a', M), toolArgs('t1', '{}'), toolEnd('t1'), toolResult('t1', 'ok'),
      textStart(M), textDelta(M, 'Gotowe.'), textEnd(M),
    ];
    const first = projectEvents('run_1', events);
    const second = projectEvents('run_1', events);
    expect(second.map((m) => m.id)).toEqual(first.map((m) => m.id));
    expect(new Set(first.map((m) => m.id)).size).toBe(first.length);
  });

  it('projekcja przyrostowa daje ten sam wynik co jednorazowa', () => {
    const events = [
      toolStart('t1', 'a', M), toolArgs('t1', '{"x":1}'), toolEnd('t1'), toolResult('t1', 'ok'),
      textStart(M), textDelta(M, 'Cze'), textDelta(M, 'sc.'), textEnd(M),
    ];
    const writes: Array<{ id: string; role: string; content: string }> = [];
    const live = new ConversationProjection('run_1', (m) => {
      const at = writes.findIndex((w) => w.id === m.id);
      const row = { id: m.id, role: m.role, content: m.content };
      if (at === -1) writes.push(row);
      else writes[at] = row;
    });
    for (const e of events) live.apply(e);
    live.finish();

    const oneShot = projectEvents('run_1', events);
    expect(writes.map((w) => w.id)).toEqual(oneShot.map((m) => m.id));
    expect(writes.map((w) => w.content)).toEqual(oneShot.map((m) => m.content));
  });
});
