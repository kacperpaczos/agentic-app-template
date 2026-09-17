import { z } from 'zod';
import {
  AGENT_VIEWS_SCOPE_KIND,
  AGENT_VIEWS_TARGET_ID,
  AppError,
  SHOW_VALUE_REFUSALS,
  formatFieldValue,
  recordIdOf,
  recordValue,
  recordsOf,
  rowMatchesFilter,
  type CanvasCard,
  type DataRecord,
  type ModuleToolDefinition,
  type ToolCallContext,
  type UiCommandResult,
} from '@platform/contracts';
import { prepareRead, runPreparedRead } from '../../registry/read-operations.ts';
import {
  candidateMatches,
  declaredFieldsOfKind,
  declaredRecordKinds,
  presentationCandidates,
  type DisplayedView,
  type PresentationCandidate,
} from '../../registry/record-presentation.ts';
import type { PlatformServices } from '../../services/index.ts';

/**
 * Showing the value of one field of one record — and saying truthfully whether
 * it was shown.
 *
 * **Why found and shown are two answers.** Reading a value from the backend and
 * pointing at it on the user's screen are different facts. A tool that found
 * the value and reported "shown" would let the agent say "look, here it is"
 * about a screen that shows something else — a filtered list without the
 * record, another page, another view. So the result keeps them apart: `found`
 * is the backend's answer, read for the signed-in owner before the browser is
 * asked for anything; `shown` is the client's acknowledgement that it
 * highlighted the cell of that record and field; `matchesBackend` compares what
 * the cell holds and says with what the backend returned.
 *
 * **Why the server chooses the place.** Which views and agent views render
 * records of the kind, whether they show the field, whether the record is in
 * them, and whether there is one such place or several, are all answerable from
 * declarations and reads (`registry/record-presentation.ts`). Each way this can
 * fail is its own answer (`SHOW_VALUE_REFUSALS`), given before the screen moves.
 */

/** A read's answer about one record, for one candidate place. */
type CandidateRead =
  | { candidate: PresentationCandidate; status: 'present'; record: DataRecord }
  | { candidate: PresentationCandidate; status: 'absent'; excludedBy?: 'composition_filter' }
  | { candidate: PresentationCandidate; status: 'forbidden'; message: string }
  | { candidate: PresentationCandidate; status: 'unreadable'; code: string; message: string };

const describeCandidate = (c: PresentationCandidate) => ({
  targetId: c.targetId,
  place: c.presentation.kind,
  label: c.label,
  ...(c.presentation.kind === 'view' ? { viewId: c.presentation.viewId } : { cardId: c.presentation.cardId }),
  operation: c.source.operation,
  fields: c.fields,
});

/** The cards of the run's conversation's agent views, or none. */
function agentViewCards(services: PlatformServices, ctx: ToolCallContext): CanvasCard[] {
  if (!ctx.conversationId) return [];
  const space = services.canvas.findScopedSpace(ctx.ownerId, AGENT_VIEWS_SCOPE_KIND, ctx.conversationId);
  return space ? services.canvas.getState(space.id, ctx.ownerId).cards : [];
}

/**
 * The record screen the tab bound to this run shows — the tab that
 * acknowledged the run's last UI command, else the one the command was sent
 * from — taken from its latest description, and only when that description is
 * current. A stale description may name a screen the user has left, and the
 * parameters of a screen nobody is looking at are not the server's to guess.
 */
function displayedView(services: PlatformServices, ctx: ToolCallContext): DisplayedView | null {
  const conversationId = ctx.conversationId ?? ctx.appContext.conversationId;
  if (!conversationId) return null;
  const ui = ctx.appContext.ui;
  const state = services.uiSnapshots.evaluate(ctx.ownerId, conversationId, {
    context: ui ? { clientId: ui.clientId, version: ui.version } : null,
    acknowledged: services.uiSnapshots.acknowledgement(ctx.ownerId, ctx.runId),
  });
  if (state.stale || !state.snapshot?.view) return null;
  const view = services.modules.view(state.snapshot.view.id)?.definition;
  return view?.params?.length ? { view, instances: state.snapshot.instances } : null;
}

