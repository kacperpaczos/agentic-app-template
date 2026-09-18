import type { UiRevealAdjustment } from '@platform/contracts';

/**
 * Opening the collapsed parts of a screen that hide something the agent was
 * asked to point at.
 *
 * Pointing at an element that is inside a closed `<details>`, a collapsed
 * accordion panel or a tab that is not the open one used to "succeed": the
 * element is in the document, so it was found, scrolled to and marked — while
 * the user saw nothing move. The answer was true about the DOM and false about
 * the screen, which is the exact failure the interface commands exist to
 * prevent.
 *
 * Deliberately generic — HTML and ARIA only, no component library, no
 * application markup, no business vocabulary:
 *
 *  - a `<details>` that is not open is opened;
 *  - a container a control declares collapsed (`aria-controls` pointing at it
 *    from a control with `aria-expanded="false"`) is opened *by clicking that
 *    control*, so the application's own toggle runs and its state stays
 *    consistent;
 *  - a `role="tabpanel"` whose tab is not selected is opened by clicking the
 *    tab, for the same reason.
 *
 * Nothing here writes a value. Opening a section changes what is on screen, not
 * what is stored — and every opening is reported as an adjustment, so the user
 * is told what moved and can close it again.
 */

/** The words a section is known by: its summary, its control's text, or its label. */
function labelOf(section: HTMLElement, control: HTMLElement | null): string {
  const summary = section.tagName === 'DETAILS' ? section.querySelector('summary') : null;
  const text =
    summary?.textContent?.trim() ||
    control?.textContent?.trim() ||
    section.getAttribute('aria-label')?.trim() ||
    section.id ||
    'sekcja';
  return text.replace(/\s+/g, ' ').slice(0, 120);
}

/** The control that says this container is collapsed, if one does. */
function collapsedBy(section: HTMLElement): HTMLElement | null {
  if (!section.id) return null;
  const id = CSS.escape(section.id);
  const control = document.querySelector<HTMLElement>(
    `[aria-controls="${id}"][aria-expanded="false"], [role="tab"][aria-controls="${id}"][aria-selected="false"]`,
  );
  return control;
}

/**
 * Opens everything between `el` and the document that is holding it closed.
 *
 * Walks outwards, because a panel inside a closed section has to be opened
 * from the outside in for the inner control to be clickable at all — and the
 * walk is bounded by the ancestor chain, so it cannot open anything the target
 * is not inside.
 *
 * Returns one adjustment per section opened, outermost first; an empty array
 * when nothing was collapsed, which is the ordinary case.
 */
export function expandCollapsedAncestors(el: HTMLElement): UiRevealAdjustment[] {
  const collapsed: Array<{ section: HTMLElement; control: HTMLElement | null }> = [];
  for (let node: HTMLElement | null = el.parentElement; node; node = node.parentElement) {
    if (node.tagName === 'DETAILS' && !(node as HTMLDetailsElement).open) {
      collapsed.push({ section: node, control: node.querySelector('summary') });
      continue;
    }
    const control = collapsedBy(node);
    if (control) collapsed.push({ section: node, control });
  }

  const opened: UiRevealAdjustment[] = [];
  // Outermost first: an inner control inside a closed outer section is not
  // clickable until the outer one is open.
  for (const { section, control } of collapsed.reverse()) {
    const label = labelOf(section, control);
    if (section.tagName === 'DETAILS') {
      (section as HTMLDetailsElement).open = true;
    } else if (control) {
      control.click();
    } else {
      continue;
    }
    opened.push({ kind: 'section_expanded', detail: `rozwinieto sekcje „${label}”` });
  }
  return opened;
}

/**
 * Whether the element is actually laid out — not merely present in the
 * document.
 *
 * `querySelector` finds an element inside a closed `<details>` or a hidden tab
 * panel just as readily as a visible one, and scrolling to it and marking it
 * then reports a success the user cannot see. A box with area is the cheapest
 * honest test of "there is something there to look at"; whether it is *in view*
 * is a separate question, answered after scrolling.
 */
export function hasBox(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
