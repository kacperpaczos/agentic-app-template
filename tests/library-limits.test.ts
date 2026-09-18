import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { processStreamedMessage } from '@openuidev/react-headless';
import { AGUI_EVENTS, PLATFORM_CUSTOM_EVENTS } from '@platform/contracts';
import type { AguiEvent } from '@platform/server';

/**
 * L5.15 — what the ready-made chat does **not** do, pinned to the versions
 * installed, by executing them.
 *
 * Until now these limitations lived in prose: a comment in `platformAdapter.ts`
 * saying the parser drops `CUSTOM`, a paragraph in an archived report, a note
 * in `FEEDBACK.md`. Prose cannot fail. An upgrade that changed any of it would
 * have gone unnoticed, and in one direction that is not merely untidy — if a
 * future parser started reducing the events this application also taps, or if
 * the thread started rendering prose while a turn is live, the same text would
 * be on screen twice. The measured double answer (107 characters shown as 214)
 * is what that looks like.
 *
 * **Which colour of red means what.** These assertions are two-directional and
 * the two directions call for opposite responses:
 *
 *  - **a limitation got worse** (the parser stops handling something it handles
 *    today, the version moved without anyone saying so): a regression. Restore
 *    the behaviour or pin the previous version.
 *  - **a limitation was fixed** (the parser starts handling `CUSTOM`, the
 *    thread starts rendering live prose): *also* red here, and it is good news
 *    — but it means the adapter beside it is now a second consumer of the same
 *    events. Remove the workaround it justifies **first**, then relax the
 *    assertion with a note naming the version that fixed it. Relaxing the
 *    assertion alone converts a fixed library into a doubled answer.
 *
 * The browser half — where the withheld prose actually ends up on screen, and
 * whether the run preview beside it doubles it — is `e2e/run-events.spec.ts`
 * ("proza w turze z narzedziem…"), because that question cannot be answered
 * without rendering.
 */

const here = createRequire(import.meta.url);

/**
 * The installed version of a package, read from the manifest beside the file it
 * resolves to.
 *
 * Not `require('<pkg>/package.json')`: neither of these packages lists that
 * subpath in its `exports`, so the obvious form throws. Walking up from the
 * resolved entry is the same approach `readVersions()` in `@platform/server`
 * takes, for the same reason.
 */
const versionOf = (pkg: string): string => {
  let dir = dirname(here.resolve(pkg));
  for (let i = 0; i < 8; i += 1) {
    const manifest = resolve(dir, 'package.json');
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
      if (json.name === pkg && json.version) return json.version;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`nie znaleziono wersji pakietu ${pkg}`);
};

