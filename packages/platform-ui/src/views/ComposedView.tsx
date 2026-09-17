import { useMemo, type ReactNode } from 'react';
import { Renderer } from '@openuidev/react-lang';
import { useViewDefinitions } from '../api/queries.ts';
import { useRegistry } from '../catalog/registry.tsx';
import { QueryErrorState } from '../components/ErrorState.tsx';
import { RenderErrorBoundary } from '../components/RenderErrorBoundary.tsx';
import { ComposedViewContext } from './viewContext.ts';

/**
 * A module screen rendered from its composition.
 *
 * The view's OpenUI Lang source goes through the same `Renderer` and the same
 * catalog as an `openui` card or a message in the chat, so a default screen and
 * a screen the agent writes are made of the same components. Route parameters
 * reach the composition as `$name` state; a parameter the view declares but was
 * not given is a stated failure, not a table asking the backend for nothing.
 *
 * The frame (`data-testid="composed-view"`, `data-view-id`) is present in every
 * state — loading, failure, unknown view, rendered — so a test or a description
 * of the screen can tell which view was meant even when it did not render.
 */
export function ComposedView({ viewId, params }: { viewId: string; params?: Record<string, string> }) {
  const registry = useRegistry();
  const views = useViewDefinitions();
  const view = views.data?.find((v) => v.id === viewId) ?? null;

  const paramsKey = JSON.stringify(params ?? {});
  const initialState = useMemo(() => {
    const entries = Object.entries(params ?? {});
    return entries.length ? Object.fromEntries(entries.map(([k, v]) => [`$${k}`, v])) : undefined;
    // Compared by value: callers build `params` inline.
  }, [paramsKey]);

  const context = useMemo(
    () => ({ viewId, primaryOperation: view?.primaryOperation ?? null }),
    [viewId, view?.primaryOperation],
  );

  const frame = (state: string, body: ReactNode) => (
    <div className="pf-composed-view" data-testid="composed-view" data-view-id={viewId} data-state={state}>
      {body}
    </div>
  );

  if (views.isLoading) {
    return frame(
      'loading',
      <div className="pf-state" role="status">
        Wczytywanie widoku…
      </div>,
    );
  }
  if (views.error) return frame('error', <QueryErrorState error={views.error} what="widoku" />);
  if (!view) {
    return frame(
      'unknown',
      <div className="pf-state pf-state--error" role="alert" data-testid="composed-view-unknown">
        Widok <code>{viewId}</code> nie jest zarejestrowany w tej instalacji.
      </div>,
    );
  }

  const missing = (view.params ?? []).filter((p) => !params?.[p]);
  if (missing.length > 0) {
    return frame(
      'error',
      <div className="pf-state pf-state--error" role="alert">
        Widok „{view.title}” wymaga parametrow: {missing.join(', ')}.
      </div>,
    );
  }

  return frame(
    'ready',
    <ComposedViewContext.Provider value={context}>
      <RenderErrorBoundary
        label={view.title}
        describe={(name, message) => `Widok „${name}” nie mogl sie wyrenderowac: ${message}`}
      >
        <Renderer response={view.composition} library={registry.library} initialState={initialState} />
      </RenderErrorBoundary>
    </ComposedViewContext.Provider>,
  );
}
