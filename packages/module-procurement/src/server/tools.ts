import { z } from 'zod';
import type { ModuleToolDefinition, ToolCallContext } from '@platform/contracts';
import {
  applyReadWindow,
  READ_WINDOW_DEFAULT_LIMIT,
  READ_WINDOW_MAX_LIMIT,
  readWindowInput,
  readWindowNote,
} from '@platform/contracts';
import {
  caseIdInput,
  listOffersInput,
  criteriaWeightsInput,
  saveComparisonInput,
  searchInput,
  updateOfferItemInput,
} from './inputs.ts';
import { formatMinor, formatQuantity, type ComparisonResult } from '../shared/index.ts';
import type { ProcurementService } from './services.ts';

/** Adds human-readable money/quantity next to the raw integers. */
function decorate(result: ComparisonResult) {
  return {
    ...result,
    rows: result.rows.map((r) => ({
      ...r,
      totalFormatted: r.totalMinor === null ? null : formatMinor(r.totalMinor, r.currency),
      lines: r.lines.map((l) => ({
        ...l,
        unitPriceFormatted:
          l.unitPriceMinor === null ? null : formatMinor(l.unitPriceMinor, r.currency),
        lineTotalFormatted:
          l.lineTotalMinor === null ? null : formatMinor(l.lineTotalMinor, r.currency),
        offeredQuantity:
          l.offeredQuantityMilli === null ? null : formatQuantity(l.offeredQuantityMilli),
        requiredQuantity:
          l.requiredQuantityMilli === null ? null : formatQuantity(l.requiredQuantityMilli),
      })),
    })),
  };
}

/**
 * The module's MCP tools. Every one is a two-line wrapper over a service method
 * — there is no business logic in this file by design.
 */
