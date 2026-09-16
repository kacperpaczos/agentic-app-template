import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  ArtifactMeta,
  AuthStatus,
  CanvasState,
  CardGeometry,
  CardSpec,
  StoredFile,
} from '@platform/contracts';
import { accessScope, setAccessContext } from './accessContext.ts';
import { apiDelete, apiGet, apiPatch, apiPost, ensureSession } from './client.ts';

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
};

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
export const useModuleData = <T>(moduleId: string, path: string, enabled = true) =>
  useQuery({
    queryKey: qk.module(`${moduleId}${path}`),
    queryFn: () => apiGet<T>(`/api/m/${moduleId}${path}`),
    enabled,
  });

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
