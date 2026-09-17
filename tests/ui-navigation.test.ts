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

/**
 * Calls `ui_navigate` the way a run does, composed from the same two pieces.
 *
 * The tool handler is invoked directly with a context whose `requestUi` is the
 * runtime's real gate over a real event stream — which is exactly how the
 * runtime wires it. What this deliberately skips is the MCP transport between
 * the model and the handler; that layer has its own tests
 * (`tests/mcp-schema.test.ts`), and reaching into the SDK server's internals to
 * include it here would test the SDK, not this.
 */
async function callNavigate(
  h: Harness,
  call: { targetId: string; spaceId?: string },
  ack: (command: UiCommand, runtime: AgentRuntime) => void | Promise<void>,
): Promise<{ result?: any; error?: unknown; emitted: UiCommand[] }> {
  const runtime = new AgentRuntime(h.platform.services);
  const conv = h.platform.services.conversations.create({
    ownerId: h.ownerId,
    firstMessage: { content: 'pokaz pliki' },
  });
  const run = h.platform.services.runs.start({
    conversationId: conv.id,
    ownerId: h.ownerId,
    prompt: 'pokaz pliki',
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
          reason: command.reason,
        },
        stream,
        // Short, so the "nobody answered" case does not hold the suite open.
        400,
      ),
  };

  const navigate = platformTools(h.platform.services).find((t) => t.name === 'ui_navigate')!;
  const out: { result?: any; error?: unknown; emitted: UiCommand[] } = { emitted };
  try {
    out.result = await navigate.handler(call as never, ctx);
  } catch (e) {
    out.error = e;
  }
  stream.close();
  await watcher;
  return out;
}

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
    const out = await callNavigate(h, { targetId: 'platform.files' }, (command, runtime) => {
      runtime.acknowledgeUiCommand({
        commandId: command.commandId,
        executed: true,
        targetId: command.targetId,
        url: '/files',
        highlighted: false,
      });
    });

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
    const out = await callNavigate(h, { targetId: 'platform.files' }, () => {
      /* no client answers */
    });

    expect(out.emitted, 'polecenie nie zostalo w ogole wyslane').toHaveLength(1);
    expect(out.result).toMatchObject({
      executed: false,
      reason: UI_COMMAND_FAILURES.noClient,
    });
  });

  it('element nieobecny na ekranie to porazka z wlasnym powodem', async () => {
    const out = await callNavigate(h, { targetId: 'platform.settings.auth' }, (command, runtime) => {
      runtime.acknowledgeUiCommand({
        commandId: command.commandId,
        executed: false,
        targetId: command.targetId,
        reason: UI_COMMAND_FAILURES.notPresent,
        url: '/settings',
      });
    });
    expect(out.result).toMatchObject({ executed: false, reason: UI_COMMAND_FAILURES.notPresent });
  });

  it('polecenie z rozmowy w tle nie przelacza widoku i mowi o tym wprost', async () => {
    const out = await callNavigate(h, { targetId: 'platform.files' }, (command, runtime) => {
      // The browser is looking at a different conversation, so it refuses.
      runtime.acknowledgeUiCommand({
        commandId: command.commandId,
        executed: false,
        targetId: command.targetId,
        reason: UI_COMMAND_FAILURES.inactiveConversation,
      });
    });
    expect(out.result).toMatchObject({
      executed: false,
      reason: UI_COMMAND_FAILURES.inactiveConversation,
    });
  });

  it('nieznany cel jest odrzucony od razu, z lista dostepnych', async () => {
    const out = await callNavigate(h, { targetId: 'platform.nie-istnieje' }, () => {
      /* should never be reached */
    });

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
    const out = await callNavigate(h, { targetId: 'platform.canvas', spaceId: other.id }, () => {
      /* should never be reached */
    });

    expect(out.error, 'cudza przestrzen nie zostala odrzucona').toBeDefined();
    // Refused on ownership, by the same service that guards every other read.
    expect(String((out.error as Error).message)).toMatch(/another owner|innego wlasciciela/i);
    expect(out.emitted, 'zapytano przegladarke o cudza przestrzen').toHaveLength(0);
  });

  it('polecenie niesie rozmowe i stabilny identyfikator', async () => {
    const out = await callNavigate(h, { targetId: 'platform.files' }, (command, runtime) => {
      runtime.acknowledgeUiCommand({ commandId: command.commandId, executed: true });
    });

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
     * `ui_filter` (and later `ui_sort`, which orders rows the same way) joined
     * this set when views became narrowable, and it does not
     * weaken the property. It changes which rows are *displayed* and says so on
     * screen; it writes nothing, and the user undoes it with one button. The
     * assertion below is therefore two things: the exact list, so a new verb
     * cannot appear unnoticed, and — the part that actually matters — that none
     * of them writes.
     */
    const tools = platformTools(h.platform.services);
    const ui = tools.filter((t) => /^ui_/.test(t.name));
    expect(ui.map((t) => t.name).sort()).toEqual(['ui_catalog', 'ui_filter', 'ui_navigate', 'ui_sort']);
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
