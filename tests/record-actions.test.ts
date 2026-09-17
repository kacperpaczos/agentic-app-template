import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EMPTY_APP_CONTEXT,
  formatFieldValue,
  parseFieldInput,
  readResultDescriptorSchema,
  recordsOf,
  type ModuleToolDefinition,
  type ReadResultDescriptor,
  type RecordField,
  type ServerModule,
  type ToolCallContext,
} from '@platform/contracts';
import {
  RECORD_ACTION_SCOPE,
  ServerModuleRegistry,
  buildSystemPrompt,
  collectToolEntries,
  platformTools,
} from '@platform/server';
import { createHarness, caseCode, login, type Harness } from './helpers.ts';

/**
 * Record actions: an interaction a read's descriptor declares, performed from
 * any table over the read through `POST /api/actions`.
 *
 * Test kontraktu lub logiki: the real platform and module on a throw-away
 * database, requests through the HTTP app. What has to hold is that a user's
 * action is the module's authorized operation and nothing else — the record
 * re-read as the session's owner, the tool the MCP server exposes run through
 * the same execution, a repeated request not changing data twice — and that a
 * module cannot declare an action that could not work or that writes through
 * a read tool or another module's tool.
 */

let h: Harness;
let cookie: string;
let otherCookie: string;
let caseId: string;

const OPERATION = 'procurement.case_offer_items';
const ACTION = 'change_unit_price';
const TOOL = 'procurement_update_offer_item';

