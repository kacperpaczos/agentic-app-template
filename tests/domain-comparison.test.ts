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

/** Wspolne „now”: validity_days liczone sa wzgledem tej chwili w kazdym tescie silnika. */
const now = new Date('2026-09-14T00:00:00.000Z');

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
    // Dokladny format pl-PL: separator grup to U+00A0 (twarda spacja), zawsze dwa miejsca groszowe.
    expect(formatMinor(2_480_000, 'PLN')).toBe('24\u00a0800,00 PLN');
    // Kwota bez pelnych zlotowych nie traci groszy na paddingu: 5 gr to „0,05”, nie „0,5”.
    expect(formatMinor(5, 'PLN')).toBe('0,05 PLN');
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

/**
 * Scoring: min-max normalizacja per kryterium, potem suma wazona. Oczekiwania
 * policzone recznie i porownane z niezaleznym przeliczeniem tej samej formuly
 * (wyrocznia), nie odczytane z wyniku silnika.
 */
describe('scoring ofert (wagi, kierunki, normalizacja min-max)', () => {
  const req1 = (): Requirement => ({
    id: 'r1',
    caseId: 'c1',
    position: 1,
    name: 'A',
    sku: null,
    unit: 'szt',
    quantityMilli: parseQuantityToMilli(1),
    spec: '',
  });
  const criterion = (key: Criterion['key'], weight: number, direction: Criterion['direction']): Criterion => ({
    id: `k-${key}`,
    caseId: 'c1',
    key,
    label: key,
    weight,
    direction,
  });

  const scored = (
    criteria: Criterion[],
    specs: Array<{ id: string; total: number; deliveryDays: number | null; validDays: number }>,
  ) => {
    const day = (n: number) => new Date(Date.parse('2026-09-14T00:00:00.000Z') + n * 86_400_000).toISOString();
    const result = compareOffers({
      procurementCase: { id: 'c1', currency: 'PLN', priceBasis: 'net' },
      requirements: [req1()],
      criteria,
      offers: specs.map(({ id, total, deliveryDays, validDays }) => ({
        offer: { ...offer(id), deliveryDays, validUntil: day(validDays) },
        supplierName: id.toUpperCase(),
        // requirements maja 1 szt., wiec suma = cena jednostkowa w minorach
        items: [item(`i-${id}`, id, 'r1', 'szt', 1, total / 100)],
      })),
      now: new Date('2026-09-14T00:00:00.000Z'),
    });
    // validity_days silnik liczy jako pelne dni miedzy „now” a validUntil.
    expect(result.rows.map((r) => r.validityDays)).toEqual(specs.map((s) => s.validDays));
    return result;
  };

  it('liczy wazona sume z normalizacji min-max zgodnie z recznym wyliczeniem', () => {
    /*
     * Recznie: total_cost (w50, nizszy lepszy): min 1000, max 3000 -> orientowane 1 / 0.5 / 0.
     *          delivery_days (w30, nizszy lepszy): 10,10,20 -> 1 / 1 / 0.
     *          validity_days (w20, wyzszy lepszy): 30,10,30 -> 1 / 0 / 1.
     *          Wynik = (50a + 30d + 20v) / 100: a=100, b=55, c=20.
     */
    const result = scored(
      [
        criterion('total_cost', 50, 'lower_is_better'),
        criterion('delivery_days', 30, 'lower_is_better'),
        criterion('validity_days', 20, 'higher_is_better'),
      ],
      [
        { id: 'a', total: 1_000, deliveryDays: 10, validDays: 30 },
        { id: 'b', total: 2_000, deliveryDays: 10, validDays: 10 },
        { id: 'c', total: 3_000, deliveryDays: 20, validDays: 30 },
      ],
    );
    const scoreOf = (id: string) => result.rows.find((r) => r.offerId === id)!.score!;
    expect(scoreOf('a')).toBe(100);
    expect(scoreOf('b')).toBe(55);
    expect(scoreOf('c')).toBe(20);
    expect(result.rows.map((r) => [r.rank, r.offerId])).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
    expect(result.bestOfferId).toBe('a');
  });

  it('kryterium bez rozstrzygniecia (span 0) liczy sie jak 1: pelna waga dla wyzszego, zero dla nizszego', () => {
    /*
     * Obie oferty identyczne (total 5000, waznosc 30 dni), wiec span = 0 i
     * normalizacja przyjmuje 1 dla obu: kryterium „wyzszy lepszy” daje kazdej
     * pelne 40, a „nizszy lepszy” kazdej 0 — remis nie promuje nikogo.
     * Recznie: 0*60 + 1*40 = 40 dla obu. Wyjatek span===0 usuwa dzielenie
     * zero-przez-zero (NaN) — bez niego wynik rozsypalby sie na NaN.
     */
    const result = scored(
      [
        criterion('total_cost', 60, 'lower_is_better'),
        criterion('validity_days', 40, 'higher_is_better'),
      ],
      [
        { id: 'a', total: 5_000, deliveryDays: 7, validDays: 30 },
        { id: 'b', total: 5_000, deliveryDays: 7, validDays: 30 },
      ],
    );
    expect(result.rows.map((r) => r.score)).toEqual([40, 40]);
    // Remis: kolejnosc stabilna (wg sortu po score), best to pierwszy wiersz.
    expect(result.bestOfferId).toBe('a');
  });

  it('brakujaca wartosc kryterium daje zero, bez imputacji', () => {
    /*
     * „b” nie podal terminu dostawy (deliveryDays = null) i pozostaje porownywalny.
     * Kryterium delivery_days (w60, wyzszy lepszy) ma jedna obecna wartosc, wiec
     * span = 0 -> „a” bierze pelne 60, a „b” — brakujaca — dostaje 0, chociaz
     * imputacja minimum tez dalaby mu 60. Recznie: a = 40 + 60 = 100, b = 0.
     */
    const result = scored(
      [
        criterion('total_cost', 40, 'lower_is_better'),
        criterion('delivery_days', 60, 'higher_is_better'),
      ],
      [
        { id: 'a', total: 1_000, deliveryDays: 5, validDays: 30 },
        { id: 'b', total: 2_000, deliveryDays: null, validDays: 30 },
      ],
    );
    expect(result.rows.find((r) => r.offerId === 'a')!.score).toBe(100);
    expect(result.rows.find((r) => r.offerId === 'b')!.score).toBe(0);
    expect(result.bestOfferId).toBe('a');
  });
});

