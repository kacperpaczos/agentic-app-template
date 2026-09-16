import { z } from 'zod';

export const MODULE_ID = 'procurement';

/* -------------------------------------------------------------------------- */
/*  Money and quantity                                                        */
/* -------------------------------------------------------------------------- */

/**
 * All money is stored and computed in integer minor units (grosze) and all
 * quantities in integer thousandths. Nothing in the domain ever sees a float, so
 * a total is bit-for-bit reproducible and two runs of the same comparison cannot
 * disagree in the last decimal.
 */
export const MINOR_PER_UNIT = 100;
export const MILLI = 1000;

export const currencySchema = z.enum(['PLN', 'EUR', 'USD']);
export type Currency = z.infer<typeof currencySchema>;

/** Net vs gross is a comparison dimension, never an implicit conversion. */
export const priceBasisSchema = z.enum(['net', 'gross']);
export type PriceBasis = z.infer<typeof priceBasisSchema>;

export const unitSchema = z.enum(['szt', 'kpl', 'm', 'm2', 'kg', 'h', 'usluga']);
export type Unit = z.infer<typeof unitSchema>;

/** Half-up rounding on the absolute value, so -0.5 and 0.5 round symmetrically. */
export function roundHalfUp(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(value));
}

/** quantityMilli x unitPriceMinor / 1000, rounded half-up to minor units. */
export function lineTotalMinor(quantityMilli: number, unitPriceMinor: number): number {
  return roundHalfUp((quantityMilli * unitPriceMinor) / MILLI);
}

export function formatMinor(minor: number, currency: Currency): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / MINOR_PER_UNIT);
  const rest = String(abs % MINOR_PER_UNIT).padStart(2, '0');
  return `${sign}${major.toLocaleString('pl-PL')},${rest} ${currency}`;
}

export function formatQuantity(quantityMilli: number): string {
  if (quantityMilli % MILLI === 0) return String(quantityMilli / MILLI);
  return (quantityMilli / MILLI).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export const parseQuantityToMilli = (value: number): number => roundHalfUp(value * MILLI);
export const parseAmountToMinor = (value: number): number => roundHalfUp(value * MINOR_PER_UNIT);

/* -------------------------------------------------------------------------- */
/*  Entities                                                                   */
/* -------------------------------------------------------------------------- */

export const caseSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  code: z.string(),
  title: z.string(),
  description: z.string(),
  /** The comparison base. Offers that do not match it are excluded, not converted. */
  currency: currencySchema,
  priceBasis: priceBasisSchema,
  status: z.enum(['draft', 'collecting', 'decided']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProcurementCase = z.infer<typeof caseSchema>;

export const supplierSchema = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  taxId: z.string().nullable(),
  country: z.string(),
  contactEmail: z.string().nullable(),
  createdAt: z.string(),
});
export type Supplier = z.infer<typeof supplierSchema>;

/** A line the case asks for. Offers are matched against these. */
export const requirementSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  position: z.number().int(),
  name: z.string(),
  sku: z.string().nullable(),
  unit: unitSchema,
  quantityMilli: z.number().int().nonnegative(),
  spec: z.string(),
});
export type Requirement = z.infer<typeof requirementSchema>;

export const offerSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  supplierId: z.string(),
  reference: z.string(),
  receivedAt: z.string(),
  currency: currencySchema,
  priceBasis: priceBasisSchema,
  validUntil: z.string().nullable(),
  deliveryDays: z.number().int().nonnegative().nullable(),
  deliveryTerms: z.string().nullable(),
  notes: z.string().nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Offer = z.infer<typeof offerSchema>;

export const offerItemSchema = z.object({
  id: z.string(),
  offerId: z.string(),
  requirementId: z.string().nullable(),
  position: z.number().int(),
  name: z.string(),
  unit: unitSchema,
  quantityMilli: z.number().int().nonnegative(),
  unitPriceMinor: z.number().int().nonnegative().nullable(),
  note: z.string().nullable(),
  version: z.number().int().nonnegative(),
});
export type OfferItem = z.infer<typeof offerItemSchema>;