const api = async (path: string, init: RequestInit & { as?: string | null } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const who = init.as === undefined ? cookie : init.as;
  if (who) headers.cookie = who;
  const res = await h.platform.app.request(path, { ...init, headers });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const act = (body: Record<string, unknown>, as?: string | null) =>
  api('/api/actions', { method: 'POST', body: JSON.stringify(body), as });

/** The case's offer items as `POST /api/read` returns them to the first owner. */
async function items(): Promise<Array<Record<string, any>>> {
  const res = await api('/api/read', { method: 'POST', body: JSON.stringify({ operation: OPERATION, input: { caseId } }) });
  expect(res.status).toBe(200);
  return recordsOf(res.body.result, res.body.descriptor);
}

const projectorOf = async (supplierPrefix: string) =>
  (await items()).find((r) => String(r.supplierName).startsWith(supplierPrefix) && /Projektor/.test(r.name))!;

const versionOf = (itemId: string) => h.service.repo.getItem(itemId, h.ownerId).item.version;

let seq = 0;
const opId = () => `test-action-${++seq}-${Date.now()}`;

/**
 * Counts calls of the handler the registry holds for the tool — the object the
 * MCP server's tool list is built from — without replacing what it does.
 */
function spyOnToolHandler() {
  const def = h.platform.registry.tool(TOOL)!.definition as ModuleToolDefinition<unknown>;
  const original = def.handler;
  const calls: Array<{ input: any; ctx: ToolCallContext }> = [];
  def.handler = async (input, ctx) => {
    calls.push({ input, ctx });
    return original(input, ctx);
  };
  return { calls, def, restore: () => void (def.handler = original) };
}

beforeAll(async () => {
  h = await createHarness();
  cookie = await login(h.platform.app, h.ownerId);
  otherCookie = await login(h.platform.app, h.otherOwnerId);
  caseId = h.service.repo.findCaseByCode(caseCode, h.ownerId)!.id;
});
afterAll(() => h.dispose());

/* -------------------------------------------------------------------------- */

describe('POST /api/actions', () => {
  let spy: ReturnType<typeof spyOnToolHandler>;
  beforeEach(() => {
    spy?.restore();
    spy = spyOnToolHandler();
  });
  afterAll(() => spy?.restore());

  it('zmienia cene przez handler narzedzia MCP modulu: odczyt, wersja pozycji i zmienione zasoby', async () => {
    const item = await projectorOf('AV Technika');
    const before = versionOf(item.id);
    const operationId = opId();

    const res = await act({
      operation: OPERATION,
      input: { caseId },
      action: ACTION,
      recordId: item.id,
      values: { unitPrice: '9 999,50' },
      operationId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ operation: OPERATION, action: ACTION, recordId: item.id, replayed: false });
    expect(res.body.result.item).toMatchObject({ id: item.id, unitPriceMinor: 999950, version: before + 1 });

    // The data a table reads back is the change.
    expect((await items()).find((r) => r.id === item.id)!.unitPriceMinor).toBe(999950);
    expect(versionOf(item.id)).toBe(before + 1);

    // The handler ran once, as the session's owner and outside any run, with
    // the input built from the re-read record and the parsed form.
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.input).toEqual({ itemId: item.id, unitPrice: 9999.5, operationId });
    expect(spy.calls[0]!.ctx).toMatchObject({ ownerId: h.ownerId, runId: null, conversationId: null });
    // It is the handler the MCP server offers the model under that name.
    const entry = collectToolEntries({ registry: h.platform.registry, platformTools: platformTools(h.platform.services) })
      .find((e) => e.localName === TOOL)!;
    expect(entry.def).toBe(spy.def);
    expect(entry.def.handler).toBe(spy.def.handler);

    // Only the tool handler reports these resources (the module's PATCH route does not).
    const offerId = h.service.repo.getItem(item.id, h.ownerId).offer.id;
    expect(res.body.changed).toEqual([`case:${caseId}`, `offer:${offerId}`]);
    // The tool received the action's operationId, so the service's own replay guard covers the call too.
    expect(h.platform.services.idempotency.get(operationId, h.ownerId, 'procurement.updateOfferItem')).toBeTruthy();
    expect(h.platform.services.idempotency.get(operationId, h.ownerId, RECORD_ACTION_SCOPE)).toBeTruthy();
  });

  it('powtorzony operationId zwraca pierwszy wynik i nie zmienia danych drugi raz', async () => {
    const item = await projectorOf('MediaPro');
    const before = versionOf(item.id);
    const body = {
      operation: OPERATION,
      input: { caseId },
      action: ACTION,
      recordId: item.id,
      values: { unitPrice: '14250' },
      operationId: opId(),
    };
    const first = await act(body);
    expect(first.status).toBe(200);
    // Same request, keys in another order: still the same request.
    const again = await act({ values: body.values, operationId: body.operationId, recordId: item.id, action: ACTION, input: { caseId }, operation: OPERATION });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.result).toEqual(first.body.result);
    expect(again.body.changed).toEqual(first.body.changed);
    expect(spy.calls).toHaveLength(1);
    expect(versionOf(item.id)).toBe(before + 1);

    // The same operationId for a different value is not the first request's answer.
    const reused = await act({ ...body, values: { unitPrice: '1' } });
    expect(reused.status).toBe(409);
    expect(reused.body.error.details.reason).toBe('operation_id_reused');
    expect(spy.calls).toHaveLength(1);
    expect((await items()).find((r) => r.id === item.id)!.unitPriceMinor).toBe(1425000);
    expect(versionOf(item.id)).toBe(before + 1);
  });

  it('walidacja: kazda odmowa bez zmiany danych i bez wywolania narzedzia', async () => {
    const item = await projectorOf('Konferencje24');
    const snapshot = JSON.stringify(await items());
    const base = { operation: OPERATION, input: { caseId }, action: ACTION, recordId: item.id, values: { unitPrice: '100' } };

    const cases: Array<[string, Record<string, unknown>, number, Record<string, unknown>]> = [
      ['bez operationId', { ...base }, 400, { code: 'validation_failed', reason: 'invalid_request' }],
      ['nieznana akcja', { ...base, action: 'usun', operationId: opId() }, 400, { code: 'validation_failed', reason: 'unknown_action' }],
      [
        'odczyt bez akcji',
        { ...base, operation: 'procurement.comparison', operationId: opId() },
        400,
        { code: 'validation_failed', reason: 'unknown_action' },
      ],
      ['nieznana operacja', { ...base, operation: 'procurement.nie_ma', operationId: opId() }, 400, { reason: 'unknown_operation' }],
      ['wejscie odczytu bez caseId', { ...base, input: {}, operationId: opId() }, 400, { reason: 'invalid_input' }],
      ['wartosc nie jest liczba', { ...base, values: { unitPrice: '12,3,4' }, operationId: opId() }, 400, { reason: 'invalid_value' }],
      ['pusta wartosc', { ...base, values: { unitPrice: '  ' }, operationId: opId() }, 400, { reason: 'invalid_value' }],
      ['brak wartosci', { ...base, values: {}, operationId: opId() }, 400, { reason: 'invalid_value' }],
      ['pole spoza formularza', { ...base, values: { unitPrice: '1', quantity: '5' }, operationId: opId() }, 400, { reason: 'invalid_value' }],
      ['rekord spoza odczytu', { ...base, recordId: 'itm_nie_ma', operationId: opId() }, 404, { code: 'not_found', reason: 'record_not_found' }],
    ];
    for (const [name, body, status, expected] of cases) {
      const res = await act(body);
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(status);
      if (expected.code) expect(res.body.error.code, name).toBe(expected.code);
      if (expected.reason) expect(res.body.error.details?.reason, name).toBe(expected.reason);
    }
    // A refused value names the field the user sees.
    const named = await act({ ...base, values: { unitPrice: 'dwanascie' }, operationId: opId() });
    expect(named.body.error.message).toContain('Nowa cena jednostkowa');
    const unknown = await act({ ...base, action: 'usun', operationId: opId() });
    expect(unknown.body.error.details.available).toEqual([ACTION]);

    // A business rule is the service's, answered as over MCP (`domain_rule_violated`).
    const negative = await act({ ...base, values: { unitPrice: '-5' }, operationId: opId() });
    expect(negative.status).toBe(422);
    expect(negative.body.error.code).toBe('domain_rule_violated');
    expect(spy.calls).toHaveLength(1); // only the rule check above reached the handler

    // No session, no action.
    expect((await act({ ...base, operationId: opId() }, null)).status).toBe(401);

    expect(JSON.stringify(await items())).toBe(snapshot);
  });

  it('rekord innego wlasciciela jest odrzucony, dane bez zmian, a jego operationId nie blokuje wlasciciela', async () => {
    const item = await projectorOf('Konferencje24');
    const snapshot = JSON.stringify(await items());
    const operationId = opId();
    const body = { operation: OPERATION, input: { caseId }, action: ACTION, recordId: item.id, values: { unitPrice: '1' }, operationId };

    // The other identity names the first owner's case and item: the re-read is refused by the module.
    const foreign = await act(body, otherCookie);
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('forbidden');
    expect(JSON.stringify(foreign.body)).not.toContain(String(item.name));
    // Its own read of anything returns no such record either.
    const ownRead = await act({ ...body, operation: 'procurement.cases', input: {}, operationId: opId() }, otherCookie);
    expect(ownRead.status).toBe(400);
    expect(spy.calls).toHaveLength(0);
    expect(JSON.stringify(await items())).toBe(snapshot);

    // Nothing was stored under the refused request: the owner's own request with that id runs.
    const mine = await act({ ...body, values: { unitPrice: '10500,25' } });
    expect(mine.status).toBe(200);
    expect(mine.body.replayed).toBe(false);
    expect((await items()).find((r) => r.id === item.id)!.unitPriceMinor).toBe(1050025);
  });
});

