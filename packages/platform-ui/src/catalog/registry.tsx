import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { createLibrary, type DefinedComponent, type Library } from '@openuidev/react-lang';
import { openuiLibrary } from '@openuidev/react-ui';
import {
  MENU_SECTIONS,
  type ConversationStarterContribution,
  type MenuItemContribution,
  type MenuSection,
  type MenuSectionLabels,
  type ModuleMeta,
  type ModuleScreenContribution,
} from '@platform/contracts';
import { platformDataComponents } from '../views/dataComponents.tsx';

/**
 * Headings for navigation sections nobody named.
 *
 * Deliberately words about *the application's own furniture* — a record, a
 * file, a setting — and not about anyone's business. A module that has a better
 * word for one of its sections says so in `UiModule.menuSections`; this is what
 * is left when it does not, and it has to read sensibly for any domain,
 * because the platform will never know which one it is serving.
 */
export const NEUTRAL_MENU_SECTION_LABELS: Record<MenuSection, string> = {
  workspace: 'Przestrzen pracy',
  records: 'Rekordy',
  data: 'Dane',
  files: 'Pliki i raporty',
  settings: 'Ustawienia',
};

/**
 * `DefinedComponent` is invariant in its props schema, so a heterogeneous
 * catalog cannot be typed precisely. The schema is enforced at runtime by the
 * OpenUI parser and, for canvas cards, by the server-side catalog — which is
 * where it matters. Widening here buys nothing away.
 */
type AnyDefinedComponent = DefinedComponent<any>;
export type AnyLibrary = Library;

/**
 * Props every card component receives.
 *
 * Generic in the card's own props so a component can declare what it takes
 * instead of reading an untyped bag. The untyped form is still the registry's
 * type — the registry holds cards of many shapes — and `typedCard` is the one
 * bridge between the two: it parses before it renders, so the only code that
 * ever sees `Record<string, unknown>` is the parser.
 */
export interface CardComponentProps<P = Record<string, unknown>> {
  cardId: string;
  props: P;
}

export type CardComponent<P = Record<string, unknown>> = ComponentType<CardComponentProps<P>>;

/**
 * A card component with declared, validated props.
 *
 * Card specs are data: they come from a composition an agent wrote, from a
 * module's default layout, or from whatever was stored months ago under an
 * older version of the component. Until now every renderer received them as
 * `Record<string, unknown>` and coerced each field itself (`String(props.caseId
 * ?? '')`), which means a missing or wrong-typed property became an empty
 * string and then an empty card — a silent wrong answer.
 *
 * `typedCard` takes the same schema the server validates the composition with
 * and parses the props once, at the boundary. What renders is typed; what does
 * not parse is a readable failure naming the component, not a blank.
 *
 * The schema is taken structurally (`{ parse }`) rather than as a Zod type:
 * the browser package has no reason to depend on the validator a module happens
 * to use.
 */
export function typedCard<P>(
  schema: { parse: (value: unknown) => P },
  Render: ComponentType<CardComponentProps<P>>,
): CardComponent {
  const name = Render.displayName ?? Render.name ?? 'Card';
  const Typed: CardComponent = ({ cardId, props }) => {
    let parsed: P;
    try {
      parsed = schema.parse(props);
    } catch (e) {
      return (
        <div className="pf-state pf-state--error" role="alert" data-testid="card-props-invalid">
          Karta <code>{name}</code> dostala wlasciwosci niezgodne ze swoim schematem:{' '}
          {(e as Error).message}
        </div>
      );
    }
    return <Render cardId={cardId} props={parsed} />;
  };
  Typed.displayName = `typedCard(${name})`;
  return Typed;
}

export interface ArtifactRendererProps {
  artifactId: string;
  content: unknown;
  meta: Record<string, unknown>;
}

/**
 * A screen component. Deliberately a plain function of no props: the router
 * mounts it on a path, and everything it needs — its route parameters, the
 * session — it reads through the platform's hooks.
 */
export type ScreenComponent = () => ReactNode;

/** A module screen the composition root mounts as a route. */
export type ModuleScreen = ModuleScreenContribution<ScreenComponent>;

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
  /**
   * What this module calls the navigation sections it puts items in. A section
   * nobody names keeps the neutral heading — the platform has no business
   * vocabulary of its own. See {@link MenuSectionLabels}.
   */
  menuSections?: MenuSectionLabels;
  /**
   * Screens this module contributes to the router. Mounted generically by the
   * composition root, which therefore names no page of any module.
   */
  screens?: ModuleScreen[];
  /** Suggested opening commands shown in the chat composer. */
  starters?: ConversationStarterContribution[];
}

export interface ClientRegistry {
  modules: UiModule[];
  cardRenderers: Record<string, CardComponent>;
  artifactRenderers: Record<string, ComponentType<ArtifactRendererProps>>;
  menu: MenuItemContribution[];
  /** Heading of every navigation section: the module's word, or the neutral one. */
  menuSections: Record<MenuSection, string>;
  /** Every module screen, in registration order, ready to be mounted as routes. */
  screens: ModuleScreen[];
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
  /**
   * Paths the platform's own screens occupy. A module screen claiming one of
   * them is refused: the router would mount two routes on one path and the
   * winner would depend on registration order.
   */
  platformScreenPaths?: string[];
}): ClientRegistry {
  const cardRenderers: Record<string, CardComponent> = { ...input.platformCardRenderers };
  const artifactRenderers: Record<string, ComponentType<ArtifactRendererProps>> = {
    ...(input.platformArtifactRenderers ?? {}),
  };
  const menu = [...input.platformMenu];
  const menuSections: Record<MenuSection, string> = { ...NEUTRAL_MENU_SECTION_LABELS };
  const sectionNamedBy = new Map<MenuSection, string>();
  const screens: ModuleScreen[] = [];
  const takenPaths = new Set(input.platformScreenPaths ?? []);
  const takenScreenIds = new Set<string>();
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
    for (const screen of mod.screens ?? []) {
      if (takenScreenIds.has(screen.id)) {
        throw new Error(`Konflikt ekranow: ekran "${screen.id}" jest juz zarejestrowany.`);
      }
      if (takenPaths.has(screen.path)) {
        throw new Error(`Konflikt ekranow: sciezka "${screen.path}" jest juz zajeta (ekran ${screen.id}).`);
      }
      takenScreenIds.add(screen.id);
      takenPaths.add(screen.path);
      screens.push(screen);
    }
    for (const section of MENU_SECTIONS) {
      const label = mod.menuSections?.[section];
      if (label === undefined) continue;
      const named = sectionNamedBy.get(section);
      if (named !== undefined && menuSections[section] !== label) {
        // Two modules disagree about what this part of the workspace is called.
        // Left to the composition root rather than to the order of `modules`.
        throw new Error(
          `Konflikt nazw sekcji: "${section}" nazywa juz modul ${named} („${menuSections[section]}”), a modul ${mod.meta.id} nazywa ja „${label}”.`,
        );
      }
      menuSections[section] = label;
      sectionNamedBy.set(section, mod.meta.id);
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

  return { modules: input.modules, cardRenderers, artifactRenderers, menu, menuSections, screens, starters, library };
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
