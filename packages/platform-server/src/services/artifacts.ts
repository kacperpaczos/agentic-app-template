import {
  AppError,
  liveArtifactSourceSchema,
  type ArtifactKind,
  type ArtifactMeta,
  type ArtifactMode,
  type ArtifactVersion,
  type LiveArtifactSource,
  type LiveResolution,
} from '@platform/contracts';
import type { Db } from '../db/client.ts';
import type { ServerModuleRegistry } from '../registry/modules.ts';
import {
  prepareRead,
  readRefusalOf,
  runPreparedRead,
  type PreparedRead,
} from '../registry/read-operations.ts';
import { newId, nowIso } from '../util/id.ts';

interface ArtRow {
  id: string;
  owner_id: string;
  conversation_id: string | null;
  kind: string;
  mode: string;
  title: string;
  renderer_type: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

interface VerRow {
  artifact_id: string;
  version: number;
  content: string;
  file_id: string | null;
  created_at: string;
}

const toArt = (r: ArtRow): ArtifactMeta => ({
  id: r.id,
  ownerId: r.owner_id,
  conversationId: r.conversation_id,
  kind: r.kind as ArtifactKind,
  mode: r.mode as ArtifactMode,
  title: r.title,
  rendererType: r.renderer_type,
  currentVersion: r.current_version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toVer = (r: VerRow): ArtifactVersion => ({
  artifactId: r.artifact_id,
  version: r.version,
  content: JSON.parse(r.content),
  fileId: r.file_id,
  createdAt: r.created_at,
});

/**
 * Artifact registry. Identity is `id`; the title is a mutable label and is never
 * used as a key. Preview and full view both read `current_version`, so they can
 * never disagree.
 */
export class ArtifactService {
  /**
   * The registry is optional so the platform still boots with no modules
   * installed; without one, a live artifact resolves to `unavailable` rather
   * than throwing. It is assigned by the composition root after registration.
   */
  modules: ServerModuleRegistry | null = null;

  constructor(private readonly db: Db) {}

  /**
   * Validates a live artifact's descriptor *before* it is stored.
   *
   * A descriptor that names an operation nobody registered would be a report
   * that fails every time it is opened. Rejecting it at creation turns that into
   * an immediate, explainable error for the agent instead. The check is the one
   * every read goes through (`prepareRead`), so a descriptor accepted here is
   * one `POST /api/read` would accept too.
   */
  assertLiveSourceIsResolvable(content: unknown): LiveArtifactSource {
    return prepareRead(this.modules, content).source;
  }

  /**
   * Re-runs the query behind a live artifact.
   *
   * Returns the freshly produced content together with an explicit resolution
   * state. Failure never falls back to the stored descriptor or to an older
   * result: a view that cannot refresh must say so rather than show numbers the
   * user would read as current.
   */
  async resolveLive(
    id: string,
    ownerId: string,
    version?: number,
  ): Promise<{ content: unknown; live: LiveResolution }> {
    const stored = this.version(id, ownerId, version);
    const base: LiveResolution = {
      operation: '',
      definitionVersion: stored.version,
      state: 'unavailable',
      resolvedAt: null,
      error: null,
    };

    let prepared: PreparedRead;
    try {
      prepared = prepareRead(this.modules, stored.content);
    } catch (err) {
      const operation = liveArtifactSourceSchema.safeParse(stored.content).data?.operation ?? '';
      switch (readRefusalOf(err)) {
        case 'unknown_operation':
          return {
            content: null,
            live: {
              ...base,
              operation,
              state: 'unavailable',
              error: `Operacja ${operation} nie jest zarejestrowana w tej instalacji.`,
            },
          };
        case 'invalid_input':
          return {
            content: null,
            live: {
              ...base,
              operation,
              state: 'failed',
              error: 'Wejscie zapisane w artefakcie nie pasuje juz do schematu operacji.',
            },
          };
        default:
          return {
            content: null,
            live: { ...base, state: 'failed', error: 'Deskryptor artefaktu jest nieczytelny.' },
          };
      }
    }

    try {
      // The owner comes from the authenticated session, never from the stored
      // descriptor: an artifact cannot be made to read someone else's data.
      const read = await runPreparedRead(prepared, ownerId);
      return {
        content: read.result,
        live: {
          ...base,
          operation: read.operation,
          state: 'fresh',
          resolvedAt: read.resolvedAt,
        },
      };
    } catch (err) {
      const e = AppError.from(err);
      return {
        content: null,
        live: {
          ...base,
          operation: prepared.source.operation,
          state: e.code === 'forbidden' || e.code === 'not_found' ? 'forbidden' : 'failed',
          error: e.message,
        },
      };
    }
  }

  #row(id: string, ownerId: string): ArtRow {
    const row = this.db.$client.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      | ArtRow
      | undefined;
    if (!row) throw new AppError('not_found', `Artefakt ${id} nie istnieje.`);
    if (row.owner_id !== ownerId) {
      throw new AppError('forbidden', 'Artefakt nalezy do innego wlasciciela.');
    }
    return row;
  }

  create(input: {
    ownerId: string;
    conversationId?: string | null;
    kind: ArtifactKind;
    mode: ArtifactMode;
    title: string;
    rendererType: string;
    content: unknown;
    fileId?: string | null;
  }): { meta: ArtifactMeta; version: ArtifactVersion } {
    const id = newId('art');
    const ts = nowIso();
    const tx = this.db.$client.transaction(() => {
      this.db.$client
        .prepare(
          `INSERT INTO artifacts (id, owner_id, conversation_id, kind, mode, title, renderer_type, current_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.ownerId,
          input.conversationId ?? null,
          input.kind,
          input.mode,
          input.title,
          input.rendererType,
          ts,
          ts,
        );
      this.db.$client
        .prepare(
          `INSERT INTO artifact_versions (artifact_id, version, content, file_id, created_at)
           VALUES (?, 1, ?, ?, ?)`,
        )
        .run(id, JSON.stringify(input.content ?? null), input.fileId ?? null, ts);
    });
    tx();
    return { meta: toArt(this.#row(id, input.ownerId)), version: this.version(id, input.ownerId) };
  }

  addVersion(
    id: string,
    ownerId: string,
    input: { content: unknown; fileId?: string | null },
  ): { meta: ArtifactMeta; version: ArtifactVersion } {
    const row = this.#row(id, ownerId);
    const next = row.current_version + 1;
    const ts = nowIso();
    const tx = this.db.$client.transaction(() => {
      this.db.$client
        .prepare(
          `INSERT INTO artifact_versions (artifact_id, version, content, file_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, next, JSON.stringify(input.content ?? null), input.fileId ?? null, ts);
      this.db.$client
        .prepare('UPDATE artifacts SET current_version = ?, updated_at = ? WHERE id = ?')
        .run(next, ts, id);
    });
    tx();
    return { meta: toArt(this.#row(id, ownerId)), version: this.version(id, ownerId) };
  }

  list(ownerId: string, filter?: { conversationId?: string; type?: string[] }): ArtifactMeta[] {
    let sql = 'SELECT * FROM artifacts WHERE owner_id = ?';
    const args: unknown[] = [ownerId];
    if (filter?.conversationId) {
      sql += ' AND conversation_id = ?';
      args.push(filter.conversationId);
    }
    if (filter?.type?.length) {
      sql += ` AND renderer_type IN (${filter.type.map(() => '?').join(',')})`;
      args.push(...filter.type);
    }
    sql += ' ORDER BY updated_at DESC';
    return (this.db.$client.prepare(sql).all(...args) as ArtRow[]).map(toArt);
  }

  meta(id: string, ownerId: string): ArtifactMeta {
    return toArt(this.#row(id, ownerId));
  }

  version(id: string, ownerId: string, version?: number): ArtifactVersion {
    const row = this.#row(id, ownerId);
    const v = version ?? row.current_version;
    const ver = this.db.$client
      .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?')
      .get(id, v) as VerRow | undefined;
    if (!ver) throw new AppError('not_found', `Wersja ${v} artefaktu ${id} nie istnieje.`);
    return toVer(ver);
  }

  rename(id: string, ownerId: string, title: string): ArtifactMeta {
    this.#row(id, ownerId);
    this.db.$client
      .prepare('UPDATE artifacts SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, nowIso(), id);
    return toArt(this.#row(id, ownerId));
  }
}
