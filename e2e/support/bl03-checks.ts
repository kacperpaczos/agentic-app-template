import { readdirSync, readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { parseToolContent } from './show-value-probe.ts';

/**
 * What the BL-03 runs assert, written once so the rehearsal and the paid run
 * execute the **same code**.
 *
 * A model turn cannot be taken back, so a run that dies on a selector, a typo or
 * a wrong endpoint is an unrecoverable loss — the reason this package rehearses
 * every scenario against the scripted stand-in first. That rehearsal is only
 * worth anything if it exercises the real thing: helpers that the model spec
 * then re-implements slightly differently prove nothing. So the driving and the
 * checking live here, the scripted rehearsal (`e2e/bl03-rehearsal.spec.ts`) runs
 * them against scenarios that call the very same tool handlers, and the model
 * specs run them against the real model.
 *
 * What the two cannot share is the *verdict* of an isolation probe: whether the
 * sandbox refuses a read is a fact about the sandbox, and a stand-in that
 * pretended either way would be the worst kind of evidence. Those assertions
 * live in the model spec alone and are marked there.
 */

/* -------------------------------------------------------------------------- */
/*  Driving the interface                                                     */
/* -------------------------------------------------------------------------- */

/** Opens the app on `baseUrl`, with a session, exactly as the other suites do. */
export async function openApp(page: Page, baseUrl: string, path = '/'): Promise<void> {
  await page.goto(`${baseUrl}${path}`);
  await page.evaluate(() =>
    fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  await page.goto(`${baseUrl}${path}`);
  await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
}

export interface SentCommand {
  runId: string;
  /** The `AppContext` the browser sent with the command, from the request body. */
  context: Record<string, any>;
}

/**
 * Types a command and returns the run it started.
 *
 * The context comes from the outgoing request rather than from the store: "the
 * command carried the record the user was on" is a claim about what left the
 * browser, and the request body is the only place that is true or false.
 */
export async function typeCommand(page: Page, text: string): Promise<SentCommand> {
  const request = page.waitForRequest(
    (r) => r.url().endsWith('/api/agui/run') && r.method() === 'POST',
  );
  const composer = page.locator('.openui-agent-thread-composer__input');
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await page.locator('.pf-chat [aria-label="Send message"]').first().click();
  const sent = await request;
  const runId = (await sent.response())?.headers()['x-run-id'];
  expect(runId, 'naglowek X-Run-Id').toBeTruthy();
  return { runId: runId!, context: sent.postDataJSON().context };
}

/** How a spec sends a command. The model spec wraps this to charge the ledger. */
export type Commander = (page: Page, text: string) => Promise<SentCommand>;

/**
 * Waits for *this* run to reach a terminal phase, approving nothing.
 *
 * The strip names the run it is showing, so a run that has not reached the
 * screen yet cannot be mistaken for one that has finished.
 */
export async function settled(page: Page, runId: string, timeout = 420_000): Promise<string> {
  const strip = page.getByTestId('run-state');
  await expect.poll(() => strip.getAttribute('data-run-id'), { timeout }).toBe(runId);
  await expect(strip).toHaveAttribute('data-phase', /succeeded|failed|cancelled/, { timeout });
  const phase = (await strip.getAttribute('data-phase'))!;
  // One beat past the terminal phase, so what the run changed is on screen.
  await page.waitForTimeout(800);
  return phase;
}

/**
 * Waits for the run, answering every consent request with the given decision.
 *
 * `decide` is asked once per prompt and gets the prompt's text, so a scenario
 * can refuse the first question and allow the second without the helper knowing
 * anything about the scenario.
 */
export async function settledDeciding(
  page: Page,
  runId: string,
  decide: (promptText: string, index: number) => 'Zgoda' | 'Odmowa',
  timeout = 420_000,
): Promise<{ phase: string; decisions: Array<{ text: string; decision: string }> }> {
  const decisions: Array<{ text: string; decision: string }> = [];
  const strip = page.getByTestId('run-state');
  await expect.poll(() => strip.getAttribute('data-run-id'), { timeout }).toBe(runId);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const phase = await strip.getAttribute('data-phase').catch(() => null);
    if (phase === 'succeeded' || phase === 'failed' || phase === 'cancelled') {
      await page.waitForTimeout(800);
      return { phase, decisions };
    }
    const prompt = page.getByTestId('permission-prompt');
    if (await prompt.isVisible().catch(() => false)) {
      const text = (await prompt.textContent())?.slice(0, 200) ?? '';
      const decision = decide(text, decisions.length);
      decisions.push({ text, decision });
      await prompt.getByRole('button', { name: decision }).click();
    }
    await page.waitForTimeout(400);
  }
  throw new Error(`uruchomienie ${runId} nie zakonczylo sie w czasie`);
}

/**
 * Doprowadza wykonanie do stanu, w ktorym **naprawde cos robi** — zgadzajac sie
 * po drodze na powloke, bo bez tego run stoi na bramce zgody zamiast pracowac.
 *
 * Zwraca decyzje, ktore padly, zeby dowod mowil, czy zgoda w ogole byla
 * potrzebna.
 */
export async function working(page: Page, runId: string): Promise<string[]> {
  const strip = page.getByTestId('run-state');
  await expect.poll(() => strip.getAttribute('data-run-id'), { timeout: 420_000 }).toBe(runId);
  const decisions: string[] = [];
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const phase = await strip.getAttribute('data-phase').catch(() => null);
    if (phase === 'succeeded' || phase === 'failed' || phase === 'cancelled') break;
    const prompt = page.getByTestId('permission-prompt');
    if (await prompt.isVisible().catch(() => false)) {
      decisions.push('Zgoda');
      await prompt.getByRole('button', { name: 'Zgoda' }).click();
      // Po zgodzie polecenie rusza — od tego momentu jest co liczyc.
      await page.waitForTimeout(2500);
      return decisions;
    }
    await page.waitForTimeout(300);
  }
  // Bez bramki: wystarczy, ze wykonanie trwa i cos juz powiedzialo.
  await page.waitForTimeout(1500);
  return decisions;
}

