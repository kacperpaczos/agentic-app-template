import { z } from 'zod';
import {
  AppError,
  UI_COMMAND_FAILURES,
  VIEW_FILTER_OPS,
  type ModuleToolDefinition,
  type ToolCallContext,
} from '@platform/contracts';
import { sortableFieldsOfTarget } from '../../registry/view-sorting.ts';
import type { PlatformServices } from '../../services/index.ts';

/**
 * Moving the interface: the catalog of places, navigation and narrowing.
 *
 * Each resolves only when the browser reports what it actually did, through
 * `ToolCallContext.requestUi`.
 */
export function uiTools(services: PlatformServices): Array<ModuleToolDefinition<any>> {
  return [
    {
      name: 'ui_catalog',
      description:
        'Wypisuje widoki, ustawienia i elementy interfejsu, ktore mozesz otworzyc lub pokazac, ' +
        'oraz przestrzenie pracy uzytkownika. Wywolaj to ZANIM zaczniesz opisywac uzytkownikowi ' +
        'droge do czegokolwiek — jesli cel jest na liscie, po prostu go otworz przez ui_navigate.',
      effect: 'read',
      alwaysLoad: true,
      inputSchema: z.object({}),
      handler: async (_input: unknown, ctx: ToolCallContext) => ({
        targets: services.modules.uiTargets().map((t) => ({
          id: t.id,
          kind: t.kind,
          label: t.label,
          description: t.description,
          /*
           * Present only for a view that declares it. Listing the properties
           * here is what makes `ui_filter` usable without guessing: the agent
           * picks a name it has been shown, instead of one that sounds right.
           */
          filterableFields: t.filter?.fields.map((f) => ({
            field: f.field,
            label: f.label,
            values: f.values,
          })),
          /*
           * Present only for a view whose records can be ordered: the declared,
           * sortable fields of its primary read. `ui_sort` refuses anything else.
           */
          sortableFields: sortableFieldsOfTarget(services.modules, t.id)?.map((f) => ({
            field: f.field,
            label: f.label,
            type: f.type,
          })),
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
        'i chwilowo go podswietla. Uzywaj tego RUTYNOWO: jesli odpowiadasz na pytanie o dane, ' +
        'ktore maja swoj widok, otworz ten widok w tej samej turze, zamiast tylko opisywac dane ' +
        'w rozmowie. Zwraca to, co KLIENT faktycznie wykonal — wywolanie moze ' +
        'zakonczyc sie niepowodzeniem (nieznany cel, element nieobecny, uzytkownik oglada inna ' +
        'rozmowe, brak polaczonego klienta). Nie twierdz, ze cos otworzyles, jesli executed=false. ' +
        'Pokazanie ustawienia NIE zmienia jego wartosci.',
      effect: 'read',
      alwaysLoad: true,
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
      name: 'ui_filter',
      description:
        'Zaweza widok do wierszy spelniajacych warunki — i JEST to domyslny sposob odpowiadania ' +
        'na prosby typu "pokaz tylko X". Nie przepisuj pasujacych wierszy do rozmowy zamiast tego: ' +
        'uzytkownik ma je zobaczyc w widoku. Pola do zawezania podaje ui_catalog jako ' +
        'filterableFields; pole spoza tej listy jest odrzucane. Zawsze podaj label — krotkie zdanie ' +
        'po polsku, ktore uzytkownik zobaczy nad widokiem. Przekaz clear=true, zeby przywrocic ' +
        'pelny widok. Zwraca to, co KLIENT faktycznie pokazal, razem z liczba wierszy ' +
        '(filtered.matched z filtered.total) i strona (page) — podaj te liczby uzytkownikowi zamiast ' +
        'zgadywac. Zawezenie zmienia tylko prezentacje, nie dane.',
      effect: 'read',
      alwaysLoad: true,
      inputSchema: z.object({
        targetId: z.string().max(120),
        predicates: z
          .array(
            z.object({
              field: z.string().max(80),
              op: z.enum(VIEW_FILTER_OPS),
              value: z.union([
                z.string().max(200),
                z.number(),
                z.boolean(),
                z.array(z.union([z.string().max(200), z.number()])).max(40),
              ]),
            }),
          )
          .max(8)
          .optional(),
        label: z.string().max(140).optional(),
        clear: z.boolean().optional(),
        reason: z.string().max(200).optional(),
      }),
      handler: async (input: any, ctx: ToolCallContext) => {
        if (!ctx.requestUi) {
          throw new AppError('unsupported_operation', 'Brak polaczonego interfejsu dla tego uruchomienia.');
        }
        const known = services.modules.uiTargets().find((t) => t.id === input.targetId);
        if (!known) {
          return {
            executed: false,
            reason: UI_COMMAND_FAILURES.unknownTarget,
            requested: input.targetId,
            available: services.modules.uiTargets().map((t) => t.id),
          };
        }

        /*
         * Clearing is allowed on any view — putting a screen back the way it
         * was must never depend on the view still declaring what it accepts.
         */
        const clearing = input.clear === true;
        if (!clearing) {
          if (!known.filter) {
            return {
              executed: false,
              reason: UI_COMMAND_FAILURES.notFilterable,
              targetId: known.id,
              label: known.label,
            };
          }
          const predicates = input.predicates ?? [];
          if (predicates.length === 0) {
            throw new AppError(
              'validation_failed',
              'Podaj warunki zawezenia albo clear=true, zeby przywrocic pelny widok.',
            );
          }
          if (!input.label) {
            throw new AppError(
              'validation_failed',
              'Podaj label — zdanie, ktore uzytkownik zobaczy nad zawezonym widokiem.',
            );
          }
          /*
           * A property the view does not declare is refused by name, with the
           * list of what it does declare. Accepting it would produce an empty
           * screen that looks like a legitimate answer.
           */
          const declared = new Set(known.filter.fields.map((f) => f.field));
          const unknown = predicates.map((p: any) => p.field).filter((f: string) => !declared.has(f));
          if (unknown.length > 0) {
            return {
              executed: false,
              reason: UI_COMMAND_FAILURES.unknownField,
              targetId: known.id,
              requested: unknown,
              available: known.filter.fields.map((f) => ({ field: f.field, label: f.label, values: f.values })),
            };
          }
        }

        const result = await ctx.requestUi({
          targetId: input.targetId,
          spaceId: null,
          filter: clearing
            ? null
            : { targetId: input.targetId, predicates: input.predicates, label: input.label },
          reason: input.reason,
        });
        return {
          executed: result.executed,
          reason: result.reason,
          targetId: result.targetId ?? input.targetId,
          label: known.label,
          url: result.url,
          cleared: clearing && result.executed,
          filtered: result.filtered,
          // A narrowing returns to the first page; the view says how many there are.
          page: result.page,
        };
      },
    },
  ];
}