export function procurementTools(service: ProcurementService): ModuleToolDefinition<never>[] {
  const defs: Array<ModuleToolDefinition<any>> = [
    {
      name: 'list_cases',
      description:
        'Wypisuje sprawy zakupowe uzytkownika wraz z liczba ofert i pozycji. ' +
        `Odczyt jest stronicowany: domyslnie ${READ_WINDOW_DEFAULT_LIMIT} spraw, najwyzej ${READ_WINDOW_MAX_LIMIT}. ` +
        'window.truncated=true znaczy, ze to nie sa wszystkie sprawy — po kolejne wywolaj z window.nextOffset. ' +
        'Pusta lista przy window.total > 0 to skutek offsetu, a nie brak spraw.',
      effect: 'read',
      inputSchema: z.object(readWindowInput),
      handler: async (i: { limit?: number; offset?: number }, ctx: ToolCallContext) => {
        const { items, window } = applyReadWindow(service.listCases(ctx.ownerId), i);
        return { cases: items, window, windowNote: readWindowNote(window, 'spraw') };
      },
    },
    {
      name: 'get_case',
      description:
        'Zwraca szczegoly sprawy zakupowej: podstawe porownania, wymagane pozycje, oferty i ich pozycje. ' +
        `Listy wymagan i ofert sa stronicowane: domyslnie ${READ_WINDOW_DEFAULT_LIMIT}, najwyzej ${READ_WINDOW_MAX_LIMIT}. ` +
        'requirementsWindow.truncated / offersWindow.truncated=true znaczy, ze to nie jest cala lista.',
      effect: 'read',
      inputSchema: z.object({ caseId: z.string(), ...readWindowInput }),
      handler: async (i: { caseId: string; limit?: number; offset?: number }, ctx: ToolCallContext) => {
        const d = service.getCaseDetail(i.caseId, ctx.ownerId);
        const requirements = applyReadWindow(d.requirements, i);
        const offers = applyReadWindow(d.offers, i);
        return {
          case: d.procurementCase,
          requirementsWindow: requirements.window,
          offersWindow: offers.window,
          windowNote: `${readWindowNote(requirements.window, 'wymagan')} ${readWindowNote(offers.window, 'ofert')}`,
          requirements: requirements.items.map((r) => ({
            id: r.id,
            position: r.position,
            name: r.name,
            unit: r.unit,
            quantity: formatQuantity(r.quantityMilli),
            spec: r.spec,
          })),
          offers: offers.items.map((o) => ({
            id: o.offer.id,
            supplier: o.supplierName,
            reference: o.offer.reference,
            currency: o.offer.currency,
            priceBasis: o.offer.priceBasis,
            validUntil: o.offer.validUntil,
            deliveryDays: o.offer.deliveryDays,
            deliveryTerms: o.offer.deliveryTerms,
            itemCount: o.items.length,
            attachmentFileIds: o.attachmentFileIds,
          })),
          criteria: d.criteria,
        };
      },
    },
    {
      name: 'list_offers',
      description:
        'Wypisuje oferty w sprawie wraz z pozycjami i cenami jednostkowymi. ' +
        `Odczyt jest stronicowany: domyslnie ${READ_WINDOW_DEFAULT_LIMIT} ofert, najwyzej ${READ_WINDOW_MAX_LIMIT}; ` +
        'pozycje kazdej oferty tez maja limit (itemsWindow przy ofercie). ' +
        'window.truncated=true znaczy, ze to nie sa wszystkie oferty.',
      effect: 'read',
      inputSchema: listOffersInput,
      handler: async (i: { caseId: string; limit?: number; offset?: number }, ctx: ToolCallContext) => {
        const d = service.getCaseDetail(i.caseId, ctx.ownerId);
        const { items: offers, window } = applyReadWindow(d.offers, i);
        return {
          offers: offers.map((o) => {
            const items = applyReadWindow(o.items, { limit: i.limit ?? READ_WINDOW_DEFAULT_LIMIT });
            return {
              id: o.offer.id,
              supplier: o.supplierName,
              reference: o.offer.reference,
              currency: o.offer.currency,
              priceBasis: o.offer.priceBasis,
              items: items.items.map((it) => ({
                id: it.id,
                requirementId: it.requirementId,
                name: it.name,
                unit: it.unit,
                quantity: formatQuantity(it.quantityMilli),
                unitPriceMinor: it.unitPriceMinor,
                unitPrice:
                  it.unitPriceMinor === null ? null : formatMinor(it.unitPriceMinor, o.offer.currency),
                version: it.version,
              })),
              /*
               * Only when something was left out. A window that covers the
               * whole list says nothing the list does not already say, and a
               * tool answer is context the model pays for — the top-level
               * `window` and `windowNote` carry the general statement.
               */
              ...(items.window.truncated ? { itemsWindow: items.window } : {}),
            };
          }),
          window,
          windowNote: readWindowNote(window, 'ofert'),
          total: d.offers.length,
        };
      },
    },
    {
      name: 'compare_offers',
      description:
        'Porownuje oferty w sprawie. Zwraca tabele z wyliczonymi przez backend sumami, kompletnoscia, rankingiem i lista ofert wykluczonych wraz z przyczyna. Nie przelicza walut ani netto/brutto.',
      effect: 'read',
      inputSchema: caseIdInput,
      handler: async (i: { caseId: string }, ctx: ToolCallContext) =>
        decorate(service.compare(i.caseId, ctx.ownerId)),
    },
    {
      name: 'update_offer_item',
      description:
        'Zmienia ilosc, cene jednostkowa, jednostke lub notatke pozycji oferty. expectedVersion jest wymagane: ' +
        'podaj version pozycji z list_offers albo z akcji rekordu. Jesli ktos zmienil pozycje w miedzyczasie, ' +
        'dostaniesz conflict zamiast cichego nadpisania jego zmiany. operationId sprawia, ze powtorzone ' +
        'wywolanie nie dubluje zmiany.',
      effect: 'write',
      /*
       * `expectedVersion` required for the agent's door, optional on the shared
       * schema the HTTP route uses (the module's own form supplies it from the
       * record it rendered). A write without a version was compared against the
       * row it was about to overwrite — no check at all — so an agent working
       * from an older reading would silently replace the user's newer change.
       */
      inputSchema: updateOfferItemInput.extend({
        expectedVersion: z
          .number()
          .int()
          .nonnegative()
          .describe('version pozycji, na ktorej pracujesz (z list_offers)'),
      }),
      handler: async (i: any, ctx: ToolCallContext) => {
        const res = await service.updateOfferItem(i, ctx.ownerId);
        const { offer } = service.repo.getItem(i.itemId, ctx.ownerId);
        ctx.emit({ type: 'data_changed', resources: [`case:${offer.caseId}`, `offer:${offer.id}`] });
        return {
          item: {
            id: res.item.id,
            name: res.item.name,
            unit: res.item.unit,
            quantity: formatQuantity(res.item.quantityMilli),
            unitPriceMinor: res.item.unitPriceMinor,
            version: res.item.version,
          },
          replayed: res.replayed,
          caseId: offer.caseId,
        };
      },
    },
    {
      name: 'find_price_provenance',
      description:
        'Dla pozycji oferty przechodzi po relacjach do oferty, dostawcy i zalacznika zrodlowego, i zwraca miejsce w pliku, z ktorego pochodzi wartosc.',
      effect: 'read',
      inputSchema: z.object({ itemId: z.string() }),
      handler: async (i: { itemId: string }, ctx: ToolCallContext) =>
        service.findProvenance(i.itemId, ctx.ownerId),
    },
    {
      name: 'search',
      description:
        'Wyszukuje sprawy, dostawcow i pozycje ofert po fragmencie nazwy. Podaj "*", zeby ' +
        'dostac wszystko. Odpowiedz zawiera totals — ile rekordow kazdego rodzaju w ogole ' +
        'istnieje. Pusta lista results przy niezerowych totals znaczy "nic nie pasuje do ' +
        'zapytania", a NIE "aplikacja jest pusta". Nigdy nie mow uzytkownikowi, ze nie ma ' +
        'danych, na podstawie samego wyniku wyszukiwania.',
      effect: 'read',
      inputSchema: searchInput,
      handler: async (i: { query: string; limit?: number }, ctx: ToolCallContext) =>
        service.search(ctx.ownerId, i.query, i.limit ?? 20),
    },
    {
      name: 'set_criteria_weights',
      description: 'Ustawia wagi kryteriow porownania dla sprawy (0-100 na kryterium).',
      effect: 'write',
      inputSchema: criteriaWeightsInput,
      handler: async (i: any, ctx: ToolCallContext) => {
        const criteria = service.setCriterionWeights(i.caseId, ctx.ownerId, i.weights);
        ctx.emit({ type: 'data_changed', resources: [`case:${i.caseId}`] });
        return { criteria };
      },
    },
    {
      name: 'save_comparison',
      description:
        'Zapisuje aktualne zestawienie porownawcze jako trwaly artefakt (snapshot). Tresc artefaktu nie zmienia sie pozniej.',
      effect: 'write',
      inputSchema: saveComparisonInput,
      handler: async (i: any, ctx: ToolCallContext) => {
        const saved = service.saveComparisonArtifact({
          caseId: i.caseId,
          ownerId: ctx.ownerId,
          conversationId: ctx.conversationId,
          runId: ctx.runId,
          title: i.title,
          operationId: i.operationId,
        });
        ctx.emit({ type: 'artifact_created', artifactId: saved.artifactId });
        return {
          artifactId: saved.artifactId,
          version: saved.version,
          bestOfferId: saved.result.bestOfferId,
        };
      },
    },
  ];
  return defs as ModuleToolDefinition<never>[];
}