/* -------------------------------------------------------------------------- */
/*  What the backend says happened                                            */
/* -------------------------------------------------------------------------- */

/**
 * Backend reads for one instance.
 *
 * A class, and not free functions taking a path, because these suites talk to
 * **three** different servers — the shared browser instance, a scripted one and
 * a production one the test starts itself — and a relative path silently
 * resolves against Playwright's `baseURL`. A helper that reads run events from
 * the wrong instance answers about nothing, cheerfully.
 */
export class Backend {
  constructor(
    readonly page: Page,
    /** Origin of the instance, or `''` for the suite's own `baseURL`. */
    readonly baseUrl = '',
  ) {}

  async json<T = any>(path: string): Promise<T> {
    const res = await this.page.request.get(`${this.baseUrl}${path}`);
    expect(res.status(), `${this.baseUrl}${path}`).toBe(200);
    return (await res.json()) as T;
  }

  runEvents(runId: string): Promise<RunEvent[]> {
    return this.json<{ events: RunEvent[] }>(`/api/runs/${runId}/events`).then((r) => r.events);
  }

  cards(spaceId: string): Promise<CanvasCard[]> {
    return this.json<{ cards: CanvasCard[] }>(`/api/canvas/spaces/${spaceId}`).then((s) => s.cards);
  }

  spaces(): Promise<Array<{ id: string; title: string; scopeKind: string | null; scopeId: string | null }>> {
    return this.json<{ spaces: Array<{ id: string; title: string; scopeKind: string | null; scopeId: string | null }> }>(
      '/api/canvas/spaces',
    ).then((s) => s.spaces);
  }

  runs(conversationId: string): Promise<RunRecord[]> {
    return this.json<{ runs: RunRecord[] }>(`/api/conversations/${conversationId}/runs`).then((r) => r.runs);
  }

  messages(conversationId: string): Promise<Array<{ id: string; role: string; content: string }>> {
    return this.json<Array<{ id: string; role: string; content: string }>>(
      `/api/threads/get/${conversationId}`,
    );
  }

