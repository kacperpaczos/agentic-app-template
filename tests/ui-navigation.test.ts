import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLATFORM_CUSTOM_EVENTS,
  UI_COMMAND_FAILURES,
  uiCommandSchema,
  type UiCommand,
} from '@platform/contracts';
import type { ToolCallContext } from '@platform/contracts';
import {
  AgentRuntime,
  buildUiTargetCatalog,
  PLATFORM_UI_TARGETS,
  platformTools,
  RunEventStream,
} from '@platform/server';
import { createHarness, login, type Harness } from './helpers.ts';

/**
 * The agent moving the interface — and, more importantly, being unable to claim
 * it did.
 *
 * The behaviour this replaces was observed in the running application: asked to
 * "switch to files", the agent called two unrelated read tools and then told the
 * user they had to create a purchase case first to see a screen that is in the
 * navigation unconditionally. It had no way to navigate and no list of what
 * exists, so it improvised — and the improvisation was false.
 *
 * So the property under test is not "an event was emitted". It is that
 * `ui_navigate` resolves to **what a client reported actually happening**, and
 * that every way it can fail produces a distinct, truthful answer.
 */

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(() => h.dispose());

/*
 * Stabilnosc bramki ack — diagnoza flakiness z audytu.
 *
 * Dwukrotnie zaobserwowano tu padniecia wygladajace jak "obce acki": test bez
 * wlasnego potwierdzenia dostawal executed=true, a test potwierdzony — wynik bez
 * url. Diagnoza przeprowadzona na kodzie i eksperymencie:
 *
 *  1. Magazyn pendingow (`AgentRuntime.#pendingUiCommands`) jest per-instancja,
 *     a kazde wywolanie narzedzia buduje WLASNY runtime, wlasny strumien i
 *     wlasny przebieg na wlasnej bazie harnessu — stan globalny procesu nie
 *     istnieje (instrumentacja REQ/ACK/TIMEOUT/RESOLVE z tokenem instancji:
 *     11 pelnych przebiegow i ~250 zdarzen bramki bez jednego przeciecia
 *     miedzy tokenami; dodatkowo test stresowy: 80 rownoległych przeplywow na
 *     jednej instancji platformy z ackami natychmiastowymi, opoznionymi i
 *     brakiem acka — zero pomieszanych wynikow).
 *  2. Jedyny wspolczynnik czasowy, o jaki mogly sie czepiac padniecia, to
 *     termin 400 ms wspoldzielony przez testy z ackiem i bez. Docieranie acka
 *     jest lancuchem mikrozadan natychmiast po emisji, wiec terminu nie
 *     przestrzega tylko wtedy, gdy ack w ogole nie przyjdzie. Niemniej
 *     testy POTWIERDZAJACE dostaja teraz jawnie dlugi termin (5 s): zapas nic
 *     nie kosztuje, a wynik no_client dla flow z ackiem jest od razu czytelna
 *     informacja o defekcie, a nie wygrywajacym timera przypadkiem. Krotkie
 *     400 ms zostaje tylko tam, gdzie brak odpowiedzi jest oczekiwanym
 *     wynikiem testu.
 *  3. commandId jest licznikowy (sekwencia procesu + losowa koncowka), wiec
 *     dwie komendy nie moga zwyciezyc przez kolizje klucza pendingow.
 */

/** Sekwencja komend w procesie: twarda unikalnosc commandId miedzy testami. */
let uiCommandSeq = 0;

/**
 * Calls `ui_navigate` / `ui_filter` the way a run does, composed from the same
 * two pieces.
 *
 * The tool handler is invoked directly with a context whose `requestUi` is the
 * runtime's real gate over a real event stream — which is exactly how the
 * runtime wires it. What this deliberately skips is the MCP transport between
 * the model and the handler; that layer has its own tests
 * (`tests/mcp-schema.test.ts`), and reaching into the SDK server's internals to
 * include it here would test the SDK, not this.
 */
async function callUiTool(
  harness: Harness,
  toolName: 'ui_navigate' | 'ui_filter',
  input: Record<string, unknown>,
  ack: (command: UiCommand, runtime: AgentRuntime) => void | Promise<void> = () => {},
  ackDeadlineMs = 400,
): Promise<{ result?: any; error?: unknown; emitted: UiCommand[] }> {
  const runtime = new AgentRuntime(harness.platform.services);
  const conv = harness.platform.services.conversations.create({
    ownerId: harness.ownerId,
    firstMessage: { content: 'pokaz pliki' },
  });
  const run = harness.platform.services.runs.start({
    conversationId: conv.id,
    ownerId: harness.ownerId,
    prompt: 'pokaz pliki',
    appContext: EMPTY_CONTEXT(conv.id),
    workspaceDir: null,
    abort: new AbortController(),
  });
  const stream = new RunEventStream(run.id, harness.platform.services.runs);

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
    ownerId: harness.ownerId,
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
        // Termin na ack klienta — patrz komentarz o stabilnosci bramki wyzej.
        ackDeadlineMs,
      ),
  };

  const tool = platformTools(harness.platform.services).find((t) => t.name === toolName)!;
  const out: { result?: any; error?: unknown; emitted: UiCommand[] } = { emitted };
  try {
    out.result = await tool.handler(input as never, ctx);
  } catch (e) {
    out.error = e;
  } finally {
    // Domkniecie musi zajsc takze wtedy, gdy narzedzie rzucilo: watcher nie
    // przecieka do nastepnego testu (po pool: 'forks' izolowane sa pliki, ale
    // NIE testy w pliku — przeciekajacy watcher bylby wtedy sluchaczem cudzego
    // strumienia).
    stream.close();
    await watcher;
  }
  return out;
}

