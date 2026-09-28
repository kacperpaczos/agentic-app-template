import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRunWorkspace,
  listWorkspaceOutputs,
  resolveInWorkspace,
  sandboxSettings,
  sanitizeFilename,
  subscriptionOnlyEnv,
  scrubbedEnvKeys,
  probeAuth,
  RunEventStream,
  encodeSse,
  deriveTitle,
} from '@platform/server';
import { createHarness, login, type Harness } from './helpers.ts';

describe('workspace i sandbox', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.dispose());

  it('tworzy workspace z katalogami input/output i sprzata po sobie', () => {
    const ws = createRunWorkspace(h.platform.config.workspacesDir, 'run_test_1');
    expect(existsSync(ws.inputDir)).toBe(true);
    expect(existsSync(ws.outputDir)).toBe(true);
    writeFileSync(resolve(ws.outputDir, 'wynik.txt'), 'abc');
    expect(listWorkspaceOutputs(ws.dir)).toEqual([{ path: 'wynik.txt', bytes: 3 }]);
    ws.dispose();
    expect(existsSync(ws.dir)).toBe(false);
  });

  it('odrzuca sciezke wychodzaca poza workspace', () => {
    const ws = createRunWorkspace(h.platform.config.workspacesDir, 'run_test_2');
    expect(() => resolveInWorkspace(ws.dir, '../../../etc/passwd')).toThrowError(/poza workspace/);
    expect(() => resolveInWorkspace(ws.dir, 'output/../../secret')).toThrowError(/poza workspace/);
    expect(resolveInWorkspace(ws.dir, 'output/ok.txt')).toContain(ws.dir);
    ws.dispose();
  });

  it('konfiguracja sandboxa odcina siec i chroni katalog danych aplikacji', () => {
    const s = sandboxSettings({ workspaceDir: '/tmp/ws', dataDir: '/tmp/dane' }) as any;
    expect(s.enabled).toBe(true);
    // A missing sandbox must fail the run, not silently downgrade it.
    expect(s.failIfUnavailable).toBe(true);
    expect(s.allowUnsandboxedCommands).toBe(false);
    // Independent of allowedTools: true here would auto-approve every sandboxed
    // shell command before canUseTool runs, making the consent gate dead code.
    expect(s.autoAllowBashIfSandboxed).toBe(false);
    expect(s.network.allowedDomains).toEqual([]);
    expect(s.network.strictAllowlist).toBe(true);
    expect(s.filesystem.allowWrite).toEqual(['/tmp/ws']);
    // Without this, a shell command could read app.db and bypass MCP entirely.
    expect(s.filesystem.denyRead).toContain('/tmp/dane');
    expect(s.filesystem.denyWrite).toContain('/tmp/dane');
  });
});

describe('polityka wylacznie subskrypcyjna', () => {
  it('usuwa zmienne kierujace na platne API i gateway', () => {
    const env = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-tajne',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      ANTHROPIC_AUTH_TOKEN: 'tajne',
      AWS_BEARER_TOKEN_BEDROCK: 'tajne',
      HOME: '/home/u',
    };
    const out = subscriptionOnlyEnv(env);
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/u');
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(out.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(out.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('sk-ant');
  });

  it('izoluje proces potomny od nadrzednej sesji Claude Code, ale zostawia CLAUDE_CONFIG_DIR', () => {
    const env = {
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s',
      CLAUDE_CODE_MESSAGING_TOKEN: 'tajne',
      CLAUDECODE: '1',
      CLAUDE_CONFIG_DIR: '/home/u/.claude',
      PATH: '/usr/bin',
    };
    const out = subscriptionOnlyEnv(env);
    expect(out.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(out.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined();
    expect(out.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined();
    expect(out.CLAUDECODE).toBeUndefined();
    expect(out.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude');
    expect(scrubbedEnvKeys(env)).toEqual(
      expect.arrayContaining(['CLAUDE_CODE_SESSION_ID', 'CLAUDECODE']),
    );
    expect(scrubbedEnvKeys(env)).not.toContain('CLAUDE_CONFIG_DIR');
  });

  it('raport uwierzytelnienia nie zawiera zadnej wartosci sekretnej', () => {
    const status = probeAuth();
    const text = JSON.stringify(status);
    expect(text).not.toMatch(/sk-ant|accessToken|refreshToken/i);
    expect(status.apiKeyPolicy).toBe('refused');
    expect(['subscription', 'none']).toContain(status.method);
  });
});

describe('limity plikow', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ withModule: false });
  });
  afterAll(() => h.dispose());

  it('czysci nazwe pliku ze sciezek i znakow sterujacych', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Windows\\evil.csv')).toBe('evil.csv');
    expect(sanitizeFilename('  raport.csv  ')).toBe('raport.csv');
    expect(sanitizeFilename('.....hidden.csv')).toBe('hidden.csv');
    expect(() => sanitizeFilename('...')).toThrowError(/pusta/);
  });

  it('odrzuca zbyt duzy plik i niedozwolony typ', () => {
    expect(() =>
      h.platform.services.files.store({
        ownerId: h.ownerId,
        filename: 'wielki.csv',
        mediaType: 'text/csv',
        bytes: new Uint8Array(h.platform.config.maxUploadBytes + 1),
      }),
    ).toThrowError(/limit/);

    expect(() =>
      h.platform.services.files.store({
        ownerId: h.ownerId,
        filename: 'zly.exe',
        mediaType: 'application/x-msdownload',
        bytes: new Uint8Array(2),
      }),
    ).toThrowError(/Niedozwolony typ/);
  });

  it('zapisuje plik pod bezpieczna nazwa i liczy sha256', () => {
    const stored = h.platform.services.files.store({
      ownerId: h.ownerId,
      filename: '../../../wyjscie.csv',
      mediaType: 'text/csv',
      bytes: new TextEncoder().encode('a;b\n1;2\n'),
    });
    expect(stored.filename).toBe('wyjscie.csv');
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
    const back = h.platform.services.files.read(stored.id, h.ownerId);
    expect(back.bytes.toString('utf8')).toBe('a;b\n1;2\n');
  });
});

