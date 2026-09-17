import { Link, useParams } from '@tanstack/react-router';
import { useEffect } from 'react';
import {
  apiPost,
  ComposedView,
  useAppState,
  useModuleData,
  useReadOperation,
  QueryErrorState,
} from '@platform/ui';
import { MODULE_ID } from '../shared/index.ts';

/**
 * Cases list — the module's "records" screen.
 *
 * The list itself is the `procurement.cases` view: a composition over the
 * platform's `DataTable`, reading the registered `procurement.cases` read. This
 * wrapper only keeps the screen's frame; the rows, their links and the
 * narrowing from the address bar all come from the composition.
 */
export function CasesPage() {
  return (
    <div className="pf-page" data-testid="cases-page">
      <h1>Sprawy zakupowe</h1>
      <ComposedView viewId="procurement.cases" />
    </div>
  );
}

/**
 * Case detail — the `procurement.case.detail` view: a composition of a case
 * header, its required lines and its offer items, all reading registered
 * reads for `$caseId`.
 *
 * Opening a case does two things outside that composition, kept in this
 * deterministic wrapper: it sets the agent's context to this record, and it
 * resolves (creating on first use) the canvas space bound to it. The default
 * composition comes from the module's `defaultComposition`, validated
 * server-side against the shared catalog.
 *
 * **Why this fetches too.** The composition itself is happy to show a "does
 * not exist" state for any one of its data components — that is how a broken
 * table already behaves. But a screen that does not exist at all must not
 * claim the frame `data-testid="case-detail-page"`: a test switching identity
 * asserts exactly that (`e2e/access-context.spec.ts`). So the wrapper reads
 * `case_overview` itself, purely to decide whether to render the frame; the
 * composition's own components read the same registered operation and land on
 * the same cached response, so this is one request, not two.
 */
export function CaseDetailPage() {
  const { caseId } = useParams({ from: '/cases/$caseId' });
  const setResource = useAppState((s) => s.setResource);
  const setSpace = useAppState((s) => s.setSpace);

  const { isLoading, error, data } = useReadOperation({
    operation: `${MODULE_ID}.case_overview`,
    input: { caseId },
  });

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

  return (
    <div className="pf-page" data-testid="case-detail-page">
      <p>
        <Link to="/" className="pf-btn">
          Otworz przestrzen pracy na canvasie
        </Link>
      </p>
      <ComposedView viewId="procurement.case.detail" params={{ caseId }} />
    </div>
  );
}

/**
 * Suppliers — the module's "data" screen, rendered from the `procurement.data`
 * view: a composition whose table reads `procurement.suppliers`.
 */
export function DataPage() {
  return (
    <div className="pf-page" data-testid="data-page">
      <h1>Dane</h1>
      <ComposedView viewId="procurement.data" />
    </div>
  );
}

/**
 * Standalone provenance view, reachable from a price in the case detail — the
 * `procurement.item.provenance` view, one custom `ItemProvenance` component
 * reading `/items/:itemId/provenance` for `$itemId`.
 *
 * Same reasoning as `CaseDetailPage` for why this wrapper fetches too: the
 * frame `data-testid="provenance-page"` must not appear for an item that does
 * not exist or is not the caller's, and this is the same module route the
 * composition's own `ItemProvenance` component reads, so the two share one
 * cached response.
 */
export function ItemProvenancePage() {
  const { itemId } = useParams({ from: '/items/$itemId' });
  const { data, isLoading, error } = useModuleData<unknown>(MODULE_ID, `/items/${itemId}/provenance`);

  if (isLoading) return <div className="pf-state">Wczytywanie…</div>;
  if (error) {
    return <QueryErrorState error={error} />;
  }
  if (!data) return null;

  return (
    <div className="pf-page" data-testid="provenance-page">
      <h1>Pochodzenie wartosci</h1>
      <ComposedView viewId="procurement.item.provenance" params={{ itemId }} />
    </div>
  );
}
