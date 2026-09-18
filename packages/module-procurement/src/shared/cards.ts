import type { CardComponentDescriptor } from '@platform/contracts';
import { PROCUREMENT_OPENUI_COMPONENTS } from './openui-components.ts';
import {
  itemProvenancePropsSchema,
  offerComparisonPropsSchema,
  offerCostChartPropsSchema,
  caseSummaryPropsSchema,
  deliveryTermsPropsSchema,
  offerItemFormPropsSchema,
  offerListPropsSchema,
} from './openui-components.ts';

/**
 * This module's canvas cards, declared once for both halves — and bound to the
 * OpenUI component that renders the same thing.
 *
 * Two catalogs used to describe the same seven components. The server declared
 * card ids with Zod schemas (`CardComponentDescriptor`), the browser kept a map
 * of renderers taking `Record<string, unknown>`, and only three of the seven had
 * an OpenUI counterpart — so a card could be placed on the canvas but not
 * composed into a view or a message, and the renderer that drew it received an
 * untyped bag whichever way it arrived.
 *
 * This table is the single declaration. `openuiName` names the catalog
 * component that renders the same content with the same props, so:
 *
 *  - the server's card catalog and the module's OpenUI declarations come from
 *    the same schemas (`server/index.ts`);
 *  - the browser wraps each renderer with that schema (`typedCard`), which is
 *    where the props stop being `unknown`;
 *  - every card is also a catalog component, so an agent can put it in a card,
 *    in an agent view or in an answer, and it is the same component validated
 *    the same way.
 *
 * Props are references and view options only — an identifier the component
 * looks up for itself, never a business value. That is what makes a stored
 * composition incapable of carrying a stale price.
 */
export interface ProcurementCardDeclaration extends CardComponentDescriptor {
  /** The OpenUI Lang component rendering the same content from the same props. */
  openuiName: keyof typeof PROCUREMENT_OPENUI_COMPONENTS;
}

export const PROCUREMENT_CARD_COMPONENTS = [
  {
    id: 'procurement.caseSummary',
    openuiName: 'CaseSummary',
    description: 'Podsumowanie sprawy zakupowej: podstawa porownania, liczba ofert i pozycji.',
    usage: 'props: { caseId }',
    propsSchema: caseSummaryPropsSchema,
  },
  {
    id: 'procurement.offerList',
    openuiName: 'OfferList',
    description: 'Lista ofert w sprawie z dostawca, referencja i liczba pozycji.',
    usage: 'props: { caseId }',
    propsSchema: offerListPropsSchema,
  },
  {
    id: 'procurement.comparisonTable',
    openuiName: 'OfferComparison',
    description:
      'Tabela porownawcza ofert wyliczona przez backend: sumy, kompletnosc, ranking i oferty wykluczone z przyczyna.',
    usage: 'props: { caseId, showExcluded?: boolean }',
    propsSchema: offerComparisonPropsSchema,
  },
  {
    id: 'procurement.costChart',
    openuiName: 'OfferCostChart',
    description: 'Wykres slupkowy kosztu calkowitego porownywalnych ofert.',
    usage: 'props: { caseId }',
    propsSchema: offerCostChartPropsSchema,
  },
  {
    id: 'procurement.deliveryTerms',
    openuiName: 'DeliveryTerms',
    description: 'Zestawienie warunkow dostawy i waznosci ofert.',
    usage: 'props: { caseId }',
    propsSchema: deliveryTermsPropsSchema,
  },
  {
    id: 'procurement.offerItemForm',
    openuiName: 'OfferItemForm',
    description: 'Formularz edycji pozycji oferty (ilosc, cena jednostkowa, jednostka, notatka).',
    usage: 'props: { offerId, itemId? }',
    propsSchema: offerItemFormPropsSchema,
  },
  {
    id: 'procurement.provenance',
    openuiName: 'ItemProvenance',
    description: 'Pochodzenie wartosci pozycji: oferta, dostawca, zalacznik zrodlowy i miejsce w pliku.',
    usage: 'props: { itemId }',
    propsSchema: itemProvenancePropsSchema,
  },
] as const satisfies readonly ProcurementCardDeclaration[];

/** Card id → the OpenUI component that renders it. Read by the catalog tests. */
export const PROCUREMENT_CARD_TO_OPENUI: Record<string, string> = Object.fromEntries(
  PROCUREMENT_CARD_COMPONENTS.map((c) => [c.id, c.openuiName]),
);
