import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FILE_ANALYSIS, FILE_LIMITS, type StoredFile } from '@platform/contracts';
import { qk, useFiles } from '../api/queries.ts';
import { useAppState } from '../state/appState.ts';
import { useChatSlots } from './chatSlots.ts';

/**
 * Attaching a file, from inside the ready-made composer.
 *
 * **Why a portal rather than a child.** `AgentInterface` renders whatever
 * children it does not recognise as `slots.rest` — the last child of its own
 * container, beside the thread. The first version of this control was an
 * ordinary `<div>` handed to `AgentInterface`, and it became a panel of its own:
 * measured in the browser, `div.pf-attach` was 393px wide next to a thread
 * squeezed to 166px. That is the layout the user reported as broken. Nothing of
 * ours may be an element child of `AgentInterface`.
 *
 * So this component renders nothing where React mounts it and portals two small
 * pieces into the composer's own markup:
 *
 *  - a paperclip button into `__action-bar`, which is `display:flex` with the
 *    submit button on `margin-left:auto` — prepending puts the clip on the left
 *    and leaves send on the right, with no positioning of ours;
 *  - a row of file chips into `__input-wrapper`, which is a flex column with the
 *    textarea in it — prepending puts attachments above the text being typed.
 *
 * Both hosts are stable, single-purpose containers in the library's markup. The
 * composer keeps its own behaviour, its own styling and its own submit path; it
 * gains two elements in places it already reserves for controls and content.
 *
 * **Why the permanent hint text is gone.** "PNG, JPEG, XLSX, CSV, tekst; max
 * 8 MB" as body text is the same sentence on every screen for an action taken
 * rarely, and in a 560px panel it cost a line that the conversation needed. It
 * now lives on the button (`title`, `aria-description`) and in the menu, read at
 * the moment it matters. The accepted types and the limit still come from the
 * contract, so the control cannot drift from what the backend takes.
 */

const EXT_BY_MEDIA: Record<string, string> = {
  'text/csv': '.csv',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg,.jpeg',
  [FILE_ANALYSIS.spreadsheet.mediaType]: '.xlsx',
};

const ACCEPT = FILE_LIMITS.allowedMediaTypes
  .flatMap((m) => [m, EXT_BY_MEDIA[m]])
  .filter(Boolean)
  .join(',');

const HINT = `Obraz, XLSX, CSV lub tekst. Do ${Math.round(FILE_LIMITS.maxBytes / (1024 * 1024))} MB.`;

/** What the platform can actually do with this kind of file. */
function analysisNote(mediaType: string): string | null {
  if (mediaType === FILE_ANALYSIS.spreadsheet.mediaType) {
    return 'arkusze i typy komorek; formuly bez przeliczania';
  }
  if ((FILE_ANALYSIS.image.mediaTypes as readonly string[]).includes(mediaType)) {
    return 'tresc obrazu czytana przez model';
  }
  return null;
}

/**
 * Keeps a host element of ours inside an element the library owns.
 *
 * The composer unmounts — switching to the artifacts tab removes it entirely —
 * so the node found on first render cannot be assumed to live for ever. A
 * `MutationObserver` puts the host back when the composer returns, carrying its
 * portal content with it.
 *
 * Safe against React because both hosts are static containers: `__action-bar`
 * holds one submit button and `__input-wrapper` a textarea and that bar, with no
 * lists and no reordering, so React never positions a child relative to ours.
 */
function useComposerHost(selector: string, className: string): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const node = document.createElement('div');
    node.className = className;

    const place = () => {
      const parent = document.querySelector(selector);
      if (!parent || node.parentElement === parent) return;
      parent.prepend(node);
      setHost(node);
    };

    place();
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      node.remove();
    };
  }, [selector, className]);

  return host;
}

