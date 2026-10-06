import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppError,
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
import {
  AgentRuntime,
  buildUiTargetCatalog,
  newId,
  nowIso,
  platformTools,
  RunEventStream,
} from '@platform/server';
import type { Supplier } from '@module/procurement/shared';
import { createHarness, login, type Harness } from './helpers.ts';

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
  ui: null,
});

/**
 * Calls `ui_filter` the way a run does, over the runtime's real acknowledgement
 * gate and a real event stream — the same composition `ui_navigate` is tested
 * through, so the command the browser would receive is the one asserted here.
 *
 * Port z audytu AgenticApp 2026-09-28: licznikowy commandId (twarda unikalnosc
 * miedzy testami — czysty random moze sie zderzyc, a obcy ack to mylace
 * zawalenie), termin acka ustawiany jawnie (5 s dla scenariuszy z
 * potwierdzeniem, 400 ms gdy brak odpowiedzi jest oczekiwanym wynikiem — 400 ms
 * wystarcza i domyka test szybciej) oraz domkniecie strumienia i watchera
 * w `finally`, zeby watcher nigdy nie przeciekł do nastepnego testu.
 */

/** Sekwencja komend w procesie: twarda unikalnosc commandId miedzy testami. */
let uiCommandSeq = 0;

async function callFilter(
  input: Record<string, unknown>,
  ack: (command: UiCommand, runtime: AgentRuntime) => void | Promise<void>,
  ackDeadlineMs = 400,
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
          commandId: `uic_${(++uiCommandSeq).toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          runId: run.id,
          conversationId: conv.id,
          targetId: command.targetId,
          spaceId: command.spaceId ?? null,
          ...(command.filter !== undefined ? { filter: command.filter } : {}),
          reason: command.reason,
        },
        stream,
        ackDeadlineMs,
      ),
  };

  const tool = platformTools(h.platform.services).find((t) => t.name === 'ui_filter')!;
  const out: { result?: any; error?: unknown; emitted: UiCommand[] } = { emitted };
  try {
    out.result = await tool.handler(input as never, ctx);
  } catch (e) {
    out.error = e;
  } finally {
    stream.close();
    await watcher;
  }
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
      5_000,
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
    const { error, emitted } = await callFilter(
      { targetId: 'procurement.data', predicates: [{ field: 'country', op: 'eq', value: 'PL' }] },
      applies(3, 4),
    );
    /*
     * The banner is generated from the predicates, so the screen is described
     * correctly with or without this. What it buys is the agent being able to
     * say what it did in the conversation — narrowing a screen silently and
     * then talking about something else is its own kind of wrong.
     *
     * Port z audytu AgenticApp 2026-09-28: pierworzedna jest struktura bledu —
     * AppError z kodem `validation_failed`, bo to kod trafia do klienta narzedzia
     * i jest stabilny. Tresc zostaje jako asercja drugorzedna — narzedzie musi
     * nazwac brakujaca rzecz (label), zeby agent mogl poprawic wywolanie zamiast
     * zgadywac.
     */
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('validation_failed');
    expect(String((error as Error).message)).toContain('label');
    // Odmowa przed dotknieciem przegladarki: blad walidacji niczego nie wysyla.
    expect(emitted).toHaveLength(0);
  });

  it('zawezenie bez warunkow jest bledem — to nie to samo co pelny widok', async () => {
    const { error, emitted } = await callFilter(
      { targetId: 'procurement.data', label: 'wszystko' },
      applies(4, 4),
    );
    // Port z audytu AgenticApp 2026-09-28: kod stabilny dla warstwy klienta;
    // tresc wskazuje agentowi wyjscie (clear=true).
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('validation_failed');
    expect(String((error as Error).message)).toContain('clear=true');
    expect(emitted).toHaveLength(0);
  });

  it('clear=true przywraca pelny widok celu z zawezeniem, a cel bez zawezenia odmawia bez komendy', async () => {
    // A view that declares a narrowing is cleared, whatever its address holds.
    const { result, emitted } = await callFilter(
      { targetId: 'procurement.data', clear: true },
      async (command, runtime) => {
        runtime.acknowledgeUiCommand({
          commandId: command.commandId,
          targetId: command.targetId,
          executed: true,
          url: '/data',
        });
      },
      5_000,
    );
    expect(emitted).toHaveLength(1);
    // `null`, not absent: absent would leave whatever narrowing is on screen.
    expect(emitted[0]!.filter).toBeNull();
    expect(result.executed).toBe(true);
    expect(result.cleared).toBe(true);

    /*
     * A target that declares none has nothing to clear. Answering "cleared"
     * would be a success nothing applied — and performing it moved the user to
     * that target's screen.
     */
    const refused = await callFilter({ targetId: 'platform.settings', clear: true }, applies(1, 1));
    expect(refused.result).toEqual({
      executed: false,
      reason: UI_COMMAND_FAILURES.notFilterable,
      targetId: 'platform.settings',
      label: 'Ustawienia',
    });
    expect(refused.emitted).toHaveLength(0);
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
      5_000,
    );
    expect(result.executed).toBe(false);
    expect(result.reason).toBe(UI_COMMAND_FAILURES.notApplied);
    expect(result.filtered).toBeUndefined();
  });
});

describe('instrukcja agenta', () => {
  /*
   * Port z audytu AgenticApp 2026-09-28: PIN KONTRAKTU promptu systemowego.
   *
   * Nie urywa slownych formul — opisy moga sie zmieniac — tylko strukture, po
   * ktorej mozna stwierdzic, ze regula NADAL jest dostarczana modelowi:
   *   1. sekcja "# Sterowanie interfejsem" istnieje i nazywa narzedzia po ich
   *      identyfikatorach MCP (mcp__app__ui_navigate / ui_filter / ui_catalog),
   *      a nie po przypadkowych slowach opisu;
   *   2. zawiera naglowek-znacznik reguly "ODPOWIADANIE O DANYCH TO TEZ
   *      POKAZYWANIE" — bez niej wraca incydent, w ktorym agent odpowiadajac
   *      o danych trescia nie otworzyl widoku, do ktorego dane nalezaly;
   *   3. kazdy cel deklarujacy zawezanie ma wypisane swoje pola w formacie
   *      "| zawezanie po: <pola>" — asercja budowana z rejestru celow, wiec
   *      przezywa parafrazy i lapie takze NOWY cel zadeklarowany bez listy pol.
   *
   * Czy model regule stosuje, sprawdza dopiero prawdziwa tura
   * (e2e/ui-navigation.spec.ts); ten plik pilnuje, by regula w ogole do niego
   * trafiala.
   */
  it('przekazuje kontrakt sterowania interfejsem: sekcja, narzedzia i regula pokazywania', async () => {
    const { buildSystemPrompt, mcpToolName } = await import('@platform/server');
    const prompt = buildSystemPrompt({
      registry: h.platform.services.modules,
      catalog: h.platform.services.catalog,
      appContext: EMPTY_CONTEXT('c'),
      resourceSummary: null,
      workspaceDir: null,
      stagedFiles: [],
      toolkit: [],
    } as never);

    const sectionStart = prompt.indexOf('# Sterowanie interfejsem');
    expect(sectionStart, 'brak sekcji sterowania interfejsem w prompcie').toBeGreaterThan(-1);
    // Granica = kolejny naglowek PIERWSZEGO poziomu ("# "), a nie podsekcja ("##").
    const nextSection = prompt.indexOf('\n# ', sectionStart + 1);
    const section =
      nextSection === -1 ? prompt.slice(sectionStart) : prompt.slice(sectionStart, nextSection);

    // Identyfikatory narzedzi — dokladnie te nazwy, ktore model widzi na liscie MCP.
    for (const tool of ['ui_navigate', 'ui_filter', 'ui_catalog']) {
      expect(section, `brak identyfikatora ${mcpToolName(tool)} w sekcji`).toContain(
        mcpToolName(tool),
      );
    }

    // Naglowek-znacznik kontraktu: odpowiedz o danych to tez pokazanie widoku.
    expect(section).toContain('ODPOWIADANIE O DANYCH TO TEZ POKAZYWANIE');

    // Format pola zgodny z describeFilterField w prompt.ts (wartosci pola w
    // nawiasie, skrot przy przecieciu limitu) — listing wypisany z REJESTRU,
    // nie z tekstu testu.
    const PROMPT_FILTER_VALUES = 12;
    const describeFilterField = (field: { field: string; values?: string[] }): string => {
      const values = field.values ?? [];
      if (values.length === 0) return field.field;
      const shown = values.slice(0, PROMPT_FILTER_VALUES).join('|');
      return `${field.field} (${shown}${values.length > PROMPT_FILTER_VALUES ? '|... pelna lista w ui_catalog' : ''})`;
    };

    // Pola zawezania wypisane dla KAZDEGO celu, ktory je deklaruje — z rejestru.
    const filterable = h.platform.services.modules
      .uiTargets()
      .filter((t) => (t.filter?.fields.length ?? 0) > 0);
    expect(filterable.length).toBeGreaterThan(0);
    for (const target of filterable) {
      const listing = `| zawezanie po: ${target
        .filter!.fields.map(describeFilterField)
        .join(', ')}`;
      expect(section, `cel ${target.id} nie ma wypisanych pol zawezania`).toContain(listing);
    }
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
  it('warunki tylko odsiewaja wiersze, ktore odbiorca i tak widzi', async () => {
    /*
     * Fixture: the second identity owns rows of its own — including rows that
     * match the very same predicate. Without them every "nothing leaked" check
     * below would be vacuously true: an empty response cannot leak, no matter
     * how badly the scoping is broken.
     */
    const addSupplierForOtherOwner = (name: string, country: string) =>
      h.service.repo.insertSupplier({
        id: newId('pcs'),
        ownerId: h.otherOwnerId,
        name,
        taxId: '0000000000',
        country,
        contactEmail: 'cudza-tozsamosc@example.com',
        createdAt: nowIso(),
      });
    // Pasuje do tego samego warunku, ktorym zawezamy — tak, by przeciek zakresu
    // byl widoczny w zawezonym wyniku, a nie tylko w pelnej liscie.
    addSupplierForOtherOwner('Cudza Polska Sp. z o.o.', 'PL');
    addSupplierForOtherOwner('Cudzy Nord OY', 'FI');

    /*
     * Prawieta droga widoku: serwer zwraca liste ograniczona do wlasciciela
     * (`GET /api/m/procurement/suppliers` -> `listSuppliers(req.ownerId)`), a
     * zawezenie z adresu dotyka wylacznie tej odpowiedzi po stronie klienta
     * (`useModuleData` -> `rowMatchesFilter`). Liczby do potwierdzenia widoku
     * pochodza z tego zawezenia; wiersze drugiej tozsamosci nie wchodza do gry
     * wcale, bo serwer ich pierwszej tozsamosci nie dal.
     */
    const list = async (userId: string): Promise<Supplier[]> => {
      const cookie = await login(h.platform.app, userId);
      const res = await h.platform.app.request('/api/m/procurement/suppliers', {
        headers: { cookie },
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { suppliers: Supplier[] }).suppliers;
    };
    const mine = await list(h.ownerId);
    const theirs = await list(h.otherOwnerId);

    expect(mine.length).toBeGreaterThan(0);
    // Odpowiedz drugiej tozsamosci istnieje i jest jej wlasna — nie pusta.
    expect(theirs.length).toBeGreaterThan(0);

    const predicates = filterFromSearch({ country: 'PL' }, ['country']);
    const narrowed = (rows: Supplier[]) => rows.filter((r) => rowMatchesFilter(r, predicates));

    // Zawezenie realnie zaweza: cos odpada, a wynik nie jest pusty — po obu
    // stronach. Bez tego dalsze asercje moglyby przechodzic próżniowo.
    expect(narrowed(mine).length).toBeGreaterThan(0);
    expect(narrowed(mine).length).toBeLessThan(mine.length);
    expect(narrowed(theirs).length).toBeGreaterThan(0);

    /*
     * Decydujace: zakresy, ktore serwer dal obu tozsamosciom, sa rozlaczne.
     * Ten sam zawezony link otwarty przez druga tozsamosc moze wiec pokazac
     * wylacznie jej wiersze — zawezenie zabiera wiersze z JEJ odpowiedzi i
     * nigdy nie dorzuci wiersza pierwszej tozsamosci, bo zadnego takiego nie
     * dostalo. Gdyby lista serwera przestala byc ograniczana do wlasciciela,
     * obie odpowiedzi zaczelyby sie nakladac i ten test pada.
     */
    const mineIds = new Set(mine.map((r) => r.id));
    const overlap = theirs.filter((r) => mineIds.has(r.id));
    expect(overlap, 'odpowiedzi obu tozsamosci nachodza na siebie').toEqual([]);
  });
});