describe('rejestr uruchomien i cykl zycia zadania', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ withModule: false });
  });
  afterAll(() => h.dispose());

  const startRun = () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, title: 'T' });
    const abort = new AbortController();
    const run = h.platform.services.runs.start({
      conversationId: conv.id,
      ownerId: h.ownerId,
      prompt: 'p',
      appContext: {
        conversationId: conv.id, spaceId: null, resource: null,
        selection: [], filters: {}, viewport: null, drafts: [],
      },
      workspaceDir: null,
      abort,
    });
    return { conv, run, abort };
  };

  it('zadanie ma trwaly status i powiazanie z rozmowa', () => {
    const { conv, run } = startRun();
    const stored = h.platform.services.runs.get(run.id, h.ownerId);
    // Accepted, not yet executing: `start()` only enqueues. The distinction is
    // what lets the UI show a queued turn instead of pretending work began.
    expect(stored.status).toBe('queued');
    expect(stored.conversationId).toBe(conv.id);
    expect(h.platform.services.runs.listForConversation(conv.id, h.ownerId)).toHaveLength(1);
  });

  it('start wykonania jest osobnym, mierzalnym punktem wzgledem zakolejkowania', async () => {
    const { run } = startRun();
    expect(h.platform.services.runs.get(run.id, h.ownerId).queuedMs).toBe(0);

    await new Promise((r) => setTimeout(r, 25));
    h.platform.services.runs.markExecutionStart(run.id);

    const started = h.platform.services.runs.get(run.id, h.ownerId);
    expect(started.status).toBe('running');
    // The wait is attributed to the queue, not to the model.
    expect(started.queuedMs).toBeGreaterThanOrEqual(20);
    expect(Date.parse(started.startedAt)).toBeGreaterThan(Date.parse(started.enqueuedAt));

    // Marking twice must not move the start again.
    const firstStart = started.startedAt;
    h.platform.services.runs.markExecutionStart(run.id);
    expect(h.platform.services.runs.get(run.id, h.ownerId).startedAt).toBe(firstStart);
  });

  it('uruchomienie czekajace w kolejce mozna anulowac zanim ruszy', () => {
    const { run, abort } = startRun();
    expect(h.platform.services.runs.get(run.id, h.ownerId).status).toBe('queued');
    const res = h.platform.services.runs.cancel(run.id, h.ownerId);
    expect(res.cancelled).toBe(true);
    expect(abort.signal.aborted).toBe(true);
    h.platform.services.runs.finish(run.id, 'cancelled', { errorCode: 'cancelled' });
    expect(h.platform.services.runs.get(run.id, h.ownerId).status).toBe('cancelled');
  });

  it('anulowanie dociera do wykonania i jest mierzalne', () => {
    const { run, abort } = startRun();
    const t0 = Date.now();
    const res = h.platform.services.runs.cancel(run.id, h.ownerId);
    const elapsed = Date.now() - t0;
    expect(res.cancelled).toBe(true);
    expect(abort.signal.aborted).toBe(true);
    // The signal is delivered synchronously; the model process sees it on its
    // next await. This measures only the application half.
    expect(elapsed).toBeLessThan(50);

    h.platform.services.runs.finish(run.id, 'cancelled', { errorCode: 'cancelled' });
    expect(h.platform.services.runs.get(run.id, h.ownerId).status).toBe('cancelled');
  });

  it('kazde uruchomienie ma dokladnie jeden rozstrzygajacy status koncowy', () => {
    const { run } = startRun();
    h.platform.services.runs.finish(run.id, 'succeeded', { durationMs: 10 });
    // A second terminal transition must not overwrite the first.
    h.platform.services.runs.finish(run.id, 'failed', { errorCode: 'internal' });
    const stored = h.platform.services.runs.get(run.id, h.ownerId);
    expect(stored.status).toBe('succeeded');
    expect(stored.errorCode).toBeNull();
  });

  it('cudze uruchomienie nie moze byc anulowane', () => {
    const { run } = startRun();
    expect(() => h.platform.services.runs.cancel(run.id, h.otherOwnerId)).toThrowError(/Cudze/);
  });

  it('restart oznacza przerwane zadania zamiast udawac kontynuacje', () => {
    const { run } = startRun();
    const reconciled = h.platform.services.runs.reconcileOnBoot();
    expect(reconciled).toBeGreaterThanOrEqual(1);
    const stored = h.platform.services.runs.get(run.id, h.ownerId);
    expect(stored.status).toBe('failed');
    expect(stored.errorMessage).toMatch(/Przerwane restartem/);
  });

  it('zatrzymanie serwera przerywa wszystkie uruchomienia', () => {
    const a = startRun();
    const b = startRun();
    // Earlier tests in this block left runs registered too; the contract is that
    // shutdown aborts every one of them, not exactly two.
    const n = h.platform.services.runs.abortAll('test_shutdown');
    expect(n).toBeGreaterThanOrEqual(2);
    expect(a.abort.signal.aborted).toBe(true);
    expect(b.abort.signal.aborted).toBe(true);
    expect(h.platform.services.runs.activeCount()).toBe(0);
  });
});

