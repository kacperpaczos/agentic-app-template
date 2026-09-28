import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILE_ANALYSIS, AppError } from '@platform/contracts';
import { analysisToolkit, createRunWorkspace } from '@platform/server';
import { createHarness, login, type Harness } from './helpers.ts';

/**
 * Analysing an attached file — the parts that must be true regardless of what
 * the model says about the result.
 *
 * Three separable claims, tested separately:
 *
 *  1. the analysis library is genuinely reachable **from inside a run
 *     workspace**, by the same resolution a sandboxed script uses;
 *  2. a real multi-sheet workbook round-trips through it with sheets, cell
 *     types and formulas intact — and a formula arrives as a *formula plus a
 *     stored value*, never as a computed one;
 *  3. publishing a modified file creates a new version and leaves the original
 *     byte-for-byte unchanged.
 *
 * What is **not** claimed here: that the model draws the right conclusion. That
 * needs the model, and is covered by the browser suite.
 */

/*
 * `exceljs` belongs to `@platform/server`, so it is resolved from the package
 * that declares it and typed structurally here — the root tsconfig cannot
 * resolve `typeof import('exceljs')`, and only this handful of members is used.
 */
interface Cell {
  value: unknown;
}
interface Worksheet {
  name: string;
  addRow: (values: unknown[]) => unknown;
  getCell: (ref: string) => Cell;
}
interface Workbook {
  worksheets: Worksheet[];
  addWorksheet: (name: string) => Worksheet;
  getWorksheet: (name: string) => Worksheet | undefined;
  xlsx: {
    writeBuffer: () => Promise<ArrayBuffer>;
    load: (data: ArrayBuffer) => Promise<unknown>;
  };
}
interface ExcelJsModule {
  Workbook: new () => Workbook;
}

const require_ = createRequire(resolve(import.meta.dirname, '../packages/platform-server/package.json'));
const ExcelJS = require_('exceljs') as ExcelJsModule;
const XLSX_MEDIA = FILE_ANALYSIS.spreadsheet.mediaType;

let h: Harness;
beforeEach(async () => {
  h = await createHarness({ withModule: false });
});
afterEach(() => h.dispose());

/** A workbook with the shapes that actually occur: several sheets, mixed types, a formula. */
async function makeWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const prices = wb.addWorksheet('Ceny');
  prices.addRow(['Pozycja', 'Ilosc', 'Cena', 'Wartosc']);
  prices.addRow(['Krzeslo', 10, 250.5, { formula: 'B2*C2', result: 2505 }]);
  prices.addRow(['Stol', 2, 1200, { formula: 'B3*C3', result: 2400 }]);

  const meta = wb.addWorksheet('Metryka');
  meta.addRow(['Data', new Date('2026-01-15T00:00:00Z')]);
  meta.addRow(['Zatwierdzone', true]);
  meta.addRow(['Uwagi', null]);

  const empty = wb.addWorksheet('Pusty');
  empty.getCell('A1').value = null;

  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('biblioteka analizy jest osiagalna z workspace uruchomienia', () => {
  it('kod uruchomiony w katalogu workspace importuje exceljs', async () => {
    const workspace = createRunWorkspace(h.platform.config.workspacesDir, 'run_toolkit', analysisToolkit());
    try {
      expect(workspace.toolkit.map((t) => t.name)).toContain('exceljs');

      // The decisive check: resolution happens from the workspace, the way a
      // script the model writes there would resolve it. A library that is only
      // reachable from the server's own package is not available to the run.
      const script = resolve(workspace.dir, 'probe.mjs');
      writeFileSync(
        script,
        `import ExcelJS from 'exceljs';
         const wb = new ExcelJS.Workbook();
         wb.addWorksheet('T').addRow(['ok']);
         const buf = await wb.xlsx.writeBuffer();
         console.log(JSON.stringify({ bytes: buf.byteLength }));`,
      );
      const out = execFileSync(process.execPath, [script], { cwd: workspace.dir }).toString();
      expect(JSON.parse(out).bytes).toBeGreaterThan(0);
    } finally {
      workspace.dispose();
    }
  });

  it('workspace nie wystawia zaleznosci serwera sandboxowanemu kodowi', () => {
    const workspace = createRunWorkspace(h.platform.config.workspacesDir, 'run_scope', analysisToolkit());
    try {
      // The curated list is the boundary: the database driver and the agent SDK
      // must not be one `import` away from model-authored code.
      const script = resolve(workspace.dir, 'probe.mjs');
      writeFileSync(
        script,
        `let reached = [];
         for (const name of ['better-sqlite3', '@anthropic-ai/claude-agent-sdk', 'hono']) {
           try { await import(name); reached.push(name); } catch {}
         }
         console.log(JSON.stringify(reached));`,
      );
      const out = execFileSync(process.execPath, [script], { cwd: workspace.dir }).toString();
      expect(JSON.parse(out)).toEqual([]);
    } finally {
      workspace.dispose();
    }
  });
});

