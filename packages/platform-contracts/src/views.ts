import { z } from 'zod';
import { APP_ERROR_CODES } from './errors.ts';
import { dataSortSchema, viewFilterPredicateSchema, viewPageSchema } from './ui.ts';

/**
 * Data views: what a module's read returns, how a screen is composed from it,
 * and what a mounted data component says about itself.
 *
 * **Why a descriptor and not the rows' own shape.** A component that renders a
 * read has to know which property identifies a row, what a column is called,
 * that an amount is stored in minor units and which property holds its
 * currency. Guessing any of that from the data produces a table that looks
 * right until the first null, the first foreign currency or the first renamed
 * property. So the module that owns the read declares it once, next to the
 * read, and every consumer — the default screen, an agent's view, the
 * validation of a composition, the prompt — takes it from there. A field that
 * is not declared is refused by name, never inferred.
 *
 * **Why the components take a source and not values.** A composition names a
 * registered read (`source.operation`) and its input; the browser fetches the
 * result through `POST /api/read`, with the owner taken from the session. A
 * composition therefore cannot carry business numbers of its own, so a screen
 * written by the agent and the default screen show the same backend data and
 * refresh the same way.
 *
 * Everything here is domain-neutral: kinds, fields and operations are opaque
 * strings supplied by the module.
 */

/* -------------------------------------------------------------------------- */
/*  Read result descriptor                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How a field's stored value is to be read.
 *
 *  - `money_minor`    integer minor units (e.g. hundredths); the currency comes
 *                     from `unitField` on the same record, or from `unit`;
 *  - `quantity_milli` integer thousandths; the unit comes from `unitField` or
 *                     `unit`;
 *  - `date`           ISO 8601 date or date-time string;
 *  - `enum`           a code from a closed set; `values` gives each its label.
 */
export const FIELD_TYPES = [
  'text',
  'number',
  'money_minor',
  'quantity_milli',
  'date',
  'boolean',
  'enum',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Field types whose value can be placed on a numeric axis. */
export const NUMERIC_FIELD_TYPES: readonly FieldType[] = ['number', 'money_minor', 'quantity_milli'];

const fieldName = z
  .string()
  .min(1)
  .max(80)
  .describe('Nazwa pola rekordu zadeklarowanego w deskryptorze operacji odczytu');

export const recordFieldSchema = z
  .object({
    /** Property name on the record. */
    field: z.string().min(1).max(80),
    /** What a user calls it — column header, axis title, summary label. */
    label: z.string().min(1).max(120),
    type: z.enum(FIELD_TYPES),
    /** Fixed unit, e.g. `%` or `dni`. Used when `unitField` is absent or empty. */
    unit: z.string().min(1).max(40).optional(),
    /** Property on the same record carrying the unit (currency code, unit of measure). */
    unitField: z.string().min(1).max(80).optional(),
    /** Labels of the codes of an `enum` field. A code without a label is shown as is. */
    values: z
      .array(z.object({ value: z.string().max(120), label: z.string().max(120) }))
      .max(60)
      .optional(),
    /**
     * Whether a view may be ordered by this field. A declared field is
     * sortable unless it says `false` (see `checkSortField`).
     */
    sortable: z.boolean().optional(),
  })
  .superRefine((f, ctx) => {
    if (f.values && f.type !== 'enum') {
      ctx.addIssue({ code: 'custom', path: ['values'], message: `Pole ${f.field}: values wymaga typu enum.` });
    }
    if (f.unitField && !(NUMERIC_FIELD_TYPES as readonly string[]).includes(f.type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['unitField'],
        message: `Pole ${f.field}: unitField ma sens tylko dla pol liczbowych.`,
      });
    }
  });
export type RecordField = z.infer<typeof recordFieldSchema>;

/** `{field}` placeholders in a record route. */
export const ROUTE_PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/* -------------------------------------------------------------------------- */
/*  Record actions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What a user types into one field of a record action's form, and what the
 * tool receives for it:
 *
 *  - `text`           the text as typed (trimmed);
 *  - `number`         a decimal number (`1 234,5` or `1234.5`);
 *  - `money_minor`    an amount typed in whole units with at most two decimals
 *                     (`1 234,56`), handed over as integer minor units (123456);
 *  - `quantity_milli` a quantity typed in units with at most three decimals,
 *                     handed over as integer thousandths.
 *
 * The type describes the tool's input, not the record field the form edits:
 * a tool taking an amount in whole currency units takes a `number`.
 */
