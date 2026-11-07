/** A thin determinate progress bar (role="progressbar"). */
import { cn } from '@/lib/cn';

export function ProgressBar({
  value,
  max = 100,
  label,
  valueText,
  className,
}: {
  value: number;
  max?: number;
  /** Accessible name, e.g. "Import progress". */
  label: string;
  /** Spoken value, e.g. "Page 3 of 10". */
  valueText?: string;
  className?: string;
}) {
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(Math.max(value, 0), safeMax);
  const percent = (clamped / safeMax) * 100;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={clamped}
      aria-valuetext={valueText}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-surface-3', className)}
    >
      <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
    </div>
  );
}
