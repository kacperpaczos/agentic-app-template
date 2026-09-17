import { AppError, type CardComponentDescriptor, type CardSpec } from '@platform/contracts';
import type { ServerModuleRegistry } from './modules.ts';
import { OpenUiServerCatalog, validateComposition, type CompositionMode } from './openui-validation.ts';

/**
 * Server-side component catalog.
 *
 * Both the default composition and any composition an agent proposes are checked
 * here before they are written. An unknown component id, or props that fail the
 * component's schema, is rejected with `validation_failed` and the previously
 * stored composition is left exactly as it was.
 */
export class ComponentCatalog {
  readonly #byId = new Map<string, CardComponentDescriptor>();
  readonly #registry: ServerModuleRegistry;
  /** The OpenUI Lang half of the catalog, which `openui` cards are parsed against. */
  readonly openui: OpenUiServerCatalog;

  constructor(registry: ServerModuleRegistry, platformComponents: CardComponentDescriptor[] = []) {
    this.#registry = registry;
    this.openui = new OpenUiServerCatalog(registry.modules.flatMap((m) => m.openuiComponents ?? []));
    for (const c of platformComponents) this.#byId.set(c.id, c);
    for (const mod of registry.modules) {
      for (const c of mod.cardComponents ?? []) {
        if (this.#byId.has(c.id)) {
          throw new AppError('conflict', `Komponent ${c.id} jest juz w katalogu.`);
        }
        this.#byId.set(c.id, c);
      }
    }
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  list(): CardComponentDescriptor[] {
    return [...this.#byId.values()];
  }

  /** Machine-readable catalog for the UI and for diagnostics. */
  describe(): Array<{ id: string; description: string; usage: string }> {
    return this.list().map((c) => ({ id: c.id, description: c.description, usage: c.usage }));
  }

  /** Catalog section of the agent's system prompt. */
  prompt(): string {
    if (this.#byId.size === 0) return 'Katalog komponentow jest pusty.';
    return this.list()
      .map((c) => `- ${c.id}: ${c.description}\n  uzycie: ${c.usage}`)
      .join('\n');
  }

  /**
   * Validates a card spec and returns the normalised version (props coerced by
   * the component schema, OpenUI source trimmed and unfenced). Throws instead of
   * mutating on any problem.
   *
   * `mode` is `agent-views` for a card in a conversation's agent views space —
   * see `CanvasService.compositionModeOfSpace` — and `catalog` otherwise.
   */
  validate(spec: CardSpec, options: { mode?: CompositionMode } = {}): CardSpec {
    if (spec.kind === 'openui') {
      const { source } = validateComposition({
        source: spec.source,
        mode: options.mode ?? 'catalog',
        catalog: this.openui,
        reads: this.#registry,
      });
      return { kind: 'openui', source };
    }
    if (options.mode === 'agent-views') {
      throw new AppError(
        'validation_failed',
        `Widok agenta jest kompozycja OpenUI (kind: "openui"); karta komponentu ${spec.component} nie jest tu dozwolona.`,
        { reason: 'component_not_allowed' },
      );
    }
    const descriptor = this.#byId.get(spec.component);
    if (!descriptor) {
      throw new AppError('validation_failed', `Nieznany komponent: ${spec.component}`, {
        allowed: [...this.#byId.keys()],
      });
    }
    const parsed = descriptor.propsSchema.safeParse(spec.props ?? {});
    if (!parsed.success) {
      throw new AppError(
        'validation_failed',
        `Nieprawidlowe wlasciwosci komponentu ${spec.component}.`,
        {
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      );
    }
    return { kind: 'component', component: spec.component, props: parsed.data };
  }
}
