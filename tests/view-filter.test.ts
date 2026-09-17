import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLATFORM_CUSTOM_EVENTS,
  UI_COMMAND_FAILURES,
  filterFromSearch,
  filterToSearch,
  rowMatchesFilter,
  rowMatchesPredicate,
  uiCommandSchema,
  type ToolCallContext,
  type UiCommand,
  type ViewFilterPredicate,
} from '@platform/contracts';
import { AgentRuntime, buildUiTargetCatalog, platformTools, RunEventStream } from '@platform/server';
import { createHarness, type Harness } from './helpers.ts';

/**
 * Narrowing a view instead of retyping rows into the conversation.
 *
 * The behaviour this replaces was observed in the running application. Asked to
 * show only the Polish suppliers, the agent listed them in the chat. The screen
 * still showed all four, so the user had the full list in front of them and a
 * hand-copied subset beside it — a copy that cannot be sorted, will not update,
 * and is exactly as correct as the retyping was.
 *
 * Two properties are under test, and the second is the one that makes this safe:
 *
 *  1. the narrowing reaches the view and the agent is told what the *view*
 *     counted, not what the server predicted;
 *  2. a narrowing the view cannot honour is refused **by name**, before the
 *     browser is asked for anything. An agent able to filter by an invented
 *     property would produce an empty screen and call it an answer.
 */

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(() => h.dispose());

const EMPTY_CONTEXT = (conversationId: string) => ({
  conversationId,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
});

/**
 * Calls `ui_filter` the way a run does, over the runtime's real acknowledgement
 * gate and a real event stream — the same composition `ui_navigate` is tested
 * through, so the command the browser would receive is the one asserted here.
 */
