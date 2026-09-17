import { sortableFields, type ReadResultDescriptor, type RecordField } from '@platform/contracts';
import type { ServerModuleRegistry } from './modules.ts';

/**
 * What the view of a UI target reads, as far as ordering it is concerned.
 *
 * A target is ordered through its view's primary instance — the data component
 * reading the view's declared `primaryOperation` — so the fields it may be
 * ordered by are that read's declared, sortable fields. Resolved here once, for
 * the catalog the agent is shown, the `ui_sort` tool and the prompt, so the
 * three cannot list different fields.
 */
export function primaryDescriptorOf(
  registry: ServerModuleRegistry,
  targetId: string,
): { operation: string; descriptor: ReadResultDescriptor } | null {
  const operation = registry.view(targetId)?.definition.primaryOperation;
  if (!operation) return null;
  const descriptor = registry.readOperation(operation)?.definition.result;
  return descriptor ? { operation, descriptor } : null;
}

/**
 * Fields the target's view may be ordered by, or null when the target has no
 * view whose records can be ordered at all.
 */
export function sortableFieldsOfTarget(registry: ServerModuleRegistry, targetId: string): RecordField[] | null {
  const primary = primaryDescriptorOf(registry, targetId);
  return primary ? sortableFields(primary.descriptor) : null;
}
