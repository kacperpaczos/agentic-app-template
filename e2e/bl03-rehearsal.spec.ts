import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import {
  Backend,
  callsOf,
  customEvents,
  descendants,
  expectCardPointsAtRecord,
  findFormulaCellXml,
  openApp,
  settled,
  settledDeciding,
  toolCalls,
  toolNames,
  stillRunning,
  typeCommand,
  working,
  type CanvasCard,
} from './support/bl03-checks.ts';
import { readZipEntry, writeZipWith } from '../tests/support/zip.ts';
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
    // Ta sama kontrola, ktorej uzywa spec platny: po tozsamosci, nie po rodzicu.
    await expect.poll(() => stillRunning(started).length, { timeout: 60_000 }).toBe(0);

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
    /*
     * Po tozsamosci zapamietanej PRZED sygnalem. Serwera juz nie ma, wiec
     * pytanie o jego potomstwo zawsze dawaloby pusto — i wlasnie dlatego ta
     * kontrola byla wczesniej niezdolna do oblania.
     */
    await expect.poll(() => stillRunning(started).length, { timeout: 30_000 }).toBe(0);
    expect(stillRunning(started), 'osierocony proces po SIGTERM').toEqual([]);

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

  /**
   * Proba zdolnosci wykrycia dla kontroli wycieku procesow (L1.6).
   *
   * Warunek postawiony w recenzji: kontrola, ktora nie potrafi oblac na
   * zastepniku, nie zasluguje na ture. Scenariusz uruchamia potomka, ktory
   * **ignoruje SIGTERM** i nie jest zwiazany z sygnalem przerwania — czyli
   * dokladnie wyciek, o ktorym mowi opis braku L1.6. Kontrola po tozsamosci
   * musi go **znalezc**; poprzednia, po potomstwie serwera, zwrocilaby pusto,
   * bo osierocony proces jest przepiety do init.
   *
   * Test konczy sie sprzatnieciem procesu proby po pid — nie po nazwie.
   */
  test('C: kontrola wycieku procesow POTRAFI oblac (potomek ignorujacy sygnal)', async ({ page }) => {
    await scripted.start('bl03-lifecycle');
    await openApp(page, BASE);
    const serverPid = scripted.pid!;
    const before = descendants(serverPid);

    const long = await send(page, 'PROBA-WYCIEK: uruchom cos dlugiego w powloce.');
    const state = await working(page, long.runId);
    expect(state.decisions).toEqual(['Zgoda']);
    await expect(page.getByTestId('streaming-answer')).toContainText('[proces] pid=', {
      timeout: 30_000,
    });

    const during = descendants(serverPid);
    const started = during.filter((d) => !before.some((b) => b.pid === d.pid));
    expect(started.length, 'scenariusz proby nie uruchomil procesu').toBeGreaterThan(0);

    const outcome = await scripted.stopWith('SIGTERM');
    expect(outcome.exited).toBe(true);

    /*
     * Sedno proby. Stara kontrola pytala o potomstwo nieistniejacego juz
     * serwera i odpowiadala „pusto" — zaliczenie mimo wycieku. Nowa pyta o te
     * konkretne procesy i ma je **znalezc**.
     */
    expect(
      descendants(serverPid),
      'kontrola po potomstwie zwraca pusto mimo wycieku — dlatego zostala wymieniona',
    ).toEqual([]);
    const leaked = stillRunning(started);
    expect(
      leaked.length,
      'kontrola wycieku NIE wykryla procesu, ktory przezyl sygnal — nie potrafi oblac',
    ).toBeGreaterThan(0);

    // Sprzatniecie po pid, nigdy po nazwie.
    for (const p of leaked) {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        /* zdazyl sam wyjsc */
      }
    }
    await expect.poll(() => stillRunning(leaked).length, { timeout: 15_000 }).toBe(0);
  });

  /**
   * Proba generalna scenariusza T14 (cztery proby izolacji narzedziami
   * plikowymi) — **bez modelu**, na stand-inie, przed wydaniem tury.
   *
   * Tura jest nieodwracalna, a scenariusz, ktory padnie na skrypcie, jest
   * strata bez odwolania. Ten test woduje wiec dokladnie te proby z projektu
   * tury — odczyt bazy, odczyt sekretu poza katalogiem danych, zapis poza
   * katalogiem roboczym, `Glob`/`Grep` poza katalogiem roboczym — przez ten sam
   * runtime, ten sam most hookow i ten sam `Backend.runEvents`, ktore proba
   * platna (`bl03-model-t14.spec.ts`) czyta jako dowod.
   *
   * Po scaleniu straznika Z12 **odmowa narzedzia plikowego zapada w hooku
   * `PreToolUse` w runtime, a stand-in odpala prawdziwe hooki** — wiec werdykt
   * drogi plikowej jest tu asertowany tak samo, jak asertuje go proba platna:
   * kazda proba pelnym krokiem, kazda odrzucona (`isError` z trescia powodu),
   * kanarek nie opuszcza pliku, zapis nie zostawia pliku. Werdytki **powloki i
   * sandboxa** pozostaja w specie modelowym samym (patrz naglowek
   * `bl03-checks.ts`), bo tych stand-in nie reprezentuje.
   */
  test('B (T14): cztery proby izolacji plikowej przebiegaja i sa zapisywane', async ({ page }) => {
    const sekretDir = mkdtempSync(join(tmpdir(), 'z11-proba-sekret-'));
    const sekret = join(sekretDir, 'sekret.txt');
    writeFileSync(sekret, 'SEKRET-KANAREK-Z11\n');
    const zapis = join(tmpdir(), `z11-proba-zapis-${Date.now().toString(36)}.txt`);
    try {
      await scripted.start('bl03-isolation', {
        Z11_SEKRET: sekret,
        Z11_SEKRET_DIR: sekretDir,
        Z11_ZAPIS: zapis,
      });
      await openApp(page, BASE);

      const proba = await send(page, 'PROBA-IZOLACJA-PLIKI: wykonaj cztery proby izolacji.');
      expect(await settled(page, proba.runId)).toBe('succeeded');

      const backend = new Backend(page, BASE);
      const events = await backend.runEvents(proba.runId);
      const calls = toolCalls(events);
      const poNazwie = (name: string) =>
        calls.filter((c) => c.name.replace(/^mcp__app__/, '') === name);
      const pelnyKrok = (c: (typeof calls)[number]) =>
        c.name !== '' && c.args !== null && c.rawResult !== null;

      /* Kazda proba jest w strumieniu pelnym krokiem narzedzia. */
      const odczytyBazy = poNazwie('Read').filter(
        (c) => String((c.args as { file_path?: string }).file_path ?? '').endsWith('app.db'),
      );
      const odczytySekretu = poNazwie('Read').filter(
        (c) => String((c.args as { file_path?: string }).file_path ?? '') === sekret,
      );
      const zapisyPoza = poNazwie('Write').filter(
        (c) => String((c.args as { file_path?: string }).file_path ?? '') === zapis,
      );
      const globyPoza = poNazwie('Glob').filter(
        (c) => String((c.args as { path?: string }).path ?? '') === sekretDir,
      );
      const grepyPoza = poNazwie('Grep').filter(
        (c) => String((c.args as { path?: string }).path ?? '') === sekretDir,
      );
      expect(pelnyKrok(odczytyBazy[0]!), 'brak proby odczytu bazy').toBe(true);
      expect(pelnyKrok(odczytySekretu[0]!), 'brak proby odczytu sekretu').toBe(true);
      expect(pelnyKrok(zapisyPoza[0]!), 'brak proby zapisu poza workspace').toBe(true);
      expect(pelnyKrok(globyPoza[0]!), 'brak proby Glob poza workspace').toBe(true);
      expect(pelnyKrok(grepyPoza[0]!), 'brak proby Grep poza workspace').toBe(true);

      /*
       * Werdykt drogi plikowej, taki sam jak w probie platnej: kazda z prob
       * odrzucona widocznie — `isError` z niepusta trescia powodu. Po scaleniu
       * straznika Z12 odmowa zapada w hooku runtime, ktory stand-in odpala
       * naprawde, wiec to jest proba generalna calego werdyktu, nie tylko
       * mechanizmu zapisu.
       */
      for (const [nazwa, c] of [
        ['Read app.db', odczytyBazy[0]],
        ['Read sekret', odczytySekretu[0]],
        ['Write poza workspace', zapisyPoza[0]],
        ['Glob poza workspace', globyPoza[0]],
        ['Grep poza workspace', grepyPoza[0]],
      ] as Array<[string, (typeof calls)[number] | undefined]>) {
        expect(c, `brak proby: ${nazwa}`).toBeTruthy();
        expect(c!.isError, `${nazwa} NIE zostalo odrzucone na scalonym strazniku`).toBe(true);
        expect(String(c!.rawResult ?? '').length, `${nazwa}: odmowa bez tresci powodu`).toBeGreaterThan(0);
      }

      /* Kanarek nie opuscil pliku zadna droga. */
      expect(
        JSON.stringify(events).includes('SEKRET-KANAREK-Z11'),
        'kanarek trafił do strumienia zdarzen mimo straznika',
      ).toBe(false);

      /* Zapis nie zostawil pliku — skutek z systemu plikow. */
      expect(existsSync(zapis), 'zapis poza workspace powiodl sie na stand-inie').toBe(false);
      if (existsSync(zapis)) rmSync(zapis, { force: true });
    } finally {
      rmSync(sekretDir, { recursive: true, force: true });
    }
  });

  /**
   * Blizniak T15 (grupy D+E) — caly przeplyw jednej rozmowy na stand-inie:
   * blad narzedzia → Stop → sygnal + restart → wznowienie. Krok z chirurgia
   * transkryptu jest na stand-inie tylko notowany (skryptowany adapter nie
   * pisze transkryptow CLI na dysk), wiec werdykt L7.13 nalezy do tury;
   * reszta przeplywu jest asertowana.
   */
  test('T15 (D+E): blad, Stop, sygnal i wznowienie przebiegaja na stand-inie', async ({ page }) => {
    await scripted.start('bl03-lifecycle');
    await openApp(page, BASE);
    const backend = new Backend(page, BASE);

    /* --- tura 1: blad narzedzia --- */
    const blad = await send(page, 'PROBA-BLAD-NARZEDZIA: wywolaj canvas_add_card z komponentem nie.istnieje.');
    expect(await settled(page, blad.runId)).toBe('succeeded');
    const bladCalls = callsOf(await backend.runEvents(blad.runId), 'canvas_add_card');
    expect(bladCalls.length, 'brak proby canvas_add_card').toBeGreaterThan(0);
    expect(bladCalls.some((c) => c.isError), 'blad narzedzia nie jest widoczny w strumieniu').toBe(true);

    /* --- tura 2: Stop w trakcie pracy potomka --- */
    const serverPid = scripted.pid!;
    const before = descendants(serverPid);
    const stopRun = await send(page, 'Uruchom cos dlugiego w powloce.');
    const stan = await working(page, stopRun.runId);
    expect(stan.inFlight, 'wykonanie nie zdazylo ruszyc — Stop niczego nie sprawdzi').toBe(true);
    const during = descendants(serverPid);
    const started = during.filter((d) => !before.some((b) => b.pid === d.pid));
    expect(started.length, 'brak procesow w trakcie').toBeGreaterThan(0);
    await page.getByTestId('run-stop').click();
    await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /cancelled|failed/, {
      timeout: 120_000,
    });
    await expect.poll(() => stillRunning(started).length, { timeout: 120_000 }).toBe(0);

    /* --- tura 3: sygnal w trakcie, restart, trwalosc --- */
    const beforeSig = descendants(scripted.pid!);
    const sigRun = await send(page, 'Uruchom cos dlugiego w powloce.');
    const stanSig = await working(page, sigRun.runId);
    expect(stanSig.inFlight).toBe(true);
    const duringSig = descendants(scripted.pid!);
    const startedSig = duringSig.filter((d) => !beforeSig.some((b) => b.pid === d.pid));
    expect(startedSig.length).toBeGreaterThan(0);
    const outcome = await scripted.stopWith('SIGTERM');
    expect(outcome.exited).toBe(true);
    await expect.poll(() => stillRunning(startedSig).length, { timeout: 120_000 }).toBe(0);

    await scripted.start('bl03-lifecycle');
    const convId = new URL(page.url()).searchParams.get('c')!;
    await openApp(page, BASE);
    await page.goto(`${BASE}/?c=${convId}`);
    const runs = await backend.runs(convId);
    const interrupted = runs.find((r) => r.id === sigRun.runId)!;
    expect(interrupted, 'uruchomienie nie przezylo restartu').toBeTruthy();
    expect(['cancelled', 'failed']).toContain(interrupted.status);

    /* --- tura 4: wznowienie (na stand-inie bez chirurgii transkryptu) --- */
    const sessionBefore = runs.find((r) => r.claudeSessionId)?.claudeSessionId ?? null;
    const wiadomosciPrzed = (await backend.messages(convId)).map((m) => m.id);
    const czwarta = await send(page, 'PROBA-DRUGA-TURA: jaki kod zapamietales?');
    expect(await settled(page, czwarta.runId)).toBe('succeeded');
    const events4 = await backend.runEvents(czwarta.runId);
    const wiazanie = customEvents(events4).filter((n) => n.includes('session_bound'));
    expect(wiazanie.length, 'brak zdarzenia wiazania sesji przy wznowieniu').toBeGreaterThan(0);
    const wiadomosciPo = (await backend.messages(convId)).map((m) => m.id);
    expect(wiadomosciPo.length).toBeGreaterThanOrEqual(wiadomosciPrzed.length);
    expect(new Set(wiadomosciPo).size).toBe(wiadomosciPo.length);
    void sessionBefore;
  });

  /**
   * Blizniak T16 (F2) — nieistniejaca sprawa przez PRAWDZIWE narzedzie
   * (prawdziwy handler, prawdziwy not_found) i arkusz z formula zbudowany
   * PRAWDZIWYM kodem w PRAWDZIWYM workspace. Asertuje tez, ze helper komorki
   * A4 potrafi oblac: skoroszyt z zapisana wartoscia musi zostac posmiaty.
   */
  test('T16 (F2): not_found przez narzedzie i arkusz bez wyniku przeliczenia', async ({ page }) => {
    await scripted.start('bl03-t16');
    await openApp(page, BASE);
    const backend = new Backend(page, BASE);

    const proba = await send(page, 'PROBA-T16: sprawy i arkusz.');
    expect(await settled(page, proba.runId)).toBe('succeeded');

    const events = await backend.runEvents(proba.runId);
    const calls = toolCalls(events);
    const getCase = calls.filter((c) => c.name.replace(/^mcp__app__/, '') === 'procurement_get_case');
    expect(getCase.length, 'brak wywolan get_case').toBeGreaterThanOrEqual(2);
    const fikcyjna = getCase.find((c) => JSON.stringify(c.args).includes('L611-nie-ma-takiej-sprawy'));
    expect(fikcyjna, 'brak proby nieistniejacej sprawy').toBeTruthy();
    expect(fikcyjna!.isError, 'nieistniejaca sprawa nie zostala odrzucona').toBe(true);
    expect(String(fikcyjna!.rawResult)).toContain('nie istnieje');
    const rzeczywista = getCase.find((c) => !c.isError);
    expect(rzeczywista, 'brak udanego odczytu istniejacej sprawy').toBeTruthy();

    /*
     * Plik zbudowany przez workspaceScript i opublikowany narzedziem w trakcie
     * wykonania — workspace znika z koncem wykonania, artefakt zostaje.
     */
    const lista = await backend.json<{ artifacts: Array<{ id: string; title: string }> }>('/api/artifacts');
    const artykul = lista.artifacts.find((a) => a.title === 'Formula T16');
    expect(artykul, `brak opublikowanego artefaktu: ${JSON.stringify(lista.artifacts.map((a) => a.title))}`).toBeTruthy();
    const meta = await backend.json<{ fileId: string }>(`/api/artifacts/${artykul!.id}`);
    expect(meta.fileId, 'artefakt nie niesie fileId wersji').toBeTruthy();
    /*
     * Bajty z magazynu plikow na dysku (`dataDir/files/<fileId><ext>`), bo
     * endpoint /content doklada podwojny Content-Length, ktorego requester
     * testowy nie przyjmuje. Serwer jest lokalny dla testu — to odczyt tego
     * samego, co serwuje przegladarce.
     */
    const magazyn = resolve(scripted.config.dataDir, 'files');
    const nazwa = readdirSync(magazyn).find((f: string) => f.startsWith(meta.fileId));
    expect(nazwa, `pliku ${meta.fileId} nie ma w magazynie`).toBeTruthy();
    const bajty = readFileSync(resolve(magazyn, nazwa!));
    const komorka = findFormulaCellXml(bajty);
    expect(komorka.formula, `komorka A4 bez formuly: ${JSON.stringify(komorka)}`).toBeTruthy();
    expect(komorka.cachedValue, `komorka A4 z zapisana wartoscia: ${JSON.stringify(komorka)}`).toBeNull();

    /*
     * Kontrola przeciwna helpera, na PRAWDZIWYCH bajtach: ten sam arkusz
     * z doklejona zapisana wartoscia musi zostac rozpoznany — helper, ktory
     * widzi jedno i to samo w kazdym pliku, nie potrafi oblac.
     */
    const czesc = readZipEntry(bajty, 'xl/worksheets/sheet1.xml').toString('utf8');
    const winnyXml = czesc.replace(
      /(<c r="A4">)(.*?)(<\/c>)/s,
      '$1$2<v>66</v>$3',
    );
    expect(winnyXml, 'wstrzykniecie wartosci nie zmienilo arkusza').not.toBe(czesc);
    const zWinna = writeZipWith(bajty, { 'xl/worksheets/sheet1.xml': winnyXml });
    const komorkaWinna = findFormulaCellXml(zWinna);
    expect(komorkaWinna.cachedValue, 'helper nie widzi zapisanej wartosci — nie potrafi oblac').toBe('66');
  });

  /**
   * Blizniak T17 (G2) — kolejnosc bramek na stand-inie: Write i Read
   * (pre-zatwierdzone) bez zadnego pytania, Bash przez prawdziwa bramke,
   * odpowiedz Odmowa i zero skutku.
   */
  test('T17 (G2): Write i Read bez pytania, Bash przez bramke i odmowiony', async ({ page }) => {
    await scripted.start('bl03-t17');
    await openApp(page, BASE);

    const proba = await send(page, 'PROBA-T17: trzy operacje.');
    const outcome = await settledDeciding(page, proba.runId, () => 'Odmowa');
    expect(await page.getByTestId('run-state').getAttribute('data-phase')).toMatch(/succeeded|failed/);

    const backend = new Backend(page, BASE);
    const events = await backend.runEvents(proba.runId);
    const calls = toolCalls(events);
    const wpisy = calls.filter((c) => c.name.replace(/^mcp__app__/, '') === 'Write');
    const odczyty = calls.filter((c) => c.name.replace(/^mcp__app__/, '') === 'Read');
    expect(wpisy.length, 'brak Write').toBeGreaterThan(0);
    expect(odczyty.length, 'brak Read').toBeGreaterThan(0);
    for (const c of [...wpisy, ...odczyty]) {
      expect(c.isError, `${c.name} zakonczyl sie bledem: ${String(c.rawResult).slice(0, 200)}`).toBe(false);
    }
    /*
     * Ograniczenie stand-inu, zapisane wprost: odrzucone `ask` nie zostawia kroku
     * narzedzia w strumieniu — realny SDK oglosza wywolanie zanim bramka odpowie
     * (tura 16 pokazala odrzuconego Basha w narzedziach przebiegu). Asertowanie
     * kroku Bash nalezy do tury platnej; stand-in asertuje pytanie bramki.
     */

    const pytania = events.filter((e) => e.name === 'CUSTOM' && e.payload?.name === 'platform.permission_request');
    const narzedziePytania = (e: { payload?: unknown }) =>
      String((e.payload as { value?: { toolName?: unknown } } | null)?.value?.toolName ?? '');
    const pytaniaOFile = pytania.filter((e) => /^(Write|Read|Edit|Glob|Grep)$/.test(narzedziePytania(e)));
    const pytaniaOBash = pytania.filter((e) => narzedziePytania(e) === 'Bash');
    expect(pytaniaOFile.length, 'bramka pytala o narzedzia plikowe').toBe(0);
    expect(pytaniaOBash.length, 'bramka nie pytala o powloke').toBeGreaterThan(0);
    expect(outcome.decisions.length, 'decyzje rozjechaly sie z pytaniami').toBe(pytania.length);
    /*
     * Ta sama koperta po stronie rozstrzygniec: `platform.permission_resolved`
     * siedzi w `payload.name`, nie w galnym `name` zdarzenia. Probę generalną
     * dodano po recenzji, która znalazła w bliźniaku płatnym licznik liczony
     * po galej nazwie — na stand-inie zielony, na turze zawsze zerowy.
     */
    const rozstrzygniecia = events.filter(
      (e) => e.name === 'CUSTOM' && e.payload?.name === 'platform.permission_resolved',
    );
    expect(rozstrzygniecia.length, 'decyzje rozjechaly sie ze zdarzeniami permissionResolved').toBe(
      outcome.decisions.length,
    );
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
