import type { ModuleSeedContext } from '@platform/contracts';
import { newId, nowIso } from '@platform/server';
import {
  parseAmountToMinor,
  parseQuantityToMilli,
  type Currency,
  type Offer,
  type OfferItem,
  type PriceBasis,
  type Unit,
} from '../shared/index.ts';
import type { ProcurementService } from './services.ts';

const iso = (d: string) => new Date(`${d}T09:00:00.000Z`).toISOString();

interface SeedItem {
  requirementKey: string | null;
  name: string;
  unit: Unit;
  quantity: number;
  unitPrice: number | null;
  note?: string;
}

interface SeedOffer {
  supplierKey: string;
  reference: string;
  receivedAt: string;
  currency: Currency;
  priceBasis: PriceBasis;
  validUntil: string | null;
  deliveryDays: number | null;
  deliveryTerms: string;
  notes?: string;
  items: SeedItem[];
  csv: string;
  /** Row in the CSV each price came from, for the provenance walk. */
  provenanceRows: Record<string, string>;
}

/**
 * Demo dataset with known, checkable arithmetic.
 *
 * The expected results are asserted in `tests/domain-comparison.test.ts`, so the
 * numbers in the UI can be verified against an independent calculation rather
 * than taken on trust:
 *
 *   AV Technika   49 830,00 PLN  (complete, 21 dni)
 *   MediaPro      49 270,00 PLN  (complete, 14 dni)   <- best
 *   Konferencje24 excluded: brak pozycji + niezgodna jednostka (kompletnosc 50%)
 *   NordAV        excluded: oferta w EUR, brak jawnego ujednolicenia waluty
 */
