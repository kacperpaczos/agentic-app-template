import type { ReactNode } from 'react';
import { Renderer } from '@openuidev/react-lang';
import type { CardSpec } from '@platform/contracts';
import { useRegistry } from '../catalog/registry.tsx';
import { RenderErrorBoundary } from '../components/RenderErrorBoundary.tsx';

/**
 * One bad card must not take the canvas with it. A renderer that throws is
 * replaced by a readable failure inside its own frame; the rest of the
 * composition keeps working.
 */
function CardErrorBoundary({ children, label }: { children: ReactNode; label: string }) {
  return (
    <RenderErrorBoundary
      label={label}
      describe={(name, message) => `Karta „${name}” nie mogla sie wyrenderowac: ${message}`}
    >
      {children}
    </RenderErrorBoundary>
  );
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
