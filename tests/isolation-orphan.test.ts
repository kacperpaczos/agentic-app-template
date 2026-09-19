import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TEST_INSTANCE_LABEL,
  TEST_RUN_ID,
  assertInstanceLabel,
  readInstanceLabel,
  resolveTestInstance,
} from '../e2e/support/isolation.ts';
import { assertDirectoryFree, assertPortFree, directoryInUse, portInUse } from '../e2e/support/port-probe.ts';
import { ScriptedInstance } from '../e2e/support/scripted.ts';
import { descendants, stillRunning } from '../e2e/support/bl03-checks.ts';

/**
 * L1.9 — nothing is deleted while a process is still using it, and a survivor
 * of an earlier run cannot pass for this run's server.
 *
 * Test kontraktu lub logiki, against a real listening socket and a real
 * directory — no mocks. The two halves are separate defects with one story:
 *
 *  1. `prepareDatabase()` deleted the data directory and then started a server.
 *     Its comment said "nothing is running yet"; nothing checked. A scripted
 *     server orphaned by an interrupted run is exactly the case where the
 *     sentence is false — it holds the port and has that database open.
 *  2. The identity check that should have caught the survivor could not: every
 *     test instance carries the same label `agenticapp-test`, so the orphan
 *     answered correctly and the run continued against a deleted database.
 *
 * The refusal is a refusal, never a kill: this repository does not end
 * processes it did not start.
 */

const REPO = resolve(import.meta.dirname, '..');

let socket: Server | null = null;
let http: HttpServer | null = null;
const dirs: string[] = [];