  /** Everything the assistant said in this conversation, from the backend. */
  async assistantText(conversationId: string): Promise<string> {
    const messages = await this.messages(conversationId);
    return messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('\n');
  }

  /**
   * The card this run made, identified by the id the run itself reported.
   *
   * L3.13 in one method. "A new card appeared" is not the claim — an existing
   * one, or one another worker made a second earlier, would satisfy it. The
   * claim is that the object is **this execution's**, so the `cardId` comes from
   * the `TOOL_CALL_RESULT` of the call this run made and is then looked up in
   * the space. A run that changed nothing has no such result and fails here
   * rather than passing on somebody else's card.
   */
  async cardFromRun(input: { runId: string; spaceId: string; tool: string }): Promise<{
    call: ToolCall;
    card: CanvasCard | null;
    cardId: string;
  }> {
    const events = await this.runEvents(input.runId);
    const calls = callsOf(events, input.tool);
    expect(
      calls.length,
      `uruchomienie nie wywolalo ${input.tool}; wywolane: ${toolNames(events).join(', ') || '(zadne)'}`,
    ).toBeGreaterThan(0);
    const call = calls[calls.length - 1]!;
    expect(call.isError, `${input.tool} zakonczylo sie bledem: ${call.rawResult}`).toBe(false);
    const cardId = (call.result as { cardId?: string } | null)?.cardId;
    expect(cardId, `${input.tool} nie zwrocilo cardId; wynik: ${call.rawResult}`).toBeTruthy();
    const cards = await this.cards(input.spaceId);
    return { call, cardId: cardId!, card: cards.find((c) => c.id === cardId) ?? null };
  }
}

export interface RunEvent {
  name: string;
  payload: Record<string, any>;
}

/** One tool call of a run: what was asked, and what came back. */
export interface ToolCall {
  id: string;
  name: string;
  /** `TOOL_CALL_ARGS` content, parsed when it is JSON. */
  args: unknown;
  /** `TOOL_CALL_RESULT` content, parsed when it is JSON. */
  result: unknown;
  rawResult: string | null;
  isError: boolean;
}

/**
 * What one `TOOL_CALL_RESULT` carries — **and it is not the same shape on both
 * paths**.
 *
 * A scripted handler's answer is logged as the object itself; the same handler
 * reached through MCP by the real model is logged as the protocol's content
 * blocks (`[{type: "text", text: "<json>"}]`). A reader that only does
 * `JSON.parse` therefore works perfectly in the rehearsal and returns an object
 * with none of the expected fields on the paid run — which is exactly what
 * happened here, on turn 1, and what happened to proba T25's first real-model
 * run before it. The unwrapping lives in `show-value-probe.ts`, which already
 * had to learn this; there is one copy of it and both suites use it.
 */
const parse = (text: string | null | undefined): unknown => {
  if (typeof text !== 'string') return null;
  try {
    return parseToolContent(text);
  } catch {
    return text;
  }
};

/**
 * The run's tool calls, paired with their arguments and their results.
 *
 * Pairing is by `toolCallId`, never by order: a run makes several calls, the
 * results do not have to arrive in the order the calls were announced, and
 * "the card this run created" is a claim that falls apart the moment the two
 * are matched by position.
 */
export function toolCalls(events: RunEvent[]): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  for (const e of events) {
    const id = e.payload?.toolCallId as string | undefined;
    if (!id) continue;
    const entry = byId.get(id) ?? {
      id,
      name: '',
      args: null,
      result: null,
      rawResult: null,
      isError: false,
    };
    if (e.name === 'TOOL_CALL_START') entry.name = String(e.payload.toolCallName ?? entry.name);
    if (e.name === 'TOOL_CALL_ARGS') entry.args = parse(e.payload.delta ?? e.payload.args);
    if (e.name === 'TOOL_CALL_RESULT') {
      entry.rawResult = String(e.payload.content ?? '');
      entry.result = parse(entry.rawResult);
      entry.isError = Boolean(e.payload.isError);
    }
    byId.set(id, entry);
  }
  return [...byId.values()];
}

