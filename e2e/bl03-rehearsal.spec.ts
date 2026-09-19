import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import {
  Backend,
  callsOf,
  descendants,
  expectCardPointsAtRecord,
  openApp,
  settled,
  settledDeciding,
  toolNames,
  typeCommand,
  workerProcesses,
  working,
  type CanvasCard,
} from './support/bl03-checks.ts';
import { type Page } from '@playwright/test';

/**
 * Dress rehearsal for the BL-03 model runs — **no model turn spent**.
 *
 * Every paid run of this package is driven here first, against the scripted
 * stand-in, through the very helpers the paid specs use. The point is narrow
 * and it is not coverage: a turn cannot be taken back, so a scenario that dies
 * on a selector, on a missing `expectedSpecVersion` or on the wrong instance's
 * URL must fail *here*, for free, and not on the subscription.
 *
 * **Rodzaj dowodu: symulacja.** Nothing in this file is evidence for a BL-03
 * criterion. The tool calls are real (the `call` steps go through the actual
 * handlers, validation and runtime), but the model's own judgement is not
 * exercised at all — the scenario is told which tool to call. What this file
 * establishes is that the checks run, that they can pass, and — in the trials
 * the report records — that they can fail.
 */

const scripted = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-bl03' });
const BASE = scripted.baseUrl;

const send = typeCommand;

/** Opens the first case and returns its id and the space its screen bound. */
async function openCase(page: Page): Promise<{ caseId: string; spaceId: string }> {
  await page.goto(`${BASE}/cases`);
  await page.locator('[data-testid^="case-tile-"]').first().click();
  await expect(page.getByTestId('case-detail-page')).toBeVisible();
  const caseId = new URL(page.url()).pathname.split('/').pop()!;
  const backend = new Backend(page, BASE);
  const spaces = await backend.spaces();
  const scoped = spaces.find((s) => s.scopeKind === 'case' && s.scopeId === caseId);
  expect(scoped, 'otwarcie sprawy nie utworzylo przestrzeni canvas').toBeTruthy();
  return { caseId, spaceId: scoped!.id };
}

/** The canvas of the space the case page bound, as the user reaches it. */
async function openCanvas(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
  await expect(page.getByTestId('card-case-summary').first()).toBeVisible();
}

