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
  it('widzi otwarty plik w katalogu i przestaje go widziec po zamknieciu', () => {
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
      const answer = directoryInUse(instance.config.dataDir);
      if (answer === null) return; // system bez /proc — sprawdzenie mowi „nie wiadomo"
      expect(answer).toBe(true);
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
