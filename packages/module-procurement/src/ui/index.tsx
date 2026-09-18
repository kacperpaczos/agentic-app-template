import { defineComponent } from '@openuidev/react-lang';
import type { ConversationStarterContribution, MenuItemContribution } from '@platform/contracts';
import type { UiModule } from '@platform/ui';
import { MODULE_ID } from '../shared/index.ts';
import { PROCUREMENT_OPENUI_COMPONENTS } from '../shared/openui-components.ts';
import {
  CaseSummaryCard,
  ComparisonTableCard,
  CostChartCard,
  DeliveryTermsCard,
  OfferItemFormCard,
  OfferListCard,
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
const { CaseSummary, DeliveryTerms, OfferComparison, OfferCostChart, OfferItemForm, OfferList } =
  PROCUREMENT_OPENUI_COMPONENTS;
const openuiComponents = [
  ...procurementDetailOpenuiComponents,
  /*
   * Every canvas card of this module is also a catalog component.
   *
   * Four of them (`caseSummary`, `offerList`, `deliveryTerms`, `offerItemForm`)
   * used to exist only in the card catalog, so they could be put on the canvas
   * and nowhere else — not in an agent's view, not in an answer — and their
   * renderers took untyped props. Declared here from the same schemas as the
   * card, they are one component with one contract, wherever it is composed;
   * `shared/cards.ts` holds the binding and the catalog tests check it.
   */
  defineComponent({
    name: CaseSummary.name,
    description: CaseSummary.description,
    props: CaseSummary.propsSchema,
    component: ({ props }) => (
      <CaseSummaryCard cardId={`openui-summary-${String(props.caseId)}`} props={{ caseId: props.caseId }} />
    ),
  }),
  defineComponent({
    name: OfferList.name,
    description: OfferList.description,
    props: OfferList.propsSchema,
    component: ({ props }) => (
      <OfferListCard cardId={`openui-offers-${String(props.caseId)}`} props={{ caseId: props.caseId }} />
    ),
  }),
  defineComponent({
    name: DeliveryTerms.name,
    description: DeliveryTerms.description,
    props: DeliveryTerms.propsSchema,
    component: ({ props }) => (
      <DeliveryTermsCard cardId={`openui-delivery-${String(props.caseId)}`} props={{ caseId: props.caseId }} />
    ),
  }),
  defineComponent({
    name: OfferItemForm.name,
    description: OfferItemForm.description,
    props: OfferItemForm.propsSchema,
    component: ({ props }) => (
      <OfferItemFormCard
        cardId={`openui-item-form-${String(props.offerId)}`}
        props={{ offerId: props.offerId, itemId: props.itemId }}
      />
    ),
  }),
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
  starters,
};
