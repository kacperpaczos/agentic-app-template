import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  claudeConfigDir,
  collectToolEntries,
  platformTools,
  protectedPathRefusal,
  sandboxSettings,
} from '@platform/server';
import { createHarness, type Harness } from './helpers.ts';
import { dispatchingAgent, newStandInHandle, type Plan, type StandInHandle, type Step } from './support/model-standin.ts';

/**
 * The login stays out of the agent's reach.
 *
 * L8.7 says credentials do not appear in the frontend, in artifacts or in logs.
 * Everything the application writes was already checked for that. What was not
 * checked is the other direction — whether the **agent** can simply open the
 * credential file and put the token into an answer. It could: `Read` is
 * pre-approved, so the consent gate is never consulted for it, and the sandbox
 * denied only the application's data directory.
 *
 * **Simulation, and marked as such.** The model is replaced at the adapter
 * boundary by a stand-in that plays the SDK's built-in file tool the way the
 * SDK does: it fires `PreToolUse`, honours a `deny` decision, and otherwise
 * really reads the file. That last part is what makes these assertions worth
 * anything — without the refusal the bytes reach the answer, which is the
 * negative control built into the step.
 *
 * **The credential here is a canary, in a temporary directory.** `CLAUDE_CONFIG_DIR`
 * is redirected for the duration of each test, so nothing reads, writes or
 * invalidates the real login.
 */

let h: Harness;
let runtime: AgentRuntime;
let plans: Map<string, Plan>;
let configDir: string;
let realConfigDir: string | undefined;
const pending: Array<Promise<unknown>> = [];
let promptSeq = 0;

/** A value that exists nowhere else, so finding it anywhere is proof of a leak. */
const CANARY = 'KANAREK-POSWIADCZENIA-7f3a91c4';

const EMPTY_CONTEXT = {
  conversationId: null as string | null,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
  ui: null,
};

async function startRun(script: Step[]) {
  promptSeq += 1;
  const prompt = `polecenie poswiadczenia ${promptSeq}`;
  const handle: StandInHandle = newStandInHandle();
  plans.set(prompt, { script, handle });
  const conversationId = h.platform.services.conversations.create({
    ownerId: h.ownerId,
    title: 'Poswiadczenia',
  }).id;
  const started = await runtime.start({
    ownerId: h.ownerId,
    conversationId,
    prompt,
    appContext: { ...EMPTY_CONTEXT, conversationId },
  });
  const events: Array<Record<string, any>> = [];
  const reader = (async () => {
    for await (const e of started.stream.read(0)) events.push(e.event as Record<string, any>);
  })();
  pending.push(started.done.catch(() => undefined), reader);
  await started.done;
  await reader;
  return { stand: handle, events, conversationId, runId: started.runId };
}

const answerText = (events: Array<Record<string, any>>) =>
  events
    .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
    .map((e) => String(e.delta ?? ''))
    .join('');

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'kanarek-claude-'));
  writeFileSync(
    join(configDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: CANARY, refreshToken: `${CANARY}-refresh`, subscriptionType: 'max' },
    }),
  );
  realConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;

  plans = new Map();
  h = await createHarness({
    withModule: false,
    modelAgent: dispatchingAgent(plans, () =>
      collectToolEntries({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
      }),
    ),
  });
  runtime = h.platform.runtime;
});

