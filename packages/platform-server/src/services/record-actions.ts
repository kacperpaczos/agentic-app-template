import {
  AppError,
  EMPTY_APP_CONTEXT,
  recordActionRequestSchema,
  recordIdOf,
  recordsOf,
  stableJson,
  type RecordActionResponse,
  type ToolCallContext,
} from '@platform/contracts';
import { executeTool } from '../registry/tool-execution.ts';
import type { ServerModuleRegistry } from '../registry/modules.ts';
import { prepareRead, runPreparedRead } from '../registry/read-operations.ts';
import {
  ACTION_OPERATION_ID_KEY,
  buildActionInput,
  parseActionValues,
} from '../registry/record-actions.ts';
import type { IdempotencyStore } from './idempotency.ts';

/** Replay scope of record actions in the idempotency store. */
export const RECORD_ACTION_SCOPE = 'platform.recordAction';

interface StoredOutcome {
  request: string;
  result: unknown;
  changed: string[];
}

/**
 * Performs a record action a user started from a table (`POST /api/actions`).
 *
 * The steps, in order, and why each is here:
 *
 *  1. The read named by the request is resolved exactly as `POST /api/read`
 *     resolves it (`prepareRead`), and the action is looked up in *its*
 *     descriptor — a request cannot pair a read with an action it does not
 *     declare.
 *  2. Form values are parsed by their declared types before anything runs.
 *  3. Under the request's `operationId` (the owner's replay guard), the record
 *     is re-read through the same read as the session's owner. A read the
 *     owner may not run fails with the module's own `forbidden` / `not_found`;
 *     a record the read does not return is `not_found`. Nothing has changed.
 *  4. The tool's input is built from that record and the form, and the tool of
 *     the module that owns the read runs through `executeTool` — the call the
 *     MCP server makes — with a context carrying the owner and no run. What
 *     the tool reports as changed (`data_changed`) is returned, for the
 *     browser to refresh by; there is no stream to put it on.
 *
 * A repeated `operationId` returns the first outcome. One reused for a
 * different request is a `conflict`, not the first request's answer.
 */
export async function performRecordAction(
  deps: { registry: ServerModuleRegistry; idempotency: IdempotencyStore },
  raw: unknown,
  ownerId: string,
): Promise<RecordActionResponse> {
  const parsed = recordActionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('validation_failed', 'Nieprawidlowe zadanie akcji rekordu.', {
      reason: 'invalid_request',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const request = parsed.data;
  const prepared = prepareRead(deps.registry, { operation: request.operation, input: request.input });
  const descriptor = prepared.entry.definition.result;
  const actions = descriptor?.actions ?? [];
  const action = actions.find((a) => a.id === request.action);
  if (!descriptor || !action) {
    throw new AppError(
      'validation_failed',
      `Operacja ${request.operation} nie deklaruje akcji rekordu "${request.action}". ` +
        `Dostepne: ${actions.map((a) => a.id).join(', ') || 'brak'}.`,
      { reason: 'unknown_action', available: actions.map((a) => a.id) },
    );
  }
  const tool = deps.registry.tool(`${prepared.entry.moduleId}_${action.tool}`);
  if (!tool) {
    // Checked when the module registered; reaching this is a platform defect.
    throw new AppError('internal', `Akcja ${action.id}: brak narzedzia ${action.tool} modulu ${prepared.entry.moduleId}.`);
  }
  const values = parseActionValues(action, request.values ?? {});
  const fingerprint = stableJson({
    operation: request.operation,
    input: prepared.source.input ?? {},
    action: action.id,
    recordId: request.recordId,
    values: request.values ?? {},
  });

  const { result: outcome, replayed } = await deps.idempotency.once<StoredOutcome>(
    request.operationId,
    ownerId,
    RECORD_ACTION_SCOPE,
    async () => {
      const read = await runPreparedRead(prepared, ownerId);
      const record = recordsOf(read.result, descriptor).find((r) => recordIdOf(r, descriptor) === request.recordId);
      if (!record) {
        throw new AppError(
          'not_found',
          `Rekord ${descriptor.record.kind} ${request.recordId} nie wystepuje w odczycie ${request.operation}.`,
          { reason: 'record_not_found' },
        );
      }
      const input = buildActionInput(action, record, values);
      if (ACTION_OPERATION_ID_KEY in tool.definition.inputSchema.shape) {
        input[ACTION_OPERATION_ID_KEY] = request.operationId;
      }

      const changed = new Set<string>();
      const ctx: ToolCallContext = {
        ownerId,
        appContext: EMPTY_APP_CONTEXT,
        conversationId: null,
        runId: null,
        workspaceDir: null,
        emit: (event) => {
          if (event.type === 'data_changed') for (const r of event.resources) changed.add(r);
        },
      };
      const result = await executeTool({ localName: tool.qualifiedName, def: tool.definition }, input, ctx);
      return { request: fingerprint, result, changed: [...changed] };
    },
  );

  if (replayed && outcome.request !== fingerprint) {
    /*
     * The identifier belongs to an attempt that was performed — saying "nothing
     * changed" without saying that would read as "your earlier change did not
     * happen".
     */
    throw new AppError(
      'conflict',
      `operationId ${request.operationId} zostal juz uzyty dla innej akcji lub innych wartosci — tamta zmiana ` +
        'zostala wykonana. Tym zadaniem nie zmieniono nic; odczytaj rekord ponownie i powtorz zmiane z nowym operationId.',
      { reason: 'operation_id_reused' },
    );
  }
  return {
    operation: request.operation,
    action: action.id,
    recordId: request.recordId,
    result: outcome.result,
    changed: outcome.changed,
    replayed,
  };
}
