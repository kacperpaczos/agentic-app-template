import { z } from 'zod';
import {
  AppError,
  UI_STATE_DEFAULT_WAIT_MS,
  UI_STATE_MAX_WAIT_MS,
  type ModuleToolDefinition,
  type ToolCallContext,
} from '@platform/contracts';
import type { PlatformServices } from '../../services/index.ts';

/**
 * Reading what the user's screen shows now.
 *
 * **Why a tool and not the context.** The context of a command is fixed when
 * the command is sent. After the agent moves or narrows the view, or while a
 * long task runs and the user keeps working, that context describes a screen
 * that is gone. This reads the latest description the conversation's tab
 * published, with its version, so the agent can ask for "at least the version
 * my command produced" and be told plainly when that is not there yet —
 * instead of describing the screen from memory of what it asked for.
 *
 * Only a tab showing the run's own conversation is read. A background task in
 * one conversation is not shown what the user is doing in another.
 */
export function uiStateTools(services: PlatformServices): Array<ModuleToolDefinition<any>> {
  return [
    {
      name: 'ui_state',
      description:
        'Zwraca aktualny opis ekranu uzytkownika w tej rozmowie: adres, otwarty widok z wersja kompozycji, ' +
        'karty przestrzeni, komponenty danych (stan, pola z etykietami, filtr, sortowanie, strona, ' +
        'identyfikatory widocznych rekordow, liczby matched/total) i dozwolone akcje. Kazdy opis ma ' +
        'wersje liczona osobno dla kazdej karty przegladarki (clientId). Po ui_navigate / ui_filter podaj ' +
        'minVersion = uiVersion i clientId = uiClientId z ich wyniku: narzedzie poczeka ' +
        `(domyslnie ${UI_STATE_DEFAULT_WAIT_MS} ms, najwyzej ${UI_STATE_MAX_WAIT_MS} ms) na opis tej karty co najmniej ` +
        'tej wersji. stale=true oznacza, ze opis nie jest potwierdzonym aktualnym stanem — reason mowi ' +
        'dlaczego: no_client (zadna karta nie opisala ekranu), other_conversation (karta pokazuje inna ' +
        'rozmowe), older_than_requested (zwrocony opis jest starszy niz wymagany), client_gone (karta ' +
        'zamknieta), client_inactive (karta dawno nie dala znaku zycia). ' +
        'Nie opisuj ekranu na podstawie opisu ze stale=true tak, jakby byl aktualny.',
      effect: 'read',
      alwaysLoad: true,
      inputSchema: z.object({
        clientId: z
          .string()
          .max(80)
          .optional()
          .describe('Karta przegladarki, o ktora pytasz, np. uiClientId z wyniku ui_navigate lub ui_filter'),
        minVersion: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Najnizsza wersja opisu tej karty, np. uiVersion z wyniku ui_navigate lub ui_filter'),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(UI_STATE_MAX_WAIT_MS)
          .optional()
          .describe('Jak dlugo czekac na opis co najmniej minVersion (ms)'),
      }),
      handler: async (input: { clientId?: string; minVersion?: number; waitMs?: number }, ctx: ToolCallContext) => {
        const conversationId = ctx.conversationId ?? ctx.appContext.conversationId;
        if (!conversationId) {
          throw new AppError(
            'unsupported_operation',
            'Opis ekranu dotyczy rozmowy wykonania, a to wywolanie nie ma rozmowy.',
          );
        }
        const waitMs = Math.min(
          input.waitMs ?? (input.minVersion !== undefined ? UI_STATE_DEFAULT_WAIT_MS : 0),
          UI_STATE_MAX_WAIT_MS,
        );
        const ui = ctx.appContext.ui;
        return services.uiSnapshots.waitFor(ctx.ownerId, conversationId, {
          ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
          ...(input.minVersion !== undefined ? { minVersion: input.minVersion } : {}),
          context: ui ? { clientId: ui.clientId, version: ui.version } : null,
          // A version without a named tab belongs to the tab that acknowledged this run's last UI command.
          acknowledged: services.uiSnapshots.acknowledgement(ctx.ownerId, ctx.runId),
          waitMs,
        });
      },
    },
  ];
}
