import { z } from 'zod';
import {
  UI_STATE_DEFAULT_WAIT_MS,
  UI_STATE_MAX_WAIT_MS,
  type ModuleToolDefinition,
  type ToolCallContext,
  type UiStateResult,
} from '@platform/contracts';
import type { PlatformServices } from '../../services/index.ts';

/**
 * Application context for the run, in two parts that must never be confused.
 *
 * **The top-level fields** — what the client sent with the command, resolved once
 * when the run started. It decides what the run is *for*: the space it writes
 * to, the record it was asked about, the rows that were selected when the user
 * pressed send. It does not move, and it must not: a task started for one record
 * may not follow the user to another (L6.10), and a task of one conversation may
 * not adopt a selection made later in another (L6.14).
 *
 * **`currentContext`** — what the user's tab, *showing this run's conversation*,
 * says it holds now. Published on the same versioned per-tab channel as the
 * screen description (`ui_state`), so it carries the same honesty: `stale` with
 * a `reason` when no tab of this conversation has published lately, and a
 * `version` that a reader can compare. During a long task this is how the agent
 * finds out that the selection or the half-typed form has changed since the
 * command — and `changedSinceCommand` names exactly which parts differ, so the
 * newer context is distinguishable from the starting one rather than silently
 * replacing it (L6.3, L6.9).
 *
 * Scoped to the conversation, exactly as `ui_state`: a background run is never
 * shown what the user selected in a conversation it does not belong to.
 */
export function contextTools(services: PlatformServices): Array<ModuleToolDefinition<any>> {
  return [
    {
      name: 'get_context',
      description:
        'Zwraca kontekst aplikacji w dwoch czesciach. Pola na najwyzszym poziomie to kontekst POLECENIA — rozmowa, ' +
        'przestrzen canvas, wskazany zasob, zaznaczenie, filtry i niezapisane szkice z chwili wyslania; ' +
        'to one wyznaczaja cel tego zadania i nie zmieniaja sie w trakcie. currentContext to to, co karta ' +
        'przegladarki pokazujaca TE rozmowe trzyma teraz: zasob, zaznaczenie i szkice, z wersja opisu. ' +
        'changedSinceCommand wymienia, co rozni sie od kontekstu polecenia (resource, selection, drafts, ' +
        'spaceId) — pusta lista znaczy "nic sie nie zmienilo". currentContext.stale=true znaczy, ze to NIE ' +
        'jest potwierdzony biezacy stan; reason mowi dlaczego (no_client, other_conversation, client_gone, ' +
        'client_inactive, older_than_requested, superseded). ' +
        'Wywolaj to na poczatku zadania i PONOWNIE, jesli zadanie trwa dlugo — zanim uznasz zaznaczenie albo ' +
        'szkic za aktualne. Cel zadania bierz z pol najwyzszego poziomu, nowosci z currentContext.',
      effect: 'read',
      alwaysLoad: true,
      inputSchema: z.object({
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(UI_STATE_MAX_WAIT_MS)
          .optional()
          .describe('Ile czekac (ms) na opis karty co najmniej minVersion'),
        minVersion: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Najnizsza wersja opisu karty, ktora uznajesz za aktualna'),
        clientId: z.string().max(80).optional().describe('Karta przegladarki, o ktora pytasz'),
        waitForChange: z
          .boolean()
          .optional()
          .describe(
            'Czekaj na opis NOWSZY niz ten, z ktorym przyszlo polecenie — czyli az uzytkownik cos zmieni. ' +
              'Bez tego dostajesz od razu to, co jest.',
          ),
      }),
      handler: async (
        input: { waitMs?: number; minVersion?: number; clientId?: string; waitForChange?: boolean },
        ctx: ToolCallContext,
      ) => {
        const description = await services.modules.describeResource(ctx.appContext.resource, ctx.ownerId);
        const commandContext = {
          conversationId: ctx.conversationId,
          spaceId: ctx.appContext.spaceId,
          resource: ctx.appContext.resource,
          resourceSummary: description.summary,
          resourceState: description.state,
          resourceNote: description.note,
          selection: ctx.appContext.selection,
          filters: ctx.appContext.filters,
          viewport: ctx.appContext.viewport,
          unsavedDrafts: ctx.appContext.drafts,
          /*
           * Only the marker of the screen at send time (version, tab, view,
           * address). What the screen shows now is `ui_state`'s answer.
           */
          ui: ctx.appContext.ui,
        };

        const conversationId = ctx.conversationId ?? ctx.appContext.conversationId;
        /*
         * "Until the user changes something" expressed as a version: one past
         * the description the command was sent with, on the tab that sent it.
         * Without a marker there is nothing to be newer than, and the flag is
         * simply an ordinary read.
         */
        const marker = ctx.appContext.ui;
        const minVersion =
          input.minVersion ?? (input.waitForChange && marker ? marker.version + 1 : undefined);
        const clientId = input.clientId ?? (input.waitForChange && marker ? marker.clientId : undefined);
        const live = conversationId
          ? await services.uiSnapshots.waitFor(ctx.ownerId, conversationId, {
              ...(clientId !== undefined ? { clientId } : {}),
              ...(minVersion !== undefined ? { minVersion } : {}),
              context: ctx.appContext.ui
                ? { clientId: ctx.appContext.ui.clientId, version: ctx.appContext.ui.version }
                : null,
              acknowledged: services.uiSnapshots.acknowledgement(ctx.ownerId, ctx.runId),
              waitMs: Math.min(
                input.waitMs ?? (minVersion !== undefined ? UI_STATE_DEFAULT_WAIT_MS : 0),
                UI_STATE_MAX_WAIT_MS,
              ),
            })
          : null;

        /*
         * The command's context stays at the top level, where it has always
         * been and where the prompt points. It is deliberately *not* repeated
         * inside a named block as well: a tool answer is stored in the
         * conversation up to `TOOL_RESULT_STORED_CHARS`, and a user with a
         * dozen rows selected and two forms open would push a duplicated
         * context past that limit — after which the stored answer is cut in the
         * middle of a value and stops parsing. `currentContext` sits beside it
         * and says in its own words which of the two it is.
         */
        return {
          ...commandContext,
          currentContext: currentContextOf(live, commandContext),
          filtersNote:
            'Stan widoku (zawezenie, sortowanie, strona) zmienia tylko to, co i w jakiej kolejnosci widac. Dane w bazie sa bez zmian.',
          note:
            'Pola na najwyzszym poziomie (spaceId, resource, selection, filters, unsavedDrafts, ui) to kontekst POLECENIA ' +
            'z chwili jego wyslania — one wyznaczaja cel tego zadania i nie zmieniaja sie w trakcie. currentContext mowi, ' +
            'co uzytkownik ma teraz na ekranie TEJ rozmowy. unsavedDrafts to NIEZAPISANY stan formularza uzytkownika: ' +
            'to nie sa dane zapisane w bazie i nie wolno ich traktowac jak faktow.',
          workspaceDir: ctx.workspaceDir,
        };
      },
    },
  ];
}

