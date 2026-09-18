import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  NodeResizer,
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
import { useAppState, type DraftRecord } from '../state/appState.ts';
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

function CardNode({ id, data, selected }: NodeProps<Node<CardNodeData>>) {
  const card = data.card;
  const remove = useRemoveCard(card.spaceId);
  const selection = useAppState((s) => s.selection);
  const toggleSelection = useAppState((s) => s.toggleSelection);
  const isSelected = selection.some((s) => s.kind === 'card' && s.id === id);

  return (
    <div
      className={`pf-card ${isSelected ? 'pf-card--selected' : ''}`}
      /*
       * The node's box is React Flow's, not ours.
       *
       * The card used to repeat the stored size here, which is why resizing
       * could not work: while the library was dragging a handle it changed the
       * node's dimensions, and this inline size held the frame at the old one.
       * Filling the node lets the library own the geometry during the gesture,
       * and the write-back in `onNodesChange` makes it persistent.
       */
      style={{ width: '100%', height: '100%' }}
      data-testid={`card-${id}`}
      data-component={card.spec.kind === 'component' ? card.spec.component : 'openui'}
    >
      {/*
        Resizing is the library's own control (`NodeResizer`, @xyflow/react
        12.11.6), shown on the selected card. We add no handle, no pointer maths
        and no drag state: the component reports `dimensions` changes through
        the same `onNodesChange` that carries a move, and they are persisted by
        the same path.

        Limitation, stated plainly: the handles are pointer-only — the library
        renders them as unlabelled `div`s with no keyboard affordance — so a
        keyboard user can move a card (the header is a control) but cannot
        resize one. Nothing here can fix that without reimplementing the
        control this criterion requires be the ready-made one.
      */}
      <NodeResizer
        isVisible={selected}
        minWidth={240}
        minHeight={120}
        lineClassName="pf-card__resize-line"
        handleClassName="pf-card__resize-handle"
      />
      <header className="pf-card__head">
        <button
          type="button"
          className="pf-card__title"
          title="Zaznacz karte dla agenta"
          aria-pressed={isSelected}
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

/**
 * Unsaved work whose card is no longer in the composition.
 *
 * A composition changes under the user: the agent adds, updates, moves or
 * removes a card, and every client showing that space re-reads it. Selections,
 * per-card view state and drafts survive that by construction — they are held
 * in `appState`, outside the canvas library's nodes — but a card that is
 * *removed* takes its form off the screen with it, and the half-typed values in
 * it are then held by a store nothing is showing.
 *
 * Losing them silently is the failure this notice exists to prevent. The draft
 * is kept, named, and the user decides: nothing is discarded until they say so.
 */
function LostDraftNotice({ drafts, onDiscard }: { drafts: DraftRecord[]; onDiscard: (formId: string) => void }) {
  if (!drafts.length) return null;
  return (
    <div className="pf-draft-conflict" role="alert" data-testid="draft-conflict">
      <strong>Karta z niezapisanymi zmianami zniknela z kompozycji.</strong>
      <ul>
        {drafts.map((d) => (
          <li key={d.formId} data-testid={`draft-conflict-${d.formId}`}>
            <code>{d.entity}</code>
            {d.entityId ? ` ${d.entityId.slice(-8)}` : ''} — niezapisane pola:{' '}
            <strong>{d.dirtyFields.join(', ')}</strong>
            <button
              type="button"
              className="pf-btn pf-btn--tiny"
              data-testid={`draft-discard-${d.formId}`}
              onClick={() => onDiscard(d.formId)}
            >
              Odrzuc szkic
            </button>
          </li>
        ))}
      </ul>
      <span className="pf-muted">
        Nic nie zostalo zapisane ani odrzucone. Szkic czeka, dopoki nie zdecydujesz.
      </span>
    </div>
  );
}

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
  const drafts = useAppState((s) => s.drafts);
  const clearDraft = useAppState((s) => s.clearDraft);
  /*
   * Cards this canvas has shown. Held per space — the component is keyed by
   * `spaceId` — so a draft in another space's card is not reported missing
   * here, and a card that was never on this canvas cannot be reported lost
   * from it.
   */
  const seenCards = useRef(new Set<string>());
  useEffect(() => {
    // Recorded in an effect, not while rendering: a render may be discarded or
    // replayed, and this ref decides whether the user is told their work
    // disappeared. It must follow what was committed to the screen.
    for (const card of data?.cards ?? []) seenCards.current.add(card.id);
  }, [data]);
  const presentCards = new Set((data?.cards ?? []).map((c) => c.id));
  const lostDrafts: DraftRecord[] = Object.values(drafts).filter(
    (d) => d.cardId && seenCards.current.has(d.cardId) && !presentCards.has(d.cardId),
  );
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
  /**
   * Geometry this session has changed and the server has not echoed back yet.
   *
   * Holds the size as well as the position, because the size is now something
   * the user changes (`NodeResizer`): without it a resized card snapped back to
   * the stored size on the next render, before the debounced write landed.
   */
  const [localGeometry, setLocalGeometry] = useState<
    Record<string, { x?: number; y?: number; width?: number; height?: number }>
  >({});
  /**
   * Which cards the canvas library considers selected.
   *
   * Held here because the nodes are controlled: they are derived from the
   * stored composition on every render, so a `selected` flag the library set on
   * its own copy is overwritten immediately. Without this the library's
   * selection never reached a node — which is why the resize control, whose
   * visibility follows it, could not appear.
   *
   * Deliberately separate from `AppState.selection`, which is the user marking
   * a card *for the agent*: one is "the pointer is on this card", the other is
   * "include this in the next command", and conflating them would make clicking
   * a card change what the agent is told.
   */
  const [activeNodes, setActiveNodes] = useState<Record<string, boolean>>({});
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
      (data?.cards ?? []).map((card) => {
        const local = localGeometry[card.id];
        return {
          id: card.id,
          type: 'card',
          position: { x: local?.x ?? card.geometry.x, y: local?.y ?? card.geometry.y },
          selected: activeNodes[card.id] ?? false,
          data: { card, selected: activeNodes[card.id] ?? false },
          width: local?.width ?? card.geometry.width,
          height: local?.height ?? card.geometry.height,
          style: { width: local?.width ?? card.geometry.width, height: local?.height ?? card.geometry.height },
          // Dragging only from the header keeps card content interactive.
          dragHandle: '.pf-card__head',
        };
      }),
    [data, localGeometry, activeNodes],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<CardNodeData>>[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          const at = change.position;
          setLocalGeometry((prev) => ({ ...prev, [change.id]: { ...(prev[change.id] ?? {}), x: at.x, y: at.y } }));
          pending.current.set(change.id, {
            ...(pending.current.get(change.id) ?? { x: 0, y: 0 }),
            x: Math.round(change.position.x),
            y: Math.round(change.position.y),
          });
          if (change.dragging === false) scheduleFlush();
        } else if (change.type === 'select') {
          setActiveNodes((prev) => ({ ...prev, [change.id]: change.selected }));
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
          /*
           * A resize the *user* performed is also held locally until the write
           * lands, exactly as a move is. A plain measurement is not: taking it
           * as local state would pin every card to whatever the browser
           * measured on mount and undo the stored layout.
           */
          if (change.resizing || change.setAttributes) {
            setLocalGeometry((prev) => ({ ...prev, [change.id]: { ...(prev[change.id] ?? {}), width, height } }));
          }
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
      <LostDraftNotice drafts={lostDrafts} onDiscard={clearDraft} />
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
    if (!working) return;
    /*
     * Read from the store, not from the render's value.
     *
     * This effect mounts in the same commit as the one in which `SpaceSync`
     * adopts the space from the address — and effects see the props of the
     * render they belong to, so the `spaceId` in scope here is the one from
     * *before* that adoption: null. Opening a saved composition from the list
     * therefore fell back to the most recently changed space instead, wrote
     * that into the address, and the user landed in a workspace they had not
     * chosen. The store is the only value that is current at the moment this
     * runs.
     */
    if (useAppState.getState().spaceId) return;
    setSpace(working.id);
  }, [spaceId, data, setSpace]);

  if (!spaceId) {
    if (isLoading) return <div className="pf-state">Wczytywanie przestrzeni…</div>;
    return (
      <div className="pf-state pf-state--empty">
        Brak przestrzeni pracy. Otworz rekord z menu po lewej, zeby ja utworzyc.
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <CanvasInner spaceId={spaceId} key={spaceId} />
    </ReactFlowProvider>
  );
}
