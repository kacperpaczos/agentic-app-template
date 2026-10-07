import { useEffect, useState } from 'react';

/**
 * Keeps a host element of ours inside an element the ready-made composer owns.
 *
 * **Why a portal rather than a child.** `AgentInterface` renders whatever
 * children it does not recognise as `slots.rest` — the last child of its own
 * container, beside the thread. The first version of the attachments control
 * was an ordinary `<div>` handed to `AgentInterface`, and it became a panel of
 * its own: measured in the browser, `div.pf-attach` was 393px wide next to a
 * thread squeezed to 166px. Nothing of ours may be an element child of
 * `AgentInterface`, so a control that belongs *inside* the composer's own
 * markup gets a host element placed there and portals its content into it.
 *
 * The composer unmounts — switching to the artifacts tab removes it entirely —
 * so the node found on first render cannot be assumed to live for ever. A
 * `MutationObserver` puts the host back when the composer returns, carrying its
 * portal content with it.
 *
 * Safe against React because both hosts used so far are static, single-purpose
 * containers: `__action-bar` holds the composer's submit button and the
 * controls prepended to it, `__input-wrapper` a textarea and that content, with
 * no lists and no reordering, so React never positions a child relative to ours.
 *
 * Shared by every control that lives in the composer's own action bar
 * (`ComposerAttachments`, `ConsentModeSelect`); the hook is one behaviour, so it
 * lives in one place rather than in as many copies as there are controls.
 */
export function useComposerHost(selector: string, className: string): HTMLElement | null {
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