export function ComposerAttachments() {
  const qc = useQueryClient();
  const files = useFiles();
  const attachments = useAppState((s) => s.attachments);
  const setAttachments = useAppState((s) => s.setAttachments);

  const { overlay } = useChatSlots();
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  /* Where the menu opens from, measured when it opens. See `menu` below. */
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const actionHost = useComposerHost('.openui-agent-thread-composer__action-bar', 'pf-attach-host');
  const chipsHost = useComposerHost('.openui-agent-thread-composer__input-wrapper', 'pf-attach-chips-host');

  const byId = new Map((files.data?.files ?? []).map((f) => [f.id, f] as const));
  const attached = attachments.map((id) => byId.get(id)).filter((f): f is StoredFile => Boolean(f));
  const available = (files.data?.files ?? []).filter((f) => !attachments.includes(f.id));

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/files', { method: 'POST', body: form, credentials: 'include' });
      if (!res.ok) {
        // The backend's message names the real reason — an unsupported type
        // lists what is accepted, an oversized file states the limit. Our own
        // wording here would hide that.
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `HTTP ${res.status}`);
      }
      const stored = (await res.json()) as StoredFile;
      await qc.invalidateQueries({ queryKey: qk.files() });
      setAttachments([...attachments, stored.id]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const openMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    setAnchor(buttonRef.current?.getBoundingClientRect() ?? null);
    setMenuOpen(true);
  };

  /* A menu closes on an outside click, on Escape, and when its anchor moves. */
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest?.('.pf-attach__menu, .pf-attach__button')) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onResize = () => setMenuOpen(false);
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [menuOpen]);

  const control = (
    <div className="pf-attach" data-testid="chat-attachments">
      <button
        ref={buttonRef}
        type="button"
        className="pf-attach__button"
        aria-label="Dolacz plik"
        aria-description={HINT}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={`Dolacz plik — ${HINT}`}
        disabled={busy}
        data-testid="chat-attach-open"
        onClick={openMenu}
      >
        {/* Inline, so the composer gains no icon dependency of ours. */}
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false">
          <path
            d="M21 11.5 12.5 20a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/*
        Visually hidden, not `display:none` — a file input must stay focusable
        for the keyboard path and settable by the browser test that drives it.
      */}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="pf-attach__input"
        data-testid="chat-attach-input"
        aria-label="Plik do dolaczenia"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
    </div>
  );

  /*
   * Portalled to the panel's overlay slot, not rendered inside the control:
   * `__input-wrapper` is `overflow: clip`, and the first version of this menu
   * was silently cut off at the composer's edge — the upload button was simply
   * not on screen, only the file list under it. Fixed coordinates, taken from
   * the button when the menu opened, put it directly above the clip.
   */
  const menu =
    menuOpen && anchor ? (
      <div
        className="pf-attach__menu"
        role="menu"
        data-testid="chat-attach-menu"
        style={{ left: anchor.left, bottom: window.innerHeight - anchor.top + 8 }}
      >
        <button
          type="button"
          role="menuitem"
          className="pf-attach__menu-item"
          data-testid="chat-attach-upload"
          onClick={() => {
            setMenuOpen(false);
            inputRef.current?.click();
          }}
        >
          Wgraj z dysku
        </button>
        <p className="pf-attach__menu-hint">{HINT}</p>

        <div className="pf-attach__menu-label">Wgrane wczesniej</div>
        {available.length === 0 ? (
          <p className="pf-attach__menu-hint">Brak innych wgranych plikow.</p>
        ) : (
          <ul className="pf-attach__picker" data-testid="chat-attach-picker">
            {available.slice(0, 8).map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  role="menuitem"
                  className="pf-attach__menu-item"
                  data-testid={`chat-attach-pick-${f.id}`}
                  onClick={() => {
                    setAttachments([...attachments, f.id]);
                    setMenuOpen(false);
                  }}
                >
                  {f.filename}
                  {f.version > 1 && <span className="pf-muted"> · wersja {f.version}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    ) : null;

  const chips = (
    <>
      {error && (
        <p className="pf-attach__error" role="alert" data-testid="chat-attach-error">
          <span>{error}</span>
          <button type="button" aria-label="Zamknij blad" onClick={() => setError(null)}>
            ×
          </button>
        </p>
      )}
      {(attached.length > 0 || busy) && (
        <ul className="pf-attach__list" data-testid="chat-attachment-list">
          {busy && <li className="pf-attach__chip pf-attach__chip--busy">Wgrywanie…</li>}
          {attached.map((f) => {
            const note = analysisNote(f.mediaType);
            return (
              <li
                key={f.id}
                className="pf-attach__chip"
                data-file-id={f.id}
                title={note ?? undefined}
              >
                <span className="pf-attach__name">{f.filename}</span>
                <button
                  type="button"
                  aria-label={`Odlacz ${f.filename}`}
                  data-testid={`chat-attach-remove-${f.id}`}
                  onClick={() => setAttachments(attachments.filter((id) => id !== f.id))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  return (
    <>
      {actionHost && createPortal(control, actionHost)}
      {chipsHost && createPortal(chips, chipsHost)}
      {overlay && menu && createPortal(menu, overlay)}
    </>
  );
}