describe('strumien zdarzen AG-UI', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ withModule: false });
  });
  afterAll(() => h.dispose());

  const makeStream = () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, title: 'T' });
    const run = h.platform.services.runs.start({
      conversationId: conv.id,
      ownerId: h.ownerId,
      prompt: 'p',
      appContext: {
        conversationId: conv.id, spaceId: null, resource: null,
        selection: [], filters: {}, viewport: null, drafts: [],
      },
      workspaceDir: null,
      abort: new AbortController(),
    });
    return { run, stream: new RunEventStream(run.id, h.platform.services.runs) };
  };

  it('numeruje zdarzenia i zapisuje je trwale', async () => {
    const { run, stream } = makeStream();
    stream.runStarted('c', run.id);
    stream.textStart('m1');
    stream.textDelta('m1', 'abc');
    stream.toolStart('t1', 'mcp__app__get_context', 'm1');
    stream.toolResult('t1', '{}');
    stream.runFinished('c', run.id);
    stream.close();

    const persisted = h.platform.services.runs.events(run.id, h.ownerId);
    expect(persisted.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(persisted.map((e) => e.name)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TOOL_CALL_START',
      'TOOL_CALL_RESULT',
      'RUN_FINISHED',
    ]);
  });

  it('odtwarza od podanego numeru — reconnect nie powiela zdarzen', async () => {
    const { stream } = makeStream();
    stream.runStarted('c', 'r');
    stream.textDelta('m1', 'a');
    stream.textDelta('m1', 'b');
    stream.close();

    const all: number[] = [];
    for await (const item of stream.read(0)) all.push(item.seq);
    expect(all).toEqual([1, 2, 3]);

    // A client that already saw seq 2 resumes without re-receiving 1 and 2.
    const resumed: number[] = [];
    for await (const item of stream.read(2)) resumed.push(item.seq);
    expect(resumed).toEqual([3]);
  });

  it('koduje zdarzenia dokladnie tak, jak oczekuje agUIAdapter', () => {
    const encoded = encodeSse({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'x' });
    expect(encoded).toBe('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"x"}\n\n');
  });
});

describe('automatyczne tytuly rozmow (bez API Anthropic)', () => {
  it('skraca pierwsza wiadomosc do sensownego tytulu', () => {
    expect(deriveTitle('Porownaj oferty dla tej sprawy. Potem dodaj wykres.')).toBe(
      'Porownaj oferty dla tej sprawy',
    );
    expect(deriveTitle('   ')).toBe('Nowa rozmowa');
    expect(deriveTitle('a'.repeat(200)).length).toBeLessThanOrEqual(64);
    expect(deriveTitle('ile to kosztuje?')).toBe('Ile to kosztuje');
  });
});

