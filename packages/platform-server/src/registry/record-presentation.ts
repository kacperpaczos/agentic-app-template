import { isASTNode } from '@openuidev/lang-core';
import type {
  CanvasCard,
  DataSource,
  ReadResultDescriptor,
  RecordField,
  SemanticInstance,
  UiRevealPresentation,
  ViewDefinition,
  ViewFilterPredicate,
} from '@platform/contracts';
import type { ServerModuleRegistry } from './modules.ts';
import { findDataInstances, type OpenUiServerCatalog } from './openui-validation.ts';

/**
 * Where a record's field is shown: the mapping from (record kind, field) to the
 * places in the interface that render it.
 *
 * **Why derived from declarations and not from the screen.** "Show me this
 * value" must be answerable before anything moves: which views render records
 * of this kind, whether they show this field, and whether one or several do.
 * Everything needed is already declared — the compositions of module views and
 * of the run's conversation's agent views name their reads, and each read's
 * descriptor names its record kind and fields — so the mapping is computed
 * from those, and can be checked on its own (`tests/show-value.test.ts`).
 *
 * The places considered are only the ones the user can be taken to or is
 * looking at:
 *
 *  - a module view on its own screen — a view with a `UiTarget` of the same id
 *    that has a route (`to`) and no route parameters;
 *  - a card of the run's conversation's agent views (`platform.agentViews`);
 *  - a module view with route parameters (a record's own screen), **only while
 *    the tab bound to the run shows it**: its parameters are read from that
 *    tab's description, never guessed.
 *
 * Only `DataTable` instances count. A table draws each record's fields as cells
 * that carry the record and the field, and can bring any of its records on
 * screen — through its narrowing and its pages. A chart draws aggregates and a
 * summary draws a fixed number of records, so neither is a place a given
 * record's value is guaranteed to be shown.
 */

/** The platform's catalog target of the agent views page. */
export const AGENT_VIEWS_TARGET_ID = 'platform.agentViews';

/** One data component instance that renders records of the kind asked about. */
export interface PresentationCandidate {
  /**
   * What names this place in `ui_show_value`'s `targetId`: the view's id, or
   * the agent view card's id — with `#<statement>` appended when one place has
   * several such instances. Unique among the candidates of one question.
   */
  targetId: string;
  presentation: UiRevealPresentation;
  /** The catalog target the client opens; null for a record screen shown now (not navigated to). */
  uiTargetId: string | null;
  /** What the user calls the place: the target's label, the view's or the card's title. */
  label: string;
  /** The composition statement of the instance. */
  statementId: string | null;
  /** The instance's read, with route parameters filled in. */
  source: DataSource;
  descriptor: ReadResultDescriptor;
  /** The fields the table renders, in order. */
  fields: string[];
  /** The composition's own narrowing of the table: a record it excludes is not shown there. */
  filter: ViewFilterPredicate[];
}

/** A module view the tab bound to the run is showing, with the instances it described. */
export interface DisplayedView {
  view: ViewDefinition;
  instances: readonly SemanticInstance[];
}

/** Descriptors of every registered read whose records are of this kind. */
export function descriptorsOfKind(registry: ServerModuleRegistry, recordKind: string): ReadResultDescriptor[] {
  return registry.readOperations
    .map((op) => op.definition.result)
    .filter((d): d is ReadResultDescriptor => d?.record.kind === recordKind);
}

/** Every field declared for records of this kind, by name, the first declaration of each. */
export function declaredFieldsOfKind(registry: ServerModuleRegistry, recordKind: string): RecordField[] {
  const out = new Map<string, RecordField>();
  for (const d of descriptorsOfKind(registry, recordKind)) {
    for (const f of d.fields) if (!out.has(f.field)) out.set(f.field, f);
  }
  return [...out.values()];
}

/** Every record kind some registered read declares. */
export function declaredRecordKinds(registry: ServerModuleRegistry): string[] {
  return [
    ...new Set(
      registry.readOperations
        .map((op) => op.definition.result?.record.kind)
        .filter((k): k is string => Boolean(k)),
    ),
  ];
}

/** A composition's `$name` reference to a route parameter, as the parser leaves it in props. */
const paramRef = (value: unknown): string | null =>
  isASTNode(value) && (value as { k?: unknown }).k === 'StateRef'
    ? String((value as { n?: unknown }).n ?? '').replace(/^\$/, '') || null
    : null;

/**
 * The route parameters of a displayed view, read from what its instances say
 * they are reading: a composition input `{caseId: $caseId}` and a mounted
 * instance of the same view, component and read with `input.caseId = "c1"` give
 * `caseId = "c1"`. Null unless every declared parameter is found, and found
 * with one value.
 */
