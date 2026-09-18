import { z } from 'zod';
import type { ReadResultDescriptor, ServerModule, ViewDefinition } from '@platform/contracts';
import type { PlatformServices } from '@platform/server';
import { newId, nowIso } from '@platform/server';
import {
  MODULE_ID,
  NOTES_PATH,
  NOTES_SCREEN_ID,
  NOTE_LIST_CARD,
  type ProbeNote,
} from '../shared/index.ts';
import { PROBE_OPENUI_COMPONENTS } from '../shared/openui-components.ts';

/**
 * Minimal control module — server half.
 *
 * Its only purpose is to prove that the platform's extension contract is real:
 * a module with its own table, its own tool, its own route, its own read
 * operation, its own canvas component, its own screen and its own OpenUI
 * component can be installed without the platform knowing anything about it,
 * and without the example module being present at all.
 *
 * It is deliberately trivial — the exercise is the contract, not a second app.
 * But it now covers *every* contract the criterion names, because a contract
 * only the example module exercises is a contract nobody has tested: the
 * example was written alongside the platform, so it can satisfy an assumption
 * the platform never wrote down. The browser half is in `../ui/index.tsx`.
 */

/** Read result of `probe.notes`, and of `GET /api/m/probe/notes`. */
const noteRecords: ReadResultDescriptor = {
  collection: 'notes',
  record: { kind: 'note', idField: 'id', titleField: 'text', route: '/probe-notes/{id}' },
  fields: [
    { field: 'text', label: 'Tresc', type: 'text', sortable: true },
    { field: 'createdAt', label: 'Utworzono', type: 'date', sortable: true },
  ],
};

const views: ViewDefinition[] = [
  {
    id: NOTES_SCREEN_ID,
    title: 'Notatki testowe',
    primaryOperation: `${MODULE_ID}.notes`,
    composition: [
      'root = Stack([summary, table])',
      'summary = ProbeNoteList(5)',
      `table = DataTable({operation: "${MODULE_ID}.notes"}, ["text", "createdAt"], null, 20)`,
    ].join('\n'),
  },
];

export function createProbeModule(platform: PlatformServices): ServerModule {
  const db = platform.db.$client;

  /**
   * The one implementation of "add a note".
   *
   * The MCP tool and the HTTP route both call this, so there is no second path
   * into the table that could validate differently — the same arrangement the
   * example module uses for its own operations.
   */
  const addNote = (ownerId: string, text: string): { id: string } => {
    const id = newId('nte');
    db.prepare('INSERT INTO probe_notes (id, owner_id, text, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      ownerId,
      text,
      nowIso(),
    );
    return { id };
  };

  const listNotes = (ownerId: string): ProbeNote[] =>
    db
      .prepare('SELECT id, text, created_at AS createdAt FROM probe_notes WHERE owner_id = ? ORDER BY created_at DESC, id DESC')
      .all(ownerId) as ProbeNote[];

  const getNote = (ownerId: string, id: string): ProbeNote | null =>
    (db
      .prepare('SELECT id, text, created_at AS createdAt FROM probe_notes WHERE owner_id = ? AND id = ?')
      .get(ownerId, id) as ProbeNote | undefined) ?? null;

  return {
    meta: {
      id: MODULE_ID,
      title: 'Modul testowy',
      version: '0.1.0',
      description: 'Minimalne rozszerzenie sprawdzajace kontrakt rejestracji modulu.',
    },

    migrations: [
      {
        id: 'probe-0001-init',
        sql: `CREATE TABLE IF NOT EXISTS probe_notes (
                id         TEXT PRIMARY KEY,
                owner_id   TEXT NOT NULL,
                text       TEXT NOT NULL,
                created_at TEXT NOT NULL
              );`,
      },
    ],

    cardComponents: [
      {
        id: NOTE_LIST_CARD,
        description: 'Lista notatek modulu testowego.',
        usage: 'props: { limit?: number }',
        propsSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      },
    ],

    /**
     * The OpenUI component the browser half adds to the shared catalog. Without
     * this declaration the view below would be refused at startup as naming an
     * unknown component.
     */
    openuiComponents: Object.values(PROBE_OPENUI_COMPONENTS),

    views,

    uiTargets: [
      {
        id: NOTES_SCREEN_ID,
        kind: 'view',
        label: 'Notatki testowe',
        description: 'Lista notatek modulu testowego; mozna zawezic przez ui_filter.',
        to: NOTES_PATH,
        filter: {
          collection: 'notes',
          fields: [{ field: 'text', label: 'Tresc notatki' }],
        },
      },
    ],

    readOperations: [
      {
        name: 'notes',
        description: 'Notatki wlasciciela: tresc i data utworzenia.',
        inputSchema: z.object({}),
        run: async (_input: Record<string, never>, ctx) => ({ notes: listNotes(ctx.ownerId) }),
        result: noteRecords,
      },
    ] as ServerModule['readOperations'],

    agentBriefing: 'Modul testowy udostepnia proste notatki tekstowe.',

    tools: [
      {
        name: 'add_note',
        description: 'Dodaje notatke testowa.',
        effect: 'write',
        inputSchema: z.object({ text: z.string().min(1).max(500) }),
        handler: async (input, ctx) => {
          const created = addNote(ctx.ownerId, (input as { text: string }).text);
          ctx.emit({ type: 'data_changed', resources: ['probe:notes'] });
          return created;
        },
      },
      {
        name: 'list_notes',
        description: 'Wypisuje notatki testowe.',
        effect: 'read',
        inputSchema: z.object({}),
        handler: async (_input, ctx) => ({ notes: listNotes(ctx.ownerId) }),
      },
    ] as ServerModule['tools'],

    routes: (register) => {
      register.get('/notes', async (req) => ({ body: { notes: listNotes(req.ownerId) } }));
      register.post('/notes', async (req) => {
        const parsed = z.object({ text: z.string().min(1).max(500) }).parse(req.body);
        return { status: 201, body: addNote(req.ownerId, parsed.text) };
      });
      register.get('/notes/:noteId', async (req) => {
        const note = getNote(req.ownerId, req.params.noteId ?? '');
        return note ? { body: { note } } : { status: 404, body: { error: { code: 'not_found' } } };
      });
    },

    defaultComposition: (scope) =>
      scope.kind === MODULE_ID
        ? [
            {
              title: 'Notatki testowe',
              spec: { kind: 'component', component: NOTE_LIST_CARD, props: { limit: 20 } },
              geometry: { x: 0, y: 0, width: 420, height: 280 },
            },
          ]
        : [],
  };
}
