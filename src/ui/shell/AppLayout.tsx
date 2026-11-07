/**
 * Layout for every screen except Play: a slim top bar (mark, wordmark, main nav), the page in
 * its own error boundary and Suspense (lazy screens), and a small credits footer.
 */
import { Suspense, useRef, type RefObject } from 'react';
import { Link, Outlet, ScrollRestoration, useLocation } from 'react-router';
import { BookOpen, Castle, Settings, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Spinner } from '@/ui/components/ui';
import { ErrorBoundary } from '@/ui/components/ErrorBoundary';
import { LanternMark } from '@/ui/components/LanternMark';
import { PageErrorFallback } from './ErrorScreens';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  {
    to: '/',
    label: 'Campaigns',
    icon: Castle,
    isActive: (p) => p === '/' || p.startsWith('/new') || p.startsWith('/campaign/'),
  },
  { to: '/library', label: 'Library', icon: BookOpen, isActive: (p) => p.startsWith('/library') },
  { to: '/settings', label: 'Settings', icon: Settings, isActive: (p) => p.startsWith('/settings') },
];

export function AppLayout() {
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text">
      <SkipToContent target={mainRef} />
      <TopBar pathname={pathname} />
      <main ref={mainRef} id="main" tabIndex={-1} className="flex flex-1 flex-col focus:outline-none">
        <ErrorBoundary resetKeys={[pathname]} fallback={(props) => <PageErrorFallback {...props} />}>
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <SiteFooter />
      <ScrollRestoration />
    </div>
  );
}

function SkipToContent({ target }: { target: RefObject<HTMLElement | null> }) {
  // A button rather than href="#main": with hash routing that href would navigate.
  return (
    <button
      type="button"
      onClick={() => target.current?.focus()}
      className="sr-only rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
    >
      Skip to content
    </button>
  );
}

function TopBar({ pathname }: { pathname: string }) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-bg pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2 rounded-lg py-1 pr-1">
          <LanternMark className="size-7" />
          <span className="font-display text-lg font-semibold tracking-wide">Solo DM</span>
        </Link>
        <nav aria-label="Main" className="ml-auto">
          <ul className="flex items-center gap-0.5 sm:gap-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavItemLink item={item} active={item.isActive(pathname)} />
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </header>
  );
}

function NavItemLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex flex-col items-center gap-0.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors',
        'sm:flex-row sm:gap-2 sm:px-3 sm:py-2 sm:text-sm',
        active ? 'bg-surface-2 text-text' : 'text-muted hover:bg-surface-2/60 hover:text-text',
      )}
    >
      <Icon className={cn('size-[18px] sm:size-4', active && 'text-accent')} aria-hidden />
      {item.label}
    </Link>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-border pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-4 text-xs text-muted sm:px-6">
        <span>Compatible with fifth edition</span>
        <span>Rules from SRD 5.2.1 (CC-BY-4.0)</span>
        <span>Unofficial fan project</span>
        <Link to="/library?tab=about" className="underline underline-offset-2 hover:text-text">
          Credits &amp; license
        </Link>
      </div>
    </footer>
  );
}

export function PageLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-3 px-4 py-24 text-sm text-muted">
      <Spinner label={label} />
      <span aria-hidden>{label}</span>
    </div>
  );
}
