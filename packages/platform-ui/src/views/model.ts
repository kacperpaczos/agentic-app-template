import {
  AppError,
  SEMANTIC_ERROR_MESSAGE_LIMIT,
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
  type DataInstanceState,
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

/** An error as a description may carry it: code and a shortened message. */
function describeError(error: unknown): NonNullable<SemanticInstance['error']> {
  const e = AppError.from(error);
  const message = e.message.length > SEMANTIC_ERROR_MESSAGE_LIMIT
    ? `${e.message.slice(0, SEMANTIC_ERROR_MESSAGE_LIMIT - 1)}…`
    : e.message;
  return { code: e.code, message };
}

/**
 * The description a mounted data component registers in `uiSemantics`, in
 * whatever state it is in.
 *
 * With a model (`ready`, `empty`) it is built from the same model the
 * component renders, so it cannot name a record or a field the screen does not
 * show: `matched` counts every record left after the predicates, while
 * `visibleRecordIds` lists only records actually drawn — the first
 * `visibleLimit` when the component draws fewer than it has, and never more
 * than the schema's limit (a summary that draws 20 of 30 records lists 20 and
 * still says 30 matched).
 *
 * Without one (`loading`, `error`, `forbidden`) nothing was counted, so
 * `matched`, `total` and `record` are null — or `record` and the requested
 * fields come from the descriptor when a response carried one — and an
 * `error` / `forbidden` instance says why, by code and message.
 */
export function describeDataInstance(input: {
  instanceId: string;
  component: string;
  viewId: string | null;
  source: DataSource;
  state: DataInstanceState;
  /** Present exactly when the component renders records or an empty result. */
  model?: DataModel | null;
  /** Descriptor known without a model, e.g. from a response whose composition was refused. */
  descriptor?: ReadResultDescriptor | null;
  /** Fields the component asked for, described when there is no model. */
  fieldNames?: readonly string[];
  /** Predicates the component applies, described when there is no model. */
  filter?: readonly ViewFilterPredicate[];
  sort?: DataSort | null;
  page?: SemanticInstance['page'];
  /** Most records the component draws (absent: all). Listed identifiers stop at the schema's limit too. */
  visibleLimit?: number;
  error?: unknown;
  actions: string[];
}): SemanticInstance {
  const base = {
    instanceId: input.instanceId,
    component: input.component,
    viewId: input.viewId,
    source: input.source,
    state: input.state,
    sort: input.sort ?? null,
    page: input.page ?? null,
  };
  const { model } = input;

  if (model && (input.state === 'ready' || input.state === 'empty')) {
    const drawn =
      input.state !== 'ready'
        ? []
        : input.visibleLimit !== undefined
          ? model.records.slice(0, input.visibleLimit)
          : model.records;
    return {
      ...base,
      error: null,
      record: { kind: model.descriptor.record.kind, idField: model.descriptor.record.idField },
      fields: model.fields.map((f) => {
        const unit = unitAcross(drawn.length ? drawn : model.records, f);
        return { field: f.field, label: f.label, type: f.type, ...(unit ? { unit } : {}) };
      }),
      filter: model.predicates,
      visibleRecordIds: drawn
        .map((r) => recordIdOf(r, model.descriptor))
        .filter((id): id is string => id !== null)
        .slice(0, SEMANTIC_VISIBLE_RECORDS_LIMIT),
      matched: model.records.length,
      total: model.total,
      actions: input.actions,
    };
  }

  const descriptor = input.descriptor ?? null;
  const declared = descriptor ? new Map(descriptor.fields.map((f) => [f.field, f])) : null;
  const requested = descriptor
    ? (input.fieldNames ?? descriptor.fields.map((f) => f.field))
        .map((name) => declared!.get(name))
        .filter((f): f is RecordField => Boolean(f))
    : [];
  const failed = input.state === 'error' || input.state === 'forbidden';
  return {
    ...base,
    // A model-less description of a ready/empty state is not a thing the
    // components produce; it is reported as loading rather than invented.
    state: failed ? input.state : 'loading',
    error: failed ? describeError(input.error) : null,
    record: descriptor ? { kind: descriptor.record.kind, idField: descriptor.record.idField } : null,
    fields: requested.map((f) => ({ field: f.field, label: f.label, type: f.type, ...(f.unit ? { unit: f.unit } : {}) })),
    filter: [...(input.filter ?? [])],
    visibleRecordIds: [],
    matched: null,
    total: null,
    actions: [],
  };
}
