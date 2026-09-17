import {
  AGENT_VIEWS_TARGET_ID,
  UI_COMMAND_FAILURES,
  applySearchPatch,
  describePredicate,
  parseAddressSearch,
  recordValue,
  viewAddressKey,
  viewStatePatch,
  type DataSource,
  type UiCommand,
  type UiCommandFailure,
  type UiCommandResult,
  type UiReveal,
  type UiRevealAdjustment,
  type UiRevealed,
  type UiTarget,
  type ViewFilterPredicate,
} from '@platform/contracts';
import { focusCanvasCard } from '../canvas/canvasFocus.ts';
import { useAppState, type RevealNotice } from '../state/appState.ts';
import { revealTargets, type RecordLocation, type RevealTarget } from '../views/revealTarget.ts';
import { pollUntil } from './uiCommandAck.ts';

/**
 * Showing one record's field on screen: the client half of `ui_show_value`.
 *
 * The server has already decided which data component renders the value
 * (`command.reveal`). This finds that component, asks it where the record is
 * (`views/revealTarget.ts`), changes the presentation when the record is hidden
 * — the narrowing that excludes it is removed, the page is turned — scrolls the
 * cell into view and highlights it, and reports what it pointed at: the record,
 * the field, the text in the cell, the value on the row it was drawn from, and
 * every change it made. Nothing here writes data; every change is to the
 * address or to a table's page, and Back undoes the address.
 *
 * It reports `executed` only for a cell that was found and is in view; a cell
 * that exists but could not be brought into view is `not_visible`, a record the
 * component does not show is `not_present`.
 */

/** How long a highlight stays on screen — the same for a control and a value. */
export const HIGHLIGHT_MS = 2600;

/** Marks an element as pointed at, for a while. */
export function markHighlighted(el: HTMLElement): void {
  el.setAttribute('data-ui-highlight', 'true');
  window.setTimeout(() => el.removeAttribute('data-ui-highlight'), HIGHLIGHT_MS);
}

/**
 * The screen and view state a notice belongs to: the path and the view's own
 * parameters, without the session's `c` and `s`. A notice about clearing a
 * narrowing is true only while that state is on screen.
 */
export function revealAddress(pathname: string, search: Record<string, unknown>): string {
  const own = Object.entries(search)
    .filter(([k, v]) => k !== 'c' && k !== 's' && typeof v === 'string' && v.trim() !== '')
    .map(([k, v]) => [k, String(v).trim()])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  return `${pathname}?${JSON.stringify(own)}`;
}

export type RevealPlan =
  /** The table has nothing to look in yet. */
  | { kind: 'wait' }
  | { kind: 'refuse'; reason: UiCommandFailure; why: RecordLocation['status'] }
  /** The record is on the page shown. */
  | { kind: 'ready'; adjustments: UiRevealAdjustment[] }
  /** A change of the view's address: narrowing and/or page. */
  | { kind: 'address'; patch: Record<string, string | undefined>; predicatesChanged: boolean; adjustments: UiRevealAdjustment[] }
  /** A table paged in memory turns to a page. */
  | { kind: 'page'; page: number; adjustments: UiRevealAdjustment[] };

const pageChange = (from: number, to: number): UiRevealAdjustment => ({
  kind: 'page_changed',
  detail: `strona ${from} → ${to}`,
  from,
  to,
});

/**
 * What must change for a table to show a record — pure, so the rules are
 * testable on their own:
 *
 *  - hidden by the address bar's narrowing: only the predicates the record
 *    fails are removed, the others stay; the page is set to the record's page
 *    under what remains;
 *  - on another page: the page is turned — in the address for the view's
 *    primary instance, in memory for any other table;
 *  - anything else that keeps it off screen (not in the read, left out by the
 *    composition's own filter, the field not drawn) cannot be changed from here
 *    and is `not_present`.
 */
