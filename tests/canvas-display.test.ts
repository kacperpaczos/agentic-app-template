import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { AppError, type CanvasState } from '@platform/contracts';

/**
 * What a canvas says it is showing — in the state it is actually in.
 *
 * The description of the screen is the agent's only picture of it, so a canvas
 * that renders `QueryErrorState` must not register the cards still sitting in
 * the query cache: an agent told `cardsState: 'loaded'` with a list of cards
 * would go on to talk about cards the user cannot see. The component is
 * rendered to a string with a prepared cache (no DOM, no effects) and
 * `useDisplayCanvas` is replaced by a recorder, so what is captured is exactly
 * what the component computes during render.
 */

const recorded = vi.hoisted(() => [] as unknown[]);
vi.mock('../packages/platform-ui/src/state/displayedCanvas.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useDisplayCanvas: (displayed: unknown) => {
      recorded.push(displayed);
    },
  };
});

const { CanvasSurface } = await import('../packages/platform-ui/src/canvas/CanvasHost.tsx');
const { cardsOnScreen } = await import('../packages/platform-ui/src/state/displayedCanvas.ts');
const { qk } = await import('../packages/platform-ui/src/api/queries.ts');
const { setAccessContext } = await import('../packages/platform-ui/src/api/accessContext.ts');

const uiRequire = createRequire(new URL('../packages/platform-ui/package.json', import.meta.url));
const { createElement } = uiRequire('react') as { createElement: (...args: unknown[]) => unknown };
const { renderToString } = uiRequire('react-dom/server') as { renderToString: (el: unknown) => string };

const SPACE_ID = 'spc_canvas_1';

const cardsState = (): CanvasState =>
  ({
    space: { id: SPACE_ID, scopeKind: null, viewport: { x: 0, y: 0, zoom: 1 } },
    cards: [
      {
        id: 'crd_1',
        spaceId: SPACE_ID,
        title: 'Karta',
        spec: { kind: 'openui', source: 'root = Stack([])' },
        specVersion: 1,
        geometry: { x: 0, y: 0, width: 300, height: 200, z: 0 },
      },
    ],
  }) as unknown as CanvasState;

/** Renders the canvas over a prepared cache and returns what it registered and drew. */
function render(cache: { data?: CanvasState; error?: AppError }) {
  // `retryOnMount: false` keeps a failed query failed during a render with no
  // effects; otherwise the observer optimistically reports a refetch (pending).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  setAccessContext(qc, 'local-user');
  const key = qk.space(SPACE_ID);
  if (cache.data) qc.setQueryData(key, cache.data);
  if (cache.error) {
    const query = qc.getQueryCache().build(qc, { queryKey: key });
    query.setState({ ...query.state, status: 'error', error: cache.error, errorUpdatedAt: Date.now(), fetchStatus: 'idle' });
  }
  recorded.length = 0;
  const html = renderToString(
    createElement(QueryClientProvider, { client: qc }, createElement(CanvasSurface, { spaceId: SPACE_ID })),
  );
  return { displayed: recorded.at(-1) as { cards: unknown; state: string } | undefined, html };
}

describe('opis kanwy zgadza sie z tym, co kanwa rysuje', () => {
  it('nieudane odswiezenie nad zapelnionym cache: error i brak kart, nie „loaded” z kartami', () => {
    const { displayed, html } = render({ data: cardsState(), error: new AppError('integration_failed', 'nie dziala') });
    // What the user is looking at.
    expect(html).toContain('data-testid="query-error"');
    expect(html).not.toContain('data-testid="card-crd_1"');
    // What the agent is told about it.
    expect(displayed).toMatchObject({ spaceId: SPACE_ID, cards: null, state: 'error' });
  });

  it('wczytane karty: loaded z kartami; brak odpowiedzi: loading bez kart', () => {
    const loaded = render({ data: cardsState() });
    expect(loaded.displayed).toMatchObject({ spaceId: SPACE_ID, state: 'loaded' });
    expect((loaded.displayed as { cards: Array<{ id: string }> }).cards.map((c) => c.id)).toEqual(['crd_1']);

    const loading = render({});
    expect(loading.displayed).toMatchObject({ spaceId: SPACE_ID, cards: null, state: 'loading' });
  });

  it('regula jest jedna: blad przed danymi, ladowanie przed obojgiem', () => {
    const data = { cards: [{ id: 'crd_1' }] } as unknown as { cards: [] };
    expect(cardsOnScreen({ spaceId: SPACE_ID, scopeKind: null, data, error: new Error('x') })).toEqual({
      spaceId: SPACE_ID,
      scopeKind: null,
      cards: null,
      state: 'error',
    });
    expect(cardsOnScreen({ spaceId: SPACE_ID, scopeKind: 'conversation', data: undefined, error: null })).toEqual({
      spaceId: SPACE_ID,
      scopeKind: 'conversation',
      cards: null,
      state: 'loading',
    });
    expect(cardsOnScreen({ spaceId: SPACE_ID, scopeKind: null, data, error: null })).toMatchObject({ state: 'loaded' });
  });
});
