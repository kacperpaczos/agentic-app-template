import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { accessFetch, requestFailureMessage } from '../api/client.ts';
import { useArtifacts, useFiles, qk } from '../api/queries.ts';

/**
 * Files and artifacts.
 *
 * Source files (uploads, seeded documents) and produced artifacts are listed
 * separately because they have different owners in the data model: an upload is
 * an input the user supplied, an artifact is a versioned result the platform
 * produced and keeps.
 */
export function FilesPage() {
  const qc = useQueryClient();
  const files = useFiles();
  const artifacts = useArtifacts();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setBusy(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      // Bound to the access context like every other request: an upload that
      // completes after an identity switch belongs to nobody on screen.
      const res = await accessFetch('/api/files', { method: 'POST', body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      await qc.invalidateQueries({ queryKey: qk.files() });
    } catch (e) {
      // `null` when the upload was abandoned because the identity changed —
      // see `requestFailureMessage`.
      const message = requestFailureMessage(e);
      if (message) setUploadError(message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="pf-page" data-testid="files-page">
      <h1>Pliki i raporty</h1>
      <p className="pf-page__lead">
        Pliki zrodlowe oraz artefakty wytworzone przez agenta. Artefakty maja trwaly identyfikator
        i wersje; tytul nie jest kluczem.
      </p>

      <h2>Pliki zrodlowe ({files.data?.files.length ?? 0})</h2>
      <div className="pf-field">
        <label htmlFor="file-upload">Wgraj plik (CSV, TXT, MD, JSON, PDF, PNG, JPEG; max 8 MB)</label>
        <input
          id="file-upload"
          ref={inputRef}
          type="file"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </div>
      {uploadError && (
        <div className="pf-state pf-state--error" role="alert">
          {uploadError}
        </div>
      )}

      {files.isLoading ? (
        <div className="pf-state">Wczytywanie…</div>
      ) : files.data?.files.length ? (
        <table className="pf-table">
          <thead>
            <tr>
              <th scope="col">Nazwa</th>
              <th scope="col">Typ</th>
              <th scope="col">Rozmiar</th>
              <th scope="col">Zakres</th>
              {/*
                Which command the file was sent with. The link is stored when
                the file is staged into a run, so it survives the run, a reload
                and a restart — before that, an attachment stopped being
                traceable the moment the request ended.
              */}
              <th scope="col">Dolaczony do</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {files.data.files.map((f) => (
              <tr key={f.id} data-testid={`file-row-${f.id}`}>
                <td>{f.filename}</td>
                <td className="pf-muted">{f.mediaType}</td>
                <td className="pf-num">{f.byteSize} B</td>
                <td className="pf-muted">{f.scopeKind ? `${f.scopeKind}:${f.scopeId?.slice(-6)}` : '—'}</td>
                <td className="pf-muted" data-testid={`file-attached-${f.id}`}>
                  {f.attachedTo?.length ? (
                    <ul className="pf-filelist__uses">
                      {f.attachedTo.map((use) => (
                        <li key={`${use.messageId}`} data-conversation={use.conversationId}>
                          <span className="pf-filelist__conv">{use.conversationTitle}</span>
                          {use.prompt && <span className="pf-filelist__prompt">: „{use.prompt}”</span>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <a className="pf-link" href={`/api/files/${f.id}/content`} download>
                    pobierz
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="pf-state pf-state--empty">Brak plikow.</div>
      )}

      <h2>Artefakty ({artifacts.data?.artifacts.length ?? 0})</h2>
      {artifacts.isLoading ? (
        <div className="pf-state">Wczytywanie…</div>
      ) : artifacts.data?.artifacts.length ? (
        <table className="pf-table">
          <thead>
            <tr>
              <th scope="col">Tytul</th>
              <th scope="col">Typ renderera</th>
              <th scope="col">Tryb</th>
              <th scope="col">Wersja</th>
              <th scope="col">Zmieniony</th>
            </tr>
          </thead>
          <tbody>
            {artifacts.data.artifacts.map((a) => (
              <tr key={a.id} data-testid={`artifact-${a.id}`}>
                <td>{a.title}</td>
                <td className="pf-muted"><code>{a.type}</code></td>
                <td>
                  <span className="pf-badge">{a.mode}</span>
                </td>
                <td className="pf-num">{a.currentVersion}</td>
                <td className="pf-muted">{new Date(a.updatedAt).toLocaleString('pl-PL')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="pf-state pf-state--empty">
          Brak artefaktow. Popros agenta o zapisanie zestawienia lub przetworzenie pliku.
        </div>
      )}
    </div>
  );
}