interface CommandContextShape {
  spaceId: string | null;
  resource: { kind: string; id: string } | null;
  selection: Array<{ kind: string; id: string }>;
  unsavedDrafts: Array<{ formId: string; entity: string; entityId: string | null; dirtyFields: string[] }>;
}

/**
 * The live half of the answer.
 *
 * A stale evaluation still carries whatever description was found — that is
 * `ui_state`'s rule and it holds here: something known to be old is more useful
 * than nothing, *provided* it is labelled. When there is no description at all
 * (`snapshot: null`), nothing is invented; the fields are null and the note says
 * the current context is unknown, which is a different statement from "nothing
 * is selected".
 */
function currentContextOf(live: UiStateResult | null, command: CommandContextShape) {
  if (!live) {
    return {
      known: false,
      stale: true,
      reason: 'no_conversation' as const,
      version: null,
      capturedAt: null,
      ageMs: null,
      spaceId: null,
      resource: null,
      selection: null,
      unsavedDrafts: null,
      changedSinceCommand: null,
      note: 'To wywolanie nie nalezy do rozmowy, wiec nie ma karty, ktora moglaby podac biezacy kontekst.',
    };
  }
  const snapshot = live.snapshot;
  if (!snapshot) {
    return {
      known: false,
      stale: true,
      reason: live.reason ?? 'no_client',
      version: null,
      capturedAt: null,
      ageMs: null,
      spaceId: null,
      resource: null,
      selection: null,
      unsavedDrafts: null,
      changedSinceCommand: null,
      note:
        'Zadna karta tej rozmowy nie podala biezacego kontekstu. NIE zakladaj, ze zaznaczenie i szkice sa ' +
        'takie jak w kontekscie polecenia — po prostu nie wiadomo, jakie sa teraz.',
    };
  }
  const context = snapshot.context;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const changed: string[] = [];
  if (!same(context.resource, command.resource)) changed.push('resource');
  if (!same(context.selection, command.selection)) changed.push('selection');
  if (!same(context.drafts, command.unsavedDrafts)) changed.push('drafts');
  if (snapshot.spaceId !== command.spaceId) changed.push('spaceId');
  return {
    known: true,
    stale: live.stale,
    ...(live.reason ? { reason: live.reason } : {}),
    version: live.version,
    capturedAt: live.capturedAt,
    ageMs: live.ageMs,
    clientId: snapshot.clientId,
    spaceId: snapshot.spaceId,
    resource: context.resource,
    selection: context.selection,
    unsavedDrafts: context.drafts,
    changedSinceCommand: changed,
    note: live.stale
      ? 'Ten opis nie jest potwierdzonym biezacym stanem (patrz reason) — nie opisuj go jako aktualnego.'
      : changed.length === 0
        ? 'Uzytkownik nie zmienil kontekstu od wyslania polecenia.'
        : `Od wyslania polecenia zmienilo sie: ${changed.join(', ')}. Cel zadania nadal wyznacza kontekst polecenia (pola najwyzszego poziomu).`,
  };
}
