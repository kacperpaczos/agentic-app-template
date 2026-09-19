import { expect, test } from './support/fixtures.ts';
import {
  Backend,
  callsOf,
  expectCardPointsAtRecord,
  openApp,
  settled,
  toolNames,
  type CanvasCard,
} from './support/bl03-checks.ts';
import { paidRun, paidSpecPreflight } from './support/bl03-model.ts';
import { type Page } from '@playwright/test';

/**
 * Przebieg A — kompozycja kanwy przez **prawdziwy model**, cztery operacje.
 *
 * Rodzaj dowodu: **rzeczywisty model**. Four commands are typed into the
 * composer of the real production build, answered by the subscription model
 * through the application's own runtime, and judged on what each run left
 * behind: the tool it called, the `cardId` that tool returned, the card in the
 * backend, and the screen.
 *
 * Kryteria: **L3.2** (add, update, move, remove through a supported composition
 * description), **L3.10** (all four actually invoked by the agent, not by an
 * endpoint test), **L3.13** (the object is *this execution's* — the `cardId`
 * comes from this run's `TOOL_CALL_RESULT`, and a card that was there before
 * fails), **L6.6** (the command names no identifier; the record comes from the
 * context, and the card points at it), **L2.13** (a setting is shown and a
 * workspace is switched, not described).
 *
 * The scenario is rehearsed without a model in `e2e/bl03-rehearsal.spec.ts`,
 * through these very helpers. Nothing here asserts on the model's wording: an
 * agent that says the right thing and changes nothing has to fail.
 *
 * Koszt: 4 tury z grantu BL-03.
 */

const FILE = 'bl03-model-canvas.spec.ts';
const preflight = paidSpecPreflight(FILE);
const AGENT_TIMEOUT = 420_000;

async function openCase(page: Page, backend: Backend): Promise<{ caseId: string; spaceId: string }> {
  await page.goto('/cases');
  await page.locator('[data-testid^="case-tile-"]').first().click();
  await expect(page.getByTestId('case-detail-page')).toBeVisible();
  const caseId = new URL(page.url()).pathname.split('/').pop()!;
  const scoped = (await backend.spaces()).find((s) => s.scopeKind === 'case' && s.scopeId === caseId);
  expect(scoped, 'otwarcie sprawy nie utworzylo przestrzeni canvas').toBeTruthy();
  return { caseId, spaceId: scoped!.id };
}

