import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  describePredicate,
  type DataSort,
  type RecordField,
  type UiTarget,
  type ViewFilterPredicate,
  type ViewPage,
} from '@platform/contracts';

/**
 * The user's controls over a view's state: narrowing, order, page.
 *
 * They change the same address the agent's commands change, through the same
 * rules (`viewStatePatch`), so a view narrowed by the agent shows that
 * narrowing in these fields, and one narrowed here is what the agent reads in
 * the next command's context. Every change is a navigation: Back undoes it.
 *
 * Plain form controls and buttons with visible labels, so they work from the
 * keyboard and are announced properly; the shell's `:focus-visible` ring marks
 * the focused one.
 */

type FilterField = NonNullable<UiTarget['filter']>['fields'][number];

/** Option standing for a narrowing the field's controls cannot express (e.g. "PL or CZ"). */
const CURRENT = '__zawezenie-biezace__';

function draftFor(fields: FilterField[], predicates: ViewFilterPredicate[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const p = predicates.find((x) => x.field === f.field);
    if (!p) {
      out[f.field] = '';
    } else if (f.values?.length) {
      out[f.field] = p.op === 'eq' && f.values.includes(String(p.value)) ? String(p.value) : CURRENT;
    } else {
      out[f.field] = p.op === 'contains' || p.op === 'eq' ? String(p.value) : CURRENT;
    }
  }
  return out;
}

/** How an applied predicate on a text field reads next to it, when the field alone does not say. */
const OPERATOR_HINTS: Partial<Record<ViewFilterPredicate['op'], string>> = {
  eq: 'rowna sie',
  contains: 'zawiera',
};

/**
 * Narrowing controls for the fields the view's target declares: a list for a
 * field with suggested values, a text field ("contains") for the rest.
 *
 * Applied with the button (or Enter), not on every keystroke or selection: each
 * application is a history entry, and Back should undo a decision, not a letter.
 *
 * **A field the user did not edit keeps its predicate as it is.** The agent may
 * narrow a text field with `eq`; rebuilding every field from its text on
 * "Apply" turned that into `contains` and silently widened the result when the
 * user changed a different field. So only edited fields are rebuilt, and an
 * applied text predicate shows its operator beside the field.
 */
