import { useEffect, useRef } from 'react';
import {
  formatFieldValue,
  recordIdOf,
  recordsOf,
  rowMatchesFilter,
  rowMatchesPredicate,
  type DataRecord,
  type DataSort,
  type DataSource,
  type DataTableProps,
  type ReadResponse,
  type RecordField,
  type UiTarget,
  type ViewFilterPredicate,
} from '@platform/contracts';
import { accessEpoch } from '../api/accessContext.ts';
import { buildDataModel } from './model.ts';

/**
 * Where one record is in a mounted table — and how the table can be brought to
 * show it.
 *
 * **Why the table answers and not the markup.** A record hidden by the address
 * bar's narrowing or sitting on another page is not in the document at all, so
 * nothing can be found by looking for its cell. Only the table knows the rows
 * of its read, what its composition and its narrowing leave, their order and
 * which page each is on — and it computes all of that with the same
 * `buildDataModel` it renders with. Each mounted `DataTable` therefore offers a
 * locator here while it is mounted; the command that shows a value
 * (`shell/uiReveal.ts`) asks it where the record is and what would have to
 * change, instead of guessing from the screen.
 */

export type RecordLocation =
  /** The table has no records to look in yet (loading, or its composition failed). */
  | { status: 'unavailable' }
  /** The read did not return the record. */
  | { status: 'absent' }
  /** The table does not render the field. */
  | { status: 'field_not_shown' }
  /** The composition's own filter leaves the record out; nothing on screen can change that. */
  | { status: 'excluded_by_composition' }
  /** The address bar's narrowing hides it: `excluding` are the predicates it fails, `kept` the rest. */
  | {
      status: 'excluded_by_narrowing';
      excluding: ViewFilterPredicate[];
      kept: ViewFilterPredicate[];
      pageShown: number | null;
    }
  | {
      status: 'present';
      /** The record as the table holds it — the row its cells are drawn from. */
      record: DataRecord;
      field: RecordField;
      /** The page the record is on, from 1; null when the table does not page. */
      page: number | null;
      pageShown: number | null;
      pageSize: number | null;
      pageCount: number | null;
      /** The record's title as the table would render it, when the descriptor names one. */
      title: string | null;
    };

export interface LocateInput {
  response: ReadResponse | null;
  props: Pick<DataTableProps, 'columns' | 'filter' | 'sort' | 'pageSize'>;
  /** The address bar's narrowing in force (the view's primary instance only). */
  narrowing: readonly ViewFilterPredicate[];
  addressSort: DataSort | null;
  /** The page asked for, from 1; null for the first. */
  page: number | null;
  recordId: string;
  field: string;
}

/** Where a record is in a table, computed by the rules the table renders with. */
export function locateRecord(input: LocateInput): RecordLocation {
  const { response, props, narrowing } = input;
  if (!response?.descriptor) return { status: 'unavailable' };
  let model: ReturnType<typeof buildDataModel>;
  try {
    model = buildDataModel({
      response,
      fieldNames: props.columns,
      filter: props.filter,
      sort: props.sort,
      narrowing: narrowing.length ? { targetId: '', predicates: [...narrowing] } : null,
      addressSort: input.addressSort,
      pageSize: props.pageSize,
      page: input.page,
    });
  } catch {
    return { status: 'unavailable' };
  }
  const { descriptor } = model;
  const isIt = (r: DataRecord) => recordIdOf(r, descriptor) === input.recordId;

  const record = recordsOf(response.result, descriptor).find(isIt);
  if (!record) return { status: 'absent' };
  const field = model.fields.find((f) => f.field === input.field);
  if (!field) return { status: 'field_not_shown' };
  if (props.filter?.length && !rowMatchesFilter(record, props.filter)) return { status: 'excluded_by_composition' };

  const pageShown = model.page?.index ?? null;
  const excluding = narrowing.filter((p) => !rowMatchesPredicate(record, p));
  if (excluding.length > 0) {
    return {
      status: 'excluded_by_narrowing',
      excluding,
      kept: narrowing.filter((p) => !excluding.includes(p)),
      pageShown,
    };
  }

  const index = model.records.findIndex(isIt);
  if (index < 0) return { status: 'absent' };
  const size = model.page?.size ?? null;
  const titleField = descriptor.record.titleField
    ? descriptor.fields.find((f) => f.field === descriptor.record.titleField)
    : undefined;
  const shown = model.records[index]!;
  return {
    status: 'present',
    record: shown,
    field,
    page: size ? Math.floor(index / size) + 1 : null,
    pageShown,
    pageSize: size,
    pageCount: model.page?.count ?? null,
    title: titleField ? formatFieldValue(shown, titleField) : null,
  };
}

