import { z } from 'zod';
import { AppError, type CardComponentDescriptor, type ServerModule } from '@platform/contracts';
import type { PlatformServices } from '@platform/server';
import { MODULE_ID } from '../shared/index.ts';
import { updateOfferItemInput } from './inputs.ts';
import { PROCUREMENT_MIGRATIONS } from './schema.ts';
import { seedProcurement } from './seed.ts';
import { ProcurementService } from './services.ts';
import { procurementTools } from './tools.ts';
import {
  caseOfferItemRecords,
  caseRecords,
  comparisonRecords,
  procurementViews,
  requirementRecords,
  supplierRecords,
} from './views.ts';

export { ProcurementService } from './services.ts';
export { ProcurementRepository } from './repository.ts';
export { PROCUREMENT_MIGRATIONS } from './schema.ts';
export { seedProcurement } from './seed.ts';

const caseRef = z.object({ caseId: z.string().max(128) });

/**
 * Card components this module contributes to the shared catalog.
 *
 * Props carry *references* (which case, which offer) and view options only.
 * A component never receives business values as props — it fetches them from the
 * backend — so a composition an agent writes can never become a second, stale
 * copy of the data.
 */
function cardComponents(): CardComponentDescriptor[] {
  return [
    {
      id: 'procurement.caseSummary',
      description: 'Podsumowanie sprawy zakupowej: podstawa porownania, liczba ofert i pozycji.',
      usage: 'props: { caseId }',
      propsSchema: caseRef,
    },
    {
      id: 'procurement.offerList',
      description: 'Lista ofert w sprawie z dostawca, referencja i liczba pozycji.',
      usage: 'props: { caseId }',
      propsSchema: caseRef,
    },
    {
      id: 'procurement.comparisonTable',
      description:
        'Tabela porownawcza ofert wyliczona przez backend: sumy, kompletnosc, ranking i oferty wykluczone z przyczyna.',
      usage: 'props: { caseId, showExcluded?: boolean }',
      propsSchema: caseRef.extend({ showExcluded: z.boolean().default(true) }),
    },
    {
      id: 'procurement.costChart',
      description: 'Wykres slupkowy kosztu calkowitego porownywalnych ofert.',
      usage: 'props: { caseId }',
      propsSchema: caseRef,
    },
    {
      id: 'procurement.deliveryTerms',
      description: 'Zestawienie warunkow dostawy i waznosci ofert.',
      usage: 'props: { caseId }',
      propsSchema: caseRef,
    },
    {
      id: 'procurement.offerItemForm',
      description: 'Formularz edycji pozycji oferty (ilosc, cena jednostkowa, jednostka, notatka).',
      usage: 'props: { offerId, itemId? }',
      propsSchema: z.object({ offerId: z.string().max(128), itemId: z.string().max(128).optional() }),
    },
    {
      id: 'procurement.provenance',
      description: 'Pochodzenie wartosci pozycji: oferta, dostawca, zalacznik zrodlowy i miejsce w pliku.',
      usage: 'props: { itemId }',
      propsSchema: z.object({ itemId: z.string().max(128) }),
    },
  ];
}

/**
 * The procurement business module.
 *
 * Everything the platform learns about procurement arrives through this object.
 * There is no import in the other direction: `@platform/*` never mentions a
 * case, an offer or a price, which `scripts/check-boundaries.mjs` verifies.
 */