export const RECORD_ACTION_FORM_FIELD_TYPES = ['text', 'number', 'money_minor', 'quantity_milli'] as const;
export type RecordActionFormFieldType = (typeof RECORD_ACTION_FORM_FIELD_TYPES)[number];

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(80);

/** `$record.<field>` — a value of the record as the backend re-reads it; `$form.<key>` — a form field. */
export const RECORD_ACTION_SOURCE = /^\$(record|form)\.([A-Za-z_][A-Za-z0-9_]*)$/;

export const recordActionFormFieldSchema = z.object({
  key: identifier,
  label: z.string().min(1).max(120),
  type: z.enum(RECORD_ACTION_FORM_FIELD_TYPES),
});
export type RecordActionFormField = z.infer<typeof recordActionFormFieldSchema>;

/*
 * The input mapping is a list of pairs rather than an object keyed by input
 * name: it has to stay expressible without `z.record()`, which no schema that
 * may reach the model over MCP can use.
 */
export const recordActionInputSchema = z.object({
  /** Key of the tool's input. */
  key: identifier,
  /** Where its value comes from: `$record.<field>` or `$form.<key>`. */
  from: z.string().regex(RECORD_ACTION_SOURCE, 'Oczekiwano $record.<pole> albo $form.<klucz>.'),
});

/**
 * An interaction a read's records offer: a write tool of the module that owns
 * the read, with its input taken from the record and from a small form.
 *
 * Performed by the platform (`POST /api/actions`) with the owner from the
 * session, after re-reading the record through the same read, through the very
 * handler the MCP server runs — so a table in a module's screen and the same
 * table in an agent's view change data by one authorized operation, and the
 * agent changing it by the tool is the same change again.
 */
export const recordActionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/).max(60),
  /** What the button says, e.g. "Zmien cene". */
  label: z.string().min(1).max(80),
  /** Unqualified name of a `write` tool of the same module. */
  tool: identifier,
  input: z.array(recordActionInputSchema).min(1).max(20),
  /** Fields the user fills in; absent: the action only asks for confirmation. */
  form: z.array(recordActionFormFieldSchema).max(10).optional(),
});
export type RecordAction = z.infer<typeof recordActionSchema>;

export const readResultDescriptorSchema = z
  .object({
    /**
     * Key of the array of records in the result. Absent: the result itself is
     * the array, or — when it is an object — a single record.
     */
    collection: z.string().min(1).max(80).optional(),
    record: z.object({
      /** Opaque record kind, e.g. what `AppContext.resource.kind` uses. */
      kind: z.string().min(1).max(80),
      /** Property holding the record's identifier. Need not be a displayed field. */
      idField: z.string().min(1).max(80),
      /** Displayed field that names the record; rendered as its link when `route` is set. */
      titleField: z.string().min(1).max(80).optional(),
      /**
       * Screen that opens one record, as a path with `{field}` placeholders
       * filled from the record — e.g. `/things/{id}`. Absent: records are not
       * links.
       */
      route: z.string().startsWith('/').max(200).optional(),
    }),
    /** Every field a view may show, filter, sort or chart. Anything else is refused. */
    fields: z.array(recordFieldSchema).min(1).max(60),
    /**
     * Interactions every table over this read offers on each record. Checked
     * against the module's tools when the module registers.
     */
    actions: z.array(recordActionSchema).max(10).optional(),
  })
  .superRefine((d, ctx) => {
    const names = d.fields.map((f) => f.field);
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) {
        ctx.addIssue({ code: 'custom', path: ['fields'], message: `Pole ${name} jest zadeklarowane dwa razy.` });
      }
      seen.add(name);
    }
    if (d.record.titleField && !seen.has(d.record.titleField)) {
      ctx.addIssue({
        code: 'custom',
        path: ['record', 'titleField'],
        message: `titleField ${d.record.titleField} nie jest zadeklarowanym polem.`,
      });
    }
    /*
     * A misspelt `unitField` is not harmless: the unit silently falls back to
     * the fixed one (or none), amounts lose their currency, and a chart can no
     * longer see that two records are in different currencies. So it must name
     * a declared field, like everything else a descriptor points at.
     */
    d.fields.forEach((f, i) => {
      if (f.unitField && !seen.has(f.unitField)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', i, 'unitField'],
          message: `Pole ${f.field}: unitField ${f.unitField} nie jest zadeklarowanym polem.`,
        });
      }
    });
    for (const [, name] of (d.record.route ?? '').matchAll(ROUTE_PLACEHOLDER)) {
      if (name && !seen.has(name) && name !== d.record.idField) {
        ctx.addIssue({
          code: 'custom',
          path: ['record', 'route'],
          message: `record.route: {${name}} nie jest zadeklarowanym polem ani idField.`,
        });
      }
    }
    checkRecordActionShapes(d.actions ?? [], seen, d.record.idField, ctx);
  });

