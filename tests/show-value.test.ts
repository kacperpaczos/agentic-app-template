import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_VIEWS_SCOPE_KIND,
  PLATFORM_CUSTOM_EVENTS,
  UI_COMMAND_FAILURES,
  UI_REVEAL_ADJUSTMENT_KINDS,
  formatFieldValue,
  uiCommandResultSchema,
  uiCommandSchema,
  type AppContext,
  type CanvasCard,
  type ReadResponse,
  type ReadResultDescriptor,
  type ToolCallContext,
  type UiCommand,
  type UiSnapshot,
} from '@platform/contracts';
import {
  AgentRuntime,
  RunEventStream,
  assertMcpCompatibleShape,
  buildSystemPrompt,
  declaredFieldsOfKind,
  platformTools,
  presentationCandidates,
} from '@platform/server';
import { locateRecord, type RecordLocation } from '../packages/platform-ui/src/views/revealTarget.ts';
import { planReveal, revealAddress } from '../packages/platform-ui/src/shell/uiReveal.ts';
import { createHarness, type Harness } from './helpers.ts';

/**
 * Showing the value of one record's field (L2.16, L6.16).
 *
 * Contract and logic tests: no browser, no model. The mapping from a record and
 * a field to the places that render it, the refusals each way it can fail, the
 * backend value read before anything moves and compared with what the client
 * says it showed, and — on the browser's side, as pure functions — where a
 * record is in a table and what has to change to bring it on screen. The screen
 * itself is `e2e/show-value.spec.ts`.
 */

let h: Harness;

const EMPTY_CONTEXT = (conversationId: string | null): AppContext => ({
  conversationId,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
  ui: null,
});

/* -------------------------------------------------------------------------- */
/*  A run that calls the tool, over the real acknowledgement gate              */
/* -------------------------------------------------------------------------- */

interface ToolRun {
  result?: any;
  error?: unknown;
  emitted: UiCommand[];
}

/**
 * Calls a platform tool the way a run does — the real runtime, the real event
 * stream, the real acknowledgement gate — and records what the browser would
 * have received. `ack` plays the client.
 */
async function callTool(
  name: string,
  input: Record<string, unknown>,
  ack: (command: UiCommand, runtime: AgentRuntime) => void | Promise<void>,
  opts: { ownerId?: string; conversationId?: string; context?: AppContext } = {},
): Promise<ToolRun> {
  const ownerId = opts.ownerId ?? h.ownerId;
  const runtime = new AgentRuntime(h.platform.services);
  const conversationId =
    opts.conversationId ??
    h.platform.services.conversations.create({ ownerId, firstMessage: { content: 'pokaz wartosc' } }).id;
  const appContext = opts.context ?? EMPTY_CONTEXT(conversationId);
  const run = h.platform.services.runs.start({
    conversationId,
    ownerId,
    prompt: 'pokaz wartosc',
    appContext,
    workspaceDir: null,
    abort: new AbortController(),
  });
  const stream = new RunEventStream(run.id, h.platform.services.runs);
  const emitted: UiCommand[] = [];
  const watcher = (async () => {
    for await (const { event } of stream.read(0)) {
      const e = event as Record<string, unknown>;
      if (e.type === 'CUSTOM' && e.name === PLATFORM_CUSTOM_EVENTS.uiCommand) {
        const parsed = uiCommandSchema.parse(e.value);
        emitted.push(parsed);
        await ack(parsed, runtime);
      }
    }
  })();
  const ctx: ToolCallContext = {
    ownerId,
    appContext,
    conversationId,
    runId: run.id,
    workspaceDir: null,
    emit: () => {},
    requestUi: (command) =>
      runtime.requestUiCommand(
        {
          commandId: `uic_${Math.random().toString(36).slice(2, 12)}`,
          runId: run.id,
          conversationId,
          targetId: command.targetId,
          spaceId: command.spaceId ?? null,
          ...(command.filter !== undefined ? { filter: command.filter } : {}),
          ...(command.sort !== undefined ? { sort: command.sort } : {}),
          ...(command.reveal ? { reveal: command.reveal } : {}),
          reason: command.reason,
        },
        stream,
        400,
      ),
  };
  const tool = platformTools(h.platform.services).find((t) => t.name === name)!;
  const out: ToolRun = { emitted };
  try {
    out.result = await tool.handler(input as never, ctx);
  } catch (e) {
    out.error = e;
  }
  stream.close();
  await watcher;
  return out;
}

