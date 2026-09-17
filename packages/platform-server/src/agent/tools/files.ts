import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import { AppError, type ModuleToolDefinition, type ToolCallContext } from '@platform/contracts';
import type { PlatformServices } from '../../services/index.ts';
import { resolveInWorkspace, listWorkspaceOutputs } from '../sandbox.ts';

export const MEDIA_BY_EXT: Record<string, string> = {
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * Managed files and the run workspace: listing, staging into `input/`,
 * publishing a new version of a file, and what the run wrote to `output/`.
 */
export function fileTools(services: PlatformServices): Array<ModuleToolDefinition<any>> {
  return [
    {
      name: 'files_list',
      description:
        'Wypisuje pliki w magazynie aplikacji. Uzyj scope, zeby zawezic do konkretnego rekordu biznesowego.',
      effect: 'read',
      inputSchema: z.object({
        scopeKind: z.string().optional(),
        scopeId: z.string().optional(),
      }),
      handler: async (input: any, ctx: ToolCallContext) => {
        const scope =
          input.scopeKind && input.scopeId ? { kind: input.scopeKind, id: input.scopeId } : undefined;
        return {
          files: services.files.list(ctx.ownerId, scope).map((f) => ({
            id: f.id,
            filename: f.filename,
            mediaType: f.mediaType,
            byteSize: f.byteSize,
            scopeKind: f.scopeKind,
            scopeId: f.scopeId,
          })),
        };
      },
    },
    {
      name: 'files_stage',
      description:
        'Kopiuje plik z magazynu aplikacji do katalogu input/ workspace uruchomienia, zeby mozna go bylo odczytac i przetworzyc kodem w sandboxie. Zwraca sciezke wzgledna.',
      effect: 'read',
      inputSchema: z.object({ fileId: z.string() }),
      handler: async (input: { fileId: string }, ctx: ToolCallContext) => {
        if (!ctx.workspaceDir) throw new AppError('unsupported_operation', 'Brak workspace uruchomienia.');
        const { meta, bytes } = services.files.read(input.fileId, ctx.ownerId);
        const target = resolveInWorkspace(ctx.workspaceDir, `input/${meta.filename}`);
        writeFileSync(target, bytes);
        return {
          path: `input/${meta.filename}`,
          absolutePath: target,
          byteSize: meta.byteSize,
          mediaType: meta.mediaType,
        };
      },
    },
    {
      name: 'files_publish_version',
      description:
        'Publikuje plik z katalogu output/ jako NOWA WERSJE wskazanego pliku wejsciowego. ' +
        'Oryginal pozostaje nienaruszony i nadal jest dostepny; wynik dostaje wlasny identyfikator, ' +
        'numer wersji i odnosnik do pobrania. Uzyj tego, gdy modyfikujesz plik uzytkownika. ' +
        'Jesli tworzysz cos nowego, a nie wersje istniejacego pliku, uzyj artifact_publish_file.',
      effect: 'write',
      inputSchema: z.object({
        path: z.string().max(400),
        originalFileId: z.string(),
        filename: z.string().max(180).optional(),
        operationId: z.string().min(8).max(200).optional(),
      }),
      handler: async (input: any, ctx: ToolCallContext) => {
        if (!ctx.workspaceDir) throw new AppError('unsupported_operation', 'Brak workspace uruchomienia.');
        const rel = input.path.startsWith('output/') ? input.path : `output/${input.path}`;
        const abs = resolveInWorkspace(ctx.workspaceDir, rel);
        if (!existsSync(abs) || !statSync(abs).isFile()) {
          throw new AppError('not_found', `Brak pliku ${rel} w workspace.`, {
            available: listWorkspaceOutputs(ctx.workspaceDir),
          });
        }
        const { result } = await services.idempotency.once(
          input.operationId,
          ctx.ownerId,
          'files.publishVersion',
          async () => {
            const filename = input.filename ?? basename(abs);
            const { original, version } = services.files.storeVersion({
              ownerId: ctx.ownerId,
              originalFileId: input.originalFileId,
              filename,
              mediaType: MEDIA_BY_EXT[extname(filename).toLowerCase()],
              bytes: readFileSync(abs),
            });
            return {
              fileId: version.id,
              filename: version.filename,
              version: version.version,
              byteSize: version.byteSize,
              sha256: version.sha256,
              downloadUrl: `/api/files/${version.id}/content`,
              original: {
                fileId: original.id,
                filename: original.filename,
                version: original.version,
                sha256: original.sha256,
                unchanged: true,
              },
            };
          },
        );
        // A new version is a file change, not a canvas change: the files screen
        // and any open list must re-read, which is what this event drives.
        ctx.emit({ type: 'data_changed', resources: ['files'] });
        return result;
      },
    },
    {
      name: 'files_versions',
      description: 'Wypisuje wersje wyprodukowane z danego pliku, wraz z oryginalem.',
      effect: 'read',
      inputSchema: z.object({ fileId: z.string() }),
      handler: async (input: { fileId: string }, ctx: ToolCallContext) => {
        const original = services.files.meta(input.fileId, ctx.ownerId);
        return {
          original: { fileId: original.id, filename: original.filename, version: original.version },
          versions: services.files.versionsOf(input.fileId, ctx.ownerId).map((f) => ({
            fileId: f.id,
            filename: f.filename,
            version: f.version,
            byteSize: f.byteSize,
            createdAt: f.createdAt,
            downloadUrl: `/api/files/${f.id}/content`,
          })),
        };
      },
    },
    {
      name: 'workspace_outputs',
      description: 'Wypisuje pliki, ktore powstaly w katalogu output/ workspace uruchomienia.',
      effect: 'read',
      inputSchema: z.object({}),
      handler: async (_input: unknown, ctx: ToolCallContext) => {
        if (!ctx.workspaceDir) return { outputs: [] };
        return { outputs: listWorkspaceOutputs(ctx.workspaceDir) };
      },
    },
  ];
}

/** Copies an uploaded file into a run workspace before the run starts. */
export function stageFileIntoWorkspace(
  services: PlatformServices,
  ownerId: string,
  fileId: string,
  workspaceDir: string,
): { path: string } {
  const { meta, bytes } = services.files.read(fileId, ownerId);
  const target = resolveInWorkspace(workspaceDir, `input/${meta.filename}`);
  writeFileSync(target, bytes);
  return { path: `input/${meta.filename}` };
}