/** A mounted table, as the command that shows a value sees it. */
export interface RevealTarget {
  instanceId: string;
  /** The module view the table is part of; null in a card or the chat. */
  viewId: string | null;
  source: DataSource;
  /** The view's address state — present only for its primary instance, on its own screen. */
  address: {
    targetId: string;
    /** `viewAddressKey` of the state the table applied. */
    key: string;
    predicates: ViewFilterPredicate[];
    filterFields: NonNullable<UiTarget['filter']>['fields'];
  } | null;
  /** Where the record is now — or, with `narrowing`, where it would be under that narrowing. */
  locate(recordId: string, field: string, opts?: { narrowing?: ViewFilterPredicate[] }): RecordLocation;
  /** Turns a table that pages in memory to a page; null for one paged through the address. */
  showPage: ((index: number) => void) | null;
}

const mounted = new Map<string, { epoch: number; current: () => RevealTarget }>();

/**
 * Tables mounted now and rendered under the identity signed in now. A table
 * that has not re-rendered since an identity switch still holds the previous
 * identity's rows, and is not offered.
 */
export function revealTargets(): RevealTarget[] {
  const epoch = accessEpoch();
  return [...mounted.values()].filter((m) => m.epoch === epoch).map((m) => m.current());
}

/**
 * Offers one table for as long as the caller keeps the returned withdrawal.
 *
 * Used by the hook below; exported because the command that reveals a value
 * talks to this registry and nothing else, so its behaviour can be exercised
 * without mounting a component.
 */
export function registerRevealTarget(current: () => RevealTarget, epoch: number = accessEpoch()): () => void {
  const id = current().instanceId;
  mounted.set(id, { epoch, current });
  return () => {
    if (mounted.get(id)?.epoch === epoch) mounted.delete(id);
  };
}

/** What `DataTable` passes on every render. */
export interface RevealTargetInput {
  instanceId: string;
  viewId: string | null;
  props: DataTableProps;
  response: ReadResponse | null;
  address: {
    targetId: string;
    key: string;
    predicates: ViewFilterPredicate[];
    sort: DataSort | null;
    page: number | null;
    filterFields: NonNullable<UiTarget['filter']>['fields'];
  } | null;
  localPage: number;
  setLocalPage: (index: number) => void;
}

/** Offers a mounted table's locator for as long as it is mounted, with its latest rows and state. */
export function useRevealTarget(input: RevealTargetInput): void {
  const latest = useRef(input);
  latest.current = input;
  const epoch = accessEpoch();
  useEffect(() => {
    return registerRevealTarget(
      () => {
        const t = latest.current;
        return {
          instanceId: t.instanceId,
          viewId: t.viewId,
          source: t.props.source,
          address: t.address
            ? { targetId: t.address.targetId, key: t.address.key, predicates: t.address.predicates, filterFields: t.address.filterFields }
            : null,
          locate: (recordId, field, opts) =>
            locateRecord({
              response: t.response,
              props: t.props,
              narrowing: opts?.narrowing ?? t.address?.predicates ?? [],
              addressSort: t.address?.sort ?? null,
              page: t.address ? t.address.page : t.localPage,
              recordId,
              field,
            }),
          showPage: t.address ? null : t.setLocalPage,
        };
      },
      epoch,
    );
  }, [input.instanceId, epoch]);
}