/** A client that reports revealing exactly what it was asked for, with the backend's value. */
const revealsIt = (record: Record<string, unknown>, field: string, descriptor: ReadResultDescriptor, page: any = null) =>
  async (command: UiCommand, runtime: AgentRuntime) => {
    const shownField = descriptor.fields.find((f) => f.field === field)!;
    runtime.acknowledgeUiCommand(
      uiCommandResultSchema.parse({
        commandId: command.commandId,
        targetId: command.targetId,
        executed: true,
        highlighted: true,
        url: '/data',
        revealed: {
          recordKind: command.reveal!.recordKind,
          recordId: command.reveal!.recordId,
          field: command.reveal!.field,
          displayedText: formatFieldValue(record, shownField),
          rawValue: (record[field] ?? null) as never,
          page,
          adjustments: [{ kind: 'filter_cleared', detail: 'Kraj: PL', predicates: [{ field: 'country', op: 'eq', value: 'PL' }] }],
        },
      }),
    );
  };

/** A client that never answers. */
const silent = () => {};

const cardsOf = (conversationId: string, ownerId = h.ownerId): CanvasCard[] => {
  const space = h.platform.services.canvas.findScopedSpace(ownerId, AGENT_VIEWS_SCOPE_KIND, conversationId);
  return space ? h.platform.services.canvas.getState(space.id, ownerId).cards : [];
};

/** Puts a composition into the conversation's agent views, as `agent_view_create` does. */
async function addAgentView(conversationId: string, title: string, source: string, ownerId = h.ownerId): Promise<CanvasCard> {
  const { space } = h.platform.services.canvas.ensureScopedSpace({
    ownerId,
    title: `Widoki agenta: ${conversationId}`,
    scopeKind: AGENT_VIEWS_SCOPE_KIND,
    scopeId: conversationId,
  });
  return h.platform.services.canvas.addCard(
    { spaceId: space.id, title, spec: { kind: 'openui', source } },
    ownerId,
  );
}

const candidatesFor = (recordKind: string, opts: { cards?: CanvasCard[]; displayed?: any } = {}) =>
  presentationCandidates({
    registry: h.platform.registry,
    catalog: h.platform.services.catalog.openui,
    recordKind,
    agentViewCards: opts.cards ?? [],
    displayed: opts.displayed ?? null,
  });

/* -------------------------------------------------------------------------- */
/*  The mapping: record and field to the places that render them              */
/* -------------------------------------------------------------------------- */

