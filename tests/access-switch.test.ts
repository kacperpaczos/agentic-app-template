import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGUI_EVENTS } from '@platform/contracts';
import {
  AccessContextChanged,
  accessFetch,
  requestFailureMessage,
  createChatStorage,
  platformAguiAdapter,
  qk,
  resetAccessContext,
  setAccessContext,
  useAppState,
} from '@platform/ui';

/**
 * What a change of identity has to abandon, beyond the query cache.
 *
 * `access-context.test.ts` covers the cache and the requests that go through
 * `api()`. Everything here is what did **not** go through it and therefore
 * survived a switch: the request the ready-made chat makes for its own threads,
 * a file upload, the run stream that keeps delivering for minutes after its
 * request resolved, and the client store that describes the work on screen.
 *
 * The interesting case in each is the late one — a response or an event that
 * lands *after* the switch. A cache that is empty at the moment of the switch
 * says nothing about it.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAccessContext();
});

/** A fetch that resolves only when the test releases it. */
function deferredFetch(payload: unknown) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const calls: Array<{ url: string; signal?: AbortSignal | null }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), signal: init.signal });
    await gate;
    if (init.signal?.aborted) throw init.signal.reason ?? new Error('aborted');
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { release, calls };
}

describe('accessFetch wiaze z kontekstem dostepu to, co nie przechodzi przez api()', () => {
  it('zadanie w locie jest przerywane w momencie przelaczenia', async () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    const { release, calls } = deferredFetch({ threads: [{ id: 'cnv_poprzedniego' }] });

    const settled = accessFetch('/api/threads/get').then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    );

    setAccessContext(qc, 'other-user');
    expect(calls[0]?.signal?.aborted, 'zadanie watkow nie zostalo przerwane').toBe(true);

    release();
    const result = await settled;
    expect(result.ok, 'odpowiedz dla poprzedniej tozsamosci zostala przyjeta').toBe(false);
  });

  it('odpowiedz, ktora mimo wszystko dobiegnie, jest odrzucana po epoce', async () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');

    // A fetch that ignores the abort signal — the worst case, and the reason
    // the epoch check exists beside the signal.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    globalThis.fetch = (async () => {
      await gate;
      return new Response('{"id":"file_poprzedniego"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const settled = accessFetch('/api/files', { method: 'POST' }).then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e }),
    );
    setAccessContext(qc, 'other-user');
    release();

    const result = await settled;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.e).toBeInstanceOf(AccessContextChanged);
  });

  it('bez zmiany kontekstu odpowiedz dociera normalnie', async () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');
    const { release } = deferredFetch({ threads: [] });
    const settled = accessFetch('/api/threads/get');
    release();
    const res = await settled;
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ threads: [] });
  });
});

describe('przerwane zadanie nie zostawia komunikatu dla nastepnego wlasciciela', () => {
  /*
   * The upload controls keep their failure in a local `useState` that no reset
   * reaches, so a message written there outlives the identity it belonged to.
   * The rule is one function precisely so it cannot be applied in one control
   * and forgotten in the other.
   */
  it('AccessContextChanged nie ma nic do powiedzenia nowemu wlascicielowi', () => {
    expect(requestFailureMessage(new AccessContextChanged())).toBeNull();
  });

  it('kazdy inny blad zachowuje swoja tresc — komunikat backendu nie jest zastepowany naszym', () => {
    expect(requestFailureMessage(new Error('Plik przekracza limit 8 MB.'))).toBe(
      'Plik przekracza limit 8 MB.',
    );
    expect(requestFailureMessage('HTTP 500')).toBe('HTTP 500');
  });
});

