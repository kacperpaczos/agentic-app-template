import { AppError } from '@platform/contracts';
import type { Db } from '@platform/server';
import {
  type Criterion,
  type Offer,
  type OfferItem,
  type ProcurementCase,
  type Provenance,
  type Requirement,
  type Supplier,
} from '../shared/index.ts';

type Row = Record<string, any>;

const caseOf = (r: Row): ProcurementCase => ({
  id: r.id,
  ownerId: r.owner_id,
  code: r.code,
  title: r.title,
  description: r.description,
  currency: r.currency,
  priceBasis: r.price_basis,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const supplierOf = (r: Row): Supplier => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  taxId: r.tax_id,
  country: r.country,
  contactEmail: r.contact_email,
  createdAt: r.created_at,
});

const requirementOf = (r: Row): Requirement => ({
  id: r.id,
  caseId: r.case_id,
  position: r.position,
  name: r.name,
  sku: r.sku,
  unit: r.unit,
  quantityMilli: r.quantity_milli,
  spec: r.spec,
});

const offerOf = (r: Row): Offer => ({
  id: r.id,
  caseId: r.case_id,
  supplierId: r.supplier_id,
  reference: r.reference,
  receivedAt: r.received_at,
  currency: r.currency,
  priceBasis: r.price_basis,
  validUntil: r.valid_until,
  deliveryDays: r.delivery_days,
  deliveryTerms: r.delivery_terms,
  notes: r.notes,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const itemOf = (r: Row): OfferItem => ({
  id: r.id,
  offerId: r.offer_id,
  requirementId: r.requirement_id,
  position: r.position,
  name: r.name,
  unit: r.unit,
  quantityMilli: r.quantity_milli,
  unitPriceMinor: r.unit_price_minor,
  note: r.note,
  version: r.version,
});

const provenanceOf = (r: Row): Provenance => ({
  id: r.id,
  offerId: r.offer_id,
  offerItemId: r.offer_item_id,
  field: r.field,
  fileId: r.file_id,
  locator: r.locator,
  note: r.note,
});

/**
 * Data access for the procurement module.
 *
 * Ownership is enforced here, on the row, from the authenticated owner id passed
 * down by the platform — never from anything the caller (or the model) supplies
 * in a payload.
 */
export class ProcurementRepository {
  constructor(private readonly db: Db) {}

  #sql = <T = Row>(q: string, ...args: unknown[]): T[] =>
    this.db.$client.prepare(q).all(...args) as T[];

  #one = <T = Row>(q: string, ...args: unknown[]): T | undefined =>
    this.db.$client.prepare(q).get(...args) as T | undefined;

  run(q: string, ...args: unknown[]): void {
    this.db.$client.prepare(q).run(...args);
  }

  transaction<T>(fn: () => T): T {
    return this.db.$client.transaction(fn)();
  }

  /* --------------------------------- cases -------------------------------- */

  listCases(ownerId: string): ProcurementCase[] {
    return this.#sql('SELECT * FROM pc_cases WHERE owner_id = ? ORDER BY created_at DESC', ownerId).map(
      caseOf,
    );
  }

  getCase(id: string, ownerId: string): ProcurementCase {
    const row = this.#one('SELECT * FROM pc_cases WHERE id = ?', id);
    if (!row) throw new AppError('not_found', `Sprawa ${id} nie istnieje.`);
    if (row.owner_id !== ownerId) throw new AppError('forbidden', 'Sprawa nalezy do innego wlasciciela.');
    return caseOf(row);
  }

  findCaseByCode(code: string, ownerId: string): ProcurementCase | null {
    const row = this.#one('SELECT * FROM pc_cases WHERE owner_id = ? AND code = ?', ownerId, code);
    return row ? caseOf(row) : null;
  }

  insertCase(c: ProcurementCase): void {
    this.run(
      `INSERT INTO pc_cases (id, owner_id, code, title, description, currency, price_basis, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.id, c.ownerId, c.code, c.title, c.description, c.currency, c.priceBasis, c.status,
      c.createdAt, c.updatedAt,
    );
  }

  /* ------------------------------- suppliers ------------------------------ */

  listSuppliers(ownerId: string): Supplier[] {
    return this.#sql('SELECT * FROM pc_suppliers WHERE owner_id = ? ORDER BY name', ownerId).map(
      supplierOf,
    );
  }

  getSupplier(id: string, ownerId: string): Supplier {
    const row = this.#one('SELECT * FROM pc_suppliers WHERE id = ?', id);
    if (!row) throw new AppError('not_found', `Dostawca ${id} nie istnieje.`);
    if (row.owner_id !== ownerId) throw new AppError('forbidden', 'Dostawca nalezy do innego wlasciciela.');
    return supplierOf(row);
  }

  insertSupplier(s: Supplier): void {
    this.run(
      `INSERT INTO pc_suppliers (id, owner_id, name, tax_id, country, contact_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      s.id, s.ownerId, s.name, s.taxId, s.country, s.contactEmail, s.createdAt,
    );
  }

  /* ------------------------------ requirements ---------------------------- */

  listRequirements(caseId: string): Requirement[] {
    return this.#sql('SELECT * FROM pc_requirements WHERE case_id = ? ORDER BY position', caseId).map(
      requirementOf,
    );
  }

  insertRequirement(r: Requirement): void {
    this.run(
      `INSERT INTO pc_requirements (id, case_id, position, name, sku, unit, quantity_milli, spec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id, r.caseId, r.position, r.name, r.sku, r.unit, r.quantityMilli, r.spec,
    );
  }

  /* --------------------------------- offers ------------------------------- */

  listOffers(caseId: string): Offer[] {
    return this.#sql('SELECT * FROM pc_offers WHERE case_id = ? ORDER BY received_at', caseId).map(
      offerOf,
    );
  }

  getOffer(id: string, ownerId: string): Offer {
    const row = this.#one('SELECT * FROM pc_offers WHERE id = ?', id);
    if (!row) throw new AppError('not_found', `Oferta ${id} nie istnieje.`);
    this.getCase(row.case_id, ownerId);
    return offerOf(row);
  }

  insertOffer(o: Offer): void {
    this.run(
      `INSERT INTO pc_offers (id, case_id, supplier_id, reference, received_at, currency, price_basis,
                              valid_until, delivery_days, delivery_terms, notes, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      o.id, o.caseId, o.supplierId, o.reference, o.receivedAt, o.currency, o.priceBasis,
      o.validUntil, o.deliveryDays, o.deliveryTerms, o.notes, o.version, o.createdAt, o.updatedAt,
    );
  }

  /* ------------------------------ offer items ----------------------------- */

  listItems(offerId: string): OfferItem[] {
    return this.#sql('SELECT * FROM pc_offer_items WHERE offer_id = ? ORDER BY position', offerId).map(
      itemOf,
    );
  }

  getItem(id: string, ownerId: string): { item: OfferItem; offer: Offer } {
    const row = this.#one('SELECT * FROM pc_offer_items WHERE id = ?', id);
    if (!row) throw new AppError('not_found', `Pozycja ${id} nie istnieje.`);
    const offer = this.getOffer(row.offer_id, ownerId);
    return { item: itemOf(row), offer };
  }

  insertItem(i: OfferItem): void {
    this.run(
      `INSERT INTO pc_offer_items (id, offer_id, requirement_id, position, name, unit, quantity_milli, unit_price_minor, note, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      i.id, i.offerId, i.requirementId, i.position, i.name, i.unit, i.quantityMilli,
      i.unitPriceMinor, i.note, i.version,
    );
  }

  /**
   * Compare-and-set update. Returns false when `expectedVersion` no longer
   * matches, so a stale write never silently overwrites a newer value.
   */
  updateItemChecked(
    id: string,
    expectedVersion: number,
    patch: { quantityMilli?: number; unitPriceMinor?: number | null; note?: string | null; unit?: string },
  ): boolean {
    const res = this.db.$client
      .prepare(
        `UPDATE pc_offer_items
            SET quantity_milli   = COALESCE(?, quantity_milli),
                unit_price_minor = CASE WHEN ? = 1 THEN ? ELSE unit_price_minor END,
                note             = CASE WHEN ? = 1 THEN ? ELSE note END,
                unit             = COALESCE(?, unit),
                version          = version + 1
          WHERE id = ? AND version = ?`,
      )
      .run(
        patch.quantityMilli ?? null,
        patch.unitPriceMinor !== undefined ? 1 : 0,
        patch.unitPriceMinor ?? null,
        patch.note !== undefined ? 1 : 0,
        patch.note ?? null,
        patch.unit ?? null,
        id,
        expectedVersion,
      );
    return res.changes > 0;
  }

  touchOffer(offerId: string, at: string): void {
    this.run('UPDATE pc_offers SET updated_at = ?, version = version + 1 WHERE id = ?', at, offerId);
  }

  /* ------------------------ attachments & provenance ---------------------- */

  listAttachments(offerId: string): Array<{ id: string; fileId: string; kind: string }> {
    return this.#sql('SELECT * FROM pc_attachments WHERE offer_id = ?', offerId).map((r) => ({
      id: r.id,
      fileId: r.file_id,
      kind: r.kind,
    }));
  }

  insertAttachment(a: { id: string; offerId: string; fileId: string; kind: string; createdAt: string }): void {
    this.run(
      'INSERT INTO pc_attachments (id, offer_id, file_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
      a.id, a.offerId, a.fileId, a.kind, a.createdAt,
    );
  }

  provenanceForItem(itemId: string): Provenance[] {
    return this.#sql('SELECT * FROM pc_provenance WHERE offer_item_id = ?', itemId).map(provenanceOf);
  }

  provenanceForOffer(offerId: string): Provenance[] {
    return this.#sql('SELECT * FROM pc_provenance WHERE offer_id = ?', offerId).map(provenanceOf);
  }

  insertProvenance(p: Provenance): void {
    this.run(
      `INSERT INTO pc_provenance (id, offer_id, offer_item_id, field, file_id, locator, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      p.id, p.offerId, p.offerItemId, p.field, p.fileId, p.locator, p.note,
    );
  }

  /* -------------------------------- criteria ------------------------------ */

  listCriteria(caseId: string): Criterion[] {
    return this.#sql('SELECT * FROM pc_criteria WHERE case_id = ?', caseId).map((r) => ({
      id: r.id,
      caseId: r.case_id,
      key: r.key,
      label: r.label,
      weight: r.weight,
      direction: r.direction,
    }));
  }

  upsertCriterion(c: Criterion): void {
    this.run(
      `INSERT INTO pc_criteria (id, case_id, key, label, weight, direction)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(case_id, key) DO UPDATE SET weight = excluded.weight, label = excluded.label,
                                               direction = excluded.direction`,
      c.id, c.caseId, c.key, c.label, c.weight, c.direction,
    );
  }

  /* --------------------------------- search ------------------------------- */

  /** How much of each kind this owner has, regardless of any query. */
  counts(ownerId: string): { cases: number; suppliers: number; offerItems: number } {
    const one = (sql: string) => (this.#sql(sql, ownerId)[0]?.n as number) ?? 0;
    return {
      cases: one('SELECT COUNT(*) AS n FROM pc_cases WHERE owner_id = ?'),
      suppliers: one('SELECT COUNT(*) AS n FROM pc_suppliers WHERE owner_id = ?'),
      offerItems: one(
        `SELECT COUNT(*) AS n FROM pc_offer_items i
           JOIN pc_offers o ON o.id = i.offer_id
           JOIN pc_cases  c ON c.id = o.case_id
          WHERE c.owner_id = ?`,
      ),
    };
  }

  search(ownerId: string, query: string, limit: number): Array<{
    kind: string;
    id: string;
    label: string;
    caseId: string | null;
  }> {
    /*
     * `*` and `%` mean "everything", not a character to look for.
     *
     * A real turn asked for everything with `query: "*"`, got no rows back —
     * `LIKE '%*%'` matches nothing — and told the user the application was
     * empty while it held four suppliers and a case. A search that answers
     * "nothing" to "show me everything" is not a narrow search, it is a wrong
     * one.
     */
    const wanted = query.trim();
    const like = wanted === '*' || wanted === '%' ? '%' : `%${wanted.toLowerCase()}%`;
    const rows: Array<{ kind: string; id: string; label: string; caseId: string | null }> = [];
    for (const r of this.#sql(
      `SELECT id, title, code FROM pc_cases WHERE owner_id = ? AND (lower(title) LIKE ? OR lower(code) LIKE ?) LIMIT ?`,
      ownerId, like, like, limit,
    )) {
      rows.push({ kind: 'case', id: r.id, label: `${r.code} - ${r.title}`, caseId: r.id });
    }
    for (const r of this.#sql(
      `SELECT id, name FROM pc_suppliers WHERE owner_id = ? AND lower(name) LIKE ? LIMIT ?`,
      ownerId, like, limit,
    )) {
      rows.push({ kind: 'supplier', id: r.id, label: r.name, caseId: null });
    }
    for (const r of this.#sql(
      `SELECT i.id AS id, i.name AS name, o.case_id AS case_id
         FROM pc_offer_items i
         JOIN pc_offers o ON o.id = i.offer_id
         JOIN pc_cases  c ON c.id = o.case_id
        WHERE c.owner_id = ? AND lower(i.name) LIKE ? LIMIT ?`,
      ownerId, like, limit,
    )) {
      rows.push({ kind: 'offer_item', id: r.id, label: r.name, caseId: r.case_id });
    }
    return rows.slice(0, limit);
  }
}
