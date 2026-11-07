/**
 * Friendly error screens: the app-level crash screen (outside the router), the page-level
 * fallback (inside the layout, so the top bar keeps working) and the router's errorElement.
 */
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Button } from '@/ui/components/ui';
import { ButtonLink } from '@/ui/components/ButtonLink';
import { LanternMark } from '@/ui/components/LanternMark';
import { toError, type ErrorFallbackProps } from '@/ui/components/ErrorBoundary';
import { NotFoundScreen } from '@/ui/screens/NotFoundScreen';

/** A lazily loaded chunk failed to download (usually: a new version was deployed). */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /dynamically imported module|importing a module script failed|error loading dynamically|chunkloaderror/i.test(
    `${error.name} ${error.message}`,
  );
}

function reloadApp(goHome = false): void {
  if (goHome) window.location.hash = '#/';
  window.location.reload();
}

function ErrorDetails({ error }: { error: Error }) {
  return (
    <details className="mt-5 text-xs text-muted">
      <summary className="cursor-pointer select-none hover:text-text">Technical details</summary>
      <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-[11px] whitespace-pre-wrap scroll-thin">
        {`${error.name}: ${error.message}${error.stack ? `\n\n${error.stack}` : ''}`}
      </pre>
    </details>
  );
}

/** Full-screen fallback for errors outside the router. */
export function AppCrashScreen({ error }: { error: Error }) {
  const updated = isChunkLoadError(error);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10 text-text">
      <div role="alert" className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-card">
        <div className="flex items-center gap-2">
          <LanternMark className="size-6" />
          <span className="font-display font-semibold tracking-wide">Solo DM</span>
        </div>
        <h1 className="mt-5 text-xl font-semibold">{updated ? 'Solo DM was updated' : 'Something went wrong'}</h1>
        <p className="mt-2 text-sm text-muted">
          {updated
            ? 'A newer version is available. Reload to keep playing.'
            : 'The app hit an unexpected error. Your campaigns are saved in this browser, so reloading is safe and usually fixes it.'}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="primary" icon={<RotateCcw className="size-4" aria-hidden />} onClick={() => reloadApp()}>
            Reload
          </Button>
          <Button variant="ghost" onClick={() => reloadApp(true)}>
            Go to campaigns
          </Button>
        </div>
        <ErrorDetails error={error} />
      </div>
    </div>
  );
}

/** Fallback for a page that failed to render. */
export function PageErrorFallback({ error, reset }: ErrorFallbackProps) {
  const updated = isChunkLoadError(error);
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-12">
      <div role="alert" className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <TriangleAlert className="size-6 text-danger" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold">
          {updated ? 'This page needs a reload' : 'This page ran into a problem'}
        </h1>
        <p className="mt-1.5 text-sm text-muted">
          {updated
            ? 'Solo DM was updated since you opened it.'
            : 'Your saves are safe. Try again, or head back to your campaigns.'}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          {updated ? (
            <Button variant="primary" onClick={() => window.location.reload()}>
              Reload
            </Button>
          ) : (
            <Button variant="primary" icon={<RotateCcw className="size-4" aria-hidden />} onClick={reset}>
              Try again
            </Button>
          )}
          <ButtonLink to="/" variant="ghost" onClick={reset}>
            Back to campaigns
          </ButtonLink>
        </div>
        <ErrorDetails error={error} />
      </div>
    </div>
  );
}

/** The router's errorElement: anything that escapes the page boundaries ends up here. */
export function RouteErrorScreen() {
  const routeError = useRouteError();
  if (isRouteErrorResponse(routeError) && routeError.status === 404) return <NotFoundScreen />;
  const error = isRouteErrorResponse(routeError)
    ? new Error(`${routeError.status} ${routeError.statusText}`)
    : toError(routeError);
  return <PageErrorFallback error={error} reset={() => window.location.reload()} />;
}
