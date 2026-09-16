import { useMemo, useRef, useState } from 'react';
import { AgentInterface, artifactListPath } from '@openuidev/react-ui';
import '@openuidev/react-ui/index.css';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost } from '../api/client.ts';
import { useRegistry } from '../catalog/registry.tsx';
import { useAppState } from '../state/appState.ts';
import { ArtifactContent, LiveBadge } from '../components/LiveArtifact.tsx';
import { makeAssistantMessage } from './AssistantMessage.tsx';
import { ChatSlotsContext } from './chatSlots.ts';
import { ComposerAttachments } from './ComposerAttachments.tsx';
import { ConversationSync } from './ConversationSync.tsx';
import { createChatLlm, createChatStorage, stopRun } from './chatWiring.ts';
import { useComposerStop } from './useComposerStop.ts';

/**
 * Shows which case and which card the conversation refers to.
 *
 * Required by the product brief: the user must be able to see what the agent is
 * about to act on before they press send.
 */
function ContextStrip() {
  const resource = useAppState((s) => s.resource);
  const selection = useAppState((s) => s.selection);
  const clearSelection = useAppState((s) => s.clearSelection);

  return (
    <div className="pf-context" data-testid="chat-context">
      <span className="pf-context__label">Kontekst rozmowy</span>
      <span className="pf-context__value">
        {resource ? `${resource.kind}: ${resource.id}` : 'brak wybranej sprawy'}
      </span>
      {selection.length > 0 && (
        <>
          <span className="pf-context__value" data-testid="chat-selection">
            zaznaczone: {selection.map((s) => `${s.kind}:${s.id.slice(-6)}`).join(', ')}
          </span>
          <button type="button" className="pf-btn pf-btn--tiny" onClick={clearSelection}>
            wyczysc
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Lifecycle of the run being watched, and the answer as it arrives.
 *
 * The phase comes from the run's own events — deliberately not from whether an
 * answer has appeared: a run with no text is still a run, and text arriving is
 * not the same as a run finishing.
 *
 * **Why the live answer is here and not in the thread.** `AgentInterface` does
 * not render a partial prose answer. Its `InterleavedTurn` resolves the answer
 * as `!turnLive || hasLangSyntax(content) ? last : null`, so while a turn is
 * open a plain-language reply is held back and committed only when the turn
 * ends; the component has no slot that changes this short of replacing
 * `Messages` wholesale. Rather than do that, this adds one element: the text as
 * it streams, shown only while the turn is open and dropped the moment the
 * ready-made thread commits the message. Every rendering function of the
 * ready-made chat — thread, timeline, composer, workspace — is untouched, and
 * the same text is never displayed twice.
 */
const PHASE_LABEL: Record<string, string> = {
  queued: 'w kolejce',
  running: 'wykonywanie',
  awaiting_consent: 'czeka na zgode',
  succeeded: 'zakonczone',
  failed: 'blad',
  cancelled: 'anulowane',
};

const ACTIVE_PHASES = new Set(['queued', 'running', 'awaiting_consent']);

function RunState() {
  /*
   * The run of *this* conversation, not "the run".
   *
   * Reading a single global record is what let one conversation's progress
   * appear under another's messages the moment two of them were in flight.
   */
  const conversationId = useAppState((s) => s.conversationId);
  const run = useAppState((s) => (conversationId ? s.runs[conversationId] : undefined));
  if (!run || run.phase === 'idle') return null;

  const tone =
    run.phase === 'failed' ? 'pf-badge--err'
      : run.phase === 'succeeded' ? 'pf-badge--ok'
        : run.phase === 'cancelled' ? 'pf-badge--warn'
          : 'pf-badge';
  return (
    <div className="pf-runstate" data-testid="run-state" data-phase={run.phase} data-run-id={run.runId ?? ''}>
      <span className={`pf-badge ${tone}`}>{PHASE_LABEL[run.phase] ?? run.phase}</span>
      {run.activeTool && (
        <span className="pf-muted" data-testid="run-active-tool">
          narzedzie: {run.activeTool}
        </span>
      )}
      {/*
        Stop is an explicit action against this named run.

        It is here rather than wired to the composer's abort because that signal
        fires on a conversation switch and on a reload as well, and a background
        task must survive both. See `chatWiring.ts`.
      */}
      {ACTIVE_PHASES.has(run.phase) && run.runId && (
        <button
          type="button"
          className="pf-btn pf-btn--tiny"
          data-testid="run-stop"
          onClick={() => void stopRun(run.runId!)}
        >
          Zatrzymaj
        </button>
      )}
      {run.phase === 'running' && run.streamingText && (
        <div className="pf-runstate__stream" data-testid="streaming-answer">
          {run.streamingText}
        </div>
      )}
      {run.phase === 'failed' && (
        <span className="pf-runstate__error" role="alert" data-testid="run-error">
          {run.errorCode ? `[${run.errorCode}] ` : ''}
          {run.errorMessage ?? 'Uruchomienie nie powiodlo sie.'}
        </span>
      )}
    </div>
  );
}

/**
 * Permission request raised by the agent's `canUseTool` gate.
 *
 * Shown for the conversation the run belongs to. A task waiting for consent in
 * another conversation is announced in the background-task list instead of
 * interrupting whatever the user is doing here.
 */
function PermissionPrompt() {
  const conversationId = useAppState((s) => s.conversationId);
  const pending = useAppState((s) =>
    conversationId ? (s.runs[conversationId]?.pendingPermission ?? null) : null,
  );
  const patchRun = useAppState((s) => s.patchRun);
  if (!pending || !conversationId) return null;

  const answer = async (allow: boolean) => {
    patchRun(conversationId, { pendingPermission: null, phase: 'running' });
    await apiPost(`/api/runs/${pending.runId}/permission`, { requestId: pending.requestId, allow });
  };

  return (
    <div className="pf-permission" role="alertdialog" aria-label="Prosba o zgode" data-testid="permission-prompt">
      <div className="pf-permission__title">Agent prosi o zgode na: {pending.toolName}</div>
      <pre className="pf-permission__input">{pending.input}</pre>
      <div className="pf-permission__actions">
        <button type="button" className="pf-btn pf-btn--primary" onClick={() => void answer(true)}>
          Zgoda
        </button>
        <button type="button" className="pf-btn" onClick={() => void answer(false)}>
          Odmowa
        </button>
      </div>
    </div>
  );
}

/**
 * Reserved path of the library's own artifact browser.
 *
 * `artifactListPath()` is public API; with no `artifactCategories` configured it
 * is `artifacts/all`, and an opened artifact is `artifacts/all/{id}` underneath
 * it — hence the prefix test rather than equality.
 */
const ARTIFACTS_PATH = artifactListPath();

/**
 * Two views of the panel: the conversation, and the artifacts it produced.
 *
 * **Why a tab strip and not another screen.** The artifact browser already
 * existed — `AgentInterface` reserves the `artifacts/` path for it and puts an
 * entry in its sidebar. But at this panel's width the sidebar is an off-canvas
 * drawer, so the only route to artifacts was: open the drawer, notice a third
 * item under the conversation list, click it. Nothing was missing except a way
 * to see that it was there, which is why the user asked for artifacts to be a
 * tab rather than for an artifact view to be built.
 *
 * So this drives the library's own navigation, through its own public
 * `path`/`onNavigate` pair, and renders the two destinations as what they are.
 * `onNavigate` is bidirectional on purpose: opening an artifact from a message,
 * or from the drawer entry, moves the highlight here too, so the strip always
 * says which view is on screen rather than only which one was last clicked.
 */
function ChatTabs({
  path,
  onSelect,
}: {
  path: string | undefined;
  onSelect: (path: string | undefined) => void;
}) {
  /* `undefined` is the library's own "no reserved path": its default thread view. */
  const tabs: { id: string; label: string; path: string | undefined }[] = [
    { id: 'thread', label: 'Rozmowa', path: undefined },
    { id: 'artifacts', label: 'Artefakty', path: ARTIFACTS_PATH },
  ];
  const activeIndex = path?.startsWith(ARTIFACTS_PATH) ? 1 : 0;

  return (
    <div className="pf-chat__tabs" role="tablist" aria-label="Widok panelu rozmowy">
      {tabs.map((tab, i) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`pf-chat-tab-${tab.id}`}
          className="pf-chat__tab"
          aria-selected={i === activeIndex}
          aria-controls="pf-chat-view"
          /* Only the active tab is a tab stop; arrows move between them. */
          tabIndex={i === activeIndex ? 0 : -1}
          data-testid={`chat-tab-${tab.id}`}
          onClick={() => onSelect(tab.path)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
            onSelect(next.path);
            document.getElementById(`pf-chat-tab-${next.id}`)?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Right-hand chat.
 *
 * `AgentInterface` from `@openuidev/react-ui` is the ready-made conversation UI:
 * thread list, composer, streaming, tool activity, artifact workspace. We supply
 * storage, an LLM adapter and the component catalog — no chat of our own.
 */
export function ChatPanel() {
  const qc = useQueryClient();
  const registry = useRegistry();
  const panel = useRef<HTMLElement | null>(null);
  /*
   * Navigation is controlled here so the tab strip and the library agree on
   * which view is showing. `AgentInterface` supports exactly this: pass
   * `onNavigate` and it treats `path` as the source of truth, and every
   * navigation of its own — the drawer's artifact entry, an artifact opened
   * from a message, the back link out of an artifact — arrives here.
   */
  const [navPath, setNavPath] = useState<string | undefined>(undefined);
  const onArtifacts = navPath?.startsWith(ARTIFACTS_PATH) ?? false;
  /*
   * Two empty elements the panel owns, for things the ready-made chat cannot
   * hold: a notice rendered inside `AgentInterface` becomes a panel beside the
   * thread, and a menu opened inside the composer is clipped by its
   * `overflow: clip` wrapper. See `chatSlots.ts`.
   */
  const [noticeHost, setNoticeHost] = useState<HTMLElement | null>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLElement | null>(null);
  const slots = useMemo(
    () => ({ notice: noticeHost, overlay: overlayHost }),
    [noticeHost, overlayHost],
  );
  /*
   * The ready-made composer's stop button ends the stream locally; this is what
   * makes it also end the work in the backend. Deliberately not wired to the
   * abort signal — see `useComposerStop.ts`.
   */
  useComposerStop(panel);

  const storage = useMemo(() => createChatStorage(), []);
  const llm = useMemo(() => createChatLlm(qc), [qc]);

  /*
   * Starter chips come from the installed modules. The platform shell contains
   * no business vocabulary of its own — `scripts/check-boundaries.mjs` fails the
   * build if any creeps in, which is exactly how the previous hard-coded
   * procurement starters were caught.
   */
  const starters = useMemo(
    () =>
      registry.starters.length
        ? registry.starters
        : [{ displayText: 'Co potrafisz?', prompt: 'Jakie masz narzedzia i co mozesz zrobic w tej aplikacji?' }],
    [registry.starters],
  );

  /*
   * Artifact renderers are wrapped in `ArtifactContent` rather than handed the
   * content the chat happens to be holding. For a live artifact that content is
   * whatever was current when the list was last fetched; the wrapper re-reads
   * the artifact — which re-runs its query server-side — and refuses to render
   * anything at all if that refresh failed.
   */
  const assistantMessage = useMemo(() => makeAssistantMessage(registry.library), [registry.library]);

  const artifactRenderers = useMemo(
    () =>
      Object.entries(registry.artifactRenderers).map(([type, Renderer]) => ({
        type,
        render: ({ id }: { content: unknown; id: string }) => (
          <ArtifactContent artifactId={id}>
            {(a) => (
              <div className="pf-artifact">
                <div className="pf-artifact__head">
                  <strong>{a.title}</strong>
                  <LiveBadge live={a.live} />
                </div>
                <Renderer artifactId={id} content={a.content} meta={{ live: a.live }} />
              </div>
            )}
          </ArtifactContent>
        ),
      })),
    [registry.artifactRenderers],
  );

  return (
    <section className="pf-chat" aria-label="Rozmowa z agentem" ref={panel}>
      <ChatTabs path={navPath} onSelect={setNavPath} />
      {/*
        Run state stays visible on both tabs — work started from the
        conversation keeps running while its artifacts are being read, and
        hiding its progress there would be hiding the thing the user went to
        look at. The context strip and the consent prompt belong to composing a
        command, so they are shown where a command can be composed.
      */}
      <RunState />
      {!onArtifacts && <ContextStrip />}
      {!onArtifacts && <PermissionPrompt />}
      <div className="pf-chat__notice" ref={setNoticeHost} />
      {/*
        No layout prop here on purpose.

        `AgentInterface` measures its own container with a ResizeObserver and
        publishes its own layout context from that width — an outer
        `LayoutContextProvider` is shadowed and has no effect, which is what the
        previous version of this file wrongly relied on. At this panel width the
        library selects its mobile arrangement, which is the correct one for a
        side panel: off-canvas conversation drawer, composer pinned to the
        bottom. All we do is give it the panel's box to measure (see styles.css).
      */}
      <div className="pf-chat__body" id="pf-chat-view">
        {/*
          No `key` here.

          It used to be keyed on our own `conversationId`, which the backend
          assigns *during* the first run of a new conversation. React therefore
          unmounted and rebuilt the chat mid-stream, throwing away the thread the
          user was watching: the answer and the tool activity vanished as soon as
          the conversation got its id. The chat owns thread selection and reloads
          its own messages — it must not be remounted from outside.
        */}
        <ChatSlotsContext.Provider value={slots}>
          <AgentInterface
            path={navPath}
            onNavigate={setNavPath}
            storage={storage}
            llm={llm}
            componentLibrary={registry.library}
            components={{ AssistantMessage: assistantMessage as never }}
            agentName="Agent aplikacji"
            artifactRenderers={artifactRenderers as never}
            starters={starters}
            /*
              Every label the component exposes. Its artifact browser also has
              an empty state and a search placeholder in English, and those are
              not in the `labels` contract — recorded as a limitation rather
              than patched over the library's own markup.
            */
            labels={{
              defaultCategory: 'Artefakty',
              workspaceToggle: 'Artefakty rozmowy',
              tabs: { all: 'Wszystko', artifacts: 'Artefakty', apps: 'Aplikacje' },
            }}
          >
            {/*
              Inside the provider on purpose: it drives the chat's own thread
              selection through the library's `useThreadList` hook, which only
              exists in this context. Renders nothing unless the conversation the
              URL names is gone.
            */}
            <ConversationSync />
            {/*
              Renders nothing here. It portals a paperclip into the ready-made
              composer's own action bar and the attached-file chips above its
              textarea — see `ComposerAttachments.tsx` for why anything else
              becomes a panel of its own.
            */}
            <ComposerAttachments />
            <AgentInterface.Composer placeholder="Napisz polecenie dla agenta…" starters={starters} />
          </AgentInterface>
        </ChatSlotsContext.Provider>
      </div>
      {/* Floating pieces position themselves; this only keeps them out of the
          library's clipping boxes. */}
      <div className="pf-chat__overlay" ref={setOverlayHost} />
    </section>
  );
}
