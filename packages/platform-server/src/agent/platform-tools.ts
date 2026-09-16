import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import {
  AppError,
  UI_COMMAND_FAILURES,
  cardGeometrySchema,
  cardSpecSchema,
  type ModuleToolDefinition,
  type ToolCallContext,
} from '@platform/contracts';
import type { PlatformServices } from '../services/index.ts';
import { resolveInWorkspace, listWorkspaceOutputs } from './sandbox.ts';

const MEDIA_BY_EXT: Record<string, string> = {
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

const requireSpace = (ctx: ToolCallContext, explicit?: string | null): string => {
  const spaceId = explicit ?? ctx.appContext.spaceId;
  if (!spaceId) throw new AppError('validation_failed', 'Brak aktywnej przestrzeni canvas.');
  return spaceId;
};

/**
 * Domain-agnostic tools every agent run gets: application context, canvas
 * composition, artifacts and managed files.
 *
 * These are registered under the `app` module id, so they surface as
 * `mcp__app__app_*` / `mcp__app__canvas_*` to Claude. They never touch business
 * tables — business operations come from the installed modules.
 */
export function platformTools(services: PlatformServices): ModuleToolDefinition<never>[] {
  const defs: Array<ModuleToolDefinition<any>> = [
    {
      name: 'get_context',
      description:
        'Zwraca aktualny kontekst aplikacji: rozmowe, przestrzen canvas, zaznaczony zasob, filtry i niezapisane szkice formularzy. Wywolaj to na poczatku zadania i ponownie, jesli zadanie trwa dlugo.',
      effect: 'read',
      inputSchema: z.object({}),
      handler: async (_input: unknown, ctx: ToolCallContext) => {
        const resourceSummary = await services.modules.describeResource(
          ctx.appContext.resource,
          ctx.ownerId,
        );
        return {
          conversationId: ctx.conversationId,
          spaceId: ctx.appContext.spaceId,
          resource: ctx.appContext.resource,
          resourceSummary,
          selection: ctx.appContext.selection,
          filters: ctx.appContext.filters,
          viewport: ctx.appContext.viewport,
          unsavedDrafts: ctx.appContext.drafts,
          note: 'unsavedDrafts to NIEZAPISANY stan formularza uzytkownika. To nie sa dane zapisane w bazie i nie wolno ich traktowac jak faktow.',
          workspaceDir: ctx.workspaceDir,
        };
      },
    },
    {
      name: 'canvas_list_cards',
      description: 'Zwraca karty aktualnej przestrzeni canvas wraz z ich pozycja i trescia.',
      effect: 'read',
      inputSchema: z.object({ spaceId: z.string().optional() }),
      handler: async (input: { spaceId?: string }, ctx: ToolCallContext) => {
        const state = services.canvas.getState(requireSpace(ctx, input.spaceId), ctx.ownerId);
        return {
          space: { id: state.space.id, title: state.space.title },
          cards: state.cards.map((c) => ({
            id: c.id,
            title: c.title,
            spec: c.spec,
            geometry: c.geometry,
            specVersion: c.specVersion,
          })),
        };
      },
    },
    {
      name: 'canvas_catalog',
      description: 'Zwraca katalog komponentow dostepnych dla kart canvasu wraz z ich uzyciem.',
      effect: 'read',
      inputSchema: z.object({}),
      handler: async () => ({ components: services.catalog.describe() }),
    },
    {
      name: 'canvas_add_card',
      description:
        'Dodaje karte do przestrzeni canvas. Komponent musi pochodzic z katalogu (canvas_catalog). Nie przekazuj wartosci biznesowych w props - karta sama pobiera dane z backendu.',
      effect: 'write',
      inputSchema: z.object({
        spaceId: z.string().optional(),
        title: z.string().max(200),
        spec: cardSpecSchema,
        geometry: cardGeometrySchema.partial().optional(),
        operationId: z.string().min(8).max(200).optional(),
      }),
      handler: async (input: any, ctx: ToolCallContext) => {
        const spaceId = requireSpace(ctx, input.spaceId);
        const spec = services.catalog.validate(input.spec);
        const card = await services.canvas.addCard(
          { spaceId, title: input.title, spec, geometry: input.geometry, operationId: input.operationId },
          ctx.ownerId,
        );
        ctx.emit({ type: 'canvas_changed', spaceId });
        return { cardId: card.id, specVersion: card.specVersion, geometry: card.geometry };
      },
    },
    {
      name: 'canvas_update_card',
      description:
        'Zmienia tresc istniejacej karty. Nie zmienia jej polozenia - pozycja karty nalezy do uzytkownika.',
      effect: 'write',
      inputSchema: z.object({
        cardId: z.string(),
        title: z.string().max(200).optional(),
        spec: cardSpecSchema,
        expectedSpecVersion: z.number().int().nonnegative().optional(),
        operationId: z.string().min(8).max(200).optional(),
      }),
      handler: async (input: any, ctx: ToolCallContext) => {
        const spec = services.catalog.validate(input.spec);
        const card = await services.canvas.updateSpec({ ...input, spec }, ctx.ownerId);
        ctx.emit({ type: 'canvas_changed', spaceId: card.spaceId });
        return { cardId: card.id, specVersion: card.specVersion };
      },
    },
    {
      name: 'canvas_move_card',
      description:
        'Przestawia lub zmienia rozmiar karty. Uzywaj tylko wtedy, gdy uzytkownik wprost prosi o zmiane ukladu.',
      effect: 'write',
      inputSchema: z.object({
        cardId: z.string(),
        geometry: cardGeometrySchema.partial(),
      }),
      handler: async (input: any, ctx: ToolCallContext) => {
        const card = services.canvas.updateGeometry(input, ctx.ownerId);
        ctx.emit({ type: 'canvas_changed', spaceId: card.spaceId });
        return { cardId: card.id, geometry: card.geometry, geometryVersion: card.geometryVersion };
      },
    },
    {
      name: 'canvas_remove_card',
      description: 'Usuwa karte z przestrzeni canvas.',
      effect: 'write',
      inputSchema: z.object({
        cardId: z.string(),
        operationId: z.string().min(8).max(200).optional(),
      }),
      handler: async (input: any, ctx: ToolCallContext) => {
        const state = services.canvas.getState(requireSpace(ctx), ctx.ownerId);
        const removed = await services.canvas.removeCard(input, ctx.ownerId);
        ctx.emit({ type: 'canvas_changed', spaceId: state.space.id });
        return removed;
      },
    },
    {
      name: 'ui_catalog',
      description:
        'Wypisuje widoki, ustawienia i elementy interfejsu, ktore mozesz otworzyc lub pokazac, ' +
        'oraz przestrzenie pracy uzytkownika. Wywolaj to ZANIM zaczniesz opisywac uzytkownikowi ' +
        'droge do czegokolwiek — jesli cel jest na liscie, po prostu go otworz przez ui_navigate.',
      effect: 'read',
      inputSchema: z.object({}),
      handler: async (_input: unknown, ctx: ToolCallContext) => ({
        targets: services.modules.uiTargets().map((t) => ({
          id: t.id,
          kind: t.kind,
          label: t.label,
          description: t.description,
        })),
        spaces: services.canvas.listSpaces(ctx.ownerId).map((sp) => ({
          spaceId: sp.id,
          title: sp.title,
          scopeKind: sp.scopeKind,
          scopeId: sp.scopeId,
          current: sp.id === ctx.appContext.spaceId,
        })),
        currentSpaceId: ctx.appContext.spaceId,
      }),
    },
    {
      name: 'ui_navigate',
      description:
        'Otwiera wskazany widok lub ustawienie, przelacza przestrzen pracy, przewija do elementu ' +
        'i chwilowo go podswietla. Zwraca to, co KLIENT faktycznie wykonal — wywolanie moze ' +
        'zakonczyc sie niepowodzeniem (nieznany cel, element nieobecny, uzytkownik oglada inna ' +
        'rozmowe, brak polaczonego klienta). Nie twierdz, ze cos otworzyles, jesli executed=false. ' +
        'Pokazanie ustawienia NIE zmienia jego wartosci.',
      effect: 'read',
      inputSchema: z.object({
        targetId: z.string().max(120),
        spaceId: z.string().max(80).optional(),
        reason: z.string().max(200).optional(),
      }),
      handler: async (input: any, ctx: ToolCallContext) => {
        if (!ctx.requestUi) {
          throw new AppError('unsupported_operation', 'Brak polaczonego interfejsu dla tego uruchomienia.');
        }
        /*
         * Checked here, against the same catalog the client resolves against, so
         * an unknown target is a clear answer rather than an eight-second wait
         * for a browser that was never going to find it.
         */
        const known = services.modules.uiTargets().find((t) => t.id === input.targetId);
        if (!known) {
          return {
            executed: false,
            reason: UI_COMMAND_FAILURES.unknownTarget,
            requested: input.targetId,
            available: services.modules.uiTargets().map((t) => t.id),
          };
        }
        if (input.spaceId) {
          // Ownership, before anything is asked of the browser: a space the
          // owner may not see must fail here, not silently on screen.
          services.canvas.getState(input.spaceId, ctx.ownerId);
        }
        const result = await ctx.requestUi({
          targetId: input.targetId,
          spaceId: input.spaceId ?? null,
          reason: input.reason,
        });
        return {
          executed: result.executed,
          reason: result.reason,
          targetId: result.targetId ?? input.targetId,
          label: known.label,
          url: result.url,
          highlighted: result.highlighted ?? false,
        };
      },
    },
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
        const { result } = await services.idempotency.once(
          input.operationId,
          ctx.ownerId,
          'artifact.publishFile',
          async () => {
            const filename = basename(abs);
            const mediaType = MEDIA_BY_EXT[extname(filename).toLowerCase()] ?? 'text/plain';
            const stored = services.files.store({
              ownerId: ctx.ownerId,
              filename,
              mediaType,
              bytes: readFileSync(abs),
              scopeKind: 'artifact',
              scopeId: ctx.runId,
            });
            const created = services.artifacts.create({
              ownerId: ctx.ownerId,
              conversationId: ctx.conversationId,
              kind: input.kind ?? 'file',
              mode: 'snapshot',
              title: input.title,
              rendererType: input.rendererType ?? 'platform.file',
              content: {
                fileId: stored.id,
                filename: stored.filename,
                mediaType: stored.mediaType,
                byteSize: stored.byteSize,
                sha256: stored.sha256,
              },
              fileId: stored.id,
            });
            return {
              artifactId: created.meta.id,
              fileId: stored.id,
              filename: stored.filename,
              byteSize: stored.byteSize,
              downloadUrl: `/api/files/${stored.id}/content`,
            };
          },
        );
        ctx.emit({ type: 'artifact_created', artifactId: result.artifactId });
        return result;
      },
    },
  ];
  return defs as ModuleToolDefinition<never>[];
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
