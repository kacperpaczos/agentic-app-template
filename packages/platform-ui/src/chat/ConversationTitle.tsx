import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useThreadList } from '@openuidev/react-headless';
import { useChatSlots } from './chatSlots.ts';

/**
 * The conversation's title, and the one control that lets a user change it.
 *
 * **Why this exists.** The platform has always been able to rename a
 * conversation — `PATCH /api/threads/update/:id`, `ConversationService.rename`,
 * and the chat's own `updateThread` action go straight to it — and Settings
 * declared `renameConversation` as available. Nothing on screen did it. The
 * ready-made `ThreadList` row menu of `@openuidev/react-ui` 0.13.10 has exactly
 * one item, Delete, and the component exposes no prop, slot or label for a
 * second one, so the capability existed for an API client and for nobody else.
 * A declaration of a feature the interface does not offer is worse than no
 * feature: it is the screen saying something untrue about itself (L4.8).
 *
 * **What it does not do.** It writes no title of its own. The title is still
 * derived from the first message by the backend (`deriveTitle`, plain string
 * work, no model call), and this only edits it. `updateThread` is the library's
 * own action, so the thread list, the selection and the cache stay the
 * library's; nothing here reimplements storage.
 *
 * **Where it is rendered.** Inside `AgentInterface`, because `useThreadList`
 * exists only in its provider — and portalled out to the panel's own strip,
 * because anything rendered here that the component does not recognise becomes
 * `slots.rest`, a column beside the thread. Same arrangement, and the same
 * reason, as `ConversationSync`'s notice.
 */
export function ConversationTitle() {
  const { title: titleHost } = useChatSlots();
  const threads = useThreadList((s) => s.threads);
  const selectedThreadId = useThreadList((s) => s.selectedThreadId);
  const updateThread = useThreadList((s) => s.updateThread);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement | null>(null);

  const thread = threads.find((t) => t.id === selectedThreadId) ?? null;

  /*
   * Editing belongs to one conversation. Moving to another while the field is
   * open would otherwise carry the half-typed name across and rename the
   * conversation the user just arrived at.
   */
  useEffect(() => {
    setEditing(false);
  }, [selectedThreadId]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  if (!thread) return null;

  const save = () => {
    const next = draft.trim();
    setEditing(false);
    // An unchanged or empty name is not a rename. Sending it would replace the
    // derived title with itself, or with nothing.
    if (!next || next === thread.title) return;
    updateThread({ ...thread, title: next });
  };

  const strip = (
    <div className="pf-conv-title" data-testid="conversation-title-bar">
      {editing ? (
        <form
          className="pf-conv-title__form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="pf-conv-title__label" htmlFor="pf-conv-title-input">
            Tytul rozmowy
          </label>
          <input
            id="pf-conv-title-input"
            ref={input}
            className="pf-input pf-conv-title__input"
            data-testid="conversation-title-input"
            value={draft}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <button type="submit" className="pf-btn pf-btn--tiny" data-testid="conversation-title-save">
            Zapisz
          </button>
          <button
            type="button"
            className="pf-btn pf-btn--tiny"
            data-testid="conversation-title-cancel"
            onClick={() => setEditing(false)}
          >
            Anuluj
          </button>
        </form>
      ) : (
        <>
          <span className="pf-conv-title__value" data-testid="conversation-title">
            {thread.title}
          </span>
          <button
            type="button"
            className="pf-btn pf-btn--tiny"
            data-testid="conversation-rename"
            onClick={() => {
              setDraft(thread.title);
              setEditing(true);
            }}
          >
            Zmien tytul
          </button>
        </>
      )}
    </div>
  );

  /*
   * Without a host — the panel not yet measured, or this component used outside
   * `ChatPanel` — nothing is rendered rather than something rendered in the
   * wrong place. Same rule as the conversation notice.
   */
  return titleHost ? createPortal(strip, titleHost) : null;
}
