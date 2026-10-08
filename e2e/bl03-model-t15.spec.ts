import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from './support/fixtures.ts';
import { ScriptedInstance } from './support/scripted.ts';
import {
  Backend,
  callsOf,
  customEvents,
  descendants,
  openApp,
  settled,
  settledDeciding,
  stillRunning,
  toolNames,
  working,
  workerProcesses,
} from './support/bl03-checks.ts';
import { paidRun, paidSpecPreflight } from './support/bl03-model.ts';
import { claudeConfigDir } from '@platform/server';

/**
 * Przebieg T15 (grupy D+E) — jedna rozmowa: blad narzedzia → Stop → sygnal →
 * wznowienie. Rodzaj dowodu: **rzeczywisty model**, przez proces Claude Agent
 * SDK, na wlasnej instancji produkcyjnego buildu.
 *
 * Kryteria, ktore ten spec MOZE domknac:
 *  - **L11.7** — Stop konczy proces potomny SDK i polecenia powloki uruchomione
 *    w sandboxie (tura 2: potomek powloki zyje w trakcie, po Stop — zero, po
 *    tozsamosci pid + czas startu);
 *  - **L1.6** — sygnal w trakcie realnego wykonania nie zostawia procesow
 *    roboczych (tura 3), a trwale dane wracaja po restarcie;
 *  - **L7.13** — ktora z dwoch reakcji daje faktyczny brak transkryptu (odmowa
 *    wznowienia vs cicha nowa sesja). Przed tura 4 transkrypt wlasnie TEJ sesji
 *    (plik `<claudeSessionId>.jsonl` w katalogu projektow CLI) jest usuwany —
 *    chirurgia wlasnego zasobu testowego, po scislej nazwie pliku, nigdy po
 *    prefiksie; katalog poswiadczen nie jest dotykany.
 *
 * Kryteria, ktore pozostaja otwarte NIEZALEZNIE od wyniku: **L5.8** i **L7.3**
 * moga byc co najwyzej WSPARTE krokami tego przebiegu (blad narzedzia, Stop) —
 * sa kryteriami pakietu i ich pelny dowod zyje w `bl03-model-lifecycle.spec.ts`;
 * ten spec ich nie deklaruje. **L8.5** (wznowienie pelne) nie jest twierdzone:
 * tura 4 celowo niszczy transkrypt, wiec testuje brak transkryptu, a nie
 * wznowienie.
 *
 * Dyscyplina: polecenia bez slownika werdyktow; rejestry przed asercjami; kazdy
 * test zapisuje wlasny dowod w `finally`.
 *
 * Koszt: 4 tury (jedna rozmowa, cztery polecenia; Stop i sygnal to akcje
 * interfejsu/systemu, nie tury).
 *
 * Warunek uruchomienia: licznik tur NIE przenosi sie z merge'em —
 * `readZ11Ledger` bez pliku `.e2e-model-turns/z11-bl03.json` startuje od zera.
 * Uruchamiac w kopii z prawdziwym rejestrem albo zasic go przed przebiegiem.
 */

const FILE = 'bl03-model-t15.spec.ts';
const AGENT_TIMEOUT = 420_000;

const instance = new ScriptedInstance({
  port: 8795,
  dataDirName: '.e2e-real-t15',
  entry: 'production',
  logFile: 'docs/evidence/z11-bl03/serwer-produkcyjny-t15.log',
});
const BASE = instance.baseUrl;

const run = paidRun({ file: FILE, przebieg: 'T15' });

const dla = (tur: number) => paidSpecPreflight(FILE, tur);

/** Wspolny stan jednej rozmowy przenoszony przez testy (i przez restart serwera). */
let conversationId: string | null = null;

/** Praca, ktora naprawde trwa — tury 19/20 pokazaly, ze taka tura ma procesy `claude` i `socat`. */
const LONG_COMMAND =
  'Wypisz po kolei liczby od 1 do 150. Kazda w osobnej linii, a przy kazdej dopisz ' +
  'jedno krotkie zdanie o tym, czy jest parzysta i czy jest podzielna przez trzy. ' +
  'Nie skracaj, nie streszczaj i nie uzywaj zadnych narzedzi — wypisz wszystkie.';

