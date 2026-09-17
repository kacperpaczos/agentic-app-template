import { expect } from '@playwright/test';
import { type Page } from '@playwright/test';

/**
 * The detector of proba T25 — what counts as "the value was shown".
 *
 * It lives here rather than in a spec because two suites need exactly the same
 * verdict and a second copy would be a second definition of passing: the
 * scripted suite (`e2e/show-value.spec.ts`) uses it both as the pass condition
 * of its positive case and as the thing its text-only run has to fail, and the
 * real-model probe (`e2e/bl01-bl02-model.spec.ts`) uses it to judge a run
 * nobody scripted. A detector that is lenient in one of the two would make the
 * other's evidence worthless, so there is one.
 *
 * It answers with a *list of what is missing*, not with assertions, so a caller
 * can require it to be empty and another can show that it is not.
 */

export interface Highlight {
  recordKind: string | null;
  recordId: string | null;
  field: string | null;
  text: string;
  inViewport: boolean;
  instanceId: string | null;
  cardId: string | null;
}

/** The value the probe expects to see pointed at, as the backend holds it. */
export interface ExpectedValue {
  recordKind: string;
  recordId: string;
  field: string;
  rawValue: unknown;
  displayedText: string;
}

/**
 * Records every cell the application highlights, as it happens.
 *
 * The highlight is deliberately short-lived, so it is observed rather than
 * polled for: an assertion that looked afterwards could miss a real one, and a
 * test that waited for it to still be there would be testing the timer.
 */
export async function watchHighlights(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __highlights?: unknown[]; __highlightObserver?: MutationObserver };
    if (w.__highlightObserver) return;
    w.__highlights = [];
    const observer = new MutationObserver((records) => {
      for (const m of records) {
        const el = m.target as HTMLElement;
        if (m.attributeName !== 'data-ui-highlight' || el.getAttribute('data-ui-highlight') !== 'true') continue;
        const rect = el.getBoundingClientRect();
        w.__highlights!.push({
          recordKind: el.getAttribute('data-record-kind'),
          recordId: el.getAttribute('data-record-id'),
          field: el.getAttribute('data-field'),
          text: (el.textContent ?? '').trim(),
          inViewport:
            rect.width > 0 &&
            rect.height > 0 &&
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= window.innerHeight &&
            rect.right <= window.innerWidth,
          instanceId: el.closest('[data-ui-instance]')?.getAttribute('data-ui-instance') ?? null,
          cardId:
            el.closest('[data-testid^="card-"]')?.getAttribute('data-testid')?.replace(/^card-/, '') ?? null,
        });
      }
    });
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-ui-highlight'] });
    w.__highlightObserver = observer;
  });
}

export const highlights = (page: Page): Promise<Highlight[]> =>
  page.evaluate(() => ((window as unknown as { __highlights?: Highlight[] }).__highlights ?? []) as Highlight[]);

/**
 * What one `TOOL_CALL_RESULT` carries, whichever path produced it.
 *
 * A scripted handler's answer is logged as the object itself; the same handler
 * reached through MCP by the real model is logged as the protocol's content
 * blocks (`[{type: "text", text: "<json>"}]`). The detector reads both runs, so
 * the unwrapping belongs here rather than in one of them — the first real-model
 * run of proba T25 failed on exactly this while the application had done
 * everything right.
 */
function parseToolContent(raw: string): any {
  const value = JSON.parse(raw);
  const blocks =
    Array.isArray(value) && value.every((b) => b && typeof b === 'object' && b.type === 'text')
      ? (value as Array<{ text: string }>)
      : null;
  if (!blocks) return value;
  const text = blocks.map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    // A tool that answers in prose: keep it readable rather than throwing.
    return { text };
  }
}

/**
 * What each tool call of a run returned, from the run's own persisted event log.
 *
 * `baseUrl` is explicit because a suite running its own server on its own port
 * must not fall back to the shared instance's `baseURL`; the shared suite
 * passes an empty string and lets Playwright resolve it.
 */
export async function toolResults(
  page: Page,
  runId: string,
  baseUrl = '',
): Promise<Array<{ name: string; result: any }>> {
  const res = await page.request.get(`${baseUrl}/api/runs/${runId}/events`);
  expect(res.status()).toBe(200);
  const { events } = (await res.json()) as { events: Array<{ name: string; payload: Record<string, any> }> };
  const names = new Map<string, string>();
  const out: Array<{ name: string; result: any }> = [];
  for (const e of events) {
    if (e.name === 'TOOL_CALL_START') names.set(e.payload.toolCallId, e.payload.toolCallName);
    if (e.name === 'TOOL_CALL_RESULT') {
      out.push({ name: names.get(e.payload.toolCallId) ?? '?', result: parseToolContent(e.payload.content) });
    }
  }
  return out;
}

export const resultOf = (results: Array<{ name: string; result: any }>, tool: string) =>
  results.find((r) => r.name === `mcp__app__${tool}`)?.result;

/** Every answer one tool gave in a run, in order — a real run may call it more than once. */
export const allResultsOf = (results: Array<{ name: string; result: any }>, tool: string) =>
  results.filter((r) => r.name === `mcp__app__${tool}`).map((r) => r.result);

/**
 * The *last* answer one tool gave in a run.
 *
 * What a run left on screen is what its last call to a UI tool did. A real
 * model reaches the right narrowing by trying values — the first `ui_filter`
 * of a run that ends correctly can perfectly well have matched nothing — so
 * anything judging the end state has to read the end, not the beginning.
 */
export const lastResultOf = (results: Array<{ name: string; result: any }>, tool: string) =>
  [...results].reverse().find((r) => r.name === `mcp__app__${tool}`)?.result;

/**
 * The probe's verdict, as a list of what is missing — so a run that only talks
 * about the value fails it, and the caller can show *that* it fails and why.
 *
 * Deliberately not a set of assertions: the negative control has to run the
 * same detector and get a non-empty list.
 */
export async function notShown(
  page: Page,
  runId: string,
  expected: ExpectedValue,
  baseUrl = '',
): Promise<string[]> {
  const problems: string[] = [];
  const result = lastResultOf(await toolResults(page, runId, baseUrl), 'ui_show_value');
  if (!result) problems.push('wykonanie nie wywolalo ui_show_value');
  else {
    if (result.found !== true) problems.push('narzedzie nie znalazlo wartosci w backendzie');
    if (result.shown !== true) problems.push(`klient nie potwierdzil pokazania (reason=${result.reason ?? '-'})`);
    if (result.matchesBackend !== true) problems.push('wartosc na ekranie nie zgadza sie z backendem');
    if (result.revealed?.recordId !== expected.recordId || result.revealed?.field !== expected.field) {
      problems.push('potwierdzenie nie wskazuje tego rekordu i pola');
    }
    if (result.revealed?.rawValue !== expected.rawValue) problems.push('potwierdzona wartosc to nie wartosc backendu');
  }
  const marked = (await highlights(page)).filter(
    (hl) =>
      hl.recordKind === expected.recordKind && hl.recordId === expected.recordId && hl.field === expected.field,
  );
  if (marked.length === 0) problems.push('zadna komorka tego rekordu i pola nie zostala podswietlona');
  else {
    if (!marked.some((hl) => hl.inViewport)) problems.push('podswietlona komorka nie byla w widocznym obszarze');
    if (!marked.some((hl) => hl.text === expected.displayedText)) {
      problems.push(`podswietlona komorka nie pokazuje "${expected.displayedText}"`);
    }
  }
  return problems;
}
