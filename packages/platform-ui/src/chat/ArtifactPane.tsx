import { useRegistry } from '../catalog/registry.tsx';
import { ArtifactContent, LiveBadge } from '../components/LiveArtifact.tsx';

/**
 * One artifact, wherever it is shown.
 *
 * The ready-made chat shows an artifact in two places — inline under the tool
 * call that produced it (`preview`) and as a page of its own in the artifact
 * browser (`actual`) — and the requirement is that the two never disagree. The
 * cheapest way to guarantee that is not to have two renderings: both call this,
 * with the same artifact id, and it reads the artifact through the one cache
 * entry `qk.artifact(id)`. A live artifact re-runs its query server-side on
 * that read, so "the same version" is the same definition version *and* the
 * same source state, not merely the same title.
 *
 * `where` only changes the label and the test hook. If it ever changed what is
 * rendered, the guarantee above would be gone.
 */
export function ArtifactPane({
  artifactId,
  where,
  onOpen,
}: {
  artifactId: string;
  where: 'preview' | 'full';
  onOpen?: () => void;
}) {
  const registry = useRegistry();

  return (
    <ArtifactContent artifactId={artifactId}>
      {(a) => {
        const Renderer = registry.artifactRenderers[a.type];
        return (
          <div
            className="pf-artifact"
            data-testid={where === 'full' ? 'artifact-full' : 'artifact-preview'}
            data-artifact-id={a.id}
            data-artifact-version={a.version}
            data-artifact-current-version={a.currentVersion}
            data-definition-version={a.live?.definitionVersion ?? a.version}
            data-source-fingerprint={a.live?.sourceFingerprint ?? ''}
          >
            <div className="pf-artifact__head">
              <strong>{a.title}</strong>
              <span className="pf-badge">
                wersja {a.version}/{a.currentVersion}
              </span>
              <LiveBadge live={a.live} />
              {onOpen && (
                <button type="button" className="pf-btn pf-btn--tiny" onClick={onOpen}>
                  Otworz
                </button>
              )}
            </div>
            {Renderer ? (
              <Renderer artifactId={a.id} content={a.content} meta={{ live: a.live }} />
            ) : (
              /*
                An artifact whose renderer the installed modules do not provide.
                Stated, and its content shown as data, rather than silently
                rendered as nothing — the artifact exists and is readable.
              */
              <pre className="pf-pre" data-testid="artifact-content">
                {JSON.stringify(a.content, null, 2).slice(0, 4000)}
              </pre>
            )}
          </div>
        );
      }}
    </ArtifactContent>
  );
}
