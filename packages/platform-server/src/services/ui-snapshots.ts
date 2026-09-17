import {
  AppError,
  UI_SNAPSHOT_MAX_BYTES,
  uiSnapshotSchema,
  type UiSnapshot,
  type UiStateResult,
} from '@platform/contracts';

/**
 * The latest interface description of every open tab, per owner.
 *
 * **Why in memory.** A description is true only while the tab that published it
 * is showing that screen. Persisting it would let a restarted backend hand the
 * agent a screen from before the restart as if it were current. After a restart
 * the store is empty and a reader is told `no_client` until a tab publishes
 * again, which each tab does on its next change or command.
 *
 * **Why keyed by owner and tab.** The owner comes from the session of the
 * request that published, never from the description, so one owner can neither
 * read nor overwrite another's. Within an owner each tab (`clientId`) has its
 * own version counter; a reader for a conversation is given the tab showing it
 * — preferring the tab the command was sent from, otherwise the one that
 * published most recently.
 *
 * What it does not know: whether a tab is still open. A closed tab's last
 * description stays until the owner's newer tabs push it out; `ageMs` is
 * reported so the reader can see how long nothing has changed.
 */

interface StoredSnapshot {
  snapshot: UiSnapshot;
  /** Server clock at acceptance. */
  receivedAt: number;
  /** Serialised content without version and capture time, for idempotent re-publication. */
  contentKey: string;
}

interface OwnerState {
  /** By clientId; insertion order is least-recently-published first. */
  clients: Map<string, StoredSnapshot>;
  /** conversationId → the tab that most recently published a description showing it. */
  byConversation: Map<string, string>;
  /** Readers waiting for the next publication. */
  waiters: Set<() => void>;
}

/** What a reader asks for. */
export interface UiStateQuery {
  minVersion?: number;
  /** The marker the run's command was sent with. */
  context?: { clientId: string; version: number } | null;
}

/** Tabs remembered per owner; the least recently published is forgotten first. */
export const UI_SNAPSHOT_CLIENTS_PER_OWNER = 20;

const contentKeyOf = (s: UiSnapshot): string => {
  const { version: _v, capturedAt: _c, ...content } = s;
  return JSON.stringify(content);
};

export class UiSnapshotStore {
  readonly #owners = new Map<string, OwnerState>();

