import {
  createLibrary,
  createParser,
  defineComponent,
  isASTNode,
  walkAST,
  type ASTNode,
  type ElementNode,
  type LibraryJSONSchema,
  type ParseResult,
} from '@openuidev/lang-core';
import {
  AppError,
  DATA_COMPONENT_DESCRIPTIONS,
  DATA_COMPONENT_PROPS,
  DATA_COMPONENTS,
  isNumericField,
  pickFields,
  type DataChartProps,
  type DataComponentName,
  type DataSummaryProps,
  type DataTableProps,
  type OpenUiComponentDeclaration,
  type ReadResultDescriptor,
} from '@platform/contracts';
import openuiLibrarySchema from './openui-library.schema.json' with { type: 'json' };
import { prepareRead, readRefusalOf, type ReadOperationLookup } from './read-operations.ts';

/**
 * Server-side validation of OpenUI Lang compositions.
 *
 * Every composition the application stores — an `openui` card, a module view,
 * an agent's view — is parsed here with the same parser the browser renders
 * with (`@openuidev/lang-core`) and checked against the same catalog, before it
 * is written. What the browser would silently drop (an unknown component, a
 * prop of the wrong type, a statement nothing reaches) or render wrongly (a
 * table on an operation nobody registered, a column the read does not have) is
 * refused here, by name, and the stored composition stays as it was.
 *
 * **Why the ready-made components come from a generated file.** The browser's
 * catalog is `openuiLibrary` from `@openuidev/react-ui` plus the platform's data
 * components plus the modules' components. The server cannot import a React
 * package, and the parser needs each component's parameter list to map
 * positional arguments, so the ready-made part is read from
 * `openui-library.schema.json`, generated from that very library and compared
 * with it by `tests/openui-catalog-parity.test.ts`. Data components and module
 * components are built from their Zod schemas, which both halves import.
 *
 * **Two modes.** `catalog` accepts every component the browser knows.
 * `agent-views` — a conversation's agent views space — accepts only data
 * components, module components and the layout and text components listed in
 * {@link AGENT_VIEW_LAYOUT_COMPONENTS}; nothing that draws numbers written into
 * the composition, and no runtime expressions.
 */

export const COMPOSITION_MODES = ['catalog', 'agent-views'] as const;
export type CompositionMode = (typeof COMPOSITION_MODES)[number];

/** Why a composition was refused. One composition may be refused for several. */
export const COMPOSITION_REFUSALS = [
  'empty',
  'syntax',
  'partial',
  'missing_root',
  'duplicate_statement',
  'unknown_component',
  'invalid_props',
  'unresolved_reference',
  'orphaned_statement',
  'forbidden_reference',
  'component_not_allowed',
  'dynamic_expression',
  'invalid_source',
  'unknown_operation',
  'invalid_input',
  'no_descriptor',
  'undeclared_field',
  'non_numeric_series',
  'primary_operation_missing',
] as const;
export type CompositionRefusal = (typeof COMPOSITION_REFUSALS)[number];

export interface CompositionProblem {
  reason: CompositionRefusal;
  message: string;
  statementId?: string;
  component?: string;
}

/**
 * Layout and text components of the ready-made catalog allowed in an agent's
 * views, and why each is harmless there.
 *
 * The rule the list implements: nothing on it takes numbers, series or rows as
 * props. A view that shows business data must get them from a data component
 * reading a registered operation; the model may arrange and title such views,
 * not supply their values. Left out on purpose: `Table`/`Col`, every chart and
 * its `Series`/`Slice`/`Point` (literal data), `Tag`/`TagBlock` (values dressed
 * as labels), forms, inputs and buttons (actions that bypass the domain
 * operations), `Image*` (external addresses), `Modal`/`Callout` (need state
 * bindings), `Steps`, `Carousel` and `CodeBlock` (not needed to present data).
 */
