import { defineComponent } from '@openuidev/react-lang';
import type { MenuItemContribution, MenuSectionLabels } from '@platform/contracts';
import {
  AppLink,
  ComposedView,
  QueryErrorState,
  useModuleData,
  useScreenParams,
  type CardComponent,
  type CardComponentProps,
  type ModuleScreen,
  type UiModule,
} from '@platform/ui';
import {
  MODULE_ID,
  NOTES_PATH,
  NOTES_SCREEN_ID,
  NOTE_DETAIL_PATH,
  NOTE_LIST_CARD,
  type ProbeNote,
} from '../shared/index.ts';
import { PROBE_OPENUI_COMPONENTS } from '../shared/openui-components.ts';

/**
 * Minimal control module — browser half.
 *
 * The point of this file is that it exists at all. Until it did, the swap trial
 * (`pnpm check:module-swap`) could only show a second module's *server*
 * contracts working: it had to delete the example module's browser half to get
 * the copy to typecheck, so nothing proved that a second module can put a card
 * on the canvas, add a screen to the router or a component to the OpenUI
 * catalog. Everything here is therefore the smallest honest version of what a
 * real second module ships — and none of it is wired into platform internals:
 * it uses the same public contracts (`UiModule`, `CardComponent`,
 * `useModuleData`, `useScreenParams`, `ComposedView`) the example module uses.
 */

/* -------------------------------------------------------------------------- */
/*  Card renderer                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The renderer behind the `probe.noteList` card.
 *
 * Its props carry a `limit` and nothing else: the notes themselves come from
 * this module's own backend route, so a stored composition can never hold a
 * stale copy of their text.
 */
export function NoteListCard({ props }: CardComponentProps) {
  const limit = typeof props.limit === 'number' ? props.limit : 20;
  const { data, isLoading, error } = useModuleData<{ notes: ProbeNote[] }>(MODULE_ID, '/notes');

  if (isLoading) return <div className="pf-state">Wczytywanie notatek…</div>;
  if (error) return <QueryErrorState error={error} />;

  const notes = (data?.notes ?? []).slice(0, limit);
  if (notes.length === 0) {
    return (
      <div className="pf-state pf-state--empty" data-testid="probe-note-list">
        Brak notatek.
      </div>
    );
  }
  return (
    <ul className="pf-list" data-testid="probe-note-list">
      {notes.map((note) => (
        <li key={note.id} data-testid="probe-note">
          <AppLink to={NOTE_DETAIL_PATH} params={{ noteId: note.id }} className="pf-link">
            {note.text}
          </AppLink>
        </li>
      ))}
    </ul>
  );
}

const cardRenderers: Record<string, CardComponent> = { [NOTE_LIST_CARD]: NoteListCard };

/* -------------------------------------------------------------------------- */
/*  Screens                                                                    */
/* -------------------------------------------------------------------------- */

/** The module's list screen: the `probe.notes` view over the shared catalog. */
export function ProbeNotesPage() {
  return (
    <div className="pf-page" data-testid="probe-notes-page">
      <h1>Notatki testowe</h1>
      <ComposedView viewId={NOTES_SCREEN_ID} />
    </div>
  );
}

/**
 * One note, reached from the list.
 *
 * Here to keep a screen with a route parameter in the control module: a module
 * page must be able to read its own `$segment` without naming a route the
 * application registered, and the only way to know that stays true is to have a
 * second module doing it.
 */
export function ProbeNotePage() {
  const { noteId = '' } = useScreenParams();
  const { data, isLoading, error } = useModuleData<{ note: ProbeNote }>(
    MODULE_ID,
    `/notes/${noteId}`,
    Boolean(noteId),
  );

  if (isLoading) return <div className="pf-state">Wczytywanie notatki…</div>;
  if (error) return <QueryErrorState error={error} />;
  if (!data) return null;

  return (
    <div className="pf-page" data-testid="probe-note-page">
      <h1>Notatka</h1>
      <p data-testid="probe-note-text">{data.note.text}</p>
      <p>
        <AppLink to={NOTES_PATH} className="pf-btn">
          Wroc do listy
        </AppLink>
      </p>
    </div>
  );
}

const screens: ModuleScreen[] = [
  { id: NOTES_SCREEN_ID, path: NOTES_PATH, component: ProbeNotesPage },
  { id: `${MODULE_ID}.note.detail`, path: NOTE_DETAIL_PATH, component: ProbeNotePage },
];

const menu: MenuItemContribution[] = [
  { id: NOTES_SCREEN_ID, section: 'records', label: 'Notatki testowe', to: NOTES_PATH, order: 10 },
];

/**
 * The control module names its section too — that is what makes the contract
 * real rather than a field only the example module fills in. With this module
 * composed the heading reads "Notatki", not the example module's noun.
 */
const menuSections: MenuSectionLabels = { records: 'Notatki' };

/* -------------------------------------------------------------------------- */
/*  OpenUI catalog                                                            */
/* -------------------------------------------------------------------------- */

const { ProbeNoteList } = PROBE_OPENUI_COMPONENTS;
const openuiComponents = [
  defineComponent({
    name: ProbeNoteList.name,
    description: ProbeNoteList.description,
    props: ProbeNoteList.propsSchema,
    component: ({ props }) => (
      <NoteListCard cardId="openui-probe-notes" props={{ limit: props.limit }} />
    ),
  }),
];

/** Browser half of the control module. */
export const probeUiModule: UiModule = {
  meta: {
    id: MODULE_ID,
    title: 'Modul testowy',
    version: '0.1.0',
    description: 'Karta, ekrany i komponent OpenUI modulu kontrolnego.',
  },
  cardRenderers,
  openuiComponents,
  menu,
  menuSections,
  screens,
};
