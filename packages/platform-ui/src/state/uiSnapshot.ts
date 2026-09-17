import {
  AppError,
  UI_SNAPSHOT_CARDS_LIMIT,
  UI_SNAPSHOT_INSTANCES_LIMIT,
  UI_SNAPSHOT_MAX_BYTES,
  compositionVersionOf,
  type AppContext,
  type CanvasState,
  type SemanticInstance,
  type UiSnapshot,
  type UiTarget,
  type ViewDefinition,
} from '@platform/contracts';
import { accessScope } from '../api/accessContext.ts';
import { apiPut } from '../api/client.ts';

/**
 * This tab's versioned description of its screen, and its publication.
 *
 * **What goes in.** Only what the application already states about itself:
 * the descriptions the mounted data components registered (`uiSemantics`), the
 * address, the conversation and space the shell holds, and three things the
 * query cache holds anyway — the catalog of targets, the module views and the
 * active space's cards. Nothing is read from the markup and nothing is fetched
 * for the purpose: what the tab has not loaded is described as unknown.
 *
 * **When the version moves.** Only when the description changes — the same
 * screen assembled twice is the same version, so a reader waiting for "newer
 * than N" is woken by a change, not by a re-render. The counter belongs to the
 * tab (`clientId`, kept in `sessionStorage` so a reload continues it) and is
 * saved with it, so it never goes backwards for the same identity.
 *
 * **When it is published.** A short while after the last change (debounced),
 * and immediately — awaited — before the tab acknowledges a UI command or sends
 * a command, so the version those carry is one the backend already has.
 */

export type UiSnapshotContent = Omit<UiSnapshot, 'version' | 'clientId' | 'capturedAt'>;

export interface UiSnapshotInput {
  /** Path and query, as in the address bar. */
  url: string;
  pathname: string;
  conversationId: string | null;
  spaceId: string | null;
  instances: readonly SemanticInstance[];
  /** The catalog, when loaded. */
  targets: readonly UiTarget[] | undefined;
  /** Module views, when loaded. */
  views: readonly ViewDefinition[] | undefined;
  /** The active space's cards, when loaded. */
  canvas: CanvasState | undefined;
}

/** Room left for version, identity and capture time under the size limit. */
const ENVELOPE_BYTES = 1024;

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** Assembles the description of one screen. Pure: the same input, the same description. */
export function buildUiSnapshotContent(input: UiSnapshotInput): UiSnapshotContent {
  /*
   * The screen's target: the catalog entry whose route is this path. Several
   * entries can share a route (a view and an element on it); the view is the
   * screen, the others are places on it.
   */
  const onRoute = (input.targets ?? []).filter((t) => t.to === input.pathname);
  const target = onRoute.find((t) => t.kind === 'view') ?? onRoute[0] ?? null;

  const views = new Map((input.views ?? []).map((v) => [v.id, v]));
  const targetView = target ? (views.get(target.id) ?? null) : null;
  /*
   * A screen whose route is not a catalog path (a record's own screen) is still
   * a view when its components say which one they belong to.
   */
  const view =
    targetView ??
    input.instances.map((i) => (i.viewId ? views.get(i.viewId) : undefined)).find((v) => v !== undefined) ??
    null;

  const spaceCards =
    input.spaceId && input.canvas && input.canvas.space.id === input.spaceId ? input.canvas.cards : null;

  let instances = input.instances.slice(0, UI_SNAPSHOT_INSTANCES_LIMIT);
  let instancesOmitted = input.instances.length - instances.length;

  const content = (): UiSnapshotContent => ({
    conversationId: input.conversationId,
    spaceId: input.spaceId,
    url: input.url,
    target: target ? { id: target.id, kind: target.kind, label: target.label } : null,
    view: view ? { id: view.id, title: view.title, compositionVersion: compositionVersionOf(view.composition) } : null,
    cards: spaceCards
      ? spaceCards.slice(0, UI_SNAPSHOT_CARDS_LIMIT).map((c) => ({
          cardId: c.id,
          title: c.title,
          kind: c.spec.kind,
          component: c.spec.kind === 'component' ? c.spec.component : 'openui',
          specVersion: c.specVersion,
        }))
      : null,
    cardsOmitted: spaceCards ? Math.max(0, spaceCards.length - UI_SNAPSHOT_CARDS_LIMIT) : 0,
    instances,
    instancesOmitted,
    /*
     * What the interface commands can do to this screen. Narrowing and ordering
     * address the screen's own target, so they are offered only where there is
     * one that declares them.
     */
    actions: [
      'navigate',
      ...(target?.filter ? ['filter'] : []),
      ...(targetView?.primaryOperation ? ['sort'] : []),
    ],
  });

  let built = content();
  // Too large to publish: leave descriptions out from the end, and say how many.
  while (instances.length > 0 && byteLength(JSON.stringify(built)) > UI_SNAPSHOT_MAX_BYTES - ENVELOPE_BYTES) {
    instances = instances.slice(0, -1);
    instancesOmitted += 1;
    built = content();
  }
  return built;
}

