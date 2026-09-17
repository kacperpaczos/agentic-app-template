import { BarChartCondensed, LineChartCondensed, PieChart } from '@openuidev/react-ui';
import type { DataChartProps } from '@platform/contracts';
import { useDescribeInstance } from '../state/uiSemantics.ts';
import { DataFrame, EmptyBody, FailureBody, LoadingBody } from './DataFrame.tsx';
import { buildChartModel, buildDataModel, describeDataInstance, type ChartModel } from './model.ts';
import { useDataModel } from './useDataModel.ts';
import { useComposedView, useInstanceId } from './viewContext.ts';

const KIND_LABEL: Record<DataChartProps['kind'], string> = {
  bar: 'Wykres slupkowy',
  line: 'Wykres liniowy',
  pie: 'Wykres kolowy',
};

/**
 * A chart over one registered read, drawn by the catalog's ready-made charts.
 *
 * Categories come from `x`, series from numeric fields of the descriptor, in
 * display units (whole currency units, units rather than thousandths). The
 * caption states what the picture shows in words — each series with its unit
 * and its smallest and largest value, formatted exactly as a table cell would
 * be — so the chart can be read without seeing it and checked against the
 * backend without measuring bars.
 *
 * Never draws a composition's literal numbers: there is no prop to pass them.
 */
export function DataChartView(props: DataChartProps) {
  const instanceId = useInstanceId('DataChart');
  const view = useComposedView();

  const { state, model, error, response } = useDataModel(
    props.source,
    (response) => {
      const data = buildDataModel({
        response,
        fieldNames: [props.x, ...props.series],
        filter: props.filter,
        sort: props.sort,
      });
      return { data, chart: buildChartModel(data, props.x, props.series) };
    },
    [JSON.stringify([props.x, props.series, props.filter, props.sort])],
  );

  const shownState = model && model.data.records.length === 0 ? 'empty' : state;
  useDescribeInstance(
    describeDataInstance({
      instanceId,
      component: 'DataChart',
      viewId: view?.viewId ?? null,
      source: props.source,
      state: shownState,
      model: model?.data,
      descriptor: response?.descriptor,
      fieldNames: [props.x, ...props.series],
      filter: props.filter,
      sort: props.sort ?? null,
      error,
      actions: [],
    }),
  );

  const frame = {
    instanceId,
    component: 'DataChart',
    operation: props.source.operation,
    title: props.title,
    as: 'figure' as const,
  };
  const heading = props.title ? <div className="pf-data__title">{props.title}</div> : null;

  if (state === 'loading') {
    return (
      <DataFrame {...frame} state="loading">
        {heading}
        <LoadingBody />
      </DataFrame>
    );
  }
  if (!model) {
    return (
      <DataFrame {...frame} state={state === 'forbidden' ? 'forbidden' : 'error'}>
        {heading}
        <FailureBody error={error} />
      </DataFrame>
    );
  }
  if (shownState === 'empty') {
    return (
      <DataFrame {...frame} state="empty">
        {heading}
        <EmptyBody total={model.data.total} matched={0} />
      </DataFrame>
    );
  }

  return (
    <DataFrame {...frame} state="ready">
      {heading}
      <div className="pf-data__chart" aria-hidden="true">
        <ChartBody kind={props.kind} chart={model.chart} />
      </div>
      <ChartCaption kind={props.kind} chart={model.chart} />
    </DataFrame>
  );
}

function ChartBody({ kind, chart }: { kind: DataChartProps['kind']; chart: ChartModel }) {
  if (kind === 'pie') {
    const [series] = chart.series;
    const data = chart.labels.flatMap((label, i) => {
      const value = series?.values[i];
      return value === null || value === undefined ? [] : [{ category: label, value }];
    });
    return <PieChart data={data} categoryKey="category" dataKey="value" isAnimationActive={false} />;
  }

  /*
   * One point per category, keyed by the series' label so the legend reads as
   * the descriptor names it. A missing value is left out of its point rather
   * than drawn as zero.
   */
  const data = chart.labels.map((label, i) => {
    const point: Record<string, string | number> = { category: label };
    for (const s of chart.series) {
      const value = s.values[i];
      if (value !== null && value !== undefined) point[s.label] = value;
    }
    return point;
  });
  const Chart = kind === 'line' ? LineChartCondensed : BarChartCondensed;
  return (
    <Chart
      data={data}
      categoryKey="category"
      xAxisLabel={chart.x.label}
      yAxisLabel={chart.unit}
      isAnimationActive={false}
    />
  );
}

function ChartCaption({ kind, chart }: { kind: DataChartProps['kind']; chart: ChartModel }) {
  return (
    <figcaption className="pf-data__caption" data-testid="data-chart-caption">
      {KIND_LABEL[kind]}, kategorie: {chart.x.label} ({chart.labels.length}).{' '}
      {chart.series.map((s) => (
        <span
          key={s.field}
          data-series={s.field}
          data-unit={s.unit ?? ''}
          data-min={s.range?.min}
          data-max={s.range?.max}
        >
          Seria {s.label}
          {s.unit ? ` [${s.unit}]` : ''}:{' '}
          {s.range ? `od ${s.range.minText} do ${s.range.maxText}` : 'brak wartosci'}
          {s.missing > 0 ? `, bez wartosci: ${s.missing}` : ''}.{' '}
        </span>
      ))}
    </figcaption>
  );
}
