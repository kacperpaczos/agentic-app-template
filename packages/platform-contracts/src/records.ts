import { AppError } from './errors.ts';
import type { DataSort } from './ui.ts';
import {
  NUMERIC_FIELD_TYPES,
  ROUTE_PLACEHOLDER,
  type ReadResultDescriptor,
  type RecordField,
} from './views.ts';

/**
 * Reading records through a result descriptor.
 *
 * Pure functions, shared by the browser components and the server, so that
 * "which rows does this read return", "what does this value look like" and "in
 * which order" have exactly one answer each. A second copy in a component would
 * be a second opinion about the same number.
 */

export type DataRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is DataRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The records a read returned, as its descriptor says to find them.
 *
 * A result that does not have the declared shape is a defect in the module, not
 * an empty list: it throws `integration_failed` so the screen says so instead
 * of rendering "no records".
 */
export function recordsOf(result: unknown, descriptor: ReadResultDescriptor): DataRecord[] {
  if (descriptor.collection) {
    const rows = isRecord(result) ? result[descriptor.collection] : undefined;
    if (!Array.isArray(rows)) {
      throw new AppError(
        'integration_failed',
        `Wynik odczytu nie zawiera kolekcji "${descriptor.collection}" zadeklarowanej w deskryptorze.`,
      );
    }
    return rows.filter(isRecord);
  }
  if (Array.isArray(result)) return result.filter(isRecord);
  if (isRecord(result)) return [result];
  throw new AppError('integration_failed', 'Wynik odczytu nie jest rekordem ani lista rekordow.');
}

/** The record's identifier as a string, or null when it has none. */
export function recordIdOf(record: DataRecord, descriptor: ReadResultDescriptor): string | null {
  const id = record[descriptor.record.idField];
  return id === undefined || id === null || id === '' ? null : String(id);
}

/** Declared fields by name. */
export function fieldsByName(descriptor: ReadResultDescriptor): Map<string, RecordField> {
  return new Map(descriptor.fields.map((f) => [f.field, f]));
}

/**
 * The named fields, in the order given, refusing any the descriptor does not
 * declare — by name, with the list of what it does declare.
 */
export function pickFields(descriptor: ReadResultDescriptor, names: readonly string[]): RecordField[] {
  const byName = fieldsByName(descriptor);
  const unknown = names.filter((n) => !byName.has(n));
  if (unknown.length > 0) {
    throw new AppError(
      'validation_failed',
      `Pola ${unknown.join(', ')} nie sa zadeklarowane w deskryptorze rekordu ${descriptor.record.kind}. ` +
        `Dostepne: ${descriptor.fields.map((f) => f.field).join(', ')}.`,
      { unknownFields: unknown, available: descriptor.fields.map((f) => f.field) },
    );
  }
  return names.map((n) => byName.get(n)!);
}

/** Path of the record's own screen, or null when there is none or a placeholder is empty. */
export function recordRouteOf(record: DataRecord, descriptor: ReadResultDescriptor): string | null {
  const template = descriptor.record.route;
  if (!template) return null;
  let missing = false;
  const path = template.replace(ROUTE_PLACEHOLDER, (_m, name: string) => {
    const value = record[name];
    if (value === undefined || value === null || value === '') missing = true;
    return encodeURIComponent(String(value ?? ''));
  });
  return missing ? null : path;
}

/* -------------------------------------------------------------------------- */
/*  Values                                                                    */
/* -------------------------------------------------------------------------- */

const EMPTY = '—';

const isEmpty = (v: unknown) => v === undefined || v === null || v === '';

/** The unit in force for one value: the record's own `unitField`, else the fixed `unit`. */
export function fieldUnitOf(record: DataRecord, field: RecordField): string | undefined {
  if (field.unitField) {
    const own = record[field.unitField];
    if (!isEmpty(own)) return String(own);
  }
  return field.unit;
}