describe('mapowanie rekord-pole na cel prezentacyjny', () => {
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.dispose());

  it('widok modulu z wlasnym ekranem jest kandydatem; pola to kolumny jego tabeli', () => {
    const found = candidatesFor('supplier');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      targetId: 'procurement.data',
      presentation: { kind: 'view', viewId: 'procurement.data' },
      uiTargetId: 'procurement.data',
      label: 'Dostawcy',
      statementId: 'suppliers',
      fields: ['name', 'taxId', 'country', 'contactEmail'],
    });
    expect(found[0]!.source).toEqual({ operation: 'procurement.suppliers' });
    expect(found[0]!.descriptor.record).toMatchObject({ kind: 'supplier', idField: 'id' });
  });

  it('rodzaj rekordu pokazywany tylko na ekranie rekordowym nie ma kandydata, dopoki karta go nie pokazuje', () => {
    // `offer_item` is rendered by the case detail screen, which is opened per record.
    expect(candidatesFor('offer_item')).toHaveLength(0);
    expect(candidatesFor('offer')).toHaveLength(0);
  });

  it('karty widokow agenta rozmowy sa kandydatami; kilka tabel w jednej karcie rozroznia instrukcja', async () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, firstMessage: { content: 'x' } });
    const card = await addAgentView(
      conv.id,
      'Dwie tabele',
      [
        'root = Stack([a, b])',
        'a = DataTable({operation: "procurement.suppliers"}, ["name", "country"])',
        'b = DataTable({operation: "procurement.suppliers"}, ["name", "taxId"])',
      ].join('\n'),
    );
    const found = candidatesFor('supplier', { cards: cardsOf(conv.id) });
    expect(found.map((c) => c.targetId)).toEqual(['procurement.data', `${card.id}#a`, `${card.id}#b`]);
    expect(found[1]).toMatchObject({ presentation: { kind: 'agent_view', cardId: card.id }, uiTargetId: 'platform.agentViews', label: 'Dwie tabele' });
    expect(found[2]!.fields).toEqual(['name', 'taxId']);
  });

  it('widok z parametrami trasy jest kandydatem tylko z opisu ekranu, z parametrami z tego opisu', () => {
    const caseId = h.service.listCases(h.ownerId)[0]!.id;
    const displayed = {
      view: h.platform.registry.view('procurement.case.detail')!.definition,
      instances: [
        {
          instanceId: 'DataTable-1',
          component: 'DataTable',
          viewId: 'procurement.case.detail',
          source: { operation: 'procurement.case_offer_items', input: { caseId } },
          state: 'ready',
          error: null,
          record: { kind: 'offer_item', idField: 'id' },
          fields: [],
          filter: [],
          sort: null,
          page: null,
          visibleRecordIds: [],
          matched: 3,
          total: 3,
          actions: [],
        },
      ],
    } as any;
    const found = candidatesFor('offer_item', { displayed });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      targetId: 'procurement.case.detail',
      presentation: { kind: 'view', viewId: 'procurement.case.detail' },
      // Not navigated to: the screen is the one the tab already shows.
      uiTargetId: null,
      statementId: 'offerItems',
    });
    // The `$caseId` of the composition is filled from the description, never guessed.
    expect(found[0]!.source).toEqual({ operation: 'procurement.case_offer_items', input: { caseId } });

    // Without the parameter in the description there is nothing to resolve.
    const blind = candidatesFor('offer_item', {
      displayed: { ...displayed, instances: [{ ...displayed.instances[0], source: { operation: 'procurement.case_offer_items' } }] },
    });
    expect(blind).toHaveLength(0);
  });

  it('pola rodzaju rekordu zbiera sie z deskryptorow, nie z jednego widoku', () => {
    expect(declaredFieldsOfKind(h.platform.registry, 'supplier').map((f) => f.field)).toEqual([
      'name',
      'taxId',
      'country',
      'contactEmail',
    ]);
    expect(declaredFieldsOfKind(h.platform.registry, 'nie-ma-takiego')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  The tool                                                                  */
/* -------------------------------------------------------------------------- */

describe('ui_show_value', () => {
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.dispose());

  const supplier = () => h.service.listSuppliers(h.ownerId)[0]!;

  it('wysyla polecenie z rekordem, polem i instancja; zwraca wartosc backendu i potwierdzenie klienta', async () => {
    const s = supplier();
    const descriptor = h.platform.registry.readOperation('procurement.suppliers')!.definition.result!;
    const { result, emitted } = await callTool(
      'ui_show_value',
      { recordKind: 'supplier', recordId: s.id, field: 'taxId' },
      revealsIt(s as never, 'taxId', descriptor, { index: 2, size: 10, count: 2 }),
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.targetId).toBe('procurement.data');
    expect(emitted[0]!.reveal).toEqual({
      recordKind: 'supplier',
      recordId: s.id,
      field: 'taxId',
      presentation: { kind: 'view', viewId: 'procurement.data' },
      source: { operation: 'procurement.suppliers' },
    });

    expect(result).toMatchObject({
      executed: true,
      found: true,
      shown: true,
      matchesBackend: true,
      recordKind: 'supplier',
      recordId: s.id,
      field: 'taxId',
      fieldLabel: 'NIP',
      highlighted: true,
      target: { targetId: 'procurement.data', place: 'view', operation: 'procurement.suppliers' },
    });
    // The backend's own value, read before the command, and its formatting.
    expect(result.backend).toEqual({ rawValue: s.taxId, displayedText: s.taxId });
    expect(result.revealed.page).toEqual({ index: 2, size: 10, count: 2 });
    expect(result.adjustments.map((a: any) => a.kind)).toEqual(['filter_cleared']);
  });

  it('rozna wartosc na ekranie: shown, ale matchesBackend=false', async () => {
    const s = supplier();
    const { result } = await callTool(
      'ui_show_value',
      { recordKind: 'supplier', recordId: s.id, field: 'taxId' },
      async (command, runtime) => {
        runtime.acknowledgeUiCommand({
          commandId: command.commandId,
          executed: true,
          highlighted: true,
          revealed: {
            recordKind: 'supplier',
            recordId: s.id,
            field: 'taxId',
            displayedText: '000',
            rawValue: '000',
            page: null,
            adjustments: [],
          },
        });
      },
    );
    expect(result).toMatchObject({ found: true, shown: true, matchesBackend: false });
    expect(result.backend.rawValue).toBe(s.taxId);
  });

  it('potwierdzenie o innym rekordzie albo bez podswietlenia nie jest pokazaniem', async () => {
    const s = supplier();
    const other = h.service.listSuppliers(h.ownerId)[1]!;
    const wrongRecord = await callTool(
      'ui_show_value',
      { recordKind: 'supplier', recordId: s.id, field: 'taxId' },
      async (command, runtime) => {
        runtime.acknowledgeUiCommand({
          commandId: command.commandId,
          executed: true,
          highlighted: true,
          revealed: {
            recordKind: 'supplier',
            recordId: other.id,
            field: 'taxId',
            displayedText: String(other.taxId),
            rawValue: other.taxId,
            page: null,
            adjustments: [],
          },
        });
      },
    );
    expect(wrongRecord.result).toMatchObject({ found: true, shown: false, matchesBackend: null, reason: 'not_confirmed' });

    const notHighlighted = await callTool(
      'ui_show_value',
      { recordKind: 'supplier', recordId: s.id, field: 'taxId' },
      async (command, runtime) => {
        runtime.acknowledgeUiCommand({
          commandId: command.commandId,
          executed: false,
          reason: UI_COMMAND_FAILURES.notVisible,
          highlighted: false,
          revealed: {
            recordKind: 'supplier',
            recordId: s.id,
            field: 'taxId',
            displayedText: String(s.taxId),
            rawValue: s.taxId,
            page: null,
            adjustments: [],
          },
        });
      },
    );
    expect(notHighlighted.result).toMatchObject({
      executed: false,
      reason: UI_COMMAND_FAILURES.notVisible,
      found: true,
      shown: false,
      matchesBackend: null,
    });
  });

  it('brak klienta: znalezione w backendzie, niepokazane', async () => {
    const s = supplier();
    const { result } = await callTool('ui_show_value', { recordKind: 'supplier', recordId: s.id, field: 'name' }, silent);
    expect(result).toMatchObject({
      executed: false,
      reason: UI_COMMAND_FAILURES.noClient,
      found: true,
      shown: false,
      matchesBackend: null,
    });
    expect(result.backend.displayedText).toBe(s.name);
  });

  it('pole spoza deskryptora: unknown_field z lista pol, nic nie trafia do przegladarki', async () => {
    const s = supplier();
    const { result, emitted } = await callTool(
      'ui_show_value',
      { recordKind: 'supplier', recordId: s.id, field: 'wojewodztwo' },
      silent,
    );
    expect(result).toMatchObject({ reason: 'unknown_field', found: false, shown: false });
    expect(result.available.map((f: any) => f.field)).toEqual(['name', 'taxId', 'country', 'contactEmail']);
    expect(emitted).toHaveLength(0);
  });

  it('rodzaj rekordu nigdzie nierenderowany i pole nierenderowane: no_renderer z powodem', async () => {
    const caseId = h.service.listCases(h.ownerId)[0]!.id;
    const offerId = h.service.compare(caseId, h.ownerId).rows[0]!.offerId;

    const nowhere = await callTool('ui_show_value', { recordKind: 'offer', recordId: offerId, field: 'totalMinor' }, silent);
    expect(nowhere.result).toMatchObject({ reason: 'no_renderer', detail: 'kind_not_rendered', found: false });
    expect(nowhere.emitted).toHaveLength(0);

    const unknownKind = await callTool('ui_show_value', { recordKind: 'gremlin', recordId: 'x', field: 'y' }, silent);
    expect(unknownKind.result).toMatchObject({ reason: 'no_renderer', detail: 'kind_not_declared' });
    expect(unknownKind.result.availableKinds).toContain('supplier');

    // A card that shows suppliers, but not their tax id.
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, firstMessage: { content: 'x' } });
    await addAgentView(conv.id, 'Kraje', 'root = DataTable({operation: "procurement.suppliers"}, ["name", "country"])');
    const s = supplier();
    const notShown = await callTool(
      'ui_show_value',
      { recordKind: 'supplier', recordId: s.id, field: 'taxId', targetId: 'platform.agentViews' },
      silent,
      { conversationId: conv.id },
    );
    expect(notShown.result).toMatchObject({ reason: 'no_renderer', detail: 'field_not_shown', fieldLabel: 'NIP' });
    expect(notShown.result.shownIn[0].fields).toEqual(['name', 'country']);
    expect(notShown.emitted).toHaveLength(0);
  });

  it('nieistniejacy rekord: record_not_found z lista sprawdzonych miejsc, bez polecenia', async () => {
    const { result, emitted } = await callTool(
      'ui_show_value',
      { recordKind: 'supplier', recordId: 'pcs_nie_ma', field: 'name' },
      silent,
    );
    expect(result).toMatchObject({ reason: 'record_not_found', found: false, shown: false });
    expect(result.checked.map((c: any) => c.targetId)).toEqual(['procurement.data']);
    expect(emitted).toHaveLength(0);
  });

  it('rekord odrzucony przez staly filtr kompozycji nie jest w niej pokazywany', async () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, firstMessage: { content: 'x' } });
    await addAgentView(
      conv.id,
      'Tylko Finlandia',
      'root = DataTable({operation: "procurement.suppliers"}, ["name", "taxId"], null, null, [{field: "country", op: "eq", value: "FI"}])',
    );
    const polish = h.service.listSuppliers(h.ownerId).find((s) => s.country === 'PL')!;
    const { result } = await callTool(
      'ui_show_value',
      { recordKind: 'supplier', recordId: polish.id, field: 'taxId', targetId: 'platform.agentViews' },
      silent,
      { conversationId: conv.id },
    );
    expect(result).toMatchObject({ reason: 'record_not_found' });
    expect(result.checked[0]).toMatchObject({ excludedBy: 'composition_filter' });
  });

  it('odczyt odmowiony dla tego wlasciciela: forbidden, nie record_not_found', async () => {
    // The other owner's conversation holds an agent view over this owner's case.
    const caseId = h.service.listCases(h.ownerId)[0]!.id;
    const offerId = h.service.compare(caseId, h.ownerId).rows[0]!.offerId;
    const conv = h.platform.services.conversations.create({
      ownerId: h.otherOwnerId,
      firstMessage: { content: 'x' },
    });
    await addAgentView(
      conv.id,
      'Cudze oferty',
      `root = DataTable({operation: "procurement.comparison", input: {caseId: "${caseId}"}}, ["supplierName", "totalMinor"])`,
      h.otherOwnerId,
    );
    const { result, emitted } = await callTool(
      'ui_show_value',
      { recordKind: 'offer', recordId: offerId, field: 'totalMinor' },
      silent,
      { ownerId: h.otherOwnerId, conversationId: conv.id },
    );
    expect(result).toMatchObject({ reason: 'forbidden', found: false, shown: false });
    expect(result.refused[0].message).toContain('innego wlasciciela');
    expect(emitted).toHaveLength(0);
  });

  it('kilka miejsc bez targetId: ambiguous z lista; z targetId wykonuje sie w wybranym', async () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, firstMessage: { content: 'x' } });
    const card = await addAgentView(
      conv.id,
      'Dostawcy wg kraju',
      'root = DataTable({operation: "procurement.suppliers"}, ["name", "taxId", "country"])',
    );
    const s = supplier();
    const descriptor = h.platform.registry.readOperation('procurement.suppliers')!.definition.result!;

    const ambiguous = await callTool(
      'ui_show_value',
      { recordKind: 'supplier', recordId: s.id, field: 'taxId' },
      silent,
      { conversationId: conv.id },
    );
    expect(ambiguous.result).toMatchObject({ reason: 'ambiguous', found: true, shown: false });
    expect(ambiguous.result.candidates.map((c: any) => c.targetId)).toEqual(['procurement.data', card.id]);
    expect(ambiguous.emitted).toHaveLength(0);

    const chosen = await callTool(
      'ui_show_value',
      { recordKind: 'supplier', recordId: s.id, field: 'taxId', targetId: card.id },
      revealsIt(s as never, 'taxId', descriptor),
      { conversationId: conv.id },
    );
    expect(chosen.emitted).toHaveLength(1);
    expect(chosen.emitted[0]!.targetId).toBe('platform.agentViews');
    expect(chosen.emitted[0]!.reveal!.presentation).toEqual({ kind: 'agent_view', cardId: card.id });
    expect(chosen.result).toMatchObject({ shown: true, matchesBackend: true, target: { targetId: card.id } });
  });

  it('nieznany targetId to co innego niz cel, ktory tego nie pokazuje', async () => {
    const s = supplier();
    const unknown = await callTool(
      'ui_show_value',
      { recordKind: 'supplier', recordId: s.id, field: 'taxId', targetId: 'nie.ma.takiego' },
      silent,
    );
    expect(unknown.result).toMatchObject({ reason: 'unknown_target', requested: 'nie.ma.takiego' });
    expect(unknown.result.candidates.map((c: any) => c.targetId)).toEqual(['procurement.data']);

    const wrongPlace = await callTool(
      'ui_show_value',
      { recordKind: 'supplier', recordId: s.id, field: 'taxId', targetId: 'procurement.cases' },
      silent,
    );
    expect(wrongPlace.result).toMatchObject({ reason: 'no_renderer', detail: 'target_does_not_render_kind' });
  });

  it('ekran rekordowy pokazywany przez karte rozmowy: kandydat z parametrami z opisu, bez nawigacji do celu', async () => {
    const conv = h.platform.services.conversations.create({ ownerId: h.ownerId, firstMessage: { content: 'x' } });
    const caseId = h.service.listCases(h.ownerId)[0]!.id;
    const items = h.service.listCaseOfferItems(caseId, h.ownerId);
    const item = items[0]!;
    const snapshot: UiSnapshot = {
      version: 3,
      clientId: 'ui_tab_show_value',
      capturedAt: new Date().toISOString(),
      conversationId: conv.id,
      spaceId: null,
      url: `/cases/${caseId}`,
      urlTruncated: false,
      target: null,
      view: { id: 'procurement.case.detail', title: 'Szczegoly sprawy', compositionVersion: 'x-1' },
      cards: [],
      cardsSpaceId: null,
      cardsState: 'none',
      cardsOmitted: 0,
      instances: [
        {
          instanceId: 'DataTable-items',
          component: 'DataTable',
          viewId: 'procurement.case.detail',
          source: { operation: 'procurement.case_offer_items', input: { caseId } },
          state: 'ready',
          error: null,
          record: { kind: 'offer_item', idField: 'id' },
          fields: [],
          filter: [],
          sort: null,
          page: null,
          visibleRecordIds: [item.id],
          matched: items.length,
          total: items.length,
          actions: [],
          groupBy: null,
        },
      ],
      instancesOmitted: 0,
      actions: ['navigate'],
    };
    h.platform.services.uiSnapshots.publish(h.ownerId, snapshot);

    const descriptor = h.platform.registry.readOperation('procurement.case_offer_items')!.definition.result!;
    const { result, emitted } = await callTool(
      'ui_show_value',
      { recordKind: 'offer_item', recordId: item.id, field: 'unitPriceMinor' },
      revealsIt(item as never, 'unitPriceMinor', descriptor),
      { conversationId: conv.id },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.reveal).toMatchObject({
      presentation: { kind: 'view', viewId: 'procurement.case.detail' },
      source: { operation: 'procurement.case_offer_items', input: { caseId } },
    });
    expect(result).toMatchObject({ shown: true, matchesBackend: true, fieldLabel: 'Cena jednostkowa' });
    // The amount is compared as the backend formats it, with the record's own currency.
    expect(result.backend.displayedText).toBe(formatFieldValue(item as never, descriptor.fields.find((f) => f.field === 'unitPriceMinor')!));
  });

  it('kontrakt narzedzia: tylko odczyt, zawsze w promptcie, schemat zgodny z MCP', () => {
    const tool = platformTools(h.platform.services).find((t) => t.name === 'ui_show_value')!;
    expect(tool.effect).toBe('read');
    expect(tool.alwaysLoad).toBe(true);
    expect(() => assertMcpCompatibleShape('ui_show_value', tool.inputSchema.shape as Record<string, unknown>)).not.toThrow();
  });

  it('prompt uczy: najpierw znajdz rekord, potem pokaz; found to nie shown', () => {
    const prompt = buildSystemPrompt({
      registry: h.platform.registry,
      catalog: h.platform.services.catalog,
      appContext: EMPTY_CONTEXT('c1'),
      resourceSummary: null,
      readOperations: [],
      toolNames: [],
      workspaceDir: null,
    } as never);
    expect(prompt).toContain('## Pokazanie wartosci pola rekordu');
    expect(prompt).toContain('mcp__app__ui_show_value');
    expect(prompt).toContain('Mow, ze pokazales wartosc, TYLKO gdy shown=true');
    expect(prompt).toContain('Odpowiedz tylko tekstem z wartoscia NIE zastepuje pokazania.');
  });
});

