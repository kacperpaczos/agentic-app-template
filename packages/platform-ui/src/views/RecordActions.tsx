import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AppError,
  formatFieldValue,
  parseFieldInput,
  recordIdOf,
  type DataRecord,
  type DataSource,
  type ReadResultDescriptor,
  type RecordAction,
  type RecordActionRequest,
  type RecordActionResponse,
} from '@platform/contracts';
import { apiPost } from '../api/client.ts';
import { invalidateAfterDataChange, invalidateBusinessData } from '../api/queries.ts';

/**
 * Record actions in a data table: a button per action on each row, a small
 * form in the row, and what came of it.
 *
 * The actions are the read's own (`descriptor.actions`), so every table over
 * the read — a module's screen, an agent's view, a table in the chat — offers
 * the same ones and performs them the same way: `POST /api/actions` with the
 * table's read and input, the record's id and the values as typed. The server
 * re-reads the record as the session's owner and runs the module's write tool
 * through the execution the MCP server uses; the browser only asks.
 *
 * **What the screen may claim afterwards.** A saved change refreshes what a
 * tool's `data_changed` refreshes (`invalidateAfterDataChange`), so this
 * table, a chart over the same data and the same read in any other view
 * refetch; while they do, the frame says it is refreshing rather than
 * presenting the previous numbers as current. A refusal says why, in words and
 * with its code. A refusal that can mean the rows on screen are no longer what
 * the backend has — no access, no such record, a conflicting change —
 * refreshes the reads (`invalidateBusinessData`: nothing else changed), so the
 * table shows the backend's answer instead of the rows the action was refused
 * on.
 */

/** Refusals after which the rows on screen are known to be unchanged. */
const DATA_UNCHANGED = new Set(['validation_failed', 'domain_rule_violated']);

type Target = { recordId: string; actionId: string; operationId: string };
type Outcome =
  | { kind: 'done'; recordId: string; actionId: string; message: string }
  | { kind: 'failed'; recordId: string; actionId: string; error: AppError };

export interface RecordActionsController {
  actions: RecordAction[];
  open: Target | null;
  outcome: Outcome | null;
  pending: boolean;
  start: (recordId: string, actionId: string) => void;
  cancel: () => void;
  submit: (values: Record<string, string>) => void;
}

const newOperationId = () => `action-${crypto.randomUUID()}`;

/** How a record is named next to an action: its title field, else its first displayed value. */
export function recordNameOf(record: DataRecord, descriptor: ReadResultDescriptor): string {
  const field =
    descriptor.fields.find((f) => f.field === descriptor.record.titleField) ?? descriptor.fields[0];
  return field ? formatFieldValue(record, field) : (recordIdOf(record, descriptor) ?? '');
}

export function useRecordActions(
  source: DataSource,
  descriptor: ReadResultDescriptor | null | undefined,
): RecordActionsController {
  const qc = useQueryClient();
  const actions = descriptor?.actions ?? [];
  const [open, setOpen] = useState<Target | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const mutation = useMutation({
    mutationFn: (request: RecordActionRequest) => apiPost<RecordActionResponse>('/api/actions', request),
  });

  const submit = (values: Record<string, string>) => {
    if (!open || mutation.isPending) return;
    const target = open;
    const action = actions.find((a) => a.id === target.actionId);
    if (!action) return;
    const failed = (error: unknown) =>
      setOutcome({ kind: 'failed', recordId: target.recordId, actionId: target.actionId, error: AppError.from(error) });

    // The server parses the values again and decides; checking here only
    // spares a request the server would refuse with the same words.
    try {
      for (const field of action.form ?? []) parseFieldInput(values[field.key] ?? '', field);
    } catch (e) {
      failed(e);
      return;
    }

    setOutcome(null);
    mutation.mutate(
      {
        operation: source.operation,
        input: source.input,
        action: action.id,
        recordId: target.recordId,
        values,
        // Kept for the life of the form: resubmitting after a lost answer
        // returns the first outcome instead of changing the data again.
        operationId: target.operationId,
      },
      {
        onSuccess: () => {
          setOpen(null);
          setOutcome({
            kind: 'done',
            recordId: target.recordId,
            actionId: target.actionId,
            message: `${action.label}: zapisano. Dane sa ponownie wczytywane z backendu.`,
          });
          // A saved change is a data change like a tool's `data_changed`.
          invalidateAfterDataChange(qc);
        },
        onError: (error) => {
          failed(error);
          if (!(error instanceof AppError && DATA_UNCHANGED.has(error.code))) invalidateBusinessData(qc);
        },
      },
    );
  };

  return {
    actions,
    open,
    outcome,
    pending: mutation.isPending,
    start: (recordId, actionId) => {
      if (mutation.isPending) return;
      setOutcome(null);
      setOpen({ recordId, actionId, operationId: newOperationId() });
    },
    cancel: () => {
      if (mutation.isPending) return;
      setOpen(null);
      setOutcome(null);
    },
    submit,
  };
}

