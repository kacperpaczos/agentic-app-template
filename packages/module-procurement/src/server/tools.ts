import { z } from 'zod';
import type { ModuleToolDefinition, ToolCallContext } from '@platform/contracts';
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
      description: 'Wypisuje sprawy zakupowe uzytkownika wraz z liczba ofert i pozycji.',
      effect: 'read',
      inputSchema: z.object({}),
      handler: async (_i: unknown, ctx: ToolCallContext) => ({
        cases: service.listCases(ctx.ownerId),
      }),
    },
    {
      name: 'get_case',
      description:
        'Zwraca szczegoly sprawy zakupowej: podstawe porownania, wymagane pozycje, oferty i ich pozycje.',
      effect: 'read',
      inputSchema: z.object({ caseId: z.string() }),
      handler: async (i: { caseId: string }, ctx: ToolCallContext) => {
        const d = service.getCaseDetail(i.caseId, ctx.ownerId);
        return {
          case: d.procurementCase,
          requirements: d.requirements.map((r) => ({
            id: r.id,
            position: r.position,
            name: r.name,
            unit: r.unit,
            quantity: formatQuantity(r.quantityMilli),
            spec: r.spec,
          })),
          offers: d.offers.map((o) => ({
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
      description: 'Wypisuje oferty w sprawie wraz z pozycjami i cenami jednostkowymi.',
      effect: 'read',
      inputSchema: listOffersInput,
      handler: async (i: { caseId: string; limit?: number }, ctx: ToolCallContext) => {
        const d = service.getCaseDetail(i.caseId, ctx.ownerId);
        return {
          offers: d.offers.slice(0, i.limit ?? 25).map((o) => ({
            id: o.offer.id,
            supplier: o.supplierName,
            reference: o.offer.reference,
            currency: o.offer.currency,
            priceBasis: o.offer.priceBasis,
            items: o.items.map((it) => ({
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
          })),
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
        'Zmienia ilosc, cene jednostkowa, jednostke lub notatke pozycji oferty. Przekaz expectedVersion, zeby nie nadpisac nowszych danych, i operationId, zeby powtorzone wywolanie nie zdublowalo zmiany.',
      effect: 'write',
      inputSchema: updateOfferItemInput,
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
      description: 'Wyszukuje sprawy, dostawcow i pozycje ofert po fragmencie nazwy.',
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
