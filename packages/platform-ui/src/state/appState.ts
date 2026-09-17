import { create } from 'zustand';
import type {
  AppContext,
  DataSort,
  UiRevealAdjustment,
  ViewFilterPredicate,
  ViewPage,
  ViewStateContext,
} from '@platform/contracts';
import { uiSnapshotSession } from './uiSnapshot.ts';

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

/**
 * What the primary instance of one view is showing, as it counted it.
 *
 * Reported by the view (`DataTable`) while it is mounted and dropped when it
 * unmounts, so the store holds the state of the views actually on screen —
 * the banner describes it, the acknowledgement of an agent's command reads it,
 * and `toAppContext()` sends it with the next command.
 */
export interface ViewStateReport {
  targetId: string;
  /** The instance reporting; only it may withdraw the report. */
  instanceId: string;
  /** `viewAddressKey` of the address state the view applied. */
  address: string;
  /** The address bar's narrowing in force. */
  predicates: ViewFilterPredicate[];
  /** Order in force, and the label of its field. */
  sort: DataSort | null;
  sortLabel: string | null;
  /** True when the order is the address bar's rather than the composition's. */
  sortFromAddress: boolean;
  /** An order the address asked for and the view set aside. */
  rejectedSort: (DataSort & { reason: 'unknown_field' | 'not_sortable' }) | null;
  page: ViewPage | null;
  /** The page the address asked for when it did not exist (the nearest is shown). */
  clampedFrom: number | null;
  /** Records left after the narrowing. */
  matched: number;
  /** Records the view would show without the narrowing. */
  total: number;
}

/** The part of a report the agent's context carries. */
export const viewStateContextOf = (r: ViewStateReport): ViewStateContext => ({
  predicates: r.predicates,
  sort: r.sort,
  page: r.page,
  matched: r.matched,
  total: r.total,
});

/**
 * The value the agent last pointed at, and what it changed on screen to get
 * there — shown above the view while the user is still looking at that state.
 */
export interface RevealNotice {
  /** The screen and view state it applies to (`revealAddress`). */
  address: string;
  /**
   * Whether the value was actually pointed at. False when the command changed
   * the presentation and then could not show the cell — the change is on
   * screen either way, so it is announced either way.
   */
  shown: boolean;
  recordKind: string;
  recordId: string;
  /** The record's title as the table renders it; null when it is not known. */
  recordTitle: string | null;
  field: string;
  /** The field's label from the descriptor; null when it is not known yet. */
  fieldLabel: string | null;
  adjustments: UiRevealAdjustment[];
}

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
   * The narrowing this session's agent applied, as a comparison key.
   *
   * Not the filter itself — that lives in the address bar, because it decides
   * which records are on screen (`state/viewFilter.ts`). This is only the
   * answer to "did the agent do it?", which a URL cannot carry and should not:
   * the same address reached by a pasted link or by Back is the same view,
   * narrowed by nobody. Transient interface state, held in memory, which is
   * where provenance of this kind belongs.
   */
  agentFilterKey: string | null;
  /**
   * What the narrowing did, counted by the view that applied it.
   *
   * Set by the view, read by the banner and by the acknowledgement. This is the
   * only thing that distinguishes "narrowed to nothing" from "nothing applied
   * the narrowing", and the agent is told which of the two happened.
   */
  filterOutcome: { targetId: string; matched: number; total: number } | null;
  /**
   * State of each view on screen, keyed by target id — see `ViewStateReport`.
   *
   * Held here, not only in the address, because the address says what was
   * *asked for* and this says what the view *did* with it: the order actually
   * applied, the page after clamping, how many records that left.
   */
  viewStates: Record<string, ViewStateReport>;
  /** What the agent's last reveal changed and whether it pointed at anything (see `RevealNotice`). */
  revealNotice: RevealNotice | null;
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
  setAgentFilterKey: (key: string | null) => void;
  reportFilterOutcome: (outcome: { targetId: string; matched: number; total: number }) => void;
  /** Records a view's state; a report equal to the stored one changes nothing. */
  reportViewState: (report: ViewStateReport) => void;
  /** Withdraws a view's report, if it is still this instance's. */
  dropViewState: (targetId: string, instanceId: string) => void;
  setRevealNotice: (notice: RevealNotice | null) => void;
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
  agentFilterKey: null,
  filterOutcome: null,
  viewStates: {},
  revealNotice: null,
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
  // The count goes with it: a stale "3 of 4" under a full view would be a lie
  // of exactly the kind this feature exists to stop.
  setAgentFilterKey: (agentFilterKey) => set({ agentFilterKey, filterOutcome: null }),
  reportFilterOutcome: (filterOutcome) =>
    set((s) =>
      s.filterOutcome &&
      s.filterOutcome.targetId === filterOutcome.targetId &&
      s.filterOutcome.matched === filterOutcome.matched &&
      s.filterOutcome.total === filterOutcome.total
        ? s
        : { filterOutcome },
    ),
  reportViewState: (report) =>
    set((s) =>
      JSON.stringify(s.viewStates[report.targetId]) === JSON.stringify(report)
        ? s
        : { viewStates: { ...s.viewStates, [report.targetId]: report } },
    ),
  dropViewState: (targetId, instanceId) =>
    set((s) => {
      if (s.viewStates[targetId]?.instanceId !== instanceId) return s;
      const next = { ...s.viewStates };
      delete next[targetId];
      return { viewStates: next };
    }),
  setRevealNotice: (revealNotice) => set({ revealNotice }),
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
      /*
       * Read when the command is sent, from the views that are on screen at
       * that moment: the next turn starts from the narrowing, order and page
       * the user is looking at, not from whatever the agent last asked for.
       */
      filters: {
        ...s.filters,
        ...Object.fromEntries(Object.values(s.viewStates).map((r) => [r.targetId, viewStateContextOf(r)])),
      },
      viewport: s.viewport,
      drafts: Object.values(s.drafts).map((d) => ({
        formId: d.formId,
        entity: d.entity,
        entityId: d.entityId,
        dirtyFields: d.dirtyFields,
      })),
      // The screen's description version at this moment; the description itself is read with `ui_state`.
      ui: uiSnapshotSession.contextMarker(),
    };
  },
}));
