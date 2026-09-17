import { useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { applyViewFilter, stableJson } from '@platform/contracts';
import type {
  ArtifactMeta,
  AuthStatus,
  CanvasCard,
  CanvasSpace,
  CanvasState,
  ReadOperationSummary,
  CardGeometry,
  CardSpec,
  StoredFile,
  UiTarget,
  ViewDefinition,
} from '@platform/contracts';
import { accessScope, setAccessContext } from './accessContext.ts';
import { apiDelete, apiGet, apiPatch, apiPost, ensureSession } from './client.ts';
import { useAppState } from '../state/appState.ts';
import { useActiveViewFilter } from '../state/viewFilter.ts';

/**
 * Query keys.
 *
 * Three things identify a cached row and all three are in the key: **who** is
 * asking (the access scope), **what** resource it is, and **which filters**
 * produced it. The access scope sits second rather than first so that the
 * coarse prefix invalidations the stream adapter performs — `['canvas']`,
 * `['artifact']`, `['module']` — keep working unchanged.
 *
 * An earlier version of this comment claimed the owner was already part of every
 * key. It was not; the keys were global and only `qc.clear()` stood between two
 * identities. That is now one of three defences, alongside per-context request
 * abortion and the epoch check in `api()`.
 */
export const qk = {
  status: () => ['status', accessScope()] as const,
  spaces: () => ['canvas', accessScope(), 'spaces'] as const,
  space: (id: string) => ['canvas', accessScope(), 'space', id] as const,
  conversation: (id: string) => ['conversation', accessScope(), id] as const,
  runs: (conversationId: string) => ['conversation', accessScope(), conversationId, 'runs'] as const,
  artifacts: (filter?: string) => ['artifacts', accessScope(), filter ?? 'all'] as const,
  artifact: (id: string) => ['artifact', accessScope(), id] as const,
  files: (scope?: string) => ['files', accessScope(), scope ?? 'all'] as const,
  module: (path: string) => ['module', accessScope(), path] as const,
  /**
   * One registered read with one input. The input is serialised with sorted
   * keys, so `{a, b}` and `{b, a}` share a cache entry instead of racing.
   */
  read: (operation: string, input: unknown) =>
    ['read', accessScope(), operation, stableJson(input ?? {})] as const,
  readOperations: () => ['read-operations', accessScope()] as const,
  /**
   * A conversation's agent views. Under `canvas`, so the end of a run refreshes
   * them with every other canvas read; a `canvas_changed` event during the run
   * invalidates {@link qk.agentViewsAll} explicitly (see `runEvents.ts`).
   */
  agentViews: (conversationId: string) => ['canvas', accessScope(), 'agent-views', conversationId] as const,
  agentViewsAll: () => ['canvas', accessScope(), 'agent-views'] as const,
  uiTargets: () => ['ui-targets', accessScope()] as const,
  uiViews: () => ['ui-views', accessScope()] as const,
};

/** JSON with object keys in sorted order, for use in cache keys (shared with the server). */
export { stableJson };

/**
 * Marks every cached business read stale: module routes and registered reads.
 *
 * One function because the two must always move together — a mutation that
 * refreshed a module screen but left a composed table on the same data showing
 * the old rows would be two versions of one record on one screen.
 */
export function invalidateBusinessData(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ['module'] });
  void qc.invalidateQueries({ queryKey: ['read'] });
}

export interface PlatformStatus {
  auth: AuthStatus;
  versions: Record<string, string>;
  model: string;
  chatCapabilities: Record<string, boolean>;
  modules: Array<{ id: string; title: string; version: string; description: string }>;
  tools: Array<{ name: string; module: string; effect: string; description: string }>;
  platformTools: string[];
  components: Array<{ id: string; description: string; usage: string }>;
  activeRuns: number;
}

export const useStatus = () =>
  useQuery({ queryKey: qk.status(), queryFn: () => apiGet<PlatformStatus>('/api/status') });

export const useCanvasState = (spaceId: string | null) =>
  useQuery({
    queryKey: spaceId ? qk.space(spaceId) : ['canvas', 'space', 'none'],
    queryFn: () => apiGet<CanvasState>(`/api/canvas/spaces/${spaceId}`),
    enabled: Boolean(spaceId),
  });

