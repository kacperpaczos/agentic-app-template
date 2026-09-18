import { inflateRawSync } from 'node:zlib';

/**
 * Just enough ZIP to ask a workbook what parts it is made of — and to put one
 * in that the parser does not understand.
 *
 * An `.xlsx` is a ZIP of XML parts. The spreadsheet library in the run workspace
 * models some of them (sheets, cells, styles, images) and not others (charts,
 * pivot tables), and **writes a saved workbook out of its own model**. So a part
 * it does not model is not copied across: it disappears. That is the mechanism
 * behind the platform's declared limit, and stating it is not the same as
 * showing it — hence this, which lets a test build a workbook containing a chart
 * part and look for it afterwards.
 *
 * Deliberately minimal and deliberately not a dependency: it reads the local
 * file headers in order (the writer produces no data descriptors, which is
 * checked below) and rebuilds the archive with stored entries. Nothing here is
 * used by the application.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

interface Entry {
  name: string;
  /** Raw, as stored in the archive. */
  data: Buffer;
  method: number;
  crc: number;
  uncompressedSize: number;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    let c = (crc ^ buf[n]!) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Every entry of the archive, in the order it was written. */
export function readZipEntries(zip: Buffer): Entry[] {
  const entries: Entry[] = [];
  let off = 0;
  while (off + 4 <= zip.length && zip.readUInt32LE(off) === LOCAL_SIG) {
    const flags = zip.readUInt16LE(off + 6);
    if (flags & 0x08) {
      throw new Error('archiwum uzywa data descriptor — ten czytnik tego nie obsluguje');
    }
    const method = zip.readUInt16LE(off + 8);
    const crc = zip.readUInt32LE(off + 14);
    const compressedSize = zip.readUInt32LE(off + 18);
    const uncompressedSize = zip.readUInt32LE(off + 22);
    const nameLen = zip.readUInt16LE(off + 26);
    const extraLen = zip.readUInt16LE(off + 28);
    const name = zip.toString('utf8', off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    entries.push({
      name,
      data: zip.subarray(dataStart, dataStart + compressedSize),
      method,
      crc,
      uncompressedSize,
    });
    off = dataStart + compressedSize;
  }
  return entries;
}

/** Names of the parts an archive contains. */
export const zipEntryNames = (zip: Buffer): string[] => readZipEntries(zip).map((e) => e.name);

/** The decoded content of one part. */
export function readZipEntry(zip: Buffer, name: string): Buffer {
  const entry = readZipEntries(zip).find((e) => e.name === name);
  if (!entry) throw new Error(`brak czesci ${name} w archiwum`);
  return entry.method === 8 ? inflateRawSync(entry.data) : Buffer.from(entry.data);
}

/**
 * Rebuilds the archive with parts added or replaced.
 *
 * New and replaced parts are stored uncompressed, which every ZIP reader
 * accepts; untouched parts are copied byte for byte, so nothing is re-encoded.
 */
export function writeZipWith(
  zip: Buffer,
  changes: Record<string, Buffer | string>,
): Buffer {
  const existing = readZipEntries(zip);
  const replaced = new Set<string>();
  const asStored = (name: string, content: Buffer | string): Entry => {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    return { name, data, method: 0, crc: crc32(data), uncompressedSize: data.length };
  };

  const entries: Entry[] = existing.map((e) => {
    const change = changes[e.name];
    if (change === undefined) return e;
    replaced.add(e.name);
    return asStored(e.name, change);
  });
  for (const [name, content] of Object.entries(changes)) {
    if (!replaced.has(name)) entries.push(asStored(name, content));
  }

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags: no data descriptor
    local.writeUInt16LE(e.method, 8);
    local.writeUInt32LE(e.crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(e.method, 10);
    central.writeUInt32LE(e.crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + e.data.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}
