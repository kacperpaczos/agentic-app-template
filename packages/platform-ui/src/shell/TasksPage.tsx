import { useEffect, useState } from 'react';
import { ACTIVE_RUN_STATUSES, type TaskView } from '@platform/contracts';
import { apiPost, requestFailureMessage } from '../api/client.ts';
import { qk, useTasks } from '../api/queries.ts';
import { useQueryClient } from '@tanstack/react-query';
import { useSessionLocation } from '../state/sessionLocation.ts';

/**
 * The global task center (L11.6).
 *
 * A task is the backend's work, not the panel that started it — so handling it
 * belongs in a dedicated, always-reachable view, not in a drawer hanging off
 * the status bar. The center shows the tasks of **every** conversation: the
 * intent, the conversation it belongs to, status, progress, tools used, input
 * files, output artifacts and errors, with the actions to open the conversation
 * or its result, cancel and retry.
 *
 * Progress is counters, not a percentage: an agent run does not know its step
 * count in advance, so any percent would be invented. Elapsed time is computed
 * in the browser from `startedAt`, so the line keeps ticking without extra
 * requests.
 */
export function TasksPage() {
  const tasks = useTasks();
  const qc = useQueryClient();
  const { setConversation } = useSessionLocation();
  const [now, setNow] = useState(() => Date.now());
  const [actionError, setActionError] = useState<string | null>(null);
  /* The run id an action is in flight for — its buttons are disabled until the
     request resolves, so a double click cannot start two things at once. */
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);

  /* Only this screen needs the ticking second; the status bar and chat do not. */
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const act = async (runId: string, path: string, what: string) => {
    setActionError(null);
    setPendingRunId(runId);
    try {
      // Through `apiPost`, not a bare fetch: the request is bound to the access
      // context like every other one, so an answer arriving after an identity
      // switch never lands on somebody else's screen.
      await apiPost(path, {});
      await qc.invalidateQueries({ queryKey: qk.tasks() });
    } catch (e) {
      const message = requestFailureMessage(e);
      if (message) setActionError(`${what}: ${message}`);
    } finally {
      setPendingRunId(null);
    }
  };

  const open = (conversationId: string) => {
    // The user's click moves the view; the center never takes it over by itself.
    void setConversation(conversationId);
  };

  /*
   * L11.19: answering the consent question where the task is handled, without
   * entering the source conversation. Bound to the request id the backend is
   * still holding, so the answer cannot attach itself to another run's
   * question.
   *
   * `answered: false` is a 200 that decided nothing — this click arrived after
   * the question was answered elsewhere or expired. It is not an error and not
   * a success; the refetch below is the whole response, showing the state that
   * actually holds (the form gone, the row in its true status).
   */
  const answerConsent = async (task: TaskView, allow: boolean) => {
    const pending = task.pendingPermission;
    if (!pending) return;
    setActionError(null);
    setPendingRunId(task.run.id);
    try {
      await apiPost<{ answered: boolean }>(`/api/runs/${task.run.id}/permission`, {
        requestId: pending.requestId,
        allow,
      });
    } catch (e) {
      const message = requestFailureMessage(e);
      if (message) setActionError(`${allow ? 'Zgoda' : 'Odmowa'}: ${message}`);
    } finally {
      /* On either outcome the rows must come from the backend again: the form
         follows the run's real state, and the attention badge follows the run
         out of `awaiting_consent` in the same refresh. */
      await qc.invalidateQueries({ queryKey: qk.tasks() });
      await qc.invalidateQueries({ queryKey: qk.activeRuns() });
      setPendingRunId(null);
    }
  };

  if (tasks.isError) {
    /* A failed fetch must not look like an empty center: the two mean
       opposite things, and the backend may be working right now. */
    return (
      <div className="pf-page" data-testid="task-center">
        <h1>Centrum zadań</h1>
        <div className="pf-state pf-state--error" role="alert" data-testid="task-center-error">
          Nie udało się pobrać listy zadań: {requestFailureMessage(tasks.error) ?? 'nieznany błąd'}
        </div>
      </div>
    );
  }

  const rows = tasks.data?.tasks ?? [];

  return (
    <div className="pf-page" data-testid="task-center">
      <h1>Centrum zadań</h1>
      <p className="pf-page__lead">
        Zadania agenta ze wszystkich rozmów: postęp, użyte narzędzia, pliki wejściowe, artefakty
        wynikowe i błędy. Zamknięcie panelu rozmowy nie zatrzymuje ani nie ukrywa pracy.
      </p>

      {actionError && (
        <div className="pf-state pf-state--error" role="alert">
          {actionError}
        </div>
      )}

      {tasks.isLoading ? (
        <div className="pf-state">Wczytywanie…</div>
      ) : rows.length === 0 ? (
        <div className="pf-state pf-state--empty" data-testid="task-center-empty">
          Brak zadań. Polecenia wydane agentowi w dowolnej rozmowie pojawią się tutaj.
        </div>
      ) : (
        <ul className="pf-tasklist" data-testid="task-center-list">
          {rows.map((task) => (
            <TaskRow
              key={task.run.id}
              task={task}
              now={now}
              busy={pendingRunId === task.run.id}
              onOpen={() => open(task.conversationId)}
              onOpenResult={() => open(task.conversationId)}
              onCancel={() => void act(task.run.id, `/api/runs/${task.run.id}/cancel`, 'Anulowanie')}
              onRetry={() => void act(task.run.id, `/api/runs/${task.run.id}/retry`, 'Ponowienie')}
              onConsent={(allow) => void answerConsent(task, allow)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The tool input as the form shows it: readable JSON, cut when it would stop
 * being a preview.
 *
 * The cut is a **render** decision only — the raw input travels nowhere, and
 * the answer endpoint receives the request id, not this text. What the cut
 * protects is the row itself: an input is arbitrary agent-chosen JSON, and one
 * large payload must not turn one task into three screens of it. The cut says
 * so by name, so a shortened preview can never pass for the whole input.
 */
const CONSENT_INPUT_LIMIT = 800;
const consentInputPreview = (input: unknown): string => {
  const pretty = JSON.stringify(input, null, 2) ?? String(input);
  if (pretty.length <= CONSENT_INPUT_LIMIT) return pretty;
  return `${pretty.slice(0, CONSENT_INPUT_LIMIT)}\n… (podgląd ucięty — ${pretty.length} znaków łącznie)`;
};

function TaskRow({
  task,
  now,
  busy,
  onOpen,
  onOpenResult,
  onCancel,
  onRetry,
  onConsent,
}: {
  task: TaskView;
  now: number;
  busy: boolean;
  onOpen: () => void;
  onOpenResult: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onConsent: (allow: boolean) => void;
}) {
  const { run, progress } = task;
  const active = (ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status);
  const elapsedMs =
    run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled'
      ? run.durationMs
      : Math.max(0, now - Date.parse(run.startedAt));
  const elapsed = elapsedMs != null ? `${(elapsedMs / 1000).toFixed(1)} s` : '—';

  const statusLabel =
    run.status === 'awaiting_consent'
      ? 'czeka na decyzję'
      : run.status === 'queued'
        ? 'zakolejkowane'
        : run.status === 'running'
          ? 'wykonywane'
          : run.status === 'succeeded'
            ? 'zakończone'
            : run.status === 'cancelled'
              ? 'anulowane'
              : 'błąd';

  return (
    <li className="pf-tasklist__item" data-testid={`task-row-${run.id}`} data-status={run.status}>
      <div className="pf-tasklist__head">
        <span className={`pf-dot ${run.status === 'succeeded' ? 'pf-dot--ok' : active ? 'pf-dot--busy' : 'pf-dot--warn'}`} aria-hidden="true" />
        <strong data-testid={`task-intent-${run.id}`}>{task.intent || '(polecenie bez treści)'}</strong>
        <span className="pf-badge" data-testid={`task-status-${run.id}`} data-status={run.status}>
          {statusLabel}
        </span>
        {/*
          The consent mode the run was started with, from its record — the
          center states how a task ran (or will run) without trusting this
          tab's memory of what was once selected at the composer.
        */}
        <span
          className="pf-badge"
          data-testid={`task-consent-mode-${run.id}`}
          data-mode={task.consentMode}
          title={
            task.consentMode === 'manual'
              ? 'Ręczny — wykonanie pyta o zgodę przed każdą akcją.'
              : task.consentMode === 'auto'
                ? 'Pełna automatyzacja — wykonanie nie pyta o pojedyncze akcje.'
                : 'Nadzorowany — narzędzia aplikacji działają od razu, pozostałe wymagają zgody.'
          }
        >
          {task.consentMode === 'manual' ? 'Ręczny' : task.consentMode === 'auto' ? 'Automatyczny' : 'Nadzorowany'}
        </span>
      </div>

      {/* The conversation a task belongs to, by name — in a list spanning many
          conversations, the command text alone is not what names it. */}
      <p className="pf-tasklist__meta" data-testid={`task-conversation-${run.id}`}>
        Rozmowa: {task.conversationTitle}
      </p>

      <p className="pf-tasklist__progress" data-testid={`task-progress-${run.id}`}>
        czas: {elapsed} · narzędzia: {progress.toolCallsStarted}/{progress.toolCallsFinished} zakończone ·
        fragmenty tekstu: {progress.textParts} · artefakty: {progress.artifactsPublished}
        {progress.lastEventAt && <> · ostatnia aktywność: {new Date(progress.lastEventAt).toLocaleTimeString('pl-PL')}</>}
      </p>

      <p className="pf-tasklist__meta" data-testid={`task-tools-${run.id}`}>
        {task.tools.length > 0
          ? `Narzędzia: ${task.tools.map((t) => `${t.name}×${t.calls}`).join(', ')}`
          : 'Narzędzia: —'}
      </p>

      <p className="pf-tasklist__meta" data-testid={`task-inputs-${run.id}`}>
        {task.inputFiles.length > 0
          ? `Pliki wejściowe: ${task.inputFiles.map((f) => f.filename).join(', ')}`
          : 'Pliki wejściowe: —'}
      </p>

      {task.artifacts.length > 0 && (
        <div className="pf-tasklist__meta" data-testid={`task-artifacts-${run.id}`}>
          Artefakty:{' '}
          {task.artifacts.map((a) => (
            <span key={a.id} className="pf-tasklist__artifact" data-artifact-id={a.id}>
              {a.title} <span className="pf-badge">{a.mode}</span>
            </span>
          ))}
        </div>
      )}

      {run.status === 'failed' && (
        <p className="pf-state pf-state--error" data-testid={`task-error-${run.id}`} role="alert">
          {run.errorCode ?? 'błąd'}: {run.errorMessage ?? 'wykonanie zakończone błędem'}
        </p>
      )}

      {/*
        L11.19: the question itself, answerable where the task is handled. The
        key `pendingPermission` exists only while the run is parked at the gate
        and disappears — the key, not a null — when the question is answered,
        expired or released, so this block lives and dies with the real state
        from the backend, never with this tab's memory of it.
      */}
      {task.pendingPermission && (
        <div className="pf-tasklist__consent" data-testid={`task-consent-form-${run.id}`}>
          <p className="pf-tasklist__consent__title">
            Zadanie czeka na decyzję — narzędzie{' '}
            <strong data-testid={`task-consent-tool-${run.id}`}>{task.pendingPermission.toolName}</strong>
          </p>
          {/*
            The command the decision is about, restated here on purpose: the
            question has to be answerable from this block alone — the row's
            head is a summary for scanning, not a part of the question.
          */}
          <p className="pf-tasklist__consent__meta">
            Polecenie: {task.intent || '(polecenie bez treści)'}
          </p>
          <pre className="pf-tasklist__consent__input" data-testid={`task-consent-input-${run.id}`}>
            {consentInputPreview(task.pendingPermission.input)}
          </pre>
          <div className="pf-tasklist__actions">
            <button
              type="button"
              className="pf-btn pf-btn--tiny pf-btn--primary"
              data-testid={`task-consent-allow-${run.id}`}
              disabled={busy}
              onClick={() => onConsent(true)}
            >
              Zgoda
            </button>
            <button
              type="button"
              className="pf-btn pf-btn--tiny"
              data-testid={`task-consent-deny-${run.id}`}
              disabled={busy}
              onClick={() => onConsent(false)}
            >
              Odmowa
            </button>
          </div>
        </div>
      )}

      <div className="pf-tasklist__actions">
        <button
          type="button"
          className="pf-btn pf-btn--tiny"
          data-testid={`task-open-${run.id}`}
          disabled={busy}
          onClick={onOpen}
        >
          Otwórz rozmowę
        </button>
        {task.artifacts.length > 0 && (
          <button
            type="button"
            className="pf-btn pf-btn--tiny"
            data-testid={`task-result-${run.id}`}
            disabled={busy}
            onClick={onOpenResult}
          >
            Otwórz wynik
          </button>
        )}
        {active && (
          <button
            type="button"
            className="pf-btn pf-btn--tiny"
            data-testid={`task-cancel-${run.id}`}
            disabled={busy}
            onClick={onCancel}
          >
            Anuluj
          </button>
        )}
        {!active && run.status !== 'succeeded' && (
          <button
            type="button"
            className="pf-btn pf-btn--tiny"
            data-testid={`task-retry-${run.id}`}
            disabled={busy}
            onClick={onRetry}
          >
            Ponów
          </button>
        )}
      </div>
    </li>
  );
}
