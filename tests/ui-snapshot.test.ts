import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGUI_EVENTS,
  AppError,
  PLATFORM_CUSTOM_EVENTS,
  UI_CLIENT_INACTIVE_AFTER_MS,
  UI_COMMAND_ACK_MARGIN_MS,
  UI_COMMAND_ACK_TIMEOUT_MS,
  UI_SNAPSHOT_INSTANCES_LIMIT,
  UI_URL_MAX_LENGTH,
  UI_SNAPSHOT_MAX_BYTES,
  appContextSchema,
  clampUiUrl,
  compositionVersionOf,
  parseRunAppContext,
  uiCommandResultSchema,
  uiCommandSchema,
  uiSnapshotSchema,
  type AppContext,
  type CanvasState,
  type SemanticInstance,
  type ToolCallContext,
  type UiCommand,
  type UiCommandResult,
  type UiSnapshot,
} from '@platform/contracts';
import {
  AgentRuntime,
  RunEventStream,
  UiSnapshotStore,
  assertMcpCompatibleShape,
  buildSystemPrompt,
  collectToolEntries,
  createPlatform,
  platformTools,
  type PlatformInstance,
} from '@platform/server';
import {
  AccessContextChanged,
  UiSnapshotSession,
  accessScope,
  apiPut,
  buildUiSnapshotContent,
  createShellSnapshotSource,
  listInstances,
  registerInstance,
  unregisterInstance,
  useUiSemantics,
  performAndAcknowledge,
  qk,
  resetAccessContext,
  setAccessContext,
  sessionIdentityStore,
  type UiClientIdentity,
  type UiClientIdentityStore,
  type UiPublication,
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
    urlTruncated: false,
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

/** The description a flush got accepted, or null (timeout, refusal). */
const accepted = async (p: Promise<UiPublication>) => {
  const r = await p;
  return r.status === 'published' ? r.snapshot : null;
};

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
    const flushing = accepted(s.flush({ timeoutMs: 1000 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual([]); // version 2 waits for version 1
    release!();
    const published = await flushing;
    expect(order).toEqual([1, 2]);
    expect(published?.version).toBe(2);
    expect(s.contextMarker()).toEqual({ version: 2, clientId: s.clientId, viewId: 'procurement.data', url: '/data?country=FI' });

    // A debounced change that changes nothing sends nothing…
    s.changed();
    await new Promise((r) => setTimeout(r, 60));
    expect(order).toEqual([1, 2]);
    // …while a flush sends the same version again (the backend may have restarted).
    expect((await accepted(s.flush()))?.version).toBe(2);
    expect(order).toEqual([1, 2, 2]);
  });

  it('po restarcie backendu (pusty magazyn) flush przed poleceniem publikuje ekran ponownie, bez nowej wersji', async () => {
    let store = new UiSnapshotStore();
    const { s } = session({ send: async (snap) => store.publish(h.ownerId, snap) });
    const first = await accepted(s.flush());
    expect(store.evaluate(h.ownerId, 'cnv_a').version).toBe(first!.version);

    store = new UiSnapshotStore(); // the backend restarted: descriptions live in memory
    expect(store.evaluate(h.ownerId, 'cnv_a').reason).toBe('no_client');

    const again = await accepted(s.flush());
    expect(again!.version).toBe(first!.version);
    expect(store.evaluate(h.ownerId, 'cnv_a')).toMatchObject({ stale: false, version: first!.version });
  });

  it('flush nie czeka dluzej niz timeout, gdy backend nie odpowiada', async () => {
    const { s } = session({ send: () => new Promise(() => {}) });
    const started = Date.now();
    expect(await s.flush({ timeoutMs: 80 })).toEqual({ status: 'timeout' });
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
    const published = await accepted(s.flush());
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
    expect(withUi).toContain(
      'Po ui_navigate, ui_filter lub ui_sort wywolaj ui_state z minVersion = uiVersion i clientId = uiClientId z ich wyniku',
    );
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

/* ========================================================================== */
/*  Fix round 1: long addresses, tab-bound versions, closed tabs, cache       */
/*  eviction, acknowledgement budget                                          */
/* ========================================================================== */

const LONG_URL = `/data?country=${Array.from({ length: 40 }, () => 'Q'.repeat(200)).join(',')}`;

describe('I1: bardzo dlugi adres zawezonego widoku', () => {
  it('opis i marker polecenia skracaja adres do limitu z jawna flaga, a wynik spelnia kontrakty', () => {
    expect(LONG_URL.length).toBeGreaterThan(UI_URL_MAX_LENGTH);
    expect(clampUiUrl('/data')).toEqual({ url: '/data', urlTruncated: false });

    const s = new UiSnapshotSession({ identity: sessionIdentityStore(), send: async () => {}, scope: () => 'x' });
    let url = LONG_URL;
    s.setSource(() =>
      buildUiSnapshotContent({
        url,
        pathname: '/data',
        conversationId: 'cnv_a',
        spaceId: null,
        instances: [],
        targets: h.platform.services.modules.uiTargets(),
        views: h.platform.services.modules.views(),
        canvas: undefined,
      }),
    );
    const long = s.capture()!;
    expect(long.url).toHaveLength(UI_URL_MAX_LENGTH);
    expect(LONG_URL.startsWith(long.url)).toBe(true);
    expect(long.urlTruncated).toBe(true);
    expect(uiSnapshotSchema.safeParse(long).success).toBe(true);

    const marker = s.contextMarker()!;
    expect(marker).toMatchObject({ url: long.url, urlTruncated: true });
    expect(appContextSchema.safeParse(context({ ui: marker })).success).toBe(true);

    url = '/data?country=PL';
    expect(s.capture()!.urlTruncated).toBe(false);
    expect(s.contextMarker()).not.toHaveProperty('urlTruncated');
  });

  it('zly znacznik ekranu nie odrzuca polecenia: ui = null z powodem; inne bledy kontekstu nadal odrzucaja', () => {
    const raw = { conversationId: 'cnv_a', spaceId: null, ui: { version: 3, clientId: 'ui_tab_aaaaaaaa', viewId: null, url: 'x'.repeat(5000) } };
    const { context: parsed, uiRejected } = parseRunAppContext(raw);
    expect(parsed.ui).toBeNull();
    expect(parsed.conversationId).toBe('cnv_a');
    expect(uiRejected?.[0]).toMatch(/^ui\.url:/);
    expect(parseRunAppContext({ conversationId: 'cnv_a', spaceId: null }).uiRejected).toBeNull();
    expect(() => parseRunAppContext({ conversationId: 7, spaceId: null, ui: null })).toThrow();
  });

  it('POST /api/agui/run ze zlym znacznikiem ekranu uruchamia wykonanie bez niego i to zglasza', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentic-uistate-'));
    let platform: PlatformInstance;
    platform = createPlatform({
      modules: [],
      env: { ...process.env, APP_DATA_DIR: dataDir },
      modelAgent: scriptedAgent([{ kind: 'call', name: 'get_context', maxChars: 4000 }], {
        tools: () => collectToolEntries({ registry: platform.registry, platformTools: platformTools(platform.services) }),
      }),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cookie = await login(platform.app, h.ownerId);
      const res = await platform.app.request('/api/agui/run', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: null,
          messages: [{ id: 'msg_long_url_1', role: 'user', content: 'Co mam na ekranie?' }],
          context: context({ ui: { version: 2, clientId: 'ui_tab_aaaaaaaa', viewId: 'x', url: LONG_URL } }),
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('X-Ui-Context-Rejected')).toBe('1');
      const body = await res.text();
      expect(body).toContain('RUN_FINISHED');
      const result = body
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => JSON.parse(l.slice(6)))
        .find((e) => e.type === AGUI_EVENTS.TOOL_CALL_RESULT);
      expect(JSON.parse(result.content).ui).toBeNull();
      expect(warn.mock.calls.flat().join(' ')).toContain('AppContext.ui');
    } finally {
      warn.mockRestore();
      platform.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('odrzucona publikacja nie ginie po cichu: wynik rejected, zapamietany powod i zgloszenie', async () => {
    const reports: string[] = [];
    const s = new UiSnapshotSession({
      identity: sessionIdentityStore(),
      send: async () => {
        throw new AppError('validation_failed', 'Nieprawidlowy opis interfejsu.', { reason: 'invalid_snapshot' });
      },
      scope: () => 'x',
      report: (message) => void reports.push(message),
    });
    s.setSource(() => buildUiSnapshotContent({ url: '/', pathname: '/', conversationId: null, spaceId: null, instances: [], targets: [], views: [], canvas: undefined }));
    expect(await s.flush()).toEqual({ status: 'rejected', code: 'validation_failed' });
    expect(s.lastRejection()).toMatchObject({ version: 1, code: 'validation_failed', details: { reason: 'invalid_snapshot' } });
    expect(reports[0]).toContain('wersji 1 nie zostal opublikowany: validation_failed');
    expect(s.published()).toBeNull();
  });
});

describe('I2: wersja nalezy do karty, zamkniete i milczace karty', () => {
  it('wersja z potwierdzenia jest liczona na karcie, ktora potwierdzila — nie na karcie o wiekszym liczniku', async () => {
    const store = h.platform.services.uiSnapshots;
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, firstMessage: { content: 'x' } });
    const X = 'ui_tab_x_sender_';
    const Y = 'ui_tab_y_reattached';
    // X sent the command and has counted to 40; Y (the same conversation, re-attached) is at 3.
    store.publish(h.ownerId, snapshot({ clientId: X, version: 40, conversationId: conv.id, url: '/data' }));
    store.publish(h.ownerId, snapshot({ clientId: Y, version: 3, conversationId: conv.id, url: '/data' }));

    const steps: Step[] = [
      { kind: 'call', name: 'ui_filter', input: { targetId: 'procurement.data', predicates: [{ field: 'country', op: 'eq', value: 'PL' }], label: 'PL' } },
      // No tab named: the version belongs to the tab that acknowledged.
      { kind: 'call', name: 'ui_state', input: { minVersion: '$last.uiVersion', waitMs: 150 } },
      { kind: 'wait', delayMs: 300 },
      { kind: 'call', name: 'ui_state', input: { minVersion: 4, clientId: Y } },
      { kind: 'wait', delayMs: 400 },
      // Y has closed meanwhile; X still shows the conversation at 40. The version is Y's, not X's.
      { kind: 'call', name: 'ui_state', input: { minVersion: 4, waitMs: 0 } },
      { kind: 'call', name: 'ui_state', input: { clientId: 'ui_tab_closed_long_ago' } },
    ];
    const runtime = new AgentRuntime(
      h.platform.services,
      scriptedAgent(steps, {
        tools: () => collectToolEntries({ registry: h.platform.registry, platformTools: platformTools(h.platform.services) }),
      }),
    );
    const appContext = context({ conversationId: conv.id, ui: { version: 40, clientId: X, viewId: 'procurement.data', url: '/data' } });
    const started = await runtime.start({ ownerId: h.ownerId, conversationId: conv.id, prompt: 'x', appContext });
    const results: any[] = [];
    for await (const { event } of started.stream.read(0)) {
      const e = event as Record<string, any>;
      if (e.type === 'CUSTOM' && e.name === PLATFORM_CUSTOM_EVENTS.uiCommand) {
        const command = uiCommandSchema.parse(e.value);
        // Tab Y acknowledges first with its version 4, which reaches the backend only a moment later.
        runtime.acknowledgeUiCommand({ commandId: command.commandId, targetId: command.targetId, executed: true, filtered: { matched: 3, total: 4 }, uiVersion: 4, uiClientId: Y, uiPublication: 'published' });
        setTimeout(() => store.publish(h.ownerId, snapshot({ clientId: Y, version: 4, conversationId: conv.id, url: '/data?country=PL' })), 250);
        setTimeout(() => store.retire(h.ownerId, Y, 4), 650);
      }
      if (e.type === AGUI_EVENTS.TOOL_CALL_RESULT) results.push(JSON.parse(e.content));
    }
    await started.done;
    const [filtered, bound, explicit, closed, gone] = results;

    expect(filtered).toMatchObject({ executed: true, uiVersion: 4, uiClientId: Y, uiPublication: 'published' });
    // Not X's pre-command description at 40: Y has not published 4 yet, and says so.
    expect(bound).toMatchObject({ stale: true, reason: 'older_than_requested', version: 3 });
    expect(bound.snapshot.clientId).toBe(Y);
    // Once it has, the named tab's version 4 is the confirmed state.
    expect(explicit).toMatchObject({ stale: false, version: 4 });
    expect(explicit.snapshot).toMatchObject({ clientId: Y, url: '/data?country=PL' });
    expect(closed).toMatchObject({ stale: true, reason: 'client_gone', snapshot: null });
    expect(gone).toMatchObject({ stale: true, reason: 'client_gone', snapshot: null });
    // The run is over: its acknowledgement is forgotten.
    expect(store.acknowledgement(h.ownerId, started.runId)).toBeNull();
  });

  it('karta zamykana wycofuje opis (DELETE); przeladowana karta z nowsza wersja nie zostaje wycofana', async () => {
    const cookie = await login(h.platform.app, h.ownerId);
    const put = (body: UiSnapshot) =>
      h.platform.app.request('/api/ui/snapshot', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const del = (q: string) => h.platform.app.request(`/api/ui/snapshot?${q}`, { method: 'DELETE', headers: { cookie } });

    expect((await put(snapshot({ version: 5 }))).status).toBe(200);
    // A reload: the old page's retirement names version 4, the new page already published 5.
    expect(await (await del('clientId=ui_tab_aaaaaaaa&version=4')).json()).toEqual({ retired: false });
    expect((await callUiState({})).stale).toBe(false);
    // Closing for good.
    expect(await (await del('clientId=ui_tab_aaaaaaaa&version=5')).json()).toEqual({ retired: true });
    expect(await callUiState({})).toMatchObject({ stale: true, reason: 'no_client', snapshot: null });
    expect(await callUiState({ clientId: 'ui_tab_aaaaaaaa' })).toMatchObject({ reason: 'client_gone' });
    expect((await del('clientId=ui_tab_aaaaaaaa')).status).toBe(400);

    // Another owner cannot retire it.
    expect((await put(snapshot({ version: 6 }))).status).toBe(200);
    const theirs = await login(h.platform.app, h.otherOwnerId);
    await h.platform.app.request('/api/ui/snapshot?clientId=ui_tab_aaaaaaaa&version=99', { method: 'DELETE', headers: { cookie: theirs } });
    expect((await callUiState({})).version).toBe(6);
  });

  it('karta milczaca dluzej niz limit jest client_inactive; heartbeat ja podtrzymuje; zyjaca karta ma pierwszenstwo', async () => {
    const store = h.platform.services.uiSnapshots;
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(t0);
      store.publish(h.ownerId, snapshot({ clientId: 'ui_tab_quiet_one', version: 2 }));
      vi.setSystemTime(t0 + UI_CLIENT_INACTIVE_AFTER_MS - 1000);
      expect(store.evaluate(h.ownerId, 'cnv_a').stale).toBe(false);
      expect(store.touch(h.ownerId, 'ui_tab_quiet_one', 2)).toBe(true);
      expect(store.touch(h.ownerId, 'ui_tab_quiet_one', 1)).toBe(false); // not the version held
      vi.setSystemTime(t0 + 2 * UI_CLIENT_INACTIVE_AFTER_MS - 2000);
      expect(store.evaluate(h.ownerId, 'cnv_a').stale).toBe(false); // kept alive by the beat
      vi.setSystemTime(t0 + 2 * UI_CLIENT_INACTIVE_AFTER_MS);
      const silent = store.evaluate(h.ownerId, 'cnv_a');
      expect(silent).toMatchObject({ stale: true, reason: 'client_inactive', version: 2 });
      expect(silent.snapshot?.clientId).toBe('ui_tab_quiet_one');

      // A live tab on the same conversation is chosen over the silent one — even over the sender's.
      store.publish(h.ownerId, snapshot({ clientId: 'ui_tab_live_two', version: 1 }));
      const chosen = store.evaluate(h.ownerId, 'cnv_a', { context: { clientId: 'ui_tab_quiet_one', version: 2 } });
      expect(chosen).toMatchObject({ stale: false });
      expect(chosen.snapshot?.clientId).toBe('ui_tab_live_two');
    } finally {
      vi.useRealTimers();
    }

    const cookie = await login(h.platform.app, h.ownerId);
    const alive = (body: unknown) =>
      h.platform.app.request('/api/ui/snapshot/alive', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(await (await alive({ clientId: 'ui_tab_live_two', version: 1 })).json()).toEqual({ known: true });
    expect(await (await alive({ clientId: 'ui_tab_never_seen', version: 1 })).json()).toEqual({ known: false });
    expect((await alive({ clientId: 'ui_tab_live_two' })).status).toBe(400);
  });

  it('sesja: heartbeat nieznanej wersji publikuje ponownie; zamykanie wycofuje biezaca wersje', async () => {
    const sent: number[] = [];
    const retired: Array<{ clientId: string; version: number }> = [];
    let known = true;
    const s = new UiSnapshotSession({
      identity: sessionIdentityStore(),
      send: async (snap) => void sent.push(snap.version),
      alive: async () => known,
      retire: (ref) => void retired.push(ref),
      scope: () => 'x',
    });
    s.setSource(() => buildUiSnapshotContent({ url: '/', pathname: '/', conversationId: null, spaceId: null, instances: [], targets: [], views: [], canvas: undefined }));
    await s.flush();
    await s.heartbeat();
    expect(sent).toEqual([1]);
    known = false; // the backend restarted
    await s.heartbeat();
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([1, 1]);
    s.closing();
    expect(retired).toEqual([{ clientId: s.clientId, version: 1 }]);
  });
});

describe('I3: opis nie zalezy od przypadkowej zawartosci pamieci podrecznej', () => {
  it('wyrzucenie katalogu i widokow z pamieci nie zmienia opisu ani wersji; po zmianie wlasciciela pierwszy opis znow nazywa cel', () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    const source = createShellSnapshotSource({
      qc,
      location: () => ({ pathname: '/settings', search: '' }),
      shell: () => ({ conversationId: 'cnv_a', spaceId: null }),
      instances: () => [],
    });
    try {
      const s = new UiSnapshotSession({ identity: sessionIdentityStore(), send: async () => {} });
      s.setSource(source);
      // Before the catalog has loaded the screen is not described at all.
      expect(s.capture()).toBeNull();
      qc.setQueryData(qk.uiTargets(), { targets: h.platform.services.modules.uiTargets() });
      qc.setQueryData(qk.uiViews(), { views: h.platform.services.modules.views() });
      const first = s.capture()!;
      expect(first.target).toEqual({ id: 'platform.settings', kind: 'view', label: 'Ustawienia' });

      // Garbage collection of the cache is not a change of the screen.
      qc.removeQueries({ queryKey: ['ui-targets'] });
      qc.removeQueries({ queryKey: ['ui-views'] });
      expect(qc.getQueryData(qk.uiTargets())).toBeUndefined();
      expect(s.capture()).toBe(first);

      // Another owner: nothing of the previous one's is described, and nothing without the new owner's catalog.
      setAccessContext(qc, 'other-user');
      expect(s.capture()).toBeNull();
      expect(s.contextMarker()).toBeNull();
      qc.setQueryData(qk.uiTargets(), { targets: h.platform.services.modules.uiTargets() });
      const other = s.capture()!;
      expect(other.version).toBe(first.version + 1);
      // The first description after the switch names the screen again…
      expect(other.target).toEqual({ id: 'platform.settings', kind: 'view', label: 'Ustawienia' });
      // …and not the conversation the shell was holding when the switch happened.
      expect(other.conversationId).toBeNull();
    } finally {
      source.dispose();
      resetAccessContext();
    }
  });
});

describe('R1: wspolny budzet potwierdzenia komendy UI', () => {
  function gate() {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, firstMessage: { content: 'x' } });
    const run = h.platform.services.runs.start({
      conversationId: conv.id,
      ownerId: h.ownerId,
      prompt: 'x',
      appContext: context({ conversationId: conv.id }),
      workspaceDir: null,
      abort: new AbortController(),
    });
    return { conv, run, stream: new RunEventStream(run.id, h.platform.services.runs), runtime: h.platform.runtime };
  }
  const command = (conv: { id: string }, run: { id: string }): UiCommand => ({
    commandId: `uic_${Math.random().toString(36).slice(2, 12)}`,
    runId: run.id,
    conversationId: conv.id,
    targetId: 'procurement.data',
    spaceId: null,
  });

  it('wolna publikacja nie zamienia wykonanej komendy w no_client: potwierdzenie w budzecie, bez wersji, uiPublication=timeout', async () => {
    const BUDGET = 900;
    const { conv, run, stream, runtime } = gate();
    const hanging = new UiSnapshotSession({ identity: sessionIdentityStore(), send: () => new Promise(() => {}), scope: () => 'x' });
    hanging.setSource(() => buildUiSnapshotContent({ url: '/data', pathname: '/data', conversationId: conv.id, spaceId: null, instances: [], targets: [], views: [], canvas: undefined }));

    const watcher = (async () => {
      for await (const { event } of stream.read(0)) {
        const e = event as Record<string, unknown>;
        if (e.type === 'CUSTOM' && e.name === PLATFORM_CUSTOM_EVENTS.uiCommand) {
          const cmd = uiCommandSchema.parse(e.value);
          void performAndAcknowledge(cmd, {
            perform: async () => {
              await new Promise((r) => setTimeout(r, 250)); // navigating, filtering
              return { commandId: cmd.commandId, targetId: cmd.targetId, executed: true, url: '/data' };
            },
            session: hanging,
            post: async (_runId, result) => runtime.acknowledgeUiCommand(result),
            budgetMs: BUDGET,
            marginMs: 200,
          });
        }
      }
    })();
    const started = Date.now();
    const outcome = await runtime.requestUiCommand(command(conv, run), stream, BUDGET);
    const took = Date.now() - started;
    stream.close();
    await watcher;

    expect(outcome.reason).toBeUndefined();
    expect(outcome).toMatchObject({ executed: true, uiPublication: 'timeout' });
    expect(outcome.uiVersion).toBeUndefined();
    expect(outcome.uiClientId).toBeUndefined();
    expect(took).toBeLessThan(BUDGET);
  });

  it('potwierdzenie mowi, czy opis opublikowano: published z karta, rejected, skipped dla innej rozmowy', async () => {
    const base = { commandId: 'uic_abcdefgh', runId: 'run_x', conversationId: 'cnv_a', targetId: 'procurement.data', spaceId: null };
    const posted: UiCommandResult[] = [];
    const flushing = (publication: UiPublication) => ({ flush: async () => publication });
    const ok = snapshot({ clientId: 'ui_tab_acking_01', version: 9 });
    await performAndAcknowledge(base, {
      perform: async () => ({ commandId: base.commandId, executed: true }),
      session: flushing({ status: 'published', snapshot: ok }),
      post: async (_r, result) => void posted.push(result),
    });
    await performAndAcknowledge(base, {
      perform: async () => ({ commandId: base.commandId, executed: true }),
      session: flushing({ status: 'rejected', code: 'validation_failed' }),
      post: async (_r, result) => void posted.push(result),
    });
    let flushed = false;
    await performAndAcknowledge(base, {
      perform: async () => ({ commandId: base.commandId, executed: false, reason: 'inactive_conversation' }),
      session: { flush: async () => ((flushed = true), { status: 'timeout' }) },
      post: async (_r, result) => void posted.push(result),
    });
    expect(posted[0]).toMatchObject({ uiVersion: 9, uiClientId: 'ui_tab_acking_01', uiPublication: 'published' });
    expect(posted[1]).toMatchObject({ uiPublication: 'rejected' });
    expect(posted[1]!.uiVersion).toBeUndefined();
    expect(posted[2]).toMatchObject({ uiPublication: 'skipped' });
    expect(flushed).toBe(false);
    expect(uiCommandResultSchema.safeParse(posted[0]).success).toBe(true);
  });

  it('serwer czeka na potwierdzenie dokladnie wspolny budzet', async () => {
    const { conv, run, stream, runtime } = gate();
    vi.useFakeTimers();
    try {
      let result: UiCommandResult | null = null;
      void runtime.requestUiCommand(command(conv, run), stream).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(UI_COMMAND_ACK_TIMEOUT_MS - 1);
      expect(result).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({ executed: false, reason: 'no_client' });
      expect(UI_COMMAND_ACK_MARGIN_MS).toBeLessThan(UI_COMMAND_ACK_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
      stream.close();
    }
  });
});

/* ========================================================================== */
/*  Fix round 2: identity isolation, honest heartbeat, prompt flag, statuses  */
/* ========================================================================== */

describe('Fix round 2', () => {
  const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('N1: opis zlozony pod poprzednia tozsamoscia nie wychodzi po przelaczeniu — heartbeat, kolejka, wycofanie i marker', async () => {
    let owner = 'local-user';
    const stores: Record<string, UiSnapshotStore> = { 'local-user': new UiSnapshotStore(), 'other-user': new UiSnapshotStore() };
    // Every request lands in the store of whoever is signed in when it is made, as the session cookie does.
    const sent: Array<{ owner: string; version: number; conversationId: string | null }> = [];
    const retired: Array<{ owner: string; version: number }> = [];
    let release: (() => void) | null = null;
    let conversationId = 'cnv_of_local_user';
    const s = new UiSnapshotSession({
      identity: sessionIdentityStore(),
      scope: () => owner,
      send: async (snap) => {
        const to = owner;
        if (snap.version === 2) await new Promise<void>((r) => (release = r));
        sent.push({ owner: to, version: snap.version, conversationId: snap.conversationId });
        stores[to]!.publish(to, snap);
      },
      alive: async (ref) => stores[owner]!.touch(owner, ref.clientId, ref.version),
      retire: (ref) => void retired.push({ owner, version: ref.version }),
    });
    s.setSource(() =>
      buildUiSnapshotContent({ url: '/data', pathname: '/data', conversationId, spaceId: null, instances: [instance('DataTable-a')], targets: [], views: [], canvas: undefined }),
    );

    expect((await s.flush()).status).toBe('published'); // v1, local-user

    // A description captured as local-user is queued behind one still on its way…
    conversationId = 'cnv_of_local_user_2';
    const inFlight = s.flush({ timeoutMs: 5000 }); // v2, blocked in send
    await sleepMs(10);
    conversationId = 'cnv_of_local_user_3';
    const queued = s.flush({ timeoutMs: 5000 }); // v3 captured as local-user, queued
    await sleepMs(10);

    // …and the user switches identity (Settings → another user).
    owner = 'other-user';
    release!();
    expect((await inFlight).status).toBe('published'); // it had already left as local-user
    expect(await queued).toEqual({ status: 'not_described' });

    // The heartbeat, the retirement and the command marker have nothing to offer the new identity.
    await s.heartbeat();
    s.closing();
    expect(s.contextMarker()).toBeNull();

    expect(sent.filter((x) => x.owner === 'other-user')).toEqual([]);
    expect(retired).toEqual([]);
    expect(stores['other-user']!.forClient('other-user', s.clientId)).toBeNull();

    // Captured as the new identity, it is published to the new identity only.
    conversationId = 'cnv_of_other_user';
    const own = await s.flush();
    expect(own.status).toBe('published');
    expect(sent.at(-1)).toMatchObject({ owner: 'other-user', conversationId: 'cnv_of_other_user' });
    expect(stores['other-user']!.forClient('other-user', s.clientId)?.conversationId).toBe('cnv_of_other_user');
    expect(sent.filter((x) => x.owner === 'other-user')).toHaveLength(1);
    expect(s.contextMarker()?.version).toBe((own as { snapshot: UiSnapshot }).snapshot.version);
  });

  it('N2: po odrzuceniu nowszego opisu karta nie podtrzymuje starszego — backend zglasza superseded', async () => {
    const store = new UiSnapshotStore();
    const owner = h.ownerId;
    const reports: string[] = [];
    const vouched: number[] = [];
    let url = '/data';
    const s = new UiSnapshotSession({
      identity: sessionIdentityStore(),
      scope: () => owner,
      report: (message) => void reports.push(message),
      send: async (snap) => {
        if (snap.url === '/odrzucany') throw new AppError('validation_failed', 'Nieprawidlowy opis interfejsu.', { reason: 'invalid_snapshot' });
        store.publish(owner, snap);
      },
      alive: async (ref) => {
        vouched.push(ref.version);
        return store.touch(owner, ref.clientId, ref.version);
      },
    });
    s.setSource(() =>
      buildUiSnapshotContent({ url, pathname: url, conversationId: 'cnv_a', spaceId: null, instances: [], targets: [], views: [], canvas: undefined }),
    );

    expect((await s.flush()).status).toBe('published');
    expect(store.evaluate(owner, 'cnv_a')).toMatchObject({ stale: false, version: 1 });

    // The screen moves on; its description is refused by the backend.
    url = '/odrzucany';
    expect(await s.flush()).toEqual({ status: 'rejected', code: 'validation_failed' });
    await sleepMs(10);
    expect(store.evaluate(owner, 'cnv_a')).toMatchObject({ stale: true, reason: 'superseded', version: 1 });

    // Heartbeats keep the tab alive but never vouch for version 1 again, and do not resend the refused 2.
    vouched.length = 0;
    await s.heartbeat();
    await s.heartbeat();
    expect(vouched).toEqual([2, 2]);
    const after = store.evaluate(owner, 'cnv_a');
    expect(after).toMatchObject({ stale: true, reason: 'superseded', version: 1 });
    expect(reports).toHaveLength(1);

    // The store: an older touch is not a vouch either; a live, current tab is preferred to a superseded one.
    expect(store.touch(owner, s.clientId, 1)).toBe(false);
    expect(store.evaluate(owner, 'cnv_a').reason).toBe('superseded');
    store.publish(owner, snapshot({ clientId: 'ui_tab_other_live', version: 1, conversationId: 'cnv_a' }));
    expect(store.evaluate(owner, 'cnv_a')).toMatchObject({ stale: false });
    expect(store.evaluate(owner, 'cnv_a').snapshot?.clientId).toBe('ui_tab_other_live');

    // Once a newer description is accepted, the tab's own description is current again.
    url = '/data?country=PL';
    expect((await s.flush()).status).toBe('published');
    expect(store.evaluate(owner, 'cnv_a', { clientId: s.clientId })).toMatchObject({ stale: false, version: 3 });
  });

  it('N3: prompt mowi, ze adres ekranu zostal skrocony', () => {
    const base = { registry: h.platform.registry, catalog: h.platform.services.catalog, resourceSummary: null, workspaceDir: null, stagedFiles: [], toolkit: [] };
    const cut = 'x'.repeat(UI_URL_MAX_LENGTH);
    const truncated = buildSystemPrompt({ ...base, appContext: context({ ui: { version: 4, clientId: 'ui_tab_aaaaaaaa', viewId: null, url: cut, urlTruncated: true } }) });
    expect(truncated).toContain(`adres ${cut} [adres skrocony do 2000 znakow — pelny jest dluzszy]`);
    const whole = buildSystemPrompt({ ...base, appContext: context({ ui: { version: 4, clientId: 'ui_tab_aaaaaaaa', viewId: null, url: '/data' } }) });
    expect(whole).not.toContain('adres skrocony');
  });

  it('N5: rejected tylko dla odmowy backendu; brak opisu i brak polaczenia maja wlasne statusy', async () => {
    const reports: string[] = [];
    const nothing = new UiSnapshotSession({ identity: sessionIdentityStore(), send: async () => {}, scope: () => 'x', report: (m) => void reports.push(m) });
    expect(await nothing.flush()).toEqual({ status: 'not_described' });

    const offline = new UiSnapshotSession({
      identity: sessionIdentityStore(),
      send: async () => {
        throw new TypeError('Failed to fetch');
      },
      scope: () => 'x',
      report: (m) => void reports.push(m),
    });
    offline.setSource(() => buildUiSnapshotContent({ url: '/', pathname: '/', conversationId: null, spaceId: null, instances: [], targets: [], views: [], canvas: undefined }));
    expect(await offline.flush()).toEqual({ status: 'unreachable' });
    expect(offline.lastRejection()).toBeNull();
    expect(reports).toEqual([]);

    const posted: UiCommandResult[] = [];
    await performAndAcknowledge(
      { commandId: 'uic_abcdefgh', runId: 'run_x', conversationId: 'cnv_a', targetId: 'procurement.data', spaceId: null },
      { perform: async () => ({ commandId: 'uic_abcdefgh', executed: true }), session: nothing, post: async (_r, r) => void posted.push(r) },
    );
    expect(posted[0]).toMatchObject({ uiPublication: 'not_described' });
    expect(uiCommandResultSchema.safeParse(posted[0]).success).toBe(true);
    for (const status of ['unreachable', 'not_described']) {
      expect(uiCommandResultSchema.safeParse({ commandId: 'uic_abcdefgh', executed: true, uiPublication: status }).success).toBe(true);
    }
  });
});

/* ========================================================================== */
/*  Fix round 3: nothing from before an identity switch                       */
/* ========================================================================== */

describe('Fix round 3', () => {
  it('A1: rejestr nie wymienia opisow zapisanych przed przelaczeniem tozsamosci, dopoki komponent ich nie opisze ponownie', () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    try {
      const before = instance('DataTable-przed', { visibleRecordIds: ['s1', 's2', 's3'] });
      expect(registerInstance(before)).toBe(true);
      expect(listInstances().map((i) => i.instanceId)).toContain('DataTable-przed');

      setAccessContext(qc, 'other-user');
      // Still mounted, not re-rendered: its entry stays, but it is not a description of this identity's screen.
      expect(useUiSemantics.getState().instances['DataTable-przed']).toBeDefined();
      expect(listInstances().map((i) => i.instanceId)).not.toContain('DataTable-przed');

      // Described again after the switch — even with the same content — it is listed.
      expect(registerInstance(before)).toBe(true);
      expect(listInstances().map((i) => i.instanceId)).toContain('DataTable-przed');
      unregisterInstance('DataTable-przed');
      expect(useUiSemantics.getState().epochs['DataTable-przed']).toBeUndefined();
    } finally {
      unregisterInstance('DataTable-przed');
      resetAccessContext();
    }
  });

  it('A1: po przelaczeniu nowy wlasciciel nie dostaje ani instancji, ani rozmowy, ani przestrzeni poprzedniego (flush i heartbeat)', async () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    const stores: Record<string, UiSnapshotStore> = { 'local-user': new UiSnapshotStore(), 'other-user': new UiSnapshotStore() };
    const shell = { conversationId: 'cnv_of_local_user' as string | null, spaceId: 'spc_of_local_user' as string | null };
    const source = createShellSnapshotSource({ qc, location: () => ({ pathname: '/settings', search: '' }), shell: () => shell, instances: listInstances });
    const s = new UiSnapshotSession({
      identity: sessionIdentityStore(),
      send: async (snap) => void stores[accessScope()]!.publish(accessScope(), snap),
      alive: async (ref) => stores[accessScope()]!.touch(accessScope(), ref.clientId, ref.version),
    });
    s.setSource(source);
    try {
      registerInstance(instance('DataTable-w-czacie', { viewId: null, visibleRecordIds: ['rec_local_1', 'rec_local_2', 'rec_local_3'] }));
      qc.setQueryData(qk.uiTargets(), { targets: h.platform.services.modules.uiTargets() });
      expect((await s.flush()).status).toBe('published');
      const mine = stores['local-user']!.forClient('local-user', s.clientId)!;
      expect(mine.instances.map((i) => i.instanceId)).toEqual(['DataTable-w-czacie']);
      expect(mine).toMatchObject({ conversationId: 'cnv_of_local_user', spaceId: 'spc_of_local_user' });

      // Settings → switch identity. The chat's table does not re-render; the shell keeps its ids.
      setAccessContext(qc, 'other-user');
      expect((await s.flush()).status).toBe('not_described'); // the new owner's catalog is not loaded yet
      await s.heartbeat();
      expect(stores['other-user']!.forClient('other-user', s.clientId)).toBeNull();

      qc.setQueryData(qk.uiTargets(), { targets: h.platform.services.modules.uiTargets() });
      expect((await s.flush()).status).toBe('published');
      await s.heartbeat();
      const theirs = stores['other-user']!.forClient('other-user', s.clientId)!;
      expect(theirs.instances).toEqual([]);
      expect(theirs.conversationId).toBeNull();
      expect(theirs.spaceId).toBeNull();
      expect(JSON.stringify(theirs)).not.toContain('rec_local_');
      expect(JSON.stringify(theirs)).not.toContain('_of_local_user');
      expect(theirs.target?.id).toBe('platform.settings');

      // Once the shell moves to the new owner's conversation, it is reported.
      shell.conversationId = 'cnv_of_other_user';
      expect((await s.flush()).status).toBe('published');
      expect(stores['other-user']!.forClient('other-user', s.clientId)?.conversationId).toBe('cnv_of_other_user');
    } finally {
      unregisterInstance('DataTable-w-czacie');
      source.dispose();
      resetAccessContext();
    }
  });

  it('M1: odmowa przeczytana po przelaczeniu nie wysyla opisu poprzedniego wlasciciela pod nowa tozsamoscia karty ani nie zglasza go dalej', async () => {
    let owner = 'local-user';
    const sent: Array<{ owner: string; clientId: string }> = [];
    const alive: string[] = [];
    const reports: string[] = [];
    const s = new UiSnapshotSession({
      identity: sessionIdentityStore(),
      scope: () => owner,
      report: (m) => void reports.push(m),
      send: async (snap) => {
        sent.push({ owner, clientId: snap.clientId });
        // The switch happens while this request's refusal is being read.
        owner = 'other-user';
        throw new AppError('conflict', 'wersja nie nowsza');
      },
      alive: async () => {
        alive.push(owner);
        return false;
      },
    });
    s.setSource(() => buildUiSnapshotContent({ url: '/', pathname: '/', conversationId: 'cnv_of_local_user', spaceId: null, instances: [], targets: [], views: [], canvas: undefined }));
    expect(await s.flush()).toEqual({ status: 'unreachable' });
    expect(sent).toEqual([{ owner: 'local-user', clientId: expect.any(String) }]);
    expect(alive).toEqual([]);
    expect(reports).toEqual([]);

    // A plain refusal read across a switch is not reported to (or passed on to) the new identity either.
    owner = 'local-user';
    const t = new UiSnapshotSession({
      identity: sessionIdentityStore(),
      scope: () => owner,
      report: (m) => void reports.push(m),
      send: async () => {
        owner = 'other-user';
        throw new AppError('validation_failed', 'Nieprawidlowy opis interfejsu.');
      },
      alive: async () => void alive.push(owner) as unknown as boolean,
    });
    t.setSource(() => buildUiSnapshotContent({ url: '/', pathname: '/', conversationId: null, spaceId: null, instances: [], targets: [], views: [], canvas: undefined }));
    expect(await t.flush()).toEqual({ status: 'unreachable' });
    expect(alive).toEqual([]);
    expect(t.lastRejection()).toBeNull();
  });

  it('M1: api() nie oddaje odmowy przeczytanej juz po przelaczeniu tozsamosci', async () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 409,
        // The body arrives after the identity has changed.
        json: async () => {
          setAccessContext(qc, 'other-user');
          return { error: { code: 'conflict', message: 'wersja nie nowsza' } };
        },
      }) as unknown as Response) as typeof fetch;
    try {
      const error = await apiPut('/api/ui/snapshot', {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AccessContextChanged);
    } finally {
      globalThis.fetch = original;
      resetAccessContext();
    }
  });
});
