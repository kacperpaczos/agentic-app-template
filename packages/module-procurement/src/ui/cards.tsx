import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BarChart } from '@openuidev/react-ui';
import { apiPatch, qk, useAppState, useModuleData, type CardComponent } from '@platform/ui';
import {
  formatMinor,
  formatQuantity,
  MODULE_ID,
  type ComparisonResult,
  type ComparisonRow,
} from '../shared/index.ts';

/* -------------------------------------------------------------------------- */
/*  Shared helpers                                                            */
/* -------------------------------------------------------------------------- */

const EXCLUSION_LABELS: Record<string, string> = {
  currency_mismatch: 'inna waluta',
  price_basis_mismatch: 'inna podstawa cenowa',
  missing_prices: 'brak cen',
  unit_mismatch: 'niezgodna jednostka',
  missing_requirements: 'brak wymaganych pozycji',
  expired: 'po terminie waznosci',
};

const ISSUE_LABELS: Record<string, string> = {
  missing_item: 'brak pozycji',
  missing_price: 'brak ceny',
  unit_mismatch: 'inna jednostka',
  quantity_mismatch: 'inna ilosc',
  extra_item: 'spoza zapytania',
};

function Loading() {
  return <div className="pf-state">Wczytywanie danych…</div>;
}

function Failure({ error }: { error: unknown }) {
  const err = error as { code?: string; message?: string };
  if (err?.code === 'forbidden') {
    return (
      <div className="pf-state pf-state--error" role="alert">
        Brak dostepu do tych danych.
      </div>
    );
  }
  if (err?.code === 'not_found') {
    return <div className="pf-state pf-state--empty">Rekord nie istnieje.</div>;
  }
  return (
    <div className="pf-state pf-state--error" role="alert">
      {err?.message ?? 'Nieznany blad'}
    </div>
  );
}

/** Every business value shown here comes from the backend, never from props. */
function useComparison(caseId: string) {
  return useModuleData<ComparisonResult>(MODULE_ID, `/cases/${caseId}/comparison`, Boolean(caseId));
}

interface CaseDetailResponse {
  procurementCase: {
    id: string;
    code: string;
    title: string;
    description: string;
    currency: string;
    priceBasis: string;
    status: string;
  };
  requirements: Array<{ id: string; position: number; name: string; unit: string; quantityMilli: number; spec: string }>;
  offers: Array<{
    offer: {
      id: string;
      reference: string;
      currency: string;
      priceBasis: string;
      validUntil: string | null;
      deliveryDays: number | null;
      deliveryTerms: string | null;
      notes: string | null;
    };
    supplierName: string;
    items: Array<{
      id: string;
      requirementId: string | null;
      name: string;
      unit: string;
      quantityMilli: number;
      unitPriceMinor: number | null;
      version: number;
      note: string | null;
    }>;
    attachmentFileIds: string[];
  }>;
}

const useCaseDetail = (caseId: string) =>
  useModuleData<CaseDetailResponse>(MODULE_ID, `/cases/${caseId}`, Boolean(caseId));

/* -------------------------------------------------------------------------- */
/*  Cards                                                                     */
/* -------------------------------------------------------------------------- */

export const CaseSummaryCard: CardComponent = ({ props }) => {
  const caseId = String(props.caseId ?? '');
  const { data, isLoading, error } = useCaseDetail(caseId);
  if (isLoading) return <Loading />;
  if (error) return <Failure error={error} />;
  if (!data) return <div className="pf-state pf-state--empty">Brak sprawy.</div>;

  const c = data.procurementCase;
  return (
    <div data-testid="card-case-summary">
      <h3 style={{ margin: '0 0 4px' }}>
        {c.code} — {c.title}
      </h3>
      <p className="pf-muted" style={{ marginTop: 0 }}>{c.description}</p>
      <dl className="pf-kv">
        <dt>Podstawa porownania</dt>
        <dd>
          {c.currency}, ceny {c.priceBasis === 'net' ? 'netto' : 'brutto'}
        </dd>
        <dt>Pozycje wymagane</dt>
        <dd>{data.requirements.length}</dd>
        <dt>Oferty</dt>
        <dd>{data.offers.length}</dd>
        <dt>Status</dt>
        <dd>{c.status}</dd>
      </dl>
    </div>
  );
};

