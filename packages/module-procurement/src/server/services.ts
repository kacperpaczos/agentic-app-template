import { AppError } from '@platform/contracts';
import type { PlatformServices } from '@platform/server';
import { newId, nowIso } from '@platform/server';
import {
  compareOffers,
  defaultCriteria,
  formatMinor,
  formatQuantity,
  parseAmountToMinor,
  parseQuantityToMilli,
  type ComparisonResult,
  type Offer,
  type OfferItem,
  type ProcurementCase,
  type Requirement,
} from '../shared/index.ts';
import { ProcurementRepository } from './repository.ts';

export interface CaseDetail {
  procurementCase: ProcurementCase;
  requirements: Requirement[];
  offers: Array<{
    offer: Offer;
    supplierName: string;
    items: OfferItem[];
    attachmentFileIds: string[];
  }>;
  criteria: ReturnType<ProcurementRepository['listCriteria']>;
}

/**
 * Procurement domain services.
 *
 * This is the single implementation of every business operation. The HTTP routes
 * and the MCP tools are two thin callers of the same methods, so validation,
 * ownership, optimistic concurrency and idempotency cannot be bypassed by
 * choosing one entry point over the other.
 *
 * Nothing here needs a model or a browser: every method is a plain function of
 * its inputs and the database, and the tests call them directly.
 */
export class ProcurementService {
  readonly repo: ProcurementRepository;

  constructor(private readonly platform: PlatformServices) {
    this.repo = new ProcurementRepository(platform.db);
  }

  listCases(ownerId: string) {
    return this.repo.listCases(ownerId).map((c) => {
      const offers = this.repo.listOffers(c.id);
      return {
        ...c,
        offerCount: offers.length,
        requirementCount: this.repo.listRequirements(c.id).length,
      };
    });
  }

  getCaseDetail(caseId: string, ownerId: string): CaseDetail {
    const procurementCase = this.repo.getCase(caseId, ownerId);
    const requirements = this.repo.listRequirements(caseId);
    const offers = this.repo.listOffers(caseId).map((offer) => ({
      offer,
      supplierName: this.repo.getSupplier(offer.supplierId, ownerId).name,
      items: this.repo.listItems(offer.id),
      attachmentFileIds: this.repo.listAttachments(offer.id).map((a) => a.fileId),
    }));
    return {
      procurementCase,
      requirements,
      offers,
      criteria: this.repo.listCriteria(caseId),
    };
  }

  listSuppliers(ownerId: string) {
    return this.repo.listSuppliers(ownerId);
  }

  getOfferDetail(offerId: string, ownerId: string) {
    const offer = this.repo.getOffer(offerId, ownerId);
    return {
      offer,
      supplier: this.repo.getSupplier(offer.supplierId, ownerId),
      items: this.repo.listItems(offerId),
      attachments: this.repo.listAttachments(offerId),
      provenance: this.repo.provenanceForOffer(offerId),
    };
  }

  /**
   * Runs the deterministic comparison for a case.
   *
   * `now` is injectable so a saved snapshot and a fresh run can be compared, and
   * so tests are not time-dependent.
   */
  compare(caseId: string, ownerId: string, now = new Date()): ComparisonResult {
    const detail = this.getCaseDetail(caseId, ownerId);
    const criteria = detail.criteria.length ? detail.criteria : defaultCriteria(caseId);
    return compareOffers({
      procurementCase: detail.procurementCase,
      requirements: detail.requirements,
      criteria,
      offers: detail.offers.map((o) => ({
        offer: o.offer,
        supplierName: o.supplierName,
        items: o.items,
      })),
      now,
    });
  }

  /**
   * Changes a quoted line.
   *
   * Guards, in order: ownership, domain validation, optimistic concurrency
   * (`expectedVersion`), and replay protection (`operationId`). The last one
   * means that retrying the identical call — which an agent under a reconnect
   * will do — returns the first result instead of applying the change twice.
   */
  async updateOfferItem(
    input: {
      itemId: string;
      quantity?: number;
      unitPrice?: number | null;
      unit?: string;
      note?: string | null;
      expectedVersion?: number;
      operationId?: string;
    },
    ownerId: string,
  ): Promise<{ item: OfferItem; changed: boolean; replayed: boolean }> {
    const { result, replayed } = await this.platform.idempotency.once(
      input.operationId,
      ownerId,
      'procurement.updateOfferItem',
      async () => {
        const { item, offer } = this.repo.getItem(input.itemId, ownerId);

        if (input.quantity !== undefined && input.quantity < 0) {
          throw new AppError('domain_rule_violated', 'Ilosc nie moze byc ujemna.');
        }
        if (input.unitPrice !== undefined && input.unitPrice !== null && input.unitPrice < 0) {
          throw new AppError('domain_rule_violated', 'Cena jednostkowa nie moze byc ujemna.');
        }

        const expected = input.expectedVersion ?? item.version;
        const patch = {
          quantityMilli: input.quantity !== undefined ? parseQuantityToMilli(input.quantity) : undefined,
          unitPriceMinor:
            input.unitPrice === undefined
              ? undefined
              : input.unitPrice === null
                ? null
                : parseAmountToMinor(input.unitPrice),
          note: input.note,
          unit: input.unit,
        };

        const ok = this.repo.transaction(() => {
          const applied = this.repo.updateItemChecked(input.itemId, expected, patch);
          if (applied) this.repo.touchOffer(offer.id, nowIso());
          return applied;
        });

        if (!ok) {
          const current = this.repo.getItem(input.itemId, ownerId).item;
          throw new AppError('conflict', 'Pozycja zostala zmieniona przez kogos innego.', {
            expectedVersion: expected,
            currentVersion: current.version,
          });
        }
        return { item: this.repo.getItem(input.itemId, ownerId).item, changed: true };
      },
    );
    return { ...result, replayed };
  }