describe('strumien uruchomienia konczy sie na zmianie tozsamosci', () => {
  /** An SSE body the test can feed one event at a time. */
  function controlledStream(conversationId: string) {
    let push!: (event: Record<string, unknown>) => void;
    let close!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        push = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        close = () => controller.close();
      },
    });
    return {
      push,
      close,
      response: new Response(body, {
        headers: { 'X-Conversation-Id': conversationId, 'X-Run-Id': 'run_late' },
      }),
    };
  }

  it('zdarzenia, ktore dobiegna po przelaczeniu, nie zmieniaja juz niczego', async () => {
    const qc = new QueryClient();
    resetAccessContext();
    setAccessContext(qc, 'local-user');
    useAppState.setState({ runs: {}, conversationId: 'cnv_poprzedniego' });

    const { push, close, response } = controlledStream('cnv_poprzedniego');
    const adapter = platformAguiAdapter(qc);
    const seen: Array<Record<string, unknown>> = [];

    const consumed = (async () => {
      for await (const e of adapter.parse(response)) seen.push(e as Record<string, unknown>);
    })();

    push({ type: AGUI_EVENTS.RUN_STARTED, threadId: 'cnv_poprzedniego', runId: 'run_late' });
    push({ type: AGUI_EVENTS.TEXT_MESSAGE_START, messageId: 'am', role: 'assistant' });
    push({ type: AGUI_EVENTS.TEXT_MESSAGE_CONTENT, messageId: 'am', delta: 'przed' });
    await new Promise((r) => setTimeout(r, 20));
    expect(useAppState.getState().runFor('cnv_poprzedniego').streamingText).toBe('przed');
    const eventsBefore = seen.length;

    /* ------------------------------ the switch ----------------------------- */

    setAccessContext(qc, 'other-user');

    // Everything the run emits from here belongs to the previous identity.
    push({ type: AGUI_EVENTS.TEXT_MESSAGE_CONTENT, messageId: 'am', delta: ' po przelaczeniu' });
    push({ type: AGUI_EVENTS.RUN_FINISHED, threadId: 'cnv_poprzedniego', runId: 'run_late' });
    close();
    await consumed;

    // Nothing was handed on to the chat to render...
    expect(seen.length, 'zdarzenia po przelaczeniu trafily do czatu').toBe(eventsBefore);
    // ...and nothing was applied: the run record is exactly as the switch left
    // it (the store having been emptied by the reset, or holding the pre-switch
    // text when nothing is registered — either way, not the later delta).
    expect(useAppState.getState().runFor('cnv_poprzedniego').streamingText).not.toContain(
      'po przelaczeniu',
    );
    expect(useAppState.getState().runFor('cnv_poprzedniego').phase).not.toBe('succeeded');
  });
});

describe('stan klienta poza pamiecia podreczna jest czyszczony', () => {
  /*
   * Nothing is registered here on purpose.
   *
   * The store subscribes to identity switches itself, once for the life of the
   * module (`state/appState.ts`), because the leak it closes does not depend on
   * anything being mounted. This suite used to register a second listener of
   * its own; after the two packages met, one rule has one implementation and
   * the test drives it the way the application does — by switching the
   * identity and looking at the store.
   */
  beforeEach(() => {
    resetAccessContext();
  });
  afterEach(() => {
    useAppState.getState().clearScopedContext();
    useAppState.setState({ navOpen: true });
  });

  it('przelaczenie zostawia pusty kontekst polecenia', () => {
    const qc = new QueryClient();
    setAccessContext(qc, 'local-user');

    useAppState.setState({
      conversationId: 'cnv_poprzedniego',
      spaceId: 'spc_poprzedniego',
      resource: { kind: 'case', id: 'case_poprzedniego' },
      selection: [{ kind: 'offer', id: 'offer_poprzedniego' }],
      attachments: ['file_poprzedniego'],
      drafts: {
        'item-1': { formId: 'item-1', entity: 'offer_item', entityId: 'i1', dirtyFields: ['quantity'], values: { quantity: '9' } },
      },
      runs: { cnv_poprzedniego: { ...useAppState.getState().runFor(null), phase: 'running', runId: 'run_1' } },
      navOpen: false,
    });

    setAccessContext(qc, 'other-user');

    const s = useAppState.getState();
    expect(s.conversationId).toBeNull();
    expect(s.spaceId).toBeNull();
    expect(s.resource).toBeNull();
    expect(s.selection).toEqual([]);
    expect(s.attachments).toEqual([]);
    expect(s.drafts).toEqual({});
    expect(s.runs).toEqual({});
    // Nothing of the previous owner's reaches the next command.
    const ctx = s.toAppContext();
    expect(JSON.stringify(ctx)).not.toContain('poprzedniego');
    // A collapsed menu is a property of the window, not of who is signed in.
    expect(s.navOpen).toBe(false);
  });

  it('pierwsze ustawienie tozsamosci niczego nie czysci', () => {
    const qc = new QueryClient();
    useAppState.setState({ resource: { kind: 'case', id: 'case_1' } });
    setAccessContext(qc, 'local-user');
    expect(useAppState.getState().resource).toEqual({ kind: 'case', id: 'case_1' });
  });
});

describe('przegladarka artefaktow gotowego czatu czyta przez ten sam cache', () => {
  it('odczyt artefaktu przez magazyn czatu i przez klucz qk.artifact to jedno pobranie', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000 } } });
    resetAccessContext();
    setAccessContext(qc, 'local-user');

    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ id: 'art_1', title: 'Raport', type: 'platform.file', content: { a: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const storage = createChatStorage(qc);
    const first = await storage.artifact!.get('art_1');
    const second = await storage.artifact!.get('art_1');

    expect(urls.filter((u) => u.includes('/api/artifacts/art_1'))).toHaveLength(1);
    // The same entry the preview in a message reads.
    expect(qc.getQueryData(qk.artifact('art_1'))).toMatchObject({ id: 'art_1' });
    // What the library is handed is a reference, never data it could render
    // instead of re-reading the artifact.
    expect(first.content).toEqual({ artifactId: 'art_1' });
    expect(second.content).toEqual({ artifactId: 'art_1' });
  });
});
