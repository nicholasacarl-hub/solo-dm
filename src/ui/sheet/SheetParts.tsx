/**
 * Small building blocks for the character sheet: stat tiles, toggleable pips, proficiency
 * markers and the optional roll button.
 */
import type { ReactNode } from 'react';
import { Dices } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ProficiencyLevel } from '@/types';

export type PipTone = 'arcane' | 'success' | 'danger' | 'gold' | 'accent' | 'info';

const pipFill: Record<PipTone, string> = {
  arcane: 'bg-arcane border-arcane',
  success: 'bg-success border-success',
  danger: 'bg-danger border-danger',
  gold: 'bg-gold border-gold',
  accent: 'bg-accent border-accent',
  info: 'bg-info border-info',
};

/**
 * A row of pips. `filled` pips are shown solid. With `onToggle`, each pip is a button: activating a
 * filled pip calls onToggle(false) ("use one"), an empty pip onToggle(true) ("restore one").
 */
export function Pips({
  total,
  filled,
  tone = 'arcane',
  label,
  onToggle,
  describe,
  className,
}: {
  total: number;
  filled: number;
  tone?: PipTone;
  /** Accessible group label, e.g. "1st-level spell slots". */
  label: string;
  onToggle?: (fill: boolean) => void;
  /** Accessible label per pip (defaults to "n of total"). */
  describe?: (index: number, isFilled: boolean) => string;
  className?: string;
}) {
  const pips = Array.from({ length: total }, (_, i) => i < filled);
  return (
    <div role="group" aria-label={`${label}: ${filled} of ${total}`} className={cn('flex flex-wrap items-center gap-1', className)}>
      {pips.map((isFilled, i) => {
        const dot = (
          <span
            aria-hidden
            className={cn(
              'block size-3.5 rounded-full border-2 transition-colors',
              isFilled ? pipFill[tone] : 'border-border bg-transparent',
            )}
          />
        );
        if (!onToggle) return <span key={i}>{dot}</span>;
        const text = describe?.(i, isFilled) ?? `${label} ${i + 1} of ${total}: ${isFilled ? 'available — mark as used' : 'used — restore'}`;
        return (
          <button
            key={i}
            type="button"
            aria-label={text}
            title={text}
            onClick={() => onToggle(!isFilled)}
            className="-m-1 rounded-full p-1 hover:bg-surface-2"
          >
            {dot}
          </button>
        );
      })}
    </div>
  );
}

export function StatTile({
  label,
  value,
  sub,
  icon,
  className,
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <div title={title} className={cn('flex min-w-0 flex-col items-center rounded-xl border border-border bg-surface-2 px-1.5 py-1.5 text-center', className)}>
      <span className="flex items-center gap-1 text-[10px] font-semibold tracking-wider text-muted uppercase">
        {icon}
        {label}
      </span>
      <span className="text-lg leading-tight font-semibold tabular-nums">{value}</span>
      {sub && <span className="truncate text-[11px] text-faint">{sub}</span>}
    </div>
  );
}

/** ○ none, ◐ half, ● proficient, ◉ expertise (with screen-reader text). */
export function ProfMarker({ level, className }: { level: ProficiencyLevel | undefined; className?: string }) {
  const lvl = level ?? 0;
  const text = lvl === 2 ? 'Expertise' : lvl === 1 ? 'Proficient' : lvl === 0.5 ? 'Half proficiency' : 'Not proficient';
  return (
    <span title={text} className={cn('inline-flex size-3.5 shrink-0 items-center justify-center', className)}>
      <span
        aria-hidden
        className={cn(
          'block rounded-full',
          lvl === 2 && 'size-3.5 border-2 border-accent bg-accent ring-2 ring-accent-soft ring-offset-1 ring-offset-surface',
          lvl === 1 && 'size-2.5 bg-accent',
          lvl === 0.5 && 'size-2.5 border-2 border-accent',
          lvl === 0 && 'size-2.5 border border-border',
        )}
      />
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** Small, optional "roll it yourself" button (unprompted rolls go to the log). */
export function RollButton({ label, onRoll, className }: { label: string; onRoll: () => void; className?: string }) {
  return (
    <button
      type="button"
      aria-label={`Roll ${label}`}
      title={`Roll ${label}`}
      onClick={onRoll}
      className={cn('inline-grid size-7 shrink-0 place-items-center rounded-lg text-faint transition-colors hover:bg-surface-3 hover:text-accent', className)}
    >
      <Dices className="size-3.5" aria-hidden />
    </button>
  );
}

export function SheetSection({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-xs font-semibold tracking-[0.14em] text-muted uppercase">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