export const useSpaces = () =>
  useQuery({
    queryKey: qk.spaces(),
    queryFn: () => apiGet<{ spaces: CanvasState['space'][] }>('/api/canvas/spaces'),
  });

export const useArtifacts = (conversationId?: string) =>
  useQuery({
    queryKey: qk.artifacts(conversationId),
    queryFn: () =>
      apiGet<{ artifacts: Array<ArtifactMeta & { type: string }> }>(
        conversationId ? `/api/artifacts?conversationId=${conversationId}` : '/api/artifacts',
      ),
  });

export const useArtifact = (id: string | null) =>
  useQuery({
    queryKey: id ? qk.artifact(id) : ['artifact', 'none'],
    queryFn: () => apiGet<Record<string, unknown>>(`/api/artifacts/${id}`),
    enabled: Boolean(id),
  });

export const useFiles = (scope?: { kind: string; id: string }) =>
  useQuery({
    queryKey: qk.files(scope ? `${scope.kind}:${scope.id}` : undefined),
    queryFn: () =>
      apiGet<{ files: StoredFile[] }>(
        scope ? `/api/files?scopeKind=${scope.kind}&scopeId=${scope.id}` : '/api/files',
      ),
  });

/** Generic reader for a business module's own HTTP routes. */
/**
 * The interface targets the agent may be asked to open, as the browser sees
 * them.
 *
 * Shared because two things need the same list and must not disagree about it:
 * the command runner, which resolves a target the agent named, and the view
 * narrowing, which decides whether a search parameter is a filter for this
 * screen. It changes only when modules change, hence effectively static.
 */
export const useUiTargets = () =>
  useQuery({
    queryKey: qk.uiTargets(),
    queryFn: () => apiGet<{ targets: UiTarget[] }>('/api/ui/targets'),
    staleTime: 5 * 60_000,
    select: (d) => d.targets,
  });

/** Every registered read by name. Changes only when modules change. */
export const useReadOperations = () =>
  useQuery({
    queryKey: qk.readOperations(),
    queryFn: () => apiGet<{ operations: ReadOperationSummary[] }>('/api/read/operations'),
    staleTime: 5 * 60_000,
    select: (d) => d.operations,
  });

/** A conversation's agent views: its space, or none yet, and the cards in it. */
export const useAgentViews = (conversationId: string | null) =>
  useQuery({
    queryKey: conversationId ? qk.agentViews(conversationId) : ['canvas', 'agent-views', 'none'],
    queryFn: () =>
      apiGet<{ conversationId: string; space: CanvasSpace | null; cards: CanvasCard[] }>(
        `/api/conversations/${conversationId}/agent-views`,
      ),
    enabled: Boolean(conversationId),
  });

/** Module screens as compositions. Changes only when modules change. */
export const useViewDefinitions = () =>
  useQuery({
    queryKey: qk.uiViews(),
    queryFn: () => apiGet<{ views: ViewDefinition[] }>('/api/ui/views'),
    staleTime: 5 * 60_000,
    select: (d) => d.views,
  });

/**
 * A module view's data — narrowed, when the agent narrowed this view.
 *
 * **Why the narrowing lives here.** The requirement is that *every* view can be
 * narrowed and that every narrowed view says so. Doing it per screen would mean
 * every screen, present and future, remembering to implement it — and the one
 * that forgot would show a full list under a banner claiming it was filtered.
 * Every module view already reads its data through this hook, so this is the
 * one place where "narrowed" can be made true rather than promised.
 *
 * The platform stays domain-free doing it. The narrowing names a `collection` —
 * a key of the response — and property names on its rows, all declared by the
 * module that owns the view and carried here as opaque strings. Nothing in this
 * file knows what any of them mean; it matches text against text.
 *
 * Which narrowing is active comes from the address bar — see
 * `state/viewFilter.ts`, which resolves it against the view's own declaration,
 * so it applies to the screen it was made for and nowhere else.
 */