async function callFilter(
  input: Record<string, unknown>,
  ack: (command: UiCommand, runtime: AgentRuntime) => void | Promise<void>,
): Promise<{ result?: any; error?: unknown; emitted: UiCommand[] }> {
  const runtime = new AgentRuntime(h.platform.services);
  const conv = h.platform.services.conversations.create({
    ownerId: h.ownerId,
    firstMessage: { content: 'pokaz tylko polskich' },
  });
  const run = h.platform.services.runs.start({
    conversationId: conv.id,
    ownerId: h.ownerId,
    prompt: 'pokaz tylko polskich',
    appContext: EMPTY_CONTEXT(conv.id),
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
    ownerId: h.ownerId,
    appContext: EMPTY_CONTEXT(conv.id),
    conversationId: conv.id,
    runId: run.id,
    workspaceDir: null,
    emit: () => {},
    requestUi: (command) =>
      runtime.requestUiCommand(
        {
          commandId: `uic_${Math.random().toString(36).slice(2, 12)}`,
          runId: run.id,
          conversationId: conv.id,
          targetId: command.targetId,
          spaceId: command.spaceId ?? null,
          ...(command.filter !== undefined ? { filter: command.filter } : {}),
          reason: command.reason,
        },
        stream,
        400,
      ),
  };

  const tool = platformTools(h.platform.services).find((t) => t.name === 'ui_filter')!;
  const out: { result?: any; error?: unknown; emitted: UiCommand[] } = { emitted };
  try {
    out.result = await tool.handler(input as never, ctx);
  } catch (e) {
    out.error = e;
  }
  stream.close();
  await watcher;
  return out;
}

/** A client that applies everything and reports the counts a view would. */
const applies = (matched: number, total: number) =>
  async (command: UiCommand, runtime: AgentRuntime) => {
    runtime.acknowledgeUiCommand({
      commandId: command.commandId,
      targetId: command.targetId,
      executed: true,
      filtered: { matched, total },
      url: '/data',
    });
  };

describe('co znaczy zawezenie', () => {
  const row = { name: 'Alfa Sp. z o.o.', country: 'PL', taxId: null };

  it('eq, neq, contains i in porownuja tekstem, bez wzgledu na wielkosc liter', () => {
    expect(rowMatchesPredicate(row, { field: 'country', op: 'eq', value: 'pl' })).toBe(true);
    expect(rowMatchesPredicate(row, { field: 'country', op: 'eq', value: 'FI' })).toBe(false);
    expect(rowMatchesPredicate(row, { field: 'country', op: 'neq', value: 'FI' })).toBe(true);
    expect(rowMatchesPredicate(row, { field: 'name', op: 'contains', value: 'alfa' })).toBe(true);
    expect(rowMatchesPredicate(row, { field: 'country', op: 'in', value: ['PL', 'CZ'] })).toBe(true);
    expect(rowMatchesPredicate(row, { field: 'country', op: 'in', value: ['DE'] })).toBe(false);
  });

  it('brakujaca albo pusta wartosc nie pasuje do niczego — takze do neq', () => {
    /*
     * Deliberate. `neq` on a row that has no such property reads as "keep it,
     * it is certainly not equal" — and that would put rows with no data into a
     * result the user asked to be narrow. Absence is not evidence.
     */
    expect(rowMatchesPredicate(row, { field: 'taxId', op: 'neq', value: '123' })).toBe(false);
    expect(rowMatchesPredicate(row, { field: 'nieistnieje', op: 'eq', value: 'x' })).toBe(false);
  });

  it('warunki lacza sie koniunkcja', () => {
    expect(
      rowMatchesFilter(row, [
        { field: 'country', op: 'eq', value: 'PL' },
        { field: 'name', op: 'contains', value: 'alfa' },
      ]),
    ).toBe(true);
    expect(
      rowMatchesFilter(row, [
        { field: 'country', op: 'eq', value: 'PL' },
        { field: 'name', op: 'contains', value: 'beta' },
      ]),
    ).toBe(false);
  });
});

describe('katalog mowi, po czym wolno zawezac', () => {
  it('ui_catalog podaje filterableFields tylko dla widokow, ktore je deklaruja', async () => {
    const catalog = platformTools(h.platform.services).find((t) => t.name === 'ui_catalog')!;
    const out: any = await catalog.handler({} as never, {
      ownerId: h.ownerId,
      appContext: EMPTY_CONTEXT('c'),
      conversationId: 'c',
      runId: 'r',
      workspaceDir: null,
      emit: () => {},
    } as never);

    const data = out.targets.find((t: any) => t.id === 'procurement.data');
    expect(data.filterableFields.map((f: any) => f.field)).toContain('country');
    // Values are listed where the set is small and known, so the agent uses the
    // codes that are in the data instead of inventing "Polska".
    expect(data.filterableFields.find((f: any) => f.field === 'country').values).toContain('PL');

    const settings = out.targets.find((t: any) => t.id === 'platform.settings');
    expect(settings.filterableFields).toBeUndefined();
  });
});

describe('zawezanie widoku przez agenta', () => {
  it('przekazuje warunki do klienta i zwraca liczby, ktore policzyl WIDOK', async () => {
    const { result, emitted } = await callFilter(
      {
        targetId: 'procurement.data',
        predicates: [{ field: 'country', op: 'eq', value: 'PL' }],
        label: 'tylko dostawcy z Polski',
      },
      applies(3, 4),
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.filter).toMatchObject({
      targetId: 'procurement.data',
      label: 'tylko dostawcy z Polski',
      predicates: [{ field: 'country', op: 'eq', value: 'PL' }],
    });
    expect(result.executed).toBe(true);
    /*
     * The decisive assertion: these numbers come from the acknowledgement, not
     * from anything the server worked out. A tool that computed them itself
     * would report a narrowing the user's screen might never have shown.
     */
    expect(result.filtered).toEqual({ matched: 3, total: 4 });
  });

  it('nieznane pole jest odrzucane po nazwie i NIC nie trafia do przegladarki', async () => {
    const { result, emitted } = await callFilter(
      {
        targetId: 'procurement.data',
        predicates: [{ field: 'wojewodztwo', op: 'eq', value: 'mazowieckie' }],
        label: 'tylko mazowieckie',
      },
      applies(0, 4),
    );

    expect(result.executed).toBe(false);
    expect(result.reason).toBe(UI_COMMAND_FAILURES.unknownField);
    expect(result.requested).toEqual(['wojewodztwo']);
    expect(result.available.map((f: any) => f.field)).toContain('country');
    // Refused before the browser is asked: an empty screen is not a refusal.
    expect(emitted).toHaveLength(0);
  });

  it('widok bez deklaracji zawezania odmawia, zamiast udawac', async () => {
    const { result, emitted } = await callFilter(
      {
        targetId: 'platform.settings',
        predicates: [{ field: 'cokolwiek', op: 'eq', value: 'x' }],
        label: 'cokolwiek',
      },
      applies(1, 1),
    );
    expect(result.executed).toBe(false);
    expect(result.reason).toBe(UI_COMMAND_FAILURES.notFilterable);
    expect(emitted).toHaveLength(0);
  });

  it('nieznany cel zwraca liste celow, ktore istnieja', async () => {
    const { result } = await callFilter(
      { targetId: 'procurement.nie-ma', predicates: [{ field: 'x', op: 'eq', value: 'y' }], label: 'x' },
      applies(1, 1),
    );
    expect(result.reason).toBe(UI_COMMAND_FAILURES.unknownTarget);
    expect(result.available).toContain('procurement.data');
  });

  it('zawezenie bez zdania dla uzytkownika jest bledem, nie cichym filtrem', async () => {
    const { error } = await callFilter(
      { targetId: 'procurement.data', predicates: [{ field: 'country', op: 'eq', value: 'PL' }] },
      applies(3, 4),
    );
    /*
     * The banner is generated from the predicates, so the screen is described
     * correctly with or without this. What it buys is the agent being able to
     * say what it did in the conversation — narrowing a screen silently and
     * then talking about something else is its own kind of wrong.
     */
    expect(String((error as Error).message)).toContain('label');
  });

  it('zawezenie bez warunkow jest bledem — to nie to samo co pelny widok', async () => {
    const { error } = await callFilter(
      { targetId: 'procurement.data', label: 'wszystko' },
      applies(4, 4),
    );
    expect(String((error as Error).message)).toContain('clear=true');
  });

  it('clear=true przywraca pelny widok i dziala na kazdym celu', async () => {
    const { result, emitted } = await callFilter(
      { targetId: 'platform.settings', clear: true },
      async (command, runtime) => {
        runtime.acknowledgeUiCommand({
          commandId: command.commandId,
          targetId: command.targetId,
          executed: true,
          url: '/settings',
        });
      },
    );
    expect(emitted).toHaveLength(1);
    // `null`, not absent: absent would leave whatever narrowing is on screen.
    expect(emitted[0]!.filter).toBeNull();
    expect(result.executed).toBe(true);
    expect(result.cleared).toBe(true);
  });

  it('odmowa klienta jest raportowana, nie nadpisywana', async () => {
    const { result } = await callFilter(
      {
        targetId: 'procurement.data',
        predicates: [{ field: 'country', op: 'eq', value: 'PL' }],
        label: 'tylko z Polski',
      },
      async (command, runtime) => {
        runtime.acknowledgeUiCommand({
          commandId: command.commandId,
          targetId: command.targetId,
          executed: false,
          reason: UI_COMMAND_FAILURES.notApplied,
        });
      },
    );
    expect(result.executed).toBe(false);
    expect(result.reason).toBe(UI_COMMAND_FAILURES.notApplied);
    expect(result.filtered).toBeUndefined();
  });
});

describe('instrukcja agenta', () => {
  it('mowi, ze odpowiadanie o danych to takze ich pokazanie', async () => {
    const { buildSystemPrompt } = await import('@platform/server');
    const prompt = buildSystemPrompt({
      registry: h.platform.services.modules,
      catalog: h.platform.services.catalog,
      appContext: EMPTY_CONTEXT('c'),
      resourceSummary: null,
      workspaceDir: null,
      stagedFiles: [],
      toolkit: [],
    } as never);

    /*
     * Asserted on the prompt because that is where the rule lives; whether the
     * model then obeys it is a question only a real turn can answer, and
     * `e2e/ui-navigation.spec.ts` spends one on exactly that.
     */
    expect(prompt).toContain('ODPOWIADANIE O DANYCH TO TEZ POKAZYWANIE');
    expect(prompt).toContain('ui_filter');
    expect(prompt).toMatch(/zawezanie po: .*country/);
  });
});

describe('pusty wynik wyszukiwania to nie pusta aplikacja', () => {
  /**
   * Straight from a real turn. The agent asked for everything with `query: "*"`,
   * `LIKE '%*%'` matched nothing, and it told the user the application held no
   * cases, no suppliers and no files — while all of them were there. An empty
   * result had been reported as an empty application, and nothing in the answer
   * could have told the two apart.
   */
  it('"*" zwraca wszystko, a nie nic', async () => {
    const all = h.service.search(h.ownerId, '*');
    expect(all.results.length).toBeGreaterThan(0);
    expect(all.results.some((r) => r.kind === 'supplier')).toBe(true);
  });

  it('kazda odpowiedz niesie, ile danych w ogole jest', async () => {
    const nothing = h.service.search(h.ownerId, 'zdecydowanie-nie-istnieje');
    expect(nothing.results).toEqual([]);
    expect(nothing.matched).toBe(0);
    /*
     * The decisive part: the same answer that says "nothing matched" also says
     * how much there is. "0 of 4 suppliers" cannot be paraphrased as "there are
     * no suppliers" without contradicting the payload.
     */
    expect(nothing.totals.suppliers).toBeGreaterThan(0);
    expect(nothing.totals.cases).toBeGreaterThan(0);
  });
});

describe('zawezenie w adresie', () => {
  /**
   * The narrowing belongs in the URL because it decides *which records the user
   * is looking at* — the thing a link, a reload, Back and a bookmark all have to
   * preserve. The first version kept it in memory, which meant a narrowed view
   * could not be shared and did not survive a refresh.
   */
  it('tam i z powrotem: warunki przezywaja zapis do adresu i odczyt', () => {
    const predicates: ViewFilterPredicate[] = [
      { field: 'country', op: 'eq', value: 'PL' },
      { field: 'name', op: 'contains', value: 'av' },
      { field: 'taxId', op: 'neq', value: '123' },
    ];
    const search = filterToSearch(predicates);
    expect(search).toEqual({ country: 'PL', name: '~av', taxId: '!123' });
    expect(filterFromSearch(search, ['country', 'name', 'taxId'])).toEqual(predicates);
  });

  it('lista wartosci zapisuje sie przecinkiem i wraca jako "in"', () => {
    const search = filterToSearch([{ field: 'country', op: 'in', value: ['PL', 'CZ'] }]);
    expect(search).toEqual({ country: 'PL,CZ' });
    expect(filterFromSearch(search, ['country'])).toEqual([
      { field: 'country', op: 'in', value: ['PL', 'CZ'] },
    ]);
  });

  it('parametr, ktorego widok nie deklaruje, nie staje sie filtrem', () => {
    /*
     * A pasted or hand-edited address is a legitimate thing to find. An unknown
     * key is somebody else's parameter or a typo — turning it into a filter on a
     * property that does not exist would empty the screen and look deliberate.
     */
    const found = filterFromSearch(
      { country: 'PL', wojewodztwo: 'mazowieckie', c: 'cnv_1' },
      ['country', 'name'],
    );
    expect(found).toEqual([{ field: 'country', op: 'eq', value: 'PL' }]);
  });

  it('pusty parametr to brak filtra, nie filtr na pusty tekst', () => {
    expect(filterFromSearch({ country: '' }, ['country'])).toEqual([]);
    expect(filterFromSearch({ country: '  ' }, ['country'])).toEqual([]);
  });

  it('pole filtra nie moze zajac klucza sesji', () => {
    /*
     * `c` and `s` are the conversation and the workspace, retained across every
     * navigation. A field of the same name would fight them for the key and be
     * dragged onto screens it means nothing on. Refused when the catalog is
     * built — at startup — rather than misbehaving quietly in production.
     */
    expect(() =>
      buildUiTargetCatalog([
        [
          {
            id: 'probe.view',
            kind: 'view',
            label: 'Probe',
            description: 'probe',
            to: '/probe',
            filter: { collection: 'rows', fields: [{ field: 'c', label: 'Kolizja' }] },
          },
        ],
      ]),
    ).toThrow(/zarezerwowane/);
  });
});

describe('zawezony link nie omija uprawnien', () => {
  /**
   * The property that makes a shareable filter safe: nothing in the address
   * reaches the database. The predicates only *remove* rows from a response the
   * server already scoped to its owner, so the same link opened by somebody else
   * narrows *their* data and can never surface a row they could not otherwise
   * see.
   */
  it('warunki tylko odsiewaja wiersze, ktore odbiorca i tak widzi', () => {
    const mine = h.service.listSuppliers(h.ownerId);
    const theirs = h.service.listSuppliers(h.otherOwnerId);

    // The second identity has no suppliers of its own in this fixture...
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs).toEqual([]);

    const predicates = filterFromSearch({ country: 'PL' }, ['country']);
    const filteredMine = mine.filter((r) => rowMatchesFilter(r, predicates));
    const filteredTheirs = theirs.filter((r) => rowMatchesFilter(r, predicates));

    /*
     * ...so the same narrowed address shows them nothing. The filter cannot add
     * rows, only take them away: every filtered row was already in the owner's
     * own response.
     */
    expect(filteredTheirs).toEqual([]);
    expect(filteredMine.length).toBeGreaterThan(0);
    expect(filteredMine.every((r) => mine.includes(r))).toBe(true);
  });
});