describe('odczyt skoroszytu obejmuje arkusze i typy komorek', () => {
  it('czyta wszystkie arkusze, a formule oddziela od zapisanej wartosci', async () => {
    const bytes = await makeWorkbook();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);

    expect(wb.worksheets.map((w) => w.name)).toEqual(['Ceny', 'Metryka', 'Pusty']);

    const prices = wb.getWorksheet('Ceny')!;
    expect(prices.getCell('A2').value).toBe('Krzeslo');
    expect(prices.getCell('B2').value).toBe(10);
    expect(prices.getCell('C2').value).toBe(250.5);

    /*
     * The property the whole "formulas are not recalculated" limit rests on:
     * the cell carries the formula *and* the value the spreadsheet last wrote,
     * as two separate fields. Reporting the second as the first would be
     * presenting a stale number as a calculation. The exact object shape is
     * pinned: a cell that came back as a bare (recalculated) number, or as any
     * other wrapper, fails here rather than passing as "truthy".
     */
    const computed = prices.getCell('D2').value as { formula: string; result: number };
    // 10 szt. x 250,50 = 2 505 — recznie, niezaleznie od biblioteki.
    expect(computed).toEqual({ formula: 'B2*C2', result: 10 * 250.5 });

    const meta = wb.getWorksheet('Metryka')!;
    expect(meta.getCell('B1').value).toBeInstanceOf(Date);
    expect(meta.getCell('B2').value).toBe(true);
    expect(meta.getCell('B3').value).toBeNull();
  });

  it('zapisana wartosc formuly moze byc nieaktualna — i dlatego nie jest wynikiem', async () => {
    /*
     * Written deliberately inconsistent: the formula says B*C (= 20) while the
     * stored result says 999. A reader that recalculated would say 20; a reader
     * that trusted the file says 999. The platform does neither silently — it
     * reports both, which is why `FILE_ANALYSIS` states the limit out loud.
     */
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('S');
    sheet.addRow([4, 5, { formula: 'A1*B1', result: 999 }]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());

    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(bytes as unknown as ArrayBuffer);
    const cell = reread.getWorksheet('S')!.getCell('C1').value as { formula: string; result: number };

    expect(cell.formula).toBe('A1*B1');
    expect(cell.result).toBe(999);
    expect(cell.result).not.toBe(20);
    expect(FILE_ANALYSIS.spreadsheet.limits.join(' ')).toMatch(/NIE sa przeliczane/);
  });

  it('exceljs: uszkodzony plik konczy sie bledem biblioteki, nie zmyslona trescia', async () => {
    /*
     * Kontrakt BIBLIOTEKI, nazwany uczciwie: w tej aplikacji nie ma serwisu, ktory
     * parsowalby XLSX po stronie platformy — analiza to skrypt pisany przez model
     * i wykonywany w workspace uruchomienia (patrz describe powyzej), wiec
     * zachowanie exceljs wobec smieci to sciezka produkcyjna. Uczciwosc testu
     * polega na tym, ze asercjonujemy realny blad biblioteki: XLSX to archiwum
     * ZIP, wiec smiec konczy sie bledem „end of central directory”, a nie
     * pustym skoroszytem do dalszej „analizy”.
     */
    const wb = new ExcelJS.Workbook();
    await expect(
      wb.xlsx.load(Buffer.from('to nie jest skoroszyt') as unknown as ArrayBuffer),
    ).rejects.toThrow(/zip/i);
  });
});

describe('magazyn plikow: typy, limity i dostep', () => {
  it('xlsx jest przyjmowany, a macro-enabled i legacy nie', async () => {
    const bytes = await makeWorkbook();
    const stored = h.platform.services.files.store({
      ownerId: h.ownerId,
      filename: 'oferty.xlsx',
      mediaType: XLSX_MEDIA,
      bytes,
    });
    expect(stored.mediaType).toBe(XLSX_MEDIA);
    expect(stored.version).toBe(1);
    expect(stored.derivedFromFileId).toBeNull();

    for (const rejected of ['application/vnd.ms-excel.sheet.macroEnabled.12', 'application/vnd.ms-excel']) {
      expect(() =>
        h.platform.services.files.store({
          ownerId: h.ownerId, filename: 'x.xlsm', mediaType: rejected, bytes,
        }),
      ).toThrowError(/Niedozwolony typ pliku/);
    }
  });

  it('plik ponad limit jest odrzucony z podaniem limitu', () => {
    const tooBig = new Uint8Array(h.platform.config.maxUploadBytes + 1);
    try {
      h.platform.services.files.store({
        ownerId: h.ownerId, filename: 'duzy.csv', mediaType: 'text/csv', bytes: tooBig,
      });
      throw new Error('powinno odrzucic');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('validation_failed');
      expect((e as AppError).details).toMatchObject({ maxBytes: h.platform.config.maxUploadBytes });
    }
  });

  it('cudzy plik jest niedostepny do odczytu i do wersjonowania', async () => {
    const mine = h.platform.services.files.store({
      ownerId: h.ownerId, filename: 'moj.xlsx', mediaType: XLSX_MEDIA, bytes: await makeWorkbook(),
    });
    expect(() => h.platform.services.files.read(mine.id, h.otherOwnerId)).toThrowError(
      /innego wlasciciela/,
    );
    expect(() =>
      h.platform.services.files.storeVersion({
        ownerId: h.otherOwnerId, originalFileId: mine.id, bytes: new Uint8Array([1]),
      }),
    ).toThrowError(/innego wlasciciela/);
  });
});

