import {
  AppError,
  SEMANTIC_VISIBLE_RECORDS_LIMIT,
  applyViewFilter,
  fieldUnitOf,
  formatFieldValue,
  isNumericField,
  numericFieldValue,
  pickFields,
  recordIdOf,
  recordsOf,
  rowMatchesFilter,
  sortRecords,
  type DataRecord,
  type DataSort,
  type DataSource,
  type ReadResponse,
  type ReadResultDescriptor,
  type RecordField,
  type SemanticInstance,
  type ViewFilterOutcome,
  type ViewFilterPredicate,
} from '@platform/contracts';

/**
 * What a data component shows, computed from a read's response.
 *
 * Pure — no React, no fetching — so the rules a table, a chart and a summary
 * follow can be tested on their own, and so all three follow the same ones:
 * records found through the descriptor, fields refused by name when the
 * descriptor does not declare them, the composition's own filter, then the
 * address bar's narrowing, then the order.
 *
 * Every refusal is an `AppError`, rendered by the component as a stated
 * failure. A misnamed column shown as an empty column would look like data.
 */

export interface DataModel {
  descriptor: ReadResultDescriptor;
  /** Fields as the component renders them, in order. */
  fields: RecordField[];
  /** Records after every predicate and the order. */
  records: DataRecord[];
  /** Records the read returned. */
  total: number;
  /** Every predicate applied: the composition's, then the address bar's. */
  predicates: ViewFilterPredicate[];
  /** Set when the address bar's narrowing was applied, for the banner and the agent. */
  outcome: ViewFilterOutcome | null;
}

export function buildDataModel(input: {
  response: ReadResponse;
  /** Fields to render; absent means every declared field. */
  fieldNames?: readonly string[];
  filter?: readonly ViewFilterPredicate[];
  sort?: DataSort;
  /** The view's own narrowing from the address bar, for its primary instance only. */
  narrowing?: { targetId: string; predicates: ViewFilterPredicate[] } | null;
}): DataModel {
  const { response } = input;
  const descriptor = response.descriptor;
  if (!descriptor) {
    throw new AppError(
      'validation_failed',
      `Operacja ${response.operation} nie deklaruje deskryptora wyniku, wiec komponent danych nie wie, jak ja pokazac.`,
    );
  }

  const fields = pickFields(descriptor, input.fieldNames ?? descriptor.fields.map((f) => f.field));
  const composed = [...(input.filter ?? [])];
  pickFields(descriptor, composed.map((p) => p.field));
  if (input.sort) pickFields(descriptor, [input.sort.field]);

  const all = recordsOf(response.result, descriptor);
  let records = composed.length ? all.filter((r) => rowMatchesFilter(r, composed)) : all;

  let outcome: ViewFilterOutcome | null = null;
  const predicates = [...composed];
  if (input.narrowing && input.narrowing.predicates.length > 0) {
    const narrowed = applyViewFilter(records, input.narrowing);
    records = narrowed.kept;
    outcome = narrowed.outcome;
    predicates.push(...input.narrowing.predicates);
  }

  if (input.sort) records = sortRecords(records, input.sort, descriptor);

  return { descriptor, fields, records, total: all.length, predicates, outcome };
}

/* -------------------------------------------------------------------------- */
/*  Chart                                                                     */
/* -------------------------------------------------------------------------- */

export interface ChartSeries {
  field: string;
  label: string;
  unit: string | undefined;
  /** One value per category, in display units; null where the record has none. */
  values: Array<number | null>;
  /** Smallest and largest value as displayed, or null when the series is empty. */
  range: { min: number; max: number; minText: string; maxText: string } | null;
  missing: number;
}

export interface ChartModel {
  x: RecordField;
  labels: string[];
  series: ChartSeries[];
  /** Shared unit of every series, when they have one. */
  unit: string | undefined;
}

