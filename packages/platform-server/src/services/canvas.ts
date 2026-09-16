import {
  AppError,
  canvasViewportSchema,
  type AddCardInput,
  type CanvasCard,
  type CanvasSpace,
  type CanvasState,
  type CanvasViewport,
  type CardGeometry,
  type RemoveCardInput,
  type UpdateCardGeometryInput,
  type UpdateCardSpecInput,
} from '@platform/contracts';
import type { Db } from '../db/client.ts';
import { newId, nowIso } from '../util/id.ts';
import type { IdempotencyStore } from './idempotency.ts';

const DEFAULT_GEOMETRY: CardGeometry = { x: 0, y: 0, width: 520, height: 360, z: 0 };

interface SpaceRow {
  id: string;
  owner_id: string;
  title: string;
  scope_kind: string | null;
  scope_id: string | null;
  viewport: string;
  created_at: string;
  updated_at: string;
}

interface CardRow {
  id: string;
  space_id: string;
  title: string;
  spec: string;
  geometry: string;
  spec_version: number;
  geometry_version: number;
  created_at: string;
  updated_at: string;
}

const toSpace = (r: SpaceRow): CanvasSpace => ({
  id: r.id,
  ownerId: r.owner_id,
  title: r.title,
  scopeKind: r.scope_kind,
  scopeId: r.scope_id,
  viewport: canvasViewportSchema.parse(JSON.parse(r.viewport)),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toCard = (r: CardRow): CanvasCard => ({
  id: r.id,
  spaceId: r.space_id,
  title: r.title,
  spec: JSON.parse(r.spec),
  geometry: JSON.parse(r.geometry),
  specVersion: r.spec_version,
  geometryVersion: r.geometry_version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Owner of the UI composition record.
 *
 * `updateSpec` and `updateGeometry` are separate on purpose — see the comment on
 * `cardGeometrySchema`. They write disjoint columns and bump disjoint version
 * counters, so a drag in flight and an agent edit in flight cannot clobber one
 * another; each only conflicts with a concurrent write of its own kind.
 */
export class CanvasService {
  constructor(
    private readonly db: Db,
    private readonly idem: IdempotencyStore,
  ) {}

  #spaceRow(spaceId: string, ownerId: string): SpaceRow {
    const row = this.db.$client
      .prepare('SELECT * FROM canvas_spaces WHERE id = ?')
      .get(spaceId) as SpaceRow | undefined;
    if (!row) throw new AppError('not_found', `Canvas space ${spaceId} not found.`);
    if (row.owner_id !== ownerId) throw new AppError('forbidden', 'Space belongs to another owner.');
    return row;
  }

  #cardRow(cardId: string, ownerId: string): { card: CardRow; space: SpaceRow } {
    const card = this.db.$client
      .prepare('SELECT * FROM canvas_cards WHERE id = ?')
      .get(cardId) as CardRow | undefined;
    if (!card) throw new AppError('not_found', `Card ${cardId} not found.`);
    const space = this.#spaceRow(card.space_id, ownerId);
    return { card, space };
  }

  listSpaces(ownerId: string): CanvasSpace[] {
    return (
      this.db.$client
        .prepare('SELECT * FROM canvas_spaces WHERE owner_id = ? ORDER BY updated_at DESC')
        .all(ownerId) as SpaceRow[]
    ).map(toSpace);
  }

  getState(spaceId: string, ownerId: string): CanvasState {
    const space = toSpace(this.#spaceRow(spaceId, ownerId));
    const cards = (
      this.db.$client
        .prepare('SELECT * FROM canvas_cards WHERE space_id = ? ORDER BY created_at')
        .all(spaceId) as CardRow[]
    ).map(toCard);
    return { space, cards };
  }

  createSpace(input: {
    ownerId: string;
    title: string;
    scopeKind?: string | null;
    scopeId?: string | null;
  }): CanvasSpace {
    const id = newId('spc');
    const ts = nowIso();
    this.db.$client
      .prepare(
        `INSERT INTO canvas_spaces (id, owner_id, title, scope_kind, scope_id, viewport, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.ownerId,
        input.title,
        input.scopeKind ?? null,
        input.scopeId ?? null,
        JSON.stringify({ x: 0, y: 0, zoom: 1 }),
        ts,
        ts,
      );
    return toSpace(this.#spaceRow(id, input.ownerId));
  }

  /** Finds the space bound to a module scope, or creates it. */
  ensureScopedSpace(input: {
    ownerId: string;
    title: string;
    scopeKind: string;
    scopeId: string;
  }): { space: CanvasSpace; created: boolean } {
    const existing = this.db.$client
      .prepare(
        'SELECT * FROM canvas_spaces WHERE owner_id = ? AND scope_kind = ? AND scope_id = ?',
      )
      .get(input.ownerId, input.scopeKind, input.scopeId) as SpaceRow | undefined;
    if (existing) return { space: toSpace(existing), created: false };
    return { space: this.createSpace(input), created: true };
  }

  setViewport(spaceId: string, ownerId: string, viewport: CanvasViewport): CanvasSpace {
    this.#spaceRow(spaceId, ownerId);
    this.db.$client
      .prepare('UPDATE canvas_spaces SET viewport = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(viewport), nowIso(), spaceId);
    return toSpace(this.#spaceRow(spaceId, ownerId));
  }

  async addCard(input: AddCardInput, ownerId: string): Promise<CanvasCard> {
    const { result } = await this.idem.once(input.operationId, ownerId, 'canvas.addCard', async () => {
      this.#spaceRow(input.spaceId, ownerId);
      const id = newId('crd');
      const ts = nowIso();
      // Without an explicit position, place the card below everything already on
      // the space. An agent that omits geometry should not drop a card on top of
      // the user's existing work.
      const base = input.geometry?.x === undefined || input.geometry?.y === undefined
        ? this.#nextFreeSlot(input.spaceId)
        : { x: 0, y: 0 };
      const geometry: CardGeometry = { ...DEFAULT_GEOMETRY, ...base, ...(input.geometry ?? {}) };
      this.db.$client
        .prepare(
          `INSERT INTO canvas_cards (id, space_id, title, spec, geometry, spec_version, geometry_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
        )
        .run(id, input.spaceId, input.title, JSON.stringify(input.spec), JSON.stringify(geometry), ts, ts);
      this.#touchSpace(input.spaceId);
      return toCard(
        this.db.$client.prepare('SELECT * FROM canvas_cards WHERE id = ?').get(id) as CardRow,
      );
    });
    return result;
  }

  /** Content write. Conflicts only with another content write. */
  async updateSpec(input: UpdateCardSpecInput, ownerId: string): Promise<CanvasCard> {
    const { result } = await this.idem.once(
      input.operationId,
      ownerId,
      'canvas.updateSpec',
      async () => {
        const { card } = this.#cardRow(input.cardId, ownerId);
        if (
          input.expectedSpecVersion !== undefined &&
          input.expectedSpecVersion !== card.spec_version
        ) {
          throw new AppError('conflict', 'Card content changed since it was read.', {
            currentSpecVersion: card.spec_version,
          });
        }
        this.db.$client
          .prepare(
            `UPDATE canvas_cards
               SET spec = ?, title = COALESCE(?, title), spec_version = spec_version + 1, updated_at = ?
             WHERE id = ?`,
          )
          .run(JSON.stringify(input.spec), input.title ?? null, nowIso(), input.cardId);
        this.#touchSpace(card.space_id);
        return toCard(
          this.db.$client
            .prepare('SELECT * FROM canvas_cards WHERE id = ?')
            .get(input.cardId) as CardRow,
        );
      },
    );
    return result;
  }

  /** Geometry write. Never touches `spec`, never bumps `spec_version`. */
  updateGeometry(input: UpdateCardGeometryInput, ownerId: string): CanvasCard {
    const { card } = this.#cardRow(input.cardId, ownerId);
    if (
      input.expectedGeometryVersion !== undefined &&
      input.expectedGeometryVersion !== card.geometry_version
    ) {
      throw new AppError('conflict', 'Card geometry changed since it was read.', {
        currentGeometryVersion: card.geometry_version,
      });
    }
    const merged: CardGeometry = { ...(JSON.parse(card.geometry) as CardGeometry), ...input.geometry };
    this.db.$client
      .prepare(
        `UPDATE canvas_cards
           SET geometry = ?, geometry_version = geometry_version + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(merged), nowIso(), input.cardId);
    return toCard(
      this.db.$client.prepare('SELECT * FROM canvas_cards WHERE id = ?').get(input.cardId) as CardRow,
    );
  }

  async removeCard(input: RemoveCardInput, ownerId: string): Promise<{ removed: string }> {
    const { result } = await this.idem.once(
      input.operationId,
      ownerId,
      'canvas.removeCard',
      async () => {
        const { card } = this.#cardRow(input.cardId, ownerId);
        this.db.$client.prepare('DELETE FROM canvas_cards WHERE id = ?').run(input.cardId);
        this.#touchSpace(card.space_id);
        return { removed: input.cardId };
      },
    );
    return result;
  }

  /** Bottom-left of the current content, with a gutter. */
  #nextFreeSlot(spaceId: string): { x: number; y: number } {
    const rows = this.db.$client
      .prepare('SELECT geometry FROM canvas_cards WHERE space_id = ?')
      .all(spaceId) as Array<{ geometry: string }>;
    if (rows.length === 0) return { x: 0, y: 0 };
    const bottom = Math.max(
      ...rows.map((r) => {
        const g = JSON.parse(r.geometry) as CardGeometry;
        return g.y + g.height;
      }),
    );
    return { x: 0, y: Math.round(bottom) + 40 };
  }

  #touchSpace(spaceId: string): void {
    this.db.$client
      .prepare('UPDATE canvas_spaces SET updated_at = ? WHERE id = ?')
      .run(nowIso(), spaceId);
  }
}