describe('modyfikacja pliku zostawia oryginal nietkniety', () => {
  it('nowa wersja to nowy plik wskazujacy na oryginal', async () => {
    const originalBytes = await makeWorkbook();
    const original = h.platform.services.files.store({
      ownerId: h.ownerId,
      filename: 'oferty.xlsx',
      mediaType: XLSX_MEDIA,
      bytes: originalBytes,
      scopeKind: 'case',
      scopeId: 'case_1',
    });

    // Modify: add a sheet, as a run would after parsing it.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(originalBytes as unknown as ArrayBuffer);
    wb.addWorksheet('Podsumowanie').addRow(['Razem', 4905]);
    const modified = Buffer.from(await wb.xlsx.writeBuffer());

    const { original: after, version } = h.platform.services.files.storeVersion({
      ownerId: h.ownerId,
      originalFileId: original.id,
      filename: 'oferty-poprawione.xlsx',
      mediaType: XLSX_MEDIA,
      bytes: modified,
    });

    expect(version.version).toBe(2);
    expect(version.derivedFromFileId).toBe(original.id);
    // Scope is inherited: a produced file stays attached to the same record.
    expect(version.scopeKind).toBe('case');
    expect(version.scopeId).toBe('case_1');

    // The original is untouched — same identity, same checksum, same bytes.
    expect(after.id).toBe(original.id);
    expect(after.sha256).toBe(original.sha256);
    expect(after.version).toBe(1);
    const reread = h.platform.services.files.read(original.id, h.ownerId);
    expect(Buffer.compare(reread.bytes, originalBytes)).toBe(0);

    // And the produced file really is the modified workbook, still openable.
    const check = new ExcelJS.Workbook();
    await check.xlsx.load(
      h.platform.services.files.read(version.id, h.ownerId).bytes as unknown as ArrayBuffer,
    );
    expect(check.worksheets.map((w) => w.name)).toContain('Podsumowanie');
    expect(check.getWorksheet('Podsumowanie')!.getCell('B1').value).toBe(4905);
    // The sheets that were there before survived the round trip.
    expect(check.worksheets.map((w) => w.name)).toEqual(
      expect.arrayContaining(['Ceny', 'Metryka', 'Pusty']),
    );

    expect(h.platform.services.files.versionsOf(original.id, h.ownerId).map((f) => f.id)).toEqual([
      version.id,
    ]);
  });

  it('oba pliki sa osobno pobieralne przez API, a obcy wlasciciel nie', async () => {
    /*
     * Pobieralnosc sprawdzana tak, jak robi to przegladarka: endpointem
     * `/api/files/:id/content`, nie po ukladzie katalogow na dysku (sufiks
     * rel_path to detal implementacji magazynu). Wersja i oryginal to dwa
     * niezalezne pobrania; sesja innego uzytkownika dostaje 403.
     */
    const original = h.platform.services.files.store({
      ownerId: h.ownerId, filename: 'a.xlsx', mediaType: XLSX_MEDIA, bytes: await makeWorkbook(),
    });
    const { version } = h.platform.services.files.storeVersion({
      ownerId: h.ownerId, originalFileId: original.id, bytes: Buffer.from(await makeWorkbook()),
    });

    const cookie = await login(h.platform.app, h.ownerId);
    const otherCookie = await login(h.platform.app, h.otherOwnerId);

    for (const file of [original, version]) {
      const res = await h.platform.app.request(`/api/files/${file.id}/content`, {
        headers: { cookie },
      });
      expect(res.status, `pobranie ${file.filename} (wersja ${file.version})`).toBe(200);
      expect(res.headers.get('content-type')).toBe(XLSX_MEDIA);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }

    const foreign = await h.platform.app.request(`/api/files/${original.id}/content`, {
      headers: { cookie: otherCookie },
    });
    expect(foreign.status).toBe(403);
  });
});