export const useModuleData = <T>(moduleId: string, path: string, enabled = true) => {
  const active = useActiveViewFilter();
  const reportFilterOutcome = useAppState((s) => s.reportFilterOutcome);

  const query = useQuery({
    queryKey: qk.module(`${moduleId}${path}`),
    queryFn: () => apiGet<T>(`/api/m/${moduleId}${path}`),
    enabled,
  });

  const { data, outcome } = useMemo(() => {
    if (!active || !query.data || typeof query.data !== 'object') {
      return { data: query.data, outcome: null };
    }
    const source = query.data as Record<string, unknown>;
    const rows = source[active.collection];
    if (!Array.isArray(rows)) {
      /*
       * The view declared a collection this response does not carry. Reported
       * as "nothing applied it" rather than quietly showing everything: the
       * banner would otherwise claim a narrowing that never happened.
       */
      return { data: query.data, outcome: null };
    }
    const { kept, outcome } = applyViewFilter(rows, active);
    return { data: { ...source, [active.collection]: kept } as T, outcome };
  }, [active, query.data]);

  /*
   * The count goes back into the store so the banner can show it and the
   * acknowledgement to the agent can be a fact rather than a prediction.
   */
  useEffect(() => {
    if (outcome) reportFilterOutcome(outcome);
  }, [outcome, reportFilterOutcome]);

  return { ...query, data } as typeof query;
};

/* ------------------------------- mutations -------------------------------- */

/**
 * Geometry writes are their own mutation with their own cache surgery: they must
 * never invalidate (and therefore never refetch-over) a card's content.
 */
export const useUpdateGeometry = (spaceId: string | null) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { cardId: string; geometry: Partial<CardGeometry> }) =>
      apiPatch<{ id: string; geometry: CardGeometry; geometryVersion: number }>(
        `/api/canvas/cards/${input.cardId}/geometry`,
        { geometry: input.geometry },
      ),
    onSuccess: (card) => {
      if (!spaceId) return;
      qc.setQueryData<CanvasState>(qk.space(spaceId), (prev) =>
        prev
          ? {
              ...prev,
              cards: prev.cards.map((c) =>
                c.id === card.id
                  ? { ...c, geometry: card.geometry, geometryVersion: card.geometryVersion }
                  : c,
              ),
            }
          : prev,
      );
    },
  });
};

export const useUpdateCardSpec = (spaceId: string | null) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { cardId: string; spec: CardSpec; expectedSpecVersion?: number; title?: string }) =>
      apiPatch(`/api/canvas/cards/${input.cardId}/spec`, {
        spec: input.spec,
        title: input.title,
        expectedSpecVersion: input.expectedSpecVersion,
      }),
    onSuccess: () => {
      if (spaceId) void qc.invalidateQueries({ queryKey: qk.space(spaceId) });
    },
  });
};

export const useAddCard = (spaceId: string | null) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; spec: CardSpec; geometry?: Partial<CardGeometry> }) =>
      apiPost('/api/canvas/cards', { spaceId, ...input }),
    onSuccess: () => {
      if (spaceId) void qc.invalidateQueries({ queryKey: qk.space(spaceId) });
    },
  });
};

export const useRemoveCard = (spaceId: string | null) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cardId: string) => apiDelete(`/api/canvas/cards/${cardId}`),
    onSuccess: () => {
      if (spaceId) void qc.invalidateQueries({ queryKey: qk.space(spaceId) });
    },
  });
};

export const useSaveViewport = (spaceId: string | null) =>
  useMutation({
    mutationFn: (viewport: { x: number; y: number; zoom: number }) =>
      apiPatch(`/api/canvas/spaces/${spaceId}/viewport`, viewport),
  });

/**
 * Switches the application to a different local identity.
 *
 * Signs in, then hands the change to `setAccessContext`, which aborts every
 * request issued for the previous identity and empties the cache before the new
 * one reads anything. Returns the identity now in effect.
 */
export async function switchAccessContext(qc: QueryClient, userId?: string): Promise<string> {
  const { userId: active } = await ensureSession(userId);
  setAccessContext(qc, active);
  return active;
}
