import {
  AppError,
  dataSourceSchema,
  recordsOf,
  type DataSource,
  type ReadOperationSummary,
  type ReadResponse,
} from '@platform/contracts';
import type { RegisteredReadOperation, ServerModuleRegistry } from './modules.ts';
import { nowIso } from '../util/id.ts';

/**
 * Resolving a registered read: name → registry → input validation → run with
 * the owner.
 *
 * One path for every consumer — a live artifact being opened, `POST /api/read`
 * behind a data component, a tool — so a descriptor accepted in one place
 * cannot be refused, or read differently, in another.
 *
 * Why each refusal carries a `reason`: callers present them differently. A live
 * artifact whose operation is no longer installed is `unavailable`, one whose
 * stored input stopped validating is `failed`; the HTTP API reports both as
 * `validation_failed`. The distinction is made here once, not re-derived from
 * message text.
 */
export type ReadRefusal = 'invalid_source' | 'unknown_operation' | 'invalid_input';

export interface PreparedRead {
  source: DataSource;
  entry: RegisteredReadOperation;
  /**
   * Input after the operation's own schema parsed it. Undefined when some input
   * keys were declared unresolved: such a source can be checked, not run.
   */
  input: unknown;
}

/** What resolving a read needs from the registry — also satisfied mid-registration. */
export type ReadOperationLookup = Pick<ServerModuleRegistry, 'readOperation' | 'readOperations'>;

export interface PrepareReadOptions {
  /**
   * Input keys whose value is known only when the source is rendered — a
   * composition's `$param`. Each must be a key the operation's input declares;
   * its value is not checked, every other key is, exactly as for a run.
   */
  unresolvedInputKeys?: readonly string[];
}

/** Checks a source against the registry without running anything. */
export function prepareRead(
  registry: ReadOperationLookup | null,
  raw: unknown,
  options: PrepareReadOptions = {},
): PreparedRead {
  const parsed = dataSourceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      'validation_failed',
      'Zrodlo danych wymaga deskryptora { operation, input } wskazujacego zarejestrowana operacje odczytu modulu.',
      { reason: 'invalid_source' satisfies ReadRefusal },
    );
  }
  const source = parsed.data;
  const entry = registry?.readOperation(source.operation);
  if (!entry) {
    const available = (registry?.readOperations ?? []).map((o) => o.qualifiedName);
    throw new AppError(
      'validation_failed',
      `Nieznana operacja odczytu "${source.operation}". Dostepne: ${available.join(', ') || 'brak'}.`,
      { reason: 'unknown_operation' satisfies ReadRefusal, operation: source.operation, available },
    );
  }
  const unresolved = options.unresolvedInputKeys ?? [];
  const declaredKeys = Object.keys(entry.definition.inputSchema.shape ?? {});
  const input = entry.definition.inputSchema.safeParse(source.input ?? {});
  const issues = [
    ...unresolved
      .filter((key) => !declaredKeys.includes(key))
      .map((key) => ({ path: key, message: `Operacja nie przyjmuje wejscia ${key}.` })),
    ...(input.success ? [] : input.error.issues)
      .filter((i) => !unresolved.includes(String(i.path[0])))
      .map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
  ];
  if (issues.length > 0) {
    throw new AppError(
      'validation_failed',
      `Wejscie operacji ${source.operation} nie przechodzi walidacji: ${issues
        .map((i) => `${i.path}: ${i.message}`)
        .join('; ')}`,
      { reason: 'invalid_input' satisfies ReadRefusal, operation: source.operation, issues },
    );
  }
  return { source, entry, input: unresolved.length > 0 ? undefined : input.data };
}

/** The refusal kind of an error thrown by {@link prepareRead}, if it is one. */
export function readRefusalOf(err: unknown): ReadRefusal | null {
  if (!(err instanceof AppError)) return null;
  const reason = (err.details as { reason?: unknown } | undefined)?.reason;
  return reason === 'invalid_source' || reason === 'unknown_operation' || reason === 'invalid_input'
    ? reason
    : null;
}

/**
 * Runs a prepared read as `ownerId`.
 *
 * The owner comes from the authenticated caller, never from the source, so a
 * descriptor cannot be made to read somebody else's data; the module's service
 * refuses with `forbidden` / `not_found`, which propagate unchanged. A result
 * that does not match the declared descriptor fails here, at the source,
 * rather than as an empty table in the browser.
 */
export async function runPreparedRead(prepared: PreparedRead, ownerId: string): Promise<ReadResponse> {
  const result = await prepared.entry.definition.run(prepared.input as never, { ownerId });
  const descriptor = prepared.entry.definition.result ?? null;
  if (descriptor) recordsOf(result, descriptor);
  return {
    operation: prepared.source.operation,
    result,
    descriptor,
    resolvedAt: nowIso(),
  };
}

/** Prepare and run in one step. */
export async function runRead(
  registry: ServerModuleRegistry | null,
  raw: unknown,
  ownerId: string,
): Promise<ReadResponse> {
  return runPreparedRead(prepareRead(registry, raw), ownerId);
}

/**
 * Every registered read as a consumer needs to know it: name, purpose, input
 * keys and result descriptor. The HTTP listing and the agent's prompt both
 * take it from here.
 */
export function describeReadOperations(registry: ServerModuleRegistry): ReadOperationSummary[] {
  return registry.readOperations.map((op) => ({
    name: op.qualifiedName,
    description: op.definition.description,
    inputKeys: Object.keys(op.definition.inputSchema.shape ?? {}),
    descriptor: op.definition.result ?? null,
  }));
}