/* -------------------------------------------------------------------------- */
/*  The browser's half, as pure functions                                     */
/* -------------------------------------------------------------------------- */

const descriptor: ReadResultDescriptor = {
  collection: 'things',
  record: { kind: 'thing', idField: 'id', titleField: 'name' },
  fields: [
    { field: 'name', label: 'Nazwa', type: 'text' },
    { field: 'group', label: 'Grupa', type: 'text' },
    { field: 'size', label: 'Rozmiar', type: 'number' },
  ],
};

const things = Array.from({ length: 12 }, (_, i) => ({
  id: `t${i + 1}`,
  name: `Rzecz ${String(i + 1).padStart(2, '0')}`,
  group: i % 2 === 0 ? 'a' : 'b',
  size: i + 1,
}));

const response: ReadResponse = {
  operation: 'm.things',
  result: { things },
  descriptor,
  resolvedAt: new Date().toISOString(),
};

const locate = (over: Partial<Parameters<typeof locateRecord>[0]> = {}): RecordLocation =>
  locateRecord({
    response,
    props: { pageSize: 5 },
    narrowing: [],
    addressSort: null,
    page: null,
    recordId: 't7',
    field: 'name',
    ...over,
  });

describe('gdzie jest rekord w tabeli (locateRecord)', () => {
  it('rekord na dalszej stronie: podaje strone i rekord, ktorego wiersz rysuje tabela', () => {
    const at = locate();
    expect(at).toMatchObject({ status: 'present', page: 2, pageShown: 1, pageSize: 5, pageCount: 3, title: 'Rzecz 07' });
    expect((at as any).record.id).toBe('t7');
  });

  it('kolejnosc z adresu zmienia strone rekordu', () => {
    expect(locate({ addressSort: { field: 'size', direction: 'desc' } })).toMatchObject({ status: 'present', page: 2 });
    expect(locate({ recordId: 't12', addressSort: { field: 'size', direction: 'desc' } })).toMatchObject({ page: 1 });
  });

  it('zawezenie z adresu, ktore ukrywa rekord: wskazuje TYLKO warunki, ktorych rekord nie spelnia', () => {
    const at = locate({
      narrowing: [
        { field: 'group', op: 'eq', value: 'b' },
        { field: 'name', op: 'contains', value: 'Rzecz' },
      ],
    });
    expect(at).toMatchObject({ status: 'excluded_by_narrowing', pageShown: 1 });
    expect((at as any).excluding).toEqual([{ field: 'group', op: 'eq', value: 'b' }]);
    expect((at as any).kept).toEqual([{ field: 'name', op: 'contains', value: 'Rzecz' }]);
  });

  it('staly filtr kompozycji, brak pola i brak rekordu to trzy rozne odpowiedzi', () => {
    expect(locate({ props: { pageSize: 5, filter: [{ field: 'group', op: 'eq', value: 'b' }] } })).toEqual({
      status: 'excluded_by_composition',
    });
    expect(locate({ props: { pageSize: 5, columns: ['group'] } })).toEqual({ status: 'field_not_shown' });
    expect(locate({ recordId: 'nie-ma' })).toEqual({ status: 'absent' });
    expect(locate({ response: null })).toEqual({ status: 'unavailable' });
  });
});

