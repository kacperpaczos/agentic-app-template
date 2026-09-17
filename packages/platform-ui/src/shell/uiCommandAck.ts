import {
  UI_COMMAND_ACK_MARGIN_MS,
  UI_COMMAND_ACK_TIMEOUT_MS,
  UI_COMMAND_FAILURES,
  type UiCommand,
  type UiCommandResult,
} from '@platform/contracts';
import type { UiSnapshotSession } from '../state/uiSnapshot.ts';

/** Less time than this left is not worth starting a publication in. */
const MIN_PUBLICATION_MS = 100;
/** How long the view must be quiet before it is described (see `UiSnapshotSession.flush`). */
const SETTLE_MS = 150;
const MAX_SETTLE_MS = 1500;

export interface UiCommandAckDeps {
  /** Carries the command out; `deadline` is when the acknowledgement must be on its way. */
  perform: (command: UiCommand, budget: { deadline: number }) => Promise<UiCommandResult>;
  session: Pick<UiSnapshotSession, 'flush'>;
  post: (runId: string, result: UiCommandResult) => Promise<unknown>;
  /** The server's wait for the acknowledgement; tests shorten both ends together. */
  budgetMs?: number;
  marginMs?: number;
}

/**
 * Performs one UI command and acknowledges it within the shared budget.
 *
 * The server waits `UI_COMMAND_ACK_TIMEOUT_MS` for the acknowledgement and then
 * reports `no_client`. So everything here — performing, letting the view settle,
 * publishing the description — is planned against one deadline set when the
 * command arrived, leaving `UI_COMMAND_ACK_MARGIN_MS` for posting. When the
 * budget runs out the acknowledgement goes without a version, saying so
 * (`uiPublication: 'timeout'`): a performed command reported as one nobody
 * answered would be a worse lie than a screen that is not described.
 */
export async function performAndAcknowledge(command: UiCommand, deps: UiCommandAckDeps): Promise<UiCommandResult> {
  const deadline = Date.now() + (deps.budgetMs ?? UI_COMMAND_ACK_TIMEOUT_MS) - (deps.marginMs ?? UI_COMMAND_ACK_MARGIN_MS);

  let result: UiCommandResult;
  try {
    result = await deps.perform(command, { deadline });
  } catch (e) {
    result = {
      commandId: command.commandId,
      targetId: command.targetId,
      executed: false,
      reason: e instanceof Error ? e.message.slice(0, 120) : 'error',
    };
  }

  /*
   * Publish the screen as it is after the command, and say which version of
   * which tab that is — once the view has settled, so the version names the
   * screen the command produced rather than the frame in between. A command
   * from another conversation changed nothing here and is not described.
   */
  if (result.reason === UI_COMMAND_FAILURES.inactiveConversation) {
    result = { ...result, uiPublication: 'skipped' };
  } else {
    const left = deadline - Date.now();
    if (left < MIN_PUBLICATION_MS) {
      result = { ...result, uiPublication: 'timeout' };
    } else {
      const publication = await deps.session.flush({
        settleMs: SETTLE_MS,
        maxSettleMs: Math.min(MAX_SETTLE_MS, Math.floor(left / 2)),
        deadlineAt: deadline,
      });
      result =
        publication.status === 'published'
          ? {
              ...result,
              uiVersion: publication.snapshot.version,
              uiClientId: publication.snapshot.clientId,
              uiPublication: 'published',
            }
          : { ...result, uiPublication: publication.status };
    }
  }

  try {
    await deps.post(command.runId, result);
  } catch {
    // The server times the command out on its own; a failed acknowledgement
    // becomes `no_client`, which is the truthful outcome.
  }
  return result;
}
