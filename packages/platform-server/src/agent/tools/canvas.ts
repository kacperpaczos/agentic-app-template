import { z } from 'zod';
import {
  AppError,
  cardGeometrySchema,
  cardSpecSchema,
  type ModuleToolDefinition,
  type ToolCallContext,
} from '@platform/contracts';
import type { PlatformServices } from '../../services/index.ts';

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
  return [
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
  ];
}
