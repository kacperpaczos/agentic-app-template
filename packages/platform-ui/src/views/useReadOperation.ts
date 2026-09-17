import { useQuery } from '@tanstack/react-query';
import type { DataSource, ReadResponse } from '@platform/contracts';
import { apiPost } from '../api/client.ts';
import { qk } from '../api/queries.ts';

/**
 * True while any input value is still `undefined`.
 *
 * A composition's input may reference a `$param` of its view; the renderer
 * fills its state after the first render, so for one frame the reference reads
 * as `undefined`. Asking the backend then would send an input without the
 * parameter and flash a validation error before the real answer. Once state is
 * initialised a missing parameter reads as `null`, which is sent and refused
 * honestly.
 */
function hasUnresolvedInput(value: unknown): boolean {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.some(hasUnresolvedInput);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasUnresolvedInput);
  }
  return false;
}

export interface ReadOperationOptions {
  enabled?: boolean;
}

/**
 * Runs one registered read through `POST /api/read` and caches it per owner,
 * operation and input (`qk.read`).
 *
 * The owner is the session's; the source only chooses which registered read
 * and with what input. Invalidated with every other business read
 * (`invalidateBusinessData`), so a mutation anywhere refreshes every table,
 * chart and summary reading the same data.
 */
export function useReadOperation(source: DataSource | null | undefined, opts: ReadOperationOptions = {}) {
  const operation = source?.operation ?? '';
  const input = source?.input ?? {};
  const waiting = hasUnresolvedInput(input);
  return useQuery({
    queryKey: operation ? qk.read(operation, input) : ['read', 'none'],
    queryFn: () => apiPost<ReadResponse>('/api/read', { operation, input }),
    enabled: Boolean(operation) && !waiting && (opts.enabled ?? true),
  });
}
