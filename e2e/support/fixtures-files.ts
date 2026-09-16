import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * Test inputs with content a model can actually be right or wrong about.
 *
 * Both are generated rather than committed as binaries: the assertions are
 * about what is *in* them, so the test and the fixture must not be able to
 * drift apart.
 */

/* --------------------------------- PNG ----------------------------------- */

function crc32(buf: Buffer): number {
  let c: number;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]!) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/**
 * A PNG of wide vertical colour bands.
 *
 * Deliberately colours and not text: reading rendered glyphs would test the
 * model's OCR, while "which colours, in what order" is unambiguous, verifiable
 * from the bytes, and impossible to answer from the filename or the metadata —
 * which is exactly the distinction the acceptance criterion draws.
 */
export function bandsPng(
  bands: Array<[number, number, number]>,
  width = 360,
  height = 160,
): Buffer {
  const bandWidth = Math.floor(width / bands.length);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const band = bands[Math.min(Math.floor(x / bandWidth), bands.length - 1)]!;
      raw[p++] = band[0];
      raw[p++] = band[1];
      raw[p++] = band[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const RED: [number, number, number] = [220, 30, 30];
export const GREEN: [number, number, number] = [30, 170, 60];
export const BLUE: [number, number, number] = [40, 80, 210];

/* --------------------------------- XLSX ---------------------------------- */

interface Cell { value: unknown }
interface Worksheet {
  name: string;
  addRow: (values: unknown[]) => unknown;
  getCell: (ref: string) => Cell;
}
interface Workbook {
  worksheets: Worksheet[];
  addWorksheet: (name: string) => Worksheet;
  getWorksheet: (name: string) => Worksheet | undefined;
  xlsx: { writeBuffer: () => Promise<ArrayBuffer>; load: (d: ArrayBuffer) => Promise<unknown> };
}

const require_ = createRequire(
  resolve(import.meta.dirname, '../../packages/platform-server/package.json'),
);
const ExcelJS = require_('exceljs') as { Workbook: new () => Workbook };

export const newWorkbook = (): Workbook => new ExcelJS.Workbook();

export async function loadWorkbook(bytes: Buffer): Promise<Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return wb;
}

/**
 * A workbook with several sheets and mixed cell types, including one formula.
 *
 * The quantities are the point: the assertion checks a total the model has to
 * derive from the cells, so reading the filename or the sheet names cannot
 * produce it.
 */
export async function multiSheetWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const items = wb.addWorksheet('Pozycje');
  items.addRow(['Nazwa', 'Ilosc', 'Cena', 'Wartosc']);
  items.addRow(['Krzeslo', 10, 250, { formula: 'B2*C2', result: 2500 }]);
  items.addRow(['Stol', 2, 1200, { formula: 'B3*C3', result: 2400 }]);
  items.addRow(['Lampa', 5, 80, { formula: 'B4*C4', result: 400 }]);

  const meta = wb.addWorksheet('Metryka');
  meta.addRow(['Data', new Date('2026-02-01T00:00:00Z')]);
  meta.addRow(['Zatwierdzone', true]);
  meta.addRow(['Uwagi', null]);

  wb.addWorksheet('Pusty');

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 10*250 + 2*1200 + 5*80 — the number the model must arrive at from the cells. */
export const WORKBOOK_TOTAL = 5300;