  #owner(ownerId: string): OwnerState {
    let state = this.#owners.get(ownerId);
    if (!state) {
      state = { clients: new Map(), byConversation: new Map(), waiters: new Set() };
      this.#owners.set(ownerId, state);
    }
    return state;
  }

  /**
   * Accepts a tab's description, from its serialised body.
   *
   * Refused: a body over the size limit, a description the contract rejects,
   * and a version that does not advance the tab's counter — unless it is the
   * very description already stored (a retried publication), which is accepted
   * without change. A tab whose version goes backwards is not the tab that
   * published before it: typically a duplicated browser tab carrying a copied
   * identity, which is told so (`conflict`) and takes a new one.
   */
  publishRaw(ownerId: string, body: string): { version: number; clientId: string } {
    if (Buffer.byteLength(body, 'utf8') > UI_SNAPSHOT_MAX_BYTES) {
      throw new AppError('validation_failed', `Opis interfejsu przekracza ${UI_SNAPSHOT_MAX_BYTES} bajtow.`, {
        reason: 'too_large',
        limit: UI_SNAPSHOT_MAX_BYTES,
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new AppError('validation_failed', 'Opis interfejsu nie jest poprawnym JSON.', { reason: 'invalid_json' });
    }
    return this.publish(ownerId, raw);
  }

  publish(ownerId: string, raw: unknown): { version: number; clientId: string } {
    const parsed = uiSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError('validation_failed', 'Nieprawidlowy opis interfejsu.', {
        reason: 'invalid_snapshot',
        issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const snapshot = parsed.data;
    const owner = this.#owner(ownerId);
    const previous = owner.clients.get(snapshot.clientId);
    const contentKey = contentKeyOf(snapshot);

    if (previous && snapshot.version <= previous.snapshot.version) {
      if (snapshot.version === previous.snapshot.version && contentKey === previous.contentKey) {
        return { version: snapshot.version, clientId: snapshot.clientId };
      }
      throw new AppError(
        'conflict',
        `Wersja ${snapshot.version} opisu interfejsu nie jest nowsza niz ${previous.snapshot.version} dla tej karty przegladarki.`,
        { reason: 'version_not_newer', current: previous.snapshot.version },
      );
    }

    // Re-inserted so the map's order is the order of publication.
    owner.clients.delete(snapshot.clientId);
    owner.clients.set(snapshot.clientId, { snapshot, receivedAt: Date.now(), contentKey });
    while (owner.clients.size > UI_SNAPSHOT_CLIENTS_PER_OWNER) {
      const oldest = owner.clients.keys().next().value as string;
      owner.clients.delete(oldest);
    }
    this.#reindex(owner);

    const waiters = [...owner.waiters];
    owner.waiters.clear();
    for (const wake of waiters) wake();
    return { version: snapshot.version, clientId: snapshot.clientId };
  }

  /** Rebuilds conversation → latest tab from what each tab shows now. */
  #reindex(owner: OwnerState): void {
    owner.byConversation.clear();
    for (const [clientId, stored] of owner.clients) {
      const conversationId = stored.snapshot.conversationId;
      // Later entries were published later, so they overwrite earlier ones.
      if (conversationId) owner.byConversation.set(conversationId, clientId);
    }
  }

  /** The latest description of one tab of this owner. */
  forClient(ownerId: string, clientId: string): UiSnapshot | null {
    return this.#owners.get(ownerId)?.clients.get(clientId)?.snapshot ?? null;
  }

  /**
   * What a reader for `conversationId` is given, right now.
   *
   * `context` is the marker the run's command was sent with (`AppContext.ui`).
   * Its tab wins while it still shows the conversation; otherwise the tab that
   * most recently published a description of it. The required version is
   * `minVersion`, raised to the context's version when the chosen tab is the
   * one the command came from — a description older than what the user was
   * looking at when they asked is stale whether or not the reader said so.
   * Versions count per tab, so neither applies across tabs by accident: the
   * context's only to its own tab, `minVersion` to whichever tab is chosen.
   */
  evaluate(
    ownerId: string,
    conversationId: string,
    opts: UiStateQuery = {},
  ): UiStateResult {
    const owner = this.#owners.get(ownerId);
    if (!owner || owner.clients.size === 0) return absent('no_client');

    const context = opts.context ?? null;
    const preferred = context ? owner.clients.get(context.clientId) : undefined;
    const indexed = owner.byConversation.get(conversationId);
    const stored =
      preferred && preferred.snapshot.conversationId === conversationId
        ? preferred
        : indexed
          ? owner.clients.get(indexed)
          : undefined;
    if (!stored) return absent('other_conversation');

    const { snapshot, receivedAt } = stored;
    const captured = Date.parse(snapshot.capturedAt);
    // Never younger than its arrival: a tab clock ahead of the server's must not make it look fresh.
    const since = Number.isFinite(captured) ? Math.min(captured, receivedAt) : receivedAt;
    const required = Math.max(
      opts.minVersion ?? 0,
      context && context.clientId === snapshot.clientId ? context.version : 0,
    );
    const older = snapshot.version < required;
    // The verdict first, the description last: whoever reads the start knows whether to trust the rest.
    return {
      stale: older,
      ...(older ? { reason: 'older_than_requested' as const } : {}),
      version: snapshot.version,
      capturedAt: snapshot.capturedAt,
      ageMs: Math.max(0, Date.now() - since),
      snapshot,
    };
  }

  /**
   * Resolves on this owner's next publication, or after `timeoutMs`.
   * Resolves `true` when something was published.
   */
  nextPublication(ownerId: string, timeoutMs: number): Promise<boolean> {
    const owner = this.#owner(ownerId);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wake = () => {
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      owner.waiters.add(wake);
      timer = setTimeout(() => {
        owner.waiters.delete(wake);
        resolve(false);
      }, Math.max(0, timeoutMs));
    });
  }

  /**
   * Waits, up to `waitMs`, until the evaluation for the conversation is a
   * description at least `minVersion` new; returns the last evaluation either
   * way. Without a wait it is a single evaluation.
   */
  async waitFor(
    ownerId: string,
    conversationId: string,
    opts: UiStateQuery & { waitMs: number },
  ): Promise<UiStateResult> {
    const deadline = Date.now() + Math.max(0, opts.waitMs);
    for (;;) {
      const result = this.evaluate(ownerId, conversationId, opts);
      if (!result.stale) return result;
      const left = deadline - Date.now();
      if (left <= 0) return result;
      await this.nextPublication(ownerId, left);
    }
  }
}

const absent = (reason: 'no_client' | 'other_conversation'): UiStateResult => ({
  stale: true,
  reason,
  version: null,
  capturedAt: null,
  ageMs: null,
  snapshot: null,
});
