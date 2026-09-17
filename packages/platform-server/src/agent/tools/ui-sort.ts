import { z } from 'zod';
import {
  AppError,
  UI_COMMAND_FAILURES,
  checkSortField,
  type ModuleToolDefinition,
  type RecordField,
  type ToolCallContext,
} from '@platform/contracts';
import { primaryDescriptorOf } from '../../registry/view-sorting.ts';
import type { PlatformServices } from '../../services/index.ts';

const describeFields = (fields: RecordField[]) =>
  fields.map((f) => ({ field: f.field, label: f.label, type: f.type }));

/**
 * Ordering a view: the agent's way of answering "sort by …" on screen.
 *
 * **Why a tool and not a sorted list in the chat.** The same reasoning as
 * narrowing: a list retyped into the conversation in a new order is a copy the
 * user cannot page, cannot narrow further and that does not update, while the
 * screen beside it keeps the old order. The order belongs to the view — in its
 * address, where Back undoes it — and the tool reports the order and page the
 * *view* says it is showing.
 *
 * A field the view's read does not declare, or declares unsortable, is refused
 * by name with the fields that may be used, before the browser is asked for
 * anything: a guessed field would otherwise come back as an unchanged screen.
 */
export function uiSortTools(services: PlatformServices): Array<ModuleToolDefinition<any>> {
  return [
    {
      name: 'ui_sort',
      description:
        'Ustawia kolejnosc wierszy widoku wedlug jednego pola (rosnaco albo malejaco) — tak odpowiadasz ' +
        'na prosby typu "posortuj po X". Nie przepisuj posortowanych wierszy do rozmowy. Pola, po ktorych ' +
        'wolno sortowac, podaje ui_catalog jako sortableFields; inne pole jest odrzucane (unknown_field ' +
        'albo not_sortable) z lista dozwolonych. clear=true przywraca domyslny porzadek widoku (tylko widoku, ktory ' +
        'ma sortowalne rekordy; inny cel odpowiada not_sortable i nic nie zmienia). ' +
        'Sortowanie zmienia tylko prezentacje, nie dane. Zmiana kolejnosci wraca do pierwszej strony. ' +
        'Zwraca to, co KLIENT faktycznie pokazal: sorted (pole i kierunek) i page (strona, rozmiar, ' +
        'liczba stron). Jesli executed=false, nie twierdz, ze widok jest posortowany.',
      effect: 'read',
      alwaysLoad: true,
      inputSchema: z.object({
        targetId: z.string().max(120),
        field: z.string().max(80).optional(),
        direction: z.enum(['asc', 'desc']).optional(),
        clear: z.boolean().optional(),
        reason: z.string().max(200).optional(),
      }),
      handler: async (input: any, ctx: ToolCallContext) => {
        if (!ctx.requestUi) {
          throw new AppError('unsupported_operation', 'Brak polaczonego interfejsu dla tego uruchomienia.');
        }
        const targets = services.modules.uiTargets();
        const known = targets.find((t) => t.id === input.targetId);
        if (!known) {
          return {
            executed: false,
            reason: UI_COMMAND_FAILURES.unknownTarget,
            requested: input.targetId,
            available: targets.map((t) => t.id),
          };
        }

        const clearing = input.clear === true;
        if (!clearing && !input.field) {
          throw new AppError(
            'validation_failed',
            'Podaj field (pole z sortableFields) albo clear=true, zeby przywrocic domyslny porzadek.',
          );
        }
        /*
         * A target whose view has no records to order has no order to set — and
         * none to clear. Answered here, before the browser is asked: "cleared"
         * would be a success nothing applied, and performing it would move the
         * user to that target's screen for nothing.
         */
        const primary = primaryDescriptorOf(services.modules, known.id);
        if (!primary) {
          return {
            executed: false,
            reason: UI_COMMAND_FAILURES.notSortable,
            targetId: known.id,
            label: known.label,
            ...(clearing ? {} : { requested: input.field }),
            available: [],
          };
        }
        let sort: { field: string; direction: 'asc' | 'desc' } | null = null;
        if (!clearing) {
          const check = checkSortField(primary.descriptor, input.field);
          if (!check.ok) {
            return {
              executed: false,
              reason: check.reason === 'unknown_field' ? UI_COMMAND_FAILURES.unknownField : UI_COMMAND_FAILURES.notSortable,
              targetId: known.id,
              label: known.label,
              requested: input.field,
              available: describeFields(check.available),
            };
          }
          sort = { field: check.field.field, direction: input.direction ?? 'asc' };
        }

        const result = await ctx.requestUi({
          targetId: known.id,
          spaceId: null,
          sort,
          reason: input.reason,
        });
        return {
          executed: result.executed,
          reason: result.reason,
          targetId: result.targetId ?? known.id,
          label: known.label,
          url: result.url,
          cleared: clearing && result.executed,
          sorted: result.sorted,
          page: result.page,
          filtered: result.filtered,
        };
      },
    },
  ];
}
