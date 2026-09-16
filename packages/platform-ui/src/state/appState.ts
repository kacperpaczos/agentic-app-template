import { create } from 'zustand';
import type { AppContext } from '@platform/contracts';

export type RunPhase =
  | 'idle'
  | 'queued'
  | 'running'
  | 'awaiting_consent'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** What the client knows about one conversation's most recent run. */
export interface ConversationRun {
  phase: RunPhase;
  runId: string | null;
  /** Tool currently being executed, when one is. */
  activeTool: string | null;
  /**
   * Answer text as it arrives, while the turn is still open.
   *
   * The ready-made thread commits an assistant message only once the turn
   * resolves (see `RunState` in ChatPanel for why), so without this the user
   * watches a spinner while the answer is already streaming in.
   */
  streamingText: string;
  errorCode: string | null;
  errorMessage: string | null;
  /**
   * Highest event sequence number applied. A client re-attaching after a reload
   * asks for everything after it, so nothing is replayed into the view twice.
   */
  lastSeq: number;
  /** Consent request raised by this run's `canUseTool` gate, if any. */
  pendingPermission: {
    requestId: string;
    toolName: string;
    input: string;
    runId: string;
  } | null;
  /**
   * True once a run that the user was not looking at has resolved — the signal
   * that lets the interface say "the task in that conversation is done" without
   * dragging them into it.
   */
  unseenResult: boolean;
}

export const emptyRun = (): ConversationRun => ({
  phase: 'idle',
  runId: null,
  activeTool: null,
  streamingText: '',
  errorCode: null,
  errorMessage: null,
  lastSeq: 0,
  pendingPermission: null,
  unseenResult: false,
});

export interface DraftRecord {
  formId: string;
  entity: string;
  entityId: string | null;
  dirtyFields: string[];
  /** Raw values, kept client-side only; never sent as if they were stored data. */
  values: Record<string, unknown>;
}

interface AppState {
  spaceId: string | null;
  conversationId: string | null;
  /** Module-defined resource the user is on, e.g. { kind: 'case', id }. */
  resource: { kind: string; id: string } | null;
  selection: Array<{ kind: string; id: string }>;
  filters: Record<string, unknown>;
  viewport: { x: number; y: number; zoom: number } | null;
  drafts: Record<string, DraftRecord>;
  /** Per-card view state (filters, expanded rows). Survives layout changes. */
  cardState: Record<string, Record<string, unknown>>;
  navOpen: boolean;
  lastRunId: string | null;
  /**
   * Files the next command will be given, by id.
   *
   * Held here rather than in `filters` because they are not a filter: the
   * backend copies them into the run workspace before the model starts, which
   * is a different kind of thing from narrowing a view. Cleared once a command
   * has been sent — an attachment belongs to the command the user attached it
   * to, not to the conversation for ever.
   */
  attachments: string[];
  /**
   * Lifecycle of every run the client knows about, **keyed by conversation**.
   *
   * Keyed, and not a single record, because a run belongs to its conversation
   * rather than to the panel. Switching to another conversation, or reloading,
   * must not show one conversation's progress under another's messages — which
   * is exactly what a single global record did. Entries are kept for finished
   * runs too, so coming back to a conversation shows its result instead of an
   * empty strip.
   *
   * Each phase is derived from the run's own events — never from whether text
   * has appeared. A run that produces no text is still running; a run whose
   * text has arrived is not finished until its terminal event says so.
   */
  runs: Record<string, ConversationRun>;

  setSpace: (id: string | null) => void;
  setConversation: (id: string | null) => void;
  setResource: (r: { kind: string; id: string } | null) => void;
  toggleSelection: (item: { kind: string; id: string }) => void;
  clearSelection: () => void;
  setFilter: (key: string, value: unknown) => void;
  setViewport: (v: { x: number; y: number; zoom: number }) => void;
  setDraft: (draft: DraftRecord) => void;
  clearDraft: (formId: string) => void;
  setCardState: (cardId: string, patch: Record<string, unknown>) => void;
  setNavOpen: (open: boolean) => void;
  setLastRunId: (id: string | null) => void;
  setAttachments: (ids: string[]) => void;
  /** Merges a patch into one conversation's run record, creating it if absent. */
  patchRun: (conversationId: string, patch: Partial<ConversationRun>) => void;
  /** Reads one conversation's run record, or an empty one. */
  runFor: (conversationId: string | null) => ConversationRun;
  /** Clears the "finished while you were elsewhere" marker. */
  acknowledgeRun: (conversationId: string) => void;
  toAppContext: () => AppContext;
}

/**
 * Client-side application state.
 *
 * Deliberately *outside* the canvas library's node data. React Flow owns node
 * positions and nothing else, so re-laying-out the canvas — by the user or by
 * the agent — cannot drop a filter, a selection or a half-typed form.
 *
 * `toAppContext()` is the single place that turns this into the context sent to
 * the agent. Drafts travel clearly labelled as drafts; they are never presented
 * to the model as stored data.
 */
export const useAppState = create<AppState>((set, get) => ({
  spaceId: null,
  conversationId: null,
  resource: null,
  selection: [],
  filters: {},
  viewport: null,
  drafts: {},
  cardState: {},
  navOpen: true,
  lastRunId: null,
  attachments: [],
  runs: {},

  setSpace: (id) => set({ spaceId: id }),
  setConversation: (id) => set({ conversationId: id }),
  setResource: (resource) => set({ resource, selection: [] }),
  toggleSelection: (item) =>
    set((s) => {
      const exists = s.selection.some((x) => x.kind === item.kind && x.id === item.id);
      return {
        selection: exists
          ? s.selection.filter((x) => !(x.kind === item.kind && x.id === item.id))
          : [...s.selection, item].slice(-20),
      };
    }),
  clearSelection: () => set({ selection: [] }),
  setFilter: (key, value) => set((s) => ({ filters: { ...s.filters, [key]: value } })),
  setViewport: (viewport) => set({ viewport }),
  setDraft: (draft) => set((s) => ({ drafts: { ...s.drafts, [draft.formId]: draft } })),
  clearDraft: (formId) =>
    set((s) => {
      const next = { ...s.drafts };
      delete next[formId];
      return { drafts: next };
    }),
  setCardState: (cardId, patch) =>
    set((s) => ({ cardState: { ...s.cardState, [cardId]: { ...(s.cardState[cardId] ?? {}), ...patch } } })),
  setNavOpen: (navOpen) => set({ navOpen }),
  setLastRunId: (lastRunId) => set({ lastRunId }),
  setAttachments: (attachments) => set({ attachments }),
  patchRun: (conversationId, patch) =>
    set((s) => ({
      runs: { ...s.runs, [conversationId]: { ...(s.runs[conversationId] ?? emptyRun()), ...patch } },
    })),
  runFor: (conversationId) => (conversationId ? (get().runs[conversationId] ?? emptyRun()) : emptyRun()),
  acknowledgeRun: (conversationId) =>
    set((s) =>
      s.runs[conversationId]
        ? { runs: { ...s.runs, [conversationId]: { ...s.runs[conversationId]!, unseenResult: false } } }
        : s,
    ),

  toAppContext: () => {
    const s = get();
    return {
      conversationId: s.conversationId,
      spaceId: s.spaceId,
      resource: s.resource,
      selection: s.selection,
      filters: s.filters,
      viewport: s.viewport,
      drafts: Object.values(s.drafts).map((d) => ({
        formId: d.formId,
        entity: d.entity,
        entityId: d.entityId,
        dirtyFields: d.dirtyFields,
      })),
    };
  },
}));
