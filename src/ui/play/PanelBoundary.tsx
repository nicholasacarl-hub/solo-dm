import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/ui/components/ui';

interface State {
  error: Error | null;
}

/** Keeps one failing side panel from taking the whole table down. */
export class PanelBoundary extends Component<{ name: string; children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[play] The ${this.props.name} panel crashed:`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex flex-col items-start gap-2 rounded-2xl border border-border bg-surface p-4 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <TriangleAlert className="size-4 text-danger" aria-hidden />
          The {this.props.name} hit a snag.
        </p>
        <p className="text-xs text-muted">{this.state.error.message}</p>
        <Button size="sm" variant="secondary" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
