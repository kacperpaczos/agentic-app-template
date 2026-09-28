import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  retainSearchParams,
} from '@tanstack/react-router';
import {
  AppShell,
  CanvasHost,
  FilesPage,
  SettingsPage,
  WorkspacePage,
} from '@platform/ui';
import { CaseDetailPage, CasesPage, DataPage, ItemProvenancePage } from '@module/procurement/ui';

/**
 * Routes.
 *
 * The router selects *which work surface* is shown; it never describes what is
 * inside the canvas. A card added by the agent needs no new route file and no
 * new executable code — the composition is data, validated against the catalog.
 *
 * The shell (navigation + chat) lives in the root route, so navigating between
 * screens, using Back/Forward or refreshing never remounts the conversation.
 */
/**
 * Session identifiers carried in the address bar on every screen.
 *
 * `c` names the active conversation, `s` the canvas space on screen. They are
 * declared here, on the root route, for two reasons: the shell that reads them
 * (chat and canvas) lives above the route tree, and the router only preserves
 * search parameters it knows about — without this declaration, navigating from
 * a case to the canvas would silently drop the conversation.
 *
 * Validation is deliberately permissive: an unknown or deleted identifier is a
 * legitimate thing to find in a pasted or stale URL, and it is handled on screen
 * (`ConversationSync` shows a notice) rather than by refusing to render.
 */
const sessionSearch = (raw: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  /*
   * Every string parameter is kept, not only `c` and `s`.
   *
   * View narrowings live in the address as one parameter per field
   * (`/data?country=PL`), which is what makes a narrowed view survive a reload,
   * come back with Back, and mean the same thing in a link somebody pastes.
   * This validator used to drop every key it did not name, so those parameters
   * were stripped before any screen could read them.
   *
   * Which of them is a filter is not decided here: the view's own declaration
   * says which fields it accepts (`UiTarget.filter`), and anything else in the
   * address is left alone rather than turned into a filter on a property that
   * does not exist. Permissive on purpose — a stale or hand-edited URL is a
   * legitimate thing to find, and it is handled on screen, not by refusing to
   * render.
   */
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
};

const rootRoute = createRootRoute({
  validateSearch: sessionSearch,
  /*
   * Keep both identifiers across every navigation.
   *
   * Without this the router rebuilds the search object for the target route, so
   * following any `Link` — the left navigation, a case tile, "open the workspace
   * on the canvas" — silently dropped the active conversation and the workspace.
   * The router's own middleware is used rather than passing `search` at every
   * call site, so a link added later (including one inside a business module,
   * which knows nothing about this) keeps the session by default.
   */
  /*
   * Only the session identifiers are retained. A narrowing deliberately is not:
   * it belongs to the view it was made for, and carrying `country=PL` onto the
   * next screen would hide rows there that nobody asked to hide. Leaving a
   * filtered view therefore drops the filter, and Back brings it back — which is
   * what the address bar is for.
   */
  search: { middlewares: [retainSearchParams(['c', 's'])] },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

const canvasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: CanvasHost,
});

const spacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/spaces',
  component: WorkspacePage,
});

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/files',
  component: FilesPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});

/* ---- module screens; mounted by the composition root, not by the platform --- */

const casesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cases',
  component: CasesPage,
});

const caseDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/cases/$caseId',
  component: CaseDetailPage,
});

const dataRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/data',
  component: DataPage,
});

const itemProvenanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/items/$itemId',
  component: ItemProvenancePage,
});

const routeTree = rootRoute.addChildren([
  canvasRoute,
  spacesRoute,
  filesRoute,
  settingsRoute,
  casesRoute,
  caseDetailRoute,
  dataRoute,
  itemProvenanceRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