export const AGENT_VIEW_LAYOUT_COMPONENTS: Readonly<Record<string, string>> = {
  Stack: 'uklad: kolumna lub wiersz innych komponentow',
  Card: 'uklad: ramka grupujaca komponenty',
  CardHeader: 'tekst: tytul i podtytul sekcji',
  Tabs: 'uklad: zakladki z alternatywnymi prezentacjami',
  TabItem: 'uklad: jedna zakladka',
  Accordion: 'uklad: sekcje zwijane',
  AccordionItem: 'uklad: jedna sekcja zwijana',
  Separator: 'uklad: linia oddzielajaca',
  TextContent: 'tekst: opis lub komentarz',
  TextCallout: 'tekst: wyrozniona uwaga',
  MarkDownRenderer: 'tekst: dluzszy opis w Markdown',
};

/** One data component instance found in a composition, with its checked props. */
export type DataInstance =
  | { component: 'DataTable'; props: DataTableProps; statementId?: string }
  | { component: 'DataChart'; props: DataChartProps; statementId?: string }
  | { component: 'DataSummary'; props: DataSummaryProps; statementId?: string };

/* -------------------------------------------------------------------------- */
/*  Server catalog                                                            */
/* -------------------------------------------------------------------------- */

const isDataComponent = (name: string): name is DataComponentName =>
  (DATA_COMPONENTS as readonly string[]).includes(name);

/**
 * The catalog as the server knows it: the ready-made components, the data
 * components and the modules' declared components, as one JSON Schema document
 * for the parser.
 */
export class OpenUiServerCatalog {
  readonly schema: LibraryJSONSchema;
  readonly root: string;
  /** Components contributed by modules, by name. */
  readonly moduleComponents: ReadonlySet<string>;
  readonly #parser: ReturnType<typeof createParser>;

  constructor(moduleComponents: readonly OpenUiComponentDeclaration[] = []) {
    const base = openuiLibrarySchema.$defs as Record<string, NonNullable<LibraryJSONSchema['$defs']>[string]>;
    const names = new Set(Object.keys(base));
    for (const c of [...DATA_COMPONENTS.map((name) => ({ name })), ...moduleComponents]) {
      // Same rule as the browser's `buildRegistry`: a second component under a
      // taken name would silently replace the first.
      if (names.has(c.name)) {
        throw new AppError('conflict', `Konflikt katalogu: komponent OpenUI "${c.name}" jest juz zarejestrowany.`);
      }
      names.add(c.name);
    }
    const extra = createLibrary<null>({
      components: [
        ...DATA_COMPONENTS.map((name) =>
          defineComponent({
            name,
            props: DATA_COMPONENT_PROPS[name],
            description: DATA_COMPONENT_DESCRIPTIONS[name],
            component: null,
          }),
        ),
        ...moduleComponents.map((c) =>
          defineComponent({ name: c.name, props: c.propsSchema, description: c.description, component: null }),
        ),
      ],
    });
    this.schema = { $defs: { ...base, ...(extra.toJSONSchema().$defs ?? {}) } };
    this.root = openuiLibrarySchema.root;
    this.moduleComponents = new Set(moduleComponents.map((c) => c.name));
    this.#parser = createParser(this.schema, this.root);
  }

  /** Every component name a composition may use in `catalog` mode. */
  names(): string[] {
    return Object.keys(this.schema.$defs ?? {});
  }

  parse(source: string): ParseResult {
    return this.#parser.parse(source);
  }

  /**
   * How a component is written in OpenUI Lang: positional arguments in schema
   * order, optional ones marked `?` — e.g. `DataTable(source, columns?, ...)`.
   */
  signature(name: string): string {
    const def = this.schema.$defs?.[name];
    const required = new Set(def?.required ?? []);
    const params = Object.keys(def?.properties ?? {}).map((p) => (required.has(p) ? p : `${p}?`));
    return `${name}(${params.join(', ')})`;
  }

  /** Whether `agent-views` mode accepts this component. */
  allowsInAgentViews(name: string): boolean {
    return isDataComponent(name) || this.moduleComponents.has(name) || name in AGENT_VIEW_LAYOUT_COMPONENTS;
  }
}

let platformCatalog: OpenUiServerCatalog | null = null;
/** The catalog without module components — enough to find data components. */
const defaultCatalog = () => (platformCatalog ??= new OpenUiServerCatalog());

