/**
 * Error boundaries keep one broken panel from blanking the whole app.
 *
 *   <ErrorBoundary label="Your campaigns">…</ErrorBoundary>
 *
 * renders a compact "couldn't load" card with a Try again button when a child throws.
 * Pass `fallback` for a custom screen and `resetKeys` to reset automatically (e.g. on navigation).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './ui';

export interface ErrorFallbackProps {
  error: Error;
  reset: () => void;
}

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Names the section in the default fallback ("Your campaigns couldn't load"). */
  label?: string;
  fallback?: (props: ErrorFallbackProps) => ReactNode;
  /** The boundary resets when any of these values change (for example the route path). */
  resetKeys?: readonly unknown[];
  onError?: (error: Error, info: ErrorInfo) => void;
  className?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Normalize anything that was thrown into an Error. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : 'Unexpected error');
}

function keysChanged(a: readonly unknown[] = [], b: readonly unknown[] = []): boolean {
  return a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: toError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(toError(error), info);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && keysChanged(prev.resetKeys, this.props.resetKeys)) this.reset();
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback({ error, reset: this.reset });
    return (
      <SectionErrorFallback error={error} reset={this.reset} label={this.props.label} className={this.props.className} />
    );
  }
}

/** Compact inline fallback for a section that failed to render. */
export function SectionErrorFallback({
  error,
  reset,
  label,
  className,
}: ErrorFallbackProps & { label?: string; className?: string }) {
  return (
    <div role="alert" className={cn('rounded-2xl border border-danger/30 bg-danger-soft/40 p-4 text-sm', className)}>
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{label ? `${label} couldn’t load.` : 'This section couldn’t load.'}</p>
          <p className="mt-1 text-muted [overflow-wrap:anywhere]">{error.message || 'Unexpected error.'}</p>
          <Button size="sm" className="mt-3" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={reset}>
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}