describe('plan odslaniania (planReveal)', () => {
  const address = {
    targetId: 'm.things',
    key: 'k',
    predicates: [] as any[],
    filterFields: [
      { field: 'group', label: 'Grupa' },
      { field: 'name', label: 'Nazwa' },
    ],
  };

  it('rekord na tej samej stronie: nic sie nie zmienia', () => {
    const plan = planReveal({
      target: { address, showPage: null },
      locate: () => locate({ recordId: 't2' }),
      labelOf: (f) => f,
    });
    expect(plan).toEqual({ kind: 'ready', adjustments: [] });
  });

  it('inna strona instancji glownej: zmiana adresu i zgloszona zmiana strony', () => {
    const plan = planReveal({ target: { address, showPage: null }, locate: () => locate(), labelOf: (f) => f }) as any;
    expect(plan.kind).toBe('address');
    expect(plan.patch).toEqual({ page: '2' });
    expect(plan.predicatesChanged).toBe(false);
    expect(plan.adjustments).toEqual([{ kind: 'page_changed', detail: 'strona 1 → 2', from: 1, to: 2 }]);
  });

  it('tabela stronicujaca w pamieci przewraca strone bez adresu', () => {
    const plan = planReveal({
      target: { address: null, showPage: () => {} },
      locate: () => locate(),
      labelOf: (f) => f,
    }) as any;
    expect(plan.kind).toBe('page');
    expect(plan.page).toBe(2);
  });

  it('zawezenie ukrywajace rekord: znika tylko ono, strona ustawiona, obie zmiany zgloszone', () => {
    const narrowing = [
      { field: 'group', op: 'eq' as const, value: 'b' },
      { field: 'name', op: 'contains' as const, value: 'Rzecz' },
    ];
    const plan = planReveal({
      target: { address: { ...address, predicates: narrowing }, showPage: null },
      locate: (kept) => locate({ narrowing: kept ?? narrowing }),
      labelOf: (f) => address.filterFields.find((x) => x.field === f)!.label,
    }) as any;
    expect(plan.kind).toBe('address');
    // The narrowing the record fails is removed; the one it satisfies stays.
    expect(plan.patch).toEqual({ group: undefined, name: '~Rzecz', page: '2' });
    expect(plan.predicatesChanged).toBe(true);
    expect(plan.adjustments).toEqual([
      { kind: 'filter_cleared', detail: 'Grupa: b', predicates: [narrowing[0]] },
      { kind: 'page_changed', detail: 'strona 1 → 2', from: 1, to: 2 },
    ]);
  });

  it('czego nie da sie zmienic prezentacja, konczy sie not_present', () => {
    for (const at of [
      { status: 'absent' as const },
      { status: 'field_not_shown' as const },
      { status: 'excluded_by_composition' as const },
    ]) {
      expect(planReveal({ target: { address, showPage: null }, locate: () => at, labelOf: (f) => f })).toEqual({
        kind: 'refuse',
        reason: UI_COMMAND_FAILURES.notPresent,
        why: at.status,
      });
    }
    expect(
      planReveal({ target: { address: null, showPage: null }, locate: () => locate(), labelOf: (f) => f }),
    ).toMatchObject({ kind: 'refuse', reason: UI_COMMAND_FAILURES.notPresent });
  });

  it('adres komunikatu obejmuje stan widoku, ale nie parametry sesji', () => {
    expect(revealAddress('/data', { c: 'cnv_1', s: 'spc_1', page: '2' })).toBe(revealAddress('/data', { page: '2' }));
    expect(revealAddress('/data', { page: '2' })).not.toBe(revealAddress('/data', {}));
    expect(revealAddress('/data', {})).not.toBe(revealAddress('/cases', {}));
  });
});

