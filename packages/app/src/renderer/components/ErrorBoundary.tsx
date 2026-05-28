import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Human label for the region that failed, e.g. "Activity tab". */
  label?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

/**
 * Catches render/lifecycle throws in its subtree and shows a recoverable error
 * card instead of letting one component blank the whole window. Without this,
 * any uncaught render error in a single tab takes down the entire app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // Surface to the devtools console with full (un-minified in dev) stack.
    console.error(`[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ''}]`, error, info);
  }

  private reset = () => this.setState({ error: null, componentStack: null });

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        className="flex flex-col h-full overflow-auto p-4 gap-3"
        style={{ color: 'var(--text-primary)' }}
      >
        <div className="text-sm font-semibold" style={{ color: '#ff3b30' }}>
          {this.props.label ? `${this.props.label} crashed` : 'Something went wrong'}
        </div>
        <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
          {error.message || String(error)}
        </div>
        <pre
          className="text-[10px] whitespace-pre-wrap rounded-md p-2 overflow-auto"
          style={{
            background: 'var(--bg-secondary)',
            color: 'var(--text-tertiary)',
            maxHeight: 240,
            border: '0.5px solid var(--border)',
          }}
        >
          {error.stack ?? ''}
          {componentStack ?? ''}
        </pre>
        <div>
          <button
            type="button"
            onClick={this.reset}
            className="text-[11px] px-3 py-1 rounded-md font-medium"
            style={{
              background: 'var(--fill-control)',
              color: 'var(--accent)',
              border: '0.5px solid var(--border)',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