export function createProcurementModule(platform: PlatformServices): ServerModule {
  const service = new ProcurementService(platform);

  return {
    meta: {
      id: MODULE_ID,
      title: 'Porownywanie ofert zakupowych',
      version: '0.1.0',
      description:
        'Sprawy zakupowe, dostawcy, oferty, pozycje, warunki, zalaczniki zrodlowe i deterministyczne zestawienia porownawcze.',
    },

    migrations: PROCUREMENT_MIGRATIONS,
    tools: procurementTools(service),
    cardComponents: cardComponents(),

    /*
     * Places in this module's screens the agent may be asked to open.
     *
     * Declared by the module, held by the platform: the platform shell contains
     * no business vocabulary, so "purchase cases" and "suppliers" can only be
     * named here. The ids are namespaced by the module, and the selectors
     * describe this module's own markup — nobody else knows it.
     */
    uiTargets: [
      {
        id: 'procurement.cases',
        kind: 'view',
        label: 'Wszystkie sprawy',
        description:
          'Lista spraw zakupowych; stad otwiera sie pojedyncza sprawe. Mozna zawezic przez ui_filter.',
        to: '/cases',
        filter: {
          collection: 'cases',
          fields: [
            { field: 'status', label: 'Status sprawy', values: ['draft', 'collecting', 'decided'] },
            { field: 'currency', label: 'Waluta', values: ['PLN', 'EUR'] },
            { field: 'title', label: 'Tytul sprawy' },
            { field: 'code', label: 'Kod sprawy' },
          ],
        },
      },
      {
        id: 'procurement.data',
        kind: 'view',
        label: 'Dostawcy',
        description:
          'Dane dostawcow i ich ofert. Mozna zawezic — np. do jednego kraju — przez ui_filter.',
        to: '/data',
        /*
         * What may be narrowed here, and by what.
         *
         * `collection` is the key of the array in this view's own response, and
         * the fields are properties of its rows. The platform carries both
         * without reading them; this module is the only place that knows a
         * supplier has a country. Listing the values lets the agent use the
         * codes that are actually in the data instead of writing "Polska".
         */
        filter: {
          collection: 'suppliers',
          fields: [
            { field: 'country', label: 'Kraj (kod ISO)', values: ['PL', 'FI', 'DE', 'CZ'] },
            { field: 'name', label: 'Nazwa dostawcy' },
            { field: 'taxId', label: 'NIP' },
          ],
        },
      },
      {
        id: 'procurement.case.comparison',
        kind: 'element',
        label: 'Tabela porownawcza',
        description:
          'Karta z zestawieniem ofert na canvasie sprawy: sumy, ranking i przyczyny wykluczen.',
        selector: '[data-testid="card-comparison"]',
      },
      {
        id: 'procurement.case.summary',
        kind: 'element',
        label: 'Podsumowanie sprawy',
        description: 'Karta podsumowania sprawy na canvasie.',
        selector: '[data-testid="card-case-summary"]',
      },
    ],

    /*
     * Queries the platform may re-run on this module's behalf when a live
     * artifact is opened. They are ordinary read methods of the domain service —
     * the same code the tools call — so a live report is recomputed by the same
     * rules as everything else, and the platform never learns any procurement
     * logic to do it.
     */
    readOperations: [
      {
        name: 'comparison',
        description:
          'Aktualna tabela porownawcza ofert w sprawie: sumy, kompletnosc, ranking i wykluczenia z przyczyna.',
        inputSchema: caseRef,
        run: async (i: { caseId: string }, ctx) => service.compare(i.caseId, ctx.ownerId),
        result: comparisonRecords,
      },
      {
        name: 'case_overview',
        description: 'Aktualne podsumowanie sprawy: podstawa porownania, liczba ofert i pozycji wymaganych.',
        inputSchema: caseRef,
        run: async (i: { caseId: string }, ctx) => service.getCaseDetail(i.caseId, ctx.ownerId),
        result: requirementRecords,
      },
      {
        name: 'case_offer_items',
        description:
          'Pozycje ofert w sprawie, jedna na wiersz: dostawca, nazwa, jednostka, ilosc, cena jednostkowa i waluta.',
        inputSchema: caseRef,
        run: async (i: { caseId: string }, ctx) => ({ items: service.listCaseOfferItems(i.caseId, ctx.ownerId) }),
        result: caseOfferItemRecords,
      },
      /*
       * The two lists behind the module's list screens. The same service calls
       * as the `/suppliers` and `/cases` routes, so a view reading them and a
       * client of the routes cannot see different rows.
       */
      {
        name: 'suppliers',
        description: 'Dostawcy wlasciciela: nazwa, NIP, kraj i kontakt.',
        inputSchema: z.object({}),
        run: async (_i: Record<string, never>, ctx) => ({ suppliers: service.listSuppliers(ctx.ownerId) }),
        result: supplierRecords,
      },
      {
        name: 'cases',
        description: 'Sprawy zakupowe wlasciciela: kod, tytul, status, waluta, podstawa cen, liczba ofert i pozycji.',
        inputSchema: z.object({}),
        run: async (_i: Record<string, never>, ctx) => ({ cases: service.listCases(ctx.ownerId) }),
        result: caseRecords,
      },
    ],

    /*
     * The list screens as compositions. Each view has the id of its UI target,
     * and names the read its table narrows — which the platform checks against
     * the target's `filter` at startup.
     */
    views: procurementViews,

    agentBriefing: [
      'Domena: porownywanie ofert zakupowych.',
      '- Sprawa zakupowa (case) ustala podstawe porownania: walute i to, czy ceny sa netto czy brutto.',
      '- Wymagane pozycje (requirements) naleza do sprawy. Pozycje oferty (offer items) sa do nich dopasowane przez requirementId.',
      '- Kwoty sa przechowywane w groszach (unitPriceMinor), ilosci w tysiecznych (quantityMilli). Wszystkie sumy liczy backend.',
      '- Oferty w innej walucie lub innej podstawie cenowej NIE sa przeliczane - sa wykluczane z rankingu z podana przyczyna.',
      '- Brakujaca pozycja, brak ceny lub niezgodna jednostka oznaczaja pozycje jako niekompletna. Nie uzupelniaj takich wartosci wlasnym szacunkiem.',
      '- Oferta niekompletna nigdy nie jest zwyciezca, nawet jesli jej czesciowa suma jest najnizsza.',
      '- Pochodzenie wartosci sprawdzaj narzedziem procurement_find_price_provenance.',
    ].join('\n'),

    describeResource: async (resource, ownerId) => {
      if (resource.kind !== 'case') return null;
      try {
        return service.describeCase(resource.id, ownerId);
      } catch {
        return null;
      }
    },

    /**
     * Cases that came from the base data get a workspace straight away.
     *
     * Reported here rather than assumed by the platform: only this module knows
     * that a purchase case is the thing a user opens first, and that its code
     * identifies it. Everything the platform then does goes through
     * `defaultComposition` below.
     */
    baseDataScopes: (ownerId) =>
      service.repo
        .listCases(ownerId)
        .map((c) => ({ kind: 'case', id: c.id, title: `Sprawa ${c.code}` })),

    /** Opening a case for the first time gives a workspace that is already useful. */
    defaultComposition: (scope) => {
      if (scope.kind !== 'case') return [];
      return [
        {
          title: 'Podsumowanie sprawy',
          spec: { kind: 'component', component: 'procurement.caseSummary', props: { caseId: scope.id } },
          geometry: { x: 0, y: 0, width: 520, height: 300 },
        },
        {
          title: 'Oferty',
          spec: { kind: 'component', component: 'procurement.offerList', props: { caseId: scope.id } },
          geometry: { x: 560, y: 0, width: 560, height: 300 },
        },
        {
          title: 'Zestawienie porownawcze',
          spec: {
            kind: 'component',
            component: 'procurement.comparisonTable',
            props: { caseId: scope.id, showExcluded: true },
          },
          geometry: { x: 0, y: 340, width: 1120, height: 480 },
        },
      ];
    },

    routes: (register) => {
      register.get('/cases', async (req) => ({ body: { cases: service.listCases(req.ownerId) } }));

      register.get('/cases/:caseId', async (req) => ({
        body: service.getCaseDetail(req.params.caseId as string, req.ownerId),
      }));

      register.get('/cases/:caseId/comparison', async (req) => ({
        body: service.compare(req.params.caseId as string, req.ownerId),
      }));

      register.post('/cases/:caseId/criteria', async (req) => ({
        body: {
          criteria: service.setCriterionWeights(
            req.params.caseId as string,
            req.ownerId,
            (req.body as { weights: Array<{ key: string; weight: number }> }).weights,
          ),
        },
      }));

      register.get('/suppliers', async (req) => ({
        body: { suppliers: service.listSuppliers(req.ownerId) },
      }));

      register.get('/offers/:offerId', async (req) => ({
        body: service.getOfferDetail(req.params.offerId as string, req.ownerId),
      }));

      /** Same service call the MCP tool makes — one implementation, two doors. */
      register.patch('/items/:itemId', async (req) => {
        const parsed = updateOfferItemInput.safeParse({
          ...((req.body ?? {}) as Record<string, unknown>),
          itemId: req.params.itemId,
        });
        if (!parsed.success) {
          throw new AppError('validation_failed', 'Nieprawidlowe dane pozycji oferty.', {
            issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          });
        }
        return { body: await service.updateOfferItem(parsed.data, req.ownerId) };
      });

      register.get('/items/:itemId/provenance', async (req) => ({
        body: service.findProvenance(req.params.itemId as string, req.ownerId),
      }));

      register.get('/search', async (req) => ({
        body: service.search(req.ownerId, String(req.query.q ?? ''), Number(req.query.limit ?? 20)),
      }));
    },

    seed: (ctx) => seedProcurement(service, ctx),
  };
}
