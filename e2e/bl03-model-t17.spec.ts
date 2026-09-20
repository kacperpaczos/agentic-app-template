import { expect, test } from './support/fixtures.ts';
import { Backend, openApp, settledDeciding, toolCalls, toolNames } from './support/bl03-checks.ts';
import { paidRun, paidSpecPreflight } from './support/bl03-model.ts';

/**
 * Pytania bramki z dopiskiem, O JAKIE narzedzie pytano.
 *
 * Zdarzenia wlasne sa w kopercie `{name: 'CUSTOM', payload: {name: 'platform.…',
 * ...wartosc}}` — stad dwochypoziomowy filtr: nazwa zdarzenia siedzi w
 * `payload.name`, a narzedzie w `payload.toolName`.
 */
const pytaniaO = (events: Array<Record<string, any>>): Array<{ tool: string; input: unknown }> =>
  events
    .filter((e) => e.name === 'CUSTOM' && e.payload?.name === 'platform.permission_request')
    .map((e) => {
      const value = (e.payload?.value ?? {}) as { toolName?: unknown; input?: unknown };
      return {
        tool: String(value.toolName ?? ''),
        input: value.input ?? null,
      };
    });

/**
 * Przebieg T17 (grupa G2) — jedna tura: kolejnosc mechanizmow SDK. Rodzaj
 * dowodu: **rzeczywisty model**.
 *
 * Kryterium, ktore ten spec MOZE domknac: **L11.12** — kolejnosc, w jakiej
 * prawdziwy SDK rozstrzyga dostep do narzedzi: nazwa w `allowedTools`
 * (Write/Read — pre-zatwierdzone) wykonuje sie **bez pytania bramki**, narzedzie
 * spoza listy (Bash) **trafia do bramki** (`canUseTool`). To zachowanie cudzego
 * kodu, nie mozna go pokazac lektura ani stand-inem, ktory dostaje te same
 * `sdkOptions` — trzeba obejrzec prawdziwa sesje.
 *
 * Obserwacje zapisywane przy okazji (bez osobnych tur), z otwartych pytan
 * recenzji:
 *  - „odmawia czy pyta": ile pytan o zgode wygenerowala kazda klasa narzedzi;
 *  - `updatedInput` (Z7): hook przepisuje sciezke narzedzia plikowego na
 *    rozwiazana; wynik `Read` raportuje `filePath` — zgadza-li sie z zadana
 *    sciezka, mowi o tym, czy CLI honouruje przepisane wejscie.
 *
 * Kryteria, ktore pozostaja otwarte NIEZALEZNIE od wyniku: tresc decyzji
 * uzytkownika dla Bash jest tu **Odmowa** — kryterium L11.9 (brak skutku po
 * odmowie / wykonanie dokladnie raz po zgodzie) jest probowane gdzie indziej i
 * ten spec go nie dotyka. Klasyfikator auto-zatwierdzajacy czesc polecen powloki
 * (druga polowa L11.12) nie jest tu probowany: Bash celuje w bramke i tyle.
 *
 * Dyscyplina: polecenie bez slownika werdyktow; rejestry przed asercjami.
 *
 * Koszt: 1 tura.
 */

const FILE = 'bl03-model-t17.spec.ts';
const preflight = paidSpecPreflight(FILE);
const AGENT_TIMEOUT = 420_000;

