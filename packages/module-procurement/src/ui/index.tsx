import { defineComponent } from '@openuidev/react-lang';
import type {
  ConversationStarterContribution,
  MenuItemContribution,
  MenuSectionLabels,
} from '@platform/contracts';
import type { ModuleScreen, UiModule } from '@platform/ui';
import { MODULE_ID } from '../shared/index.ts';
import { PROCUREMENT_OPENUI_COMPONENTS } from '../shared/openui-components.ts';
import {
  ComparisonTableCard,
  CostChartCard,
  procurementCardRenderers,
} from './cards.tsx';
import { procurementDetailOpenuiComponents } from './detailComponents.tsx';
import { CaseDetailPage, CasesPage, DataPage, ItemProvenancePage } from './pages.tsx';

export { CaseDetailPage, CasesPage, DataPage, ItemProvenancePage } from './pages.tsx';
export * from './cards.tsx';
export * from './detailComponents.tsx';

const menu: MenuItemContribution[] = [
  { id: 'procurement.cases', section: 'records', label: 'Wszystkie sprawy', to: '/cases', order: 10 },
  { id: 'procurement.suppliers', section: 'data', label: 'Dostawcy', to: '/data', order: 10 },
];

/**
 * What this module calls the sections it puts those items in.
 *
 * "Sprawy zakupowe" is a sentence about somebody's business, so it belongs
 * here and not in the shell — which is exactly where it used to live
 * (`AppShell.tsx`, `SECTION_LABELS.records`), with the result that an
 * application composing any other module still read "Sprawy zakupowe".
 */
const menuSections: MenuSectionLabels = { records: 'Sprawy zakupowe' };

/**
 * This module's screens, declared for the composition root to mount.
 *
 * The paths and their `$segments` are the module's own: no file outside this
 * package names `/cases/$caseId`, and the pages read those segments through
 * `useScreenParams()` rather than through the application's route registration,
 * so this list compiles whether or not the application mounts it.
 */
const screens: ModuleScreen[] = [
  { id: 'procurement.cases', path: '/cases', component: CasesPage },
  { id: 'procurement.case.detail', path: '/cases/$caseId', component: CaseDetailPage },
  { id: 'procurement.data', path: '/data', component: DataPage },
  { id: 'procurement.item.provenance', path: '/items/$itemId', component: ItemProvenancePage },
];

const starters: ConversationStarterContribution[] = [
  {
    displayText: 'Porownaj oferty',
    prompt: 'Porownaj oferty dla tej sprawy i pokaz tabele porownawcza na canvasie.',
  },
  {
    displayText: 'Wykres kosztow',
    prompt: 'Dodaj wykres kosztow i pokaz obok warunki dostawy.',
  },
  {
    displayText: 'Skad ta cena',
    prompt: 'Znajdz, skad pochodzi cena zaznaczonej pozycji.',
  },
];

/**
 * OpenUI Lang components the agent may compose directly inside a chat message
 * or inside an `openui` card. They render the same React components as the
 * canvas cards, so a table written by the agent and a table in the default
 * layout are the same table reading the same backend data.
 *
 * Name, description and props schema of every one of them come from
 * `shared/openui-components.ts`, which the server half declares too — see there
 * for why.
 */
const { OfferComparison, OfferCostChart } = PROCUREMENT_OPENUI_COMPONENTS;
const openuiComponents = [
  ...procurementDetailOpenuiComponents,
  defineComponent({
    name: OfferComparison.name,
    description: OfferComparison.description,
    props: OfferComparison.propsSchema,
    component: ({ props }) => (
      <ComparisonTableCard
        cardId={`openui-${String(props.caseId)}`}
        props={{ caseId: props.caseId, showExcluded: props.showExcluded }}
      />
    ),
  }),
  defineComponent({
    name: OfferCostChart.name,
    description: OfferCostChart.description,
    props: OfferCostChart.propsSchema,
    component: ({ props }) => (
      <CostChartCard cardId={`openui-chart-${String(props.caseId)}`} props={{ caseId: props.caseId }} />
    ),
  }),
];

/** Browser half of the procurement module. */
export const procurementUiModule: UiModule = {
  meta: {
    id: MODULE_ID,
    title: 'Porownywanie ofert zakupowych',
    version: '0.1.0',
    description: 'Karty, ekrany i komponenty OpenUI domeny zakupowej.',
  },
  cardRenderers: procurementCardRenderers,
  openuiComponents,
  menu,
  menuSections,
  screens,
  starters,
};