/** Martwe dotad galezie silnika: brak ceny, niezgodna ilosc, puste kryteria. */
describe('brzegi silnika porownania', () => {
  const req = (id: string, qty: number): Requirement => ({
    id,
    caseId: 'c1',
    position: 1,
    name: id,
    sku: null,
    unit: 'szt',
    quantityMilli: parseQuantityToMilli(qty),
    spec: '',
  });

  it('pozycja bez ceny wyklucza oferte z powodu missing_prices i nie dostaje wyniku', () => {
    const result = compareOffers({
      procurementCase: { id: 'c1', currency: 'PLN', priceBasis: 'net' },
      requirements: [req('r1', 1), req('r2', 1)],
      criteria,
      offers: [
        {
          offer: offer('bez_ceny'),
          supplierName: 'Bez Ceny',
          items: [
            item('i1', 'bez_ceny', 'r1', 'szt', 1, 100),
            item('i2', 'bez_ceny', 'r2', 'szt', 1, null),
          ],
        },
      ],
      now,
    });
    const row = result.rows[0]!;
    const unpaid = row.lines.find((l) => l.requirementId === 'r2')!;
    expect(unpaid.issues).toContain('missing_price');
    expect(unpaid.lineTotalMinor).toBeNull();
    expect(row.totalMinor).toBe(10_000); // suma tylko z wycenionych pozycji
    expect(row.completenessPct).toBe(50);
    expect(row.comparable).toBe(false);
    expect(row.exclusions).toContain('missing_prices');
    expect(row.score).toBeNull(); // brak wyniku i rankingu, nie zero
    expect(row.rank).toBeNull();
    expect(result.bestOfferId).toBeNull();
    expect(result.excluded).toEqual([
      { offerId: 'bez_ceny', supplierName: 'Bez Ceny', reasons: ['missing_prices'] },
    ]);
    // Uwaga zwracana klientowi: braki pozostaja brakami, silnik ich nie doszacowuje.
    expect(result.notes.join(' ')).toMatch(/nie sa rankingowane|brakujace/);
  });

  it('niezgodna ilosc nie wyklucza oferty: flaga na linii, suma z ilosci z oferty', () => {
    /*
     * Wymagane 2 szt., ofertowano 3 szt. po 100,00. Silnik nie przestrzega ilosci
     * (to decyzja kupca), ale zostawia slad: issue quantity_mismatch na linii,
     * obie ilosci widoczne, a suma liczona jest z tego, czego faktycznie dotyczy
     * cena — 3 x 100,00 = 300,00. quantity_mismatch celowo nie jest powodem
     * wykluczenia (nie ma go w exclusionReasonSchema).
     */
    const result = compareOffers({
      procurementCase: { id: 'c1', currency: 'PLN', priceBasis: 'net' },
      requirements: [req('r1', 2)],
      criteria,
      offers: [
        {
          offer: offer('ilosc3'),
          supplierName: 'Ilosc3',
          items: [item('i1', 'ilosc3', 'r1', 'szt', 3, 100)],
        },
      ],
      now,
    });
    const row = result.rows[0]!;
    const line = row.lines[0]!;
    expect(line.requiredQuantityMilli).toBe(2_000);
    expect(line.offeredQuantityMilli).toBe(3_000);
    expect(line.issues).toContain('quantity_mismatch');
    expect(line.lineTotalMinor).toBe(30_000);
    expect(row.totalMinor).toBe(30_000);
    expect(row.completenessPct).toBe(100);
    expect(row.comparable).toBe(true);
    expect(row.exclusions).toEqual([]);
    expect(result.bestOfferId).toBe('ilosc3');
  });

  it('puste kryteria uruchomia fallback na kryteria domyslne z wagami 60/25/15', () => {
    /*
     * Ksztalt domyslnych kryteriow zapisany recznie (nie przez wywolanie
     * defaultCriteria — asercja porownujaca kod z samym soba niczego nie dowodzi).
     * Razem z wynikiem:
     * total_cost 60 (a lepszy), delivery_days 25 (span 0 -> 0 dla obu),
     * validity_days 15 (span 0 -> 15 dla obu): a = 75, b = 15.
     */
    const result = compareOffers({
      procurementCase: { id: 'c1', currency: 'PLN', priceBasis: 'net' },
      requirements: [req('r1', 1)],
      criteria: [],
      offers: [
        { offer: { ...offer('a'), deliveryDays: 7 }, supplierName: 'A', items: [item('i1', 'a', 'r1', 'szt', 1, 10)] },
        { offer: { ...offer('b'), deliveryDays: 7 }, supplierName: 'B', items: [item('i2', 'b', 'r1', 'szt', 1, 30)] },
      ],
      now,
    });
    expect(result.criteria).toEqual([
      { key: 'total_cost', label: 'Koszt calkowity', weight: 60, direction: 'lower_is_better' },
      { key: 'delivery_days', label: 'Termin dostawy', weight: 25, direction: 'lower_is_better' },
      { key: 'validity_days', label: 'Waznosc oferty', weight: 15, direction: 'higher_is_better' },
    ]);
    expect(result.rows.find((r) => r.offerId === 'a')!.score).toBe(75);
    expect(result.rows.find((r) => r.offerId === 'b')!.score).toBe(15);
    expect(result.bestOfferId).toBe('a');
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
