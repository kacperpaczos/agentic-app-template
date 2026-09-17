import {
  AppError,
  UI_CLIENT_INACTIVE_AFTER_MS,
  UI_SNAPSHOT_MAX_BYTES,
  uiSnapshotSchema,
  type UiSnapshot,
  type UiStateReason,
  type UiStateResult,
} from '@platform/contracts';

/**
 * The latest interface description of every open tab, per owner.
 *
 * **Why in memory.** A description is true only while the tab that published it
 * is showing that screen. Persisting it would let a restarted backend hand the
 * agent a screen from before the restart as if it were current. After a restart
 * the store is empty and a reader is told `no_client` until a tab publishes
 * again — which each tab does on its next change, command or heartbeat.
 *
 * **Why keyed by owner and tab.** The owner comes from the session of the
 * request that published, never from the description, so one owner can neither
 * read nor overwrite another's. Within an owner each tab (`clientId`) has its
 * own version counter, so **a version means something only together with its
 * tab**: a reader asking for "version N or newer" is answered about the tab N
 * belongs to — named explicitly, or the tab that acknowledged the run's last
 * UI command, or the tab the command was sent from — never about whichever tab
 * happens to have a larger number.
 *
 * **Which tabs count as open.** A closing tab retires its description
 * (`retire`); an open one says so every `UI_CLIENT_HEARTBEAT_MS` (`touch`). A
 * description whose tab has been silent for `UI_CLIENT_INACTIVE_AFTER_MS` — a
 * tab closed without a word, or one that signed in as somebody else — is still
 * returned, marked stale (`client_inactive`). A tab that says it shows a
 * newer version than the one held (its newer description was refused) keeps
 * its older description marked `superseded`.
 */

interface StoredSnapshot {
  snapshot: UiSnapshot;
  /** Server clock at acceptance. */
  receivedAt: number;
  /** Server clock of the tab's last publication or heartbeat. */
  seenAt: number;
  /**
   * A newer version the tab says it shows, which this backend does not have
   * (its publication was refused). Set, the stored description is not the
   * tab's screen any more.
   */
  supersededBy?: number;
  /** Serialised content without version and capture time, for idempotent re-publication. */
  contentKey: string;
}

interface OwnerState {
  /** By clientId; insertion order is least-recently-published first. */
  clients: Map<string, StoredSnapshot>;
  /** Readers waiting for the next publication or heartbeat. */
  waiters: Set<() => void>;
}

/** A version together with the tab it belongs to. */
export interface UiVersionRef {
  clientId: string;
  version: number;
}

/** What a reader asks for. */
export interface UiStateQuery {
  /** The tab asked about; `minVersion` then counts on its counter. */
  clientId?: string;
  minVersion?: number;
  /** The marker the run's command was sent with (`AppContext.ui`). */
  context?: UiVersionRef | null;
  /** The tab and version of the run's last acknowledged UI command. */
  acknowledged?: UiVersionRef | null;
}

/** Tabs remembered per owner; the least recently published is forgotten first. */
export const UI_SNAPSHOT_CLIENTS_PER_OWNER = 20;

const contentKeyOf = (s: UiSnapshot): string => {
  const { version: _v, capturedAt: _c, ...content } = s;
  return JSON.stringify(content);
};

export class UiSnapshotStore {
  readonly #owners = new Map<string, OwnerState>();
  /** runId → owner and the version its last UI command was acknowledged with. */
  readonly #acks = new Map<string, { ownerId: string } & UiVersionRef>();