export function planReveal(input: {
  target: Pick<RevealTarget, 'address' | 'showPage'>;
  /** Where the record is — now, or under another narrowing. */
  locate: (narrowing?: ViewFilterPredicate[]) => RecordLocation;
  labelOf: (field: string) => string;
}): RevealPlan {
  const { target } = input;
  const here = input.locate();
  switch (here.status) {
    case 'unavailable':
      return { kind: 'wait' };
    case 'absent':
    case 'field_not_shown':
    case 'excluded_by_composition':
      return { kind: 'refuse', reason: UI_COMMAND_FAILURES.notPresent, why: here.status };
    case 'excluded_by_narrowing': {
      const there = target.address ? input.locate(here.kept) : null;
      if (!target.address || there?.status !== 'present') {
        return { kind: 'refuse', reason: UI_COMMAND_FAILURES.notPresent, why: here.status };
      }
      const adjustments: UiRevealAdjustment[] = [
        {
          kind: 'filter_cleared',
          detail: here.excluding.map((p) => describePredicate(p, input.labelOf(p.field))).join(', '),
          predicates: here.excluding,
        },
      ];
      const from = here.pageShown ?? 1;
      if (there.page !== null && there.page !== from) adjustments.push(pageChange(from, there.page));
      return {
        kind: 'address',
        patch: viewStatePatch(
          target.address.filterFields.map((f) => f.field),
          { predicates: here.kept, page: there.page ?? null },
        ),
        predicatesChanged: true,
        adjustments,
      };
    }
    case 'present': {
      if (here.page === null || here.page === here.pageShown) return { kind: 'ready', adjustments: [] };
      const adjustments = [pageChange(here.pageShown ?? 1, here.page)];
      if (target.address) {
        return {
          kind: 'address',
          patch: viewStatePatch(target.address.filterFields.map((f) => f.field), { page: here.page }),
          predicatesChanged: false,
          adjustments,
        };
      }
      if (target.showPage) return { kind: 'page', page: here.page, adjustments };
      return { kind: 'refuse', reason: UI_COMMAND_FAILURES.notPresent, why: here.status };
    }
  }
}

const sameSource = (a: DataSource, b: DataSource) =>
  a.operation === b.operation && JSON.stringify(a.input ?? {}) === JSON.stringify(b.input ?? {});

/** The mounted table the server named: same read, in the named view or agent view card. */
function findTable(reveal: UiReveal): RevealTarget | null {
  const { presentation } = reveal;
  return (
    revealTargets().find((t) => {
      if (!sameSource(t.source, reveal.source)) return false;
      if (presentation.kind === 'view') return t.viewId === presentation.viewId;
      return Boolean(
        document.querySelector(
          `[data-testid="card-${CSS.escape(presentation.cardId)}"] [data-ui-instance="${CSS.escape(t.instanceId)}"]`,
        ),
      );
    }) ?? null
  );
}

/**
 * Waits for the next painted frame, but never past the command's deadline.
 *
 * An unbounded `requestAnimationFrame` await is not safe inside a budgeted
 * command: a hidden tab paints no frames at all, so the wait would never
 * resolve, no acknowledgement would be posted and the server would report
 * `no_client` — about a command that had already changed the screen. Returns
 * whether a frame actually came, so a caller can say it could not check
 * instead of claiming it did.
 */
function nextFrame(until: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (framed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(framed);
    };
    requestAnimationFrame(() => finish(true));
    window.setTimeout(() => finish(false), Math.max(0, Math.min(FRAME_WAIT_MS, until - Date.now())));
  });
}

/** Longest wait for one frame; a painting tab answers in well under this. */
const FRAME_WAIT_MS = 120;

/** Whether the element's centre is on screen and not clipped by any scrolling or clipping ancestor. */
function inView(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const clip = parent.getBoundingClientRect();
    if (x < clip.left || x > clip.right || y < clip.top || y > clip.bottom) return false;
  }
  return true;
}

/**
 * Scrolls the cell into view. On a canvas card the card's own body is scrolled
 * (scaled by the canvas zoom) and the canvas centres the card when needed —
 * scrolling the page would move the canvas's container under the library that
 * positions it.
 */
async function bringIntoView(
  cell: HTMLElement,
  reveal: UiReveal,
  adjustments: UiRevealAdjustment[],
  until: number,
): Promise<boolean> {
  let framed = true;
  if (reveal.presentation.kind === 'agent_view') {
    const body = cell.closest<HTMLElement>('.pf-card__body');
    if (body) {
      const card = body.closest<HTMLElement>('.pf-card');
      const zoom = card && card.offsetWidth ? card.getBoundingClientRect().width / card.offsetWidth : 1;
      const b = body.getBoundingClientRect();
      const c = cell.getBoundingClientRect();
      body.scrollTop += (c.top - b.top - (b.height - c.height) / 2) / (zoom || 1);
      body.scrollLeft += (c.left - b.left - (b.width - c.width) / 2) / (zoom || 1);
    }
    framed = await nextFrame(until);
    if (framed && !inView(cell) && focusCanvasCard(reveal.presentation.cardId)) {
      adjustments.push({ kind: 'card_focused', detail: 'kanwa przesunieta do karty' });
      framed = (await nextFrame(until)) && (await nextFrame(until));
    }
  } else {
    cell.scrollIntoView({ block: 'center', inline: 'nearest' });
    framed = await nextFrame(until);
  }
  // No frame, no check: a tab that is not painting cannot be said to be showing it.
  return framed && inView(cell);
}

