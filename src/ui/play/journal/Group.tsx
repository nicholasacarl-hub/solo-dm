import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/** A collapsible group within a journal tab ("Active (2)", "House rules (3)"). */
export function Group({
  label,
  count,
  defaultOpen = true,
  icon,
  description,
  children,
}: {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  /** Small decorative icon before the label. */
  icon?: ReactNode;
  /** One line under the heading, shown while the group is open. */
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group/section">
      <summary className="mb-2 flex cursor-pointer list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 text-faint transition-transform group-open/section:rotate-90" aria-hidden />
        {icon}
        <h3 className="font-display text-[0.6875rem] font-semibold tracking-[0.14em] text-muted uppercase">{label}</h3>
        {count !== undefined && <span className="text-xs text-faint tabular-nums">{count}</span>}
      </summary>
      {description && <p className="-mt-1 mb-2 text-xs text-faint">{description}</p>}
      <div className="flex flex-col gap-2">{children}</div>
    </details>
  );
}

/** "2 secret entries hidden" — shown while spoilers are off. */
export function HiddenNote({ count, singular, plural }: { count: number; singular: string; plural: string }) {
  if (count === 0) return null;
  return (
    <p className="text-xs text-faint italic">
      {count} secret {count === 1 ? singular : plural} hidden. Turn on “Show DM secrets” to see{' '}
      {count === 1 ? 'it' : 'them'}.
    </p>
  );
}
