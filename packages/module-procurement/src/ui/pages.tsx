import { Link, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import { apiPost, useAppState, useModuleData,
  QueryErrorState,
} from '@platform/ui';
import { formatMinor, formatQuantity, MODULE_ID } from '../shared/index.ts';

interface CaseListItem {
  id: string;
  code: string;
  title: string;
  currency: string;
  priceBasis: string;
  status: string;
  offerCount: number;
  requirementCount: number;
}

/** Cases list — the module's "records" screen. */
export function CasesPage() {
  const { data, isLoading, error } = useModuleData<{ cases: CaseListItem[] }>(MODULE_ID, '/cases');

  if (isLoading) return <div className="pf-state">Wczytywanie spraw…</div>;
  if (error) {
    return <QueryErrorState error={error} />;
  }

  return (
    <div className="pf-page" data-testid="cases-page">
      <h1>Sprawy zakupowe</h1>
      <p className="pf-page__lead">
        Kazda sprawa ustala podstawe porownania: walute i to, czy ceny sa netto czy brutto.
      </p>
      {data?.cases.length ? (
        <div className="pf-cards-grid">
          {data.cases.map((c) => (
            <Link
              key={c.id}
              to="/cases/$caseId"
              params={{ caseId: c.id }}
              className="pf-tile"
              data-testid={`case-tile-${c.id}`}
            >
              <strong>
                {c.code} — {c.title}
              </strong>
              <div className="pf-muted" style={{ marginTop: 6, fontSize: 12 }}>
                {c.currency} · {c.priceBasis === 'net' ? 'netto' : 'brutto'} · {c.offerCount} ofert ·{' '}
                {c.requirementCount} pozycji
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="pf-state pf-state--empty">Brak spraw. Uruchom `pnpm seed`.</div>
      )}
    </div>
  );
}

/**
 * Case detail.
 *
 * Opening a case does two things: it sets the agent's context to this record,
 * and it resolves (creating on first use) the canvas space bound to it. The
 * default composition comes from the module's `defaultComposition`, validated
 * server-side against the shared catalog.
 */
export function CaseDetailPage() {
  const { caseId } = useParams({ from: '/cases/$caseId' });
  const setResource = useAppState((s) => s.setResource);
  const setSpace = useAppState((s) => s.setSpace);

  const { data, isLoading, error } = useModuleData<{
    procurementCase: { id: string; code: string; title: string; description: string; currency: string; priceBasis: string };
    requirements: Array<{ id: string; position: number; name: string; unit: string; quantityMilli: number; spec: string }>;
    offers: Array<{
      offer: { id: string; reference: string; currency: string; deliveryDays: number | null; validUntil: string | null };
      supplierName: string;
      items: Array<{ id: string; name: string; unit: string; quantityMilli: number; unitPriceMinor: number | null }>;
      attachmentFileIds: string[];
    }>;
  }>(MODULE_ID, `/cases/${caseId}`);

  useEffect(() => {
    setResource({ kind: 'case', id: caseId });
    let cancelled = false;
    void (async () => {
      const state = await apiPost<{ space: { id: string } }>('/api/canvas/spaces/for-scope', {
        kind: 'case',
        id: caseId,
        title: `Sprawa ${caseId.slice(-6)}`,
      });
      if (!cancelled) setSpace(state.space.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [caseId, setResource, setSpace]);

  if (isLoading) return <div className="pf-state">Wczytywanie sprawy…</div>;
  if (error) {
    return <QueryErrorState error={error} />;
  }
  if (!data) return null;

  const c = data.procurementCase;
  return (
    <div className="pf-page" data-testid="case-detail-page">
      <h1>
        {c.code} — {c.title}
      </h1>
      <p className="pf-page__lead">
        {c.description} Podstawa porownania: {c.currency}, ceny {c.priceBasis === 'net' ? 'netto' : 'brutto'}.
      </p>
      <p>
        <Link to="/" className="pf-btn">
          Otworz przestrzen pracy na canvasie
        </Link>
      </p>

      <h2>Pozycje wymagane</h2>
      <table className="pf-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Nazwa</th>
            <th scope="col">Ilosc</th>
            <th scope="col">Specyfikacja</th>
          </tr>
        </thead>
        <tbody>
          {data.requirements.map((r) => (
            <tr key={r.id}>
              <td className="pf-num">{r.position}</td>
              <td>{r.name}</td>
              <td className="pf-num">
                {formatQuantity(r.quantityMilli)} {r.unit}
              </td>
              <td className="pf-muted">{r.spec}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Oferty</h2>
      {data.offers.map(({ offer, supplierName, items, attachmentFileIds }) => (
        <div key={offer.id} style={{ marginBottom: 18 }}>
          <h3 style={{ fontSize: 14, marginBottom: 4 }}>
            {supplierName} <span className="pf-muted">({offer.reference})</span>{' '}
            {offer.currency !== c.currency && <span className="pf-badge pf-badge--warn">{offer.currency}</span>}
          </h3>
          <table className="pf-table">
            <thead>
              <tr>
                <th scope="col">Pozycja</th>
                <th scope="col">Ilosc</th>
                <th scope="col">Cena jedn.</th>
                <th scope="col">Zrodlo</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{i.name}</td>
                  <td className="pf-num">
                    {formatQuantity(i.quantityMilli)} {i.unit}
                  </td>
                  <td className="pf-num">
                    {i.unitPriceMinor === null ? (
                      <span className="pf-missing">brak</span>
                    ) : (
                      formatMinor(i.unitPriceMinor, offer.currency as never)
                    )}
                  </td>
                  <td>
                    <Link to="/items/$itemId" params={{ itemId: i.id }} className="pf-link">
                      pochodzenie
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

/** Suppliers and offer lines — the module's "data" screen. */
export function DataPage() {
  const { data, isLoading } = useModuleData<{
    suppliers: Array<{ id: string; name: string; taxId: string | null; country: string; contactEmail: string | null }>;
  }>(MODULE_ID, '/suppliers');

  if (isLoading) return <div className="pf-state">Wczytywanie…</div>;

  return (
    <div className="pf-page" data-testid="data-page">
      <h1>Dane</h1>
      <p className="pf-page__lead">Dostawcy zarejestrowani w aplikacji.</p>
      <table className="pf-table">
        <thead>
          <tr>
            <th scope="col">Nazwa</th>
            <th scope="col">NIP</th>
            <th scope="col">Kraj</th>
            <th scope="col">Kontakt</th>
          </tr>
        </thead>
        <tbody>
          {(data?.suppliers ?? []).map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td className="pf-muted">{s.taxId ?? '—'}</td>
              <td>{s.country}</td>
              <td className="pf-muted">{s.contactEmail ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Standalone provenance view, reachable from a price in the case detail. */
export function ItemProvenancePage() {
  const { itemId } = useParams({ from: '/items/$itemId' });
  const { data, isLoading, error } = useModuleData<any>(MODULE_ID, `/items/${itemId}/provenance`);

  if (isLoading) return <div className="pf-state">Wczytywanie…</div>;
  if (error) {
    return <QueryErrorState error={error} />;
  }

  return (
    <div className="pf-page" data-testid="provenance-page">
      <h1>Pochodzenie wartosci</h1>
      <dl className="pf-kv">
        <dt>Pozycja</dt>
        <dd>{data.item.name}</dd>
        <dt>Cena jednostkowa</dt>
        <dd>{data.item.unitPriceFormatted ?? 'brak'}</dd>
        <dt>Dostawca</dt>
        <dd>{data.supplier.name}</dd>
        <dt>Oferta</dt>
        <dd>{data.offer.reference}</dd>
      </dl>
      <h2>Zrodlo</h2>
      <ul>
        {data.provenance.map((p: any) => (
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