afterEach(async () => {
  const s = socket;
  socket = null;
  if (s) await new Promise<void>((done) => s.close(() => done()));
  const h = http;
  http = null;
  if (h) await new Promise<void>((done) => h.close(() => done()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Occupies a port the way an orphaned server does: it just listens. */
async function occupy(port = 0): Promise<number> {
  const server = createServer(() => {});
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  socket = server;
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('brak portu');
  return address.port;
}

/** A stand-in `/api/health`, with the label and run id of an older run. */
async function healthAnswering(label: string | null, runId: string | null): Promise<string> {
  const server = createHttpServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, instanceLabel: label, instanceRunId: runId }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  http = server;
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('brak portu');
  return `http://127.0.0.1:${address.port}`;
}

describe('port zajety przez cudzy proces', () => {
  it('portInUse widzi nasluchujacy proces i nie widzi wolnego portu', async () => {
    const port = await occupy();
    expect(portInUse(port)).toBe(true);
    await new Promise<void>((done) => socket!.close(() => done()));
    socket = null;
    // The same port, now free: without this the check could be a constant.
    expect(portInUse(port)).toBe(false);
  });

  it('assertPortFree odmawia z powodem, zamiast zabijac proces', async () => {
    const port = await occupy();
    expect(() => assertPortFree(port, 'przygotowanie')).toThrow(/jest juz zajety/);
    expect(() => assertPortFree(port, 'przygotowanie')).toThrow(/Zatrzymaj TEN proces samodzielnie/);
    // And the process is still alive — the guard did not touch it.
    expect(socket!.listening).toBe(true);
  });

  it('prepareDatabase NIE kasuje katalogu, gdy port jest zajety', async () => {
    const instance = new ScriptedInstance({ port: 8798, dataDirName: '.e2e-scripted-sierota-test' });
    dirs.push(instance.config.dataDir);
    mkdirSync(instance.config.dataDir, { recursive: true });
    const marker = resolve(instance.config.dataDir, 'app.db');
    writeFileSync(marker, 'baza-otwarta-przez-osierocony-proces');

    await occupy(8798);

    expect(() => instance.prepareDatabase()).toThrow(/port 8798 jest juz zajety/);
    /*
     * The assertion the criterion is about: the refusal came *before* the
     * delete. A guard that refuses after `rmSync` protects nothing.
     */
    expect(existsSync(marker)).toBe(true);
  });

  it('kontrola: przy wolnym porcie prepareDatabase dochodzi do kasowania', async () => {
    /*
     * Without this, the test above would also pass on a `prepareDatabase` that
     * throws for any reason at all, or on one that never deletes anything.
     * Here the port is free, the guard lets it through, and the marker is gone.
     *
     * `migrate`/`seed` then run for real, which is what makes this a control
     * over the whole method rather than over its first line.
     */
    const instance = new ScriptedInstance({ port: 8797, dataDirName: '.e2e-scripted-sierota-ok' });
    dirs.push(instance.config.dataDir);
    mkdirSync(instance.config.dataDir, { recursive: true });
    const marker = resolve(instance.config.dataDir, 'znacznik.txt');
    writeFileSync(marker, 'do skasowania');

    instance.prepareDatabase();

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(resolve(instance.config.dataDir, 'app.db'))).toBe(true);
  }, 120_000);
});

describe('katalog otwarty przez dzialajacy proces', () => {
  /*
   * Pominiecie jest JAWNE. Wczesniej test wracal `return`, gdy nie bylo /proc,
   * czyli zaliczal sie po cichu na systemie, na ktorym niczego nie sprawdzil.
   */
  it.skipIf(!existsSync('/proc'))('widzi otwarty plik w katalogu i przestaje go widziec po zamknieciu', () => {
    /*
     * Port to nie cale pytanie: proces moze trzymac ten katalog, nasluchujac na
     * innym porcie niz ten, ktory przebieg zarezerwowal. Otwarty deskryptor tego
     * samego procesu wystarczy, zeby sprawdzenie bylo prawdziwe — i zeby dalo
     * sie pokazac obie odpowiedzi, nie tylko jedna.
     */
    const instance = new ScriptedInstance({ port: 8796, dataDirName: '.e2e-scripted-katalog-test' });
    dirs.push(instance.config.dataDir);
    mkdirSync(instance.config.dataDir, { recursive: true });
    const file = resolve(instance.config.dataDir, 'app.db');
    writeFileSync(file, 'x');

    const fd = openSync(file, 'r');
    try {
      expect(directoryInUse(instance.config.dataDir)).toBe(true);
      expect(() => assertDirectoryFree(instance.config.dataDir, 'przygotowanie')).toThrow(/otwarty przez/);
      expect(() => instance.prepareDatabase()).toThrow(/otwarty przez/);
      // Plik nadal jest — odmowa poprzedzila kasowanie.
      expect(existsSync(file)).toBe(true);
    } finally {
      closeSync(fd);
    }

    // Kontrola przeciwna: po zamknieciu ten sam katalog jest wolny.
    expect(directoryInUse(instance.config.dataDir)).toBe(false);
    expect(() => assertDirectoryFree(instance.config.dataDir, 'przygotowanie')).not.toThrow();
  });
});

describe('czytnik etykiety — ten sam serwer, w skonczonym czasie', () => {
  /*
   * `readInstanceLabel` obsluguje proxy trybu deweloperskiego i KAZDA suite
   * przegladarkowa, a poprawke (redirect: 'error' + termin) dostal bez testu.
   * Analiza kodu nie zamyka zachowania, wiec oto oba przypadki na prawdziwych
   * serwerach.
   */
  it('odpowiedz przez przekierowanie nie uchodzi za etykiete tej instancji', async () => {
    const labelled = await healthAnswering(TEST_INSTANCE_LABEL, TEST_RUN_ID);
    const redirector = createHttpServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', `${labelled}/api/health`);
      res.end();
    });
    await new Promise<void>((done) => redirector.listen(0, '127.0.0.1', done));
    const address = redirector.address();
    if (typeof address === 'string' || address === null) throw new Error('brak portu');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const answer = await readInstanceLabel(base);
      expect(answer, 'przekierowanie zostalo przyjete jako etykieta').toHaveProperty('unreachable');
      // I ta sama odmowa po stronie polityki suit.
      await expect(assertInstanceLabel(base, TEST_INSTANCE_LABEL, 'Instancja')).rejects.toThrow(
        /nie odpowiada na \/api\/health/,
      );
    } finally {
      await new Promise<void>((done) => redirector.close(() => done()));
    }
  });

  it('cel, ktory przyjmuje polaczenie i milczy, konczy sie odmowa, nie zawieszeniem', async () => {
    const silent = createHttpServer(() => {
      /* celowo bez odpowiedzi */
    });
    await new Promise<void>((done) => silent.listen(0, '127.0.0.1', done));
    const address = silent.address();
    if (typeof address === 'string' || address === null) throw new Error('brak portu');
    const started = Date.now();
    try {
      const answer = await readInstanceLabel(`http://127.0.0.1:${address.port}`);
      expect(answer).toHaveProperty('unreachable');
      // Termin jest w module 10 s; liczy sie to, ze przebieg w ogole wraca.
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      await new Promise<void>((done) => silent.close(() => done()));
    }
  }, 30_000);

  it('kontrola przeciwna: bezposrednia odpowiedz jest czytana', async () => {
    const base = await healthAnswering(TEST_INSTANCE_LABEL, TEST_RUN_ID);
    expect(await readInstanceLabel(base)).toEqual({ label: TEST_INSTANCE_LABEL, runId: TEST_RUN_ID });
  });
});