export function uiShowValueTools(services: PlatformServices): Array<ModuleToolDefinition<any>> {
  return [
    {
      name: 'ui_show_value',
      description:
        'Pokazuje uzytkownikowi wartosc JEDNEGO pola JEDNEGO rekordu na ekranie: otwiera widok, w ktorym rekord jest ' +
        'wyswietlany, w razie potrzeby jawnie usuwa zawezenie, ktore go ukrywa, i przechodzi na jego strone, ' +
        'przewija do komorki i chwilowo ja podswietla. Najpierw znajdz rekord i jego identyfikator narzedziem ' +
        'modulu (to narzedzie nie szuka po nazwie). recordKind to rodzaj rekordu z deskryptora operacji odczytu, ' +
        'recordId — wartosc jego pola id jako tekst, field — pole z deskryptora. Wynik rozroznia found (backend ma ' +
        'rekord; backend.displayedText to jego wartosc) od shown (KLIENT potwierdzil, ze wskazal to pole) i podaje ' +
        'matchesBackend. Mow, ze pokazales wartosc, tylko gdy shown=true. adjustments opisuja zmiany prezentacji ' +
        '(dane sa bez zmian). Odmowy: unknown_field, no_renderer (nigdzie nie pokazuje sie takich rekordow albo tego ' +
        'pola), ambiguous (kilka miejsc — wybierz targetId z candidates), record_not_found, forbidden; po stronie ' +
        'klienta: inactive_conversation, not_present, not_visible, no_client.',
      effect: 'read',
      alwaysLoad: true,
      inputSchema: z.object({
        recordKind: z.string().max(80).describe('Rodzaj rekordu z deskryptora operacji odczytu, np. record.kind'),
        recordId: z.string().max(128).describe('Identyfikator rekordu (wartosc pola idField) jako tekst'),
        field: z.string().max(80).describe('Pole rekordu zadeklarowane w deskryptorze'),
        targetId: z
          .string()
          .max(200)
          .optional()
          .describe('Miejsce do wyboru przy niejednoznacznosci: targetId z candidates, id widoku albo karty'),
        reason: z.string().max(200).optional(),
      }),
      handler: async (
        input: { recordKind: string; recordId: string; field: string; targetId?: string; reason?: string },
        ctx: ToolCallContext,
      ) => {
        if (!ctx.requestUi) {
          throw new AppError('unsupported_operation', 'Brak polaczonego interfejsu dla tego uruchomienia.');
        }
        const { recordKind, recordId, field } = input;
        // Nothing was read or shown yet; every early answer says so.
        const base = { executed: false, found: false, shown: false, matchesBackend: null, recordKind, recordId, field };

        const declared = declaredFieldsOfKind(services.modules, recordKind);
        if (declared.length === 0) {
          return {
            ...base,
            reason: SHOW_VALUE_REFUSALS.noRenderer,
            detail: 'kind_not_declared',
            availableKinds: declaredRecordKinds(services.modules),
          };
        }
        const fieldDef = declared.find((f) => f.field === field);
        if (!fieldDef) {
          return {
            ...base,
            reason: SHOW_VALUE_REFUSALS.unknownField,
            available: declared.map((f) => ({ field: f.field, label: f.label, type: f.type })),
          };
        }

        const cards = agentViewCards(services, ctx);
        let pool = presentationCandidates({
          registry: services.modules,
          catalog: services.catalog.openui,
          recordKind,
          agentViewCards: cards,
          displayed: displayedView(services, ctx),
        });

        if (input.targetId !== undefined) {
          const everywhere = pool;
          pool = pool.filter((c) => candidateMatches(c, input.targetId!));
          if (pool.length === 0) {
            const known =
              input.targetId === AGENT_VIEWS_TARGET_ID ||
              services.modules.view(input.targetId) !== undefined ||
              services.modules.uiTargets().some((t) => t.id === input.targetId) ||
              cards.some((c) => c.id === input.targetId);
            return {
              ...base,
              reason: known ? SHOW_VALUE_REFUSALS.noRenderer : 'unknown_target',
              ...(known ? { detail: 'target_does_not_render_kind' } : {}),
              requested: input.targetId,
              candidates: everywhere.filter((c) => c.fields.includes(field)).map(describeCandidate),
            };
          }
        }
        if (pool.length === 0) {
          return { ...base, reason: SHOW_VALUE_REFUSALS.noRenderer, detail: 'kind_not_rendered' };
        }

        const showing = pool.filter((c) => c.fields.includes(field));
        if (showing.length === 0) {
          // Records of this kind are on screen somewhere, but never with this field.
          return {
            ...base,
            reason: SHOW_VALUE_REFUSALS.noRenderer,
            detail: 'field_not_shown',
            fieldLabel: fieldDef.label,
            shownIn: pool.map(describeCandidate),
          };
        }

        /*
         * The backend's answer, read as the signed-in owner, before the browser is
         * asked for anything — one read per distinct source. A place whose read
         * is refused is not a place the value can be shown in; a record the
         * composition's own filter leaves out is not drawn there either.
         */
        const reads = new Map<string, Promise<{ ok: true; records: DataRecord[] } | { ok: false; error: AppError }>>();
        const readOnce = (c: PresentationCandidate) => {
          const key = JSON.stringify([c.source.operation, c.source.input ?? {}]);
          if (!reads.has(key)) {
            reads.set(
              key,
              (async () => {
                try {
                  const response = await runPreparedRead(prepareRead(services.modules, c.source), ctx.ownerId);
                  return { ok: true as const, records: recordsOf(response.result, c.descriptor) };
                } catch (e) {
                  return { ok: false as const, error: AppError.from(e) };
                }
              })(),
            );
          }
          return reads.get(key)!;
        };
        const outcomes: CandidateRead[] = await Promise.all(
          showing.map(async (candidate): Promise<CandidateRead> => {
            const read = await readOnce(candidate);
            if (!read.ok) {
              const { code, message } = read.error;
              if (code === 'forbidden' || code === 'unauthenticated') return { candidate, status: 'forbidden', message };
              // The thing the read refers to is gone: nothing of it is drawn there.
              if (code === 'not_found') return { candidate, status: 'absent' };
              return { candidate, status: 'unreadable', code, message };
            }
            const record = read.records.find((r) => recordIdOf(r, candidate.descriptor) === recordId);
            if (!record) return { candidate, status: 'absent' };
            if (candidate.filter.length && !rowMatchesFilter(record, candidate.filter)) {
              return { candidate, status: 'absent', excludedBy: 'composition_filter' };
            }
            return { candidate, status: 'present', record };
          }),
        );

        const present = outcomes.filter((o): o is Extract<CandidateRead, { status: 'present' }> => o.status === 'present');
        const unreadable = outcomes
          .filter((o): o is Extract<CandidateRead, { status: 'unreadable' }> => o.status === 'unreadable')
          .map((o) => ({ ...describeCandidate(o.candidate), code: o.code, message: o.message }));
        if (present.length === 0) {
          const refused = outcomes.filter((o): o is Extract<CandidateRead, { status: 'forbidden' }> => o.status === 'forbidden');
          if (refused.length > 0) {
            return {
              ...base,
              reason: SHOW_VALUE_REFUSALS.forbidden,
              refused: refused.map((o) => ({ ...describeCandidate(o.candidate), message: o.message })),
              ...(unreadable.length ? { unreadable } : {}),
            };
          }
          return {
            ...base,
            reason: SHOW_VALUE_REFUSALS.recordNotFound,
            checked: outcomes.map((o) => ({
              ...describeCandidate(o.candidate),
              ...(o.status === 'absent' && o.excludedBy ? { excludedBy: o.excludedBy } : {}),
            })),
            ...(unreadable.length ? { unreadable } : {}),
          };
        }
        if (present.length > 1) {
          return {
            ...base,
            found: true,
            reason: SHOW_VALUE_REFUSALS.ambiguous,
            candidates: present.map((o) => describeCandidate(o.candidate)),
          };
        }

        const { candidate, record } = present[0]!;
        const shownField = candidate.descriptor.fields.find((f) => f.field === field)!;
        const backend = { rawValue: recordValue(record, field), displayedText: formatFieldValue(record, shownField) };
        const result: UiCommandResult = await ctx.requestUi({
          targetId: candidate.uiTargetId ?? (candidate.presentation.kind === 'view' ? candidate.presentation.viewId : AGENT_VIEWS_TARGET_ID),
          spaceId: null,
          reveal: { recordKind, recordId, field, presentation: candidate.presentation, source: candidate.source },
          reason: input.reason,
        });

        const revealed = result.revealed;
        const identifies =
          revealed !== undefined &&
          revealed.recordKind === recordKind &&
          revealed.recordId === recordId &&
          revealed.field === field;
        // Shown means the client says it pointed at *this* record's *this* field, in view.
        const shown = result.executed && result.highlighted === true && identifies;
        return {
          executed: result.executed,
          ...(result.reason ? { reason: result.reason } : result.executed && !shown ? { reason: 'not_confirmed' } : {}),
          found: true,
          shown,
          matchesBackend: shown
            ? revealed!.rawValue === backend.rawValue && revealed!.displayedText === backend.displayedText
            : null,
          recordKind,
          recordId,
          field,
          fieldLabel: shownField.label,
          target: describeCandidate(candidate),
          backend,
          ...(revealed ? { revealed } : {}),
          adjustments: revealed?.adjustments ?? [],
          highlighted: result.highlighted ?? false,
          url: result.url,
          // The screen's description after the change, and the tab it belongs to: pass both to ui_state.
          uiVersion: result.uiVersion,
          uiClientId: result.uiClientId,
          uiPublication: result.uiPublication,
        };
      },
    },
  ];
}
