import { Link } from '@tanstack/react-router';
import { defineComponent } from '@openuidev/react-lang';
import { formatFieldValue, type RecordField } from '@platform/contracts';
import { QueryErrorState, useModuleData, useReadOperation } from '@platform/ui';
import {
  caseHeaderPropsSchema,
  caseOfferSourcesPropsSchema,
  itemProvenancePropsSchema,
} from '../shared/openui-components.ts';
import { MODULE_ID } from '../shared/index.ts';

/**
 * Non-tabular OpenUI components of the case detail and item provenance
 * screens.
 *
 * Everything tabular on these screens (`DataTable` on `case_overview` and
 * `case_offer_items`) is the platform's own component reading a registered
 * read; what is left — the case's own heading, the per-offer grouping with its
 * "pochodzenie" links and downloadable attachments, and the provenance list —
 * does not fit a generic record grid, so it is this module's own React,
 * exposed to compositions the same way the canvas cards already are: typed
 * props carrying only an id, data fetched by the component itself.
 *
 * `CaseHeader` and `CaseOfferSources` both read `case_overview`: the same
 * registered read the case detail view's requirements table uses, so the
 * three components share one cached response instead of the case being
 * fetched three times.
 */

interface CaseOverviewResult {
  procurementCase: {
    code: string;
    title: string;
    description: string;
    currency: string;
    priceBasis: 'net' | 'gross';
  };
  offers: Array<{
    offer: { id: string; reference: string; currency: string };
    supplierName: string;
    items: Array<{ id: string; name: string }>;
    attachmentFileIds: string[];
  }>;
}

function useCaseOverview(caseId: string) {
  const query = useReadOperation({ operation: `${MODULE_ID}.case_overview`, input: { caseId } });
  return { ...query, result: query.data?.result as CaseOverviewResult | undefined };
}

function CaseHeaderView({ caseId }: { caseId: string }) {
  const { isLoading, error, result } = useCaseOverview(caseId);
  if (isLoading) return <div className="pf-state">Wczytywanie sprawy…</div>;
  if (error) return <QueryErrorState error={error} what="sprawy" />;
  const c = result?.procurementCase;
  if (!c) return null;
  return (
    <div>
      <h1>
        {c.code} — {c.title}
      </h1>
      <p className="pf-page__lead">
        {c.description} Podstawa porownania: {c.currency}, ceny {c.priceBasis === 'net' ? 'netto' : 'brutto'}.
      </p>
    </div>
  );
}

function CaseOfferSourcesView({ caseId }: { caseId: string }) {
  const { isLoading, error, result } = useCaseOverview(caseId);
  if (isLoading) return <div className="pf-state">Wczytywanie ofert…</div>;
  if (error) return <QueryErrorState error={error} what="ofert" />;
  const offers = result?.offers ?? [];
  const caseCurrency = result?.procurementCase.currency;
  if (offers.length === 0) return <p className="pf-state pf-state--empty">Brak ofert w tej sprawie.</p>;

  return (
    <div>
      {offers.map(({ offer, supplierName, items, attachmentFileIds }) => (
        <div key={offer.id} style={{ marginBottom: 18 }}>
          <h3 style={{ fontSize: 14, marginBottom: 4 }}>
            {supplierName} <span className="pf-muted">({offer.reference})</span>{' '}
            {offer.currency !== caseCurrency && <span className="pf-badge pf-badge--warn">{offer.currency}</span>}
          </h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {items.map((i) => (
              <li key={i.id}>
                {i.name} —{' '}
                <Link to="/items/$itemId" params={{ itemId: i.id }} className="pf-link">
                  pochodzenie
                </Link>
              </li>
            ))}
          </ul>
          {attachmentFileIds.map((fid) => (
            <a key={fid} className="pf-link" href={`/api/files/${fid}/content`} download style={{ fontSize: 12 }}>
              zalacznik zrodlowy
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}

interface ProvenanceResponse {
  item: { name: string; unitPriceMinor: number | null };
  offer: { reference: string; currency: string };
  supplier: { name: string };
  provenance: Array<{
    field: string;
    locator: string;
    note: string | null;
    file: { id: string; filename: string };
    downloadUrl: string;
  }>;
}

/** The one field this screen formats through the shared descriptor rule. */
const unitPriceField: RecordField = {
  field: 'unitPriceMinor',
  label: 'Cena jednostkowa',
  type: 'money_minor',
  unitField: 'currency',
};

function ItemProvenanceView({ itemId }: { itemId: string }) {
  const { data, isLoading, error } = useModuleData<ProvenanceResponse>(
    MODULE_ID,
    `/items/${itemId}/provenance`,
    Boolean(itemId),
  );
  if (isLoading) return <div className="pf-state">Wczytywanie…</div>;
  if (error) return <QueryErrorState error={error} />;
  if (!data) return null;

  return (
    <div>
      <dl className="pf-kv">
        <dt>Pozycja</dt>
        <dd>{data.item.name}</dd>
        <dt>Cena jednostkowa</dt>
        <dd>{formatFieldValue({ unitPriceMinor: data.item.unitPriceMinor, currency: data.offer.currency }, unitPriceField)}</dd>
        <dt>Dostawca</dt>
        <dd>{data.supplier.name}</dd>
        <dt>Oferta</dt>
        <dd>{data.offer.reference}</dd>
      </dl>
      <h2>Zrodlo</h2>
      <ul>
        {data.provenance.map((p) => (
          <li key={p.locator}>
            {p.field} — {p.locator} w{' '}
            <a className="pf-link" href={p.downloadUrl} download>
              {p.file.filename}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const procurementDetailOpenuiComponents = [
  defineComponent({
    name: 'CaseHeader',
    description: 'Naglowek sprawy zakupowej: kod, tytul, opis i podstawa porownania. Podaj wylacznie identyfikator sprawy.',
    props: caseHeaderPropsSchema,
    component: ({ props }) => <CaseHeaderView caseId={String(props.caseId)} />,
  }),
  defineComponent({
    name: 'CaseOfferSources',
    description:
      'Oferty sprawy pogrupowane po dostawcy, z lacza do pochodzenia kazdej pozycji i zalacznikami zrodlowymi. ' +
      'Podaj wylacznie identyfikator sprawy.',
    props: caseOfferSourcesPropsSchema,
    component: ({ props }) => <CaseOfferSourcesView caseId={String(props.caseId)} />,
  }),
  defineComponent({
    name: 'ItemProvenance',
    description:
      'Pochodzenie wartosci jednej pozycji oferty: pozycja, cena, dostawca, oferta i lista zrodel z lacza do pliku. ' +
      'Podaj wylacznie identyfikator pozycji.',
    props: itemProvenancePropsSchema,
    component: ({ props }) => <ItemProvenanceView itemId={String(props.itemId)} />,
  }),
];
