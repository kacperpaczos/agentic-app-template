import { useMemo } from 'react';
import { AppError, type DataSource, type ReadResponse } from '@platform/contracts';
import { isAccessFailure, type DataState } from './DataFrame.tsx';
import { useReadOperation } from './useReadOperation.ts';

/**
 * A data component's read and its model, with one state for the frame.
 *
 * Shared by the table, the chart and the summary so they cannot disagree about
 * what counts as loading, as a failure or as no access. `build` turns the
 * response into what the component renders; anything it throws — an undeclared
 * field, a result without its declared collection — becomes the `error` state
 * with the reason, rather than a render crash or an empty body.
 */
export function useDataModel<T>(
  source: DataSource,
  build: (response: ReadResponse) => T,
  deps: readonly unknown[],
): { state: Exclude<DataState, 'empty'>; model: T | null; error: unknown } {
  const read = useReadOperation(source);

  const built = useMemo((): { model: T | null; error: unknown } => {
    if (!read.data) return { model: null, error: null };
    try {
      return { model: build(read.data), error: null };
    } catch (e) {
      return { model: null, error: AppError.from(e) };
    }
    // `build` is a fresh closure every render; `deps` names what it reads.
  }, [read.data, ...deps]);

  if (read.error) {
    return { state: isAccessFailure(read.error) ? 'forbidden' : 'error', model: null, error: read.error };
  }
  if (built.error) return { state: 'error', model: null, error: built.error };
  if (!built.model) return { state: 'loading', model: null, error: null };
  return { state: 'ready', model: built.model, error: null };
}
