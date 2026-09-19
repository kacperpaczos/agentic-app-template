import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import {
  AppError,
  applyReadWindow,
  operationFingerprint,
  READ_WINDOW_DEFAULT_LIMIT,
  READ_WINDOW_MAX_LIMIT,
  readWindowInput,
  readWindowNote,
  type ModuleToolDefinition,
  type ToolCallContext,
} from '@platform/contracts';
import type { PlatformServices } from '../../services/index.ts';
import { resolveInWorkspace, listWorkspaceOutputs } from '../sandbox.ts';

/** Content identity for a publication's fingerprint (see `files_publish_version`). */
export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/*
 * Required, not optional — the same contract as `artifact_create` /
 * `artifact_publish_file` in `artifacts.ts`. Publishing a version creates a
 * new file row and a new artifact; nothing collapses a repeat the way
 * `canvas_update_card` collapses one via `expectedSpecVersion`. Without a
 * required key the guard below (`services.idempotency.once`) is never
 * engaged, because a model never told the field exists never supplies it —
 * which is how a reconnect's retry produced a second version (L9.7).
 */
const OPERATION_ID = z
  .string()
  .min(8)
  .max(200)
  .describe('Wlasny identyfikator tej publikacji; powtorzenie z tym samym nie publikuje drugiej wersji');

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
        'Wypisuje pliki w magazynie aplikacji. Uzyj scope, zeby zawezic do konkretnego rekordu biznesowego. ' +
        `Odczyt jest stronicowany: domyslnie ${READ_WINDOW_DEFAULT_LIMIT} plikow, najwyzej ${READ_WINDOW_MAX_LIMIT}. ` +
        'window.truncated=true znaczy, ze to nie sa wszystkie pliki — po kolejne wywolaj z window.nextOffset.',
      effect: 'read',
      inputSchema: z.object({
        scopeKind: z.string().optional(),
        scopeId: z.string().optional(),
        ...readWindowInput,
      }),
      handler: async (input: any, ctx: ToolCallContext) => {
        const scope =
          input.scopeKind && input.scopeId ? { kind: input.scopeKind, id: input.scopeId } : undefined;
        const { items, window } = applyReadWindow(services.files.list(ctx.ownerId, scope), input);
        return {
          files: items.map((f) => ({
            id: f.id,
            filename: f.filename,
            mediaType: f.mediaType,
            byteSize: f.byteSize,
            scopeKind: f.scopeKind,
            scopeId: f.scopeId,
          })),
          window,
          windowNote: readWindowNote(window, 'plikow'),
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
        'Jesli tworzysz cos nowego, a nie wersje istniejacego pliku, uzyj artifact_publish_file. ' +
        'operationId jest wymagane: powtorzone wywolanie z tym samym identyfikatorem zwraca ta sama wersje, a nie druga.',
      effect: 'write',
      inputSchema: z.object({
        path: z.string().max(400),
        originalFileId: z.string(),
        filename: z.string().max(180).optional(),
        operationId: OPERATION_ID,
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
        /*
         * Read once, and hashed into the fingerprint.
         *
         * The fields of the call are not the whole request here: what is being
         * published is the *content* of a workspace file, and that content can
         * differ between two calls naming the same path — a run that regenerates
         * `output/raport.csv` and republishes it is the ordinary case. A
         * fingerprint over `path` and `originalFileId` alone would call those two
         * calls identical and answer the second with the first one's version, so
         * the sentence "a repeat with a different file is refused" would be true
         * of a different path and false of different bytes. It is now true of
         * both.
         *
         * Read **once**, above the guard, and used for both: the bytes that are
         * fingerprinted are the bytes that get published. A second read inside
         * the closure would hash one file and store another whenever the two
         * differ, and the guard would be answering about something it never saw.
         */
        const bytes = readFileSync(abs);
        const { result } = await services.idempotency.once(
          input.operationId,
          ctx.ownerId,
          'files.publishVersion',
          /*
           * The fingerprint is not optional here either. Without it a repeated
           * `operationId` carrying different content answered with the first
           * publication's id, version and download link and reported success —
           * the caller would be told its second file was published when nothing
           * of it was written. This was the one write path that was missed when
           * the guard was rebuilt.
           */
          async () => {
            const filename = input.filename ?? basename(abs);
            /*
             * A produced version is also an **artifact** of this conversation.
             *
             * It used to be only a row in `files`, which made it invisible where
             * a user looks for what a run produced: the conversation's artifact
             * tab showed nothing, and the only route to the result was the files
             * screen. The artifact is created inside the same transaction as the
             * version it describes, so the two cannot come apart — and it
             * carries the run, so "which execution produced this" is answerable
             * afterwards.
             */
            const { original, version, result: artifact } = services.files.storeVersion(
              {
                ownerId: ctx.ownerId,
                originalFileId: input.originalFileId,
                filename,
                mediaType: MEDIA_BY_EXT[extname(filename).toLowerCase()],
                bytes,
              },
              (produced, source) =>
                services.artifacts.create({
                  ownerId: ctx.ownerId,
                  conversationId: ctx.conversationId,
                  runId: ctx.runId,
                  kind: 'file',
                  mode: 'snapshot',
                  title: `${produced.filename} (wersja ${produced.version})`,
                  rendererType: 'platform.file',
                  content: {
                    fileId: produced.id,
                    filename: produced.filename,
                    mediaType: produced.mediaType,
                    byteSize: produced.byteSize,
                    sha256: produced.sha256,
                    version: produced.version,
                    derivedFromFileId: source.id,
                  },
                  fileId: produced.id,
                }),
            );
            return {
              fileId: version.id,
              filename: version.filename,
              version: version.version,
              byteSize: version.byteSize,
              sha256: version.sha256,
              downloadUrl: `/api/files/${version.id}/content`,
              artifactId: artifact.meta.id,
              original: {
                fileId: original.id,
                filename: original.filename,
                version: original.version,
                sha256: original.sha256,
                unchanged: true,
              },
            };
          },
          { fingerprint: operationFingerprint({ ...input, contentSha256: sha256(bytes) }) },
        );
        // A new version is a file change, not a canvas change: the files screen
        // and any open list must re-read, which is what this event drives.
        ctx.emit({ type: 'data_changed', resources: ['files'] });
        // …and it is an artifact, so the conversation's artifact tab re-reads too.
        ctx.emit({ type: 'artifact_created', artifactId: result.artifactId });
        return result;
      },
    },
    {
      name: 'files_versions',
      description:
        'Wypisuje wersje wyprodukowane z danego pliku, wraz z oryginalem. ' +
        `Odczyt jest stronicowany: domyslnie ${READ_WINDOW_DEFAULT_LIMIT} wersji, najwyzej ${READ_WINDOW_MAX_LIMIT}.`,
      effect: 'read',
      inputSchema: z.object({ fileId: z.string(), ...readWindowInput }),
      handler: async (input: { fileId: string; limit?: number; offset?: number }, ctx: ToolCallContext) => {
        const original = services.files.meta(input.fileId, ctx.ownerId);
        const { items, window } = applyReadWindow(services.files.versionsOf(input.fileId, ctx.ownerId), input);
        return {
          original: { fileId: original.id, filename: original.filename, version: original.version },
          versions: items.map((f) => ({
            fileId: f.id,
            filename: f.filename,
            version: f.version,
            byteSize: f.byteSize,
            createdAt: f.createdAt,
            downloadUrl: `/api/files/${f.id}/content`,
          })),
          window,
          windowNote: readWindowNote(window, 'wersji pliku'),
        };
      },
    },
    {
      name: 'workspace_outputs',
      description:
        'Wypisuje pliki, ktore powstaly w katalogu output/ workspace uruchomienia. ' +
        `Odczyt jest stronicowany: domyslnie ${READ_WINDOW_DEFAULT_LIMIT} plikow, najwyzej ${READ_WINDOW_MAX_LIMIT}.`,
      effect: 'read',
      inputSchema: z.object(readWindowInput),
      handler: async (input: { limit?: number; offset?: number }, ctx: ToolCallContext) => {
        if (!ctx.workspaceDir) {
          const { window } = applyReadWindow([], input);
          return { outputs: [], window, windowNote: readWindowNote(window, 'plikow wyjsciowych') };
        }
        const { items, window } = applyReadWindow(listWorkspaceOutputs(ctx.workspaceDir), input);
        return { outputs: items, window, windowNote: readWindowNote(window, 'plikow wyjsciowych') };
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
