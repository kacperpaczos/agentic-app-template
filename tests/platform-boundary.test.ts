import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatform, DEFAULT_USER_ID, type PlatformInstance } from '@platform/server';
import { createProbeModule } from '@module/devkit-probe/server';
import { login, testGlmEnv } from './helpers.ts';

/**
 * The platform must be usable without the procurement module. If any of these
 * fail, the "platform / business module" split is decoration rather than
 * architecture.
 */
describe('platforma dziala bez modulu zakupowego', () => {
  const disposers: Array<() => void> = [];
  const boot = (modules: 'none' | 'probe') => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentic-boundary-'));
    const env = testGlmEnv(dataDir);
    const platform = createPlatform({
      modules: modules === 'none' ? [] : (services) => [createProbeModule(services)],
      env,
    });
    disposers.push(() => {
      platform.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    return platform;
  };

  afterEach(() => {
    while (disposers.length) disposers.pop()?.();
  });

  it('startuje z pustym rejestrem modulow', () => {
    const p: PlatformInstance = boot('none');
    expect(p.registry.modules).toHaveLength(0);
    expect(p.registry.tools).toHaveLength(0);
    // The domain-agnostic catalog is still there.
    expect(p.services.catalog.list().map((c) => c.id)).toEqual(
      expect.arrayContaining(['platform.markdown', 'platform.artifact', 'platform.files']),
    );
  });

  it('bez modulu serwuje pusty stan zamiast bledu', async () => {
    const p = boot('none');
    const cookie = await login(p.app, DEFAULT_USER_ID);
    const res = await p.app.request('/api/status', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.modules).toEqual([]);
    expect(body.tools).toEqual([]);
    // The platform's own tools are always present.
    expect(body.platformTools).toEqual(expect.arrayContaining(['mcp__app__get_context']));

    const spaces = await p.app.request('/api/canvas/spaces', { headers: { cookie } });
    expect((await spaces.json()).spaces).toEqual([]);
  });

  it('bez modulu nie ma tabel domenowych zakupowych', () => {
    const p = boot('none');
    const tables = p.db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.some((t) => t.name.startsWith('pc_'))).toBe(false);
    expect(tables.some((t) => t.name === 'canvas_cards')).toBe(true);
  });

  it('przyjmuje dowolny modul testowy: migracja, narzedzie, trasa, komponent', async () => {
    const p = boot('probe');
    const cookie = await login(p.app, DEFAULT_USER_ID);

    // migration ran
    const tables = p.db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='probe_notes'")
      .all();
    expect(tables).toHaveLength(1);

    // tools registered with the module namespace
    expect(p.registry.tools.map((t) => t.qualifiedName)).toEqual(
      expect.arrayContaining(['probe_add_note', 'probe_list_notes']),
    );

    // catalog extended
    expect(p.services.catalog.has('probe.noteList')).toBe(true);

    // route mounted under the module prefix
    const res = await p.app.request('/api/m/probe/notes', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).notes).toEqual([]);

    // the tool actually writes through the module's own handler
    await p.registry.callTool(
      'probe_add_note',
      // operationId required since L9.7's closure — see `module-devkit-probe/src/server/index.ts`.
      { text: 'notatka z testu', operationId: 'probe-add-note-boundary-1' },
      {
        ownerId: DEFAULT_USER_ID,
        appContext: {
          conversationId: null, spaceId: null, resource: null,
          selection: [], filters: {}, viewport: null, drafts: [], ui: null,
        },
        conversationId: null,
        runId: null,
        workspaceDir: null,
        emit: () => {},
      },
    );
    const after = await (await p.app.request('/api/m/probe/notes', { headers: { cookie } })).json();
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0].text).toBe('notatka z testu');
  });

  /*
   * L9.7, fourth tool found by the audit and not named in the original gap:
   * `probe_add_note` inserted a row with no `operationId` at all, the same
   * defect class as `canvas_add_card` before it was fixed. It is a devkit
   * module never installed by the real app (`apps/server/src/compose.ts`
   * loads only the procurement module), but the pattern is the same, so the
   * fix is the same — required `operationId`, wired through the shared
   * `IdempotencyStore` — and it gets the same proof: a repeat under one key
   * is one row, checked in the database.
   */
  it('L9.7: probe_add_note wymaga operationId, a powtorzenie z tym samym kluczem daje jeden wiersz', async () => {
    const p = boot('probe');
    const ctx = {
      ownerId: DEFAULT_USER_ID,
      appContext: {
        conversationId: null, spaceId: null, resource: null,
        selection: [], filters: {}, viewport: null, drafts: [], ui: null,
      },
      conversationId: null,
      runId: null,
      workspaceDir: null,
      emit: () => {},
    };
    const notesOf = () =>
      (p.db.$client.prepare('SELECT COUNT(*) AS n FROM probe_notes WHERE owner_id = ?').get(DEFAULT_USER_ID) as {
        n: number;
      }).n;

    await expect(p.registry.callTool('probe_add_note', { text: 'bez klucza' }, ctx)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(notesOf(), 'wywolanie bez operationId nie powinno bylo nic zapisac').toBe(0);

    const operationId = 'probe-add-note-repeat-1';
    await p.registry.callTool('probe_add_note', { text: 'z kluczem', operationId }, ctx);
    await p.registry.callTool('probe_add_note', { text: 'z kluczem', operationId }, ctx);
    expect(notesOf(), 'probe_add_note zdublowal mimo tego samego operationId').toBe(1);
  });

  it('domyslna kompozycja modulu testowego jest walidowana tym samym katalogiem', async () => {
    const p = boot('probe');
    const cookie = await login(p.app, DEFAULT_USER_ID);
    const res = await p.app.request('/api/canvas/spaces/for-scope', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'probe', id: 'x1', title: 'Test' }),
    });
    expect(res.status).toBe(200);
    const state = (await res.json()) as any;
    expect(state.created).toBe(true);
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0].spec.component).toBe('probe.noteList');
    // The default `limit` from the component schema was applied by validation.
    expect(state.cards[0].spec.props.limit).toBe(20);
  });
});
