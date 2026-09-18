import { Link } from '@tanstack/react-router';
import { AGENT_VIEWS_SCOPE_KIND } from '@platform/contracts';
import { useSpaces } from '../api/queries.ts';
import { useAppState } from '../state/appState.ts';
import { QueryErrorState } from '../components/ErrorState.tsx';

/**
 * Saved compositions.
 *
 * A space is the persistent canvas for one scope. Reopening one restores its
 * cards, their positions and the viewport — the composition is stored server
 * side, not in the browser.
 */
export function WorkspacePage() {
  const { data, isLoading, error } = useSpaces();
  const currentSpace = useAppState((s) => s.spaceId);

  if (isLoading) return <div className="pf-state">Wczytywanie przestrzeni…</div>;
  if (error) return <QueryErrorState error={error} what="listy przestrzeni" />;
  // Agent views belong to their conversation and are shown on their own page.
  const spaces = data?.spaces.filter((s) => s.scopeKind !== AGENT_VIEWS_SCOPE_KIND) ?? [];

  return (
    <div className="pf-page" data-testid="workspace-page">
      <h1>Przestrzen pracy</h1>
      <p className="pf-page__lead">
        Zapisane kompozycje canvasu. Uklad, rozmiary kart i widok sa trwale i wracaja po restarcie.
      </p>

      {spaces.length ? (
        <div className="pf-cards-grid">
          {spaces.map((s) => (
            <Link
              key={s.id}
              to="/"
              className="pf-tile"
              /*
               * The space travels in the address, not through a store call
               * beside the navigation.
               *
               * Setting it in `onClick` made `SpaceSync` rewrite *this* entry's
               * address (it corrects the URL by replacement) and only then did
               * the link push the canvas. The entry the user came from lost the
               * space it was opened with, so Back landed on this page with the
               * new space already in force and a second Back was needed to undo
               * one click. Carried in the link, one history entry holds one
               * choice and Back restores exactly the previous workspace.
               */
              search={(prev: Record<string, unknown>) => ({ ...prev, s: s.id })}
              data-testid={`space-${s.id}`}
            >
              <strong>{s.title}</strong>
              {s.id === currentSpace && <span className="pf-badge pf-badge--ok"> otwarta</span>}
              <div className="pf-muted" style={{ marginTop: 6, fontSize: 12 }}>
                {s.scopeKind ? `${s.scopeKind}:${s.scopeId?.slice(-8)}` : 'bez zakresu'} ·{' '}
                zmieniona {new Date(s.updatedAt).toLocaleString('pl-PL')}
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="pf-state pf-state--empty">
          Brak zapisanych przestrzeni. Otworz rekord, zeby utworzyc jego przestrzen pracy.
        </div>
      )}
    </div>
  );
}
