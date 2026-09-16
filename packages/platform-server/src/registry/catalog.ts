import { AppError, type CardComponentDescriptor, type CardSpec } from '@platform/contracts';
import type { ServerModuleRegistry } from './modules.ts';

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

  constructor(registry: ServerModuleRegistry, platformComponents: CardComponentDescriptor[] = []) {
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
   * the component schema). Throws instead of mutating on any problem.
   */
  validate(spec: CardSpec): CardSpec {
    if (spec.kind === 'openui') {
      if (!spec.source.trim()) {
        throw new AppError('validation_failed', 'Pusta kompozycja OpenUI.');
      }
      return spec;
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
