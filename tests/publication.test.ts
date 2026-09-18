import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError, type ToolCallContext } from '@platform/contracts';
import {
  collectToolEntries,
  createRunWorkspace,
  executeTool,
  platformTools,
  removeManagedFile,
  removeManagedTree,
  sha256,
} from '@platform/server';
import { createHarness, login, type Harness } from './helpers.ts';
import { dispatchingAgent, newStandInHandle, type Plan, type Step } from './support/model-standin.ts';

/**
 * Publishing a result out of the sandbox: atomically, durably, and never as a
 * finished thing when it is not one.
 *
 * Three separable claims, and the failure paths are the point of each:
 *
 *  1. a published file **outlives the workspace** — the run's scratch directory
 *     is gone by the time anyone downloads, and the bytes are still the bytes;
 *  2. publication is **one step**: the file, its row and the artifact that
 *     points at them either all exist or none of them does;
 *  3. a run that is broken off **publishes nothing**, rather than leaving a
 *     partial result looking complete.
 *
 * **Simulation, and marked as such** for the parts that go through a run: the
 * model is a stand-in at the adapter boundary, writing into the workspace the
 * way sandboxed code would and calling the real tool handlers. The filesystem,
 * the transaction, the HTTP download and the cleanup are all real.
 */

let h: Harness;
let plans: Map<string, Plan>;
const pending: Array<Promise<unknown>> = [];
let promptSeq = 0;

const EMPTY_CONTEXT = {
  conversationId: null as string | null,
  spaceId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: [],
  ui: null,
};

async function startRun(conversationId: string, script: Step[]) {
  promptSeq += 1;
  const prompt = `polecenie publikacji ${promptSeq}`;
  const handle = newStandInHandle();
  plans.set(prompt, { script, handle });
  const started = await h.platform.runtime.start({
    ownerId: h.ownerId,
    conversationId,
    prompt,
    appContext: { ...EMPTY_CONTEXT, conversationId },
  });
  const reader = (async () => {
    for await (const _ of started.stream.read(0)) {
      /* drained so the stream is consumed as a client would */
    }
  })();
  pending.push(started.done.catch(() => undefined), reader);
  return {
    stand: handle,
    runId: started.runId,
    done: started.done,
    workspaceDir: resolve(h.platform.config.workspacesDir, started.runId),
    run: () => h.platform.services.runs.get(started.runId, h.ownerId),
  };
}

const conversation = (title = 'Publikacja') =>
  h.platform.services.conversations.create({ ownerId: h.ownerId, title }).id;

const filesOnDisk = () =>
  existsSync(h.platform.config.filesDir) ? readdirSync(h.platform.config.filesDir).sort() : [];

