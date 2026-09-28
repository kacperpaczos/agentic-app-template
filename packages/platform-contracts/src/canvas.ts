import { z } from 'zod';

/**
 * Canvas model.
 *
 * Split of responsibility (this is the core of the "position vs content" rule):
 *
 *   geometry  — owned by the user's pointer. Written through
 *               PATCH /api/canvas/cards/:id/geometry, versioned by `geometryVersion`.
 *   spec      — owned by the composition author (agent or default layout).
 *               Written through PATCH /api/canvas/cards/:id/spec, versioned by
 *               `specVersion`.
 *
 * The two never travel in the same request, never share a version counter and
 * never invalidate each other's cache entry. Dragging a card therefore cannot
 * lose an agent edit that landed mid-drag, and vice versa.
 */
export const cardGeometrySchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(160).max(4000),
  height: z.number().finite().min(120).max(4000),
  z: z.number().int().default(0),
});
export type CardGeometry = z.infer<typeof cardGeometrySchema>;

/**
 * A card's content. Two kinds:
 *  - `component` — a catalog component id plus validated props. Data is fetched
 *    by the component itself from the backend; props only carry references and
 *    view options, never business values.
 *  - `openui`    — an OpenUI Lang source string rendered by the OpenUI renderer
 *    against the registered component catalog.
 */
/**
 * Two constraints come from this schema also being the input of the
 * `canvas_add_card` / `canvas_update_card` MCP tools:
 *
 *  - `props` is a loose object, never `z.record(...)`: the Claude Agent SDK
 *    cannot convert a Zod record to JSON Schema, and the failure silently drops
 *    the *entire* MCP server from the session.
 *  - `props` is `.optional()`, never `.default()`: a defaulted field is reported
 *    to the model as required ("expected nonoptional, received undefined"), so a
 *    call that legitimately omits it fails.
 *
 * Both are enforced at startup by `assertMcpCompatibleShape` in `@platform/server`.
 */
export const cardSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('component'),
    component: z.string().min(1).max(120),
    props: z.looseObject({}).optional(),
  }),
  z.object({
    kind: z.literal('openui'),
    source: z.string().max(200_000),
  }),
]);
export type CardSpec = z.infer<typeof cardSpecSchema>;

export const canvasCardSchema = z.object({
  id: z.string(),
  spaceId: z.string(),
  title: z.string().max(200),
  spec: cardSpecSchema,
  geometry: cardGeometrySchema,
  specVersion: z.number().int().nonnegative(),
  geometryVersion: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CanvasCard = z.infer<typeof canvasCardSchema>;

export const canvasViewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().min(0.05).max(8),
});
export type CanvasViewport = z.infer<typeof canvasViewportSchema>;

export const canvasSpaceSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  title: z.string().max(200),
  /**
   * Opaque, module-supplied scope for the space (e.g. a business record id).
   * The platform stores and compares it but never interprets it.
   */
  scopeKind: z.string().max(80).nullable(),
  scopeId: z.string().max(128).nullable(),
  viewport: canvasViewportSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CanvasSpace = z.infer<typeof canvasSpaceSchema>;

export const canvasStateSchema = z.object({
  space: canvasSpaceSchema,
  cards: z.array(canvasCardSchema),
});
export type CanvasState = z.infer<typeof canvasStateSchema>;

/* ------------------------------ write contracts --------------------------- */

export const addCardInputSchema = z.object({
  spaceId: z.string(),
  title: z.string().max(200),
  spec: cardSpecSchema,
  geometry: cardGeometrySchema.partial().optional(),
  operationId: z.string().min(8).max(200).optional(),
});
export type AddCardInput = z.infer<typeof addCardInputSchema>;

export const updateCardSpecInputSchema = z.object({
  cardId: z.string(),
  title: z.string().max(200).optional(),
  spec: cardSpecSchema,
  /** Last seen `specVersion`; a stale value is rejected with `conflict`. */
  expectedSpecVersion: z.number().int().nonnegative().optional(),
  operationId: z.string().min(8).max(200).optional(),
});
export type UpdateCardSpecInput = z.infer<typeof updateCardSpecInputSchema>;

export const updateCardGeometryInputSchema = z.object({
  cardId: z.string(),
  geometry: cardGeometrySchema.partial(),
  expectedGeometryVersion: z.number().int().nonnegative().optional(),
});
export type UpdateCardGeometryInput = z.infer<typeof updateCardGeometryInputSchema>;

export const removeCardInputSchema = z.object({
  cardId: z.string(),
  operationId: z.string().min(8).max(200).optional(),
});
export type RemoveCardInput = z.infer<typeof removeCardInputSchema>;