/** The SSE body the browser would receive, built from real platform events. */
const sseResponse = (events: AguiEvent[]): Response =>
  new Response(new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')));

interface LibMessage {
  id: string;
  role?: string;
  content?: string;
  toolCalls?: unknown[];
}

/** Everything the library's reducer made of a sequence of events. */
async function reduce(events: AguiEvent[]): Promise<LibMessage[]> {
  const out: LibMessage[] = [];
  const index = new Map<string, number>();
  const put = (m: LibMessage) => {
    const at = index.get(m.id);
    if (at === undefined) {
      index.set(m.id, out.length);
      out.push({ ...m });
    } else out[at] = { ...m };
  };
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

/**
 * The reducer's output without the identifiers it mints itself.
 *
 * Its message ids are random UUIDs, so two reductions of the same events are
 * never `toEqual` — and comparing two reductions is exactly how "these events
 * change nothing" is stated here.
 */
const shapeOf = (messages: LibMessage[]) =>
  messages.map(({ id: _id, ...rest }) => ({ ...rest, toolCalls: (rest.toolCalls ?? []).length }));

const M = 'am_run_1';
const textTurn: AguiEvent[] = [
  { type: AGUI_EVENTS.TEXT_MESSAGE_START, messageId: M, role: 'assistant' },
  { type: AGUI_EVENTS.TEXT_MESSAGE_CONTENT, messageId: M, delta: 'Odpowiedz.' },
  { type: AGUI_EVENTS.TEXT_MESSAGE_END, messageId: M },
];

describe('L5.15 — ograniczenia gotowego czatu, przypiete do zainstalowanych wersji', () => {
  it('wersje sa te, dla ktorych te ograniczenia zostaly zmierzone', () => {
    /*
     * The version is part of the claim, not context for it. "The parser ignores
     * CUSTOM" is a statement about 0.9.13; an upgrade makes it a statement about
     * nothing until somebody re-measures.
     */
    expect(
      versionOf('@openuidev/react-headless'),
      'parser czatu ma inna wersje niz ta, dla ktorej zmierzono ponizsze ograniczenia — zmierz je ' +
        'ponownie, zanim zmienisz ten literal',
    ).toBe('0.9.13');
    expect(
      versionOf('@openuidev/react-ui'),
      'watek czatu ma inna wersje niz ta, dla ktorej zmierzono wstrzymanie prozy i podwojne jej ' +
        'pokazanie w turze z narzedziem (e2e/run-events.spec.ts)',
    ).toBe('0.13.10');
  });

  it('parser biblioteki pomija CUSTOM — dlatego platformAdapter podsluchuje ten sam strumien', async () => {
    const custom: AguiEvent[] = [
      { type: AGUI_EVENTS.CUSTOM, name: PLATFORM_CUSTOM_EVENTS.canvasChanged, value: { version: 1, spaceId: 'sp_1' } },
      { type: AGUI_EVENTS.CUSTOM, name: PLATFORM_CUSTOM_EVENTS.artifactCreated, value: { version: 1, artifactId: 'art_1' } },
      {
        type: AGUI_EVENTS.CUSTOM,
        name: PLATFORM_CUSTOM_EVENTS.permissionRequest,
        value: { version: 1, requestId: 'req_1', runId: 'run_1', toolName: 'Bash', input: '{}' },
      },
    ];

    // Nothing at all comes out of a stream made only of CUSTOM events…
    expect(await reduce(custom)).toEqual([]);
    // …and mixing them into a normal turn changes nothing about that turn: the
    // reducer's output is identical with and without them.
    expect(shapeOf(await reduce([...custom, ...textTurn]))).toEqual(shapeOf(await reduce(textTurn)));
  });

  it('parser biblioteki pomija RUN_STARTED i RUN_FINISHED — faza wykonania nie moze pochodzic z niego', async () => {
    const lifecycle: AguiEvent[] = [
      { type: AGUI_EVENTS.RUN_STARTED, threadId: 'conv_1', runId: 'run_1' },
      { type: AGUI_EVENTS.RUN_FINISHED, threadId: 'conv_1', runId: 'run_1', durationMs: 5 },
    ];
    expect(await reduce(lifecycle)).toEqual([]);
    expect(shapeOf(await reduce([lifecycle[0]!, ...textTurn, lifecycle[1]!]))).toEqual(
      shapeOf(await reduce(textTurn)),
    );
  });

  it('parser biblioteki rozumie tekst i narzedzia — wiec nic z tego nie jest w adapterze powielane', async () => {
    /*
     * The other direction of the same pin, and the one that keeps this file
     * honest. If the parser handled *nothing*, tapping the stream would be
     * harmless; the reason `platformAdapter` may only tap — never reduce — is
     * that text and tool activity are already the library's job. A change that
     * made this list shorter would mean the chat has stopped rendering
     * something, and a change that made `applyRunEvent` append text the library
     * also appends is the doubled answer.
     */
    const withTool: AguiEvent[] = [
      { type: AGUI_EVENTS.TOOL_CALL_START, toolCallId: 't1', toolCallName: 'mcp__app__x', parentMessageId: M },
      { type: AGUI_EVENTS.TOOL_CALL_ARGS, toolCallId: 't1', delta: '{"a":1}' },
      { type: AGUI_EVENTS.TOOL_CALL_END, toolCallId: 't1' },
      { type: AGUI_EVENTS.TOOL_CALL_RESULT, messageId: 'tr_t1', toolCallId: 't1', content: 'ok', role: 'tool' },
      ...textTurn,
    ];
    const messages = await reduce(withTool);
    expect(messages.some((m) => m.role === 'assistant' && m.content === 'Odpowiedz.')).toBe(true);
    expect(messages.some((m) => m.role === 'tool' && m.content === 'ok')).toBe(true);
    expect(messages.some((m) => (m.toolCalls ?? []).length > 0)).toBe(true);
  });
});
