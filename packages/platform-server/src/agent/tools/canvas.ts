import { z } from 'zod';
import {
  AppError,
  applyReadWindow,
  cardGeometrySchema,
  cardSpecSchema,
  READ_WINDOW_DEFAULT_LIMIT,
  READ_WINDOW_MAX_LIMIT,
  readWindowInput,
  readWindowNote,
  type ModuleToolDefinition,
  type ToolCallContext,
} from '@platform/contracts';
import { assertOwnConversationViews, type PlatformServices } from '../../services/index.ts';

const requireSpace = (ctx: ToolCallContext, explicit?: string | null): string => {
  const spaceId = explicit ?? ctx.appContext.spaceId;
  if (!spaceId) throw new AppError('validation_failed', 'Brak aktywnej przestrzeni canvas.');
  return spaceId;
};

/**
 * Canvas composition: list, catalog, add, update, move and remove cards.
 *
 * Content and position are separate tools on purpose — the position of a card
 * belongs to the user, and an edit of its content must not move it.
 */
export function canvasTools(services: PlatformServices): Array<ModuleToolDefinition<any>> {
  /*
   * Every space and card id these tools take is checked against the run's
   * conversation: another conversation's agent views are not this run's to
   * read or change (`assertOwnConversationViews`).
   */
  const spaceFor = (ctx: ToolCallContext, spaceId: string) => {
    const space = services.canvas.getSpace(spaceId, ctx.ownerId);
    assertOwnConversationViews(space, ctx.conversationId);
    return space;
  };
  const spaceOfCard = (ctx: ToolCallContext, cardId: string) => {
    const space = services.canvas.spaceOfCard(cardId, ctx.ownerId);
    assertOwnConversationViews(space, ctx.conversationId);
    return space;
  };

  return [
    {
      name: 'canvas_list_cards',
      description:
        'Zwraca karty aktualnej przestrzeni canvas wraz z ich pozycja i trescia. ' +
        `Odczyt jest stronicowany: domyslnie ${READ_WINDOW_DEFAULT_LIMIT} kart, najwyzej ${READ_WINDOW_MAX_LIMIT}. ` +
        'window.truncated=true znaczy, ze to nie sa wszystkie karty — po kolejne wywolaj z window.nextOffset.',
      effect: 'read',
      inputSchema: z.object({ spaceId: z.string().optional(), ...readWindowInput }),
      handler: async (input: { spaceId?: string; limit?: number; offset?: number }, ctx: ToolCallContext) => {
        const state = services.canvas.getState(spaceFor(ctx, requireSpace(ctx, input.spaceId)).id, ctx.ownerId);
        const { items, window } = applyReadWindow(state.cards, input);
        return {
          space: { id: state.space.id, title: state.space.title },
          cards: items.map((c) => ({
            id: c.id,
            title: c.title,
            spec: c.spec,
            geometry: c.geometry,
            specVersion: c.specVersion,
          })),
          window,
          windowNote: readWindowNote(window, 'kart'),
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
        const spaceId = spaceFor(ctx, requireSpace(ctx, input.spaceId)).id;
        const spec = services.catalog.validate(input.spec, {
          mode: services.canvas.compositionModeOfSpace(spaceId, ctx.ownerId),
        });
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
        'Zmienia tresc istniejacej karty. Nie zmienia jej polozenia - pozycja karty nalezy do uzytkownika. ' +
        'expectedSpecVersion jest wymagane: podaj specVersion z canvas_list_cards. Jesli ktos zmienil karte ' +
        'w miedzyczasie, dostaniesz conflict zamiast cichego nadpisania jego zmiany.',
      effect: 'write',
      inputSchema: z.object({
        cardId: z.string(),
        title: z.string().max(200).optional(),
        spec: cardSpecSchema,
        /*
         * Required, not optional. Optional meant that a write which simply left
         * it out was compared against the row it was about to overwrite — that
         * is, not compared at all — so an agent working from a reading taken
         * minutes earlier would quietly replace whatever the user had done
         * since. Naming the version is the whole of the check (L6.10, L9.6).
         */
        expectedSpecVersion: z
          .number()
          .int()
          .nonnegative()
          .describe('specVersion karty, na ktorej pracujesz (z canvas_list_cards)'),
        operationId: z.string().min(8).max(200).optional(),
      }),
      handler: async (input: any, ctx: ToolCallContext) => {
        spaceOfCard(ctx, input.cardId);
        const spec = services.catalog.validate(input.spec, {
          mode: services.canvas.compositionModeOfCard(input.cardId, ctx.ownerId),
        });
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
        spaceOfCard(ctx, input.cardId);
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
        const space = spaceOfCard(ctx, input.cardId);
        const removed = await services.canvas.removeCard(input, ctx.ownerId);
        ctx.emit({ type: 'canvas_changed', spaceId: space.id });
        return removed;
      },
    },
  ];
}
