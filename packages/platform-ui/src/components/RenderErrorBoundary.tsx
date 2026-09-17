import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * One piece of a composition that throws must not take the rest with it.
 *
 * Replaces a renderer that crashed with a readable failure inside its own
 * frame; everything around it keeps working. Used for canvas cards and for
 * composed views, which fail the same way and must say so the same way.
 */
export class RenderErrorBoundary extends Component<
  { children: ReactNode; label: string; describe: (label: string, message: string) => ReactNode },
  { message: string | null }
> {
  override state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[render]', this.props.label, error, info.componentStack);
  }

  override render() {
    if (this.state.message) {
      return (
        <div className="pf-state pf-state--error" role="alert">
          {this.props.describe(this.props.label, this.state.message)}
        </div>
      );
    }
    return this.props.children;
  }
}