const currentUrl = () => window.location.pathname + window.location.search;

/** Waits and polls like the other UI commands, within the command's budget. */
const POLL = { attempts: 80, intervalMs: 60 };

/**
 * The sentences the banner shows about a reveal — one place, so what the user
 * reads and what the tests assert cannot drift apart.
 */
export function revealNoticeText(notice: RevealNotice): { headline: string; subject: string; changes: string[]; note: string } {
  const field = notice.fieldLabel ?? notice.field;
  const record = notice.recordTitle ? `„${notice.recordTitle}”` : notice.recordId;
  return {
    headline: notice.shown ? 'Agent wskazal wartosc.' : 'Agent zmienil widok, szukajac wartosci.',
    subject: notice.shown
      ? `Pole „${field}” rekordu ${record}.`
      : `Pole „${field}” rekordu ${record} nie zostalo wskazane.`,
    changes: notice.adjustments.map((a) =>
      a.kind === 'filter_cleared'
        ? `Zdjeto zawezenie: ${a.detail}.`
        : a.kind === 'page_changed'
          ? `Zmieniono ${a.detail}.`
          : `${a.detail}.`,
    ),
    note: 'Zmiany dotycza tylko tego, co widac — dane sa bez zmian.',
  };
}

export async function performReveal(
  command: UiCommand & { reveal: UiReveal },
  deps: {
    catalog: UiTarget[];
    navigate: (options: {
      to: string;
      search: Record<string, unknown> | ((prev: Record<string, unknown>) => Record<string, unknown>);
      replace?: boolean;
    }) => Promise<unknown>;
    /** When waiting must stop (`waitingDeadline`). */
    until: number;
  },
): Promise<UiCommandResult> {
  const { reveal } = command;
  const base = { commandId: command.commandId, targetId: command.targetId };
  /** Changes made to the presentation so far; reported and announced whatever happens next. */
  const adjustments: UiRevealAdjustment[] = [];
  /**
   * Says on screen what this command changed and whether it pointed at
   * anything — called as soon as the screen changes, not only on success.
   *
   * A narrowing cleared by a command that then failed is still cleared: the
   * user is looking at a view they did not narrow, so something has to say who
   * changed it and why. The change is **not** undone: it is the state in which
   * the record is reachable, and putting it back would hide the record again
   * while claiming nothing happened.
   */
  const announce = (shown: boolean, found?: { recordTitle: string | null; fieldLabel: string }) => {
    if (!shown && adjustments.length === 0) return;
    useAppState.getState().setRevealNotice({
      address: revealAddress(window.location.pathname, parseAddressSearch(window.location.search)),
      shown,
      recordKind: reveal.recordKind,
      recordId: reveal.recordId,
      recordTitle: found?.recordTitle ?? null,
      field: reveal.field,
      fieldLabel: found?.fieldLabel ?? null,
      adjustments: [...adjustments],
    });
  };
  const refuse = (reason: UiCommandFailure, extra: Partial<UiCommandResult> = {}): UiCommandResult => ({
    ...base,
    executed: false,
    reason,
    url: currentUrl(),
    ...(adjustments.length ? { adjustments: [...adjustments] } : {}),
    ...extra,
  });
  const poll = <T>(probe: () => T | null) => pollUntil(probe, { ...POLL, until: deps.until });

  /*
   * The screen. A module view with its own route and the agent views page are
   * navigated to — from another screen with a clean address (the session's `c`
   * and `s` are kept by the router), so nothing of that screen's state is
   * carried over. A record screen with route parameters is not navigated to:
   * the server chose it because the tab shows it now.
   */
  const route =
    reveal.presentation.kind === 'view'
      ? (deps.catalog.find((t) => t.id === (reveal.presentation as { viewId: string }).viewId && t.to)?.to ?? null)
      : (deps.catalog.find((t) => t.id === AGENT_VIEWS_TARGET_ID)?.to ?? null);
  if (reveal.presentation.kind === 'agent_view' && !route) return refuse(UI_COMMAND_FAILURES.unknownTarget);
  let navigated = false;
  if (route && window.location.pathname !== route) {
    await deps.navigate({ to: route, search: {} });
    navigated = true;
  }

  /*
   * The table, once it has rows to look in — and, for a view's primary
   * instance, once it has applied the address now in the bar, so the answer
   * does not come from the state before a navigation.
   */
  const settledTable = () =>
    poll(() => {
      const table = findTable(reveal);
      /*
       * A table being read again is not a table to take values from: a record
       * action invalidates its read, and the rows on screen are the ones about
       * to be replaced. Waiting here is what keeps a value that is already old
       * from being compared with the backend and called a match.
       */
      if (!table || table.refreshing) return null;
      if (table.locate(reveal.recordId, reveal.field).status === 'unavailable') return null;
      if (table.address) {
        const names = table.address.filterFields.map((f) => f.field);
        if (table.address.key !== viewAddressKey(parseAddressSearch(window.location.search), names)) return null;
      }
      return table;
    });
  const table = await settledTable();
  // Still being read when the budget ran out: the screen never reached a state
  // this command could confirm, which is not the same as the record missing.
  if (!table) return refuse(findTable(reveal)?.refreshing ? UI_COMMAND_FAILURES.notApplied : UI_COMMAND_FAILURES.notPresent);

  const labels = new Map(table.address?.filterFields.map((f) => [f.field, f.label]) ?? []);
  const plan = planReveal({
    target: table,
    locate: (narrowing) => table.locate(reveal.recordId, reveal.field, narrowing ? { narrowing } : undefined),
    labelOf: (field) => labels.get(field) ?? field,
  });
  if (plan.kind === 'wait') return refuse(UI_COMMAND_FAILURES.notPresent);
  if (plan.kind === 'refuse') return refuse(plan.reason);
  adjustments.push(...plan.adjustments);

  if (plan.kind === 'address' && table.address) {
    const names = table.address.filterFields.map((f) => f.field);
    const expected = applySearchPatch(parseAddressSearch(window.location.search), plan.patch);
    if (plan.predicatesChanged) {
      /*
       * Credited to the agent while the screen shows what it left, as for a
       * narrowing it set; cleared when nothing narrows the view any more.
       */
      const key = viewAddressKey(expected, names, { page: false });
      useAppState
        .getState()
        .setAgentFilterKey(key === viewAddressKey({}, names, { page: false }) ? null : `${table.address.targetId}|${key}`);
    }
    await deps.navigate({
      to: route ?? window.location.pathname,
      search: (prev) => ({ ...prev, ...plan.patch }),
      // The command's own navigation to this screen is not a state the user had: one history entry.
      replace: navigated,
    });
    // The screen has changed; from here every answer says so, including a refusal.
    announce(false);
  } else if (plan.kind === 'page') {
    table.showPage?.(plan.page);
    announce(false);
  }

  /* The record on the page shown, and its cell. */
  const shown = await poll(() => {
    const now = findTable(reveal);
    if (!now || now.refreshing) return null;
    const at = now.locate(reveal.recordId, reveal.field);
    if (at.status !== 'present' || (at.page !== null && at.page !== at.pageShown)) return null;
    if (now.address) {
      const names = now.address.filterFields.map((f) => f.field);
      if (now.address.key !== viewAddressKey(parseAddressSearch(window.location.search), names)) return null;
    }
    const cell = document.querySelector<HTMLElement>(
      `[data-ui-instance="${CSS.escape(now.instanceId)}"] td[data-record-kind="${CSS.escape(reveal.recordKind)}"]` +
        `[data-record-id="${CSS.escape(reveal.recordId)}"][data-field="${CSS.escape(reveal.field)}"]`,
    );
    return cell ? { at, cell } : null;
  });
  if (!shown) return refuse(findTable(reveal)?.refreshing ? UI_COMMAND_FAILURES.notApplied : UI_COMMAND_FAILURES.notPresent);
  const { at, cell } = shown;

  const visible = await bringIntoView(cell, reveal, adjustments, deps.until);
  const page =
    at.pageShown !== null && at.pageSize !== null && at.pageCount !== null
      ? { index: at.pageShown, size: at.pageSize, count: at.pageCount }
      : null;
  const revealed: UiRevealed = {
    recordKind: reveal.recordKind,
    recordId: reveal.recordId,
    field: reveal.field,
    displayedText: (cell.textContent ?? '').trim(),
    rawValue: recordValue(at.record, reveal.field),
    page,
  };
  if (!visible) {
    // The cell exists; it could not be brought in front of the user. Whatever
    // was changed to get this far is still on screen, and still reported.
    announce(false, { recordTitle: at.title, fieldLabel: at.field.label });
    return refuse(UI_COMMAND_FAILURES.notVisible, { highlighted: false, revealed });
  }

  markHighlighted(cell);
  announce(true, { recordTitle: at.title, fieldLabel: at.field.label });
  return {
    ...base,
    executed: true,
    highlighted: true,
    revealed,
    ...(adjustments.length ? { adjustments: [...adjustments] } : {}),
    ...(page ? { page } : {}),
    url: currentUrl(),
  };
}
