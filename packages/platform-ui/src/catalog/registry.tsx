import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { createLibrary, type DefinedComponent, type Library } from '@openuidev/react-lang';
import { openuiLibrary } from '@openuidev/react-ui';
import type {
  ConversationStarterContribution,
  MenuItemContribution,
  ModuleMeta,
} from '@platform/contracts';
import { platformDataComponents } from '../views/dataComponents.tsx';

/**
 * `DefinedComponent` is invariant in its props schema, so a heterogeneous
 * catalog cannot be typed precisely. The schema is enforced at runtime by the
 * OpenUI parser and, for canvas cards, by the server-side catalog — which is
 * where it matters. Widening here buys nothing away.
 */
type AnyDefinedComponent = DefinedComponent<any>;
export type AnyLibrary = Library;

/** Props every card component receives. */
export interface CardComponentProps {
  cardId: string;
  props: Record<string, unknown>;
}

export type CardComponent = ComponentType<CardComponentProps>;

export interface ArtifactRendererProps {
  artifactId: string;
  content: unknown;
  meta: Record<string, unknown>;
}

/**
 * Browser half of a business module.
 *
 * Mirrors `ServerModule`: the server validates a composition against its
 * `cardComponents`, the browser renders it from `cardRenderers`. The two lists
 * are kept in step by `tests/catalog-parity.test.ts`.
 */
export interface UiModule {
  meta: ModuleMeta;
  /** Card renderers keyed by the component id used in `CardSpec.component`. */
  cardRenderers: Record<string, CardComponent>;
  /** OpenUI Lang components the agent may compose inside a card or a message. */
  openuiComponents?: AnyDefinedComponent[];
  /** Artifact renderers keyed by `rendererType`. */
  artifactRenderers?: Record<string, ComponentType<ArtifactRendererProps>>;
  menu: MenuItemContribution[];
  /** Suggested opening commands shown in the chat composer. */
  starters?: ConversationStarterContribution[];
}

export interface ClientRegistry {
  modules: UiModule[];
  cardRenderers: Record<string, CardComponent>;
  artifactRenderers: Record<string, ComponentType<ArtifactRendererProps>>;
  menu: MenuItemContribution[];
  starters: ConversationStarterContribution[];
  /** Merged OpenUI catalog: the ready-made one plus every module's additions. */
  library: AnyLibrary;
}

/**
 * Builds the client registry.
 *
 * `openuiLibrary` from `@openuidev/react-ui` supplies the generic catalog
 * (text, tables, charts, forms) out of the box; modules add domain components on
 * top. Composition and rendering therefore use one catalog — the initial layout
 * and an agent-authored layout cannot diverge.
 */
export function buildRegistry(input: {
  modules: UiModule[];
  platformCardRenderers: Record<string, CardComponent>;
  platformArtifactRenderers?: Record<string, ComponentType<ArtifactRendererProps>>;
  platformMenu: MenuItemContribution[];
}): ClientRegistry {
  const cardRenderers: Record<string, CardComponent> = { ...input.platformCardRenderers };
  const artifactRenderers: Record<string, ComponentType<ArtifactRendererProps>> = {
    ...(input.platformArtifactRenderers ?? {}),
  };
  const menu = [...input.platformMenu];
  const starters: ConversationStarterContribution[] = [];
  /*
   * The platform's data components are always in the catalog: module views are
   * made of them, and an `openui` card or a chat answer may use them too.
   */
  const extraComponents: AnyDefinedComponent[] = [...platformDataComponents];

  for (const mod of input.modules) {
    for (const [id, renderer] of Object.entries(mod.cardRenderers)) {
      if (cardRenderers[id]) {
        throw new Error(`Konflikt katalogu: komponent karty "${id}" jest juz zarejestrowany.`);
      }
      cardRenderers[id] = renderer;
    }
    for (const [type, renderer] of Object.entries(mod.artifactRenderers ?? {})) {
      artifactRenderers[type] = renderer;
    }
    menu.push(...mod.menu);
    starters.push(...(mod.starters ?? []));
    extraComponents.push(...(mod.openuiComponents ?? []));
  }

  menu.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  // `Library.components` is a Record keyed by component name, while
  // `createLibrary` takes an array — hence the values() on the way back in.
  const base = openuiLibrary as unknown as AnyLibrary;
  const names = new Set(Object.keys(base.components));
  for (const c of extraComponents) {
    // A second component under a taken name would silently replace the first.
    if (names.has(c.name)) {
      throw new Error(`Konflikt katalogu: komponent OpenUI "${c.name}" jest juz zarejestrowany.`);
    }
    names.add(c.name);
  }
  const library = createLibrary({
    components: [...Object.values(base.components), ...extraComponents],
    componentGroups: base.componentGroups,
    root: base.root,
    id: 'app-catalog',
  });

  return { modules: input.modules, cardRenderers, artifactRenderers, menu, starters, library };
}

const RegistryContext = createContext<ClientRegistry | null>(null);

export function RegistryProvider(props: { registry: ClientRegistry; children: ReactNode }) {
  return <RegistryContext.Provider value={props.registry}>{props.children}</RegistryContext.Provider>;
}

export function useRegistry(): ClientRegistry {
  const ctx = useContext(RegistryContext);
  if (!ctx) throw new Error('RegistryProvider nie jest zamontowany.');
  return ctx;
}