/* -------------------------------------------------------------------------- */

describe('kontrola startowa akcji rekordu', () => {
  const noop = async () => ({});
  const tool = (
    name: string,
    effect: 'read' | 'write',
    inputSchema: z.ZodObject = z.object({ id: z.string(), value: z.number().optional(), operationId: z.string().optional() }),
  ) =>
    ({ name, description: name, effect, inputSchema, handler: noop }) as unknown as ModuleToolDefinition<never>;

  const descriptor = (actions: unknown): ReadResultDescriptor =>
    ({
      collection: 'things',
      record: { kind: 'thing', idField: 'id', titleField: 'name' },
      fields: [
        { field: 'name', label: 'Nazwa', type: 'text' },
        { field: 'amount', label: 'Kwota', type: 'number' },
      ],
      actions,
    }) as ReadResultDescriptor;

  const moduleWith = (id: string, actions: unknown, tools: ModuleToolDefinition<never>[]): ServerModule => ({
    meta: { id, title: id, version: '0', description: id },
    migrations: [],
    tools,
    readOperations: [
      {
        name: 'things',
        description: 'things',
        inputSchema: z.object({}),
        run: async () => ({ things: [] }),
        result: descriptor(actions),
      },
    ],
  });

  const good = {
    id: 'set_value',
    label: 'Ustaw',
    tool: 'save',
    input: [
      { key: 'id', from: '$record.id' },
      { key: 'value', from: '$form.value' },
    ],
    form: [{ key: 'value', label: 'Wartosc', type: 'number' }],
  };

  const refuse = (mod: ServerModule, registry = new ServerModuleRegistry()) => {
    let message = '';
    try {
      registry.register(mod);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message, 'modul powinien zostac odrzucony').not.toBe('');
    // A refused module leaves nothing behind.
    expect(registry.readOperation(`${mod.meta.id}.things`)).toBeUndefined();
    return message;
  };

  it('poprawna akcja i modul przykladowy przechodza', () => {
    const registry = new ServerModuleRegistry().register(moduleWith('m', [good], [tool('save', 'write')]));
    expect(registry.readOperation('m.things')!.definition.result!.actions![0]!.id).toBe('set_value');
    const offerItems = h.platform.registry.readOperation(OPERATION)!.definition.result!;
    expect(offerItems.actions!.map((a) => [a.id, a.tool])).toEqual([[ACTION, 'update_offer_item']]);
  });

  it('akcja wskazujaca narzedzie odczytu jest odrzucona z nazwa akcji i narzedzia', () => {
    const message = refuse(moduleWith('m', [{ ...good, tool: 'list' }], [tool('save', 'write'), tool('list', 'read')]));
    expect(message).toContain('akcja set_value');
    expect(message).toContain('narzedzie list jest narzedziem odczytu');
  });

  it('akcja wskazujaca narzedzie innego modulu jest odrzucona', () => {
    const registry = new ServerModuleRegistry().register(moduleWith('inny', [], [tool('save_other', 'write')]));
    const message = refuse(moduleWith('m', [{ ...good, tool: 'save_other' }], [tool('save', 'write')]), registry);
    expect(message).toContain('narzedzie save_other nie jest narzedziem modulu m');
    expect(message).toContain('save');
    // Qualified with the other module's prefix it is still not this module's tool.
    const qualified = refuse(moduleWith('m', [{ ...good, tool: 'inny_save_other' }], [tool('save', 'write')]), registry);
    expect(qualified).toContain('nie jest narzedziem modulu m');
  });

  it('wejscie spoza schematu narzedzia, brak wymaganego wejscia i mapowane operationId sa odrzucone', () => {
    expect(
      refuse(moduleWith('m', [{ ...good, input: [...good.input, { key: 'kolor', from: '$record.name' }] }], [tool('save', 'write')])),
    ).toContain('wejscie kolor nie istnieje w schemacie narzedzia save');
    expect(
      refuse(moduleWith('m', [{ ...good, input: [good.input[1]] }], [tool('save', 'write')])),
    ).toContain('narzedzie save wymaga wejscia id');
    expect(
      refuse(
        moduleWith('m', [{ ...good, input: [...good.input, { key: 'operationId', from: '$record.name' }] }], [tool('save', 'write')]),
      ),
    ).toContain('wejscia operationId nie mapuje sie');
  });

  it('pole formularza niezgodne z typem wejscia narzedzia jest odrzucone', () => {
    const message = refuse(
      moduleWith('m', [{ ...good, form: [{ key: 'value', label: 'Wartosc', type: 'text' }] }], [tool('save', 'write')]),
    );
    expect(message).toContain('pole formularza value (text) nie pasuje do typu wejscia value');
    // Minor units need an integer or number input; a decimal form needs a number input, not an integer one.
    const integerInput = z.object({ id: z.string(), value: z.number().int() });
    expect(() =>
      new ServerModuleRegistry().register(
        moduleWith('m', [{ ...good, form: [{ key: 'value', label: 'W', type: 'money_minor' }] }], [tool('save', 'write', integerInput)]),
      ),
    ).not.toThrow();
    expect(
      refuse(moduleWith('m', [good], [tool('save', 'write', integerInput)])),
    ).toContain('pole formularza value (number) nie pasuje');
  });

  it('deskryptor: pole rekordu spoza deskryptora, nieuzywane pole formularza i powtorzenia sa odrzucane z nazwa', () => {
    const check = (actions: unknown) => {
      const parsed = readResultDescriptorSchema.safeParse(descriptor(actions));
      expect(parsed.success).toBe(false);
      return parsed.error!.issues.map((i) => i.message).join(' | ');
    };
    expect(check([{ ...good, input: [{ key: 'id', from: '$record.cena' }, good.input[1]] }])).toContain(
      '$record.cena nie jest zadeklarowanym polem rekordu ani idField',
    );
    expect(check([{ ...good, input: [good.input[0], { key: 'value', from: '$form.inne' }] }])).toContain(
      '$form.inne nie jest polem formularza akcji',
    );
    expect(check([{ ...good, input: [good.input[0]] }])).toContain('pole formularza value nie trafia do zadnego wejscia');
    expect(check([good, good])).toContain('identyfikator akcji powtarza sie');
    expect(check([{ ...good, input: [...good.input, good.input[0]] }])).toContain('wejscie id jest mapowane dwa razy');
    expect(check([{ ...good, input: [{ key: 'id', from: 'record.id' }] }])).toContain('Oczekiwano $record.<pole> albo $form.<klucz>');
    // The descriptor without actions is unchanged.
    expect(readResultDescriptorSchema.safeParse(descriptor(undefined)).success).toBe(true);
    // And the module refuses to start on it, naming the operation.
    expect(refuse(moduleWith('m', [{ ...good, input: [{ key: 'id', from: '$record.cena' }, good.input[1]] }], [tool('save', 'write')])))
      .toContain('Operacja odczytu m.things: niepoprawny deskryptor wyniku');
  });

  it('prompt mowi, ktore narzedzie wykonuje akcje rekordu tabeli', () => {
    const prompt = buildSystemPrompt({
      registry: h.platform.registry,
      catalog: h.platform.services.catalog,
      appContext: EMPTY_APP_CONTEXT,
      resourceSummary: null,
      workspaceDir: null,
      stagedFiles: [],
      toolkit: [],
    });
    const lines = prompt.split('\n');
    const at = lines.findIndex((l) => l.startsWith(`- ${OPERATION}:`));
    expect(lines[at + 2]).toBe(
      '  kazda DataTable tej operacji daje uzytkownikowi akcje rekordu: Zmien cene (mcp__app__procurement_update_offer_item)',
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('wartosci formularza akcji', () => {
  const money: RecordField = { field: 'v', label: 'Kwota', type: 'money_minor' };
  const qty: RecordField = { field: 'v', label: 'Ilosc', type: 'quantity_milli' };
  const num: RecordField = { field: 'v', label: 'Liczba', type: 'number' };

  it('czyta liczbe tak, jak wypisuje ja tabela — w obie strony', () => {
    for (const minor of [0, 29, 100, 1999, 123456, 999950, -150, 1234567890]) {
      const shown = formatFieldValue({ v: minor }, money);
      expect(parseFieldInput(shown, { label: 'Kwota', type: 'money_minor' }), shown).toBe(minor);
    }
    for (const milli of [0, 1, 2125, 16000, 1234567]) {
      const shown = formatFieldValue({ v: milli }, qty);
      expect(parseFieldInput(shown, { label: 'Ilosc', type: 'quantity_milli' }), shown).toBe(milli);
    }
    for (const value of [0, 12.5, 1234.5, 9999.5, -3.25, 1234567]) {
      const shown = formatFieldValue({ v: value }, num);
      expect(parseFieldInput(shown, { label: 'Liczba', type: 'number' }), shown).toBe(value);
    }
  });

  it('przyjmuje kropke i spacje, odmawia nadmiaru miejsc po przecinku zamiast zaokraglac', () => {
    const f = (type: 'money_minor' | 'quantity_milli' | 'number' | 'text') => ({ label: 'Pole X', type });
    expect(parseFieldInput('19,99', f('money_minor'))).toBe(1999);
    expect(parseFieldInput('19.9', f('money_minor'))).toBe(1990);
    expect(parseFieldInput(' 12 400 ', f('money_minor'))).toBe(1240000);
    expect(parseFieldInput('12\u00a0400,5', f('number'))).toBe(12400.5);
    expect(parseFieldInput('2,125', f('quantity_milli'))).toBe(2125);
    expect(parseFieldInput('  opis  ', f('text'))).toBe('opis');
    for (const [text, type] of [
      ['12,345', 'money_minor'],
      ['1,2345', 'quantity_milli'],
      ['abc', 'number'],
      ['12,3,4', 'number'],
      ['1 23', 'number'],
      ['12.', 'number'],
      ['', 'text'],
      ['   ', 'money_minor'],
    ] as const) {
      expect(() => parseFieldInput(text, f(type)), `${type} "${text}"`).toThrow(/Pole Pole X:/);
    }
  });
});
