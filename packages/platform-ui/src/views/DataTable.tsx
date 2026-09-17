import { useEffect } from 'react';
import { Link } from '@tanstack/react-router';
import {
  formatFieldValue,
  isNumericField,
  recordIdOf,
  recordRouteOf,
  type DataRecord,
  type DataTableProps,
  type ReadResultDescriptor,
  type RecordField,
} from '@platform/contracts';
import { useUiTargets } from '../api/queries.ts';
import { useAppState } from '../state/appState.ts';
import { useDescribeInstance } from '../state/uiSemantics.ts';
import { useActiveViewFilter } from '../state/viewFilter.ts';
import { DataFrame, EmptyBody, FailureBody, LoadingBody } from './DataFrame.tsx';
import { withGrouping } from './grouping.ts';
import { buildDataModel, describeDataInstance } from './model.ts';
import { useDataModel } from './useDataModel.ts';
import { useComposedView, useInstanceId } from './viewContext.ts';

/**
 * A table over one registered read.
 *
 * Columns, labels and formatting come from the read's descriptor; a column the
 * descriptor does not declare is refused by name. Rows and cells carry the
 * record and field they show (`data-record-kind`, `data-record-id`,
 * `data-field`), so a record's value on screen can be found by what it is
 * rather than by where it happens to be drawn.
 *
 * **Narrowing.** Inside a module view, the instance reading the view's
 * `primaryOperation` is the view's primary instance: the address bar's
 * narrowing of the view's target applies to it, and it reports what it counted
 * to the banner and to the agent — the same rule and the same report as a
 * module screen reading its own route (`applyViewFilter`). Any other table,
 * including one in a card or the chat, applies only its composition's `filter`.
 *
 * `pageSize` is accepted and not yet applied: every matching row is shown.
 * Paging belongs with the address-bar state that makes it undoable.
 */
export function DataTableView(props: DataTableProps) {
  const instanceId = useInstanceId('DataTable');
  const view = useComposedView();
  const active = useActiveViewFilter();
  const targets = useUiTargets();
  const reportFilterOutcome = useAppState((s) => s.reportFilterOutcome);

  const primary = Boolean(view && view.primaryOperation === props.source.operation);
  const narrowing = primary && active && active.targetId === view!.viewId ? active : null;

  const { state, model, error, response } = useDataModel(
    props.source,
    (response) =>
      withGrouping(
        buildDataModel({
          response,
          fieldNames: props.columns,
          filter: props.filter,
          sort: props.sort,
          narrowing,
        }),
        props.groupBy,
      ),
    // The renderer re-evaluates props on every render; compare them by value.
    [JSON.stringify([props.columns, props.filter, props.sort, props.groupBy]), narrowing],
  );

  const outcome = model?.outcome ?? null;
  useEffect(() => {
    if (outcome) reportFilterOutcome(outcome);
  }, [outcome, reportFilterOutcome]);

  const filterable = primary && Boolean(targets.data?.find((t) => t.id === view!.viewId)?.filter);
  const shownState = model && model.records.length === 0 ? 'empty' : state;
  useDescribeInstance(
    describeDataInstance({
      instanceId,
      component: 'DataTable',
      viewId: view?.viewId ?? null,
      source: props.source,
      state: shownState,
      model,
      descriptor: response?.descriptor,
      fieldNames: props.columns,
      filter: [...(props.filter ?? []), ...(narrowing?.predicates ?? [])],
      sort: props.sort ?? null,
      error,
      actions: model
        ? [...(filterable ? ['filter'] : []), ...(model.descriptor.record.route ? ['open_record'] : [])]
        : [],
    }),
  );

  const frame = { instanceId, component: 'DataTable', operation: props.source.operation, title: props.title };
  if (state === 'loading') return <DataFrame {...frame} state="loading"><LoadingBody /></DataFrame>;
  if (!model) {
    return (
      <DataFrame {...frame} state={state === 'forbidden' ? 'forbidden' : 'error'}>
        <FailureBody error={error} />
      </DataFrame>
    );
  }
  if (shownState === 'empty') {
    return (
      <DataFrame {...frame} state="empty">
        <EmptyBody total={outcome?.total ?? model.total} matched={0} />
      </DataFrame>
    );
  }

  const { descriptor } = model;
  const linkField = linkColumn(descriptor, model.fields);

  const renderRow = (record: DataRecord, index: number) => {
    const id = recordIdOf(record, descriptor);
    return (
      <tr
        key={id ?? `row-${index}`}
        data-record-kind={descriptor.record.kind}
        data-record-id={id ?? undefined}
      >
        {model.fields.map((f) => (
          <td
            key={f.field}
            className={isNumericField(f) ? 'pf-num' : undefined}
            data-record-kind={descriptor.record.kind}
            data-record-id={id ?? undefined}
            data-field={f.field}
          >
            {f.field === linkField ? (
              <RecordLink record={record} descriptor={descriptor} field={f} id={id} />
            ) : (
              formatFieldValue(record, f)
            )}
          </td>
        ))}
      </tr>
    );
  };

  return (
    <DataFrame {...frame} state="ready">
      <table className="pf-table">
        <thead>
          <tr>
            {model.fields.map((f) => (
              <th key={f.field} scope="col" data-field={f.field}>
                {f.label}
              </th>
            ))}
          </tr>
        </thead>
        {model.grouping ? (
          /*
           * One body per group, headed by the value and its count. The rows are
           * the same rows as ungrouped — same attributes, same cells.
           */
          model.grouping.groups.map((group) => (
            <tbody key={group.key} data-group-field={model.grouping!.field.field} data-group-key={group.key}>
              <tr className="pf-table__group">
                <th colSpan={model.fields.length} scope="rowgroup">
                  {model.grouping!.field.label}: {group.label}{' '}
                  <span className="pf-muted" data-group-count={group.records.length}>
                    ({group.records.length})
                  </span>
                </th>
              </tr>
              {group.records.map((record, index) => renderRow(record, index))}
            </tbody>
          ))
        ) : (
          <tbody>{model.records.map((record, index) => renderRow(record, index))}</tbody>
        )}
      </table>
    </DataFrame>
  );
}

/** The column that opens a record: its title field when shown, else the first column. */
function linkColumn(descriptor: ReadResultDescriptor, fields: RecordField[]): string | null {
  if (!descriptor.record.route) return null;
  const title = descriptor.record.titleField;
  if (title && fields.some((f) => f.field === title)) return title;
  return fields[0]?.field ?? null;
}

function RecordLink(props: {
  record: DataRecord;
  descriptor: ReadResultDescriptor;
  field: RecordField;
  id: string | null;
}) {
  const text = formatFieldValue(props.record, props.field);
  const href = recordRouteOf(props.record, props.descriptor);
  if (!href) return <>{text}</>;
  const kind = props.descriptor.record.kind;
  return (
    <Link
      to={href as never}
      className="pf-link"
      data-record-link=""
      /*
       * `<kind>-tile-<id>` is the name the browser suites already use to open a
       * record from its list (it dates from when lists were tiles). Kept, and
       * derived from the opaque kind, so those suites address the composed list
       * without edits; new code should use `data-record-link` with
       * `data-record-kind` / `data-record-id`.
       */
      data-testid={props.id ? `${kind}-tile-${props.id}` : undefined}
    >
      {text}
    </Link>
  );
}