/**
 * What can be said about record actions from the descriptor alone: unique ids,
 * inputs and form keys; every `$record.<field>` a declared field or the id;
 * every `$form.<key>` a field of the action's form; and no form field that no
 * input uses — a field the user fills in and the tool never receives would be
 * a lie about what the action does. Whether the tool exists, writes and takes
 * those inputs is checked against the module's tools at registration.
 */
function checkRecordActionShapes(
  actions: readonly RecordAction[],
  declared: ReadonlySet<string>,
  idField: string,
  ctx: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  actions.forEach((action, i) => {
    const where = `Akcja ${action.id}`;
    const issue = (path: PropertyKey[], message: string) =>
      ctx.addIssue({ code: 'custom', path: ['actions', i, ...path], message: `${where}: ${message}` });
    if (ids.has(action.id)) issue(['id'], 'identyfikator akcji powtarza sie.');
    ids.add(action.id);

    const formKeys = new Set<string>();
    (action.form ?? []).forEach((f, j) => {
      if (formKeys.has(f.key)) issue(['form', j, 'key'], `pole formularza ${f.key} powtarza sie.`);
      formKeys.add(f.key);
    });

    const inputKeys = new Set<string>();
    const usedForm = new Set<string>();
    action.input.forEach((entry, j) => {
      if (inputKeys.has(entry.key)) issue(['input', j, 'key'], `wejscie ${entry.key} jest mapowane dwa razy.`);
      inputKeys.add(entry.key);
      const [, kind, name] = RECORD_ACTION_SOURCE.exec(entry.from) ?? [];
      if (kind === 'record' && name && !declared.has(name) && name !== idField) {
        issue(['input', j, 'from'], `${entry.from} nie jest zadeklarowanym polem rekordu ani idField.`);
      }
      if (kind === 'form' && name) {
        if (!formKeys.has(name)) issue(['input', j, 'from'], `${entry.from} nie jest polem formularza akcji.`);
        usedForm.add(name);
      }
    });
    (action.form ?? []).forEach((f, j) => {
      if (!usedForm.has(f.key)) {
        issue(['form', j, 'key'], `pole formularza ${f.key} nie trafia do zadnego wejscia narzedzia.`);
      }
    });
  });
}
export type ReadResultDescriptor = z.infer<typeof readResultDescriptorSchema>;

/* -------------------------------------------------------------------------- */
/*  Data source                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Which registered read a data component (or a live artifact) re-runs.
 *
 * Never code, never SQL, never values: a qualified operation name and the input
 * the operation's own schema validates. `input` is a loose object rather than
 * `z.record()` so that the schema can be offered to the model over MCP.
 */
export const dataSourceSchema = z.object({
  /** Qualified operation name, `<moduleId>.<operation>`. */
  operation: z
    .string()
    .min(1)
    .max(200)
    .describe('Kwalifikowana nazwa zarejestrowanej operacji odczytu, np. "modul.operacja"'),
  /** Input for the operation; validated against the operation's own schema. */
  input: z.looseObject({}).optional().describe('Wejscie operacji zgodne z jej schematem'),
});
export type DataSource = z.infer<typeof dataSourceSchema>;

/* -------------------------------------------------------------------------- */
/*  Module views                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A module screen, written as an OpenUI Lang composition.
 *
 * `id` equals the `UiTarget.id` of the screen it renders, so a view, the place
 * the agent may open and the narrowing it may apply are one name.
 */
