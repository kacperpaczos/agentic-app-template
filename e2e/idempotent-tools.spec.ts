import { expect, type Page } from '@playwright/test';
import { test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import {
  Backend,
  callsOf,
  openApp,
  settled,
  toolNames,
  typeCommand,
  type ToolCall,
} from './support/bl03-checks.ts';
import { writeEvidence } from '../tests/support/measurement-evidence.ts';

/**
 * L9.7 through the real interface: a repeat of a creating write tool produces
 * **one** effect.
 *
 * **Rodzaj dowodu: test GUI bez modelu.** The command is sent from the browser,
 * the run goes through the real runtime, and every `call` step executes the real
 * tool handler through the same validation and execution the MCP server applies
 * (`invokeTool`) — the model's door, with the model replaced by the scenario.
 * The scenario repeats each creating tool with the *same* `operationId` (the
 * shape of an agent retrying after a reconnect) and, once, calls without any
 * key, which the tool schema refuses before a handler runs.
 *
 * What is asserted is not what the tools answer — the answers are read from the
 * run's events and then checked against what actually happened: the canvas
 * space, the conversation's agent views, the file store and the artifact list,
 * all read back through the same HTTP API the screens read. One repeat is one
 * row, and a keyless call is a visible tool error that leaves nothing behind.
 *
 * What this evidence does **not** show, said plainly: whether a *live* model
 * supplies its own `operationId`. That is a property of the model reading the
 * tool descriptions, exercised only by a paid run, and nothing here pretends to
 * it. What the platform owes — that a repeat under one key cannot double the
 * effect, and that a keyless call cannot write at all — is what this file proves
 * at the interface.
 */

const scripted = new ScriptedInstance({ port: 8797, dataDirName: '.e2e-scripted-l97' });
const BASE = scripted.baseUrl;

/** Opens a case page, so the command's context carries the case and its space. */
async function openCase(page: Page): Promise<{ caseId: string; spaceId: string }> {
  await page.goto(`${BASE}/cases`);
  await page.locator('[data-testid^="case-tile-"]').first().click();
  await expect(page.getByTestId('case-detail-page')).toBeVisible();
  const caseId = new URL(page.url()).pathname.split('/').pop()!;
  const backend = new Backend(page, BASE);
  const scoped = (await backend.spaces()).find((s) => s.scopeKind === 'case' && s.scopeId === caseId);
  expect(scoped, 'otwarcie sprawy nie utworzilo przestrzeni canvas').toBeTruthy();
  return { caseId, spaceId: scoped!.id };
}

/** Every result of these calls said "ok", and there is a result to read. */
function expectOk(calls: ToolCall[], what: string): void {
  for (const call of calls) {
    expect(call.isError, `${what} zakonczylo sie bledem: ${call.rawResult}`).toBe(false);
    expect(call.result, `${what}: pusty wynik`).toBeTruthy();
  }
}

test.describe('L9.7 przez interfejs: powtorzenie z tym samym kluczem daje jeden skutek', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    scripted.prepareDatabase();
    await scripted.start('bl09-l97');
  });
  test.afterAll(() => scripted.stop());

  test('powtorzone canvas_add_card, agent_view_create i files_publish_version: jeden wiersz kazdego', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openApp(page, BASE);
    const backend = new Backend(page, BASE);
    const { caseId, spaceId } = await openCase(page);

    const sent = await typeCommand(page, 'Prosze zrobic powtorka zapisow testowych.');
    expect(await settled(page, sent.runId)).toBe('succeeded');
    const events = await backend.runEvents(sent.runId);
    expect(toolNames(events), `narzedzia uruchomienia: ${toolNames(events).join(', ')}`).toContain(
      'canvas_add_card',
    );

    /* ---------- canvas_add_card: dwa razy z kluczem, raz bez ---------- */

    const cardCalls = callsOf(events, 'canvas_add_card');
    expect(cardCalls, 'scenariusz mial wolac canvas_add_card trzy razy').toHaveLength(3);
    const keyed = cardCalls.filter((c) => (c.args as { operationId?: string })?.operationId);
    const keyless = cardCalls.filter((c) => !((c.args as { operationId?: string })?.operationId));
    expect(keyed, 'dwa wywolania z kluczem').toHaveLength(2);
    expect(keyless, 'jedno wywolanie bez klucza').toHaveLength(1);
    expectOk(keyed, 'canvas_add_card z kluczem');

    const firstCardId = (keyed[0]!.result as { cardId: string }).cardId;
    const secondCardId = (keyed[1]!.result as { cardId: string }).cardId;
    expect(
      secondCardId,
      'powtorzenie z tym samym operationId zwrocilo INNA karte — powtorka zapisala drugi raz',
    ).toBe(firstCardId);

    // The keyless call is a visible tool error, naming the missing field.
    expect(keyless[0]!.isError, 'wywolanie bez klucza mialo byc odrzucone').toBe(true);
    expect((keyless[0]!.result as { error?: string }).error).toBe('validation_failed');
    expect(JSON.stringify(keyless[0]!.result)).toContain('operationId');

    /* ---------- agent_view_create: dwa razy z kluczem ------------------ */

    const viewCalls = callsOf(events, 'agent_view_create');
    expect(viewCalls, 'scenariusz mial wolac agent_view_create dwa razy').toHaveLength(2);
    expectOk(viewCalls, 'agent_view_create');
    const firstView = viewCalls[0]!.result as { cardId: string; spaceId: string };
    const secondView = viewCalls[1]!.result as { cardId: string; spaceId: string };
    expect(
      secondView.cardId,
      'powtorzone agent_view_create utworzylo drugi widok',
    ).toBe(firstView.cardId);

    /* ---------- files_publish_version: dwa razy z kluczem -------------- */

    const versionCalls = callsOf(events, 'files_publish_version');
    expect(versionCalls, 'scenariusz mial wolac files_publish_version dwa razy').toHaveLength(2);
    expectOk(versionCalls, 'files_publish_version');
    const firstVersion = versionCalls[0]!.result as { fileId: string; version: number };
    const secondVersion = versionCalls[1]!.result as { fileId: string; version: number };
    expect(
      secondVersion.fileId,
      'powtorzone files_publish_version utworzylo druga wersje pliku',
    ).toBe(firstVersion.fileId);
    expect(secondVersion.version).toBe(firstVersion.version);

    /* ---------- …a stan po stronie danych potwierdza pojedyncze efekty - */

    // Canvas: exactly one card of this scenario, and the keyless call left nothing.
    const cards = await backend.cards(spaceId);
    const l97Cards = cards.filter((c) => c.title.startsWith('L97'));
    expect(
      l97Cards.map((c) => c.title),
      'w przestrzeni sprawy jest wiecej niz jedna karta z powtorzenia albo zostala karta bez klucza',
    ).toEqual(['L97 KARTA POWTORZONA']);
    expect(l97Cards[0]!.id).toBe(firstCardId);

    // Agent views of this conversation: exactly one card, the repeated id.
    const views = await backend.json<{ cards: Array<{ id: string; title: string }> }>(
      `/api/conversations/${sent.context.conversationId}/agent-views`,
    );
    expect(
      views.cards.map((c) => ({ id: c.id, title: c.title })),
      'widoki agenta rozmowy nie maja dokladnie jednego powtorzonego widoku',
    ).toEqual([{ id: firstView.cardId, title: 'L97 WIDOK POWTORZONY' }]);

    // Files: the published result exists exactly once.
    const files = await backend.json<{ files: Array<{ id: string; filename: string }> }>('/api/files');
    const published = files.files.filter((f) => f.filename === 'l97-poprawione.csv');
    expect(
      published.map((f) => f.id),
      'magazyn plikow ma inna liczbe niz jedna opublikowana wersje',
    ).toEqual([firstVersion.fileId]);

    // Artifacts of the conversation: exactly one for the publication.
    const artifacts = await backend.json<{ artifacts: Array<{ id: string; title: string }> }>(
      `/api/artifacts?conversationId=${sent.context.conversationId}`,
    );
    const publicationArtifacts = artifacts.artifacts.filter((a) => a.title.startsWith('l97-poprawione.csv'));
    expect(
      publicationArtifacts.map((a) => a.title),
      'biblioteka artefaktow ma inna liczbe niz jeden artefakt publikacji',
    ).toEqual([`l97-poprawione.csv (wersja ${firstVersion.version})`]);

    /* ---------- the stamped evidence, on request ----------------------- */

    writeEvidence(
      'dowod-l97-idempotencja-narzedzi.json',
      {
        rodzajWykonania: 'test GUI bez modelu',
        opis:
          'L9.7 przez rzeczywisty interfejs: polecenie wyslane z przegladarki, wykonanie przez prawdziwy ' +
          'runtime, wywolania narzedzi przez te sama walidacje i wykonanie co serwer MCP. Kazde narzedzie ' +
          'tworzace wolane dwa razy z tym samym operationId daje jeden wiersz; wywolanie bez klucza jest ' +
          'odrzucone przez schemat i nie zapisuje niczego. Skutki liczone w bazie przez API odczytu, nie w ' +
          'odpowiedziach narzedzi.',
        zrodlo: 'pnpm exec playwright test e2e/idempotent-tools.spec.ts (regresja szablonu)',
        scena: 'bl09-l97 (e2e/support/bl09-scenarios.ts), instancja scenariuszowa na wlasnym porcie i katalogu danych',
        uruchomienie: { runId: sent.runId, conversationId: sent.context.conversationId, caseId, spaceId },
        klucze: {
          canvas_add_card: 'e2e-l97-karta-1',
          agent_view_create: 'e2e-l97-widok-1',
          files_publish_version: 'e2e-l97-wersja-1',
        },
        wyniki: {
          canvas_add_card: { pierwsze: firstCardId, powtorzenie: secondCardId },
          agent_view_create: { pierwsze: firstView.cardId, powtorzenie: secondView.cardId },
          files_publish_version: {
            pierwsze: firstVersion,
            powtorzenie: secondVersion,
          },
        },
        liczebnikiWBazie: {
          kartyL97WPrzestrzeni: l97Cards.length,
          widokiAgentaRozmowy: views.cards.length,
          opublikowaneWersjePliku: published.length,
          artefaktyPublikacji: publicationArtifacts.length,
        },
        wywolanieBezKlucza: {
          narzedzie: 'canvas_add_card',
          wynik: keyless[0]!.result,
          kartyPoWywolaniuBezKlucza: l97Cards.length,
        },
        czegoDowodNiePokazuje:
          'Czy zywy model podaje wlasne operationId (czyta opisy narzedzi) — to wlasciwosc modelu, ' +
          'cwiczona tylko przebiegiem platnym; tu model jest zastapiony scenariuszem na granicy adaptera. ' +
          'Udowodnione jest zachowanie platformy: powtorzenie z jednym kluczem = jeden skutek, brak klucza = brak zapisu.',
      },
      'docs/evidence/z10-bl09',
    );
  });
});
