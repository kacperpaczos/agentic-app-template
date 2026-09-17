import { z } from 'zod';
import type { OpenUiComponentDeclaration } from '@platform/contracts';

/**
 * This module's OpenUI Lang components, as both halves know them.
 *
 * React-free on purpose: the browser half renders each one (`ui/index.tsx`,
 * `defineComponent`) and the server half declares it (`openuiComponents`), so
 * the server can validate a composition that uses it. Both take the name, the
 * description and — above all — the props schema from here, whose key order is
 * the positional argument order in OpenUI Lang. Two copies could disagree about
 * that order and nothing would say so until a composition rendered the wrong
 * prop.
 *
 * Props carry references only (which case); the components fetch their data.
 */
export const PROCUREMENT_OPENUI_COMPONENTS = {
  OfferComparison: {
    name: 'OfferComparison',
    description:
      'Tabela porownawcza ofert dla sprawy zakupowej. Dane pobiera backend; podaj wylacznie identyfikator sprawy.',
    propsSchema: z.object({
      caseId: z.string().describe('Identyfikator sprawy zakupowej'),
      showExcluded: z.boolean().optional().describe('Czy pokazac oferty wykluczone z rankingu'),
    }),
  },
  OfferCostChart: {
    name: 'OfferCostChart',
    description: 'Wykres kosztu calkowitego ofert w sprawie zakupowej.',
    propsSchema: z.object({ caseId: z.string().describe('Identyfikator sprawy zakupowej') }),
  },
} as const satisfies Record<string, OpenUiComponentDeclaration>;
