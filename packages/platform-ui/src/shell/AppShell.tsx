import { useEffect, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { MENU_SECTIONS, authIsConfirmed, authIsUsable } from '@platform/contracts';
import { useStatus } from '../api/queries.ts';
import { CanvasHost } from '../canvas/CanvasHost.tsx';
import { ChatPanel } from '../chat/ChatPanel.tsx';
import { useRegistry } from '../catalog/registry.tsx';
import { useAppState } from '../state/appState.ts';
import { AccessContextReset } from './AccessContextReset.tsx';
import { SpaceSync } from './SpaceSync.tsx';
import { BackgroundTasks } from './BackgroundTasks.tsx';
import { UiCommandRunner } from './UiCommandRunner.tsx';
import { UiSnapshotPublisher } from './UiSnapshotPublisher.tsx';
import { ViewFilterBanner } from './ViewFilterBanner.tsx';

/**
 * Collapsible left navigation.
 *
 * Sections are fixed by the platform; their *items* and their *headings* come
 * from the module registry. The platform therefore never names a business
 * screen — and, since `registry.menuSections`, never names a business section
 * either: it used to call the `records` heading "Sprawy zakupowe", which is the
 * example module's noun sitting in the shell (see `MenuSectionLabels`).
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
                <h2 className="pf-nav__heading">{registry.menuSections[section]}</h2>
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

/**
 * The one line of the shell that talks about the subscription.
 *
 * Three facts, never merged: whether the application may try a run
 * (`authIsUsable`), whether a call has actually succeeded (`authIsConfirmed`)
 * and what went wrong last. The dot follows the second, not the first, which is
 * the correction L8.9 asks for — a present credential file used to paint it
 * green, so "logged in" and "the model answered" looked identical, and a failed
 * run left it green as well.
 *
 * `data-auth-state` carries the access state itself. A browser test asserting
 * the wording would be asserting a label; the attribute is the state.
 */
function StatusBar() {
  const { data } = useStatus();
  const lastRunId = useAppState((s) => s.lastRunId);
  if (!data) return null;
  const auth = data.auth;
  const usable = authIsUsable(auth);
  const confirmed = authIsConfirmed(auth);
  const plan = auth.credential.subscriptionType ? ` (${auth.credential.subscriptionType})` : '';
  /*
   * The explicit GLM mode states its provider in the label and names the
   * harness in the prefix — the two facts the owner's decision (2026-09-20)
   * keeps apart. Its sdkSession may well report `api_key`, which is the
   * expected answer there, so the subscription-only "niezgodna z polityka"
   * branch must not fire; the endpoint credential is what "logowanie wygaslo"
   * advice would be wrong about, too.
   */
  const label =
    auth.method === 'glm'
      ? auth.sdkSession.state === 'subscription'
        ? 'GLM/Z.AI — sesja SDK korzysta z subskrypcji Claude; konfiguracja niezgodna'
        : auth.access.state === 'revoked' || auth.access.state === 'refresh_refused'
        ? 'GLM/Z.AI — dostep odrzucony przez endpoint; sprawdz token'
        : auth.access.state === 'rate_limited'
          ? 'GLM/Z.AI — limit uzycia wyczerpany'
          : auth.access.state === 'failed'
            ? 'GLM/Z.AI — blad polaczenia z modelem'
            : confirmed
              ? 'GLM/Z.AI — dostep potwierdzony'
              : 'GLM/Z.AI — dostep niesprawdzony'
      : auth.sdkSession.state === 'api_key'
        ? 'sesja SDK na kluczu API — niezgodna z polityka'
        : auth.access.state === 'revoked' || auth.access.state === 'refresh_refused'
          ? 'logowanie wygaslo — wykonaj /login'
          : auth.access.state === 'rate_limited'
            ? `limit uzycia wyczerpany${plan}`
            : auth.access.state === 'failed'
              ? `blad polaczenia z modelem${plan}`
              : !auth.credential.present
                ? 'brak logowania'
                : confirmed
                  ? `subskrypcja${plan} — dostep potwierdzony`
                  : `subskrypcja${plan} — dostep niesprawdzony`;
  /* Green only for a confirmed call; a warning for anything unusable; neutral
     for "we have not tried yet", which is neither good news nor bad. */
  const dot = confirmed ? 'pf-dot--ok' : usable ? 'pf-dot--idle' : 'pf-dot--warn';
  return (
    <div className="pf-statusbar" data-testid="statusbar">
      <span className={`pf-dot ${dot}`} aria-hidden="true" />
      <span data-testid="statusbar-auth" data-auth-state={auth.access.state} data-auth-confirmed={String(confirmed)} data-auth-method={auth.method}>
        {auth.method === 'glm' ? 'Agent (Claude Code): ' : 'Claude: '}
        {label}
      </span>
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
      {/*
        Below the publisher on purpose: a switch of identity has to let the
        description source record what it was describing before anything is
        emptied. Drops `c` and `s` from the address; the store is cleared by
        itself. See `state/accessReset.ts`.
      */}
      <AccessContextReset />
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
