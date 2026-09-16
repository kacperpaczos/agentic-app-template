import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Renderer } from '@openuidev/react-lang';
import type { CardSpec } from '@platform/contracts';
import { useRegistry } from '../catalog/registry.tsx';

/**
 * One bad card must not take the canvas with it. A renderer that throws is
 * replaced by a readable failure inside its own frame; the rest of the
 * composition keeps working.
 */
class CardErrorBoundary extends Component<
  { children: ReactNode; label: string },
  { message: string | null }
> {
  override state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[card]', this.props.label, error, info.componentStack);
  }

  override render() {
    if (this.state.message) {
      return (
        <div className="pf-state pf-state--error" role="alert">
          Karta „{this.props.label}” nie mogla sie wyrenderowac: {this.state.message}
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Renders a card's content.
 *
 * `component` specs resolve against the shared catalog; `openui` specs go
 * through the OpenUI renderer with the same catalog. An unknown component id is
 * shown as an explicit problem rather than an empty box — but note it can only
 * get here if the backend catalog accepted it, so this path means the browser
 * and server catalogs have drifted.
 */
export function CardBody({ cardId, spec }: { cardId: string; spec: CardSpec }) {
  const registry = useRegistry();

  if (spec.kind === 'openui') {
    return (
      <CardErrorBoundary label={cardId}>
        <Renderer response={spec.source} library={registry.library} />
      </CardErrorBoundary>
    );
  }

  const Renderable = registry.cardRenderers[spec.component];
  if (!Renderable) {
    return (
      <div className="pf-state pf-state--error" role="alert">
        Brak renderera dla komponentu <code>{spec.component}</code>. Katalog przegladarki i katalog
        backendu sa niezgodne.
      </div>
    );
  }

  return (
    <CardErrorBoundary label={spec.component}>
      <Renderable cardId={cardId} props={spec.props ?? {}} />
    </CardErrorBoundary>
  );
}
