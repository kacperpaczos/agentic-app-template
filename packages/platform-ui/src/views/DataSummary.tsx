import {
  formatFieldValue,
  recordIdOf,
  recordRouteOf,
  type DataSummaryProps,
} from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { useDescribeInstance } from '../state/uiSemantics.ts';
import { DataFrame, EmptyBody, FailureBody, LoadingBody } from './DataFrame.tsx';
import { buildDataModel, describeDataInstance } from './model.ts';
import { useDataModel } from './useDataModel.ts';
import { useComposedView, useInstanceId } from './viewContext.ts';

/** More records than this are counted, not listed: a summary is not a table. */
const SUMMARY_RECORDS_LIMIT = 20;

/**
 * Key facts of the records one registered read returns, as label–value pairs.
 *
 * Shows stored values only, formatted as everywhere else. It computes nothing:
 * a total or an average belongs to the backend, which is the only place that
 * knows how an amount is allowed to be added up.
 */
export function DataSummaryView(props: DataSummaryProps) {
  const instanceId = useInstanceId('DataSummary');
  const view = useComposedView();

  const { state, model, error, response } = useDataModel(
    props.source,
    (response) => buildDataModel({ response, fieldNames: props.fields }),
    [JSON.stringify(props.fields)],
  );

  const shownState = model && model.records.length === 0 ? 'empty' : state;
  useDescribeInstance(
    describeDataInstance({
      instanceId,
      component: 'DataSummary',
      viewId: view?.viewId ?? null,
      source: props.source,
      state: shownState,
      // The whole model: `matched` counts every record, `visibleLimit` only
      // bounds which of them are listed as on screen.
      model,
      visibleLimit: SUMMARY_RECORDS_LIMIT,
      descriptor: response?.descriptor,
      fieldNames: props.fields,
      error,
      actions: model?.descriptor.record.route ? ['open_record'] : [],
    }),
  );

  const frame = { instanceId, component: 'DataSummary', operation: props.source.operation, title: props.title };
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
        <EmptyBody total={model.total} matched={0} />
      </DataFrame>
    );
  }

  const { descriptor } = model;
  const shown = model.records.slice(0, SUMMARY_RECORDS_LIMIT);
  return (
    <DataFrame {...frame} state="ready">
      {shown.map((record, index) => {
        const id = recordIdOf(record, descriptor);
        const href = recordRouteOf(record, descriptor);
        return (
          <dl
            key={id ?? `record-${index}`}
            className="pf-kv pf-data__record"
            data-record-kind={descriptor.record.kind}
            data-record-id={id ?? undefined}
          >
            {model.fields.map((f) => (
              <div key={f.field} className="pf-data__pair">
                <dt>{f.label}</dt>
                <dd data-record-kind={descriptor.record.kind} data-record-id={id ?? undefined} data-field={f.field}>
                  {href && f.field === descriptor.record.titleField ? (
                    <Link to={href as never} className="pf-link" data-record-link="">
                      {formatFieldValue(record, f)}
                    </Link>
                  ) : (
                    formatFieldValue(record, f)
                  )}
                </dd>
              </div>
            ))}
          </dl>
        );
      })}
      {model.records.length > shown.length && (
        <div className="pf-muted">i {model.records.length - shown.length} kolejnych rekordow</div>
      )}
    </DataFrame>
  );
}