/** `ui_navigate` przez realna bramke ack; `ackDeadlineMs` — patrz naglowek pliku. */
const callNavigate = (
  harness: Harness,
  call: { targetId: string; spaceId?: string },
  ack?: (command: UiCommand, runtime: AgentRuntime) => void | Promise<void>,
  ackDeadlineMs = 400,
) => callUiTool(harness, 'ui_navigate', call, ack, ackDeadlineMs);

const EMPTY_CONTEXT = (conversationId: string) => ({
  conversationId,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
});

describe('katalog celow interfejsu', () => {
  it('zawiera ekrany platformy i ekrany modulu, bez duplikatow', () => {
    const targets = h.platform.services.modules.uiTargets();
    const ids = targets.map((t) => t.id);

    expect(ids).toContain('platform.files');
    expect(ids).toContain('platform.settings.auth');
    // Contributed by the business module, not written into the platform.
    expect(ids).toContain('procurement.cases');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('platforma nie nazywa ekranow biznesowych', () => {
    // The boundary, restated where it matters: every platform-owned target must
    // be describable without a business noun.
    const platformText = PLATFORM_UI_TARGETS.map((t) => `${t.id} ${t.label} ${t.description}`)
      .join(' ')
      .toLowerCase();
    for (const noun of ['sprawa zakupowa', 'dostawc', 'oferta', 'przetarg']) {
      expect(platformText, `platforma uzywa slowa "${noun}"`).not.toContain(noun);
    }
  });

  it('powtorzony identyfikator nie przeslania wpisu platformy', () => {
    const merged = buildUiTargetCatalog([
      [{ id: 'platform.files', kind: 'view', label: 'Podmiana', description: 'probuje przeslonic' }],
    ]);
    const files = merged.filter((t) => t.id === 'platform.files');
    expect(files).toHaveLength(1);
    expect(files[0]!.label).toBe('Pliki i raporty');
  });

  it('jest dostepny dla przegladarki pod tym samym adresem, co dla agenta', async () => {
    const cookie = await login(h.platform.app, h.ownerId);
    const res = await h.platform.app.request('/api/ui/targets', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { targets: Array<{ id: string }> };
    expect(body.targets.map((t) => t.id).sort()).toEqual(
      h.platform.services.modules.uiTargets().map((t) => t.id).sort(),
    );
  });
});

describe('ui_navigate zwraca to, co potwierdzil klient', () => {
  it('potwierdzone wykonanie wraca jako executed=true wraz z adresem', async () => {
    const out = await callNavigate(
      h,
      { targetId: 'platform.files' },
      (command, runtime) => {
        runtime.acknowledgeUiCommand({
          commandId: command.commandId,
          executed: true,
          targetId: command.targetId,
          url: '/files',
          highlighted: false,
        });
      },
      // Ack jest czescia scenariusza — dlugi termin zamiast wyscigu z timerem.
      5_000,
    );

    expect(out.error).toBeUndefined();
    expect(out.result).toMatchObject({
      executed: true,
      targetId: 'platform.files',
      label: 'Pliki i raporty',
      url: '/files',
    });
  });

  it('brak potwierdzenia daje executed=false, nie sukces', async () => {
    /*
     * The decisive case. Emitting the event and returning "done" is exactly the
     * shortcut the acceptance criteria rule out: nothing observed the
     * navigation, so nothing may claim it.
     */
    const out = await callNavigate(h, { targetId: 'platform.files' }, undefined, 400);

    expect(out.emitted, 'polecenie nie zostalo w ogole wyslane').toHaveLength(1);
    expect(out.result).toMatchObject({
      executed: false,
      reason: UI_COMMAND_FAILURES.noClient,
    });
  });

  it('element nieobecny na ekranie to porazka z wlasnym powodem', async () => {
    const out = await callNavigate(
      h,
      { targetId: 'platform.settings.auth' },
      (command, runtime) => {
        runtime.acknowledgeUiCommand({
          commandId: command.commandId,
          executed: false,
          targetId: command.targetId,
          reason: UI_COMMAND_FAILURES.notPresent,
          url: '/settings',
        });
      },
      5_000,
    );
    expect(out.result).toMatchObject({ executed: false, reason: UI_COMMAND_FAILURES.notPresent });
  });

  it('polecenie z rozmowy w tle nie przelacza widoku i mowi o tym wprost', async () => {
    const out = await callNavigate(
      h,
      { targetId: 'platform.files' },
      (command, runtime) => {
        // The browser is looking at a different conversation, so it refuses.
        runtime.acknowledgeUiCommand({
          commandId: command.commandId,
          executed: false,
          targetId: command.targetId,
          reason: UI_COMMAND_FAILURES.inactiveConversation,
        });
      },
      5_000,
    );
    expect(out.result).toMatchObject({
      executed: false,
      reason: UI_COMMAND_FAILURES.inactiveConversation,
    });
  });

  it('nieznany cel jest odrzucony od razu, z lista dostepnych', async () => {
    const out = await callNavigate(h, { targetId: 'platform.nie-istnieje' });

    expect(out.result).toMatchObject({
      executed: false,
      reason: UI_COMMAND_FAILURES.unknownTarget,
      requested: 'platform.nie-istnieje',
    });
    expect(out.result.available).toContain('platform.files');
    // Answered from the catalog; the browser is never asked to look for it.
    expect(out.emitted, 'zapytano przegladarke o nieistniejacy cel').toHaveLength(0);
  });

  it('cudza przestrzen pracy jest odrzucona przed dotknieciem interfejsu', async () => {
    const other = h.platform.services.canvas.createSpace({
      ownerId: h.otherOwnerId,
      title: 'Nie moja',
    });
    const out = await callNavigate(h, { targetId: 'platform.canvas', spaceId: other.id });

    expect(out.error, 'cudza przestrzen nie zostala odrzucona').toBeDefined();
    // Refused on ownership, by the same service that guards every other read.
    expect(String((out.error as Error).message)).toMatch(/another owner|innego wlasciciela/i);
    expect(out.emitted, 'zapytano przegladarke o cudza przestrzen').toHaveLength(0);
  });

  it('polecenie niesie rozmowe i stabilny identyfikator', async () => {
    const out = await callNavigate(
      h,
      { targetId: 'platform.files' },
      (command, runtime) => {
        runtime.acknowledgeUiCommand({ commandId: command.commandId, executed: true });
      },
      5_000,
    );

    expect(out.emitted).toHaveLength(1);
    const command = out.emitted[0]!;
    // Carried so the client can refuse a command aimed at a conversation the
    // user is not watching, and so a replayed stream does not navigate twice.
    expect(command.conversationId).toBeTruthy();
    expect(command.commandId).toMatch(/^uic_/);
    expect(command.runId).toBeTruthy();
  });

  it('pokazanie ustawienia nie ma zadnej operacji zmiany wartosci', () => {
    /*
     * The tool surface is the guarantee: there is no "set" verb at all, so an
     * agent cannot change a setting by accident while showing it.
     *
     * `ui_filter` joined this set when views became narrowable, and it does not
     * weaken the property. It changes which rows are *displayed* and says so on
     * screen; it writes nothing, and the user undoes it with one button. The
     * assertion below is therefore two things: the exact list, so a new verb
     * cannot appear unnoticed, and — the part that actually matters — that none
     * of them writes.
     */
    const tools = platformTools(h.platform.services);
    const ui = tools.filter((t) => /^ui_/.test(t.name));
    expect(ui.map((t) => t.name).sort()).toEqual(['ui_catalog', 'ui_filter', 'ui_navigate']);
    expect(ui.every((t) => t.effect === 'read')).toBe(true);
  });
});

describe('potwierdzenie jest chronione', () => {
  it('cudze uruchomienie nie moze zostac potwierdzone', async () => {
    const conv = h.platform.services.conversations.create({
      ownerId: h.ownerId,
      firstMessage: { content: 'x' },
    });
    const run = h.platform.services.runs.start({
      conversationId: conv.id,
      ownerId: h.ownerId,
      prompt: 'x',
      appContext: EMPTY_CONTEXT(conv.id),
      workspaceDir: null,
      abort: new AbortController(),
    });

    const cookie = await login(h.platform.app, h.otherOwnerId);
    const res = await h.platform.app.request(`/api/runs/${run.id}/ui-ack`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'uic_obce', executed: true }),
    });
    expect(res.status).toBe(403);
  });

  it('wlasciciel moze potwierdzic, ale nieznany commandId nie jest przyjmowany', async () => {
    const conv = h.platform.services.conversations.create({
      ownerId: h.ownerId,
      firstMessage: { content: 'x' },
    });
    const run = h.platform.services.runs.start({
      conversationId: conv.id,
      ownerId: h.ownerId,
      prompt: 'x',
      appContext: EMPTY_CONTEXT(conv.id),
      workspaceDir: null,
      abort: new AbortController(),
    });

    const cookie = await login(h.platform.app, h.ownerId);
    const res = await h.platform.app.request(`/api/runs/${run.id}/ui-ack`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: 'uic_nieznany', executed: true }),
    });
    expect(res.status).toBe(200);
    // Accepted as a request, but nothing was waiting for it — a late or replayed
    // acknowledgement must not resolve some other command.
    expect(await res.json()).toMatchObject({ accepted: false });
  });
});