export function FilterBar(props: {
  fields: FilterField[];
  predicates: ViewFilterPredicate[];
  onApply: (predicates: ViewFilterPredicate[]) => void;
}) {
  const { fields, predicates, onApply } = props;
  const baseId = useId();
  const appliedKey = JSON.stringify(predicates);
  const [draft, setDraft] = useState(() => draftFor(fields, predicates));
  const [edited, setEdited] = useState<ReadonlySet<string>>(() => new Set());

  // The address changed — by Back, a link or the agent: show what is applied.
  useEffect(() => {
    setDraft(draftFor(fields, predicates));
    setEdited(new Set());
    // `appliedKey` is the value of `predicates`.
  }, [appliedKey, fields]);

  const edit = (field: string, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
    setEdited((e) => new Set(e).add(field));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: ViewFilterPredicate[] = [];
    for (const f of fields) {
      if (!edited.has(f.field)) {
        const kept = predicates.find((p) => p.field === f.field);
        if (kept) next.push(kept);
        continue;
      }
      const value = (draft[f.field] ?? '').trim();
      if (!value) continue;
      if (value === CURRENT) {
        const kept = predicates.find((p) => p.field === f.field);
        if (kept) next.push(kept);
      } else if (f.values?.length) {
        next.push({ field: f.field, op: 'eq', value });
      } else {
        next.push({ field: f.field, op: 'contains', value });
      }
    }
    if (JSON.stringify(next) !== appliedKey) onApply(next);
  };

  return (
    <form
      className="pf-filterbar"
      role="search"
      aria-label="Zawezenie widoku"
      data-testid="view-filter-controls"
      onSubmit={submit}
    >
      {fields.map((f) => {
        const id = `${baseId}-${f.field}`;
        const current = predicates.find((p) => p.field === f.field);
        const hint = f.values?.length
          ? null
          : edited.has(f.field)
            ? (draft[f.field] ?? '').trim() && draft[f.field] !== CURRENT
              ? OPERATOR_HINTS.contains
              : null
            : current && draft[f.field] !== CURRENT
              ? (OPERATOR_HINTS[current.op] ?? null)
              : null;
        return (
          <div className="pf-filterbar__field" key={f.field}>
            <label htmlFor={id}>{f.label}</label>
            {f.values?.length ? (
              <select
                id={id}
                name={f.field}
                data-filter-field={f.field}
                value={draft[f.field] ?? ''}
                onChange={(e) => edit(f.field, e.target.value)}
              >
                <option value="">wszystkie</option>
                {draft[f.field] === CURRENT && current && (
                  <option value={CURRENT}>{describePredicate(current, f.label)}</option>
                )}
                {f.values.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                name={f.field}
                type="search"
                data-filter-field={f.field}
                placeholder={draft[f.field] === CURRENT && current ? describePredicate(current, f.label) : 'zawiera…'}
                value={draft[f.field] === CURRENT ? '' : (draft[f.field] ?? '')}
                aria-describedby={hint ? `${id}-op` : undefined}
                onChange={(e) => edit(f.field, e.target.value)}
              />
            )}
            {hint && (
              <span id={`${id}-op`} className="pf-filterbar__op" data-filter-op-for={f.field}>
                {hint}
              </span>
            )}
          </div>
        );
      })}
      <div className="pf-filterbar__actions">
        <button type="submit" className="pf-btn pf-btn--tiny" data-testid="view-filter-apply">
          Zastosuj
        </button>
        <button
          type="button"
          className="pf-btn pf-btn--tiny"
          data-testid="view-filter-reset"
          disabled={predicates.length === 0}
          onClick={() => onApply([])}
        >
          Wyczysc
        </button>
      </div>
    </form>
  );
}

/**
 * The next order when a column header is pressed: ascending, then descending,
 * then back to the view's own order. An order that is the composition's own
 * (not the address bar's) cannot be "cleared" into itself, so it alternates.
 */
export function nextSort(current: DataSort | null, fromAddress: boolean, field: string): DataSort | null {
  if (!current || current.field !== field) return { field, direction: 'asc' };
  if (current.direction === 'asc') return { field, direction: 'desc' };
  return fromAddress ? null : { field, direction: 'asc' };
}

/**
 * A column header. For a sortable field of a view the user may order, the
 * label is a button and the header carries `aria-sort`; the arrow is drawn by
 * CSS, so the header's text stays the field's label.
 */
export function HeaderCell(props: {
  field: RecordField;
  sortable: boolean;
  sort: DataSort | null;
  onSort: ((field: string) => void) | null;
}) {
  const { field, sort, onSort } = props;
  const active = sort?.field === field.field ? sort.direction : null;
  const interactive = props.sortable && onSort !== null;
  return (
    <th
      scope="col"
      data-field={field.field}
      aria-sort={
        active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : interactive ? 'none' : undefined
      }
    >
      {interactive ? (
        <button
          type="button"
          className="pf-sort"
          data-sort-field={field.field}
          onClick={() => onSort!(field.field)}
        >
          {field.label}
        </button>
      ) : (
        field.label
      )}
    </th>
  );
}

/** "Previous / page X of Y / Next". Each step is a navigation for the primary view. */
export function Pager(props: { page: ViewPage; onPage: (index: number) => void }) {
  const { index, count } = props.page;
  return (
    <nav className="pf-pager" aria-label="Strony tabeli" data-testid="data-pager">
      <button
        type="button"
        className="pf-btn pf-btn--tiny"
        data-testid="data-page-prev"
        disabled={index <= 1}
        onClick={() => props.onPage(index - 1)}
      >
        Poprzednia
      </button>
      <span className="pf-pager__status" data-testid="data-page-status" aria-live="polite">
        Strona {index} z {count}
      </span>
      <button
        type="button"
        className="pf-btn pf-btn--tiny"
        data-testid="data-page-next"
        disabled={index >= count}
        onClick={() => props.onPage(index + 1)}
      >
        Nastepna
      </button>
    </nav>
  );
}