describe('tozsamosc przebiegu, nie tylko etykieta', () => {
  it('resolveTestInstance przekazuje identyfikator przebiegu serwerowi', () => {
    const cfg = resolveTestInstance({
      repoRoot: REPO,
      dataDirName: '.e2e-data',
      defaultPort: 8799,
      env: {},
    });
    expect(cfg.env.APP_INSTANCE_RUN_ID).toBe(TEST_RUN_ID);
    expect(TEST_RUN_ID).not.toBe('');
  });

  it('instancja z wlasciwa etykieta, ale z innego przebiegu, jest odrzucona', async () => {
    const base = await healthAnswering(TEST_INSTANCE_LABEL, 'przebieg-sprzed-tygodnia');
    // Without a run id the answer is accepted — that is the old behaviour and
    // the reason the survivor got through.
    await expect(assertInstanceLabel(base, TEST_INSTANCE_LABEL, 'Instancja')).resolves.toBeUndefined();
    // With one, it is not.
    await expect(
      assertInstanceLabel(base, TEST_INSTANCE_LABEL, 'Instancja', TEST_RUN_ID),
    ).rejects.toThrow(/Z INNEGO PRZEBIEGU/);
  });

  it('instancja tego samego przebiegu przechodzi', async () => {
    const base = await healthAnswering(TEST_INSTANCE_LABEL, TEST_RUN_ID);
    await expect(
      assertInstanceLabel(base, TEST_INSTANCE_LABEL, 'Instancja', TEST_RUN_ID),
    ).resolves.toBeUndefined();
    expect(await readInstanceLabel(base)).toEqual({ label: TEST_INSTANCE_LABEL, runId: TEST_RUN_ID });
  });

  it('stara instancja bez pola instanceRunId tez jest odrzucona', async () => {
    // A server from before this field existed answers `undefined`, which reads
    // as `null` — and `null` is not this run either.
    const base = await healthAnswering(TEST_INSTANCE_LABEL, null);
    await expect(
      assertInstanceLabel(base, TEST_INSTANCE_LABEL, 'Instancja', TEST_RUN_ID),
    ).rejects.toThrow(/instanceRunId=null/);
  });
});

/* -------------------------------------------------------------------------- */
/*  L1.6 — kontrola wycieku procesow roboczych, postawiona na probie          */
/* -------------------------------------------------------------------------- */

/**
 * Czy `stillRunning` POTRAFI oblac — i czy potrafi przejsc.
 *
 * Poprzednia kontrola wycieku pytala `descendants(serverPid)` **po** wyjsciu
 * serwera. Proces osierocony przez to wyjscie jest przepiety do init, wiec z
 * definicji przestaje byc potomkiem: lista wracala pusta niezaleznie od tego,
 * czy cokolwiek wyciekło. Kontrola, ktora nie potrafi oblac, jest dokladnie tym
 * defektem, ktory opis braku L1.6 nazywa — „regresja nie wykryje wycieku
 * procesow roboczych" — odtworzonym w kontroli majacej go lapac.
 *
 * Zastapila ja para **pid + czas startu**, chwytana PRZED sygnalem. Ten plik
 * stawia ja na probie bez zadnej tury modelu i bez przegladarki: prawdziwe
 * procesy systemu wystarczaja, zeby pokazac obie odpowiedzi.
 *
 *  1. proces, ktory przezyl sygnal, jest **znajdowany** (a stara kontrola nadal
 *     mowi „pusto", co jest tu zmierzone, nie zalozone);
 *  2. przy uporzadkowanym zamknieciu kontrola mowi „pusto" — inaczej byłaby
 *     stalą w druga strone;
 *  3. sam pid nie wystarcza: ten sam pid z innym czasem startu **nie** jest
 *     tym procesem, wiec ponownie uzyty numer nie uchodzi za wyciek.
 *
 * Sprzatanie idzie po pid, nigdy po nazwie, i nie dotyka niczego, czego ten
 * plik sam nie uruchomil.
 *
 * **Czego to NIE dowodzi.** Ze prawdziwy przebieg modelu nie zostawia procesow.
 * To jest zdanie o aplikacji i o SDK, nie o kontroli; domknie je dopiero tura
 * z `e2e/bl03-model-lifecycle.spec.ts`. Tutaj sprawdzany jest przyrzad.
 */