/* -------------------------------------------------------------------------- */
/*  The tab's identity                                                        */
/* -------------------------------------------------------------------------- */

export interface UiClientIdentity {
  clientId: string;
  /** Last version assigned under this identity. */
  version: number;
}

export interface UiClientIdentityStore {
  load(): UiClientIdentity | null;
  save(identity: UiClientIdentity): void;
}

const IDENTITY_KEY = 'platform.ui-snapshot.client';

/**
 * `sessionStorage`: one identity per tab, surviving a reload of that tab. Every
 * access may throw (storage disabled, private mode, quota) and is contained —
 * the identity then lives in memory for the life of the page, and a reload
 * starts a new one, which is still correct: a new tab identity with a new
 * counter.
 */
export function sessionIdentityStore(): UiClientIdentityStore {
  return {
    load() {
      try {
        const raw = globalThis.sessionStorage?.getItem(IDENTITY_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<UiClientIdentity>;
        if (typeof parsed.clientId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(parsed.clientId) &&
            Number.isInteger(parsed.version) && (parsed.version as number) >= 0) {
          return { clientId: parsed.clientId, version: parsed.version as number };
        }
      } catch {
        /* unavailable or unreadable: a new identity below */
      }
      return null;
    },
    save(identity) {
      try {
        globalThis.sessionStorage?.setItem(IDENTITY_KEY, JSON.stringify(identity));
      } catch {
        /* kept in memory by the session */
      }
    },
  };
}

export function newUiClientId(): string {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  return `ui_${random.slice(0, 24)}`;
}

/* -------------------------------------------------------------------------- */
/*  The session                                                               */
/* -------------------------------------------------------------------------- */

export interface UiSnapshotSessionOptions {
  identity?: UiClientIdentityStore;
  /** Sends one description; rejects with `AppError('conflict')` when the backend refuses its version. */
  send: (snapshot: UiSnapshot) => Promise<unknown>;
  debounceMs?: number;
  /** Who is signed in: a description published under another identity is a new one. */
  scope?: () => string;
}

export interface UiSnapshotFlushOptions {
  /**
   * Wait until nothing the description depends on has changed for this long
   * (and no component is still loading), before capturing. For the moment
   * right after a command changed the screen.
   */
  settleMs?: number;
  /** Upper bound on that wait. */
  maxSettleMs?: number;
  /** Upper bound on waiting for the backend to accept. */
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class UiSnapshotSession {
  readonly #store: UiClientIdentityStore;
  readonly #send: (snapshot: UiSnapshot) => Promise<unknown>;
  readonly #debounceMs: number;
  readonly #scope: () => string;
  #identity: UiClientIdentity;
  #source: (() => UiSnapshotContent) | null = null;
  #current: UiSnapshot | null = null;
  #currentKey: string | null = null;
  #published: UiSnapshot | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #lastChangeAt = 0;

  constructor(opts: UiSnapshotSessionOptions) {
    this.#store = opts.identity ?? sessionIdentityStore();
    this.#send = opts.send;
    this.#debounceMs = opts.debounceMs ?? 250;
    this.#scope = opts.scope ?? accessScope;
    this.#identity = this.#store.load() ?? { clientId: newUiClientId(), version: 0 };
    this.#store.save(this.#identity);
  }

  get clientId(): string {
    return this.#identity.clientId;
  }

  /** Where descriptions come from; the shell's publisher installs it while mounted. */
  setSource(source: (() => UiSnapshotContent) | null): void {
    this.#source = source;
    if (!source && this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** The latest description assembled, published or not. */
  current(): UiSnapshot | null {
    return this.#current;
  }

  /** The latest description the backend accepted. */
  published(): UiSnapshot | null {
    return this.#published;
  }

  /** What a command carries about the screen it was sent from (`AppContext.ui`). */
  contextMarker(): AppContext['ui'] {
    const s = this.#current;
    return s ? { version: s.version, clientId: s.clientId, viewId: s.view?.id ?? null, url: s.url } : null;
  }

  /**
   * Assembles the description now. A new version only when it differs from the
   * current one — or was signed in under someone else.
   */
  capture(): UiSnapshot | null {
    if (!this.#source) return this.#current;
    const content = this.#source();
    const key = `${this.#scope()}|${JSON.stringify(content)}`;
    if (this.#current && this.#current.clientId === this.#identity.clientId && key === this.#currentKey) {
      return this.#current;
    }
    this.#identity = { clientId: this.#identity.clientId, version: this.#identity.version + 1 };
    this.#store.save(this.#identity);
    this.#currentKey = key;
    this.#current = {
      version: this.#identity.version,
      clientId: this.#identity.clientId,
      capturedAt: new Date().toISOString(),
      ...content,
    };
    return this.#current;
  }

  /** Something the description depends on changed: capture and publish once things are quiet. */
  changed(): void {
    this.#lastChangeAt = Date.now();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.capture();
      void this.#publishCurrent();
    }, this.#debounceMs);
  }

  /**
   * Captures and publishes now, and resolves with the description the backend
   * accepted — or null when it did not within `timeoutMs`.
   */
  async flush(opts: UiSnapshotFlushOptions = {}): Promise<UiSnapshot | null> {
    const settleMs = opts.settleMs ?? 0;
    if (settleMs > 0) {
      const started = Date.now();
      const maxSettleMs = opts.maxSettleMs ?? 1500;
      for (;;) {
        const now = Date.now();
        const quiet = now - Math.max(this.#lastChangeAt, started) >= settleMs;
        const loading = this.#source?.().instances.some((i) => i.state === 'loading') ?? false;
        if ((quiet && !loading) || now - started >= maxSettleMs) break;
        await sleep(Math.min(settleMs, 50));
      }
    }
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.capture();
    const publication = this.#publishCurrent();
    const timeoutMs = opts.timeoutMs ?? 2000;
    return Promise.race([publication, sleep(timeoutMs).then(() => null)]);
  }

  /**
   * Publishes the current description, one publication at a time, so the
   * backend receives this tab's versions in order.
   */
  #publishCurrent(): Promise<UiSnapshot | null> {
    const run = this.#chain.then(async () => {
      const snapshot = this.#current;
      if (!snapshot) return null;
      const done = this.#published;
      if (done && done.clientId === snapshot.clientId && done.version === snapshot.version) return snapshot;
      try {
        await this.#send(snapshot);
        this.#published = snapshot;
        return snapshot;
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'conflict')) return null;
        /*
         * The backend already has a newer version under this identity: another
         * tab carries it (a duplicated tab copies `sessionStorage`). This tab
         * takes a new identity and publishes the same description as its first.
         */
        this.#identity = { clientId: newUiClientId(), version: 1 };
        this.#store.save(this.#identity);
        const renewed: UiSnapshot = { ...snapshot, clientId: this.#identity.clientId, version: 1 };
        if (this.#current === snapshot) {
          this.#current = renewed;
        } else if (this.#current) {
          // A newer description was assembled meanwhile: it follows under the new identity.
          this.#identity = { clientId: this.#identity.clientId, version: 2 };
          this.#store.save(this.#identity);
          this.#current = { ...this.#current, clientId: this.#identity.clientId, version: 2 };
        }
        try {
          await this.#send(renewed);
          this.#published = renewed;
          return renewed;
        } catch {
          return null;
        }
      }
    });
    this.#chain = run.catch(() => null);
    return run;
  }
}

/** This tab's session. */
export const uiSnapshotSession = new UiSnapshotSession({
  send: (snapshot) => apiPut('/api/ui/snapshot', snapshot),
});