export const viewDefinitionSchema = z
  .object({
    id: z.string().min(3).max(120),
    title: z.string().min(1).max(200),
    /** OpenUI Lang source rendered against the shared component catalog. */
    composition: z.string().min(1).max(200_000),
    /** Route parameters handed to the composition as `$name` state. */
    params: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(10)
      .optional(),
    /**
     * The read behind the view's primary instance — the data component that the
     * address-bar narrowing of this view's `UiTarget` applies to.
     *
     * Declared rather than discovered so the platform can check, at startup and
     * without parsing the composition, that every narrowable field of the
     * target is a field this read actually declares. Required when the view's
     * target declares `filter`.
     */
    primaryOperation: z.string().min(1).max(200).optional(),
  })
  .superRefine((v, ctx) => {
    const params = v.params ?? [];
    if (new Set(params).size !== params.length) {
      ctx.addIssue({ code: 'custom', path: ['params'], message: `Widok ${v.id}: parametry sie powtarzaja.` });
    }
  });
export type ViewDefinition = z.infer<typeof viewDefinitionSchema>;

/* -------------------------------------------------------------------------- */
/*  Data components                                                           */
/* -------------------------------------------------------------------------- */

/** Names of the platform's data components in the OpenUI catalog. */
export const DATA_COMPONENTS = ['DataTable', 'DataChart', 'DataSummary'] as const;
export type DataComponentName = (typeof DATA_COMPONENTS)[number];

const dataFilterSchema = z
  .array(viewFilterPredicateSchema)
  .max(8)
  .describe('Stale zawezenie kompozycji: [{field, op: eq|neq|contains|in, value}]; wszystkie warunki musza byc spelnione');

/*
 * Key order is the positional argument order in OpenUI Lang
 * (`DataTable(source, columns, title, pageSize, filter, sort, groupBy)`), so it is part
 * of the contract: reordering these keys changes the meaning of every stored
 * composition.
 */
export const dataTablePropsSchema = z.object({
  source: dataSourceSchema,
  columns: z
    .array(fieldName)
    .min(1)
    .max(40)
    .optional()
    .describe('Pola pokazane jako kolumny, w tej kolejnosci; brak = wszystkie pola deskryptora'),
  title: z.string().max(200).optional().describe('Tytul tabeli'),
  pageSize: z.number().int().min(1).max(200).optional().describe('Liczba wierszy na strone'),
  filter: dataFilterSchema.optional(),
  sort: dataSortSchema.optional().describe('Porzadek wierszy'),
  /*
   * Appended last on purpose: it is a new positional argument, and every stored
   * composition written before it must keep its meaning.
   */
  groupBy: fieldName
    .optional()
    .describe('Pole grupujace wiersze; kazda grupa ma naglowek z wartoscia i liczba rekordow'),
});
export type DataTableProps = z.infer<typeof dataTablePropsSchema>;

export const dataChartPropsSchema = z
  .object({
    source: dataSourceSchema,
    kind: z.enum(['bar', 'line', 'pie']).describe('Rodzaj wykresu'),
    x: fieldName.describe('Pole kategorii (os X, etykiety wycinkow)'),
    series: z
      .array(fieldName)
      .min(1)
      .max(8)
      .describe('Pola liczbowe tworzace serie; wykres kolowy przyjmuje jedna serie'),
    title: z.string().max(200).optional().describe('Tytul wykresu'),
    filter: dataFilterSchema.optional(),
    sort: dataSortSchema.optional().describe('Porzadek kategorii'),
  })
  .superRefine((p, ctx) => {
    if (p.kind === 'pie' && p.series.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['series'], message: 'Wykres kolowy przyjmuje dokladnie jedna serie.' });
    }
  });
export type DataChartProps = z.infer<typeof dataChartPropsSchema>;

export const dataSummaryPropsSchema = z.object({
  source: dataSourceSchema,
  fields: z.array(fieldName).min(1).max(40).describe('Pola pokazane w podsumowaniu, w tej kolejnosci'),
  title: z.string().max(200).optional().describe('Tytul podsumowania'),
});
export type DataSummaryProps = z.infer<typeof dataSummaryPropsSchema>;

