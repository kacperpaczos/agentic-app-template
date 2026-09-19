import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import {
  Backend,
  callsOf,
  customEvents,
  descendants,
  openApp,
  settled,
  toolNames,
  workerProcesses,
  working,
} from './support/bl03-checks.ts';
import { paidRun, paidSpecPreflight } from './support/bl03-model.ts';

/**
 * Przebiegi C i D — blad, Stop, sygnal i wznowienie sesji, na **prawdziwym
 * modelu**.
 *
 * Rodzaj dowodu: **rzeczywisty model**, przez `@mastra/claude` i proces Claude
 * Agent SDK.
 *
 * ## Dlaczego ten plik ma wlasna instancje
 *
 * Playwright owns the suite's server: a test may not stop it, signal it or
 * start it again on the same data. Three of the claims here are about exactly
 * that — what a SIGTERM leaves running, what survives a restart, and whether a
 * second turn of a conversation resumes the right Claude session **after** the
 * backend has been restarted. So this spec starts the production bundle itself
 * (`ScriptedInstance`, `entry: 'production'`), on its own reserved port and its
 * own `.e2e-real-bl03` directory, and signals only the child it started.
 *
 * Kryteria: **L8.5** (the second turn continues the same session id, remembers
 * the first, and does not duplicate the history — including across a restart),
 * **L6.5** (an unsaved form is context, not data: the agent answers with the
 * stored value and says the draft is unsaved), **L5.8** (the tool-failure hook
 * and the argument content on the *real* adapter, not in a simulation),
 * **L7.3** (result, error and cancellation reach the client through the
 * orchestration layer), **L1.6** (a signal during a real execution leaves no
 * unmanaged worker process, and the durable data comes back).
 *
 * L7.13 is **not** this package's criterion and is not claimed here. The
 * resumption below passes through the point where a lost transcript would show,
 * so what the SDK actually did is recorded in the evidence for whoever owns it.
 *
 * Koszt: do 7 tur z grantu BL-03 (6 zaplanowanych, 1 zapas).
 */

const FILE = 'bl03-model-lifecycle.spec.ts';
const preflight = paidSpecPreflight(FILE);
const AGENT_TIMEOUT = 420_000;

const instance = new ScriptedInstance({
  port: 8797,
  dataDirName: '.e2e-real-bl03',
  entry: 'production',
  logFile: 'docs/evidence/z11-bl03/serwer-produkcyjny.log',
});
const BASE = instance.baseUrl;

const run = paidRun({ file: FILE, przebieg: 'C/D' });

/**
 * Praca, ktora naprawde trwa.
 *
 * Dwa podejscia, oba zmierzone:
 *
 *  1. dlugie generowanie tekstu — model robi to bez wahania, ale sonda bez
 *     modelu pokazala, ze sesja SDK w tej wersji **nie zostawia zadnego procesu
 *     potomnego** serwera (CLI dziala w tym samym procesie);
 *  2. `sleep 45` w powloce, zeby pod sandboxem powstal prawdziwy proces — model
 *     tego **nie wykonal**: nie poprosil o zgode i skonczyl ture bez wywolania
 *     powloki (tura 13 grantu, `decyzjeZgody: []`, zero potomkow).
 *
 * Wracamy wiec do (1). Kryterium mowi o tym, co zostaje PO zatrzymaniu, a nie o
 * tym, ile procesow bylo w trakcie — liczba w trakcie idzie do dowodu, zeby
 * czytelnik wiedzial, na czym ten wynik stoi.
 */
const LONG_COMMAND =
  'Wypisz po kolei liczby od 1 do 150. Kazda w osobnej linii, a przy kazdej dopisz ' +
  'jedno krotkie zdanie o tym, czy jest parzysta i czy jest podzielna przez trzy. ' +
  'Nie skracaj, nie streszczaj i nie uzywaj zadnych narzedzi — wypisz wszystkie.';

