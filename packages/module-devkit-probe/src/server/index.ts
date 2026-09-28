import { z } from 'zod';
import type { ServerModule } from '@platform/contracts';
import type { PlatformServices } from '@platform/server';
import { newId, nowIso } from '@platform/server';

/**
 * Minimal test module.
 *
 * Its only purpose is to prove that the platform's extension contract is real:
 * a module with its own table, its own tool, its own route and its own canvas
 * component can be installed without the platform knowing anything about it,
 * and without the procurement module being present at all.
 *
 * It is deliberately trivial — the exercise is the contract, not a second app.
 */
export function createProbeModule(platform: PlatformServices): ServerModule {
  const db = platform.db.$client;

  return {
    meta: {
      id: 'probe',
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
        id: 'probe.noteList',
        description: 'Lista notatek modulu testowego.',
        usage: 'props: { limit?: number }',
        propsSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
      },
    ],

    agentBriefing: 'Modul testowy udostepnia proste notatki tekstowe.',

    tools: [
      {
        name: 'add_note',
        description: 'Dodaje notatke testowa.',
        effect: 'write',
        inputSchema: z.object({ text: z.string().min(1).max(500) }),
        handler: async (input, ctx) => {
          const id = newId('nte');
          db.prepare('INSERT INTO probe_notes (id, owner_id, text, created_at) VALUES (?, ?, ?, ?)').run(
            id,
            ctx.ownerId,
            (input as { text: string }).text,
            nowIso(),
          );
          ctx.emit({ type: 'data_changed', resources: ['probe:notes'] });
          return { id };
        },
      },
      {
        name: 'list_notes',
        description: 'Wypisuje notatki testowe.',
        effect: 'read',
        inputSchema: z.object({}),
        handler: async (_input, ctx) => ({
          notes: db
            .prepare('SELECT id, text, created_at FROM probe_notes WHERE owner_id = ? ORDER BY created_at DESC')
            .all(ctx.ownerId),
        }),
      },
    ] as ServerModule['tools'],

    routes: (register) => {
      register.get('/notes', async (req) => ({
        body: {
          notes: db
            .prepare('SELECT id, text, created_at FROM probe_notes WHERE owner_id = ?')
            .all(req.ownerId),
        },
      }));
    },

    defaultComposition: (scope) =>
      scope.kind === 'probe'
        ? [
            {
              title: 'Notatki testowe',
              spec: { kind: 'component', component: 'probe.noteList', props: { limit: 20 } },
              geometry: { x: 0, y: 0, width: 420, height: 280 },
            },
          ]
        : [],
  };
}