export function displayedViewParams(
  view: ViewDefinition,
  compositionInstances: ReturnType<typeof findDataInstances>,
  displayed: readonly SemanticInstance[],
): Record<string, string> | null {
  const values = new Map<string, Set<string>>();
  for (const instance of compositionInstances) {
    const input = (instance.props.source.input ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(input)) {
      const param = paramRef(value);
      if (!param) continue;
      for (const mounted of displayed) {
        if (mounted.viewId !== view.id || mounted.component !== instance.component) continue;
        if (mounted.source.operation !== instance.props.source.operation) continue;
        const given = (mounted.source.input as Record<string, unknown> | undefined)?.[key];
        if (typeof given !== 'string' || !given) continue;
        if (!values.has(param)) values.set(param, new Set());
        values.get(param)!.add(given);
      }
    }
  }
  const params: Record<string, string> = {};
  for (const name of view.params ?? []) {
    const found = values.get(name);
    if (!found || found.size !== 1) return null;
    params[name] = [...found][0]!;
  }
  return params;
}

/** A source with its `$param` references replaced by the parameters' values. */
function resolveSource(source: DataSource, params: Record<string, string>): DataSource | null {
  if (!source.input) return source;
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source.input)) {
    const param = paramRef(value);
    if (param === null) {
      input[key] = value;
      continue;
    }
    if (!(param in params)) return null;
    input[key] = params[param];
  }
  return { operation: source.operation, input };
}

/**
 * Every table, in every place the run can show, that renders records of
 * `recordKind` — whichever fields it shows. Callers narrow to a field.
 */
export function presentationCandidates(input: {
  registry: ServerModuleRegistry;
  catalog: OpenUiServerCatalog;
  recordKind: string;
  /** Cards of the run's conversation's agent views space, in its order. */
  agentViewCards: readonly CanvasCard[];
  /** The record screen the tab bound to the run shows, if it shows one. */
  displayed: DisplayedView | null;
}): PresentationCandidate[] {
  const { registry, catalog, recordKind } = input;
  const found: Array<Omit<PresentationCandidate, 'targetId'> & { base: string }> = [];

  const collect = (
    composition: string,
    place: { base: string; presentation: UiRevealPresentation; uiTargetId: string | null; label: string },
    params: Record<string, string>,
  ) => {
    let instances: ReturnType<typeof findDataInstances>;
    try {
      instances = findDataInstances(composition, catalog);
    } catch {
      // A composition the parser cannot read renders nothing to point at.
      return;
    }
    for (const instance of instances) {
      if (instance.component !== 'DataTable') continue;
      const descriptor = registry.readOperation(instance.props.source.operation)?.definition.result;
      if (!descriptor || descriptor.record.kind !== recordKind) continue;
      const source = resolveSource(instance.props.source, params);
      if (!source) continue;
      found.push({
        ...place,
        statementId: instance.statementId ?? null,
        source,
        descriptor,
        fields: [...(instance.props.columns ?? descriptor.fields.map((f) => f.field))],
        filter: [...(instance.props.filter ?? [])],
      });
    }
  };

  const targets = registry.uiTargets();
  for (const view of registry.views()) {
    if (view.params?.length) continue;
    const target = targets.find((t) => t.id === view.id && t.to);
    if (!target) continue;
    collect(
      view.composition,
      { base: view.id, presentation: { kind: 'view', viewId: view.id }, uiTargetId: target.id, label: target.label },
      {},
    );
  }

  for (const card of input.agentViewCards) {
    if (card.spec.kind !== 'openui') continue;
    collect(
      card.spec.source,
      {
        base: card.id,
        presentation: { kind: 'agent_view', cardId: card.id },
        uiTargetId: AGENT_VIEWS_TARGET_ID,
        label: card.title,
      },
      {},
    );
  }

  if (input.displayed?.view.params?.length) {
    const { view } = input.displayed;
    const params = displayedViewParams(view, findDataInstances(view.composition, catalog), input.displayed.instances);
    if (params) {
      collect(view.composition, { base: view.id, presentation: { kind: 'view', viewId: view.id }, uiTargetId: null, label: view.title }, params);
    }
  }

  const perPlace = new Map<string, number>();
  for (const c of found) perPlace.set(c.base, (perPlace.get(c.base) ?? 0) + 1);
  return found.map(({ base, ...c }) => ({
    ...c,
    targetId: (perPlace.get(base) ?? 0) > 1 && c.statementId ? `${base}#${c.statementId}` : base,
  }));
}

/**
 * Whether a candidate is the place `targetId` names: its own id, its view or
 * card, or — for `platform.agentViews` — any card of the agent views.
 */
export function candidateMatches(candidate: PresentationCandidate, targetId: string): boolean {
  if (candidate.targetId === targetId) return true;
  const p = candidate.presentation;
  if (p.kind === 'view') return p.viewId === targetId;
  return p.cardId === targetId || targetId === AGENT_VIEWS_TARGET_ID;
}
