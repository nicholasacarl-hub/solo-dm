/** A titled card for one group of settings. */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

export function SettingsSection({
  id,
  title,
  description,
  icon: Icon,
  tone = 'default',
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  tone?: 'default' | 'danger';
  children: ReactNode;
}) {
  const titleId = `settings-${id}-title`;
  return (
    <section
      id={`settings-${id}`}
      aria-labelledby={titleId}
      className={cn(
        'scroll-mt-20 rounded-2xl border bg-surface p-4 shadow-card sm:p-6',
        tone === 'danger' ? 'border-danger/40' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        {Icon && <Icon className={cn('size-4', tone === 'danger' ? 'text-danger' : 'text-accent')} aria-hidden />}
        <h2 id={titleId} className="font-display text-base font-semibold tracking-wide">
          {title}
        </h2>
      </div>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-5 flex flex-col gap-6">{children}</div>
    </section>
  );
}

/** One-line status message (test results and the like), announced politely. */
export function StatusLine({
  tone,
  icon,
  children,
}: {
  tone: 'muted' | 'success' | 'danger' | 'gold';
  icon?: ReactNode;
  children: ReactNode;
}) {
  const color = { muted: 'text-muted', success: 'text-success', danger: 'text-danger', gold: 'text-gold' }[tone];
  return (
    <p className={cn('flex items-start gap-2 text-sm', color)}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}
