/**
 * What both halves of the control module know about each other.
 *
 * React-free on purpose: the server half imports it under Node, the browser
 * half in the bundle, so the module id, the table prefix and the shape of a
 * note are written once and cannot drift between them.
 */

export const MODULE_ID = 'probe';

/** One row of `probe_notes`, as the module's route and read operation return it. */
export interface ProbeNote {
  id: string;
  text: string;
  createdAt: string;
}

/** Card component id used in `CardSpec.component`, and its renderer key. */
export const NOTE_LIST_CARD = `${MODULE_ID}.noteList`;

/** Id shared by this module's screen, its `UiTarget` and its `ViewDefinition`. */
export const NOTES_SCREEN_ID = `${MODULE_ID}.notes`;

/** Route of the notes screen, relative to the app root. */
export const NOTES_PATH = '/probe-notes';
export const NOTE_DETAIL_PATH = '/probe-notes/$noteId';
