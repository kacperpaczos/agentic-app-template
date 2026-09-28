import { AppError } from '@platform/contracts';

/**
 * Which way to synchronise the address bar and the ready-made chat's thread
 * selection.
 *
 * Kept pure and separate from the component that applies it, because the hard
 * part is not the effect — it is deciding *which side moved*. Both the URL and
 * the chat can change on their own:
 *
 *  - the URL moves on a reload, on Back/Forward, and on a shared link;
 *  - the chat moves when the user picks a conversation from the drawer, presses
 *    "new chat", or when the backend assigns an id to a conversation that did
 *    not have one yet — which happens *during* the first run of that
 *    conversation.
 *
 * A one-directional rule gets this wrong in a way that looks like a glitch: if
 * the URL always wins, clicking a conversation snaps straight back to the
 * previous one; if the chat always wins, Back and Forward stop working. So the
 * decision is made against `lastSynced` — the value the two sides last agreed
 * on — and whichever differs from it is the side that moved.
 *
 * **What this deliberately does not do** is check whether the conversation
 * exists. An earlier version decided that from the chat's loaded thread list,
 * and was wrong twice over: the list is empty for a moment after a reload (so a
 * perfectly good conversation was declared missing, and the recovery path then
 * cleared it from the URL), and the list is paged (so a conversation further
 * back would be declared missing forever). `selectThread` in the library does
 * not require the thread to be in the list either — it fetches the messages and
 * reports `threadError` if that fails. Existence is therefore the server's
 * answer, classified by {@link classifyThreadFailure}, and not a guess from
 * whatever the client happens to have cached.
 */

export type RestoreAction =
  /** Both sides agree. */
  | { action: 'idle' }
  /** The URL names a conversation the chat is not showing. Follow the URL. */
  | { action: 'select'; threadId: string }
  /** The URL names no conversation. Show the new-conversation state. */
  | { action: 'new' }
  /**
   * The chat moved. Write it to the URL — pushing a history entry for a real
   * switch, replacing for an id the backend has just assigned to the
   * conversation the user is already in (that is not a navigation).
   */
  | { action: 'publish'; threadId: string | null; replace: boolean };

export interface RestoreInput {
  /** Conversation id in the address bar, or null when absent. */
  urlThreadId: string | null;
  /** Conversation the ready-made chat currently has selected. */
  selectedThreadId: string | null;
  /** Value both sides last agreed on; null before the first synchronisation. */
  lastSynced: string | null;
}

export function decideRestore(input: RestoreInput): RestoreAction {
  const { urlThreadId, selectedThreadId, lastSynced } = input;

  /*
   * The URL is authoritative when it has moved. That covers the first render
   * after a reload, where `lastSynced` is null and the URL carries the
   * conversation the user was reading.
   */
  if (urlThreadId !== lastSynced) {
    if (urlThreadId === null) {
      /*
       * The parameter was there and is gone: Back onto an entry that predates
       * the conversation, or the notice being dismissed. Reachable only after a
       * previous synchronisation — on the very first render an absent parameter
       * equals `lastSynced`, so this branch cannot be the default state being
       * mistaken for an instruction.
       */
      return { action: 'new' };
    }
    return selectedThreadId === urlThreadId
      ? { action: 'idle' }
      : { action: 'select', threadId: urlThreadId };
  }

  if (selectedThreadId !== lastSynced) {
    return {
      action: 'publish',
      threadId: selectedThreadId,
      // null → id is the backend naming the conversation already on screen;
      // anything else is the user moving between conversations.
      replace: lastSynced === null && selectedThreadId !== null,
    };
  }

  return { action: 'idle' };
}

/**
 * Why a conversation could not be opened, from the server's own answer.
 *
 * `gone` and `failed` need different words on screen and different recovery: a
 * deleted conversation will never load and the user should start a new one, a
 * failed request should be retried. Collapsing them into one "unavailable"
 * state tells the user to give up on work that is still there.
 */
export type ThreadFailure = 'gone' | 'failed';

export function classifyThreadFailure(error: unknown): ThreadFailure {
  if (error instanceof AppError && (error.code === 'not_found' || error.code === 'forbidden')) {
    return 'gone';
  }
  return 'failed';
}
