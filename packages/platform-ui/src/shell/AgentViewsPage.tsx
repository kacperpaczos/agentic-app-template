import type { ReactNode } from 'react';
import { useAgentViews } from '../api/queries.ts';
import { CanvasSurface } from '../canvas/CanvasHost.tsx';
import { QueryErrorState } from '../components/ErrorState.tsx';
import { AGENT_VIEWS_SCOPE_KIND, type CanvasCard, type CanvasSpace } from '@platform/contracts';
import { useDisplayCanvas, type DisplayedCanvas } from '../state/displayedCanvas.ts';
import { useSessionLocation } from '../state/sessionLocation.ts';

/**
 * "Agent views": the active conversation's presentation space.
 *
 * Each conversation has its own space (scope `conversation:<id>`), filled by
 * the agent through the `agent_view_*` tools with compositions of data
 * components. This page shows the space of the conversation named in the
 * address bar (`c`) — so a reload, Back and switching conversations all show
 * the right one without anything else to restore.
 *
 * It never touches the workspace: the canvas here is given its space
 * explicitly, the working space (`s`, `AppState.spaceId`) is neither read nor
 * written, and its pan and zoom are not reported as the working canvas's
 * viewport. The cards are the same canvas cards as anywhere else, so the user
 * can move them, and a move survives the agent changing their content.
 */
/**
 * What the agent views page shows, for the screen's description — decided the
 * same way the page decides what to render, so the two cannot disagree. Null
 * only when the page renders the canvas, which describes itself (with the cards
 * it actually draws). Never the working space: without a conversation, on an
 * error, or with no views, the page shows none of its cards.
 */
export function agentViewsDisplay(input: {
  conversationId: string | null;
  data: { space: CanvasSpace | null; cards: CanvasCard[] } | undefined;
  failed: boolean;
}): DisplayedCanvas | null {
  const scopeKind = AGENT_VIEWS_SCOPE_KIND;
  if (!input.conversationId) return { spaceId: null, scopeKind, cards: [], state: 'none' };
  // An error is shown even when older data is still cached: that data is not on screen.
  if (input.failed) return { spaceId: null, scopeKind, cards: null, state: 'error' };
  if (!input.data) return { spaceId: null, scopeKind, cards: null, state: 'loading' };
  const { space, cards } = input.data;
  if (!space) return { spaceId: null, scopeKind, cards: [], state: 'none' };
  if (cards.length === 0) return { spaceId: space.id, scopeKind, cards: [], state: 'loaded' };
  return null;
}

export function AgentViewsPage() {
  const { conversationId } = useSessionLocation();
  const views = useAgentViews(conversationId);
  /*
   * What this page shows, for the screen's description, while it has no canvas
   * of its own on screen: no views yet is an empty set of cards, not the working
   * space's. Once the canvas is there, the canvas says it (with fresher cards).
   */
  useDisplayCanvas(agentViewsDisplay({ conversationId, data: views.data, failed: Boolean(views.error) }));

  const frame = (state: string, body: ReactNode, spaceId?: string) => (
    <div
      className="pf-agent-views"
      data-testid="agent-views-page"
      data-state={state}
      data-conversation-id={conversationId ?? ''}
      data-space-id={spaceId ?? ''}
    >
      <header className="pf-agent-views__head">
        <h1>Widoki agenta</h1>
        <p className="pf-page__lead">
          Tabele, wykresy i podsumowania utworzone przez agenta w tej rozmowie. Dane pochodza z backendu i
          odswiezaja sie po ich zmianie; kazda rozmowa ma wlasne widoki.
        </p>
      </header>
      {body}
    </div>
  );

  if (!conversationId) {
    return frame(
      'no-conversation',
      <div className="pf-state pf-state--empty" role="status">
        Brak aktywnej rozmowy. Wybierz rozmowe z listy albo zacznij nowa — widoki agenta naleza do rozmowy.
      </div>,
    );
  }
  if (views.error) {
    return frame('error', <QueryErrorState error={views.error} what="widokow agenta" />);
  }
  if (views.isLoading || !views.data) {
    return frame(
      'loading',
      <div className="pf-state" role="status">
        Wczytywanie widokow agenta…
      </div>,
    );
  }
  const { space, cards } = views.data;
  if (!space || cards.length === 0) {
    return frame(
      'empty',
      <div className="pf-state pf-state--empty" role="status" data-testid="agent-views-empty">
        Ta rozmowa nie ma jeszcze widokow. Popros agenta o zestawienie, porownanie lub wykres — pojawi sie tutaj.
      </div>,
      space?.id,
    );
  }
  return frame(
    'ready',
    <div className="pf-agent-views__canvas">
      <CanvasSurface spaceId={space.id} publishViewport={false} emptyMessage="Ta rozmowa nie ma jeszcze widokow." />
    </div>,
    space.id,
  );
}
