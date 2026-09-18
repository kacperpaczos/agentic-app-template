import type { ReactNode } from 'react';
import type { LiveResolution } from '@platform/contracts';
import { useArtifact } from '../api/queries.ts';
import { QueryErrorState } from './ErrorState.tsx';

/**
 * Presentation rules shared by every place an artifact is shown.
 *
 * The one rule that matters: a live artifact whose refresh did not succeed must
 * never be rendered as data. Showing the last good numbers under a live label,
 * or showing the stored descriptor because the query failed, would put a stale
 * or wrong figure in front of someone who has been told it is current — so a
 * failed resolution renders as a stated failure and nothing else.
 */

const LIVE_LABEL: Record<LiveResolution['state'], string> = {
  fresh: 'dane aktualne',
  failed: 'nie udalo sie odswiezyc',
  unavailable: 'zrodlo niedostepne w tej instalacji',
  forbidden: 'brak dostepu do zrodla',
};

/**
 * What is being shown, and how current it is — as three separate facts.
 *
 * A live artifact has a *definition* (the saved question, versioned like any
 * other artifact content), a *moment* it was answered, and a *source state* it
 * was answered from. They move independently: the same definition read twice
 * gives two moments, and the same moment says nothing about whether the data
 * behind it changed. Collapsing them into one "live" label is what made a view
 * that had not refreshed indistinguishable from one that had.
 *
 * All three are also attributes, so that two views of one artifact can be
 * compared by a test the way a reader compares them on screen.
 */
export function LiveBadge({ live }: { live: LiveResolution | null }) {
  if (!live) return <span className="pf-badge" data-testid="artifact-live-state" data-live-state="snapshot">snapshot</span>;
  const ok = live.state === 'fresh';
  return (
    <span
      className={`pf-badge ${ok ? 'pf-badge--ok' : 'pf-badge--warn'}`}
      data-testid="artifact-live-state"
      data-live-state={live.state}
      data-definition-version={live.definitionVersion}
      data-source-fingerprint={live.sourceFingerprint ?? ''}
      title={live.operation ? `zrodlo: ${live.operation}` : undefined}
    >
      live · {LIVE_LABEL[live.state]}
      {ok && live.resolvedAt ? ` (${new Date(live.resolvedAt).toLocaleTimeString('pl-PL')})` : ''}
      {' · def '}
      {live.definitionVersion}
      {live.sourceFingerprint ? ` · zrodlo ${live.sourceFingerprint.slice(0, 8)}` : ''}
    </span>
  );
}

export interface ArtifactPayload {
  id: string;
  title: string;
  type: string;
  mode: 'snapshot' | 'live';
  version: number;
  currentVersion: number;
  fileId: string | null;
  content: unknown;
  source?: unknown;
  live: LiveResolution | null;
}

/**
 * Loads one artifact and hands the caller a payload it can trust.
 *
 * `children` is only called when there is something real to render: for a
 * snapshot always, for a live artifact only when the query behind it actually
 * re-ran. Everything else — loading, transport error, failed refresh — is
 * rendered here, once, the same way everywhere.
 */
export function ArtifactContent({
  artifactId,
  children,
}: {
  artifactId: string;
  children: (payload: ArtifactPayload) => ReactNode;
}) {
  const { data, isLoading, error } = useArtifact(artifactId || null);

  if (!artifactId) return <div className="pf-state pf-state--empty">Brak identyfikatora artefaktu.</div>;
  if (isLoading) return <div className="pf-state">Wczytywanie artefaktu…</div>;
  if (error) return <QueryErrorState error={error} what="artefaktu" />;
  if (!data) return <div className="pf-state pf-state--empty">Artefakt nie istnieje.</div>;

  const payload = data as unknown as ArtifactPayload;
  const live = payload.live ?? null;

  if (payload.mode === 'live' && live && live.state !== 'fresh') {
    return (
      <div className="pf-artifact">
        <div className="pf-artifact__head">
          <strong>{payload.title}</strong>
          <LiveBadge live={live} />
        </div>
        <div className="pf-state pf-state--error" role="alert" data-testid="artifact-live-error">
          {live.error ?? LIVE_LABEL[live.state]}
          <div className="pf-muted">
            Pokazanie poprzedniego wyniku byloby wprowadzeniem w blad — ten artefakt ma zawsze
            przedstawiac stan biezacy.
          </div>
        </div>
      </div>
    );
  }

  return <>{children({ ...payload, live })}</>;
}