const rowCount = (table: string) =>
  (h.platform.db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const waitUntil = async (predicate: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('warunek nie zaszedl w czasie');
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeEach(async () => {
  plans = new Map();
  h = await createHarness({
    withModule: false,
    modelAgent: dispatchingAgent(plans, () =>
      collectToolEntries({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
      }),
    ),
  });
});
afterEach(async () => {
  h.platform.services.runs.abortAll('koniec_testu');
  await Promise.allSettled(pending.splice(0));
  h.dispose();
});

/* ---------------------- durable past the cleanup -------------------------- */

describe('wynik przezywa sprzatniecie workspace', () => {
  it('artefakt opublikowany z output/ jest pobieralny, gdy workspace juz nie istnieje', async () => {
    const conv = conversation();
    const content = 'kolumna;wartosc\nrazem;5300\n';
    const started = await startRun(conv, [
      { kind: 'writeOutput', path: 'raport.csv', content },
      {
        kind: 'call',
        name: 'artifact_publish_file',
        input: { path: 'raport.csv', title: 'Raport z sandboxa' },
      },
      { kind: 'text', text: 'Opublikowalem raport.' },
    ]);
    await started.done;

    /*
     * The condition the previous proof left out: the scratch directory is
     * **gone** before anything is read back. A download that happened to work
     * while the workspace still existed would say nothing about durability.
     */
    expect(existsSync(started.workspaceDir), 'workspace nie zostal sprzatniety').toBe(false);

    const artifacts = h.platform.services.artifacts.list(h.ownerId, { conversationId: conv });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.rendererType).toBe('platform.file');
    expect(artifacts[0]!.runId).toBe(started.runId);

    const version = h.platform.services.artifacts.version(artifacts[0]!.id, h.ownerId);
    const fileId = version.fileId!;
    expect(fileId, 'artefakt nie wskazuje pliku').toBeTruthy();

    // Byte-for-byte, and by checksum — not merely "the request returned 200".
    const cookie = await login(h.platform.app, h.ownerId);
    const res = await h.platform.app.request(`/api/files/${fileId}/content`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const downloaded = Buffer.from(await res.arrayBuffer());
    expect(downloaded.toString('utf8')).toBe(content);
    expect(sha256(downloaded)).toBe(sha256(Buffer.from(content, 'utf8')));
    expect(sha256(downloaded)).toBe(h.platform.services.files.meta(fileId, h.ownerId).sha256);
  });

  it('cudzy wynik jest nie do pobrania i nie do zobaczenia jako artefakt', async () => {
    const conv = conversation();
    const started = await startRun(conv, [
      { kind: 'writeOutput', path: 'tajne.txt', content: 'tresc wlasciciela' },
      { kind: 'call', name: 'artifact_publish_file', input: { path: 'tajne.txt', title: 'Wynik' } },
    ]);
    await started.done;

    const artifact = h.platform.services.artifacts.list(h.ownerId, { conversationId: conv })[0]!;
    const fileId = h.platform.services.artifacts.version(artifact.id, h.ownerId).fileId!;

    const cookie = await login(h.platform.app, h.otherOwnerId);
    const file = await h.platform.app.request(`/api/files/${fileId}/content`, { headers: { cookie } });
    expect(file.status).toBe(403);
    const art = await h.platform.app.request(`/api/artifacts/${artifact.id}`, { headers: { cookie } });
    expect(art.status).toBe(403);
  });
});

/* ------------------------- one step, or none of it ------------------------ */

describe('publikacja jest niepodzielna', () => {
  /*
   * What this establishes, precisely — and what it does not.
   *
   * It shows that by the time anything could learn the file exists (the row is
   * not committed yet) the final name already carries **all** the bytes, and
   * that nothing temporary is left behind afterwards. A detection trial
   * confirmed the second half bites: replacing the rename with a direct write to
   * the final name fails this test — but on the leftover temporary file, not on
   * a truncated one.
   *
   * The property "the final name never exists half-written" is structural: the
   * final name comes into being only through `rename`, which is atomic within a
   * filesystem. Observing its absence would need a reader running *during* the
   * write, which no deterministic test can arrange here. Said out loud rather
   * than implied by a test name.
   */
  it('plik pod nazwa docelowa jest kompletny, a po zapisie nie zostaje nic tymczasowego', () => {
    const bytes = Buffer.from('x'.repeat(4096), 'utf8');
    let seenInsideTransaction: string | null = null;
    const { file } = h.platform.services.files.storeWith(
      { ownerId: h.ownerId, filename: 'duzy.txt', mediaType: 'text/plain', bytes },
      (stored) => {
        /*
         * Read from inside the transaction, which is the earliest moment any
         * other party could learn the file exists: the row is not committed yet
         * and the bytes are already all there. The rename is what guarantees
         * this — a direct write to the final name is visible while it is still
         * short.
         */
        const path = resolve(h.platform.config.filesDir, `${stored.id}.txt`);
        seenInsideTransaction = readFileSync(path).toString('utf8');
        return null;
      },
    );
    expect(seenInsideTransaction).toBe(bytes.toString('utf8'));
    // And nothing temporary is left behind.
    expect(filesOnDisk().filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(h.platform.services.files.meta(file.id, h.ownerId).byteSize).toBe(bytes.byteLength);
  });

  it('awaria drugiego kroku nie zostawia ani pliku, ani wiersza, ani artefaktu', async () => {
    const before = { files: filesOnDisk(), rows: rowCount('files'), artifacts: rowCount('artifacts') };

    /*
     * The failure is injected into the *second* half of the publication, which
     * is exactly where the old two-call version came apart: the bytes were
     * already stored and the row already inserted when the artifact failed.
     */
    const artifacts = h.platform.services.artifacts;
    const original = artifacts.create.bind(artifacts);
    artifacts.create = () => {
      throw new AppError('internal', 'awaria zapisu artefaktu');
    };
    try {
      expect(() =>
        h.platform.services.files.storeWith(
          { ownerId: h.ownerId, filename: 'polowiczny.txt', mediaType: 'text/plain', bytes: Buffer.from('abc') },
          (stored) =>
            artifacts.create({
              ownerId: h.ownerId,
              kind: 'file',
              mode: 'snapshot',
              title: 'nie powstanie',
              rendererType: 'platform.file',
              content: { fileId: stored.id },
              fileId: stored.id,
            }),
        ),
      ).toThrowError(/awaria zapisu artefaktu/);
    } finally {
      artifacts.create = original;
    }

    expect(filesOnDisk(), 'osierocone bajty po nieudanej publikacji').toEqual(before.files);
    expect(rowCount('files')).toBe(before.rows);
    expect(rowCount('artifacts')).toBe(before.artifacts);
  });

  it('nowa wersja pliku i jej artefakt powstaja razem', async () => {
    const conv = conversation();
    const originalBytes = Buffer.from('nazwa;ilosc\nkrzeslo;10\n', 'utf8');
    const original = h.platform.services.files.store({
      ownerId: h.ownerId,
      filename: 'dane.csv',
      mediaType: 'text/csv',
      bytes: originalBytes,
    });

    const producedText = 'nazwa;ilosc\nkrzeslo;10\nrazem;10\n';
    const started = await startRun(conv, [
      { kind: 'writeOutput', path: 'dane-poprawione.csv', content: producedText },
      {
        kind: 'call',
        name: 'files_publish_version',
        input: { path: 'dane-poprawione.csv', originalFileId: original.id },
      },
    ]);
    await started.done;

    const versions = h.platform.services.files.versionsOf(original.id, h.ownerId);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(2);

    /*
     * The half that was missing: a produced version used to be a row in `files`
     * and nothing else, so the conversation's artifact tab showed nothing at
     * all. It is an artifact of this conversation and of this run.
     */
    const artifacts = h.platform.services.artifacts.list(h.ownerId, { conversationId: conv });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.rendererType).toBe('platform.file');
    expect(artifacts[0]!.runId).toBe(started.runId);
    expect(h.platform.services.artifacts.version(artifacts[0]!.id, h.ownerId).fileId).toBe(versions[0]!.id);

    // The original is untouched, which is the other half of the same promise.
    const reread = h.platform.services.files.read(original.id, h.ownerId);
    expect(Buffer.compare(reread.bytes, originalBytes)).toBe(0);
    expect(reread.meta.sha256).toBe(original.sha256);
  });

  it('artefakt i jego plik sa dostepne po restarcie procesu', async () => {
    const conv = conversation();
    const started = await startRun(conv, [
      { kind: 'writeOutput', path: 'wynik.txt', content: 'trwala tresc' },
      { kind: 'call', name: 'artifact_publish_file', input: { path: 'wynik.txt', title: 'Trwaly wynik' } },
    ]);
    await started.done;
    const artifactId = h.platform.services.artifacts.list(h.ownerId, { conversationId: conv })[0]!.id;
    const fileId = h.platform.services.artifacts.version(artifactId, h.ownerId).fileId!;

    // A restart: the same data directory, a new process-level platform.
    const { createPlatform } = await import('@platform/server');
    const restarted = createPlatform({
      modules: [],
      env: { ...process.env, APP_DATA_DIR: h.dataDir },
    });
    try {
      const meta = restarted.services.artifacts.meta(artifactId, h.ownerId);
      expect(meta.rendererType).toBe('platform.file');
      const content = restarted.services.files.read(fileId, h.ownerId);
      expect(content.bytes.toString('utf8')).toBe('trwala tresc');
    } finally {
      restarted.close();
    }
  });
});

/* --------------------- a broken run publishes nothing --------------------- */

describe('zerwane zadanie nie publikuje niekompletnego wyniku', () => {
  it('zatrzymanie po zapisie do output/, a przed publikacja, nie zostawia ani pliku, ani artefaktu', async () => {
    const conv = conversation();
    const before = { files: filesOnDisk(), rows: rowCount('files'), artifacts: rowCount('artifacts') };

    const started = await startRun(conv, [
      { kind: 'writeOutput', path: 'niedokonczony.txt', content: 'polowa wyniku' },
      // The run is still working on the result when the user presses Stop.
      { kind: 'wait', ms: 10_000 },
      { kind: 'call', name: 'artifact_publish_file', input: { path: 'niedokonczony.txt', title: 'Nie powinno powstac' } },
    ]);
    await waitUntil(() => existsSync(resolve(started.workspaceDir, 'output', 'niedokonczony.txt')));

    expect(h.platform.services.runs.cancel(started.runId, h.ownerId).cancelled).toBe(true);
    await started.done;

    expect(started.run().status).toBe('cancelled');
    expect(started.stand.performed, 'publikacja wykonala sie mimo zatrzymania').toEqual([]);
    expect(rowCount('files'), 'anulowane zadanie opublikowalo plik').toBe(before.rows);
    expect(rowCount('artifacts'), 'anulowane zadanie opublikowalo artefakt').toBe(before.artifacts);
    expect(filesOnDisk()).toEqual(before.files);
    // And the partial work went with the workspace.
    expect(existsSync(started.workspaceDir)).toBe(false);
  });

  it('publikacja pliku, ktorego w output/ nie ma, jest odmowa z lista dostepnych', async () => {
    const workspace = createRunWorkspace(h.platform.config.workspacesDir, 'run_brak_pliku');
    try {
      writeFileSync(resolve(workspace.outputDir, 'jest.txt'), 'x');
      const entry = collectToolEntries({
        registry: h.platform.registry,
        platformTools: platformTools(h.platform.services),
      }).find((t) => t.localName === 'artifact_publish_file')!;
      const ctx: ToolCallContext = {
        ownerId: h.ownerId,
        appContext: { ...EMPTY_CONTEXT },
        conversationId: conversation(),
        runId: 'run_brak_pliku',
        workspaceDir: workspace.dir,
        emit: () => {},
        requestUi: async () => ({ commandId: 'x', executed: false }),
      };
      await expect(
        executeTool(entry, { path: 'nie-ma.txt', title: 'Nic' }, ctx),
      ).rejects.toThrowError(/Brak pliku/);
      expect(rowCount('artifacts')).toBe(0);
    } finally {
      workspace.dispose();
    }
  });
});

/* ------------------ the guard on destructive operations ------------------- */

describe('operacje kasujace sprawdzaja sciezke w chwili wykonania', () => {
  it('odmawia usuniecia czegokolwiek spoza zadeklarowanego katalogu', () => {
    const outside = resolve(h.dataDir, 'nie-magazyn.txt');
    writeFileSync(outside, 'nie do skasowania');
    const root = { root: h.platform.config.filesDir, what: 'magazynu plikow' };

    expect(() => removeManagedFile(outside, root)).toThrowError(/poza katalogiem/);
    expect(() => removeManagedFile(resolve(h.platform.config.filesDir, '../app.db'), root)).toThrowError(
      /poza katalogiem/,
    );
    // The root itself is not a smaller version of a file inside it.
    expect(() => removeManagedTree(h.platform.config.filesDir, root)).toThrowError(/poza katalogiem/);
    expect(existsSync(outside), 'plik poza katalogiem zostal skasowany').toBe(true);
  });

  it('usuniecie pliku z magazynu dziala i nie rusza sasiadow', () => {
    const keep = h.platform.services.files.store({
      ownerId: h.ownerId, filename: 'zostaje.txt', mediaType: 'text/plain', bytes: Buffer.from('a'),
    });
    const drop = h.platform.services.files.store({
      ownerId: h.ownerId, filename: 'znika.txt', mediaType: 'text/plain', bytes: Buffer.from('b'),
    });
    h.platform.services.files.delete(drop.id, h.ownerId);
    expect(existsSync(resolve(h.platform.config.filesDir, `${drop.id}.txt`))).toBe(false);
    expect(existsSync(resolve(h.platform.config.filesDir, `${keep.id}.txt`))).toBe(true);
    expect(h.platform.services.files.meta(keep.id, h.ownerId).id).toBe(keep.id);
  });
});
