import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import { AppError, type ModuleToolDefinition, type ToolCallContext } from '@platform/contracts';
import type { PlatformServices } from '../../services/index.ts';
import { resolveInWorkspace, listWorkspaceOutputs } from '../sandbox.ts';
import { MEDIA_BY_EXT } from './files.ts';

/**
 * Durable artifacts: a snapshot or a live descriptor, and a workspace file
 * published for download.
 */
export function artifactTools(services: PlatformServices): Array<ModuleToolDefinition<any>> {
  return [
    {
      name: 'artifact_create',
      description:
        'Zapisuje trwaly artefakt. mode="snapshot" (domyslnie) zamraza przekazana tresc JSON. ' +
        'mode="live" NIE zapisuje danych: jako content podaj deskryptor {"operation":"<modul>.<operacja>","input":{...}} ' +
        'wskazujacy zarejestrowana operacje odczytu; przy kazdym otwarciu artefaktu platforma uruchomi ja ponownie ' +
        'i pokaze aktualny wynik. Lista dostepnych operacji jest w opisie systemowym.',
      effect: 'write',
      inputSchema: z.object({
        title: z.string().max(200),
        kind: z.enum(['report', 'table', 'chart', 'file']),
        // `.optional()` not `.default()`: see the note on cardSpecSchema.
        mode: z.enum(['snapshot', 'live']).optional(),
        rendererType: z.string().max(120),
        content: z.unknown(),
        operationId: z.string().min(8).max(200).optional(),
      }),
      handler: async (input: any, ctx: ToolCallContext) => {
        const mode = input.mode ?? 'snapshot';
        /*
         * A live artifact is checked against the read-operation registry before
         * it is stored. Otherwise the model could promise a self-refreshing
         * report that names a query nobody implements, and the failure would
         * only surface later, to the user, on open.
         */
        if (mode === 'live') services.artifacts.assertLiveSourceIsResolvable(input.content);

        const { result } = await services.idempotency.once(
          input.operationId,
          ctx.ownerId,
          'artifact.create',
          async () =>
            services.artifacts.create({
              ownerId: ctx.ownerId,
              conversationId: ctx.conversationId,
              runId: ctx.runId,
              kind: input.kind,
              mode,
              title: input.title,
              rendererType: input.rendererType,
              content: input.content,
            }).meta,
        );
        ctx.emit({ type: 'artifact_created', artifactId: result.id });
        return { artifactId: result.id, version: result.currentVersion };
      },
    },
    {
      name: 'artifact_publish_file',
      description:
        'Publikuje plik z katalogu output/ workspace jako trwaly artefakt do pobrania. Plik jest kopiowany do magazynu aplikacji, wiec przetrwa sprzatniecie workspace.',
      effect: 'write',
      inputSchema: z.object({
        path: z.string().max(400),
        title: z.string().max(200),
        kind: z.enum(['report', 'table', 'chart', 'file']).optional(),
        rendererType: z.string().max(120).optional(),
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
        // Read once, above the guard: see the note in `files_publish_version`.
        const bytes = readFileSync(abs);
        const { result } = await services.idempotency.once(
          input.operationId,
          ctx.ownerId,
          'artifact.publishFile',
          async () => {
            const filename = basename(abs);
            const mediaType = MEDIA_BY_EXT[extname(filename).toLowerCase()] ?? 'text/plain';
            /*
             * One publication, not two steps. The bytes are renamed into place
             * before anything is written, and the file row and the artifact that
             * points at it are inserted in the same transaction — so an
             * interrupted publication leaves neither an orphaned file nor an
             * artifact whose content is missing.
             */
            const { file: stored, result: created } = services.files.storeWith(
              {
                ownerId: ctx.ownerId,
                filename,
                mediaType,
                bytes,
                scopeKind: 'artifact',
                scopeId: ctx.runId,
              },
              (file) =>
                services.artifacts.create({
                  ownerId: ctx.ownerId,
                  conversationId: ctx.conversationId,
                  runId: ctx.runId,
                  kind: input.kind ?? 'file',
                  mode: 'snapshot',
                  title: input.title,
                  rendererType: input.rendererType ?? 'platform.file',
                  content: {
                    fileId: file.id,
                    filename: file.filename,
                    mediaType: file.mediaType,
                    byteSize: file.byteSize,
                    sha256: file.sha256,
                  },
                  fileId: file.id,
                }),
            );
            return {
              artifactId: created.meta.id,
              fileId: stored.id,
              filename: stored.filename,
              byteSize: stored.byteSize,
              sha256: stored.sha256,
              downloadUrl: `/api/files/${stored.id}/content`,
            };
          },
        );
        ctx.emit({ type: 'artifact_created', artifactId: result.artifactId });
        return result;
      },
    },
  ];
}
