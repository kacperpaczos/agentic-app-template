import { createContext, useContext } from 'react';

/**
 * Places the chat panel offers to things that must not be laid out or clipped
 * by the ready-made chat.
 *
 * Two different problems, both found by measuring the running page:
 *
 *  - `notice` — `AgentInterface` renders any child it does not recognise as
 *    `slots.rest`, a sibling of the thread inside its own container. A notice
 *    rendered there becomes a column and takes a share of the panel's width;
 *  - `overlay` — the composer's `__input-wrapper` is `overflow: clip`, so a
 *    menu opened from inside it is cut off at the wrapper's edge. The first
 *    version of the attachment menu lost its upload button that way.
 *
 * Both are empty elements the panel renders itself, outside the library's
 * container, that components inside it portal to.
 */
export interface ChatSlots {
  /** Above the chat, in the panel's own column. */
  notice: HTMLElement | null;
  /** Outside every clipping box, for floating things positioned themselves. */
  overlay: HTMLElement | null;
}

export const ChatSlotsContext = createContext<ChatSlots>({ notice: null, overlay: null });

export const useChatSlots = (): ChatSlots => useContext(ChatSlotsContext);
