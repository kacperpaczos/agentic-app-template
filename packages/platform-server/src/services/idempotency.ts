import type { Db } from '../db/client.ts';
import { nowIso } from '../util/id.ts';

/**
 * Replay guard for business mutations.
 *
 * A caller (HTTP client, or the agent through an MCP write tool) passes an
 * `operationId`. The first execution stores its result; every repeat returns the
 * stored result without touching the domain again. This is what makes
 * "reconnect does not double a mutation" true rather than hopeful.
 */
export class IdempotencyStore {
  constructor(private readonly db: Db) {}

  get<T>(operationId: string, ownerId: string, scope: string): T | undefined {
    const row = this.db.$client
      .prepare(
        'SELECT result FROM idempotency_keys WHERE operation_id = ? AND owner_id = ? AND scope = ?',
      )
      .get(operationId, ownerId, scope) as { result: string } | undefined;
    return row ? (JSON.parse(row.result) as T) : undefined;
  }

  put(operationId: string, ownerId: string, scope: string, result: unknown): void {
    this.db.$client
      .prepare(
        `INSERT INTO idempotency_keys (operation_id, owner_id, scope, result, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(operation_id, owner_id, scope) DO NOTHING`,
      )
      .run(operationId, ownerId, scope, JSON.stringify(result ?? null), nowIso());
  }

  /** Runs `fn` at most once per (operationId, owner, scope). */
  async once<T>(
    operationId: string | undefined,
    ownerId: string,
    scope: string,
    fn: () => Promise<T>,
  ): Promise<{ result: T; replayed: boolean }> {
    if (!operationId) return { result: await fn(), replayed: false };
    const existing = this.get<T>(operationId, ownerId, scope);
    if (existing !== undefined) return { result: existing, replayed: true };
    const result = await fn();
    this.put(operationId, ownerId, scope, result);
    return { result, replayed: false };
  }
}