afterEach(async () => {
  h.platform.services.runs.abortAll('koniec_testu');
  await Promise.allSettled(pending.splice(0));
  h.dispose();
  if (realConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

/* ---------------------------------- rule ---------------------------------- */

describe('regula chronionych katalogow', () => {
  const guards = [
    { dir: '/tmp/dane-aplikacji', what: 'danych aplikacji' },
    { dir: '/home/ktos/.claude', what: 'poswiadczen Claude' },
  ];

  it('odczyt pliku poswiadczen jest odrzucony z podaniem powodu', () => {
    const reason = protectedPathRefusal(
      'Read',
      { file_path: '/home/ktos/.claude/.credentials.json' },
      guards,
    );
    expect(reason).toBeTruthy();
    expect(reason).toContain('poswiadczen Claude');
  });

  it('kazde narzedzie plikowe jest objete regula, nie tylko Read', () => {
    for (const [tool, input] of [
      ['Write', { file_path: '/home/ktos/.claude/x' }],
      ['Edit', { file_path: '/home/ktos/.claude/.credentials.json' }],
      ['Glob', { path: '/home/ktos/.claude' }],
      ['Grep', { path: '/home/ktos/.claude' }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(protectedPathRefusal(tool, input, guards), `${tool} nieobjete regula`).toBeTruthy();
    }
  });

  it('baza aplikacji jest chroniona tak samo jak logowanie', () => {
    expect(protectedPathRefusal('Read', { file_path: '/tmp/dane-aplikacji/app.db' }, guards)).toBeTruthy();
  });

  it('zwykly plik roboczy przechodzi bez zmian', () => {
    expect(protectedPathRefusal('Read', { file_path: '/tmp/ws/output/wynik.txt' }, guards)).toBeNull();
    // A path that merely resembles the guarded one is not inside it.
    expect(protectedPathRefusal('Read', { file_path: '/home/ktos/.claude-notatki/plan.md' }, guards)).toBeNull();
  });

  it('sciezka wzgledna jest oceniana po rozwiazaniu, nie po zapisie', () => {
    const fromWorkspace = (p: string) => resolve('/tmp/ws/run_1', p);
    expect(
      protectedPathRefusal('Read', { file_path: '../../../home/ktos/.claude/.credentials.json' }, guards, fromWorkspace),
    ).toBeTruthy();
    expect(protectedPathRefusal('Read', { file_path: 'output/wynik.txt' }, guards, fromWorkspace)).toBeNull();
  });

  it('narzedzie bez argumentu sciezki nie jest zgadywane', () => {
    // `Bash` is confined by the sandbox, not by a path argument it does not have.
    expect(protectedPathRefusal('Bash', { command: 'cat /home/ktos/.claude/.credentials.json' }, guards)).toBeNull();
  });
});

describe('sandbox zna katalog poswiadczen', () => {
  it('katalog logowania jest zablokowany do odczytu i zapisu', () => {
    const s = sandboxSettings({
      workspaceDir: '/tmp/ws',
      dataDir: '/tmp/dane',
      credentialDirs: ['/home/ktos/.claude'],
    }) as any;
    expect(s.filesystem.denyRead).toContain('/home/ktos/.claude');
    expect(s.filesystem.denyWrite).toContain('/home/ktos/.claude');
    // And the data directory it already protected is still protected.
    expect(s.filesystem.denyRead).toContain('/tmp/dane');
  });

  it('katalog poswiadczen czyta zmienna CLAUDE_CONFIG_DIR', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/gdzies/indziej' } as NodeJS.ProcessEnv)).toBe('/gdzies/indziej');
    expect(claudeConfigDir({} as NodeJS.ProcessEnv)).toMatch(/\.claude$/);
  });
});

/* ------------------------------ through a run ------------------------------ */

describe('uruchomienie nie moze odczytac poswiadczenia (symulacja na granicy adaptera)', () => {
  it('proba odczytu pliku poswiadczen konczy sie odmowa, a kanarek nie trafia do odpowiedzi', async () => {
    const { stand, events } = await startRun([
      { kind: 'text', text: 'Sprawdzam plik logowania. ' },
      { kind: 'fileTool', name: 'Read', input: { file_path: join(configDir, '.credentials.json') } },
      { kind: 'text', text: 'Koniec.' },
    ]);

    expect(stand.fileTools).toEqual([
      expect.objectContaining({ name: 'Read', denied: true }),
    ]);
    expect(stand.fileTools[0]?.reason).toContain('poswiadczen Claude');

    const text = answerText(events);
    expect(text.includes(CANARY), 'wartosc poswiadczenia trafila do odpowiedzi').toBe(false);
    // The refusal is announced, not swallowed: the step is in the conversation.
    expect(text).toContain('odmowa');
  });

  it('odmowa jest widoczna w historii jako nieudany krok narzedzia', async () => {
    const { conversationId } = await startRun([
      { kind: 'fileTool', name: 'Read', input: { file_path: join(configDir, '.credentials.json') } },
      { kind: 'text', text: 'Nie moge tego odczytac.' },
    ]);
    const messages = h.platform.services.conversations.messages(conversationId, h.ownerId);
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages.length, 'krok narzedzia nie trafil do historii').toBeGreaterThan(0);
    const stored = JSON.stringify(messages);
    expect(stored.includes(CANARY), 'wartosc poswiadczenia trafila do historii rozmowy').toBe(false);
    // Marked as a failure, so the chat shows it as one.
    expect(toolMessages.some((m) => (m.meta as any)?.isError === true || String(m.content).includes('odmowa') || String(m.content).includes('nie ma dostepu'))).toBe(true);
  });

  it('caly katalog logowania jest poza zasiegiem, nie tylko jeden plik', async () => {
    const { stand } = await startRun([
      { kind: 'fileTool', name: 'Glob', input: { path: configDir, pattern: '*' } },
      { kind: 'text', text: 'Koniec.' },
    ]);
    expect(stand.fileTools[0]).toMatchObject({ denied: true });
  });

  it('plik w workspace uruchomienia pozostaje dostepny', async () => {
    /*
     * The control that keeps the rule honest in the other direction: a
     * protection that refused every file would pass every assertion above and
     * break the product.
     */
    const readable = join(configDir, '..', 'nie-poswiadczenie.txt');
    writeFileSync(resolve(readable), 'zwykla tresc robocza');
    const { stand } = await startRun([
      { kind: 'fileTool', name: 'Read', input: { file_path: resolve(readable) } },
      { kind: 'text', text: 'Koniec.' },
    ]);
    expect(stand.fileTools[0]).toMatchObject({ denied: false });
    rmSync(resolve(readable), { force: true });
  });
});
