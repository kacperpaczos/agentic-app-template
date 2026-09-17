import { useQuery } from '@tanstack/react-query';
import { AppError, type DataSource, type ReadResponse } from '@platform/contracts';
import { apiPost } from '../api/client.ts';
import { qk, useReadOperations } from '../api/queries.ts';

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

/** What a data component does with its source right now. */
export type ReadGate =
  | { kind: 'wait' }
  | { kind: 'fetch' }
  | { kind: 'refuse'; error: AppError };

/**
 * Whether a source may be sent to `POST /api/read`.
 *
 * **Why a gate at all.** The chat renders an answer while it streams, and the
 * renderer draws elements that are still arriving: `DataTable({operation:
 * "modul.op` is a table whose operation is, for a moment, `modul.op`. Without
 * this, every chunk would fire a read for a name that is not an operation yet —
 * a stream of refused requests and a flickering error. So a read is sent only
 * for an operation the registry lists (`GET /api/read/operations`).
 *
 * A name the list does not have is refused here, with the backend's wording,
 * rather than waited on: a stored composition naming a removed operation must
 * say so, not spin. While the list itself is loading nothing is sent; if the
 * list cannot be read, the backend decides.
 */
export function readGate(
  source: DataSource | null | undefined,
  operations: ReadonlyArray<{ name: string }> | undefined,
  listFailed = false,
): ReadGate {
  const operation = source?.operation ?? '';
  if (!operation || hasUnresolvedInput(source?.input ?? {})) return { kind: 'wait' };
  if (!operations) return listFailed ? { kind: 'fetch' } : { kind: 'wait' };
  if (operations.some((o) => o.name === operation)) return { kind: 'fetch' };
  const available = operations.map((o) => o.name);
  return {
    kind: 'refuse',
    error: new AppError(
      'validation_failed',
      `Nieznana operacja odczytu "${operation}". Dostepne: ${available.join(', ') || 'brak'}.`,
      { reason: 'unknown_operation', operation, available },
    ),
  };
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
 * chart and summary reading the same data. Sent only past {@link readGate}.
 */
export function useReadOperation(source: DataSource | null | undefined, opts: ReadOperationOptions = {}) {
  const operations = useReadOperations();
  const gate = readGate(source, operations.data, operations.isError);
  const operation = source?.operation ?? '';
  const input = source?.input ?? {};
  const query = useQuery({
    queryKey: operation ? qk.read(operation, input) : ['read', 'none'],
    queryFn: () => apiPost<ReadResponse>('/api/read', { operation, input }),
    enabled: gate.kind === 'fetch' && (opts.enabled ?? true),
  });
  if (gate.kind === 'refuse') {
    return { ...query, data: undefined, error: gate.error, isError: true, status: 'error' } as typeof query;
  }
  return query;
}
