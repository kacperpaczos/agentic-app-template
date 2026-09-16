import { z } from 'zod';

export const idSchema = z.string().min(1).max(128);
export type Id = z.infer<typeof idSchema>;

export const ownerIdSchema = z.string().min(1).max(128);
export type OwnerId = z.infer<typeof ownerIdSchema>;

/** Monotonic optimistic-concurrency token. Every mutable platform row carries one. */
export const versionSchema = z.number().int().nonnegative();

/**
 * Caller-supplied operation id. The platform stores the first result under this
 * key and replays it for any repeat, so a retried request never doubles a
 * business effect. See `IdempotencyStore`.
 */
export const operationIdSchema = z.string().min(8).max(200);