/** Transkrypt WLASNEJ sesji testowej: dokladna nazwa pliku, zadnych prefiksow. */
const znajdzTranskrypt = (sessionId: string): string | null => {
  const projects = join(claudeConfigDir(process.env as NodeJS.ProcessEnv), 'projects');
  if (!existsSync(projects)) return null;
  const szukany = `${sessionId}.jsonl`;
  const stos: string[] = [projects];
  while (stos.length > 0) {
    const dir = stos.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const pelna = resolve(dir, entry.name);
      if (entry.isDirectory()) stos.push(pelna);
      else if (entry.name === szukany) return pelna;
    }
  }
  return null;
};

test.describe('BL-03 przebieg T15: blad narzedzia, Stop, sygnal, wznowienie po utracie transkryptu', () => {
  test.describe.configure({ mode: 'serial', timeout: AGENT_TIMEOUT });

  test.beforeAll(async () => {
    instance.prepareDatabase();
    await instance.start('-');
  });
  test.afterAll(async () => {
    await instance.stop();
  });

  test('tura 1: blad narzedzia i zasadzenie kodu do pamieci rozmowy', async ({ page }) => {
    test.skip(!dla(4).ok, dla(4).skipReason ?? '');
    const backend = new Backend(page, BASE);
    const record: Record<string, unknown> = { kryteria: ['przygotowanie: blad narzedzia + kod do pamieci'] };
    try {
      await openApp(page, BASE);
      /*
       * Tozsamosc rozmowy czytana PO pierwszym poleceniu, nie przed: swieza
       * instancja nie ma zadnej rozmowy, a aplikacja tworzy i wybiera ja
       * przy pierwszym poleceniu (proba 2026-09-20T17-06-16-992Z: asercja
       * przed poleceniem obla na otwarciu, zero tur wydanych; wzorzec
       * zgodny z bl03-model-lifecycle.spec.ts). Polecenia kolejnych tur
       * tego samego pliku i wznowienie po restarcie opieraja sie na tej tozsamosci.
       */
      const first = await run.command(
        page,
        'To jest kontrolowana proba obslugi bledow narzedzia na mojej instancji testowej. ' +
          'Wywolaj narzedzie canvas_add_card z komponentem o nazwie doslownie „nie.istnieje” ' +
          'i tytulem „Karta z bledem”. Wywolaj je dokladnie raz i nie poprawiaj nazwy komponentu. ' +
          'Nastepnie zapisz w pamieci tej rozmowy, ze kod operacji to T15-4721 — ' +
          'bede o niego pytal pozniej. Nie uzywaj powloki.',
      );
      const phase = await settled(page, first.runId);
      conversationId = new URL(page.url()).searchParams.get('c');
      expect(conversationId, 'rozmowa nie ma identyfikatora w adresie po pierwszym poleceniu').toBeTruthy();
      const events = await backend.runEvents(first.runId);
      record.runId = first.runId;
      record.faza = phase;
      record.rozmowa = conversationId;
      record.narzedzia = toolNames(events);

      const attempts = callsOf(events, 'canvas_add_card');
      record.probaBledu = attempts.map((a) => ({ argumenty: a.args, wynik: String(a.rawResult ?? '').slice(0, 300) }));

      expect(attempts.length, `model nie wywolal narzedzia; wywolal: ${toolNames(events).join(', ')}`).toBeGreaterThan(0);
      const bad = attempts.find((c) => c.isError);
      expect(
        bad,
        `zadne wywolanie nie zostalo oznaczone jako blad: ${JSON.stringify(attempts.map((a) => a.rawResult))}`,
      ).toBeTruthy();
      expect(JSON.stringify(bad!.args)).toContain('nie.istnieje');
      record.wynik = 'zaliczona';
    } finally {
      run.save('t15-t1-blad-narzedzia.json', { ...record, wynik: record.wynik ?? 'niezaliczona' });
    }
  });

  test('tura 2: Stop konczy potomka powloki — po tozsamosci pid + czas startu (L11.7)', async ({ page }) => {
    test.skip(!dla(4).ok, dla(4).skipReason ?? '');
    const backend = new Backend(page, BASE);
    const record: Record<string, unknown> = { kryteria: ['L11.7'] };
    try {
      await page.goto(`${BASE}/?c=${conversationId}`);
      const serverPid = instance.pid!;
      const before = descendants(serverPid);

      const long = await run.command(page, 'Uruchom w powloce polecenie: sleep 120. Czekaj na jego zakonczenie.');
      const state = await working(page, long.runId);
      record.decyzjeZgody = state.decisions;
      expect(state.inFlight, `wykonanie juz sie zakonczylo (faza ${state.phase}) — nie bylo czego zatrzymywac`).toBe(true);

      const during = descendants(serverPid);
      const started = during.filter((d) => !before.some((b) => b.pid === d.pid));
      record.procesyWTrakcie = started;
      record.robocze = workerProcesses(serverPid);
      expect(started.length, 'wykonanie nie uruchomilo zadnego procesu — nie ma czego sprawdzac po Stop').toBeGreaterThan(0);

      await page.getByTestId('run-stop').click();
      await expect(page.getByTestId('run-state')).toHaveAttribute('data-phase', /cancelled|failed/, {
        timeout: 120_000,
      });

      await expect.poll(() => stillRunning(started).length, { timeout: 120_000 }).toBe(0);
      const leftovers = stillRunning(started);
      record.procesyPo = leftovers;
      expect(leftovers, `procesy wykonania dzialaja po Stop: ${JSON.stringify(leftovers)}`).toEqual([]);

      const convId = conversationId!;
      const rec = (await backend.runs(convId)).find((r) => r.id === long.runId)!;
      expect(rec.status).toBe('cancelled');
      record.statusPo = rec.status;
      record.wynik = 'zaliczona';
    } finally {
      run.save('t15-t2-stop.json', { ...record, wynik: record.wynik ?? 'niezaliczona' });
    }
  });

  test('tura 3: SIGTERM w trakcie wykonania — zero osieroconych, dane wracaja; usuniecie transkryptu sesji (L1.6 + przygotowanie L7.13)', async ({
    page,
  }) => {
    test.skip(!dla(4).ok, dla(4).skipReason ?? '');
    const backend = new Backend(page, BASE);
    const record: Record<string, unknown> = { kryteria: ['L1.6', 'L7.13-przygotowanie'] };
    try {
      await page.goto(`${BASE}/?c=${conversationId}`);
      const serverPid = instance.pid!;
      const before = descendants(serverPid);

      const long = await run.command(page, LONG_COMMAND);
      const convId = conversationId!;
      const state = await working(page, long.runId);
      expect(state.inFlight, `wykonanie juz sie zakonczylo (faza ${state.phase}) — nie bylo czego przerywac sygnalem`).toBe(true);

      const during = descendants(serverPid);
      const started = during.filter((d) => !before.some((b) => b.pid === d.pid));
      record.procesyWTrakcie = started;
      expect(started.length, 'wykonanie nie uruchomilo zadnego procesu — nie ma czego sprawdzac po sygnale').toBeGreaterThan(0);

      const sesja = (await backend.runs(convId)).find((r) => r.claudeSessionId)?.claudeSessionId ?? null;
      record.claudeSessionId = sesja;
      expect(sesja, 'rozmowa nie powiazala zadnej sesji SDK — nie ma czego usuwac').toBeTruthy();

      /* Chirurgia L7.13: wlasny transkrypt testowy, po dokladnej nazwie pliku. */
      const transkrypt = znajdzTranskrypt(sesja!);
      const stanTranskryptu: Record<string, unknown> = {
        szukany: `${sesja}.jsonl`,
        znaleziony: transkrypt,
        usuniety: false,
      };
      if (transkrypt) {
        rmSync(transkrypt);
        stanTranskryptu['usuniety'] = true;
      }
      record.transkrypt = stanTranskryptu;

      const outcome = await instance.stopWith('SIGTERM');
      record.zamkniecie = { zakonczony: outcome.exited, ms: outcome.ms, sygnal: outcome.signal };
      expect(outcome.exited, `serwer nie zakonczyl sie po SIGTERM w ${outcome.ms} ms`).toBe(true);

      await expect.poll(() => stillRunning(started).length, { timeout: 120_000 }).toBe(0);
      const leftovers = stillRunning(started);
      record.procesyPo = leftovers;
      expect(leftovers, `osierocone procesy robocze po SIGTERM: ${JSON.stringify(leftovers)}`).toEqual([]);

      await instance.start('-');
      await openApp(page, BASE);
      await page.goto(`${BASE}/?c=${convId}`);
      const runs = await backend.runs(convId);
      const interrupted = runs.find((r) => r.id === long.runId)!;
      expect(interrupted, 'uruchomienie nie przezylo restartu').toBeTruthy();
      expect(['cancelled', 'failed']).toContain(interrupted.status);
      const messages = await backend.messages(convId);
      expect(messages.length, 'historia rozmowy zniknela po restarcie').toBeGreaterThan(0);
      record.poRestarcie = { status: interrupted.status, wiadomosci: messages.length };
      /*
       * Gwarancja probowania L7.13 (recenzja): tura 4 odpowiada na pytanie o
       * reakcje na BRAK transkryptu tylko wtedy, gdy transkrypt naprawde zniknal.
       * Gdyby pliku nie udalo sie znalezc (inny katalog konfiguracji CLI, porzadki
       * po stronie CLI), tura 3 konczy sie tutaj jawnie — z pomiarami L1.6 juz
       * wpisanymi w rekord — a tryb serial pomija ture 4, zamiast zaliczyc
       * zwykle wznowienie z calym transkryptem jako odpowiedz o braku transkryptu.
       */
      expect(
        stanTranskryptu['usuniety'],
        `transkrypt sesji ${sesja} nie zostal znaleziony ani usuniety — czwarta tura probowalaby zwykle wznowienie, nie reakcje na brak transkryptu (L7.13)`,
      ).toBe(true);
      record.wynik = 'zaliczona';
    } finally {
      run.save('t15-t3-sygnal.json', { ...record, wynik: record.wynik ?? 'niezaliczona' });
    }
  });

  test('tura 4: wznowienie po utracie transkryptu — ktora reakcja SDK (L7.13)', async ({ page }) => {
    test.skip(!dla(4).ok, dla(4).skipReason ?? '');
    const backend = new Backend(page, BASE);
    const record: Record<string, unknown> = { kryteria: ['L7.13'] };
    const convId = conversationId!;
    try {
      await page.goto(`${BASE}/?c=${convId}`);
      const przed = await backend.runs(convId);
      const sesjaPrzed = przed.find((r) => r.claudeSessionId)?.claudeSessionId ?? null;
      const wiadomosciPrzed = (await backend.messages(convId)).map((m) => m.id);

      const fourth = await run.command(
        page,
        'Jaki kod operacji zapisales w pamieci tej rozmowy na jej poczatku? Odpowiedz sama liczba.',
      );
      /* Pytania o zgode nie powinno byc; gdyby model ja wywolal, ta proba nie moze zawiesic tury. */
      const phase = (await settledDeciding(page, fourth.runId, () => 'Zgoda')).phase;
      const events4 = await backend.runEvents(fourth.runId);

      const said = await backend.assistantText(convId);
      const runsAfter = await backend.runs(convId);
      const sesjaPo = runsAfter.find((r) => r.id === fourth.runId)?.claudeSessionId ?? null;
      const wiadomosciPo = (await backend.messages(convId)).map((m) => m.id);

      /*
       * Rejestry PRZED asercjami. To, KTORA reakcja nastapila, jest wlasnie
       * odpowiedzia na pytanie L7.13 — obie sa poprawnymi wynikami proby:
       *  - `session_transcript_lost`: odmowa wznowienia (jawny komunikat);
       *  - `session_bound` z NOWYM identyfikatorem: cicha nowa sesja.
       */
      const utracone = customEvents(events4).filter((n) => n.includes('session_transcript_lost'));
      const wiazanie = customEvents(events4).filter((n) => n.includes('session_bound'));
      record.reakcjaSdk = {
        sessionTranscriptLost: utracone.length > 0,
        sessionBound: wiazanie.length > 0,
        sesjaPrzed,
        sesjaPo,
        sesjaZmieniona: sesjaPrzed !== null && sesjaPo !== null && sesjaPrzed !== sesjaPo,
        faza: phase,
        odpowiedz: said.slice(-600),
        zawieraKod: said.includes('4721'),
      };

      /* Asercja: platforma MUSI pokazac, ktora z dwoch reakcji zaszla. */
      expect(
        utracone.length > 0 || wiazanie.length > 0,
        'ani session_transcript_lost, ani session_bound nie trafilo do zdarzen — reakcja na brak transkryptu jest niewidoczna (L7.13)',
      ).toBe(true);
      /* Historia rozmowy pozostaje nietknieta i bez powielenia — niezaleznie od reakcji SDK. */
      expect(wiadomosciPo.length, 'historia skurczyla sie po czwartej turze').toBeGreaterThanOrEqual(wiadomosciPrzed.length);
      expect(
        wiadomosciPrzed.every((id) => wiadomosciPo.includes(id)),
        'stare wiadomosci zniknely po czwartej turze',
      ).toBe(true);
      expect(new Set(wiadomosciPo).size, 'powielone wiadomosci po czwartej turze').toBe(wiadomosciPo.length);
      record.wynik = 'zaliczona';
    } finally {
      run.save('t15-t4-wznowienie.json', { ...record, wynik: record.wynik ?? 'niezaliczona' });
    }
  });
});