test.describe('BL-03 przebiegi C i D: blad, Stop, sygnal, wznowienie sesji', () => {
  test.describe.configure({ mode: 'serial', timeout: AGENT_TIMEOUT });
  test.skip(!preflight.ok, preflight.skipReason ?? '');

  test.beforeAll(async () => {
    instance.prepareDatabase();
    await instance.start('-');
  });
  test.afterAll(async () => {
    await instance.stop();
  });

  /* ---------------------------------------------------------------------- */
  /*  D — wznowienie sesji po restarcie backendu (L8.5)                      */
  /* ---------------------------------------------------------------------- */

  test('druga tura po restarcie backendu wznawia te sama sesje i nie powiela historii', async ({
    page,
  }) => {
    const backend = new Backend(page, BASE);
    const record: Record<string, unknown> = { kryteria: ['L8.5'], obserwacjaDla: 'L7.13' };
    try {
      await openApp(page, BASE);

      const first = await run.command(
        page,
        'Zapamietaj liczbe 4721 jako kod operacji na te rozmowe. Odpowiedz tylko: OK.',
      );
      const conversationId = new URL(page.url()).searchParams.get('c')!;
      expect(await settled(page, first.runId)).toBe('succeeded');

      const runsBefore = await backend.runs(conversationId);
      const messagesBefore = await backend.messages(conversationId);
      const sessionBefore = runsBefore.find((r) => r.id === first.runId)!.claudeSessionId;
      expect(sessionBefore, 'pierwsza tura nie zostala powiazana z sesja Claude').toBeTruthy();
      record.turaPierwsza = { runId: first.runId, wiadomosci: messagesBefore.length };

      /* ------------------------- restart backendu ------------------------- */

      const stopped = await instance.stopWith('SIGTERM');
      expect(stopped.exited, `backend nie zakonczyl sie po SIGTERM (${stopped.ms} ms)`).toBe(true);
      await instance.start('-');
      await page.goto(`${BASE}/?c=${conversationId}`);
      await expect(page.locator('.openui-agent-thread-composer__input')).toBeVisible();

      /* -------------------------- druga tura ------------------------------ */

      const second = await run.command(
        page,
        'Jaki kod operacji kazalem ci zapamietac w tej rozmowie? Odpowiedz sama liczba.',
      );
      const phase = await settled(page, second.runId);
      const events = await backend.runEvents(second.runId);
      run.log.push({ cel: 'druga tura po restarcie', runId: second.runId, faza: phase });
      expect(phase).toBe('succeeded');

      const runsAfter = await backend.runs(conversationId);
      const secondRecord = runsAfter.find((r) => r.id === second.runId)!;
      // The same session, resumed by its own id — not a new one started quietly.
      expect(secondRecord.claudeSessionId, 'druga tura nie ma sesji Claude').toBeTruthy();
      expect(
        secondRecord.claudeSessionId,
        'druga tura odpowiedziala z innej sesji niz pierwsza',
      ).toBe(sessionBefore);

      // Memory of the first turn, which is the only thing a resumed session is for.
      const said = await backend.assistantText(conversationId);
      record.odpowiedzDrugiejTury = said.slice(-600);
      expect(said).toContain('4721');

      // Continued, not duplicated: every earlier message is still there, once.
      const messagesAfter = await backend.messages(conversationId);
      expect(messagesAfter.length).toBeGreaterThan(messagesBefore.length);
      expect(messagesAfter.filter((m) => messagesBefore.some((b) => b.id === m.id))).toHaveLength(
        messagesBefore.length,
      );
      expect(new Set(messagesAfter.map((m) => m.id)).size).toBe(messagesAfter.length);
      expect(runsAfter.length).toBe(runsBefore.length + 1);

      /*
       * Observation for somebody else's criterion (L7.13): whether the SDK
       * refused the resume, answered from a different session, or resumed
       * cleanly. Recorded, never claimed.
       */
      record.l713 = {
        sesjaPierwszejTury: Boolean(sessionBefore),
        sesjeIdentyczne: secondRecord.claudeSessionId === sessionBefore,
        zdarzeniaCustom: customEvents(events),
        transkryptUtracony: customEvents(events).includes('platform.session_transcript_lost'),
        kodBledu: secondRecord.errorCode,
      };
      record.wynik = 'zaliczona';
    } finally {
      run.save('d-wznowienie-sesji.json', { ...record, wynik: record.wynik ?? 'niezaliczona' });
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  D — szkic formularza a dane zapisane (L6.5)                            */
  /* ---------------------------------------------------------------------- */

  test('agent podaje wartosc zapisana i odnotowuje niezapisany szkic', async ({ page }) => {
    const backend = new Backend(page, BASE);
    const record: Record<string, unknown> = { kryteria: ['L6.5'] };
    try {
      await openApp(page, BASE);
      await page.goto(`${BASE}/cases`);
      await page.locator('[data-testid^="case-tile-"]').first().click();
      await expect(page.getByTestId('case-detail-page')).toBeVisible();
      const caseId = new URL(page.url()).pathname.split('/').pop()!;
      const spaceId = (await backend.spaces()).find((s) => s.scopeId === caseId)!.id;

      /*
       * The form card is placed through the API — preparation, not the
       * behaviour under test. The typing below happens in the browser, which is
       * the part that registers the draft (G13).
       */
      const detail = await backend.json<{
        offers: Array<{
          offer: { id: string };
          items: Array<{ id: string; name: string; quantityMilli: number; unit: string; version: number }>;
        }>;
      }>(`/api/m/procurement/cases/${caseId}`);
      const offer = detail.offers[0]!;
      const created = await page.request.post(`${BASE}/api/canvas/cards`, {
        data: {
          spaceId,
          title: 'Pozycja oferty',
          spec: { kind: 'component', component: 'procurement.offerItemForm', props: { offerId: offer.offer.id } },
        },
      });
      expect(created.status(), await created.text()).toBe(201);

      await page.getByRole('link', { name: 'Otworz przestrzen pracy na canvasie' }).click();
      await page.reload();
      const form = page.getByTestId('card-item-form');
      await expect(form).toBeVisible({ timeout: 60_000 });

      const selectedName = await form.locator('select').inputValue();
      const item = offer.items.find((i) => i.id === selectedName) ?? offer.items[0]!;

      /*
       * Zapisana ilosc ustawiona na liczbe, ktorej nigdzie indziej nie ma.
       *
       * Przy ilosci „2” asercja „odpowiedz zawiera zapisana wartosc” przechodzi
       * przez przypadek — dwojka trafi sie w kazdym zdaniu z liczba. Przy 37
       * trafienie znaczy, ze agent podal wlasnie te wartosc. Ustawione przez
       * API, czyli przygotowanie; zachowanie pod proba jest dalej w
       * przegladarce.
       */
      const savedQuantity = 37;
      const patched = await page.request.patch(`${BASE}/api/m/procurement/items/${item.id}`, {
        data: {
          quantity: savedQuantity,
          expectedVersion: item.version,
          operationId: `z11-przygotowanie-${item.id}-${Date.now()}`,
        },
      });
      expect(patched.status(), await patched.text()).toBe(200);
      await page.reload();
      await expect(form).toBeVisible({ timeout: 60_000 });
      record.pozycja = { id: item.id, nazwa: item.name, zapisanaIlosc: savedQuantity };

      // Typed and deliberately not saved.
      const quantity = form.locator('input[id^="qty-"]');
      await expect(quantity).toBeVisible();
      await quantity.fill('999');
      await quantity.blur();

      const asked = await run.command(
        page,
        `Patrzysz na formularz pozycji „${item.name}”. Podaj ZAPISANA ilosc tej pozycji ` +
          '(liczba i jednostka) i napisz, czy mam w tym formularzu cos niezapisanego. ' +
          'Nie zapisuj niczego.',
      );
      const phase = await settled(page, asked.runId);
      const events = await backend.runEvents(asked.runId);
      run.log.push({ cel: 'szkic a dane zapisane', runId: asked.runId, faza: phase, narzedzia: toolNames(events) });
      expect(phase).toBe('succeeded');

      // The draft reached the command's context, labelled as a draft and
      // without the typed value.
      const context = callsOf(events, 'get_context').at(-1);
      const drafts =
        (context?.result as { unsavedDrafts?: Array<Record<string, unknown>> } | undefined)?.unsavedDrafts ??
        (asked.context.drafts as Array<Record<string, unknown>>);
      record.szkicWKontekscie = drafts;
      expect(drafts.length, 'szkic nie trafil do kontekstu polecenia').toBeGreaterThan(0);
      expect(JSON.stringify(drafts), 'kontekst niosl wpisana wartosc jak dane').not.toContain('999');

      const said = await backend.assistantText(new URL(page.url()).searchParams.get('c')!);
      record.odpowiedz = said.slice(-1500);
      record.wpisanaWartoscWOdpowiedzi = said.includes('999');
      // Wartosc ZAPISANA, podana jako zapisana.
      expect(said, 'agent nie podal zapisanej ilosci').toContain(String(savedQuantity));
      // I szkic nazwany szkicem, a nie danymi.
      expect(said.toLowerCase()).toMatch(/niezapisan|szkic|nie zapisa|robocz/);

      // Nothing was saved behind the user's back.
      const after = await backend.json<{ offers: Array<{ items: Array<{ id: string; quantityMilli: number }> }> }>(
        `/api/m/procurement/cases/${caseId}`,
      );
      const itemAfter = after.offers.flatMap((o) => o.items).find((i) => i.id === item.id)!;
      /*
       * Porownanie z wartoscia PO przygotowaniu, nie z odczytem sprzed niego.
       * Baseline `item.quantityMilli` pochodzi sprzed patcha na 37, wiec
       * porownanie z nim oblewa nawet wtedy, gdy nic sie nie zmienilo — co
       * kosztowalo ture, mimo ze sama proba przeszla.
       */
      expect(itemAfter.quantityMilli).toBe(savedQuantity * 1000);
      record.wynik = 'zaliczona';
    } finally {
      run.save('d-szkic-a-dane.json', { ...record, wynik: record.wynik ?? 'niezaliczona' });
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  C — blad narzedzia przez rzeczywisty adapter (L5.8, L7.3)              */
  /* ---------------------------------------------------------------------- */

  test('blad narzedzia przechodzi przez adapter do rozmowy, z trescia argumentow', async ({ page }) => {
    const backend = new Backend(page, BASE);
    const record: Record<string, unknown> = { kryteria: ['L5.8', 'L7.3'] };
    try {
      await openApp(page, BASE);

      const failed = await run.command(
        page,
        'To jest KONTROLOWANA PROBA OBSLUGI BLEDOW na mojej instancji testowej — sprawdzam, ' +
          'czy blad narzedzia dociera do rozmowy czytelnie. BLAD jest wynikiem, ktorego oczekuje.\n' +
          'Wywolaj narzedzie canvas_add_card z komponentem o nazwie doslownie „nie.istnieje” ' +
          'i tytulem „Karta z bledem”. Wiem, ze taki komponent nie istnieje i ze wywolanie sie ' +
          'nie powiedzie — o to chodzi. Wywolaj je dokladnie raz, nie poprawiaj nazwy komponentu ' +
          'i przepisz dokladny komunikat bledu, ktory dostales.',
      );
      const phase = await settled(page, failed.runId);
      const events = await backend.runEvents(failed.runId);
      run.log.push({ cel: 'blad narzedzia', runId: failed.runId, faza: phase, narzedzia: toolNames(events) });

      const attempts = callsOf(events, 'canvas_add_card');
      expect(attempts.length, `model nie wywolal narzedzia; wywolal: ${toolNames(events).join(', ')}`).toBeGreaterThan(0);
      const bad = attempts.find((c) => c.isError);
      /*
       * The hook under test. `PostToolUseFailure` is the one path the platform
       * had only ever simulated: a real adapter renaming it, or reporting the
       * reason in another field, would show up here as a tool result that is
       * not marked as an error or carries a bare "null".
       */
      expect(bad, `zadne wywolanie nie zostalo oznaczone jako blad: ${JSON.stringify(attempts.map((a) => a.rawResult))}`).toBeTruthy();
      expect(String(bad!.rawResult)).not.toBe('null');
      expect(String(bad!.rawResult)).toContain('nie.istnieje');
      // TOOL_CALL_ARGS carries what was actually asked for — the other half of
      // L5.8's gap, and the reason the arguments are read rather than the name.
      expect(JSON.stringify(bad!.args)).toContain('nie.istnieje');
      record.bladNarzedzia = { argumenty: bad!.args, wynik: String(bad!.rawResult).slice(0, 400) };

      // Visible to the user, not only in the log.
      await expect(page.locator('.pf-chat')).toContainText('nie.istnieje', { timeout: 30_000 });
      record.wynik = 'zaliczona';
    } finally {
      run.save('c-blad-narzedzia.json', { ...record, wynik: record.wynik ?? 'niezaliczona' });
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  C — Stop przez rzeczywisty adapter i proces SDK (L7.3, L1.6)           */
  /* ---------------------------------------------------------------------- */

  test('Stop konczy wykonanie modelu i nie zostawia procesow roboczych', async ({ page }) => {
    const backend = new Backend(page, BASE);
    const record: Record<string, unknown> = { kryteria: ['L7.3', 'L1.6'] };
    try {
      await openApp(page, BASE);
      const serverPid = instance.pid!;
      expect(serverPid, 'nie znam pid instancji produkcyjnej').toBeTruthy();
      const before = descendants(serverPid);

      const long = await run.command(page, LONG_COMMAND);
      const conversationId = new URL(page.url()).searchParams.get('c')!;
      const state = await working(page, long.runId);
      record.decyzjeZgody = state.decisions;
      record.fazaWChwiliDzialania = state.phase;
      /*
       * Warunek, a nie nadzieja: kryterium mowi o przerwaniu **w trakcie**
       * wykonania. Wykonanie, ktore juz sie skonczylo, nie moze o nim nic
       * powiedziec — i wlasnie na tym przepadly dwie tury.
       */
      expect(state.inFlight, `wykonanie juz sie zakonczylo (faza ${state.phase}) — nie bylo czego przerywac`).toBe(true);

      const during = descendants(serverPid);
      const started = during.filter((d) => !before.some((b) => b.pid === d.pid));
      record.procesyWTrakcie = {
        potomkowiePrzed: before.length,
        potomkowieWTrakcie: during.length,
        uruchomionePrzezWykonanie: started.map((w) => w.comm),
        robocze: workerProcesses(serverPid).map((w) => w.comm),
      };
      /*
       * Ile ich jest, **zapisujemy**; czego nie ma po Stopie, **asercjujemy**.
       *
       * Sonda bez modelu pokazala, ze sesja SDK sama z siebie nie zostawia
       * procesu potomnego. Wymaganie „w trakcie musi byc co najmniej jeden”
       * obleweloby wiec poprawne zachowanie platformy i wydaloby ture na moje
       * zalozenie o wnetrzu SDK. Kryterium mowi o tym, co zostaje PO
       * zatrzymaniu — i to jest asercja ponizej.
       */

      await page.getByTestId('run-stop').click();
      await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /cancelled|failed/, {
        timeout: 120_000,
      });

      // Nic, co to wykonanie uruchomilo, nie dziala dalej.
      await expect
        .poll(() => descendants(serverPid).filter((p) => started.some((s) => s.pid === p.pid)).length, {
          timeout: 120_000,
        })
        .toBe(0);
      await expect.poll(() => workerProcesses(serverPid).length, { timeout: 120_000 }).toBe(0);
      const after = descendants(serverPid);
      expect(after.length, `potomkowie przed ${before.length}, po ${after.length}`).toBeLessThanOrEqual(before.length);

      const record2 = (await backend.runs(conversationId)).find((r) => r.id === long.runId)!;
      expect(record2.status).toBe('cancelled');
      expect(record2.errorCode).toBe('cancelled');
      record.poZatrzymaniu = { status: record2.status, kod: record2.errorCode, potomkowie: after.length };

      // The interface says so, and the partial answer is not thrown away.
      await expect(page.locator('.pf-chat')).toContainText(/zatrzym|anulow|cancel/i, { timeout: 30_000 });
      record.wynik = 'zaliczona';
    } finally {
      run.save('c-stop.json', { ...record, wynik: record.wynik ?? 'niezaliczona' });
    }
  });

  /* ---------------------------------------------------------------------- */
  /*  C/D — sygnal w trakcie wykonania (L1.6)                                */
  /* ---------------------------------------------------------------------- */

  test('SIGTERM w trakcie wykonania nie zostawia procesow, a trwale dane wracaja', async ({ page }) => {
    const backend = new Backend(page, BASE);
    const record: Record<string, unknown> = { kryteria: ['L1.6'] };
    try {
      await openApp(page, BASE);
      const serverPid = instance.pid!;
      const before = descendants(serverPid);

      const long = await run.command(page, LONG_COMMAND);
      const conversationId = new URL(page.url()).searchParams.get('c')!;
      const state = await working(page, long.runId);
      record.decyzjeZgody = state.decisions;
      record.fazaWChwiliDzialania = state.phase;
      /*
       * Warunek, a nie nadzieja: kryterium mowi o przerwaniu **w trakcie**
       * wykonania. Wykonanie, ktore juz sie skonczylo, nie moze o nim nic
       * powiedziec — i wlasnie na tym przepadly dwie tury.
       */
      expect(state.inFlight, `wykonanie juz sie zakonczylo (faza ${state.phase}) — nie bylo czego przerywac`).toBe(true);

      const during = descendants(serverPid);
      const started = during.filter((d) => !before.some((b) => b.pid === d.pid));
      record.procesyWTrakcie = {
        potomkowiePrzed: before.length,
        potomkowieWTrakcie: during.length,
        uruchomionePrzezWykonanie: started.map((w) => w.comm),
        robocze: workerProcesses(serverPid).map((w) => w.comm),
      };

      /* The signal, with nothing behind it: no SIGKILL, so a shutdown that hung
       * would be visible rather than hidden — and its children would not be
       * orphaned by the test itself. */
      const outcome = await instance.stopWith('SIGTERM');
      record.zamkniecie = { zakonczony: outcome.exited, ms: outcome.ms, kod: outcome.code, sygnal: outcome.signal };
      expect(outcome.exited, `serwer nie zakonczyl sie po SIGTERM w ${outcome.ms} ms`).toBe(true);

      // Nothing of the model's is still running.
      await expect.poll(() => workerProcesses(serverPid).length, { timeout: 60_000 }).toBe(0);
      const leftovers = descendants(serverPid);
      expect(leftovers, `osierocone procesy po SIGTERM: ${JSON.stringify(leftovers)}`).toEqual([]);
      record.procesyPo = leftovers;

      /* The other half of L1.6: the durable data is still there. */
      await instance.start('-');
      await openApp(page, BASE);
      const runs = await backend.runs(conversationId);
      const interrupted = runs.find((r) => r.id === long.runId)!;
      expect(interrupted, 'uruchomienie nie przezylo restartu').toBeTruthy();
      // An interrupted run is marked as interrupted, not left looking alive.
      expect(['cancelled', 'failed']).toContain(interrupted.status);
      expect((await backend.messages(conversationId)).length).toBeGreaterThan(0);
      record.poRestarcie = { status: interrupted.status, kod: interrupted.errorCode };
      record.wynik = 'zaliczona';
    } finally {
      run.save('c-sygnal.json', { ...record, wynik: record.wynik ?? 'niezaliczona' });
    }
  });
});