export async function seedProcurement(
  service: ProcurementService,
  ctx: ModuleSeedContext,
): Promise<void> {
  const ownerId = ctx.ownerId;
  if (service.repo.findCaseByCode('PC-2026-01', ownerId)) return;

  const procurementCase = service.createCase({
    ownerId,
    code: 'PC-2026-01',
    title: 'Wyposazenie sali konferencyjnej',
    description:
      'Zakup i montaz wyposazenia AV dla sali konferencyjnej na 40 osob. Porownanie w PLN, ceny netto.',
    currency: 'PLN',
    priceBasis: 'net',
    status: 'collecting',
  });

  /* ------------------------------ requirements ---------------------------- */

  const requirementDefs: Array<{ key: string; name: string; unit: Unit; qty: number; spec: string }> = [
    { key: 'projektor', name: 'Projektor laserowy 4K', unit: 'szt', qty: 2, spec: 'Min. 5000 ANSI lm, 4K, laser' },
    { key: 'ekran', name: 'Ekran elektryczny 120 cali', unit: 'szt', qty: 1, spec: 'Format 16:9, sterowanie RF' },
    { key: 'wideo', name: 'System wideokonferencyjny', unit: 'kpl', qty: 1, spec: 'Kamera PTZ + mikrofony sufitowe' },
    { key: 'montaz', name: 'Montaz i kalibracja', unit: 'h', qty: 16, spec: 'Prace na obiekcie, dni robocze' },
  ];

  const requirementIds = new Map<string, string>();
  requirementDefs.forEach((r, index) => {
    const id = newId('pcr');
    requirementIds.set(r.key, id);
    service.repo.insertRequirement({
      id,
      caseId: procurementCase.id,
      position: index + 1,
      name: r.name,
      sku: null,
      unit: r.unit,
      quantityMilli: parseQuantityToMilli(r.qty),
      spec: r.spec,
    });
  });

  /* -------------------------------- suppliers ----------------------------- */

  const supplierDefs = [
    { key: 'avtechnika', name: 'AV Technika Sp. z o.o.', taxId: '5213456789', country: 'PL', email: 'oferty@avtechnika.example' },
    { key: 'mediapro', name: 'MediaPro Systemy', taxId: '7010987654', country: 'PL', email: 'przetargi@mediapro.example' },
    { key: 'konferencje24', name: 'Konferencje24', taxId: '9512345678', country: 'PL', email: 'biuro@konferencje24.example' },
    { key: 'nordav', name: 'NordAV OY', taxId: 'FI12345678', country: 'FI', email: 'sales@nordav.example' },
  ];

  const supplierIds = new Map<string, string>();
  for (const s of supplierDefs) {
    const id = newId('pcs');
    supplierIds.set(s.key, id);
    service.repo.insertSupplier({
      id,
      ownerId,
      name: s.name,
      taxId: s.taxId,
      country: s.country,
      contactEmail: s.email,
      createdAt: nowIso(),
    });
  }

  /* --------------------------------- offers -------------------------------- */

  const offers: SeedOffer[] = [
    {
      supplierKey: 'avtechnika',
      reference: 'OF/2026/114',
      receivedAt: iso('2026-08-20'),
      currency: 'PLN',
      priceBasis: 'net',
      validUntil: iso('2026-12-31'),
      deliveryDays: 21,
      deliveryTerms: 'DDP, dostawa i wniesienie w cenie',
      items: [
        { requirementKey: 'projektor', name: 'Projektor laserowy 4K EX-5200', unit: 'szt', quantity: 2, unitPrice: 12400 },
        { requirementKey: 'ekran', name: 'Ekran elektryczny 120"', unit: 'szt', quantity: 1, unitPrice: 3250 },
        { requirementKey: 'wideo', name: 'Zestaw wideokonferencyjny Pro', unit: 'kpl', quantity: 1, unitPrice: 18900 },
        { requirementKey: 'montaz', name: 'Montaz i kalibracja', unit: 'h', quantity: 16, unitPrice: 180 },
      ],
      csv: [
        'pozycja;nazwa;jednostka;ilosc;cena_jednostkowa_netto_pln',
        '1;Projektor laserowy 4K EX-5200;szt;2;12400.00',
        '2;Ekran elektryczny 120";szt;1;3250.00',
        '3;Zestaw wideokonferencyjny Pro;kpl;1;18900.00',
        '4;Montaz i kalibracja;h;16;180.00',
      ].join('\n'),
      provenanceRows: { projektor: 'wiersz 2, kolumna cena_jednostkowa_netto_pln', ekran: 'wiersz 3, kolumna cena_jednostkowa_netto_pln', wideo: 'wiersz 4, kolumna cena_jednostkowa_netto_pln', montaz: 'wiersz 5, kolumna cena_jednostkowa_netto_pln' },
    },
    {
      supplierKey: 'mediapro',
      reference: 'MP-2026-0442',
      receivedAt: iso('2026-08-22'),
      currency: 'PLN',
      priceBasis: 'net',
      validUntil: iso('2026-11-30'),
      deliveryDays: 14,
      deliveryTerms: 'DAP, wniesienie po stronie zamawiajacego',
      items: [
        { requirementKey: 'projektor', name: 'Projektor laser 4K MP-Vision', unit: 'szt', quantity: 2, unitPrice: 13100 },
        { requirementKey: 'ekran', name: 'Ekran elektryczny 120" Slim', unit: 'szt', quantity: 1, unitPrice: 2980 },
        { requirementKey: 'wideo', name: 'System wideokonferencyjny MP-Conf', unit: 'kpl', quantity: 1, unitPrice: 17450 },
        { requirementKey: 'montaz', name: 'Montaz, kalibracja, szkolenie', unit: 'h', quantity: 16, unitPrice: 165 },
        { requirementKey: null, name: 'Przedluzona gwarancja 5 lat (opcja)', unit: 'usluga', quantity: 1, unitPrice: 4200, note: 'Pozycja spoza zapytania - nie wchodzi do sumy porownawczej' },
      ],
      csv: [
        'pozycja;nazwa;jednostka;ilosc;cena_jednostkowa_netto_pln',
        '1;Projektor laser 4K MP-Vision;szt;2;13100.00',
        '2;Ekran elektryczny 120" Slim;szt;1;2980.00',
        '3;System wideokonferencyjny MP-Conf;kpl;1;17450.00',
        '4;Montaz, kalibracja, szkolenie;h;16;165.00',
        '5;Przedluzona gwarancja 5 lat (opcja);usluga;1;4200.00',
      ].join('\n'),
      provenanceRows: { projektor: 'wiersz 2, kolumna cena_jednostkowa_netto_pln', ekran: 'wiersz 3, kolumna cena_jednostkowa_netto_pln', wideo: 'wiersz 4, kolumna cena_jednostkowa_netto_pln', montaz: 'wiersz 5, kolumna cena_jednostkowa_netto_pln' },
    },
    {
      supplierKey: 'konferencje24',
      reference: 'K24/26/77',
      receivedAt: iso('2026-08-25'),
      currency: 'PLN',
      priceBasis: 'net',
      validUntil: iso('2026-10-15'),
      deliveryDays: 30,
      deliveryTerms: 'EXW magazyn dostawcy',
      notes: 'Brak wyceny systemu wideokonferencyjnego; montaz wyceniony ryczaltem.',
      items: [
        { requirementKey: 'projektor', name: 'Projektor 4K K24-LX', unit: 'szt', quantity: 2, unitPrice: 11900 },
        { requirementKey: 'ekran', name: 'Ekran elektryczny 120"', unit: 'szt', quantity: 1, unitPrice: 3100 },
        // Unit differs from the requirement (usluga vs h) -> not normalised away.
        { requirementKey: 'montaz', name: 'Montaz ryczalt', unit: 'usluga', quantity: 1, unitPrice: 2400, note: 'Ryczalt zamiast stawki godzinowej' },
      ],
      csv: [
        'pozycja;nazwa;jednostka;ilosc;cena_jednostkowa_netto_pln',
        '1;Projektor 4K K24-LX;szt;2;11900.00',
        '2;Ekran elektryczny 120";szt;1;3100.00',
        '3;Montaz ryczalt;usluga;1;2400.00',
      ].join('\n'),
      provenanceRows: { projektor: 'wiersz 2, kolumna cena_jednostkowa_netto_pln', ekran: 'wiersz 3, kolumna cena_jednostkowa_netto_pln', montaz: 'wiersz 4, kolumna cena_jednostkowa_netto_pln' },
    },
    {
      supplierKey: 'nordav',
      reference: 'NAV-26-9',
      receivedAt: iso('2026-08-26'),
      currency: 'EUR',
      priceBasis: 'net',
      validUntil: iso('2026-12-15'),
      deliveryDays: 18,
      deliveryTerms: 'DAP Warszawa',
      notes: 'Oferta w EUR - poza podstawa porownania sprawy.',
      items: [
        { requirementKey: 'projektor', name: 'Laser projector 4K NX', unit: 'szt', quantity: 2, unitPrice: 2780 },
        { requirementKey: 'ekran', name: 'Electric screen 120"', unit: 'szt', quantity: 1, unitPrice: 690 },
        { requirementKey: 'wideo', name: 'Video conference kit', unit: 'kpl', quantity: 1, unitPrice: 4150 },
        { requirementKey: 'montaz', name: 'Installation', unit: 'h', quantity: 16, unitPrice: 45 },
      ],
      csv: [
        'position;name;unit;quantity;unit_price_net_eur',
        '1;Laser projector 4K NX;szt;2;2780.00',
        '2;Electric screen 120";szt;1;690.00',
        '3;Video conference kit;kpl;1;4150.00',
        '4;Installation;h;16;45.00',
      ].join('\n'),
      provenanceRows: { projektor: 'wiersz 2, kolumna unit_price_net_eur', ekran: 'wiersz 3, kolumna unit_price_net_eur', wideo: 'wiersz 4, kolumna unit_price_net_eur', montaz: 'wiersz 5, kolumna unit_price_net_eur' },
    },
  ];

  for (const seed of offers) {
    const offerId = newId('pco');
    const ts = nowIso();
    const record: Offer = {
      id: offerId,
      caseId: procurementCase.id,
      supplierId: supplierIds.get(seed.supplierKey) as string,
      reference: seed.reference,
      receivedAt: seed.receivedAt,
      currency: seed.currency,
      priceBasis: seed.priceBasis,
      validUntil: seed.validUntil,
      deliveryDays: seed.deliveryDays,
      deliveryTerms: seed.deliveryTerms,
      notes: seed.notes ?? null,
      version: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    service.repo.insertOffer(record);

    const stored = await ctx.storeFile({
      filename: `oferta-${seed.supplierKey}-${seed.reference.replace(/[^\w-]/g, '_')}.csv`,
      mediaType: 'text/csv',
      bytes: new TextEncoder().encode(`${seed.csv}\n`),
      scopeKind: 'procurement.offer',
      scopeId: offerId,
    });
    service.repo.insertAttachment({
      id: newId('pca'),
      offerId,
      fileId: stored.id,
      kind: 'offer_document',
      createdAt: ts,
    });

    seed.items.forEach((item, index) => {
      const itemId = newId('pci');
      const record: OfferItem = {
        id: itemId,
        offerId,
        requirementId: item.requirementKey ? (requirementIds.get(item.requirementKey) ?? null) : null,
        position: index + 1,
        name: item.name,
        unit: item.unit,
        quantityMilli: parseQuantityToMilli(item.quantity),
        unitPriceMinor: item.unitPrice === null ? null : parseAmountToMinor(item.unitPrice),
        note: item.note ?? null,
        version: 1,
      };
      service.repo.insertItem(record);

      const locator = item.requirementKey ? seed.provenanceRows[item.requirementKey] : undefined;
      if (locator) {
        service.repo.insertProvenance({
          id: newId('pcp'),
          offerId,
          offerItemId: itemId,
          field: 'unit_price',
          fileId: stored.id,
          locator,
          note: `Cena odczytana z dokumentu oferty ${seed.reference}.`,
        });
      }
    });
  }

  /* ---- an extra, not-yet-imported quote for the sandbox CSV scenario ----- */

  await ctx.storeFile({
    filename: 'oferta-nowa-technika-NT-2026-51.csv',
    mediaType: 'text/csv',
    bytes: new TextEncoder().encode(
      [
        'pozycja;nazwa;jednostka;ilosc;cena_jednostkowa_netto_pln',
        '1;Projektor laserowy 4K NT-900;szt;2;12750.00',
        '2;Ekran elektryczny 120";szt;1;3050.00',
        '3;System wideokonferencyjny NT-Meet;kpl;1;18100.00',
        '4;Montaz i kalibracja;h;16;172.50',
        '',
      ].join('\n'),
    ),
    scopeKind: 'procurement.case',
    scopeId: procurementCase.id,
  });
}