/**
 * What the catalog says about each data component. One text for the browser's
 * `defineComponent` and the server's catalog, which must describe the same
 * component the same way (compared by the catalog parity test).
 */
export const DATA_COMPONENT_DESCRIPTIONS: Record<DataComponentName, string> = {
  DataTable:
    'Tabela rekordow zarejestrowanej operacji odczytu. Dane pobiera backend; podaj zrodlo {operation, input} ' +
    'i opcjonalnie kolumny (pola deskryptora), tytul, rozmiar strony, stale zawezenie, porzadek i pole grupowania. ' +
    'Nigdy nie wpisuj wartosci.',
  DataChart:
    'Wykres (bar, line, pie) rekordow zarejestrowanej operacji odczytu: kategorie z pola x, serie z pol liczbowych ' +
    'deskryptora. Dane i jednostki pochodza z backendu; podpis podaje serie, jednostke i zakres wartosci.',
  DataSummary:
    'Podsumowanie rekordow zarejestrowanej operacji odczytu jako pary etykieta-wartosc dla wskazanych pol deskryptora.',
};

/** Props schema of each data component, for whoever validates a composition. */
export const DATA_COMPONENT_PROPS = {
  DataTable: dataTablePropsSchema,
  DataChart: dataChartPropsSchema,
  DataSummary: dataSummaryPropsSchema,
} as const satisfies Record<DataComponentName, z.ZodObject>;

/* -------------------------------------------------------------------------- */
/*  Semantic description of a mounted instance                                */
/* -------------------------------------------------------------------------- */

/** Most record identifiers one description carries; the rest are counted, not listed. */
export const SEMANTIC_VISIBLE_RECORDS_LIMIT = 50;

/**
 * What a data component is doing, as its frame says (`data-state`):
 * `loading` — no answer yet; `ready` — records shown; `empty` — the read
 * answered and nothing is left to show; `error` — the read or the composition
 * failed; `forbidden` — the owner may not see the source.
 */
export const DATA_INSTANCE_STATES = ['loading', 'ready', 'empty', 'error', 'forbidden'] as const;
export type DataInstanceState = (typeof DATA_INSTANCE_STATES)[number];

/** Longest error message a description carries. */
export const SEMANTIC_ERROR_MESSAGE_LIMIT = 300;

/**
 * What one mounted data component says it is showing.
 *
 * Rendering a composition does not tell anyone what is on screen. Each data
 * component therefore reports, while mounted, which read it shows, which
 * records and fields, and under which narrowing — in the same vocabulary the
 * descriptor declares — so the application can describe the active interface
 * without scraping its markup.
 */