test.describe('BL-03 przebieg A: kanwa, rekord i nawigacja na prawdziwym modelu', () => {
  test.describe.configure({ mode: 'serial', timeout: AGENT_TIMEOUT });
  test.skip(!preflight.ok, preflight.skipReason ?? '');

  test('cztery operacje kompozycji, ustawienie i przestrzen — jedna rozmowa', async ({ page }) => {
    const run = paidRun({ file: FILE, przebieg: 'A' });
    const backend = new Backend(page);
    const marker = `Z11A${Date.now().toString(36).toUpperCase()}`;
    const record: Record<string, unknown> = { znacznik: marker, kryteria: ['L3.2', 'L3.10', 'L3.13', 'L6.6', 'L2.13'] };

    try {
      await openApp(page, '');
      const { caseId, spaceId } = await openCase(page, backend);
      record.sprawa = caseId;

      /* ------------------------------ tura 1: dodanie ---------------------- */

      const before = await backend.cards(spaceId);
      const added = await run.command(
        page,
        'Dodaj na kanwie tej sprawy karte pokazujaca koszty ofert — wybierz pasujacy ' +
          'komponent z katalogu kart. ' +
          'Identyfikatora sprawy nie podaje — wez go z kontekstu tego polecenia. ' +
          'Nie opisuj drogi, po prostu dodaj karte.',
      );
      // The command carried the record, not only the space: the half of L6.6
      // that a command sent from the canvas cannot show.
      expect(added.context.resource, 'polecenie nie nioslo wskazanego rekordu').toEqual({
        kind: 'case',
        id: caseId,
      });
      const phase1 = await settled(page, added.runId);
      run.log.push({ tura: 1, cel: 'dodanie karty', runId: added.runId, faza: phase1, narzedzia: toolNames(await backend.runEvents(added.runId)) });
      expect(phase1).toBe('succeeded');

      const created = await backend.cardFromRun({ runId: added.runId, spaceId, tool: 'canvas_add_card' });
      expect(
        before.some((c) => c.id === created.cardId),
        'karta istniala juz przed poleceniem — zastany element nie zalicza proby',
      ).toBe(false);
      expectCardPointsAtRecord(created.card, caseId);
      const component = created.card!.spec.component!;
      record.kartaWykonania = created.cardId;
      record.komponent = component;
      record.kartaWskazujeSprawe = (created.card!.spec.props ?? {}).caseId;

      await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
      await expect(page.getByTestId('card-case-summary').first()).toBeVisible();
      /*
       * Po identyfikatorze karty, nie po komponencie. Ktory dokladnie komponent
       * wybierze model, jest jego decyzja w granicach katalogu — asercja na
       * `card-cost-chart` oblalaby poprawne uzycie `comparisonTable` i wydalaby
       * ture na moje zalozenie, a nie na zachowanie aplikacji.
       */
      await expect(page.getByTestId(`card-${created.cardId}`)).toBeVisible({ timeout: 60_000 });

      /* -------------------- tura 2: zmiana tresci i przesuniecie ------------ */

      const geometryBefore = created.card!.geometry;
      const changed = await run.command(
        page,
        `Zmien tytul karty, ktora przed chwila dodales, na doslownie „ZMIENIONY-${marker}” ` +
          'i przesun te karte nizej i bardziej w prawo niz jest teraz. ' +
          'Zawartosci karty nie zmieniaj — ma dalej pokazywac ten sam wykres.',
      );
      const phase2 = await settled(page, changed.runId);
      const events2 = await backend.runEvents(changed.runId);
      run.log.push({ tura: 2, cel: 'zmiana i przesuniecie', runId: changed.runId, faza: phase2, narzedzia: toolNames(events2) });
      expect(phase2).toBe('succeeded');

      const updates = callsOf(events2, 'canvas_update_card');
      const moves = callsOf(events2, 'canvas_move_card');
      expect(updates.length, `wywolane narzedzia: ${toolNames(events2).join(', ')}`).toBeGreaterThan(0);
      expect(moves.length, `wywolane narzedzia: ${toolNames(events2).join(', ')}`).toBeGreaterThan(0);
      // Both operations on the card **this** run's predecessor created.
      expect((updates[updates.length - 1]!.result as { cardId: string }).cardId).toBe(created.cardId);
      expect((moves[moves.length - 1]!.result as { cardId: string }).cardId).toBe(created.cardId);

      const afterChange = (await backend.cards(spaceId)).find((c) => c.id === created.cardId) as CanvasCard;
      expect(afterChange, 'karta zniknela po zmianie').toBeTruthy();
      expect(afterChange.title).toContain(`ZMIENIONY-${marker}`);
      expect(afterChange.specVersion).toBeGreaterThan(created.card!.specVersion);
      expect(
        { x: afterChange.geometry.x, y: afterChange.geometry.y },
        'przesuniecie nie zmienilo polozenia',
      ).not.toEqual({ x: geometryBefore.x, y: geometryBefore.y });
      // The content survived the content edit — a card that lost its component
      // would satisfy "the title changed" and be a defect.
      expect(afterChange.spec.component).toBe(component);
      expect((afterChange.spec.props ?? {}).caseId).toBe(caseId);
      record.poZmianie = { tytul: afterChange.title, specVersion: afterChange.specVersion, geometria: afterChange.geometry };

      await expect(page.locator('.react-flow')).toContainText(`ZMIENIONY-${marker}`, { timeout: 60_000 });

      /* ----------------------------- tura 3: usuniecie ---------------------- */

      const removed = await run.command(page, 'Usun z kanwy te karte, ktora przed chwila zmieniles.');
      const phase3 = await settled(page, removed.runId);
      const events3 = await backend.runEvents(removed.runId);
      run.log.push({ tura: 3, cel: 'usuniecie', runId: removed.runId, faza: phase3, narzedzia: toolNames(events3) });
      expect(phase3).toBe('succeeded');

      const removals = callsOf(events3, 'canvas_remove_card');
      expect(removals.length, `wywolane narzedzia: ${toolNames(events3).join(', ')}`).toBeGreaterThan(0);
      expect((removals[removals.length - 1]!.result as { removed: string }).removed).toBe(created.cardId);
      expect((await backend.cards(spaceId)).some((c) => c.id === created.cardId)).toBe(false);
      await expect(page.getByTestId(`card-${created.cardId}`)).toHaveCount(0, { timeout: 60_000 });
      // The rest of the composition is untouched.
      await expect(page.getByTestId('card-case-summary').first()).toBeVisible();

      /* ------------------- tura 4: ustawienie i przestrzen ------------------ */

      if ((await backend.spaces()).length < 2) {
        const made = await page.request.post('/api/canvas/spaces', { data: { title: 'Druga przestrzen' } });
        expect(made.status(), await made.text()).toBe(201);
        await page.reload();
        await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();
      }
      const spacesBefore = await backend.spaces();
      const other = spacesBefore.find((s) => s.id !== spaceId)!;

      const navigated = await run.command(
        page,
        'Pokaz mi w ustawieniach sekcje ze stanem logowania Claude — ' +
          'nie opisuj do niej drogi, tylko ja otworz i wskaz. ' +
          `Potem przelacz mnie na przestrzen pracy „${other.title}”.`,
      );
      const target = page.getByTestId('settings-auth');
      await expect(target).toBeVisible({ timeout: AGENT_TIMEOUT });
      await expect(target).toHaveAttribute('data-ui-highlight', 'true', { timeout: 30_000 });

      const phase4 = await settled(page, navigated.runId);
      const events4 = await backend.runEvents(navigated.runId);
      run.log.push({ tura: 4, cel: 'ustawienie i przestrzen', runId: navigated.runId, faza: phase4, narzedzia: toolNames(events4) });
      expect(phase4).toBe('succeeded');

      const navigations = callsOf(events4, 'ui_navigate');
      const shownSetting = navigations.find(
        (c) => (c.args as { targetId?: string } | null)?.targetId === 'platform.settings.auth',
      );
      expect(shownSetting, `ui_navigate nie pokazal ustawienia; wywolania: ${toolNames(events4).join(', ')}`).toBeTruthy();
      expect((shownSetting!.result as { executed: boolean }).executed).toBe(true);

      const switched = navigations.find((c) => (c.args as { spaceId?: string } | null)?.spaceId);
      expect(switched, 'zadne ui_navigate nie przelaczylo przestrzeni pracy').toBeTruthy();
      expect((switched!.result as { executed: boolean }).executed, String(switched!.rawResult)).toBe(true);
      await expect
        .poll(() => new URL(page.url()).searchParams.get('s'), { timeout: 30_000 })
        .toBe(other.id);
      record.przestrzenPo = new URL(page.url()).searchParams.get('s');
      record.wynik = 'zaliczona';
    } finally {
      run.save('a-kanwa-rekord-nawigacja.json', { ...record, wynik: record.wynik ?? 'niezaliczona' });
    }
  });
});
