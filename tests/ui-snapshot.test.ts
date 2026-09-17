import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGUI_EVENTS,
  AppError,
  PLATFORM_CUSTOM_EVENTS,
  UI_SNAPSHOT_INSTANCES_LIMIT,
  UI_SNAPSHOT_MAX_BYTES,
  appContextSchema,
  compositionVersionOf,
  uiCommandResultSchema,
  uiCommandSchema,
  uiSnapshotSchema,
  type AppContext,
  type CanvasState,
  type SemanticInstance,
  type ToolCallContext,
  type UiCommand,
  type UiSnapshot,
} from '@platform/contracts';
import {
  AgentRuntime,
  RunEventStream,
  assertMcpCompatibleShape,
  buildSystemPrompt,
  collectToolEntries,
  platformTools,
} from '@platform/server';
import {
  UiSnapshotSession,
  buildUiSnapshotContent,
  sessionIdentityStore,
  type UiClientIdentity,
  type UiClientIdentityStore,
  type UiSnapshotContent,
  type UiSnapshotInput,
} from '@platform/ui';
import { resolveLastResult, scriptedAgent, type Step } from '../e2e/support/scripted-agent.ts';
import { createHarness, login, type Harness } from './helpers.ts';

/**
 * The versioned description of the active screen (BL-01: L6.15, L6.17).
 *
 * Three parts, tested apart and then together: the tab assembling and
 * versioning its description, the backend keeping the latest one per owner and
 * tab, and `ui_state` handing the agent the description of *its own*
 * conversation's screen — at least as new as asked, or plainly marked stale.
 *
 * Rodzaj dowodu: test kontraktu lub logiki; wykonanie ze skryptowanym modelem
 * (`AgentRuntime` + `scriptedAgent`) to symulacja.
 */

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(() => h.dispose());

const context = (over: Partial<AppContext> = {}): AppContext => ({
  conversationId: null,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
  ui: null,
  ...over,
});

function instance(id: string, over: Partial<SemanticInstance> = {}): SemanticInstance {
  return {
    instanceId: id,
    component: 'DataTable',
    viewId: 'procurement.data',
    source: { operation: 'procurement.suppliers' },
    state: 'ready',
    error: null,
    record: { kind: 'supplier', idField: 'id' },
    fields: [
      { field: 'name', label: 'Nazwa', type: 'text' },
      { field: 'country', label: 'Kraj', type: 'text' },
    ],
    filter: [{ field: 'country', op: 'eq', value: 'PL' }],
    sort: null,
    page: null,
    visibleRecordIds: ['s1', 's2', 's3'],
    matched: 3,
    total: 4,
    actions: ['filter'],
    ...over,
  };
}

function snapshot(over: Partial<UiSnapshot> = {}): UiSnapshot {
  return {
    version: 1,
    clientId: 'ui_tab_aaaaaaaa',
    capturedAt: new Date().toISOString(),
    conversationId: 'cnv_a',
    spaceId: null,
    url: '/data?country=PL',
    target: { id: 'procurement.data', kind: 'view', label: 'Dostawcy' },
    view: { id: 'procurement.data', title: 'Dostawcy', compositionVersion: 'x-00000000' },
    cards: null,
    cardsOmitted: 0,
    instances: [instance('DataTable-a')],
    instancesOmitted: 0,
    actions: ['navigate', 'filter', 'sort'],
    ...over,
  };
}

const uiStateTool = () => platformTools(h.platform.services).find((t) => t.name === 'ui_state')!;

const toolCtx = (over: Partial<ToolCallContext> = {}): ToolCallContext => ({
  ownerId: h.ownerId,
  appContext: context({ conversationId: 'cnv_a' }),
  conversationId: 'cnv_a',
  runId: 'run_x',
  workspaceDir: null,
  emit: () => {},
  ...over,
});

const callUiState = (input: Record<string, unknown>, over: Partial<ToolCallContext> = {}) =>
  uiStateTool().handler(input as never, toolCtx(over)) as Promise<any>;

/* -------------------------------------------------------------------------- */

