import type { QueryClient } from '@tanstack/react-query';
import { PLATFORM_CUSTOM_EVENTS, uiCommandSchema, type UiCommand } from '@platform/contracts';
import { invalidateBusinessData, qk } from '../api/queries.ts';
import { useAppState } from '../state/appState.ts';

/**
 * The component that performs interface commands, when one is mounted.
 *
 * A function reference rather than an import, because the reducer is pure
 * plumbing and the executor needs the router. Null when no interface is
 * mounted — in which case nothing acknowledges, and the server's own timeout
 * reports `no_client`, which is exactly right.
 */
let uiCommandHandler: ((command: UiCommand) => void) | null = null;

export function setUiCommandHandler(handler: ((command: UiCommand) => void) | null): void {
  uiCommandHandler = handler;
}

/**
 * Applies one AG-UI event to the client's record of a run.
 *
 * Deliberately separate from the stream adapter, and deliberately taking the
 * conversation id as an argument, because the same reduction has to serve two
 * callers that reach it by different routes:
 *
 *  - the response to `POST /api/agui/run`, tapped as the ready-made chat parses
 *    it (`platformAdapter.ts`);
 *  - a re-attached background stream from `GET /api/runs/:id/stream`
 *    (`runStreams.ts`), which is how a run that outlived its socket gets back
 *    into the interface.
 *
 * Both must produce the same state, and neither may write into whichever
 * conversation happens to be on screen — a run belongs to *its* conversation.
 * That is why nothing here reads `conversationId` from the store.
 *
 * `isActive` says whether the user is currently looking at this conversation.
 * It changes exactly one thing: a run that resolves while they are elsewhere is
 * marked `unseenResult`, so the interface can mention it without dragging them
 * out of what they are doing.
 */
export function applyRunEvent(
  conversationId: string,
  event: Record<string, unknown>,
  ctx: { qc: QueryClient; isActive: () => boolean },
): void {
  const store = useAppState.getState();
  const patch = (p: Parameters<typeof store.patchRun>[1]) => store.patchRun(conversationId, p);
  const current = () => useAppState.getState().runFor(conversationId);

  switch (event.type) {
    case 'RUN_STARTED': {
      const runId = typeof event.runId === 'string' ? event.runId : null;
      if (runId) store.setLastRunId(runId);
      patch({
        phase: 'running',
        runId,
        activeTool: null,
        streamingText: '',
        errorCode: null,
        errorMessage: null,
        pendingPermission: null,
        unseenResult: false,
      });
      return;
    }

    case 'TEXT_MESSAGE_CONTENT': {
      const delta = typeof event.delta === 'string' ? event.delta : '';
      if (delta) patch({ streamingText: current().streamingText + delta });
      return;
    }

    case 'TOOL_CALL_START':
      patch({ activeTool: String(event.toolCallName ?? '') });
      return;

    case 'TOOL_CALL_RESULT':
      patch({ activeTool: null });
      return;

    case 'RUN_FINISHED':
    case 'RUN_ERROR': {
      /*
       * The terminal phase comes from the terminal event, not from whether an
       * answer appeared. A cancellation announces itself first through the
       * `run_cancelled` CUSTOM event, so a RUN_ERROR that follows it must not
       * overwrite `cancelled` with `failed`.
       */
      const wasCancelled = current().phase === 'cancelled';
      if (event.type === 'RUN_FINISHED') {
        // The ready-made thread now owns the committed answer; drop our preview
        // so the same text is never on screen twice.
        patch({
          phase: 'succeeded',
          activeTool: null,
          streamingText: '',
          pendingPermission: null,
          unseenResult: !ctx.isActive(),
        });
      } else if (!wasCancelled) {
        patch({
          phase: 'failed',
          activeTool: null,
          streamingText: '',
          pendingPermission: null,
          errorCode: typeof event.code === 'string' ? event.code : null,
          errorMessage: typeof event.message === 'string' ? event.message : null,
          unseenResult: !ctx.isActive(),
        });
      }

      // Final safety net: refresh anything the run might have touched without
      // announcing it. Cheap, and it guarantees the UI is never stale after a run.
      void ctx.qc.invalidateQueries({ queryKey: ['canvas'] });
      invalidateBusinessData(ctx.qc);
      void ctx.qc.invalidateQueries({ queryKey: ['artifacts'] });
      void ctx.qc.invalidateQueries({ queryKey: ['artifact'] });
      void ctx.qc.invalidateQueries({ queryKey: ['files'] });
      return;
    }
  }

  if (event.type !== 'CUSTOM') return;
  const name = event.name as string;
  const value = (event.value ?? {}) as Record<string, unknown>;

  switch (name) {
    case PLATFORM_CUSTOM_EVENTS.canvasChanged: {
      const spaceId = value.spaceId as string | undefined;
      if (spaceId) void ctx.qc.invalidateQueries({ queryKey: qk.space(spaceId) });
      break;
    }
    case PLATFORM_CUSTOM_EVENTS.dataChanged:
      // Business data changed through a tool: refresh module reads and
      // registered reads (every data component), any canvas card that derives
      // from them, and every open artifact — a live artifact re-runs its query
      // on read, so invalidating it is what makes an open report reflect the
      // mutation that just happened.
      invalidateBusinessData(ctx.qc);
      void ctx.qc.invalidateQueries({ queryKey: ['canvas'] });
      void ctx.qc.invalidateQueries({ queryKey: ['artifact'] });
      break;
    case PLATFORM_CUSTOM_EVENTS.artifactCreated:
      void ctx.qc.invalidateQueries({ queryKey: ['artifacts'] });
      void ctx.qc.invalidateQueries({ queryKey: ['files'] });
      // An open artifact view must re-read too: a new version of the one being
      // looked at is the case where a stale panel is most misleading.
      void ctx.qc.invalidateQueries({ queryKey: ['artifact'] });
      break;
    case PLATFORM_CUSTOM_EVENTS.sessionBound: {
      const bound = value.conversationId as string | undefined;
      if (bound) void ctx.qc.invalidateQueries({ queryKey: qk.conversation(bound) });
      break;
    }
    case PLATFORM_CUSTOM_EVENTS.permissionRequest:
      // Recorded against this run's conversation, not the one on screen: a
      // consent prompt belongs where the work is.
      patch({
        phase: 'awaiting_consent',
        pendingPermission: {
          requestId: String(value.requestId),
          toolName: String(value.toolName),
          input: String(value.input ?? ''),
          runId: String(value.runId ?? ''),
        },
        unseenResult: !ctx.isActive(),
      });
      break;
    case PLATFORM_CUSTOM_EVENTS.uiCommand: {
      /*
       * Handed on exactly as received, including the conversation it came
       * from — the executor refuses a command from a conversation the user is
       * not watching, and can only do that if it knows which one that is.
       */
      const parsed = uiCommandSchema.safeParse(value);
      if (parsed.success && uiCommandHandler) uiCommandHandler(parsed.data);
      break;
    }
    case PLATFORM_CUSTOM_EVENTS.runCancelled:
      patch({ phase: 'cancelled', activeTool: null, pendingPermission: null });
      break;
    default:
      break;
  }
}
