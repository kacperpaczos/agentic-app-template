import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeChange,
  type NodeProps,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AGENT_VIEWS_SCOPE_KIND, type CanvasCard } from '@platform/contracts';
import {
  useCanvasState,
  useRemoveCard,
  useSaveViewport,
  useSpaces,
  useUpdateGeometry,
} from '../api/queries.ts';
import { useAppState } from '../state/appState.ts';
import { CardBody } from './CardBody.tsx';
import { QueryErrorState } from '../components/ErrorState.tsx';
import { cardsOnScreen, useDisplayCanvas } from '../state/displayedCanvas.ts';
import { registerCanvasFocus } from './canvasFocus.ts';

/**
 * Infinite canvas.
 *
 * React Flow (`@xyflow/react`, MIT) provides pan, zoom, drag, selection, resize
 * and the minimap. We do not reimplement any of it. What the platform adds is
 * the persistence split: React Flow reports a geometry change, we write it to
 * the geometry endpoint alone, and card content keeps flowing from its own
 * query. The two never touch.
 */

interface CardNodeData extends Record<string, unknown> {
  card: CanvasCard;
  selected: boolean;
}

function CardNode({ id, data }: NodeProps<Node<CardNodeData>>) {
  const card = data.card;
  const remove = useRemoveCard(card.spaceId);
  const selection = useAppState((s) => s.selection);
  const toggleSelection = useAppState((s) => s.toggleSelection);
  const isSelected = selection.some((s) => s.kind === 'card' && s.id === id);

  return (
    <div
      className={`pf-card ${isSelected ? 'pf-card--selected' : ''}`}
      style={{ width: card.geometry.width, height: card.geometry.height }}
      data-testid={`card-${id}`}
      data-component={card.spec.kind === 'component' ? card.spec.component : 'openui'}
    >
      <header className="pf-card__head">
        <button
          type="button"
          className="pf-card__title"
          title="Zaznacz karte dla agenta"
          onClick={() => toggleSelection({ kind: 'card', id })}
        >
          {isSelected ? '◉ ' : '○ '}
          {card.title}
        </button>
        <button
          type="button"
          className="pf-card__close"
          aria-label={`Usun karte ${card.title}`}
          onClick={() => remove.mutate(id)}
        >
          ×
        </button>
      </header>
      <div className="pf-card__body nodrag nowheel">
        <CardBody cardId={id} spec={card.spec} />
      </div>
    </div>
  );
}

const nodeTypes = { card: CardNode };

interface CanvasSurfaceProps {
  spaceId: string;
  /**
   * Whether pan and zoom are the working canvas's, reported to the agent as
   * `AppContext.viewport`. Off for a canvas that is not the user's workspace
   * (agent views): its viewport is still saved with its own space, but must not
   * pass for the position on the working canvas.
   */
  publishViewport?: boolean;
  /** Shown over a space with no cards. */
  emptyMessage?: string;
}