describe('kontrakt opisu ekranu', () => {
  it('limity: wersja od 1, identyfikator karty, najwyzej 30 instancji, poprawne opisy instancji', () => {
    expect(uiSnapshotSchema.safeParse(snapshot()).success).toBe(true);
    expect(uiSnapshotSchema.safeParse(snapshot({ version: 0 })).success).toBe(false);
    expect(uiSnapshotSchema.safeParse(snapshot({ version: 1.5 })).success).toBe(false);
    expect(uiSnapshotSchema.safeParse(snapshot({ clientId: 'krotki' })).success).toBe(false);
    expect(uiSnapshotSchema.safeParse(snapshot({ clientId: 'ui tab z spacja' })).success).toBe(false);
    expect(uiSnapshotSchema.safeParse(snapshot({ capturedAt: 'wczoraj' })).success).toBe(false);
    expect(uiSnapshotSchema.safeParse(snapshot({ url: `/${'x'.repeat(2000)}` })).success).toBe(false);

    const many = Array.from({ length: UI_SNAPSHOT_INSTANCES_LIMIT }, (_, i) => instance(`DataTable-${i}`));
    expect(uiSnapshotSchema.safeParse(snapshot({ instances: many })).success).toBe(true);
    expect(uiSnapshotSchema.safeParse(snapshot({ instances: [...many, instance('DataTable-x')] })).success).toBe(false);

    const cards = Array.from({ length: 51 }, (_, i) => ({
      cardId: `crd_${i}`,
      title: 'k',
      kind: 'openui' as const,
      component: 'openui',
      specVersion: 1,
    }));
    expect(uiSnapshotSchema.safeParse(snapshot({ cards: cards.slice(0, 50) })).success).toBe(true);
    expect(uiSnapshotSchema.safeParse(snapshot({ cards })).success).toBe(false);

    // An instance description the registry contract rejects is rejected here too.
    const incoherent = instance('DataTable-bad', { state: 'loading' }); // loading with counts
    expect(uiSnapshotSchema.safeParse(snapshot({ instances: [incoherent] })).success).toBe(false);
  });

  it('wersja kompozycji jest stabilna i rozroznia zrodla', () => {
    const source = 'root = Stack([t])\nt = DataTable({operation: "m.op"})';
    expect(compositionVersionOf(source)).toBe(compositionVersionOf(`${source}`));
    expect(compositionVersionOf(source)).not.toBe(compositionVersionOf(source.replace('m.op', 'm.oq')));
    expect(compositionVersionOf(source)).toMatch(/^[0-9a-z]+-[0-9a-f]{8}$/);
  });

  it('AppContext.ui domyslnie null, wersja od 1; uiVersion w potwierdzeniu jest opcjonalne', () => {
    const parsed = appContextSchema.parse({ conversationId: null, spaceId: null });
    expect(parsed.ui).toBeNull();
    const marker = { version: 4, clientId: 'ui_tab_aaaaaaaa', viewId: 'procurement.data', url: '/data' };
    expect(appContextSchema.parse({ conversationId: null, spaceId: null, ui: marker }).ui).toEqual(marker);
    expect(appContextSchema.safeParse({ conversationId: null, spaceId: null, ui: { ...marker, version: 0 } }).success).toBe(false);

    expect(uiCommandResultSchema.parse({ commandId: 'uic_12345678', executed: true }).uiVersion).toBeUndefined();
    expect(uiCommandResultSchema.parse({ commandId: 'uic_12345678', executed: true, uiVersion: 9 }).uiVersion).toBe(9);
    expect(uiCommandResultSchema.safeParse({ commandId: 'uic_12345678', executed: true, uiVersion: 0 }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('opis ekranu skladany w karcie przegladarki', () => {
  const input = (over: Partial<UiSnapshotInput> = {}): UiSnapshotInput => ({
    url: '/data?country=PL',
    pathname: '/data',
    conversationId: 'cnv_a',
    spaceId: 'spc_1',
    instances: [instance('DataTable-a')],
    targets: h.platform.services.modules.uiTargets(),
    views: h.platform.services.modules.views(),
    canvas: undefined,
    ...over,
  });

  it('widok z trasy celu z wersja kompozycji, instancje, karty przestrzeni i akcje', () => {
    const view = h.platform.services.modules.views().find((v) => v.id === 'procurement.data')!;
    const canvas = {
      space: { id: 'spc_1' },
      cards: [
        { id: 'crd_1', title: 'Tabela', spec: { kind: 'openui', source: 'x' }, specVersion: 3 },
        { id: 'crd_2', title: 'Notatka', spec: { kind: 'component', component: 'platform.markdown' }, specVersion: 1 },
      ],
    } as unknown as CanvasState;

    const content = buildUiSnapshotContent(input({ canvas }));
    expect(content.target).toEqual({ id: 'procurement.data', kind: 'view', label: 'Dostawcy' });
    expect(content.view).toEqual({
      id: 'procurement.data',
      title: view.title,
      compositionVersion: compositionVersionOf(view.composition),
    });
    expect(content.instances.map((i) => i.instanceId)).toEqual(['DataTable-a']);
    expect(content.cards).toEqual([
      { cardId: 'crd_1', title: 'Tabela', kind: 'openui', component: 'openui', specVersion: 3 },
      { cardId: 'crd_2', title: 'Notatka', kind: 'component', component: 'platform.markdown', specVersion: 1 },
    ]);
    expect(content.actions).toEqual(['navigate', 'filter', 'sort']);
    expect(uiSnapshotSchema.safeParse({ ...content, version: 1, clientId: 'ui_tab_aaaaaaaa', capturedAt: new Date().toISOString() }).success).toBe(true);
  });

  it('ekran bez widoku: tylko nawigacja; karty nieznane, gdy przestrzen nie jest wczytana; widok z instancji', () => {
    const files = buildUiSnapshotContent(input({ url: '/files', pathname: '/files', instances: [] }));
    // `/files` has a view target and an element on it: the view is the screen.
    expect(files.target?.id).toBe('platform.files');
    expect(files.view).toBeNull();
    expect(files.actions).toEqual(['navigate']);
    expect(files.cards).toBeNull();
    expect(files.cardsOmitted).toBe(0);

    // Another space's cards in the cache are not this space's.
    const other = { space: { id: 'spc_2' }, cards: [] } as unknown as CanvasState;
    expect(buildUiSnapshotContent(input({ canvas: other })).cards).toBeNull();

    // A record screen with no catalog route: the view comes from the components.
    const detail = buildUiSnapshotContent(input({ url: '/x/1', pathname: '/x/1' }));
    expect(detail.target).toBeNull();
    expect(detail.view?.id).toBe('procurement.data');
    expect(detail.actions).toEqual(['navigate']);
  });

  it('ponad limit instancje sa pominiete i policzone; za duzy opis traci instancje od konca', () => {
    const many = Array.from({ length: 34 }, (_, i) => instance(`DataTable-${i}`));
    const content = buildUiSnapshotContent(input({ instances: many }));
    expect(content.instances).toHaveLength(UI_SNAPSHOT_INSTANCES_LIMIT);
    expect(content.instancesOmitted).toBe(4);
    expect(content.instances[0]!.instanceId).toBe('DataTable-0');

    const fat = Array.from({ length: 20 }, (_, i) =>
      instance(`DataTable-${i}`, {
        filter: Array.from({ length: 28 }, () => ({ field: 'name', op: 'in' as const, value: Array.from({ length: 40 }, () => 'x'.repeat(200)) })),
      }),
    );
    const trimmed = buildUiSnapshotContent(input({ instances: fat }));
    expect(trimmed.instances.length).toBeLessThan(20);
    expect(trimmed.instances.length + trimmed.instancesOmitted).toBe(20);
    expect(new TextEncoder().encode(JSON.stringify(trimmed)).length).toBeLessThanOrEqual(UI_SNAPSHOT_MAX_BYTES);
  });
});

/* -------------------------------------------------------------------------- */

describe('sesja karty: wersje i publikacja', () => {
  function memoryIdentity(initial: UiClientIdentity | null = null) {
    const saved: UiClientIdentity[] = [];
    let value = initial;
    const store: UiClientIdentityStore = {
      load: () => value,
      save: (identity) => {
        value = identity;
        saved.push(identity);
      },
    };
    return { store, saved, get: () => value };
  }

  function session(opts: { identity?: UiClientIdentityStore; send?: (s: UiSnapshot) => Promise<unknown>; scope?: () => string } = {}) {
    const sent: UiSnapshot[] = [];
    let content: UiSnapshotContent = buildUiSnapshotContent({
      url: '/data',
      pathname: '/data',
      conversationId: 'cnv_a',
      spaceId: null,
      instances: [instance('DataTable-a', { filter: [], visibleRecordIds: ['s1', 's2', 's3', 's4'], matched: 4 })],
      targets: h.platform.services.modules.uiTargets(),
      views: h.platform.services.modules.views(),
      canvas: undefined,
    });
    const s = new UiSnapshotSession({
      identity: opts.identity ?? memoryIdentity().store,
      send: opts.send ?? (async (snap) => void sent.push(snap)),
      debounceMs: 20,
      scope: opts.scope ?? (() => 'local-user'),
    });
    s.setSource(() => content);
    return { s, sent, set: (next: Partial<UiSnapshotContent>) => (content = { ...content, ...next }) };
  }

  it('nowa wersja tylko przy istotnej zmianie; wersje rosna i przezywaja przeladowanie karty', async () => {
    const identity = memoryIdentity();
    const { s, set } = session({ identity: identity.store });
    const first = s.capture()!;
    expect(first.version).toBe(1);
    // The same screen assembled again is the same description.
    expect(s.capture()).toBe(first);
    expect(s.capture()!.version).toBe(1);

    set({ url: '/data?country=PL' });
    expect(s.capture()!.version).toBe(2);
    set({ url: '/data?country=PL' });
    expect(s.capture()!.version).toBe(2);
    expect(identity.get()).toEqual({ clientId: first.clientId, version: 2 });

    // A reload of the tab: same identity from storage, the counter continues.
    const reloaded = session({ identity: identity.store });
    expect(reloaded.s.clientId).toBe(first.clientId);
    expect(reloaded.s.capture()!.version).toBe(3);
  });

  it('zmiana zalogowanej tozsamosci daje nowa wersje tego samego ekranu', () => {
    let owner = 'local-user';
    const { s } = session({ scope: () => owner });
    expect(s.capture()!.version).toBe(1);
    owner = 'other-user';
    expect(s.capture()!.version).toBe(2);
  });

  it('publikacja z opoznieniem i flush: kolejno, czeka na przyjecie, zwraca opublikowana wersje', async () => {
    const order: number[] = [];
    let release: (() => void) | null = null;
    const { s, set } = session({
      send: async (snap) => {
        if (snap.version === 1) await new Promise<void>((r) => (release = r));
        order.push(snap.version);
      },
    });

    s.changed();
    s.changed(); // debounced: one capture
    await new Promise((r) => setTimeout(r, 60));
    expect(s.current()!.version).toBe(1);
    expect(s.published()).toBeNull(); // version 1 still on its way

    set({ url: '/data?country=FI' });
    const flushing = s.flush({ timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual([]); // version 2 waits for version 1
    release!();
    const published = await flushing;
    expect(order).toEqual([1, 2]);
    expect(published?.version).toBe(2);
    expect(s.contextMarker()).toEqual({ version: 2, clientId: s.clientId, viewId: 'procurement.data', url: '/data?country=FI' });

    // Nothing changed: flushing again sends nothing and answers with the same version.
    expect((await s.flush())?.version).toBe(2);
    expect(order).toEqual([1, 2]);
  });

  it('flush nie czeka dluzej niz timeout, gdy backend nie odpowiada', async () => {
    const { s } = session({ send: () => new Promise(() => {}) });
    const started = Date.now();
    expect(await s.flush({ timeoutMs: 80 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('konflikt wersji: karta bierze nowa tozsamosc i publikuje ten sam opis jako wersje 1', async () => {
    const identity = memoryIdentity({ clientId: 'ui_copied_tab_id', version: 5 });
    const attempts: UiSnapshot[] = [];
    const { s } = session({
      identity: identity.store,
      send: async (snap) => {
        attempts.push(snap);
        if (snap.clientId === 'ui_copied_tab_id') throw new AppError('conflict', 'wersja nie nowsza');
      },
    });
    const published = await s.flush();
    expect(attempts.map((a) => [a.clientId === 'ui_copied_tab_id', a.version])).toEqual([[true, 6], [false, 1]]);
    expect(published?.clientId).not.toBe('ui_copied_tab_id');
    expect(published?.version).toBe(1);
    expect(identity.get()).toEqual({ clientId: published!.clientId, version: 1 });
    expect(s.contextMarker()?.clientId).toBe(published!.clientId);
  });

  it('niedostepny sessionStorage: tozsamosc w pamieci, bez wyjatku', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage disabled');
      },
    });
    try {
      const store = sessionIdentityStore();
      expect(store.load()).toBeNull();
      expect(() => store.save({ clientId: 'ui_tab_aaaaaaaa', version: 1 })).not.toThrow();
      const s = new UiSnapshotSession({ identity: store, send: async () => {}, scope: () => 'x' });
      s.setSource(() => buildUiSnapshotContent({ url: '/', pathname: '/', conversationId: null, spaceId: null, instances: [], targets: [], views: [], canvas: undefined }));
      expect(s.capture()!.version).toBe(1);
      expect(s.clientId).toMatch(/^ui_[A-Za-z0-9]{8,}$/);
    } finally {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
      else delete (globalThis as Record<string, unknown>).sessionStorage;
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('PUT i GET /api/ui/snapshot', () => {
  const put = (cookie: string, body: unknown) =>
    h.platform.app.request('/api/ui/snapshot', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const get = (cookie: string, query: string) =>
    h.platform.app.request(`/api/ui/snapshot?${query}`, { headers: { cookie } });

  it('wlasciciel z sesji publikuje, a odczyt po rozmowie i po karcie zwraca ten opis', async () => {
    const cookie = await login(h.platform.app, h.ownerId);
    const res = await put(cookie, snapshot({ version: 3 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, version: 3, clientId: 'ui_tab_aaaaaaaa' });

    const byConversation = await (await get(cookie, 'conversationId=cnv_a')).json();
    expect(byConversation.stale).toBe(false);
    expect(byConversation.version).toBe(3);
    expect(byConversation.snapshot.instances[0].visibleRecordIds).toEqual(['s1', 's2', 's3']);
    expect(byConversation.ageMs).toBeGreaterThanOrEqual(0);

    const byClient = await (await get(cookie, 'clientId=ui_tab_aaaaaaaa')).json();
    expect(byClient.snapshot.version).toBe(3);
  });

  it('drugi wlasciciel nie odczyta ani nie nadpisze opisu pierwszego', async () => {
    const mine = await login(h.platform.app, h.ownerId);
    const theirs = await login(h.platform.app, h.otherOwnerId);
    expect((await put(mine, snapshot({ version: 3 }))).status).toBe(200);

    expect(await (await get(theirs, 'conversationId=cnv_a')).json()).toMatchObject({ snapshot: null, reason: 'no_client', stale: true });
    expect(await (await get(theirs, 'clientId=ui_tab_aaaaaaaa')).json()).toEqual({ snapshot: null });

    // The same tab id under another owner is another owner's tab: version 1 is accepted there…
    expect((await put(theirs, snapshot({ version: 1, url: '/cudzy' }))).status).toBe(200);
    // …and the first owner still reads its own version 3.
    const own = await (await get(mine, 'conversationId=cnv_a')).json();
    expect(own.version).toBe(3);
    expect(own.snapshot.url).toBe('/data?country=PL');

    // The agent of the other owner, in a run of the same conversation id, gets nothing of it either.
    const r = await callUiState({}, { ownerId: h.otherOwnerId, conversationId: 'cnv_b', appContext: context({ conversationId: 'cnv_b' }) });
    expect(r).toMatchObject({ snapshot: null, reason: 'other_conversation' });
    const mineTool = await callUiState({});
    expect(mineTool.snapshot.url).toBe('/data?country=PL');
  });

  it('odmowy: bez sesji 401, zly opis 400, za duzy 400, wersja nie nowsza 409, powtorzenie tej samej 200', async () => {
    const cookie = await login(h.platform.app, h.ownerId);
    expect((await put('', snapshot())).status).toBe(401);

    const bad = await put(cookie, { ...snapshot(), version: 0 });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.details.reason).toBe('invalid_snapshot');
    expect((await put(cookie, '{nie json')).status).toBe(400);

    const huge = await put(cookie, snapshot({ url: '/x', conversationId: 'c'.repeat(100), instances: [instance('a', { filter: [] })], actions: ['x'.repeat(UI_SNAPSHOT_MAX_BYTES)] }));
    expect(huge.status).toBe(400);
    expect((await huge.json()).error.details.reason).toBe('too_large');

    expect((await put(cookie, snapshot({ version: 5 }))).status).toBe(200);
    // Retried publication of the same description: accepted, nothing changes.
    expect((await put(cookie, snapshot({ version: 5, capturedAt: new Date(Date.now() + 5).toISOString() }))).status).toBe(200);
    const older = await put(cookie, snapshot({ version: 4 }));
    expect(older.status).toBe(409);
    expect((await older.json()).error.details).toEqual({ reason: 'version_not_newer', current: 5 });
    const sameVersionOtherContent = await put(cookie, snapshot({ version: 5, url: '/files' }));
    expect(sameVersionOtherContent.status).toBe(409);
    expect((await (await get(cookie, 'conversationId=cnv_a')).json()).snapshot.url).toBe('/data?country=PL');

    expect((await get(cookie, '')).status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */

describe('narzedzie ui_state', () => {
  const store = () => h.platform.services.uiSnapshots;

  it('no_client, other_conversation i swiezy opis rozmowy wykonania', async () => {
    const none = await callUiState({});
    expect(none).toEqual({ stale: true, reason: 'no_client', version: null, capturedAt: null, ageMs: null, snapshot: null });
    // The verdict comes first, so a shortened echo of the answer still carries it.
    expect(Object.keys(none).slice(0, 2)).toEqual(['stale', 'reason']);

    // The user's tab shows conversation B while the run belongs to A.
    store().publish(h.ownerId, snapshot({ conversationId: 'cnv_b' }));
    expect(await callUiState({})).toMatchObject({ snapshot: null, stale: true, reason: 'other_conversation' });

    // A tab showing a new, unsaved conversation is not showing A either.
    store().publish(h.ownerId, snapshot({ clientId: 'ui_tab_new_chat', conversationId: null }));
    expect((await callUiState({})).reason).toBe('other_conversation');

    // Tab moves to A: now it is described, fresh.
    store().publish(h.ownerId, snapshot({ version: 2, conversationId: 'cnv_a' }));
    const fresh = await callUiState({});
    expect(fresh.stale).toBe(false);
    expect(fresh.reason).toBeUndefined();
    expect(fresh.version).toBe(2);
    expect(fresh.snapshot.conversationId).toBe('cnv_a');

    // …and moves away again: the description it gave of A is no longer handed out.
    store().publish(h.ownerId, snapshot({ version: 3, conversationId: 'cnv_b' }));
    expect((await callUiState({})).reason).toBe('other_conversation');

    // Outside a conversation there is nothing to describe.
    const refused = await uiStateTool().handler({} as never, toolCtx({ conversationId: null, appContext: context() })).catch((e) => e);
    expect(refused).toBeInstanceOf(AppError);
  });

  it('minVersion czeka na publikacje i zwraca nowsza wersje', async () => {
    store().publish(h.ownerId, snapshot({ version: 4, instances: [] }));
    setTimeout(() => store().publish(h.ownerId, snapshot({ version: 5 })), 150);
    const started = Date.now();
    const result = await callUiState({ minVersion: 5, waitMs: 2000 });
    const waited = Date.now() - started;
    expect(result.stale).toBe(false);
    expect(result.version).toBe(5);
    expect(result.snapshot.instances[0].filter).toEqual([{ field: 'country', op: 'eq', value: 'PL' }]);
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThan(2000);
  });

  it('minVersion po przekroczeniu czasu: stale=true, older_than_requested i starszy opis', async () => {
    store().publish(h.ownerId, snapshot({ version: 4 }));
    // Unrelated publications during the wait do not satisfy it.
    setTimeout(() => store().publish(h.ownerId, snapshot({ clientId: 'ui_tab_other_one', conversationId: 'cnv_z' })), 100);
    const started = Date.now();
    const result = await callUiState({ minVersion: 9, waitMs: 400 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
    expect(result).toMatchObject({ stale: true, reason: 'older_than_requested', version: 4 });
    expect(result.snapshot.version).toBe(4);

    // No minimum version and no wait: a single evaluation, answered at once.
    const t0 = Date.now();
    await callUiState({});
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('karta, z ktorej wyslano polecenie, ma pierwszenstwo, a jej wersja z kontekstu jest dolna granica', async () => {
    store().publish(h.ownerId, snapshot({ clientId: 'ui_tab_sender_01', version: 3 }));
    store().publish(h.ownerId, snapshot({ clientId: 'ui_tab_second_02', version: 8, url: '/data' }));
    const marker = (version: number) => context({ conversationId: 'cnv_a', ui: { version, clientId: 'ui_tab_sender_01', viewId: 'procurement.data', url: '/data?country=PL' } });

    // Without a context, the most recent tab showing the conversation.
    expect((await callUiState({})).snapshot.clientId).toBe('ui_tab_second_02');
    // With it, the sender's tab.
    const sender = await callUiState({}, { appContext: marker(3) });
    expect(sender.snapshot.clientId).toBe('ui_tab_sender_01');
    expect(sender.stale).toBe(false);
    // The sender's tab at a version older than the one the command was sent with is stale.
    const behind = await callUiState({}, { appContext: marker(4) });
    expect(behind).toMatchObject({ stale: true, reason: 'older_than_requested', version: 3 });
  });

  it('wejscie zgodne z MCP, waitMs najwyzej 5000', () => {
    const tool = uiStateTool();
    expect(tool.effect).toBe('read');
    expect(tool.alwaysLoad).toBe(true);
    expect(() => assertMcpCompatibleShape('ui_state', tool.inputSchema.shape as Record<string, unknown>)).not.toThrow();
    expect(tool.inputSchema.safeParse({ waitMs: 5000 }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ waitMs: 5001 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ minVersion: 0 }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('AppContext.ui w wykonaniu', () => {
  it('wykonanie dostaje marker ekranu z chwili wyslania: get_context go podaje, ui_state liczy od niego', async () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, firstMessage: { content: 'test' } });
    h.platform.services.uiSnapshots.publish(h.ownerId, snapshot({ clientId: 'ui_tab_sender_01', version: 6, conversationId: conv.id }));

    const steps: Step[] = [
      { kind: 'call', name: 'get_context', maxChars: 4000 },
      { kind: 'call', name: 'ui_state', maxChars: 4000 },
    ];
    const runtime = new AgentRuntime(
      h.platform.services,
      scriptedAgent(steps, {
        tools: () => collectToolEntries({ registry: h.platform.registry, platformTools: platformTools(h.platform.services) }),
      }),
    );
    // Parsed the way POST /api/agui/run parses the body the browser sent.
    const appContext = appContextSchema.parse({
      conversationId: conv.id,
      spaceId: null,
      ui: { version: 7, clientId: 'ui_tab_sender_01', viewId: 'procurement.data', url: '/data?country=PL' },
    });
    const started = await runtime.start({ ownerId: h.ownerId, conversationId: conv.id, prompt: 'test', appContext });
    const results: any[] = [];
    for await (const { event } of started.stream.read(0)) {
      const e = event as Record<string, any>;
      if (e.type === AGUI_EVENTS.TOOL_CALL_RESULT) results.push(JSON.parse(e.content));
    }
    await started.done;

    expect(results[0].ui).toEqual({ version: 7, clientId: 'ui_tab_sender_01', viewId: 'procurement.data', url: '/data?country=PL' });
    // The server has version 6 of the sender's tab; the command was sent at 7: older than what the user saw.
    expect(results[1]).toMatchObject({ stale: true, reason: 'older_than_requested', version: 6 });
  });

  it('prompt podaje wersje ekranu z chwili wyslania i zasade odczytu ui_state po akcji', () => {
    const base = {
      registry: h.platform.registry,
      catalog: h.platform.services.catalog,
      resourceSummary: null,
      workspaceDir: null,
      stagedFiles: [],
      toolkit: [],
    };
    const withUi = buildSystemPrompt({
      ...base,
      appContext: context({ ui: { version: 12, clientId: 'ui_tab_sender_01', viewId: 'procurement.data', url: '/data?country=PL' } }),
    });
    expect(withUi).toContain('- ekran przy wyslaniu polecenia: opis w wersji 12 (karta ui_tab_sender_01), widok procurement.data, adres /data?country=PL');
    expect(withUi).toContain('Po ui_navigate, ui_filter lub ui_sort wywolaj ui_state z minVersion = uiVersion z ich wyniku');
    expect(buildSystemPrompt({ ...base, appContext: context() })).toContain('- ekran przy wyslaniu polecenia: (brak opisu)');
  });
});

/* -------------------------------------------------------------------------- */

describe('potwierdzenie komendy UI niesie uiVersion', () => {
  it('ui_filter i ui_navigate przekazuja uiVersion z potwierdzenia klienta; /ui-ack je przyjmuje', async () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, firstMessage: { content: 'x' } });
    const run = h.platform.services.runs.start({
      conversationId: conv.id,
      ownerId: h.ownerId,
      prompt: 'x',
      appContext: context({ conversationId: conv.id }),
      workspaceDir: null,
      abort: new AbortController(),
    });
    const runtime = h.platform.runtime;
    const stream = new RunEventStream(run.id, h.platform.services.runs);
    const cookie = await login(h.platform.app, h.ownerId);
    let version = 10;
    const acks: unknown[] = [];
    const watcher = (async () => {
      for await (const { event } of stream.read(0)) {
        const e = event as Record<string, unknown>;
        if (e.type === 'CUSTOM' && e.name === PLATFORM_CUSTOM_EVENTS.uiCommand) {
          const command: UiCommand = uiCommandSchema.parse(e.value);
          version += 1;
          // Through the HTTP acknowledgement, as the browser posts it, awaited like a real consumer.
          const res = await h.platform.app.request(`/api/runs/${run.id}/ui-ack`, {
            method: 'POST',
            headers: { cookie, 'content-type': 'application/json' },
            body: JSON.stringify({
              commandId: command.commandId,
              targetId: command.targetId,
              executed: true,
              url: '/data',
              ...(command.filter ? { filtered: { matched: 3, total: 4 } } : {}),
              uiVersion: version,
            }),
          });
          acks.push(await res.json());
        }
      }
    })();
    const ctx: ToolCallContext = {
      ...toolCtx({ conversationId: conv.id, runId: run.id }),
      requestUi: (command) =>
        runtime.requestUiCommand(
          {
            commandId: `uic_${Math.random().toString(36).slice(2, 12)}`,
            runId: run.id,
            conversationId: conv.id,
            targetId: command.targetId,
            spaceId: command.spaceId ?? null,
            ...(command.filter !== undefined ? { filter: command.filter } : {}),
          },
          stream,
          2000,
        ),
    };
    const tools = platformTools(h.platform.services);
    const filtered = (await tools.find((t) => t.name === 'ui_filter')!.handler(
      { targetId: 'procurement.data', predicates: [{ field: 'country', op: 'eq', value: 'PL' }], label: 'PL' } as never,
      ctx,
    )) as any;
    const navigated = (await tools.find((t) => t.name === 'ui_navigate')!.handler({ targetId: 'procurement.data' } as never, ctx)) as any;
    stream.close();
    await watcher;
    expect(acks).toEqual([{ accepted: true }, { accepted: true }]);
    expect(filtered).toMatchObject({ executed: true, filtered: { matched: 3, total: 4 }, uiVersion: 11 });
    expect(navigated).toMatchObject({ executed: true, uiVersion: 12 });
  });
});

describe('strumien wykonania nie wstrzymuje zdarzenia wyemitowanego w trakcie obslugi poprzedniego', () => {
  it('czytelnik zajety poprzednim zdarzeniem dostaje nastepne bez czekania na kolejne', async () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, firstMessage: { content: 'x' } });
    const run = h.platform.services.runs.start({
      conversationId: conv.id,
      ownerId: h.ownerId,
      prompt: 'x',
      appContext: context({ conversationId: conv.id }),
      workspaceDir: null,
      abort: new AbortController(),
    });
    const stream = new RunEventStream(run.id, h.platform.services.runs);
    const seen: string[] = [];
    let second: (() => void) | null = null;
    const secondSeen = new Promise<void>((r) => (second = r));
    const reader = (async () => {
      for await (const { event } of stream.read(0)) {
        const name = String((event as Record<string, unknown>).name);
        seen.push(name);
        if (name === 'pierwsze') {
          // The consumer is busy (a socket write): the next event is emitted meanwhile.
          stream.custom('drugie', {});
          await new Promise((r) => setTimeout(r, 20));
        }
        if (name === 'drugie') second!();
      }
    })();
    stream.custom('pierwsze', {});
    const delivered = await Promise.race([secondSeen.then(() => true), new Promise((r) => setTimeout(() => r(false), 500))]);
    stream.close();
    await reader;
    // Nothing else is emitted: without the fix the second event waits for close.
    expect(delivered).toBe(true);
    expect(seen).toEqual(['pierwsze', 'drugie']);
  });
});

describe('krok call skryptowanego modelu: wartosc z poprzedniego wyniku', () => {
  it('$last.<sciezka> podstawia wartosc poprzedniego wyniku; brak wartosci to null, nie pominiecie', () => {
    const last = { executed: true, uiVersion: 7, nested: { a: [1] } };
    expect(resolveLastResult({ minVersion: '$last.uiVersion', keep: 'tekst', n: 2 }, last)).toEqual({ minVersion: 7, keep: 'tekst', n: 2 });
    expect(resolveLastResult({ x: ['$last.nested.a'] }, last)).toEqual({ x: [[1]] });
    expect(resolveLastResult({ minVersion: '$last.brak' }, last)).toEqual({ minVersion: null });
    expect(resolveLastResult({ minVersion: '$last.uiVersion' }, null)).toEqual({ minVersion: null });
  });
});
