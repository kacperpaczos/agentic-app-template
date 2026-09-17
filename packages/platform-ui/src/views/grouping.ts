import {
  fieldUnitOf,
  formatFieldValue,
  pickFields,
  type DataRecord,
  type RecordField,
} from '@platform/contracts';
import type { DataModel } from './model.ts';

/**
 * Rows of a table in groups by one field.
 *
 * Pure, and kept apart from the table itself, so the rule is testable on its
 * own and a change to how rows are rendered does not touch it.
 *
 * A group is one stored value of the field in one unit: 100 PLN and 100 EUR are
 * two groups, because putting them under one heading would state an equality
 * the data does not have. Its label is formatted exactly as a cell showing the
 * same value, so a heading reads like the column. Groups keep the order in
 * which their first record appears, i.e. the table's own order; an empty value
 * forms its own group, labelled like an empty cell.
 *
 * Grouping is applied to the rows already on screen — after the order and the
 * page — never the other way round, so it cannot change which records a page
 * shows; each group also counts its records across all pages.
 */
export interface RecordGroup {
  /** Stored value and unit, e.g. `net|` or `10000|PLN`; `|` for an empty value. */
  key: string;
  label: string;
  /** The group's records among those grouped (the page shown). */
  records: DataRecord[];
  /** The group's records among all matched records, on every page. */
  total: number;
}

export interface Grouping {
  field: RecordField;
  groups: RecordGroup[];
}

const groupKey = (record: DataRecord, field: RecordField): string => {
  const raw = record[field.field];
  const value = raw === undefined || raw === null || raw === '' ? '' : String(raw);
  return `${value}|${value ? (fieldUnitOf(record, field) ?? '') : ''}`;
};

/**
 * `records` in groups; `all` (defaults to `records`) is the whole matched set
 * each group's `total` is counted over, when `records` is one page of it.
 */
export function groupRecords(
  records: readonly DataRecord[],
  field: RecordField,
  all: readonly DataRecord[] = records,
): RecordGroup[] {
  const groups = new Map<string, RecordGroup>();
  for (const record of records) {
    const key = groupKey(record, field);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: formatFieldValue(record, field), records: [], total: 0 };
      groups.set(key, group);
    }
    group.records.push(record);
  }
  for (const record of all) {
    const group = groups.get(groupKey(record, field));
    if (group) group.total += 1;
  }
  return [...groups.values()];
}

/**
 * The model with its grouping, when the composition asks for one: the rows of
 * the page shown (`shown`), with totals over every matched record. A field the
 * descriptor does not declare is refused by name, like a column.
 */
export function withGrouping<T extends DataModel>(model: T, groupBy: string | null | undefined): T & { grouping: Grouping | null } {
  if (!groupBy) return { ...model, grouping: null };
  const [field] = pickFields(model.descriptor, [groupBy]);
  return { ...model, grouping: { field: field!, groups: groupRecords(model.shown, field!, model.records) } };
}