function CanvasInner({
  spaceId,
  publishViewport = true,
  emptyMessage = 'Pusta przestrzen. Popros agenta o dodanie karty.',
}: CanvasSurfaceProps) {
  const { data, isLoading, error } = useCanvasState(spaceId);
  /*
   * The space on screen and its cards, for the screen's description
   * (`state/displayedCanvas.ts`). Decided by the same rule as every other
   * screen showing cards, in the same order this component renders them: the
   * error below wins over cached data, so the description cannot name cards
   * while the user is looking at `QueryErrorState`.
   */
  useDisplayCanvas(cardsOnScreen({ spaceId, scopeKind: data?.space.scopeKind ?? null, data, error }));
  const updateGeometry = useUpdateGeometry(spaceId);
  const saveViewport = useSaveViewport(spaceId);
  const setViewport = useAppState((s) => s.setViewport);
  const { setViewport: applyViewport, getNode, setCenter, getZoom } = useReactFlow();

  // Centring one card, for a command that points at a value inside it (`canvasFocus.ts`).
  useEffect(
    () =>
      registerCanvasFocus((cardId) => {
        const node = getNode(cardId);
        if (!node) return false;
        const width = node.measured?.width ?? node.width ?? 0;
        const height = node.measured?.height ?? node.height ?? 0;
        void setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: getZoom(), duration: 0 });
        return true;
      }),
    [getNode, setCenter, getZoom],
  );

  /** Pending geometry writes, flushed after the pointer settles. */
  const pending = useRef(new Map<string, { x: number; y: number; width?: number; height?: number }>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localGeometry, setLocalGeometry] = useState<Record<string, { x: number; y: number }>>({});
  const viewportRestored = useRef(false);

  useEffect(() => {
    if (viewportRestored.current || !data) return;
    viewportRestored.current = true;
    // The stored viewport is restored verbatim. `fitView()` was tried here and
    // rejected: it runs before React Flow has measured the nodes, so it zooms
    // out to an unreadable scale on first paint. Cards are laid out at readable
    // size by the default composition, and the user's own pan/zoom is saved.
    applyViewport(data.space.viewport as Viewport);
  }, [data, applyViewport]);

  const flush = useCallback(() => {
    const batch = [...pending.current.entries()];
    pending.current.clear();
    for (const [cardId, geometry] of batch) {
      updateGeometry.mutate({ cardId, geometry });
    }
  }, [updateGeometry]);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = setTimeout(flush, 350);
  }, [flush]);

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current);
    },
    [],
  );

  const nodes: Node<CardNodeData>[] = useMemo(
    () =>
      (data?.cards ?? []).map((card) => ({
        id: card.id,
        type: 'card',
        position: localGeometry[card.id] ?? { x: card.geometry.x, y: card.geometry.y },
        data: { card, selected: false },
        style: { width: card.geometry.width, height: card.geometry.height },
        // Dragging only from the header keeps card content interactive.
        dragHandle: '.pf-card__head',
      })),
    [data, localGeometry],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<CardNodeData>>[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          setLocalGeometry((prev) => ({ ...prev, [change.id]: change.position as { x: number; y: number } }));
          pending.current.set(change.id, {
            ...(pending.current.get(change.id) ?? { x: 0, y: 0 }),
            x: Math.round(change.position.x),
            y: Math.round(change.position.y),
          });
          if (change.dragging === false) scheduleFlush();
        } else if (change.type === 'dimensions' && change.dimensions) {
          const stored = data?.cards.find((c) => c.id === change.id)?.geometry;
          const width = Math.round(change.dimensions.width);
          const height = Math.round(change.dimensions.height);
          /*
           * React Flow reports a card's size every time it measures it — on
           * mount, and again whenever the cards are re-read (an agent changed
           * one of them). A measurement equal to the stored size is not a
           * resize and writes nothing. When it is one, the position written
           * with it is the card's own: falling back to (0, 0), as this did,
           * moved every card the user had not dragged in this session onto
           * the first one the moment anything was measured.
           */
          if (stored && stored.width === width && stored.height === height) continue;
          const current = pending.current.get(change.id);
          const local = localGeometry[change.id];
          pending.current.set(change.id, {
            x: Math.round(current?.x ?? local?.x ?? stored?.x ?? 0),
            y: Math.round(current?.y ?? local?.y ?? stored?.y ?? 0),
            width,
            height,
          });
          scheduleFlush();
        }
      }
    },
    [scheduleFlush, localGeometry, data],
  );

  const onMoveEnd = useCallback(
    (_e: unknown, viewport: Viewport) => {
      if (publishViewport) setViewport(viewport);
      saveViewport.mutate(viewport);
    },
    [saveViewport, setViewport, publishViewport],
  );

  if (error) return <QueryErrorState error={error} what="przestrzeni pracy" />;
  if (isLoading) return <div className="pf-state">Wczytywanie przestrzeni…</div>;
  if (!data) return <div className="pf-state pf-state--empty">Brak przestrzeni pracy.</div>;

  return (
    <ReactFlow
      nodes={nodes}
      edges={[]}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onMoveEnd={onMoveEnd}
      minZoom={0.15}
      maxZoom={2.5}
      nodesConnectable={false}
      elementsSelectable
      proOptions={{ hideAttribution: false }}
      data-testid="canvas"
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable />
      {data.cards.length === 0 && (
        <div className="pf-state pf-state--empty pf-state--overlay">{emptyMessage}</div>
      )}
    </ReactFlow>
  );
}

/**
 * A canvas over one explicitly named space, independent of the space the user
 * is working in (`AppState.spaceId`), which it neither reads nor changes.
 */
export function CanvasSurface(props: CanvasSurfaceProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} key={props.spaceId} />
    </ReactFlowProvider>
  );
}

/**
 * Opens the last space the user worked in when none is selected, so landing on
 * the canvas shows real work rather than an empty invitation.
 */
export function CanvasHost() {
  const spaceId = useAppState((s) => s.spaceId);
  const setSpace = useAppState((s) => s.setSpace);
  const { data, isLoading } = useSpaces();

  useEffect(() => {
    // A conversation's agent views space is not a workspace: it has its own page.
    const working = data?.spaces.find((sp) => sp.scopeKind !== AGENT_VIEWS_SCOPE_KIND);
    if (spaceId || !working) return;
    setSpace(working.id);
  }, [spaceId, data, setSpace]);

  if (!spaceId) {
    if (isLoading) return <div className="pf-state">Wczytywanie przestrzeni…</div>;
    return (
      <div className="pf-state pf-state--empty">
        Brak przestrzeni pracy. Otworz sprawe z menu po lewej, zeby ja utworzyc.
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <CanvasInner spaceId={spaceId} key={spaceId} />
    </ReactFlowProvider>
  );
}