/** Local tool names of a run, in the order they were announced. */
export const toolNames = (events: RunEvent[]): string[] =>
  events
    .filter((e) => e.name === 'TOOL_CALL_START')
    .map((e) => String(e.payload.toolCallName ?? '').replace(/^mcp__app__/, ''));

/** The run's own calls of one tool. */
export const callsOf = (events: RunEvent[], localName: string): ToolCall[] =>
  toolCalls(events).filter((c) => c.name.replace(/^mcp__app__/, '') === localName);

/** Names of the custom platform events a run emitted (`platform.*`). */
export const customEvents = (events: RunEvent[]): string[] =>
  events.filter((e) => e.name === 'CUSTOM').map((e) => String(e.payload?.name ?? ''));

export interface CanvasCard {
  id: string;
  title: string;
  spec: { kind: string; component?: string; props?: Record<string, unknown> };
  geometry: { x: number; y: number; width: number; height: number; z?: number };
  specVersion: number;
}

export interface RunRecord {
  id: string;
  status: string;
  errorCode: string | null;
  claudeSessionId: string | null;
  durationMs: number | null;
  firstTokenMs: number | null;
}

/**
 * Both halves of L6.6: the object the run made belongs to the record the
 * command was about, and the backend says so.
 */
export function expectCardPointsAtRecord(
  card: CanvasCard | null,
  recordId: string,
  propName = 'caseId',
): void {
  expect(card, 'karty o tym identyfikatorze nie ma w przestrzeni').toBeTruthy();
  expect(card!.spec.kind).toBe('component');
  expect(
    (card!.spec.props ?? {})[propName],
    `karta nie wskazuje rekordu z kontekstu polecenia (${propName})`,
  ).toBe(recordId);
}

export const conversationIdOf = (page: Page): string | null =>
  new URL(page.url()).searchParams.get('c');

/* -------------------------------------------------------------------------- */
/*  Processes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every process descended from `root`, with its command name, from `/proc`.
 *
 * "The application left no unmanaged worker process" is a claim about
 * processes, and a status in a database cannot see one. The comm field is
 * parenthesised and may contain spaces, hence the split on the last `)`.
 */
export function descendants(root: number): Array<{ pid: number; comm: string }> {
  const parents = new Map<number, { ppid: number; comm: string }>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(after[1]);
      if (Number.isFinite(ppid)) parents.set(Number(entry), { ppid, comm });
    } catch {
      // Ended between the listing and the read: not a descendant still running,
      // which is all this counts.
    }
  }
  const found: Array<{ pid: number; comm: string }> = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [pid, info] of parents) {
      if (info.ppid === current && !found.some((f) => f.pid === pid)) {
        found.push({ pid, comm: info.comm });
        queue.push(pid);
      }
    }
  }
  return found;
}

/**
 * Descendants that are the model's, not the server's own.
 *
 * The Claude Agent SDK runs the CLI as a child process, and a sandboxed command
 * runs under `bwrap` beneath it. Those are the "unmanaged worker processes"
 * L1.6 is about — a `node` worker of the server is not one, so the match is by
 * name rather than by count.
 */
export const workerProcesses = (root: number): Array<{ pid: number; comm: string }> =>
  descendants(root).filter((p) => /claude|bwrap|bubblewrap/i.test(p.comm));

/** Processes that were there before and are not there now. */
export const goneSince = (
  before: Array<{ pid: number }>,
  now: Array<{ pid: number }>,
): number[] => before.filter((b) => !now.some((n) => n.pid === b.pid)).map((b) => b.pid);

/**
 * Values that must never appear in evidence or in a conversation.
 *
 * Used by the isolation run: the honest way to show that a secret stayed
 * unreachable is to take the real bytes from disk and look for them in
 * everything the run produced — the same technique `tests/runtime.test.ts` uses
 * for the subscription token. The values themselves are never printed, only the
 * verdict.
 */
export function containsAny(haystack: string, needles: string[]): string | null {
  for (const n of needles) {
    if (n.length >= 8 && haystack.includes(n)) return `${n.slice(0, 4)}…(${n.length} znakow)`;
  }
  return null;
}