/**
 * Categories and numeric series for a chart.
 *
 * A series must be a numeric field, and all its values must be in one unit: a
 * bar in PLN next to a bar in EUR on one axis would state a comparison the data
 * does not support, so that is refused with the units named rather than drawn.
 */
export function buildChartModel(model: DataModel, x: string, seriesNames: readonly string[]): ChartModel {
  const [xField] = pickFields(model.descriptor, [x]);
  const seriesFields = pickFields(model.descriptor, seriesNames);

  const series = seriesFields.map((field): ChartSeries => {
    if (!isNumericField(field)) {
      throw new AppError(
        'validation_failed',
        `Pole ${field.field} (${field.label}) nie jest liczbowe i nie moze tworzyc serii wykresu.`,
      );
    }
    const units = new Set(
      model.records
        .filter((r) => numericFieldValue(r, field) !== null)
        .map((r) => fieldUnitOf(r, field) ?? ''),
    );
    if (units.size > 1) {
      throw new AppError(
        'validation_failed',
        `Seria ${field.label} laczy rozne jednostki (${[...units].join(', ')}); zawez dane do jednej jednostki.`,
      );
    }
    const values = model.records.map((r) => numericFieldValue(r, field));
    let lowest: { value: number; record: DataRecord } | null = null;
    let highest: { value: number; record: DataRecord } | null = null;
    for (const [i, record] of model.records.entries()) {
      const value = values[i];
      if (value === null || value === undefined) continue;
      if (!lowest || value < lowest.value) lowest = { value, record };
      if (!highest || value > highest.value) highest = { value, record };
    }
    const [unit] = [...units];
    return {
      field: field.field,
      label: field.label,
      unit: unit || undefined,
      values,
      range:
        lowest && highest
          ? {
              min: lowest.value,
              max: highest.value,
              // Formatted from the records themselves, so the caption reads
              // exactly like the table cell holding the same value.
              minText: formatFieldValue(lowest.record, field),
              maxText: formatFieldValue(highest.record, field),
            }
          : null,
      missing: values.filter((v) => v === null).length,
    };
  });

  const units = new Set(series.map((s) => s.unit));
  return {
    x: xField!,
    labels: model.records.map((r) => formatFieldValue(r, xField!)),
    series,
    unit: units.size === 1 ? [...units][0] : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/*  Semantic description                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The unit a field is shown in across these records: the one they share, the
 * fixed unit when there are no records, and none when they disagree — a mixed
 * column has no single unit to report.
 */
function unitAcross(records: readonly DataRecord[], field: RecordField): string | undefined {
  const units = new Set(records.map((r) => fieldUnitOf(r, field)).filter((u): u is string => Boolean(u)));
  if (units.size === 0) return field.unit;
  return units.size === 1 ? [...units][0] : undefined;
}

/**
 * The description a mounted data component registers in `uiSemantics`.
 *
 * Built from the same model the component renders, so the description cannot
 * name a record or a field the screen does not show.
 */
export function describeDataInstance(input: {
  instanceId: string;
  component: string;
  viewId: string | null;
  source: DataSource;
  model: DataModel;
  sort?: DataSort | null;
  page?: SemanticInstance['page'];
  actions: string[];
}): SemanticInstance {
  const { model } = input;
  const ids = model.records
    .map((r) => recordIdOf(r, model.descriptor))
    .filter((id): id is string => id !== null);
  return {
    instanceId: input.instanceId,
    component: input.component,
    viewId: input.viewId,
    source: input.source,
    record: { kind: model.descriptor.record.kind, idField: model.descriptor.record.idField },
    fields: model.fields.map((f) => {
      const unit = unitAcross(model.records, f);
      return { field: f.field, label: f.label, type: f.type, ...(unit ? { unit } : {}) };
    }),
    filter: model.predicates,
    sort: input.sort ?? null,
    page: input.page ?? null,
    visibleRecordIds: ids.slice(0, SEMANTIC_VISIBLE_RECORDS_LIMIT),
    matched: model.records.length,
    total: model.total,
    actions: input.actions,
  };
}
