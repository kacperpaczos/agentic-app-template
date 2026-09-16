import { MarkDownRenderer } from '@openuidev/react-ui';
import { useFiles } from '../api/queries.ts';
import type { CardComponent, CardComponentProps } from '../catalog/registry.tsx';
import { ArtifactContent, LiveBadge } from './LiveArtifact.tsx';

/** Domain-agnostic card renderers. Mirror of `platformCardComponents()` on the server. */

const MarkdownCard: CardComponent = ({ props }: CardComponentProps) => (
  <div className="pf-prose">
    <MarkDownRenderer textMarkdown={String(props.markdown ?? '')} />
  </div>
);

const ArtifactCard: CardComponent = ({ props }: CardComponentProps) => {
  const id = String(props.artifactId ?? '');
  return (
    <ArtifactContent artifactId={id}>
      {(a) => {
        const content = a.content as Record<string, unknown> | null;
        const fileId = a.fileId ?? (content?.fileId as string | undefined);
        return (
          <div className="pf-artifact">
            <div className="pf-artifact__head">
              <strong>{a.title}</strong>
              <span className="pf-badge">
                wersja {a.version}/{a.currentVersion}
              </span>
              <LiveBadge live={a.live} />
            </div>
            {fileId ? (
              <p>
                <a className="pf-link" href={`/api/files/${fileId}/content`} download>
                  Pobierz {String(content?.filename ?? 'plik')}
                </a>
                {content?.byteSize ? (
                  <span className="pf-muted"> ({String(content.byteSize)} B)</span>
                ) : null}
              </p>
            ) : null}
            <pre className="pf-pre" data-testid="artifact-content">
              {JSON.stringify(a.content, null, 2).slice(0, 4000)}
            </pre>
          </div>
        );
      }}
    </ArtifactContent>
  );
};

const FilesCard: CardComponent = ({ props }: CardComponentProps) => {
  const scopeKind = String(props.scopeKind ?? '');
  const scopeId = String(props.scopeId ?? '');
  const { data, isLoading, error } = useFiles(
    scopeKind && scopeId ? { kind: scopeKind, id: scopeId } : undefined,
  );

  if (isLoading) return <div className="pf-state">Wczytywanie plikow…</div>;
  if (error) {
    return (
      <div className="pf-state pf-state--error" role="alert">
        {(error as Error).message}
      </div>
    );
  }
  if (!data?.files.length) return <div className="pf-state pf-state--empty">Brak plikow w tym zakresie.</div>;

  return (
    <table className="pf-table">
      <thead>
        <tr>
          <th scope="col">Plik</th>
          <th scope="col">Typ</th>
          <th scope="col">Rozmiar</th>
          <th scope="col" />
        </tr>
      </thead>
      <tbody>
        {data.files.map((f) => (
          <tr key={f.id}>
            <td>{f.filename}</td>
            <td className="pf-muted">{f.mediaType}</td>
            <td className="pf-num">{f.byteSize} B</td>
            <td>
              <a className="pf-link" href={`/api/files/${f.id}/content`} download>
                pobierz
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export const platformCardRenderers: Record<string, CardComponent> = {
  'platform.markdown': MarkdownCard,
  'platform.artifact': ArtifactCard,
  'platform.files': FilesCard,
};

/** Renderer for files published out of the sandbox. */
export const platformArtifactRenderers = {
  'platform.file': ({ content }: { content: unknown }) => {
    const c = (content ?? {}) as Record<string, unknown>;
    return (
      <div className="pf-artifact">
        <p>
          <a className="pf-link" href={`/api/files/${String(c.fileId)}/content`} download>
            Pobierz {String(c.filename ?? 'plik')}
          </a>
        </p>
        <p className="pf-muted">
          {String(c.mediaType ?? '')} · {String(c.byteSize ?? 0)} B · sha256 {String(c.sha256 ?? '').slice(0, 16)}…
        </p>
      </div>
    );
  },
};
