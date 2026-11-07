/**
 * The Solo DM mark: a simple hanging lantern with an ember flame. Original artwork; the same
 * geometry is used for public/favicon.svg and the app icons.
 * The frame follows `currentColor`; the flame uses the theme accent.
 */
import { cn } from '@/lib/cn';

export function LanternMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <circle cx="16" cy="5" r="2.5" />
      <path d="M10 11.5 12.5 7.5h7l2.5 4Z" />
      <rect x="10" y="11.5" width="12" height="13" rx="2" className="fill-accent/15" />
      <path d="M16 13.4c.7 1.9 3.4 3.4 3.4 6.3a3.4 3.4 0 0 1-6.8 0c0-1.5.8-2.6 1.7-3.4.1 1.1.6 1.8 1.3 2.1-.2-1.7.1-3.4.4-5Z" className="fill-accent stroke-none" />
      <path d="M16 19.2c.8.9 1.3 1.5 1.3 2.2a1.3 1.3 0 0 1-2.6 0c0-.7.5-1.3 1.3-2.2Z" fill="#f8dfa6" stroke="none" />
      <path d="M9 24.5h14l-1.5 3.5h-11Z" />
    </svg>
  );
}