test.describe('proba generalna prob modelowych BL-03 (bez modelu)', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  test.beforeAll(() => {
    scripted.prepareDatabase();
  });
  test.afterEach(() => scripted.stop());

  /* ---------------------------------------------------------------------- */
  /*  Przebieg A — kanwa, rekord, nawigacja                                  */
  /* ---------------------------------------------------------------------- */

  test('A: cztery operacje kompozycji przez narzedzia, kazda powiazana z wykonaniem', async ({
    page,
  }) => {
    await scripted.start('bl03-canvas');
    await openApp(page, BASE);
    const backend = new Backend(page, BASE);
    const { caseId, spaceId } = await openCase(page);

    /* --- 1. dodanie: karta jest nowa, jest tego wykonania i wskazuje rekord -- */

    const before = await backend.cards(spaceId);
    const added = await send(page, 'PROBA-DODAJ karte z wykresem kosztow dla tej sprawy.');
    // The command carried the record, not only the space — the half of L6.6 a
    // canvas-only command cannot show.
    expect(added.context.resource, 'polecenie nie nioslo wskazanego rekordu').toEqual({
      kind: 'case',
      id: caseId,
    });
    expect(await settled(page, added.runId)).toBe('succeeded');

    const created = await backend.cardFromRun({
      runId: added.runId,
      spaceId,
      tool: 'canvas_add_card',
    });
    expect(
      before.some((c) => c.id === created.cardId),
      'karta istniala juz przed poleceniem — zastany element nie zalicza proby',
    ).toBe(false);
    expectCardPointsAtRecord(created.card, caseId);
    expect(created.card!.spec.component).toBe('procurement.costChart');

    // Visible, and without a reload.
    await openCanvas(page);
    await expect(page.getByTestId('card-cost-chart').first()).toBeVisible({ timeout: 30_000 });

    /* --- 2. zmiana tresci i przesuniecie, obie na tej samej karcie ---------- */

    const geometryBefore = created.card!.geometry;
    const changed = await send(page, 'PROBA-ZMIEN tytul tej karty i przesun ja.');
    expect(await settled(page, changed.runId)).toBe('succeeded');

    const events = await backend.runEvents(changed.runId);
    const updates = callsOf(events, 'canvas_update_card');
    const moves = callsOf(events, 'canvas_move_card');
    expect(updates.length, `wywolane narzedzia: ${toolNames(events).join(', ')}`).toBeGreaterThan(0);
    expect(moves.length, `wywolane narzedzia: ${toolNames(events).join(', ')}`).toBeGreaterThan(0);
    expect((updates[0]!.result as { cardId: string }).cardId).toBe(created.cardId);
    expect((moves[0]!.result as { cardId: string }).cardId).toBe(created.cardId);

    const afterChange = (await backend.cards(spaceId)).find(
      (c) => c.id === created.cardId,
    ) as CanvasCard;
    expect(afterChange, 'karta zniknela po zmianie').toBeTruthy();
    expect(afterChange.title).toBe('ZMIENIONY-TYTUL');
    expect(afterChange.specVersion).toBeGreaterThan(created.card!.specVersion);
    expect(
      { x: afterChange.geometry.x, y: afterChange.geometry.y },
      'przesuniecie nie zmienilo polozenia',
    ).not.toEqual({ x: geometryBefore.x, y: geometryBefore.y });
    /*
     * Widoczne, a nie tylko zapisane — i celowo probowane tutaj, bo selektor
     * naglowka karty to dokladnie ten rodzaj szczegolu, ktory na turze platnej
     * kosztuje ture.
     */
    await expect(page.locator('.react-flow')).toContainText('ZMIENIONY-TYTUL', { timeout: 30_000 });

    /* --- 3. usuniecie: karta znika z backendu i z ekranu -------------------- */

    const removed = await send(page, 'PROBA-USUN te karte.');
    expect(await settled(page, removed.runId)).toBe('succeeded');
    const removals = callsOf(await backend.runEvents(removed.runId), 'canvas_remove_card');
    expect(removals.length).toBeGreaterThan(0);
    expect((removals[0]!.result as { removed: string }).removed).toBe(created.cardId);
    expect((await backend.cards(spaceId)).some((c) => c.id === created.cardId)).toBe(false);
    await expect(page.getByTestId('card-cost-chart')).toHaveCount(0, { timeout: 30_000 });
  });

  test('A: polecenie pokazuje ustawienie i przelacza przestrzen pracy', async ({ page }) => {
    await scripted.start('bl03-canvas');
    await openApp(page, BASE);
    const backend = new Backend(page, BASE);
    const { spaceId } = await openCase(page);
    await openCanvas(page);
    /*
     * A second workspace has to exist for "switch to the other one" to mean
     * anything, and the fixture has only the one the case page binds. Made
     * through the API — preparation, not the behaviour under test.
     */
    if ((await backend.spaces()).length < 2) {
      const made = await page.request.post(`${BASE}/api/canvas/spaces`, {
        data: { title: 'Druga przestrzen' },
      });
      expect(made.status(), await made.text()).toBe(201);
      await page.reload();
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    }
    expect((await backend.spaces()).length).toBeGreaterThan(1);

    const shown = await send(page, 'PROBA-NAWIGACJA: pokaz ustawienie logowania.');
    const target = page.getByTestId('settings-auth');
    await expect(target).toBeVisible({ timeout: 60_000 });
    // The highlight is markup, not a claim in prose.
    await expect(target).toHaveAttribute('data-ui-highlight', 'true', { timeout: 15_000 });
    expect(await settled(page, shown.runId)).toBe('succeeded');

    await page.goto(`${BASE}/`);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    const switched = await send(page, 'PROBA-PRZESTRZEN: przelacz na druga przestrzen pracy.');
    expect(await settled(page, switched.runId)).toBe('succeeded');
    const navigations = callsOf(await backend.runEvents(switched.runId), 'ui_navigate');
    const last = navigations[navigations.length - 1]!;
    expect((last.result as { executed: boolean }).executed, `ui_navigate: ${last.rawResult}`).toBe(
      true,
    );
    // The address names the space the agent switched to, and it is not the one
    // the screen started on.
    await expect
      .poll(() => new URL(page.url()).searchParams.get('s'), { timeout: 20_000 })
      .not.toBe(spaceId);
  });

  /* ---------------------------------------------------------------------- */
  /*  Przebieg E — agent chodzi po relacjach                                 */
  /* ---------------------------------------------------------------------- */

  test('E: wyszukanie rekordu, przejscie po relacjach i szczegol z backendu', async ({ page }) => {
    await scripted.start('bl03-relations');
    await openApp(page, BASE);
    const backend = new Backend(page, BASE);

    const asked = await send(page, 'PROBA-RELACJE: skad wzieto cene pozycji MP-Vision?');
    expect(await settled(page, asked.runId)).toBe('succeeded');

    const events = await backend.runEvents(asked.runId);
    const names = toolNames(events);
    // Found by name, then walked: the search has to come before the traversal,
    // otherwise the identifier came from somewhere other than the agent.
    expect(names.indexOf('procurement_search')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('procurement_find_price_provenance')).toBeGreaterThan(
      names.indexOf('procurement_search'),
    );

    const provenance = callsOf(events, 'procurement_find_price_provenance')[0]!;
    const result = provenance.result as {
      supplier: { name: string };
      offer: { reference: string };
      provenance: Array<{ locator: string; file: { filename: string } }>;
    };
    expect(result.supplier.name).toContain('MediaPro');
    expect(result.offer.reference).toBe('MP-2026-0442');
    expect(result.provenance[0]!.locator).toMatch(/wiersz \d+/);
    expect(result.provenance[0]!.file.filename).toMatch(/\.csv$/);
  });

  /* ---------------------------------------------------------------------- */
  /*  Przebieg B — brama zgody (plumbing tylko; werdykty izolacji na modelu) */
  /* ---------------------------------------------------------------------- */

  test('B: odmowa nie wykonuje operacji, zgoda wykonuje ja dokladnie raz', async ({ page }) => {
    await scripted.start('bl03-consent');
    await openApp(page, BASE);
    const backend = new Backend(page, BASE);

    const refused = await send(page, 'PROBA-ZGODA: przetworz cos w powloce.');
    const first = await settledDeciding(page, refused.runId, () => 'Odmowa');
    expect(first.decisions.map((d) => d.decision)).toEqual(['Odmowa']);
    expect(first.decisions[0]!.text).toContain('Bash');
    // The whole property: a refusal leaves the work undone. `workspace_outputs`
    // is the run's own answer about its own workspace, so the absence is the
    // run's statement rather than the test's guess.
    const refusedOutputs = callsOf(await backend.runEvents(refused.runId), 'workspace_outputs')[0]!;
    expect((refusedOutputs.result as { outputs: unknown[] }).outputs).toEqual([]);

    const allowed = await send(page, 'PROBA-ZGODA jeszcze raz, tym razem zgadzam sie.');
    const second = await settledDeciding(page, allowed.runId, () => 'Zgoda');
    expect(second.decisions.map((d) => d.decision)).toEqual(['Zgoda']);
    const allowedOutputs = callsOf(await backend.runEvents(allowed.runId), 'workspace_outputs')[0]!;
    const outputs = (allowedOutputs.result as { outputs: Array<{ path: string }> }).outputs;
    // Exactly once: one file, not two, from one approved operation.
    expect(outputs.map((f) => f.path)).toEqual(['wykonane.txt']);
  });

  test('B: odmowa i zgoda na te sama operacje w JEDNYM poleceniu', async ({ page }) => {
    await scripted.start('bl03-consent');
    await openApp(page, BASE);
    const backend = new Backend(page, BASE);

    /*
     * Ksztalt, ktory naprawde wykona proba platna: jedno polecenie, dwie
     * prosby o zgode, decyzja zalezna od numeru prosby.
     */
    const sent = await send(page, 'PROBA-ZGODA-DWIE-DECYZJE: sprobuj dwa razy.');
    const both = await settledDeciding(page, sent.runId, (_text, index) =>
      index === 0 ? 'Odmowa' : 'Zgoda',
    );
    expect(both.decisions.map((d) => d.decision)).toEqual(['Odmowa', 'Zgoda']);

    const outputs = callsOf(await backend.runEvents(sent.runId), 'workspace_outputs')[0]!;
    const files = (outputs.result as { outputs: Array<{ path: string }> }).outputs.map((f) => f.path);
    // Odmowa nie wykonala swojej operacji, zgoda wykonala swoja — dokladnie raz.
    expect(files).toEqual(['druga.txt']);
  });

  /* ---------------------------------------------------------------------- */
  /*  Przebiegi C i D — blad narzedzia, Stop, sygnal, druga tura             */
  /* ---------------------------------------------------------------------- */

  test('C: blad narzedzia dociera do rozmowy jako blad, nie jako wynik', async ({ page }) => {
    await scripted.start('bl03-lifecycle');
    await openApp(page, BASE);
    const backend = new Backend(page, BASE);

    const failed = await send(page, 'PROBA-BLAD-NARZEDZIA: dodaj karte z nieznanym komponentem.');
    expect(await settled(page, failed.runId)).toBe('succeeded');

    const call = callsOf(await backend.runEvents(failed.runId), 'canvas_add_card')[0]!;
    expect(call.isError, 'nieudane wywolanie zapisane jako sukces').toBe(true);
    expect(String(call.rawResult)).toContain('nie.istnieje');
    // And the reason is on screen, not only in the log.
    await expect(page.locator('.pf-chat')).toContainText('nie.istnieje');
  });

  test('C: Stop konczy wykonanie i zabiera jego proces', async ({ page }) => {
    await scripted.start('bl03-lifecycle');
    await openApp(page, BASE);
    const serverPid = scripted.pid!;
    expect(serverPid).toBeTruthy();

    const before = descendants(serverPid);
    const long = await send(page, 'Uruchom cos dlugiego w powloce.');
    const strip = page.getByTestId('run-state');
    // Ten sam helper, ktorego uzywa proba platna — razem z klikaniem Zgody.
    const state = await working(page, long.runId);
    expect(state.decisions, 'bramka zgody nie zostala przecwiczona').toEqual(['Zgoda']);
    expect(state.inFlight, 'wykonanie nie trwalo w chwili dzialania').toBe(true);
    await expect(page.getByTestId('streaming-answer')).toContainText('[proces] pid=', {
      timeout: 30_000,
    });
    const during = descendants(serverPid);
    const started = during.filter((d) => !before.some((b) => b.pid === d.pid));
    expect(started.length, 'uruchomienie nie wystartowalo zadnego procesu').toBe(1);

    await page.getByTestId('run-stop').click();
    await expect(strip).toHaveAttribute('data-phase', /cancelled|failed/, { timeout: 30_000 });
    await expect
      .poll(() => descendants(serverPid).filter((p) => started.some((s) => s.pid === p.pid)).length, {
        timeout: 60_000,
      })
      .toBe(0);

    const backend = new Backend(page, BASE);
    const runs = await backend.runs(new URL(page.url()).searchParams.get('c')!);
    const record = runs.find((r) => r.id === long.runId)!;
    expect(record.status).toBe('cancelled');
    expect(record.errorCode).toBe('cancelled');
  });

  test('C/D: sygnal w trakcie wykonania nie zostawia procesow, a dane wracaja po restarcie', async ({
    page,
  }) => {
    await scripted.start('bl03-lifecycle');
    await openApp(page, BASE);
    const serverPid = scripted.pid!;
    const before = descendants(serverPid);

    const long = await send(page, 'Uruchom cos dlugiego w powloce.');
    const conversationId = new URL(page.url()).searchParams.get('c')!;
    const state = await working(page, long.runId);
    expect(state.decisions).toEqual(['Zgoda']);
    expect(state.inFlight).toBe(true);
    await expect(page.getByTestId('streaming-answer')).toContainText('[proces] pid=', {
      timeout: 30_000,
    });
    const during = descendants(serverPid);
    const started = during.filter((d) => !before.some((b) => b.pid === d.pid));
    expect(started.length).toBe(1);

    /* The signal, and nothing behind it: no SIGKILL, so a shutdown that hung
     * would be visible instead of hidden. */
    const outcome = await scripted.stopWith('SIGTERM');
    expect(outcome.exited, `serwer nie zakonczyl sie po SIGTERM w ${outcome.ms} ms`).toBe(true);

    // Nothing of the run is still running — neither its own child nor anything
    // that looks like a model worker.
    await expect
      .poll(() => descendants(serverPid).filter((p) => started.some((s) => s.pid === p.pid)).length, {
        timeout: 30_000,
      })
      .toBe(0);
    expect(workerProcesses(serverPid)).toEqual([]);

    /* The other half of L1.6: the durable state is still there. */
    await scripted.start('bl03-lifecycle');
    await openApp(page, BASE);
    const backend = new Backend(page, BASE);
    const runs = await backend.runs(conversationId);
    const record = runs.find((r) => r.id === long.runId)!;
    expect(record, 'uruchomienie nie przezylo restartu').toBeTruthy();
    // An interrupted run is marked as interrupted, not left looking alive.
    expect(['cancelled', 'failed']).toContain(record.status);
    expect((await backend.messages(conversationId)).length).toBeGreaterThan(0);

    /* And a second command of the same conversation still goes through. */
    await page.goto(`${BASE}/?c=${conversationId}`);
    await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
    const messagesBefore = await backend.messages(conversationId);
    const second = await send(page, 'PROBA-DRUGA-TURA: jaki kod zapamietales?');
    expect(await settled(page, second.runId)).toBe('succeeded');

    const messagesAfter = await backend.messages(conversationId);
    // Continued, not duplicated: every earlier message is still there once.
    expect(messagesAfter.length).toBeGreaterThan(messagesBefore.length);
    expect(messagesAfter.filter((m) => messagesBefore.some((b) => b.id === m.id))).toHaveLength(
      messagesBefore.length,
    );
    expect(new Set(messagesAfter.map((m) => m.id)).size).toBe(messagesAfter.length);
    expect((await backend.runs(conversationId)).length).toBe(runs.length + 1);
  });

  test('D: niezapisany szkic trafia do kontekstu jako szkic, bez wartosci', async ({ page }) => {
    await scripted.start('bl03-lifecycle');
    await openApp(page, BASE);
    const backend = new Backend(page, BASE);
    const { caseId, spaceId } = await openCase(page);

    /*
     * The form card is put on the canvas through the API — preparation, not the
     * behaviour under test (G13: the API may prepare, the interface must act).
     * The typing below is the part that matters, and it happens in the browser.
     */
    const detail = await backend.json<{ offers: Array<{ offer: { id: string } }> }>(
      `/api/m/procurement/cases/${caseId}`,
    );
    const offerId = detail.offers[0]!.offer.id;
    const created = await page.request.post(`${BASE}/api/canvas/cards`, {
      data: {
        spaceId,
        title: 'Pozycja oferty',
        spec: { kind: 'component', component: 'procurement.offerItemForm', props: { offerId } },
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    expect(
      (await backend.cards(spaceId)).some((c) => c.spec.component === 'procurement.offerItemForm'),
      'karta formularza nie powstala w przestrzeni sprawy',
    ).toBe(true);

    await openCanvas(page);
    // The card was made behind the tab's back, so the screen is asked again.
    await page.reload();
    const form = page.getByTestId('card-item-form');
    await expect(form).toBeVisible({ timeout: 30_000 });

    // Typed and deliberately not saved.
    const quantity = form.locator('input[id^="qty-"]');
    await expect(quantity).toBeVisible();
    await quantity.fill('999');
    await quantity.blur();

    const asked = await send(page, 'PROBA-SZKIC: jaka jest zapisana ilosc tej pozycji?');
    expect(await settled(page, asked.runId)).toBe('succeeded');

    const context = callsOf(await backend.runEvents(asked.runId), 'get_context')[0]!;
    const drafts = (context.result as { unsavedDrafts: Array<Record<string, unknown>> })
      .unsavedDrafts;
    expect(drafts.length, 'szkic nie trafil do kontekstu polecenia').toBeGreaterThan(0);
    expect(drafts[0]!.entity).toBe('offer_item');
    expect(drafts[0]!.dirtyFields).toContain('quantity');
    /*
     * The typed value itself must **not** travel: a draft is not data, and a
     * context carrying "999" would let an agent quote it as if it were stored.
     */
    expect(JSON.stringify(drafts)).not.toContain('999');
  });
});
