import type { ReactNode } from 'react';
import { Link, useParams } from '@tanstack/react-router';

/**
 * Navigation as a contract, so a module never names the application's routes.
 *
 * The router instance is registered globally by the composition root
 * (`declare module '@tanstack/react-router' { interface Register … }`), which is
 * what gives the application typed links. A *module* must not reach for that
 * registration: its screens exist whether or not this particular application
 * mounts them, and a page that writes `useParams({ from: '/cases/$caseId' })`
 * stops typechecking the moment the application composes a different module —
 * which is precisely the swap the platform is supposed to survive.
 *
 * These two helpers are the whole navigation surface a module needs: read the
 * parameters of the screen I am on, and link to a path. Both are typed on
 * plain strings, and both are the platform's, so the module imports the router
 * library not at all (enforced by `scripts/check-boundaries.mjs`).
 */

/**
 * Route parameters of the screen currently on display.
 *
 * `strict: false` asks the router for the parameters of whatever matched,
 * rather than of a route named at compile time. The result is widened to plain
 * strings: the platform cannot know a module's parameter names, and the module
 * declared the `$segments` of its own path, so it knows them already.
 */
export function useScreenParams(): Record<string, string> {
  const params = useParams({ strict: false }) as unknown as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export interface AppLinkProps {
  /** Path as declared in a menu item or a screen contribution, e.g. `/items/$itemId`. */
  to: string;
  /** Values for the `$segments` of `to`. */
  params?: Record<string, string>;
  className?: string;
  title?: string;
  'data-testid'?: string;
  children: ReactNode;
}

/**
 * A link to a path inside the application.
 *
 * Keeps the session identifiers across the navigation exactly as any other link
 * does (the root route's `retainSearchParams` middleware), because it *is* the
 * router's own `Link` — only with props the module can express without knowing
 * the route table.
 */
export function AppLink({ to, params, children, ...rest }: AppLinkProps) {
  return (
    <Link to={to} params={params as never} {...rest}>
      {children}
    </Link>
  );
}
