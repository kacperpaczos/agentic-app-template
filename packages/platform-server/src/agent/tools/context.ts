import { z } from 'zod';
import { type ModuleToolDefinition, type ToolCallContext } from '@platform/contracts';
import type { PlatformServices } from '../../services/index.ts';

/**
 * Application context for the run: what the user is looking at, as the client
 * sent it, with the resource resolved to a short summary.
 */
export function contextTools(services: PlatformServices): Array<ModuleToolDefinition<any>> {
  return [
    {
      name: 'get_context',
      description:
        'Zwraca aktualny kontekst aplikacji: rozmowe, przestrzen canvas, zaznaczony zasob, filtry i niezapisane szkice formularzy. Wywolaj to na poczatku zadania i ponownie, jesli zadanie trwa dlugo.',
      effect: 'read',
      alwaysLoad: true,
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
          /*
           * Only the marker of the screen at send time (version, tab, view,
           * address). What the screen shows now is `ui_state`'s answer.
           */
          ui: ctx.appContext.ui,
          note: 'unsavedDrafts to NIEZAPISANY stan formularza uzytkownika. To nie sa dane zapisane w bazie i nie wolno ich traktowac jak faktow.',
          workspaceDir: ctx.workspaceDir,
        };
      },
    },
  ];
}
