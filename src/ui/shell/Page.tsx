/** Page container and header used by the shell screens. */
import { useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

const widths = {
  narrow: 'max-w-3xl',
  wide: 'max-w-6xl',
} as const;

export function Page({
  children,
  width = 'wide',
  className,
}: {
  children: ReactNode;
  width?: keyof typeof widths;
  className?: string;
}) {
  return <div className={cn('mx-auto w-full px-4 pt-6 pb-12 sm:px-6 sm:pt-8', widths[width], className)}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small line above the title, e.g. a back link. */
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-2">{eyebrow}</div>}
        <h1 className="font-display text-2xl font-semibold tracking-wide sm:text-[1.75rem]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Set document.title to "<title> · Solo DM" while the screen is mounted. */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Solo DM` : 'Solo DM';
  }, [title]);
}