export const semanticInstanceSchema = z
  .object({
    /** Unique among the instances mounted at once; also `data-ui-instance`. */
    instanceId: z.string().min(1).max(120),
    component: z.string().min(1).max(80),
    /** Module view the instance is part of, or null outside one (card, chat). */
    viewId: z.string().max(120).nullable(),
    source: dataSourceSchema,
    /**
     * Described in every state, so "the table on screen is still loading /
     * failed / may not be read" is something the application can say.
     */
    state: z.enum(DATA_INSTANCE_STATES),
    /**
     * Why an `error` or `forbidden` instance shows no records: the error code
     * and its message, shortened. Messages come from `AppError`, which never
     * carries secrets. Null in every other state.
     */
    error: z
      .object({ code: z.enum(APP_ERROR_CODES), message: z.string().max(SEMANTIC_ERROR_MESSAGE_LIMIT) })
      .nullable(),
    /** From the read's descriptor; null while it is not known (loading, a failed read). */
    record: z.object({ kind: z.string().max(80), idField: z.string().max(80) }).nullable(),
    /**
     * Fields as rendered, with their labels and the unit in force. Before
     * records are shown: the requested fields the descriptor declares, with
     * their fixed unit, or none while the descriptor is not known.
     */
    fields: z
      .array(
        z.object({
          field: z.string().max(80),
          label: z.string().max(120),
          type: z.enum(FIELD_TYPES),
          unit: z.string().max(40).optional(),
        }),
      )
      .max(60),
    /** Every predicate in force: the composition's own and the address bar's. */
    filter: z.array(viewFilterPredicateSchema).max(28),
    sort: dataSortSchema.nullable(),
    /** `index` counts from 1. Null when the instance does not paginate. */
    page: viewPageSchema.nullable(),
    /** Records on screen, at most the limit. Empty unless `ready`. */
    visibleRecordIds: z.array(z.string().max(128)).max(SEMANTIC_VISIBLE_RECORDS_LIMIT),
    /**
     * Records left after every predicate — all of them, not only those listed
     * or drawn. Null unless `ready` or `empty`: nothing was counted.
     */
    matched: z.number().int().nonnegative().nullable(),
    /** Records the read returned, before any predicate. Null unless `ready` or `empty`. */
    total: z.number().int().nonnegative().nullable(),
    /** Interactions the instance offers right now, e.g. `filter`, `open_record`. */
    actions: z.array(z.string().max(80)).max(20),
  })
  .superRefine((d, ctx) => {
    const counted = d.state === 'ready' || d.state === 'empty';
    const bothCounted = d.matched !== null && d.total !== null;
    const noneCounted = d.matched === null && d.total === null;
    if (counted ? !bothCounted : !noneCounted) {
      ctx.addIssue({
        code: 'custom',
        path: ['matched'],
        message: `Stan ${d.state}: matched i total ${counted ? 'sa wymagane' : 'musza byc null'}.`,
      });
    }
    if ((d.state === 'error' || d.state === 'forbidden') !== (d.error !== null)) {
      ctx.addIssue({ code: 'custom', path: ['error'], message: `Stan ${d.state}: niezgodne pole error.` });
    }
    if (d.state !== 'ready' && d.visibleRecordIds.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['visibleRecordIds'], message: `Stan ${d.state} nie pokazuje rekordow.` });
    }
    if (d.state === 'empty' && d.matched !== 0) {
      ctx.addIssue({ code: 'custom', path: ['matched'], message: 'Stan empty oznacza matched = 0.' });
    }
  });
export type SemanticInstance = z.infer<typeof semanticInstanceSchema>;

/* -------------------------------------------------------------------------- */
/*  Reading                                                                   */
/* -------------------------------------------------------------------------- */

/** What `POST /api/read` answers. */
export interface ReadResponse {
  operation: string;
  result: unknown;
  /** Null for a read that declares no result descriptor. */
  descriptor: ReadResultDescriptor | null;
  resolvedAt: string;
}

/** One entry of `GET /api/read/operations`. */
export interface ReadOperationSummary {
  name: string;
  description: string;
  inputKeys: string[];
  descriptor: ReadResultDescriptor | null;
}

/* -------------------------------------------------------------------------- */
/*  Performing a record action                                                */
/* -------------------------------------------------------------------------- */

/**
 * What `POST /api/actions` takes.
 *
 * The read and its input are those of the table the user acts in: the record
 * is re-read through them, with the session's owner, so the action works on
 * the record as the backend has it now — never on values the browser sends.
 * Form values are sent as typed and parsed on the server by each field's
 * declared type. `operationId` is required: a repeated request (a retry, a
 * double click) returns the first outcome instead of changing data twice.
 *
 * Only the HTTP API takes this, so `values` may be a plain object.
 */
export const recordActionRequestSchema = z.object({
  operation: dataSourceSchema.shape.operation,
  input: dataSourceSchema.shape.input,
  action: z.string().min(1).max(60),
  recordId: z.string().min(1).max(128),
  values: z.record(z.string(), z.string().max(500)).optional(),
  operationId: z.string().min(8).max(200),
});
export type RecordActionRequest = z.infer<typeof recordActionRequestSchema>;

/** What `POST /api/actions` answers. */
export interface RecordActionResponse {
  operation: string;
  action: string;
  recordId: string;
  /** The tool's own answer. */
  result: unknown;
  /** Resources the tool reported changed (`data_changed`), e.g. `thing:42`. */
  changed: string[];
  /** True when this `operationId` was already performed and its outcome is returned again. */
  replayed: boolean;
}

/**
 * JSON with object keys in sorted order: one text for values that differ only
 * in key order. The browser keys its read cache with it; the server compares
 * a repeated record action with the first one by it.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
