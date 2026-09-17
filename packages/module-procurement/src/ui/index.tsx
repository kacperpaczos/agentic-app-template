import { z } from 'zod';
import { defineComponent } from '@openuidev/react-lang';
import type { ConversationStarterContribution, MenuItemContribution } from '@platform/contracts';
import type { UiModule } from '@platform/ui';
import { MODULE_ID } from '../shared/index.ts';
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
 */
const openuiComponents = [
  ...procurementDetailOpenuiComponents,
  defineComponent({
    name: 'OfferComparison',
    description:
      'Tabela porownawcza ofert dla sprawy zakupowej. Dane pobiera backend; podaj wylacznie identyfikator sprawy.',
    props: z.object({
      caseId: z.string().describe('Identyfikator sprawy zakupowej'),
      showExcluded: z.boolean().optional().describe('Czy pokazac oferty wykluczone z rankingu'),
    }),
    component: ({ props }) => (
      <ComparisonTableCard
        cardId={`openui-${String(props.caseId)}`}
        props={{ caseId: props.caseId, showExcluded: props.showExcluded }}
      />
    ),
  }),
  defineComponent({
    name: 'OfferCostChart',
    description: 'Wykres kosztu calkowitego ofert w sprawie zakupowej.',
    props: z.object({ caseId: z.string().describe('Identyfikator sprawy zakupowej') }),
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