export const provenanceSchema = z.object({
  id: z.string(),
  offerId: z.string(),
  offerItemId: z.string().nullable(),
  field: z.enum(['unit_price', 'delivery_days', 'valid_until', 'quantity']),
  fileId: z.string(),
  locator: z.string(),
  note: z.string().nullable(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const criterionKeySchema = z.enum(['total_cost', 'delivery_days', 'validity_days', 'completeness']);
export type CriterionKey = z.infer<typeof criterionKeySchema>;

export const criterionSchema = z.object({
  id: z.string(),
  caseId: z.string(),
  key: criterionKeySchema,
  label: z.string(),
  weight: z.number().int().min(0).max(100),
  direction: z.enum(['lower_is_better', 'higher_is_better']),
});
export type Criterion = z.infer<typeof criterionSchema>;

/* -------------------------------------------------------------------------- */
/*  Comparison engine (pure)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why an offer cannot be ranked. These are surfaced verbatim; the engine never
 * guesses a conversion rate, a unit or a missing price to make a row comparable.
 */
export const exclusionReasonSchema = z.enum([
  'currency_mismatch',
  'price_basis_mismatch',
  'missing_prices',
  'unit_mismatch',
  'missing_requirements',
  'expired',
]);
export type ExclusionReason = z.infer<typeof exclusionReasonSchema>;

export interface ComparisonLine {
  requirementId: string | null;
  requirementName: string;
  offerItemId: string | null;
  itemName: string | null;
  unit: Unit | null;
  requiredQuantityMilli: number | null;
  offeredQuantityMilli: number | null;
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
  issues: Array<'missing_item' | 'missing_price' | 'unit_mismatch' | 'quantity_mismatch' | 'extra_item'>;
}

export interface ComparisonRow {
  offerId: string;
  supplierId: string;
  supplierName: string;
  reference: string;
  currency: Currency;
  priceBasis: PriceBasis;
  deliveryDays: number | null;
  validUntil: string | null;
  validityDays: number | null;
  lines: ComparisonLine[];
  /** Sum of the priced lines only. Null when nothing could be priced. */
  totalMinor: number | null;
  /** Fraction of required lines that are present AND priced AND unit-compatible, 0..100. */
  completenessPct: number;
  comparable: boolean;
  exclusions: ExclusionReason[];
  /** Weighted score, 0..100. Null for a non-comparable offer. */
  score: number | null;
  rank: number | null;
}

export interface ComparisonResult {
  caseId: string;
  caseCurrency: Currency;
  casePriceBasis: PriceBasis;
  evaluatedAt: string;
  criteria: Array<{ key: CriterionKey; label: string; weight: number; direction: string }>;
  rows: ComparisonRow[];
  /** Offers left out of the ranking, with the reason. */
  excluded: Array<{ offerId: string; supplierName: string; reasons: ExclusionReason[] }>;
  bestOfferId: string | null;
  notes: string[];
}

export interface ComparisonInput {
  procurementCase: Pick<ProcurementCase, 'id' | 'currency' | 'priceBasis'>;
  requirements: Requirement[];
  criteria: Criterion[];
  offers: Array<{
    offer: Offer;
    supplierName: string;
    items: OfferItem[];
  }>;
  /** Injected so the result is deterministic in tests. */
  now: Date;
}

const daysBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / 86_400_000);

/**
 * Deterministic offer comparison.
 *
 * Pure function: no database, no model, no clock of its own. This is the single
 * authority for what "cheaper" means in this product, and it is what both the
 * HTTP endpoint and the MCP tool call.
 *
 * Rules, in order:
 *  1. An offer in another currency or another price basis than the case is never
 *     converted — it is excluded with a reason.
 *  2. A required line missing from the offer, or present without a price, or
 *     quoted in a different unit, is an issue on that line. Its value is not
 *     estimated; the line total stays null.
 *  3. `totalMinor` sums only lines that could actually be priced, and an offer
 *     that is not 100% complete is never the winner — an incomplete quote is
 *     cheaper for a reason that has nothing to do with price.
 */
export function compareOffers(input: ComparisonInput): ComparisonResult {
  const { procurementCase, requirements, offers, now } = input;
  const criteria = input.criteria.length ? input.criteria : defaultCriteria(procurementCase.id);
  const notes: string[] = [];

  const rows: ComparisonRow[] = offers.map(({ offer, supplierName, items }) => {
    const exclusions: ExclusionReason[] = [];
    if (offer.currency !== procurementCase.currency) exclusions.push('currency_mismatch');
    if (offer.priceBasis !== procurementCase.priceBasis) exclusions.push('price_basis_mismatch');

    const validityDays = offer.validUntil ? daysBetween(now, new Date(offer.validUntil)) : null;
    if (validityDays !== null && validityDays < 0) exclusions.push('expired');

    const byRequirement = new Map<string, OfferItem>();
    const extras: OfferItem[] = [];
    for (const item of items) {
      if (item.requirementId) byRequirement.set(item.requirementId, item);
      else extras.push(item);
    }

    const lines: ComparisonLine[] = requirements.map((req) => {
      const item = byRequirement.get(req.id);
      const issues: ComparisonLine['issues'] = [];
      if (!item) {
        issues.push('missing_item');
        return {
          requirementId: req.id,
          requirementName: req.name,
          offerItemId: null,
          itemName: null,
          unit: null,
          requiredQuantityMilli: req.quantityMilli,
          offeredQuantityMilli: null,
          unitPriceMinor: null,
          lineTotalMinor: null,
          issues,
        };
      }
      if (item.unit !== req.unit) issues.push('unit_mismatch');
      if (item.quantityMilli !== req.quantityMilli) issues.push('quantity_mismatch');
      if (item.unitPriceMinor === null) issues.push('missing_price');

      // A line is priced only when the unit matches and a price exists. A unit
      // mismatch is never normalised away.
      const priceable = item.unitPriceMinor !== null && item.unit === req.unit;
      return {
        requirementId: req.id,
        requirementName: req.name,
        offerItemId: item.id,
        itemName: item.name,
        unit: item.unit,
        requiredQuantityMilli: req.quantityMilli,
        offeredQuantityMilli: item.quantityMilli,
        unitPriceMinor: item.unitPriceMinor,
        lineTotalMinor: priceable
          ? lineTotalMinor(item.quantityMilli, item.unitPriceMinor as number)
          : null,
        issues,
      };
    });

    for (const extra of extras) {
      lines.push({
        requirementId: null,
        requirementName: '(pozycja spoza zapytania)',
        offerItemId: extra.id,
        itemName: extra.name,
        unit: extra.unit,
        requiredQuantityMilli: null,
        offeredQuantityMilli: extra.quantityMilli,
        unitPriceMinor: extra.unitPriceMinor,
        lineTotalMinor:
          extra.unitPriceMinor === null
            ? null
            : lineTotalMinor(extra.quantityMilli, extra.unitPriceMinor),
        issues: ['extra_item'],
      });
    }

    const requiredLines = lines.filter((l) => l.requirementId !== null);
    const pricedRequired = requiredLines.filter((l) => l.lineTotalMinor !== null);
    const completenessPct = requiredLines.length
      ? roundHalfUp((pricedRequired.length / requiredLines.length) * 100)
      : 100;

    if (requiredLines.some((l) => l.issues.includes('missing_item'))) {
      exclusions.push('missing_requirements');
    }
    if (requiredLines.some((l) => l.issues.includes('missing_price'))) exclusions.push('missing_prices');
    if (requiredLines.some((l) => l.issues.includes('unit_mismatch'))) exclusions.push('unit_mismatch');

    // Extras are shown but never folded into the comparable total: they answer a
    // question the case did not ask.
    const totalMinor = pricedRequired.length
      ? pricedRequired.reduce((sum, l) => sum + (l.lineTotalMinor ?? 0), 0)
      : null;

    const hardExclusions = exclusions.filter(
      (r) => r === 'currency_mismatch' || r === 'price_basis_mismatch' || r === 'expired',
    );
    const comparable =
      hardExclusions.length === 0 && completenessPct === 100 && totalMinor !== null;

    return {
      offerId: offer.id,
      supplierId: offer.supplierId,
      supplierName,
      reference: offer.reference,
      currency: offer.currency,
      priceBasis: offer.priceBasis,
      deliveryDays: offer.deliveryDays,
      validUntil: offer.validUntil,
      validityDays,
      lines,
      totalMinor,
      completenessPct,
      comparable,
      exclusions: [...new Set(exclusions)],
      score: null,
      rank: null,
    };
  });

  const comparableRows = rows.filter((r) => r.comparable);
  if (comparableRows.length < rows.length) {
    notes.push(
      'Oferty niekompletne lub w innej walucie/podstawie cenowej nie sa rankingowane. Wartosci brakujace pozostaja oznaczone jako brakujace.',
    );
  }

  scoreRows(comparableRows, criteria);
  comparableRows
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .forEach((row, i) => {
      row.rank = i + 1;
    });

  const best = comparableRows.reduce<ComparisonRow | null>(
    (acc, r) => (acc === null || (r.rank ?? 99) < (acc.rank ?? 99) ? r : acc),
    null,
  );

  return {
    caseId: procurementCase.id,
    caseCurrency: procurementCase.currency,
    casePriceBasis: procurementCase.priceBasis,
    evaluatedAt: now.toISOString(),
    criteria: criteria.map((c) => ({
      key: c.key,
      label: c.label,
      weight: c.weight,
      direction: c.direction,
    })),
    rows,
    excluded: rows
      .filter((r) => !r.comparable)
      .map((r) => ({ offerId: r.offerId, supplierName: r.supplierName, reasons: r.exclusions })),
    bestOfferId: best?.offerId ?? null,
    notes,
  };
}

/** Min-max normalisation per criterion, then a weighted sum. */
function scoreRows(rows: ComparisonRow[], criteria: Criterion[]): void {
  if (rows.length === 0) return;
  const totalWeight = criteria.reduce((s, c) => s + c.weight, 0) || 1;

  const valueOf = (row: ComparisonRow, key: CriterionKey): number | null => {
    switch (key) {
      case 'total_cost':
        return row.totalMinor;
      case 'delivery_days':
        return row.deliveryDays;
      case 'validity_days':
        return row.validityDays;
      case 'completeness':
        return row.completenessPct;
    }
  };

  const contributions = new Map<string, number>();
  for (const row of rows) contributions.set(row.offerId, 0);

  for (const criterion of criteria) {
    const values = rows.map((r) => valueOf(r, criterion.key));
    const present = values.filter((v): v is number => v !== null);
    if (present.length === 0) continue;
    const min = Math.min(...present);
    const max = Math.max(...present);
    const span = max - min;

    rows.forEach((row, i) => {
      const raw = values[i];
      // A missing value scores zero on that criterion; it is never imputed.
      if (raw === null || raw === undefined) return;
      const normalised = span === 0 ? 1 : (raw - min) / span;
      const oriented = criterion.direction === 'lower_is_better' ? 1 - normalised : normalised;
      contributions.set(row.offerId, (contributions.get(row.offerId) ?? 0) + oriented * criterion.weight);
    });
  }

  for (const row of rows) {
    row.score = roundHalfUp(((contributions.get(row.offerId) ?? 0) / totalWeight) * 100);
  }
}

export function defaultCriteria(caseId: string): Criterion[] {
  return [
    { id: `${caseId}-c1`, caseId, key: 'total_cost', label: 'Koszt calkowity', weight: 60, direction: 'lower_is_better' },
    { id: `${caseId}-c2`, caseId, key: 'delivery_days', label: 'Termin dostawy', weight: 25, direction: 'lower_is_better' },
    { id: `${caseId}-c3`, caseId, key: 'validity_days', label: 'Waznosc oferty', weight: 15, direction: 'higher_is_better' },
  ];
}