export const OfferListCard: CardComponent = ({ props }) => {
  const caseId = String(props.caseId ?? '');
  const { data, isLoading, error } = useCaseDetail(caseId);
  const toggleSelection = useAppState((s) => s.toggleSelection);
  const selection = useAppState((s) => s.selection);

  if (isLoading) return <Loading />;
  if (error) return <Failure error={error} />;
  if (!data?.offers.length) return <div className="pf-state pf-state--empty">Brak ofert w tej sprawie.</div>;

  return (
    <table className="pf-table" data-testid="card-offer-list">
      <thead>
        <tr>
          <th scope="col">Dostawca</th>
          <th scope="col">Referencja</th>
          <th scope="col">Waluta</th>
          <th scope="col">Pozycji</th>
          <th scope="col">Dostawa</th>
        </tr>
      </thead>
      <tbody>
        {data.offers.map(({ offer, supplierName, items }) => {
          const selected = selection.some((s) => s.kind === 'offer' && s.id === offer.id);
          return (
            <tr
              key={offer.id}
              onClick={() => toggleSelection({ kind: 'offer', id: offer.id })}
              style={{ cursor: 'pointer' }}
              className={selected ? 'pf-row--best' : ''}
              data-testid={`offer-row-${offer.id}`}
            >
              <td>
                {selected ? '◉ ' : ''}
                {supplierName}
              </td>
              <td className="pf-muted">{offer.reference}</td>
              <td>
                {offer.currency}
                {offer.currency !== data.procurementCase.currency && (
                  <span className="pf-badge pf-badge--warn"> inna</span>
                )}
              </td>
              <td className="pf-num">{items.length}</td>
              <td className="pf-num">{offer.deliveryDays === null ? '—' : `${offer.deliveryDays} dni`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

export const ComparisonTableCard: CardComponent = ({ cardId, props }) => {
  const caseId = String(props.caseId ?? '');
  const showExcludedDefault = props.showExcluded !== false;
  const { data, isLoading, error } = useComparison(caseId);

  // Card-local view state lives in the app store, not in the canvas node, so it
  // survives the agent rearranging the layout.
  const cardState = useAppState((s) => s.cardState[cardId]);
  const setCardState = useAppState((s) => s.setCardState);
  const showExcluded = (cardState?.showExcluded as boolean | undefined) ?? showExcludedDefault;

  if (isLoading) return <Loading />;
  if (error) return <Failure error={error} />;
  if (!data) return <div className="pf-state pf-state--empty">Brak danych porownania.</div>;

  const ranked = data.rows.filter((r) => r.comparable).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  const excluded = data.rows.filter((r) => !r.comparable);

  return (
    <div data-testid="card-comparison">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
        <span className="pf-badge">
          podstawa: {data.caseCurrency}, {data.casePriceBasis === 'net' ? 'netto' : 'brutto'}
        </span>
        <label style={{ fontSize: 12 }}>
          <input
            type="checkbox"
            checked={showExcluded}
            onChange={(e) => setCardState(cardId, { showExcluded: e.target.checked })}
          />{' '}
          pokaz wykluczone ({excluded.length})
        </label>
      </div>

      <table className="pf-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Dostawca</th>
            <th scope="col">Suma</th>
            <th scope="col">Dostawa</th>
            <th scope="col">Waznosc</th>
            <th scope="col">Kompletnosc</th>
            <th scope="col">Wynik</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((row) => (
            <tr
              key={row.offerId}
              className={row.offerId === data.bestOfferId ? 'pf-row--best' : ''}
              data-testid={`comparison-row-${row.offerId}`}
            >
              <td className="pf-num">{row.rank}</td>
              <td>
                {row.supplierName}
                {row.offerId === data.bestOfferId && <span className="pf-badge pf-badge--ok"> najlepsza</span>}
              </td>
              <td className="pf-num" data-testid={`total-${row.offerId}`}>
                {row.totalMinor === null ? (
                  <span className="pf-missing">brak</span>
                ) : (
                  formatMinor(row.totalMinor, row.currency)
                )}
              </td>
              <td className="pf-num">{row.deliveryDays === null ? <span className="pf-missing">brak</span> : `${row.deliveryDays} dni`}</td>
              <td className="pf-num">{row.validityDays === null ? <span className="pf-missing">brak</span> : `${row.validityDays} dni`}</td>
              <td className="pf-num">{row.completenessPct}%</td>
              <td className="pf-num">{row.score ?? '—'}</td>
            </tr>
          ))}

          {showExcluded &&
            excluded.map((row) => (
              <tr key={row.offerId} className="pf-row--excluded" data-testid={`comparison-row-${row.offerId}`}>
                <td className="pf-num">—</td>
                <td>{row.supplierName}</td>
                <td className="pf-num">
                  {row.totalMinor === null ? (
                    <span className="pf-missing">brak</span>
                  ) : (
                    <span className="pf-muted">{formatMinor(row.totalMinor, row.currency)} (czesciowa)</span>
                  )}
                </td>
                <td className="pf-num">{row.deliveryDays ?? '—'}</td>
                <td className="pf-num">{row.validityDays ?? '—'}</td>
                <td className="pf-num">{row.completenessPct}%</td>
                <td>
                  {row.exclusions.map((e) => (
                    <span key={e} className="pf-badge pf-badge--warn" style={{ marginRight: 4 }}>
                      {EXCLUSION_LABELS[e] ?? e}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
        </tbody>
      </table>

      {data.notes.map((n) => (
        <p key={n} className="pf-muted" style={{ fontSize: 12, marginTop: 8 }}>
          {n}
        </p>
      ))}

      <LineBreakdown rows={showExcluded ? data.rows : ranked} />
    </div>
  );
};

function LineBreakdown({ rows }: { rows: ComparisonRow[] }) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12 }}>Pozycje szczegolowe</summary>
      {rows.map((row) => (
        <div key={row.offerId} style={{ marginTop: 8 }}>
          <strong style={{ fontSize: 13 }}>{row.supplierName}</strong>
          <table className="pf-table">
            <thead>
              <tr>
                <th scope="col">Pozycja</th>
                <th scope="col">Ilosc</th>
                <th scope="col">Cena jedn.</th>
                <th scope="col">Wartosc</th>
                <th scope="col">Uwagi</th>
              </tr>
            </thead>
            <tbody>
              {row.lines.map((l, i) => (
                <tr key={`${row.offerId}-${l.offerItemId ?? l.requirementId ?? i}`}>
                  <td>{l.itemName ?? l.requirementName}</td>
                  <td className="pf-num">
                    {l.offeredQuantityMilli === null ? (
                      <span className="pf-missing">brak</span>
                    ) : (
                      `${formatQuantity(l.offeredQuantityMilli)} ${l.unit ?? ''}`
                    )}
                  </td>
                  <td className="pf-num">
                    {l.unitPriceMinor === null ? (
                      <span className="pf-missing">brak</span>
                    ) : (
                      formatMinor(l.unitPriceMinor, row.currency)
                    )}
                  </td>
                  <td className="pf-num">
                    {l.lineTotalMinor === null ? (
                      <span className="pf-missing">brak</span>
                    ) : (
                      formatMinor(l.lineTotalMinor, row.currency)
                    )}
                  </td>
                  <td>
                    {l.issues.map((issue) => (
                      <span key={issue} className="pf-badge pf-badge--warn" style={{ marginRight: 4 }}>
                        {ISSUE_LABELS[issue] ?? issue}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </details>
  );
}

export const CostChartCard: CardComponent = ({ props }) => {
  const caseId = String(props.caseId ?? '');
  const { data, isLoading, error } = useComparison(caseId);

  const chartData = useMemo(
    () =>
      (data?.rows ?? [])
        .filter((r) => r.totalMinor !== null)
        .map((r) => ({
          name: r.supplierName,
          Koszt: Math.round((r.totalMinor as number) / 100),
        })),
    [data],
  );

  if (isLoading) return <Loading />;
  if (error) return <Failure error={error} />;
  if (!chartData.length) return <div className="pf-state pf-state--empty">Brak wycenionych ofert.</div>;

  const incomplete = (data?.rows ?? []).filter((r) => r.totalMinor !== null && !r.comparable);

  return (
    <div data-testid="card-cost-chart" style={{ height: '100%', minHeight: 220 }}>
      <BarChart data={chartData as never} categoryKey="name" />
      <p className="pf-muted" style={{ fontSize: 11, marginTop: 4 }}>
        Kwoty w {data?.caseCurrency} ({data?.casePriceBasis === 'net' ? 'netto' : 'brutto'}).
        {incomplete.length > 0 &&
          ` Slupki ofert niekompletnych (${incomplete
            .map((r) => r.supplierName)
            .join(', ')}) to sumy czesciowe i nie sa porownywalne.`}
      </p>
    </div>
  );
};

export const DeliveryTermsCard: CardComponent = ({ props }) => {
  const caseId = String(props.caseId ?? '');
  const { data, isLoading, error } = useCaseDetail(caseId);
  if (isLoading) return <Loading />;
  if (error) return <Failure error={error} />;
  if (!data?.offers.length) return <div className="pf-state pf-state--empty">Brak ofert.</div>;

  return (
    <table className="pf-table" data-testid="card-delivery-terms">
      <thead>
        <tr>
          <th scope="col">Dostawca</th>
          <th scope="col">Termin</th>
          <th scope="col">Warunki</th>
          <th scope="col">Wazna do</th>
        </tr>
      </thead>
      <tbody>
        {data.offers.map(({ offer, supplierName }) => (
          <tr key={offer.id}>
            <td>{supplierName}</td>
            <td className="pf-num">
              {offer.deliveryDays === null ? <span className="pf-missing">brak</span> : `${offer.deliveryDays} dni`}
            </td>
            <td className="pf-muted">{offer.deliveryTerms ?? <span className="pf-missing">brak</span>}</td>
            <td className="pf-muted">
              {offer.validUntil ? new Date(offer.validUntil).toLocaleDateString('pl-PL') : <span className="pf-missing">brak</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/**
 * Editable line.
 *
 * Draft state is registered in the platform store so the agent can see that a
 * form is dirty — and is told explicitly that a draft is not stored data.
 * The save path goes through the same service the MCP tool uses, carrying the
 * row version so a stale save is rejected rather than applied.
 */
export const OfferItemFormCard: CardComponent = ({ cardId, props }) => {
  const offerId = String(props.offerId ?? '');
  const preselected = props.itemId ? String(props.itemId) : null;
  const qc = useQueryClient();
  const setDraft = useAppState((s) => s.setDraft);
  const clearDraft = useAppState((s) => s.clearDraft);

  const { data, isLoading, error } = useModuleData<{
    offer: { id: string; currency: string; caseId: string };
    items: Array<{ id: string; name: string; unit: string; quantityMilli: number; unitPriceMinor: number | null; version: number }>;
  }>(MODULE_ID, `/offers/${offerId}`, Boolean(offerId));

  const [selectedId, setSelectedId] = useState<string | null>(preselected);
  const [quantity, setQuantity] = useState<string>('');
  const [unitPrice, setUnitPrice] = useState<string>('');
  const [conflict, setConflict] = useState<string | null>(null);

  const item = data?.items.find((i) => i.id === (selectedId ?? data.items[0]?.id));

  const save = useMutation({
    mutationFn: async () => {
      if (!item) throw new Error('Brak wybranej pozycji.');
      return apiPatch(`/api/m/${MODULE_ID}/items/${item.id}`, {
        quantity: quantity === '' ? undefined : Number(quantity),
        unitPrice: unitPrice === '' ? undefined : Number(unitPrice),
        expectedVersion: item.version,
        operationId: `ui-${item.id}-${item.version}-${quantity}-${unitPrice}`,
      });
    },
    onSuccess: () => {
      setConflict(null);
      clearDraft(`item-${item?.id}`);
      setQuantity('');
      setUnitPrice('');
      void qc.invalidateQueries({ queryKey: ['module'] });
      void qc.invalidateQueries({ queryKey: qk.spaces() });
    },
    onError: (e) => {
      const err = e as { code?: string; message?: string };
      setConflict(
        err.code === 'conflict'
          ? 'Pozycja zostala w miedzyczasie zmieniona. Odswiez dane i sprobuj ponownie.'
          : (err.message ?? 'Blad zapisu'),
      );
    },
  });

  if (isLoading) return <Loading />;
  if (error) return <Failure error={error} />;
  if (!data?.items.length) return <div className="pf-state pf-state--empty">Oferta nie ma pozycji.</div>;

  const markDirty = (field: string, value: string) => {
    const dirty = [
      ...(field === 'quantity' ? (value ? ['quantity'] : []) : quantity ? ['quantity'] : []),
      ...(field === 'unitPrice' ? (value ? ['unitPrice'] : []) : unitPrice ? ['unitPrice'] : []),
    ];
    if (item && dirty.length) {
      setDraft({
        formId: `item-${item.id}`,
        entity: 'offer_item',
        entityId: item.id,
        dirtyFields: dirty,
        values: { quantity, unitPrice, [field]: value },
      });
    } else if (item) {
      clearDraft(`item-${item.id}`);
    }
  };

  return (
    <div data-testid="card-item-form" data-card={cardId}>
      <div className="pf-field">
        <label htmlFor={`item-${cardId}`}>Pozycja</label>
        <select
          id={`item-${cardId}`}
          value={item?.id ?? ''}
          onChange={(e) => {
            setSelectedId(e.target.value);
            setQuantity('');
            setUnitPrice('');
            setConflict(null);
          }}
        >
          {data.items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </div>

      {item && (
        <>
          <p className="pf-muted" style={{ fontSize: 12 }}>
            Zapisane: {formatQuantity(item.quantityMilli)} {item.unit} ·{' '}
            {item.unitPriceMinor === null ? 'brak ceny' : formatMinor(item.unitPriceMinor, data.offer.currency as never)} ·
            wersja {item.version}
          </p>

          <div className={`pf-field ${quantity ? 'pf-field--dirty' : ''}`}>
            <label htmlFor={`qty-${cardId}`}>Nowa ilosc ({item.unit})</label>
            <input
              id={`qty-${cardId}`}
              type="number"
              step="0.001"
              min="0"
              value={quantity}
              placeholder={formatQuantity(item.quantityMilli)}
              onChange={(e) => {
                setQuantity(e.target.value);
                markDirty('quantity', e.target.value);
              }}
            />
          </div>

          <div className={`pf-field ${unitPrice ? 'pf-field--dirty' : ''}`}>
            <label htmlFor={`price-${cardId}`}>Nowa cena jednostkowa ({data.offer.currency})</label>
            <input
              id={`price-${cardId}`}
              type="number"
              step="0.01"
              value={unitPrice}
              placeholder={item.unitPriceMinor === null ? '' : String(item.unitPriceMinor / 100)}
              onChange={(e) => {
                setUnitPrice(e.target.value);
                markDirty('unitPrice', e.target.value);
              }}
            />
          </div>

          {conflict && (
            <div className="pf-state pf-state--error" role="alert">
              {conflict}
            </div>
          )}

          <button
            type="button"
            className="pf-btn pf-btn--primary"
            disabled={save.isPending || (!quantity && !unitPrice)}
            onClick={() => save.mutate()}
            data-testid="save-item"
          >
            {save.isPending ? 'Zapisywanie…' : 'Zapisz'}
          </button>
        </>
      )}
    </div>
  );
};

export const ProvenanceCard: CardComponent = ({ props }) => {
  const itemId = String(props.itemId ?? '');
  const { data, isLoading, error } = useModuleData<{
    item: { name: string; quantity: string; unitPriceFormatted: string | null };
    offer: { reference: string; receivedAt: string };
    supplier: { name: string };
    provenance: Array<{ field: string; locator: string; note: string | null; file: { id: string; filename: string }; downloadUrl: string }>;
    otherAttachments: Array<{ kind: string; file: { filename: string }; downloadUrl: string }>;
  }>(MODULE_ID, `/items/${itemId}/provenance`, Boolean(itemId));

  if (!itemId) return <div className="pf-state pf-state--empty">Brak identyfikatora pozycji.</div>;
  if (isLoading) return <Loading />;
  if (error) return <Failure error={error} />;
  if (!data) return null;

  return (
    <div data-testid="card-provenance">
      <dl className="pf-kv">
        <dt>Pozycja</dt>
        <dd>{data.item.name}</dd>
        <dt>Cena jednostkowa</dt>
        <dd>{data.item.unitPriceFormatted ?? <span className="pf-missing">brak</span>}</dd>
        <dt>Dostawca</dt>
        <dd>{data.supplier.name}</dd>
        <dt>Oferta</dt>
        <dd>
          {data.offer.reference} ({new Date(data.offer.receivedAt).toLocaleDateString('pl-PL')})
        </dd>
      </dl>

      <h4 style={{ margin: '10px 0 4px', fontSize: 13 }}>Zrodlo wartosci</h4>
      {data.provenance.length === 0 ? (
        <p className="pf-missing">Brak zapisanego pochodzenia dla tej pozycji.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {data.provenance.map((p) => (
            <li key={`${p.field}-${p.file.id}`} style={{ marginBottom: 4 }}>
              <strong>{p.field}</strong> — {p.locator} w{' '}
              <a className="pf-link" href={p.downloadUrl} download>
                {p.file.filename}
              </a>
              {p.note && <div className="pf-muted" style={{ fontSize: 12 }}>{p.note}</div>}
            </li>
          ))}
        </ul>
      )}

      {data.otherAttachments.length > 0 && (
        <>
          <h4 style={{ margin: '10px 0 4px', fontSize: 13 }}>Pozostale zalaczniki</h4>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.otherAttachments.map((a) => (
              <li key={a.file.filename}>
                <a className="pf-link" href={a.downloadUrl} download>
                  {a.file.filename}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

export const procurementCardRenderers: Record<string, CardComponent> = {
  'procurement.caseSummary': CaseSummaryCard,
  'procurement.offerList': OfferListCard,
  'procurement.comparisonTable': ComparisonTableCard,
  'procurement.costChart': CostChartCard,
  'procurement.deliveryTerms': DeliveryTermsCard,
  'procurement.offerItemForm': OfferItemFormCard,
  'procurement.provenance': ProvenanceCard,
};