describe('kontrakt polecenia i potwierdzenia', () => {
  it('polecenie niesie rekord, pole i instancje; potwierdzenie — tekst, wartosc i zmiany prezentacji', () => {
    const command = uiCommandSchema.parse({
      commandId: 'uic_12345678',
      runId: 'run_1',
      conversationId: 'cnv_1',
      targetId: 'procurement.data',
      reveal: {
        recordKind: 'supplier',
        recordId: 'pcs_1',
        field: 'taxId',
        presentation: { kind: 'view', viewId: 'procurement.data' },
        source: { operation: 'procurement.suppliers' },
      },
    });
    expect(command.reveal!.presentation).toEqual({ kind: 'view', viewId: 'procurement.data' });

    const ack = uiCommandResultSchema.parse({
      commandId: 'uic_12345678',
      executed: true,
      highlighted: true,
      revealed: {
        recordKind: 'supplier',
        recordId: 'pcs_1',
        field: 'taxId',
        displayedText: '5213456789',
        rawValue: '5213456789',
        page: { index: 2, size: 10, count: 2 },
        adjustments: [{ kind: 'page_changed', detail: 'strona 1 → 2', from: 1, to: 2 }],
      },
    });
    expect(ack.revealed!.adjustments[0]!.kind).toBe('page_changed');
    expect(UI_REVEAL_ADJUSTMENT_KINDS).toEqual(['filter_cleared', 'page_changed', 'card_focused']);

    // A presentation must name a place; an adjustment must be one of the kinds.
    expect(() =>
      uiCommandSchema.parse({ ...command, reveal: { ...command.reveal, presentation: { kind: 'somewhere' } } }),
    ).toThrow();
    expect(() =>
      uiCommandResultSchema.parse({
        ...ack,
        revealed: { ...ack.revealed, adjustments: [{ kind: 'data_changed', detail: 'x' }] },
      }),
    ).toThrow();
  });
});