describe('kopia i odtworzenie trwalego stanu lokalnego', () => {
  it('skopiowany katalog danych otwiera sie z kompletnym stanem', async () => {
    const { cpSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createPlatform } = await import('@platform/server');
    const { createProcurementModule } = await import('@module/procurement/server');

    const h = await createHarness();
    try {
      const artifact = h.platform.services.artifacts.create({
        ownerId: h.ownerId,
        kind: 'report',
        mode: 'snapshot',
        title: 'Do odtworzenia',
        rendererType: 'platform.file',
        content: { wartosc: 42 },
      });
      const files = h.platform.services.files.list(h.ownerId);
      const space = h.platform.services.canvas.createSpace({ ownerId: h.ownerId, title: 'Kopia' });
      await h.platform.services.canvas.addCard(
        {
          spaceId: space.id,
          title: 'Karta',
          spec: { kind: 'component', component: 'platform.markdown', props: { markdown: 'x' } },
        },
        h.ownerId,
      );
      // WAL mode keeps writes outside the main file until a checkpoint; a copy
      // taken without this would be missing the most recent rows.
      h.platform.db.$client.pragma('wal_checkpoint(TRUNCATE)');

      const copy = mkdtempSync(join(tmpdir(), 'agentic-restore-'));
      cpSync(h.dataDir, copy, { recursive: true });

      const restored = createPlatform({
        modules: (s) => [createProcurementModule(s)],
        env: { ...process.env, APP_DATA_DIR: copy },
      });
      try {
        expect(restored.services.artifacts.meta(artifact.meta.id, h.ownerId).title).toBe(
          'Do odtworzenia',
        );
        expect(restored.services.artifacts.version(artifact.meta.id, h.ownerId).content).toEqual({
          wartosc: 42,
        });
        expect(restored.services.files.list(h.ownerId)).toHaveLength(files.length);
        expect(restored.services.files.read(files[0]!.id, h.ownerId).bytes.length).toBeGreaterThan(0);
        expect(restored.services.canvas.getState(space.id, h.ownerId).cards).toHaveLength(1);
        // Domain data comes back too, and the module's migrations are not re-run.
        expect(restored.registry.modules).toHaveLength(1);
      } finally {
        restored.close();
        rmSync(copy, { recursive: true, force: true });
      }
    } finally {
      h.dispose();
    }
  });
});

describe('token subskrypcji nie wycieka z aplikacji', () => {
  /**
   * Strong version of the claim in FEEDBACK section 2.
   *
   * `probeAuth()` genuinely reads and parses the credential file — that is the
   * only way to learn the plan and the expiry. What must hold is that no token
   * material leaves this process. The test takes the *real* value from disk and
   * looks for it in everything the application exposes.
   *
   * Skipped when no credential is present, so the suite still runs on a machine
   * that is not logged in.
   */
  const credFile = resolve(
    process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), '.claude'),
    '.credentials.json',
  );

  const readTokens = (): string[] => {
    if (!existsSync(credFile)) return [];
    try {
      const oauth = (JSON.parse(readFileSync(credFile, 'utf8')) as Record<string, any>)
        .claudeAiOauth;
      return [oauth?.accessToken, oauth?.refreshToken].filter(
        (v): v is string => typeof v === 'string' && v.length > 12,
      );
    } catch {
      return [];
    }
  };

  it('rzeczywista wartosc tokena nie wystepuje w wyniku probeAuth()', () => {
    const tokens = readTokens();
    if (tokens.length === 0) {
      expect(probeAuth().credential.present).toBe(false);
      return;
    }
    const serialized = JSON.stringify(probeAuth());
    for (const token of tokens) {
      expect(serialized).not.toContain(token);
      // Also reject a leading fragment, which would be enough to identify it.
      expect(serialized).not.toContain(token.slice(0, 16));
    }
  });

  it('rzeczywista wartosc tokena nie wystepuje w odpowiedzi /api/status', async () => {
    const tokens = readTokens();
    const h = await createHarness({ withModule: false });
    try {
      const cookie = await login(h.platform.app, h.ownerId);
      const text = await (
        await h.platform.app.request('/api/status', { headers: { cookie } })
      ).text();
      for (const token of tokens) {
        expect(text).not.toContain(token);
        expect(text).not.toContain(token.slice(0, 16));
      }
      // The metadata that *is* exposed stays exposed.
      expect(JSON.parse(text).auth).toHaveProperty('apiKeyPolicy', 'refused');
    } finally {
      h.dispose();
    }
  });
});