test.describe('BL-03 przebieg T17: kolejnosc allowedTools vs canUseTool na prawdziwym SDK', () => {
  test.describe.configure({ mode: 'serial', timeout: AGENT_TIMEOUT });
  test.skip(!preflight.ok, preflight.skipReason ?? '');

  test('Write i Read bez pytania, Bash przez bramke — kolejnosc z observed', async ({ page }) => {
    const run = paidRun({ file: FILE, przebieg: 'T17' });
    const backend = new Backend(page);
    const record: Record<string, unknown> = { kryteria: ['L11.12'] };

    try {
      await openApp(page, '');

      const t17 = await run.command(
        page,
        'Trzy rzeczy w tym uruchomieniu, po kolei:\n' +
          `1) zapisz narzedziem Write plik output/notatka-g2.txt z trescia PROBA-G2,\n` +
          `2) przeczytaj narzedziem Read wlasnie zapisany plik,\n` +
          `3) wykonaj w powloce (narzedzie Bash) polecenie: echo PROBA-G2\n` +
          'Na koniec napisz krotkie podsumowanie, co sie udalo.',
      );
      const conversationId = new URL(page.url()).searchParams.get('c')!;

      /*
       * Decyzja na pytanie o powloke jest celowo **Odmowa**: kryterium mowi o
       * KOLEJNOSCI (co pyta bramke, co nie pyta), nie o skutku polecenia powloki.
       */
      const outcome = await settledDeciding(page, t17.runId, () => 'Odmowa');
      const events = await backend.runEvents(t17.runId);
      const calls = toolCalls(events);

      /* --------------------- rejestry przed asercjami --------------------- */

      const wpisy = calls.filter((c) => c.name.replace(/^mcp__app__/, '') === 'Write');
      const odczyty = calls.filter((c) => c.name.replace(/^mcp__app__/, '') === 'Read');
      const shelle = calls.filter((c) => c.name.replace(/^mcp__app__/, '') === 'Bash');
      const pytania = pytaniaO(events);
      const pytaniaOFile = pytania.filter((p) => /^(Write|Read|Edit|Glob|Grep)$/.test(p.tool));
      const pytaniaOBash = pytania.filter((p) => p.tool === 'Bash');
      const rozstrzygniecia = events.filter((e) => e.name === 'platform.permission_resolved').length;

      const obserwacjaZ7 = odczyty.map((c) => {
        const zadana = String((c.args as { file_path?: string } | null)?.file_path ?? '');
        const raportowana = String((c.result as { file?: { filePath?: string } } | null)?.file?.filePath ?? '');
        return { zadana, raportowana, zgodne: raportowana === '' ? 'brak raportu' : raportowana === zadana };
      });

      record.narzedzia = toolNames(events);
      record.wywolania = {
        Write: wpisy.map((c) => ({ argumenty: c.args, blad: c.isError, tresc: String(c.rawResult ?? '').slice(0, 200) })),
        Read: odczyty.map((c) => ({ argumenty: c.args, blad: c.isError, tresc: String(c.rawResult ?? '').slice(0, 200) })),
        Bash: shelle.map((c) => ({ argumenty: c.args, blad: c.isError, tresc: String(c.rawResult ?? '').slice(0, 200) })),
      };
      record.bramka = {
        liczbaPytan: outcome.decisions.length,
        tresciPytan: outcome.decisions.map((d) => `${d.decision}: ${d.text.slice(0, 160)}`),
        pytaniaONarzedzia: pytania,
        zdarzeniaResolved: rozstrzygniecia,
      };
      record.obserwacjaUpdatedInput = obserwacjaZ7;
      record.odpowiedz = (await backend.assistantText(conversationId)).slice(0, 800);

      /* ------------------------------- asercje ------------------------------- */

      /* Proba naprawde zaszla po wszystkich trzech drogach. */
      expect(wpisy.length, 'model nie wywolal Write').toBeGreaterThan(0);
      expect(odczyty.length, 'model nie wywolal Read').toBeGreaterThan(0);
      expect(shelle.length, 'model nie probowal powloki — brak danych o drugiej polowie kolejnosci').toBeGreaterThan(0);

      /* Pre-zatwierdzone: wykonane i bez zadnego pytania. */
      for (const c of [...wpisy, ...odczyty]) {
        expect(c.isError, `${c.name} zakonczylo sie bledem: ${String(c.rawResult).slice(0, 200)}`).toBe(false);
      }
      /*
       * Sedno L11.12: o narzedzia z allowedTools bramka **nie zostala zapytana
       * ani razu** — a o powloke zostala. Jednoczesnie w jednym uruchomieniu,
       * jedna lista, jedna bramka: to jest wlasnie kolejnosc rozstrzygania.
       */
      expect(
        pytaniaOFile.length,
        `bramka zostala zapytana o narzedzia plikowe: ${JSON.stringify(pytaniaOFile)}`,
      ).toBe(0);
      expect(pytaniaOBash.length, 'brak zdarzenia pytania o powloke, choc Bash poszedl do bramki').toBeGreaterThan(0);

      /* Poza lista: bramka pytala, i to o powloke. */
      expect(outcome.decisions.length, 'bramka nie pytala o powloke — canUseTool nie zostal skonsultowany').toBeGreaterThan(0);
      expect(
        outcome.decisions.some((d) => /bash/i.test(d.text)),
        `pytanie bramki nie wymienia powloki: ${JSON.stringify(outcome.decisions.map((d) => d.text.slice(0, 120)))}`,
      ).toBe(true);
      expect(pytania.length, 'zdarzenia permissionRequest rozjechaly sie z pytaniami bramki').toBe(outcome.decisions.length);
      expect(rozstrzygniecia, 'brak zdarzen permissionResolved przy odpowiadaniu na pytania').toBe(outcome.decisions.length);
      record.wynik = 'zaliczona';
    } finally {
      run.save('t17-kolejnosc-bramek.json', { ...record, wynik: record.wynik ?? 'niezaliczona' });
    }
  });
});
