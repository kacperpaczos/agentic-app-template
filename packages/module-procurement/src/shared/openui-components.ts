import { z } from 'zod';
import type { OpenUiComponentDeclaration } from '@platform/contracts';

/**
 * This module's OpenUI Lang components, as both halves know them — the one
 * place they are declared.
 *
 * React-free on purpose: the browser half renders each one (`defineComponent`
 * in `ui/index.tsx` and `ui/detailComponents.tsx`) and the server half declares
 * it (`ServerModule.openuiComponents` in `server/index.ts`), so every
 * composition that calls one — a module view such as the case detail screen,
 * an `openui` card, an agent's view — is validated against these schemas
 * before it is stored or, for a module view, before the application starts.
 * Both halves take the name, the description and the props schema from here;
 * the key order of a schema is the positional argument order in OpenUI Lang,
 * and `tests/openui-catalog-parity.test.ts` checks that the browser's catalog
 * and the server's agree on all of it.
 *
 * Every data-fetching component's prop is a reference — an id the component
 * looks up itself — never a business value, so a composition naming one of
 * these components can never carry a stale copy of a price or a quantity.
 * `SectionHeading` is the one exception: it fetches nothing, and its `text` is
 * fixed UI copy chosen by the composition — the same kind of literal the
 * catalog's own `TextContent` already takes.
 */

export const sectionHeadingPropsSchema = z.object({
  text: z.string().min(1).max(200).describe('Tresc naglowka sekcji'),
});
export type SectionHeadingProps = z.infer<typeof sectionHeadingPropsSchema>;

export const caseHeaderPropsSchema = z.object({
  caseId: z.string().min(1).max(128).describe('Identyfikator sprawy zakupowej'),
});
export type CaseHeaderProps = z.infer<typeof caseHeaderPropsSchema>;

export const caseOfferSourcesPropsSchema = z.object({
  caseId: z.string().min(1).max(128).describe('Identyfikator sprawy zakupowej'),
});
export type CaseOfferSourcesProps = z.infer<typeof caseOfferSourcesPropsSchema>;

export const itemProvenancePropsSchema = z.object({
  itemId: z.string().min(1).max(128).describe('Identyfikator pozycji oferty'),
});
export type ItemProvenanceProps = z.infer<typeof itemProvenancePropsSchema>;

export const caseSummaryPropsSchema = z.object({
  caseId: z.string().min(1).max(128).describe('Identyfikator sprawy zakupowej'),
});
export type CaseSummaryProps = z.infer<typeof caseSummaryPropsSchema>;

export const offerListPropsSchema = z.object({
  caseId: z.string().min(1).max(128).describe('Identyfikator sprawy zakupowej'),
});
export type OfferListProps = z.infer<typeof offerListPropsSchema>;

export const deliveryTermsPropsSchema = z.object({
  caseId: z.string().min(1).max(128).describe('Identyfikator sprawy zakupowej'),
});
export type DeliveryTermsProps = z.infer<typeof deliveryTermsPropsSchema>;

export const offerItemFormPropsSchema = z.object({
  offerId: z.string().min(1).max(128).describe('Identyfikator oferty'),
  itemId: z.string().max(128).optional().describe('Identyfikator pozycji do wybrania na starcie'),
});
export type OfferItemFormProps = z.infer<typeof offerItemFormPropsSchema>;

export const offerComparisonPropsSchema = z.object({
  caseId: z.string().describe('Identyfikator sprawy zakupowej'),
  showExcluded: z.boolean().optional().describe('Czy pokazac oferty wykluczone z rankingu'),
});

export type OfferComparisonProps = z.infer<typeof offerComparisonPropsSchema>;

export const offerCostChartPropsSchema = z.object({
  caseId: z.string().describe('Identyfikator sprawy zakupowej'),
});
export type OfferCostChartProps = z.infer<typeof offerCostChartPropsSchema>;

export const PROCUREMENT_OPENUI_COMPONENTS = {
  CaseSummary: {
    name: 'CaseSummary',
    description:
      'Podsumowanie sprawy zakupowej: podstawa porownania, liczba ofert i pozycji. ' +
      'Podaj wylacznie identyfikator sprawy.',
    propsSchema: caseSummaryPropsSchema,
  },
  OfferList: {
    name: 'OfferList',
    description:
      'Lista ofert w sprawie z dostawca, referencja i liczba pozycji. Podaj wylacznie identyfikator sprawy.',
    propsSchema: offerListPropsSchema,
  },
  DeliveryTerms: {
    name: 'DeliveryTerms',
    description:
      'Zestawienie warunkow dostawy i waznosci ofert w sprawie. Podaj wylacznie identyfikator sprawy.',
    propsSchema: deliveryTermsPropsSchema,
  },
  OfferItemForm: {
    name: 'OfferItemForm',
    description:
      'Formularz edycji pozycji oferty (ilosc, cena jednostkowa). Zapis idzie przez akcje domenowa; ' +
      'podaj identyfikator oferty i opcjonalnie pozycji.',
    propsSchema: offerItemFormPropsSchema,
  },
  SectionHeading: {
    name: 'SectionHeading',
    description: 'Naglowek sekcji ekranu (poziom h2) o podanej, stalej tresci — nie wartosc rekordu.',
    propsSchema: sectionHeadingPropsSchema,
  },
  CaseHeader: {
    name: 'CaseHeader',
    description:
      'Naglowek sprawy zakupowej: kod, tytul, opis i podstawa porownania. Podaj wylacznie identyfikator sprawy.',
    propsSchema: caseHeaderPropsSchema,
  },
  CaseOfferSources: {
    name: 'CaseOfferSources',
    description:
      'Oferty sprawy pogrupowane po dostawcy, z lacza do pochodzenia kazdej pozycji i zalacznikami zrodlowymi. ' +
      'Podaj wylacznie identyfikator sprawy.',
    propsSchema: caseOfferSourcesPropsSchema,
  },
  ItemProvenance: {
    name: 'ItemProvenance',
    description:
      'Pochodzenie wartosci jednej pozycji oferty: pozycja, cena, dostawca, oferta i lista zrodel z lacza do pliku. ' +
      'Podaj wylacznie identyfikator pozycji.',
    propsSchema: itemProvenancePropsSchema,
  },
  OfferComparison: {
    name: 'OfferComparison',
    description:
      'Tabela porownawcza ofert dla sprawy zakupowej. Dane pobiera backend; podaj wylacznie identyfikator sprawy.',
    propsSchema: offerComparisonPropsSchema,
  },
  OfferCostChart: {
    name: 'OfferCostChart',
    description: 'Wykres kosztu calkowitego ofert w sprawie zakupowej.',
    propsSchema: offerCostChartPropsSchema,
  },
} as const satisfies Record<string, OpenUiComponentDeclaration>;
