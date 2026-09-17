import { z } from 'zod';
import { viewFilterPredicateSchema } from './ui.ts';

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
    /** Whether a view may be ordered by this field. */
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
  });
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

export const dataSortSchema = z.object({
  field: fieldName,
  direction: z.enum(['asc', 'desc']).describe('asc rosnaco, desc malejaco'),
});
export type DataSort = z.infer<typeof dataSortSchema>;

const dataFilterSchema = z
  .array(viewFilterPredicateSchema)
  .max(8)
  .describe('Stale zawezenie kompozycji: [{field, op: eq|neq|contains|in, value}]; wszystkie warunki musza byc spelnione');

/*
 * Key order is the positional argument order in OpenUI Lang
 * (`DataTable(source, columns, title, pageSize, filter, sort)`), so it is part
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
 * What one mounted data component says it is showing.
 *
 * Rendering a composition does not tell anyone what is on screen. Each data
 * component therefore reports, while mounted, which read it shows, which
 * records and fields, and under which narrowing — in the same vocabulary the
 * descriptor declares — so the application can describe the active interface
 * without scraping its markup.
 */
export const semanticInstanceSchema = z.object({
  /** Unique among the instances mounted at once; also `data-ui-instance`. */
  instanceId: z.string().min(1).max(120),
  component: z.string().min(1).max(80),
  /** Module view the instance is part of, or null outside one (card, chat). */
  viewId: z.string().max(120).nullable(),
  source: dataSourceSchema,
  record: z.object({ kind: z.string().max(80), idField: z.string().max(80) }),
  /** Fields as rendered, with their labels and the unit in force. */
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
  filter: z.array(viewFilterPredicateSchema).max(16),
  sort: dataSortSchema.nullable(),
  /** `index` counts from 1. Null when the instance does not paginate. */
  page: z
    .object({
      index: z.number().int().min(1),
      size: z.number().int().min(1),
      count: z.number().int().min(0),
    })
    .nullable(),
  visibleRecordIds: z.array(z.string().max(128)).max(SEMANTIC_VISIBLE_RECORDS_LIMIT),
  /** Records left after every predicate. */
  matched: z.number().int().nonnegative(),
  /** Records the read returned, before any predicate. */
  total: z.number().int().nonnegative(),
  /** Interactions the instance offers right now, e.g. `filter`, `open_record`. */
  actions: z.array(z.string().max(80)).max(20),
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
