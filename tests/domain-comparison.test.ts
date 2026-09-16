import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compareOffers,
  formatMinor,
  lineTotalMinor,
  parseAmountToMinor,
  parseQuantityToMilli,
  type Criterion,
  type Offer,
  type OfferItem,
  type Requirement,
} from '@module/procurement/shared';
import { createHarness, caseCode, type Harness } from './helpers.ts';

/**
 * The comparison engine is a pure function, so these expectations are computed
 * by hand and compared against the implementation — not taken from its output.
 */
describe('silnik porownania (czysta funkcja, bez bazy i bez modelu)', () => {
  const req = (id: string, name: string, unit: Requirement['unit'], qty: number): Requirement => ({
    id,
    caseId: 'c1',
    position: 1,
    name,
    sku: null,
    unit,
    quantityMilli: parseQuantityToMilli(qty),
    spec: '',
  });

  const offer = (id: string, patch: Partial<Offer> = {}): Offer => ({
    id,
    caseId: 'c1',
    supplierId: `s-${id}`,
    reference: `REF-${id}`,
    receivedAt: '2026-08-20T09:00:00.000Z',
    currency: 'PLN',
    priceBasis: 'net',
    validUntil: '2026-12-31T09:00:00.000Z',
    deliveryDays: 14,
    deliveryTerms: null,
    notes: null,
    version: 1,
    createdAt: '2026-08-20T09:00:00.000Z',
    updatedAt: '2026-08-20T09:00:00.000Z',
    ...patch,
  });

  const item = (
    id: string,
    offerId: string,
    requirementId: string | null,
    unit: OfferItem['unit'],
    qty: number,
    price: number | null,
  ): OfferItem => ({
    id,
    offerId,
    requirementId,
    position: 1,
    name: id,
    unit,
    quantityMilli: parseQuantityToMilli(qty),
    unitPriceMinor: price === null ? null : parseAmountToMinor(price),
    note: null,
    version: 1,
  });

  const criteria: Criterion[] = [
    { id: 'k1', caseId: 'c1', key: 'total_cost', label: 'Koszt', weight: 60, direction: 'lower_is_better' },
    { id: 'k2', caseId: 'c1', key: 'delivery_days', label: 'Dostawa', weight: 40, direction: 'lower_is_better' },
  ];

  const now = new Date('2026-09-14T00:00:00.000Z');

  it('mnozy ilosc przez cene jednostkowa w liczbach calkowitych', () => {
    // 2 x 12 400,00 PLN = 24 800,00 PLN
    expect(lineTotalMinor(parseQuantityToMilli(2), parseAmountToMinor(12_400))).toBe(2_480_000);
    // 1,5 x 10,01 = 15,015 -> 15,02 (half-up)
    expect(lineTotalMinor(parseQuantityToMilli(1.5), parseAmountToMinor(10.01))).toBe(1502);
  });

  it('sumuje pozycje deterministycznie i formatuje kwote', () => {
    const r1 = req('r1', 'A', 'szt', 2);
    const o = offer('o1');
    const result = compareOffers({
      procurementCase: { id: 'c1', currency: 'PLN', priceBasis: 'net' },
      requirements: [r1],
      criteria,
      offers: [{ offer: o, supplierName: 'Alfa', items: [item('i1', 'o1', 'r1', 'szt', 2, 12_400)] }],
      now,
    });
    expect(result.rows[0]?.totalMinor).toBe(2_480_000);
    expect(formatMinor(2_480_000, 'PLN')).toContain('24');
    expect(result.rows[0]?.comparable).toBe(true);
  });

  it('nie przelicza innej waluty — wyklucza oferte z podana przyczyna', () => {
    const r1 = req('r1', 'A', 'szt', 1);
    const result = compareOffers({
      procurementCase: { id: 'c1', currency: 'PLN', priceBasis: 'net' },
      requirements: [r1],
      criteria,
      offers: [
        { offer: offer('pln'), supplierName: 'Alfa', items: [item('i1', 'pln', 'r1', 'szt', 1, 1000)] },
        {
          offer: offer('eur', { currency: 'EUR' }),
          supplierName: 'Beta',
          items: [item('i2', 'eur', 'r1', 'szt', 1, 100)],
        },
      ],
      now,
    });
    const eurRow = result.rows.find((r) => r.offerId === 'eur');
    expect(eurRow?.comparable).toBe(false);
    expect(eurRow?.exclusions).toContain('currency_mismatch');
    expect(result.bestOfferId).toBe('pln');
  });

  it('nie porownuje netto z brutto', () => {
    const r1 = req('r1', 'A', 'szt', 1);
    const result = compareOffers({
      procurementCase: { id: 'c1', currency: 'PLN', priceBasis: 'net' },
      requirements: [r1],
      criteria,
      offers: [
        {
          offer: offer('gross', { priceBasis: 'gross' }),
          supplierName: 'Beta',
          items: [item('i1', 'gross', 'r1', 'szt', 1, 100)],
        },
      ],
      now,
    });
    expect(result.rows[0]?.exclusions).toContain('price_basis_mismatch');
    expect(result.bestOfferId).toBeNull();
  });

  it('nie zgaduje brakujacej pozycji i nie pozwala jej wygrac mimo nizszej sumy', () => {
    const r1 = req('r1', 'A', 'szt', 1);
    const r2 = req('r2', 'B', 'szt', 1);
    const result = compareOffers({
      procurementCase: { id: 'c1', currency: 'PLN', priceBasis: 'net' },
      requirements: [r1, r2],
      criteria,
      offers: [
        {
          offer: offer('full'),
          supplierName: 'Pelna',
          items: [item('i1', 'full', 'r1', 'szt', 1, 100), item('i2', 'full', 'r2', 'szt', 1, 100)],
        },
        {
          // Cheaper on paper — but only because a required line is missing.
          offer: offer('partial', { deliveryDays: 5 }),
          supplierName: 'Niepelna',
          items: [item('i3', 'partial', 'r1', 'szt', 1, 50)],
        },
      ],
      now,
    });
    const partial = result.rows.find((r) => r.offerId === 'partial');
    expect(partial?.totalMinor).toBe(5000);
    expect(partial?.completenessPct).toBe(50);
    expect(partial?.comparable).toBe(false);
    expect(partial?.exclusions).toContain('missing_requirements');
    expect(partial?.lines.find((l) => l.requirementId === 'r2')?.issues).toContain('missing_item');
    expect(result.bestOfferId).toBe('full');
  });

  it('nie normalizuje niezgodnej jednostki', () => {
    const r1 = req('r1', 'Montaz', 'h', 16);
    const result = compareOffers({
      procurementCase: { id: 'c1', currency: 'PLN', priceBasis: 'net' },
      requirements: [r1],
      criteria,
      offers: [
        {
          offer: offer('ryczalt'),
          supplierName: 'Gamma',
          items: [item('i1', 'ryczalt', 'r1', 'usluga', 1, 2400)],
        },
      ],
      now,
    });
    const row = result.rows[0];
    expect(row?.lines[0]?.issues).toContain('unit_mismatch');
    expect(row?.lines[0]?.lineTotalMinor).toBeNull();
    expect(row?.totalMinor).toBeNull();
    expect(row?.comparable).toBe(false);
  });

  it('nie wlicza pozycji spoza zapytania do sumy porownawczej', () => {
    const r1 = req('r1', 'A', 'szt', 1);
    const result = compareOffers({
      procurementCase: { id: 'c1', currency: 'PLN', priceBasis: 'net' },
      requirements: [r1],
      criteria,
      offers: [
        {
          offer: offer('o1'),
          supplierName: 'Alfa',
          items: [
            item('i1', 'o1', 'r1', 'szt', 1, 100),
            item('extra', 'o1', null, 'usluga', 1, 999),
          ],
        },
      ],
      now,
    });
    expect(result.rows[0]?.totalMinor).toBe(10_000);
    expect(result.rows[0]?.lines.find((l) => l.offerItemId === 'extra')?.issues).toContain('extra_item');
  });

  it('wyklucza oferte po terminie waznosci', () => {
    const r1 = req('r1', 'A', 'szt', 1);
    const result = compareOffers({
      procurementCase: { id: 'c1', currency: 'PLN', priceBasis: 'net' },
      requirements: [r1],
      criteria,
      offers: [
        {
          offer: offer('stara', { validUntil: '2026-01-01T09:00:00.000Z' }),
          supplierName: 'Delta',
          items: [item('i1', 'stara', 'r1', 'szt', 1, 10)],
        },
      ],
      now,
    });
    expect(result.rows[0]?.exclusions).toContain('expired');
    expect(result.rows[0]?.comparable).toBe(false);
  });

  it('jest deterministyczny — dwa przebiegi daja identyczny wynik', () => {
    const r1 = req('r1', 'A', 'szt', 3);
    const input = {
      procurementCase: { id: 'c1', currency: 'PLN' as const, priceBasis: 'net' as const },
      requirements: [r1],
      criteria,
      offers: [
        { offer: offer('a'), supplierName: 'A', items: [item('i1', 'a', 'r1', 'szt', 3, 33.33)] },
        { offer: offer('b', { deliveryDays: 20 }), supplierName: 'B', items: [item('i2', 'b', 'r1', 'szt', 3, 33.34)] },
      ],
      now,
    };
    expect(JSON.stringify(compareOffers(input))).toBe(JSON.stringify(compareOffers(input)));
  });
});

