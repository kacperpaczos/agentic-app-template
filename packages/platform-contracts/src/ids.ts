import { z } from 'zod';
// `views.ts` does not import this file, so naming it here closes no cycle.
import { stableJson } from './views.ts';

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

/**
 * What a repeat has to match to count as the same operation.
 *
 * The key says "this is the same operation"; this is what makes that claim
 * checkable. Without it the store answers a *different* request with the first
 * one's stored result and reports success — so the caller believes a change it
 * never made was applied. Every write path that takes an `operationId` passes
 * one, and it lives here rather than beside each of them because four private
 * copies of a rule is four chances to forget the fifth (which is exactly what
 * happened to `files_publish_version`).
 *
 * The key itself is excluded: two calls differing only in `operationId` are two
 * operations, not a mismatch.
 */
export function operationFingerprint(request: Record<string, unknown>): string {
  const { operationId: _key, ...rest } = request;
  return stableJson(rest);
}