/* -------------------------------------------------------------------------- */
/*  Statements                                                                */
/* -------------------------------------------------------------------------- */

const STATEMENT_HEAD = /^(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=\s*\S/;

/**
 * Top-level statements of a source, split the way the parser splits them:
 * newlines outside strings and brackets end a statement.
 *
 * The parser skips a line that is not `name = expression` without a word, so a
 * garbled line — or half a statement broken by a stray newline — would be
 * dropped from the view with nobody told. Checking each chunk here is what
 * turns that into a syntax refusal.
 */
function topLevelChunks(source: string): string[] {
  const chunks: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (c === '\\') escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === '\n' && depth === 0) {
      // A ternary may continue on the next line (`? a` / `: b`), as the parser allows.
      const rest = source.slice(i + 1).trimStart();
      if (rest.startsWith('?') || rest.startsWith(':')) continue;
      chunks.push(source.slice(start, i));
      start = i + 1;
    }
  }
  chunks.push(source.slice(start));
  return chunks.map((c) => c.trim()).filter((c) => c && !c.startsWith('//') && !c.startsWith('#'));
}

/** The source without an enclosing ``` fence, which the renderer strips too. */
export function normalizeCompositionSource(source: string): string {
  const trimmed = source.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (fenced ? fenced[1]! : trimmed).trim();
}

/* -------------------------------------------------------------------------- */
/*  Walking a parse result                                                    */
/* -------------------------------------------------------------------------- */

const isElement = (v: unknown): v is ElementNode =>
  typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'element';

/** Paths of runtime expressions inside a value (`$state`, `@Builtin(...)`, operators). */
function dynamicPaths(value: unknown, path: string[] = [], out: Array<{ path: string[]; node: ASTNode }> = []) {
  if (isASTNode(value)) {
    out.push({ path, node: value });
    return out;
  }
  if (Array.isArray(value)) value.forEach((v, i) => dynamicPaths(v, [...path, String(i)], out));
  else if (value && typeof value === 'object' && !isElement(value)) {
    for (const [k, v] of Object.entries(value)) dynamicPaths(v, [...path, k], out);
  }
  return out;
}

interface WalkContext {
  mode: CompositionMode;
  catalog: OpenUiServerCatalog;
  reads: ReadOperationLookup | null;
  /** View parameters a data source may use as `$name`. */
  params: readonly string[];
  problems: CompositionProblem[];
  instances: DataInstance[];
}

function walkValue(value: unknown, ctx: WalkContext, statementId: string | undefined): void {
  if (value === null || value === undefined) return;
  if (isElement(value)) {
    walkElement(value, ctx);
    return;
  }
  if (isASTNode(value)) {
    walkExpression(value, ctx, statementId);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walkValue(v, ctx, statementId);
    return;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) walkValue(v, ctx, statementId);
  }
}

/**
 * A runtime expression. In an agent's view there are none: the view shows what
 * the registered reads return, and an expression is how a composition would
 * compute or switch what it shows. Elsewhere expressions are the renderer's
 * business, except that a data component inside one would escape every check
 * below — its props are known only when it renders.
 */
function walkExpression(node: ASTNode, ctx: WalkContext, statementId: string | undefined): void {
  if (ctx.mode === 'agent-views') {
    ctx.problems.push({
      reason: 'dynamic_expression',
      statementId,
      message:
        `Instrukcja ${statementId ?? '?'}: widok agenta nie moze zawierac wyrazen ani stanu ($zmienna, @Funkcja, operatory) — ` +
        'pokazuje to, co zwracaja zarejestrowane odczyty.',
    });
    return;
  }
  walkAST(node, (n) => {
    if (n.k === 'Comp' && isDataComponent(n.name)) {
      ctx.problems.push({
        reason: 'dynamic_expression',
        statementId,
        component: n.name,
        message: `Instrukcja ${statementId ?? '?'}: komponent ${n.name} nie moze byc wynikiem wyrazenia; zadeklaruj go jako osobna instrukcje.`,
      });
    }
  });
}

