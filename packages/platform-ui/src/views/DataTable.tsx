import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  formatFieldValue,
  isNumericField,
  isSortableField,
  recordIdOf,
  recordRouteOf,
  type DataRecord,
  type DataTableProps,
  type ReadResultDescriptor,
  type RecordField,
} from '@platform/contracts';
import { useAppState, type ViewStateReport } from '../state/appState.ts';
import { useDescribeInstance } from '../state/uiSemantics.ts';
import { useViewAddress } from '../state/viewFilter.ts';
import { DataFrame, EmptyBody, FailureBody, LoadingBody } from './DataFrame.tsx';
import { FilterBar, HeaderCell, Pager, nextSort } from './DataTableControls.tsx';
import { RecordActionCell, RecordActionStatus, RecordActionsHeader, useRecordActions } from './RecordActions.tsx';
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
 * **The view's state.** Inside a module view, the instance reading the view's
 * `primaryOperation` is the view's primary instance. On the view's own screen
 * the address bar's narrowing, order (`sort`) and page (`page`) apply to it,
 * and it shows the controls that change them — the same address the agent's
 * commands change. It reports what it applied and counted: the narrowing's
 * outcome to the banner (`reportFilterOutcome`, as a module screen reading its
 * own route does), and its whole state to `viewStates`, which the banner, the
 * acknowledgement of an agent's command and the next command's context read.
 *
 * Any other table — in a card, in the chat — applies only its composition's
 * `filter` and `sort`, and pages in memory: it has no address of its own.
 *
 * **Grouping.** `groupBy` shows the rows of the page on screen in groups by one
 * declared field, each under a heading with its value, the number of its rows
 * on this page and — when the page shows only part of the group — how many
 * the whole matched set has (`grouping.ts`). Groups follow the rows, not the
 * other way round: paging and order stay exactly as without grouping, so the
 * page, the pager and the semantic description (which lists the page's rows)
 * keep describing the same records.
 */
export function DataTableView(props: DataTableProps) {
  const instanceId = useInstanceId('DataTable');
  const view = useComposedView();
  const reportFilterOutcome = useAppState((s) => s.reportFilterOutcome);
  const reportViewState = useAppState((s) => s.reportViewState);
  const dropViewState = useAppState((s) => s.dropViewState);

  const primary = Boolean(view && view.primaryOperation === props.source.operation);
  const address = useViewAddress(primary ? view!.viewId : null);
  const [localPage, setLocalPage] = useState(1);
  const narrowing =
    address && address.predicates.length > 0 ? { targetId: address.targetId, predicates: address.predicates } : null;

  const { state, model, error, response, refreshing } = useDataModel(
    props.source,
    (response) =>
      withGrouping(
        buildDataModel({
          response,
          fieldNames: props.columns,
          filter: props.filter,
          sort: props.sort,
          narrowing,
          addressSort: address?.sort ?? null,
          pageSize: props.pageSize,
          page: address ? address.page : localPage,
        }),
        props.groupBy,
      ),
    // The renderer re-evaluates props on every render; compare them by value.
    [
      JSON.stringify([props.columns, props.filter, props.sort, props.pageSize, props.groupBy]),
      address ? `${address.targetId}|${address.key}` : null,
      localPage,
    ],
  );

  const outcome = model?.outcome ?? null;
  useEffect(() => {
    if (outcome) reportFilterOutcome(outcome);
  }, [outcome, reportFilterOutcome]);

  const report: ViewStateReport | null =
    address && model
      ? {
          targetId: address.targetId,
          instanceId,
          address: address.key,
          predicates: address.predicates,
          sort: model.sort,
          sortLabel: model.sort ? (model.descriptor.fields.find((f) => f.field === model.sort!.field)?.label ?? null) : null,
          sortFromAddress: model.sortFromAddress,
          rejectedSort: model.rejectedSort,
          page: model.page ? { index: model.page.index, size: model.page.size, count: model.page.count } : null,
          clampedFrom: model.page?.clamped ? model.page.requested : null,
          matched: model.records.length,
          total: model.baseCount,
        }
      : null;
  const reportKey = report ? JSON.stringify(report) : null;
  useEffect(() => {
    if (!report) return;
    reportViewState(report);
    return () => dropViewState(report.targetId, report.instanceId);
    // `reportKey` is the value of `report`.
  }, [reportKey, reportViewState, dropViewState]);

  // The read's own record actions (`RecordActions.tsx`): the same in every table over it.
  const recordActions = useRecordActions(props.source, response?.descriptor);

  const filterable = Boolean(address && address.filterFields.length > 0);
  const sortable = Boolean(address && model?.descriptor.fields.some(isSortableField));
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
        ? [
            ...(filterable ? ['filter'] : []),
            ...(sortable ? ['sort'] : []),
            ...(model.page && model.page.count > 1 ? ['page'] : []),
            ...(model.descriptor.record.route ? ['open_record'] : []),
            ...recordActions.actions.map((a) => `action:${a.id}`),
          ]
        : [],
    }),
  );

  const frame = { instanceId, component: 'DataTable', operation: props.source.operation, title: props.title, refreshing };
  if (state === 'loading') return <DataFrame {...frame} state="loading"><LoadingBody /></DataFrame>;
  if (!model) {
    return (
      <DataFrame {...frame} state={state === 'forbidden' ? 'forbidden' : 'error'}>
        <RecordActionStatus controller={recordActions} formShown={false} refreshing={refreshing} />
        <FailureBody error={error} />
      </DataFrame>
    );
  }

  const { descriptor } = model;
  const linkField = linkColumn(descriptor, model.fields);
  const onSort = address
    ? (field: string) => address.change({ sort: nextSort(model.sort, model.sortFromAddress, field) })
    : null;
  const onPage = address ? (index: number) => address.change({ page: index }) : setLocalPage;

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
        <RecordActionCell controller={recordActions} record={record} descriptor={descriptor} />
      </tr>
    );
  };

  // A refusal is shown in its form while the form is on screen, above the table otherwise.
  const formShown = Boolean(
    shownState !== 'empty' &&
      recordActions.open &&
      model.shown.some((r) => recordIdOf(r, descriptor) === recordActions.open!.recordId),
  );
  const columnCount = model.fields.length + (recordActions.actions.length > 0 ? 1 : 0);

  /*
   * One frame for the ready and the empty state, with the controls at the same
   * place in both: narrowing to nothing must leave the user the fields to
   * change it with, and pressing "Apply" must not move the focus away.
   */
  return (
    <DataFrame {...frame} state={shownState === 'empty' ? 'empty' : 'ready'}>
      {address && filterable && (
        <FilterBar
          fields={address.filterFields}
          predicates={address.predicates}
          onApply={(predicates) => address.change({ predicates })}
        />
      )}
      <RecordActionStatus controller={recordActions} formShown={formShown} refreshing={refreshing} />
      {shownState === 'empty' ? (
        <EmptyBody total={outcome?.total ?? model.total} matched={0} />
      ) : (
        <table className="pf-table">
          <thead>
            <tr>
              {model.fields.map((f) => (
                <HeaderCell key={f.field} field={f} sortable={isSortableField(f)} sort={model.sort} onSort={onSort} />
              ))}
              <RecordActionsHeader controller={recordActions} />
            </tr>
          </thead>
          {model.grouping ? (
            /*
             * One body per group of the page's rows, headed by the value and its
             * count. The rows are the same rows as ungrouped — same attributes,
             * same cells.
             */
            model.grouping.groups.map((group) => (
              <tbody key={group.key} data-group-field={model.grouping!.field.field} data-group-key={group.key}>
                <tr className="pf-table__group">
                  <th colSpan={columnCount} scope="rowgroup">
                    {model.grouping!.field.label}: {group.label}{' '}
                    <span
                      className="pf-muted"
                      data-group-count={group.records.length}
                      data-group-total={group.total}
                    >
                      ({group.records.length}
                      {group.total !== group.records.length ? ` z ${group.total}` : ''})
                    </span>
                  </th>
                </tr>
                {group.records.map((record, index) => renderRow(record, index))}
              </tbody>
            ))
          ) : (
            <tbody>{model.shown.map((record, index) => renderRow(record, index))}</tbody>
          )}
        </table>
      )}
      {model.page && (model.page.count > 1 || model.page.clamped) && (
        <Pager page={model.page} onPage={onPage} />
      )}
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