/** Header of the actions column; nothing when the read declares no actions. */
export function RecordActionsHeader({ controller }: { controller: RecordActionsController }) {
  if (controller.actions.length === 0) return null;
  return (
    <th scope="col" className="pf-table__actions">
      Akcje
    </th>
  );
}

/** One row's actions: its buttons, or the form of the action being performed on it. */
export function RecordActionCell(props: {
  controller: RecordActionsController;
  record: DataRecord;
  descriptor: ReadResultDescriptor;
}) {
  const { controller, record, descriptor } = props;
  const recordId = recordIdOf(record, descriptor);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const openHere = controller.open && controller.open.recordId === recordId ? controller.open : null;
  const wasOpen = useRef<string | null>(null);

  const noFormOpen = controller.open === null;
  // Closing the form returns the focus to the button that opened it — unless
  // another row's form took over, which has the focus now.
  useEffect(() => {
    if (!openHere && wasOpen.current && noFormOpen) buttons.current.get(wasOpen.current)?.focus();
    wasOpen.current = openHere?.actionId ?? null;
  }, [openHere?.actionId, noFormOpen]);

  if (controller.actions.length === 0) return null;
  const cell = (children: ReactNode) => (
    <td className="pf-table__actions">{children}</td>
  );
  if (!recordId) return cell(null);

  const action = openHere ? controller.actions.find((a) => a.id === openHere.actionId) : undefined;
  if (openHere && action) {
    const failure =
      controller.outcome?.kind === 'failed' &&
      controller.outcome.recordId === recordId &&
      controller.outcome.actionId === action.id
        ? controller.outcome.error
        : null;
    return cell(
      <RecordActionForm
        key={openHere.operationId}
        action={action}
        recordId={recordId}
        recordName={recordNameOf(record, descriptor)}
        pending={controller.pending}
        error={failure}
        onSubmit={controller.submit}
        onCancel={controller.cancel}
      />,
    );
  }

  const name = recordNameOf(record, descriptor);
  return cell(
    <div className="pf-record-action__buttons">
      {controller.actions.map((a) => (
        <button
          key={a.id}
          ref={(el) => {
            if (el) buttons.current.set(a.id, el);
            else buttons.current.delete(a.id);
          }}
          type="button"
          className="pf-btn pf-btn--tiny"
          data-record-action={a.id}
          aria-label={`${a.label}: ${name}`}
          disabled={controller.pending}
          onClick={() => controller.start(recordId, a.id)}
        >
          {a.label}
        </button>
      ))}
    </div>,
  );
}

function RecordActionForm(props: {
  action: RecordAction;
  recordId: string;
  recordName: string;
  pending: boolean;
  error: AppError | null;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const { action, pending, error } = props;
  const baseId = useId();
  const fields = action.form ?? [];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, ''])),
  );
  const errorId = `${baseId}-error`;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    props.onSubmit(values);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onCancel();
    }
  };

  return (
    <form
      className="pf-record-action"
      data-testid="record-action-form"
      data-record-action={action.id}
      data-record-id={props.recordId}
      aria-label={`${action.label}: ${props.recordName}`}
      aria-busy={pending || undefined}
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
    >
      {fields.map((f, i) => (
        <div key={f.key} className="pf-record-action__field">
          <label htmlFor={`${baseId}-${f.key}`}>{f.label}</label>
          <input
            id={`${baseId}-${f.key}`}
            name={f.key}
            type="text"
            inputMode={f.type === 'text' ? 'text' : 'decimal'}
            autoComplete="off"
            autoFocus={i === 0}
            value={values[f.key] ?? ''}
            disabled={pending}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        </div>
      ))}
      <div className="pf-record-action__buttons">
        <button type="submit" className="pf-btn pf-btn--primary pf-btn--tiny" disabled={pending} autoFocus={fields.length === 0}>
          {pending ? 'Zapisywanie…' : fields.length === 0 ? `Potwierdz: ${action.label}` : 'Zapisz'}
        </button>
        <button type="button" className="pf-btn pf-btn--tiny" disabled={pending} onClick={props.onCancel}>
          Anuluj
        </button>
      </div>
      {error && <RecordActionError id={errorId} error={error} />}
    </form>
  );
}

function RecordActionError({ error, id }: { error: AppError; id?: string }) {
  return (
    <div
      id={id}
      className="pf-state pf-state--error pf-record-action__error"
      role="alert"
      data-testid="record-action-error"
      data-error-code={error.code}
    >
      {error.message}
    </div>
  );
}

/**
 * The last outcome, above the table: a saved change, or a refusal whose form
 * is no longer on screen (the table itself failed, or the record is gone from
 * it) — a refusal must stay readable after the rows it was about disappear.
 */
export function RecordActionStatus(props: { controller: RecordActionsController; formShown: boolean }) {
  const { outcome } = props.controller;
  if (!outcome) return null;
  if (outcome.kind === 'done') {
    return (
      <p className="pf-record-action__status" role="status" data-testid="record-action-status" data-record-id={outcome.recordId}>
        {outcome.message}
      </p>
    );
  }
  return props.formShown ? null : <RecordActionError error={outcome.error} />;
}