describe('kontrola wycieku procesow roboczych (L1.6) — przyrzad na probie', () => {
  const NA_LINUKSIE = existsSync('/proc');

  /** Zyje, dopoki go nie zabijemy; ignoruje SIGTERM, tak jak wyciek z opisu L1.6. */
  const UPARTY = "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);";
  /** Zwykly potomek, ktorego rodzic sprzata przy zamknieciu. */
  const ZWYKLY = 'setInterval(() => {}, 1000);';

  const spawnedPids: number[] = [];

  /** „Serwer": proces, ktory uruchamia jednego potomka i sam czeka. */
  const startParent = (childCode: string, tidy: boolean): ChildProcess => {
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');` +
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' });` +
          (tidy ? `process.on('SIGTERM', () => { child.kill('SIGKILL'); process.exit(0); });` : '') +
          `setInterval(() => {}, 1000);`,
      ],
      { stdio: 'ignore' },
    );
    if (parent.pid) spawnedPids.push(parent.pid);
    return parent;
  };

  const waitFor = async (predicate: () => boolean, ms = 10_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((done) => setTimeout(done, 50));
    }
    return predicate();
  };

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  afterEach(() => {
    // Wylacznie po pid i wylacznie to, co ten blok uruchomil.
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* zdazyl wyjsc sam */
      }
    }
  });

  it.skipIf(!NA_LINUKSIE)('ZNAJDUJE proces, ktory przezyl sygnal — stara kontrola nadal mowi „pusto"', async () => {
    const parent = startParent(UPARTY, false);
    const parentPid = parent.pid!;
    expect(await waitFor(() => descendants(parentPid).length > 0), 'scenariusz proby nie uruchomil potomka').toBe(true);

    // Tozsamosc chwytana PRZED sygnalem — na tym polega cala zmiana.
    const zapamietane = descendants(parentPid);
    expect(zapamietane.length).toBeGreaterThan(0);
    for (const p of zapamietane) spawnedPids.push(p.pid);

    process.kill(parentPid, 'SIGTERM');
    expect(await waitFor(() => !alive(parentPid)), 'rodzic nie zakonczyl sie po SIGTERM').toBe(true);

    /*
     * Zmierzone, nie zalozone: stara kontrola po wyjsciu rodzica odpowiada
     * „pusto" mimo wycieku. To jest powod wymiany, zapisany jako obserwacja.
     */
    expect(
      descendants(parentPid),
      'kontrola po potomstwie niespodziewanie cos zobaczyla — uzasadnienie wymiany wymaga sprawdzenia',
    ).toEqual([]);

    // A nowa go widzi. To jest zdolnosc do oblania.
    const wyciek = stillRunning(zapamietane);
    expect(wyciek.length, 'kontrola wycieku NIE wykryla procesu, ktory przezyl sygnal').toBeGreaterThan(0);
    expect(wyciek.map((p) => p.pid)).toEqual(zapamietane.map((p) => p.pid));
  });

  it.skipIf(!NA_LINUKSIE)('mowi „pusto", gdy zamkniecie posprzatalo po sobie', async () => {
    const parent = startParent(ZWYKLY, true);
    const parentPid = parent.pid!;
    expect(await waitFor(() => descendants(parentPid).length > 0), 'scenariusz proby nie uruchomil potomka').toBe(true);

    const zapamietane = descendants(parentPid);
    for (const p of zapamietane) spawnedPids.push(p.pid);

    process.kill(parentPid, 'SIGTERM');
    expect(await waitFor(() => !alive(parentPid)), 'rodzic nie zakonczyl sie po SIGTERM').toBe(true);

    /*
     * Kontrola w druga strone. Bez niej test powyzej zaliczylby takze
     * `stillRunning`, ktore zawsze zwraca cos — czyli kontrole tak samo
     * bezuzyteczna jak ta, ktora zastapila, tylko oblewajaca zamiast zaliczac.
     */
    expect(await waitFor(() => stillRunning(zapamietane).length === 0), 'potomek nie zostal sprzatniety').toBe(true);
    expect(stillRunning(zapamietane)).toEqual([]);
  });

  it.skipIf(!NA_LINUKSIE)('ten sam pid z innym czasem startu NIE jest tym procesem', async () => {
    /*
     * Pid sam w sobie nie jest tozsamoscia — numery sa ponownie uzywane, a
     * kontrola pytajaca „czy /proc/1234 istnieje" potrafi po minucie
     * odpowiedziec „tak" o zupelnie innym procesie i zglosic wyciek, ktorego
     * nie ma. Tu ten przypadek jest podstawiony wprost: ten sam, zyjacy pid z
     * cudzym czasem startu ma zostac odrzucony.
     */
    const parent = startParent(ZWYKLY, false);
    const parentPid = parent.pid!;
    expect(await waitFor(() => descendants(parentPid).length > 0)).toBe(true);
    const [potomek] = descendants(parentPid);
    spawnedPids.push(potomek!.pid);

    // Ten sam, zyjacy proces jest widziany…
    expect(stillRunning([potomek!]).map((p) => p.pid)).toEqual([potomek!.pid]);
    // …a ten sam pid podszyty innym czasem startu — nie.
    expect(
      stillRunning([{ ...potomek!, startTime: `${Number(potomek!.startTime) + 1}` }]),
      'kontrola uznala obcy proces za nasz tylko dlatego, ze ma ten sam pid',
    ).toEqual([]);
  });
});
