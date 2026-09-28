import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { basename, extname, resolve, sep } from 'node:path';
import { AppError, FILE_LIMITS, type StoredFile } from '@platform/contracts';
import type { Db } from '../db/client.ts';
import { newId, nowIso, sha256 } from '../util/id.ts';

interface FileRow {
  id: string;
  owner_id: string;
  filename: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  rel_path: string;
  scope_kind: string | null;
  scope_id: string | null;
  created_at: string;
  derived_from_file_id: string | null;
  version: number;
}

const toFile = (r: FileRow): StoredFile => ({
  id: r.id,
  ownerId: r.owner_id,
  filename: r.filename,
  mediaType: r.media_type,
  byteSize: r.byte_size,
  sha256: r.sha256,
  scopeKind: r.scope_kind,
  scopeId: r.scope_id,
  createdAt: r.created_at,
  derivedFromFileId: r.derived_from_file_id,
  version: r.version,
});

const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * Strips everything but a plain basename. Uploads and sandbox-published results
 * are both named by the *caller*, so this runs on every path that reaches disk.
 */
export function sanitizeFilename(raw: string): string {
  const base = basename(raw.replaceAll('\\', '/')).replace(CONTROL_CHARS, '');
  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned) throw new AppError('validation_failed', 'Nazwa pliku jest pusta.');
  if (cleaned.length > FILE_LIMITS.maxFilenameLength) {
    const ext = extname(cleaned).slice(0, 12);
    return cleaned.slice(0, FILE_LIMITS.maxFilenameLength - ext.length) + ext;
  }
  return cleaned;
}

/** Managed file store. Every byte the app persists goes through here. */
export class FileService {
  constructor(
    private readonly db: Db,
    private readonly filesDir: string,
    private readonly maxBytes: number,
  ) {}

  store(input: {
    ownerId: string;
    filename: string;
    mediaType: string;
    bytes: Uint8Array;
    scopeKind?: string | null;
    scopeId?: string | null;
    /** Set when this file is a produced version of an existing one. */
    derivedFromFileId?: string | null;
    version?: number;
  }): StoredFile {
    const filename = sanitizeFilename(input.filename);
    if (input.bytes.byteLength > this.maxBytes) {
      throw new AppError('validation_failed', `Plik przekracza limit ${this.maxBytes} bajtow.`, {
        byteSize: input.bytes.byteLength,
        maxBytes: this.maxBytes,
      });
    }
    const mediaType = input.mediaType || 'application/octet-stream';
    if (!(FILE_LIMITS.allowedMediaTypes as readonly string[]).includes(mediaType)) {
      throw new AppError('validation_failed', `Niedozwolony typ pliku: ${mediaType}`, {
        allowed: FILE_LIMITS.allowedMediaTypes,
      });
    }
    const id = newId('fil');
    const relPath = `${id}${extname(filename) || ''}`;
    mkdirSync(this.filesDir, { recursive: true });
    writeFileSync(resolve(this.filesDir, relPath), input.bytes);
    this.db.$client
      .prepare(
        `INSERT INTO files (id, owner_id, filename, media_type, byte_size, sha256, rel_path, scope_kind, scope_id, created_at, derived_from_file_id, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.ownerId,
        filename,
        mediaType,
        input.bytes.byteLength,
        sha256(input.bytes),
        relPath,
        input.scopeKind ?? null,
        input.scopeId ?? null,
        nowIso(),
        input.derivedFromFileId ?? null,
        input.version ?? 1,
      );
    return toFile(this.#row(id, input.ownerId));
  }

  #row(id: string, ownerId: string): FileRow {
    const row = this.db.$client.prepare('SELECT * FROM files WHERE id = ?').get(id) as
      | FileRow
      | undefined;
    if (!row) throw new AppError('not_found', `Plik ${id} nie istnieje.`);
    if (row.owner_id !== ownerId) {
      throw new AppError('forbidden', 'Plik nalezy do innego wlasciciela.');
    }
    return row;
  }

  meta(id: string, ownerId: string): StoredFile {
    return toFile(this.#row(id, ownerId));
  }

  read(id: string, ownerId: string): { meta: StoredFile; bytes: Buffer } {
    const row = this.#row(id, ownerId);
    const path = resolve(this.filesDir, row.rel_path);
    if (!path.startsWith(this.filesDir + sep)) {
      throw new AppError('internal', 'Nieprawidlowa sciezka pliku w magazynie.');
    }
    if (!existsSync(path)) {
      throw new AppError('not_found', 'Tresc pliku zostala usunieta z dysku.');
    }
    return { meta: toFile(row), bytes: readFileSync(path) };
  }

  list(ownerId: string, scope?: { kind: string; id: string }): StoredFile[] {
    const rows = scope
      ? (this.db.$client
          .prepare(
            'SELECT * FROM files WHERE owner_id = ? AND scope_kind = ? AND scope_id = ? ORDER BY created_at DESC',
          )
          .all(ownerId, scope.kind, scope.id) as FileRow[])
      : (this.db.$client
          .prepare('SELECT * FROM files WHERE owner_id = ? ORDER BY created_at DESC')
          .all(ownerId) as FileRow[]);
    return rows.map(toFile);
  }

  /**
   * Stores a file produced from an existing one.
   *
   * The original is read (which checks ownership) and then **left alone**: the
   * new bytes become a separate row that points back at it. That is what makes
   * "the agent changed my spreadsheet" a reversible, inspectable fact rather
   * than a lost original — and it is why nothing in this service ever rewrites
   * a stored file in place.
   *
   * The new version inherits the parent's scope, so a produced file stays
   * attached to the same business record as the upload it came from.
   */
  storeVersion(input: {
    ownerId: string;
    originalFileId: string;
    filename?: string;
    mediaType?: string;
    bytes: Uint8Array;
  }): { original: StoredFile; version: StoredFile } {
    const original = this.meta(input.originalFileId, input.ownerId);
    const version = this.store({
      ownerId: input.ownerId,
      filename: input.filename ?? original.filename,
      mediaType: input.mediaType ?? original.mediaType,
      bytes: input.bytes,
      scopeKind: original.scopeKind,
      scopeId: original.scopeId,
      derivedFromFileId: original.id,
      version: original.version + 1,
    });
    return { original: this.meta(original.id, input.ownerId), version };
  }

  /** Every file produced from this one, newest first. */
  versionsOf(fileId: string, ownerId: string): StoredFile[] {
    this.#row(fileId, ownerId);
    return (
      this.db.$client
        .prepare(
          'SELECT * FROM files WHERE derived_from_file_id = ? AND owner_id = ? ORDER BY created_at DESC',
        )
        .all(fileId, ownerId) as FileRow[]
    ).map(toFile);
  }

  delete(id: string, ownerId: string): void {
    const row = this.#row(id, ownerId);
    this.db.$client.prepare('DELETE FROM files WHERE id = ?').run(id);
    const path = resolve(this.filesDir, row.rel_path);
    if (path.startsWith(this.filesDir + sep) && existsSync(path)) rmSync(path, { force: true });
  }
}