function walkElement(el: ElementNode, ctx: WalkContext): void {
  const where = `Instrukcja ${el.statementId ?? '(wewnetrzna)'}`;
  if (ctx.mode === 'agent-views' && !ctx.catalog.allowsInAgentViews(el.typeName)) {
    ctx.problems.push({
      reason: 'component_not_allowed',
      statementId: el.statementId,
      component: el.typeName,
      message:
        `${where}: komponent ${el.typeName} nie jest dozwolony w widokach agenta. Dane pokazuja tylko ` +
        `${DATA_COMPONENTS.join(', ')}${ctx.catalog.moduleComponents.size ? ` i ${[...ctx.catalog.moduleComponents].join(', ')}` : ''}; ` +
        `uklad i tekst: ${Object.keys(AGENT_VIEW_LAYOUT_COMPONENTS).join(', ')}.`,
    });
    return;
  }
  if (isDataComponent(el.typeName)) {
    checkDataComponent(el, el.typeName, ctx);
    return;
  }
  walkValue(el.props, ctx, el.statementId);
}

/**
 * A data component: static props that satisfy its schema, a source naming a
 * registered read with input its schema accepts, a read that declares its
 * result, and only fields that result declares.
 */
function checkDataComponent(el: ElementNode, name: DataComponentName, ctx: WalkContext): void {
  const where = `Instrukcja ${el.statementId ?? '(wewnetrzna)'} (${name})`;
  const fail = (reason: CompositionRefusal, message: string) =>
    ctx.problems.push({ reason, statementId: el.statementId, component: name, message: `${where}: ${message}` });

  /*
   * Props must be literal, so what is checked is what renders. The one
   * exception is a module view's own route parameter as a source input value,
   * e.g. `{caseId: $caseId}` — declared by the view, filled by the router.
   */
  const unresolvedInputKeys: string[] = [];
  for (const { path, node } of dynamicPaths(el.props)) {
    const isParamInput =
      ctx.mode === 'catalog' &&
      path.length === 3 &&
      path[0] === 'source' &&
      path[1] === 'input' &&
      node.k === 'StateRef' &&
      ctx.params.includes(node.n.replace(/^\$/, ''));
    if (isParamInput) {
      unresolvedInputKeys.push(path[2]!);
      continue;
    }
    fail(
      'dynamic_expression',
      `wlasciwosc ${path.join('.') || '(props)'} musi byc stala` +
        (ctx.mode === 'catalog' ? ' (dozwolony jest tylko parametr widoku jako wartosc source.input).' : '.'),
    );
    return;
  }

  /*
   * `null` is how a composition skips a positional argument to reach a later
   * one (`DataTable(src, null, null, null, null, null, "status")`); it means
   * "not given", which the schema spells as absent.
   */
  const given = Object.fromEntries(Object.entries(el.props).filter(([, v]) => v !== null));
  const parsed = DATA_COMPONENT_PROPS[name].safeParse(given);
  if (!parsed.success) {
    fail(
      'invalid_props',
      `nieprawidlowe wlasciwosci — ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(props)'}: ${i.message}`)
        .join('; ')}`,
    );
    return;
  }

  let descriptor: ReadResultDescriptor | undefined;
  try {
    descriptor = prepareRead(ctx.reads, parsed.data.source, { unresolvedInputKeys }).entry.definition.result;
  } catch (err) {
    const reason = readRefusalOf(err) ?? 'invalid_source';
    fail(reason, AppError.from(err).message);
    return;
  }
  if (!descriptor) {
    fail(
      'no_descriptor',
      `operacja ${parsed.data.source.operation} nie deklaruje deskryptora wyniku, wiec komponent danych nie wie, jak ja pokazac.`,
    );
    return;
  }

  const fieldGroups: Array<[string, string[]]> = [];
  const filterFields = (f?: Array<{ field: string }>) => (f ?? []).map((p) => p.field);
  if (name === 'DataTable') {
    const p = parsed.data as DataTableProps;
    fieldGroups.push(['columns', p.columns ?? []], ['filter', filterFields(p.filter)]);
    if (p.sort) fieldGroups.push(['sort', [p.sort.field]]);
    if (p.groupBy) fieldGroups.push(['groupBy', [p.groupBy]]);
  } else if (name === 'DataChart') {
    const p = parsed.data as DataChartProps;
    fieldGroups.push(['x', [p.x]], ['series', p.series], ['filter', filterFields(p.filter)]);
    if (p.sort) fieldGroups.push(['sort', [p.sort.field]]);
  } else {
    fieldGroups.push(['fields', (parsed.data as DataSummaryProps).fields]);
  }

  let fieldsOk = true;
  for (const [prop, names] of fieldGroups) {
    try {
      const fields = pickFields(descriptor, names);
      if (name === 'DataChart' && prop === 'series') {
        const textual = fields.filter((f) => !isNumericField(f));
        if (textual.length > 0) {
          fieldsOk = false;
          fail(
            'non_numeric_series',
            `serie ${textual.map((f) => `${f.field} (${f.type})`).join(', ')} nie sa polami liczbowymi.`,
          );
        }
      }
    } catch (err) {
      fieldsOk = false;
      fail('undeclared_field', `${prop}: ${AppError.from(err).message}`);
    }
  }
  if (!fieldsOk) return;

  ctx.instances.push({ component: name, props: parsed.data, statementId: el.statementId } as DataInstance);
}

/* -------------------------------------------------------------------------- */
/*  Entry points                                                              */
/* -------------------------------------------------------------------------- */

export interface ValidateCompositionInput {
  source: string;
  mode: CompositionMode;
  catalog: OpenUiServerCatalog;
  /** Where data sources are resolved; null refuses every data component. */
  reads: ReadOperationLookup | null;
  /** Route parameters of a module view, usable as `$name` in a source input. */
  params?: readonly string[];
  /** A module view's primary read: some `DataTable` must read it. */
  primaryOperation?: string;
}

export interface ValidatedComposition {
  /** The source as stored: trimmed, without an enclosing fence. */
  source: string;
  instances: DataInstance[];
}

/** Every problem with a composition; empty when it may be stored. */
export function checkComposition(input: ValidateCompositionInput): {
  source: string;
  problems: CompositionProblem[];
  instances: DataInstance[];
} {
  const source = normalizeCompositionSource(input.source);
  const problems: CompositionProblem[] = [];
  const instances: DataInstance[] = [];
  const done = () => ({ source, problems, instances });

  if (!source) {
    problems.push({ reason: 'empty', message: 'Pusta kompozycja OpenUI.' });
    return done();
  }

  const chunks = topLevelChunks(source);
  const ids = new Map<string, number>();
  for (const chunk of chunks) {
    const head = STATEMENT_HEAD.exec(chunk);
    if (!head) {
      problems.push({
        reason: 'syntax',
        message: `Nie rozpoznano instrukcji "${chunk.slice(0, 80)}" — kazda linia ma postac nazwa = Komponent(...).`,
      });
      continue;
    }
    ids.set(head[1]!, (ids.get(head[1]!) ?? 0) + 1);
  }
  for (const [id, count] of ids) {
    if (count > 1) {
      problems.push({
        reason: 'duplicate_statement',
        statementId: id,
        message: `Instrukcja ${id} jest zdefiniowana ${count} razy; kazda nazwa moze wystapic raz.`,
      });
    }
  }
  if (problems.length === 0 && !ids.has('root')) {
    problems.push({ reason: 'missing_root', message: 'Kompozycja musi miec instrukcje root = Komponent(...).' });
  }
  if (problems.length > 0) return done();

  const result = input.catalog.parse(source);
  if (result.meta.incomplete) {
    problems.push({
      reason: 'partial',
      message: 'Kompozycja jest niekompletna: niedomkniety nawias lub cudzyslow. Zapisywana jest tylko pelna kompozycja.',
    });
    return done();
  }
  for (const e of result.meta.errors) {
    problems.push({
      reason: e.code === 'unknown-component' ? 'unknown_component' : 'invalid_props',
      statementId: e.statementId,
      component: e.component,
      message:
        e.code === 'unknown-component'
          ? `Instrukcja ${e.statementId ?? '?'}: nieznany komponent ${e.component}.`
          : `Instrukcja ${e.statementId ?? '?'} (${e.component}): ${e.message}`,
    });
  }
  for (const name of new Set(result.meta.unresolved)) {
    problems.push({
      reason: 'unresolved_reference',
      statementId: name,
      message: `Odwolanie do ${name}, ktore nie jest zdefiniowane w kompozycji.`,
    });
  }
  for (const name of result.meta.orphaned) {
    problems.push({
      reason: 'orphaned_statement',
      statementId: name,
      message: `Instrukcja ${name} nie jest osiagalna z root, wiec nie zostalaby pokazana ani sprawdzona.`,
    });
  }
  for (const q of [...result.queryStatements, ...result.mutationStatements]) {
    problems.push({
      reason: 'forbidden_reference',
      statementId: q.statementId,
      message:
        `Instrukcja ${q.statementId}: Query/Mutation nie sa dostepne — dane pokazuja komponenty danych ` +
        'przez zarejestrowane operacje odczytu.',
    });
  }
  if (input.mode === 'agent-views' && Object.keys(result.stateDeclarations).length > 0) {
    problems.push({
      reason: 'dynamic_expression',
      message: `Widok agenta nie moze deklarowac stanu (${Object.keys(result.stateDeclarations).join(', ')}).`,
    });
  }
  if (!result.root) {
    if (problems.length === 0) problems.push({ reason: 'syntax', message: 'Kompozycja nie tworzy zadnego komponentu.' });
    return done();
  }

  const ctx: WalkContext = {
    mode: input.mode,
    catalog: input.catalog,
    reads: input.reads,
    params: input.params ?? [],
    problems,
    instances,
  };
  walkElement(result.root, ctx);

  if (input.primaryOperation && problems.length === 0) {
    const primary = instances.some(
      (i) => i.component === 'DataTable' && i.props.source.operation === input.primaryOperation,
    );
    if (!primary) {
      problems.push({
        reason: 'primary_operation_missing',
        message: `Widok deklaruje primaryOperation ${input.primaryOperation}, ale zaden DataTable w kompozycji jej nie czyta.`,
      });
    }
  }
  return done();
}

/** Longest refusal message; the full list is in `details.problems`. */
const MESSAGE_PROBLEMS = 5;

/**
 * Validates a composition and returns what may be stored, or throws
 * `validation_failed` naming every problem (`details.reason` is the first one's,
 * `details.problems` lists all).
 */
export function validateComposition(input: ValidateCompositionInput): ValidatedComposition {
  const { source, problems, instances } = checkComposition(input);
  if (problems.length > 0) {
    const shown = problems.slice(0, MESSAGE_PROBLEMS).map((p) => p.message);
    const more = problems.length > MESSAGE_PROBLEMS ? ` (i ${problems.length - MESSAGE_PROBLEMS} innych)` : '';
    throw new AppError('validation_failed', `Kompozycja OpenUI odrzucona: ${shown.join(' ')}${more}`, {
      reason: problems[0]!.reason,
      problems,
    });
  }
  return { source, instances };
}

/**
 * The data component instances of a composition, with their checked props.
 *
 * For whoever needs to know what a stored composition shows — e.g. which views
 * render a given record kind and field — without resolving its reads: an
 * instance whose props do not satisfy its schema is left out, and nothing else
 * about the composition is judged.
 */
export function findDataInstances(
  source: string,
  catalog: OpenUiServerCatalog = defaultCatalog(),
): DataInstance[] {
  const result = catalog.parse(normalizeCompositionSource(source));
  const found: DataInstance[] = [];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined || isASTNode(value)) return;
    if (isElement(value)) {
      if (isDataComponent(value.typeName)) {
        const given = Object.fromEntries(Object.entries(value.props).filter(([, v]) => v !== null));
        const parsed = DATA_COMPONENT_PROPS[value.typeName].safeParse(given);
        if (parsed.success) {
          found.push({ component: value.typeName, props: parsed.data, statementId: value.statementId } as DataInstance);
        }
        return;
      }
      visit(value.props);
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else if (typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(result.root);
  return found;
}