export const isNumericField = (field: RecordField): boolean =>
  (NUMERIC_FIELD_TYPES as readonly string[]).includes(field.type);

/**
 * A numeric value in display units — minor units become whole units,
 * thousandths become units. Null for an empty or non-numeric value, never 0:
 * a missing number is not a zero.
 */
export function numericFieldValue(record: DataRecord, field: RecordField): number | null {
  const raw = record[field.field];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  switch (field.type) {
    case 'money_minor':
      return raw / 100;
    case 'quantity_milli':
      return raw / 1000;
    case 'number':
      return raw;
    default:
      return null;
  }
}

const withUnit = (text: string, unit: string | undefined) => (unit ? `${text} ${unit}` : text);

/** Integer arithmetic, so an amount never picks up a float's last-digit error. */
function formatMinorUnits(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(minor));
  const major = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${major.toLocaleString('pl-PL')},${rest}`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * How one field of one record reads on screen.
 *
 * The single formatting rule of the platform's data components: amounts in
 * minor units with the record's currency, quantities in thousandths with the
 * record's unit, dates in Polish order, enums through their labels. An empty
 * value is a dash, never a zero or a blank that looks like a rendering bug.
 */
export function formatFieldValue(record: DataRecord, field: RecordField): string {
  const raw = record[field.field];
  if (isEmpty(raw)) return EMPTY;
  const unit = fieldUnitOf(record, field);

  switch (field.type) {
    case 'money_minor':
      return typeof raw === 'number' ? withUnit(formatMinorUnits(raw), unit) : String(raw);
    case 'quantity_milli':
      return typeof raw === 'number'
        ? withUnit((raw / 1000).toLocaleString('pl-PL', { maximumFractionDigits: 3 }), unit)
        : String(raw);
    case 'number':
      return typeof raw === 'number' ? withUnit(raw.toLocaleString('pl-PL'), unit) : String(raw);
    case 'date': {
      const text = String(raw);
      const dateOnly = DATE_ONLY.exec(text);
      if (dateOnly) return `${dateOnly[3]}.${dateOnly[2]}.${dateOnly[1]}`;
      const parsed = new Date(text);
      return Number.isNaN(parsed.getTime()) ? text : parsed.toLocaleDateString('pl-PL');
    }
    case 'boolean':
      return raw === true ? 'tak' : raw === false ? 'nie' : String(raw);
    case 'enum':
      return field.values?.find((v) => v.value === String(raw))?.label ?? String(raw);
    case 'text':
    default:
      return String(raw);
  }
}

/* -------------------------------------------------------------------------- */
/*  Order                                                                     */
/* -------------------------------------------------------------------------- */

function comparable(record: DataRecord, field: RecordField): number | string | null {
  const raw = record[field.field];
  if (isEmpty(raw)) return null;
  if (isNumericField(field)) return typeof raw === 'number' ? raw : null;
  if (field.type === 'date') {
    const t = Date.parse(String(raw));
    return Number.isNaN(t) ? null : t;
  }
  if (field.type === 'boolean') return raw === true ? 1 : 0;
  // An enum is ordered by what the user reads, not by its stored code.
  if (field.type === 'enum') return formatFieldValue(record, field);
  return String(raw);
}

/**
 * Records ordered by one declared field, by the field's type: numbers and
 * amounts numerically, dates chronologically, text in Polish collation, enums
 * by their labels. Empty values go last in either direction; equal values keep
 * their order.
 */
export function sortRecords(
  records: readonly DataRecord[],
  sort: DataSort,
  descriptor: ReadResultDescriptor,
): DataRecord[] {
  const [field] = pickFields(descriptor, [sort.field]);
  const factor = sort.direction === 'desc' ? -1 : 1;
  return [...records].sort((a, b) => {
    const va = comparable(a, field!);
    const vb = comparable(b, field!);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * factor;
    return String(va).localeCompare(String(vb), 'pl') * factor;
  });
}