describe('dane demonstracyjne maja sprawdzalne wartosci', () => {
  let h: Harness;
  let caseId: string;

  beforeAll(async () => {
    h = await createHarness();
    const found = h.service.repo.findCaseByCode(caseCode, h.ownerId);
    expect(found).not.toBeNull();
    caseId = found!.id;
  });
  afterAll(() => h.dispose());

  it('sumy ofert zgadzaja sie z recznym wyliczeniem', () => {
    const result = h.service.compare(caseId, h.ownerId, new Date('2026-09-14T00:00:00.000Z'));
    const byName = (n: string) => result.rows.find((r) => r.supplierName.startsWith(n));

    // 2x12400 + 1x3250 + 1x18900 + 16x180 = 24800 + 3250 + 18900 + 2880 = 49 830,00
    expect(byName('AV Technika')?.totalMinor).toBe(4_983_000);
    // 2x13100 + 1x2980 + 1x17450 + 16x165 = 26200 + 2980 + 17450 + 2640 = 49 270,00
    expect(byName('MediaPro')?.totalMinor).toBe(4_927_000);

    expect(byName('AV Technika')?.comparable).toBe(true);
    expect(byName('MediaPro')?.comparable).toBe(true);

    // Incomplete: missing video system + unit mismatch on the installation line.
    const k24 = byName('Konferencje24');
    expect(k24?.comparable).toBe(false);
    expect(k24?.completenessPct).toBe(50);
    expect(k24?.exclusions).toEqual(expect.arrayContaining(['missing_requirements', 'unit_mismatch']));

    const nord = byName('NordAV');
    expect(nord?.exclusions).toContain('currency_mismatch');

    // Cheapest complete offer with the shortest delivery wins.
    expect(result.bestOfferId).toBe(byName('MediaPro')?.offerId);
    expect(byName('MediaPro')?.rank).toBe(1);
    expect(byName('AV Technika')?.rank).toBe(2);
  });

  it('gwarancja opcjonalna MediaPro nie wchodzi do sumy porownawczej', () => {
    const result = h.service.compare(caseId, h.ownerId, new Date('2026-09-14T00:00:00.000Z'));
    const mediapro = result.rows.find((r) => r.supplierName.startsWith('MediaPro'));
    const extra = mediapro?.lines.find((l) => l.issues.includes('extra_item'));
    expect(extra).toBeDefined();
    expect(extra?.lineTotalMinor).toBe(420_000);
    expect(mediapro?.totalMinor).toBe(4_927_000);
  });
});