  /**
   * Walks item -> offer -> attachment -> platform file so "where does this price
   * come from" is answered by traversing real relations, not by guessing.
   */
  findProvenance(itemId: string, ownerId: string) {
    const { item, offer } = this.repo.getItem(itemId, ownerId);
    const supplier = this.repo.getSupplier(offer.supplierId, ownerId);
    const entries = this.repo.provenanceForItem(itemId);
    const attachments = this.repo.listAttachments(offer.id);

    const files = new Map<string, { id: string; filename: string; mediaType: string }>();
    for (const fileId of new Set([...entries.map((e) => e.fileId), ...attachments.map((a) => a.fileId)])) {
      try {
        const meta = this.platform.files.meta(fileId, ownerId);
        files.set(fileId, { id: meta.id, filename: meta.filename, mediaType: meta.mediaType });
      } catch {
        // A deleted source file is reported as missing rather than hidden.
      }
    }

    return {
      item: {
        id: item.id,
        name: item.name,
        unit: item.unit,
        quantity: formatQuantity(item.quantityMilli),
        unitPriceMinor: item.unitPriceMinor,
        unitPriceFormatted:
          item.unitPriceMinor === null ? null : formatMinor(item.unitPriceMinor, offer.currency),
      },
      offer: { id: offer.id, reference: offer.reference, receivedAt: offer.receivedAt },
      supplier: { id: supplier.id, name: supplier.name },
      provenance: entries.map((e) => ({
        field: e.field,
        locator: e.locator,
        note: e.note,
        file: files.get(e.fileId) ?? { id: e.fileId, filename: '(plik usuniety)', mediaType: '' },
        downloadUrl: `/api/files/${e.fileId}/content`,
      })),
      otherAttachments: attachments
        .filter((a) => !entries.some((e) => e.fileId === a.fileId))
        .map((a) => ({
          kind: a.kind,
          file: files.get(a.fileId) ?? { id: a.fileId, filename: '(plik usuniety)', mediaType: '' },
          downloadUrl: `/api/files/${a.fileId}/content`,
        })),
    };
  }

  search(ownerId: string, query: string, limit = 20) {
    if (!query.trim()) return { results: [] };
    return { results: this.repo.search(ownerId, query.trim(), Math.min(limit, 50)) };
  }

  setCriterionWeights(
    caseId: string,
    ownerId: string,
    weights: Array<{ key: string; weight: number }>,
  ) {
    this.repo.getCase(caseId, ownerId);
    const existing = this.repo.listCriteria(caseId);
    const base = existing.length ? existing : defaultCriteria(caseId);
    for (const c of base) {
      const override = weights.find((w) => w.key === c.key);
      this.repo.upsertCriterion({ ...c, weight: override ? override.weight : c.weight });
    }
    return this.repo.listCriteria(caseId);
  }

  /** Saves the current comparison as a frozen platform artifact. */
  saveComparisonArtifact(input: {
    caseId: string;
    ownerId: string;
    conversationId: string | null;
    title?: string;
    operationId?: string;
  }) {
    const result = this.compare(input.caseId, input.ownerId);
    const detail = this.repo.getCase(input.caseId, input.ownerId);
    const created = this.platform.artifacts.create({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      kind: 'table',
      mode: 'snapshot',
      title: input.title ?? `Zestawienie ofert - ${detail.code}`,
      rendererType: 'procurement.comparison',
      content: result,
    });
    return { artifactId: created.meta.id, version: created.meta.currentVersion, result };
  }

  /* ---------------------------- writes used by seed ----------------------- */

  createCase(input: Omit<ProcurementCase, 'createdAt' | 'updatedAt' | 'id'> & { id?: string }) {
    const ts = nowIso();
    const record: ProcurementCase = {
      ...input,
      id: input.id ?? newId('pcs'),
      createdAt: ts,
      updatedAt: ts,
    };
    this.repo.insertCase(record);
    for (const c of defaultCriteria(record.id)) this.repo.upsertCriterion(c);
    return record;
  }

  describeCase(caseId: string, ownerId: string): string {
    const detail = this.getCaseDetail(caseId, ownerId);
    const c = detail.procurementCase;
    return [
      `Sprawa ${c.code}: ${c.title}.`,
      `Podstawa porownania: ${c.currency}, ceny ${c.priceBasis === 'net' ? 'netto' : 'brutto'}.`,
      `Pozycji wymaganych: ${detail.requirements.length}, ofert: ${detail.offers.length}`,
      `(${detail.offers.map((o) => o.supplierName).join(', ') || 'brak'}).`,
    ].join(' ');
  }
}