  #owner(ownerId: string): OwnerState {
    let state = this.#owners.get(ownerId);
    if (!state) {
      state = { clients: new Map(), waiters: new Set() };
      this.#owners.set(ownerId, state);
    }
    return state;
  }

  #wake(owner: OwnerState): void {
    const waiters = [...owner.waiters];
    owner.waiters.clear();
    for (const wake of waiters) wake();
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
  publishRaw(ownerId: string, body: string): UiVersionRef {
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

  publish(ownerId: string, raw: unknown): UiVersionRef {
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
    const now = Date.now();

    if (previous && snapshot.version <= previous.snapshot.version) {
      if (snapshot.version === previous.snapshot.version && contentKey === previous.contentKey) {
        previous.seenAt = now;
        this.#wake(owner);
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
    owner.clients.set(snapshot.clientId, { snapshot, receivedAt: now, seenAt: now, contentKey });
    while (owner.clients.size > UI_SNAPSHOT_CLIENTS_PER_OWNER) {
      const oldest = owner.clients.keys().next().value as string;
      owner.clients.delete(oldest);
    }
    this.#wake(owner);
    return { version: snapshot.version, clientId: snapshot.clientId };
  }

  /**
   * The tab is still open, showing this version. False when the backend does
   * not hold that version of that tab — the tab should publish it again.
   *
   * A version newer than the one held is not a sign that the held description
   * is still right: the tab is alive, but its screen has moved on to something
   * this backend does not have, so the held description is marked superseded
   * rather than kept fresh.
   */
  touch(ownerId: string, clientId: string, version: number): boolean {
    const owner = this.#owners.get(ownerId);
    const stored = owner?.clients.get(clientId);
    if (!owner || !stored) return false;
    const held = stored.snapshot.version;
    if (version < held) return false;
    stored.seenAt = Date.now();
    if (version > held) stored.supersededBy = Math.max(stored.supersededBy ?? 0, version);
    this.#wake(owner);
    /*
     * A tab's versions only grow, so once it has said it shows something newer,
     * a word about the held version is a late message, not a vouch: the mark
     * stays until a newer description is accepted (which replaces the entry).
     */
    return version === held && stored.supersededBy === undefined;
  }

  /**
   * The tab closed. Its description goes, unless it has already published one
   * newer than `version` (the same tab, reloaded).
   */
  retire(ownerId: string, clientId: string, version: number): boolean {
    const owner = this.#owners.get(ownerId);
    const stored = owner?.clients.get(clientId);
    if (!owner || !stored || stored.snapshot.version > version) return false;
    owner.clients.delete(clientId);
    this.#wake(owner);
    return true;
  }

  /** The latest description of one tab of this owner. */
  forClient(ownerId: string, clientId: string): UiSnapshot | null {
    return this.#owners.get(ownerId)?.clients.get(clientId)?.snapshot ?? null;
  }

  /** Remembers which tab acknowledged a run's UI command, with which version. */
  recordAcknowledgement(ownerId: string, runId: string, ref: UiVersionRef): void {
    this.#acks.set(runId, { ownerId, ...ref });
  }

  acknowledgement(ownerId: string, runId: string | null): UiVersionRef | null {
    const ack = runId ? this.#acks.get(runId) : undefined;
    return ack && ack.ownerId === ownerId ? { clientId: ack.clientId, version: ack.version } : null;
  }

  forgetRun(runId: string): void {
    this.#acks.delete(runId);
  }

  /**
   * What a reader for `conversationId` is given, right now.
   *
   * **A version is bound to its tab.** When `minVersion` is asked for, it is
   * checked against the tab it belongs to: `clientId` if named, otherwise the
   * tab that acknowledged the run's last UI command, otherwise the tab the
   * command was sent from. That tab gone → `client_gone`; showing another
   * conversation → `other_conversation`. No other tab's larger number satisfies
   * it.
   *
   * Without a version to honour, the tab is chosen: the acknowledging or
   * sending tab while it shows the conversation and is alive, otherwise the
   * most recently publishing live tab showing it, otherwise the most recent
   * silent one (returned, marked `client_inactive`).
   *
   * The context's version is also a floor for its own tab: a description older
   * than what the user was looking at when they asked is stale.
   */
  evaluate(ownerId: string, conversationId: string, opts: UiStateQuery = {}): UiStateResult {
    const owner = this.#owners.get(ownerId);
    const context = opts.context ?? null;
    const acknowledged = opts.acknowledged ?? null;
    const now = Date.now();
    const alive = (s: StoredSnapshot) => now - s.seenAt <= UI_CLIENT_INACTIVE_AFTER_MS;
    const current = (s: StoredSnapshot) => alive(s) && s.supersededBy === undefined;
    const showing = (s: StoredSnapshot | undefined): s is StoredSnapshot =>
      Boolean(s && s.snapshot.conversationId === conversationId);

    const bound =
      opts.clientId ?? (opts.minVersion !== undefined ? (acknowledged?.clientId ?? context?.clientId) : undefined);

    let stored: StoredSnapshot | undefined;
    if (bound) {
      stored = owner?.clients.get(bound);
      // The tab the version belongs to is not open any more (or never reached this backend).
      if (!stored) return absent('client_gone');
      if (!showing(stored)) return absent('other_conversation');
    } else {
      if (!owner || owner.clients.size === 0) return absent('no_client');
      const preferred = [acknowledged?.clientId, context?.clientId]
        .map((id) => (id ? owner.clients.get(id) : undefined))
        .find((s) => showing(s) && current(s));
      const onConversation = [...owner.clients.values()].filter(showing).reverse();
      stored = preferred ?? onConversation.find(current) ?? onConversation.find(alive) ?? onConversation[0];
      if (!stored) return absent('other_conversation');
    }

    const { snapshot, receivedAt } = stored;
    const captured = Date.parse(snapshot.capturedAt);
    // Never younger than its arrival: a tab clock ahead of the server's must not make it look fresh.
    const since = Number.isFinite(captured) ? Math.min(captured, receivedAt) : receivedAt;
    const required = Math.max(
      opts.minVersion ?? 0,
      context && context.clientId === snapshot.clientId ? context.version : 0,
    );
    const reason: UiStateReason | undefined = !alive(stored)
      ? 'client_inactive'
      : stored.supersededBy !== undefined
        ? 'superseded'
        : snapshot.version < required
          ? 'older_than_requested'
          : undefined;
    // The verdict first, the description last: whoever reads the start knows whether to trust the rest.
    return {
      stale: reason !== undefined,
      ...(reason ? { reason } : {}),
      version: snapshot.version,
      capturedAt: snapshot.capturedAt,
      ageMs: Math.max(0, now - since),
      snapshot,
    };
  }

  /**
   * Resolves on this owner's next publication or heartbeat, or after
   * `timeoutMs`. Resolves `true` when something arrived.
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
   * Waits, up to `waitMs`, until the evaluation for the conversation is not
   * stale; returns the last evaluation either way. Without a wait it is a
   * single evaluation.
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

const absent = (reason: UiStateReason): UiStateResult => ({
  stale: true,
  reason,
  version: null,
  capturedAt: null,
  ageMs: null,
  snapshot: null,
});
