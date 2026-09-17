import { useEffect, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { MENU_SECTIONS, authIsUsable, type MenuSection } from '@platform/contracts';
import { useStatus } from '../api/queries.ts';
import { CanvasHost } from '../canvas/CanvasHost.tsx';
import { ChatPanel } from '../chat/ChatPanel.tsx';
import { useRegistry } from '../catalog/registry.tsx';
import { useAppState } from '../state/appState.ts';
import { SpaceSync } from './SpaceSync.tsx';
import { BackgroundTasks } from './BackgroundTasks.tsx';
import { UiCommandRunner } from './UiCommandRunner.tsx';
import { UiSnapshotPublisher } from './UiSnapshotPublisher.tsx';
import { ViewFilterBanner } from './ViewFilterBanner.tsx';

const SECTION_LABELS: Record<MenuSection, string> = {
  workspace: 'Przestrzen pracy',
  records: 'Sprawy zakupowe',
  data: 'Dane',
  files: 'Pliki i raporty',
  settings: 'Ustawienia',
};

/**
 * Collapsible left navigation.
 *
 * Sections are fixed by the platform; their *items* come from the module
 * registry. The platform therefore never names a business screen.
 */
function Nav() {
  const registry = useRegistry();
  const open = useAppState((s) => s.navOpen);
  const setOpen = useAppState((s) => s.setNavOpen);
  const current = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className={`pf-nav ${open ? '' : 'pf-nav--collapsed'}`} aria-label="Nawigacja glowna">
      <button
        type="button"
        className="pf-nav__toggle"
        aria-expanded={open}
        aria-label={open ? 'Zwin menu' : 'Rozwin menu'}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">☰</span>
      </button>

      {open && (
        <div className="pf-nav__sections">
          {MENU_SECTIONS.map((section) => {
            const items = registry.menu.filter((m) => m.section === section);
            if (items.length === 0) return null;
            return (
              <div className="pf-nav__section" key={section}>
                <h2 className="pf-nav__heading">{SECTION_LABELS[section]}</h2>
                <ul className="pf-nav__list">
                  {items.map((item) => (
                    <li key={item.id}>
                      <Link
                        to={item.to}
                        className={`pf-nav__link ${current === item.to ? 'pf-nav__link--active' : ''}`}
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </nav>
  );
}

function StatusBar() {
  const { data } = useStatus();
  const lastRunId = useAppState((s) => s.lastRunId);
  if (!data) return null;
  const auth = data.auth;
  /*
   * The dot reflects *access*, not the presence of a file: a revoked or
   * unrenewable login used to show green because the credential existed.
   * A stale local expiry alone stays green — the SDK renews on the next call.
   */
  const ok = authIsUsable(auth);
  const plan = auth.credential.subscriptionType ? ` (${auth.credential.subscriptionType})` : '';
  const label =
    auth.access.state === 'revoked' || auth.access.state === 'refresh_refused'
      ? 'logowanie wygaslo — wykonaj /login'
      : auth.access.state === 'rate_limited'
        ? `limit uzycia wyczerpany${plan}`
        : auth.credential.present
          ? `subskrypcja${plan}`
          : 'brak logowania';
  return (
    <div className="pf-statusbar" data-testid="statusbar">
      <span className={`pf-dot ${ok ? 'pf-dot--ok' : 'pf-dot--warn'}`} aria-hidden="true" />
      <span data-testid="statusbar-auth">Claude: {label}</span>
      <span className="pf-statusbar__sep">·</span>
      <span>model {data.model}</span>
      <span className="pf-statusbar__sep">·</span>
      <span>{data.modules.length} modul(y), {data.tools.length + data.platformTools.length} narzedzi</span>
      {lastRunId && (
        <>
          <span className="pf-statusbar__sep">·</span>
          <span data-testid="last-run">run {lastRunId.slice(-8)}</span>
        </>
      )}
      {/* What the backend is doing, whichever conversation it belongs to. */}
      <BackgroundTasks />
    </div>
  );
}

/**
 * Three-pane layout: navigation, work surface, chat.
 *
 * The work surface is the canvas by default; a module route (a list, a detail
 * page) replaces it while the chat and navigation stay put, so the conversation
 * never loses its place.
 */
export function AppShell({ children }: { children?: ReactNode }) {
  const navOpen = useAppState((s) => s.navOpen);
  const setNavOpen = useAppState((s) => s.setNavOpen);

  // Narrow screens start with the navigation collapsed.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 900) setNavOpen(false);
  }, [setNavOpen]);

  return (
    <div className={`pf-shell ${navOpen ? '' : 'pf-shell--nav-collapsed'}`}>
      {/* Records the workspace in the URL so a reload comes back to it. */}
      <SpaceSync />
      {/* Performs the agent's interface commands and reports what really happened. */}
      <UiCommandRunner />
      {/* Publishes what this tab shows, versioned, for the agent's `ui_state`. */}
      <UiSnapshotPublisher />
      <Nav />
      <main className="pf-main">
        <StatusBar />
        {/*
          Above the work surface, so it is true of every screen — including the
          ones written after this one. See `ViewFilterBanner.tsx`.
        */}
        <ViewFilterBanner />
        <div className="pf-surface">{children ?? <CanvasHost />}</div>
      </main>
      <ChatPanel />
    </div>
  );
}
